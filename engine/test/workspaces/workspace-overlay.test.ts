import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import {
  commitFile,
  initTempRepo,
  makeManager,
  makeTestConfig,
  mkWorkspaceTempDir,
  rawGit,
  trackBranch,
  writeFile,
} from "./workspace-test-support.ts";

/**
 * `harness workspace create --overlay`: a dirty checkout's working tree,
 * snapshotted (its real index and files untouched) into a workspace, fixed
 * there through the ordinary gates, and ADOPTED back into that checkout by
 * the merge — only while the checkout still holds exactly the snapshot. The
 * fixture checkout is a LINKED worktree (as the testing checkout is), so the
 * index is found with `--git-path index`, never `.git/index`.
 */

/** Matches a HarnessError by its typed code. */
function throwsCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === code;
}

/** A repository whose `testing` branch is checked out in a linked worktree, with a few tracked files. */
function linkedCheckout(prefix: string): Readonly<{ root: string; linked: string }> {
  const { root } = initTempRepo(prefix);
  commitFile(root, "a.txt", "a\n");
  commitFile(root, "b.txt", "b\n");
  commitFile(root, "gone.txt", "gone\n");
  const linked = join(mkWorkspaceTempDir(`${prefix}-linked`), "testing");
  rawGit(root, ["worktree", "add", "-q", "-b", "testing", linked]);
  trackBranch(root, "testing");
  return { root, linked };
}

/** The linked checkout's inherited dirty state: an unstaged edit, a staged add, an intent-to-add, an untracked file, an unstaged deletion. */
function dirty(linked: string): void {
  writeFileSync(join(linked, "a.txt"), "a, edited\n");
  writeFile(linked, "staged.txt", "staged\n");
  rawGit(linked, ["add", "staged.txt"]);
  writeFile(linked, "intent.txt", "intent\n");
  rawGit(linked, ["add", "-N", "intent.txt"]);
  writeFile(linked, "untracked.txt", "untracked\n");
  rmSync(join(linked, "gone.txt"));
}

