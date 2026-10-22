/**
 * THE DOOR WHILE CI RUNS, AND ITS BUTTONS (github-only §5.3 step 3, ci §5.2,
 * §6.6):
 *
 *   - `preflightArtifacts`: before anything is downloaded, the run's
 *     artifacts are listed and refused when a name is not one the generated
 *     pipeline uploads, an artifact expired, or a size is past its bound — a
 *     hostile run's payload is never fetched (V-19);
 *   - `streamProgress`: the `bridlewise/door` check, in progress, updated
 *     from the jobs API every interval with the per-job table. DISPLAY ONLY:
 *     the verdict comes from the completed run alone, so a lost or killed
 *     streamer changes nothing (V-10). A merge-group run whose queue ref is
 *     gone (a destroyed group: GitHub sends no event for it) is cancelled,
 *     freeing its job slots, and the check says `dequeued`;
 *   - `rerunCold`: the "Re-run cold" button — `ci.yml` dispatched on the
 *     pull request's own branch with `cold`, through the dispatch API that
 *     answers the run id; a fork's branch is refused (its code is not ours to
 *     run with a dispatch).
 */
import { InputError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import type { ForgeClient } from "../forge/port.ts";
import { branchTip, cancelWorkflowRun, dispatchWorkflow, getWorkflowRun, listRunArtifacts, listRunJobs, refExists, writeCheckRun, findCheckRun, type ArtifactFacts, type Repository } from "./door-github.ts";
import { DOOR_LIMITS } from "./door-config.ts";

/** The artifacts the generated pipeline uploads, with each kind's size bound. */
const ARTIFACT_POLICY = deepFreeze({
  kinds: [
    { pattern: /^gate-plan$/u, maxBytes: 8 * 1024 * 1024 },
    { pattern: /^gate-results-[a-z0-9-]{1,80}$/u, maxBytes: 64 * 1024 * 1024 },
    { pattern: /^gate-logs-[a-z0-9-]{1,80}$/u, maxBytes: 256 * 1024 * 1024 },
    { pattern: /^gate-receipt$/u, maxBytes: 8 * 1024 * 1024 },
  ],
  maxTotalBytes: 1024 * 1024 * 1024,
});

export type PreflightFinding = Readonly<{ rule: "artifact-name" | "artifact-size" | "artifact-expired" | "artifact-total" | "artifact-plan-missing"; artifact?: string; detail: string }>;

/** Judges the listed artifacts before any is downloaded. */
export function judgeArtifacts(artifacts: readonly ArtifactFacts[]): readonly PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  let total = 0;
  for (const artifact of artifacts) {
    total += artifact.sizeInBytes;
    const kind = ARTIFACT_POLICY.kinds.find((candidate) => candidate.pattern.test(artifact.name));
    if (kind === undefined) {
      findings.push({ rule: "artifact-name", artifact: artifact.name, detail: "a name the generated pipeline never uploads" });
      continue;
    }
    if (artifact.expired) findings.push({ rule: "artifact-expired", artifact: artifact.name, detail: "expired before the door read it" });
    if (artifact.sizeInBytes > kind.maxBytes) findings.push({ rule: "artifact-size", artifact: artifact.name, detail: `${String(artifact.sizeInBytes)} bytes, over its ${String(kind.maxBytes)}-byte bound` });
  }
  if (total > ARTIFACT_POLICY.maxTotalBytes) findings.push({ rule: "artifact-total", detail: `${String(total)} bytes in all, over the ${String(ARTIFACT_POLICY.maxTotalBytes)}-byte bound` });
  if (!artifacts.some((artifact) => artifact.name === "gate-plan")) findings.push({ rule: "artifact-plan-missing", detail: "the run uploaded no plan" });
  return deepFreeze(findings);
}

export async function preflightArtifacts(client: ForgeClient, repository: Repository, runId: number): Promise<readonly PreflightFinding[]> {
  return judgeArtifacts(await listRunArtifacts(client, repository, runId, DOOR_LIMITS.readPages));
}

export type StreamOptions = Readonly<{
  intervalMs: number;
  /** The streamer stops by this time (display only: the verdict never depends on it). */
  deadline: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>;

export type StreamEnding = "completed" | "dequeued" | "deadline";

/** Streams the run's progress into the check until it completes, its group is destroyed, or the deadline passes. */
export async function streamProgress(client: ForgeClient, repository: Repository, runId: number, options: StreamOptions): Promise<StreamEnding> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  let checkId: number | null = null;
  for (;;) {
    const run = await getWorkflowRun(client, repository, runId);
    if (run.status === "completed") return "completed";
    checkId ??= await findCheckRun(client, repository, run.headSha);
    if (run.event === "merge_group" && !(await refExists(client, repository, `heads/${run.headBranch}`))) {
      await cancelWorkflowRun(client, repository, run.id);
      await writeCheckRun(client, repository, run.headSha, { status: "completed", conclusion: "cancelled", title: "Dequeued: the merge group was destroyed", summary: `The queue dropped this group (its ref ${run.headBranch} is gone), so its CI run was cancelled to free the job slots.` }, checkId);
      return "dequeued";
    }
    const jobs = await listRunJobs(client, repository, run.id, DOOR_LIMITS.readPages);
    const done = jobs.filter((job) => job.status === "completed").length;
    const failed = jobs.filter((job) => job.conclusion === "failure").map((job) => job.name);
    const table = ["| Job | State |", "|---|---|", ...jobs.map((job) => `| ${job.name} | ${job.conclusion ?? job.status} |`)].join("\n");
    checkId = await writeCheckRun(client, repository, run.headSha, {
      status: "in_progress",
      title: `${String(done)} of ${String(jobs.length)} jobs done${failed.length === 0 ? "" : `; failing so far: ${failed.slice(0, DOOR_LIMITS.failingJobsNamed).join(", ")}`}`,
      summary: `Live progress of [the CI run](https://github.com/${repository.owner}/${repository.name}/actions/runs/${String(run.id)}) (display only: the verdict comes from the completed run).\n\n${table}`,
    }, checkId);
    if (now() + options.intervalMs > options.deadline) return "deadline";
    await sleep(options.intervalMs);
  }
}

/**
 * The "Re-run cold" button: `ci.yml` dispatched cold on the pull request's
 * own branch; answers the new run id. The branch must exist HERE and point
 * at exactly the commit the check judged: a fork's branch, a same-named
 * branch of ours, or a branch that moved since is refused (a dispatch runs
 * what the branch holds, and the button is for that commit only).
 */
export async function rerunCold(client: ForgeClient, repository: Repository, request: Readonly<{ headBranch: string | null; headSha: string }>): Promise<number> {
  const refuse = (why: string): never => {
    throw new InputError(`Re-run cold refused: ${why} (push a new commit instead)`, "door_rerun_refused");
  };
  if (request.headBranch === null || request.headBranch === "") refuse("the check names no branch of this repository");
  const tip = await branchTip(client, repository, request.headBranch!);
  if (tip === null) refuse(`this repository has no branch ${request.headBranch!} (a fork's branch cannot be dispatched here)`);
  if (tip !== request.headSha) refuse(`branch ${request.headBranch!} is at ${tip!}, not the judged ${request.headSha}`);
  return dispatchWorkflow(client, repository, "ci.yml", request.headBranch!, { cold: "true" });
}
