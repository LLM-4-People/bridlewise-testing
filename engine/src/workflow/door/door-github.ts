/**
 * THE DOOR'S GITHUB OPERATIONS — every read and write the door makes, typed,
 * on the ONE forge client (`../forge/port.ts`; github-only §5.3). Each answer
 * is narrowed to the fields the door judges, and a shape GitHub did not send
 * is the typed `door_github_answer_invalid`, never a guessed default.
 *
 * Artifacts are NOT downloaded here: the forge adapter never follows a
 * redirect, and an artifact download is one. The door lists them here
 * (names, sizes, digests: what it refuses before anything is fetched) and the
 * generated `door.yml` downloads the accepted ones by the run id GitHub named
 * (`actions/download-artifact`, `run-id`), never by a name the pull request
 * chose alone.
 */
import { InputError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { isForgeError } from "../forge/codes.ts";
import type { ForgeClient } from "../forge/port.ts";
import { DOOR_CHECK } from "../gates/main-integrity.ts";

export type Repository = Readonly<{ owner: string; name: string }>;

export const DOOR_CHECK_NAME = DOOR_CHECK.name;

function refuse(what: string): never {
  throw new InputError(`GitHub answered an unexpected shape: ${what}`, "door_github_answer_invalid");
}

function record(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(what);
  return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) refuse(what);
  return value as string;
}

function integer(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) refuse(what);
  return value as number;
}

const SHA = /^[0-9a-f]{40}$/u;

function sha(value: unknown, what: string): string {
  const candidate = text(value, what);
  if (!SHA.test(candidate)) refuse(`${what} is not a commit sha`);
  return candidate;
}

function base(repository: Repository): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

export type WorkflowRunFacts = Readonly<{
  id: number;
  attempt: number;
  name: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  headBranch: string;
  headRepositoryId: number;
  repositoryId: number;
  pullRequests: readonly Readonly<{ number: number; headSha: string; baseSha: string }>[];
}>;

function runFacts(value: unknown): WorkflowRunFacts {
  const run = record(value, "a workflow run");
  const headRepository = record(run.head_repository, "the run's head repository");
  const repository = record(run.repository, "the run's repository");
  const pulls = Array.isArray(run.pull_requests) ? run.pull_requests : refuse("the run's pull requests");
  return deepFreeze({
    id: integer(run.id, "the run id"),
    attempt: integer(run.run_attempt, "the run attempt"),
    name: text(run.name, "the run's workflow name"),
    path: text(run.path, "the run's workflow path"),
    event: text(run.event, "the run's event"),
    status: text(run.status, "the run's status"),
    conclusion: run.conclusion === null || run.conclusion === undefined ? null : text(run.conclusion, "the run's conclusion"),
    headSha: sha(run.head_sha, "the run's head sha"),
    headBranch: text(run.head_branch, "the run's head branch"),
    headRepositoryId: integer(headRepository.id, "the head repository id"),
    repositoryId: integer(repository.id, "the repository id"),
    pullRequests: (pulls as unknown[]).map((entry) => {
      const pull = record(entry, "a run's pull request");
      return { number: integer(pull.number, "a pull request number"), headSha: sha(record(pull.head, "a pull head").sha, "a pull head sha"), baseSha: sha(record(pull.base, "a pull base").sha, "a pull base sha") };
    }),
  });
}

/** A workflow run (its current attempt). */
export async function getWorkflowRun(client: ForgeClient, repository: Repository, runId: number): Promise<WorkflowRunFacts> {
  return runFacts((await client.rest({ method: "GET", path: `${base(repository)}/actions/runs/${runId}` })).data);
}

/** Every attempt of a run, oldest first (attempt 1 … the current one). */
export async function listRunAttempts(client: ForgeClient, repository: Repository, run: WorkflowRunFacts): Promise<readonly WorkflowRunFacts[]> {
  const attempts: WorkflowRunFacts[] = [];
  for (let attempt = 1; attempt <= run.attempt; attempt += 1) {
    attempts.push(runFacts((await client.rest({ method: "GET", path: `${base(repository)}/actions/runs/${run.id}/attempts/${attempt}` })).data));
  }
  return deepFreeze(attempts);
}

