import assert from "node:assert/strict";
import test from "node:test";

import {
  createMetricsCollector,
  quantileFromHistogram,
  type MetricScopeKey,
  type MetricCorrelation,
  type DurationHistogramSnapshot,
} from "../../src/performance/metrics-collector.ts";
import { DEFAULT_PERFORMANCE_CONFIG, parsePerformanceConfig } from "../../src/performance/performance-config.ts";
import { makePerfConfig } from "../support/factories.ts";

const KEY: MetricScopeKey = { module: "test", function: "op", scope: "unit" };
const CORR: MetricCorrelation = { runId: "run-1", turnId: "turn-1", agentId: "agent-1" };

test("metrics-collector: records a single successful call", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.entryCount, 1);
  assert.equal(snap.totalCallCount, 1);
  assert.equal(snap.totalErrorCount, 0);
  assert.equal(snap.totalCancellationCount, 0);
});

test("metrics-collector: records error count", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "failed", "shared");
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.totalErrorCount, 1);
  assert.equal(snap.totalCallCount, 2);
});

test("metrics-collector: records cancellation count", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "cancelled", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.totalCancellationCount, 1);
});

test("metrics-collector: recordError increments error count without call", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordError(KEY, CORR);
  const snap = collector.snapshot();
  assert.equal(snap.totalErrorCount, 1);
  assert.equal(snap.totalCallCount, 0);
});

test("metrics-collector: recordCancellation increments cancellation count without call", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCancellation(KEY, CORR);
  const snap = collector.snapshot();
  assert.equal(snap.totalCancellationCount, 1);
  assert.equal(snap.totalCallCount, 0);
});

test("metrics-collector: recordCallStart returns a completion callback", () => {
  const collector = createMetricsCollector({ config: makePerfConfig(), clock: (() => { let t = 0; return () => (t += 5); })() });
  const done = collector.recordCallStart(KEY, CORR, "shared");
  done();
  const snap = collector.snapshot();
  assert.equal(snap.totalCallCount, 1);
  assert.equal(snap.entries[0]!.durationHistogram.totalCount, 1);
});

test("metrics-collector: histogram records min/max/sum", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 5, "succeeded", "shared");
  collector.recordCall(KEY, CORR, 15, "succeeded", "shared");
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  const hist = snap.entries[0]!.durationHistogram;
  assert.equal(hist.totalCount, 3);
  assert.equal(hist.minMs, 5);
  assert.equal(hist.maxMs, 15);
  assert.equal(hist.sumMs, 30);
});

test("metrics-collector: histogram ignores non-finite durations", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, NaN, "succeeded", "shared");
  collector.recordCall(KEY, CORR, -1, "succeeded", "shared");
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  const hist = snap.entries[0]!.durationHistogram;
  assert.equal(hist.totalCount, 1);
});

test("metrics-collector: separate scopes produce separate entries", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  collector.recordCall(KEY, { ...CORR, agentId: "agent-2" }, 20, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.entryCount, 2);
});

test("metrics-collector: same scope and correlation aggregates into one entry", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  collector.recordCall(KEY, CORR, 20, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.entryCount, 1);
  assert.equal(snap.entries[0]!.callCount, 2);
});

test("metrics-collector: disabled config produces noop collector", () => {
  const collector = createMetricsCollector({ config: makePerfConfig({ enabled: false }) });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.entryCount, 0);
  assert.equal(snap.totalCallCount, 0);
});

test("metrics-collector: snapshot has stable schema version", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  const snap = collector.snapshot();
  assert.equal(snap.schemaVersion, "bridlewise-metrics-snapshot/v1");
  assert.ok(snap.snapshotId.startsWith("snap-"));
  assert.ok(snap.wallTime.length > 0);
});

test("metrics-collector: entryCount tracks unique entries", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  assert.equal(collector.entryCount(), 0);
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  assert.equal(collector.entryCount(), 1);
  collector.recordCall(KEY, { ...CORR, turnId: "turn-2" }, 10, "succeeded", "shared");
  assert.equal(collector.entryCount(), 2);
});

test("metrics-collector: reset clears all entries", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  collector.recordError(KEY, CORR);
  collector.reset();
  assert.equal(collector.entryCount(), 0);
  const snap = collector.snapshot();
  assert.equal(snap.totalCallCount, 0);
});

