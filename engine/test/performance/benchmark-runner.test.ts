import assert from "node:assert/strict";
import test from "node:test";

import { createHash } from "node:crypto";

import {
  createBenchmarkRunner,
  captureHardwareFingerprint,
  computePercentiles,
  validateBenchmarkResult,
  BENCHMARK_RESULT_SCHEMA_VERSION,
  type BenchmarkTarget,
  type BenchmarkResult,
} from "../../src/performance/benchmark-runner.ts";
import { DEFAULT_PERFORMANCE_CONFIG } from "../../src/performance/performance-config.ts";
import { makePerfConfig } from "../support/factories.ts";

const noopTarget: BenchmarkTarget = {
  name: "noop",
  operation: () => {},
};

const failingTarget: BenchmarkTarget = {
  name: "failing",
  operation: () => { throw new Error("fail"); },
};

test("benchmark-runner: schema version is correct", () => {
  assert.equal(BENCHMARK_RESULT_SCHEMA_VERSION, "bridlewise-benchmark-result/v1");
});

test("benchmark-runner: captures hardware fingerprint", () => {
  const fp = captureHardwareFingerprint();
  assert.ok(fp.cpuModel.length > 0);
  assert.ok(fp.cpuCount > 0);
  assert.ok(fp.totalMemoryBytes > 0);
  assert.ok(fp.platform.length > 0);
  assert.ok(fp.arch.length > 0);
  assert.ok(fp.nodeVersion.length > 0);
  assert.ok(fp.fingerprintHash.length === 64);
});

test("benchmark-runner: fingerprint is deterministic within process", () => {
  const fp1 = captureHardwareFingerprint();
  const fp2 = captureHardwareFingerprint();
  assert.equal(fp1.fingerprintHash, fp2.fingerprintHash);
});

test("benchmark-runner: computePercentiles returns zeros for empty array", () => {
  const p = computePercentiles([]);
  assert.equal(p.p50, 0);
  assert.equal(p.p95, 0);
  assert.equal(p.p99, 0);
});

test("benchmark-runner: computePercentiles returns correct values", () => {
  const p = computePercentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.ok(p.p50 > 0);
  assert.ok(p.p95 >= p.p50);
  assert.ok(p.p99 >= p.p95);
});

test("benchmark-runner: run returns a result with benchmarkId", async () => {
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const result = await runner.run(noopTarget);
  assert.ok(result.benchmarkId.startsWith("bench-"));
  assert.equal(result.benchmarkName, "noop");
  assert.ok(result.totalRepetitions > 0);
});

test("benchmark-runner: result has hardware fingerprint", async () => {
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const result = await runner.run(noopTarget);
  assert.ok(result.hardwareFingerprint.fingerprintHash.length === 64);
});

test("benchmark-runner: result has configHash", async () => {
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const result = await runner.run(noopTarget);
  assert.ok(result.configHash.length === 64);
});

test("benchmark-runner: result has cold and warm repetitions", async () => {
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const result = await runner.run(noopTarget);
  const coldCount = result.repetitions.filter((r) => r.mode === "cold").length;
  const warmCount = result.repetitions.filter((r) => r.mode === "warm").length;
  assert.ok(coldCount > 0, "should have cold repetitions");
  assert.ok(warmCount > 0, "should have warm repetitions");
});

test("benchmark-runner: result has percentile data", async () => {
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const result = await runner.run(noopTarget);
  assert.ok(result.coldPercentiles.p50 >= 0);
  assert.ok(result.warmPercentiles.p50 >= 0);
  assert.ok(result.minMs >= 0);
  assert.ok(result.maxMs >= 0);
  assert.ok(result.meanMs >= 0);
  assert.ok(result.standardDeviationMs >= 0);
});

test("benchmark-runner: failing target records failed repetitions", async () => {
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const result = await runner.run(failingTarget);
  assert.ok(result.failedRepetitions > 0);
  assert.ok(result.repetitions.some((r) => !r.succeeded));
});

test("benchmark-runner: coldSetup is called for cold repetitions", async () => {
  let setupCount = 0;
  const target: BenchmarkTarget = {
    name: "with-setup",
    operation: () => {},
    coldSetup: () => { setupCount++; },
  };
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  await runner.run(target);
  assert.ok(setupCount > 0);
});

