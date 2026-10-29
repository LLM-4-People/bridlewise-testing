/**
 * THE VITEST DOOR OF HEAVY-RUN ADMISSION.
 *
 * Every way of running the web suite — `npx vitest run`, `npm test`,
 * `npm run test:raw`, watch mode — loads `vitest.config.ts` first, and vitest
 * runs this global setup once, in the main process, before any worker
 * starts. There is no path to the runner that does not pass here, which is
 * what makes this the door and not a reminder: a heavy run is admitted under
 * its per-run caps (a cgroup scope and a CPU-time limit), beside any other
 * run — nothing waits for another run, whatever the load (NO-LOAD-BLOCK).
 *
 * The door's module lives in `engine/scripts/tooling/test-run-lock.ts`.
 * HEAVY IS ONE DEFINITION: the files this run selects, counted by vitest
 * itself; a run of fewer than the configured number records nothing. A heavy
 * run is never admitted HERE (vitest's main process would own the record,
 * and a SIGKILL of that process would drop it under workers still running):
 * it borrows the run of the supervising door that started it — `npm test`,
 * or `harness slot run -- npx vitest run` — from inside that run's scope,
 * and, started outside one (a bare `npx vitest run a b c`), it RE-RUNS
 * ITSELF inside the one supervising door, as the coverage run and the perf
 * profile do, and exits with that run's code. The door's record ADOPTS the
 * run — this process among the processes the record names live — so a
 * SIGKILL of vitest's main process leaves the record live until the adopted
 * run's process tree is gone (design LOW 8).
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
  // The vitest main process would own the run in its own process: a heavy run only BORROWS the run of the
  // supervising door that started it (`npm test`, `harness slot run --`).
  const testFileCount = await selectedTestFileCount(project, process.argv.slice(2));
  try {
    lock = await door("web vitest suite", { testFileCount, inProcess: true });
  } catch (error) {
    // Outside every door: run this very command again INSIDE the one supervising door (it admits the run at once under
    // its caps, adopts it and drops the record only when the run's process tree is gone), and leave with its code. Inside the door
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
