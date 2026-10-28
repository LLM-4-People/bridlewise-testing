/**
 * PER-TEST LIMITS IN CPU WORK — the one judgement both test runners install
 * (NO-LOAD-BLOCK, audit L2 and row G-05).
 *
 * ── WHY NOT WALL TIME ─────────────────────────────────────────────────────
 *
 * A per-test wall timeout judges the HOST, not the test. A busy machine makes
 * a runnable test WAIT for a core; it does not make it execute more. The user
 * rule this serves: "i never want anything to be blocked no matter what cpu
 * usage we have". Measured on the red that brought this here: the web suite's
 * `declared-pattern-liveness` arm took 17-30 s of wall on hosted runners and
 * timed out at the 30 s wall limit, and the cause was CPU WORK (it re-ran the
 * whole public node:test suite, ~32 s of CPU); a wall limit could not tell
 * that apart from a loaded runner, and it would equally have failed a 1 s test
 * on a host thirty times oversubscribed.
 *
 * ── WHAT IS JUDGED ────────────────────────────────────────────────────────
 *
 * Each test's CPU work: this process's CPU (every thread) plus every child it
 * REAPED during the test, read by the one in-repo reader
 * (`src/shared/run-cpu.ts`, `/proc/self/stat` `cutime`/`cstime`). The window
 * is the test with its `beforeEach`/`afterEach` hooks. The ceiling is the
 * test FILE's class (`testExecution.testCpuClasses`), declared once, in the
 * config both suites read: a file named in a class gets that class's
 * ceiling, every other file the default. A test over its ceiling FAILS with
 * the work it did, the ceiling it broke and where that ceiling is declared.
 * Wall time is RECORDED beside it as a signal and never judged.
 *
 * An unreadable CPU reading is a REFUSAL, never a pass: a judgement with no
 * measurement behind it would agree with everything.
 *
 * ── WHAT IS NOT JUDGED HERE ───────────────────────────────────────────────
 *
 * A HANG. A test that never settles is ended by the runner's one wall
 * backstop (`testExecution.testHangBackstopMs`), which is large on purpose:
 * it exists to end a hang, never to police slowness. The runner's stall
 * watchdog (no output) ends a synchronous spin, which no in-runtime hook can.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { readRunCpu } from "../../src/shared/run-cpu.ts";
import type { TestExecutionConfig } from "../../src/kernel/config-contracts.ts";

/** The declaration, as `testExecution.testCpuClasses` holds it. */
export type TestCpuClasses = NonNullable<TestExecutionConfig["testCpuClasses"]>;

/** Where an operator sets the classes; every message names it. */
export const TEST_CPU_CLASSES_SITE = "testExecution.testCpuClasses in engine/bridlewise.config.json";

/**
 * The class a test file is judged under: its declared class, else the
 * default. `file` is repository-relative (`tests/…`, `engine/test/…`), as the
 * classes name their files; each runner's door spells it from its own root
 * (a vitest DOM context's module URLs are not file URLs, so this module never
 * derives a root of its own).
 */
export function cpuClassOf(classes: TestCpuClasses, file: string): Readonly<{ name: string; ceilingMs: number }> {
  const declared = classes.classes.find((one) => one.files.includes(file));
  return declared === undefined ? { name: "default", ceilingMs: classes.defaultCeilingMs } : { name: declared.name, ceilingMs: declared.ceilingMs };
}

/**
 * A class that names a file the repository does not hold is dead config: the
 * file it meant was renamed or deleted, and whatever replaced it is judged
 * under a ceiling nobody chose for it. Refused, with the names.
 */
export function deadClassFiles(classes: TestCpuClasses, repositoryRoot: string): string | null {
  const dead = classes.classes.flatMap((one) => one.files.filter((file) => !existsSync(join(repositoryRoot, file))).map((file) => `${one.name}: ${file}`));
  return dead.length === 0 ? null : `${TEST_CPU_CLASSES_SITE} names test files that do not exist (${dead.join(", ")}); a class must name the files it was measured for`;
}

/** This process's CPU work so far (its own and its reaped children's), in ms. */
function cpuWorkMs(): number {
  const reading = readRunCpu();
  if (reading === null) {
    throw new Error(
      "test-cpu-class: this process's CPU work is unreadable (no /proc/self/stat), so no test here can be judged; " +
        "a judgement with no measurement behind it would pass everything",
    );
  }
  return reading.totalCpuMs;
}

/** The verdict on one test's work, or null when it is within its class. */
export function cpuCeilingFailure(
  classes: TestCpuClasses,
  file: string,
  cpuMs: number,
  wallMs: number,
): string | null {
  const judged = cpuClassOf(classes, file);
  if (cpuMs <= judged.ceilingMs) return null;
  return (
    `this test did ${String(cpuMs)} ms of CPU work, over its ${judged.name} class ceiling of ${String(judged.ceilingMs)} ms ` +
    `(${TEST_CPU_CLASSES_SITE}); its wall time, ${String(wallMs)} ms, is recorded and not judged. ` +
    `Do less work, or declare the file in a class whose ceiling was measured for it.`
  );
}

/** The two per-test hooks of a runner (vitest's or node:test's), each given that runner's own context. */
export type PerTestHooks<Context> = Readonly<{
  beforeEach: (hook: (context: Context) => void) => void;
  afterEach: (hook: (context: Context) => void) => void;
}>;

/**
 * Installs the judgement into a runner: `fileOf` names the test file of a
 * hook's context (repository-relative), and `record` (optional) keeps the
 * reading beside the test for its reporters.
 *
 * ONE READING PER TEST CONTEXT, never one per process: both runners hand a
 * test's `beforeEach` and `afterEach` the same context object, and a test's
 * window may hold others — a nested `t.test` runs its hooks inside its
 * parent's window, and concurrent tests interleave theirs. Each window is
 * keyed by its own context. CPU work is the process's, so a parent's reading
 * includes its subtests' work (it did that work) and concurrent tests each
 * see the work done during their window: both are over-, never
 * under-attribution, so no test escapes its ceiling.
 */
export function installTestCpuJudgement<Context extends object>(
  hooks: PerTestHooks<Context>,
  classes: TestCpuClasses,
  fileOf: (context: Context) => string,
  record?: (context: Context, reading: Readonly<{ cpuMs: number; wallMs: number }>) => void,
): void {
  const starts = new WeakMap<Context, Readonly<{ cpuMs: number; wallMs: number }>>();
  hooks.beforeEach((context) => {
    starts.set(context, { cpuMs: cpuWorkMs(), wallMs: performance.now() });
  });
  hooks.afterEach((context) => {
    const start = starts.get(context);
    if (start === undefined) throw new Error("test-cpu-class: an afterEach ran with no beforeEach reading for its test, so this test's work is unmeasured");
    starts.delete(context);
    const reading = { cpuMs: Math.max(0, cpuWorkMs() - start.cpuMs), wallMs: Math.round(performance.now() - start.wallMs) };
    record?.(context, reading);
    const failure = cpuCeilingFailure(classes, fileOf(context), reading.cpuMs, reading.wallMs);
    if (failure !== null) throw new Error(failure);
  });
}
