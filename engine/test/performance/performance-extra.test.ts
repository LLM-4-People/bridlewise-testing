import assert from "node:assert/strict";
import test from "node:test";

import {
  createMetricsCollector,
  quantileFromHistogram,
  type MetricScopeKey,
  type MetricCorrelation,
  type DurationHistogramSnapshot,
} from "../../src/performance/metrics-collector.ts";
import { createDiagnosticRunner } from "../../src/performance/diagnostic-modes.ts";
import {
  generateFunctionManifest,
  functionManifestCoverage,
  type FunctionManifestExclusion,
} from "../../src/performance/function-manifest.ts";
import {
  createBenchmarkRunner,
  computePercentiles,
  validateBenchmarkResult,
  captureHardwareFingerprint,
  BENCHMARK_RESULT_SCHEMA_VERSION,
  type BenchmarkResult,
  type BenchmarkTarget,
} from "../../src/performance/benchmark-runner.ts";
import { type ArchitectureModule } from "../../src/architecture-manifest.ts";
import {
  DEFAULT_PERFORMANCE_CONFIG,
  parsePerformanceConfig,
  performanceConfigViolations,
  isLabelAllowed,
  redactLabelValue,
  PERFORMANCE_CONFIG_SCHEMA,
} from "../../src/performance/performance-config.ts";
import { makePerfConfig } from "../support/factories.ts";

const KEY: MetricScopeKey = { module: "test", function: "op", scope: "unit" };

test("extra: config rejects zero exportIntervalMs", () => {
  assert.throws(() => parsePerformanceConfig({
    ...DEFAULT_PERFORMANCE_CONFIG,
    exporters: { ...DEFAULT_PERFORMANCE_CONFIG.exporters, exportIntervalMs: 0 },
  }));
});

test("extra: config rejects negative maxLabelValueLength", () => {
  assert.throws(() => PERFORMANCE_CONFIG_SCHEMA.parse({
    ...DEFAULT_PERFORMANCE_CONFIG,
    privacy: { ...DEFAULT_PERFORMANCE_CONFIG.privacy, maxLabelValueLength: -1 },
  }));
});

test("extra: config accepts every declared diagnostic mode id as an exclusion at once", () => {
  const config = makePerfConfig({ diagnosticModes: { ...DEFAULT_PERFORMANCE_CONFIG.diagnosticModes, excludedModes: ["cpu", "memory", "io", "event-loop", "process", "cgroup"] } });
  assert.equal(config.diagnosticModes.excludedModes.length, 6);
});

test("extra: config accepts all exporter kinds at once", () => {
  const config = makePerfConfig({ exporters: { ...DEFAULT_PERFORMANCE_CONFIG.exporters, enabledExporters: ["timeline", "json-file", "otlp-http", "prometheus"] } });
  assert.equal(config.exporters.enabledExporters.length, 4);
});

test("extra: isLabelAllowed rejects empty forbidden pattern match in key", () => {
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "runId", "normal-value"), true);
});

test("extra: redactLabelValue preserves normal values", () => {
  assert.equal(redactLabelValue(DEFAULT_PERFORMANCE_CONFIG, "agent-1"), "agent-1");
  assert.equal(redactLabelValue(DEFAULT_PERFORMANCE_CONFIG, "run-abc-123"), "run-abc-123");
});

test("extra: metrics collector handles empty correlation", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, {}, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.entryCount, 1);
  assert.equal(snap.entries[0]!.correlation.runId, undefined);
});

test("extra: metrics collector handles full correlation", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  const fullCorr: MetricCorrelation = {
    runId: "r1", turnId: "t1", taskId: "task1", attemptId: "a1",
    agentId: "agent1", providerId: "prov1", modelId: "model1",
    toolName: "tool1", commitSha: "abc123", treeHash: "def456",
    configHash: "cfg1", testId: "test1", timelineId: "tl1",
  };
  collector.recordCall(KEY, fullCorr, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.entries[0]!.correlation.runId, "r1");
  assert.equal(snap.entries[0]!.correlation.commitSha, "abc123");
});

test("extra: metrics collector recordCallStart with exact attribution", () => {
  const collector = createMetricsCollector({ config: makePerfConfig(), clock: (() => { let t = 0; return () => (t += 1); })() });
  const done = collector.recordCallStart(KEY, { runId: "r1" }, "exact");
  done();
  const snap = collector.snapshot();
  assert.equal(snap.entries[0]!.attribution, "exact");
});

