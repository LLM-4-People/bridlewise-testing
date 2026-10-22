#!/usr/bin/env node
/**
 * THE END OF A CI JOB'S OWN PROCESS TREE (#421).
 *
 * Seen three times: every step of a job finished, its workflow run said
 * "completed success", and the job's check run stayed `in_progress` forever
 * after the runner's last log line, "Cleaning up orphan processes". The merge
 * queue waited on it until somebody re-ran the job.
 *
 * The runner marks every process it starts for a job with that job's
 * `RUNNER_TRACKING_ID` (in its environment) and, after the last step, ends
 * whatever still carries it. This step, the last of every job (`if: always()`),
 * does that itself first, and says what it found:
 *
 *   - it lists every process still carrying this job's id (outside this step's
 *     own ancestry and its own children): pid, parent, process group, state,
 *     elapsed time, CPU time and command line;
 *   - it ends them (SIGTERM, then SIGKILL after a short grace), and names any
 *     that survive both — a process in uninterruptible sleep (`D`) is the shape
 *     that can stall the runner's own cleanup;
 *   - a job that left any process FAILS here, naming each one, so the cause is
 *     fixed at its owner instead of being swept up silently.
 *
 * Plain JavaScript on purpose: it runs on every job, including those that use
 * the runner image's own Node (no type stripping there).
 *
 * Usage (as a job's last step): `node scripts/end-job-processes.mjs`
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** The grace a process gets between SIGTERM and SIGKILL, and between SIGKILL and the survivor count (milliseconds). */
const KILL_GRACE_MS = 5_000;
const POLL_MS = 100;

const trackingId = process.env.RUNNER_TRACKING_ID;
if (trackingId === undefined || trackingId.length === 0) {
  throw new Error("RUNNER_TRACKING_ID is not set: this step runs as a GitHub Actions job's last step");
}

/** The parent of `pid`, from /proc (null when it is gone). */
function parentOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `pid (comm) state ppid …`: comm may hold spaces and parentheses, so read after its last `)`.
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return null;
  }
}

/** Whether `pid` descends from (or is) `ancestor`. */
function descendsFrom(pid, ancestor) {
  for (let current = pid, hops = 0; current !== null && current > 1 && hops < 4096; current = parentOf(current), hops += 1) {
    if (current === ancestor) return true;
  }
  return false;
}

/** This step's own ancestry (its shell, the runner's step process): never an orphan. */
const ancestry = new Set();
for (let current = process.pid; current !== null && current > 1; current = parentOf(current)) ancestry.add(current);

/** Every live process carrying this job's tracking id, outside this step. */
function jobProcesses() {
  return readdirSync("/proc").filter((name) => /^\d+$/u.test(name)).map(Number).filter((pid) => {
    if (ancestry.has(pid) || descendsFrom(pid, process.pid)) return false;
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`RUNNER_TRACKING_ID=${trackingId}`);
    } catch {
      return false; // gone, or not ours to read
    }
  });
}

function describe(pids) {
  if (pids.length === 0) return "";
  try {
    return execFileSync("ps", ["-o", "pid=,ppid=,pgid=,stat=,etime=,time=,args=", "-p", pids.join(",")], { encoding: "utf8" });
  } catch {
    return pids.map((pid) => `${String(pid)} (gone before it could be described)`).join("\n");
  }
}

function signal(pids, name) {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // already gone
    }
  }
}

async function settle(deadlineMs) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end && jobProcesses().length > 0) await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS));
  return jobProcesses();
}

const found = jobProcesses();
if (found.length === 0) {
  process.stdout.write("end-job-processes: no process of this job is left\n");
} else {
  const listing = describe(found);
  process.stdout.write(`end-job-processes: ${String(found.length)} process(es) of this job outlived its steps:\n  PID  PPID  PGID STAT     ELAPSED     TIME COMMAND\n${listing}`);
  signal(found, "SIGTERM");
  let left = await settle(KILL_GRACE_MS);
  if (left.length > 0) {
    signal(left, "SIGKILL");
    left = await settle(KILL_GRACE_MS);
  }
  if (left.length > 0) process.stdout.write(`end-job-processes: ${String(left.length)} survived SIGKILL (uninterruptible?):\n${describe(left)}`);
  for (const line of listing.trim().split("\n")) process.stdout.write(`::error title=Orphaned process::${line.trim()}\n`);
  process.exitCode = 1;
}
