/**
 * THE VITEST DOOR OF THE ONE-INSTRUMENT LOCK.
 *
 * Every way of running the web suite — `npx vitest run`, `npm test`,
 * `npm run test:raw`, watch mode — loads `vitest.config.ts` first, and vitest
 * runs this global setup once, in the main process, before any worker
 * starts. There is no path to the runner that does not pass here, which is
 * what makes this the door and not a reminder: start the suite while the
 * engine suite or a browser profile holds the lock and the refusal names
 * the holder instead of letting two instruments contend for the same cores.
 *
 * Measured while the rule was prose: run together with the engine suite,
 * this suite reported 35.81 s against a 35 s cap and went red; run alone
 * immediately after, it was under. A red caused by your own parallelism is
 * indistinguishable from a regression until you re-run alone.
 *
 * The lock module lives in `engine/scripts/tooling/test-run-lock.ts` and says why a
 * lock file and not a process scan. HEAVY IS ONE DEFINITION: the files this
 * run selects, counted by vitest itself; a run of fewer than the configured
 * number takes nothing. A heavy run never takes the lock HERE (vitest's main
 * process would hold it, and a SIGKILL of that process would free it under
 * workers still running): it borrows the hold of the supervising door that
 * started it — `npm test`, or `harness slot run -- npx vitest run` — and,
 * started outside one (a bare `npx vitest run a b c`), it RE-RUNS ITSELF
 * inside the one supervising door, as the coverage run and the perf profile
 * do, and exits with that run's code. The door takes the lock and its record
 * ADOPTS the run — this process among the processes the record names live —
 * so the protection against a SIGKILL of vitest's main process is that
 * adoption: the door frees the lock only when the adopted run's process tree
 * is gone (design LOW 8: this process is one the record names, not one it
 * never names).
 */

import { parseCLI, type TestProject } from "vitest/node";

import { enforceTestRunLock, type TestRunLock } from "../../engine/scripts/tooling/test-run-lock.ts";
import { INSIDE_INSTRUMENT_LOCK_VARIABLE, runInsideInstrumentLock } from "../../engine/src/workflow/slot-cli.ts";

let lock: TestRunLock | null = null;

/**
 * The files THIS run selects, counted by vitest itself: the command line's
 * own filters (vitest's own parser) globbed by the project's own
 * specification search — one count of what actually runs, never a guess from
 * the arguments (design L-2).
 */
export async function selectedTestFileCount(project: Pick<TestProject, "vitest">, argv: readonly string[]): Promise<number> {
  const { filter } = parseCLI(["vitest", ...argv]);
  const specifications = await project.vitest.globTestSpecifications(filter);
  return new Set(specifications.map((specification) => specification.moduleId)).size;
}

/**
 * The door for one vitest command line: its selected files counted, then the one lock's door. A LISTING too:
 * `vitest list` collects the whole suite, which is heavy (it drove the host's load to 45 in a measurement window),
 * so it takes the lock like any run of as many files (no verb is exempt). `door` is the lock's door, a
 * test's own in a test.
 */
export async function setup(project: TestProject, door: typeof enforceTestRunLock = enforceTestRunLock): Promise<void> {
  // The vitest main process would hold the lock in its own process: a heavy run only BORROWS the hold of the
  // supervising door that started it (`npm test`, `harness slot run --`).
  const testFileCount = await selectedTestFileCount(project, process.argv.slice(2));
  try {
    lock = await door("web vitest suite", { testFileCount, inProcess: true });
  } catch (error) {
    // Outside every door: run this very command again INSIDE the one supervising door (it waits for the lock, adopts
    // the run and frees the lock only when the run's process tree is gone), and leave with its code. Inside the door
    // already (its variable is set), a refusal is final: never a second re-run.
    if ((error as { code?: unknown }).code !== "instrument_lock_unsupervised" || process.env[INSIDE_INSTRUMENT_LOCK_VARIABLE] === "1") throw error;
    const { exitCode } = await runInsideInstrumentLock("web vitest suite", testFileCount, [process.execPath, ...process.execArgv, ...process.argv.slice(1)]);
    process.exit(exitCode);
  }
}

export function teardown(): void {
  lock?.release();
  lock = null;
}
