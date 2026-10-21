import assert from "node:assert/strict";
import { chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceConflictError } from "../../src/workflow/workspace-manager.ts";
import { resolveForgeTarget, type WorkspaceForge, type WorkspaceForgeFactory } from "../../src/workflow/workspace-forge.ts";
import {
  commitFile,
  forgeAt,
  initTempRepo,
  makeManager,
  makeTestConfig,
  mkWorkspaceTempDir,
  rawGit,
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
  assert.deepEqual(record.forge, { remote: "origin", trunk: "main", pullRequest: null, publishedHead: null, ready: false }, "create resolved the target's upstream and opened nothing yet");
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
  assert.deepEqual(published.forge, { remote: "origin", trunk: "main", pullRequest: { number: 1, url: "https://forge.test/pull/1" }, publishedHead: round.head, ready: false });
  assert.equal(manager.status(record.workspaceId).forge?.publishedHead, round.head, "the record is saved");
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
  assert.deepEqual(forge.calls.find((call) => call.op === "setBranch")?.request, { branch: record.lease.branch, sha: second.head, previous: first.head });
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

  const lying: WorkspaceForgeFactory = (target) => {
    const real: WorkspaceForge = forgeAt(target.remoteUrl);
    return { ...real, createBlob: async (content: Buffer) => { await real.createBlob(content); return "0".repeat(40); } };
  };
  await assert.rejects(() => makeManager(root, { config, forge: lying }).manager.publish(record.workspaceId), throwsCode("workspace_publish_object_mismatch"));

  const round = (await manager.publish(record.workspaceId)).round;
  // Someone else pushes to the agent's branch on the forge: it is never rewound.
  const clone = mkWorkspaceTempDir("ws-forge-intruder");
  rawGit(clone, ["clone", "-q", bare, "."]);
  rawGit(clone, ["checkout", "-q", record.lease.branch!]);
  commitFile(clone, "src/intruder.ts", "export const intruder = 1;\n");
  rawGit(clone, ["push", "-q", "origin", record.lease.branch!]);
  await assert.rejects(() => manager.publish(record.workspaceId), throwsCode("workspace_publish_remote_ahead"));
  assert.equal(rawGit(worktree, ["rev-parse", "HEAD"]), round.head, "the local branch stays at what it published");

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
  assert.equal(published.forge?.pullRequest?.number, opened.number);
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
  assert.equal(marked.forge?.ready, true);
  assert.equal(forge.pulls.get(1)!.draft, false);
  forge.calls.length = 0;
  await manager.ready(record.workspaceId);
  assert.equal(forge.calls.filter((call) => call.op === "markReadyForReview").length, 0, "an already ready pull request is not marked again");
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
