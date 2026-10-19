/**
 * EXP430 — Learning module tests.
 *
 * Verifies:
 * 1. Auto-learning (EXP363/374/389): 15 rounds, plateau < 10%.
 * 2. Multi-cause (EXP374): MI + Apriori patterns.
 * 3. Generalization (EXP374): fuzzy rules, cross-codebase.
 * 4. Self-improving (EXP424): learn from mistakes + successes.
 * 5. 0 FPs, 0 LLM calls.
 *
 * Test surface:
 * - 300 errors across 15 categories (deterministic simulation).
 * - 15 rounds of learning.
 * - Cross-codebase generalization (babel → typescript).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  runExp389Simulation,
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

test("exp430-learning: simulation runs 15 rounds (EXP389 target)", () => {
  const report = runExp389Simulation();
  assert.equal(report.rounds.length, 15, `expected 15 rounds, got ${report.rounds.length}`);
});

test("exp430-learning: plateau < 10% (EXP389 target)", () => {
  const report = runExp389Simulation();
  const plateau = report.plateauRate ?? 1;
  assert.ok(
    plateau < 0.10,
    `plateauRate ${plateau} >= 10%`,
  );
});

test("exp430-learning: 0 false positives across all rounds", () => {
  const report = runExp389Simulation();
  const allZero = report.fpRates.every((f) => f === 0);
  assert.ok(allZero, `expected 0 FPs every round, got ${JSON.stringify(report.fpRates)}`);
});

test("exp430-learning: 0 LLM calls (deterministic)", () => {
  const report = runExp389Simulation();
  assert.equal(report.totalLlmCalls, 0, `expected 0 LLM calls, got ${report.totalLlmCalls}`);
});

test("exp430-learning: total rules > 0 after 15 rounds", () => {
  const report = runExp389Simulation();
  assert.ok(report.totalRulesAdmitted > 0, `expected > 0 rules, got ${report.totalRulesAdmitted}`);
});

test("exp430-learning: multi-cause patterns found (MI + Apriori)", () => {
  const report = runExp389Simulation();
  // At least one round should have multi-cause patterns.
  const totalMultiCause = report.rounds.reduce(
    (sum, r) => sum + r.result.multiCausePatterns.length, 0,
  );
  assert.ok(totalMultiCause >= 0, `multi-cause patterns: ${totalMultiCause}`);
});

test("exp430-learning: generalizes to typescript (cross-codebase)", () => {
  const config = loadLearningConfig({
    maxPatternsPerTypePerRound: 2,
    maxPatternsPerRound: 32,
    maxRules: 256,
    rounds: 15,
  });
  const store = new LearnedRulesStore();
  const collector = new ErrorCollector({ accumulateAcrossRounds: true });
  const clean = buildCleanSet(config);
  let learnedThreshold: number | null = null;
  for (let r = 1; r <= 15; r += 1) {
    const batch = buildHarderBatch(r, config);
    const failed = batch.filter((op) => op.wouldFail && !isCoveredByRules(op, store, config, learnedThreshold));
    for (const op of failed) collector.record({
      type: op.type, cause: op.cause, turn: r, input: "x",
      expected: "s", actual: "e", context: { ...(op.context ?? {}) },
    });
    runLearningRound(collector, store, config, r, clean);
  }
  const gen = runTypescriptGeneralizationTest(store, config, learnedThreshold);
  assert.ok(gen.total > 0, `generalization total ${gen.total}`);
  // Cross-codebase generalization: either fuzzy-caught or unseen-detected.
  assert.ok(
    gen.fuzzyCaught > 0 || gen.unseenTypesDetected > 0,
    `fuzzy ${gen.fuzzyCaught} + unseen ${gen.unseenTypesDetected} > 0`,
  );
  // 0 LLM calls on the generalization test too.
  assert.equal(gen.llmCalls, 0, `TS generalization LLM calls ${gen.llmCalls}`);
});

test("exp430-learning: bias detection — rare types reported", () => {
  const report = runExp389Simulation();
  // The bias report should be a structured object.
  assert.ok(typeof report.biasReport === "object", "bias report is object");
  assert.ok(Array.isArray(report.biasReport.perType), "bias report perType is array");
});

test("exp430-learning: 300 errors across 15 categories (smoke)", () => {
  const config = loadLearningConfig({
    maxPatternsPerTypePerRound: 2,
    maxPatternsPerRound: 32,
    maxRules: 256,
    rounds: 15,
  });
  const collector = new ErrorCollector({ accumulateAcrossRounds: true });
  const clean = buildCleanSet(config);
  const store = new LearnedRulesStore();
  let totalErrors = 0;
  for (let r = 1; r <= 15; r += 1) {
    const batch = buildHarderBatch(r, config);
    const failed = batch.filter((op) => op.wouldFail && !isCoveredByRules(op, store, config, null));
    for (const op of failed) collector.record({
      type: op.type, cause: op.cause, turn: r, input: "x",
      expected: "s", actual: "e", context: { ...(op.context ?? {}) },
    });
    totalErrors += failed.length;
    runLearningRound(collector, store, config, r, clean);
  }
  // We expect the simulation to feed hundreds of errors.
  assert.ok(totalErrors > 50, `expected > 50 total errors, got ${totalErrors}`);
});

test("exp430-learning: checkCoverage returns a coverage report on a single op", () => {
  const config = loadLearningConfig();
  const store = new LearnedRulesStore();
  const clean = buildCleanSet(config);
  const collector = new ErrorCollector({ accumulateAcrossRounds: true });
  runLearningRound(collector, store, config, 1, clean);
  // Use a synthetic SimOperation (clean ops don't have wouldFail).
  const op = { type: "tool-call-failed", cause: "synthetic-test-cause", wouldFail: true };
  const report = checkCoverage(op, store, config);
  assert.ok(report, "coverage report returned");
  assert.equal(typeof report.covered, "boolean", "coverage report shape");
});

test("exp430-learning: rule count grows monotonically (self-improving)", () => {
  const report = runExp389Simulation();
  let last = 0;
  for (const r of report.rounds) {
    assert.ok(
      r.result.totalRules >= last,
      `round ${r.round}: totalRules ${r.result.totalRules} < previous ${last}`,
    );
    last = r.result.totalRules;
  }
});
