/**
 * THE END OF A CI JOB'S OWN PROCESS TREE (#421).
 *
 * Seen three times: every step of a job finished, its workflow run said
 * "completed success", and the job's check run stayed `in_progress` forever
 * after the runner's last log line, "Cleaning up orphan processes".
 *
 * The runner marks every process it starts for a job with that job's
 * `RUNNER_TRACKING_ID` and ends whatever still carries it after the last step.
 * This reaper, run by the post step of the local action
 * `.github/actions/end-job-processes` (which runs after every other step and
 * post step of the job), does it first and says what it found:
 *
 *   - it finds the job's processes through the one process owner
 *     (`jobProcesses`: exactly this job's mark, never another job's, never its
 *     own ancestry or descendants) and lists each: pid, parent, process group
 *     and command line;
 *   - it ends them through the one terminator (`terminate`: SIGTERM, then
 *     SIGKILL after the configured grace) and names any it could not confirm
 *     gone;
 *   - a job that left any process FAILS here, naming each one, so the cause is
 *     fixed at its owner instead of being swept up silently.
 *
 * Usage: `node engine/scripts/tooling/end-job-processes.ts` (the action's post step).
 */
import { commandLineOf, JOB_MARK_VARIABLE, jobProcesses, parentOf, processGroupOf, terminate } from "../../src/process/process-facts.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { DEFAULT_JOB_REAPER_GRACE_MS, DEFAULT_JOB_REAPER_ROUNDS } from "../../src/workflow/workflow-config.ts";

/** One leftover process, described from its procfs facts. */
function describe(pid: number): string {
  return `pid ${String(pid)} (parent ${String(parentOf(pid) ?? "?")}, group ${String(processGroupOf(pid) ?? "?")}): ${commandLineOf(pid)?.join(" ") ?? "(no command line)"}`;
}

/**
 * Ends this job's leftover processes and answers the exit code: 0 when none
 * was left, 1 when any was. It looks again after each round (a process being
 * ended can start another, as a shell loop does), up to the configured rounds.
 */
export async function endJobProcesses(trackingId: string): Promise<number> {
  const described: string[] = [];
  const unconfirmed: number[] = [];
  for (let round = 0; round < DEFAULT_JOB_REAPER_ROUNDS; round += 1) {
    const found = jobProcesses(trackingId);
    if (found.length === 0) break;
    const lines = found.map((owned) => describe(owned.pid));
    described.push(...lines);
    process.stdout.write(`end-job-processes: ${String(found.length)} process(es) of this job outlived its steps:\n${lines.map((line) => `  ${line}`).join("\n")}\n`);
    const endings = await Promise.all(found.map((owned) => terminate(owned, { graceMs: DEFAULT_JOB_REAPER_GRACE_MS })));
    unconfirmed.push(...found.filter((_, index) => endings[index]!.ending === "unconfirmed").map((owned) => owned.pid));
  }
  if (described.length === 0) {
    process.stdout.write("end-job-processes: no process of this job is left\n");
    return 0;
  }
  const remaining = jobProcesses(trackingId).map((owned) => owned.pid);
  if (unconfirmed.length > 0 || remaining.length > 0) {
    process.stdout.write(`end-job-processes: not confirmed gone (uninterruptible, or still respawning): ${[...new Set([...unconfirmed, ...remaining])].join(", ")}\n`);
  }
  for (const line of described) process.stdout.write(`::error title=Orphaned process::${line}\n`);
  return 1;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const trackingId = process.env[JOB_MARK_VARIABLE];
  if (trackingId === undefined || trackingId.length === 0) {
    throw new Error(`${JOB_MARK_VARIABLE} is not set: this reaper runs as a GitHub Actions job's post step`);
  }
  process.exitCode = await endJobProcesses(trackingId);
}
