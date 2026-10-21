import { HarnessError } from "../../src/kernel/errors.ts";
import { deepFreeze } from "../../src/kernel/integrity.ts";
import { resolveGitExecutable } from "../../src/git/git-adapter.ts";
import { commitTreeReader, gitOutput, writeTree, type GitRepository } from "../../src/git/tree-reader.ts";
import type { ForgeCommit, ForgeMergeAnswer, ForgeMergeResult, ForgePullRequest, ForgeTreeEntry, WorkspaceForge } from "../../src/workflow/workspace-forge.ts";

/**
 * A FAKE FORGE backed by a real bare repository (the workspace's remote): the
 * Git Data API writes real objects there, so the publisher's fetch-back and
 * the local branch's compare-and-swap run for real against what it made. The
 * pull requests are kept in memory with GitHub's own refusals where the
 * workspace depends on them (a pull request needs a commit beyond its base;
 * only an open one is updated). THE MERGE QUEUE is GitHub's async merge API:
 * a request is accepted (202, its id) or answered from the pull request's
 * state (200 merged/enqueued, 409 a pending request, 400 a draft or a closed
 * one); {@link FakeForge.advanceQueue} is one step of the queue — pending
 * requests are enqueued (or fail: the head moved), then each queued pull
 * request is merged onto the trunk as a merge commit (parents: the trunk,
 * the head) unless its group fails (`setQueueVerdict`) or git cannot merge it,
 * which dequeues it. Every call is recorded, the request as given:
 * a test can prove what a commit request carried (and that it carried no
 * author or committer at all).
 */

export type FakeForgeCall = Readonly<{ op: string; request: unknown }>;

type FakePull = { number: number; head: string; base: string; title: string; body: string; draft: boolean; state: "open" | "closed"; merged: boolean; mergeCommitSha: string | null; queued: boolean; comments: string[] };

type FakeMergeRequest = { id: string; number: number; sha: string; result: ForgeMergeResult };

export type FakeForge = WorkspaceForge & Readonly<{
  bare: string;
  calls: FakeForgeCall[];
  pulls: Map<number, FakePull>;
  /** Whether the commits this forge makes are signed (default true). */
  setVerified(verified: boolean): void;
  requests: Map<string, FakeMergeRequest>;
  /** The queue's CI verdict on a pull request's group (default: pass); `hold` keeps it queued. */
  setQueueVerdict(verdict: (pull: FakePull) => "pass" | "fail" | "hold"): void;
  /** The answer every next merge request gets instead of the queue's (a refusal), or null. */
  setRequestRefusal(refusal: Extract<ForgeMergeAnswer, { kind: "refused" }> | null): void;
  /** One step of the merge queue (see the header). */
  advanceQueue(): void;
}>;

/** The identity a forge commit carries (the forge's own, as GitHub's web-flow is). */
const FORGE_IDENTITY = deepFreeze({
  GIT_AUTHOR_NAME: "forge-app[bot]", GIT_AUTHOR_EMAIL: "forge-app@forge.test", GIT_AUTHOR_DATE: "2026-10-21T00:00:00Z",
  GIT_COMMITTER_NAME: "Forge", GIT_COMMITTER_EMAIL: "noreply@forge.test", GIT_COMMITTER_DATE: "2026-10-21T00:00:00Z",
});

