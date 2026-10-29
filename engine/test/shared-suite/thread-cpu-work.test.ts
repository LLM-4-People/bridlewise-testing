/**
 * THE CPU WORK OF ONE PIECE OF CODE (engine/src/shared/run-cpu.ts): the one
 * reading every performance budget is judged by (NO-LOAD-BLOCK).
 *
 * Pinned here, each with a plant that turns it red:
 *  - the reading moves in scheduler TICKS, so a call far shorter than a tick
 *    is still measured (by repetition), not read as 0 or as a whole tick;
 *  - it is THIS THREAD's work: another thread burning CPU while the measured
 *    code waits is not counted (`process.cpuUsage()` would count it);
 *  - an unreadable reading is a typed refusal, never a zero.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { cpuWorkOf, threadCpuTickMs, threadCpuWorkMs } from "../../src/shared/run-cpu.ts";

test("the reading moves in scheduler ticks, probed on this host (never a constant)", () => {
  const tick = threadCpuTickMs();
  assert.ok(tick > 0 && tick < 50, `a tick of ${String(tick)} ms`);
});

test("a call far shorter than a tick is measured by repetition: a sub-tick call reads above 0 and below a tick, and four times the work reads about four times as much", () => {
  let sink = 0;
  const work = (iterations: number) => (): void => {
    for (let i = 0; i < iterations; i += 1) sink = (sink + i * 7) % 1_000_003;
  };
  const tick = threadCpuTickMs();
  // Size one call well under a tick on this host, from a measured call.
  let iterations = 200_000;
  while (cpuWorkOf(work(iterations)) > tick / 4) iterations = Math.floor(iterations / 2);
  const once = cpuWorkOf(work(iterations), 3);
  const four = cpuWorkOf(work(iterations * 4), 3);
  assert.ok(sink >= 0);
  assert.ok(once > 0 && once < tick, `a sub-tick call read ${once.toFixed(3)} ms against a ${tick.toFixed(1)} ms tick`);
  assert.ok(four / once > 2.5 && four / once < 6, `four times the work read ${(four / once).toFixed(2)} times as much (${once.toFixed(3)} → ${four.toFixed(3)} ms)`);
});

test("it is THIS THREAD's work: a worker burning CPU while the measured code waits is not counted", async (t) => {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(
    `const { workerData, parentPort } = require("node:worker_threads");
     const flag = new Int32Array(workerData);
     parentPort.on("message", (ms) => {
       const start = process.threadCpuUsage();
       for (;;) { const used = process.threadCpuUsage(start); if ((used.user + used.system) / 1000 >= ms) break; }
       Atomics.store(flag, 0, 1);
       Atomics.notify(flag, 0);
     });
     parentPort.postMessage("ready");`,
    { eval: true, workerData: flag.buffer },
  );
  t.after(() => worker.terminate());
  await new Promise((resolve) => worker.once("message", resolve));
  const perCall = cpuWorkOf(() => {
    // The worker burns 10 ms of ITS thread's CPU while this thread waits for it.
    Atomics.store(flag, 0, 0);
    worker.postMessage(10);
    Atomics.wait(flag, 0, 0);
  });
  assert.ok(perCall < 2, `a wait while another thread burned 10 ms read ${perCall.toFixed(3)} ms of this thread's work`);
});

test("an unreadable reading is a typed refusal, never a zero", () => {
  const real = process.threadCpuUsage;
  (process as { threadCpuUsage?: unknown }).threadCpuUsage = undefined;
  try {
    assert.throws(() => threadCpuWorkMs(), (error: unknown) => (error as { code?: string }).code === "cpu_reading_unavailable");
  } finally {
    process.threadCpuUsage = real;
  }
});
