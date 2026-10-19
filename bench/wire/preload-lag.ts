/**
 * IN-SERVER-PROCESS PROBE — event-loop lag + memory, sampled from INSIDE
 * the server process, without one line of product code changing.
 *
 * How it gets there: this module is loaded via node's `--import` flag when
 * the bench spawns its own server instance
 * (`node --experimental-strip-types --import <this> server/index.ts`). It runs
 * BEFORE `server/index.ts` is evaluated, in the same isolate, on the same
 * event loop. Nothing in `server/` imports it and nothing in `server/` knows
 * it exists.
 *
 * WHAT IT CAN SEE, and what it cannot
 *   CAN: every millisecond the event loop was blocked in synchronous work —
 *        a 3-second `pageAllRows`, a `spawnSync` tool call, a 74MB
 *        `JSON.stringify`. This is the metric that predicts collapse, and a
 *        client-side probe cannot see it: from outside, a blocked loop and a
 *        slow query are the same number.
 *   CAN: RSS / heap / external / arrayBuffers of the real server process,
 *        and the libuv thread-pool CPU time (`resourceUsage`).
 *   CANNOT: work done on the libuv thread pool or in worker threads. scrypt
 *        (login) and fs reads run off-loop, so they cost latency without
 *        costing lag. A latency rise with FLAT lag means "off-loop work or
 *        queueing", not "blocked".
 *   CANNOT: report during a block. The readout channel below shares the
 *        event loop it measures, so a probe GET issued during a 3s block
 *        answers 3s late — but the SAMPLES for that block are already in the
 *        ring buffer and are returned in full when it does answer. Delayed
 *        readout, complete data.
 *
 * COST OF OBSERVING (stated so it can be subtracted): one `setInterval` at
 * `HARNESS_BENCH_LAG_INTERVAL_MS` (default 10ms) plus one loopback HTTP
 * listener that is idle unless polled. The sampler is `unref`'d so it never
 * holds the process open. Measured against a no-preload control by
 * `bench/wire/load.ts` (case `probe/observer-cost`) — if the control and the
 * observed run disagree beyond the noise floor, the probe is lying and the
 * report says so.
 *
 * WHY IT KEEPS TIMESTAMPS (and `bench/lib/stats.ts::startLagSampler` does
 * not): a load run needs lag WINDOWED to a phase — "lag while the SSE stream
 * was open", "lag during the 30s sustained ramp" — which needs each sample's
 * wall-clock time. `startLagSampler` returns one `Stats` for its whole
 * lifetime and does not expose samples, so it cannot be windowed. The
 * measurement technique here is identical to it (schedule at a fixed
 * interval, record how LATE the timer fired); every statistic is computed by
 * `summarize()` from `bench/lib/stats.ts`. No percentile is reimplemented.
 *
 * Enabled only when `HARNESS_BENCH_PROBE_PORT` is set. Unset → this module
 * returns immediately and the process is byte-for-byte a normal server.
 */

import { createServer } from "node:http";

import { summarize, type Stats } from "../lib/stats.ts";

const NS_PER_MS = 1_000_000;

/** Ring-buffer cap. At the 10ms default this is ~17 minutes of samples. */
const MAX_SAMPLES = 100_000;

const probePort = Number(process.env["HARNESS_BENCH_PROBE_PORT"] ?? "0");
const intervalMs = Number(process.env["HARNESS_BENCH_LAG_INTERVAL_MS"] ?? "10");

if (Number.isFinite(probePort) && probePort > 0) {
  start(probePort, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 10);
}

/** One lag observation: when it was taken (ms since process start) and how
 * late the timer fired (ms). `atMs` is what makes windowing possible. */
type LagSample = { readonly atMs: number; readonly lagMs: number };

