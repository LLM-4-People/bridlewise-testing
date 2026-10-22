import { once } from "node:events";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Transform } from "node:stream";
import { finished } from "node:stream/promises";
import { run } from "node:test";

import {
  assertTestInventorySourceSnapshot,
  testFilesFromInventory,
  type TestInventory,
  type TestInventorySourceSnapshot,
} from "../test-inventory.ts";
import {
  deriveTestRunReasons,
  type TestCounts,
  type TestRunReason,
  type TestRunnerSummary,
  type TestFailureDetail,
  type TestSkip,
} from "./test-receipt.ts";
import {
  extractTestResultError,
  isCancelledTestFailure,
  classifyTestConcurrency,
  buildSerialPhases,
  loadPriorTestFileDurations,
  sortTestFilesLongestFirst,
  DEFAULT_FULL_SUITE_PARALLEL_CONCURRENCY,
  type ConcurrencyMode,
  type TestFileDuration,
} from "../../src/workflow/test-result-collector.ts";
import { DEFAULT_ENGINE_SUITE_WATCHDOG, DEFAULT_TEST_RUNTIME_BUDGET_MS, type SuiteWatchdog } from "../../src/workflow/workflow-config.ts";
import { deepFreeze } from "../../src/kernel/integrity.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { networkGuardImport } from "./network-under-test.ts";

type TestEvent = Readonly<{
  type: string;
  data?: Readonly<{
    name?: string;
    file?: string;
    line?: number;
    column?: number;
    skip?: unknown;
    todo?: unknown;
    success?: unknown;
    nesting?: unknown;
    duration_ms?: unknown;
    details?: Readonly<{
      duration_ms?: unknown;
      error?: unknown;
    }>;
    counts?: Readonly<{
      tests?: unknown;
      failed?: unknown;
      passed?: unknown;
      cancelled?: unknown;
      skipped?: unknown;
      todo?: unknown;
      topLevel?: unknown;
      suites?: unknown;
    }>;
  }>;
}>;

type TestSummaryCounts = NonNullable<NonNullable<TestEvent["data"]>["counts"]>;

export type InventoryTestAccounting = Readonly<{
  expectedIds: readonly string[];
  discoveredIds: readonly string[];
  passedIds: readonly string[];
  counts: TestCounts;
  /**
   * Files that failed AT MODULE LOAD (no resolved child test events). Node's
   * runner counts each as ONE synthetic failed test in its summary, and the
   * per-test accounting counts the same crash in `counts.failed` (the named
   * module-load row) — but the file contributes ZERO inventory ids to
   * `discoveredIds`, because its real tests never enqueued. That asymmetry is
   * the one place `passed+failed+skipped+todo+cancelled` legitimately exceeds
   * the inventory-id `discovered` count, and the receipt must reconcile it
   * (not crash on it). Recorded here so the receipt can subtract exactly the
   * crash count — never a guess, never a blanket tolerance.
   */
  loadCrashCount: number;
  /**
   * Files the suite watchdog KILLED (`engineSuiteWatchdog`): node reports each
   * as one more aborted (cancelled) file-level test beside whatever of its own
   * tests had reported, so, like a load crash, it is a terminal with no
   * inventory id — reconciled exactly by the receipt, and named in `failures`.
   */
  abortedFileCount: number;
  runnerSummary: TestRunnerSummary;
  reasons: readonly TestRunReason[];
  failures: readonly string[];
  failureDetails: readonly TestFailureDetail[];
  /** Every dispatched test that skipped, named `<file>::<name>` with its reason (test-receipt.ts TestSkip). */
  skips: readonly TestSkip[];
  unknownTests: readonly string[];
  /**
   * Test entry IDs withheld from dispatch. Empty on every run today — nothing
   * withholds any more. The receipt RECORDS them; it no longer measures
   * against them, which is the whole point: this used to define the expected
   * set, so withholding a file made the run complete by definition.
   */
  gatedTestIds: readonly string[];
  /**
   * Per-file wall-clock durations observed from `test:summary` events,
   * sorted by path. A plain array (not a Map) so the accounting stays
   * canonical-JSON encodable for fixture consumers.
   */
  fileDurations: readonly TestFileDuration[];
  runnerSummaryObserved: boolean;
  runnerSuccessful: boolean;
  passed: boolean;
}>;

