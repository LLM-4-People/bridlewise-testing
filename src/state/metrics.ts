/**
 * nanostores shared state: metrics snapshot + derived summary.
 *
 * Plain.ts — Node-testable via Vitest. Fed ONLY by client.ts (setMetrics).
 *
 * Percentile computation is a pure function over a DurationHistogramSnapshot.
 * The histogram bucket layout is strategy-dependent; this module assumes
 * `bounds[i]` is the upper bound of bucket `i` (bounds.length === counts.length)
 * and falls back to a linear min/max interpolation otherwise. The fallback is
 * honest — it does not fabricate precision the distribution does not provide.
 *
 * @global-store server-wide system metrics (not chat-scoped; reflects the whole server process)
 */

import { atom, computed, type ReadableAtom, type WritableAtom } from "nanostores";

import type {
  MetricsSnapshot,
  MetricEntrySnapshot,
  DurationHistogramSnapshot,
} from "../../shared/types";

import { metricsConfig } from "./web-ui-config";
import { registerReset } from "./store-registry";

// ── System resource metrics (web-UI specific; from server metrics-bridge) ──
//
// SPO: `SystemMetrics` is owned by `shared/wire-types.ts` (single
// wire-shape owner, imported by both server + client — no drift). Re-
// exported here so existing `import { type SystemMetrics } from
// "./state/metrics"` paths are unchanged.
import type { SystemMetrics } from "../../shared/wire-types";
export type { SystemMetrics };

export type TokenThroughput = Readonly<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Null when the server's elapsed interval is not positive: no rate was measured. */
  tokensPerSecond: number | null;
}>;

// ── Stores ──

export const metricsSnapshot: WritableAtom<MetricsSnapshot | null> = atom<MetricsSnapshot | null>(null);
export const systemMetrics: WritableAtom<SystemMetrics | null> = atom<SystemMetrics | null>(null);
export const tokenThroughput: WritableAtom<TokenThroughput | null> = atom<TokenThroughput | null>(null);

export const metricEntries: ReadableAtom<readonly MetricEntrySnapshot[]> = computed(
  metricsSnapshot,
  (s) => (s ? s.entries : []),
);

export type MetricsSummary = Readonly<{
  readonly totalCalls: number;
  readonly totalErrors: number;
  readonly totalCancellations: number;
  readonly entryCount: number;
  readonly topEntry: MetricEntrySnapshot | null;
  readonly topPercentiles: Readonly<{ readonly p50: number; readonly p95: number; readonly p99: number }> | null;
}>;

const EMPTY_SUMMARY: MetricsSummary = Object.freeze({
  totalCalls: 0,
  totalErrors: 0,
  totalCancellations: 0,
  entryCount: 0,
  topEntry: null,
  topPercentiles: null,
});

export const metricsSummary: ReadableAtom<MetricsSummary> = computed(
  metricsSnapshot,
  (s) => {
    if (!s) return EMPTY_SUMMARY;
    const topEntry = pickTopEntry(s.entries);
    const topPercentiles = topEntry
      ? {
          p50: percentileFromHistogram(topEntry.durationHistogram, 50),
          p95: percentileFromHistogram(topEntry.durationHistogram, 95),
          p99: percentileFromHistogram(topEntry.durationHistogram, 99),
        }
      : null;
    return {
      totalCalls: s.totalCallCount,
      totalErrors: s.totalErrorCount,
      totalCancellations: s.totalCancellationCount,
      entryCount: s.entryCount,
      topEntry,
      topPercentiles,
    };
  },
);

// ── Pure helpers (exported for testing) ──

export function percentileFromHistogram(
  hist: DurationHistogramSnapshot,
  p: number,
): number {
  if (hist.totalCount === 0) return 0;
  if (hist.bounds.length !== hist.counts.length) {
    // Layout does not match the upper-bound assumption; fall back to a
    // min..max linear interpolation. Honest, not precise.
    return hist.minMs + (p / 100) * (hist.maxMs - hist.minMs);
  }
  const target = (p / 100) * hist.totalCount;
  let cumulative = 0;
  for (let i = 0; i < hist.counts.length; i++) {
    const prev = cumulative;
    const count = hist.counts[i] ?? 0;
    cumulative += count;
    if (cumulative >= target) {
      const lower = i === 0 ? hist.minMs : (hist.bounds[i - 1] ?? hist.minMs);
      const upper = hist.bounds[i] ?? hist.maxMs;
      const bucket = cumulative - prev;
      if (bucket <= 0) return upper;
      const frac = (target - prev) / bucket;
      return lower + frac * (upper - lower);
    }
  }
  return hist.maxMs;
}

function pickTopEntry(
  entries: readonly MetricEntrySnapshot[],
): MetricEntrySnapshot | null {
  let best: MetricEntrySnapshot | null = null;
  for (const e of entries) {
    if (best === null || e.callCount > best.callCount) best = e;
  }
  return best;
}

// ── Ingestion (called only by client.ts) ──

/**
 * Shallow equality for the snapshot's identity fields. Two snapshots with
 * the same totals + entry count + id are treated as identical so a poll
 * that returns unchanged data does NOT trigger a store notification (the
 * dashboard re-renders only when metrics actually change — no wasted
 * re-renders while idle). This is a shallow compare by design: the entries
 * array is not deep-compared (it is large); the scalar totals + entryCount
 * are a sufficient change signal (call/error/cancellation counts move on
 * any real activity).
 */
function snapshotIdentical(a: MetricsSnapshot, b: MetricsSnapshot): boolean {
  return (
    a.snapshotId === b.snapshotId &&
    a.entryCount === b.entryCount &&
    a.totalCallCount === b.totalCallCount &&
    a.totalErrorCount === b.totalErrorCount &&
    a.totalCancellationCount === b.totalCancellationCount
  );
}

