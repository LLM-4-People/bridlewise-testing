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

import { fileURLToPath } from "node:url";

import { testProcessSupervisorBinary } from "../../guardian/build.ts";
import { superviseCommand } from "../../src/process/supervised-run.ts";
import { readTestExecutionConfig } from "../../src/workflow/test-result-collector.ts";

import { asLockDoor, enforceTestRunLock, testFileCountOfArgs, type TestRunLock } from "./test-run-lock.ts";
import { armTestKeyHome } from "../../test/support/test-key-home.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

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
    process.exitCode = 1;
    return;
  }
  // THE ONE INSTRUMENT LOCK: a run of the configured number of test files or
  // more (the guards: a few hundred) waits for it, saying who holds it; a
  // targeted run of fewer takes nothing.
  const lock: TestRunLock = await enforceTestRunLock(runner, { testFileCount: testFileCountOfArgs(process.argv.slice(2)) });
  armTestKeyHome();
  // UNDER THE NATIVE SUPERVISOR (adopted into the lock this door holds): a
  // door killed outright leaves its `node --test` stopped with every process
  // it started, and the lock held until that is done — never a run orphaned
  // beside the next holder.
  const { engineSuiteWatchdog } = readTestExecutionConfig(fileURLToPath(new URL("../../", import.meta.url)));
  const run = await superviseCommand({
    supervisor: testProcessSupervisorBinary(),
    command: process.execPath,
    args: ["--experimental-strip-types", "--test", ...process.argv.slice(2)],
    hardCeilingMs: engineSuiteWatchdog.hardCeilingMs,
    killGraceMs: engineSuiteWatchdog.killGraceMs,
    onStdout: (chunk) => process.stdout.write(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
    killOnInterrupt: true,
  });
  lock.release();
  if (run.ending !== "exited") {
    process.stderr.write(`[test-guards] node --test ended by ${run.ending}${run.signal === null ? "" : ` (${run.signal})`}\n`);
    process.exitCode = 1;
    return;
  }
  // The exit code is set and the loop drains: `process.exit()` can deadlock at shutdown (Node #54918, #351).
  process.exitCode = run.exitCode;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const interrupted = await asLockDoor(main);
  if (interrupted !== null) process.exitCode = interrupted;
}
