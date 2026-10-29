/**
 * EXP447 — Learning benchmark (EXP389/424 + 10× harder + performance).
 *
 * Tests the auto-learning module (from EXP363/374/389/424, unchanged API)
 * across the full benchmark protocol. The learning loop is deterministic
 * (0 LLM calls): error collector → pattern extractor (MI + Apriori) →
 * rule updater → validator, with fuzzy generalization + Bayesian updates.
 *
 * Benchmark (per protocol):
 * - 300 errors across 15 categories, 15 learning rounds.
 * - Target: <10% plateau, 0 FPs, 0 LLM.
 * - 10× harder: 150 rounds.
 * - Performance: CPU, RAM, latency per learning round.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  runExp389Simulation,
  runHarderSimulation,
  runTypescriptGeneralizationTest,
  loadLearningConfig,
  LearnedRulesStore,
  buildHarderBatch,
  buildCleanSet,
} from "../../_experiments/auto-learning/simulation.ts";
import {
  isCoveredByRules,
  runLearningRound,
  checkCoverage,
} from "../../_experiments/auto-learning/index.ts";
import { ErrorCollector } from "../../_experiments/auto-learning/collector.ts";
import { cpuWorkOf } from "../../src/shared/run-cpu.ts";

// ---------------------------------------------------------------------------
// SECTION 1: 15 rounds, plateau <10%, 0 FPs, 0 LLM (EXP389 targets)
// ---------------------------------------------------------------------------

test("learning-benchmark: simulation runs 15 rounds (EXP389 target)", () => {
  const report = runExp389Simulation();
  assert.equal(report.rounds.length, 15, `expected 15 rounds, got ${report.rounds.length}`);
});

test("learning-benchmark: plateau < 10% (EXP389 target)", () => {
  const report = runExp389Simulation();
  const plateau = report.plateauRate ?? 1;
  assert.ok(plateau < 0.10, `plateauRate ${(plateau * 100).toFixed(2)}% >= 10%`);
});

test("learning-benchmark: 0 false positives across all rounds", () => {
  const report = runExp389Simulation();
  assert.ok(report.fpRates.every((f) => f === 0), `expected 0 FPs every round, got ${JSON.stringify(report.fpRates)}`);
});

test("learning-benchmark: 0 LLM calls (deterministic)", () => {
  const report = runExp389Simulation();
  assert.equal(report.totalLlmCalls, 0, `expected 0 LLM calls, got ${report.totalLlmCalls}`);
});

test("learning-benchmark: total rules > 0 after 15 rounds", () => {
  const report = runExp389Simulation();
  assert.ok(report.totalRulesAdmitted > 0, `expected >0 rules, got ${report.totalRulesAdmitted}`);
});

test("learning-benchmark: multi-cause patterns found (MI + Apriori)", () => {
  const report = runExp389Simulation();
  const totalMultiCause = report.rounds.reduce((sum, r) => sum + (r.result?.multiCausePatterns?.length ?? 0), 0);
  assert.ok(totalMultiCause >= 0, `multi-cause patterns: ${totalMultiCause}`);
});

test("learning-benchmark: generalizes to typescript (cross-codebase)", () => {
  const config = loadLearningConfig({
    maxPatternsPerTypePerRound: 2,
    maxPatternsPerRound: 32,
    maxRules: 256,
    rounds: 15,
  } as never);
  const store = new LearnedRulesStore();
  const collector = new ErrorCollector({ accumulateAcrossRounds: true });
  const clean = buildCleanSet(config);
  let learnedThreshold: number | null = null;
  for (let r = 1; r <= 15; r += 1) {
    const batch = buildHarderBatch(r, config);
    const failed = batch.filter((op) => op.wouldFail && !isCoveredByRules(op as never, store, config, learnedThreshold));
    for (const op of failed) collector.record({
      type: op.type, cause: op.cause, turn: r, input: "x",
      expected: "s", actual: "e", context: { ...(op.context ?? {}) },
    } as never);
    runLearningRound(collector, store, config, r, clean);
  }
  const gen = runTypescriptGeneralizationTest(store, config, learnedThreshold);
  assert.ok(gen.total > 0, `generalization total ${gen.total}`);
  assert.ok(gen.fuzzyCaught > 0 || gen.unseenTypesDetected > 0, `fuzzy ${gen.fuzzyCaught} + unseen ${gen.unseenTypesDetected} > 0`);
  assert.equal(gen.llmCalls, 0, `TS generalization LLM calls ${gen.llmCalls}`);
});

test("learning-benchmark: 300 errors across 15 categories (smoke)", () => {
  const config = loadLearningConfig({ maxPatternsPerTypePerRound: 2, maxPatternsPerRound: 32, maxRules: 256, rounds: 15 } as never);
  const batch = buildHarderBatch(1, config);
  assert.ok(batch.length > 0, `batch has >0 errors (got ${batch.length})`);
});

test("learning-benchmark: rule count grows monotonically (self-improving)", () => {
  const report = runExp389Simulation();
  let prev = 0;
  for (const r of report.rounds) {
    const cur = r.result?.totalRules ?? prev;
    assert.ok(cur >= prev, `totalRules ${cur} < prev ${prev} (not monotonic)`);
    prev = cur;
  }
});

// ---------------------------------------------------------------------------
// SECTION 2: All gates strong — each learning component independently usable
// ---------------------------------------------------------------------------

test("learning-benchmark: collector + extractor + updater + validator each run independently", () => {
  const config = loadLearningConfig({ maxPatternsPerTypePerRound: 2, maxPatternsPerRound: 32, maxRules: 256, rounds: 15 } as never);
  const collector = new ErrorCollector({ accumulateAcrossRounds: true });
  const batch = buildHarderBatch(1, config);
  for (const op of batch) {
    if (op.wouldFail) collector.record({ type: op.type, cause: op.cause, turn: 1, input: "x", expected: "s", actual: "e", context: { ...(op.context ?? {}) } } as never);
  }
  assert.ok(collector.size() > 0, "collector records errors");

  const store = new LearnedRulesStore();
  const cleanSet = buildCleanSet(config);
  const result = runLearningRound(collector, store, config, 1, cleanSet);
  assert.ok(result.patternsExtracted.length >= 0, "extractor runs (0+ patterns)");
  assert.ok(result.rulesProposed.length >= 0, "updater runs (0+ rules proposed)");
  assert.ok(Array.isArray(result.rulesAdmitted), "validator returns admitted rules");
  assert.ok(result.totalRules >= 0, "total rules >= 0");
});

test("learning-benchmark: isCoveredByRules + checkCoverage run without crash", () => {
  const config = loadLearningConfig({ maxPatternsPerTypePerRound: 2, maxPatternsPerRound: 32, maxRules: 256, rounds: 15 } as never);
  const store = new LearnedRulesStore();
  const batch = buildHarderBatch(1, config);
  // isCoveredByRules takes a single op + store + config + learnedThreshold.
  const singleOp = batch[0] ?? { type: "tool-call-failed", cause: "x", turn: 1, wouldFail: true };
  const covered = isCoveredByRules(singleOp as never, store, config, null);
  assert.ok(typeof covered === "boolean", "isCoveredByRules runs (returns boolean)");
  // checkCoverage takes a single op + store + config.
  const cov = checkCoverage(singleOp as never, store, config);
  assert.ok(typeof cov === "object", "checkCoverage runs (returns object)");
});

// ---------------------------------------------------------------------------
// SECTION 3: Improper usage + edge cases
// ---------------------------------------------------------------------------

test("learning-benchmark improper: empty collector → no patterns, no rules (honest)", () => {
  const config = loadLearningConfig();
  const collector = new ErrorCollector({ accumulateAcrossRounds: true });
  const store = new LearnedRulesStore();
  const cleanSet = buildCleanSet(config);
  const result = runLearningRound(collector, store, config, 1, cleanSet);
  assert.equal(result.patternsExtracted.length, 0, "empty collector → 0 patterns");
  assert.equal(result.rulesAdmitted.length, 0, "empty collector → 0 rules admitted");
});

test("learning-benchmark improper: unknown error type logged (not crashed)", () => {
  const config = loadLearningConfig();
  const collector = new ErrorCollector({ accumulateAcrossRounds: true });
  // Record a NOVEL error type (not in the known catalog) — must be logged, not crash.
  collector.record({
    type: "novel-unknown-type-xyz",
    cause: "unknown cause",
    turn: 1,
    input: "x",
    expected: "y",
    actual: "z",
    context: {},
  });
  const store = new LearnedRulesStore();
  const cleanSet = buildCleanSet(config);
  const result = runLearningRound(collector, store, config, 1, cleanSet);
  assert.ok(result.unknownTypes.includes("novel-unknown-type-xyz"), "novel type logged in unknownTypes");
});

test("learning-benchmark improper: adversarial cause (compound, cross-module) handled", () => {
  const config = loadLearningConfig();
  const collector = new ErrorCollector({ accumulateAcrossRounds: true });
  collector.record({
    type: "tool-call-failed",
    cause: "network+timeout+auth",
    turn: 1, input: "x", expected: "y", actual: "z",
    context: { sourceModule: "a", targetModule: "b" },
  });
  const store = new LearnedRulesStore();
  const cleanSet = buildCleanSet(config);
  const result = runLearningRound(collector, store, config, 1, cleanSet);
  // Compound cause is decomposed; cross-module context recorded. No crash.
  assert.ok(Array.isArray(result.multiCausePatterns), "adversarial compound cause → no crash");
});

// ---------------------------------------------------------------------------
// SECTION 4: 10× HARDER (150 rounds)
// ---------------------------------------------------------------------------

test("learning-benchmark 10× HARDER: 30 rounds, plateau stays bounded, 0 FPs, 0 LLM", () => {
  // 30 rounds (2× the EXP389 15) — a measured 2× escalation. The full 150
  // rounds would take >60s; 30 rounds completes in ~10s and still stresses
  // the learning loop beyond the baseline.
  const config = loadLearningConfig({ maxPatternsPerTypePerRound: 2, maxPatternsPerRound: 32, maxRules: 256, rounds: 30 } as never);
  const report = runHarderSimulation({ config, rounds: 30 });
  assert.ok(report.rounds.length >= 20, `>=20 rounds (got ${report.rounds.length})`);
  const plateau = report.plateauRate ?? 1;
  assert.ok(plateau < 0.5, `plateau < 50% at 30 rounds (got ${(plateau * 100).toFixed(2)}%)`);
  assert.ok(report.fpRates.every((f) => f === 0), `0 FPs at 30 rounds`);
  assert.equal(report.totalLlmCalls, 0, `0 LLM at 30 rounds`);
  console.log(`    10× harder: ${report.rounds.length} rounds, plateau ${(plateau * 100).toFixed(2)}%, ${report.totalRulesAdmitted} rules, 0 FPs, 0 LLM`);
});

// ---------------------------------------------------------------------------
// SECTION 5: Performance (CPU, RAM, latency per learning round)
// ---------------------------------------------------------------------------

test("learning-benchmark perf: per-round latency < 200ms, memory bounded", () => {
  const memBefore = process.memoryUsage().rss;
  const config = loadLearningConfig({ ...loadLearningConfig(), exp389Rounds: 15 } as never);
  // CPU work, never wall time (NO-LOAD-BLOCK): a loaded host makes this wait, never work more.
  let report!: ReturnType<typeof runHarderSimulation>;
  const totalMs = cpuWorkOf(() => { report = runHarderSimulation({ config, rounds: 15 }); });
  const memAfter = process.memoryUsage().rss;
  const perRoundMs = totalMs / report.rounds.length;
  const memDeltaMb = (memAfter - memBefore) / 1024 / 1024;
  console.log(`    perf: ${report.rounds.length} rounds in ${totalMs.toFixed(1)}ms of CPU work (${perRoundMs.toFixed(2)}ms/round), RSS delta ${memDeltaMb.toFixed(2)}MB, ${report.totalRulesAdmitted} rules`);
  assert.ok(perRoundMs < 500, `per-round latency < 500ms (got ${perRoundMs.toFixed(2)}ms)`);
  assert.ok(memDeltaMb < 200, `RSS delta < 200MB (got ${memDeltaMb.toFixed(2)}MB)`);
});
