import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, lstatSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceConflictError } from "../../src/workflow/workspace-manager.ts";
import { dispatchWorkspaceCli, runWorkspaceCli } from "../../src/workflow/workspace-cli.ts";
import { indexFilePath } from "../../src/git/repository-ownership.ts";
import { hasSecondName } from "../../src/filesystem/link-containment.ts";
import { createWorkspaceRecordStore, workspaceRecordStores } from "../../src/workflow/workspace-registry.ts";
import { resolveForgeTarget, type WorkspaceForge, type WorkspaceForgeFactory } from "../../src/workflow/workspace-forge.ts";
import {
  commitFile,
  forgeAt,
  forgeStateOf,
  initTempRepo,
  makeManager,
  makeFakeCommands,
  failGate,
  makeTestConfig,
  mkWorkspaceTempDir,
  rawGit,
  registryOf,
  testRepository,
  trackBranch,
  writeFile,
} from "./workspace-test-support.ts";

/** Matches a HarnessError by its typed code. */
function throwsCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === code;
}

/** A repository whose `main` tracks a bare forge remote, a manager on it, and the fake forge of that remote. */
function forgeFixture(prefix: string, options: Readonly<{ forge?: WorkspaceForgeFactory | null }> = {}) {
  const { root, bare } = initTempRepo(prefix);
  const workspaceRoot = mkWorkspaceTempDir(`${prefix}-wt`);
  const config = makeTestConfig(workspaceRoot);
  const { manager } = makeManager(root, { config, ...(options.forge === undefined ? {} : { forge: options.forge }) });
  return { root, bare, config, manager, forge: forgeAt(bare) };
}

/** The forge's view of `ref` in the bare repository. */
function forgeRev(bare: string, ref: string): string {
  return rawGit(bare, ["rev-parse", ref]);
}

test("the first round publishes signed twins with the same trees, moves the local branch to them, and opens ONE draft pull request with a generated body", async () => {
  const { root, bare, manager, forge } = forgeFixture("ws-forge-round");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src", "bin"] });
  const worktree = record.lease.worktreePath;
  assert.deepEqual(record.forge, { remote: "origin", trunk: "main", pullRequest: null, publishedHead: null, ready: false, land: null, stackedOn: null }, "create resolved the target's upstream and opened nothing yet");
  writeFile(worktree, "src/deep/nested/a.ts", "export const a = 1;\n");
  writeFile(worktree, "bin/run.sh", "#!/bin/sh\necho run\n");
  chmodSync(join(worktree, "bin/run.sh"), 0o755);
  symlinkSync("deep/nested/a.ts", join(worktree, "src/link.ts"));
  rawGit(worktree, ["add", "-A"]);
  rawGit(worktree, ["commit", "-q", "-m", "Add the feature\n\nSigned-off-by: Test Author <author@example.com>"]);
  commitFile(worktree, "src/deep/nested/a.ts", "export const a = 2;\n", "Tune the feature");
  const localHead = rawGit(worktree, ["rev-parse", "HEAD"]);
  const localTree = rawGit(worktree, ["rev-parse", "HEAD^{tree}"]);
  const localAuthor = rawGit(worktree, ["log", "-1", "--format=%an <%ae>"]);

  const { record: published, round } = await manager.publish(record.workspaceId);
  assert.equal(round.commits.length, 2);
  assert.equal(round.blobs, 4, "each new blob once: two versions of a.ts, the script, the link");
  assert.notEqual(round.head, localHead, "the twin is the forge's commit, not the local one");
  assert.equal(round.tree, localTree);
  assert.equal(forgeRev(bare, `refs/heads/${record.lease.branch!}`), round.head, "the forge branch is at the last twin");
  assert.equal(forgeRev(bare, `${round.head}^{tree}`), localTree, "the twin holds exactly the local tree");
  assert.equal(rawGit(worktree, ["rev-parse", "HEAD"]), round.head, "the local branch moved to the twin");
  assert.equal(rawGit(worktree, ["status", "--porcelain"]), "", "the worktree and its index are untouched (the same tree)");
  assert.equal(rawGit(root, ["rev-parse", "main"]), record.lease.baseSha, "the canonical checkout is untouched");
  assert.equal(rawGit(bare, ["ls-tree", round.head, "bin/run.sh"]).split(" ")[0], "100755", "the executable mode survived");
  assert.equal(rawGit(bare, ["ls-tree", round.head, "src/link.ts"]).split(" ")[0], "120000", "the link survived");

  // The commit requests carried no identity at all: the forge signs them.
  const commitRequests = forge.calls.filter((call) => call.op === "createCommit").map((call) => call.request as Readonly<Record<string, unknown>>);
  assert.equal(commitRequests.length, 2);
  for (const request of commitRequests) assert.deepEqual(Object.keys(request).toSorted(), ["message", "parents", "tree"]);
  assert.deepEqual(commitRequests[0]!["parents"], [record.lease.baseSha], "the first twin's parent is the trunk commit itself");
  assert.deepEqual(commitRequests[1]!["parents"], [round.commits[0]!.twin], "a later twin's parent is the earlier twin");
  const firstMessage = rawGit(bare, ["log", "-1", "--format=%B", round.commits[0]!.twin]);
  assert.match(firstMessage, /^Add the feature\n/u);
  assert.match(firstMessage, /Signed-off-by: Test Author <author@example\.com>/u, "the message's own trailers are kept");
  assert.ok(firstMessage.includes(`Co-authored-by: ${localAuthor}`), "the local author is credited as a co-author");
  assert.equal(rawGit(bare, ["log", "-1", "--format=%an", round.head]), "forge-app[bot]", "the forge is the author");

  assert.equal(forge.pulls.size, 1);
  const pull = forge.pulls.get(1)!;
  assert.equal(pull.draft, true);
  assert.equal(pull.head, record.lease.branch);
  assert.equal(pull.base, "main");
  assert.equal(pull.title, "Add the feature", "the title is the branch's first commit subject");
  assert.ok(pull.body.includes(`bridlewise:workspace ${record.workspaceId}`));
  assert.ok(pull.body.includes("- `src`") && pull.body.includes("- `bin`"), "the write set is listed");
  assert.ok(pull.body.includes("Tune the feature"), "the commits are listed");
  assert.ok(pull.body.includes("Not validated at this tree yet"));
  assert.ok(!pull.body.includes(worktree), "no local path reaches the forge");
  assert.deepEqual(published.forge, { remote: "origin", trunk: "main", pullRequest: { number: 1, url: "https://forge.test/pull/1" }, publishedHead: round.head, ready: false, land: null, stackedOn: null });
  assert.equal(forgeStateOf(manager.status(record.workspaceId)).publishedHead, round.head, "the record is saved");
});

