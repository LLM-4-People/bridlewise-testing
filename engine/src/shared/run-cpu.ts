/**
 * The CPU time a test run actually consumed — the run's WORK, as opposed to
 * the run's DURATION.
 *
 * ── WHY THIS NUMBER HAD TO EXIST ─────────────────────────────────────────
 *
 * The suite's wall clock was being judged against an absolute cap, and the
 * cap sat inside the run-to-run noise band. The obvious repair — divide the
 * wall clock by the recorded ambient load — was measured and REJECTED, and
 * the measurement is worth keeping because it is counter-intuitive:
 *
 *   - `load1PerCpuAtStart` is `loadavg()[0]`, a one-minute EXPONENTIALLY
 *     DECAYING average sampled before the run starts. Immediately after a
 *     previous suite run it is dominated by that run's ghost — cores that are
 *     now completely free. Measured here: a run whose recorded load was
 *     **0.598/cpu** finished in **35.6s** on an idle box, while a run whose
 *     recorded load was **0.678/cpu** — eight genuine CPU burners, running
 *     throughout — took **60.5s**. Two nearly equal recorded loads, a 70%
 *     difference in outcome. **The recorded load cannot separate them**, which
 *     is exactly why the historical failures showed no correlation with it.
 *   - Per-file wall-clock occupancy does not help either: under those same
 *     eight burners it moved **724 → 1240 ms/file (+71%)**, tracking the wall
 *     clock almost exactly. Occupancy is wall time, so it inherits every
 *     contention effect the wall clock has.
 *
 * CPU time does not — under MILD contention. Contention makes a runnable
 * process WAIT for a core; it does not make it execute more instructions. So
 * under mild contention the same tree does the same work whoever else is on
 * the machine, and a budget on that work is a budget on the suite rather
 * than on the box it happened to run on. The invariance does not survive
 * saturation — cache thrashing, memory-bandwidth contention and scheduling
 * pressure add real work to the same instructions — which is why the
 * verdict that consumes this number defers a saturated box as provisional
 * instead of judging it (see `budget-verdict.ts`, the owner of that model).
 *
 * ── HOW IT IS READ, AND WHY THERE IS NO CLOCK-TICK CONSTANT ──────────────
 *
 * `/proc/self/stat` carries `utime`/`stime` (this process) and
 * `cutime`/`cstime` (every child it has REAPED) — and a vitest run spends
 * almost all of its CPU in pool workers, which are children. Those four
 * fields are in kernel clock ticks, and the tick rate is a build-time
 * constant of the kernel that node exposes nowhere.
 *
 * Rather than hardcode 100 and be wrong on a kernel built differently, the
 * rate is DERIVED from the process's own two clocks: `process.cpuUsage()`
 * reports this process's CPU in microseconds, and `utime + stime` reports the
 * same quantity in ticks. Their ratio is the tick length, measured on the
 * machine that is running, and it cancels out of the answer entirely:
 *
 *     childCpuMs = (cutime + cstime) * (selfCpuMs / (utime + stime))
 *
 * No constant, nothing to keep in step with a kernel. When the denominator is
 * zero — a process that has consumed no measurable CPU, or a platform with no
 * `/proc` — the answer is ABSENT, never a zero: zero CPU is a claim that the
 * run did no work, and a budget that believes it would pass a suite that
 * never ran.
 *
 * The parse deliberately starts after the LAST `)` in the line: field 2 is the
 * executable name in parentheses and may itself contain spaces and
 * parentheses, so splitting the whole line on whitespace mis-indexes every
 * field after it. That is the standard trap in reading this file, and it is
 * the same one `scripts/run-tests.ts` avoids by shelling out to `ps`.
 */
import { spawnSync } from "node:child_process";

import { parseStatLine, procfsDocument, STAT_FIELD } from "../process/process-facts.ts";
import { DEFAULT_CPU_CALIBRATION_TIMEOUT_MS } from "../workflow/workflow-config.ts";