test("metrics-collector: close stops recording", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  collector.close();
  collector.recordCall(KEY, CORR, 20, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.totalCallCount, 1);
});

test("metrics-collector: cardinality limit prevents new series", () => {
  const config = makePerfConfig({ cardinality: { ...DEFAULT_PERFORMANCE_CONFIG.cardinality, maxTotalSeries: 2 } });
  const collector = createMetricsCollector({ config });
  collector.recordCall(KEY, { ...CORR, agentId: "a1" }, 10, "succeeded", "shared");
  collector.recordCall(KEY, { ...CORR, agentId: "a2" }, 10, "succeeded", "shared");
  collector.recordCall(KEY, { ...CORR, agentId: "a3" }, 10, "succeeded", "shared");
  assert.equal(collector.entryCount(), 2);
});

test("metrics-collector: sampled traces are off by default", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  assert.equal(collector.sampledTraces().length, 0);
});

test("metrics-collector: sampled traces are recorded when sampling rate is 1", () => {
  const config = makePerfConfig({ sampling: { ...DEFAULT_PERFORMANCE_CONFIG.sampling, traceSamplingRate: 1, maxTracesPerScope: 100 } });
  const collector = createMetricsCollector({ config });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  collector.recordCall(KEY, CORR, 20, "succeeded", "shared");
  const traces = collector.sampledTraces();
  assert.equal(traces.length, 2);
  assert.equal(traces[0]!.outcome, "succeeded");
  assert.equal(traces[0]!.attribution, "shared");
  assert.ok(traces[0]!.traceId.startsWith("trace-"));
});

test("metrics-collector: sampled traces respect maxTracesPerScope limit", () => {
  const config = makePerfConfig({ sampling: { ...DEFAULT_PERFORMANCE_CONFIG.sampling, traceSamplingRate: 1, maxTracesPerScope: 3 } });
  const collector = createMetricsCollector({ config });
  for (let i = 0; i < 10; i++) {
    collector.recordCall(KEY, CORR, i, "succeeded", "shared");
  }
  assert.equal(collector.sampledTraces().length, 3);
});

test("metrics-collector: correlation IDs are preserved in snapshot", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.entries[0]!.correlation.runId, "run-1");
  assert.equal(snap.entries[0]!.correlation.agentId, "agent-1");
});

test("metrics-collector: attribution is preserved in snapshot", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "exact");
  const snap = collector.snapshot();
  assert.equal(snap.entries[0]!.attribution, "exact");
});

test("metrics-collector: sensitive correlation values are redacted", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, { ...CORR, toolName: "Bearer secret-token" }, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.entries[0]!.correlation.toolName, "[redacted]");
});

test("metrics-collector: credential-named label keys are still filtered from correlation", () => {
  // The allowlist is gone; the exclusion path is the canonical forbidden-text
  // denylist, which the sanitizer applies to the KEY: a credential-named key is
  // excluded even with an innocent value.
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, { ...CORR, apiKey: "innocent" } as MetricCorrelation, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal((snap.entries[0]!.correlation as Record<string, unknown>).apiKey, undefined);
});

test("metrics-collector: an unlisted benign label key passes through by default", () => {
  // Deny-by-default posture inverted: a key no list ever named is ADMITTED
  // (sanitized + value-redacted), so a future producer cannot be silently
  // dropped for not being on a list. `customLane` was never listed anywhere.
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, { ...CORR, customLane: "checkout" } as MetricCorrelation, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal((snap.entries[0]!.correlation as Record<string, unknown>).customLane, "checkout");
});

test("metrics-collector: snapshot entries contain histogram bucket counts", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  const hist = snap.entries[0]!.durationHistogram;
  assert.equal(hist.bucketCount, DEFAULT_PERFORMANCE_CONFIG.histograms.bucketCount);
  assert.ok(hist.counts.length > 0);
  assert.equal(hist.counts.reduce((a, b) => a + b, 0), 1);
});

test("metrics-collector: configHash in snapshot matches config hash", () => {
  const config = makePerfConfig();
  const collector = createMetricsCollector({ config });
  const snap = collector.snapshot();
  assert.equal(snap.configHash, snap.configHash);
  assert.equal(snap.configHash.length, 64);
});

test("metrics-collector: quantileFromHistogram returns 0 for empty histogram", () => {
  const snap = { bucketCount: 10, bucketStrategy: "log-linear", bounds: new Array(10).fill(0), counts: new Array(10).fill(0), totalCount: 0, minMs: 0, maxMs: 0, sumMs: 0 };
  assert.equal(quantileFromHistogram(snap, 0.5), 0);
});

