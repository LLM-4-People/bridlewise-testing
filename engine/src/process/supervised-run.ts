/**
 * THE ONE PROCESS SUPERVISOR OF A TEST RUN — the web suite's and the engine
 * suite's, and every nested runner a test launches.
 *
 * A clock and a PID held by a process that is not the one being watched: the
 * native primitive (`engine/guardian/test-process-supervisor.c`, built by
 * `engine/guardian/build.ts`) is a Linux child subreaper holding pidfds, so
 * EVERY descendant of the command — a detached one, one that called `setsid`,
 * one whose parent already exited — is re-parented to it and killed when the
 * command ends, is stopped, or reaches its hard ceiling; if the supervisor
 * itself dies, the command dies with it (a parent-death signal) and the
 * command's process group is ended here. No in-runtime timeout can do this:
 * a synchronous spin blocks the very event loop its timer would need.
 *
 * - {@link superviseCommand}: the asynchronous run (both suites' runners): the
 *   output forwarded to the caller's sinks, a STALL clock (no output for
 *   `stallTimeoutMs`), an external stop, and the receipt.
 * - {@link runBoundedTestProcess}: the synchronous bounded launch a test makes
 *   of a nested runner, with the same receipt.
 * - {@link readSupervisorReceipt}: the fd-3 receipt, read and CHECKED one way.
 * - {@link startDetached}: the ONE launch that is deliberately NOT supervised —
 *   a background run that must outlive the process starting it (the promotion
 *   trigger's unattended run), in a session of its own with none of this
 *   process's stdio; it bounds its own work (its commands are supervised).
 *
 * The native binary is built by the caller (`ensureTestProcessSupervisor()`,
 * `engine/guardian/build.ts`) and
 * handed in: this layer runs processes, it builds nothing.
 *
 * - {@link runTestCommand}: THE ONE TEST-EXECUTION DOOR — {@link superviseCommand}
 *   with the run CONFINED, always: the whole filesystem read-only to the
 *   command and every descendant but its own per-run scratch root and the
 *   checkout's declared writable places (decision TEST-CONFINEMENT-SELF-BIND).
 *   Every route that runs tests goes through it; {@link superviseCommand}
 *   itself runs the trusted, non-test commands (a checkout's setup, a build).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { checkoutConfinementPlaces, closeTestRunScratch, openTestRunScratch, testRunEnvironment } from "../filesystem/checkout-write-door.ts";
import { HarnessError, InputError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { isProcessGroupAlive, ownedAnnouncement, procfsDocument, terminate, type ProcessIdentity } from "./process-facts.ts";
import { adoptIntoOwnedInstrumentLock } from "./instrument-lock-adoption.ts";
import { guarded } from "./fault-policy.ts";

/** The signal a receipt's negative status names (`-15` → `SIGTERM`), or null for an exit status. */
function signalOfStatus(status: number): NodeJS.Signals | null {
  if (status >= 0) return null;
  return (Object.entries(constants.signals).find(([, number]) => number === -status)?.[0] as NodeJS.Signals | undefined) ?? null;
}

/** The receipt the native supervisor writes when it closes cleanly. */
export type TestProcessSupervision = Readonly<{
  commandPid: number;
  /** The command's exit status, or minus its terminating signal. */
  status: number;
  timedOut: boolean;
  interrupted: boolean;
  reaped: readonly Readonly<{ pid: number; status: number; killed: boolean }>[];
  commandKilled: boolean;
  waitedCpuUs: number;
  supervisorCpuUsBeforeReceipt: number;
  /** Every process it killed: the command (when killed) and each killed descendant. */
  killed: readonly number[];
  noOwnedChildren: boolean;
  /**
   * The confined run's cgroup layout (decision TEST-CONFINEMENT-SELF-BIND, the run's cgroup): `own-leaf` when its
   * cgroup namespace was rooted at a leaf of its own (worker leaves below were the run's to make), `started-cgroup`
   * when it rooted where it started (a cgroup the user does not own: no worker leaves), null for an unconfined command.
   */
  runCgroup: "own-leaf" | "started-cgroup" | null;
}>;