/** The first field number that follows the parenthesised executable name (`proc(5)`, 1-based). */
const FIRST_FIELD_AFTER_COMM = 3;

export interface RunCpu {
  /** CPU consumed by this process and every child it has reaped, in ms. */
  readonly totalCpuMs: number;
  /** The child half alone, in ms — where a vitest run does its work. */
  readonly childCpuMs: number;
}

/** One `/proc/self/stat` field, in clock ticks, or null when unreadable. */
function statTicks(afterComm: readonly string[], field: number): number | null {
  const raw = afterComm[field - FIRST_FIELD_AFTER_COMM];
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * The run's CPU cost, or null when it cannot be measured honestly.
 *
 * Null is a real answer here and the caller must carry it as absence: a
 * budget with no CPU measurement behind it must refuse to judge rather than
 * judge a zero.
 */
export function readRunCpu(
  readStat: () => string | undefined = () => procfsDocument("self", "stat"),
  selfCpuUsage: () => { user: number; system: number } = () => process.cpuUsage(),
): RunCpu | null {
  const line = readStat();
  if (line === undefined) return null; // No procfs — not a Linux box. Absence, not zero.
  // Parsed by the one stat-line owner (after the LAST `)`: the executable's
  // name is field 2 and may hold spaces and parentheses).
  const afterComm = parseStatLine(line);
  if (afterComm === undefined) return null;

  const utime = statTicks(afterComm, STAT_FIELD.utime);
  const stime = statTicks(afterComm, STAT_FIELD.stime);
  const cutime = statTicks(afterComm, STAT_FIELD.cutime);
  const cstime = statTicks(afterComm, STAT_FIELD.cstime);
  if (utime === null || stime === null || cutime === null || cstime === null) return null;

  const selfTicks = utime + stime;
  if (selfTicks <= 0) return null; // Nothing to calibrate the tick length with.

  const usage = selfCpuUsage();
  const selfCpuMs = (usage.user + usage.system) / 1000;
  if (!Number.isFinite(selfCpuMs) || selfCpuMs <= 0) return null;

  // Tick length measured on this machine, from this process's own two clocks.
  const msPerTick = selfCpuMs / selfTicks;
  const childCpuMs = (cutime + cstime) * msPerTick;
  const totalCpuMs = selfCpuMs + childCpuMs;
  if (!Number.isFinite(childCpuMs) || !Number.isFinite(totalCpuMs)) return null;
  return { totalCpuMs: Math.round(totalCpuMs), childCpuMs: Math.round(childCpuMs) };
}


/**
 * ── THE LOAD-AGNOSTIC METRIC: CALIBRATED WORK ─────────────────────────────
 *
 * THE PROBLEM THIS ANSWERS. Raw CPU time is invariant to a runnable process
 * WAITING for a core, but not at saturation: cache and memory-bandwidth
 * contention add real work to the same instructions. On this host the same
 * tree measured 2124.7 ms/file under load ~9-10 against a 1926 ms/file
 * baseline (+10.3%), so the gate reddened because the box was busy.
 *
 * THE SIGNAL. Every measurement of the suite's CPU is paired with a fixed,
 * deterministic micro-benchmark run at the SAME two moments (run start and
 * run end), in a child of this process. The benchmark is a fixed integer loop
 * with a 256 KiB working set, spawned with `--no-opt` so its instruction count
 * does not depend on V8's time-based tiering; it runs six fixed chunks and
 * reports each chunk's own `process.cpuUsage()`. The reading is the MEDIAN
 * chunk (robust to one descheduled chunk), and the run's calibration is the
 * mean of the start and end readings. The suite's cost is then
 *
 *     workUnitsPerTestFile = (runCpuMs / calibrationMs) / testFileCount
 *
 * — the suite's CPU in units of "a fixed chunk of this machine's execution
 * at this moment", per test file. Cluster the metric ID in the settings
 * document and the ledger; the unit is dimensionless.
 *
 * THE PROFILE WAS CHOSEN BY MEASUREMENT, NOT PREFERENCE. On a real 4-file
 * subset (68 tests) of this suite, interleaved 3 ambient + 2 with eight
 * memory-streaming burners, on this 12-core host:
 *
 *     condition    raw ms/file                  calibrated (256 KiB) units/file
 *     ambient      12579.5  11035.5  10619.0    305.9   267.2   241.6
 *     loaded       16907.0  16540.2             280.6   283.9
 *     step         +46.6%                       +3.9%
 *
 * A 60-second profile (`--no-opt`, 5M-iteration chunks) inflated 3.4× under
 * the same burners; an L3-sized one inflated 3-5×; a register-only one
 * inflated ~17% but was unstable. The 256 KiB profile is the one whose
 * sensitivity matched the subject's. THE RESIDUAL IS STILL REPORTED AND
 * BOUNDED: the run's own calibration readings must agree within the declared
 * drift (see `calibrationDriftFraction`) and its recorded ambient load must
 * sit within the declared validity bound, or the judgement layer DEFERS
 * rather than judging. Nothing here ever substitutes raw CPU for an absent
 * calibration: `computeRunWork` returns null, and the verdict refuses.
 *
 * WHY SIX CHUNKS AND A MEDIAN. A single short pass is at the mercy of one
 * scheduler hiccup; the median of six fixed chunks rejected the outliers in
 * every measured pass while keeping the reading cheap (six × ~40 ms). The
 * child measures only the chunks, never its own startup, so process spawn
 * cost is not part of the unit.
 */
export const SUITE_WORK_METRIC = "calibrated-work/v1" as const;

/**
 * THIS THREAD's CPU work so far, in ms (microsecond precision), or null when
 * the runtime gives no per-thread reading.
 *
 * For timing ONE PIECE OF CODE (a microbenchmark's budget): a busy host
 * makes the code WAIT for a core, which is wall time, never this number. It
 * is also immune to work other threads in the process do (the GC's helpers,
 * a worker), which `process.cpuUsage()` would add. The process-and-children
 * reading above (`readRunCpu`) is the one for a whole run; its clock-tick
 * resolution (usually 10 ms) cannot time a 16 ms frame budget.
 *
 * Null is a real answer: a budget with no measurement behind it must refuse
 * to judge, never judge a zero.
 */
export function readThreadCpuMs(): number | null {
  if (typeof process.threadCpuUsage !== "function") return null;
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/**
 * This thread's CPU work so far, in ms, for a budget that must be judged: an
 * unreadable reading is a REFUSAL (a budget with no measurement behind it
 * would pass everything), never a zero.
 */
export function threadCpuWorkMs(): number {
  const reading = readThreadCpuMs();
  if (reading === null) {
    throw new Error("run-cpu: this runtime gives no per-thread CPU reading (process.threadCpuUsage), so no CPU budget can be judged here");
  }
  return reading;
}

/**
 * THE CPU WORK OF ONE PIECE OF CODE (NO-LOAD-BLOCK), for a performance
 * budget: the least CPU work `fn` did on this thread across `runs` calls
 * (each given its run's index, for a fixture that must differ per run). A
 * busy host makes the code WAIT for a core, which this never counts; a wall
 * clock around the same call judges the host (measured: sweep-perf failed a
 * required shard at 144 ms against 100 under load). The least of several
 * runs keeps a GC pause or a cold cache, real work but not the code's own,
 * out of the reading.
 */
export function cpuWorkOf(fn: (run: number) => void, runs = 1): number {
  let least = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run += 1) {
    const start = threadCpuWorkMs();
    fn(run);
    least = Math.min(least, threadCpuWorkMs() - start);
  }
  return least;
}

/** {@link cpuWorkOf} for code that awaits (a render that settles, a stubbed fetch): what awaiting costs is waiting, never counted. */
export async function cpuWorkOfAsync(fn: (run: number) => Promise<void>, runs = 1): Promise<number> {
  let least = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run += 1) {
    const start = threadCpuWorkMs();
    await fn(run);
    least = Math.min(least, threadCpuWorkMs() - start);
  }
  return least;
}