export type JobFacts = Readonly<{ id: number; name: string; status: string; conclusion: string | null; runAttempt: number }>;

/** The jobs of a run's current attempt. */
export async function listRunJobs(client: ForgeClient, repository: Repository, runId: number, maxPages: number): Promise<readonly JobFacts[]> {
  const jobs = await client.paginate<unknown>({ path: `${base(repository)}/actions/runs/${runId}/jobs`, query: { filter: "latest" } }, { maxPages, perPage: 100, items: (data) => (record(data, "a jobs page").jobs as unknown[] | undefined) ?? refuse("a jobs page without jobs") });
  return deepFreeze(jobs.map((entry) => {
    const job = record(entry, "a job");
    return {
      id: integer(job.id, "a job id"),
      name: text(job.name, "a job name"),
      status: text(job.status, "a job status"),
      conclusion: job.conclusion === null || job.conclusion === undefined ? null : text(job.conclusion, "a job conclusion"),
      runAttempt: integer(job.run_attempt, "a job's run attempt"),
    };
  }));
}

export type ArtifactFacts = Readonly<{ id: number; name: string; sizeInBytes: number; expired: boolean; digest: string | null }>;

/** The artifacts a run uploaded (names, sizes and digests; never their bytes). */
export async function listRunArtifacts(client: ForgeClient, repository: Repository, runId: number, maxPages: number): Promise<readonly ArtifactFacts[]> {
  const artifacts = await client.paginate<unknown>({ path: `${base(repository)}/actions/runs/${runId}/artifacts` }, { maxPages, perPage: 100, items: (data) => (record(data, "an artifacts page").artifacts as unknown[] | undefined) ?? refuse("an artifacts page without artifacts") });
  return deepFreeze(artifacts.map((entry) => {
    const artifact = record(entry, "an artifact");
    return {
      id: integer(artifact.id, "an artifact id"),
      name: text(artifact.name, "an artifact name"),
      sizeInBytes: integer(artifact.size_in_bytes, "an artifact size"),
      expired: artifact.expired === true,
      digest: typeof artifact.digest === "string" ? artifact.digest : null,
    };
  }));
}

export type PullFacts = Readonly<{ number: number; headSha: string; baseSha: string; baseRef: string; headRef: string; headRepositoryId: number; mergeCommitSha: string | null; draft: boolean }>;

export async function getPullRequest(client: ForgeClient, repository: Repository, number: number): Promise<PullFacts> {
  const pull = record((await client.rest({ method: "GET", path: `${base(repository)}/pulls/${number}` })).data, "a pull request");
  const head = record(pull.head, "a pull head");
  const baseSide = record(pull.base, "a pull base");
  return deepFreeze({
    number: integer(pull.number, "a pull number"),
    headSha: sha(head.sha, "the pull head sha"),
    baseSha: sha(baseSide.sha, "the pull base sha"),
    baseRef: text(baseSide.ref, "the pull base ref"),
    headRef: text(head.ref, "the pull head ref"),
    headRepositoryId: integer(record(head.repo, "the pull head repository").id, "the pull head repository id"),
    mergeCommitSha: typeof pull.merge_commit_sha === "string" && SHA.test(pull.merge_commit_sha) ? pull.merge_commit_sha : null,
    draft: pull.draft === true,
  });
}

export type CommitFacts = Readonly<{ sha: string; message: string; authorEmail: string; committerEmail: string }>;

/** The commits of a pull request, oldest first (GitHub lists at most 250). */
export async function listPullCommits(client: ForgeClient, repository: Repository, number: number, maxPages: number): Promise<readonly CommitFacts[]> {
  const commits = await client.paginate<unknown>({ path: `${base(repository)}/pulls/${number}/commits` }, { maxPages, perPage: 100 });
  return deepFreeze(commits.map((entry) => {
    const item = record(entry, "a pull commit");
    const commit = record(item.commit, "a commit body");
    return {
      sha: sha(item.sha, "a pull commit sha"),
      message: typeof commit.message === "string" ? commit.message : refuse("a commit message"),
      authorEmail: typeof record(commit.author, "a commit author").email === "string" ? (record(commit.author, "a commit author").email as string) : "",
      committerEmail: typeof record(commit.committer, "a commit committer").email === "string" ? (record(commit.committer, "a commit committer").email as string) : "",
    };
  }));
}