const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** The receipt line, checked field by field: a malformed or truncated one is ABSENT, never cast. */
function receiptOf(line: Record<string, unknown>): Omit<TestProcessSupervision, "killed"> | undefined {
  const reaped = line["reaped"];
  if (!isInteger(line["commandPid"]) || !isInteger(line["status"]) || !isBoolean(line["timedOut"]) || !isBoolean(line["interrupted"])
    || !isBoolean(line["commandKilled"]) || !isBoolean(line["noOwnedChildren"]) || !isInteger(line["waitedCpuUs"])
    || !isInteger(line["supervisorCpuUsBeforeReceipt"]) || !Array.isArray(reaped)
    || !(line["runCgroup"] === null || line["runCgroup"] === "own-leaf" || line["runCgroup"] === "started-cgroup")) return undefined;
  const children = reaped.map((entry: unknown) => {
    const child = entry as Record<string, unknown> | null;
    return child !== null && typeof child === "object" && isInteger(child["pid"]) && isInteger(child["status"]) && isBoolean(child["killed"])
      ? Object.freeze({ pid: child["pid"], status: child["status"], killed: child["killed"] }) : undefined;
  });
  if (children.some((child) => child === undefined)) return undefined;
  return {
    commandPid: line["commandPid"], status: line["status"], timedOut: line["timedOut"], interrupted: line["interrupted"],
    reaped: Object.freeze(children as NonNullable<(typeof children)[number]>[]), commandKilled: line["commandKilled"],
    waitedCpuUs: line["waitedCpuUs"], supervisorCpuUsBeforeReceipt: line["supervisorCpuUsBeforeReceipt"], noOwnedChildren: line["noOwnedChildren"],
    runCgroup: line["runCgroup"],
  };
}

/**
 * THE SUPERVISOR'S RECEIPT, read one way for every caller: the fd-3 stream is
 * an announcement line (`announcedCommandPid`, written before anything can
 * go wrong — the command's pid, which is its process group) followed, on a
 * clean close, by the receipt proper as the LAST line. `receipt` is
 * `undefined` when the supervisor died before writing it, or wrote a line
 * that is not a receipt.
 */
export function readSupervisorReceipt(text: string): Readonly<{ announcedCommandPid: number | undefined; announcedCommand: ProcessIdentity | undefined; receipt: TestProcessSupervision | undefined }> {
  const lines = text.split("\n").filter((line) => line.trim().length > 0).map((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
    } catch {
      // A torn last line is a receipt that was never completed: absence.
      return undefined;
    }
  });
  const announced = lines[0]?.["announcedCommandPid"];
  // The command's start time, read by the supervisor while the command was its unreaped child: the identity a later stop is bound to.
  const announcedStart = lines[0]?.["announcedCommandStartTime"];
  const last = lines.at(-1);
  const receipt = last === undefined ? undefined : receiptOf(last);
  return {
    announcedCommandPid: isInteger(announced) ? announced : undefined,
    announcedCommand: isInteger(announced) && isInteger(announcedStart) ? Object.freeze({ pid: announced, startTime: announcedStart }) : undefined,
    receipt: receipt === undefined ? undefined : Object.freeze({ ...receipt, killed: Object.freeze([
      ...(receipt.commandKilled ? [receipt.commandPid] : []),
      ...receipt.reaped.filter((child) => child.killed).map((child) => child.pid),
    ]) }),
  };
}

/** The supervisor's argument vector: `[--pass-fd] <ceiling ms> <grace ms> <command> [args…]`. */
function supervisorArguments(ceilingMs: number, graceMs: number, command: string, args: readonly string[], passFd: boolean): string[] {
  if (!Number.isFinite(ceilingMs) || ceilingMs <= 0 || !Number.isFinite(graceMs) || graceMs <= 0) {
    throw new InputError("A supervised process needs positive finite bounds", "test_process_bounds_invalid");
  }
  return [...(passFd ? ["--pass-fd"] : []), String(Math.ceil(ceilingMs)), String(Math.ceil(graceMs)), command, ...args];
}

