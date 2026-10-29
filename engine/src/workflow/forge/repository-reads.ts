/**
 * THE FLOOR'S GITHUB READS, on the forge port — the workflow runs and their jobs, the open
 * code-scanning and Dependabot alerts (with the completeness the floor
 * judges), the releases and the `product` branch's tip the floor status page
 * shows (`scripts/floor/status.mjs`), and the Pages deployments and commit
 * comparison the deploy-order check judges (`scripts/floor/deploy-order.mjs`). They were
 * a second GitHub client (`scripts/floor/github.mjs`, deleted): every read is
 * now a typed call of the one client, through the one outbound door.
 */
import type { ForgeClient } from "./port.ts";
import { ForgeError, isForgeError } from "./codes.ts";

/** The alert endpoints' page size, and the completeness threshold: a full page with no `next` link is not a final page. */
const ALERT_PAGE_SIZE = 100;

export type WorkflowRun = Readonly<{
  id: number;
  name: string | null;
  path: string | null;
  event: string | null;
  status: string | null;
  conclusion: string | null;
  headSha: string | null;
  headBranch: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
}>;

export type AlertCount = Readonly<{
  /** The open alerts, when every page was seen; null otherwise. */
  total: number | null;
  judged: number;
  /** The population the API declared (`rel="last"` of a one-per-page probe); null when it declared none. */
  declaredTotal: number | null;
  high: number;
  critical: number;
  complete: boolean;
  truncated: boolean;
}>;

export type Release = Readonly<{ tag: string; name: string | null; draft: boolean; prerelease: boolean; publishedAt: string | null; url: string }>;

