/**
 * THE DOOR every suite/profile runner takes to HEAVY-RUN ADMISSION
 * (`src/process/instrument-lock.ts`): a heavy run is admitted AT ONCE under
 * its per-run caps (a cgroup scope and a CPU-time limit for every supervisor
 * it starts), whatever else runs — nothing waits for another run
 * (NO-LOAD-BLOCK). It used to be ONE INSTRUMENT AT A TIME, a host-wide lock a
 * second heavy run waited for: the suites' costs were judged in CPU time that
 * contention inflated, so they could not share the cores. They are judged in
 * CPU work now (Q-TX2), and a run beside another measures the same work.
 *
 * What is heavy is ONE definition, from config: a run of `minimumTestFiles`
 * test files or more (every entry passes the count of the files it actually
 * runs); a run of fewer is light and records nothing:
 *
 *   * a run whose ANCESTOR is an admitted run (or a process it adopted: a
 *     supervisor it runs a command under) is INSIDE that run: the handle is
 *     BORROWED and never releases, and it makes no scope of its own;
 *   * a heavy run whose runner would be admitted IN ITS OWN PROCESS (the
 *     vitest and Playwright global setups) is not: its workers would start
 *     outside any supervisor and so outside the run's caps. It runs only
 *     inside a run a supervising door admitted (`npm test`, `harness slot run
 *     --`), and is refused by name otherwise (`instrument_lock_unsupervised`).
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
import { admitInstrumentRun, borrowInstrumentLock, holdInstrumentLock, instrumentLockPath, isHeavyRun, wholeInstrumentTestFileCount, type InstrumentLockConfig } from "../../src/process/instrument-lock.ts";
import { SUBPROCESS_BOUNDS } from "../../src/workflow/workflow-config.ts";
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
  /** Frees an owned run; `failure` is the run's own failure, carried by a memory-cap refusal (see InstrumentHold). */
  release(failure?: unknown): void;
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
    throw new TestRunLockError("testExecution.instrumentLock is not declared in bridlewise.config.json: the run registry's place, what is heavy and the per-run caps are declared there", "instrument_lock_undeclared");
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
 * passes `Infinity`): an ADMITTED run for `runner`, at once and under its
 * per-run caps, BORROWED inside an admitted run, and nothing for a light run.
 * `inProcess`: the runner would be admitted in its own process (a global
 * setup) — a heavy run then only borrows, and is refused
 * (`instrument_lock_unsupervised`) outside a run a supervising door admitted.
 * `lockDir` is a test's own registry folder; production uses the host's.
 */
export function enforceTestRunLock(
  runner: string,
  options: Readonly<{ testFileCount: number; inProcess?: boolean; lockDir?: string }>,
): TestRunLock {
  const config = declaredLock();
  const lockPath = options.lockDir === undefined ? hostLockPath() : injectedLockPath(options.lockDir);
  if (options.inProcess === true && isHeavyRun(config, options.testFileCount)) {
    const borrowed = borrowInstrumentLock(lockPath, runner);
    if (borrowed === undefined) {
      throw new TestRunLockError(
        `${runner}: a run of ${Number.isFinite(options.testFileCount) ? String(options.testFileCount) : "the whole suite's"} test files is heavy, and this runner would be admitted in its own process — ` +
          "its workers would then start outside the run's caps. Run it through a door that supervises it: `npm test` (the web suite), " +
          "`npm run test:e2e`, or `node engine/src/cli.ts harness slot run -- <command>`; a run of fewer than " +
          `${String(config.minimumTestFiles)} test files is light.`,
        "instrument_lock_unsupervised",
      );
    }
    return borrowed;
  }
  if (options.lockDir !== undefined) {
    if (!isHeavyRun(config, options.testFileCount)) return { owns: false, runner, path: lockPath, release: () => undefined };
    return admitInstrumentRun(lockPath, runner, config.perRun, SUBPROCESS_BOUNDS);
  }
  return holdInstrumentLock({ config, harnessRoot: ENGINE_ROOT, runner, testFileCount: options.testFileCount, cpu: SUBPROCESS_BOUNDS });
}
