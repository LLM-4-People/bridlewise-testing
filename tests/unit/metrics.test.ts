// @vitest-environment node
import { describe, test, expect, beforeEach } from "vitest";

import {
  metricsSnapshot,
  metricEntries,
  metricsSummary,
  percentileFromHistogram,
  setMetrics,
  resetMetrics,
} from "../../src/state/metrics";
import type {
  MetricsSnapshot,
  DurationHistogramSnapshot,
} from "../../shared/types";

function hist(
  bounds: readonly number[],
  counts: readonly number[],
  opts: Partial<DurationHistogramSnapshot> = {},
): DurationHistogramSnapshot {
  const totalCount = counts.reduce((a, b) => a + b, 0);
  return {
    bucketCount: counts.length,
    bucketStrategy: "fixed",
    bounds,
    counts,
    totalCount,
    minMs: opts.minMs ?? 0,
    maxMs: opts.maxMs ?? (bounds[bounds.length - 1] ?? 0),
    sumMs: opts.sumMs ?? 0,
  };
}

function snapshot(entries = 1): MetricsSnapshot {
  return {
    schemaVersion: "1",
    snapshotId: "s1",
    wallTime: "2026-01-01T00:00:00Z",
    entryCount: entries,
    entries: Array.from({ length: entries }, (_, i) => ({
      key: { module: "m", function: `fn${i}`, scope: "s" },
      correlation: {},
      callCount: 10 + i,
      errorCount: i,
      cancellationCount: 0,
      durationHistogram: hist([10, 20, 30], [5, 5, 5]),
      totalCpuMs: 0,
      totalHeapDeltaBytes: 0,
      attribution: "exact",
    })),
    totalCallCount: 10,
    totalErrorCount: 0,
    totalCancellationCount: 0,
    configHash: "h",
  };
}

describe("metrics store", () => {
  beforeEach(() => resetMetrics());

  test("initial state is null and summary is empty", () => {
    expect(metricsSnapshot.get()).toBeNull();
    expect(metricEntries.get()).toHaveLength(0);
    expect(metricsSummary.get().totalCalls).toBe(0);
    expect(metricsSummary.get().topEntry).toBeNull();
  });

  test("setMetrics populates entries and summary totals", () => {
    setMetrics(snapshot(2));
    expect(metricEntries.get()).toHaveLength(2);
    expect(metricsSummary.get().totalCalls).toBe(10);
    expect(metricsSummary.get().entryCount).toBe(2);
  });

  test("topEntry is the entry with the highest callCount", () => {
    setMetrics(snapshot(2));
    expect(metricsSummary.get().topEntry?.key.function).toBe("fn1");
  });

  test("topPercentiles are derived from the top entry histogram", () => {
    setMetrics(snapshot(1));
    const p = metricsSummary.get().topPercentiles;
    expect(p).not.toBeNull();
    expect(p!.p50).toBeCloseTo(15, 5);
    expect(p!.p99).toBeGreaterThan(p!.p50);
  });

  test("percentileFromHistogram falls back when bounds/counts lengths differ", () => {
    const h = hist([10, 20], [5, 5, 5], { minMs: 0, maxMs: 30 });
    // bounds.length (2)!== counts.length (3) → linear min/max fallback
    expect(percentileFromHistogram(h, 50)).toBeCloseTo(15, 5);
  });

  test("percentileFromHistogram returns 0 for an empty histogram", () => {
    const h = hist([], [], { minMs: 0, maxMs: 0 });
    expect(percentileFromHistogram(h, 50)).toBe(0);
  });
});
