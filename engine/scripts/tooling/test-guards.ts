/**
 * THE `node --test` DOOR OF THE ONE-INSTRUMENT LOCK.
 *
 * Acquires the lock in THIS process — the one that outlives the run — then
 * delegates to `node --test` with the arguments it was handed, forwarding
 * the child's exit code exactly.
 *
 * ── WHY A WRAPPER AND NOT `--import` ──────────────────────────────────────
 *
 * Measured on node 24.18: under `--test`, an `--import` module is preloaded
 * in the per-file CHILDREN and never in the supervisor (probe: exactly one
 * load, in the child, with the test file as argv). A lock taken by a child
 * dies with that child's file and refuses its own siblings. The holder must
 * be the process that outlives the whole run, and only a wrapper is that
 * process.
 *
 * ── SIGNALS ───────────────────────────────────────────────────────────────
 *
 * No signal handlers, deliberately: npm runs this script in the terminal's
 * process group, so Ctrl-C reaches the `node --test` child directly and its
 * own teardown runs. If this wrapper is killed outright the lock goes stale
 * and the next runner breaks it by liveness — recovery is automatic, and a
 * handler here would only race the child's.
 *
 * The runner name is derived from the npm lifecycle event rather than
 * hardcoded, so a second `node --test` script routed through this wrapper
 * names itself without an edit here.
 *
 * ── A PRIVATE KEY HOME, LIKE EVERY RUNNER ─────────────────────────────────
 *
 * The run's processes are under test, and a process under test without a
 * key home is refused (`key_home_unset_under_test`): this wrapper arms one
 * (`armTestKeyHome`, the canonical worker's and the vitest config's owner),
 * exported to `node --test` and every file it spawns, removed at exit. Before
 * it did, `npm run test:guards` was red by construction on every guard that
 * opens a timeline or a database, and a targeted `npm run test:unit <file>`
 * refused the same way (L-2026-09-29-targeted-runs-need-a-private-key-home).
 */

import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureTestProcessSupervisor } from "../../guardian/build.ts";
import { repositoryToplevel } from "../../src/git/repository-ownership.ts";
import { superviseCommand } from "../../src/process/supervised-run.ts";
import { readTestExecutionConfig } from "../../src/workflow/test-result-collector.ts";

import { enforceTestRunLock, testFileCountOfArgs, type TestRunLock } from "./test-run-lock.ts";
import { armTestKeyHome } from "../../test/support/test-key-home.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

const ENGINE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Whether this run is the LIVE suite's (`engine/live/`): every test file it is
 * given lies there. The live suite depends on the world outside the checkout
 * and is unconfined by design; a run that mixes live and hermetic files is
 * refused, so a hermetic file can never ride along unconfined.
 */
function liveSuiteRun(args: readonly string[]): boolean {
  const live = join(ENGINE_ROOT, "live") + sep;
  const files = args.filter((arg) => !arg.startsWith("-")).map((arg) => resolve(arg));
  const inLive = files.filter((file) => file.startsWith(live));
  if (inLive.length > 0 && inLive.length !== files.length) {
    process.stderr.write("[test-guards] REFUSED (test_live_suite_mixed) — a live-suite run takes engine/live/ files only: the live suite runs unconfined, a hermetic file never does\n");
    process.exit(1);
  }
  return files.length > 0 && inLive.length === files.length;
}

export async function main(): Promise<void> {
  const runner = `engine ${process.env.npm_lifecycle_event ?? "node --test"}`;
  // The subset door (`test:unit`) must take an explicit file or pattern. With
  // no argument, `node --test` discovers the WHOLE tree — including
  // `verification/benchmarks/**` `.mjs` scripts that are not node:test files —
  // and fails on them. Refuse the no-argument invocation here, at the one
  // wrapper every subset run passes through, rather than letting the runner
  // fail opaquely on a non-test file it discovered by default.
  const lifecycleEvent = process.env.npm_lifecycle_event;
  if (lifecycleEvent === "test:unit" && process.argv.slice(2).length === 0) {
    process.stderr.write(
      "[test-guards] test:unit requires an explicit test file or pattern " +
        "(e.g. `npm run test:unit test/editor/binary-guard.test.ts`). With no " +
        "argument, node --test discovers the whole tree — including non-test " +
        "`.mjs` scripts under verification/ — and fails on them.\n",
    );
    // The process ends by draining (process.exit can deadlock at shutdown: Node #54918, #351).
    process.exitCode = 1;
    return;
  }
  // HEAVY-RUN ADMISSION (src/process/instrument-lock.ts): a run of the
  // configured number of test files or more (the guards: a few hundred) is
  // admitted at once, under its per-run caps, and never waits for another
  // run; a targeted run of fewer is light and records nothing.
  const lock: TestRunLock = enforceTestRunLock(runner, { testFileCount: testFileCountOfArgs(process.argv.slice(2)) });
  armTestKeyHome();
  // UNDER THE NATIVE SUPERVISOR (adopted into the run this door admitted): a
  // door killed outright leaves its `node --test` stopped with every process
  // it started, and the lock held until that is done — never a run orphaned
  // beside the next holder.
  const { engineSuiteWatchdog } = readTestExecutionConfig(fileURLToPath(new URL("../../", import.meta.url)));
  // A runner builds the supervisor before its run (make's incremental check); every caller inside the run resolves it.
  const supervisor = ensureTestProcessSupervisor();
  const run = await superviseCommand({
    supervisor,
    command: process.execPath,
    args: ["--experimental-strip-types", "--test", ...process.argv.slice(2)],
    hardCeilingMs: engineSuiteWatchdog.hardCeilingMs,
    killGraceMs: engineSuiteWatchdog.killGraceMs,
    onStdout: (chunk) => process.stdout.write(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
    killOnInterrupt: true,
    // The checkout is read-only to the tests (#293's class), as under the suite runners — except the LIVE suite,
    // unconfined by design (real host facts: decision TEST-CONFINEMENT-SELF-BIND).
    ...(liveSuiteRun(process.argv.slice(2)) ? {} : { readOnlyCheckout: repositoryToplevel(ENGINE_ROOT, "directory") ?? ENGINE_ROOT }),
  });
  lock.release();
  if (run.ending !== "exited") {
    process.stderr.write(`[test-guards] node --test ended by ${run.ending}${run.signal === null ? "" : ` (${run.signal})`}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = run.exitCode;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  await main();
}
