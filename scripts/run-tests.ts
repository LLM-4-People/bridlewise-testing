/**
 * THE TEST RUN'S WATCHDOG — a clock held by a process that is not the one
 * being watched, judging PROGRESS rather than elapsed time.
 *
 * ── WHAT HAPPENED, MEASURED ────────────────────────────────────────────────
 *
 * Six orphaned vitest workers ran `artifact-runtime-errors.test.ts` at ~102%
 * CPU EACH for up to 1h16m, long after the agent that spawned them had
 * finished — roughly 600% of a twelve-core machine. They corrupted every
 * measurement taken that day. The cause was a mutation that raised a cap and
 * turned `for (i < CAP + 3)` into a spin.
 *
 * ── WHY NO IN-RUNTIME TIMEOUT COULD HAVE SAVED IT ──────────────────────────
 *
 * This is the part that is easy to get wrong, and getting it wrong produces a
 * fix that looks complete and stops nothing.
 *
 * The hang was SYNCHRONOUS. A `for` loop with no exit blocks its worker
 * outright. Vitest's `testTimeout` is a timer, and a timer is a callback
 * waiting for a turn on an event loop that will never yield again — so the
 * mechanism that would kill the test cannot run, precisely when it is needed.
 * The same is true of `hookTimeout`, of an `AbortSignal`, and of any watchdog
 * living inside the runtime. They all require the hung process to cooperate.
 *
 * Only something that does NOT need its cooperation can end it: a different
 * process, holding a clock and a PID. That is this file. It is the only layer
 * effective against a synchronous spin, which is why it is layer one and the
 * `testTimeout` in `vitest.config.ts` is layer three.
 *
 * ── WHAT IT ACTUALLY DOES ──────────────────────────────────────────────────
 *
 *   1. REAPS ORPHANS first. A previous run's orphans are still burning CPU and
 *      would make this run's measurements meaningless — and its own budget
 *      wrong, since a loaded machine is slower. Only ORPHANED vitest processes
 *      (PPID 1) from THIS project directory are touched: a live run belonging
 *      to someone else on the same machine is never disturbed.
 *   2. RUNS vitest under the NATIVE SUPERVISOR (`tests/helpers/test-process-
 *      supervisor.c`, built by `engine/guardian/build.ts`): a Linux child
 *      subreaper holding pidfds, so EVERY descendant — a detached one, one
 *      that called `setsid`, one whose parent already exited — is re-parented
 *      to it and killed when the run ends. Killing a process group left a
 *      detached spinner running at 100% CPU (wf1a-correctness §7).
 *   3. KILLS on a STALL: no output at all for `stallTimeoutMs`
 *      (`testExecution.webSuiteWatchdog`). A fixed 180 s wall clock used to be
 *      the trigger, and on a loaded shared machine it killed healthy runs
 *      that were merely slow — a spun suite and a slow one differ in that the
 *      spun one stops PRINTING. The supervisor is told (SIGTERM) and kills the
 *      command and every descendant with SIGKILL, because a spun worker cannot
 *      run a SIGTERM handler either: a signal handler is JavaScript, and
 *      JavaScript is what is stuck.
 *   4. KILLS at the HARD CEILING (`hardCeilingMs`), whatever the load: a run
 *      that prints forever still ends. The supervisor's own clock enforces
 *      it, so a blocked Node loop here cannot stop it.
 *   5. EXITS non-zero and says why when it killed the run, so a killed run is
 *      a FAILED run and never a silent pass. There is no wall-clock verdict:
 *      whether the suite got slower is the CPU budget's judgment.
 *
 * Usage: `npm test` (any arguments are passed through to vitest).
 */