test("a later round publishes only what is new, regenerates the same pull request, and an unchanged branch publishes nothing", async () => {
  const { bare, manager, forge } = forgeFixture("ws-forge-rounds");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  const worktree = record.lease.worktreePath;
  commitFile(worktree, "src/a.ts", "export const a = 1;\n", "First round");
  const first = (await manager.publish(record.workspaceId)).round;
  forge.calls.length = 0;
  commitFile(worktree, "src/b.ts", "export const b = 1;\n", "Second round");
  const second = (await manager.publish(record.workspaceId)).round;
  assert.equal(second.commits.length, 1);
  assert.equal(forge.calls.filter((call) => call.op === "createBlob").length, 1, "only the new blob is uploaded");
  assert.deepEqual(forge.calls.find((call) => call.op === "setBranch")?.request, { branch: record.lease.branch, sha: second.head, previous: first.head, forwardOnly: false });
  assert.equal(forgeRev(bare, `${second.head}^`), first.head);
  assert.equal(forge.pulls.size, 1, "no second pull request");
  assert.ok(forge.pulls.get(1)!.body.includes("Second round"), "the body is regenerated");
  assert.equal(forge.calls.filter((call) => call.op === "openDraftPullRequest").length, 0);

  forge.calls.length = 0;
  const again = (await manager.publish(record.workspaceId)).round;
  assert.equal(again.head, second.head);
  assert.equal(again.commits.length, 0);
  assert.equal(forge.calls.filter((call) => call.op === "createCommit" || call.op === "setBranch").length, 0, "nothing is re-made");
});

test("a merge of the trunk into the branch is re-made with both parents mapped; a rebase onto a moved trunk rewrites the agent's own branch", async () => {
  const { root, bare, manager } = forgeFixture("ws-forge-history");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  const worktree = record.lease.worktreePath;
  commitFile(worktree, "src/a.ts", "export const a = 1;\n", "Feature");
  const first = (await manager.publish(record.workspaceId)).round;
  // The trunk moves on the forge (another land).
  const trunkCommit = commitFile(root, "docs/other.md", "# other\n", "Another land");
  rawGit(root, ["push", "-q", "origin", "main"]);
  rawGit(worktree, ["fetch", "-q", "origin"]);
  rawGit(worktree, ["merge", "-q", "--no-edit", "origin/main"]);
  const merged = (await manager.publish(record.workspaceId)).round;
  assert.equal(merged.commits.length, 1);
  assert.deepEqual(rawGit(bare, ["log", "-1", "--format=%P", merged.head]).split(" "), [first.head, trunkCommit], "the merge twin's parents: the earlier twin, then the trunk commit itself");
  assert.equal(forgeRev(bare, `${merged.head}^{tree}`), rawGit(worktree, ["rev-parse", "HEAD^{tree}"]));

  // A rebase: the branch is rewritten on the trunk; the forge branch is moved (the agent's own).
  const trunkAgain = commitFile(root, "docs/more.md", "# more\n", "Yet another land");
  rawGit(root, ["push", "-q", "origin", "main"]);
  rawGit(worktree, ["fetch", "-q", "origin"]);
  rawGit(worktree, ["rebase", "-q", "origin/main"]);
  const rebased = (await manager.publish(record.workspaceId)).round;
  assert.equal(rawGit(bare, ["rev-parse", `${rebased.head}^`]), trunkAgain);
  assert.equal(forgeRev(bare, `refs/heads/${record.lease.branch!}`), rebased.head);
  assert.equal(rawGit(worktree, ["rev-parse", "HEAD"]), rebased.head);
});