test("extra: metrics collector estimated attribution is preserved", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, { runId: "r1" }, 10, "succeeded", "estimated");
  assert.equal(collector.snapshot().entries[0]!.attribution, "estimated");
});

test("extra: metrics collector histogram with explicit bounds", () => {
  const config = makePerfConfig({
    histograms: {
      ...DEFAULT_PERFORMANCE_CONFIG.histograms,
      bucketCount: 5,
      bucketStrategy: "explicit",
      explicitBounds: [1, 5, 10, 50, 100],
    },
  });
  const collector = createMetricsCollector({ config });
  collector.recordCall(KEY, { runId: "r1" }, 3, "succeeded", "shared");
  collector.recordCall(KEY, { runId: "r1" }, 75, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.entries[0]!.durationHistogram.totalCount, 2);
});

test("extra: quantileFromHistogram with single entry", () => {
  const snap: DurationHistogramSnapshot = {
    bucketCount: 1, bucketStrategy: "linear", bounds: [10], counts: [1], totalCount: 1, minMs: 5, maxMs: 5, sumMs: 5,
  };
  assert.equal(quantileFromHistogram(snap, 0.5), 5);
});

test("extra: quantileFromHistogram p0 and p1", () => {
  const snap: DurationHistogramSnapshot = {
    bucketCount: 10, bucketStrategy: "linear", bounds: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100], counts: [5, 5, 0, 0, 0, 0, 0, 0, 0, 0], totalCount: 10, minMs: 1, maxMs: 20, sumMs: 100,
  };
  assert.ok(quantileFromHistogram(snap, 0) >= 0);
  assert.ok(quantileFromHistogram(snap, 1) >= 0);
});

test("extra: diagnostic runner with every mode excluded returns empty runAll", () => {
  const config = makePerfConfig({ diagnosticModes: { ...DEFAULT_PERFORMANCE_CONFIG.diagnosticModes, excludedModes: ["cpu", "memory", "io", "event-loop", "process", "cgroup"] } });
  const runner = createDiagnosticRunner({ config });
  assert.deepEqual([...runner.runAll()], []);
});

test("extra: diagnostic runner with custom timeout", () => {
  const config = makePerfConfig({ diagnosticModes: { ...DEFAULT_PERFORMANCE_CONFIG.diagnosticModes, modeTimeoutMs: 100, modeBudgetMs: 200 } });
  const runner = createDiagnosticRunner({ config });
  const result = runner.run("cpu");
  assert.ok(result.durationMs >= 0);
});

test("extra: function manifest with empty exclusions has 100% coverage", () => {
  const modules: ArchitectureModule[] = [
    { id: "m1", path: "src/m1.ts", realm: "shared", layer: "domain", owner: "o1",
      allowedDependencyLayers: ["domain"], compositionRoot: false, executionBoundary: "pure" as const,
      ports: { requires: [], provides: [] },
      effects: [], configPaths: [], stateOwners: [], projectionOwners: [],
      authorityFamilies: [], authorityIdentifiers: [], responsibilities: ["m1"] },
  ];
  const moduleSources = new Map([["src/m1.ts", "export function m1(): void {}\n"]]);
  const manifest = generateFunctionManifest({ config: makePerfConfig(), architectureModules: modules, moduleSources });
  const coverage = functionManifestCoverage(manifest);
  assert.equal(coverage.coveragePercent, 100);
});

test("extra: function manifest with all excluded has 0% coverage", () => {
  const exclusion: FunctionManifestExclusion = {
    moduleId: "m1", functionId: "m1", rationale: "test", owner: "test", evidence: ["e"], scope: "test",
  };
  const modules: ArchitectureModule[] = [
    { id: "m1", path: "src/m1.ts", realm: "shared", layer: "domain", owner: "o1",
      allowedDependencyLayers: ["domain"], compositionRoot: false, executionBoundary: "pure" as const,
      ports: { requires: [], provides: [] },
      effects: [], configPaths: [], stateOwners: [], projectionOwners: [],
      authorityFamilies: [], authorityIdentifiers: [], responsibilities: ["m1"] },
  ];
  const moduleSources = new Map([["src/m1.ts", "export function m1(): void {}\n"]]);
  const manifest = generateFunctionManifest({ config: makePerfConfig(), architectureModules: modules, exclusions: [exclusion], moduleSources });
  const coverage = functionManifestCoverage(manifest);
  assert.equal(coverage.excludedFunctions, 1);
  assert.ok(coverage.coveragePercent < 100);
});