/** The calibration workload's identity — recorded with every reading. */
const CALIBRATION_WORKLOAD = "int-mem-l2/v1" as const;

/** Iterations per measured chunk (fixed; the unit is this exact work). */
const CALIBRATION_CHUNK_ITERATIONS = 5_000_000;

/** Measured chunks per calibration reading. */
const CALIBRATION_CHUNKS = 6;

/** Int32 words the calibration walks (256 KiB — the L2-sized profile). */
const CALIBRATION_ARRAY_WORDS = 1 << 16;

/**
 * The benchmark a calibration child runs. Kept as source rather than a
 * separate module: the child is spawned with `--no-opt`, and a file import
 * would put this tree's module graph (and its type stripping) on the
 * measurement path. The loop touches a fixed 256 KiB array on a fixed
 * LCG walk, so its instruction and cache profile are deterministic.
 */
const CALIBRATION_SOURCE = `
const iterations = Number(process.env.BW_CAL_ITER);
const chunks = Number(process.env.BW_CAL_CHUNKS);
const words = Number(process.env.BW_CAL_WORDS);
const mem = new Int32Array(words);
for (let i = 0; i < mem.length; i += 16) mem[i] = i + 1;
function work(n) {
  let a = 1, b = 2, c = 3, d = 4, x = 12345, acc = 0;
  for (let i = 0; i < n; i++) {
    a = (Math.imul(a, 1664525) + 1013904223) | 0;
    b = (b ^ (a >>> 13)) + i | 0;
    c = (c + (b & 0xffff)) | 0;
    d = (d ^ (c << 5)) | 0;
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    acc += mem[(x >>> 6) & (mem.length - 1)];
  }
  return (a ^ b ^ c ^ d ^ acc) | 0;
}
work(iterations);
const out = [];
for (let i = 0; i < chunks; i++) {
  const before = process.cpuUsage();
  work(iterations);
  const after = process.cpuUsage();
  out.push(((after.user + after.system) - (before.user + before.system)) / 1000);
}
process.stdout.write(JSON.stringify(out));
`;