/** A commit's tree and parents (the Git Data API). */
export async function getGitCommit(client: ForgeClient, repository: Repository, commitSha: string): Promise<Readonly<{ sha: string; tree: string; parents: readonly string[] }>> {
  const commit = record((await client.rest({ method: "GET", path: `${base(repository)}/git/commits/${commitSha}` })).data, "a git commit");
  const parents = Array.isArray(commit.parents) ? commit.parents : refuse("a commit's parents");
  return deepFreeze({
    sha: sha(commit.sha, "a commit sha"),
    tree: sha(record(commit.tree, "a commit tree").sha, "a commit's tree sha"),
    parents: (parents as unknown[]).map((parent) => sha(record(parent, "a parent").sha, "a parent sha")),
  });
}

/** Does `ref` (`heads/…`) still exist? A destroyed merge group's ref is gone. */
export async function refExists(client: ForgeClient, repository: Repository, ref: string): Promise<boolean> {
  try {
    await client.rest({ method: "GET", path: `${base(repository)}/git/ref/${ref.split("/").map(encodeURIComponent).join("/")}` });
    return true;
  } catch (error) {
    if (isForgeError(error, "github_not_found")) return false;
    throw error;
  }
}

/** The commit `branch` points at here, or null when this repository has no such branch. */
export async function branchTip(client: ForgeClient, repository: Repository, branch: string): Promise<string | null> {
  try {
    const ref = record((await client.rest({ method: "GET", path: `${base(repository)}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}` })).data, "a ref");
    return sha(record(ref.object, "a ref's object").sha, "a branch tip");
  } catch (error) {
    if (isForgeError(error, "github_not_found")) return null;
    throw error;
  }
}

export async function cancelWorkflowRun(client: ForgeClient, repository: Repository, runId: number): Promise<void> {
  await client.rest({ method: "POST", path: `${base(repository)}/actions/runs/${runId}/cancel` });
}

/** The commits that carry an open secret-scanning alert (every location of every open alert). */
export async function openAlertCommits(client: ForgeClient, repository: Repository, maxPages: number): Promise<ReadonlyMap<string, readonly number[]>> {
  const alerts = await client.paginate<unknown>({ path: `${base(repository)}/secret-scanning/alerts`, query: { state: "open" } }, { maxPages, perPage: 100 });
  const byCommit = new Map<string, number[]>();
  for (const entry of alerts) {
    const alert = record(entry, "a secret-scanning alert");
    const number = integer(alert.number, "an alert number");
    const locations = await client.paginate<unknown>({ path: `${base(repository)}/secret-scanning/alerts/${number}/locations` }, { maxPages, perPage: 100 });
    for (const location of locations) {
      const details = record(record(location, "an alert location").details, "an alert location's details");
      if (typeof details.commit_sha === "string") byCommit.set(details.commit_sha, [...(byCommit.get(details.commit_sha) ?? []), number]);
    }
  }
  return byCommit;
}

/** The check run `name` already on `headSha`, if the door created one (the stream and the judge share it). */
export async function findCheckRun(client: ForgeClient, repository: Repository, headSha: string, name = DOOR_CHECK_NAME): Promise<number | null> {
  const answer = record((await client.rest({ method: "GET", path: `${base(repository)}/commits/${headSha}/check-runs`, query: { check_name: name, filter: "latest" } })).data, "a check-runs answer");
  const runs = Array.isArray(answer.check_runs) ? answer.check_runs : refuse("a check-runs list");
  const first = (runs as unknown[])[0];
  return first === undefined ? null : integer(record(first, "a check run").id, "a check run id");
}

export type CheckAnnotation = Readonly<{ path: string; start_line: number; end_line: number; annotation_level: "notice" | "warning" | "failure"; title: string; message: string }>;

export type CheckRunWrite = Readonly<{
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "action_required";
  externalId?: string;
  detailsUrl?: string;
  title: string;
  summary: string;
  text?: string;
  annotations?: readonly CheckAnnotation[];
  actions?: readonly Readonly<{ label: string; description: string; identifier: string }>[];
}>;

