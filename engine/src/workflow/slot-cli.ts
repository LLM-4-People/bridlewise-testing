/**
 * `harness slot run -- <command> [args…]` — THE SHELL'S DOOR TO HEAVY-RUN
 * ADMISSION (src/process/instrument-lock.ts), for ad-hoc load and performance
 * work that no runner starts: a CPU hog, a file looped under load, a profile.
 * The run is admitted at once (it never waits for another run), the command
 * runs under the native supervisor and the run's caps (its cgroup scope and
 * CPU-time limit; adopted into the run's record, so a door killed outright
 * leaves the record live until the command and everything it started are
 * gone), and the record is released when the command ends; its exit code is
 * the command's. A run in which the kernel killed a process for passing its
 * memory cap ends in the admission owner's typed refusal
 * (`run_memory_cap_exceeded`, raised when the run's record is released),
 * never an ordinary signal ending; a door that BORROWS an outer run keeps
 * its command's own exit code, and the outer run's owner reports the kill.
 */
import { constants } from "node:os";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureTestProcessSupervisor } from "../../guardian/build.ts";
import { INPUT_ERROR_CODE, InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { admitInstrumentRun, holdInstrumentLock, wholeInstrumentTestFileCount, withinInstrumentHold, type PerRunCaps } from "../process/instrument-lock.ts";
import { configuredSubprocessBounds } from "./workflow-config.ts";
import { runTestCommand } from "../process/supervised-run.ts";
import { repositoryToplevel } from "../git/repository-ownership.ts";
import { wrapResult, type CommandAnswer } from "./command-result.ts";
import { readTestExecutionConfig } from "./test-result-collector.ts";

export type SlotRunOutput = Readonly<{ command: readonly string[]; exitCode: number; ending: string }>;

/**
 * The run's label in the registry, for a slot run: the program and how many arguments it
 * got — never the arguments themselves (a person reads it; a command line is
 * unbounded and carries anything).
 */
function slotRunLabel(command: readonly string[]): string {
  return `slot run: ${basename(command[0] ?? "")} (${String(command.length - 1)} argument(s))`;
}

/**
 * THE ONE "INSIDE THE DOOR" MARKER: the environment variable the supervising
 * door sets on the command it runs ({@link runInsideInstrumentLock}). A door
 * that re-ran itself (vitest, the coverage run, the perf profile) reads it to
 * take its inner path and never re-run a second time — and the inner path
 * still BORROWS the hold through the one lock door, which refuses it outside
 * a live hold: the marker chooses the path, never grants the lock.
 */
export const INSIDE_INSTRUMENT_LOCK_VARIABLE = "HARNESS_INSIDE_INSTRUMENT_LOCK";

/**
 * THE SUPERVISING DOOR (correctness L-N1): `runner` admitted as a heavy run
 * (heavy by `testFileCount`; a whole instrument passes `Infinity`) AT ONCE,
 * then `command` run under the native supervisor and the run's caps, ADOPTED
 * into the run's record — so a door killed outright never drops the record
 * under its command. Answers the command's exit code (a command a signal
 * ended: 128 + its number, the shell's convention). `harness slot run`, the
 * coverage run and the perf profile are all admitted this way, never in
 * their own process.
 */
/** The declared admission (required: the registry's place and the caps are config). */
function declaredInstrumentLock<T>(lock: T | undefined): T {
  if (lock === undefined) throw new InputError("testExecution.instrumentLock is not declared in bridlewise.config.json", "instrument_lock_undeclared");
  return lock;
}

export async function runInsideInstrumentLock(runner: string, testFileCount: number, command: readonly string[], options: Readonly<{ lockPath?: string; caps?: PerRunCaps; onResult?: (chunk: Buffer) => void }> = {}): Promise<Readonly<{ exitCode: number; ending: string }>> {
  const engineRoot = fileURLToPath(new URL("../../", import.meta.url));
  const config = readTestExecutionConfig(engineRoot);
  // `lockPath`: a test's own registry (the host's registry is never a test's
  // to write), and only there `caps`: a test's own caps.
  if (options.caps !== undefined && options.lockPath === undefined) throw new InputError("a run's caps are the config's; only a test's own registry (lockPath) takes caps of its own", INPUT_ERROR_CODE);
  const lock = options.lockPath !== undefined
    ? admitInstrumentRun(options.lockPath, runner, options.caps ?? declaredInstrumentLock(config.instrumentLock).perRun, configuredSubprocessBounds())
    : holdInstrumentLock({ config: config.instrumentLock, harnessRoot: engineRoot, runner, testFileCount, cpu: configuredSubprocessBounds() });
  return withinInstrumentHold(lock, async () => {
    // CONFINED, always (decision TEST-CONFINEMENT-SELF-BIND): heavy load is test load — coverage, the raw and
    // supported vitest runs, the browser runs, the perf profile — through the one test-execution door. Work that must
    // write the checkout (a build, `harness sync`) runs through its declared trusted runner, never here.
    const run = await runTestCommand({
      supervisor: ensureTestProcessSupervisor(),
      checkout: repositoryToplevel(engineRoot, "directory") ?? engineRoot,
      command: command[0]!,
      args: command.slice(1),
      hardCeilingMs: config.engineSuiteWatchdog.hardCeilingMs,
      killGraceMs: config.engineSuiteWatchdog.killGraceMs,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
      env: { ...process.env, [INSIDE_INSTRUMENT_LOCK_VARIABLE]: "1" },
      killOnInterrupt: true,
      // A confined run hands back what it made on its result channel (its fd 3), never through the checkout.
      ...(options.onResult === undefined ? {} : { onResult: options.onResult }),
    });
    const exitCode = run.signal !== null ? 128 + constants.signals[run.signal] : run.ending === "exited" ? run.exitCode : 1;
    return deepFreeze({ exitCode, ending: run.ending });
  }, (ended) => (ended.exitCode === 0 ? undefined : `the command ${runner} ended ${ended.ending} with exit code ${String(ended.exitCode)}`));
}

export async function runSlotCli(argv: readonly string[]): Promise<CommandAnswer<SlotRunOutput>> {
  if (argv[0] !== "run" || argv[1] !== "--" || argv.length < 3) {
    throw new InputError("harness slot takes: run -- <command> [args…]", INPUT_ERROR_CODE);
  }
  const command = argv.slice(2);
  // A whole instrument (an ad-hoc load or profile), heavy by kind (config `wholeInstruments`).
  const engineRoot = fileURLToPath(new URL("../../", import.meta.url));
  const count = wholeInstrumentTestFileCount(declaredInstrumentLock(readTestExecutionConfig(engineRoot).instrumentLock), "slot");
  const { exitCode, ending } = await runInsideInstrumentLock(slotRunLabel(command), count, command);
  return { result: wrapResult("slot", deepFreeze({ command, exitCode, ending }), { status: exitCode === 0 ? "pass" : "fail" }), exitCode };
}
