/**
 * ONE INSTRUMENT AT A TIME — the door every suite/profile runner takes, to
 * the HOST's one instrument lock (`src/process/instrument-lock.ts`: one lock
 * file per host user, built on the one lock primitive). A second heavy run
 * WAITS, naming the holder — in one checkout and across checkouts alike.
 *
 * ── THE DEFECT, MEASURED ──────────────────────────────────────────────────
 *
 * The sequential rule lived in prose: run the suites one at a time, never
 * concurrently, because they contend for the same cores and at least one gate
 * judges cost. Measured while it was prose: the web suite run together with
 * the engine suite reported 35.81 s against a 35 s cap and went red; run
 * alone immediately after, it was under. The engine suite's worker setup
 * rejects (`candidate_format_rejected`, candidate-changed-during-verification)
 * while the web suite runs. A red caused by your own parallelism is
 * indistinguishable from a regression until you re-run alone, and the re-run
 * costs a full cycle every time. The rule is now a refusal, not a reminder.
 *
 * ── WHY A LOCK FILE AND NOT A PROCESS SCAN ────────────────────────────────
 *
 * A process scan answers "is something that looks like X alive" — a claim
 * about command lines, and a fragile one: the web runner's own orphan reaper
 * (`scripts/run-tests.ts`) documents killing its invoking shell because
 * `pgrep -f vitest` matched the wrong process, and every competitor pair
 * would need its own pattern list. The lock file answers the question the
 * refusal actually needs — WHO is running, since WHEN, and is that process
 * still alive — because the holder writes its own identity into the lock.
 * Mutual exclusion is then pairwise-complete with no enumeration: any holder
 * blocks any other runner, including one added tomorrow, because there is
 * nothing to add to a list.
 *
 * ── THE LOCK IS THE ONE FILE LOCK ──────────────────────────────────────────
 *
 * Acquisition, liveness (pid AND start time: a recycled pid is another
 * process), the atomic break of a dead holder's lock, the nonce-checked
 * release and the exit-time release are the one cross-process file lock's
 * (`src/filesystem/file-lock.ts`, `tryAcquireFileLock`: it never waits). This
 * module is the DOOR: the runner's name in the record, and what is heavy —
 * ONE definition, from config: a run of `minimumTestFiles` test files or more
 * (every entry passes the count of the files it actually runs; a run of fewer
 * takes nothing):
 *
 *   * a LIVE holder that is this process or one of its ANCESTORS (or a
 *     process that holder adopted: a supervisor it runs a command under)
 *     means the run is INSIDE the hold: the handle is BORROWED and never
 *     releases; any other live holder is waited for (`enforceTestRunLock`);
 *   * a heavy run whose runner holds the lock IN ITS OWN PROCESS (the vitest
 *     and Playwright global setups: a SIGKILL of that process would free the
 *     lock under workers still running, correctness L-N1) never takes it: it
 *     runs only inside a hold a supervising door took (`npm test`,
 *     `harness slot run --`), and is refused by name otherwise;
 *   * a DEAD holder's lock is broken and taken (the file lock's break);
 *   * an UNREADABLE lock (a file no instrument wrote) is honoured — refused,
 *     named — until it is as old as the file lock's policy bound, then broken
 *     like any other lock's: one policy for every lock (it used to fail closed
 *     forever here while the other locks broke it; wf-del2-design D1).
 *
 * ── SIGNALS ───────────────────────────────────────────────────────────────
 *
 * Only while it WAITS does the door listen for SIGTERM, SIGINT and SIGHUP
 * (`waitForInstrumentLock`: the wait is asynchronous; a signal ends it,
 * typed, and the lock is never taken after one). Once the run starts, the
 * runners' own signal semantics apply. Hard deaths are covered by liveness:
 * a dead holder's lock is broken by the next runner.
 *
 * FEW DEPENDENCIES ON PURPOSE: node built-ins plus the owners whose rule it
 * must share — private-state (the folder) and the one file lock. It is
 * loaded on the critical path of every suite start — the engine runner, the
 * web vitest global setup, and both Playwright global setups.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensurePrivateStateDirectory } from "../../src/filesystem/private-state.ts";
import { recognizableTestSourceLanguage } from "../../src/kernel/test-surface-manifest.ts";
import { borrowInstrumentLock, holdInstrumentLock, instrumentLockPath, instrumentLockStamp, interruptedWaitExitCode, isHeavyRun, waitForInstrumentLock, wholeInstrumentTestFileCount, type InstrumentLockConfig, type InstrumentLockStamp } from "../../src/process/instrument-lock.ts";
import type { WholeInstrumentKind } from "../../src/kernel/config-contracts.ts";
import { readTestExecutionConfig } from "../../src/workflow/test-result-collector.ts";

/** The lock file's name inside an injected lock folder (a test's own); production takes the host lock from config. */
export const TEST_RUN_LOCK_FILE_NAME = "test-runner.lock";

