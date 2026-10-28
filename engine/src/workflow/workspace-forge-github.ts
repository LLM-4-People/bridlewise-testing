/**
 * THE WORKSPACE'S FORGE ON GITHUB — the GitHub implementation of the port
 * `ws` consumes (`WorkspaceForge`, `workspace-forge.ts`), written as typed
 * operations ON the forge client (`src/workflow/forge/port.ts`: the one
 * REST/GraphQL client, through the ONE outbound HTTP door, the API version
 * pinned, every refusal a typed `ForgeError`). No request is built anywhere
 * else.
 *
 * Each operation is one GitHub call (or the read that names its object):
 * - the Git Data API over REST: `POST …/git/blobs` (base64), `POST
 *   …/git/trees` (`base_tree`; a deletion is `sha: null` with the entry's own
 *   mode), `POST …/git/commits` with NO author, committer or signature (the
 *   App's commit is GitHub's to sign: `verification`), `GET …/git/ref/heads/…`;
 * - the branch move as a COMPARE-AND-SWAP: a create is `POST …/git/refs`
 *   (refused while the ref exists); a move is GraphQL `updateRefs` with
 *   `beforeOid`, forced only when the caller allows a move that is not a
 *   fast-forward (`forwardOnly: false`; REST `PATCH …/git/refs` has no
 *   compare-and-swap and is never used); a refused move is read back, so
 *   "moved elsewhere" is an answer, not an error;
 * - the pull request: REST to open (`draft: true`), regenerate, comment and
 *   close; GraphQL to leave and return to draft; and ONE GraphQL read of its
 *   whole state (head, base, draft, open/closed/merged, the merge commit, and
 *   whether it is in the merge queue), so no two reads can straddle the
 *   queue's merge;
 * - the land: GraphQL `enqueuePullRequest` with `expectedHeadOid` (the head
 *   this workspace published: a push in between refuses the enqueue), the
 *   enqueued head read back from GitHub's own answer. Auto-merge is never
 *   used: it does not enqueue on ruleset queues.
 */
import { HarnessError } from "../kernel/errors.ts";
import { admitHarnessKeyHome } from "../filesystem/self-protection/key-home.ts";
import { keyHomeCustody, type AppKeyCustody } from "./forge/app-keys.ts";
import type { ForgeAppRole } from "./forge/app-registry.ts";
import { ForgeError, isForgeError } from "./forge/codes.ts";
import { configuredForge, configuredForgeClient } from "./forge/configured-forge.ts";
import { appInstallationCredential } from "./forge/credentials.ts";
import { forgeEndpoint, trunkRepository } from "./forge/forge-config.ts";
import type { ForgeClient } from "./forge/port.ts";
import { repositoryPath } from "./forge/repository-reads.ts";
import type { ForgeCommit, ForgeEnqueueAnswer, ForgePullRequest, ForgeQueueEntry, ForgeTreeEntry, WorkspaceForge, WorkspaceForgeFactory } from "./workspace-forge.ts";

/** The repository the forge serves, `owner/name`. */
export type GithubWorkspaceRepository = Readonly<{ owner: string; name: string }>;

/** The one read of a pull request's whole state. */
const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id number url headRefOid baseRefName isDraft state merged mergeCommit { oid } isInMergeQueue }
  }
}`;

/** The merge queue of one branch, in queue order (GitHub's own positions). */
const MERGE_QUEUE_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: $branch) { entries(first: 100) { nodes { position pullRequest { number headRefOid } } } }
  }
}`;

const REPOSITORY_ID_QUERY = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`;

const UPDATE_REF_MUTATION = `mutation($repositoryId: ID!, $name: GitRefname!, $after: GitObjectID!, $before: GitObjectID!, $force: Boolean!) {
  updateRefs(input: { repositoryId: $repositoryId, refUpdates: [{ name: $name, afterOid: $after, beforeOid: $before, force: $force }] }) { clientMutationId }
}`;

const READY_MUTATION = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`;
const DRAFT_MUTATION = `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`;
const ENQUEUE_MUTATION = `mutation($id: ID!, $head: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { mergeQueueEntry { state pullRequest { headRefOid } } }
}`;