/**
 * THE ONE VITEST COMMAND every vitest route runs through {@link runTestCommand}:
 * node itself on the checkout's vitest entry (no `npx` between: the run's
 * result channel, fd 3, reaches vitest's main process), with vite's
 * config loaded by its module runner (`--configLoader=runner`): the default
 * loader bundles the config into `node_modules/.vite-temp`, a write into the
 * read-only checkout.
 */
export function vitestCommand(checkout: string, args: readonly string[]): readonly [string, readonly string[]] {
  return [process.execPath, [join(checkout, "node_modules", "vitest", "vitest.mjs"), ...args, "--configLoader=runner"]];
}

/**
 * THE CONFINEMENT OF ONE RUN (decision TEST-CONFINEMENT-SELF-BIND; the user's
 * rule that a malicious module cannot bypass core): the supervisor's arguments
 * — the checkout, the run's scratch root and the checkout's declared writable
 * places (the write door's `checkoutConfinementPlaces`, checked there first;
 * the native supervisor checks each again by descriptor and binds it from that
 * descriptor) — PROBED before use, every time: a host or a place that refuses
 * is a typed refusal naming why and the fix, never an unconfined run.
 */
export function testConfinement(supervisor: string, checkout: string, scratch: string): readonly string[] {
  const places = checkoutConfinementPlaces(checkout);
  const args = Object.freeze([
    "--checkout", places.root, "--scratch", scratch,
    ...places.writable.flatMap((place) => ["--writable", place]),
  ]);
  const probe = spawnSync(supervisor, ["--probe-confinement", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (probe.error !== undefined || probe.status !== 0) {
    const said = (probe.stderr || String(probe.error ?? `exit ${String(probe.status)}`)).trim();
    throw new HarnessError(
      `The test confinement refused this run, so no test runs (${said}). ${confinementRemedy(said)}`,
      "test_confinement_unavailable",
    );
  }
  return args;
}

/**
 * The fix for the step the supervisor refused (N9): the user-namespace host
 * fix only when namespaces were refused, the kernel when mount_setattr is
 * missing, the place itself when a writable place was refused.
 */
function confinementRemedy(said: string): string {
  if (/unshare|map this user/u.test(said)) {
    return procfsDocument("sys", "kernel", "apparmor_restrict_unprivileged_userns")?.trim() === "1"
      ? "AppArmor restricts unprivileged user namespaces here; admit them for this checkout's test supervisor alone, once: `node engine/guardian/build.ts --apparmor-install` prints the commands"
      : "Unprivileged user namespaces are not available (check /proc/sys/user/max_user_namespaces and the kernel's user-namespace support).";
  }
  if (/mount_setattr|open_tree|move_mount/u.test(said)) return "The confinement needs Linux 5.12 or later (mount_setattr, open_tree, move_mount).";
  if (/writable place|scratch root|checkout must/u.test(said)) return "Fix the named place (a real directory, at its canonical path, with no hard-linked file beneath it), then run again.";
  return "The step it names failed; the run is refused rather than run unconfined.";
}

/**
 * The supervisor left no receipt: it died before it could kill and reap. Its
 * command died with it (the parent-death signal); whatever the command
 * started and left in the command's process group is ended here. Answers
 * whether a group was killed.
 */
function endOrphanedGroup(announced: ProcessIdentity | undefined): boolean {
  if (announced === undefined || !isProcessGroupAlive(announced.pid)) return false;
  // The one terminator, no grace (SIGKILL sent before it yields): the command's supervisor is gone, nothing to finish for.
  // Owned by the identity the supervisor announced at spawn (pid AND start time): a recycled leader pid is another group.
  void terminate({ group: ownedAnnouncement(announced) }, { graceMs: 0 });
  return true;
}

export type SupervisedCommandOptions = Readonly<{
  /** The native supervisor binary (`ensureTestProcessSupervisor()`). */
  supervisor: string;
  command: string;
  args: readonly string[];
  /** Killed, with every descendant, when still running at this bound, whatever the load. */
  hardCeilingMs: number;
  /** Killed when it prints nothing (stdout or stderr) for this long; no stall clock when absent. */
  stallTimeoutMs?: number;
  /** How long it has after a stop (SIGTERM) before it and every descendant are SIGKILLed (the suite watchdog's `killGraceMs`). */
  killGraceMs: number;
  watchIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Where the command's output goes (each chunk as it arrives). */
  onStdout: (chunk: Buffer) => void;
  onStderr: (chunk: Buffer) => void;
  /**
   * The command reports on its own fd 3 (the engine test worker): the caller's
   * sink receives it (the supervisor passes fd 4 through as the command's fd 3).
   */
  onResult?: (chunk: Buffer) => void;
  /** Aborting it stops the command and every descendant (the supervisor's SIGTERM path). */
  stop?: AbortSignal;
  /** Stops the run when THIS process receives SIGINT, SIGTERM or SIGHUP (an operator's Ctrl-C takes every descendant down too). */
  killOnInterrupt?: boolean;
}>;

export type SupervisedCommand = Readonly<{
  /** The command's own exit code, or 1 for any run this supervision ended (a killed run is a failed run). */
  exitCode: number;
  /** Why it ended: its own exit, a stall kill, the hard ceiling, a stop or signal, or a supervisor that left no receipt. */
  ending: "exited" | "stalled" | "ceiling" | "stopped" | "signal" | "unverified";
  elapsedMs: number;
  /** The receipt; absent only when `ending` is `unverified`. */
  supervision: TestProcessSupervision | undefined;
  /** The command's process group was killed because no receipt came. */
  orphanedGroupKilled: boolean;
  /** The command's own exit status (minus a signal), or null without a receipt. */
  status: number | null;
  /** The signal that ended the command (from the receipt's status), or null. */
  signal: NodeJS.Signals | null;
  /** Every output pipe reached its end (the run settled on `close`, not on the kill grace after `exit`). */
  outputComplete: boolean;
}>;

/**
 * Runs `command` under the native supervisor. It ends — with every
 * descendant — when it exits, prints nothing for `stallTimeoutMs`, reaches
 * `hardCeilingMs`, or is stopped. EXIT-BACKED: the supervisor's own exit
 * settles the run (a descendant holding the pipes cannot keep it open past
 * the kill grace).
 */
export function superviseCommand(options: SupervisedCommandOptions): Promise<SupervisedCommand> {
  return supervise(options, []);
}

/** {@link runTestCommand}'s options: a supervised command's, and the checkout it runs in. */
export type TestCommandOptions = SupervisedCommandOptions & Readonly<{
  /** The checkout the tests are of: read-only to them but its declared writable places. */
  checkout: string;
}>;

/**
 * THE ONE TEST-EXECUTION DOOR: `command` supervised and CONFINED. It gets a
 * fresh scratch root of its own (the write door's `openTestRunScratch`, removed
 * when the run ends, whatever its outcome), its TMPDIR, node compile cache and
 * scratch variable inside it, and sees everything else read-only but
 * the checkout's declared writable places ({@link testConfinement}).
 * Confinement is what this door IS, not an option of it.
 */
export async function runTestCommand(options: TestCommandOptions): Promise<SupervisedCommand> {
  const scratch = openTestRunScratch();
  try {
    const confinement = testConfinement(options.supervisor, options.checkout, scratch.bound);
    return await supervise({ ...options, env: testRunEnvironment(scratch, options.env) }, confinement);
  } finally {
    // Reported BESIDE the run's result (always on), never instead of it: a test cannot trade its verdict for a crash.
    const unremoved = closeTestRunScratch(scratch);
    if (unremoved !== null) process.emitWarning(unremoved, { code: "test_run_scratch_unremoved" });
  }
}

function supervise(options: SupervisedCommandOptions, confinement: readonly string[]): Promise<SupervisedCommand> {
  const killGraceMs = options.killGraceMs;
  const passFd = options.onResult !== undefined;
  const args = [...confinement, ...supervisorArguments(options.hardCeilingMs, killGraceMs, options.command, options.args, passFd)];
  const startedAt = Date.now();
  let lastOutputAt = startedAt;
  // fd 3 carries the supervisor's receipt (the command never inherits it); fd
  // 4, when passed, becomes the command's fd 3. No stdin: the command leads
  // its own process group, and a background group reading a terminal stops.
  // The supervisor leads a group of its own too (detached): a terminal's
  // Ctrl-C reaches this process alone, which forwards ONE stop; had it also
  // reached the supervisor, the forwarded stop would be its second, which
  // kills at once and skips the grace (wf-1b3a-correctness L3). If this
  // process dies instead, the supervisor's parent-death signal stops it.
  // Inside an admitted heavy run, the supervisor is born under the run's caps
  // (this process is in the run's scope and CPU-time limit:
  // src/process/instrument-lock.ts).
  const child: ChildProcess = spawn(options.supervisor, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe", ...(passFd ? ["pipe" as const] : [])],
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  // An admitted run's record stays live while THIS supervisor lives
  // (src/process/instrument-lock-adoption.ts): the supervisor ends only after
  // the command's whole process tree is gone, so a run's owner killed
  // outright never drops its record under a command still running.
  if (child.pid !== undefined) adoptIntoOwnedInstrumentLock(child.pid);
  const receipt: Buffer[] = [];
  // A stop is delivered once the supervisor has ANNOUNCED its command (its
  // first receipt bytes): before that it may not yet hold its signals, and a
  // SIGTERM would kill it with no receipt instead of stopping the command.
  let announced = false;
  let stopPending = false;
  (child.stdio[3] as Readable).on("data", guarded("process.supervised-run.receipt", (chunk: Buffer) => {
    receipt.push(chunk);
    if (announced) return;
    announced = true;
    if (stopPending) child.kill("SIGTERM");
  }));
  child.stdout!.on("data", guarded("process.supervised-run.stdout", (chunk: Buffer) => { lastOutputAt = Date.now(); options.onStdout(chunk); }));
  child.stderr!.on("data", guarded("process.supervised-run.stderr", (chunk: Buffer) => { lastOutputAt = Date.now(); options.onStderr(chunk); }));
  if (passFd) (child.stdio[4] as Readable).on("data", guarded("process.supervised-run.result", (chunk: Buffer) => options.onResult!(chunk)));
  let stalledKill = false;
  let stopped = false;
  const tellSupervisor = (): void => {
    if (announced) child.kill("SIGTERM");
    else stopPending = true;
  };
  const stop = guarded("process.supervised-run.stop", (): void => {
    stopped = true;
    tellSupervisor();
  });
  if (options.stop?.aborted === true) stop();
  else options.stop?.addEventListener("abort", stop, { once: true });
  const interruptSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  if (options.killOnInterrupt === true) for (const signal of interruptSignals) process.on(signal, stop);
  const stallTimeoutMs = options.stallTimeoutMs;
  const watch = stallTimeoutMs === undefined ? undefined : setInterval(guarded("process.supervised-run.stall-watch", () => {
    if (stalledKill || stopped || Date.now() - lastOutputAt <= stallTimeoutMs) return;
    stalledKill = true;
    tellSupervisor();
  }), options.watchIntervalMs ?? ROOT_POLICY.verification.testRunSupervision.watchIntervalMs);
  return new Promise((resolveRun) => {
    let settled = false;
    const settle = (outputComplete: boolean): void => {
      if (settled) return;
      settled = true;
      if (watch !== undefined) clearInterval(watch);
      options.stop?.removeEventListener("abort", stop);
      if (options.killOnInterrupt === true) for (const signal of interruptSignals) process.removeListener(signal, stop);
      const elapsedMs = Date.now() - startedAt;
      const { announcedCommand, receipt: supervision } = readSupervisorReceipt(Buffer.concat(receipt).toString("utf8"));
      if (supervision === undefined) {
        resolveRun(Object.freeze({ exitCode: 1, ending: "unverified", elapsedMs, supervision, orphanedGroupKilled: endOrphanedGroup(announcedCommand), status: null, signal: null, outputComplete }));
        return;
      }
      const ended = (ending: SupervisedCommand["ending"], exitCode = 1): void =>
        resolveRun(Object.freeze({ exitCode, ending, elapsedMs, supervision, orphanedGroupKilled: false, status: supervision.status, signal: signalOfStatus(supervision.status), outputComplete }));
      if (stalledKill) ended("stalled");
      else if (stopped) ended("stopped");
      else if (supervision.timedOut) ended("ceiling");
      else if (supervision.interrupted || supervision.status < 0) ended("signal");
      else ended("exited", supervision.status);
    };
    // A supervisor that could not even start (a missing binary) leaves no
    // receipt: the run settles as unverified, never as an unhandled error.
    const settleIncomplete = guarded("process.supervised-run.settle", () => settle(false));
    child.once("error", settleIncomplete);
    child.on("close", guarded("process.supervised-run.close", () => settle(true)));
    child.on("exit", guarded("process.supervised-run.exit", () => { setTimeout(settleIncomplete, killGraceMs).unref(); }));
  });
}

/**
 * The lines a runner prints when a supervised run ends, spelled once for both
 * suites: the descendants the supervisor had to kill, and a hard-ceiling kill.
 */
/**
 * Starts `command` DETACHED (see the header): a new session, stdin and stdout
 * nowhere, stderr this process's when `stderr` is `"inherit"` (a notice the
 * person who triggered it should see), the open file `stderr` names when it is
 * a descriptor (the run's log; the caller closes its copy), else nowhere;
 * unreferenced so this process may exit at once. Answers its pid. A launch
 * that fails to start is thrown.
 */
export function startDetached(command: string, args: readonly string[], options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; stderr: "ignore" | "inherit" | number }>): number {
  const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "ignore", options.stderr] });
  let failure: Error | undefined;
  // A launch that cannot start reports it as an event (never uncaught): the pid below says so.
  child.once("error", guarded("process.detached-launch.error", (error: Error) => { failure = error; }));
  if (child.pid === undefined) throw new HarnessError(`could not start ${command} in the background${failure === undefined ? "" : `: ${failure.message}`}`, "detached_launch_failed");
  child.unref();
  return child.pid;
}