/** One calibration reading: the median fixed chunk's CPU cost, in ms. */
export interface CalibrationReading {
  /** Median measured-chunk CPU ms — the calibration unit's size right now. */
  readonly cpuMs: number;
  /** Every measured chunk, in order, for the reading's own witness. */
  readonly chunks: readonly number[];
  /** The workload identity, recorded so a unit change can never look like drift. */
  readonly workload: string;
  /** Fixed work per chunk, recorded with the unit. */
  readonly chunkIterations: number;
}

/**
 * Parse a calibration child's stdout. Exported so the refusal branches
 * (missing, malformed, non-positive chunks) are drivable without spawning.
 * A reading with fewer than three chunks, any non-finite/non-positive chunk,
 * or a non-positive median is ABSENT — never a zero.
 */
function parseCalibrationOutput(stdout: string): CalibrationReading | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 3) return null;
  const chunks: number[] = [];
  for (const chunk of parsed) {
    if (typeof chunk !== "number" || !Number.isFinite(chunk) || chunk <= 0) return null;
    chunks.push(chunk);
  }
  const sorted = [...chunks].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  if (!Number.isFinite(median) || median <= 0) return null;
  return { cpuMs: median, chunks, workload: CALIBRATION_WORKLOAD, chunkIterations: CALIBRATION_CHUNK_ITERATIONS };
}

/**
 * Measure the machine's current speed with the fixed workload: the median
 * chunk's CPU cost, or null when the benchmark cannot run honestly.
 *
 * Null is a real answer and every consumer must carry it as absence: a
 * missing calibration is not a zero and must never silently become raw CPU.
 * The injection point exists so a guard can drive a failed spawn without a
 * broken machine; production callers use the default.
 */