export type InventoryTestRunOptions = Readonly<{
  coverage?: boolean;
  reporter?: Transform;
  concurrency?: ConcurrencyMode;
  parallelConcurrency?: number;
  /**
   * Parallel-phase concurrency when RUN_SLOW is set (the full suite). The
   * full suite overlaps the parallel phase with the serial tiers; a LOWER
   * parallel concurrency reduces the total process count so the serial
   * tiers' CPU-bound + child processes face less oversubscription. The
   * default suite (non-RUN_SLOW) keeps the full parallelConcurrency.
   */
  fullSuiteParallelConcurrency?: number;
  /**
   * Concurrency for the serial phase. The serial phase runs files that share
   * process-level resources (evidence-worker spawns, S1 repository walks)
   * SEPARATELY from the parallel phase to avoid cross-phase contention.
   * Within the serial phase, a bounded concurrency lets the isolated serial
   * files (each using its own temp directory) share the phase. 1 (or
   * undefined) preserves the original fully sequential behavior; values >1
   * run that many serial files at once. The default lives in
   * workflow-config.ts; the config document overrides it.
   */
  serialPhaseConcurrency?: number;
  /**
   * Concurrency for the serial phase when RUN_SLOW is set (the full suite).
   * The slow serial files use process isolation when concurrency > 1, so a
   * higher concurrency is safe. The default lives in workflow-config.ts; the
   * config document overrides it. This is the concurrency for the SUBPROCESS-
   * SPAWNING serial tier; the in-process tier uses
   * fullSuiteInProcessSerialPhaseConcurrency.
   */
  fullSuiteSerialPhaseConcurrency?: number;
  /**
   * Concurrency for the IN-PROCESS serial tier when RUN_SLOW is set (the full
   * suite). In-process serial files (S1 scenarios with verifyS1Structure,
   * harness-commands architecture scans) are CPU-bound and do not spawn
   * subprocesses, so a higher concurrency is safe (no subprocess
   * oversubscription). The default lives in workflow-config.ts; the config
   * document overrides it.
   */
  fullSuiteInProcessSerialPhaseConcurrency?: number;
  /**
   * Wall-clock budget for a SINGLE TEST CASE, in milliseconds. Passed to the
   * runner as `timeout`, so a test that never settles FAILS instead of
   * removing the suite.
   *
   * ── THE POPULATION THIS NUMBER BOUNDS, AND WHERE IT CAME FROM ───────────
   *
   * It bounds ONE TEST, not one file and not the run: driven on node
   * v24.18.0, `run({ timeout })` fails the individual test with
   * `failureType: "testTimeoutFailure"`, then lets the remaining tests in the
   * same file run and the run complete normally.
   *
   * The default is `testExecution.runtimeBudgetMs`. Its value is bounded from
   * below by measurement: the slowest FILE in this suite is
   * `test/foundation-cascade.test.ts` at 45,195 ms, and a file's duration is
   * the sum of its tests, so 45,195 ms is a measured UPPER BOUND on the
   * slowest single test. The default sits above that with room for
   * contention. Changing the file set changes that bound, which is why the
   * number lives in the config beside the measurement rather than in this
   * file.
   *
   * Absent this, the children ran at node's default `--test-timeout=0` —
   * never. Measured: a hung `test/tools/concurrent/worker-pool.test.ts` sat
   * for 22 minutes across three respawns and produced no verdict at all.
   * The suite-level CPU budget cannot help, because it is judged AFTER the
   * run returns and a run that never returns is never judged: a hung test did
   * not fail the suite, it removed the suite.
   */
  runtimeBudgetMs?: number;
  /**
   * THE FILE-LEVEL WATCHDOG (`testExecution.engineSuiteWatchdog`). The
   * per-test timeout above fails a test that never settles, but it cannot end
   * a FILE: a cancelled test whose handles stay open (a server it never
   * closed, a pending promise holding it) keeps its file's process alive, and
   * the runner waits for that process to exit. Measured: one file held a run
   * for two hours after both of its tests had been cancelled. A phase that
   * reports no test event for `stallTimeoutMs`, or a run still going at
   * `hardCeilingMs`, is ABORTED: node kills every file process still running
   * (a hung one and a spinning one alike — the clock is this worker's, never
   * the watched file's) and reports each as a failed, aborted file, so a
   * killed run is a failed run.
   */
  engineSuiteWatchdog?: SuiteWatchdog;
  /**
   * THE CELL A CI SHARD RUNS (the gate catalogue's engine cells,
   * `src/workflow/gates/`): only these inventoried sources are dispatched;
   * every other inventoried source is WITHHELD — still expected, counted
   * skipped, never subtracted (the accounting's own gatedSourceIds rule) — so
   * the receipt says exactly what this run did not run, and the gates' seal
   * proves the cells cover the inventory exactly once. A source the
   * inventory does not hold is a typed refusal. Absent: the whole inventory.
   */
  cellSourceIds?: ReadonlySet<string>;
  /**
   * Hash-only snapshot captured by `loadTestInventoryWithSnapshot`. When
   * present, the pre/post-run source assertions re-read and re-hash the
   * canonical sources but skip the redundant Babel re-parse (byte-identical
   * sources yield identical discovered test names). When absent, the
   * assertions perform the full rebuild-and-parse validation.
   */
  sourceSnapshot?: TestInventorySourceSnapshot;
}>;

export type InventoryTestAccountantOptions = Readonly<{
  expectedSummaryCount?: number;
  /**
   * Test source IDs (relative paths) withheld from dispatch. The one caller
   * is a CI cell (`cellSourceIds`): the entries stay in the expected set and
   * are counted as skipped, which the whole-suite passing gate rejects; only
   * the CELL's rule (`cellReceiptPassing`, test-receipt.ts) accepts them, and
   * only when they are exactly the withheld ones. A parameter that is merely
   * deleted leaves nothing to fail when the behaviour comes back.
   */
  gatedSourceIds?: ReadonlySet<string>;
}>;

// RUN_SLOW is gone, and `isRunSlowEnabled` with it. It once decided which
// tests ran; then, briefly, only how fast they ran. Both are settled now —
// every file is dispatched, on the schedule tuned for every file — so the
// variable selected nothing, and an environment variable that selects nothing
// is a switch a reader will believe in. The run summary stopped recording it
// for the same reason: a field naming a mode that does not exist is worse
// than an absent one, because it invites a comparison between two runs that
// were never different.

export type InventoryTestAccountant = Readonly<{
  observe: (event: TestEvent) => void;
  complete: () => InventoryTestAccounting;
}>;

/**
 * One dispatch of the node test runner.
 *
 * ── `timeoutMs` IS REQUIRED, AND THAT REQUIREMENT IS THE FIX ─────────────
 *
 * Both `run()` calls in this module used to pass no `timeout`, so every test
 * child ran with node's default of "never". A hung test therefore did not
 * fail the suite; it REMOVED the suite, silently, for as long as anyone was
 * willing to wait.
 *
 * The budget could have been added at each call site, and that is exactly the
 * shape that goes stale: two sites, one edited. So there is one dispatch
 * function, it is the only caller of `run`, and its options make the budget a
 * REQUIRED field — a third phase added tomorrow cannot omit it, because
 * omitting it does not compile.
 */
type TestPhaseDispatch = Readonly<{
  files: readonly string[];
  concurrency: boolean | number;
  isolation?: "process";
  coverage: boolean;
  timeoutMs: number;
  /** REQUIRED like the timeout: the stall bound and the RUN's ceiling instant (see `engineSuiteWatchdog`). */
  watchdog: Readonly<{ stallTimeoutMs: number; ceilingAt: number }>;
}>;

