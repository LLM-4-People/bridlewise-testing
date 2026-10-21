import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import { acquireLock, LockAcquisitionTimeout } from "../../src/workflow/resource-lock.ts";
import { FILE_LOCK_SCHEMA_VERSION, type FileLockContent } from "../../src/filesystem/file-lock.ts";
import {
  WorkspaceConflictError,
  WorkspaceIntegrityError,
  WorkspaceLeaseExpiredError,
} from "../../src/workflow/workspace-manager.ts";
import {
  commitFile,
  initTempRepo,
  makeManager,
  makeTestConfig,
  mkWorkspaceTempDir,
  rawGit,
  registryRoot,
  trackBranch,
} from "./workspace-test-support.ts";

/**
 * Hostile and concurrency scenarios for the workspace registry and its
 * integrator: one registry and one pair of locks per repository (seen from
 * every worktree), concurrent admission, merge-lock contention, stale-lock
 * recovery, mid-run worktree destruction, lease expiry and the sweep.
 */

/** Matches a HarnessError by its typed code. */
function throwsCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === code;
}

function lockDirectory(root: string): string {
  return join(registryRoot(root), "locks");
}

test("two simultaneous merges serialize on the repository's merge lock", async () => {
  const { root } = initTempRepo("ws-race");
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir("ws-race-wt")) });
  const first = await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/race-a"] });
  const second = await manager.create({ agentName: "agentB", mode: "feature", writeSet: ["src/race-b"] });
  commitFile(first.lease.worktreePath, "src/race-a/a.ts", "export const a = 1;\n");
  commitFile(second.lease.worktreePath, "src/race-b/b.ts", "export const b = 1;\n");
  assert.equal((await manager.validate(first.workspaceId)).status, "pass");
  assert.equal((await manager.validate(second.workspaceId)).status, "pass");

  const [receiptA, receiptB] = await Promise.all([manager.merge(first.workspaceId), manager.merge(second.workspaceId)]);
  assert.notEqual(receiptA.mergeCommitSha, receiptB.mergeCommitSha);
  assert.equal(manager.list().filter((record) => record.state === "merged").length, 2);
  assert.ok(existsSync(join(root, "src/race-a/a.ts")) && existsSync(join(root, "src/race-b/b.ts")), "both landed, one after the other");
  assert.equal(rawGit(root, ["branch", "--list", "agent/*"]), "");
  assert.equal(existsSync(join(lockDirectory(root), "workspace-merge.lock")), false, "merge lock is released");
});

test("two concurrent creates with overlapping write sets: exactly one is admitted", async () => {
  const { root } = initTempRepo("ws-admit");
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir("ws-admit-wt")) });
  const outcomes = await Promise.allSettled([
    manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/shared"] }),
    manager.create({ agentName: "agentB", mode: "feature", writeSet: ["src/shared/inner"] }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const refused = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(refused !== undefined && refused.reason instanceof WorkspaceConflictError && refused.reason.report.kind === "static-overlap");
  assert.equal(manager.list().filter((record) => record.state === "active").length, 1);
});

test("a manager rooted in another worktree of the repository sees the same registry and takes the same locks", async () => {
  const { root } = initTempRepo("ws-common");
  const linked = join(mkWorkspaceTempDir("ws-common-linked"), "other");
  rawGit(root, ["worktree", "add", "-q", "-b", "other", linked]);
  trackBranch(root, "other");
  const config = makeTestConfig(mkWorkspaceTempDir("ws-common-wt"));
  const fromMain = makeManager(root, { config }).manager;
  const fromLinked = makeManager(linked, { config }).manager;
  assert.equal(fromLinked.registry.root, fromMain.registry.root);
  const record = await fromMain.create({ agentName: "agentA", mode: "feature", writeSet: ["src/a"] });
  assert.equal(fromLinked.status(record.workspaceId).workspaceId, record.workspaceId);
  await assert.rejects(() => fromLinked.create({ agentName: "agentB", mode: "feature", writeSet: ["src/a/deeper"] }), (error: unknown) =>
    error instanceof WorkspaceConflictError && error.report.conflicts[0]!.otherWorkspaceId === record.workspaceId);
  const fromThere = await fromLinked.create({ agentName: "agentC", mode: "feature", writeSet: ["src/c"] });
  assert.equal(fromThere.lease.targetBranch, "other", "the target defaults to the branch checked out where the command runs");
});

test("a read-only workspace overlapping an active lease is admitted, carries no lease, and can never merge", async () => {
  const { root } = initTempRepo("ws-readonly");
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir("ws-readonly-wt")) });
  await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  const verifier = await manager.create({ agentName: "verifier", mode: "read-only", writeSet: [] });
  assert.equal(verifier.lease.kind, "read-only");
  assert.equal(verifier.lease.branch, null);
  assert.equal(verifier.lease.targetBranch, null);
  assert.equal(verifier.lease.writeSetIdentity, null);
  assert.deepEqual(verifier.lease.writeSet, []);
  assert.equal(rawGit(verifier.lease.worktreePath, ["rev-parse", "HEAD"]), rawGit(root, ["rev-parse", "HEAD"]));
  const report = await manager.validate(verifier.workspaceId);
  assert.equal(report.status, "pass");
  assert.equal(report.gates[0]!.status, "skip");
  await assert.rejects(() => manager.merge(verifier.workspaceId), throwsCode("workspace_read_only"));
  await assert.rejects(() => manager.extend(verifier.workspaceId, ["src"]), throwsCode("workspace_read_only"));
  await assert.rejects(() => manager.create({ agentName: "verifier", mode: "read-only", writeSet: ["src"] }), throwsCode("workspace_read_only"));
  manager.abort(verifier.workspaceId);
  assert.ok(!existsSync(verifier.lease.worktreePath));
});