import { testProcessSupervisorBinary } from "../engine/guardian/build.ts";
import { superviseCommand, supervisedEndingLines, type SupervisedCommand } from "../engine/src/process/supervised-run.ts";
import { reportLauncherStop, watchLauncher } from "../engine/scripts/tooling/launcher-watch.ts";
import { sweepEndedRunTemporaries, temporaryRootHeadroom, temporaryRootKeepOutRefusal, temporaryRootPreflightLine } from "../engine/src/filesystem/temporary-root.ts";
import { fileURLToPath } from "node:url";
import type { SuiteWatchdog } from "../engine/src/workflow/workflow-config.ts";
import { allProcessIds, commandLineOf, parentOf, processGroupOf, workingDirectoryOf } from "../engine/src/process/process-facts.ts";
import { readWebSuiteWatchdog } from "../tests/helpers/budget-config.ts";
import { ROOT_POLICY } from "../engine/src/kernel/root-policy.ts";
import { bootstrapProcess, isEntryPoint } from "../engine/src/runtime/cli-debug.ts";
import { supervisedCommandOutcome, finalizeQualifiedRun, qualificationInvocation, qualificationTerminal, runForInvocation, QUALIFICATION_INVOCATION_ENV, WEB_RUN_HISTORY_PATH } from "../engine/src/shared/run-history.ts";
import { readMeasuredTree } from "../engine/src/shared/tree-identity.ts";
import { enforceTestRunLock, testFileCountOfArgs } from "../engine/scripts/tooling/test-run-lock.ts";
import { resolve } from "node:path";

const projectDir = process.cwd();

/**
 * The command-line fragment that identifies a REAL vitest process.
 *
 * NOT the bare word "vitest", and this is not pedantry — it was measured, by
 * the old stray reaper killing the shell that invoked it. `pgrep -f vitest` matches
 * anything whose command line contains the string, which includes
 * `grep -i vitest`, an editor with the word in a filename, and the very shell
 * running `npm test 2>&1 | grep vitest`. All of those had this project as
 * their cwd, so the cwd check did not save them.
 *
 * A real vitest is always launched from the installed package, so the path
 * fragment is the honest identifier — `node_modules/vitest/…` covers both the
 * runner and its `dist/workers/forks.js` children.
 */
const VITEST_CMDLINE_MARK = "node_modules/vitest";

/**
 * NAME vitest processes left over from an earlier run of THIS project —
 * never kill them (KILL-OWNED-ONLY, UR-18): a stray was not spawned by this
 * run, so this run does not stop it. It reaped them once (SIGKILL) and a
 * neighbour's process was killed by a stop that took it for its own
 * (2026-10-08); the run now says what it found, and the run or terminal that
 * started a stray stops it.
 *
 * "STRAY" MEANS ORPHANED: another vitest may legitimately run in this same
 * directory — a second agent, a watch mode, a colleague's terminal. The
 * distinguishing fact is whether the process still has a living parent: an
 * orphan has been reparented to init (PPID 1); a live run has not.
 *
 * Scoped five ways:
 *   - the command line must name the INSTALLED vitest, not merely mention the
 *     word (see `VITEST_CMDLINE_MARK`);
 *   - it must be ORPHANED (PPID 1) — never someone's live run;
 *   - the process's working directory must be this project;
 *   - it must not be this process;
 *   - it must not be in this process's own group (the launcher's pipeline).
 */
export function strayVitest(
  listPids: () => readonly number[] = listVitestPids,
  cwdOf: (pid: number) => string | null = cwdOfPid,
  selfPid: number = process.pid,
  cmdlineOf: (pid: number) => string = cmdlineOfPid,
  groupOf: (pid: number) => number | null = pgidOfPid,
  parentOf: (pid: number) => number | null = ppidOfPid,
): number[] {
  const strays: number[] = [];
  const ownGroup = groupOf(selfPid);
  for (const pid of listPids()) {
    if (pid === selfPid) continue;
    if (ownGroup !== null && groupOf(pid) === ownGroup) continue;
    if (!cmdlineOf(pid).includes(VITEST_CMDLINE_MARK)) continue;
    if (parentOf(pid) !== 1) continue;
    if (cwdOf(pid) !== projectDir) continue;
    strays.push(pid);
  }
  return strays;
}

/** Every live process whose command line names the installed vitest (procfs, through the one process-facts reader). */
function listVitestPids(): number[] {
  return allProcessIds().filter((pid) => cmdlineOfPid(pid).includes(VITEST_CMDLINE_MARK));
}

function cmdlineOfPid(pid: number): string {
  return (commandLineOf(pid) ?? []).join(" ");
}

function ppidOfPid(pid: number): number | null {
  return parentOf(pid) ?? null;
}