/** Set once a SIGTERM told this run to stop: every later phase is ended before it dispatches a file. */
let terminated = false;

async function* runTestPhase(cwd: string, phase: TestPhaseDispatch): AsyncGenerator<unknown> {
  const controller = new AbortController();
  let ended: "stalled" | "ceiling" | "terminated" | undefined;
  const end = (why: "stalled" | "ceiling" | "terminated"): void => {
    if (ended !== undefined) return;
    ended = why;
    process.stderr.write(why === "stalled"
      ? `[run-tests] STALLED: no test event for ${String(phase.watchdog.stallTimeoutMs)}ms; the phase's running files are killed and reported as aborted failures.\n`
      : why === "ceiling"
        ? "[run-tests] HARD CEILING: the run was still going at its ceiling; the phase's running files are killed and reported as aborted failures.\n"
        : "[run-tests] TERMINATED: the run was told to stop (SIGTERM: its launcher exited or it was interrupted); the phase's running files are killed.\n");
    controller.abort(new Error(`engine test run ${why}`));
  };
  // A SIGTERM (the runner stopping a run whose launcher exited, or a person)
  // ends the phase through the same abort as the watchdogs, so node:test
  // kills the files it is running instead of leaving them orphaned.
  const terminate = (): void => {
    terminated = true;
    end("terminated");
  };
  process.once("SIGTERM", terminate);
  if (terminated) end("terminated");
  const stall = setTimeout(() => end("stalled"), phase.watchdog.stallTimeoutMs);
  const ceiling = setTimeout(() => end("ceiling"), Math.max(0, phase.watchdog.ceilingAt - Date.now()));
  try {
    for await (const event of run({
      cwd,
      files: phase.files,
      // Every test file's process connects only to this machine (network-under-test.ts).
      execArgv: [networkGuardImport()],
      concurrency: phase.concurrency,
      ...(phase.isolation !== undefined ? { isolation: phase.isolation } : {}),
      coverage: phase.coverage,
      timeout: phase.timeoutMs,
      signal: controller.signal,
    })) {
      stall.refresh();
      yield event;
    }
  } finally {
    clearTimeout(stall);
    clearTimeout(ceiling);
    process.removeListener("SIGTERM", terminate);
  }
}