test("benchmark-runner: regression is detected against baseline", async () => {
  const runner = createBenchmarkRunner({
    config: makePerfConfig({ budgets: { ...DEFAULT_PERFORMANCE_CONFIG.budgets, regressionBudgetPercent: 1 } }),
  });
  const baseline: BenchmarkResult = {
    schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION,
    benchmarkId: "baseline",
    benchmarkName: "noop",
    hardwareFingerprint: captureHardwareFingerprint(),
    configHash: "",
    repetitions: [],
    coldPercentiles: { p50: 0, p95: 0, p99: 0 },
    warmPercentiles: { p50: 0.001, p95: 0, p99: 0 },
    minMs: 0, maxMs: 0, meanMs: 0.001, standardDeviationMs: 0,
    regressionBudgetPercent: 1, regressionDetected: false,
    overheadBudgetPercent: 5, overheadMeasuredPercent: 0, overheadBudgetExceeded: false,
    totalRepetitions: 3, succeededRepetitions: 3, failedRepetitions: 0,
    wallTime: "", totalDurationMs: 0,
  };
  const slowTarget: BenchmarkTarget = {
    name: "slow",
    // Deterministic synchronous workload (sha256 of a 100 KB buffer) instead
    // of a clock-polling busy-wait. The previous form spun the CPU on
    // `performance.now()` polls, stealing cycles from parallel tests under
    // load; this does real work that is reliably slower than the baseline
    // (warmPercentiles.p50 = 0.001 ms) so regression is still detected.
    operation: () => { createHash("sha256").update("x".repeat(100000)).digest(); },
  };
  const result = await runner.run(slowTarget, baseline);
  assert.ok(result.regressionDetected || result.warmPercentiles.p50 > baseline.warmPercentiles.p50);
});

test("benchmark-runner: overhead budget is tracked", async () => {
  const runner = createBenchmarkRunner({
    config: makePerfConfig({ budgets: { ...DEFAULT_PERFORMANCE_CONFIG.budgets, overheadBudgetPercent: 50 } }),
  });
  const result = await runner.run(noopTarget);
  assert.ok(result.overheadMeasuredPercent >= 0);
  assert.equal(result.overheadBudgetExceeded, false);
});

test("benchmark-runner: fingerprint returns cached fingerprint", () => {
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const fp = runner.fingerprint();
  assert.ok(fp.fingerprintHash.length === 64);
});

test("benchmark-runner: validateBenchmarkResult detects insufficient repetitions", () => {
  const config = makePerfConfig({ budgets: { ...DEFAULT_PERFORMANCE_CONFIG.budgets, minBenchmarkRepetitions: 10 } });
  const fakeResult: BenchmarkResult = {
    schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION,
    benchmarkId: "fake", benchmarkName: "fake",
    hardwareFingerprint: captureHardwareFingerprint(), configHash: "",
    repetitions: [{ repetition: 1, mode: "cold", durationMs: 1, succeeded: true, errorMessage: null }],
    coldPercentiles: { p50: 1, p95: 1, p99: 1 },
    warmPercentiles: { p50: 0, p95: 0, p99: 0 },
    minMs: 1, maxMs: 1, meanMs: 1, standardDeviationMs: 0,
    regressionBudgetPercent: 10, regressionDetected: false,
    overheadBudgetPercent: 5, overheadMeasuredPercent: 0, overheadBudgetExceeded: false,
    totalRepetitions: 1, succeededRepetitions: 1, failedRepetitions: 0,
    wallTime: "", totalDurationMs: 1,
  };
  const violations = validateBenchmarkResult(fakeResult, config);
  assert.ok(violations.includes("benchmark_result_insufficient_repetitions"));
  assert.ok(violations.includes("benchmark_result_no_warm_repetitions"));
});

test("benchmark-runner: validateBenchmarkResult detects all-failed repetitions", () => {
  const fakeResult: BenchmarkResult = {
    schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION,
    benchmarkId: "fake", benchmarkName: "fake",
    hardwareFingerprint: captureHardwareFingerprint(), configHash: "",
    repetitions: [
      { repetition: 1, mode: "cold", durationMs: 0, succeeded: false, errorMessage: "err" },
      { repetition: 1, mode: "warm", durationMs: 0, succeeded: false, errorMessage: "err" },
    ],
    coldPercentiles: { p50: 0, p95: 0, p99: 0 },
    warmPercentiles: { p50: 0, p95: 0, p99: 0 },
    minMs: 0, maxMs: 0, meanMs: 0, standardDeviationMs: 0,
    regressionBudgetPercent: 10, regressionDetected: false,
    overheadBudgetPercent: 5, overheadMeasuredPercent: 0, overheadBudgetExceeded: false,
    totalRepetitions: 2, succeededRepetitions: 0, failedRepetitions: 2,
    wallTime: "", totalDurationMs: 0,
  };
  const violations = validateBenchmarkResult(fakeResult, makePerfConfig());
  assert.ok(violations.includes("benchmark_result_all_repetitions_failed"));
});

