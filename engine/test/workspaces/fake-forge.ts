import { HarnessError } from "../../src/kernel/errors.ts";
import { ForgeError } from "../../src/workflow/forge/codes.ts";
import { deepFreeze } from "../../src/kernel/integrity.ts";
import { resolveGitExecutable } from "../../src/git/git-adapter.ts";
import { commitTreeReader, writeTree } from "../../src/git/tree-reader.ts";
import { gitOutput, type GitRepository } from "../../src/git/git-door.ts";
import type { ForgeCommit, ForgeEnqueueAnswer, ForgePullRequest, ForgeTreeEntry, WorkspaceForge } from "../../src/workflow/workspace-forge.ts";
import { subprocessBounds } from "../../src/workflow/workflow-config.ts";

/**
 * A FAKE FORGE backed by a real bare repository (the workspace's remote): the
 * Git Data API writes real objects there, so the publisher's fetch-back and
 * the local branch's compare-and-swap run for real against what it made. The
 * pull requests are kept in memory with GitHub's own refusals where the
 * workspace depends on them (a pull request needs a commit beyond its base;
 * only an open one is updated) and a MERGE QUEUE with GitHub's semantics (an
 * enqueue only at the expected head; a pull request whose head moves leaves
 * the queue; the queue's merge is a real merge commit on the base whose second
 * parent is the head it merged), and the repository's `delete_branch_on_merge`
 * (a merged pull request's head branch is deleted, and every open pull
 * request based on that branch is closed with it — why a stack never opens a
 * pull request against another one's branch). Every call is recorded, the request as given:
 * a test can prove what a commit request carried (and that it carried no
 * author or committer at all).
 */

export type FakeForgeCall = Readonly<{ op: string; request: unknown }>;

type FakePull = { number: number; head: string; base: string; title: string; body: string; draft: boolean; state: "open" | "closed"; merged: boolean; mergeCommitSha: string | null; comments: string[]; queuedHead: string | null; queuedAt: number };

export type FakeForge = WorkspaceForge & Readonly<{
  bare: string;
  calls: FakeForgeCall[];
  pulls: Map<number, FakePull>;
  /** Whether the commits this forge makes are signed (default true). */
  setVerified(verified: boolean): void;
  /** The head the next enqueue answers it queued (a forge that queued another head than asked), or null for the truth. */
  answerEnqueueAt(head: string | null): void;
  /** The next merge-queue read fails with `error` (a forge that cannot answer), or null to answer truly. */
  failMergeQueueWith(error: Error | null): void;
  /**
   * The queue merges pull request `number` into its base: a merge commit of
   * the base's tip and `head` (default: the head it was queued at — another
   * one is a queue that merged a head nobody asked for).
   */
  runQueue(number: number, head?: string): string;
  /** The queue drops pull request `number` without merging it (its group failed). */
  dropFromQueue(number: number): void;
}>;

/** The identity a forge commit carries (the forge's own, as GitHub's web-flow is). */
const FORGE_IDENTITY = deepFreeze({
  GIT_AUTHOR_NAME: "forge-app[bot]", GIT_AUTHOR_EMAIL: "forge-app@forge.test", GIT_AUTHOR_DATE: "2026-10-21T00:00:00Z",
  GIT_COMMITTER_NAME: "Forge", GIT_COMMITTER_EMAIL: "noreply@forge.test", GIT_COMMITTER_DATE: "2026-10-21T00:00:00Z",
});

