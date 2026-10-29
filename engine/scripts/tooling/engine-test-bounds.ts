/**
 * THE ENGINE SUITE'S PER-TEST BOUNDS (NO-LOAD-BLOCK; TEST-CPU-CLASSES, row
 * G-05): preloaded into every test file's process by the one runner door
 * (`inventory-test-run.ts` hands node:test {@link engineTestBoundsImport}).
 *
 * ── CPU WORK, BY CLASS — NEVER A PER-TEST WALL CAP ────────────────────────
 *
 * Each test is judged by the CPU work it did against its file's class
 * (`testExecution.testCpuClasses`, the one judgement both suites install:
 * `test-cpu-class.ts`). A per-test WALL timeout used to be the judgement
 * (`runtimeBudgetMs`, 120 s): under full-suite contention it failed tests
 * that pass alone — foundation-cascade, handoff-continuity and
 * repository-path each spawn three hostile runtimes and ran out of wall
 * time while doing no more work. A busy host makes a test wait for a core;
 * it does not make it do more.
 *
 * ── ONE WALL BOUND: THE HANG BACKSTOP ─────────────────────────────────────
 *
 * node:test's per-test timeout is set to `testExecution.testHangBackstopMs`
 * (the same backstop the web suite uses): it ends a test that never settles,
 * and it never polices slowness. No test declares its own: that is refused
 * AT RUN TIME, on the timer the runner arms, not by reading sources (a static
 * reader always loses to the next spelling). node:test arms each test's and
 * hook's bound through `timers.setTimeout`, which its internals bind when
 * they load; this module wraps it BEFORE node:test loads, so a bound armed
 * with any delay but the backstop fails the test, suite or hook it bounds,
 * naming the delay. A liveness witness proves on every test that the wrap
 * sees the runner's timers, so a node that stops arming them this way fails
 * loudly instead of passing unwatched.
 */
import timers from "node:timers";
import { relative, resolve, sep } from "node:path";
import { isMainThread } from "node:worker_threads";

import { isEntryPointAmong } from "../../src/runtime/entry-point.ts";
import { DEFAULT_TEST_CPU_CLASSES, DEFAULT_TEST_HANG_BACKSTOP_MS } from "../../src/workflow/workflow-config.ts";
import { installTestCpuJudgement, type TestCpuClasses } from "./test-cpu-class.ts";
import { enterOwnWorkerLeaf } from "../../src/process/instrument-lock.ts";

/**
 * The diagnostic word a test file's worker names its leaf with (`<word> <pid>`),
 * read back by the run's accountant to know which file each leaf measured.
 * The peak itself is read by the runner from the scope, never reported by the
 * worker (instrument-lock.ts `runScopeLeafMemory`).
 */
export const WORKER_LEAF_DIAGNOSTIC = "worker-leaf";

/**
 * What a test file's process is bounded by. `cpuClasses` is null for a run
 * that does not judge CPU (coverage instruments every line). `files` are the
 * test files the run dispatches (absolute): only a process whose main module
 * is one of them installs anything.
 */
export type EngineTestBounds = Readonly<{ hangBackstopMs: number; cpuClasses: TestCpuClasses | null; repositoryRoot: string; files: readonly string[] }>;

/**
 * THE ONE CONSTRUCTION of a run's bounds from the config (every engine runner
 * uses it: the suite's inventory run and the targeted door test-guards.ts),
 * so no runner runs its test files under bounds of its own or none at all.
 * `coverage` judges no CPU (it instruments every line). The files are the
 * runner's: it adds them.
 */
export function engineTestBoundsFrom(
  options: Readonly<{ testHangBackstopMs?: number; testCpuClasses?: TestCpuClasses }>,
  engineRoot: string,
  coverage = false,
): Omit<EngineTestBounds, "files"> {
  return Object.freeze({
    hangBackstopMs: options.testHangBackstopMs ?? DEFAULT_TEST_HANG_BACKSTOP_MS,
    cpuClasses: coverage ? null : options.testCpuClasses ?? DEFAULT_TEST_CPU_CLASSES,
    repositoryRoot: resolve(engineRoot, ".."),
  });
}