test("extend widens and renews a lease through the same admission check", async () => {
  let clock = Date.parse("2026-09-30T12:00:00.000Z");
  const { root } = initTempRepo("ws-extend");
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir("ws-extend-wt")), now: () => new Date(clock) });
  const record = await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/a"] });
  const other = await manager.create({ agentName: "agentB", mode: "feature", writeSet: ["src/b"] });
  clock += 60_000;
  const extended = await manager.extend(record.workspaceId, ["docs"]);
  assert.deepEqual(extended.lease.writeSet, ["docs", "src/a"]);
  assert.equal(extended.lease.generation, 2);
  assert.ok(extended.lease.expiresAt > record.lease.expiresAt, "the lease is renewed");
  assert.notEqual(extended.lease.writeSetIdentity, record.lease.writeSetIdentity);
  await assert.rejects(() => manager.extend(record.workspaceId, ["src/b/c.ts"]), (error: unknown) =>
    error instanceof WorkspaceConflictError && error.report.conflicts.some((entry) => entry.otherWorkspaceId === other.workspaceId));
  assert.equal(manager.status(record.workspaceId).lease.generation, 2, "a refused extension changes nothing");
});

test("a held merge lock blocks the integrator with a timeout", async () => {
  const { root } = initTempRepo("ws-heldlock");
  const config = makeTestConfig(mkWorkspaceTempDir("ws-heldlock-wt"), {
    mergeLock: Object.freeze({ name: "workspace-merge", timeoutMs: 300, staleMs: 60_000 }),
  });
  const { manager } = makeManager(root, { config });
  const record = await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/held"] });
  commitFile(record.lease.worktreePath, "src/held/h.ts", "export const h = 1;\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  const handle = await acquireLock(registryRoot(root), "workspace-merge", { lockDirectory: lockDirectory(root), timeoutMs: 1_000, unreadableAfterMs: 60_000 });
  try {
    await assert.rejects(() => manager.merge(record.workspaceId), LockAcquisitionTimeout);
  } finally {
    handle.release();
  }
});

test("a stale lock file from a dead process is recovered", async () => {
  const { root } = initTempRepo("ws-stalelock");
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir("ws-stalelock-wt")) });
  mkdirSync(lockDirectory(root), { recursive: true });
  // A lock record as the one file lock writes it, held by a pid that is not alive.
  const stale: FileLockContent = {
    schemaVersion: FILE_LOCK_SCHEMA_VERSION,
    pid: 999_999_999,
    startTime: 1,
    acquiredAt: new Date(Date.now() - 3_600_000).toISOString(),
    nonce: "planted-dead-merge",
    holder: "workspace-merge:dead",
    adopted: [],
  };
  writeFileSync(join(lockDirectory(root), "workspace-merge.lock"), `${JSON.stringify(stale)}\n`, { mode: 0o600 });
  const record = await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/stale"] });
  commitFile(record.lease.worktreePath, "src/stale/s.ts", "export const s = 1;\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  const receipt = await manager.merge(record.workspaceId);
  assert.equal(receipt.workspaceId, record.workspaceId);
  assert.equal(manager.status(record.workspaceId).state, "merged");
});

test("deleting the worktree's .git entry mid-run quarantines without touching the canonical checkout", async () => {
  const { root } = initTempRepo("ws-destroyed");
  const canonicalHeadBefore = rawGit(root, ["rev-parse", "HEAD"]);
  const indexBefore = sha256(readFileSync(join(root, ".git/index")));
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir("ws-destroyed-wt")) });
  const record = await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/doomed"] });
  commitFile(record.lease.worktreePath, "src/doomed/d.ts", "export const d = 1;\n");
  rmSync(join(record.lease.worktreePath, ".git"), { force: true });
  await assert.rejects(() => manager.validate(record.workspaceId), WorkspaceIntegrityError);
  assert.equal(manager.status(record.workspaceId).state, "quarantined");
  assert.equal(rawGit(root, ["rev-parse", "HEAD"]), canonicalHeadBefore);
  assert.equal(sha256(readFileSync(join(root, ".git/index"))), indexBefore);
});

test("an expired lease aborts through validation and through the sweep; the sweep removes a quarantined worktree past its retention", async () => {
  let clock = Date.parse("2026-09-30T12:00:00.000Z");
  const { root } = initTempRepo("ws-expired");
  const config = makeTestConfig(mkWorkspaceTempDir("ws-expired-wt"), { leaseTtlMs: 1_000, quarantineTtlMs: 5_000 });
  const { manager } = makeManager(root, { config, now: () => new Date(clock) });
  const first = await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/e1"] });
  const second = await manager.create({ agentName: "agentB", mode: "feature", writeSet: ["src/e2"] });
  clock += 2_000;
  await assert.rejects(() => manager.validate(first.workspaceId), WorkspaceLeaseExpiredError);
  assert.equal(manager.status(first.workspaceId).state, "quarantined");
  assert.deepEqual(await manager.sweep(), [second.workspaceId]);
  assert.equal(manager.status(second.workspaceId).state, "quarantined");
  assert.ok(existsSync(first.lease.worktreePath) && existsSync(second.lease.worktreePath), "quarantine preserves the worktrees");
  assert.match(rawGit(root, ["worktree", "list", "--porcelain"]), /locked/u, "a quarantined worktree is locked");

  clock += 10_000;
  assert.deepEqual([...await manager.sweep()].toSorted(), [first.workspaceId, second.workspaceId].toSorted());
  assert.ok(!existsSync(first.lease.worktreePath) && !existsSync(second.lease.worktreePath), "past its retention a quarantined (locked) worktree is removed");
});