/** A fake forge over the bare repository `bare`; `scratch` holds its private indexes (the tree writer's). */
export function createFakeForge(bare: string, scratch: string): FakeForge {
  const repository: GitRepository = deepFreeze({ root: bare, executable: resolveGitExecutable(), timeoutMs: 30_000 });
  const calls: FakeForgeCall[] = [];
  const pulls = new Map<number, FakePull>();
  const requests = new Map<string, FakeMergeRequest>();
  let verified = true;
  let queueVerdict: (pull: FakePull) => "pass" | "fail" | "hold" = () => "pass";
  let requestRefusal: Extract<ForgeMergeAnswer, { kind: "refused" }> | null = null;
  const git = (argv: readonly string[], options: Readonly<{ input?: Buffer; environment?: Readonly<Record<string, string>>; allowed?: readonly number[] }> = {}): string =>
    gitOutput(repository, argv, options).stdout.toString("utf8").trim();
  const headOf = (branch: string): string | null => {
    const found = gitOutput(repository, ["rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`], { allowed: [0, 1] });
    return found.status === 0 ? found.stdout.toString("utf8").trim() : null;
  };
  const record = (op: string, request: unknown): void => {
    calls.push(deepFreeze({ op, request }));
  };
  const view = (pull: FakePull): ForgePullRequest => deepFreeze({
    number: pull.number, url: `https://forge.test/pull/${String(pull.number)}`, headSha: headOf(pull.head) ?? "", draft: pull.draft,
    state: pull.state, merged: pull.merged, mergeCommitSha: pull.mergeCommitSha, queued: pull.queued,
  });
  /** Merges a queued pull request onto its base as GitHub's queue does (a merge commit), or answers why it cannot. */
  const mergeQueued = (pull: FakePull): string | null => {
    const base = headOf(pull.base)!;
    const head = headOf(pull.head)!;
    const merged = gitOutput(repository, ["merge-tree", "--write-tree", base, head], { allowed: [0, 1] });
    if (merged.status !== 0) return null;
    const tree = merged.stdout.toString("utf8").split("\n")[0]!.trim();
    const commit = git(["commit-tree", tree, "-p", base, "-p", head, "-F", "-"], { input: Buffer.from(`Merge pull request #${String(pull.number)} from ${pull.head}\n`, "utf8"), environment: FORGE_IDENTITY });
    git(["update-ref", `refs/heads/${pull.base}`, commit, base]);
    return commit;
  };
  const requirePull = (number: number): FakePull => {
    const pull = pulls.get(number);
    if (pull === undefined) throw new HarnessError(`pull request #${String(number)} does not exist`, "forge_not_found");
    return pull;
  };
  return {
    bare,
    calls,
    pulls,
    requests,
    setVerified(value: boolean): void {
      verified = value;
    },
    setQueueVerdict(verdict: (pull: FakePull) => "pass" | "fail" | "hold"): void {
      queueVerdict = verdict;
    },
    setRequestRefusal(refusal: Extract<ForgeMergeAnswer, { kind: "refused" }> | null): void {
      requestRefusal = refusal;
    },
    advanceQueue(): void {
      for (const request of requests.values()) {
        if (request.result.status !== "pending") continue;
        const pull = requirePull(request.number);
        if (headOf(pull.head) !== request.sha) {
          request.result = { status: "failed", message: "the head of the pull request changed after the merge was requested" };
          continue;
        }
        pull.queued = true;
        request.result = { status: "enqueued" };
      }
      for (const pull of pulls.values()) {
        if (!pull.queued) continue;
        const verdict = queueVerdict(pull);
        if (verdict === "hold") continue;
        const commit = verdict === "pass" ? mergeQueued(pull) : null;
        pull.queued = false;
        if (commit === null) continue;
        pull.merged = true;
        pull.mergeCommitSha = commit;
        pull.state = "closed";
      }
    },
    async createBlob(content: Buffer): Promise<string> {
      record("createBlob", { bytes: content.length });
      return git(["hash-object", "-w", "--stdin"], { input: content });
    },
    async createTree(request: Readonly<{ baseTree: string; entries: readonly ForgeTreeEntry[] }>): Promise<string> {
      record("createTree", request);
      const base = commitTreeReader(repository, request.baseTree);
      const entries = new Map(base.paths().map((path) => [path, base.entry(path)!] as const));
      for (const entry of request.entries) {
        if (entry.sha === null) entries.delete(entry.path);
        else entries.set(entry.path, { mode: entry.mode, oid: entry.sha });
      }
      return writeTree(repository, new Map([...entries].map(([path, entry]) => [path, { mode: entry.mode, oid: entry.oid! }])), scratch);
    },
    async createCommit(request: Readonly<{ message: string; tree: string; parents: readonly string[] }>): Promise<ForgeCommit> {
      record("createCommit", request);
      const sha = git(["commit-tree", request.tree, ...request.parents.flatMap((parent) => ["-p", parent]), "-F", "-"], { input: Buffer.from(request.message, "utf8"), environment: FORGE_IDENTITY });
      return deepFreeze({ sha, tree: request.tree, verified, verificationReason: verified ? "valid" : "unsigned" });
    },
    async branchHead(branch: string): Promise<string | null> {
      record("branchHead", { branch });
      return headOf(branch);
    },
    async setBranch(request: Readonly<{ branch: string; sha: string; previous: string | null }>): Promise<void> {
      record("setBranch", request);
      if (request.previous === null && headOf(request.branch) !== null) throw new HarnessError(`reference refs/heads/${request.branch} already exists`, "forge_validation_failed");
      git(["update-ref", `refs/heads/${request.branch}`, request.sha]);
    },
    async findPullRequest(branch: string): Promise<ForgePullRequest | null> {
      record("findPullRequest", { branch });
      const pull = [...pulls.values()].find((candidate) => candidate.head === branch && candidate.state === "open");
      return pull === undefined ? null : view(pull);
    },
    async openDraftPullRequest(request: Readonly<{ head: string; base: string; title: string; body: string }>): Promise<ForgePullRequest> {
      record("openDraftPullRequest", request);
      const head = headOf(request.head);
      if (head === null || git(["rev-list", "--count", `refs/heads/${request.base}..${head}`]) === "0") {
        throw new HarnessError(`No commits between ${request.base} and ${request.head}`, "forge_validation_failed");
      }
      const pull: FakePull = { number: pulls.size + 1, head: request.head, base: request.base, title: request.title, body: request.body, draft: true, state: "open", merged: false, mergeCommitSha: null, queued: false, comments: [] };
      pulls.set(pull.number, pull);
      return view(pull);
    },
    async updatePullRequest(number: number, request: Readonly<{ title: string; body: string }>): Promise<void> {
      record("updatePullRequest", { number, ...request });
      const pull = requirePull(number);
      pull.title = request.title;
      pull.body = request.body;
    },
    async markReadyForReview(number: number): Promise<void> {
      record("markReadyForReview", { number });
      requirePull(number).draft = false;
    },
    async closePullRequest(number: number, comment: string): Promise<void> {
      record("closePullRequest", { number, comment });
      const pull = requirePull(number);
      pull.comments.push(comment);
      pull.state = "closed";
    },
    async pullRequest(number: number): Promise<ForgePullRequest> {
      record("pullRequest", { number });
      return view(requirePull(number));
    },
    async requestMerge(number: number, request: Readonly<{ sha: string }>): Promise<ForgeMergeAnswer> {
      record("requestMerge", { number, ...request });
      if (requestRefusal !== null) return requestRefusal;
      const pull = requirePull(number);
      if (pull.merged) return { kind: "merged", mergeCommitSha: pull.mergeCommitSha! };
      if (pull.queued) return { kind: "enqueued" };
      if (pull.state !== "open" || pull.draft) return { kind: "refused", status: 400, message: `pull request #${String(number)} is ${pull.draft ? "a draft" : pull.state}` };
      const pending = [...requests.values()].find((candidate) => candidate.number === number && candidate.result.status === "pending");
      if (pending !== undefined) return { kind: "already-requested", requestId: pending.id, expectedHeadSha: pending.sha };
      const id = `merge-${String(requests.size + 1)}`;
      requests.set(id, { id, number, sha: request.sha, result: { status: "pending" } });
      return { kind: "accepted", requestId: id };
    },
    async mergeRequestResult(number: number, requestId: string): Promise<ForgeMergeResult> {
      record("mergeRequestResult", { number, requestId });
      const request = requests.get(requestId);
      if (request === undefined || request.number !== number) return { status: "expired" };
      return request.result;
    },
  };
}
