/**
 * THE HARNESS'S SUBPROCESS BOUND: ONE TYPE, ONE KERNEL LIMIT, ONE WORDING
 * (NO-LOAD-BLOCK L2; audit rows A-17 and A-18).
 *
 * A wall timeout on a subprocess judges the HOST: a busy machine makes a step
 * wait for a core, it does not make it do more work. `harness sync`'s steps
 * (240 s for `harness check`) and the typecheck (120 s) were killed that way
 * on a loaded host, and merges were blocked. So a subprocess is bounded by its
 * WORK, through the one bounded run (`runCpuBounded`,
 * src/process/supervised-run.ts), under {@link SubprocessBounds}:
 *
 * - its process GROUP's CPU time (`cpuBudgetMs`), members and reaped children,
 *   vanished members kept;
 * - a STALL: no output and no CPU work at all for `stallMs` of the time it
 *   COULD run (the time it waited on a run queue for a core is never counted:
 *   a busy host starves a process, it does not stall it);
 * - the output it may hold (`outputBytes`);
 * - one very large WALL backstop (`hangBackstopMs`), the only wall bound left:
 *   a run still going at it is HUNG, never slow;
 * - THE KERNEL'S CPU LIMIT, binding: RLIMIT_CPU, soft and hard
 *   ({@link kernelCpuLimit}), set before the command is exec'd
 *   ({@link cpuLimitedInvocation}) and inherited by every descendant, which
 *   cannot raise it. It lies past what the supervisor's own stop needs, so it
 *   decides an ending only when the supervisor cannot (a `setsid` escapee, an
 *   orphaned group). An admitted run puts ITS OWN process under the same
 *   limit ({@link limitOwnCpu}, the instrument lock's per-run caps).
 *
 * {@link boundedEnding} says how a run ended: its exit status, the signal, or
 * which bound fired. Never just "failed".
 */
import { spawnSync } from "node:child_process";

import { InputError } from "../kernel/errors.ts";
import { ownCpuTimeLimit } from "./process-facts.ts";

/** How a subprocess is bounded: by its work, and one wall backstop for a hang. */
export type SubprocessBounds = Readonly<{
  /** Its process group's CPU time (the members' own and their reaped children's), in ms. */
  cpuBudgetMs: number;
  /** A stall: no output and no CPU work for this long of the time it could run (its run-queue wait excluded). */
  stallMs: number;
  /** The one wall bound: a run still going at it is hung. */
  hangBackstopMs: number;
  /** How often the group's CPU time and the output are read. */
  pollMs: number;
  /** Between a stop's SIGTERM and SIGKILL. */
  killGraceMs: number;
  /** The output (stdout and stderr) held in memory, at most. */
  outputBytes: number;
}>;

const POSITIVE_BOUNDS = ["cpuBudgetMs", "stallMs", "hangBackstopMs", "pollMs", "killGraceMs", "outputBytes"] as const;

/**
 * Refuses bounds no run can keep (`cpu_bounds_invalid`), before anything runs: a missing bound compares false
 * forever and a run under it would never stop, so no fallback value is ever chosen.
 */
export function assertSubprocessBounds(bounds: SubprocessBounds | undefined): asserts bounds is SubprocessBounds {
  const invalid = POSITIVE_BOUNDS.filter((name) => {
    const value = (bounds as Readonly<Record<string, unknown>> | undefined)?.[name];
    return typeof value !== "number" || !Number.isFinite(value) || value <= 0;
  });
  if (invalid.length > 0) throw new InputError(`a bounded run needs every bound as a positive finite number; missing or invalid: ${invalid.join(", ")}`, "cpu_bounds_invalid");
  const valid = bounds as SubprocessBounds;
  // A watch no more frequent than the stall window cannot see a stall end before it is judged one.
  if (valid.pollMs >= valid.stallMs) throw new InputError(`a bounded run must read its group more often than its stall window: pollMs ${String(valid.pollMs)} is not below stallMs ${String(valid.stallMs)}`, "cpu_bounds_invalid");
}

/**
 * The kernel's per-process CPU limit `bounds` imply, in whole seconds: the soft limit (SIGXCPU) past what the
 * supervisor's own stop needs (the budget, two reads, the grace), and the hard limit (SIGKILL) a grace above
 * it. A process's own CPU never exceeds its group's, so while the supervisor runs the budget always ends the
 * run first.
 */
export function kernelCpuLimit(bounds: SubprocessBounds): Readonly<{ soft: number; hard: number }> {
  const soft = Math.ceil((bounds.cpuBudgetMs + 2 * bounds.pollMs + bounds.killGraceMs) / 1000) + 1;
  return { soft, hard: soft + Math.ceil(bounds.killGraceMs / 1000) + 1 };
}

