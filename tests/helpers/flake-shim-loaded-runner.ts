/**
 * A REPRODUCTION SHIM (`harness flake reproduce --preload`, the FLAKE-REPRO
 * decision) for a performance budget judged in WALL time: it recreates, on
 * any machine and every run, a loaded CI runner that preempts the test's
 * thread. Every `performance.now()` read made from a test file first waits
 * PREEMPTED_MS without working (`Atomics.wait`), as a thread waiting for a
 * core does, and only then reads the clock. A wall-clock budget measured
 * around the code therefore counts the wait; a CPU-work budget does not,
 * because the thread did no work while it waited (NO-LOAD-BLOCK).
 *
 * Observed: `tests/cockpit/render-perf.test.ts` "40 folded code blocks
 * tokenize inside 16ms" failed at 16.09 ms on #635's Shard 5 and in the
 * merge queue's run that removed #561. The code did not do more; the runner
 * was loaded.
 *
 * Every other caller reads the clock as before; the test and the product are
 * untouched. Preloaded into the reproduction run's vitest processes (the
 * door's NODE_OPTIONS); never imported by a test.
 */
const PREEMPTED_MS = 20;
const TEST_FILE_FRAME = /\.test\.ts:\d+:\d+/u;
const clock = performance.now.bind(performance);
const parked = new Int32Array(new SharedArrayBuffer(4));

performance.now = function readAfterAPreemption(): number {
  if (TEST_FILE_FRAME.test(new Error().stack ?? "")) Atomics.wait(parked, 0, 0, PREEMPTED_MS);
  return clock();
};
