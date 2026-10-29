/**
 * A REPRODUCTION SHIM for the engine runner (`harness flake reproduce
 * --preload engine/test/support/flake-shim-cpu-past-default.ts`, the
 * FLAKE-REPRO decision). It recreates, on any machine and every run, what a
 * slower hosted runner did to S1-B09-HOSTILE-REAL (#615): the test's CPU work
 * crossing the DEFAULT class's 60 s ceiling (60,207 ms), which a test with
 * less than the classes' headroom over its normal cost does at random.
 *
 * In the test process it marks the named test while it runs (a beforeEach,
 * order-free), and the first `readFileSync` that test makes does 61 s of CPU
 * work first — inside the test's own window, so the judgement counts it.
 *
 * Never imported by a test.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isMainThread } from "node:worker_threads";

const TARGET = "S1-B09-HOSTILE-REAL";
const EXTRA_CPU_MS = 61_000;
let running: string | undefined;
let burnt = false;

// Only a test file's own main thread: node:test imported in a worker would report it as a test file.
if (isMainThread) {
  const { beforeEach, afterEach } = await import("node:test");
  beforeEach((context) => { running = context.name; });
  afterEach(() => { running = undefined; });
}

const readFileSync = fs.readFileSync;
fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
  if (running === TARGET && !burnt) {
    burnt = true;
    const start = process.threadCpuUsage();
    for (;;) {
      const used = process.threadCpuUsage(start);
      if ((used.user + used.system) / 1000 >= EXTRA_CPU_MS) break;
    }
  }
  return Reflect.apply(readFileSync, fs, args) as ReturnType<typeof fs.readFileSync>;
}) as typeof fs.readFileSync;
syncBuiltinESMExports();
