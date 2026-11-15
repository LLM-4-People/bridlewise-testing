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

import {
  calibrationReadingFromChunks,
  cpuWorkOf,
  measureCalibration,
  threadCpuTickMs,
  threadCpuWorkMs,
  type CalibrationSpawn,
} from "../../src/shared/run-cpu.ts";

test("a constructed calibration owns its ordered witness and preserves custom workload units", () => {
  const chunks = [30, 10, 20, 40];
  const profile = { workload: "test-reference/v1", chunkIterations: 100 };
  const reading = calibrationReadingFromChunks(chunks, profile);
  assert.deepEqual(reading, {
    cpuMs: 25,
    chunks: [30, 10, 20, 40],
    workload: "test-reference/v1",
    chunkIterations: 100,
  });
  assert.ok(reading);
  assert.notEqual(reading.chunks, chunks);
  assert.deepEqual(chunks, [30, 10, 20, 40]);
  chunks[0] = 999;
  profile.workload = "changed-reference/v2";
  profile.chunkIterations = 200;
  assert.deepEqual(reading.chunks, [30, 10, 20, 40]);
  assert.equal(reading.workload, "test-reference/v1");
  assert.equal(reading.chunkIterations, 100);
  assert.equal(calibrationReadingFromChunks([30, 10, 20], profile)?.cpuMs, 20);
});

test("chunk getters cannot relabel a calibration after its unit is validated", () => {
  const profile = { workload: "test-reference/v1", chunkIterations: 100 };
  const chunks = [10, 20, 30];
  Object.defineProperty(chunks, 0, {
    get() {
      profile.workload = "changed-reference/v2";
      profile.chunkIterations = 0;
      return 10;
    },
  });
  const reading = calibrationReadingFromChunks(chunks, profile);
  assert.equal(profile.workload, "changed-reference/v2");
  assert.equal(profile.chunkIterations, 0);
  assert.deepEqual(reading, {
    cpuMs: 20,
    chunks: [10, 20, 30],
    workload: "test-reference/v1",
    chunkIterations: 100,
  });
});

test("an array length cannot forge a calibration's required chunk witness", () => {
  const chunks = [10, 20, 30];
  Object.defineProperty(chunks, Symbol.iterator, {
    value: function* () {
      yield 10;
    },
  });
  assert.equal(chunks.length, 3);
  assert.equal(calibrationReadingFromChunks(chunks, {
    workload: "test-reference/v1",
    chunkIterations: 100,
  }), null);
});

test("a calibration constructor refuses malformed or unusable units", () => {
  for (const profile of [null, undefined, {}, "test-reference/v1"]) {
    assert.equal(calibrationReadingFromChunks([10, 20, 30], profile as never), null);
  }
  for (const workload of [null, undefined, 100, "", " \t\n"]) {
    assert.equal(calibrationReadingFromChunks([10, 20, 30], {
      workload,
      chunkIterations: 100,
    } as never), null);
  }
  for (const chunkIterations of [undefined, null, 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(calibrationReadingFromChunks([10, 20, 30], {
      workload: "test-reference/v1",
      chunkIterations,
    } as never), null);
  }
});

test("a calibration constructor refuses absent, invalid or overflowed chunk witnesses", () => {
  const invalidChunks: readonly [string, unknown][] = [
    ["absent", undefined],
    ["null", null],
    ["non-array", {}],
    ["empty", []],
    ["short", [10, 20]],
    ["zero", [10, 0, 30]],
    ["negative", [10, -20, 30]],
    ["non-number", [10, "20", 30]],
    ["NaN", [10, Number.NaN, 30]],
    ["infinite", [10, Number.POSITIVE_INFINITY, 30]],
    ["overflowed median", [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]],
  ];
  for (const [label, chunks] of invalidChunks) {
    assert.equal(calibrationReadingFromChunks(chunks as never, {
      workload: "test-reference/v1",
      chunkIterations: 100,
    }), null, label);
  }
});

/** A native-shaped result for the actual UTF-8 seam; no subprocess or calibration work. */
function calibrationSpawn(stdout: string): {
  spawn: CalibrationSpawn;
  calls: () => number;
} {
  let calls = 0;
  const spawn: CalibrationSpawn = (_command, _args, options) => {
    assert.equal(options?.encoding, "utf8");
    calls += 1;
    return { pid: 0, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
  };
  return { spawn, calls: () => calls };
}

test("the production calibration parser retains fixed units and ordered odd/even chunk witnesses", () => {
  for (const { chunks, cpuMs } of [
    { chunks: [30, 10, 20], cpuMs: 20 },
    { chunks: [30, 10, 20, 40], cpuMs: 25 },
  ]) {
    const fixture = calibrationSpawn(JSON.stringify(chunks));
    assert.deepEqual(measureCalibration(fixture.spawn), {
      cpuMs,
      chunks,
      workload: "int-mem-l2/v1",
      chunkIterations: 5_000_000,
    });
    assert.equal(fixture.calls(), 1);
  }
});

test("the production calibration parser preserves absence for malformed or unusable output", () => {
  for (const stdout of [
    "[", "null", "{}", '"chunks"', "[]", "[10,20]", "[10,0,20]", "[10,-1,20]",
    '[10,"20",30]', "[10,null,30]", "[1e400,10,20]",
    "[1.7976931348623157e308,1.7976931348623157e308,1.7976931348623157e308,1.7976931348623157e308]",
  ]) {
    const fixture = calibrationSpawn(stdout);
    assert.equal(measureCalibration(fixture.spawn), null, stdout);
    assert.equal(fixture.calls(), 1);
  }
});

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
