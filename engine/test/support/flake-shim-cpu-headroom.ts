/**
 * A REPRODUCTION SHIM for the engine runner (`harness flake reproduce
 * --preload engine/test/support/flake-shim-cpu-headroom.ts`, the FLAKE-REPRO
 * decision). It recreates, on any machine and every run, the HEADROOM RULE
 * the CPU classes are sized by (`testExecution.testCpuClasses.headroomFactor`):
 * a test must do at most its class ceiling / headroomFactor of CPU work, so a
 * runner that many times slower still passes it. The `[cpu-headroom]`
 * warning states the same rule.
 *
 * Each test's `beforeEach`, which runs inside the judge's window (hooks run in
 * registration order, and the judge registers first), does
 * `ceiling × (1 − 1/headroomFactor)` of CPU work first. The test then passes
 * its ceiling exactly when its own work is at most `ceiling / headroomFactor`.
 * A test that fits its ceiling only on a fast host fails here; one with the
 * headroom passes. (A preload's `afterEach`, or a test's `t.after`, runs after
 * the judge has read, so the work cannot be added at the end.)
 *
 * Every test in the process is judged so: run it with `--only-named`. Never
 * imported by a test.
 */
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

import { cpuClassOf, type TestCpuClasses } from "../../scripts/tooling/test-cpu-class.ts";
import { requireRunCpuMs } from "../../src/shared/run-cpu.ts";

const config = JSON.parse(readFileSync(new URL("../../bridlewise.config.json", import.meta.url), "utf8")) as { testExecution: { testCpuClasses: TestCpuClasses } };
const CLASSES = config.testExecution.testCpuClasses;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// Only a test file's own main thread: node:test imported in a worker would report it as a test file.
if (isMainThread) {
  const { beforeEach } = await import("node:test");
  beforeEach((context) => {
    const file = relative(REPOSITORY_ROOT, context.filePath ?? "").split(sep).join("/");
    const extra = cpuClassOf(CLASSES, file).ceilingMs * (1 - 1 / CLASSES.headroomFactor);
    const target = requireRunCpuMs() + extra;
    while (requireRunCpuMs() < target) {
      for (let spin = 0; spin < 200_000; spin += 1) Math.sqrt(spin);
    }
  });
}