export class TestRunLockError extends Error {
  readonly code: string;
  constructor(message: string, code = "test_run_lock_failed") {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export interface TestRunLock {
  /** True only for the handle that created the lock; borrowed and light handles report false and release nothing. */
  readonly owns: boolean;
  readonly runner: string;
  readonly path: string;
  /** Whether the run this handle covers holds the one instrument lock (what its measurements record). */
  readonly stamp: InstrumentLockStamp;
  release(): void;
}

const ENGINE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** A test's own lock folder (private), and the lock file in it. */
function injectedLockPath(lockDir: string): string {
  try {
    ensurePrivateStateDirectory(lockDir);
  } catch (error) {
    throw new TestRunLockError(`could not create the lock directory ${lockDir}: ${(error as Error).message}`, "test_run_lock_dir_failed");
  }
  return join(lockDir, TEST_RUN_LOCK_FILE_NAME);
}

/** The declared lock (required: what is heavy and where the lock lives are config). */
function declaredLock(): InstrumentLockConfig {
  const config = readTestExecutionConfig(ENGINE_ROOT).instrumentLock;
  if (config === undefined) {
    throw new TestRunLockError("testExecution.instrumentLock is not declared in bridlewise.config.json: the one instrument lock's place and what is heavy are declared there", "instrument_lock_undeclared");
  }
  return config;
}

/** The count a whole instrument of `kind` passes the door: config declares it heavy by kind (`wholeInstruments`), or it is refused. */
export function wholeInstrumentRun(kind: WholeInstrumentKind): number {
  return wholeInstrumentTestFileCount(declaredLock(), kind);
}

function hostLockPath(): string {
  return instrumentLockPath(declaredLock(), ENGINE_ROOT);
}

/**
 * How many test files a runner's arguments name: a recognizable test source
 * that exists is one; a folder or a pattern names no count of its own and is
 * heavy (`heavyAt`); a path that names nothing is none (a no-op subset holds
 * nothing); no file argument at all is the whole suite (unbounded).
 */
export function namedTestFileCount(args: readonly string[], heavyAt: number, exists: (path: string) => "file" | "folder" | "absent"): number {
  const named = args.filter((arg) => !arg.startsWith("-"));
  if (named.length === 0) return Number.POSITIVE_INFINITY;
  return named.reduce((count, arg) => {
    const kind = exists(arg);
    if (kind === "absent") return count;
    if (kind === "folder" || /[*?[\]{}]/u.test(arg)) return count + heavyAt;
    return count + (recognizableTestSourceLanguage(arg.split("/").at(-1) ?? arg) === undefined ? 0 : 1);
  }, 0);
}

/** {@link namedTestFileCount} of a runner's own arguments, on the real filesystem, at the configured heavy threshold. */
export function testFileCountOfArgs(args: readonly string[]): number {
  return namedTestFileCount(args, declaredLock().minimumTestFiles, (path) => {
    try {
      return statSync(path).isDirectory() ? "folder" : "file";
    } catch {
      return "absent";
    }
  });
}

/**
 * THE DOOR every instrument's entry point calls, with the count of the test
 * files the run actually runs (`testFileCount`: required — one definition of
 * heavy; a whole instrument that is no test-file run, a profile or a slot,
 * passes `Infinity`): the host's one instrument lock for `runner`, WAITING
 * (and saying who holds it, and honouring a signal) while another heavy run
 * holds it, BORROWED inside a hold, and nothing for a light run.
 * `inProcess`: the runner would hold the lock in its own process (a global
 * setup) — a heavy run then only borrows, and is refused
 * (`instrument_lock_unsupervised`) outside a hold a supervising door took.
 * `lockDir` is a test's own folder; production takes the host lock.
 */
export async function enforceTestRunLock(
  runner: string,
  options: Readonly<{ testFileCount: number; inProcess?: boolean; lockDir?: string }>,
): Promise<TestRunLock> {
  const onWait = (line: string): void => void process.stderr.write(`${line}\n`);
  const config = declaredLock();
  const lockPath = options.lockDir === undefined ? hostLockPath() : injectedLockPath(options.lockDir);
  if (options.inProcess === true && isHeavyRun(config, options.testFileCount)) {
    const borrowed = borrowInstrumentLock(lockPath, runner);
    if (borrowed === undefined) {
      throw new TestRunLockError(
        `${runner}: a run of ${Number.isFinite(options.testFileCount) ? String(options.testFileCount) : "the whole suite's"} test files is heavy, and this runner would hold the one instrument lock in its own process — ` +
          "killed, it would free the lock under workers still running. Run it through a door that supervises it: `npm test` (the web suite), " +
          "`npm run test:e2e`, or `node engine/src/cli.ts harness slot run -- <command>`; a run of fewer than " +
          `${String(config.minimumTestFiles)} test files takes no lock.`,
        "instrument_lock_unsupervised",
      );
    }
    return borrowed;
  }
  if (options.lockDir !== undefined) {
    if (!isHeavyRun(config, options.testFileCount)) return { owns: false, runner, path: lockPath, stamp: instrumentLockStamp(lockPath), release: () => undefined };
    return waitForInstrumentLock(lockPath, runner, { onWait, pollIntervalMs: config.pollIntervalMs });
  }
  return holdInstrumentLock({ config, harnessRoot: ENGINE_ROOT, runner, testFileCount: options.testFileCount, onWait });
}

/**
 * A door's entry point: `run`, and when a signal ended its wait for the lock
 * (`instrument_lock_wait_interrupted`), said and exited as the signal would
 * have (128 + its number) — the door never went on to take the lock.
 */
export async function asLockDoor(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const code = interruptedWaitExitCode(error);
    if (code === undefined) throw error;
    process.stderr.write(`[test-run-lock] ${(error as Error).message}\n`);
    process.exit(code);
  }
}

/** Whether THIS process runs inside a live hold of the host's instrument lock (a measurement's stamp). */
export function currentInstrumentLockStamp(): InstrumentLockStamp {
  return instrumentLockStamp(hostLockPath());
}
