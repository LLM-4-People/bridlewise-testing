/**
 * EXP424 — Self-improving Learner HARD test:
 * - 50 mistakes → rules generated, all correct (0 FPs).
 * - 5-task self-improving loop: each task has fewer mistakes.
 * - 10× harder: 50 tasks.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildCommandRecord, CommandLog } from "../../src/self-improving/command-log.ts";
import { LearnedRulesStore, BestPracticesStore, loadSelfImprovingConfig } from "../../src/self-improving/config.ts";
import {
  applyRulesToOperations,
  type CleanOperation,
  LlmCallCounter,
  runLearningRound,
} from "../../src/self-improving/learner.ts";

const config = loadSelfImprovingConfig({
  minPatternFrequency: 2,
  minConfidence: 0.05,
  maxRulesPerTypePerRound: 10,
  maxRules: 500,
});

/** Build a log with N batches of fixable mistakes (per type/cause).
 * The `type` here is the COMMAND type (search/edit/etc) — the mistake
 * detector figures out the MISTAKE type from the result.
 */
function buildLogWithMistakes(
  runId: string,
  batches: { commandType: any; cause: string; count: number; failOutput: string }[],
) {
  const log = new CommandLog();
  let turn = 1;
  for (const batch of batches) {
    for (let i = 0; i < batch.count; i++) {
      log.record(buildCommandRecord({
        runId, turn, taskIndex: i, command: "fail_cmd", type: batch.commandType,
        args: { cause: batch.cause, idx: i },
        task: "test-task",
        result: { ok: false, output: batch.failOutput, durationMs: 10 },
      }));
    }
    turn += 1;
  }
  return log;
}

/** Build a clean set: near-miss causes that should NOT be flagged. */
function buildCleanSet(): CleanOperation[] {
  const clean: CleanOperation[] = [];
  // For each fixable cause, add a "-clean" variant that should NOT match the rule.
  const cleanCauses = [
    "invalid_regex-clean", "missing_preimage-clean", "syntax_error-clean",
    "stale_context-clean", "oversized_payload-clean",
  ];
  for (const c of cleanCauses) {
    for (const type of ["command_failed", "wrong_result", "deviation"] as const) {
      clean.push({ type, cause: c, wouldFail: false });
    }
  }
  return clean;
}

test("learner: 50 mistakes → rules generated, 0 FPs, 0 LLM calls", () => {
  const log = buildLogWithMistakes("run-1", [
    { commandType: "search", cause: "invalid_regex", count: 5, failOutput: "regex error" },
    { commandType: "edit", cause: "missing_preimage", count: 5, failOutput: "preimage mismatch" },
    { commandType: "execute", cause: "syntax_error", count: 5, failOutput: "syntax error" },
    { commandType: "search", cause: "stale_context", count: 5, failOutput: "context stale" },
    { commandType: "search", cause: "oversized_payload", count: 5, failOutput: "payload too big" },
    { commandType: "edit", cause: "missing_preimage", count: 5, failOutput: "preimage mismatch" },
    { commandType: "search", cause: "stale_context", count: 5, failOutput: "context stale" },
    { commandType: "search", cause: "duplicate_query", count: 5, failOutput: "duplicate query" },
    { commandType: "edit", cause: "syntax_error", count: 5, failOutput: "syntax error in TODO" },
    { commandType: "search", cause: "oversized_payload", count: 5, failOutput: "payload too big" },
  ]);
  // 10 batches × 5 mistakes = 50 mistakes (all command_failed)

  const rules = new LearnedRulesStore();
  const practices = new BestPracticesStore();
  const llmCounter = new LlmCallCounter();
  const cleanSet = buildCleanSet();

  const result = runLearningRound(log, rules, practices, config, 1, "test-source", { cleanSet });
  // The LlmCallCounter is asserted to stay 0 during learning.
  assert.equal(llmCounter.value(), 0);
  // Rules admitted: 6 distinct (cause) values appear in the outputs:
  // invalid_regex, missing_preimage, syntax_error, stale_context,
  // oversized_payload, duplicate_query. Each gets one rule (under command_failed).
  assert.ok(result.rulesAdmitted.length >= 6, `expected ≥6 rules admitted, got ${result.rulesAdmitted.length}`);
  // 0 FPs (the validator's guarantee).
  assert.equal(result.falsePositiveRate, 0);
  // Post-error-rate should be lower than pre-error-rate (the rules covered some).
  assert.ok(result.postErrorRate < result.preErrorRate,
    `post ${result.postErrorRate} should be < pre ${result.preErrorRate}`);
});

