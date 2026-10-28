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

import { globSync, statSync } from "node:fs";

import { InputError } from "../../src/kernel/errors.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureTestProcessSupervisor } from "../../guardian/build.ts";
import { superviseCommand } from "../../src/process/supervised-run.ts";
import { readTestExecutionConfig } from "../../src/workflow/test-result-collector.ts";

import { engineTestBoundsFrom, engineTestBoundsImport } from "./engine-test-bounds.ts";
import { enforceTestRunLock, testFileCountOfArgs, type TestRunLock } from "./test-run-lock.ts";
import { armTestKeyHome } from "../../test/support/test-key-home.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

/**
 * The test files the arguments name, absolute: a file as given, or what a
 * glob matches (node --test expands a glob itself, the same way); flags are
 * skipped. A FOLDER is refused, typed: node 24 does not expand one (it
 * reports the folder as a failing test), so it names no file to bound. The
 * bounds install only in these files' processes, never in a process they
 * start.
 */
export function testFilesNamed(args: readonly string[], cwd: string): readonly string[] {
  const files = new Set<string>();
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    const path = resolve(cwd, arg);
    const facts = statSync(path, { throwIfNoEntry: false });
    if (facts?.isFile() === true) files.add(path);
    else if (facts?.isDirectory() === true) {
      throw new InputError(`${arg} is a folder: node --test does not expand a folder, so name its test files or a glob of them`, "test_guards_folder_argument");
    } else {
      for (const found of globSync(arg, { cwd })) files.add(resolve(cwd, found));
    }
  }
  return [...files].toSorted();
}

/**
 * The files this door runs, or a typed refusal when the arguments name NONE:
 * node --test would then discover its whole default set itself, and none of
 * those files would run under the suite's bounds (a flags-only run such as
 * `--test-name-pattern=x`, or no argument at all). Never an unbounded run.
 */
export function boundedTestFiles(args: readonly string[], cwd: string): readonly string[] {
  const files = testFilesNamed(args, cwd);
  if (files.length === 0) {
    throw new InputError(
      "the test door requires an explicit test file or pattern: with none, node --test discovers its whole default set itself, " +
        "outside the suite's bounds (and fails on the non-test .mjs scripts under verification/). " +
        "Name the files, e.g. `test/editor/binary-guard.test.ts`, or a glob of them.",
      "test_guards_no_test_file",
    );
  }
  return files;
}

export async function main(): Promise<void> {
  const runner = `engine ${process.env.npm_lifecycle_event ?? "node --test"}`;
  // THE FILES FIRST, and none is a refusal (`boundedTestFiles`): every file
  // this door runs runs under the suite's bounds, and node --test never
  // discovers files of its own.
  let files: readonly string[];
  try {
    files = boundedTestFiles(process.argv.slice(2), process.cwd());
  } catch (error) {
    process.stderr.write(`[test-guards] ${error instanceof Error ? error.message : String(error)}\n`);
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
  const engineRoot = fileURLToPath(new URL("../../", import.meta.url));
  const testExecution = readTestExecutionConfig(engineRoot);
  const { engineSuiteWatchdog } = testExecution;
  // THE SUITE'S OWN BOUNDS (engine-test-bounds.ts, the one construction): every
  // test file this door runs is judged by its CPU work against its class and
  // ended only by the hang backstop, exactly as in the suite. A targeted run
  // used to run with neither, so a CPU-class failure could never be seen —
  // nor reproduced through `harness flake reproduce`, which runs here.
  const bounds = { ...engineTestBoundsFrom(testExecution, engineRoot), files };
  // A runner builds the supervisor before its run (make's incremental check); every caller inside the run resolves it.
  const supervisor = ensureTestProcessSupervisor();
  const run = await superviseCommand({
    supervisor,
    command: process.execPath,
    // `--test-timeout` IS the backstop, as the suite's `run({ timeout })` is:
    // node:test arms it per test, and the bounds both require it and refuse any other.
    args: ["--experimental-strip-types", engineTestBoundsImport(bounds), "--test", `--test-timeout=${String(bounds.hangBackstopMs)}`, ...process.argv.slice(2)],
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
  process.exitCode = run.exitCode;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  await main();
}