test("publish refuses: no forge, a read-only workspace, a dirty worktree, an unleased path, an empty branch, a forge branch ahead, an unsigned twin, a wrong object, a changed upstream", async () => {
  const { root, bare, config, manager, forge } = forgeFixture("ws-forge-refusals");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  const worktree = record.lease.worktreePath;

  await assert.rejects(() => manager.publish(record.workspaceId), throwsCode("workspace_publish_empty"), "nothing beyond the trunk: no pull request can open");
  const offline = makeManager(root, { config, forge: null }).manager;
  commitFile(worktree, "src/a.ts", "export const a = 1;\n");
  await assert.rejects(() => offline.publish(record.workspaceId), throwsCode("workspace_forge_unavailable"));
  const verifier = await manager.create({ agentName: "verifier", mode: "read-only", writeSet: [] });
  assert.equal(verifier.forge, null);
  await assert.rejects(() => manager.publish(verifier.workspaceId), throwsCode("workspace_read_only"));

  writeFile(worktree, "src/dirty.ts", "export const dirty = 1;\n");
  await assert.rejects(() => manager.publish(record.workspaceId), throwsCode("workspace_publish_dirty"));
  rawGit(worktree, ["add", "-A"]);
  rawGit(worktree, ["commit", "-q", "-m", "dirty, committed"]);

  commitFile(worktree, "docs/unleased.md", "# out of lease\n");
  await assert.rejects(() => manager.publish(record.workspaceId), (error: unknown) =>
    error instanceof WorkspaceConflictError && error.report.conflicts.some((conflict) => conflict.path === "docs/unleased.md"));
  assert.equal(forge.calls.filter((call) => call.op === "createCommit").length, 0, "a refused lease publishes nothing");
  rawGit(worktree, ["rm", "-q", "docs/unleased.md"]);
  rawGit(worktree, ["commit", "-q", "-m", "back in the lease"]);

  forge.setVerified(false);
  await assert.rejects(() => manager.publish(record.workspaceId), throwsCode("workspace_publish_unverified"));
  assert.equal(rawGit(bare, ["branch", "--list", record.lease.branch!]), "", "an unsigned round sets no branch");
  forge.setVerified(true);

  // A forge that answers another object than the local one, at each of the three checks: never published.
  const lying = (lie: Partial<WorkspaceForge>): WorkspaceForgeFactory => (target) => ({ ...forgeAt(target.remoteUrl), ...lie });
  const real = forge;
  const otherTree = rawGit(bare, ["rev-parse", "main^{tree}"]);
  for (const [what, lie, words] of [
    ["a blob", { createBlob: async (content: Buffer) => { await real.createBlob(content); return "0".repeat(40); } }, "as the blob"],
    ["a tree", { createTree: async () => otherTree }, "built the tree"],
    ["a commit of another tree", { createCommit: async (request: Readonly<{ message: string; tree: string; parents: readonly string[] }>) => ({ ...await real.createCommit(request), tree: otherTree }) }, "commit"],
  ] as const) {
    // Each lie is caught by ITS check (its own words), never only by a later one.
    await assert.rejects(() => makeManager(root, { config, forge: lying(lie) }).manager.publish(record.workspaceId), (error: unknown) =>
      throwsCode("workspace_publish_object_mismatch")(error) && String((error as Error).message).includes(words === "commit" ? "the forge's commit" : words), `a forge that answers ${what} it was not given is refused`);
    assert.equal(rawGit(bare, ["branch", "--list", record.lease.branch!]), "", `no branch after ${what}`);
  }

  const round = (await manager.publish(record.workspaceId)).round;
  // Someone else pushes to the agent's branch on the forge: it is never rewound.
  const clone = mkWorkspaceTempDir("ws-forge-intruder");
  rawGit(clone, ["clone", "-q", bare, "."]);
  rawGit(clone, ["checkout", "-q", record.lease.branch!]);
  commitFile(clone, "src/intruder.ts", "export const intruder = 1;\n");
  rawGit(clone, ["push", "-q", "origin", record.lease.branch!]);
  await assert.rejects(() => manager.publish(record.workspaceId), throwsCode("branch_moved_by_another_writer"));
  assert.equal(rawGit(worktree, ["rev-parse", "HEAD"]), round.head, "the local branch stays at what it published");
  // DIVERGED: the agent has new work too — the foreign commit is still never discarded.
  const foreign = rawGit(bare, ["rev-parse", `refs/heads/${record.lease.branch!}`]);
  commitFile(worktree, "src/mine.ts", "export const mine = 1;\n");
  await assert.rejects(() => manager.publish(record.workspaceId), throwsCode("branch_moved_by_another_writer"));
  assert.equal(rawGit(bare, ["rev-parse", `refs/heads/${record.lease.branch!}`]), foreign, "the foreign commit is still the branch's head");

  rawGit(root, ["remote", "add", "elsewhere", bare]);
  rawGit(root, ["config", "branch.main.remote", "elsewhere"]);
  await assert.rejects(() => manager.publish(record.workspaceId), throwsCode("workspace_target_upstream_changed"));
});