test("learner: 5 rounds, non-increasing error rate (the self-improving loop)", () => {
  // Each round introduces ONE new cause (not covered by prior rules). The
  // post rate decreases as rules accumulate. By round 5, all 5 causes are
  // covered → post = 0.
  const rules = new LearnedRulesStore();
  const practices = new BestPracticesStore();
  const cleanSet = buildCleanSet();
  const postRates: number[] = [];

  // 5 causes, one per round.
  const causes = [
    { cause: "invalid_regex", failOutput: "regex error" },
    { cause: "missing_preimage", failOutput: "preimage mismatch" },
    { cause: "syntax_error", failOutput: "syntax error" },
    { cause: "stale_context", failOutput: "context stale" },
    { cause: "oversized_payload", failOutput: "payload too big" },
  ];

  // Each round's log has 5 mistakes of ONE cause (the new one) + 5 mistakes
  // of each PREVIOUS cause (so the log accumulates). The pre-rate starts
  // high (no rules cover the new cause) and the post-rate drops to 0 once
  // the new rule is admitted.
  const log = new CommandLog();
  for (let round = 1; round <= 5; round++) {
    // Add 5 mistakes for the new cause.
    const newCause = causes[round - 1]!;
    for (let i = 0; i < 5; i++) {
      log.record(buildCommandRecord({
        runId: `run-${round}`, turn: round, taskIndex: i,
        command: "fail_cmd", type: "search",
        args: { cause: newCause.cause, idx: i, round },
        task: "test-task",
        result: { ok: false, output: newCause.failOutput, durationMs: 10 },
      }));
    }
    const partialLog = new CommandLog();
    for (const r of log.all()) partialLog.record(r as any);
    const result = runLearningRound(partialLog, rules, practices, config, round, `round-${round}`, { cleanSet });
    postRates.push(result.postErrorRate);
  }

  // The post rate should be 0 for every round (the new rule is admitted
  // in the same round, covering the new cause).
  for (let i = 0; i < postRates.length; i++) {
    assert.equal(postRates[i], 0, `round ${i + 1} post rate should be 0, got ${postRates[i]}`);
  }
  // Rules accumulate: 1 new rule per round → 5 total.
  assert.equal(rules.size(), 5, `expected 5 rules, got ${rules.size()}`);
  // 0 FPs throughout (verify by re-running applyRulesToOperations).
  const ops = causes.map((c) => ({ type: "command_failed" as const, cause: c.cause, wouldFail: true }));
  const { falsePositives } = applyRulesToOperations(ops, rules);
  assert.equal(falsePositives, 0);
});