export async function executeInventoryTestRun(
  root: string,
  inventory: TestInventory,
  options: InventoryTestRunOptions = {},
): Promise<InventoryTestAccounting> {
  const assertSnapshot = (): void => {
    assertTestInventorySourceSnapshot(root, inventory, options.sourceSnapshot);
  };
  assertSnapshot();
  const concurrency = options.concurrency ?? false;
  const inventorySources = new Set(inventory.tests.map((entry) => entry.sourceId));
  const cell = options.cellSourceIds;
  if (cell !== undefined) {
    const strangers = [...cell].filter((sourceId) => !inventorySources.has(sourceId));
    if (cell.size === 0 || strangers.length > 0) {
      throw new InputError(`the engine cell names ${cell.size === 0 ? "no source" : `sources the test inventory does not hold: ${strangers.join(", ")}`}`, "test_cell_invalid");
    }
  }
  // The withheld sources of a cell: expected and counted skipped by the accountant, never dispatched.
  const withheld = cell === undefined ? undefined : new Set([...inventorySources].filter((sourceId) => !cell.has(sourceId)));
  const allFiles = cell === undefined
    ? testFilesFromInventory(root, inventory)
    : testFilesFromInventory(root, inventory).filter((file) => cell.has(relative(root, file).split(sep).join("/")));
  const coverage = options.coverage ?? false;
  // The default lives here rather than at the callers, because two of the
  // three callers (`scripts/coverage.ts`, `scripts/planned-node-test-evidence.ts`)
  // pass no options at all and would otherwise still run without a budget.
  const timeoutMs = options.runtimeBudgetMs ?? DEFAULT_TEST_RUNTIME_BUDGET_MS;
  const suiteWatchdog = options.engineSuiteWatchdog ?? DEFAULT_ENGINE_SUITE_WATCHDOG;
  const watchdog = { stallTimeoutMs: suiteWatchdog.stallTimeoutMs, ceilingAt: Date.now() + suiteWatchdog.hardCeilingMs };
  const reporter = options.reporter;
  const reporterCompletion = reporter ? finished(reporter) : undefined;

  // EVERY INVENTORIED FILE IS DISPATCHED. There used to be a slow-file gate
  // here: a file whose PREVIOUSLY MEASURED wall-clock exceeded a threshold was
  // dropped from the run unless RUN_SLOW=1 was set. It is gone, and the reason
  // is not performance.
  //
  // The gate did not mark those tests skipped — it removed them from the
  // DENOMINATOR the accounting compares against, so `skipped === 0` (this
  // repository's strongest passing condition) stayed satisfied by a set that
  // had silently shrunk. Measured on this tree: 696 of 8,555 entries across 32
  // files walked out that way, and the receipt still read "passed". Four of the
  // tests inside those files fail DETERMINISTICALLY — two on a stale pinned
  // source digest, and they had been invisible since the commit that broke
  // them.
  //
  // Its input made it worse. The durations come from a GITIGNORED cache, so the
  // gated set is a property of what this machine happened to run last: a fresh
  // checkout gates nothing and runs everything, a warm one gates whatever it
  // last measured as slow, and both print the same word. The set even moved
  // between two runs here (32 files, then 17) with no code change.
  //
  // Removing the filter is what makes the class impossible rather than
  // detected: there is no longer any code path that can subtract from the
  // expected set, so no future threshold, cache or mode can shrink it. The
  // measured durations are still loaded — `sortTestFilesLongestFirst` and the
  // serial-tier split use them for SCHEDULING, which cannot change which tests
  // run, only the order they run in.
  const priorDurations = loadPriorTestFileDurations(root);
  const files = allFiles;

  if (concurrency === "auto") {
    // ONE FILE SET, ONE SCHEDULE. The concurrencies below used to branch on
    // RUN_SLOW, because the two modes dispatched different files and each had
    // been tuned for its own. They dispatch the same files now, and running
    // the full set on the schedule tuned for a subset is measurably unstable:
    // three consecutive runs of the whole suite under the default numbers
    // failed on a DIFFERENT test each time — a preflight path check, then two
    // CLI disposition tests and a concurrent-appender chain — while the
    // full-suite numbers produced byte-identical result hashes across runs.
    // Contention flakiness, not regressions, and the fix is to stop asking a
    // subset's schedule to carry the whole suite.
    const parallelConcurrency =
      options.fullSuiteParallelConcurrency ?? options.parallelConcurrency ?? DEFAULT_FULL_SUITE_PARALLEL_CONCURRENCY;
    // Two-tier serial concurrency: in-process serial files (no subprocess
    // spawning — S1 scenarios with verifyS1Structure/makeRuntimeCandidate,
    // harness-commands architecture scans) run at a HIGHER concurrency since
    // they are CPU-bound and do not oversubscribe with subprocesses.
    // Subprocess-spawning serial files (foundation-cascade, repository-path,
    // handoff-continuity, b13 — import node:child_process or use the evidence
    // pipeline) run at a LOWER concurrency to avoid subprocess oversubscription
    // (12-way × N subprocesses on 12 CPUs). The in-process tier uses
    // fullSuiteInProcessSerialPhaseConcurrency and the subprocess tier uses
    // fullSuiteSerialPhaseConcurrency — the numbers tuned against the whole
    // file set, which is the only file set there is. The
    // classification is DYNAMIC (classifySerialConcurrencyTier scans each file
    // for subprocess-spawning markers, not a hardcoded list) so a file that
    // gains subprocess usage is automatically reclassified.
    const inProcessSerialConcurrency =
      options.fullSuiteInProcessSerialPhaseConcurrency ?? options.fullSuiteSerialPhaseConcurrency ?? options.serialPhaseConcurrency ?? 1;
    const subprocessSerialConcurrency =
      options.fullSuiteSerialPhaseConcurrency ?? options.serialPhaseConcurrency ?? 1;
    const maxSerialConcurrency = Math.max(inProcessSerialConcurrency, subprocessSerialConcurrency);
    const serialIsolation: "process" | undefined = maxSerialConcurrency <= 1 ? undefined : "process";
    const classification = classifyTestConcurrency(files, root);
    // Schedule the parallel phase longest-first (LPT) using per-file
    // durations persisted by the previous run, so slow files start
    // immediately instead of straggling at the end of an exhausted lane
    // pool. Files without a recorded duration keep deterministic path order.
    // priorDurations is loaded once at the top of this function.
    const phases: { files: readonly string[]; concurrency: boolean | number; isolation?: "process" }[] = [];
    if (classification.parallel.length > 0) {
      phases.push({
        files: sortTestFilesLongestFirst(classification.parallel, priorDurations).map((file) => resolve(root, file)),
        concurrency: parallelConcurrency,
        isolation: "process",
      });
    }
    if (classification.serial.length > 0) {
      // Two-tier serial model: the shared buildSerialPhases owner splits the
      // serial files into in-process (higher concurrency) and subprocess-
      // spawning (lower concurrency) tiers, both longest-first. The tiers
      // run sequentially within the serial phase to avoid cross-tier CPU
      // contention.
      const serialPhases = buildSerialPhases(classification.serial, root, priorDurations, {
        inProcessConcurrency: inProcessSerialConcurrency,
        subprocessConcurrency: subprocessSerialConcurrency,
        isolation: serialIsolation,
      });
      for (const phase of serialPhases) {
        phases.push({
          files: phase.files,
          concurrency: phase.concurrency,
          ...(phase.isolation !== undefined ? { isolation: phase.isolation } : {}),
        });
      }
    }
    if (phases.length === 0) {
      const accountant = createInventoryTestAccountant(root, inventory, {
        expectedSummaryCount: 0,
        ...(withheld === undefined ? {} : { gatedSourceIds: withheld }),
      });
      reporter?.end();
      if (reporterCompletion) await reporterCompletion;
      assertSnapshot();
      return accountant.complete();
    }
    const accountant = createInventoryTestAccountant(root, inventory, {
      expectedSummaryCount: phases.length,
      ...(withheld === undefined ? {} : { gatedSourceIds: withheld }),
    });
    const drain = async (phase: { files: readonly string[]; concurrency: boolean | number; isolation?: "process" }): Promise<void> => {
      const stream = runTestPhase(root, { ...phase, coverage, timeoutMs, watchdog });
      for await (const value of stream) {
        const event = normalizeTestEvent(value);
        accountant.observe(event);
        if (reporter && !reporter.write(event)) await once(reporter, "drain");
      }
    };
    // The phases array is [parallel?, serialT1?, serialT2?]. The parallel
    // phase runs FIRST (alone) to avoid cross-phase resource contention with
    // the serial phase: overlapping them was measured to cause parallel
    // tests (matrix-executor, results-writer, scanner) to race with the
    // serial phase's subprocess-spawning tests on shared resources
    // (timeline.db, temp dirs), producing 37 flaky failures at parallel=4.
    // The serial tiers run CONCURRENTLY after the parallel phase completes:
    // the in-process tier (CPU-bound Babel parsing) and the subprocess tier
    // (I/O-bound, waiting for child processes) use complementary resources,
    // so overlapping them gives wall time = max(T1, T2) instead of T1 + T2.
    // Sequential tiers were measured WORSE (237s): the in-process tier's 5.7×
    // memory-contention slowdown is from its own Babel processes, so
    // serializing adds T2's time on top. The in-process tier concurrency is
    // kept LOW (4) to reduce memory-bandwidth thrashing.
    const hasParallel = classification.parallel.length > 0;
    const parallelPhase = hasParallel ? [phases[0]!] : [];
    const serialTiers = hasParallel ? phases.slice(1) : phases;
    try {
      for (const phase of parallelPhase) {
        await drain(phase);
      }
      if (serialTiers.length === 1) {
        await drain(serialTiers[0]!);
      } else if (serialTiers.length > 1) {
        await Promise.all(serialTiers.map((phase) => drain(phase)));
      }
    } finally {
      reporter?.end();
    }
    if (reporterCompletion) await reporterCompletion;
    assertSnapshot();
    return accountant.complete();
  }

  const streamConcurrency: boolean | number = concurrency;
  const accountant = createInventoryTestAccountant(root, inventory, withheld === undefined ? {} : { gatedSourceIds: withheld });
  const stream = runTestPhase(root, { files, concurrency: streamConcurrency, coverage, timeoutMs, watchdog });
  try {
    for await (const value of stream) {
      const event = normalizeTestEvent(value);
      accountant.observe(event);
      if (reporter && !reporter.write(event)) await once(reporter, "drain");
    }
  } finally {
    reporter?.end();
  }
  if (reporterCompletion) await reporterCompletion;
  assertSnapshot();
  return accountant.complete();
}