test("create refuses a target with no upstream: it could never land", async () => {
  const { root, config } = forgeFixture("ws-forge-untracked");
  rawGit(root, ["branch", "side"]);
  const { manager } = makeManager(root, { config });
  await assert.rejects(() => manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"], target: "side" }), throwsCode("workspace_target_untracked"));
  assert.equal(rawGit(root, ["branch", "--list", "agent/*"]), "", "nothing was made");
  trackBranch(root, "side");
  assert.deepEqual(resolveForgeTarget(testRepository(root), "side"), { remote: "origin", remoteUrl: rawGit(root, ["remote", "get-url", "origin"]), trunk: "side" });
});

test("a crashed round's pull request is adopted, never opened twice", async () => {
  const { manager, forge } = forgeFixture("ws-forge-adopt");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/a.ts", "export const a = 1;\n", "The work");
  // The round set the branch and opened the pull request, then died before saving the record.
  const bare = forge.bare;
  rawGit(record.lease.worktreePath, ["push", "-q", bare, `HEAD:refs/heads/${record.lease.branch!}`]);
  const opened = await forge.openDraftPullRequest({ head: record.lease.branch!, base: "main", title: "t", body: "b" });
  const { record: published } = await manager.publish(record.workspaceId);
  assert.equal(forgeStateOf(published).pullRequest?.number, opened.number);
  assert.equal(forge.pulls.size, 1);
});

test("ready: only a published head whose tree passed validation leaves draft; unpublished work or a head someone else moved is refused", async () => {
  const { bare, manager, forge } = forgeFixture("ws-forge-ready");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  const worktree = record.lease.worktreePath;
  await assert.rejects(() => manager.ready(record.workspaceId), throwsCode("workspace_not_published"));
  commitFile(worktree, "src/a.ts", "export const a = 1;\n", "The work");
  await manager.publish(record.workspaceId);
  await assert.rejects(() => manager.ready(record.workspaceId), throwsCode("workspace_not_validated"));
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  commitFile(worktree, "src/b.ts", "export const b = 1;\n", "More work");
  await assert.rejects(() => manager.ready(record.workspaceId), throwsCode("workspace_unpublished_commits"));
  await manager.publish(record.workspaceId);
  await assert.rejects(() => manager.ready(record.workspaceId), throwsCode("workspace_not_validated"), "the validation was of another tree");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  assert.ok(forge.pulls.get(1)!.body.includes("Not validated at this tree yet"), "the body was generated before this validation");

  const intruder = rawGit(bare, ["commit-tree", rawGit(bare, ["rev-parse", `refs/heads/${record.lease.branch!}^{tree}`]), "-p", `refs/heads/${record.lease.branch!}`, "-m", "intruder"]);
  const before = rawGit(bare, ["rev-parse", `refs/heads/${record.lease.branch!}`]);
  rawGit(bare, ["update-ref", `refs/heads/${record.lease.branch!}`, intruder]);
  await assert.rejects(() => manager.ready(record.workspaceId), throwsCode("workspace_published_head_moved"));
  rawGit(bare, ["update-ref", `refs/heads/${record.lease.branch!}`, before]);

  const marked = await manager.ready(record.workspaceId);
  assert.equal(forgeStateOf(marked).ready, true);
  assert.equal(forge.pulls.get(1)!.draft, false);
  forge.calls.length = 0;
  await manager.ready(record.workspaceId);
  assert.equal(forge.calls.filter((call) => call.op === "markReadyForReview").length, 0, "an already ready pull request is not marked again");
  forge.pulls.get(1)!.state = "closed";
  await assert.rejects(() => manager.ready(record.workspaceId), throwsCode("workspace_pull_request_closed"), "a closed pull request is never readied");
});

test("a validation survives the publish (the twin holds the same tree): the local merge still lands it", async () => {
  const { manager } = forgeFixture("ws-forge-then-merge");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/a.ts", "export const a = 1;\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  await manager.publish(record.workspaceId);
  const receipt = await manager.merge(record.workspaceId);
  assert.equal(receipt.changedPaths[0], "src/a.ts");
});

test("the fake forge's forward-only move is GitHub's `force: false`: a move that is not a fast-forward is refused (and nothing moves), a fast-forward applies, and a workspace's own rewrite (forwardOnly: false) applies", async () => {
  const { bare, forge } = forgeFixture("ws-forge-forward-only");
  const base = rawGit(bare, ["rev-parse", "refs/heads/main"]);
  const tree = rawGit(bare, ["rev-parse", `${base}^{tree}`]);
  const ahead = rawGit(bare, ["commit-tree", tree, "-p", base, "-m", "a fast-forward"]);
  const aside = rawGit(bare, ["commit-tree", tree, "-p", base, "-m", "a rewrite"]);
  assert.deepEqual(await forge.setBranch({ branch: "product", sha: ahead, previous: null, forwardOnly: true }), { applied: true }, "a create is no move");
  await assert.rejects(() => forge.setBranch({ branch: "product", sha: aside, previous: ahead, forwardOnly: true }), throwsCode("github_validation_failed"), "not a fast-forward");
  assert.equal(forgeRev(bare, "refs/heads/product"), ahead, "a refused move moves nothing");
  const further = rawGit(bare, ["commit-tree", tree, "-p", ahead, "-m", "further"]);
  assert.deepEqual(await forge.setBranch({ branch: "product", sha: further, previous: ahead, forwardOnly: true }), { applied: true });
  assert.deepEqual(await forge.setBranch({ branch: "product", sha: aside, previous: further, forwardOnly: false }), { applied: true }, "a rewrite applies when it is allowed");
  assert.equal(forgeRev(bare, "refs/heads/product"), aside);
  assert.deepEqual(await forge.setBranch({ branch: "product", sha: further, previous: ahead, forwardOnly: true }), { applied: false }, "a branch elsewhere is the compare-and-swap's answer, never the forward-only refusal");
});

test("the branch move is a compare-and-swap: another writer's push between the read and the move is never overwritten", async () => {
  const { bare, root, config, manager } = forgeFixture("ws-forge-cas");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  const worktree = record.lease.worktreePath;
  commitFile(worktree, "src/a.ts", "export const a = 1;\n", "First");
  const first = (await manager.publish(record.workspaceId)).round;
  commitFile(worktree, "src/b.ts", "export const b = 1;\n", "Second");
  // Another writer pushes right before the move (after the publisher read the branch).
  const racing: WorkspaceForgeFactory = (target) => {
    const real = forgeAt(target.remoteUrl);
    return { ...real, setBranch: async (request) => {
      const tree = rawGit(bare, ["rev-parse", `${first.head}^{tree}`]);
      rawGit(bare, ["update-ref", `refs/heads/${request.branch}`, rawGit(bare, ["commit-tree", tree, "-p", first.head, "-m", "a reviewer's suggestion"])]);
      return real.setBranch(request);
    } };
  };
  await assert.rejects(() => makeManager(root, { config, forge: racing }).manager.publish(record.workspaceId), throwsCode("branch_moved_by_another_writer"));
  assert.equal(rawGit(bare, ["log", "-1", "--format=%s", `refs/heads/${record.lease.branch!}`]), "a reviewer's suggestion", "the other writer's commit stays");
  assert.equal(forgeStateOf(manager.status(record.workspaceId)).publishedHead, first.head, "the record still names the last round");
});

test("the ready gate holds on every round: publishing a new head after ready returns the pull request to draft until it is validated and readied again", async () => {
  const { manager, forge } = forgeFixture("ws-forge-regate");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  const worktree = record.lease.worktreePath;
  commitFile(worktree, "src/a.ts", "export const a = 1;\n", "Validated work");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  await manager.publish(record.workspaceId);
  await manager.ready(record.workspaceId);
  assert.equal(forge.pulls.get(1)!.draft, false);
  commitFile(worktree, "src/b.ts", "export const b = 1;\n", "Unvalidated work");
  const { record: republished } = await manager.publish(record.workspaceId);
  assert.equal(forgeStateOf(republished).ready, false, "the record forgets ready");
  assert.equal(forge.pulls.get(1)!.draft, true, "the pull request is a draft again");
  assert.ok(forge.pulls.get(1)!.body.includes("Not validated at this tree yet"));
  await assert.rejects(() => manager.ready(record.workspaceId), throwsCode("workspace_not_validated"));
  // A round that publishes nothing new keeps a ready pull request ready.
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  await manager.ready(record.workspaceId);
  forge.calls.length = 0;
  assert.equal(forgeStateOf((await manager.publish(record.workspaceId)).record).ready, true);
  assert.equal(forge.calls.filter((call) => call.op === "convertToDraft").length, 0);
});

test("a later round that crashed after moving the forge branch is adopted (its twins carry the local trees); two concurrent publishes make one set of twins", async () => {
  const { root, config, manager, forge } = forgeFixture("ws-forge-crash");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  const worktree = record.lease.worktreePath;
  commitFile(worktree, "src/a.ts", "export const a = 1;\n", "First");
  await manager.publish(record.workspaceId);
  commitFile(worktree, "src/b.ts", "export const b = 1;\n", "Second");
  // The round moves the forge branch and the local branch, then dies before its record is saved.
  const store = createWorkspaceRecordStore(workspaceRecordStores(registryOf(root)));
  const dying = makeManager(root, { config, records: { ...store, save: () => { throw new Error("injected: died before the record was saved"); } } }).manager;
  await assert.rejects(() => dying.publish(record.workspaceId), /injected/u);
  const adopted = await manager.publish(record.workspaceId);
  assert.equal(adopted.round.commits.length, 0, "nothing is re-made");
  assert.equal(forgeStateOf(adopted.record).publishedHead, rawGit(worktree, ["rev-parse", "HEAD"]));

  commitFile(worktree, "src/c.ts", "export const c = 1;\n", "Third");
  commitFile(worktree, "src/d.ts", "export const d = 1;\n", "Fourth");
  forge.calls.length = 0;
  const rounds = await Promise.all([manager.publish(record.workspaceId), manager.publish(record.workspaceId)]);
  assert.equal(forge.calls.filter((call) => call.op === "createCommit").length, 2, "one set of twins: the rounds ran one after the other");
  assert.deepEqual(rounds.map((entry) => entry.round.commits.length).toSorted(), [0, 2]);
});

test("an adopted pull request opened against another base is refused, and a deletion keeps the deleted entry's mode", async () => {
  const { root, bare, manager, forge } = forgeFixture("ws-forge-base");
  symlinkSync("README.md", join(root, "link.md"));
  rawGit(root, ["add", "link.md"]);
  rawGit(root, ["commit", "-q", "-m", "a link"]);
  rawGit(root, ["push", "-q", "origin", "main"]);
  rawGit(root, ["branch", "side"]);
  trackBranch(root, "side");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["link.md"] });
  rawGit(record.lease.worktreePath, ["rm", "-q", "link.md"]);
  rawGit(record.lease.worktreePath, ["commit", "-q", "-m", "Drop the link"]);
  rawGit(record.lease.worktreePath, ["push", "-q", bare, `HEAD:refs/heads/${record.lease.branch!}`]);
  await forge.openDraftPullRequest({ head: record.lease.branch!, base: "side", title: "t", body: "b" });
  await assert.rejects(() => manager.publish(record.workspaceId), throwsCode("workspace_pull_request_base_mismatch"));

  await manager.abort(record.workspaceId);

  // A deletion is sent with the mode the entry had: a link's deletion is a link's.
  const deleting = await manager.create({ agentName: "deleter", mode: "feature", writeSet: ["link.md"] });
  rawGit(deleting.lease.worktreePath, ["rm", "-q", "link.md"]);
  rawGit(deleting.lease.worktreePath, ["commit", "-q", "-m", "Drop the link"]);
  forge.calls.length = 0;
  await manager.publish(deleting.workspaceId);
  const trees = forge.calls.filter((call) => call.op === "createTree").map((call) => call.request as Readonly<{ entries: readonly Readonly<{ path: string; mode: string; sha: string | null }>[] }>);
  assert.deepEqual(trees[0]!.entries, [{ path: "link.md", mode: "120000", sha: null }]);
});