/** `/repos/<owner>/<name>` of `owner/name` (the projection store addresses its repository the same way). */
export function repositoryPath(repository: string): string {
  const [owner, name, ...rest] = repository.split("/");
  if (owner === undefined || name === undefined || owner === "" || name === "" || rest.length > 0) throw new ForgeError("forge_request_invalid", `Not an owner/name repository: ${repository}.`, { repository });
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** The latest page of workflow runs (optionally at one head commit). */
export async function workflowRuns(client: ForgeClient, repository: string, headSha?: string): Promise<readonly WorkflowRun[]> {
  const answer = await client.rest<{ workflow_runs?: Record<string, unknown>[] }>({
    method: "GET", path: `${repositoryPath(repository)}/actions/runs`, query: { per_page: 100, ...(headSha === undefined ? {} : { head_sha: headSha }) },
  });
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return (answer.data?.workflow_runs ?? []).map((run) => Object.freeze({
    id: Number(run.id), name: text(run.name), path: text(run.path), event: text(run.event), status: text(run.status), conclusion: text(run.conclusion),
    headSha: text(run.head_sha), headBranch: text(run.head_branch), createdAt: text(run.created_at), updatedAt: text(run.updated_at), url: text(run.html_url),
  }));
}

export type WorkflowJob = Readonly<{
  id: number;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  url: string | null;
}>;

/**
 * Every job of one workflow run (its latest attempt: `filter=latest`), read
 * page by page up to `maxPages` (the configured `forge.request.maxPages`): a
 * longer list is refused, never truncated, since a claim bound to a job is
 * judged against that job's own conclusion.
 */
export async function workflowJobs(client: ForgeClient, repository: string, runId: number, maxPages: number): Promise<readonly WorkflowJob[]> {
  const jobs = await client.paginate<Record<string, unknown>>(
    { path: `${repositoryPath(repository)}/actions/runs/${String(runId)}/jobs`, query: { filter: "latest" } },
    {
      maxPages, perPage: 100,
      items: (data) => {
        const list = (data as { jobs?: unknown } | null)?.jobs;
        if (!Array.isArray(list)) throw new ForgeError("github_response_invalid", `The jobs of workflow run ${String(runId)} are not a list.`, { runId });
        return list as Record<string, unknown>[];
      },
    },
  );
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return jobs.map((job) => Object.freeze({ id: Number(job.id), name: text(job.name), status: text(job.status), conclusion: text(job.conclusion), url: text(job.html_url) }));
}

/**
 * Whether GitHub itself signed commit `sha` and reports the signature valid
 * (`signature.isValid` and `wasSignedByGitHub`, read through GraphQL: the REST
 * verification object does not say who signed). A commit with no signature is
 * `false`; an unknown commit is a typed refusal, never `false`.
 */
export async function commitSignedByGitHub(client: ForgeClient, repository: string, sha: string): Promise<boolean> {
  const [owner, name] = repositoryPath(repository).split("/").slice(2).map((part) => decodeURIComponent(part));
  const data = await client.graphql<{ repository?: { object?: { signature?: { isValid?: unknown; wasSignedByGitHub?: unknown } | null } | null } | null }>(
    "query($owner: String!, $name: String!, $oid: GitObjectID!) { repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit { signature { isValid wasSignedByGitHub } } } } }",
    { owner, name, oid: sha },
  );
  const commit = data.repository?.object;
  if (commit === undefined || commit === null) throw new ForgeError("github_not_found", `GitHub holds no commit ${sha} in ${repository}.`, { repository, sha });
  return commit.signature?.isValid === true && commit.signature.wasSignedByGitHub === true;
}

/** A pull request's facts a dependency adoption judges: its author, its state, its two commits and the files it changes. */
export type PullRequestFacts = Readonly<{
  number: number;
  authorLogin: string;
  /** GitHub's numeric id of the author's account: what identifies it (a login is only its name). */
  authorId: number;
  authorType: string;
  state: "open" | "closed";
  baseSha: string;
  headSha: string;
  files: readonly Readonly<{ path: string; status: string; previousPath: string | null }>[];
}>;

/** One pull request's facts, its files read page by page up to `maxPages` (a longer list is refused, never truncated). */
export async function pullRequestFacts(client: ForgeClient, repository: string, number: number, maxPages: number): Promise<PullRequestFacts> {
  const answer = await client.rest<Record<string, unknown>>({ method: "GET", path: `${repositoryPath(repository)}/pulls/${String(number)}` });
  const pull = answer.data ?? {};
  const user = (pull.user ?? {}) as Record<string, unknown>;
  const base = (pull.base ?? {}) as Record<string, unknown>;
  const head = (pull.head ?? {}) as Record<string, unknown>;
  const text = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.length === 0) throw new ForgeError("github_response_invalid", `Pull request ${String(number)} answered no ${field}.`, { number, field });
    return value;
  };
  const files = await client.paginate<Record<string, unknown>>({ path: `${repositoryPath(repository)}/pulls/${String(number)}/files` }, { maxPages, perPage: 100 });
  return Object.freeze({
    number,
    authorLogin: text(user.login, "author"),
    authorId: typeof user.id === "number" && Number.isSafeInteger(user.id) && user.id > 0 ? user.id : (() => { throw new ForgeError("github_response_invalid", `Pull request ${String(number)} answered no author id.`, { number, field: "author id" }); })(),
    authorType: text(user.type, "author type"),
    state: pull.state === "open" ? "open" : "closed",
    baseSha: text(base.sha, "base commit"),
    headSha: text(head.sha, "head commit"),
    files: files.map((file) => Object.freeze({ path: text(file.filename, "file name"), status: text(file.status, "file status"), previousPath: typeof file.previous_filename === "string" ? file.previous_filename : null })),
  });
}