function pgidOfPid(pid: number): number | null {
  // `process.getpgid` DOES NOT EXIST in Node, so an earlier version's optional
  // call was always undefined and the "never our own process group" check
  // never fired (found by putting scripts/ into a TypeScript program). The
  // group comes from procfs, parsed after the last `)` of the stat line.
  return processGroupOf(pid) ?? null;
}

function cwdOfPid(pid: number): string | null {
  // `/proc/<pid>/cwd` is what makes "only this project's strays" mechanical
  // rather than a guess at the command line's shape.
  return workingDirectoryOf(pid) ?? null;
}

/** How often the supervision looks at its launcher. */
const WATCH_INTERVAL_MS = ROOT_POLICY.verification.testRunSupervision.watchIntervalMs;

export type SupervisedRun = Readonly<{
  exitCode: number;
  /**
   * Why the run ended: the command's own exit, a stall kill, the hard
   * ceiling, a signal, a supervisor that left no receipt, or the LAUNCHER
   * (the `npm test` wrapper) exiting — the run is stopped with everything it
   * started, never left running as an orphan.
   */
  ending: "exited" | "stalled" | "ceiling" | "signal" | "unverified" | "launcher-exited";
  elapsedMs: number;
  /** Descendants still running when the run ended, killed by the supervisor (detached ones included). */
  killedDescendants: readonly number[];
  /** The complete native result, retained for current qualification. */
  terminal: SupervisedCommand;
}>;

/**
 * Runs `command` (vitest) under the ONE supervisor (`engine/src/process/supervised-run.ts`),
 * forwarding its output, and ends it — with every descendant — when it prints
 * nothing for `stallTimeoutMs` or reaches `hardCeilingMs`, or
 * (`stopWhenLauncherExits`) when the process that launched THIS one exits: a
 * SIGTERM to the `npm test` wrapper used to leave the runner orphaned,
 * running the whole suite to its end while the wrapper had already reported
 * 143 (step6-readiness-2 F-11).
 */