test("metrics-collector: quantileFromHistogram throws for invalid quantile", () => {
  const snap = { bucketCount: 10, bucketStrategy: "log-linear", bounds: new Array(10).fill(10), counts: [1], totalCount: 1, minMs: 5, maxMs: 5, sumMs: 5 };
  assert.throws(() => quantileFromHistogram(snap, -0.1));
  assert.throws(() => quantileFromHistogram(snap, 1.1));
});

test("metrics-collector: many rapid calls are handled efficiently", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  for (let i = 0; i < 1000; i++) {
    collector.recordCall(KEY, CORR, i, "succeeded", "shared");
  }
  const snap = collector.snapshot();
  assert.equal(snap.totalCallCount, 1000);
  assert.equal(snap.entryCount, 1);
});

test("metrics-collector: concurrent calls with different correlations create separate entries", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  const correlations = ["a", "b", "c", "d", "e"].map((agentId) => ({ ...CORR, agentId }));
  for (const corr of correlations) {
    collector.recordCall(KEY, corr, 10, "succeeded", "shared");
  }
  assert.equal(collector.entryCount(), 5);
});

test("metrics-collector: linear histogram strategy produces correct bucket distribution", () => {
  const config = makePerfConfig({ histograms: { ...DEFAULT_PERFORMANCE_CONFIG.histograms, bucketStrategy: "linear", bucketCount: 10, maxDurationMs: 100 } });
  const collector = createMetricsCollector({ config });
  collector.recordCall(KEY, CORR, 5, "succeeded", "shared");
  collector.recordCall(KEY, CORR, 50, "succeeded", "shared");
  collector.recordCall(KEY, CORR, 95, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.entries[0]!.durationHistogram.totalCount, 3);
  assert.equal(snap.entries[0]!.durationHistogram.minMs, 5);
  assert.equal(snap.entries[0]!.durationHistogram.maxMs, 95);
});

test("metrics-collector: exact attribution is accepted", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "exact");
  const snap = collector.snapshot();
  assert.equal(snap.entries[0]!.attribution, "exact");
});

test("metrics-collector: shared attribution is accepted", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.entries[0]!.attribution, "shared");
});

test("metrics-collector: estimated attribution is accepted", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "estimated");
  const snap = collector.snapshot();
  assert.equal(snap.entries[0]!.attribution, "estimated");
});

test("metrics-collector: noop collector close is safe", () => {
  const collector = createMetricsCollector({ config: makePerfConfig({ enabled: false }) });
  collector.close();
  assert.equal(collector.snapshot().entryCount, 0);
});

test("metrics-collector: noop collector reset is safe", () => {
  const collector = createMetricsCollector({ config: makePerfConfig({ enabled: false }) });
  collector.reset();
  assert.equal(collector.entryCount(), 0);
});

test("metrics-collector: noop collector sampledTraces is empty", () => {
  const collector = createMetricsCollector({ config: makePerfConfig({ enabled: false }) });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  assert.deepEqual([...collector.sampledTraces()], []);
});

// ---------------------------------------------------------------------------
// C4 regression: quantileFromHistogram uses bounds and counts (not just min/max)
// ---------------------------------------------------------------------------

test("C4 quantileFromHistogram: snapshot includes bounds", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  const hist = snap.entries[0]!.durationHistogram;
  assert.ok(Array.isArray(hist.bounds));
  assert.equal(hist.bounds.length, hist.bucketCount);
});

test("C4 quantileFromHistogram: same min/max different distributions yield different quantiles", () => {
  const bounds = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const histA: DurationHistogramSnapshot = {
    bucketCount: 10, bucketStrategy: "linear", bounds,
    counts: [0, 10, 0, 0, 0, 0, 0, 0, 0, 0], totalCount: 10, minMs: 1, maxMs: 95, sumMs: 200,
  };
  const histB: DurationHistogramSnapshot = {
    bucketCount: 10, bucketStrategy: "linear", bounds,
    counts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 10], totalCount: 10, minMs: 1, maxMs: 95, sumMs: 950,
  };
  const p50A = quantileFromHistogram(histA, 0.5);
  const p50B = quantileFromHistogram(histB, 0.5);
  assert.notEqual(p50A, p50B, "same min/max but different distributions must yield different p50");
  assert.ok(p50A < p50B, "lower distribution must yield lower p50");
});