/**
 * How the invocation answers a command it cannot find (on the run's own `PATH`, or as a path): this status,
 * with this one line on stderr, before anything is exec'd. The bounded run reads it as `unstarted`
 * (`ENOENT`), as a spawn of a missing command answers; the shell does the lookup, so no file is read here.
 */
export const COMMAND_NOT_FOUND = Object.freeze({ status: 127, marker: "bounded-run: command not found" });

/**
 * `command args…` under the kernel CPU limit: the soft limit first (it may not exceed the hard one), then the
 * hard one, then `exec`, so the command is the process spawned (its pid, its group). A limit this process
 * already holds that is TIGHTER is kept (a run nested in an admitted run never asks for more than it holds,
 * and is never refused for it). A host refusing the limit refuses the run: the shell exits non-zero before
 * the command starts, never a run unbounded. A command the shell cannot find is {@link COMMAND_NOT_FOUND}.
 */
export function cpuLimitedInvocation(command: string, args: readonly string[], bounds: SubprocessBounds): Readonly<{ command: string; args: readonly string[] }> {
  const { soft, hard } = kernelCpuLimit(bounds);
  return {
    command: "/bin/sh",
    args: ["-c", `cap() { held=$(ulimit -H -t); if [ "$held" = unlimited ] || [ "$held" -gt "$1" ]; then echo "$1"; else echo "$held"; fi; }; ulimit -S -t "$(cap "$1")" && ulimit -H -t "$(cap "$2")" && shift 2 && { command -v -- "$1" >/dev/null 2>&1 || { printf '%s\\n' '${COMMAND_NOT_FOUND.marker}' >&2; exit ${String(COMMAND_NOT_FOUND.status)}; }; } && exec "$@"`, "sh",
      String(soft), String(hard), command, ...args],
  };
}

/**
 * Puts THIS process under `bounds`' kernel CPU limit ({@link kernelCpuLimit}: soft, then hard: SIGXCPU, then
 * SIGKILL), through `prlimit`; every process it starts from now on inherits the limit, each counting its own
 * CPU work. Returns why it could not, or null once `/proc/self/limits` shows the limit in force.
 */
export function limitOwnCpu(bounds: SubprocessBounds): string | null {
  const { soft, hard } = kernelCpuLimit(bounds);
  const set = spawnSync("prlimit", ["--pid", String(process.pid), `--cpu=${String(soft)}:${String(hard)}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (set.error !== undefined || set.status !== 0) return `prlimit ${set.error !== undefined ? set.error.message : `exited ${String(set.status)}: ${set.stderr.trim()}`}`;
  const inForce = ownCpuTimeLimit();
  return inForce?.soft === String(soft) && inForce.hard === String(hard) ? null
    : `the CPU limit in force reads ${inForce === undefined ? "nothing" : `${inForce.soft}:${inForce.hard}`}, not ${String(soft)}:${String(hard)} s`;
}

/**
 * How a bounded run ended: its own exit, the bound that stopped it, or (`cpu-rlimit`) the kernel's CPU limit,
 * which ends a process only when the supervisor could not.
 */
export type BoundedEnding = "exited" | "cpu-exhausted" | "cpu-rlimit" | "stalled" | "hung" | "output-exceeded" | "unmeasurable" | "unstarted";

/** How a bounded run ended, in words, spelled ONCE for every caller that reports one. Never just "failed". */
export function boundedEnding(
  run: Readonly<{ ending: BoundedEnding; status: number | null; signal: NodeJS.Signals | null; cpuMs: number | null; startError: string | null }>,
  bounds: SubprocessBounds,
): string {
  const used = run.cpuMs === null ? "" : ` (${String(run.cpuMs)} ms used)`;
  switch (run.ending) {
    case "cpu-exhausted": return `its process group spent its CPU budget of ${String(bounds.cpuBudgetMs)} ms${used} and was stopped`;
    case "cpu-rlimit": return `a process of it spent its CPU-time limit of ${String(kernelCpuLimit(bounds).soft)} s of CPU work (RLIMIT_CPU, the kernel backstop) and was ended by ${run.signal ?? "SIGXCPU"}`;
    case "stalled": return `it produced no output and no CPU work for ${String(bounds.stallMs)} ms of the time it could run (stalled) and was stopped`;
    case "hung": return `HUNG: it was still running at the ${String(bounds.hangBackstopMs / 1000)} s hang backstop (wall) and was stopped`;
    case "output-exceeded": return `its output passed ${String(bounds.outputBytes)} bytes and it was stopped`;
    case "unmeasurable": return "procfs cannot measure its process group's CPU time, so its budget could not be judged and it was stopped";
    case "unstarted": return `it could not start (${run.startError ?? "unknown"})`;
    case "exited": return run.signal === null ? `it exited with status ${String(run.status)}` : `it was ended by signal ${run.signal}`;
  }
}
