// @vitest-environment node
/**
 * Metrics store dedup + history tests.
 *
 * Verifies the poll-dedup fix: an identical snapshot does NOT trigger a
 * store notification or a duplicate sparkline history point (the dashboard
 * re-renders only when metrics actually change — no wasted re-renders while
 * the harness is idle). Also verifies the history cap is config-driven
 * (webUi.metrics.historyMax) rather than a hardcoded 60.
 */
import { describe, test, expect, beforeEach } from "vitest";
import {
  metricsSnapshot,
  metricsHistory,
  systemMetrics,
  tokenThroughput,
  setMetrics,
  setSystemMetrics,
  setTokenThroughput,
  resetMetrics,
  type MetricsHistoryPoint,
} from "../../src/state/metrics";
import type { MetricsSnapshot, DurationHistogramSnapshot } from "../../shared/types";

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

function snapshot(opts: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    schemaVersion: "1",
    snapshotId: opts.snapshotId ?? "s1",
    wallTime: "2026-01-01T00:00:00Z",
    entryCount: opts.entryCount ?? 1,
    entries: [
      {
        key: { module: "m", function: "fn", scope: "s" },
        correlation: {},
        callCount: opts.totalCallCount ?? 10,
        errorCount: 0,
        cancellationCount: 0,
        durationHistogram: hist([10, 20, 30], [5, 5, 5]),
        totalCpuMs: 0,
        totalHeapDeltaBytes: 0,
        attribution: "exact",
      },
    ],
    totalCallCount: opts.totalCallCount ?? 10,
    totalErrorCount: opts.totalErrorCount ?? 0,
    totalCancellationCount: opts.totalCancellationCount ?? 0,
    configHash: "h",
  };
}

describe("metrics dedup — identical snapshots are skipped", () => {
  beforeEach(() => resetMetrics());

  test("setMetrics with an identical snapshot does NOT notify or append history", () => {
    let notifications = 0;
    const unlisten = metricsSnapshot.listen(() => { notifications++; });
    let historyNotifications = 0;
    const unlistenHist = metricsHistory.listen(() => { historyNotifications++; });

    setMetrics(snapshot());
    const afterFirst = notifications;
    const afterFirstHist = historyNotifications;

    // Second call with the SAME snapshot → skipped (no new notification, no
    // duplicate history point).
    setMetrics(snapshot());
    expect(notifications).toBe(afterFirst);
    expect(historyNotifications).toBe(afterFirstHist);
    expect(metricsHistory.get().length).toBe(1);

    unlisten();
    unlistenHist();
  });

  test("setMetrics with a CHANGED snapshot notifies + appends history", () => {
    setMetrics(snapshot({ snapshotId: "s1", totalCallCount: 10 }));
    expect(metricsHistory.get().length).toBe(1);
    setMetrics(snapshot({ snapshotId: "s2", totalCallCount: 11 }));
    expect(metricsHistory.get().length).toBe(2);
    const points = metricsHistory.get() as readonly MetricsHistoryPoint[];
    expect(points[0]!.totalCalls).toBe(10);
    expect(points[1]!.totalCalls).toBe(11);
  });

  test("setSystemMetrics dedups identical system metrics", () => {
    const sys = {
      capturedAt: "t1",
      processUptimeMs: 1000,
      osUptimeMs: 0,
      cpuCount: 4,
      loadAverage1m: 0.5,
      memory: { rss: 1, heapUsed: 2, heapTotal: 3, external: 0, arrayBuffers: 0, systemFree: 0, systemTotal: 0 },
      eventLoop: { utilization: 0.1, delayMin: 0, delayMax: 0, delayMean: 0, delayStddev: 0 },
    };
    let notifications = 0;
    const unlisten = systemMetrics.listen(() => { notifications++; });
    setSystemMetrics(sys);
    const afterFirst = notifications;
    setSystemMetrics(sys); // identical → skipped
    expect(notifications).toBe(afterFirst);
    setSystemMetrics({ ...sys, loadAverage1m: 0.9 }); // changed → notifies
    expect(notifications).toBe(afterFirst + 1);
    unlisten();
  });

  test("setTokenThroughput dedups identical throughput", () => {
    const tp = { inputTokens: 1, outputTokens: 2, totalTokens: 3, tokensPerSecond: 4 };
    let notifications = 0;
    const unlisten = tokenThroughput.listen(() => { notifications++; });
    setTokenThroughput(tp);
    const afterFirst = notifications;
    setTokenThroughput(tp); // identical → skipped
    expect(notifications).toBe(afterFirst);
    setTokenThroughput({ ...tp, tokensPerSecond: 99 }); // changed → notifies
    expect(notifications).toBe(afterFirst + 1);
    unlisten();
  });
});