test("draft: ready withdrawal resumes editing, preserves qualification and supports a no-edit ready round trip", async () => {
  const { manager, forge } = forgeFixture("ws-forge-draft-roundtrip");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  const worktree = record.lease.worktreePath;
  commitFile(worktree, "src/a.ts", "export const a = 1;\n");
  await manager.publish(record.workspaceId);
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  const ready = await manager.ready(record.workspaceId);
  const index = readFileSync(indexFilePath(worktree, "directory"));
  const head = rawGit(worktree, ["rev-parse", "HEAD"]);
  const drafted = await manager.draft(record.workspaceId);
  assert.equal(drafted.state, "active");
  assert.equal(forgeStateOf(drafted).ready, false);
  assert.equal(forge.pulls.get(1)!.draft, true);
  assert.deepEqual(drafted.validationReport, ready.validationReport);
  assert.deepEqual(drafted.lease, ready.lease);
  assert.equal(rawGit(worktree, ["rev-parse", "HEAD"]), head);
  assert.deepEqual(readFileSync(indexFilePath(worktree, "directory")), index);
  const unchanged = await manager.draft(record.workspaceId);
  assert.equal(unchanged.revision, drafted.revision, "an observed draft is idempotent");
  const again = await manager.ready(record.workspaceId);
  assert.equal(again.state, "validating");
  assert.equal(forgeStateOf(again).ready, true);
  assert.deepEqual(again.validationReport, ready.validationReport, "ready reuses only the current exact passing report");
});

test("draft: a current failed report and unpublished dirty native work survive withdrawal", async () => {
  const { root, config, manager, forge } = forgeFixture("ws-forge-draft-failed");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  const worktree = record.lease.worktreePath;
  commitFile(worktree, "src/a.ts", "export const a = 1;\n");
  await manager.publish(record.workspaceId);
  await manager.validate(record.workspaceId);
  await manager.ready(record.workspaceId);
  const gate = config.phases.validate[0]!;
  const failed = makeManager(root, { config, commands: makeFakeCommands({ [gate]: () => failGate(gate, "declared current failure") }) }).manager;
  assert.equal((await failed.validate(record.workspaceId)).status, "fail");
  const before = failed.status(record.workspaceId);
  await assert.rejects(() => failed.ready(record.workspaceId), throwsCode("workspace_not_validated"));
  const local = commitFile(worktree, "src/local.ts", "export const local = true;\n");
  writeFile(worktree, "src/a.ts", "staged-only bytes\n");
  rawGit(worktree, ["add", "--", "src/a.ts"]);
  writeFile(worktree, "src/a.ts", "unstaged bytes\n");
  writeFile(worktree, "src/untracked.ts", "untracked bytes\n");
  const index = readFileSync(indexFilePath(worktree, "directory"));
  assert.equal(forge.pulls.get(1)!.draft, false, "dirty native work exists before the first withdrawal");
  const resumed = await failed.draft(record.workspaceId);
  assert.equal(resumed.state, "active");
  assert.equal(forgeStateOf(resumed).ready, false);
  assert.equal(forge.pulls.get(1)!.draft, true);
  assert.equal((await failed.draft(record.workspaceId)).revision, resumed.revision);
  assert.equal(rawGit(worktree, ["rev-parse", "HEAD"]), local);
  assert.deepEqual(readFileSync(indexFilePath(worktree, "directory")), index);
  assert.equal(readFileSync(join(worktree, "src/a.ts"), "utf8"), "unstaged bytes\n");
  assert.equal(readFileSync(join(worktree, "src/untracked.ts"), "utf8"), "untracked bytes\n");
  assert.deepEqual(resumed.validationReport, before.validationReport, "no historical pass replaces the current failure");
});

