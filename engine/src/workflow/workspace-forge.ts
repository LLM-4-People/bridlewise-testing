/**
 * THE WORKSPACE ON THE FORGE — what `ws` needs of GitHub, and the one
 * publisher of a workspace's commits there (github-only §6.1, §6.2).
 *
 * THE PORT ({@link WorkspaceForge}) is the narrow, semantic surface the
 * workspace manager consumes: the Git Data API (blobs, trees, commits, the
 * branch ref), the pull request (open as a draft, regenerate its body, mark it
 * ready, return it to draft, close it). It is STRUCTURAL. Its GitHub
 * implementation is THIS lane's (GH-3) typed operations written on the forge
 * port's client (`engine/src/workflow/forge/`, PR #52: the one REST/GraphQL
 * client on the ONE outbound HTTP door, App tokens minted through the
 * broker); until it is wired, the CLI gives the manager no forge and every
 * forge verb refuses `workspace_forge_unavailable`. Tests drive a fake backed
 * by a real bare repository. A request type carries
 * no author, committer or signature field at all, so an API commit made
 * through this port is GitHub's to sign (web-flow, "Verified") by
 * construction, never by a caller's discipline.
 *
 * THE TARGET ({@link resolveForgeTarget}): where a workspace's work goes is
 * git's own answer, never a second setting — the land target branch's
 * upstream (`branch.<target>.remote` and `branch.<target>.merge`): the remote
 * and the trunk branch the pull request is opened against. A target with no
 * upstream can never land, so `create` refuses it (`workspace_target_untracked`).
 *
 * THE PUBLISHER ({@link publishBranch}): the forge branch must be where this
 * workspace last left it (`expectedHead`: the head its last round published,
 * or absent before the first) — anything else is another writer's work and
 * is never overwritten (`branch_moved_by_another_writer`), with ONE exception,
 * a crashed round: a forge head whose commits are, one for one, twins of the
 * local commits (the same trees) is adopted. Then each new local commit of
 * the workspace's branch is re-made on the forge through the Git Data API, in
 * topological order:
 *   1. `createBlob` for each blob the commit's tree diff (against its first
 *      parent) adds or changes, once per round — the answered id must be the
 *      local blob id (`workspace_publish_object_mismatch`);
 *   2. `createTree` on the first parent's tree (`base_tree`) with exactly the
 *      diff's entries — the answered tree must be the local commit's tree;
 *   3. `createCommit` with the same message (plus a `Co-authored-by` trailer
 *      naming the local author, git's own trailer rules) and the parents
 *      mapped to their published twins — the answer must be verified
 *      (`workspace_publish_unverified`: V-6);
 *   4. the branch ref set to the last twin by COMPARE-AND-SWAP from the
 *      expected head (created only while absent; moved only from where this
 *      workspace left it — an agent's rebase moves its own branch, never
 *      another writer's commits), then read back;
 *   5. the twin fetched back and the LOCAL branch moved to it by
 *      compare-and-swap: the twin holds the same tree, so the worktree, its
 *      index and every tree-keyed reuse are untouched, and the next round
 *      publishes only what is new. This is the harness's own branch, never a
 *      checkout's index.
 * Every refusal is typed; nothing is retried here, and a half-published round
 * is simply re-published (the objects are content-addressed, the ref is set
 * last). The tree delta is read through the one raw-diff reader
 * (`treeDiff`, src/git/tree-reader.ts).
 */