/** A fake forge over the bare repository `bare`; `scratch` holds its private indexes (the tree writer's). */
export function createFakeForge(bare: string, scratch: string): FakeForge {
  const repository: GitRepository = deepFreeze({ root: bare, executable: resolveGitExecutable(), bounds: subprocessBounds({}) });
  const calls: FakeForgeCall[] = [];
  const pulls = new Map<number, FakePull>();
  let verified = true;
  let enqueueAnswer: string | null = null;
  let mergeQueueFailure: Error | null = null;
  // The queue's order: each enqueue takes the next position.
  let queueClock = 0;
  const git = (argv: readonly string[], options: Readonly<{ input?: Buffer; environment?: Readonly<Record<string, string>>; allowed?: readonly number[] }> = {}): string =>
    gitOutput(repository, argv, options).stdout.toString("utf8").trim();
  const headOf = (branch: string): string | null => {
    const found = gitOutput(repository, ["rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`], { allowed: [0, 1] });
    return found.status === 0 ? found.stdout.toString("utf8").trim() : null;
  };
  const record = (op: string, request: unknown): void => {
    calls.push(deepFreeze({ op, request }));
  };
  const view = (pull: FakePull): ForgePullRequest => {
    const headSha = headOf(pull.head) ?? "";
    // GitHub's queue drops a pull request whose head moved.
    if (pull.queuedHead !== null && pull.queuedHead !== headSha) pull.queuedHead = null;
    return deepFreeze({
      number: pull.number, url: `https://forge.test/pull/${String(pull.number)}`, headSha, base: pull.base, draft: pull.draft,
      state: pull.state, merged: pull.merged, mergeCommitSha: pull.mergeCommitSha, queued: pull.queuedHead !== null,
    });
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
    setVerified(value: boolean): void {
      verified = value;
    },
    answerEnqueueAt(head: string | null): void {
      enqueueAnswer = head;
    },
    failMergeQueueWith(error: Error | null): void {
      mergeQueueFailure = error;
    },
    runQueue(number: number, head?: string): string {
      const pull = requirePull(number);
      const queued = view(pull).queued ? pull.queuedHead : null;
      const merging = head ?? queued;
      if (merging === null) throw new HarnessError(`pull request #${String(number)} is not in the merge queue`, "forge_validation_failed");
      const baseTip = headOf(pull.base)!;
      const tree = git(["merge-tree", "--write-tree", baseTip, merging]).split("\n")[0]!;
      const merge = git(["commit-tree", tree, "-p", baseTip, "-p", merging, "-F", "-"], { input: Buffer.from(`Merge pull request #${String(number)}\n`, "utf8"), environment: FORGE_IDENTITY });
      git(["update-ref", `refs/heads/${pull.base}`, merge, baseTip]);
      Object.assign(pull, { merged: true, mergeCommitSha: merge, state: "closed", queuedHead: null });
      // delete_branch_on_merge: the head branch goes, and the pull requests based on it are closed with it.
      git(["update-ref", "-d", `refs/heads/${pull.head}`]);
      for (const other of pulls.values()) if (other.state === "open" && other.base === pull.head) other.state = "closed";
      return merge;
    },
    dropFromQueue(number: number): void {
      requirePull(number).queuedHead = null;
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
    async setBranch(request: Readonly<{ branch: string; sha: string; previous: string | null; forwardOnly: boolean }>): Promise<Readonly<{ applied: boolean }>> {
      record("setBranch", request);
      // `force: false`, as GitHub's: a move that is not a fast-forward is refused (422), never applied.
      if (request.forwardOnly && request.previous !== null && headOf(request.branch) === request.previous
        && gitOutput(repository, ["merge-base", "--is-ancestor", request.previous, request.sha], { allowed: [0, 1] }).status !== 0) {
        throw new ForgeError("github_validation_failed", `the move of ${request.branch} to ${request.sha} is not a fast forward`, { branch: request.branch });
      }
      // A compare-and-swap, as GraphQL `updateRefs` with `beforeOid` (and a create only while absent): git's own.
      const swapped = gitOutput(repository, ["update-ref", `refs/heads/${request.branch}`, request.sha, request.previous ?? "0".repeat(40)], { allowed: [0, 1, 128] });
      return deepFreeze({ applied: swapped.status === 0 });
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
      const pull: FakePull = { number: pulls.size + 1, head: request.head, base: request.base, title: request.title, body: request.body, draft: true, state: "open", merged: false, mergeCommitSha: null, comments: [], queuedHead: null, queuedAt: 0 };
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
    async convertToDraft(number: number): Promise<void> {
      record("convertToDraft", { number });
      requirePull(number).draft = true;
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
    async enqueue(number: number, request: Readonly<{ expectedHeadSha: string }>): Promise<ForgeEnqueueAnswer> {
      record("enqueue", { number, ...request });
      const pull = requirePull(number);
      const current = view(pull);
      const refusal = current.state !== "open" ? "Pull request is closed"
        : current.draft ? "Pull request is in draft"
          : current.headSha !== request.expectedHeadSha ? `Expected head ${request.expectedHeadSha} does not match ${current.headSha}`
            : null;
      if (refusal !== null) return deepFreeze({ kind: "refused", message: refusal });
      pull.queuedHead = current.headSha;
      pull.queuedAt = ++queueClock;
      return deepFreeze({ kind: "enqueued", headSha: enqueueAnswer ?? current.headSha });
    },
    async mergeQueue(base: string) {
      record("mergeQueue", { base });
      if (mergeQueueFailure !== null) {
        const failure = mergeQueueFailure;
        mergeQueueFailure = null;
        throw failure;
      }
      // A queued head is fetched from its branch on this forge (GitHub's is refs/pull/<n>/head).
      return deepFreeze([...pulls.values()].filter((pull) => pull.base === base && view(pull).queued).toSorted((left, right) => left.queuedAt - right.queuedAt)
        .map((pull) => ({ number: pull.number, headSha: pull.queuedHead!, fetchRef: `refs/heads/${pull.head}` })));
    },
  };
}