export function measureCalibration(
  spawn: typeof spawnSync = spawnSync,
): CalibrationReading | null {
  const result = spawn(process.execPath, ["--no-opt", "-e", CALIBRATION_SOURCE], {
    env: {
      ...process.env,
      BW_CAL_ITER: String(CALIBRATION_CHUNK_ITERATIONS),
      BW_CAL_CHUNKS: String(CALIBRATION_CHUNKS),
      BW_CAL_WORDS: String(CALIBRATION_ARRAY_WORDS),
    },
    encoding: "utf8",
    timeout: DEFAULT_CPU_CALIBRATION_TIMEOUT_MS,
    maxBuffer: 1 << 20,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  if (typeof result.stdout !== "string") return null;
  return parseCalibrationOutput(result.stdout);
}

/** The run's two calibration samples — one at each end of the measured run. */
export interface CalibrationEvidence {
  readonly atStart: CalibrationReading | null;
  readonly atEnd: CalibrationReading | null;
}

/**
 * The one computation of the suite's load-agnostic cost. Nothing else in the
 * tree divides the run's CPU by the calibration or by the test-file count:
 * the reporter writes this record, the verdict reads it, the ledger stores it
 * and every document quotes it.
 *
 * Returns null — ABSENT — when any input is missing or unusable. In
 * particular a run with no calibration is NOT measured in raw CPU: the two
 * quantities are different units, and substituting one for the other is the
 * silent-swap defect this metric exists to prevent.
 */
export interface RunWork {
  readonly metric: typeof SUITE_WORK_METRIC;
  /** The suite's CPU (self + reaped children) between the two snapshots. */
  readonly runCpuMs: number;
  /** The run's calibration: the mean of the start and end readings. */
  readonly calibrationMs: number;
  readonly calibrationStartMs: number;
  readonly calibrationEndMs: number;
  /** |end - start| / mean — how much the machine's speed moved during the run. */
  readonly calibrationDriftFraction: number;
  readonly calibrationWorkload: string;
  readonly calibrationChunkIterations: number;
  /** Suite CPU in calibration units. */
  readonly workUnits: number;
  /** The judged figure: calibration units per test file. */
  readonly workUnitsPerTestFile: number;
  /** Raw CPU per test file — provenance only, never judged. */
  readonly rawCpuMsPerTestFile: number;
}

/**
 * Combine the run's CPU delta and its two calibration readings into the one
 * judged quantity. See {@link RunWork}.
 */
export function computeRunWork(
  runCpuMs: number | null,
  calibration: CalibrationEvidence,
  testFileCount: number,
): RunWork | null {
  if (runCpuMs === null || !Number.isFinite(runCpuMs) || runCpuMs <= 0) return null;
  if (!Number.isSafeInteger(testFileCount) || testFileCount <= 0) return null;
  const start = calibration.atStart;
  const end = calibration.atEnd;
  if (start == null || end == null) return null;
  if (!Number.isFinite(start.cpuMs) || start.cpuMs <= 0) return null;
  if (!Number.isFinite(end.cpuMs) || end.cpuMs <= 0) return null;
  const calibrationMs = (start.cpuMs + end.cpuMs) / 2;
  if (!Number.isFinite(calibrationMs) || calibrationMs <= 0) return null;
  const workUnits = runCpuMs / calibrationMs;
  const workUnitsPerTestFile = workUnits / testFileCount;
  if (!Number.isFinite(workUnitsPerTestFile)) return null;
  return {
    metric: SUITE_WORK_METRIC,
    runCpuMs,
    calibrationMs,
    calibrationStartMs: start.cpuMs,
    calibrationEndMs: end.cpuMs,
    calibrationDriftFraction: Math.abs(end.cpuMs - start.cpuMs) / calibrationMs,
    calibrationWorkload: start.workload,
    calibrationChunkIterations: start.chunkIterations,
    workUnits,
    workUnitsPerTestFile,
    rawCpuMsPerTestFile: runCpuMs / testFileCount,
  };
}