type PullRequestNode = Readonly<{
  id?: unknown; number?: unknown; url?: unknown; headRefOid?: unknown; baseRefName?: unknown; isDraft?: unknown;
  state?: unknown; merged?: unknown; mergeCommit?: { oid?: unknown } | null; isInMergeQueue?: unknown;
}>;

function invalid(what: string): never {
  throw new ForgeError("github_response_invalid", `GitHub's answer to ${what} is not what the workspace reads.`, { path: what });
}

function text(value: unknown, what: string): string {
  return typeof value === "string" && value !== "" ? value : invalid(what);
}

/** The workspace's forge on GitHub for `repository`, through `client` (see the header). */
export function githubWorkspaceForge(client: ForgeClient, repository: GithubWorkspaceRepository): WorkspaceForge {
  const base = repositoryPath(`${repository.owner}/${repository.name}`);
  const headRef = (branch: string): string => `refs/heads/${branch}`;
  const refPath = (branch: string): string => `${base}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
  const nodeIds = new Map<number, string>();
  let repositoryId: string | undefined;

  async function readPullRequest(number: number): Promise<ForgePullRequest> {
    const data = await client.graphql<{ repository?: { pullRequest?: PullRequestNode | null } | null }>(PULL_REQUEST_QUERY, { owner: repository.owner, name: repository.name, number });
    const node = data.repository?.pullRequest;
    if (node === undefined || node === null) throw new ForgeError("github_not_found", `pull request #${String(number)} does not exist in ${repository.owner}/${repository.name}.`, { number });
    nodeIds.set(number, text(node.id, "pullRequest.id"));
    const state = node.state === "OPEN" ? "open" : node.state === "CLOSED" || node.state === "MERGED" ? "closed" : invalid("pullRequest.state");
    return Object.freeze({
      number: typeof node.number === "number" ? node.number : invalid("pullRequest.number"),
      url: text(node.url, "pullRequest.url"),
      headSha: text(node.headRefOid, "pullRequest.headRefOid"),
      base: text(node.baseRefName, "pullRequest.baseRefName"),
      draft: node.isDraft === true,
      state,
      merged: node.merged === true,
      mergeCommitSha: typeof node.mergeCommit?.oid === "string" ? node.mergeCommit.oid : null,
      queued: node.isInMergeQueue === true,
    });
  }

  async function nodeIdOf(number: number): Promise<string> {
    return nodeIds.get(number) ?? (await readPullRequest(number), nodeIds.get(number)!);
  }

  async function branchHead(branch: string): Promise<string | null> {
    try {
      const answer = await client.rest<{ object?: { sha?: unknown } }>({ method: "GET", path: refPath(branch) });
      return text(answer.data?.object?.sha, "git ref");
    } catch (error) {
      if (isForgeError(error, "github_not_found")) return null;
      throw error;
    }
  }

  return Object.freeze({
    async createBlob(content: Buffer): Promise<string> {
      const answer = await client.rest<{ sha?: unknown }>({ method: "POST", path: `${base}/git/blobs`, body: { content: content.toString("base64"), encoding: "base64" } });
      return text(answer.data?.sha, "git blob");
    },
    async createTree(request: Readonly<{ baseTree: string; entries: readonly ForgeTreeEntry[] }>): Promise<string> {
      const tree = request.entries.map((entry) => ({ path: entry.path, mode: entry.mode, type: entry.mode === "160000" ? "commit" : "blob", sha: entry.sha }));
      const answer = await client.rest<{ sha?: unknown }>({ method: "POST", path: `${base}/git/trees`, body: { base_tree: request.baseTree, tree } });
      return text(answer.data?.sha, "git tree");
    },
    async createCommit(request: Readonly<{ message: string; tree: string; parents: readonly string[] }>): Promise<ForgeCommit> {
      const answer = await client.rest<{ sha?: unknown; tree?: { sha?: unknown }; verification?: { verified?: unknown; reason?: unknown } }>({
        method: "POST", path: `${base}/git/commits`, body: { message: request.message, tree: request.tree, parents: [...request.parents] },
      });
      return Object.freeze({
        sha: text(answer.data?.sha, "git commit"),
        tree: text(answer.data?.tree?.sha, "git commit tree"),
        verified: answer.data?.verification?.verified === true,
        verificationReason: typeof answer.data?.verification?.reason === "string" ? answer.data.verification.reason : "unknown",
      });
    },
    branchHead,
    async setBranch(request: Readonly<{ branch: string; sha: string; previous: string | null; forwardOnly: boolean }>): Promise<Readonly<{ applied: boolean }>> {
      try {
        if (request.previous === null) {
          await client.rest({ method: "POST", path: `${base}/git/refs`, body: { ref: headRef(request.branch), sha: request.sha } });
        } else {
          repositoryId ??= text((await client.graphql<{ repository?: { id?: unknown } | null }>(REPOSITORY_ID_QUERY, { owner: repository.owner, name: repository.name })).repository?.id, "repository.id");
          await client.graphql(UPDATE_REF_MUTATION, { repositoryId, name: headRef(request.branch), after: request.sha, before: request.previous, force: !request.forwardOnly });
        }
        return Object.freeze({ applied: true });
      } catch (error) {
        // A refused swap is an ANSWER when the branch is no longer where it was expected: another writer moved it.
        if (isForgeError(error) && error.forgeClass === "refused" && await branchHead(request.branch) !== request.previous) return Object.freeze({ applied: false });
        throw error;
      }
    },
    async findPullRequest(branch: string): Promise<ForgePullRequest | null> {
      const answer = await client.rest<readonly { number?: unknown }[]>({ method: "GET", path: `${base}/pulls`, query: { head: `${repository.owner}:${branch}`, state: "open", per_page: 2 } });
      const first = answer.data?.[0];
      return first === undefined ? null : readPullRequest(typeof first.number === "number" ? first.number : invalid("pull number"));
    },
    async openDraftPullRequest(request: Readonly<{ head: string; base: string; title: string; body: string }>): Promise<ForgePullRequest> {
      const answer = await client.rest<{ number?: unknown }>({ method: "POST", path: `${base}/pulls`, body: { title: request.title, head: request.head, base: request.base, body: request.body, draft: true } });
      return readPullRequest(typeof answer.data?.number === "number" ? answer.data.number : invalid("pull number"));
    },
    async updatePullRequest(number: number, request: Readonly<{ title: string; body: string }>): Promise<void> {
      await client.rest({ method: "PATCH", path: `${base}/pulls/${String(number)}`, body: { title: request.title, body: request.body } });
    },
    async markReadyForReview(number: number): Promise<void> {
      await client.graphql(READY_MUTATION, { id: await nodeIdOf(number) });
    },
    async convertToDraft(number: number): Promise<void> {
      await client.graphql(DRAFT_MUTATION, { id: await nodeIdOf(number) });
    },
    async closePullRequest(number: number, comment: string): Promise<void> {
      await client.rest({ method: "POST", path: `${base}/issues/${String(number)}/comments`, body: { body: comment } });
      await client.rest({ method: "PATCH", path: `${base}/pulls/${String(number)}`, body: { state: "closed" } });
    },
    pullRequest: readPullRequest,
    async enqueue(number: number, request: Readonly<{ expectedHeadSha: string }>): Promise<ForgeEnqueueAnswer> {
      try {
        const data = await client.graphql<{ enqueuePullRequest?: { mergeQueueEntry?: { pullRequest?: { headRefOid?: unknown } } | null } | null }>(ENQUEUE_MUTATION, { id: await nodeIdOf(number), head: request.expectedHeadSha });
        return Object.freeze({ kind: "enqueued", headSha: text(data.enqueuePullRequest?.mergeQueueEntry?.pullRequest?.headRefOid, "enqueuePullRequest") });
      } catch (error) {
        // GitHub's judgement of the pull request (not mergeable, not the expected head, checks or reviews missing) is the land's
        // typed answer; a permission, a budget or an outage is not — it stays the forge's error.
        if (isForgeError(error, "github_validation_failed", "github_conflict", "github_precondition_failed")) return Object.freeze({ kind: "refused", message: error.message });
        throw error;
      }
    },
    async mergeQueue(branch: string): Promise<readonly ForgeQueueEntry[]> {
      const data = await client.graphql<{ repository?: { mergeQueue?: { entries?: { nodes?: unknown } } | null } | null }>(MERGE_QUEUE_QUERY, { owner: repository.owner, name: repository.name, branch });
      const nodes = data.repository?.mergeQueue?.entries?.nodes ?? [];
      if (!Array.isArray(nodes)) invalid("mergeQueue.entries");
      return Object.freeze((nodes as { position?: unknown; pullRequest?: { number?: unknown; headRefOid?: unknown } | null }[])
        .map((node) => {
          const number = node.pullRequest?.number;
          if (typeof number !== "number" || typeof node.position !== "number") invalid("mergeQueue.entries.nodes");
          // A queued head is fetched from GitHub's own pull-request ref: a fork's head too.
          return { position: node.position as number, entry: Object.freeze({ number, headSha: text(node.pullRequest?.headRefOid, "mergeQueue.headRefOid"), fetchRef: `refs/pull/${String(number)}/head` }) };
        })
        .toSorted((left, right) => left.position - right.position)
        .map(({ entry }) => entry));
    },
  });
}