import { HarnessError, InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { gitOutput, treeDiff, type GitRepository } from "../git/tree-reader.ts";
import type { WorktreeGitPort } from "../git/worktree-port.ts";
import { remoteTrackingRef } from "../git/git-port.ts";

/** A pull request as the workspace reads it. */
export type ForgePullRequest = Readonly<{
  number: number;
  url: string;
  headSha: string;
  /** The branch it is opened against. */
  base: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  mergeCommitSha: string | null;
}>;

/** One entry of a tree request: a file (or gitlink) at `path`, or its deletion (`sha: null`). */
export type ForgeTreeEntry = Readonly<{ path: string; mode: "100644" | "100755" | "120000" | "160000"; sha: string | null }>;

/** A commit the forge made: its id, its tree, and whether the forge signed it (web-flow). */
export type ForgeCommit = Readonly<{ sha: string; tree: string; verified: boolean; verificationReason: string }>;

/**
 * The narrow forge surface `ws` consumes (see the header). Every method is
 * one forge operation; a transport failure, a permission refusal or an
 * unexpected answer is the adapter's typed error, never a value here.
 */
export type WorkspaceForge = Readonly<{
  /** `POST /git/blobs`: answers the blob id. */
  createBlob(content: Buffer): Promise<string>;
  /** `POST /git/trees` with `base_tree`: answers the tree id. */
  createTree(request: Readonly<{ baseTree: string; entries: readonly ForgeTreeEntry[] }>): Promise<string>;
  /** `POST /git/commits` with no author, committer or signature: the forge signs it. */
  createCommit(request: Readonly<{ message: string; tree: string; parents: readonly string[] }>): Promise<ForgeCommit>;
  /** The branch's head on the forge, or null when it does not exist. */
  branchHead(branch: string): Promise<string | null>;
  /**
   * A COMPARE-AND-SWAP of the branch: created at `sha` only while absent
   * (`previous: null`: `POST /git/refs`), else moved to `sha` only while it is
   * at `previous` (GraphQL `updateRefs` with `beforeOid` — REST `PATCH
   * /git/refs` has no compare-and-swap and is never used). Answers whether it
   * applied; a branch found elsewhere is `applied: false`, never an overwrite.
   */
  setBranch(request: Readonly<{ branch: string; sha: string; previous: string | null }>): Promise<Readonly<{ applied: boolean }>>;
  /** The open pull request whose head is `branch`, or null. */
  findPullRequest(branch: string): Promise<ForgePullRequest | null>;
  /** Opens a DRAFT pull request `head` → `base`. */
  openDraftPullRequest(request: Readonly<{ head: string; base: string; title: string; body: string }>): Promise<ForgePullRequest>;
  /** Regenerates the pull request's title and body. */
  updatePullRequest(number: number, request: Readonly<{ title: string; body: string }>): Promise<void>;
  /** Marks a draft ready for review (GraphQL `markPullRequestReadyForReview`). */
  markReadyForReview(number: number): Promise<void>;
  /** Returns a ready pull request to draft (GraphQL `convertPullRequestToDraft`). */
  convertToDraft(number: number): Promise<void>;
  /** Closes the pull request with `comment` (the branch is kept). */
  closePullRequest(number: number, comment: string): Promise<void>;
  /** The pull request as it is now. */
  pullRequest(number: number): Promise<ForgePullRequest>;
}>;

/** Where a workspace lands on the forge: its target's upstream. */
export type ForgeTarget = Readonly<{
  /** The git remote's name (`branch.<target>.remote`). */
  remote: string;
  /** The remote's URL as git resolves it (`remote get-url`), from which the adapter names the repository. */
  remoteUrl: string;
  /** The trunk branch on the remote (`branch.<target>.merge`, without `refs/heads/`). */
  trunk: string;
}>;

/** Builds the forge client of a target (the composition root's choice: the GitHub adapter, or a test's fake). */
export type WorkspaceForgeFactory = (target: ForgeTarget) => WorkspaceForge;

function configValue(repository: GitRepository, key: string): string | null {
  const answered = gitOutput(repository, ["config", "--get", key], { allowed: [0, 1] });
  return answered.status === 0 ? answered.stdout.toString("utf8").trim() : null;
}

/**
 * The land target's upstream, as git records it (see the header), or
 * `workspace_target_untracked` naming the remedy.
 */
export function resolveForgeTarget(repository: GitRepository, targetBranch: string): ForgeTarget {
  const remote = configValue(repository, `branch.${targetBranch}.remote`);
  const merge = configValue(repository, `branch.${targetBranch}.merge`);
  if (remote === null || merge === null || remote === "." || !merge.startsWith("refs/heads/")) {
    throw new InputError(
      `${targetBranch} has no upstream branch on a remote: a workspace lands through a pull request against its target's upstream — set it (git branch --set-upstream-to <remote>/<trunk> ${targetBranch})`,
      "workspace_target_untracked",
    );
  }
  return deepFreeze({ remote, remoteUrl: remoteUrlOf(repository, remote), trunk: merge.slice("refs/heads/".length) });
}

/** The URL of the configured remote `remote` as git resolves it, or `workspace_target_untracked`. */
export function remoteUrlOf(repository: GitRepository, remote: string): string {
  const url = gitOutput(repository, ["remote", "get-url", remote], { allowed: [0, 2, 128] });
  const remoteUrl = url.stdout.toString("utf8").trim().split("\n")[0] ?? "";
  if (url.status !== 0 || remoteUrl === "") throw new InputError(`the remote ${remote} is not configured`, "workspace_target_untracked");
  return remoteUrl;
}

/** One local commit as the publisher re-makes it. */
type LocalCommit = Readonly<{ sha: string; tree: string; parents: readonly string[]; message: string; author: string }>;

/** What one round published. */
export type PublishedRound = Readonly<{
  /** The branch's head on the forge after the round (the local branch now points at it too). */
  head: string;
  tree: string;
  /** Each local commit and its signed twin, oldest first (empty: nothing was new). */
  commits: readonly Readonly<{ local: string; twin: string }>[];
  /** The blobs uploaded this round. */
  blobs: number;
}>;

export type PublishRequest = Readonly<{
  forge: WorkspaceForge;
  /** The workspace's worktree (its HEAD is the branch to publish). */
  repository: GitRepository;
  git: WorktreeGitPort;
  target: ForgeTarget;
  /** The workspace's branch (local and on the forge: the same name). */
  branch: string;
  /** Where this workspace last left the forge branch (its last round's head), or null before its first round. */
  expectedHead: string | null;
  fetchMs: number;
}>;

function fail(code: string, message: string, details: Readonly<Record<string, string | number | boolean>> = {}): never {
  throw new HarnessError(message, code, false, details);
}

function text(repository: GitRepository, argv: readonly string[]): string {
  return gitOutput(repository, argv).stdout.toString("utf8");
}

/** Fetches `branches` of `remote` into their tracking refs, or refuses typed. */
export function fetchForgeBranches(git: WorktreeGitPort, root: string, remote: string, branches: readonly string[], timeoutMs: number): void {
  const fetched = git.fetchRefs(root, remote, branches.map((branch) => `+refs/heads/${branch}:${remoteTrackingRef(remote, branch)}`), timeoutMs);
  if (fetched.refusal !== null) fail("workspace_forge_fetch_refused", `fetching ${branches.join(", ")} from ${remote} was refused: ${fetched.refusal}`, { remote });
}

/** A commit object's tree, parents, author and message (UTF-8 only: a re-encoded message would be another commit's). */
function readCommit(repository: GitRepository, sha: string): LocalCommit {
  const raw = gitOutput(repository, ["cat-file", "commit", sha]).stdout;
  const split = raw.indexOf("\n\n");
  const headers = raw.subarray(0, split === -1 ? raw.length : split).toString("utf8").split("\n");
  const message = split === -1 ? "" : raw.subarray(split + 2).toString("utf8");
  const field = (name: string): readonly string[] => headers.filter((line) => line.startsWith(`${name} `)).map((line) => line.slice(name.length + 1));
  const encoding = field("encoding")[0];
  if (encoding !== undefined && !/^utf-?8$/iu.test(encoding)) {
    fail("workspace_publish_encoding", `commit ${sha} declares the message encoding ${encoding}: only UTF-8 messages can be re-made through the API (rewrite it)`, { commit: sha });
  }
  const author = (field("author")[0] ?? "").replace(/ \d+ [+-]\d{4}$/u, "");
  return deepFreeze({ sha, tree: field("tree")[0]!, parents: deepFreeze([...field("parent")]), message, author });
}

/** The message the twin carries: the local one, plus `Co-authored-by` naming the local author (git's trailer rules: never twice). */
function twinMessage(repository: GitRepository, commit: LocalCommit): string {
  if (!/^[^<>\n]+ <[^<>\n]*>$/u.test(commit.author)) return commit.message;
  return gitOutput(repository, ["interpret-trailers", "--if-exists", "addIfDifferent", "--trailer", `Co-authored-by: ${commit.author}`], { input: Buffer.from(commit.message, "utf8") }).stdout.toString("utf8");
}

/**
 * The entries `commit`'s tree changes against its first parent's (the one
 * raw-diff reader, `treeDiff`: recursive, no renames, each path checked
 * UTF-8): each file's new mode and id, or its deletion (sent with the mode it
 * had: a link's or a gitlink's deletion is a link's or a gitlink's).
 */
function treeDelta(repository: GitRepository, parent: string, commit: string): readonly ForgeTreeEntry[] {
  const forgeMode = (mode: string, path: string): ForgeTreeEntry["mode"] => {
    if (mode === "100644" || mode === "100755" || mode === "120000" || mode === "160000") return mode;
    return fail("workspace_publish_mode", `commit ${commit} records ${path} with the mode ${mode}, which a forge tree cannot hold`, { commit });
  };
  return deepFreeze(treeDiff(repository, parent, commit).map((entry) => (entry.status === "D"
    ? deepFreeze({ path: entry.path, mode: forgeMode(entry.srcMode, entry.path), sha: null })
    : deepFreeze({ path: entry.path, mode: forgeMode(entry.dstMode, entry.path), sha: entry.dstOid }))));
}

/** The commits of `head` beyond `excluded`, oldest first. */
function commitsBeyond(repository: GitRepository, head: string, excluded: readonly string[]): readonly string[] {
  return text(repository, ["rev-list", "--reverse", "--topo-order", head, "--not", ...excluded]).split("\n").filter((line) => line.length > 0);
}

/**
 * Whether the forge head `remoteHead` is a crashed round of THIS workspace:
 * its commits beyond `excluded` (the trunk and the expected head) are, one
 * for one in order, twins of the local ones — each the same tree.
 */
function isTwinOfLocal(repository: GitRepository, remoteHead: string, head: string, excluded: readonly string[]): boolean {
  const remote = commitsBeyond(repository, remoteHead, excluded);
  const local = commitsBeyond(repository, head, excluded);
  const treeOf = (commit: string): string => text(repository, ["rev-parse", `${commit}^{tree}`]).trim();
  return remote.length > 0 && remote.length === local.length && remote.every((commit, index) => treeOf(commit) === treeOf(local[index]!));
}

/**
 * Publishes the workspace branch's new commits as signed twins (see the
 * header) and answers the round. A branch with no commit beyond the trunk is
 * refused (`workspace_publish_empty`: the forge opens no pull request without
 * one); a forge branch anywhere but where this workspace left it is another
 * writer's and is never overwritten (`branch_moved_by_another_writer`), save
 * a crashed round's twins, which are adopted.
 */
export async function publishBranch(request: PublishRequest): Promise<PublishedRound> {
  const { forge, repository, git, target, branch, expectedHead } = request;
  const root = repository.root;
  const moved = (current: string | null): never => fail("branch_moved_by_another_writer",
    `${branch} on ${target.remote} is at ${current ?? "(absent)"}, not where this workspace left it (${expectedHead ?? "absent"}): another writer pushed to it, and its work is never overwritten — integrate it locally (fetch and rebase onto it), or take the pull request over by hand`,
    { branch, current: current ?? "", expected: expectedHead ?? "" });
  const remoteHead = await forge.branchHead(branch);
  fetchForgeBranches(git, root, target.remote, remoteHead === null ? [target.trunk] : [target.trunk, branch], request.fetchMs);
  const trunkRef = remoteTrackingRef(target.remote, target.trunk);
  if (remoteHead !== null && git.revParse(root, remoteTrackingRef(target.remote, branch), request.fetchMs) !== remoteHead) {
    fail("workspace_publish_remote_moved", `${branch} moved on ${target.remote} while it was read: publish again`, { branch });
  }
  const head = git.revParse(root, "HEAD", request.fetchMs);
  const headTree = git.revParse(root, `${head}^{tree}`, request.fetchMs);
  if (remoteHead !== expectedHead) {
    if (remoteHead === null || !isTwinOfLocal(repository, remoteHead, head, [trunkRef, ...(expectedHead === null ? [] : [expectedHead])])) return moved(remoteHead);
    // A crashed round: the forge already holds this workspace's twins. Adopt them.
    const adopted = git.updateRef(root, `refs/heads/${branch}`, remoteHead, head, request.fetchMs);
    if (adopted.refusal !== null) fail("workspace_publish_local_moved", `${branch} moved locally while a crashed round was adopted (${adopted.refusal})`, { branch });
    return deepFreeze({ head: remoteHead, tree: headTree, commits: deepFreeze([]), blobs: 0 });
  }
  if (head === remoteHead) return deepFreeze({ head, tree: headTree, commits: deepFreeze([]), blobs: 0 });
  const listed = commitsBeyond(repository, head, [trunkRef, ...(remoteHead === null ? [] : [remoteHead])]);
  if (listed.length === 0) {
    fail("workspace_publish_empty", `${branch} holds no commit beyond ${target.remote}/${target.trunk}: commit the round's work first`, { branch });
  }

  const twins = new Map<string, string>();
  const uploaded = new Set<string>();
  const published: { local: string; twin: string }[] = [];
  for (const sha of listed) {
    const commit = readCommit(repository, sha);
    const firstParent = commit.parents[0];
    if (firstParent === undefined) fail("workspace_publish_root_commit", `commit ${sha} has no parent: a workspace branch forks from its trunk`, { commit: sha });
    const entries = treeDelta(repository, firstParent, sha);
    for (const entry of entries) {
      if (entry.sha === null || entry.mode === "160000" || uploaded.has(entry.sha)) continue;
      const answered = await forge.createBlob(gitOutput(repository, ["cat-file", "blob", entry.sha]).stdout);
      if (answered !== entry.sha) fail("workspace_publish_object_mismatch", `the forge stored ${entry.path} of ${sha} as the blob ${answered}, not ${entry.sha}`, { commit: sha });
      uploaded.add(entry.sha);
    }
    const baseTree = git.revParse(root, `${firstParent}^{tree}`, request.fetchMs);
    const tree = entries.length === 0 ? baseTree : await forge.createTree({ baseTree, entries });
    if (tree !== commit.tree) fail("workspace_publish_object_mismatch", `the forge built the tree ${tree} for ${sha}, whose tree is ${commit.tree}`, { commit: sha });
    const made = await forge.createCommit({ message: twinMessage(repository, commit), tree, parents: commit.parents.map((parent) => twins.get(parent) ?? parent) });
    if (made.tree !== commit.tree) fail("workspace_publish_object_mismatch", `the forge's commit ${made.sha} holds the tree ${made.tree}, not ${commit.tree}`, { commit: sha });
    if (!made.verified) fail("workspace_publish_unverified", `the forge did not sign the commit ${made.sha} (${made.verificationReason}): an agent's commit must be Verified (required_signatures)`, { commit: sha, twin: made.sha });
    twins.set(sha, made.sha);
    published.push({ local: sha, twin: made.sha });
  }
  const twinHead = twins.get(head)!;
  const set = await forge.setBranch({ branch, sha: twinHead, previous: remoteHead });
  if (!set.applied) return moved(await forge.branchHead(branch));
  // Read back: the forge's own answer, then the fetched ref.
  const readBack = await forge.branchHead(branch);
  if (readBack !== twinHead) return moved(readBack);
  fetchForgeBranches(git, root, target.remote, [branch], request.fetchMs);
  if (git.revParse(root, remoteTrackingRef(target.remote, branch), request.fetchMs) !== twinHead) {
    fail("workspace_publish_remote_moved", `${branch} on ${target.remote} is not the published ${twinHead} after the round: publish again`, { branch });
  }
  const local = git.updateRef(root, `refs/heads/${branch}`, twinHead, head, request.fetchMs);
  if (local.refusal !== null) {
    fail("workspace_publish_local_moved", `${branch} was published as ${twinHead}, but the local branch moved from ${head} meanwhile (${local.refusal}): rebase the new commits onto ${twinHead}`, { branch, twinHead });
  }
  return deepFreeze({ head: twinHead, tree: headTree, commits: deepFreeze(published.map((entry) => deepFreeze(entry))), blobs: uploaded.size });
}
