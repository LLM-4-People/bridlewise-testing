/**
 * THE CPU WORK OF ONE PIECE OF CODE, for a test's performance budget
 * (NO-LOAD-BLOCK: "i never want anything to be blocked no matter what cpu
 * usage we have").
 *
 * A wall-clock budget (`performance.now()` around a call) judges the HOST:
 * under load the code waits for a core and a correct test goes red
 * (measured: `sweep-perf` failed required Shard 3 at 144 ms against a 100 ms
 * budget, and 27 ms against 16 ms). This helper measures the work the
 * calling thread did instead (`readThreadCpuMs`, the engine's one CPU
 * reader), which waiting does not inflate.
 *
 * `runs` > 1 keeps the SMALLEST reading: a GC pause or a cold cache during
 * one run is real work, but not the code's own, and the least of several
 * runs is the closest to the code's cost.
 */
import { readThreadCpuMs } from "../../engine/src/shared/run-cpu.ts";

function threadCpuMs(): number {
  const reading = readThreadCpuMs();
  if (reading === null) {
    throw new Error("cpu-work: this runtime gives no per-thread CPU reading (process.threadCpuUsage), so no CPU budget can be judged here; a budget with no measurement behind it would pass everything");
  }
  return reading;
}

/** The least CPU work, in ms, `fn` did on this thread across `runs` calls. */
export function cpuWorkMs(fn: () => void, runs = 1): number {
  let least = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run += 1) {
    const start = threadCpuMs();
    fn();
    least = Math.min(least, threadCpuMs() - start);
  }
  return least;
}
