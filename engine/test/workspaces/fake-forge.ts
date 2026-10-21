import { HarnessError } from "../../src/kernel/errors.ts";
import { deepFreeze } from "../../src/kernel/integrity.ts";
import { resolveGitExecutable } from "../../src/git/git-adapter.ts";
import { commitTreeReader, gitOutput, writeTree, type GitRepository } from "../../src/git/tree-reader.ts";
import type { ForgeCommit, ForgePullRequest, ForgeTreeEntry, WorkspaceForge } from "../../src/workflow/workspace-forge.ts";

/**
 * A FAKE FORGE backed by a real bare repository (the workspace's remote): the
 * Git Data API writes real objects there, so the publisher's fetch-back and
 * the local branch's compare-and-swap run for real against what it made. The
 * pull requests are kept in memory with GitHub's own refusals where the
 * workspace depends on them (a pull request needs a commit beyond its base;
 * only an open one is updated). Every call is recorded, the request as given:
 * a test can prove what a commit request carried (and that it carried no
 * author or committer at all).
 */

export type FakeForgeCall = Readonly<{ op: string; request: unknown }>;

type FakePull = { number: number; head: string; base: string; title: string; body: string; draft: boolean; state: "open" | "closed"; merged: boolean; mergeCommitSha: string | null; comments: string[] };

export type FakeForge = WorkspaceForge & Readonly<{
  bare: string;
  calls: FakeForgeCall[];
  pulls: Map<number, FakePull>;
  /** Whether the commits this forge makes are signed (default true). */
  setVerified(verified: boolean): void;
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
  let verified = true;
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
    state: pull.state, merged: pull.merged, mergeCommitSha: pull.mergeCommitSha,
  });
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
      const pull: FakePull = { number: pulls.size + 1, head: request.head, base: request.base, title: request.title, body: request.body, draft: true, state: "open", merged: false, mergeCommitSha: null, comments: [] };
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
  };
}
