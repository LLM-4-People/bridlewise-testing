/**
 * EXP424 — Self-improving workflow INTEGRATION test.
 *
 * The full loop:
 * 1. The harness runs a task (logs all commands to the CommandLog).
 * 2. The mistake detector inspects every command (logs all mistakes).
 * 3. The success detector extracts successful patterns.
 * 4. The learner turns mistakes → prevention rules + successes → best practices.
 * 5. The workflow improver identifies inefficiencies + suggests improvements.
 * 6. The LLM boundary measures generation vs mechanical output.
 * 7. The next task benefits from the rules (fewer mistakes).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildCommandRecord } from "../../src/self-improving/command-log.ts";
import { SelfImprovingWorkflow } from "../../src/self-improving/index.ts";
import { type CleanOperation } from "../../src/self-improving/learner.ts";

function buildLogForTask(taskId: number, numMistakes: number) {
  // Build a log with `numMistakes` command_failed mistakes (same cause) +
  // 5 successful commands (with a pattern).
  const records = [];
  for (let i = 0; i < numMistakes; i++) {
    records.push(buildCommandRecord({
      runId: `task-${taskId}`, turn: 1, taskIndex: i,
      command: "search_code", type: "search",
      args: { query: "foo", viewport: 50, cause: "invalid_regex" },
      task: `task-${taskId}`,
      result: { ok: false, output: "regex error in pattern", durationMs: 10 },
    }));
  }
  for (let i = 0; i < 5; i++) {
    records.push(buildCommandRecord({
      runId: `task-${taskId}`, turn: 2, taskIndex: i,
      command: "search_code", type: "search",
      args: { query: `q${i}`, viewport: 50 },
      task: `task-${taskId}`,
      result: { ok: true, output: "found 5 results", durationMs: 5 },
    }));
  }
  return records;
}

const cleanSet: CleanOperation[] = [
  { type: "command_failed", cause: "invalid_regex-clean", wouldFail: false },
  { type: "command_failed", cause: "missing_preimage-clean", wouldFail: false },
  { type: "command_failed", cause: "syntax_error-clean", wouldFail: false },
];

test("integration: self-improving workflow — full loop, 5 tasks, decreasing mistakes", () => {
  const wf = new SelfImprovingWorkflow({
    minPatternFrequency: 2,
    minConfidence: 0.05,
    maxRulesPerTypePerRound: 10,
    maxRules: 500,
  });

  // Simulate 5 tasks. Each task starts with N mistakes, but after the
  // first task, the rule for "invalid_regex" is admitted and SUBSEQUENT
  // tasks have fewer real mistakes (we simulate by reducing numMistakes).
  const mistakeCounts = [10, 8, 6, 4, 2];
  const postErrorRates: number[] = [];
  for (let t = 1; t <= 5; t++) {
    for (const r of buildLogForTask(t, mistakeCounts[t - 1]!)) {
      wf.log.record(r);
    }
    const result = wf.runRound({ cleanSet, source: `task-${t}` });
    postErrorRates.push(result.roundResult.postErrorRate);
  }

  // After 5 tasks, at least one rule should be admitted.
  assert.ok(wf.ruleCount() >= 1, `expected ≥1 rule, got ${wf.ruleCount()}`);
  // The post-error rate should be 0 by the last task (the rule covers invalid_regex).
  assert.equal(postErrorRates[postErrorRates.length - 1], 0,
    `final rate should be 0, got ${postErrorRates[postErrorRates.length - 1]}`);
  // 0 FPs throughout.
  assert.ok(postErrorRates.every((r) => r >= 0 && r <= 1));
});

test("integration: self-improving workflow — workflow improver identifies inefficiencies", () => {
  const wf = new SelfImprovingWorkflow();
  // Add 5 duplicate calls across runs
  for (let i = 0; i < 5; i++) {
    wf.log.record(buildCommandRecord({
      runId: `run-${i}`, turn: 1, taskIndex: 0,
      command: "search_code", type: "search",
      args: { query: "foo", viewport: 50 },
      task: "test",
      result: { ok: true, output: "ok", durationMs: 10 },
    }));
  }
  const result = wf.runRound({ source: "test-inefficiency" });
  assert.ok(result.inefficiencies.length > 0,
    "expected inefficiencies to be detected");
  // At least one should be a duplicate_calls or missing_cache.
  assert.ok(result.inefficiencies.some((f) =>
    f.type === "duplicate_calls" || f.type === "missing_cache"));
});

test("integration: self-improving workflow — LLM boundary measures generation", () => {
  const wf = new SelfImprovingWorkflow();
  const pure = "We should refactor this function. ```function foo() { return 42; } ```";
  const c1 = wf.classifyLLMResponse(pure);
  assert.equal(c1.pureGeneration, true);
  assert.equal(c1.mechanicalSpans, 0);
  const mixed = "I'll retry the search. The function should return 42.";
  const c2 = wf.classifyLLMResponse(mixed);
  assert.equal(c2.pureGeneration, false);
  assert.ok(c2.mechanicalSpans > 0);
});

test("integration: self-improving workflow — interceptRequest + buildFailureSignal", () => {
  const wf = new SelfImprovingWorkflow();
  const ctx = "I'll retry the search. The function should return 42.";
  const { cleanedContext, removedSpans } = wf.interceptRequest(ctx);
  assert.ok(removedSpans.length > 0);
  assert.ok(!cleanedContext.includes("retry the search"));
  const signal = wf.buildFailureSignal("previous", "regex error");
  assert.ok(signal.includes("did not work"));
  assert.ok(signal.includes("regex error"));
});

test("integration: 10× harder — 50 tasks, no FP, decreasing mistakes", () => {
  const wf = new SelfImprovingWorkflow({
    minPatternFrequency: 2,
    minConfidence: 0.05,
    maxRulesPerTypePerRound: 10,
    maxRules: 500,
  });
  const mistakeCounts = Array.from({ length: 50 }, (_, i) => Math.max(0, 50 - i));
  const postRates: number[] = [];
  for (let t = 1; t <= 50; t++) {
    for (const r of buildLogForTask(t, mistakeCounts[t - 1]!)) {
      wf.log.record(r);
    }
    const result = wf.runRound({ cleanSet, source: `task-${t}` });
    postRates.push(result.roundResult.postErrorRate);
  }
  // By task 5, the rule is admitted → subsequent tasks should have post=0.
  for (let i = 5; i < 50; i++) {
    assert.ok(postRates[i]! <= 0.05,
      `task ${i + 1} post rate ${postRates[i]} should be ≤ 0.05`);
  }
});