test("draft: remote conversion followed by record failure reconciles without repeating the side effect", async () => {
  const { root, config, manager, forge } = forgeFixture("ws-forge-draft-reconcile");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/a.ts", "export const a = 1;\n");
  await manager.publish(record.workspaceId);
  await manager.validate(record.workspaceId);
  const ready = await manager.ready(record.workspaceId);
  const store = createWorkspaceRecordStore(workspaceRecordStores(registryOf(root)));
  let intervened = false;
  const dying = makeManager(root, { config, records: { ...store, save: (stale) => {
    assert.equal(intervened, false);
    intervened = true;
    store.save(store.load(record.workspaceId)!); // A genuine competing write increments production revision.
    return store.save(stale); // The actual production CAS must reject this stale writer.
  } } }).manager;
  await assert.rejects(() => dying.draft(record.workspaceId), throwsCode("workspace_record_changed"));
  assert.equal(intervened, true);
  assert.equal(manager.status(record.workspaceId).revision, ready.revision + 1);
  assert.equal(forge.pulls.get(1)!.draft, true, "the remote side effect is retained truthfully");
  assert.equal(forgeStateOf(manager.status(record.workspaceId)).ready, true, "no failed local save claims completion");
  const calls = forge.calls.filter((call) => call.op === "convertToDraft").length;
  const recovered = await manager.draft(record.workspaceId);
  assert.equal(recovered.state, "active");
  assert.equal(forgeStateOf(recovered).ready, false);
  assert.equal(forge.calls.filter((call) => call.op === "convertToDraft").length, calls);
  assert.deepEqual(recovered.validationReport, ready.validationReport);
});

test("draft: a queued pull request refuses before conversion and preserves its record", async () => {
  const { manager, forge } = forgeFixture("ws-forge-draft-queued");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/a.ts", "export const a = 1;\n");
  const { round } = await manager.publish(record.workspaceId);
  await manager.validate(record.workspaceId);
  await manager.ready(record.workspaceId);
  assert.equal((await forge.enqueue(1, { expectedHeadSha: round.head })).kind, "enqueued");
  const before = manager.status(record.workspaceId);
  const conversions = forge.calls.filter((call) => call.op === "convertToDraft").length;
  await assert.rejects(() => manager.draft(record.workspaceId), throwsCode("workspace_draft_denied"));
  assert.deepEqual(manager.status(record.workspaceId), before);
  assert.equal(forge.pulls.get(1)!.draft, false);
  assert.equal(forge.calls.filter((call) => call.op === "convertToDraft").length, conversions);
});


for (const drift of ["head", "index", "branch", "revision", "generation", "upstream"] as const) {
  test(`draft: ${drift} drift during remote observation refuses before conversion and preserves caller work`, async () => {
    const { root, config, manager, forge } = forgeFixture(`ws-draft-local-${drift}`);
    const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
    const worktree = record.lease.worktreePath;
    commitFile(worktree, "src/a.ts", "export const a = 1;\n");
    await manager.publish(record.workspaceId);
    await manager.validate(record.workspaceId);
    await manager.ready(record.workspaceId);
    const store = createWorkspaceRecordStore(workspaceRecordStores(registryOf(root)));
    let injected = false;
    let retained: { head: string; branch: string; index: Buffer; record: ReturnType<typeof manager.status> } | null = null;
    const changing = makeManager(root, { config, forge: () => ({ ...forge, async pullRequest(number) {
      const view = await forge.pullRequest(number);
      assert.equal(injected, false, "the first observation must refuse without a second read");
      injected = true;
      if (drift === "head") commitFile(worktree, "src/later.ts", "caller native progress\n");
      if (drift === "index") { writeFile(worktree, "src/a.ts", "caller staged progress\n"); rawGit(worktree, ["add", "--", "src/a.ts"]); }
      if (drift === "branch") { rawGit(worktree, ["branch", "caller-retained"]); rawGit(worktree, ["symbolic-ref", "HEAD", "refs/heads/caller-retained"]); }
      if (drift === "revision" || drift === "generation") {
        const current = store.load(record.workspaceId)!;
        store.save(drift === "generation" ? { ...current, lease: { ...current.lease, generation: current.lease.generation + 1 } } : current);
      }
      if (drift === "upstream") rawGit(root, ["config", "branch.main.merge", "refs/heads/other-trunk"]);
      retained = { head: rawGit(worktree, ["rev-parse", "HEAD"]), branch: rawGit(worktree, ["symbolic-ref", "HEAD"]), index: readFileSync(indexFilePath(worktree, "directory")), record: store.load(record.workspaceId)! };
      return view;
    } }) }).manager;
    const conversions = forge.calls.filter((call) => call.op === "convertToDraft").length;
    await assert.rejects(() => changing.draft(record.workspaceId), throwsCode(drift === "upstream" ? "workspace_target_upstream_changed" : drift === "branch" ? "workspace_integrity_failed" : "workspace_draft_subject_changed"));
    assert.equal(injected, true);
    assert.ok(retained);
    const after = { head: rawGit(worktree, ["rev-parse", "HEAD"]), branch: rawGit(worktree, ["symbolic-ref", "HEAD"]), index: readFileSync(indexFilePath(worktree, "directory")), record: store.load(record.workspaceId)! };
    assert.deepEqual(after, retained, "the refusal preserves the actual intervening owner's work");
    assert.equal(forge.calls.filter((call) => call.op === "convertToDraft").length, conversions);
    assert.equal(forge.pulls.get(1)!.draft, false);
  });
}