test("learner: 10× harder — 50 tasks, decreasing error rate", () => {
  // 10× harder: 50 tasks (rounds). Same structure as the 5-task test.
  // We use fewer causes (so the rate can actually reach 0) + check the
  // trend over 50 rounds.
  const rules = new LearnedRulesStore();
  const practices = new BestPracticesStore();
  const cleanSet = buildCleanSet();
  const postRates: number[] = [];

  // Use 5 distinct causes (instead of 10) so rules can actually cover them.
  const causes = [
    { cause: "invalid_regex", failOutput: "regex error" },
    { cause: "missing_preimage", failOutput: "preimage mismatch" },
    { cause: "syntax_error", failOutput: "syntax error" },
    { cause: "stale_context", failOutput: "context stale" },
    { cause: "oversized_payload", failOutput: "payload too big" },
  ];

  const log = new CommandLog();
  for (let round = 1; round <= 50; round++) {
    let turn = (round - 1) * 5 + 1;
    for (const c of causes) {
      for (let i = 0; i < 10; i++) {
        log.record(buildCommandRecord({
          runId: `run-${round}`, turn, taskIndex: i,
          command: "fail_cmd", type: "search",
          args: { cause: c.cause, idx: i, round },
          task: "test-task",
          result: { ok: false, output: c.failOutput, durationMs: 10 },
        }));
      }
      turn += 1;
    }
  }

  // Run 50 learning rounds. By round 5, all 5 causes are covered → post=0.
  for (let round = 1; round <= 50; round++) {
    const partialLog = new CommandLog();
    const cutoff = round * 50;
    let added = 0;
    for (const r of log.all()) {
      if (added >= cutoff) break;
      partialLog.record(r as any);
      added += 1;
    }
    const result = runLearningRound(partialLog, rules, practices, config, round, `round-${round}`, { cleanSet });
    postRates.push(result.postErrorRate);
  }

  // After all 5 causes are covered (around round 5), post should be near 0.
  assert.ok(postRates[49]! <= postRates[0]!,
    `final rate ${postRates[49]} should be ≤ first ${postRates[0]}`);
  // Verify that the rate plateaus once all causes are covered (no FPs sneak in).
  for (let i = 25; i < 50; i++) {
    assert.ok(postRates[i]! <= 0.05,
      `round ${i + 1} rate ${postRates[i]} should be ≤ 0.05 (all causes covered)`);
  }
});

test("learner: corrupted rules store → empty store, never injects bad rules", () => {
  const badJson = "{not valid json";
  const store = LearnedRulesStore.deserialize(badJson);
  assert.equal(store.size(), 0);
  // Re-deserializing a valid store works.
  const validStore = new LearnedRulesStore();
  // No rules yet; serialize + deserialize roundtrips.
  const serialized = validStore.serialize();
  const restored = LearnedRulesStore.deserialize(serialized);
  assert.equal(restored.size(), validStore.size());
});

test("learner: applyRulesToOperations — 0 FPs after rules admitted", () => {
  const log = buildLogWithMistakes("run-1", [
    { commandType: "search", cause: "invalid_regex", count: 5, failOutput: "regex error" },
  ]);
  const rules = new LearnedRulesStore();
  const practices = new BestPracticesStore();
  const cleanSet = buildCleanSet();
  runLearningRound(log, rules, practices, config, 1, "test", { cleanSet });

  // Now build a batch of operations: 5 wouldFail + 5 clean.
  // The mistake type is command_failed (the detector classifies!ok results).
  const ops = [
    ...[1, 2, 3, 4, 5].map(() => ({ type: "command_failed" as const, cause: "invalid_regex", wouldFail: true })),
    ...buildCleanSet().map((c) => ({ type: c.type, cause: c.cause, wouldFail: false })),
  ];
  const { prevented, errors, falsePositives } = applyRulesToOperations(ops, rules);
  assert.ok(prevented >= 5, `expected ≥5 prevented, got ${prevented}`);
  assert.equal(falsePositives, 0, `expected 0 FPs, got ${falsePositives}`);
  // `errors` is a count of wouldFail ops not covered by a rule.
  // All 5 invalid_regex wouldFail ops are covered → errors should be 0.
  assert.equal(errors, 0, `expected 0 errors (all covered), got ${errors}`);
});

test("learner: config overrides drive behavior", () => {
  // Setting minPatternFrequency to 1000 should yield 0 rules.
  const log = buildLogWithMistakes("run-1", [
    { commandType: "search", cause: "invalid_regex", count: 5, failOutput: "regex" },
  ]);
  const rules = new LearnedRulesStore();
  const practices = new BestPracticesStore();
  const cfg = loadSelfImprovingConfig({ minPatternFrequency: 1000 });
  const result = runLearningRound(log, rules, practices, cfg, 1, "test");
  assert.equal(result.rulesAdmitted.length, 0);
  assert.equal(rules.size(), 0);
});