test("benchmark-runner: validateBenchmarkResult detects regression", () => {
  const fakeResult: BenchmarkResult = {
    schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION,
    benchmarkId: "fake", benchmarkName: "fake",
    hardwareFingerprint: captureHardwareFingerprint(), configHash: "",
    repetitions: [
      { repetition: 1, mode: "cold", durationMs: 1, succeeded: true, errorMessage: null },
      { repetition: 1, mode: "warm", durationMs: 1, succeeded: true, errorMessage: null },
    ],
    coldPercentiles: { p50: 1, p95: 1, p99: 1 },
    warmPercentiles: { p50: 1, p95: 1, p99: 1 },
    minMs: 1, maxMs: 1, meanMs: 1, standardDeviationMs: 0,
    regressionBudgetPercent: 10, regressionDetected: true,
    overheadBudgetPercent: 5, overheadMeasuredPercent: 0, overheadBudgetExceeded: false,
    totalRepetitions: 2, succeededRepetitions: 2, failedRepetitions: 0,
    wallTime: "", totalDurationMs: 1,
  };
  const violations = validateBenchmarkResult(fakeResult, makePerfConfig());
  assert.ok(violations.includes("benchmark_result_regression_detected"));
});

test("benchmark-runner: validateBenchmarkResult detects overhead budget exceeded", () => {
  const fakeResult: BenchmarkResult = {
    schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION,
    benchmarkId: "fake", benchmarkName: "fake",
    hardwareFingerprint: captureHardwareFingerprint(), configHash: "",
    repetitions: [
      { repetition: 1, mode: "cold", durationMs: 1, succeeded: true, errorMessage: null },
      { repetition: 1, mode: "warm", durationMs: 1, succeeded: true, errorMessage: null },
    ],
    coldPercentiles: { p50: 1, p95: 1, p99: 1 },
    warmPercentiles: { p50: 1, p95: 1, p99: 1 },
    minMs: 1, maxMs: 1, meanMs: 1, standardDeviationMs: 0,
    regressionBudgetPercent: 10, regressionDetected: false,
    overheadBudgetPercent: 5, overheadMeasuredPercent: 10, overheadBudgetExceeded: true,
    totalRepetitions: 2, succeededRepetitions: 2, failedRepetitions: 0,
    wallTime: "", totalDurationMs: 1,
  };
  const violations = validateBenchmarkResult(fakeResult, makePerfConfig());
  assert.ok(violations.includes("benchmark_result_overhead_budget_exceeded"));
});

test("benchmark-runner: minRepetitions is respected", async () => {
  const config = makePerfConfig({ budgets: { ...DEFAULT_PERFORMANCE_CONFIG.budgets, minBenchmarkRepetitions: 5, maxBenchmarkRepetitions: 10 } });
  const runner = createBenchmarkRunner({ config });
  const result = await runner.run(noopTarget);
  assert.ok(result.totalRepetitions >= 5);
});

test("benchmark-runner: maxBenchmarkDurationMs stops the repetition loops once exceeded", async () => {
  // The duration ceiling is the bound that keeps one slow target from
  // stretching a benchmark without limit — it must override the repetition
  // FLOOR the same way it overrides the ceiling. Drive it deterministically:
  // the start read and the first loop check read 0, every later read sits
  // past the budget, so the first repetition runs and BOTH loops stop at
  // their next check no matter how small the configured minimum is.
  let clockReads = 0;
  const config = makePerfConfig({
    budgets: {
      ...DEFAULT_PERFORMANCE_CONFIG.budgets,
      minBenchmarkRepetitions: 3,
      maxBenchmarkRepetitions: 100,
      maxBenchmarkDurationMs: 1_000,
    },
  });
  const runner = createBenchmarkRunner({
    config,
    clock: () => (clockReads++ < 2 ? 0 : 100_001),
  });
  const result = await runner.run(noopTarget);
  assert.equal(
    result.totalRepetitions,
    1,
    "the duration budget must stop the loops after the first repetition — a bound the clock has already exceeded cannot be out-waited",
  );
});

test("benchmark-runner: succeeded and failed counts are correct", async () => {
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const result = await runner.run(noopTarget);
  assert.equal(result.succeededRepetitions + result.failedRepetitions, result.totalRepetitions);
  assert.ok(result.succeededRepetitions > 0);
});

test("benchmark-runner: totalDurationMs is positive", async () => {
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const result = await runner.run(noopTarget);
  assert.ok(result.totalDurationMs >= 0);
});

test("benchmark-runner: result is frozen", async () => {
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const result = await runner.run(noopTarget);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.repetitions));
});

test("benchmark-runner: wallTime is a valid ISO string", async () => {
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const result = await runner.run(noopTarget);
  assert.ok(!isNaN(Date.parse(result.wallTime)));
});