function indexPath(checkout: string): string {
  return rawGit(checkout, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
}

/** What `git add -A` would commit, computed independently (a temp copy of the index). */
function independentSnapshotTree(checkout: string): string {
  const scratch = join(mkWorkspaceTempDir("ws-overlay-index"), "index");
  copyFileSync(indexPath(checkout), scratch);
  rawGit(checkout, ["add", "-A"], { GIT_INDEX_FILE: scratch });
  return rawGit(checkout, ["write-tree"], { GIT_INDEX_FILE: scratch });
}

test("create --overlay leaves the checkout's index byte-identical and its files untouched; the overlay is what git add -A would commit", async () => {
  const { linked } = linkedCheckout("ws-overlay-create");
  dirty(linked);
  const indexBefore = sha256(readFileSync(indexPath(linked)));
  const statusBefore = rawGit(linked, ["status", "--porcelain=v2"]);
  const expectedTree = independentSnapshotTree(linked);
  const head = rawGit(linked, ["rev-parse", "HEAD"]);

  const { manager } = makeManager(linked, { config: makeTestConfig(mkWorkspaceTempDir("ws-overlay-create-wt")) });
  const record = await manager.create({ agentName: "adopt", mode: "overlay", writeSet: [] });

  assert.equal(sha256(readFileSync(indexPath(linked))), indexBefore, "the real index is byte-identical");
  assert.equal(rawGit(linked, ["status", "--porcelain=v2"]), statusBefore, "the working tree is untouched");
  const overlay = record.lease.overlay!;
  assert.equal(overlay.tree, expectedTree, "the overlay records exactly the tree git add -A would commit");
  assert.equal(overlay.checkout, linked);
  assert.equal(rawGit(linked, ["rev-parse", `${overlay.commit}^`]), head, "the overlay's parent is the checkout's HEAD");
  assert.equal(record.lease.baseSha, head);
  assert.equal(record.lease.targetBranch, "testing");
  assert.deepEqual([...record.lease.writeSet], ["a.txt", "gone.txt", "intent.txt", "staged.txt", "untracked.txt"]);
  assert.equal(rawGit(record.lease.worktreePath, ["rev-parse", "HEAD"]), overlay.commit, "the workspace starts at the overlay");
  assert.equal(readFileSync(join(record.lease.worktreePath, "a.txt"), "utf8"), "a, edited\n");
});

test("adoption: the merge lands the overlay and the workspace's fixes into the checkout, which ends clean at the merge", async () => {
  const { linked } = linkedCheckout("ws-overlay-adopt");
  dirty(linked);
  const tip = rawGit(linked, ["rev-parse", "HEAD"]);
  const { manager } = makeManager(linked, { config: makeTestConfig(mkWorkspaceTempDir("ws-overlay-adopt-wt")) });
  const record = await manager.create({ agentName: "adopt", mode: "overlay", writeSet: [] });
  commitFile(record.lease.worktreePath, "a.txt", "a, edited and fixed in the workspace\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  const receipt = await manager.merge(record.workspaceId);

  assert.equal(receipt.landing, "overlay-adoption");
  assert.equal(receipt.landedIn, linked);
  assert.equal(rawGit(linked, ["rev-parse", "HEAD"]), receipt.mergeCommitSha);
  assert.equal(rawGit(linked, ["rev-parse", `${receipt.mergeCommitSha}^1`]), tip, "first-parent history: the old tip, then the merge");
  rawGit(linked, ["merge-base", "--is-ancestor", record.lease.overlay!.commit, receipt.mergeCommitSha]);
  assert.equal(rawGit(linked, ["status", "--porcelain"]), "", "the checkout is clean at the merge: every entry was adopted");
  assert.equal(readFileSync(join(linked, "a.txt"), "utf8"), "a, edited and fixed in the workspace\n");
  assert.equal(readFileSync(join(linked, "untracked.txt"), "utf8"), "untracked\n");
  assert.equal(rawGit(linked, ["ls-files", "gone.txt"]), "", "the deletion was adopted");
  assert.equal(rawGit(linked, ["cat-file", "-p", `${receipt.mergeCommitSha}:intent.txt`]), "intent");
});

test("an adoption that fails after its read-tree gives the checkout its own index back, byte for byte (A5-correctness L1)", async () => {
  const { linked } = linkedCheckout("ws-overlay-restore");
  dirty(linked);
  const indexBefore = sha256(readFileSync(indexPath(linked)));
  const statusBefore = rawGit(linked, ["status", "--porcelain=v2"]);
  const config = makeTestConfig(mkWorkspaceTempDir("ws-overlay-restore-wt"));
  const { manager, git } = makeManager(linked, { config });
  const record = await manager.create({ agentName: "adopt", mode: "overlay", writeSet: [] });
  commitFile(record.lease.worktreePath, "a.txt", "a, fixed\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  // The switch fails once the index was already rewritten to the snapshot's tree.
  const failing = { ...git, readTreeSwitch: () => { throw new Error("injected: the two-way switch failed"); } };
  const { manager: integrator } = makeManager(linked, { config, git: failing });
  await assert.rejects(() => integrator.merge(record.workspaceId), /injected: the two-way switch failed/u);
  assert.equal(sha256(readFileSync(indexPath(linked))), indexBefore, "the checkout's own index is back");
  assert.equal(rawGit(linked, ["status", "--porcelain=v2"]), statusBefore);
});

test("a checkout touched after the overlay was taken refuses the adoption and stays as it is", async () => {
  const { linked } = linkedCheckout("ws-overlay-stale");
  dirty(linked);
  const { manager } = makeManager(linked, { config: makeTestConfig(mkWorkspaceTempDir("ws-overlay-stale-wt")) });
  // The fix touches a file the overlay did not change: the lease names it too.
  const record = await manager.create({ agentName: "adopt", mode: "overlay", writeSet: ["b.txt"] });
  assert.ok(record.lease.writeSet.includes("b.txt"));
  commitFile(record.lease.worktreePath, "b.txt", "b, fixed\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  writeFileSync(join(linked, "b.txt"), "b, edited in the checkout after the overlay\n");
  const statusBefore = rawGit(linked, ["status", "--porcelain=v2"]);
  const headBefore = rawGit(linked, ["rev-parse", "HEAD"]);
  await assert.rejects(() => manager.merge(record.workspaceId), throwsCode("workspace_overlay_stale"));
  assert.equal(rawGit(linked, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(rawGit(linked, ["status", "--porcelain=v2"]), statusBefore);
  assert.equal(readFileSync(join(linked, "b.txt"), "utf8"), "b, edited in the checkout after the overlay\n");
  assert.equal(manager.status(record.workspaceId).state, "active");
});

test("an overlay is refused when a staged version would be lost: neither HEAD nor the working tree holds it", async () => {
  const { linked } = linkedCheckout("ws-overlay-divergent");
  writeFileSync(join(linked, "a.txt"), "the staged version\n");
  rawGit(linked, ["add", "a.txt"]);
  writeFileSync(join(linked, "a.txt"), "the working-tree version\n");
  const indexBefore = sha256(readFileSync(indexPath(linked)));
  const { manager } = makeManager(linked, { config: makeTestConfig(mkWorkspaceTempDir("ws-overlay-divergent-wt")) });
  await assert.rejects(() => manager.create({ agentName: "adopt", mode: "overlay", writeSet: [] }), throwsCode("workspace_overlay_staged_divergent"));
  assert.equal(sha256(readFileSync(indexPath(linked))), indexBefore);
  assert.deepEqual(manager.list(), []);
});

test("an overlay is refused when a staged deletion's file is still on disk (git rm --cached): the snapshot would add it back", async () => {
  const { linked } = linkedCheckout("ws-overlay-keptdeletion");
  writeFileSync(join(linked, "a.txt"), "a, edited\n");
  rawGit(linked, ["rm", "-q", "--cached", "--", "b.txt"]);
  const indexBefore = sha256(readFileSync(indexPath(linked)));
  const { manager } = makeManager(linked, { config: makeTestConfig(mkWorkspaceTempDir("ws-overlay-keptdeletion-wt")) });
  await assert.rejects(() => manager.create({ agentName: "adopt", mode: "overlay", writeSet: [] }), (error: unknown) =>
    throwsCode("workspace_overlay_staged_divergent")(error) && String((error as Error).message).includes("the deletion of b.txt"));
  assert.equal(sha256(readFileSync(indexPath(linked))), indexBefore);
  assert.deepEqual(manager.list(), []);
});

/** An overlay validated, then ONE thing of its checkout changed (`touch`): the adoption must be refused as stale. */
async function adoptionAfterOnly(touch: "index" | "target"): Promise<void> {
  const { linked } = linkedCheckout(`ws-overlay-only-${touch}`);
  dirty(linked);
  const { manager } = makeManager(linked, { config: makeTestConfig(mkWorkspaceTempDir(`ws-overlay-only-${touch}-wt`)) });
  const record = await manager.create({ agentName: "adopt", mode: "overlay", writeSet: [] });
  commitFile(record.lease.worktreePath, "a.txt", "a, fixed\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  if (touch === "index") {
    // Same files, so the same snapshot tree; only the index differs.
    rawGit(linked, ["add", "-N", "untracked.txt"]);
  } else {
    // Same files and index; only the branch moved (another writer's commit).
    const moved = rawGit(linked, ["commit-tree", "-p", "HEAD", "-m", "elsewhere", `${rawGit(linked, ["rev-parse", "HEAD"])}^{tree}`]);
    rawGit(linked, ["update-ref", "refs/heads/testing", moved]);
  }
  await assert.rejects(() => manager.merge(record.workspaceId), (error: unknown) =>
    throwsCode("workspace_overlay_stale")(error) && String((error as Error).message).includes(touch === "index" ? "index changed" : "testing moved"));
  assert.equal(manager.status(record.workspaceId).state, "active");
}

test("the adoption is refused when only the checkout's index (not its files) changed after the overlay", () => adoptionAfterOnly("index"));
test("the adoption is refused when only the checkout's branch (not its files or index) moved after the overlay", () => adoptionAfterOnly("target"));

test("an overlay is refused when a deleted file's bytes sit at an ignored path (a move-loss)", async () => {
  const { linked } = linkedCheckout("ws-overlay-moveloss");
  writeFileSync(join(linked, ".gitignore"), `${readFileSync(join(linked, ".gitignore"), "utf8")}parked/\n`);
  rawGit(linked, ["commit", "-qam", "ignore parked/"]);
  mkdirSync(join(linked, "parked"));
  renameSync(join(linked, "b.txt"), join(linked, "parked", "b.txt"));
  const { manager } = makeManager(linked, { config: makeTestConfig(mkWorkspaceTempDir("ws-overlay-moveloss-wt")) });
  await assert.rejects(() => manager.create({ agentName: "adopt", mode: "overlay", writeSet: [] }), (error: unknown) =>
    throwsCode("workspace_overlay_move_loss")(error) && String((error as Error).message).includes("b.txt"));
});

test("an overlay of a clean checkout is refused: there is nothing to adopt", async () => {
  const { linked } = linkedCheckout("ws-overlay-clean");
  const { manager } = makeManager(linked, { config: makeTestConfig(mkWorkspaceTempDir("ws-overlay-clean-wt")) });
  await assert.rejects(() => manager.create({ agentName: "adopt", mode: "overlay", writeSet: [] }), throwsCode("workspace_overlay_clean"));
});

test("an overlay lands into the checkout it snapshots: another target is refused", async () => {
  const { root, linked } = linkedCheckout("ws-overlay-target");
  dirty(linked);
  const { manager } = makeManager(linked, { config: makeTestConfig(mkWorkspaceTempDir("ws-overlay-target-wt")) });
  await assert.rejects(() => manager.create({ agentName: "adopt", mode: "overlay", writeSet: [], target: "main" }), throwsCode("workspace_overlay_target"));
  assert.equal(rawGit(root, ["branch", "--list", "agent/*"]), "");
});

test("the overlay adoption's read-tree switch keeps the config's 0600 (the one settle point after a tree move)", async () => {
  const { root } = initTempRepo("ws-overlay-mode");
  const configFile = "engine/bridlewise.config.json";
  commitFile(root, "a.txt", "a\n");
  commitFile(root, configFile, "{}\n");
  const linked = join(mkWorkspaceTempDir("ws-overlay-mode-linked"), "testing");
  rawGit(root, ["worktree", "add", "-q", "-b", "testing", linked]);
  trackBranch(root, "testing");
  chmodSync(join(linked, configFile), 0o600);
  writeFileSync(join(linked, "a.txt"), "a, edited\n");
  const { manager } = makeManager(linked, { config: makeTestConfig(mkWorkspaceTempDir("ws-overlay-mode-wt")) });
  const record = await manager.create({ agentName: "adopt", mode: "overlay", writeSet: [configFile] });
  commitFile(record.lease.worktreePath, configFile, "{ }\n");
  const report = await manager.validate(record.workspaceId);
  assert.equal(report.status, "pass", JSON.stringify(report.gates.filter((gate) => gate.status !== "pass")));
  const receipt = await manager.merge(record.workspaceId);
  assert.equal(receipt.landing, "overlay-adoption");
  assert.equal(readFileSync(join(linked, configFile), "utf8"), "{ }\n", "the adoption rewrote the config");
  assert.equal(statSync(join(linked, configFile)).mode & 0o777, 0o600, "and it keeps 0600");
});