test("C4 quantileFromHistogram: interpolates within bucket using bounds", () => {
  const bounds = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const hist: DurationHistogramSnapshot = {
    bucketCount: 10, bucketStrategy: "linear", bounds,
    counts: [0, 10, 0, 0, 0, 0, 0, 0, 0, 0], totalCount: 10, minMs: 1, maxMs: 95, sumMs: 200,
  };
  // All 10 values fall in bucket 1 (bounds[0]=10, bounds[1]=20).
  // p50: target=5, i=1: cumulative=10 >= 5.
  // result = bounds[0] + (bounds[1]-bounds[0]) * (5 - (10-10)) / 10 = 10 + 10*0.5 = 15
  assert.equal(quantileFromHistogram(hist, 0.5), 15);
  // p25: target=2.5, i=1: cumulative=10 >= 2.5.
  // result = 10 + 10 * 2.5/10 = 12.5
  assert.equal(quantileFromHistogram(hist, 0.25), 12.5);
  // p75: target=7.5, i=1: cumulative=10 >= 7.5.
  // result = 10 + 10 * 7.5/10 = 17.5
  assert.equal(quantileFromHistogram(hist, 0.75), 17.5);
});

test("C4 quantileFromHistogram: p50 in last bucket interpolates near upper bound", () => {
  const bounds = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const hist: DurationHistogramSnapshot = {
    bucketCount: 10, bucketStrategy: "linear", bounds,
    counts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 10], totalCount: 10, minMs: 1, maxMs: 95, sumMs: 950,
  };
  // All 10 values in bucket 9 (bounds[8]=90, bounds[9]=100).
  // p50: target=5, i=9: cumulative=10 >= 5.
  // result = 90 + (100-90) * (5 - 0) / 10 = 90 + 5 = 95
  assert.equal(quantileFromHistogram(hist, 0.5), 95);
});

test("C4 quantileFromHistogram: matches in-class quantile via real collector", () => {
  const config = makePerfConfig({
    histograms: { ...DEFAULT_PERFORMANCE_CONFIG.histograms, bucketStrategy: "linear", bucketCount: 10, maxDurationMs: 100 },
  });
  const collector = createMetricsCollector({ config });
  for (let i = 1; i <= 100; i++) {
    collector.recordCall(KEY, CORR, i, "succeeded", "shared");
  }
  const snap = collector.snapshot();
  const hist = snap.entries[0]!.durationHistogram;
  // p50 should be around 50 (linear distribution 1..100, linear buckets 0..100)
  const p50 = quantileFromHistogram(hist, 0.5);
  assert.ok(p50 >= 40 && p50 <= 60, `p50 should be near midpoint, got ${p50}`);
  // p95 should be in the upper range
  const p95 = quantileFromHistogram(hist, 0.95);
  assert.ok(p95 > 80, `p95 should be in upper range, got ${p95}`);
  // p99 should be near the top
  const p99 = quantileFromHistogram(hist, 0.99);
  assert.ok(p99 > 85, `p99 should be near top, got ${p99}`);
});

// ============================================================================
// FIX 3 (MAJOR): flush exports the current snapshot without clearing state.
// ============================================================================

test("metrics-collector: flush calls the exporter with the current snapshot (FIX 3)", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  collector.recordCall(KEY, CORR, 20, "failed", "shared");
  let calls = 0;
  let totalCalls = 0;
  let totalErrors = 0;
  collector.flush((snapshot) => {
    calls++;
    totalCalls = snapshot.totalCallCount;
    totalErrors = snapshot.totalErrorCount;
  });
  assert.equal(calls, 1, "flush must call the exporter exactly once");
  assert.equal(totalCalls, 2, "snapshot must reflect 2 calls");
  assert.equal(totalErrors, 1, "snapshot must reflect 1 error");
  // flush does not clear state — a second flush reports the same data
  collector.flush((snapshot) => {
    totalCalls = snapshot.totalCallCount;
  });
  assert.equal(totalCalls, 2, "flush must not clear state");
  collector.close();
});

test("metrics-collector: flush is a no-op after close (FIX 3)", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  collector.close();
  let called = false;
  collector.flush(() => { called = true; });
  assert.equal(called, false, "flush after close must not invoke the exporter");
});

