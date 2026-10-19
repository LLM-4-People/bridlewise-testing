/**
 * Measurement primitives for the benchmark harness.
 *
 * Everything here exists to make numbers COMPARABLE across runs on
 * different machines and different tree states. Three rules:
 *
 *   1. Every sample set carries its NOISE FLOOR — the measured cost of
 *      measuring nothing. A number smaller than the noise floor is not a
 *      number, it is a rounding artifact, and `Stats.meaningful` says so.
 *   2. Percentiles, never means. A mean hides the tail, and the tail is
 *      what the user feels. p50/p95/p99/max are reported always.
 *   3. Warmup is explicit and excluded. JIT tiering, SQLite page cache
 *      and OS page cache all make the first N iterations lie.
 *
 * No dependencies — `process.hrtime.bigint()` and arithmetic only.
 */

/** Nanoseconds per millisecond. */
const NS_PER_MS = 1_000_000;

export type Stats = {
  /** Number of samples retained (post-warmup). */
  readonly n: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
  /** Sum of all retained samples — the wall time the work actually cost. */
  readonly totalMs: number;
  /**
   * The measurement floor for this process, in ms: the p50 of timing an
   * empty closure. Samples at or below this are indistinguishable from
   * the act of measuring.
   */
  readonly noiseFloorMs: number;
  /** False when p50 <= noiseFloorMs — the result is below the floor. */
  readonly meaningful: boolean;
};

/**
 * Calibrate the timer overhead for THIS process. Called once per bench
 * run and threaded into every Stats so every reported number is
 * self-describing. Typical value on a modern x64 Linux box: 30–90ns.
 */
export function measureNoiseFloor(iterations = 20_000): number {
  const samples: number[] = [];
  const noop = (): number => 0;
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    noop();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / NS_PER_MS);
  }
  samples.sort((a, b) => a - b);
  return percentile(samples, 50);
}

/** Exact-rank percentile over a PRE-SORTED ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

/** Build Stats from raw ms samples (unsorted is fine — this sorts a copy). */
export function summarize(samplesMs: readonly number[], noiseFloorMs: number): Stats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  const p50 = percentile(sorted, 50);
  return {
    n: sorted.length,
    minMs: sorted[0] ?? Number.NaN,
    p50Ms: p50,
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1] ?? Number.NaN,
    meanMs: sorted.length > 0 ? total / sorted.length : Number.NaN,
    totalMs: total,
    noiseFloorMs,
    meaningful: p50 > noiseFloorMs * 2,
  };
}

export type TimeOptions = {
  /** Iterations whose samples are DISCARDED (JIT + cache warmup). */
  readonly warmup?: number;
  /** Iterations whose samples are KEPT. */
  readonly iterations?: number;
  /**
   * Stop early once this much wall time has elapsed (ms), so a pathological
   * case (an O(n^2) read over a large fixture) reports rather than hangs.
   */
  readonly maxWallMs?: number;
};

/** Time a synchronous closure. Returns Stats plus the last return value. */
export function timeSync<T>(
  fn: () => T,
  noiseFloorMs: number,
  options: TimeOptions = {},
): { readonly stats: Stats; readonly last: T } {
  const warmup = options.warmup ?? 3;
  const iterations = options.iterations ?? 30;
  const maxWallMs = options.maxWallMs ?? 60_000;

  let last: T = undefined as unknown as T;
  for (let i = 0; i < warmup; i++) last = fn();

  const samples: number[] = [];
  const startedAt = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    last = fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / NS_PER_MS);
    if (Number(t1 - startedAt) / NS_PER_MS > maxWallMs) break;
  }
  return { stats: summarize(samples, noiseFloorMs), last };
}

/** Time an async closure, serially (no overlap). */
export async function timeAsync<T>(
  fn: () => Promise<T>,
  noiseFloorMs: number,
  options: TimeOptions = {},
): Promise<{ readonly stats: Stats; readonly last: T }> {
  const warmup = options.warmup ?? 3;
  const iterations = options.iterations ?? 30;
  const maxWallMs = options.maxWallMs ?? 60_000;

  let last: T = undefined as unknown as T;
  for (let i = 0; i < warmup; i++) last = await fn();

  const samples: number[] = [];
  const startedAt = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    last = await fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / NS_PER_MS);
    if (Number(t1 - startedAt) / NS_PER_MS > maxWallMs) break;
  }
  return { stats: summarize(samples, noiseFloorMs), last };
}

/**
 * Event-loop lag sampler. Schedules a timer every `intervalMs` and records
 * how LATE it fires. This is the single most diagnostic number for a
 * single-threaded Node server: lag is time the event loop was blocked in
 * synchronous work and could not serve anyone.
 *
 * Usage:
 *   const lag = startLagSampler();
 *   ...do work / drive load...
 *   const stats = lag.stop(noiseFloor);
 */
export function startLagSampler(intervalMs = 10): {
  stop: (noiseFloorMs: number) => Stats;
} {
  const samples: number[] = [];
  let expected = process.hrtime.bigint() + BigInt(intervalMs * NS_PER_MS);
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const lateMs = Number(now - expected) / NS_PER_MS;
    samples.push(Math.max(0, lateMs));
    expected = now + BigInt(intervalMs * NS_PER_MS);
  }, intervalMs);
  timer.unref();
  return {
    stop: (noiseFloorMs: number): Stats => {
      clearInterval(timer);
      return summarize(samples, noiseFloorMs);
    },
  };
}

/** Format a ms number for a fixed-width table. */
export function ms(value: number): string {
  if (!Number.isFinite(value)) return "     —";
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  if (value >= 10) return `${value.toFixed(1)}ms`;
  if (value >= 1) return `${value.toFixed(2)}ms`;
  return `${(value * 1000).toFixed(0)}µs`;
}

/** Format a byte count. */
export function bytes(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${value}B`;
}

/**
 * The perceptual thresholds this product is judged against, from
 * DESIGN-COCKPIT-V2.md §1.5 (F2, the latency budget table).
 */
export const BUDGET = {
  /** One frame — imperceptible. keystroke → paint. */
  FRAME_MS: 16,
  /** action → visible acknowledgement. */
  ACK_MS: 100,
  /** any view/room/scope open. */
  VIEW_MS: 200,
  /** finding → docked at its seam. */
  FINDING_MS: 300,
  /** The outer bound of "keeps flow" (Nielsen). */
  FLOW_MS: 1000,
} as const;

/** Which budget band a latency falls in — for the verdict column. */
export function band(msValue: number): string {
  if (!Number.isFinite(msValue)) return "?";
  if (msValue <= BUDGET.FRAME_MS) return "FRAME";
  if (msValue <= BUDGET.ACK_MS) return "ACK";
  if (msValue <= BUDGET.VIEW_MS) return "VIEW";
  if (msValue <= BUDGET.FLOW_MS) return "FLOW";
  return "BROKEN";
}
