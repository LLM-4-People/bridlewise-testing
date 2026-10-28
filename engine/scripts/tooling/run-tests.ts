import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execPath } from "node:process";

import { enableSharedCompileCache, pruneCompileCacheRoot, scanCompileCache } from "./compile-cache.ts";
import { runRecordedCommand } from "./recorded-command.ts";
import {
  beginRecordedExecution,
  CHECK_EXECUTION_OPERATION,
  completeRecordedExecution,
  configuredExecutionAuthority,
  executionOperationSpec,
  TEST_EXECUTION_OPERATION,
  testExecutionQualification,
  type CompletedExecution,
  type ExecutionAuthority,
  type ExecutionOperation,
} from "./test-execution.ts";
import { computeTestResultReceiptDeterministicHash, testResultFailureStatements, testResultLedgerRows, type TestResultReceipt } from "./test-receipt.ts";
import { enforceTestRunLock } from "./test-run-lock.ts";
import { HarnessError, extractErrorMessage } from "../../src/kernel/errors.ts";
import { bestEffort } from "../../src/shared/best-effort.ts";
import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { ensurePrivateStateDirectory } from "../../src/filesystem/private-state.ts";
import { canonicalJson } from "../../src/kernel/integrity.ts";
import { harnessFolderChanges, harnessFolderIdentity } from "../../src/kernel/config.ts";
import { repositoryRefChanges, repositoryRefIdentity } from "../../src/git/repository-ownership.ts";
import { parseJsonExact } from "../../src/kernel/json-integrity.ts";
import { isPlainObject } from "../../src/shared/type-guards.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { schemaId, statePath } from "../../src/kernel/product-identity.ts";
import { applyDevModeSafeReadEnvVars } from "../../src/shared/dev-mode-env.ts";
import {
  readTestExecutionConfig,
  writeTestRunSummary,
  type TestRunSummaryInput,
} from "../../src/workflow/test-result-collector.ts";
import {
  judgeSuiteCpu,
  type CacheWarmthReading,
  type GateOutcome,
  type SuiteCpuJudgment,
} from "../../src/shared/budget-verdict.ts";
import { computeRunWork, measureCalibration, readRunCpu, type CalibrationReading, type RunCpu } from "../../src/shared/run-cpu.ts";
import { readAmbientLoadPerCpu } from "../../src/shared/ambient-load.ts";
import { finalizeQualifiedRun, qualificationInvocation, qualificationTerminal, runForInvocation, appendJudgedRun, readRepositoryHeadSha, readRunHistory, TEST_RUN_HISTORY_PATH } from "../../src/shared/run-history.ts";
import { measuredTreeMark, provisionalFailureMark, mutationRunMark, readMeasuredTree } from "../../src/shared/tree-identity.ts";
import { VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import { configuredRuntimeAdmission, withAdmittedNodeRuntime } from "../../src/runtime/admitted-node-runtime.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { reportLauncherStop, watchLauncher } from "./launcher-watch.ts";
import { testProcessSupervisorBinary } from "../../guardian/build.ts";
import { sweepEndedRunTemporaries, temporaryRootHeadroom, temporaryRootKeepOutRefusal, temporaryRootPreflightLine } from "../../src/filesystem/temporary-root.ts";

export type WorkerExecutionOptions = Readonly<{
  authority?: ExecutionAuthority;
  workerPath?: string;
  workerArguments?: readonly string[];
  environment?: Readonly<NodeJS.ProcessEnv>;
  setupFailureCode?: string;
  /** Aborting it stops the worker (SIGTERM: the running test files are killed and the run ends). */
  stop?: AbortSignal;
}>;

export function runTestsWithEvidence(options: WorkerExecutionOptions = {}): Promise<CompletedExecution> {
  return runWorkerWithEvidence(TEST_EXECUTION_OPERATION, options);
}

export function runCheckWithEvidence(options: WorkerExecutionOptions = {}): Promise<CompletedExecution> {
  return runWorkerWithEvidence(CHECK_EXECUTION_OPERATION, options);
}

export async function runWorkerWithEvidence(
  operation: ExecutionOperation,
  options: WorkerExecutionOptions = {},
): Promise<CompletedExecution> {
  const admission = configuredRuntimeAdmission();
  return withAdmittedNodeRuntime(admission, async () => {
    const executable = execPath;
    const workerPath = options.workerPath ?? fileURLToPath(new URL("./test-worker.ts", import.meta.url));
    const mode = executionOperationSpec(operation).workerMode;
    const arguments_ = options.workerArguments ?? [workerPath, "--mode", mode];
    const authority = options.authority ?? configuredExecutionAuthority();
    const workingDirectory = authority.receipt.repositoryRoot;
    const context = beginRecordedExecution(authority, operation, [executable, ...arguments_]);
    // THE ONE SUPERVISOR (src/process/supervised-run.ts), as the web suite
    // runs under it: everything the worker starts — its test files and what
    // THEY start, detached ones included — dies with the run. A file the
    // worker's own watchdog aborted used to leave its children orphaned
    // (a fixture's leak.test.ts ran on for 75 minutes, ppid 1). The run's
    // ceiling sits a stall bound above the worker's own watchdog ceiling, so
    // the worker's abort always reports first.
    const { engineSuiteWatchdog } = readTestExecutionConfig(workingDirectory);
    const observation = await runRecordedCommand({
      arguments: arguments_,
      cwd: workingDirectory,
      supervision: { supervisor: testProcessSupervisorBinary(), hardCeilingMs: engineSuiteWatchdog.hardCeilingMs + engineSuiteWatchdog.stallTimeoutMs, killGraceMs: engineSuiteWatchdog.killGraceMs },
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.setupFailureCode === undefined ? {} : { setupFailureCode: options.setupFailureCode }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
    });
    return completeRecordedExecution(context, observation);
  });
}

type TestCommandResult = Readonly<{ operation: "maintenance" | "suite"; exitCode: number }>;


async function runCli(invocationId: string, observedTerminal: (execution: CompletedExecution) => void): Promise<TestCommandResult> {
  const argv = process.argv.slice(2);
  const operation = argv[0] === "--auto-add-dispositions" && argv.length % 2 === 1 &&
    argv.slice(1).every((value, index) => index % 2 === 1 || value === "--prune") ? "maintenance" : "suite";
  let releaseInstrumentLock: (() => void) | undefined;
  const finish = (exitCode: number): TestCommandResult => {
    releaseInstrumentLock?.();
    return { operation, exitCode };
  };
  try {
    enableSharedCompileCache();
    process.stderr.write(`${temporaryRootPreflightLine("run-tests", temporaryRootHeadroom())}\n`);
    const keptOut = temporaryRootKeepOutRefusal(fileURLToPath(new URL("../../", import.meta.url)));
    if (keptOut !== undefined) {
      process.stdout.write(`${canonicalJson({ error: "temporary_root_kept_out", message: keptOut })}\n`);
      return finish(1);
    }
    // Dev-mode safe-read env vars: when `selfProtection.enabled === false` in
    // the config, the dev workspace is hardlink/symlink seeded and the safe
    // repository reader would reject it. Propagate the bypass env vars
    // automatically so `npm test` / `node scripts/run-tests.ts` never needs
    // the operator to set HARNESS_REJECT_HARDLINKS=0 / HARNESS_REJECT_SYMLINKS=0
    // by hand. Existing explicit values are preserved (an operator forcing =1
    // for a security test is never overridden). The test worker subprocess
    // inherits `process.env`, so this covers the in-process AND child runs.
    const root = fileURLToPath(new URL("../../", import.meta.url));
    applyDevModeSafeReadEnvVars(root);
    // Sub-CLI used by `harness regenerate` / `harness sync` (invoked as a
    // subprocess) to auto-add missing disposition entries without pulling
    // builder-layer modules into the runtime import graph. Emits a JSON
    // status payload on stdout.
    if (operation === "maintenance") {
      const root = fileURLToPath(new URL("../../", import.meta.url));
      cleanupFoundationCascadeResidue(root);
      const prune = argv.slice(1).filter((_, index) => index % 2 === 1);
      const { addedPaths, prunedPaths } = await autoAddMissingDispositionEntries(root, prune);
      process.stdout.write(`${canonicalJson({
        status: addedPaths.length > 0 || prunedPaths.length > 0 ? "added" : "current",
        addedCount: addedPaths.length,
        addedPaths,
        prunedCount: prunedPaths.length,
        prunedPaths,
      })}\n`);
      // A PRUNE THAT REPORTS SUCCESS IS THE SAME DEFECT AS ONE THAT IS
      // SILENT. This returned 0 while reporting `prunedCount: 399`, so the
      // only detector of the measured catastrophe was a number in a payload
      // that nothing compared against anything. Removal is now either
      // explicitly requested — in which case the operator asked for it and
      // this exits 0 — or it never gets here, because the refusal above threw.
      return finish(0);
    }
    // HEAVY-RUN ADMISSION, HERE — and not at the top of this function, on
    // purpose: `harness regenerate` shells out to the `--auto-add-dispositions`
    // sub-CLI above, which runs no tests and needs no run of its own. The
    // sub-CLI returns before this line; everything below it is the run. The
    // whole suite is heavy, so it is admitted at once (never waiting for
    // another run) and this process enters the run's caps — its cgroup scope
    // and CPU-time limit — before the worker and every test child start.
    const instrumentLock = enforceTestRunLock("engine npm test", { testFileCount: inventoryTestFileCount(root) ?? Number.POSITIVE_INFINITY });
    releaseInstrumentLock = instrumentLock.release;
    // BEFORE THE RUN, AND AFTER THE SUB-CLI ABOVE: the corpora git cannot
    // report missing. See scripts/verification/required-fixture-roots.ts — an
    // absent one used to be discovered as an 18-minute run that produced no
    // receipt at all.
    //
    // IT SITS HERE RATHER THAN AT THE TOP OF THIS FUNCTION, and the placement
    // is measured rather than tidy. At the top it refused every INVOCATION,
    // and one of them runs no tests at all: `harness regenerate` shells out to
    // `--auto-add-dispositions` above, and it does so on whatever root it was
    // given — including the throwaway fixture trees that
    // `harness-commands.test.ts` builds, which are copies of `src/ scripts/
    // verification/ traceability/ test/` and by design carry no 4 GB corpus.
    // The refusal printed a message about a missing corpus, the caller parsed
    // it as the JSON payload it expects, and the failure surfaced as
    // `parsed.addedPaths is not iterable` — a declaration about the SUITE
    // stopping a manifest edit that reads none of it.
    //
    // The requirement is unchanged and its wording still holds: it is checked
    // at the START OF A RUN. Everything below this line is the run. The
    // acceptance for both halves is real rather than structural — the fixture
    // case is driven by `HarnessCommands: harnessRegenerate write=true
    // auto-adds missing disposition entries for new test files`, and the order
    // itself by `required-fixture-roots: the corpus check gates the RUN and
    // not the manifest sub-CLI`.
    {
      const { checkRequiredFixtureRoots } = await import("../verification/required-fixture-roots.ts");
      const verdict = checkRequiredFixtureRoots(root);
      if (!verdict.ok) {
        process.stdout.write(`${canonicalJson({
          error: "required_fixture_root_absent",
          message: verdict.message,
          missing: verdict.missing.map((entry) => entry.path),
        })}\n`);
        // One result carries the operation and exit code to the entrypoint;
        // this pre-worker refusal remains a suite with absent terminal proof.
        return finish(1);
      }
    }
    // Auto-heal stale test inventory and dispositions before running the suite.
    // This prevents the recurring "test inventory source hash is invalid" /
    // "test-surface disposition coverage is incomplete" failures that happen
    // when agents commit test file changes without running `harness regenerate`.
    // The auto-heal runs as a subprocess (same pattern as the test worker itself)
    // to avoid pulling builder-layer deps into the runner's module graph.
    await autoHealTestInventory();
    // The run's cost is measured HERE, around the worker subprocess, and the
    // budget it feeds is a CPU budget: the CPU delta below is this process's
    // own accounting of self plus REAPED children (`/proc/self/stat`
    // cutime/cstime, calibrated by `process.cpuUsage()` — see
    // `src/shared/run-cpu.ts`), and the worker's entire subtree rolls up
    // into it when the worker is reaped. The worker's own
    // `process.cpuUsage()` could not carry this number: the suite's work
    // happens in the worker's spawned test children, which self-usage does
    // not include — a worker-side reading would bound the orchestrator and
    // report the suite's cost as a rounding error. Wall clock is still
    // measured and RECORDED in the summary; it is judged by nothing (on one
    // unchanged tree it moves +73% under contention while CPU moves +2.6%).
    // The prune/baseline/start-stamp sequence lives in `beginMeasuredRun`,
    // whose ORDER is what a test can hold still — see that function for why
    // each ordering is load-bearing. Calling the steps inline here is
    // exactly the shape that was reorderable with zero reds.
    // The tree this run starts on (after the auto-heal, before the first
    // test and the CPU baseline): the end's read must find it unchanged for
    // the row to carry it as the tree the run measured.
    const treeAtStart = readMeasuredTree(fileURLToPath(new URL("../../", import.meta.url)));
    // NO TEST WRITES THE LIVE HARNESS FOLDER (round 13, R3-1): its identity, as a configuration bootstrap compares it,
    // before the first test and after the last; a change fails the run, named (a concurrent gate would have failed on it).
    const harnessAtStart = harnessFolderIdentity(root);
    // NOR MOVES THE REPOSITORY (round 14): the checkout's HEAD and the branch it names, before and after; a test whose
    // git command fell through to the real checkout (a commit, a reset, a checkout) is named and fails the run.
    const refsAtStart = repositoryRefIdentity(root);
    const { cpuBefore, calibrationBefore, headSha, ambientLoadPerCpu, ambientLoad5PerCpu, ambientLoad15PerCpu, runStartMs } =
      beginMeasuredRun(fileURLToPath(new URL("../../", import.meta.url)));
    // THE RUN NEVER OUTLIVES ITS LAUNCHER. A SIGTERM to the `npm test` wrapper
    // left this runner orphaned: it finished the whole suite and recorded a
    // row while the wrapper had already reported 143, and it held the
    // test-run lock the next runs refused against (step6-readiness-2 F-11).
    // When the launcher exits, the worker is told to stop (its running test
    // files are killed), and the run is reported here as stopped — never
    // judged, never recorded.
    const launcher = new AbortController();
    let launcherExited: number | undefined;
    const stopLauncherWatch = watchLauncher((pid) => {
      launcherExited = pid;
      launcher.abort();
    }, ROOT_POLICY.verification.testRunSupervision.watchIntervalMs);
    const execution = await runTestsWithEvidence({ stop: launcher.signal });
    stopLauncherWatch();
    if (launcherExited !== undefined) {
      reportLauncherStop(launcherExited, Date.now() - runStartMs, (text) => process.stderr.write(text));
      return finish(1);
    }
    // The provisional judgement for this run's ledger rows, derived through
    // the tree-identity owner: did the tree this run measured carry
    // uncommitted TRACKED edits? A dirty-tree run's failures are evidence
    // about the edit being built, not the committed code, so the flaky-test
    // memory must weigh them as provisional. Untracked or gitignored files
    // are not edits, so they do not mark the run; an unreadable answer
    // records nothing (and the row counts as a real failure).
    const provisional = provisionalFailureMark(fileURLToPath(new URL("../../", import.meta.url)));
    // The deliberate-mutation provenance, same owner: a run launched with
    // HARNESS_MUTATION_RUN=1 is the operator's own verification red, and the
    // flaky memory must not read it as the suite's flakiness.
    const mutation = mutationRunMark();
    const wallClockMs = Date.now() - runStartMs;
    const cpuAfter = readRunCpu();
    // AFTER the CPU snapshot: the calibration's own CPU is not the suite's.
    const calibrationAfter = measureCalibration();
    // The tree this run measured (its like-for-like key: a commit of exactly
    // this tree finds the run, wherever it was taken) — only when it is still
    // the tree the run started on; read after the CPU so its git work is not
    // the suite's cost.
    const tree = measuredTreeMark(fileURLToPath(new URL("../../", import.meta.url)), treeAtStart);
    process.stdout.write(execution.stdout);
    process.stderr.write(execution.stderr);
    // Automatically save the test run summary to a deterministic path so the
    // user can compare runs without capturing output manually. The summary
    // includes the deterministicHash which must be identical across two runs
    // of the same suite with the same outcomes.
    observedTerminal(execution);
    let summaryWriteFailed = false;
    let recordedFailures: readonly string[] = [];
    let recordedDigests: Readonly<Record<string, string>> = {};
    let recordedLocations: Readonly<Record<string, string>> = {};
    // A run that produced NO result receipt (a worker that failed its setup
    // ran nothing) measured nothing: it is never judged and never enters the
    // ledger, where its empty failure list read as a green run with every
    // known failure "fixed" (workflow lesson a-run-that-ran-nothing-is-not-green).
    const measured = execution.result !== null && execution.result.schemaVersion === ROOT_POLICY.receipts.testExecution.resultSchemaVersion;
    if (measured) {
      try {
        const root = fileURLToPath(new URL("../../", import.meta.url));
        const receipt = execution.result as TestResultReceipt;
        const summaryInput: TestRunSummaryInput = {
          resultIntegrityHash: receipt.integrityHash,
          deterministicHash: computeTestResultReceiptDeterministicHash(receipt),
          status: receipt.result.status,
          exitCode: execution.exitCode,
          failures: receipt.result.diagnostic === null ? [] : receipt.result.diagnostic.failures,
          failureStatements: testResultFailureStatements(receipt),
          reasons: receipt.result.diagnostic === null ? [] : receipt.result.diagnostic.reasons,
          testCount: receipt.testReceipt.counts.discovered,
          passCount: receipt.testReceipt.counts.passed,
          failCount: receipt.testReceipt.counts.failed,
          wallClockMs,
        };
        ({ failures: recordedFailures, failureDigests: recordedDigests, failureLocations: recordedLocations } = testResultLedgerRows(receipt, root));
        writeTestRunSummary(root, summaryInput);
      } catch (summaryError) {
        summaryWriteFailed = true;
        process.stderr.write(`${canonicalJson({ error: "test_run_summary_write_failed", message: extractErrorMessage(summaryError) })}\n`);
      }
    }
    // JUDGMENT AT END-OF-RUN, IN THE RUNNER. The predecessor was a test
    // INSIDE the suite reading the PREVIOUS run's summary — a one-run lag,
    // with three refusal paths that scored as PASS. Here the run that is
    // judged is the run that just happened, a refusal is PRINTED, and a
    // failed gate is a non-zero exit of this very command.
    if (!measured) {
      process.stdout.write("[suite-budget] NOT JUDGED — the run produced no result receipt (no test executed), so it measured nothing and is not recorded\n");
      return finish(Math.max(execution.exitCode, 1));
    }
    const harnessChanged = [...harnessFolderChanges(harnessAtStart, harnessFolderIdentity(root)), ...repositoryRefChanges(refsAtStart, repositoryRefIdentity(root))];
    if (harnessChanged.length > 0) {
      process.stderr.write(`\n[harness-folder] THE SUITE CHANGED THE LIVE HARNESS FOLDER OR MOVED ITS REPOSITORY (the folder every configuration bootstrap compares; the checkout's HEAD and branch): ${harnessChanged.join(", ")}. A test writes its own temp folder or a harness view (tests/helpers/isolated-config.ts) and runs git only in a repository of its own, never the live tree.\n`);
    }
    const tested = testExecutionQualification(execution);
    const producer = harnessChanged.length === 0 ? tested : { ...tested,
      outcomes: [...tested.outcomes, { gate: "harness-folder", kind: "fail" as const, message: `the suite changed the live harness folder: ${harnessChanged.join(", ")}` }] };
    const gateExitCode = judgeSuiteRunCost({
      root: fileURLToPath(new URL("../../", import.meta.url)),
      runStartMs,
      wallClockMs,
      cpuBefore,
      cpuAfter,
      calibrationBefore,
      calibrationAfter,
      failures: recordedFailures,
      failureDigests: recordedDigests,
      failureLocations: recordedLocations,
      invocationId,
      producer: summaryWriteFailed ? { complete: false, outcomes: [...producer.outcomes,
        { gate: "engine-summary", kind: "fail", message: "current summary publication failed" }] } : producer,
      headSha,
      ambientLoadPerCpu,
      ambientLoad5PerCpu,
      ambientLoad15PerCpu,
      provisional,
      mutation,
      tree,
    });
    return finish(Math.max(execution.exitCode, gateExitCode));
  } catch (error) {
    const code = error instanceof HarnessError ? error.code : "test_runner_failed";
    process.stderr.write(`${canonicalJson({ error: code, message: extractErrorMessage(error) })}\n`);
    return finish(1);
  }
}

/**
 * Prune the compile cache under the DECLARED policy, or print the note that
 * none is declared. Failure to read the config here must not stop the suite
 * (the gate below reads it again and refuses loudly on its own terms) — but
 * it is printed, never swallowed.
 */
/** What `beginMeasuredRun` hands the runner — every pre-run measurement, in
 *  the order the mechanism requires them to be taken. */
export interface MeasuredRunBegin {
  /** Null when `/proc` could not be read — absence, never a fabricated zero. */
  readonly cpuBefore: RunCpu | null;
  /** The calibration taken BEFORE the CPU baseline, so its cost is not the suite's. */
  readonly calibrationBefore: CalibrationReading | null;
  readonly headSha: string | null;
  /** Null when the load sample or the CPU count is unreadable — absence,
   *  never a fabricated zero. The one producer is
   *  `src/shared/ambient-load.ts::readAmbientLoadPerCpu`. */
  readonly ambientLoadPerCpu: number | null;
  /** The same one run-start sample's 5- and 15-minute legs, per CPU. Null
   *  on the same unreadable conditions as the 1-minute figure. */
  readonly ambientLoad5PerCpu: number | null;
  readonly ambientLoad15PerCpu: number | null;
  readonly runStartMs: number;
}

/** The three order-bearing steps, injectable so a test can OBSERVE the order
 *  rather than trust the comment that used to be the only guarantee. */
export interface MeasuredRunBeginSteps {
  readonly pruneCache: (root: string) => void;
  readonly readCpuBaseline: () => RunCpu | null;
  readonly measureCalibration: () => CalibrationReading | null;
  readonly stampStart: () => number;
}

/**
 * Take every pre-run measurement, IN THE ORDER THE MECHANISM REQUIRES.
 *
 * THE CACHE PRUNE RUNS FIRST — before the run's start-stamp AND before the
 * CPU baseline, and both orderings are load-bearing:
 *   - taken before the start-stamp, the prune can only ever delete entries
 *     whose mtime predates it, so the end-of-run warmth walk
 *     (mtime >= start) cannot be fabricated or eroded by it;
 *   - taken before `cpuBefore`, the prune's own filesystem cost never
 *     inflates the judged CPU figure.
 * The calibration runs BEFORE `cpuBefore`, so its own CPU never sits inside
 * the window the suite's cost is measured over; the head sha and the ambient
 * load are sampled AT RUN START (the load average is a decaying one-minute
 * figure — sampled after the run it would describe the run itself, not the
 * conditions it started under), and the start-stamp is LAST so nothing that
 * happens in this function can sit inside the window the warmth instrument
 * reads.
 *
 * This used to be five inline statements in `runCli`, whose order was a
 * comment: reordering them produced ZERO reds. Now the order lives in one
 * function a test drives with instrumented steps
 * (`test/prevention/suite-cpu-budget.test.ts`), and `runCli` is held to
 * calling THIS function rather than re-inlining the sequence.
 */
export function beginMeasuredRun(
  root: string,
  steps: MeasuredRunBeginSteps = {
    pruneCache: pruneCompileCacheIfDeclared,
    readCpuBaseline: readRunCpu,
    measureCalibration,
    stampStart: Date.now,
  },
): MeasuredRunBegin {
  steps.pruneCache(root);
  // BEFORE the CPU baseline: the calibration's own CPU must not sit inside
  // the window the suite's cost is measured over.
  const calibrationBefore = steps.measureCalibration();
  const cpuBefore = steps.readCpuBaseline();
  const headSha = readRepositoryHeadSha(root);
  // ONE reading, all three legs, from the shared producer: the 1-minute
  // figure is the covariate recorded beside the verdict, and the 5-/15-minute
  // legs witness the saturation ghost that decays out of the 1-minute figure
  // within minutes of a previous suite finishing. An unreadable sample is
  // null, never a fabricated zero; no leg ever moves a cap (NO-LOAD-BLOCK).
  const ambient = readAmbientLoadPerCpu();
  const runStartMs = steps.stampStart();
  return {
    cpuBefore,
    calibrationBefore,
    headSha,
    ambientLoadPerCpu: ambient.perCpu?.load1 ?? null,
    ambientLoad5PerCpu: ambient.perCpu?.load5 ?? null,
    ambientLoad15PerCpu: ambient.perCpu?.load15 ?? null,
    runStartMs,
  };
}

function pruneCompileCacheIfDeclared(root: string): void {
  // The config read stays OUTSIDE the catch: a refused document is a refusal
  // of the run, not a skipped prune (config-refusal-propagates.test.ts).
  const policy = readTestExecutionConfig(root).compileCachePruning;
  try {
    if (policy === undefined) {
      process.stdout.write(
        "[compile-cache] no pruning policy declared (testExecution.compileCachePruning in " +
          "bridlewise.config.json) — the shared V8 compile cache grows unbounded. Declare " +
          "{ maxEntryAgeDays, maxEntries, timeBudgetMs } to bound it; nothing is guessed.\n",
      );
      return;
    }
    const result = pruneCompileCacheRoot(policy);
    process.stdout.write(
      `[compile-cache] prune: ${String(result.prunedEntries)} of ` +
        `${String(result.scannedEntries)} entries removed in ${String(result.tookMs)}ms ` +
        `(policy: keep newest ${String(policy.maxEntries)}/dir within ` +
        `${String(policy.maxEntryAgeDays)}d)` +
        `${result.timeBudgetExhausted ? " — TIME BUDGET EXHAUSTED, the next run continues the trim" : ""}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `[compile-cache] prune skipped: ${extractErrorMessage(error)}\n`,
    );
  }
}

/**
 * The verdict-to-exit-code binding, owned here at the single choke point where
 * the gate's outcome becomes the runner's exit. A FAIL is the only outcome that
 * fails the run; every other verdict (pass, warn, not-judged) exits clean so a
 * refused or over-cap-but-tolerated run never masks as a regression. This is a
 * pure function of the outcome kind so the binding is drivable directly — a
 * guard that reads the source text for a `return 1` near the word "fail" can be
 * satisfied by an unrelated branch's exit and stay green while the fail arm is
 * gutted; driving this function cannot.
 */
export function gateOutcomeExitCode(kind: GateOutcome["kind"]): number {
  return kind === "fail" ? 1 : 0;
}

/**
 * The suite's run-cost gate: collect the runner-bound evidence (CPU delta,
 * inventory population, compile-cache warmth), hand it to the shared judge,
 * print every outcome — a NOT-JUDGED is a printed first-class result, never
 * a silent green — append the judged record to the run-history ledger, and
 * translate a failed gate into a non-zero exit.
 *
 * THE INSTRUMENT ITSELF FAILING IS A RED, NOT A SHRUG: a gate that cannot
 * run its own decision has not found the suite healthy, it has found
 * nothing, and reporting nothing as success is the failure mode this whole
 * mechanism replaces (the predecessor scored a corrupt summary as PASS).
 */
export function judgeSuiteRunCost(run: Readonly<{
  root: string;
  runStartMs: number;
  wallClockMs: number;
  cpuBefore: RunCpu | null;
  cpuAfter: RunCpu | null;
  calibrationBefore: CalibrationReading | null;
  calibrationAfter: CalibrationReading | null;
  failures: readonly string[];
  failureDigests: Readonly<Record<string, string>>;
  failureLocations: Readonly<Record<string, string>>;
  invocationId: string;
  producer: ReturnType<typeof testExecutionQualification>;
  headSha: string | null;
  ambientLoadPerCpu: number | null;
  ambientLoad5PerCpu: number | null;
  ambientLoad15PerCpu: number | null;
  provisional: Readonly<{ provisionalFailures: true }> | Readonly<Record<string, never>>;
  mutation: ReturnType<typeof mutationRunMark>;
  tree: ReturnType<typeof measuredTreeMark>;
}>): number {
  try {
    const cpuMs = run.cpuBefore !== null && run.cpuAfter !== null
      ? run.cpuAfter.totalCpuMs - run.cpuBefore.totalCpuMs
      : null;
    // The population is the pinned inventory's test-file set — the exact
    // binding the worker asserted the run against, so a passing run's
    // executed file set IS this set. Counted from the artifact, with its
    // source named, rather than recalled from prose.
    const testFileCount = inventoryTestFileCount(run.root);
    // THE ONE COMPUTATION of the load-agnostic metric — the signal owner's,
    // not this runner's. Null (absent) when the CPU, the calibration or the
    // population is missing; the verdict refuses rather than substituting
    // raw CPU.
    const work = computeRunWork(
      cpuMs,
      { atStart: run.calibrationBefore, atEnd: run.calibrationAfter },
      testFileCount ?? 0,
    );
    // EVERY FULL RUN IS A MEASUREMENT, whatever else ran beside it: the cost
    // is CPU work, valid at any load (NO-LOAD-BLOCK, audit A-04). There is no
    // "unslotted" refusal: runs share the host under per-run caps.
    // The warmth scan runs AFTER the CPU readings above, so its own cost
    // (a stat walk of the compile cache) never inflates the judged figure.
    const scan = scanCompileCache(run.runStartMs);
    const warmth: CacheWarmthReading | null = scan === null
      ? null
      : {
        entriesAtEnd: scan.entries,
        writtenDuringRun: scan.writtenSince,
        newestEntryMtimeMs: scan.newestMtimeMs,
        runStartMs: run.runStartMs,
      };
    const config = readTestExecutionConfig(run.root);
    const declaration = config.integrationSuiteCpuBudget ?? {
      missing:
        "integrationSuiteCpuBudget is not set under testExecution in " +
        "bridlewise.config.json. This gate bounds what the integration suite may cost " +
        "in CPU milliseconds per test file, and it has no default: a budget nobody chose " +
        "is not a budget. Declare the accumulation phase " +
        "({ phase: \"accumulation\", minimumJudgedRuns, maxPopulationDriftFraction }) to " +
        "start collecting the evidence a cap is derived from.",
    };
    const historyPath = resolve(run.root, TEST_RUN_HISTORY_PATH);
    const judgment: SuiteCpuJudgment = judgeSuiteCpu(
      {
        workUnitsPerTestFile: work?.workUnitsPerTestFile ?? null,
        workMetric: work?.metric ?? null,
        rawCpuMsPerTestFile: work?.rawCpuMsPerTestFile ?? null,
        calibrationMs: work?.calibrationMs ?? null,
        calibrationDriftFraction: work?.calibrationDriftFraction ?? null,
        testFileCount,
        wallClockMs: run.wallClockMs,
        timestamp: new Date().toISOString(),
        warmth,
        headSha: run.headSha,
        ambientLoadPerCpu: run.ambientLoadPerCpu,
        ambientLoad5PerCpu: run.ambientLoad5PerCpu,
        ambientLoad15PerCpu: run.ambientLoad15PerCpu,
      },
      declaration,
      readRunHistory(historyPath),
      "integration",
      "testExecution.integrationSuiteCpuBudget",
    );
    // Provenance on every run: the readings themselves, beside the verdict,
    // so a moved number is visible whether or not any gate colours.
    process.stdout.write(
      `[suite-budget] this run: cpu ${cpuMs === null ? "unreadable" : `${(cpuMs / 1000).toFixed(1)}s`} ` +
        `over ${testFileCount === null ? "unknown" : String(testFileCount)} test files ` +
        `(${work === null ? "calibrated work unreadable — not substituted with raw CPU" : `${work.workUnitsPerTestFile.toFixed(3)} calibration units/file, metric ${work.metric}, raw ${work.rawCpuMsPerTestFile.toFixed(1)} ms/file provenance`}) · ` +
        `wall clock ${(run.wallClockMs / 1000).toFixed(2)}s (reported, not judged) · ` +
        `compile cache ${scan === null ? "not observable" : `${String(scan.entries)} entries, ${String(scan.writtenSince)} written during the run`}\n`,
    );
    if (judgment.judgedRecord !== null) {
      // Only a JUDGED run enters the ledger — a refusal proved nothing about
      // the tree, so it must neither extend a streak nor break one. Failure
      // rows ride along for the flaky-memory guard this ledger also serves,
      // marked provisional when the run measured a tracked-dirty (mid-edit)
      // tree: those rows are evidence about the edit, not the committed
      // code. A run launched as a deliberate mutation verification carries
      // that mark instead — its red is the verification working.
      appendJudgedRun(
        {
          ...judgment.judgedRecord,
          ...(run.tree.treeId === undefined ? {} : { qualification: {
            schemaVersion: 1 as const, invocationId: run.invocationId, treeId: run.tree.treeId,
            producer: "engine" as const, producerComplete: run.producer.complete,
            outcomes: [judgment.outcome, ...run.producer.outcomes],
          } }),
          failures: run.failures,
          ...(Object.keys(run.failureDigests).length > 0 ? { failureDigests: run.failureDigests } : {}),
          ...(Object.keys(run.failureLocations).length > 0 ? { failureLocations: run.failureLocations } : {}),
          ...run.provisional,
          ...run.mutation,
          ...run.tree,
        },
        historyPath,
      );
    }
    const o = judgment.outcome;
    if (o.kind === "not-judged") {
      process.stdout.write(`[suite-budget] ${o.gate}: NOT JUDGED — ${o.message}\n`);
    } else if (o.kind === "pass") {
      process.stdout.write(`[suite-budget] ${o.gate}: ${o.message}\n`);
    } else {
      process.stderr.write(
        `\n[suite-budget] ${o.gate} FAILED on THIS run:\n${o.message}\n`,
      );
    }
    return Math.max(gateOutcomeExitCode(o.kind), run.producer.outcomes.some((outcome) => outcome.kind === "fail") ? 1 : 0);
  } catch (error) {
    process.stderr.write(
      `\n[suite-budget] THE GATE COULD NOT RUN: ${extractErrorMessage(error)}\n` +
        `[suite-budget] A guard that cannot evaluate has not passed. Failing the run.\n`,
    );
    return 1;
  }
}

/**
 * How many test FILES the pinned inventory binds a full run to.
 *
 * Counted from the pinned test inventory's own canonical source list (the
 * artifact at `VERIFICATION_PATHS.testInventory` — the one the worker
 * asserts the run against), never from a filesystem walk here, which would
 * be a second universe that can disagree with the one the run was actually
 * held to. Null when the artifact cannot be read or has no list: absence,
 * never a guessed number.
 */
function inventoryTestFileCount(root: string): number | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(root, VERIFICATION_PATHS.testInventory), "utf8"),
    );
    const ids = (parsed as { scope?: { canonicalNodeSourceIds?: unknown } } | null)
      ?.scope?.canonicalNodeSourceIds;
    if (!Array.isArray(ids) || ids.length === 0) return null;
    return new Set(ids.filter((id): id is string => typeof id === "string")).size;
  } catch {
    return null;
  }
}

/**
 * Auto-heal stale test inventory and dispositions before running the suite.
 *
 * If the test-surface dispositions manifest is missing entries for recognizable
 * test files, or the test inventory hash doesn't match the current sources,
 * this function regenerates them in-place. This eliminates the need for agents
 * to manually run `harness regenerate` or `npm run inventory:generate` after
 * committing test file changes.
 *
 * The regeneration runs as a subprocess (`node src/cli.ts harness regenerate`)
 * to reuse the existing builder-layer transaction logic without importing it
 * into the runner's module graph (which would create layer violations).
 * `harness regenerate` itself:
 *   - auto-adds missing disposition entries for recognizable test files
 *     (after cleaning up ephemeral foundation-cascade residue)
 *   - regenerates the test inventory (atomically writes the inventory file
 *     AND updates the root-policy inventory-hash pin)
 *   - repairs ALL hash bindings (including the disposition manifest binding
 *     which may have changed after auto-adding entries)
 *   - regenerates the module registrar
 * This makes `npm test` self-sufficient — agents never need to manually
 * run `harness regenerate` after committing test file changes.
 *
 * The subprocess is skipped when the cheap test-surface fingerprint (source
 * file stats + disposition manifest + inventory + root-policy hashes) still
 * matches the fingerprint recorded after the last successful regeneration;
 * any change invalidates the fingerprint and forces a real regeneration.
 */
/** Where the auto-heal fingerprint is cached, repository-relative (exported for its test: one spelling). */
export const AUTO_HEAL_FINGERPRINT_PATH = statePath("state", "test-results", "auto-heal-fingerprint.json");
/** The cache document's schema (exported for its test: one spelling). */
export const AUTO_HEAL_FINGERPRINT_SCHEMA_VERSION = schemaId("auto-heal-fingerprint", 1);

async function autoHealTestInventory(): Promise<void> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  try {
    const { computeTestSurfaceFingerprint } = await import("../test-inventory.ts");
    // Fingerprint unavailable: REPORTED, unlike the cache read below (a2-design
    // L7 asked which). Every input it reads is tracked and present in a sound
    // checkout, so a failure means the tree is mid-change or broken, never an
    // ordinary first run; it falls through to the unconditional regenerate,
    // which owns drift recovery and names what is wrong.
    const fingerprint = bestEffort(() => computeTestSurfaceFingerprint(root));
    if (fingerprint !== undefined && readAutoHealFingerprintCache(root) === fingerprint) {
      return;
    }
    const { execFileSync } = await import("node:child_process");
    execFileSync(execPath, ["src/cli.ts", "harness", "regenerate"], {
      cwd: root,
      stdio: "pipe",
      timeout: 120_000,
    });
    try {
      writeAutoHealFingerprintCache(root, computeTestSurfaceFingerprint(root));
    } catch (cacheError) {
      // A cache write failure only costs the next run a regeneration; report
      // it but do not mask the successful heal.
      process.stderr.write(`${canonicalJson({
        error: "auto_heal_fingerprint_cache_failed",
        message: extractErrorMessage(cacheError),
      })}\n`);
    }
  } catch (error) {
    // A BROAD CATCH THAT DOES NOT RE-THROW CONVERTS A CRASH INTO A VERDICT.
    //
    // This wrote `auto_heal_failed` to stderr and returned, so the suite ran
    // anyway. Everything the regeneration exists to refuse — a dead qualified
    // pattern, a pruned disposition set, a conservation identity that no
    // longer balances — is raised HERE, as an exception from the `harness
    // regenerate` subprocess. Swallowed, every one of those refusals became a
    // line of stderr in front of a green run, which is worse than not having
    // them: it is a guard that is loud only for a command nobody has to run.
    //
    // The subprocess output is carried along because `execFileSync` puts the
    // real diagnostic on the child's stderr, and a wrapper that drops it
    // reports "regenerate failed" for every possible reason.
    const detail = error instanceof Error && "stderr" in error
      ? `${extractErrorMessage(error)}: ${String((error as { stderr?: unknown }).stderr ?? "").trim()}`
      : extractErrorMessage(error);
    throw new HarnessError(
      `test inventory auto-heal failed, so the suite was not run: ${detail}`,
      "auto_heal_failed",
    );
  }
}

/**
 * The fingerprint recorded after the last successful regeneration, or
 * `undefined` for a cache miss. No cache yet (a fresh checkout, a cleaned
 * state directory) and an unreadable-as-JSON cache are ordinary misses that the
 * regeneration heals, so they report nothing; only a failed read of a cache
 * that exists goes to the central best-effort report. (A missing file used to
 * surface as "[debug] diagnostic unavailable" on every first run.)
 */
export function readAutoHealFingerprintCache(root: string): string | undefined {
  const path = join(root, AUTO_HEAL_FINGERPRINT_PATH);
  if (!existsSync(path)) return undefined;
  return bestEffort(() => {
    const parsed = parseJsonExact(readFileSync(path, "utf8"))?.value;
    return isPlainObject(parsed) && parsed.schemaVersion === AUTO_HEAL_FINGERPRINT_SCHEMA_VERSION &&
      typeof parsed.fingerprint === "string" ? parsed.fingerprint : undefined;
  });
}

function writeAutoHealFingerprintCache(root: string, fingerprint: string): void {
  const absolutePath = resolve(root, AUTO_HEAL_FINGERPRINT_PATH);
  const content = `${canonicalJson({
    schemaVersion: AUTO_HEAL_FINGERPRINT_SCHEMA_VERSION,
    fingerprint,
  })}\n`;
  ensurePrivateStateDirectory(dirname(absolutePath));
  const result = atomicWriteFile(absolutePath, content);
  if (!result.success) {
    throw new HarnessError(
      `Failed to write auto-heal fingerprint cache to ${absolutePath}: ${result.reason ?? "unknown error"}`,
      "auto_heal_fingerprint_cache_failed",
    );
  }
}

export function cleanupFoundationCascadeResidue(root: string): void {
  const supportDir = join(root, "test", "support");
  bestEffort(() => {
    for (const entry of readdirSync(supportDir)) {
      if (
        (entry.startsWith("foundation-cascade-") || entry.startsWith(".foundation-cascade-")) &&
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u.test(entry)
      ) {
        bestEffort(() => unlinkSync(join(supportDir, entry)));
      }
    }
  });
}

/**
 * Reconcile the dispositions manifest with the recognizable test surface: add
 * entries for recognizable test files missing from the manifest, and prune
 * entries for files no longer on the recognizable surface (deleted test files
 * or sources moved out of scope). The language is derived from
 * `recognizableTestSourceLanguage` (never hardcoded). JavaScript/TypeScript
 * sources under the qualified patterns default to the "canonical-node-test"
 * disposition. Anything else — Python sources, or recognizable js/ts sources
 * outside `qualifiedSourcePatterns` (for example under `scripts/`) — defaults
 * to "pending-external-qualification": the manifest semantics forbid a
 * canonical disposition for unqualified sources, and silently admitting them
 * would weaken the test-surface gate.
 *
 * The recognizable file set comes from the single owner
 * `listRecognizableTestPaths` (in `scripts/test-inventory.ts`), which applies
 * the same walk (`listSafeRepositoryTree` with `repositoryScanExclusions`) and
 * the same per-path filters (`shouldExcludeExperiment` +
 * `recognizableTestSourceLanguage`) as the inventory builder itself. Sharing
 * one owner means the coverage check and the reconciliation can never drift:
 * the manifest always tracks exactly the files the inventory considers
 * in-scope, so `buildTestSurfaceScope` (which compares the manifest entry set
 * to the recognizable set) always agrees.
 *
 * Returns the relative paths of the entries that were added and pruned (both
 * empty when the manifest already covered every recognizable file and held no
 * stale entries).
 */
export async function autoAddMissingDispositionEntries(root: string, prune: readonly string[] = []): Promise<{
  addedPaths: readonly string[];
  prunedPaths: readonly string[];
}> {
  const { join } = await import("node:path");
  const { createTestSurfaceDispositionManifest, isQualifiedCanonicalNodeTestSource, parseTestSurfaceDispositionManifestText, recognizableTestSourceLanguage } = await import("../verification/test-surface.ts");
  const { ROOT_POLICY } = await import("../../src/kernel/root-policy.ts");
  const { listUntrackedRecognizableTestPaths, listRecognizableTestPaths } = await import("../test-inventory.ts");

  // REFUSE ON UNTRACKED — before anything is written.
  //
  // A recognizable test source git does not hold can be neither registered
  // (the conservation identity refuses a registry naming a file a clone does
  // not contain) nor left out (the coverage gate refuses an unregistered
  // recognizable file). Registering it anyway wrote the manifest, then the
  // inventory step refused, and the tree was left half-healed. The way out is
  // to put the file in the index or out of the tree; either is a decision.
  const untrackedPaths = listUntrackedRecognizableTestPaths(root);
  if (untrackedPaths.length > 0) {
    throw new HarnessError(
      `test-surface auto-heal refused: ${untrackedPaths.length} recognizable test source(s) are not in the git ` +
      `index, so a clone would not run them and the test surface cannot be registered: ` +
      `${untrackedPaths.slice(0, 10).join(", ")}${untrackedPaths.length > 10 ? ", …" : ""}. ` +
      `Stage them (\`git add -N <path>\` is enough) or move them out of the tree, then re-run.`,
      "test_surface_source_untracked",
    );
  }

  const manifestPath = join(root, ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath);
  const text = readFileSync(manifestPath, "utf8");
  const manifest = parseTestSurfaceDispositionManifestText(text);
  const registeredByPath = new Map(manifest.entries.map((e) => [e.path, e] as const));
  const registeredPaths = new Set(registeredByPath.keys());

  // The single owner returns the recognizable test-surface file set. Both the
  // inventory coverage check and this reconciliation use it, so they agree by
  // construction.
  const recognizablePaths = listRecognizableTestPaths(root);
  const recognizableSet = new Set(recognizablePaths);

  const missingPaths = recognizablePaths
    .filter((path) => !registeredPaths.has(path))
    .sort();
  const stalePaths = [...registeredPaths]
    .filter((path) => !recognizableSet.has(path))
    .sort();

  if (missingPaths.length === 0 && stalePaths.length === 0) {
    return { addedPaths: [], prunedPaths: [] };
  }

  // REFUSE ON PRUNE — the two directions are not symmetric.
  //
  // ADDING an entry is safe: a new test file appears, it is registered, and
  // the suite gets larger. REMOVING one is how the suite disappears. Renaming
  // `test/` to `tests/` prunes 399 entries and re-adds them as
  // `pending-external-qualification`; the manifest is then internally
  // consistent, the coverage gate at `buildTestSurfaceScope` is satisfied
  // because it compares the HEALED manifest to the CURRENT surface, and the
  // run reports passing with 78 of 8,562 tests. The heal ran before any gate
  // could fire, which is the whole defect: a repair that outruns its check.
  //
  // So a prune is a refusal with a named way out, never a silent repair. The
  // legitimate case — a test file was genuinely deleted — is one flag, and
  // requiring it means the deletion is a decision somebody made rather than
  // something a rename did.
  // A named prune is a DELETION: a path still on the recognizable surface is
  // a file that exists, and naming it cannot remove it from the suite.
  const notDeleted = prune.filter((path) => recognizableSet.has(path));
  if (notDeleted.length > 0) {
    throw new HarnessError(
      `test-surface prune refused: ${notDeleted.join(", ")} still exist on the recognizable test surface; ` +
      `--prune names a test file that was DELETED on purpose, never one that is present.`,
      "test_surface_prune_not_deleted",
    );
  }
  // Every stale path must be named, one by one: a blanket flag would also
  // bless a directory rename (hundreds of "stale" paths at once).
  const pruneSet = new Set(prune);
  const unnamed = stalePaths.filter((path) => !pruneSet.has(path));
  if (unnamed.length > 0) {
    throw new HarnessError(
      `test-surface auto-heal refused: ${unnamed.length} registered test source(s) are no longer on the ` +
      `recognizable surface, and removing them would shrink the suite silently: ` +
      `${unnamed.slice(0, 10).join(", ")}${unnamed.length > 10 ? ", …" : ""}. ` +
      `If a directory moved, move the pattern in root-policy.ts with it. If these files were deleted on ` +
      `purpose, name each deletion: node src/cli.ts harness sync ${unnamed.slice(0, 10).map((path) => `--prune ${path}`).join(" ")}` +
      `${unnamed.length > 10 ? " …" : ""} (the candidate tool takes the same --prune flags).`,
      "test_surface_prune_refused",
    );
  }

  // Build the reconciled entry set: keep existing entries whose paths are
  // still recognizable, drop stale entries, and add new entries for the
  // missing paths with the language- and qualification-appropriate default
  // disposition.
  const keptEntries = manifest.entries.filter((entry) => recognizableSet.has(entry.path));
  const addedEntries = missingPaths.map((path) => {
    const language = recognizableTestSourceLanguage(path);
    if (language === undefined) {
      // listRecognizableTestPaths only returns recognizable paths, so this is
      // unreachable; guard for exhaustiveness.
      throw new Error(`auto-add encountered a non-recognizable path: ${path}`);
    }
    if (language === "javascript-typescript" && isQualifiedCanonicalNodeTestSource(path)) {
      return {
        path,
        language,
        disposition: "canonical-node-test" as const,
        rationale: "Auto-registered by npm test auto-heal.",
        evidenceLinks: [] as string[],
        blocksFullRepositoryClaim: false,
      };
    }
    return {
      path,
      language,
      disposition: "pending-external-qualification" as const,
      rationale: language === "python"
        ? "Preserved Python test or suite runner; interpreter, dependencies, isolation, parent-captured receipts, and execution remain unqualified and are never invoked implicitly by the Node core."
        : "Recognizable test source outside the qualified source patterns; it is never executed implicitly by the Node core until its loader and runner are qualified and the central pattern admits it.",
      evidenceLinks: [] as string[],
      blocksFullRepositoryClaim: true,
    };
  });

  const newEntries = [...keptEntries, ...addedEntries];
  const regenerated = createTestSurfaceDispositionManifest(newEntries);
  const written = atomicWriteFile(manifestPath, JSON.stringify(regenerated, null, 2) + "\n");
  if (!written.success) {
    throw new HarnessError(`Failed to write the disposition manifest ${manifestPath}: ${written.reason ?? "unknown error"}`, "disposition_manifest_write_failed");
  }
  process.stderr.write(`${canonicalJson({ auto_heal: "dispositions", added: missingPaths.length, pruned: stalePaths.length, files: missingPaths, prunedFiles: stalePaths })}\n`);
  return { addedPaths: missingPaths, prunedPaths: stalePaths };
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const invocationId = qualificationInvocation(process.env);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const tree = readMeasuredTree(root);
  let execution: CompletedExecution | undefined;
  let result: TestCommandResult | undefined;
  result = await runCli(invocationId, (observed) => { execution = observed; });
  if (result === undefined) throw new Error("the engine runner answered nothing");
  process.exitCode = result.exitCode;
  process.stderr.write(`${sweepEndedRunTemporaries("run-tests")}\n`);
  // Maintenance has no worker. Only explicit operation intent exempts it;
  // a suite without an observed execution still refuses completion. Executions
  // already carry the one live/replayed policy decision from their owner.
  if (result.operation === "suite") {
    if (execution === undefined) {
      process.stderr.write("[run-tests] engine test command has no terminal proof\n");
      process.exitCode = 1;
    }
    const history = resolve(root, TEST_RUN_HISTORY_PATH);
    if (runForInvocation(history, invocationId) !== undefined) {
      if (tree === null || readMeasuredTree(root) !== tree || execution?.terminal === undefined) {
        process.stderr.write("[run-tests] current qualification lacks unchanged tree/terminal evidence\n");
        process.exitCode = 1;
      } else {
        try { finalizeQualifiedRun(history, invocationId, tree, qualificationTerminal(invocationId, tree, execution.terminal)); }
        catch {
          process.stderr.write("[run-tests] current qualification finalization refused\n");
          process.exitCode = 1;
        }
      }
    }
  }
}