/** A file's text at commit `ref`, or null when the commit does not hold it. */
export async function fileAtRef(client: ForgeClient, repository: string, path: string, ref: string): Promise<string | null> {
  try {
    const answer = await client.rest<{ content?: unknown; encoding?: unknown }>({ method: "GET", path: `${repositoryPath(repository)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, query: { ref } });
    if (answer.data?.encoding !== "base64" || typeof answer.data.content !== "string") throw new ForgeError("github_response_invalid", `The contents of ${path} at ${ref} are not base64 text.`, { path, ref });
    return Buffer.from(answer.data.content, "base64").toString("utf8");
  } catch (error) {
    if (isForgeError(error, "github_not_found")) return null;
    throw error;
  }
}

/** The latest run of each workflow (by name, then path). */
export function latestByWorkflow(runs: readonly WorkflowRun[]): ReadonlyMap<string, WorkflowRun> {
  const latest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    const key = run.name ?? run.path ?? "unknown";
    const current = latest.get(key);
    if (current === undefined || String(run.createdAt) > String(current.createdAt)) latest.set(key, run);
  }
  return latest;
}

function pageOf(path: string | undefined): number | null {
  if (path === undefined) return null;
  const page = Number(new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("page"));
  return Number.isInteger(page) && page > 0 ? page : null;
}

function severityOf(kind: "code-scanning" | "dependabot", alert: Record<string, unknown>): unknown {
  if (kind === "code-scanning") {
    const rule = alert.rule as { security_severity_level?: unknown; severity?: unknown } | undefined;
    return rule?.security_severity_level ?? rule?.severity ?? null;
  }
  return (alert.security_advisory as { severity?: unknown } | undefined)?.severity ?? null;
}

/**
 * The open alerts of `kind`, with the facts completeness needs: the population
 * the API declared (a one-alert-per-page probe: its `rel="last"` page number
 * IS the count), how many were judged, and whether every page was seen. A
 * truncated population is reported incomplete, never counted as a smaller pass.
 */
export async function countOpenAlerts(client: ForgeClient, repository: string, kind: "code-scanning" | "dependabot"): Promise<AlertCount> {
  const path = `${repositoryPath(repository)}/${kind === "code-scanning" ? "code-scanning/alerts" : "dependabot/alerts"}`;
  const probe = await client.rest<unknown>({ method: "GET", path, query: { state: "open", per_page: 1, page: 1 } });
  if (!Array.isArray(probe.data)) throw new ForgeError("github_response_invalid", `The ${kind} alert endpoint answered no alert list.`, { kind });
  const declaredTotal = probe.links.last !== undefined ? pageOf(probe.links.last)
    : probe.links.next !== undefined ? null
      : probe.data.length <= 1 ? probe.data.length : null;
  const alerts: Record<string, unknown>[] = [];
  let complete = declaredTotal !== null;
  if (declaredTotal !== null && declaredTotal > 0) {
    const pageCount = Math.ceil(declaredTotal / ALERT_PAGE_SIZE);
    for (let page = 1; page <= pageCount && complete; page += 1) {
      const answer = await client.rest<unknown>({ method: "GET", path, query: { state: "open", per_page: ALERT_PAGE_SIZE, page } });
      if (!Array.isArray(answer.data)) throw new ForgeError("github_response_invalid", `The ${kind} alert endpoint answered no alert list.`, { kind });
      alerts.push(...(answer.data as Record<string, unknown>[]));
      // A page that continues the population must declare the next one; the terminal page must declare none.
      complete = page < pageCount ? pageOf(answer.links.next) === page + 1 : answer.links.next === undefined;
    }
    complete = complete && alerts.length === declaredTotal;
  }
  let high = 0;
  let critical = 0;
  for (const alert of alerts) {
    const severity = severityOf(kind, alert);
    if (severity === "high") high += 1;
    if (severity === "critical") critical += 1;
  }
  return Object.freeze({ total: complete ? alerts.length : null, judged: alerts.length, declaredTotal, high, critical, complete, truncated: !complete });
}

/**
 * Every release, newest first (GitHub's order), read page by page up to
 * `maxPages` (the configured `forge.request.maxPages`): a longer list is
 * refused, never truncated, since the release train's interval and its
 * previous release are judged over all of them.
 */
export async function listReleases(client: ForgeClient, repository: string, maxPages: number): Promise<readonly Release[]> {
  const releases = await client.paginate<Record<string, unknown>>({ path: `${repositoryPath(repository)}/releases` }, { maxPages, perPage: 100 });
  return releases.map((release) => Object.freeze({
    tag: String(release.tag_name), name: typeof release.name === "string" ? release.name : null, draft: release.draft === true, prerelease: release.prerelease === true,
    publishedAt: typeof release.published_at === "string" ? release.published_at : null, url: String(release.html_url),
  }));
}

export type BranchTip = Readonly<{ commit: string; committedAt: string | null }>;

/** A branch's tip, or `null` when the repository has no such branch (e.g. `product` before its first promotion). */
export async function branchTip(client: ForgeClient, repository: string, branch: string): Promise<BranchTip | null> {
  try {
    const answer = await client.rest<{ commit?: { sha?: unknown; commit?: { committer?: { date?: unknown } } } }>({
      method: "GET", path: `${repositoryPath(repository)}/branches/${encodeURIComponent(branch)}`,
    });
    const sha = answer.data?.commit?.sha;
    if (typeof sha !== "string") throw new ForgeError("github_response_invalid", `The branch ${branch} answered no commit.`, { branch });
    const date = answer.data.commit?.commit?.committer?.date;
    return Object.freeze({ commit: sha, committedAt: typeof date === "string" ? date : null });
  } catch (error) {
    if (isForgeError(error, "github_not_found")) return null;
    throw error;
  }
}

export type Deployment = Readonly<{ id: number; sha: string }>;
export type DeploymentStatus = Readonly<{ state: string; environmentUrl: string | null }>;

/** The newest deployments of an environment (one page of 100, newest first). */
export async function deployments(client: ForgeClient, repository: string, environment: string): Promise<readonly Deployment[]> {
  const answer = await client.rest<unknown>({ method: "GET", path: `${repositoryPath(repository)}/deployments`, query: { environment, per_page: 100 } });
  if (!Array.isArray(answer.data)) throw new ForgeError("github_response_invalid", "The deployments endpoint answered no list.", { environment });
  return (answer.data as Record<string, unknown>[]).map((deployment) => Object.freeze({ id: Number(deployment.id), sha: String(deployment.sha) }));
}

/** Every status a deployment reported (newest first, up to 100). */
export async function deploymentStatuses(client: ForgeClient, repository: string, id: number): Promise<readonly DeploymentStatus[]> {
  const answer = await client.rest<unknown>({ method: "GET", path: `${repositoryPath(repository)}/deployments/${String(id)}/statuses`, query: { per_page: 100 } });
  if (!Array.isArray(answer.data)) throw new ForgeError("github_response_invalid", `The statuses of deployment ${String(id)} are not a list.`, { id });
  return (answer.data as Record<string, unknown>[]).map((status) => Object.freeze({
    state: String(status.state), environmentUrl: typeof status.environment_url === "string" && status.environment_url.length > 0 ? status.environment_url : null,
  }));
}

export type CommitComparison = "identical" | "ahead" | "behind" | "diverged";

/**
 * How `head` relates to `base` in the commit graph, or `null` when GitHub
 * no longer holds `base` (a rewritten history): the caller decides what an
 * unknown relation means, never this read.
 */
export async function compareCommits(client: ForgeClient, repository: string, base: string, head: string): Promise<CommitComparison | null> {
  try {
    const answer = await client.rest<{ status?: unknown }>({ method: "GET", path: `${repositoryPath(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}` });
    const status = answer.data?.status;
    if (status === "identical" || status === "ahead" || status === "behind" || status === "diverged") return status;
    throw new ForgeError("github_response_invalid", `The comparison of ${base}...${head} answered an unknown status.`, { base, head });
  } catch (error) {
    if (isForgeError(error, "github_not_found")) return null;
    throw error;
  }
}

/** The floor's word for why a read failed (its status page's vocabulary). */
export function readFailureCode(error: unknown): "authentication" | "unavailable" | "timeout" | "oversized" | "api-error" {
  if (isForgeError(error, "github_unauthorized", "github_forbidden")) return "authentication";
  if (isForgeError(error, "forge_list_oversized")) return "oversized";
  if (isForgeError(error, "github_not_found")) return "unavailable";
  if (isForgeError(error, "github_unavailable")) return "timeout";
  return "api-error";
}