export async function superviseRun(
  command: string,
  args: readonly string[],
  watchdog: SuiteWatchdog,
  options: Readonly<{ watchIntervalMs?: number; write?: (text: string) => void; killOnInterrupt?: boolean; stopWhenLauncherExits?: boolean; environment?: Readonly<NodeJS.ProcessEnv> }> = {},
): Promise<SupervisedRun> {
  const write = options.write ?? ((text: string) => process.stderr.write(text));
  const stop = new AbortController();
  let launcherExited: number | undefined;
  const stopLauncherWatch = options.stopWhenLauncherExits === true
    ? watchLauncher((launcher) => {
      launcherExited = launcher;
      write(`\n[run-tests] the process that launched this run (pid ${String(launcher)}) exited: stopping the run and every process it started.\n`);
      stop.abort();
    }, options.watchIntervalMs ?? WATCH_INTERVAL_MS)
    : () => undefined;
  const run = await superviseCommand({
    supervisor: testProcessSupervisorBinary(),
    command,
    args,
    hardCeilingMs: watchdog.hardCeilingMs,
    stallTimeoutMs: watchdog.stallTimeoutMs,
    killGraceMs: watchdog.killGraceMs,
    ...(options.watchIntervalMs === undefined ? {} : { watchIntervalMs: options.watchIntervalMs }),
    // Output is piped for the stall clock; keep vitest's colours for a human.
    env: process.stdout.isTTY === true ? { ...(options.environment ?? process.env), FORCE_COLOR: "1" } : options.environment ?? process.env,
    onStdout: (chunk) => process.stdout.write(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
    stop: stop.signal,
    ...(options.killOnInterrupt === undefined ? {} : { killOnInterrupt: options.killOnInterrupt }),
  });
  stopLauncherWatch();
  const killedDescendants = (run.supervision?.reaped ?? []).filter((entry) => entry.killed).map((entry) => entry.pid);
  const ended = (ending: SupervisedRun["ending"], exitCode = 1): SupervisedRun => ({ exitCode, ending, elapsedMs: run.elapsedMs, killedDescendants, terminal: run });
  if (run.ending === "unverified") {
    write(`[run-tests] the native supervisor ended without a receipt; ${run.orphanedGroupKilled ? "its command's process group was killed; " : ""}the run is not certified\n`);
    return ended("unverified");
  }
  for (const line of supervisedEndingLines(run, watchdog.hardCeilingMs)) write(`${line}\n`);
  // A run we killed is a FAILED run. Reporting the command's own exit code
  // here would let a stall kill masquerade as a pass.
  if (launcherExited !== undefined) {
    reportLauncherStop(launcherExited, run.elapsedMs, write);
    return ended("launcher-exited");
  }
  switch (run.ending) {
    case "stalled":
      write(
        `\n[run-tests] STALLED: no output for ${String(watchdog.stallTimeoutMs)}ms.\n` +
          `[run-tests] The run and every process it started were killed. A synchronous\n` +
          `[run-tests] infinite loop cannot be interrupted from inside the runtime, so\n` +
          `[run-tests] this is the only layer that can end it. See tests/test-budget.ts.\n`,
      );
      return ended("stalled");
    case "ceiling":
      return ended("ceiling");
    case "stopped":
    case "signal":
      write(`[run-tests] vitest terminated (${run.supervision?.interrupted === true || run.ending === "stopped" ? "interrupted" : `signal ${String(-(run.status ?? 0))}`})\n`);
      return ended("signal");
    case "exited":
      return ended("exited", run.exitCode);
  }
}

async function main(): Promise<void> {
  process.stderr.write(`${temporaryRootPreflightLine("run-tests", temporaryRootHeadroom())}\n`);
  const keptOut = temporaryRootKeepOutRefusal(fileURLToPath(new URL("../engine/", import.meta.url)));
  if (keptOut !== undefined) {
    process.stderr.write(`[run-tests] REFUSED (temporary_root_kept_out) — ${keptOut}\n`);
    process.exit(1);
  }
  const watchdog = readWebSuiteWatchdog();
  if ("missing" in watchdog) {
    process.stderr.write(`[run-tests] ${watchdog.missing}\n`);
    process.exit(1);
  }
  const strays = strayVitest();
  if (strays.length > 0) {
    process.stdout.write(
      `[run-tests] ${String(strays.length)} orphaned vitest process(es) of this project are still running (not stopped: this run did not start them): ${strays.join(", ")}\n`,
    );
  }
  // THE HOST'S ONE INSTRUMENT LOCK (engine/src/process/instrument-lock.ts):
  // the whole web suite (or any run of the configured number of files) waits
  // for it, saying who holds it; a targeted run of fewer files takes nothing.
  // vitest's own global setup then runs inside this hold, and the supervisor
  // that runs vitest is adopted into it.
  const instrumentLock = enforceTestRunLock("web npm test", { testFileCount: testFileCountOfArgs(process.argv.slice(2)) });
  const invocationId = qualificationInvocation(process.env);
  const tree = readMeasuredTree(projectDir);
  const run = await superviseRun("npx", ["vitest", "run", ...process.argv.slice(2)], watchdog, {
    killOnInterrupt: true, stopWhenLauncherExits: true,
    environment: { ...process.env, [QUALIFICATION_INVOCATION_ENV]: invocationId },
  });
  process.stderr.write(`${sweepEndedRunTemporaries("run-tests")}\n`);
  const completion = supervisedCommandOutcome(run.terminal, "web test command");
  if (completion.kind !== "pass") process.stderr.write(`[run-tests] ${completion.message}\n`);
  const history = resolve(projectDir, WEB_RUN_HISTORY_PATH);
  // A focused/cold run legitimately has no numeric row. A workspace suite
  // gate refuses that absence; this wrapper never fabricates a measurement.
  if (runForInvocation(history, invocationId) !== undefined) {
    if (tree === null || readMeasuredTree(projectDir) !== tree) {
      process.stderr.write("[run-tests] current qualification tree changed or is unreadable\n");
      process.exit(1);
    }
    try { finalizeQualifiedRun(history, invocationId, tree, qualificationTerminal(invocationId, tree, run.terminal, run.ending)); }
    catch {
      process.stderr.write("[run-tests] current qualification finalization refused\n");
      process.exit(1);
    }
  }
  instrumentLock.release();
  process.exit(completion.kind === "pass" ? run.exitCode : 1);
}

// Only run when invoked as a script, so the tests above can import the
// stray finder without launching a suite.
if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  await main();
}
