/**
 * A REPRODUCTION SHIM for the engine runner (`harness flake reproduce
 * --preload engine/test/support/flake-shim-cpu-headroom.ts`, the FLAKE-REPRO
 * decision). It recreates, on any machine and every run, the runner the CPU
 * classes are sized for: one `testExecution.testCpuClasses.headroomFactor`
 * times slower than this host. Each test's CPU work (this process and its
 * reaped children, the judge's own reader) is measured from its
 * `beforeEach`, and its `afterEach` does that work over again (factor − 1
 * times) before the judge reads it. A test whose work fits its ceiling only
 * on a fast host fails here; one with the classes' headroom passes.
 *
 * Every test in the process is slowed: run it with `--only-named`. Never
 * imported by a test.
 */
import { readFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";

import { requireRunCpuMs } from "../../src/shared/run-cpu.ts";

const config = JSON.parse(readFileSync(new URL("../../bridlewise.config.json", import.meta.url), "utf8")) as { testExecution: { testCpuClasses: { headroomFactor: number } } };
const FACTOR = config.testExecution.testCpuClasses.headroomFactor;

// Only a test file's own main thread: node:test imported in a worker would report it as a test file.
if (isMainThread) {
  const { beforeEach, afterEach } = await import("node:test");
  const starts = new WeakMap<object, number>();
  beforeEach((context) => { starts.set(context, requireRunCpuMs()); });
  afterEach((context) => {
    const start = starts.get(context);
    if (start === undefined) return;
    const target = requireRunCpuMs() + (requireRunCpuMs() - start) * (FACTOR - 1);
    while (requireRunCpuMs() < target) {
      for (let spin = 0; spin < 200_000; spin += 1) Math.sqrt(spin);
    }
  });
}