function start(port: number, sampleIntervalMs: number): void {
  const startedAt = process.hrtime.bigint();
  const samples: LagSample[] = [];
  /** Total samples ever taken, including any dropped by the ring cap — so a
   * reader can tell "quiet" from "the buffer wrapped". */
  let taken = 0;

  // Same technique as bench/lib/stats.ts::startLagSampler: schedule at a
  // fixed interval, record how late the callback actually ran. Lateness IS
  // the time the loop was unavailable.
  let expected = process.hrtime.bigint() + BigInt(sampleIntervalMs * NS_PER_MS);
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const lateMs = Number(now - expected) / NS_PER_MS;
    expected = now + BigInt(sampleIntervalMs * NS_PER_MS);
    taken++;
    samples.push({
      atMs: Number(now - startedAt) / NS_PER_MS,
      lagMs: Math.max(0, lateMs),
    });
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  }, sampleIntervalMs);
  // unref: the probe must never be the reason the process stays alive. A
  // server that will not exit because the bench was watching it is a bench
  // that changed what it measured.
  timer.unref();

  const probe = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const nowMs = Number(process.hrtime.bigint() - startedAt) / NS_PER_MS;

    if (url.pathname === "/reset") {
      samples.length = 0;
      taken = 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, atMs: nowMs }));
      return;
    }

    // ?since=<atMs> windows the lag to one phase of the load run. Absent →
    // everything still in the buffer.
    const sinceRaw = url.searchParams.get("since");
    const since = sinceRaw === null ? -Infinity : Number(sinceRaw);
    const windowed = samples.filter((s) => s.atMs > since);
    const mem = process.memoryUsage();
    const cpu = process.resourceUsage();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        pid: process.pid,
        atMs: nowMs,
        sampleIntervalMs,
        // The count in the window vs the count the window SHOULD hold. A
        // shortfall means the sampler itself was starved — which is not a
        // gap in the data, it is the finding.
        windowSamples: windowed.length,
        windowExpectedSamples:
          Number.isFinite(since) ? Math.max(0, Math.round((nowMs - since) / sampleIntervalMs)) : windowed.length,
        totalSamplesTaken: taken,
        bufferedSamples: samples.length,
        lagMs: windowed.map((s) => s.lagMs),
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
        arrayBuffersBytes: mem.arrayBuffers,
        userCpuMs: cpu.userCPUTime / 1000,
        systemCpuMs: cpu.systemCPUTime / 1000,
        maxRssKb: cpu.maxRSS,
      }),
    );
  });

  probe.unref();
  probe.listen(port, "127.0.0.1");
}

// ── Client-side helpers (imported by the bench, not by the server) ────────

/** The probe's JSON payload, as the bench consumes it. */
export type ProbeReading = {
  readonly pid: number;
  readonly atMs: number;
  readonly sampleIntervalMs: number;
  readonly windowSamples: number;
  readonly windowExpectedSamples: number;
  readonly totalSamplesTaken: number;
  readonly bufferedSamples: number;
  readonly lagMs: readonly number[];
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
  readonly externalBytes: number;
  readonly arrayBuffersBytes: number;
  readonly userCpuMs: number;
  readonly systemCpuMs: number;
  readonly maxRssKb: number;
};

/**
 * Summarise a probe reading's lag samples with the SAME `summarize()` the
 * rest of the harness uses, so a lag p99 is comparable with a latency p99.
 *
 * `starved` is the honest caveat: when the sampler collected materially
 * fewer samples than the window should hold, the loop was blocked so hard
 * that the sampler itself could not run. The percentiles then UNDERSTATE the
 * lag, because the worst moments produced no sample at all — the reader must
 * be told, not left to assume the tail is complete.
 */
export function summarizeProbeLag(
  reading: ProbeReading,
  noiseFloorMs: number,
): { readonly stats: Stats; readonly starved: boolean; readonly note: string } {
  const stats = summarize(reading.lagMs, noiseFloorMs);
  const expected = reading.windowExpectedSamples;
  const starved = expected > 20 && reading.windowSamples < expected * 0.8;
  return {
    stats,
    starved,
    note: starved
      ? `sampler starved: ${reading.windowSamples}/${expected} expected samples — ` +
        `the loop was blocked through its own sampling interval, so these percentiles are a LOWER BOUND`
      : `${reading.windowSamples}/${expected} samples`,
  };
}