export function createInventoryTestAccountant(
  root: string,
  inventory: TestInventory,
  options: InventoryTestAccountantOptions = {},
): InventoryTestAccountant {
  const expectedSummaryCount = options.expectedSummaryCount ?? 1;
  const gatedSourceIds = options.gatedSourceIds ?? new Set<string>();
  // A GATED TEST IS A SKIPPED TEST, NEVER A SUBTRACTED ONE.
  //
  // This used to filter the inventory down to the non-gated subset, which made
  // every downstream comparison — expected, discovered, passed, and the summary
  // match — run against a denominator that had silently shrunk. `skipped === 0`
  // in the passing condition below could not see it, because nothing was ever
  // skipped: the entries were simply not there to be counted. That is how 696
  // undispatched tests, four of them deterministically failing, produced a
  // receipt reading "passed".
  //
  // The expected set is now the WHOLE inventory, unconditionally. A gated
  // entry stays expected, is reported `skipped`, and therefore trips the
  // existing gate on its own with no new mechanism. Nothing gates today (the
  // dispatch-side filter is deleted); this keeps the accounting honest if a
  // future caller reintroduces one, so the reintroduction is loud instead of
  // free.
  const inventoryByKey = new Map(inventory.tests.map((entry) => [`${entry.sourceId}\0${entry.name}`, entry.id]));
  // Secondary index: maps (sourceId, flatName) → inventoryId. Node's test
  // runner emits events with flat test names (no describe prefix), but the
  // inventory stores nested names ("describe > test"). When the primary
  // lookup (exact name) fails, the secondary index resolves the flat event
  // name to the inventory ID by matching the last segment after " > ".
  const inventoryByFlatName = new Map<string, Map<string, string>>();
  for (const entry of inventory.tests) {
    const flatName = entry.name.includes(" > ") ? entry.name.split(" > ").pop()! : entry.name;
    let byFlat = inventoryByFlatName.get(entry.sourceId);
    if (byFlat === undefined) { byFlat = new Map(); inventoryByFlatName.set(entry.sourceId, byFlat); }
    byFlat.set(flatName, entry.id);
  }
  const inventorySourceIds = new Set(inventory.tests.map((entry) => entry.sourceId));
  const expectedIds = inventory.tests.map((entry) => entry.id);
  // The gated entries, in expected order. They are dispatched by nobody, so no
  // event will ever arrive for them; `complete()` counts them as skipped and
  // as discovered, which keeps `discovered === passed + failed + skipped +
  // todo + cancelled` true while making the gate below fire.
  const gatedIds = gatedSourceIds.size === 0
    ? ([] as readonly string[])
    : inventory.tests.filter((entry) => gatedSourceIds.has(entry.sourceId)).map((entry) => entry.id);
  const discoveredIds: string[] = [];
  const passedIds: string[] = [];
  const failures: string[] = [];
  const failureDetails: TestFailureDetail[] = [];
  const skips: TestSkip[] = [];
  const unknownTests: string[] = [];
  // Pending unknown lifecycle events that are NOT file wrappers but might be
  // describe/suite wrappers. Each entry records the event label, the source
  // ID, and the nesting level. In complete(), a pending entry is re-classified
  // as a describe/suite wrapper (and removed) if the same file has test events
  // at a higher nesting level (the describe contains child tests). Otherwise
  // it is a genuinely unknown test (added to the file without updating the
  // inventory) and is kept in unknownTests.
  const pendingDescribeWrappers: { label: string; sourceId: string; nesting: number }[] = [];
  const maxNestingBySourceId = new Map<string, number>();
  // Source files that produced at least one INVENTORY-RESOLVED event. A
  // file-wrapper `test:fail` for a source with none of these is a module
  // that crashed AT LOAD: its tests never enqueued, so nothing below would
  // ever name it — the count gates red on the shrink while the failure list
  // stays empty, and a nameless red sends the reader to the wrong place.
  const resolvedSourceIds = new Set<string>();
  // Source IDs whose file failed AT MODULE LOAD (no resolved child events).
  // Tracked so complete() can report the load-crash count for the receipt's
  // terminal-count reconciliation (see InventoryTestAccounting.loadCrashCount).
  const loadCrashSourceIds = new Set<string>();
  // The files the suite watchdog killed (see abortedFileCount), each with the
  // abort node reported for it.
  const abortedSourceIds = new Map<string, unknown>();
  const lifecycle = new Map<string, { enqueued: boolean; terminal: boolean }>();
  let failed = 0;
  let skipped = 0;
  let todo = 0;
  let cancelledEvents = 0;
  let summaryEvents = 0;
  let summaryCancelled = 0;
  let allSummariesSuccessful = true;
  let allSummariesHaveCounts = true;
  const fileDurationsMs = new Map<string, number>();
  const aggregateSummaryCounts = { tests: 0, failed: 0, passed: 0, cancelled: 0, skipped: 0, todo: 0 };

  const observe = (event: TestEvent): void => {
    const data = event.data;
    const inventoryId = inventoryIdForEvent(data, root, inventoryByKey, inventoryByFlatName);
    const isTestLifecycleEvent = ["test:enqueue", "test:pass", "test:fail", "test:cancel"].includes(event.type);
    if (inventoryId && data?.file) {
      const resolvedSourceId = sourceIdForFile(root, data.file);
      if (resolvedSourceId !== undefined) resolvedSourceIds.add(resolvedSourceId);
    }
    const allSummariesSeen = summaryEvents >= expectedSummaryCount;
    if (allSummariesSeen && isTestLifecycleEvent) unknownTests.push(`${event.type}:after-global-summary`);
    // Track the maximum nesting per source file so complete() can
    // distinguish describe/suite wrappers from genuinely unknown tests.
    if (isTestLifecycleEvent && data?.file) {
      const sourceId = sourceIdForFile(root, data.file);
      if (sourceId !== undefined) {
        const nesting = typeof data.nesting === "number" && Number.isFinite(data.nesting) ? data.nesting : 0;
        const prev = maxNestingBySourceId.get(sourceId);
        if (prev === undefined || nesting > prev) maxNestingBySourceId.set(sourceId, nesting);
      }
    }
    if (isTestLifecycleEvent && !inventoryId && data?.name && !isFileWrapper(data, root, inventorySourceIds)) {
      const sourceId = data.file ? sourceIdForFile(root, data.file) : undefined;
      const nesting = typeof data.nesting === "number" && Number.isFinite(data.nesting) ? data.nesting : 0;
      if (sourceId !== undefined) {
        pendingDescribeWrappers.push({ label: `${event.type}:${data.name}`, sourceId, nesting });
      } else {
        unknownTests.push(`${event.type}:${data.name}`);
      }
    } else if (isTestLifecycleEvent && (!data?.file || !data.name)) {
      unknownTests.push(`${event.type}:malformed-event`);
    }
    if (event.type === "test:summary" && data?.file !== undefined) {
      const summarySourceId = sourceIdForFile(root, data.file);
      if (summarySourceId === undefined || !inventorySourceIds.has(summarySourceId)) {
        unknownTests.push(`test:summary:unknown-file:${data.file}`);
      } else {
        // Capture the file's wall-clock duration so the runner can persist
        // it for next-run longest-first lane scheduling. The per-file
        // test:summary event carries the duration at data.duration_ms (top
        // level), not data.details.duration_ms (which is per-test). Reading
        // the wrong field left file-durations.json empty, disabling LPT
        // scheduling entirely.
        const durationMs = typeof data.duration_ms === "number" && Number.isFinite(data.duration_ms) && data.duration_ms >= 0
          ? data.duration_ms
          : data.details?.duration_ms;
        if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
          fileDurationsMs.set(summarySourceId, durationMs);
        }
      }
    }
    if (event.type === "test:enqueue" && inventoryId) {
      const state = lifecycle.get(inventoryId);
      if (state !== undefined) unknownTests.push(`test:enqueue:duplicate:${inventoryId}`);
      else lifecycle.set(inventoryId, { enqueued: true, terminal: false });
      discoveredIds.push(inventoryId);
    }
    if (event.type === "test:pass") {
      if (inventoryId) {
        observeTerminal(inventoryId, event.type, lifecycle, unknownTests);
        if (data?.skip !== undefined) {
          skipped += 1;
          const fileId = data.file ? sourceIdForFile(root, data.file) : undefined;
          skips.push({ identity: `${fileId ?? inventoryId}::${data.name}`, reason: typeof data.skip === "string" ? data.skip : "" });
        } else if (data?.todo !== undefined) todo += 1;
        else passedIds.push(inventoryId);
      }
    }
    if (event.type === "test:fail") {
      if (inventoryId) {
        observeTerminal(inventoryId, event.type, lifecycle, unknownTests);
        if (isCancelledTestFailure(data?.details?.error)) cancelledEvents += 1;
        else failed += 1;
        // The row names the FILE as well as the test: two files may share a
        // test name, and the flaky-memory guard compares identities across
        // runs — a bare name collides, and a collision is a wrong suspect.
        // The file is the path-shaped source id (never the inventory's key,
        // which is free to be a content hash), with the inventory id as the
        // fallback so the row is never nameless.
        if (data?.name) {
          const fileId = data.file ? sourceIdForFile(root, data.file) : undefined;
          const identity = `${fileId ?? inventoryId}::${data.name}`;
          failures.push(identity);
          failureDetails.push({ identity, file: fileId ?? null, line: data.line ?? null, column: data.column ?? null,
            error: extractTestResultError(data.details?.error) });
        }
      } else if (data?.file && data.name && isFileWrapper(data, root, inventorySourceIds)) {
        // A FILE-WRAPPER FAIL WITH NO RESOLVED EVENTS IS A MODULE-LOAD
        // CRASH, AND THE FILE PATH IS ITS NAME. node reports a file that
        // threw during import as one failed test whose name IS the file;
        // `isFileWrapper` exists to keep that synthetic test out of the
        // per-test accounting, but keeping it out of `failures` too made
        // the crash NAMELESS — a whole file's tests vanished, the count
        // gate redded on the shrink, and nothing said which file. The
        // no-resolved-events condition keeps the ordinary case out: a
        // wrapper that fails because a CHILD failed arrives after that
        // child's own resolved fail event has already been named.
        const wrapperSourceId = sourceIdForFile(root, data.file);
        const failureType = (data.details?.error as { failureType?: unknown } | undefined)?.failureType;
        if (wrapperSourceId !== undefined && failureType === "testAborted") {
          // THE WATCHDOG KILLED THIS FILE: its process never finished. Named
          // whether or not its own tests had reported — the file-level abort
          // is one more terminal node counts, and the reason the run failed.
          abortedSourceIds.set(wrapperSourceId, data.details?.error);
          const identity = `${wrapperSourceId} (killed by the suite watchdog — the file never finished)`;
          failures.push(identity);
          failureDetails.push({ identity, file: wrapperSourceId, line: data.line ?? null, column: data.column ?? null,
            error: extractTestResultError(data.details?.error) });
        } else if (wrapperSourceId !== undefined && !resolvedSourceIds.has(wrapperSourceId)) {
          failed += 1;
          loadCrashSourceIds.add(wrapperSourceId);
          const identity = `${wrapperSourceId} (the whole file failed at module load — its tests never ran)`;
          failures.push(identity);
          failureDetails.push({ identity, file: wrapperSourceId, line: data.line ?? null, column: data.column ?? null,
            error: extractTestResultError(data.details?.error) });
        }
      }
    }
    if (event.type === "test:cancel") {
      if (inventoryId) {
        observeTerminal(inventoryId, event.type, lifecycle, unknownTests);
        cancelledEvents += 1;
        const fileId = data?.file ? sourceIdForFile(root, data.file) : undefined;
        const identity = `${fileId ?? inventoryId}::${data?.name}`;
        failures.push(identity);
        failureDetails.push({ identity, file: fileId ?? null, line: data?.line ?? null, column: data?.column ?? null,
          error: extractTestResultError(data?.details?.error) });
      }
    }
    if (event.type === "test:summary" && data?.file === undefined) {
      summaryEvents += 1;
      if (summaryEvents > expectedSummaryCount) {
        unknownTests.push("test:summary:excess-global-summary");
      }
      if (data?.success !== true) allSummariesSuccessful = false;
      const counts = parseSummaryCounts(data?.counts);
      if (counts === undefined) {
        allSummariesHaveCounts = false;
      } else {
        aggregateSummaryCounts.tests += counts.tests;
        aggregateSummaryCounts.failed += counts.failed;
        aggregateSummaryCounts.passed += counts.passed;
        aggregateSummaryCounts.cancelled += counts.cancelled;
        aggregateSummaryCounts.skipped += counts.skipped;
        aggregateSummaryCounts.todo += counts.todo;
        summaryCancelled += counts.cancelled;
      }
    }
  };

  const complete = (): InventoryTestAccounting => {
    // Re-classify pending unknown lifecycle events: a describe/suite wrapper
    // is an event at nesting N where the same file has test events at nesting
    // > N (the describe contains child tests). Such events are suite wrappers,
    // not genuinely unknown tests, so they are removed from unknownTests. A
    // genuinely unknown test (added without updating the inventory) has NO
    // child events at a higher nesting, so it is kept.
    // Use a separate array so the original unknownTests (which deepFreeze
    // freezes in place on the first complete() call) is never mutated here.
    const reclassifiedUnknown: string[] = [];
    for (const pending of pendingDescribeWrappers) {
      const maxNesting = maxNestingBySourceId.get(pending.sourceId) ?? 0;
      if (maxNesting > pending.nesting) {
        // Describe/suite wrapper — not an unknown test.
        continue;
      }
      reclassifiedUnknown.push(pending.label);
    }
    const allUnknownTests = [...unknownTests, ...reclassifiedUnknown];
    // A gated entry never produced an event, so it is folded in here rather
    // than observed: discovered (it was expected and accounted for) and
    // skipped (its assertions did not execute). Both counts move, so the
    // terminal-count identity holds and `skipped === 0` below refuses the run.
    // A KILLED FILE'S UNFINISHED TESTS WERE CANCELLED BY THE KILL: the one in
    // flight and every one not yet started were discovered (enqueued) and
    // will never report a terminal. They are counted cancelled — each is
    // accounted for once — and the file's own row names the kill.
    // Each is named like any cancelled test (`<file>::<test>`), so a receipt's
    // rows still match its failed + cancelled count.
    const entryById = new Map(inventory.tests.map((entry) => [entry.id, entry]));
    let killedUnfinished = 0;
    for (const [id, state] of lifecycle) {
      const entry = entryById.get(id);
      if (!state.enqueued || state.terminal || entry === undefined || !abortedSourceIds.has(entry.sourceId)) continue;
      killedUnfinished += 1;
      const identity = `${entry.sourceId}::${entry.name.split(" > ").pop() ?? entry.name}`;
      failures.push(identity);
      failureDetails.push({ identity, file: entry.sourceId, line: null, column: null, error: extractTestResultError(abortedSourceIds.get(entry.sourceId)) });
    }
    const counts: TestCounts = {
      discovered: discoveredIds.length + gatedIds.length,
      passed: passedIds.length,
      failed,
      skipped: skipped + gatedIds.length,
      todo,
      cancelled: Math.max(cancelledEvents, summaryCancelled) + killedUnfinished,
    };
    const orderedDiscovered = uniqueObservedIds(expectedIds, [...discoveredIds, ...gatedIds]);
    const orderedPassed = uniqueObservedIds(expectedIds, passedIds);
    const allSummariesArrived = summaryEvents === expectedSummaryCount;
    const summaryCountsValue = allSummariesArrived && allSummariesHaveCounts
      ? aggregateSummaryCounts
      : undefined;
    const expectedCount = inventory.tests.length;
    // The runner's own summary can only speak for the tests it was handed, so
    // it is compared against the DISPATCHED count. The runner COUNTS a file
    // that crashed at module load as one (failed) test — it ran the file and
    // produced a verdict — while the inventory's per-test list for that file
    // never dispatched. The denominator therefore adds the crash count, so
    // the summary's `tests` matches instead of reding `runner-summary-counts-
    // mismatch` on top of the real failure. Everything else below is compared
    // against the full inventory, keeping a shrunken dispatch set visible.
    const loadCrashCount = loadCrashSourceIds.size;
    const abortedFileCount = abortedSourceIds.size;
    const dispatchedCount = expectedCount - gatedIds.length -
      (expectedCount - discoveredIds.length - loadCrashCount - abortedFileCount - gatedIds.length);
    const summaryMatches = summaryCountsValue !== undefined &&
      summaryCountsValue.tests === dispatchedCount &&
      summaryCountsValue.failed === failed && summaryCountsValue.passed === passedIds.length &&
      summaryCountsValue.cancelled === counts.cancelled && summaryCountsValue.skipped === skipped &&
      summaryCountsValue.todo === todo;
    const summarySuccessful = allSummariesArrived && allSummariesSuccessful && allSummariesHaveCounts;
    const normalizedRunnerSummary: TestRunnerSummary = {
      eventCount: allSummariesArrived ? 1 : summaryEvents,
      successful: summarySuccessful,
      counts: summarySuccessful
        ? summaryCountsValue ?? null
        : (allSummariesArrived && allSummariesHaveCounts ? summaryCountsValue! : null),
    };
    const passed = normalizedRunnerSummary.successful && failed === 0 && skipped === 0 && todo === 0 &&
      summaryMatches && counts.cancelled === 0 && allUnknownTests.length === 0 &&
      orderedDiscovered.length === expectedCount &&
      orderedPassed.length === expectedCount && counts.discovered === expectedCount &&
      counts.passed === expectedCount;
    const reasons = deriveTestRunReasons({
      expectedCount,
      runnerSummary: normalizedRunnerSummary,
      discoveredCount: counts.discovered,
      passedCount: counts.passed,
      counts,
      withheldCount: gatedIds.length,
      unknownTestsCount: allUnknownTests.length,
      candidateIdentityComparison: "not-evaluated",
    });
    const gatedTestIds = [...gatedIds];
    return deepFreeze({
      expectedIds,
      discoveredIds: orderedDiscovered,
      passedIds: orderedPassed,
      counts,
      loadCrashCount,
      abortedFileCount,
      runnerSummary: normalizedRunnerSummary,
      reasons,
      failures: [...failures],
      failureDetails: [...failureDetails],
      skips: [...skips],
      unknownTests: allUnknownTests,
      gatedTestIds,
      fileDurations: [...fileDurationsMs.entries()]
        .map(([file, durationMs]) => ({ file, durationMs }))
        .toSorted((left, right) => left.file < right.file ? -1 : left.file > right.file ? 1 : 0),
      runnerSummaryObserved: summaryEvents === 1,
      runnerSuccessful: normalizedRunnerSummary.successful,
      passed,
    });
  };

  return Object.freeze({ observe, complete });
}

