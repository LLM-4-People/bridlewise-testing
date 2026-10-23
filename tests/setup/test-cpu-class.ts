/**
 * THE WEB SUITE'S PER-TEST JUDGEMENT: CPU WORK, BY CLASS (NO-LOAD-BLOCK L2).
 *
 * Installs the one judgement both suites share
 * (engine/scripts/tooling/test-cpu-class.ts) into every web test: a test is
 * judged by the CPU work it did against its file's class ceiling
 * (`testExecution.testCpuClasses`), never by its wall time. The reading is
 * kept on the test (`meta.cpuMs`, `meta.wallMs`) for the reporters, so the
 * JSON report carries each test's work beside its duration.
 *
 * The one wall bound left, vitest's `testTimeout`/`hookTimeout`, is the HANG
 * BACKSTOP (`testExecution.testHangBackstopMs`, wired in vitest.config.ts). A
 * test that reaches it is classified `hung` here, with the work it had done:
 * a hang is a different finding from a slow test, and says so.
 *
 * ── NO TEST DECLARES ITS OWN WALL BOUND: CHECKED AT RUN TIME ──────────────
 *
 * A per-test or per-hook timeout is a wall judgement, and the backstop is the
 * only wall bound (TEST-CPU-CLASSES). It is enforced HERE, on what the runner
 * actually does, never by reading sources: a static reader loses to the next
 * spelling (an aliased import, a namespace import, spread or computed options,
 * a helper that wraps `test`, `vi["setConfig"]`). Whatever the spelling, the
 * runner ends up in one of three places this module watches:
 *
 * - THE TIMER IT ARMS. Every test and hook the runner bounds is wrapped in
 *   its `runWithTimeout`, which arms a timer through the runner's own safe
 *   timers when the test or hook starts. Those timers are wrapped below: one
 *   armed with any delay but the backstop fails the test or hook it bounds,
 *   naming the delay. A liveness check proves the wrap sees the runner's
 *   timers on every test, so a runner that stops arming them this way fails
 *   loudly instead of passing unwatched.
 * - THE TASK IT COLLECTED. A test's effective `task.timeout` (0 or Infinity
 *   included, which arm no timer) must be the backstop, and so must every
 *   hook of the file's suites (a hook with no timer is refused by name).
 * - ITS CONFIGURATION. `testTimeout` and `hookTimeout` must still be the
 *   backstop before and after every test (a `setConfig` in any spelling).
 *
 * Every refusal fails the run, naming the test (or the hook's suite).
 */
import { relative, sep } from "node:path";
import { afterEach, beforeEach, TestRunner } from "vitest";
import type { RunnerTestSuite, TestContext } from "vitest";

import { deadClassFiles, installTestCpuJudgement } from "../../engine/scripts/tooling/test-cpu-class.ts";
import { readTestCpuClasses, readTestHangBackstopMs } from "../helpers/budget-config.ts";

const BACKSTOP_MS = readTestHangBackstopMs();
const WALL_RULE =
  `a per-test or per-hook wall timeout is not allowed: the only wall bound is the hang backstop ` +
  `(testExecution.testHangBackstopMs, ${String(BACKSTOP_MS)} ms), and a test is judged by its CPU work against its ` +
  `file's class (testExecution.testCpuClasses; TEST-CPU-CLASSES). Remove the timeout, or declare the file in a class`;

/** The runner's safe timers: the ones its `runWithTimeout` arms each test's and hook's bound with. */
type SafeTimers = { setTimeout: (handler: () => void, delay?: number, ...rest: unknown[]) => unknown };
const WRAPPED = Symbol.for("bridlewise.wall-bound.wrapped");
const safeTimersKey = Object.getOwnPropertySymbols(globalThis).find((key) => key.description === "vitest:SAFE_TIMERS");
const safeTimers = safeTimersKey === undefined ? undefined : (globalThis as unknown as Record<symbol, SafeTimers & { [WRAPPED]?: true }>)[safeTimersKey];
if (safeTimers === undefined) {
  throw new Error("test-cpu-class: the runner's safe timers are not on globalThis, so no test's wall bound can be watched; the check refuses to run unwatched");
}
/** How many bounds the runner armed in this file, as the wrap saw them (the liveness witness). */
let armedBounds = 0;
if (safeTimers[WRAPPED] !== true) {
  const real = safeTimers.setTimeout;
  safeTimers.setTimeout = function wallBoundTimer(handler, delay, ...rest) {
    const holder: { stack?: string } = {};
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 6;
    Error.captureStackTrace(holder, wallBoundTimer);
    Error.stackTraceLimit = limit;
    if (holder.stack?.includes("runWithTimeout") === true) {
      armedBounds += 1;
      if (delay !== BACKSTOP_MS) throw new Error(`this test or hook is bounded by a ${String(delay)} ms wall timeout; ${WALL_RULE}`);
    }
    return Reflect.apply(real, this, [handler, delay, ...rest]);
  };
  safeTimers[WRAPPED] = true;
}