/** GitHub takes at most 50 annotations per request; the rest are appended by later updates. */
export const ANNOTATIONS_PER_REQUEST = 50;

function checkBody(write: CheckRunWrite, annotations: readonly CheckAnnotation[]): Readonly<Record<string, unknown>> {
  return {
    status: write.status,
    ...(write.conclusion === undefined ? {} : { conclusion: write.conclusion }),
    ...(write.externalId === undefined ? {} : { external_id: write.externalId }),
    ...(write.detailsUrl === undefined ? {} : { details_url: write.detailsUrl }),
    output: { title: write.title, summary: write.summary, ...(write.text === undefined ? {} : { text: write.text }), annotations },
    ...(write.actions === undefined ? {} : { actions: write.actions }),
  };
}

/**
 * Creates or updates the door's check run on `headSha`; annotations beyond
 * the first 50 are appended in further updates (GitHub keeps them).
 */
export async function writeCheckRun(client: ForgeClient, repository: Repository, headSha: string, write: CheckRunWrite, existing: number | null): Promise<number> {
  const annotations = write.annotations ?? [];
  const first = annotations.slice(0, ANNOTATIONS_PER_REQUEST);
  let id = existing;
  if (id === null) {
    const created = record((await client.rest({ method: "POST", path: `${base(repository)}/check-runs`, body: { name: DOOR_CHECK_NAME, head_sha: headSha, ...checkBody(write, first) } })).data, "a created check run");
    id = integer(created.id, "a created check run id");
  } else {
    await client.rest({ method: "PATCH", path: `${base(repository)}/check-runs/${id}`, body: checkBody(write, first) });
  }
  for (let offset = ANNOTATIONS_PER_REQUEST; offset < annotations.length; offset += ANNOTATIONS_PER_REQUEST) {
    await client.rest({ method: "PATCH", path: `${base(repository)}/check-runs/${id}`, body: { output: { title: write.title, summary: write.summary, annotations: annotations.slice(offset, offset + ANNOTATIONS_PER_REQUEST) } } });
  }
  return id;
}

/** Dispatches `workflow` on `ref` with `inputs` and answers the run id GitHub created (API 2026-03-10: `return_run_details`). */
export async function dispatchWorkflow(client: ForgeClient, repository: Repository, workflow: string, ref: string, inputs: Readonly<Record<string, string>>): Promise<number> {
  const answer = record((await client.rest({ method: "POST", path: `${base(repository)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, body: { ref, inputs, return_run_details: true } })).data, "a dispatch answer");
  return integer(answer.workflow_run_id, "the dispatched run id");
}

export type QueueEntry = Readonly<{ position: number; state: string; headCommit: string; baseCommit: string; pullNumber: number; pullHead: string }>;

/** The merge queue of `branch`, in position order (GraphQL `mergeQueue.entries`). */
export async function mergeQueueEntries(client: ForgeClient, repository: Repository, branch: string): Promise<readonly QueueEntry[]> {
  const query = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: $branch) {
      entries(first: 100) { nodes { position state headCommit { oid } baseCommit { oid } pullRequest { number headRefOid } } }
    }
  }
}`;
  const data = record(await client.graphql(query, { owner: repository.owner, name: repository.name, branch }), "a merge queue answer");
  const queue = record(record(data.repository, "a repository").mergeQueue, "a merge queue");
  const nodes = record(queue.entries, "queue entries").nodes;
  if (!Array.isArray(nodes)) refuse("queue entry nodes");
  return deepFreeze((nodes as unknown[]).map((entry) => {
    const node = record(entry, "a queue entry");
    const pull = record(node.pullRequest, "a queued pull request");
    return {
      position: integer(node.position, "a queue position"),
      state: text(node.state, "a queue entry state"),
      headCommit: sha(record(node.headCommit, "an entry head commit").oid, "an entry head commit"),
      baseCommit: sha(record(node.baseCommit, "an entry base commit").oid, "an entry base commit"),
      pullNumber: integer(pull.number, "a queued pull number"),
      pullHead: sha(pull.headRefOid, "a queued pull head"),
    };
  }).toSorted((left, right) => left.position - right.position));
}