export function supervisedEndingLines(run: SupervisedCommand, hardCeilingMs: number): readonly string[] {
  const killed = (run.supervision?.reaped ?? []).filter((entry) => entry.killed).map((entry) => entry.pid);
  return [
    ...(killed.length > 0 ? [`[run-tests] killed ${String(killed.length)} process(es) the run left running: ${killed.join(", ")}`] : []),
    ...(run.ending === "ceiling" ? [`[run-tests] HARD CEILING: the run was still going after ${String(hardCeilingMs)}ms; it and every process it started were killed.`] : []),
  ];
}

/**
 * A NESTED runner launch a test makes, bounded and synchronous: the command
 * runs under the supervisor with `timeoutMs` as its ceiling. Its own call is
 * bounded too (the ceiling plus two graces): a supervisor that cannot close
 * (a descendant holding its pipes after it was killed) never hangs the test
 * that launched it — the command's process group is ended and the launch
 * refused as unverified.
 */
export function runBoundedTestProcess(
  supervisor: string,
  command: string,
  arguments_: readonly string[],
  options: Readonly<{ timeoutMs: number; killGraceMs: number; env?: NodeJS.ProcessEnv; cwd?: string }>,
) {
  const grace = options.killGraceMs;
  const args = supervisorArguments(options.timeoutMs, grace, command, arguments_, false);
  const result = spawnSync(supervisor, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe"],
    timeout: options.timeoutMs + 2 * grace, killSignal: "SIGKILL",
    env: options.env, cwd: options.cwd, maxBuffer: ROOT_POLICY.receipts.immutableExecution.maximumBytes,
  });
  const { announcedCommandPid, announcedCommand, receipt: supervision } = readSupervisorReceipt(result.output[3] ?? "");
  if (result.error || result.status !== 0 || supervision === undefined) {
    const groupKilled = endOrphanedGroup(announcedCommand);
    throw new HarnessError(
      `The nested test supervisor did not close with a receipt${groupKilled ? `; its command's process group ${String(announcedCommandPid)} was killed` : ""}`,
      "test_process_supervisor_failed",
    );
  }
  return {
    pid: supervision.commandPid,
    status: supervision.status >= 0 ? supervision.status : null,
    signal: signalOfStatus(supervision.status),
    stdout: result.stdout,
    stderr: result.stderr,
    error: supervision.timedOut || supervision.interrupted
      ? new HarnessError("The nested test exceeded its execution boundary", "test_process_boundary_exceeded") : undefined,
    supervision,
  };
}
