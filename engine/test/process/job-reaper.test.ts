/**
 * A CI JOB'S REAPER ENDS ITS OWN PROCESSES AND NOTHING ELSE (#421).
 *
 * The reaper (`scripts/tooling/end-job-processes.ts`) runs as the last thing
 * a job does. It ends every process carrying THIS job's runner mark, and a
 * loosened match would signal other jobs' processes on a shared runner, so the
 * selection is pinned here. Only exactly this job's `RUNNER_TRACKING_ID` is
 * ever selected; planted foreign processes (an id that starts or ends like
 * this one, the id under another name) survive; a process that ignores SIGTERM
 * is still ended; and the job fails naming each one.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { carriesJobMark, commandLineOf, isProcessAlive, JOB_MARK_VARIABLE, jobProcesses, terminate } from "../../src/process/process-facts.ts";
import { endJobProcesses } from "../../scripts/tooling/end-job-processes.ts";

test("JobReaper: only this job's exact mark is this job's — another id, a near miss or another name is not", () => {
  const id = "github_1234abcd";
  const environ = (...entries: readonly string[]): string => [...entries, ""].join("\0");
  assert.equal(carriesJobMark(environ("PATH=/usr/bin", `${JOB_MARK_VARIABLE}=${id}`, "HOME=/h"), id), true, "this job's mark (liveness)");
  for (const [label, text] of [
    ["another job", environ(`${JOB_MARK_VARIABLE}=github_ffff0000`)],
    ["an id that starts like this one", environ(`${JOB_MARK_VARIABLE}=${id}2`)],
    ["an id that ends like this one", environ(`${JOB_MARK_VARIABLE}=x${id}`)],
    ["this id under another name", environ(`OTHER_TRACKING_ID=${id}`)],
    ["the name without a value", environ(`${JOB_MARK_VARIABLE}=`)],
    ["no mark at all", environ("PATH=/usr/bin")],
  ] as const) {
    assert.equal(carriesJobMark(text, id), false, label);
  }
  assert.equal(carriesJobMark(environ(`${JOB_MARK_VARIABLE}=`), ""), false, "an empty id marks nothing");
});

/** A process re-parented away from this test (a double fork), carrying `id` as its job mark; its pid. */
function plantOrphan(id: string, script: string): number {
  const planted = spawnSync("sh", ["-c", `(${script}) >/dev/null 2>&1 & echo $!`], { encoding: "utf8", env: { ...process.env, [JOB_MARK_VARIABLE]: id } });
  const pid = Number(planted.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 1, `planted ${script}: ${planted.stderr}`);
  return pid;
}

test("JobReaper: the job's leftover processes are ended — one ignoring SIGTERM too — foreign ones survive, and the job fails", async () => {
  const id = `github_${randomUUID()}`;
  const foreignIds = [`${id}2`, `x${id}`];
  const ours = [plantOrphan(id, "exec sleep 300"), plantOrphan(id, "trap '' TERM; while :; do sleep 1; done")];
  const foreign = foreignIds.map((foreignId) => plantOrphan(foreignId, "exec sleep 300"));
  try {
    // Selected: every planted process of this job (and what they started, such as the loop's `sleep`), no foreign one.
    const selected = jobProcesses(id).map((owned) => owned.pid);
    assert.ok(ours.every((pid) => selected.includes(pid)), `this job's planted processes are selected (liveness): ${selected.join(", ")}`);
    assert.ok(foreign.every((pid) => !selected.includes(pid)), "no foreign process is selected");
    assert.equal(await endJobProcesses(id), 1, "a job that left processes fails");
    for (const pid of ours) assert.equal(isProcessAlive(pid), false, `this job's process ${String(pid)} (${commandLineOf(pid)?.join(" ") ?? "gone"}) was ended`);
    for (const pid of foreign) assert.equal(isProcessAlive(pid), true, `a foreign process ${String(pid)} was signalled`);
    assert.equal(await endJobProcesses(id), 0, "a job with nothing left passes");
  } finally {
    // Every plant is ended through the same owner, whatever the assertions found: the foreign ones are each their own
    // job's, and a failed run must not leave this job's loop behind (it is looked at again: a loop starts a `sleep`).
    for (const plantedId of [id, ...foreignIds]) {
      for (let round = 0; round < 3; round += 1) for (const owned of jobProcesses(plantedId)) await terminate(owned, { graceMs: 0 });
    }
  }
});
