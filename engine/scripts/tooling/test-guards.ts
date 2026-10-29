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

import { globSync, lstatSync, realpathSync, statSync } from "node:fs";

import { InputError } from "../../src/kernel/errors.ts";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureTestProcessSupervisor } from "../../guardian/build.ts";
import { testRunSuiteOf } from "../../src/filesystem/checkout-write-door.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { repositoryToplevel } from "../../src/git/repository-ownership.ts";
import { gitOutput, type GitRepository } from "../../src/git/tree-reader.ts";
import { configuredGitRepository } from "../../src/git/worktree-port.ts";
import { runTestCommand, superviseCommand } from "../../src/process/supervised-run.ts";
import { readTestExecutionConfig } from "../../src/workflow/test-result-collector.ts";

import { engineTestBoundsFrom, engineTestBoundsImport, type EngineTestBounds } from "./engine-test-bounds.ts";
import { enforceTestRunLock, type TestRunLock } from "./test-run-lock.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

const ENGINE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The run's key-home preload (`node --import`): armed INSIDE the run, in its own scratch; each file inherits it. */
/** The node flags that load a module (the checkout write door's one list). */
const LIVE_RUN_FLAGS: ReadonlySet<string> = new Set(ROOT_POLICY.verification.checkoutWriteDoor.liveRunFlags);

const KEY_HOME_PRELOAD = fileURLToPath(new URL("../../test/support/arm-test-key-home.ts", import.meta.url));

/**
 * The flags node --test takes with NO value, which the door passes as they
 * are. Every other flag must carry its value in the same token
 * (`--name=value`): a value in the NEXT token would otherwise read as a test
 * file to bound while node reads it as the flag's value — and node, left with
 * no file, discovers its whole default set unbounded (`--import ./x.mjs`).
 */
const NODE_TEST_BOOLEAN_FLAGS = new Set(["--test-only", "--test-force-exit", "--test-randomize", "--test-update-snapshots", "--experimental-test-coverage", "--experimental-test-module-mocks", "--experimental-test-snapshots"]);

/**
 * The run the door hands node, EXACTLY: the flags as given, each either a
 * known boolean or `--name=value`, and the test files, absolute — a file as
 * given, or what a glob matches (expanded here, so node receives the very
 * files the door bounds). Refused, typed:
 *  - a flag whose value would sit in the next token (`test_guards_flag_value`);
 *  - a FOLDER: node 24 does not expand one, it reports the folder as a failing
 *    test (`test_guards_folder_argument`);
 *  - a pattern that names no file (`test_guards_pattern_unmatched`);
 *  - a run that names no file at all: node --test would then discover its
 *    whole default set itself, outside the bounds (`test_guards_no_test_file`).
 */
export function doorRun(args: readonly string[], cwd: string): Readonly<{ flags: readonly string[]; files: readonly string[] }> {
  const flags: string[] = [];
  const files = new Set<string>();
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && !NODE_TEST_BOOLEAN_FLAGS.has(arg)) {
        throw new InputError(`${arg}: write a flag's value in the same argument (${arg}=<value>); a value in the next argument would be read as a test file here and as the flag's value by node`, "test_guards_flag_value");
      }
      flags.push(arg);
      continue;
    }
    const path = resolve(cwd, arg);
    const facts = statSync(path, { throwIfNoEntry: false });
    if (facts?.isFile() === true) files.add(path);
    else if (facts?.isDirectory() === true) {
      throw new InputError(`${arg} is a folder: node --test does not expand a folder, so name its test files or a glob of them`, "test_guards_folder_argument");
    } else {
      const matched = globSync(arg, { cwd }).map((found) => resolve(cwd, found));
      if (matched.length === 0) throw new InputError(`${arg} names no test file`, "test_guards_pattern_unmatched");
      for (const found of matched) files.add(found);
    }
  }
  if (files.size === 0) {
    throw new InputError(
      "the test door requires an explicit test file or pattern: with none, node --test discovers its whole default set itself, " +
        "outside the suite's bounds (and fails on the non-test .mjs scripts under verification/). " +
        "Name the files, e.g. `test/editor/binary-guard.test.ts`, or a glob of them.",
      "test_guards_no_test_file",
    );
  }
  return { flags, files: [...files].toSorted() };
}

/**
 * THE ARGV the door hands node, EXACTLY and nothing else: the key-home
 * preload, the bounds' preload, `--test` with the backstop as its per-test timeout, the door's
 * flags, then the very files it bounds — never the arguments it was given.
 */
export function doorNodeArgs(bounds: EngineTestBounds, door: ReturnType<typeof doorRun>): readonly string[] {
  // The run's key home is armed INSIDE the run, by a preload of the `node --test` process (each file inherits it).
  return ["--experimental-strip-types", `--import=${KEY_HOME_PRELOAD}`, engineTestBoundsImport(bounds), "--test", `--test-timeout=${String(bounds.hangBackstopMs)}`, ...door.flags, ...door.files];
}

