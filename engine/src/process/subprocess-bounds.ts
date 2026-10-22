/**
 * THE HARNESS'S SUBPROCESS BOUND: CPU WORK, AND ONE HANG BACKSTOP
 * (NO-LOAD-BLOCK L2; audit rows A-17 and A-18).
 *
 * A wall timeout on a subprocess judges the HOST: a busy machine makes a step
 * wait for a core, it does not make it do more work. `harness sync`'s steps
 * (240 s for `harness check`) and the typecheck (120 s) were killed that way
 * on a loaded host, and merges were blocked. So a subprocess is bounded by:
 *
 * - its CPU WORK, per process: the kernel's RLIMIT_CPU, set by POSIX `ulimit`
 *   before the command is exec'd, and inherited by every child. The SOFT limit
 *   sends SIGXCPU; the HARD limit, a grace above it, kills a process that
 *   ignored the signal, and no child can raise it;
 * - one very large WALL backstop, the only wall bound left: a run still going
 *   at it is HUNG, never slow.
 *

 * The harness's values are `SUBPROCESS_BOUNDS` (src/workflow/workflow-config.ts);
 * this module is the mechanism, so the process layer (the supervised door's
 * per-run caps) and the workflow layer share it.
 *
 * {@link boundedEnding} says how a run that left no answer ended: its exit
 * status, the signal, and which bound fired. Never just "failed".
 */
/** How a subprocess is bounded: its CPU per process, and the one hang backstop. */
export type SubprocessBounds = Readonly<{ cpuLimitSeconds: number; cpuKillGraceSeconds: number; hangBackstopMs: number }>;

/**
 * `command args…` under the CPU limit: the soft limit first (it may not
 * exceed the hard one), then the hard one, then `exec`, so the command is the
 * process the backstop ends. A host refusing the limit refuses the run (the
 * shell exits non-zero before the command starts), never a run unbounded.
 */
export function cpuLimitedInvocation(command: string, args: readonly string[], bounds: SubprocessBounds): Readonly<{ command: string; args: readonly string[] }> {
  const [shell, ...prefix] = cpuLimitPrefix(bounds);
  return { command: shell!, args: [...prefix, command, ...args] };
}

/** The argv that runs whatever follows it under `bounds`' CPU limit (the shell, its script, the soft and hard limits). */
export function cpuLimitPrefix(bounds: SubprocessBounds): readonly string[] {
  return ["/bin/sh", "-c", 'ulimit -S -t "$1" && ulimit -H -t "$2" && shift 2 && exec "$@"', "sh",
    String(bounds.cpuLimitSeconds), String(bounds.cpuLimitSeconds + bounds.cpuKillGraceSeconds)];
}

/** How a bounded run ended, in words: its status, the signal, and which bound fired. */
export function boundedEnding(
  ended: Readonly<{ status: number | null; signal: NodeJS.Signals | null; errorCode?: string }>,
  bounds: SubprocessBounds,
): string {
  if (ended.errorCode === "ETIMEDOUT") {
    return `HUNG: it was still running at the ${String(bounds.hangBackstopMs / 1000)} s hang backstop (wall) and was killed with ${ended.signal ?? "SIGKILL"}`;
  }
  if (ended.signal === "SIGXCPU") {
    return `it spent its CPU-time limit of ${String(bounds.cpuLimitSeconds)} s of CPU work (RLIMIT_CPU) and was ended by SIGXCPU`;
  }
  if (ended.signal !== null) return `it was ended by signal ${ended.signal}`;
  if (ended.errorCode !== undefined) return `it could not run to its end (${ended.errorCode})`;
  return `it exited with status ${String(ended.status)}`;
}