/** The runner's configured bounds, as `setConfig` writes them (the worker's config object). */
function configuredBounds(): Readonly<{ testTimeout: unknown; hookTimeout: unknown }> {
  const config = (globalThis as { __vitest_worker__?: { config?: { testTimeout?: unknown; hookTimeout?: unknown } } }).__vitest_worker__?.config;
  if (config === undefined) throw new Error("test-cpu-class: the runner's configuration is unreadable, so a changed testTimeout or hookTimeout cannot be seen; refusing");
  return { testTimeout: config.testTimeout, hookTimeout: config.hookTimeout };
}

const CLEANUP_TIMEOUT = Symbol.for("VITEST_CLEANUP_TIMEOUT");
/** Every hook of `suite` and the suites under it whose bound is not the backstop: no timer at all, or a before-hook's other value. */
function offBoundHooks(suite: RunnerTestSuite, where: string): string[] {
  const found: string[] = [];
  for (const [kind, hooks] of Object.entries(TestRunner.getSuiteHooks(suite)) as [string, readonly ((...args: never[]) => unknown)[]][]) {
    if (kind === "aroundEach" || kind === "aroundAll") continue;
    for (const hook of hooks) {
      const declared = (hook as unknown as Record<symbol, unknown>)[CLEANUP_TIMEOUT];
      if (hook.name !== "runWithTimeout") found.push(`${where}: a ${kind} hook with no wall bound at all (a 0 or Infinity timeout)`);
      else if (declared !== undefined && declared !== BACKSTOP_MS) found.push(`${where}: a ${kind} hook bounded by ${String(declared)} ms`);
    }
  }
  for (const child of suite.tasks) if (child.type === "suite") found.push(...offBoundHooks(child, `${where} > ${child.name}`));
  return found;
}

/** The refusal for this test's bounds, or null when every one of them is the backstop. */
function wallBoundRefusal(context: TestContext, phase: "before" | "after"): string | null {
  const config = configuredBounds();
  if (config.testTimeout !== BACKSTOP_MS || config.hookTimeout !== BACKSTOP_MS) {
    return `${phase} this test the runner's testTimeout is ${String(config.testTimeout)} and hookTimeout ${String(config.hookTimeout)} ms (setConfig); ${WALL_RULE}`;
  }
  if (phase === "after") return null;
  if (context.task.timeout !== BACKSTOP_MS) return `this test is bounded by a ${String(context.task.timeout)} ms wall timeout; ${WALL_RULE}`;
  const hooks = offBoundHooks(context.task.file, context.task.file.name);
  return hooks.length === 0 ? null : `${hooks.join("; ")}; ${WALL_RULE}`;
}

declare module "vitest" {
  interface TaskMeta {
    /** This test's CPU work (its process and the children it reaped), in ms: the judged reading. */
    cpuMs?: number;
    /** This test's wall time, in ms: recorded, never judged. */
    wallMs?: number;
  }
}

const classes = readTestCpuClasses();
if ("missing" in classes) throw new Error(classes.missing);
// The suite runs from the repository root (vitest.config.ts pins it).
const ROOT = process.cwd();
const dead = deadClassFiles(classes, ROOT);
if (dead !== null) throw new Error(dead);

let armedBefore = 0;
beforeEach((context) => {
  // LIVENESS: this very hook ran inside a bound the runner armed, so the wrap must have seen it.
  if (armedBounds === armedBefore) {
    throw new Error("test-cpu-class: the runner armed no bound this wrap could see for this hook, so wall bounds are unwatched (has vitest changed how it arms them?); refusing");
  }
  armedBefore = armedBounds;
  const refusal = wallBoundRefusal(context, "before");
  if (refusal !== null) throw new Error(refusal);
});
afterEach((context) => {
  const refusal = wallBoundRefusal(context, "after");
  if (refusal !== null) throw new Error(refusal);
});

installTestCpuJudgement<TestContext>(
  { beforeEach, afterEach },
  classes,
  (context) => relative(ROOT, context.task.file.filepath).split(sep).join("/"),
  (context, reading) => {
    context.task.meta.cpuMs = reading.cpuMs;
    context.task.meta.wallMs = reading.wallMs;
    const timedOut = (context.task.result?.errors ?? []).some((error) => /timed out in \d+ms/u.test(String(error.message)));
    if (timedOut) {
      throw new Error(
        `hung: this test was still running at its ${String(context.task.timeout)} ms hang backstop (testExecution.testHangBackstopMs) ` +
          `after ${String(reading.cpuMs)} ms of CPU work. A hang is not a slow test: find what it waits for.`,
      );
    }
  },
);