function systemMetricsIdentical(a: SystemMetrics, b: SystemMetrics): boolean {
  return (
    a.capturedAt === b.capturedAt &&
    a.processUptimeMs === b.processUptimeMs &&
    a.loadAverage1m === b.loadAverage1m &&
    a.memory.rss === b.memory.rss &&
    a.memory.heapUsed === b.memory.heapUsed &&
    a.eventLoop.utilization === b.eventLoop.utilization
  );
}

function throughputIdentical(a: TokenThroughput, b: TokenThroughput): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.totalTokens === b.totalTokens &&
    a.tokensPerSecond === b.tokensPerSecond
  );
}

export type MetricsHistoryPoint = Readonly<{
  readonly at: number;
  /** Null when no rate was measured; the sparkline skips absence, never draws 0 for it. */
  readonly tokensPerSecond: number | null;
  readonly totalCalls: number;
  readonly totalErrors: number;
  readonly loadAverage1m: number | null;
  /** Null when the poll carried no system reading; absence is not a measured zero. */
  readonly heapUsed: number | null;
  /** Null when the poll carried no system reading; absence is not a measured zero. */
  readonly eventLoopUtil: number | null;
}>;

export const metricsHistory = atom<readonly MetricsHistoryPoint[]>([]);

function appendHistoryPoint(point: MetricsHistoryPoint): void {
  const max = metricsConfig.get().historyMax;
  const next = [...metricsHistory.get(), point];
  if (next.length > max) next.splice(0, next.length - max);
  metricsHistory.set(next);
}

export type MetricsPoll = Readonly<{
  snapshot: MetricsSnapshot;
  /** The same poll's system reading, or null when the response carried none. */
  system: SystemMetrics | null;
  /** The same poll's token accumulator, or null when the response carried none. */
  tokens: TokenThroughput | null;
}>;

/**
 * Record one `/api/metrics` poll atomically: the three stores and the history
 * point all take their values from THIS response, never from whatever the
 * previous poll left behind. This is the only path that appends a history
 * point; the individual setters below only hydrate a store (chat history
 * hydration and tests use them).
 *
 * An unmeasured heap, event-loop utilization, load average or rate is recorded
 * as null. Absence is not a measured zero: the record is evidence, not a
 * display fallback.
 */
export function recordMetricsPoll(poll: MetricsPoll): void {
  // ABSENCE IS A VALUE FOR THIS POLL. A response that omits a half (or sends
  // null) means this poll measured nothing for it — the previous poll's
  // reading must be cleared, not kept, and a missing field must never reach
  // the store as `undefined`. Normalizing once here makes the three writes
  // and the history point describe the SAME response.
  const system = poll.system ?? null;
  const tokens = poll.tokens ?? null;
  const prevSnapshot = metricsSnapshot.get();
  const prevSystem = systemMetrics.get();
  const prevTokens = tokenThroughput.get();
  const snapshotChanged = prevSnapshot === null || !snapshotIdentical(prevSnapshot, poll.snapshot);
  const systemChanged = system === null
    ? prevSystem !== null
    : prevSystem === null || !systemMetricsIdentical(prevSystem, system);
  const tokensChanged = tokens === null
    ? prevTokens !== null
    : prevTokens === null || !throughputIdentical(prevTokens, tokens);
  if (!snapshotChanged && !systemChanged && !tokensChanged) return;
  if (snapshotChanged) metricsSnapshot.set(poll.snapshot);
  if (systemChanged) systemMetrics.set(system);
  if (tokensChanged) tokenThroughput.set(tokens);
  appendHistoryPoint({
    at: Date.now(),
    tokensPerSecond: tokens?.tokensPerSecond ?? null,
    totalCalls: poll.snapshot.totalCallCount,
    totalErrors: poll.snapshot.totalErrorCount,
    loadAverage1m: system?.loadAverage1m ?? null,
    heapUsed: system?.memory.heapUsed ?? null,
    eventLoopUtil: system?.eventLoop.utilization ?? null,
  });
}

export function setMetrics(snapshot: MetricsSnapshot): void {
  // Dedup: skip the store set when the poll returned identical per-function
  // metrics (idle harness) — no wasted re-render. History is appended only by
  // recordMetricsPoll, from one complete poll.
  const prev = metricsSnapshot.get();
  if (prev !== null && snapshotIdentical(prev, snapshot)) return;
  metricsSnapshot.set(snapshot);
}

/** Hydrate or clear the system half. `null` is absence (no reading in the
 * poll), a value the store can hold; only an identical value is skipped. */
export function setSystemMetrics(metrics: SystemMetrics | null): void {
  const prev = systemMetrics.get();
  if (metrics === null) {
    if (prev !== null) systemMetrics.set(null);
    return;
  }
  if (prev !== null && systemMetricsIdentical(prev, metrics)) return;
  systemMetrics.set(metrics);
}

/** Hydrate or clear the token half; see `setSystemMetrics`. */
export function setTokenThroughput(throughput: TokenThroughput | null): void {
  const prev = tokenThroughput.get();
  if (throughput === null) {
    if (prev !== null) tokenThroughput.set(null);
    return;
  }
  if (prev !== null && throughputIdentical(prev, throughput)) return;
  tokenThroughput.set(throughput);
}

export function resetMetrics(): void {
  metricsSnapshot.set(null);
  systemMetrics.set(null);
  tokenThroughput.set(null);
  metricsHistory.set([]);
}

registerReset("metrics", resetMetrics);