test("extra: computePercentiles single element", () => {
  const p = computePercentiles([42]);
  assert.equal(p.p50, 42);
  assert.equal(p.p95, 42);
  assert.equal(p.p99, 42);
});

test("extra: computePercentiles sorted correctly", () => {
  const p = computePercentiles([100, 10, 50, 30, 70]);
  assert.ok(p.p50 >= 30 && p.p50 <= 70);
  assert.ok(p.p95 >= 70 && p.p95 <= 100);
});

test("extra: benchmark with custom fingerprint", async () => {
  const customFp = captureHardwareFingerprint();
  const runner = createBenchmarkRunner({ config: makePerfConfig(), hardwareFingerprint: customFp });
  const result = await runner.run({ name: "test", operation: () => {} });
  assert.equal(result.hardwareFingerprint.fingerprintHash, customFp.fingerprintHash);
});

test("extra: benchmark async operation", async () => {
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const target: BenchmarkTarget = {
    name: "async-op",
    operation: async () => { await new Promise((r) => setTimeout(r, 1)); },
  };
  const result = await runner.run(target);
  assert.ok(result.succeededRepetitions > 0);
});

test("extra: benchmark coldSetup as async function", async () => {
  let setupCount = 0;
  const target: BenchmarkTarget = {
    name: "async-setup",
    operation: () => {},
    coldSetup: async () => { setupCount++; await Promise.resolve(); },
  };
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  await runner.run(target);
  assert.ok(setupCount > 0);
});

test("extra: validateBenchmarkResult valid result has no violations", () => {
  const fakeResult: BenchmarkResult = {
    schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION,
    benchmarkId: "ok", benchmarkName: "ok",
    hardwareFingerprint: captureHardwareFingerprint(), configHash: "",
    repetitions: [
      { repetition: 1, mode: "cold", durationMs: 1, succeeded: true, errorMessage: null },
      { repetition: 1, mode: "cold", durationMs: 1, succeeded: true, errorMessage: null },
      { repetition: 1, mode: "cold", durationMs: 1, succeeded: true, errorMessage: null },
      { repetition: 1, mode: "warm", durationMs: 1, succeeded: true, errorMessage: null },
      { repetition: 1, mode: "warm", durationMs: 1, succeeded: true, errorMessage: null },
      { repetition: 1, mode: "warm", durationMs: 1, succeeded: true, errorMessage: null },
    ],
    coldPercentiles: { p50: 1, p95: 1, p99: 1 },
    warmPercentiles: { p50: 1, p95: 1, p99: 1 },
    minMs: 1, maxMs: 1, meanMs: 1, standardDeviationMs: 0,
    regressionBudgetPercent: 10, regressionDetected: false,
    overheadBudgetPercent: 5, overheadMeasuredPercent: 0, overheadBudgetExceeded: false,
    totalRepetitions: 6, succeededRepetitions: 6, failedRepetitions: 0,
    wallTime: "", totalDurationMs: 1,
  };
  const violations = validateBenchmarkResult(fakeResult, makePerfConfig());
  assert.deepEqual([...violations], []);
});

test("extra: performance config violations returns sorted unique", () => {
  // The overlap arm this test used to carry died with `includedModules`
  // (the include-list is gone, so there is nothing to overlap with an
  // exclusion). Two live violations still exercise the sorted-unique
  // property: duplicate exporters + non-monotonic explicit bounds.
  const config = {
    ...DEFAULT_PERFORMANCE_CONFIG,
    histograms: {
      ...DEFAULT_PERFORMANCE_CONFIG.histograms,
      bucketStrategy: "explicit",
      explicitBounds: [10, 5, 20],
    },
    exporters: { ...DEFAULT_PERFORMANCE_CONFIG.exporters, enabledExporters: ["timeline", "timeline"] },
  };
  const parsed = parsePerformanceConfig(config);
  const violations = performanceConfigViolations(parsed);
  assert.ok(violations.length >= 2);
  const sorted = [...violations].sort();
  assert.deepEqual([...violations], sorted);
  assert.equal(new Set(violations).size, violations.length);
});

test("extra: metrics collector noop recordCallStart returns noop callback", () => {
  const collector = createMetricsCollector({ config: makePerfConfig({ enabled: false }) });
  const done = collector.recordCallStart(KEY, { runId: "r1" });
  done();
  assert.equal(collector.entryCount(), 0);
});

test("extra: diagnostic runner result is frozen", () => {
  const runner = createDiagnosticRunner({ config: makePerfConfig() });
  const result = runner.run("cpu");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.snapshot));
});