/**
 * The repository a git remote URL names on the forge whose web origin is
 * `webUrl` (`https://<host>/<owner>/<name>[.git]` or
 * `git@<host>:<owner>/<name>[.git]`), or null when it names none there.
 */
export function forgeRepositoryOfRemote(remoteUrl: string, webUrl: string): GithubWorkspaceRepository | null {
  const host = new URL(webUrl).host.toLowerCase();
  const https = /^https:\/\/([^/@]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(remoteUrl);
  const ssh = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(remoteUrl);
  const match = https ?? ssh;
  if (match === null || match[1]!.toLowerCase() !== host) return null;
  return Object.freeze({ owner: match[2]!, name: match[3]! });
}

/**
 * THE WORKSPACE CLI'S FORGE: for a target whose upstream remote names the
 * configured trunk repository (`forge` section: the organisation and the
 * repository of kind `trunk`) — any other remote (another host's, such as the
 * retired Gitea `testing`) is refused (`workspace_forge_remote_unknown`,
 * naming the GitHub trunk and its `landTargets` branch as the remedy) — the
 * GitHub implementation on the forge client, as the `agent` App
 * (an installation token for that one repository, minted from the host's key
 * custody on first use and renewed in memory; nothing is read or minted
 * until a forge call is made).
 */
export function githubWorkspaceForgeFactory(landTargets: readonly string[]): WorkspaceForgeFactory {
  return (target) => {
    const settings = configuredForge();
    const trunk = trunkRepository(settings);
    const named = forgeRepositoryOfRemote(target.remoteUrl, settings.webUrl);
    if (named === null || named.owner.toLowerCase() !== settings.organization.toLowerCase() || named.name.toLowerCase() !== trunk.name.toLowerCase()) {
      const trunkUrl = `${settings.webUrl.replace(/\/+$/u, "")}/${settings.organization}/${trunk.name}`;
      throw new HarnessError(
        `the target's upstream remote ${target.remote} (${target.remoteUrl}) is not the forge's trunk repository ${trunkUrl}: a workspace lands only on the GitHub trunk (${landTargets.map((branch) => `${trunkUrl} ${branch}`).join(", ")}) — target a branch whose upstream is it (git branch --set-upstream-to <remote of ${trunkUrl}>/${landTargets[0] ?? "main"} <target>)`,
        "workspace_forge_remote_unknown",
        false,
        { remote: target.remote, trunkRepository: trunkUrl, landTargets: landTargets.join(",") },
      );
    }
    // The key home is admitted on the first signature, not here: a workspace that never reaches the forge needs no App key.
    let admitted: AppKeyCustody | undefined;
    const custody: AppKeyCustody = Object.freeze({
      clientId: (role: ForgeAppRole) => (admitted ??= keyHomeCustody(admitHarnessKeyHome([]))).clientId(role),
      signRs256: (role: ForgeAppRole, data: Uint8Array) => (admitted ??= keyHomeCustody(admitHarnessKeyHome([]))).signRs256(role, data),
    });
    const credential = appInstallationCredential(forgeEndpoint(settings), custody, { role: "agent", owner: settings.organization, repository: trunk.name, renewBeforeMs: settings.tokenRenewBeforeMs });
    return githubWorkspaceForge(configuredForgeClient(credential), { owner: settings.organization, name: trunk.name });
  };
}