for (const drift of ["number", "head", "base", "closed", "merged", "queued", "not-draft"] as const) {
  test(`draft: post-conversion ${drift} drift retains remote truth without granting local withdrawal`, async () => {
    const { root, config, manager, forge } = forgeFixture(`ws-draft-remote-${drift}`);
    const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
    const worktree = record.lease.worktreePath;
    commitFile(worktree, "src/a.ts", "export const a = 1;\n");
    await manager.publish(record.workspaceId);
    await manager.validate(record.workspaceId);
    const ready = await manager.ready(record.workspaceId);
    const index = readFileSync(indexFilePath(worktree, "directory"));
    let converted = false;
    const changing = makeManager(root, { config, forge: () => ({ ...forge,
      async convertToDraft(number) { await forge.convertToDraft(number); converted = true; },
      async pullRequest(number) {
        const view = await forge.pullRequest(number);
        if (!converted) return view;
        // A post-conversion answer is a different remote subject or lost state.
        return { ...view, ...(drift === "number" ? { number: number + 1 } : drift === "head" ? { headSha: "0".repeat(40) } : drift === "base" ? { base: "foreign" } : drift === "closed" ? { state: "closed" as const } : drift === "merged" ? { merged: true } : drift === "queued" ? { queued: true } : { draft: false }) };
      },
    }) }).manager;
    const codes = { number: "workspace_draft_subject_changed", head: "workspace_published_head_moved", base: "workspace_pull_request_base_mismatch", closed: "workspace_pull_request_closed", merged: "workspace_draft_denied", queued: "workspace_draft_denied", "not-draft": "workspace_draft_not_observed" } as const;
    const marks = forge.calls.filter((call) => call.op === "markReadyForReview").length;
    await assert.rejects(() => changing.draft(record.workspaceId), throwsCode(codes[drift]));
    assert.equal(converted, true);
    assert.equal(forge.pulls.get(1)!.draft, true, "conversion really happened before a hostile readback");
    assert.deepEqual(manager.status(record.workspaceId), ready, "unproved completion cannot change local authorization or reports");
    assert.deepEqual(readFileSync(indexFilePath(worktree, "directory")), index);
    assert.equal(forge.calls.filter((call) => call.op === "markReadyForReview").length, marks, "no compensating remote ready effect");
  });
}

for (const loseAnswer of [false, true]) {
  test(`draft: conversion lostAnswer=${loseAnswer} preserves local readiness and a fresh observed draft reconciles`, async () => {
    const { root, config, manager, forge } = forgeFixture(`ws-draft-convert-${loseAnswer}`);
    const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
    commitFile(record.lease.worktreePath, "src/a.ts", "export const a = 1;\n");
    await manager.publish(record.workspaceId);
    await manager.validate(record.workspaceId);
    const ready = await manager.ready(record.workspaceId);
    const failing = makeManager(root, { config, forge: () => ({ ...forge, async convertToDraft(number) {
      if (loseAnswer) await forge.convertToDraft(number);
      throw new Error("declared conversion transport failure");
    } }) }).manager;
    await assert.rejects(() => failing.draft(record.workspaceId), /declared conversion transport failure/u);
    assert.deepEqual(manager.status(record.workspaceId), ready);
    assert.equal(forge.pulls.get(1)!.draft, loseAnswer);
    const conversions = forge.calls.filter((call) => call.op === "convertToDraft").length;
    const recovered = await manager.draft(record.workspaceId);
    assert.equal(forgeStateOf(recovered).ready, false);
    assert.equal(forge.calls.filter((call) => call.op === "convertToDraft").length, conversions + (loseAnswer ? 0 : 1));
    assert.deepEqual(recovered.validationReport, ready.validationReport);
  });
}


for (const drift of ["head", "index"] as const) {
  for (const phase of ["conversion", "readback"] as const) {
    test(`draft: native ${drift} drift after ${phase} cannot turn a partial remote effect into local authorization`, async () => {
      const { root, config, manager, forge } = forgeFixture(`ws-draft-late-${drift}-${phase}`);
      const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
      const worktree = record.lease.worktreePath;
      commitFile(worktree, "src/a.ts", "export const a = 1;\n");
      await manager.publish(record.workspaceId);
      await manager.validate(record.workspaceId);
      const ready = await manager.ready(record.workspaceId);
      let converted = false;
      let retained: { head: string; index: Buffer } | null = null;
      const intervene = () => {
        assert.equal(retained, null);
        if (drift === "head") commitFile(worktree, "src/caller.ts", "later native progress\n");
        else { writeFile(worktree, "src/a.ts", "later staged progress\n"); rawGit(worktree, ["add", "--", "src/a.ts"]); }
        retained = { head: rawGit(worktree, ["rev-parse", "HEAD"]), index: readFileSync(indexFilePath(worktree, "directory")) };
      };
      const changing = makeManager(root, { config, forge: () => ({ ...forge,
        async convertToDraft(number) { await forge.convertToDraft(number); converted = true; if (phase === "conversion") intervene(); },
        async pullRequest(number) { const view = await forge.pullRequest(number); if (converted && phase === "readback") intervene(); return view; },
      }) }).manager;
      await assert.rejects(() => changing.draft(record.workspaceId), throwsCode("workspace_draft_subject_changed"));
      assert.equal(converted, true);
      assert.ok(retained);
      assert.equal(forge.pulls.get(1)!.draft, true, "partial remote truth is retained");
      assert.deepEqual(manager.status(record.workspaceId), ready, "no local readiness/report/lease claim follows a changed native subject");
      assert.deepEqual({ head: rawGit(worktree, ["rev-parse", "HEAD"]), index: readFileSync(indexFilePath(worktree, "directory")) }, retained);
    });
  }
}


for (const field of ["workspaceId", "baseSha"] as const) {
  test(`ready: a passing same-tree report with another ${field} cannot authorize readiness`, async () => {
    const { root, manager, forge } = forgeFixture(`ws-ready-report-${field}`);
    const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
    commitFile(record.lease.worktreePath, "src/a.ts", "export const a = 1;\n");
    await manager.publish(record.workspaceId);
    assert.equal((await manager.validate(record.workspaceId)).status, "pass");
    const store = createWorkspaceRecordStore(workspaceRecordStores(registryOf(root)));
    const current = store.load(record.workspaceId)!;
    assert.ok(current.validationReport);
    const report = { ...current.validationReport, [field]: field === "workspaceId" ? "other-writer-abcdef123456" : "0".repeat(40) };
    const planted = store.save({ ...current, validationReport: report });
    const marks = forge.calls.filter((call) => call.op === "markReadyForReview").length;
    await assert.rejects(() => manager.ready(record.workspaceId), throwsCode("workspace_not_validated"));
    assert.deepEqual(store.load(record.workspaceId), planted, "the refused report remains truthful evidence");
    assert.equal(forge.pulls.get(1)!.draft, true);
    assert.equal(forge.calls.filter((call) => call.op === "markReadyForReview").length, marks);
  });
}