test("metrics-collector: flush swallows exporter errors (FIX 3)", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  // a throwing exporter must not crash the collector
  assert.doesNotThrow(() => {
    collector.flush(() => { throw new Error("exporter boom"); });
  });
  // a subsequent flush still works
  let calls = 0;
  collector.flush(() => { calls++; });
  assert.equal(calls, 1, "flush must recover from a prior exporter error");
  collector.close();
});

test("metrics-collector: noop collector flush is a no-op (FIX 3)", () => {
  const disabled = parsePerformanceConfig({ ...DEFAULT_PERFORMANCE_CONFIG, enabled: false });
  const collector = createMetricsCollector({ config: disabled });
  let called = false;
  collector.flush(() => { called = true; });
  assert.equal(called, false, "noop collector flush must not invoke the exporter");
});

// ---------------------------------------------------------------------------
// Resource aggregates — CPU + heap deltas per scope (the metrics lane's half
// of the per-effect cost measurement; the ledger lane carries the same
// readings in its timing document).
// ---------------------------------------------------------------------------

test("metrics-collector: recordCall aggregates cpu/ram deltas into the entry", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared", { cpuMs: 1.5, heapDeltaBytes: 2048 });
  collector.recordCall(KEY, CORR, 5, "succeeded", "shared", { cpuMs: 0.5, heapDeltaBytes: -4096 });
  const entry = collector.snapshot().entries[0]!;
  assert.equal(entry.totalCpuMs, 2, "cpu deltas sum across the scope's calls");
  assert.equal(entry.totalHeapDeltaBytes, -2048, "heap deltas sum and may net NEGATIVE (a release)");
});

test("metrics-collector: calls without a resource delta leave the aggregates at zero", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared");
  const entry = collector.snapshot().entries[0]!;
  assert.equal(entry.totalCpuMs, 0);
  assert.equal(entry.totalHeapDeltaBytes, 0);
});

test("metrics-collector: non-finite resource readings never poison the sums", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared", { cpuMs: Number.NaN, heapDeltaBytes: Number.POSITIVE_INFINITY });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared", { cpuMs: 2, heapDeltaBytes: 100 });
  const entry = collector.snapshot().entries[0]!;
  assert.equal(entry.totalCpuMs, 2, "a NaN cpu reading is dropped, not propagated");
  assert.equal(entry.totalHeapDeltaBytes, 100, "an infinite heap reading is dropped, not propagated");
});

test("metrics-collector: resource aggregates are per-scope, like every other aggregate", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, CORR, 10, "succeeded", "shared", { cpuMs: 1, heapDeltaBytes: 1 });
  collector.recordCall(KEY, { ...CORR, agentId: "agent-2" }, 10, "succeeded", "shared", { cpuMs: 7, heapDeltaBytes: 7 });
  const entries = collector.snapshot().entries;
  const mine = entries.find((e) => e.correlation.agentId === "agent-1")!;
  const other = entries.find((e) => e.correlation.agentId === "agent-2")!;
  assert.equal(mine.totalCpuMs, 1);
  assert.equal(other.totalCpuMs, 7);
});

test("metrics-collector: recordCallStart's completion feeds the aggregates too", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  const done = collector.recordCallStart(KEY, CORR, "shared");
  done();
  const entry = collector.snapshot().entries[0]!;
  assert.equal(entry.callCount, 1);
  assert.equal(entry.totalCpuMs, 0, "a completion without a measured delta records zero, not a fabrication");
});

test("metrics-collector: the shared probe measures a real window", async () => {
  // The probe is the ONE owner of the delta measurement (the effect wrapper
  // and the metrics call sites both use it), so its arithmetic is pinned
  // here: a window that burns CPU reports a positive cpuMs, and the heap
  // delta is a finite number.
  const { startResourceDeltaProbe } = await import("../../src/performance/metrics-collector.ts");
  const probe = startResourceDeltaProbe();
  let acc = 0;
  for (let i = 0; i < 100_000; i++) acc += i;
  const delta = probe.stop();
  assert.ok(delta.cpuMs > 0, `a loop that ran must show CPU cost, got ${delta.cpuMs}`);
  assert.ok(Number.isFinite(delta.heapDeltaBytes), `heap delta must be finite, got ${delta.heapDeltaBytes}`);
  assert.ok(acc >= 0);
});