/** The refusal of a per-test wall bound, naming it. */
function wallBoundRefusal(delay: unknown, backstopMs: number): string {
  return `this test, suite or hook is bounded by a ${String(delay)} ms wall timeout: a per-test wall timeout is not allowed. ` +
    `The only wall bound is the hang backstop (testExecution.testHangBackstopMs, ${String(backstopMs)} ms), and a test is judged ` +
    "by its CPU work against its file's class (testExecution.testCpuClasses; TEST-CPU-CLASSES). Remove the timeout, or declare the file in a class";
}

/**
 * Installs the bounds into THIS process: the timer wrap first (node:test must
 * not be loaded yet), then the per-test hooks on node:test's root, which every
 * test of the file runs under.
 */
export async function installEngineTestBounds(bounds: EngineTestBounds): Promise<void> {
  // ONLY THE TEST FILE'S OWN PROCESS. The preload rides `process.execArgv`
  // into everything a test starts the usual way — a worker thread, a child
  // node it spawns with the parent's options — and node:test, once imported
  // there, makes that thread or process report as a test file of its own
  // (measured: timeline-concurrency's worker threads arrived as unknown
  // files and the run's accounting refused itself). Such a thread or
  // process is the test's own work, already bounded by its test.
  if (!isMainThread || !isEntryPointAmong(bounds.files)) return;
  // Inside an admitted run, this test file's process (and every process it
  // starts) is accounted in a leaf of its own, so its peak memory is measured
  // per worker (instrument-lock.ts `enterOwnWorkerLeaf`). Moved before any
  // test runs, so the leaf sees the test's whole allocation.
  const workerLeaf = enterOwnWorkerLeaf();
  let armed = 0;
  const real = timers.setTimeout;
  timers.setTimeout = function engineBoundTimer(this: unknown, ...args: Parameters<typeof timers.setTimeout>) {
    const holder: { stack?: string } = {};
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 8;
    Error.captureStackTrace(holder, engineBoundTimer);
    Error.stackTraceLimit = limit;
    if (holder.stack?.includes("node:internal/test_runner/") === true) {
      armed += 1;
      if (args[1] !== bounds.hangBackstopMs) throw new Error(wallBoundRefusal(args[1], bounds.hangBackstopMs));
    }
    return Reflect.apply(real, this, args) as ReturnType<typeof timers.setTimeout>;
  } as typeof timers.setTimeout;
  const { beforeEach, afterEach } = await import("node:test");
  let seen = 0;
  beforeEach(() => {
    // LIVENESS: this very hook ran inside a bound the runner armed, so the wrap must have seen it.
    if (armed === seen) {
      throw new Error("engine-test-bounds: the runner armed no bound this wrap could see for this hook, so wall bounds are unwatched (has node:test changed how it arms them?); refusing");
    }
    seen = armed;
  });
  if (bounds.cpuClasses === null) return;
  type Context = import("node:test").TestContext | import("node:test").SuiteContext;
  installTestCpuJudgement<Context>(
    { beforeEach: (hook) => beforeEach((context) => hook(context)), afterEach: (hook) => afterEach((context) => hook(context)) },
    bounds.cpuClasses,
    (context) => relative(bounds.repositoryRoot, context.filePath ?? "").split(sep).join("/"),
    // The reading rides the test's own diagnostics, so the run's report carries each test's work.
    (context, reading) => {
      if (!("diagnostic" in context)) return;
      context.diagnostic(`cpu-work ${String(reading.cpuMs)} ms; wall ${String(reading.wallMs)} ms (recorded, not judged)`);
      // Which leaf measures this file: the runner reads its peak from the scope.
      if (workerLeaf !== undefined) context.diagnostic(`${WORKER_LEAF_DIAGNOSTIC} ${String(process.pid)}`);
    },
  );
}

/** The bounds module as a file URL, for the preload of a process the run starts itself. */
const SELF = new URL("./engine-test-bounds.ts", import.meta.url).href;

/** The node option that preloads the bounds into a process the run starts to run test files: a `data:` module that installs them. */
export function engineTestBoundsImport(bounds: EngineTestBounds): string {
  const install = `import { installEngineTestBounds } from ${JSON.stringify(SELF)}; await installEngineTestBounds(${JSON.stringify(bounds)});`;
  return `--import=data:text/javascript,${encodeURIComponent(install)}`;
}