test("draft: expired authority refuses without ending the workspace or changing its PR", async () => {
  const { root, config, manager, forge } = forgeFixture("ws-draft-expired-readonly");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/a.ts", "export const a = 1;\n");
  await manager.publish(record.workspaceId);
  await manager.validate(record.workspaceId);
  const before = await manager.ready(record.workspaceId);
  const index = readFileSync(indexFilePath(record.lease.worktreePath, "directory"));
  const expired = makeManager(root, { config, now: () => new Date(Date.parse(before.lease.expiresAt) + 1) }).manager;
  const conversions = forge.calls.filter((call) => call.op === "convertToDraft").length;
  await assert.rejects(() => expired.draft(record.workspaceId), throwsCode("workspace_lease_expired"));
  assert.deepEqual(manager.status(record.workspaceId), before);
  assert.equal(existsSync(record.lease.worktreePath), true);
  assert.deepEqual(readFileSync(indexFilePath(record.lease.worktreePath, "directory")), index);
  assert.equal(forge.pulls.get(1)!.draft, false);
  assert.equal(forge.calls.filter((call) => call.op === "convertToDraft").length, conversions);
});

test("draft: missing worktree identity refuses without quarantining or changing its PR", async () => {
  const { manager, forge } = forgeFixture("ws-draft-intact-readonly");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/a.ts", "export const a = 1;\n");
  await manager.publish(record.workspaceId);
  await manager.validate(record.workspaceId);
  const before = await manager.ready(record.workspaceId);
  const indexPath = indexFilePath(record.lease.worktreePath, "directory");
  const index = readFileSync(indexPath);
  rmSync(join(record.lease.worktreePath, ".git"));
  const conversions = forge.calls.filter((call) => call.op === "convertToDraft").length;
  await assert.rejects(() => manager.draft(record.workspaceId), throwsCode("workspace_integrity_failed"));
  assert.deepEqual(manager.status(record.workspaceId), before);
  assert.deepEqual(readFileSync(indexPath), index);
  assert.equal(forge.pulls.get(1)!.draft, false);
  assert.equal(forge.calls.filter((call) => call.op === "convertToDraft").length, conversions);
});

test("draft: a hard-linked native index refuses before conversion and preserves both names", async () => {
  const { root, manager, forge } = forgeFixture("ws-draft-index-second-name");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  const worktree = record.lease.worktreePath;
  commitFile(worktree, "src/a.ts", "export const a = 1;\n");
  await manager.publish(record.workspaceId);
  await manager.validate(record.workspaceId);
  const before = await manager.ready(record.workspaceId);
  const indexPath = indexFilePath(worktree, "directory");
  const bytes = readFileSync(indexPath);
  const mode = lstatSync(indexPath).mode & 0o7777;
  const head = rawGit(worktree, ["rev-parse", "HEAD"]);
  const alias = join(root, "retained-index.alias");
  const conversions = forge.calls.filter((call) => call.op === "convertToDraft").length;
  linkSync(indexPath, alias);
  try {
    assert.ok(hasSecondName(lstatSync(indexPath).nlink), "the fixture really gives the index a second name");
    await assert.rejects(() => manager.draft(record.workspaceId), throwsCode("workspace_custody_unsupported"));
    assert.deepEqual(manager.status(record.workspaceId), before, "record and full qualification are untouched");
    assert.equal(rawGit(worktree, ["rev-parse", "HEAD"]), head);
    assert.deepEqual(readFileSync(indexPath), bytes);
    assert.deepEqual(readFileSync(alias), bytes, "a refusal neither removes nor rewrites the other name");
    assert.equal(lstatSync(indexPath).mode & 0o7777, mode);
    assert.equal(lstatSync(alias).mode & 0o7777, mode);
    assert.equal(forge.pulls.get(1)!.draft, false);
    assert.equal(forge.calls.filter((call) => call.op === "convertToDraft").length, conversions);
  } finally {
    rmSync(alias);
  }
  const resumed = await manager.draft(record.workspaceId);
  assert.equal(forgeStateOf(resumed).ready, false, "the ordinary single-name index remains usable");
  assert.deepEqual(resumed.validationReport, before.validationReport);
});

test("draft CLI: the shared production dispatcher preserves explicit success over an earlier FAIL", async () => {
  const { root, config, manager, forge } = forgeFixture("ws-draft-cli-dispatch");
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/a.ts", "export const ready = true;\n");
  await manager.publish(record.workspaceId);
  await manager.validate(record.workspaceId);
  await manager.ready(record.workspaceId);
  const failing = makeManager(root, { config, commands: {
    async run(_cwd, name) { return failGate(name, "declared current CLI failure"); },
  } }).manager;
  assert.equal((await failing.validate(record.workspaceId)).status, "fail");
  const before = failing.status(record.workspaceId);
  const result = await dispatchWorkspaceCli(failing, "draft", [record.workspaceId]);
  assert.equal(result.status, "pass");
  assert.ok("action" in result.result);
  assert.equal(result.result.action, "draft");
  assert.equal(forgeStateOf(failing.status(record.workspaceId)).ready, false);
  assert.deepEqual(failing.status(record.workspaceId).validationReport, before.validationReport);
  assert.equal(forge.pulls.get(1)!.draft, true);
  await assert.rejects(() => runWorkspaceCli(root, ["draft", record.workspaceId]), throwsCode("workspace_forge_remote_unknown"), "normal outer parsing reaches the existing forge route without contacting an API for this bare fixture");
  for (const args of [[], [record.workspaceId, "extra"], ["--force"], [record.workspaceId, "--force"]]) {
    await assert.rejects(() => runWorkspaceCli(root, ["draft", ...args]), throwsCode("input_error"));
  }
});