function parseSummaryCounts(counts: TestSummaryCounts | undefined): Readonly<{
    tests: number;
    failed: number;
    passed: number;
    cancelled: number;
    skipped: number;
    todo: number;
  }> | undefined {
  if (counts === undefined) return undefined;
  const fields = ["tests", "failed", "passed", "cancelled", "skipped", "todo"] as const;
  const values: Partial<Record<typeof fields[number], number>> = {};
  for (const field of fields) {
    const value = counts[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
    values[field] = value;
  }
  return values as Readonly<{
    tests: number;
    failed: number;
    passed: number;
    cancelled: number;
    skipped: number;
    todo: number;
  }>;
}

function observeTerminal(
  inventoryId: string,
  eventType: string,
  lifecycle: Map<string, { enqueued: boolean; terminal: boolean }>,
  violations: string[],
): void {
  const state = lifecycle.get(inventoryId);
  if (state === undefined || !state.enqueued) {
    violations.push(`${eventType}:before-enqueue:${inventoryId}`);
    lifecycle.set(inventoryId, { enqueued: false, terminal: true });
    return;
  }
  if (state.terminal) violations.push(`${eventType}:duplicate-terminal:${inventoryId}`);
  state.terminal = true;
}

function normalizeTestEvent(value: unknown): TestEvent {
  if (typeof value !== "object" || value === null || !("type" in value) ||
    typeof value.type !== "string") throw new Error("test runner emitted an invalid event");
  const data = "data" in value && typeof value.data === "object" && value.data !== null
    ? value.data as TestEvent["data"]
    : undefined;
  return Object.freeze({ type: value.type, ...(data === undefined ? {} : { data }) });
}

function inventoryIdForEvent(
  data: TestEvent["data"],
  root: string,
  inventoryByKey: ReadonlyMap<string, string>,
  inventoryByFlatName: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string | undefined {
  if (!data?.file || !data.name) return undefined;
  const sourceId = sourceIdForFile(root, data.file);
  if (sourceId === undefined) return undefined;
  const exact = inventoryByKey.get(`${sourceId}\0${data.name}`);
  if (exact !== undefined) return exact;
  // Node's test runner emits flat test names (no describe prefix). The
  // inventory stores nested names ("describe > test"). Fall back to the
  // flat-name index to resolve the event to its inventory ID.
  const byFlat = inventoryByFlatName.get(sourceId);
  if (byFlat !== undefined) {
    const flat = byFlat.get(data.name);
    if (flat !== undefined) return flat;
  }
  return undefined;
}

function isFileWrapper(
  data: NonNullable<TestEvent["data"]>,
  root: string,
  inventorySourceIds: ReadonlySet<string>,
): boolean {
  if (!data.file || !data.name) return false;
  const sourceId = sourceIdForFile(root, data.file);
  if (sourceId === undefined || !inventorySourceIds.has(sourceId)) return false;
  return data.name === data.file || data.name === sourceId;
}

/** A test file's source id: its path relative to `root` (undefined outside it) — the file half of every engine failure identity. */
export function sourceIdForFile(root: string, file: string): string | undefined {
  const sourceId = isAbsolute(file)
    ? relative(resolve(root), resolve(file)).replaceAll("\\", "/")
    : file.replaceAll("\\", "/");
  if (sourceId === "" || sourceId === ".." || sourceId.startsWith("../") || sourceId.startsWith("/")) {
    return undefined;
  }
  return sourceId;
}

function uniqueObservedIds(expectedIds: readonly string[], observedIds: readonly string[]): string[] {
  const frequencies = new Map<string, number>();
  for (const id of observedIds) frequencies.set(id, (frequencies.get(id) ?? 0) + 1);
  return expectedIds.filter((id) => frequencies.get(id) === 1);
}