export async function main(): Promise<void> {
  const runner = `engine ${process.env.npm_lifecycle_event ?? "node --test"}`;
  // THE FILES FIRST, and none is a refusal (`boundedTestFiles`): every file
  // this door runs runs under the suite's bounds, and node --test never
  // discovers files of its own.
  let door: ReturnType<typeof doorRun>;
  try {
    door = doorRun(process.argv.slice(2), process.cwd());
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
  // WHICH SUITE, from the very files node will run (the write door's `testRunSuiteOf`): the live suite
  // (`engine/live/`, unconfined by design: real host facts) only when every file lies there; a mixed run is refused,
  // so a hermetic file never rides along unconfined.
  const suite = testRunSuiteOf(door.files, join(ENGINE_ROOT, "live"));
  if (typeof suite !== "string") {
    process.stderr.write(`[test-guards] REFUSED (${suite.refused})\n`);
    process.exitCode = 1;
    return;
  }
  // A live run is unconfined: any flag that could load a module of the caller's choosing (`--import=<a hermetic test>`,
  // `--env-file` holding NODE_OPTIONS, `--experimental-config-file`) would run code outside the live suite unconfined
  // beside it. So a live run takes only the flags that select tests (an allow list), and every other is refused.
  const unlisted = door.flags.filter((flag) => !LIVE_RUN_FLAGS.has(flag.split("=", 1)[0]!));
  if (suite === "live" && unlisted.length > 0) {
    process.stderr.write(`[test-guards] REFUSED (test_live_suite_flag: a live run is unconfined and takes only ${[...LIVE_RUN_FLAGS].join(", ")}: ${unlisted.join(" ")})\n`);
    process.exitCode = 1;
    return;
  }
  // A live run is unconfined, so its files are the REVIEWED live set only: each committed (through the hooks, where the
  // pinned live set is checked), byte-for-byte its committed content, and of one name (never a hard link of a hermetic
  // test). An untracked copy, an edited file or a link is refused here, before anything runs (review of #634, #14).
  if (suite === "live") {
    const unreviewed = unreviewedLiveFiles(configuredGitRepository({}, ENGINE_ROOT), door.files);
    if (unreviewed.length > 0) {
      process.stderr.write(`[test-guards] REFUSED (test_live_suite_unreviewed: a live run is unconfined and runs only the committed live set; commit the file first:\n${unreviewed.map((line) => `  ${line}`).join("\n")})\n`);
      process.exitCode = 1;
      return;
    }
  }
  const lock: TestRunLock = enforceTestRunLock(runner, { testFileCount: door.files.length });
  // UNDER THE NATIVE SUPERVISOR (adopted into the run this door admitted): a
  // door killed outright leaves its `node --test` stopped with every process
  // it started, and the lock held until that is done — never a run orphaned
  // beside the next holder.
  const engineRoot = ENGINE_ROOT;
  const testExecution = readTestExecutionConfig(engineRoot);
  const { engineSuiteWatchdog } = testExecution;
  // THE SUITE'S OWN BOUNDS (engine-test-bounds.ts, the one construction): every
  // test file this door runs is judged by its CPU work against its class and
  // ended only by the hang backstop, exactly as in the suite. A targeted run
  // used to run with neither, so a CPU-class failure could never be seen —
  // nor reproduced through `harness flake reproduce`, which runs here.
  const bounds = { ...engineTestBoundsFrom(testExecution, engineRoot), files: door.files };
  // A runner builds the supervisor before its run (make's incremental check); every caller inside the run resolves it.
  const supervisor = ensureTestProcessSupervisor();
  const command = {
    supervisor,
    command: process.execPath,
    // `--test-timeout` IS the backstop, as the suite's `run({ timeout })` is:
    // node:test arms it per test, and the bounds both require it and refuse any other.
    args: doorNodeArgs(bounds, door),
    hardCeilingMs: engineSuiteWatchdog.hardCeilingMs,
    killGraceMs: engineSuiteWatchdog.killGraceMs,
    onStdout: (chunk: Buffer) => process.stdout.write(chunk),
    onStderr: (chunk: Buffer) => process.stderr.write(chunk),
    killOnInterrupt: true,
  };
  // Through the one test-execution door, confined — except the LIVE suite, unconfined by design (real host facts:
  // decision TEST-CONFINEMENT-SELF-BIND), the one declared exception.
  // The live child gets no NODE_OPTIONS of its caller's: an inherited `--import=` would load a module unconfined.
  const run = suite === "live"
    ? await superviseCommand({ ...command, env: withoutNodeOptions(process.env) })
    : await runTestCommand({ ...command, checkout: repositoryToplevel(ENGINE_ROOT, "directory") ?? ENGINE_ROOT });
  // The run's own failure rides along if its run was cut at the memory cap (InstrumentHold.release).
  lock.release(run.ending === "exited" && run.exitCode === 0 ? undefined : `node --test ended ${run.ending}${run.signal === null ? "" : ` (${run.signal})`} with exit code ${String(run.exitCode)}`);
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

/**
 * The live files of `files` that are NOT the reviewed live set, each with why: not committed at HEAD, not its
 * committed content, or a file of more than one name (a hard link aliasing another test). Empty when every file is the
 * committed one.
 */
export function unreviewedLiveFiles(repository: GitRepository, files: readonly string[]): readonly string[] {
  const top = gitOutput(repository, ["rev-parse", "--show-toplevel"]).stdout.toString("utf8").trim();
  return files.flatMap((file) => {
    const path = realpathSync(file);
    const named = relative(top, path).split(sep).join("/");
    if (lstatSync(path).nlink > 1) return [`${named}: has more than one name (a hard link)`];
    // `<mode> blob <oid>\t<path>` when HEAD holds it (the path from the top, taken literally), nothing when it does not.
    const entry = gitOutput(repository, ["--literal-pathspecs", "ls-tree", "--full-tree", "HEAD", "--", named]).stdout.toString("utf8");
    const committed = /^\d+ blob ([0-9a-f]+)\t/u.exec(entry)?.[1];
    if (committed === undefined) return [`${named}: not committed`];
    const present = gitOutput(repository, ["hash-object", "--", path]).stdout.toString("utf8").trim();
    return present === committed ? [] : [`${named}: differs from its committed content`];
  });
}

/** `environment` without NODE_OPTIONS: what an unconfined live run's node is started with (round 3, must-fix 2). */
export function withoutNodeOptions(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => name !== "NODE_OPTIONS"));
}
