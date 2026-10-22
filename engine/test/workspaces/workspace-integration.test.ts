import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLinuxMountPoints } from "../../src/filesystem/linux-path.ts";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { HarnessError } from "../../src/kernel/errors.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { landCommit } from "../../src/workflow/tree-landing.ts";
import { WEB_RUN_HISTORY_PATH, suiteLedgerPaths, type SuiteLedgerName } from "../../src/shared/run-history.ts";
import { README_CONSUMER_BLOCK } from "../../src/kernel/verification-paths.ts";
import { acquireLock } from "../../src/workflow/resource-lock.ts";
import { createWorkspaceRecordStore, workspaceRecordStores } from "../../src/workflow/workspace-registry.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import type { EventLedgerStoragePort } from "../../src/timeline/timeline-types.ts";
import {
  createWorkspaceManager,
  createWorkspaceTimelineHooks,
  WorkspaceConflictError,
  WorkspaceGateFailedError,
  WorkspaceLeaseExpiredError,
} from "../../src/workflow/workspace-manager.ts";
import { configureDebugSystem, createCollectingSink, getAuditEvents, resetDebugSystem } from "../../src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../src/shared/debug/debug-config.ts";
import type { WorkspaceRecord } from "../../src/workflow/workspace-contracts.ts";
import {
  commitFailureOwners,
  commitFile,
  commitTrackerBoard,
  failGate,
  fakeForgeFactory,
  forgeStateOf,
  initTempRepo,
  makeFakeCommands,
  makeGitPort,
  makeManager,
  makeTestConfig,
  mkWorkspaceTempDir,
  passGate,
  qualifiedSuiteGate,
  rawGit,
  registryOf,
  registryRoot,
  TEST_INTEGRATOR_IDENTITY,
  TEST_TIMEOUTS,
  testRepository,
  trackBranch,
  writeFile,
} from "./workspace-test-support.ts";
import { repositoryRegistry } from "../../src/workflow/repository-registry.ts";
import { budgetFieldOf } from "../../src/workflow/workspace-manager.ts";

/** Matches a HarnessError by its typed code. */
function throwsCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === code;
}

/** Everything a checkout's state is: HEAD, the index's entries and the status, byte for byte. */
function checkoutState(root: string): Readonly<{ head: string; indexEntries: string; staged: string; status: string }> {
  return {
    head: rawGit(root, ["rev-parse", "HEAD"]),
    indexEntries: rawGit(root, ["ls-files", "--stage"]),
    staged: rawGit(root, ["diff", "--cached", "--name-status"]),
    status: rawGit(root, ["status", "--porcelain=v2"]),
  };
}

const PIN_A = "a".repeat(64);
const PIN_B = "b".repeat(64);
const PIN_C = "c".repeat(64);
/** A pin-bearing generated output (a hash-binding target) and a wholly generated one, repository-relative. */
const PIN_BEARING = "engine/src/kernel/root-policy.ts";
const WHOLESALE = "engine/src/architecture-manifest.ts";
/**
 * The pin-bearing file's text: a REAL binding's pin (the config contract's
 * `sourceSha256`, located by its registry `findRegex`) and an authored body.
 */
function pinned(pin: string, body: string): string {
  return `export const POLICY = {\n  configuration: { contract: {\n    sourcePath: "${ROOT_POLICY.configuration.contract.sourcePath}",\n    sourceSha256: "${pin}",\n  } },\n  body: "${body}",\n};\n`;
}

test("happy path: create -> commit -> validate -> merge lands by fast-forward in the checkout holding the target, then tears down", async () => {
  const { root } = initTempRepo("ws-happy");
  const workspaceRoot = mkWorkspaceTempDir("ws-happy-wt");
  const commands = makeFakeCommands();
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot), commands });
  const tip = rawGit(root, ["rev-parse", "HEAD"]);

  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src/feature"] });
  assert.equal(record.state, "active");
  assert.equal(record.lease.kind, "feature");
  assert.equal(record.lease.targetBranch, "main", "the target defaults to the branch checked out where the command runs");
  assert.equal(record.lease.baseSha, tip);
  assert.ok(record.lease.branch?.startsWith("agent/worker/"));
  assert.ok(existsSync(record.lease.worktreePath));
  assert.equal(record.lease.writeSetIdentity?.length, 64);
  assert.ok(existsSync(join(workspaceRecordStores(registryOf(root)).current, `${record.workspaceId}.json`)), "the record lives in the git common dir's registry");

  commitFile(record.lease.worktreePath, "src/feature/new.ts", "export const x = 1;\n");
  const report = await manager.validate(record.workspaceId);
  assert.equal(report.status, "pass");
  assert.equal(report.full, false);
  assert.deepEqual(report.changedPaths, ["src/feature/new.ts"]);
  assert.deepEqual(report.gates.map((gate) => gate.gate), ["write-set-proof", "unit"]);

  const receipt = await manager.merge(record.workspaceId);
  assert.equal(receipt.landing, "fast-forward");
  assert.equal(receipt.landedIn, root);
  assert.equal(receipt.targetBranch, "main");
  assert.equal(receipt.preMergeHeadSha, tip);
  assert.deepEqual(receipt.changedPaths, ["src/feature/new.ts"]);
  assert.equal(receipt.receiptHash.length, 64);

  assert.equal(rawGit(root, ["rev-parse", "HEAD"]), receipt.mergeCommitSha, "the canonical branch fast-forwarded to the merge commit");
  assert.equal(rawGit(root, ["rev-parse", `${receipt.mergeCommitSha}^1`]), tip, "the merge's first parent is the target's old tip");
  assert.equal(rawGit(root, ["log", "-1", "--format=%s"]), `merge: workspace ${record.workspaceId} (worker)`);
  assert.equal(readFileSync(join(root, "src/feature/new.ts"), "utf8"), "export const x = 1;\n");
  assert.equal(rawGit(root, ["status", "--porcelain"]), "", "the landing checkout is clean at the merge");
  assert.ok(!existsSync(record.lease.worktreePath), "worktree is torn down");
  assert.equal(rawGit(root, ["branch", "--list", "agent/*"]), "", "agent branch is deleted");
  assert.ok(commands.calls.every((call) => call.cwd === record.lease.worktreePath), "every gate ran in the workspace, never in the canonical checkout");
  assert.deepEqual(commands.calls.map((call) => call.name), ["unit", "regen", "suite"]);

  const final = manager.status(record.workspaceId);
  assert.equal(final.state, "merged");
  assert.equal(final.mergeReceipt?.receiptHash, receipt.receiptHash);
});

test("dirty canonical landing: a disjoint workspace lands while every dirty, staged, intent-to-add and untracked entry survives", async () => {
  const { root } = initTempRepo("ws-dirty");
  const workspaceRoot = mkWorkspaceTempDir("ws-dirty-wt");
  commitFile(root, "a.txt", "a\n");
  commitFile(root, "gone.txt", "gone\n");
  // The canonical checkout's inherited state: an unstaged edit, a staged add,
  // an intent-to-add entry, an untracked file and an unstaged deletion.
  writeFileSync(join(root, "a.txt"), "a dirty\n");
  writeFile(root, "staged.txt", "staged\n");
  rawGit(root, ["add", "staged.txt"]);
  writeFile(root, "intent.txt", "intent\n");
  rawGit(root, ["add", "-N", "intent.txt"]);
  writeFile(root, "untracked.txt", "untracked\n");
  rawGit(root, ["rm", "-q", "--cached", "--", "gone.txt"]);
  const before = checkoutState(root);
  const dirtyBytes = ["a.txt", "staged.txt", "intent.txt", "untracked.txt"].map((path) => sha256(readFileSync(join(root, path))));

  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/b.ts", "export const b = 1;\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  const receipt = await manager.merge(record.workspaceId);

  const after = checkoutState(root);
  assert.equal(after.head, receipt.mergeCommitSha);
  assert.equal(rawGit(root, ["rev-parse", `${after.head}^1`]), before.head, "first parent is the old tip");
  assert.equal(after.staged, `${before.staged}`, "the staged entries are exactly as they were (the fast-forward adds no staged change)");
  assert.equal(after.status.split("\n").filter((line) => !line.includes("src/b.ts")).join("\n"), before.status, "every dirty entry is unchanged");
  assert.deepEqual(["a.txt", "staged.txt", "intent.txt", "untracked.txt"].map((path) => sha256(readFileSync(join(root, path)))), dirtyBytes);
  assert.equal(readFileSync(join(root, "src/b.ts"), "utf8"), "export const b = 1;\n");
});

test("overlap refusal: a workspace touching a path the canonical checkout has dirty is refused by git, and nothing moves", async () => {
  const { root } = initTempRepo("ws-overlap");
  const workspaceRoot = mkWorkspaceTempDir("ws-overlap-wt");
  commitFile(root, "shared/file.txt", "one\n");
  writeFileSync(join(root, "shared/file.txt"), "one, edited in the canonical checkout\n");
  const before = checkoutState(root);

  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["shared"] });
  commitFile(record.lease.worktreePath, "shared/file.txt", "two\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  await assert.rejects(() => manager.merge(record.workspaceId), throwsCode("workspace_land_refused"));

  assert.deepEqual(checkoutState(root), before, "HEAD, index and status are untouched");
  assert.equal(readFileSync(join(root, "shared/file.txt"), "utf8"), "one, edited in the canonical checkout\n");
  const current = manager.status(record.workspaceId);
  assert.equal(current.state, "validating", "git refused the land itself: the validation still holds");
  assert.equal(current.validationReport?.status, "pass");
  assert.equal(rawGit(record.lease.worktreePath, ["symbolic-ref", "--short", "HEAD"]), record.lease.branch, "the worktree is back on its branch");

  // Once the overlap is gone, the merge runs again WITHOUT a re-validation.
  rawGit(root, ["checkout", "--", "shared/file.txt"]);
  const receipt = await manager.merge(record.workspaceId);
  assert.equal(readFileSync(join(root, "shared/file.txt"), "utf8"), "two\n");
  assert.equal(receipt.landing, "fast-forward");
});

test("target moved during the gates: the fast-forward is refused and nothing partial lands", async () => {
  const { root } = initTempRepo("ws-moved");
  const workspaceRoot = mkWorkspaceTempDir("ws-moved-wt");
  const commands = makeFakeCommands({
    suite: () => {
      commitFile(root, "elsewhere.txt", "a commit made while the merge gates ran\n");
      return passGate("suite");
    },
  });
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot), commands });
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/b.ts", "export const b = 1;\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  await assert.rejects(() => manager.merge(record.workspaceId), throwsCode("workspace_land_refused"));
  assert.ok(!existsSync(join(root, "src/b.ts")), "the workspace's change did not land");
  assert.equal(rawGit(root, ["log", "-1", "--format=%s"]), "update elsewhere.txt");
  assert.equal(manager.status(record.workspaceId).state, "validating", "a lost race for the target keeps the validation; the next merge rebuilds and gates M");
});

test("target not checked out anywhere: the land is a compare-and-swap of the ref, refused when the target moved", async () => {
  const { root } = initTempRepo("ws-cas");
  const workspaceRoot = mkWorkspaceTempDir("ws-cas-wt");
  rawGit(root, ["branch", "side"]);
  trackBranch(root, "side");
  const sideTip = rawGit(root, ["rev-parse", "side"]);
  const headBefore = rawGit(root, ["rev-parse", "HEAD"]);
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });

  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"], target: "side" });
  assert.equal(record.lease.targetBranch, "side");
  commitFile(record.lease.worktreePath, "src/b.ts", "export const b = 1;\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  const receipt = await manager.merge(record.workspaceId);
  assert.equal(receipt.landing, "update-ref");
  assert.equal(receipt.landedIn, null);
  assert.equal(rawGit(root, ["rev-parse", "side"]), receipt.mergeCommitSha);
  assert.equal(rawGit(root, ["rev-parse", `${receipt.mergeCommitSha}^1`]), sideTip);
  assert.equal(rawGit(root, ["rev-parse", "HEAD"]), headBefore, "the checkout on main is untouched");

  // CAS: the target moves while the merge gates run.
  const commands = makeFakeCommands({
    suite: () => {
      rawGit(root, ["branch", "-f", "side", headBefore]);
      return passGate("suite");
    },
  });
  const moving = makeManager(root, { config: makeTestConfig(workspaceRoot), commands }).manager;
  const second = await moving.create({ agentName: "worker", mode: "feature", writeSet: ["src"], target: "side" });
  commitFile(second.lease.worktreePath, "src/c.ts", "export const c = 1;\n");
  assert.equal((await moving.validate(second.workspaceId)).status, "pass");
  await assert.rejects(() => moving.merge(second.workspaceId), throwsCode("workspace_land_refused"));
  assert.equal(rawGit(root, ["rev-parse", "side"]), headBefore, "the ref is where the other writer put it");
});

test("a failing merge gate leaves every checkout byte-identical and adds no commit", async () => {
  const { root } = initTempRepo("ws-gatefail");
  const workspaceRoot = mkWorkspaceTempDir("ws-gatefail-wt");
  const commands = makeFakeCommands({ suite: () => failGate("suite", "1 test failed") });
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot), commands });
  const before = checkoutState(root);
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/m.ts", "export const m = 1;\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  await assert.rejects(() => manager.merge(record.workspaceId), (error: unknown) =>
    error instanceof WorkspaceGateFailedError && error.gateResults.some((gate) => gate.gate === "suite" && gate.status === "fail"));
  assert.deepEqual(checkoutState(root), before);
  assert.equal(rawGit(root, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(manager.status(record.workspaceId).state, "active", "nothing landed: the agent fixes and re-validates");
  assert.equal(rawGit(record.lease.worktreePath, ["symbolic-ref", "--short", "HEAD"]), record.lease.branch);
});

test("the regenerate phase: a declared generated output lands in the merge commit; an undeclared write is refused", async () => {
  const { root } = initTempRepo("ws-regen");
  const workspaceRoot = mkWorkspaceTempDir("ws-regen-wt");
  commitFile(root, WHOLESALE, "export const MANIFEST = [];\n");
  const declared = makeFakeCommands({
    regen: (cwd) => {
      writeFileSync(join(cwd, WHOLESALE), "export const MANIFEST = [\"regenerated\"];\n");
      return passGate("regen");
    },
  });
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot), commands: declared });
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/r.ts", "export const r = 1;\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  const receipt = await manager.merge(record.workspaceId);
  assert.deepEqual(receipt.regeneratedPaths, [WHOLESALE]);
  assert.equal(rawGit(root, ["show", `${receipt.mergeCommitSha}:${WHOLESALE}`]), "export const MANIFEST = [\"regenerated\"];");

  const undeclared = makeFakeCommands({
    regen: (cwd) => {
      writeFileSync(join(cwd, "README.md"), "# rewritten by a generator nobody declared\n");
      return passGate("regen");
    },
  });
  const second = makeManager(root, { config: makeTestConfig(workspaceRoot), commands: undeclared }).manager;
  const other = await second.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(other.lease.worktreePath, "src/s.ts", "export const s = 1;\n");
  assert.equal((await second.validate(other.workspaceId)).status, "pass");
  const headBefore = rawGit(root, ["rev-parse", "HEAD"]);
  await assert.rejects(() => second.merge(other.workspaceId), throwsCode("workspace_regenerate_undeclared_write"));
  assert.equal(rawGit(root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(rawGit(other.lease.worktreePath, ["status", "--porcelain"]), "", "the aborted merge left the worktree as it was");
});

test("not converged: a merge gate that rewrites a tracked file refuses the land and names it", async () => {
  const { root } = initTempRepo("ws-converge");
  const workspaceRoot = mkWorkspaceTempDir("ws-converge-wt");
  const commands = makeFakeCommands({
    suite: (cwd) => {
      writeFileSync(join(cwd, "README.md"), "# a suite that rewrote a tracked file\n");
      return passGate("suite");
    },
  });
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot), commands });
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/c.ts", "export const c = 1;\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  const headBefore = rawGit(root, ["rev-parse", "HEAD"]);
  await assert.rejects(() => manager.merge(record.workspaceId), (error: unknown) =>
    throwsCode("workspace_gates_not_converged")(error) && String((error as Error).message).includes("README.md"));
  assert.equal(rawGit(root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(manager.status(record.workspaceId).state, "active");
});

test("generated-output conflicts: a pin-only change and a wholly generated file resolve to the target; an authored change is reported", async () => {
  const { root } = initTempRepo("ws-pins");
  const workspaceRoot = mkWorkspaceTempDir("ws-pins-wt");
  commitFile(root, PIN_BEARING, pinned(PIN_A, "base"));
  commitFile(root, WHOLESALE, "export const MANIFEST = [\"base\"];\n");
  const base = rawGit(root, ["rev-parse", "HEAD"]);
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });

  // The workspace changes a source and, as its commit regenerated them, the pin and the manifest.
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/x.ts", "export const x = 1;\n");
  commitFile(record.lease.worktreePath, PIN_BEARING, pinned(PIN_B, "base"));
  commitFile(record.lease.worktreePath, WHOLESALE, "export const MANIFEST = [\"base\", \"x\"];\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  // Meanwhile the target changed the same generated outputs (another land).
  commitFile(root, PIN_BEARING, pinned(PIN_C, "target edit"));
  commitFile(root, WHOLESALE, "export const MANIFEST = [\"base\", \"y\"];\n");
  const receipt = await manager.merge(record.workspaceId);
  assert.deepEqual([...receipt.resolvedConflicts].toSorted(), [PIN_BEARING, WHOLESALE].toSorted());
  assert.equal(rawGit(root, ["show", `${receipt.mergeCommitSha}:${PIN_BEARING}`]), pinned(PIN_C, "target edit").trimEnd(), "resolved to the target's side (the regenerate phase re-derives it)");
  assert.equal(readFileSync(join(root, "src/x.ts"), "utf8"), "export const x = 1;\n");

  // An AUTHORED change to the pin-bearing file (not only its pin) is a source
  // edit: it must be leased, and the target's authored edit of the same file
  // since the base is a merged-since conflict.
  const authored = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"], base });
  commitFile(authored.lease.worktreePath, PIN_BEARING, pinned(PIN_B, "branch edit"));
  commitFile(authored.lease.worktreePath, "src/y.ts", "export const y = 1;\n");
  const unleased = await manager.validate(authored.workspaceId);
  assert.equal(unleased.status, "fail");
  assert.deepEqual(unleased.gates.find((gate) => gate.gate === "write-set-proof")?.details, [`unleased: ${PIN_BEARING}`]);
  await manager.extend(authored.workspaceId, [PIN_BEARING]);
  assert.equal((await manager.validate(authored.workspaceId)).status, "pass");
  const headBefore = rawGit(root, ["rev-parse", "HEAD"]);
  await assert.rejects(() => manager.merge(authored.workspaceId), (error: unknown) =>
    error instanceof WorkspaceConflictError && error.report.kind === "dynamic-overlap" && error.report.conflicts.some((entry) => entry.path === PIN_BEARING));
  assert.equal(rawGit(root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(rawGit(authored.lease.worktreePath, ["status", "--porcelain"]), "", "nothing was merged in the worktree");
});

test("the lease exempts a regeneration, never a path: an authored edit of a pin-bearing file or a README's prose needs a lease, a pin or consumer-block change does not, and another workspace's lease on it holds", async () => {
  const { root } = initTempRepo("ws-genonly");
  const workspaceRoot = mkWorkspaceTempDir("ws-genonly-wt");
  const readme = (prose: string, block: string): string => `# Module\n\n${prose}\n\n${README_CONSUMER_BLOCK.begin}\n${block}\n${README_CONSUMER_BLOCK.end}\n`;
  commitFile(root, PIN_BEARING, pinned(PIN_A, "base"));
  commitFile(root, "src/mod/README.md", readme("Hand-written prose.", "- consumer a"));
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });

  // Regeneration only: the pin and the consumer block change with a leased source edit.
  const regenerating = await manager.create({ agentName: "regen", mode: "feature", writeSet: ["src/mod/a.ts"] });
  commitFile(regenerating.lease.worktreePath, "src/mod/a.ts", "export const a = 1;\n");
  commitFile(regenerating.lease.worktreePath, PIN_BEARING, pinned(PIN_B, "base"));
  commitFile(regenerating.lease.worktreePath, "src/mod/README.md", readme("Hand-written prose.", "- consumer a\n- consumer b"));
  assert.equal((await manager.validate(regenerating.workspaceId)).status, "pass", "a pin and a generated block re-derived need no lease");

  // Authored edits of the same files are source edits.
  const authoring = await manager.create({ agentName: "author", mode: "feature", writeSet: ["src/mod/b.ts"] });
  commitFile(authoring.lease.worktreePath, PIN_BEARING, pinned(PIN_A, "policy text edited by hand"));
  commitFile(authoring.lease.worktreePath, "src/mod/README.md", readme("Prose edited by hand.", "- consumer a"));
  const proof = (await manager.validate(authoring.workspaceId)).gates.find((gate) => gate.gate === "write-set-proof")!;
  assert.equal(proof.status, "fail");
  assert.deepEqual(proof.details, [`unleased: ${PIN_BEARING}`, "unleased: src/mod/README.md"]);

  // A workspace that LEASES the pin-bearing file blocks another's authored
  // edit of it (admission), and the merge's pending-lease check judges the
  // authored set: a pin-only change never conflicts with that lease.
  await manager.abort(authoring.workspaceId);
  const owner = await manager.create({ agentName: "owner", mode: "feature", writeSet: [PIN_BEARING] });
  await assert.rejects(() => manager.create({ agentName: "intruder", mode: "feature", writeSet: [PIN_BEARING] }), (error: unknown) =>
    error instanceof WorkspaceConflictError && error.report.kind === "static-overlap");
  const receipt = await manager.merge(regenerating.workspaceId);
  assert.ok(receipt.changedPaths.includes(PIN_BEARING), "the regenerated pin landed beside the owner's lease");
  assert.equal(manager.status(owner.workspaceId).state, "active");
});

test("a base outside the target's history is refused at create, and a branch that merges another branch in must lease what that brings (P9)", async () => {
  const { root } = initTempRepo("ws-base");
  const workspaceRoot = mkWorkspaceTempDir("ws-base-wt");
  rawGit(root, ["checkout", "-q", "-b", "other"]);
  commitFile(root, "secret/config.txt", "from another branch\n");
  const otherTip = rawGit(root, ["rev-parse", "HEAD"]);
  rawGit(root, ["checkout", "-q", "main"]);
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });
  const owner = await manager.create({ agentName: "owner", mode: "feature", writeSet: ["secret"] });
  await assert.rejects(() => manager.create({ agentName: "sneak", mode: "feature", writeSet: ["docs"], base: "other" }), throwsCode("workspace_base_not_on_target"));
  assert.equal(manager.list().filter((record) => record.agentName === "sneak").length, 0, "nothing was reserved");

  // The same delta brought in by the branch's own history is in the changed set.
  const sneak = await manager.create({ agentName: "sneak", mode: "feature", writeSet: ["docs"] });
  rawGit(sneak.lease.worktreePath, ["merge", "-q", "--no-edit", otherTip]);
  commitFile(sneak.lease.worktreePath, "docs/a.md", "docs\n");
  const report = await manager.validate(sneak.workspaceId);
  assert.equal(report.status, "fail");
  assert.deepEqual(report.changedPaths, ["docs/a.md", "secret/config.txt"]);
  assert.deepEqual(report.gates.find((gate) => gate.gate === "write-set-proof")?.details, ["unleased: secret/config.txt"]);
  assert.equal(existsSync(join(root, "secret/config.txt")), false);
  assert.equal(manager.status(owner.workspaceId).state, "active");
});

test("the changed set is what the merge brings: after a rebase onto the moved target, the target's own changes are not the branch's", async () => {
  const { root } = initTempRepo("ws-forkpoint");
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir("ws-forkpoint-wt")) });
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/f.ts", "export const f = 1;\n");
  commitFile(root, "docs/landed-meanwhile.md", "another workspace's land\n");
  rawGit(record.lease.worktreePath, ["rebase", "-q", "main"]);
  const report = await manager.validate(record.workspaceId);
  assert.deepEqual(report.changedPaths, ["src/f.ts"]);
  assert.equal(report.status, "pass");
});

test("land targets name the forge's trunk, never a local branch: any local branch whose upstream is origin/main lands; an upstream trunk not declared (a product branch), no upstream, or a remote the forge does not know is refused — named or inherited from the invoking checkout", async () => {
  const { root } = initTempRepo("ws-landtarget");
  const workspaceRoot = mkWorkspaceTempDir("ws-landtarget-wt");
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });
  // Any local name: what lands is its upstream, the trunk main.
  rawGit(root, ["branch", "--track", "my-local-name", "origin/main"]);
  const anyName = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src/any"], target: "my-local-name" });
  assert.deepEqual([forgeStateOf(anyName).remote, forgeStateOf(anyName).trunk], ["origin", "main"]);
  await manager.abort(anyName.workspaceId);
  // A local branch NAMED main whose upstream is the product trunk is not main.
  rawGit(root, ["branch", "product"]);
  trackBranch(root, "product");
  rawGit(root, ["branch", "--track", "main-lookalike", "origin/product"]);
  await assert.rejects(() => manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"], target: "main-lookalike" }), throwsCode("workspace_target_not_landable"));
  await assert.rejects(() => manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"], target: "product" }), throwsCode("workspace_target_not_landable"));
  rawGit(root, ["branch", "untracked"]);
  await assert.rejects(() => manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"], target: "untracked" }), throwsCode("workspace_target_untracked"));
  // A remote the forge does not know (the composition root's factory refuses it): refused at create, before anything is made.
  rawGit(root, ["remote", "add", "elsewhere", mkWorkspaceTempDir("ws-landtarget-elsewhere")]);
  rawGit(root, ["branch", "foreign"]);
  rawGit(root, ["config", "branch.foreign.remote", "elsewhere"]);
  // Another host's branch (the retired Gitea `testing`): the remote is refused before its trunk is judged.
  rawGit(root, ["config", "branch.foreign.merge", "refs/heads/testing-on-another-host"]);
  const knowsOrigin = makeManager(root, { config: makeTestConfig(workspaceRoot), forge: (target) => {
    if (target.remote !== "origin") throw new HarnessError(`the remote ${target.remote} is not the forge's trunk repository`, "workspace_forge_remote_unknown");
    return fakeForgeFactory(target);
  } }).manager;
  await assert.rejects(() => knowsOrigin.create({ agentName: "worker", mode: "feature", writeSet: ["src"], target: "foreign" }), throwsCode("workspace_forge_remote_unknown"));
  // Inherited from the invoking checkout: a checkout of the product branch.
  const linked = join(mkWorkspaceTempDir("ws-landtarget-linked"), "product");
  rawGit(root, ["worktree", "add", "-q", linked, "product"]);
  const fromProduct = makeManager(linked, { config: makeTestConfig(workspaceRoot) }).manager;
  await assert.rejects(() => fromProduct.create({ agentName: "worker", mode: "feature", writeSet: ["src"] }), throwsCode("workspace_target_not_landable"));
  writeFile(linked, "dirty.txt", "dirty\n");
  await assert.rejects(() => fromProduct.create({ agentName: "worker", mode: "overlay", writeSet: [] }), throwsCode("workspace_target_not_landable"));
  assert.deepEqual(manager.list().filter((record) => record.state !== "aborted"), [], "nothing was reserved, snapshotted or made");
  assert.equal(rawGit(root, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).length, 2);
  // A target removed from the declaration after create is refused at merge and at land.
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/x.ts", "export const x = 1;\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  const narrowed = makeManager(root, { config: makeTestConfig(workspaceRoot, { landTargets: ["side"] }) }).manager;
  await assert.rejects(() => narrowed.merge(record.workspaceId), throwsCode("workspace_target_not_landable"));
  await assert.rejects(() => narrowed.land(record.workspaceId), throwsCode("workspace_target_not_landable"));
  assert.equal(manager.status(record.workspaceId).state, "validating");
});

test("an integrator that died mid-merge is recovered: before the land the worktree returns to its branch (active); after it the teardown finishes (merged); a running integrator is never interrupted", async () => {
  const { root } = initTempRepo("ws-recover");
  const workspaceRoot = mkWorkspaceTempDir("ws-recover-wt");
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });
  const store = createWorkspaceRecordStore(workspaceRecordStores(registryOf(root)));
  const dieMidMerge = async (name: string, landed: boolean): Promise<WorkspaceRecord> => {
    const record = await manager.create({ agentName: name, mode: "feature", writeSet: [`src/${name}`] });
    commitFile(record.lease.worktreePath, `src/${name}/f.ts`, "export const f = 1;\n");
    assert.equal((await manager.validate(record.workspaceId)).status, "pass");
    // What a killed integrator leaves: the record `merging`, the worktree
    // detached at the target with a merge in progress (or, after the land,
    // the target holding the merge).
    const tip = rawGit(root, ["rev-parse", "main"]);
    rawGit(record.lease.worktreePath, ["checkout", "-q", "--detach", tip]);
    rawGit(record.lease.worktreePath, ["merge", "-q", "--no-ff", "--no-commit", record.lease.branch!]);
    if (landed) {
      rawGit(record.lease.worktreePath, ["commit", "-q", "-m", "merge"]);
      rawGit(root, ["merge", "-q", "--ff-only", rawGit(record.lease.worktreePath, ["rev-parse", "HEAD"])]);
    }
    const current = store.load(record.workspaceId)!;
    store.save({ ...current, state: "merging", history: [...current.history, { from: current.state, to: "merging", at: new Date().toISOString(), reason: "the integrator took the merge lock" }] });
    await assert.rejects(() => manager.abort(record.workspaceId), throwsCode("workspace_abort_denied"));
    return record;
  };

  const before = await dieMidMerge("before", false);
  // While an integrator holds the merge lock, nothing recovers.
  const lockDirectory = join(registryRoot(root), "locks");
  const held = await acquireLock(registryRoot(root), "workspace-merge", { lockDirectory, owner: "a live integrator" });
  await assert.rejects(() => manager.recover(before.workspaceId), throwsCode("workspace_recover_denied"));
  assert.deepEqual((await manager.sweep()).swept, [], "the sweep leaves a running integrator's workspace to it");
  held.release();
  const recovered = await manager.recover(before.workspaceId);
  assert.equal(recovered.state, "active");
  assert.equal(rawGit(before.lease.worktreePath, ["symbolic-ref", "--short", "HEAD"]), before.lease.branch);
  assert.equal(rawGit(before.lease.worktreePath, ["status", "--porcelain"]), "");
  assert.equal(existsSync(join(root, "src/before/f.ts")), false, "nothing landed");

  const after = await dieMidMerge("after", true);
  assert.deepEqual((await manager.sweep()).swept, [after.workspaceId], "the sweep recovers a dead integrator's workspace");
  const merged = manager.status(after.workspaceId);
  assert.equal(merged.state, "merged");
  assert.equal(existsSync(after.lease.worktreePath), false);
  assert.equal(rawGit(root, ["branch", "--list", after.lease.branch!]), "");
  assert.equal(readFileSync(join(root, "src/after/f.ts"), "utf8"), "export const f = 1;\n");
});

test("record writes are a compare-and-swap: a validate that read the record before an extend refuses to overwrite it", async () => {
  const { root } = initTempRepo("ws-cas-record");
  const store = createWorkspaceRecordStore(workspaceRecordStores(registryOf(root)));
  let extendDuringGates: (() => void) | null = null;
  const commands = makeFakeCommands({ unit: (cwd) => { extendDuringGates?.(); return passGate("unit", cwd); } });
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir("ws-cas-record-wt")), commands });
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/f.ts", "export const f = 1;\n");
  // Another command (another process) widens the lease while the gates run.
  extendDuringGates = () => {
    const current = store.load(record.workspaceId)!;
    store.save({ ...current, lease: { ...current.lease, writeSet: ["docs", "src"], generation: current.lease.generation + 1 } });
  };
  await assert.rejects(() => manager.validate(record.workspaceId), throwsCode("workspace_record_changed"));
  assert.deepEqual(manager.status(record.workspaceId).lease.writeSet, ["docs", "src"], "the extend survives");
  assert.throws(() => store.save(record), throwsCode("workspace_record_changed"), "a stale revision is never written");
  assert.throws(() => manager.status("../workspaces/x"), throwsCode("workspace_id_invalid"), "an id never names a path outside the registry");
});

test("the land refuses a dirty overlap even when the repository sets merge.autostash: nothing moves and nothing is stashed", async () => {
  const { root } = initTempRepo("ws-autostash");
  commitFile(root, "src/a.txt", "one\n");
  rawGit(root, ["config", "merge.autostash", "true"]);
  writeFileSync(join(root, "src/a.txt"), "one, dirty in the canonical checkout\n");
  const before = checkoutState(root);
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir("ws-autostash-wt")) });
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/a.txt", "two\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  await assert.rejects(() => manager.merge(record.workspaceId), throwsCode("workspace_land_refused"));
  assert.deepEqual(checkoutState(root), before);
  assert.equal(readFileSync(join(root, "src/a.txt"), "utf8"), "one, dirty in the canonical checkout\n");
  assert.equal(rawGit(root, ["stash", "list"]), "", "no autostash entry");
});

test("the merge's own checks: a pending lease on a changed path (a record admitted elsewhere) and a base past the staleness budget are refused", async () => {
  const { root } = initTempRepo("ws-merge-checks");
  const workspaceRoot = mkWorkspaceTempDir("ws-merge-checks-wt");
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot, { baseStalenessCommits: 1 }) });
  const store = createWorkspaceRecordStore(workspaceRecordStores(registryOf(root)));
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/f.ts", "export const f = 1;\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  // A pending lease admission never let in (another tool's record, an older revision).
  const intruder = await manager.create({ agentName: "other", mode: "feature", writeSet: ["docs"] });
  const stored = store.load(intruder.workspaceId)!;
  store.save({ ...stored, lease: { ...stored.lease, writeSet: ["src/f.ts"] } });
  await assert.rejects(() => manager.merge(record.workspaceId), (error: unknown) =>
    error instanceof WorkspaceConflictError && error.report.conflicts.some((entry) => entry.otherWorkspaceId === intruder.workspaceId));
  await manager.abort(intruder.workspaceId);
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  commitFile(root, "elsewhere/1.txt", "1\n");
  commitFile(root, "elsewhere/2.txt", "2\n");
  await assert.rejects(() => manager.merge(record.workspaceId), (error: unknown) =>
    error instanceof WorkspaceConflictError && error.report.conflicts.some((entry) => entry.path === "(base)"));
  assert.equal(manager.status(record.workspaceId).state, "active");
});



test("a merge whose tree validate --full already qualified does not run the merge gates twice", async () => {
  const { root } = initTempRepo("ws-full");
  const workspaceRoot = mkWorkspaceTempDir("ws-full-wt");
  const commands = makeFakeCommands();
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot), commands });
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/f.ts", "export const f = 1;\n");
  const report = await manager.validate(record.workspaceId, { full: true });
  assert.equal(report.status, "pass");
  assert.equal(report.full, true);
  assert.deepEqual(report.gates.map((gate) => gate.gate), ["write-set-proof", "unit", "regen", "converged", "suite"]);
  const receipt = await manager.merge(record.workspaceId);
  assert.deepEqual(commands.calls.map((call) => call.name), ["unit", "regen", "suite", "regen"], "the merge re-ran regenerate but not the qualified merge gates");
  assert.ok(receipt.gateResults.some((gate) => gate.gate === "merge-gates" && gate.status === "skip"));
});

test("validate --full refuses a branch whose commits the regenerate phase would still change", async () => {
  const { root } = initTempRepo("ws-fullconv");
  const workspaceRoot = mkWorkspaceTempDir("ws-fullconv-wt");
  const commands = makeFakeCommands({
    regen: (cwd) => {
      writeFile(cwd, WHOLESALE, "export const MANIFEST = [\"stale in the branch\"];\n");
      return passGate("regen");
    },
  });
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot), commands });
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/f.ts", "export const f = 1;\n");
  const report = await manager.validate(record.workspaceId, { full: true });
  assert.equal(report.status, "fail");
  const converged = report.gates.find((gate) => gate.gate === "converged");
  assert.equal(converged?.status, "fail");
  assert.deepEqual(converged?.details, [WHOLESALE]);
  assert.equal(report.gates.some((gate) => gate.gate === "suite"), false, "fail-fast: the merge gates did not run");
});

test("a failing validate gate stops the phase: the gates after it are skipped", async () => {
  const { root } = initTempRepo("ws-failfast");
  const workspaceRoot = mkWorkspaceTempDir("ws-failfast-wt");
  const config = makeTestConfig(workspaceRoot, {
    commands: { lint: { cwd: ".", argv: ["true"], timeoutMs: 1_000 }, unit: { cwd: ".", argv: ["true"], timeoutMs: 1_000 } },
    phases: { setup: [], validate: ["lint", "unit"], regenerate: [], merge: [] },
  });
  const commands = makeFakeCommands({ lint: () => failGate("lint") });
  const { manager } = makeManager(root, { config, commands });
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/f.ts", "export const f = 1;\n");
  const report = await manager.validate(record.workspaceId);
  assert.equal(report.status, "fail");
  assert.deepEqual(report.gates.map((gate) => `${gate.gate}:${gate.status}`), ["write-set-proof:pass", "lint:fail", "unit:skip"]);
  assert.deepEqual(commands.calls.map((call) => call.name), ["lint"]);
  assert.equal(manager.status(record.workspaceId).state, "active");
});

test("static conflict: overlapping write sets reject the second admission", async () => {
  const { root } = initTempRepo("ws-static");
  const workspaceRoot = mkWorkspaceTempDir("ws-static-wt");
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });
  await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/shared"] });
  await assert.rejects(() => manager.create({ agentName: "agentB", mode: "feature", writeSet: ["src/shared/inner"] }), (error: unknown) =>
    error instanceof WorkspaceConflictError && error.report.kind === "static-overlap" && error.report.conflicts[0]!.path === "src/shared");
});

test("an expired lease holds nothing: an overlapping successor is admitted and merges, and the expired workspace is left as it was", async () => {
  const { root } = initTempRepo("ws-expired");
  const workspaceRoot = mkWorkspaceTempDir("ws-expired-wt");
  const config = makeTestConfig(workspaceRoot);
  const { manager } = makeManager(root, { config });
  const expired = await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/shared"] });
  await assert.rejects(() => manager.create({ agentName: "agentB", mode: "feature", writeSet: ["src/shared/inner"] }), (error: unknown) =>
    error instanceof WorkspaceConflictError && error.report.kind === "static-overlap", "a live lease still blocks");
  const later = makeManager(root, { config, now: () => new Date(Date.now() + 2 * config.leaseTtlMs) }).manager;
  configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { enabledSinks: ["collecting"] } }, [createCollectingSink()]);
  let successor: WorkspaceRecord;
  try {
    successor = await later.create({ agentName: "agentB", mode: "feature", writeSet: ["src/shared/inner"] });
    const admitted = getAuditEvents().filter((event) => event.category === "workspace-admitted-over-expired").map((event) => event.context);
    assert.equal(admitted.length, 1, "admission over an expired lease is an audit event");
    assert.equal(admitted[0]!["expiredWorkspaceId"], expired.workspaceId);
    assert.equal(admitted[0]!["workspaceId"], successor.workspaceId);
    assert.deepEqual(admitted[0]!["paths"], ["src/shared"]);
  } finally {
    resetDebugSystem();
  }
  commitFile(successor.lease.worktreePath, "src/shared/inner/x.ts", "export const x = 1;\n");
  assert.equal((await later.validate(successor.workspaceId)).status, "pass");
  assert.equal((await later.merge(successor.workspaceId)).changedPaths[0], "src/shared/inner/x.ts", "the merge's pending-lease check skips the expired lease too");
  const untouched = later.status(expired.workspaceId);
  assert.equal(untouched.state, "active", "admission never ends the expired workspace: only its own verbs or a sweep do");
  assert.ok(existsSync(expired.lease.worktreePath), "its worktree is kept");
  assert.notEqual(rawGit(root, ["branch", "--list", expired.lease.branch!]), "", "its branch is kept");
});

test("a MERGING workspace keeps its paths past its lease's expiry: its integrator owns them until the land (correctness N2)", async () => {
  const { root } = initTempRepo("ws-merging-expired");
  const workspaceRoot = mkWorkspaceTempDir("ws-merging-expired-wt");
  const config = makeTestConfig(workspaceRoot);
  const { manager } = makeManager(root, { config });
  const store = createWorkspaceRecordStore(workspaceRecordStores(registryOf(root)));
  const merging = await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/shared"] });
  commitFile(merging.lease.worktreePath, "src/shared/x.ts", "export const x = 1;\n");
  assert.equal((await manager.validate(merging.workspaceId)).status, "pass");
  const current = store.load(merging.workspaceId)!;
  store.save({ ...current, state: "merging", history: [...current.history, { from: current.state, to: "merging", at: new Date().toISOString(), reason: "the integrator took the merge lock" }] });
  const later = makeManager(root, { config, now: () => new Date(Date.now() + 2 * config.leaseTtlMs) }).manager;
  await assert.rejects(() => later.create({ agentName: "agentB", mode: "feature", writeSet: ["src/shared/inner"] }), (error: unknown) =>
    error instanceof WorkspaceConflictError && error.report.kind === "static-overlap", "an expired but MERGING lease still holds its paths");
  assert.equal(later.status(merging.workspaceId).state, "merging", "and nothing ended it");
});

test("extend never revives an expired lease: it ends it like every other verb (correctness N4)", async () => {
  const { root } = initTempRepo("ws-extend-expired");
  const workspaceRoot = mkWorkspaceTempDir("ws-extend-expired-wt");
  const config = makeTestConfig(workspaceRoot);
  const { manager } = makeManager(root, { config });
  const expired = await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/shared"] });
  const live = await manager.extend(expired.workspaceId, ["src/more"]);
  assert.deepEqual(live.lease.writeSet, ["src/more", "src/shared"], "a live lease is widened and renewed");
  const later = makeManager(root, { config, now: () => new Date(Date.now() + 2 * config.leaseTtlMs) }).manager;
  await assert.rejects(() => later.extend(expired.workspaceId, ["src/other"]), (error: unknown) => error instanceof WorkspaceLeaseExpiredError);
  const ended = later.status(expired.workspaceId);
  assert.ok(ended.state === "aborted" || ended.state === "quarantined", `the expired workspace is ended, not renewed (${ended.state})`);
  assert.deepEqual(ended.lease.writeSet, ["src/more", "src/shared"], "and its lease never took the new paths");
});

test("never-leasable: a wholly generated output or a state path cannot enter a write set; a pin-bearing source can", async () => {
  const { root } = initTempRepo("ws-neverlease");
  const workspaceRoot = mkWorkspaceTempDir("ws-neverlease-wt");
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });
  await assert.rejects(() => manager.create({ agentName: "agentA", mode: "feature", writeSet: [WHOLESALE] }), throwsCode("workspace_write_set_never_leasable"));
  await assert.rejects(() => manager.create({ agentName: "agentA", mode: "feature", writeSet: ["engine/src"] }), throwsCode("workspace_write_set_never_leasable"), "a directory covering a generated output is refused too");
  await assert.rejects(() => manager.create({ agentName: "agentA", mode: "feature", writeSet: ["engine/.bridlewise/state"] }), throwsCode("workspace_write_set_never_leasable"));
  const record = await manager.create({ agentName: "agentA", mode: "feature", writeSet: [PIN_BEARING] });
  assert.deepEqual(record.lease.writeSet, [PIN_BEARING]);
});

test("dynamic conflict: a path merged to the target since the base must be rebased and re-validated", async () => {
  const { root } = initTempRepo("ws-dynamic");
  const workspaceRoot = mkWorkspaceTempDir("ws-dynamic-wt");
  const baseSha = commitFile(root, "src/x/file.txt", "one\ntwo\nthree\n");
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });
  const first = await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/x"], base: baseSha });
  commitFile(first.lease.worktreePath, "src/x/file.txt", "ONE\ntwo\nthree\n");
  assert.equal((await manager.validate(first.workspaceId)).status, "pass");
  await manager.merge(first.workspaceId);

  // B pins its base BEFORE A's merge; A is terminal so admission is legal.
  const second = await manager.create({ agentName: "agentB", mode: "feature", writeSet: ["src/x"], base: baseSha });
  commitFile(second.lease.worktreePath, "src/x/file.txt", "one\ntwo\nTHREE\n");
  assert.equal((await manager.validate(second.workspaceId)).status, "pass");
  await assert.rejects(() => manager.merge(second.workspaceId), (error: unknown) =>
    error instanceof WorkspaceConflictError && error.report.kind === "dynamic-overlap" && error.report.conflicts.some((entry) => entry.path === "src/x/file.txt"));
  assert.equal(manager.status(second.workspaceId).state, "active");

  // The repair path: rebase onto the target (disjoint hunks), re-validate, land.
  rawGit(second.lease.worktreePath, ["rebase", "main"]);
  assert.equal((await manager.validate(second.workspaceId)).status, "pass");
  await manager.merge(second.workspaceId);
  assert.equal(readFileSync(join(root, "src/x/file.txt"), "utf8"), "ONE\ntwo\nTHREE\n");
});

test("textual conflict: a file/directory conflict with the target is reported and the target is untouched", async () => {
  const { root, baseSha } = initTempRepo("ws-textual");
  const workspaceRoot = mkWorkspaceTempDir("ws-textual-wt");
  commitFile(root, "blk", "a file named blk\n");
  const canonicalHead = rawGit(root, ["rev-parse", "HEAD"]);
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot, { baseStalenessCommits: 50 }) });
  const record = await manager.create({ agentName: "agentB", mode: "feature", writeSet: ["blk"], base: baseSha });
  commitFile(record.lease.worktreePath, "blk/inner.txt", "nested\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  await assert.rejects(() => manager.merge(record.workspaceId), (error: unknown) =>
    error instanceof WorkspaceConflictError && error.report.conflicts.length > 0);
  assert.equal(manager.status(record.workspaceId).state, "active");
  assert.equal(rawGit(root, ["rev-parse", "HEAD"]), canonicalHead);
});

test("out-of-lease write: validation fails with the unleased path; a generated output is exempt", async () => {
  const { root } = initTempRepo("ws-unleased");
  const workspaceRoot = mkWorkspaceTempDir("ws-unleased-wt");
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });
  const record = await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/ok"] });
  commitFile(record.lease.worktreePath, "src/ok/good.ts", "export const good = 1;\n");
  commitFile(record.lease.worktreePath, WHOLESALE, "export const MANIFEST = [];\n");
  commitFile(record.lease.worktreePath, "src/evil.ts", "export const evil = 1;\n");
  const report = await manager.validate(record.workspaceId);
  assert.equal(report.status, "fail");
  const proof = report.gates.find((gate) => gate.gate === "write-set-proof");
  assert.deepEqual(proof?.details, ["unleased: src/evil.ts"]);
  assert.equal(report.gates.some((gate) => gate.gate === "unit"), false, "fail-fast after the proof");
  assert.equal(manager.status(record.workspaceId).state, "active");
});

test("uncommitted work fails the write-set proof: the gates judge commits", async () => {
  const { root } = initTempRepo("ws-uncommitted");
  const workspaceRoot = mkWorkspaceTempDir("ws-uncommitted-wt");
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });
  const record = await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src"] });
  writeFile(record.lease.worktreePath, "src/wip.ts", "export const wip = 1;\n");
  const report = await manager.validate(record.workspaceId);
  assert.equal(report.status, "fail");
  assert.deepEqual(report.gates[0]!.details, ["uncommitted: src/wip.ts"]);
});

test("setup: links become symlinks to the source's entry, the config mode is 0600, and a failing setup command removes the worktree and branch", async () => {
  const { root } = initTempRepo("ws-setup");
  const workspaceRoot = mkWorkspaceTempDir("ws-setup-wt");
  commitFile(root, "engine/bridlewise.config.json", "{}\n");
  const corpus = mkWorkspaceTempDir("ws-setup-corpus");
  rawGit(root, ["config", "core.excludesFile", "/dev/null"]);
  writeFileSync(join(root, ".git", "info", "exclude"), "corpus\n");
  const { symlinkSync } = await import("node:fs");
  symlinkSync(corpus, join(root, "corpus"));
  const config = makeTestConfig(workspaceRoot, {
    links: ["corpus"],
    commands: { deps: { cwd: ".", argv: ["true"], timeoutMs: 1_000 } },
    phases: { setup: ["deps"], validate: [], regenerate: [], merge: [] },
  });
  const ok = makeManager(root, { config }).manager;
  const record = await ok.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  assert.ok(lstatSync(join(record.lease.worktreePath, "corpus")).isSymbolicLink());
  assert.equal(readlinkSync(join(record.lease.worktreePath, "corpus")), corpus);
  assert.equal(statSync(join(record.lease.worktreePath, "engine/bridlewise.config.json")).mode & 0o777, 0o600);

  const failing = makeManager(root, { config, commands: makeFakeCommands({ deps: () => failGate("deps", "npm ci failed") }) }).manager;
  await assert.rejects(() => failing.create({ agentName: "broken", mode: "feature", writeSet: ["docs"] }), (error: unknown) =>
    throwsCode("workspace_setup_failed")(error) && String((error as Error).message).includes("deps: npm ci failed"),
    "the refusal carries the failed gate's own words, not only its name");
  const broken = failing.list().find((entry) => entry.agentName === "broken")!;
  assert.equal(broken.state, "aborted");
  assert.ok(!existsSync(broken.lease.worktreePath), "the worktree is removed");
  assert.equal(rawGit(root, ["branch", "--list", broken.lease.branch!]), "", "the branch is removed");
});

test("a workspace root on another filesystem is refused before anything is made", async () => {
  const { root } = initTempRepo("ws-otherfs");
  // ANOTHER FILESYSTEM, FROM THIS SYSTEM'S MOUNT TABLE — never an assumed
  // path (/dev/shm is absent on some hosts, and the temp root is on it on
  // others): the first mount point, on a device not the repository's, where
  // a folder can actually be made (a writable bit is not enough: mqueue says
  // writable and refuses mkdir). A host with none cannot run this test, and says so.
  const repositoryDevice = statSync(root).dev;
  const other = [...readLinuxMountPoints()].toSorted().find((point) => {
    try {
      if (!statSync(point).isDirectory() || statSync(point).dev === repositoryDevice) return false;
      rmdirSync(mkdtempSync(join(point, "ws-otherfs-probe-")));
      return true;
    } catch { return false; }
  });
  assert.ok(other !== undefined, "this host has no writable mount point on another filesystem than the repository's");
  const workspaceRoot = join(other, `ws-otherfs-${process.pid}-${Date.now()}`);
  try {
    const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });
    await assert.rejects(() => manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] }), throwsCode("workspace_root_filesystem_mismatch"));
    assert.deepEqual(manager.list(), []);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("merge precondition: an unvalidated workspace cannot merge", async () => {
  const { root } = initTempRepo("ws-precondition");
  const workspaceRoot = mkWorkspaceTempDir("ws-precondition-wt");
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot) });
  const record = await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/p"] });
  await assert.rejects(() => manager.merge(record.workspaceId), throwsCode("workspace_merge_precondition_failed"));
});

test("timeline shard import: an actual merge imports every page and retains the source after teardown", async () => {
  const { root } = initTempRepo("ws-timeline");
  const workspaceRoot = mkWorkspaceTempDir("ws-timeline-wt");
  const hooks = createWorkspaceTimelineHooks(registryOf(root), { queryDefaultLimit: 37 });
  const pageLimits: (number | undefined)[] = [];
  const timeline = { ...hooks, openShard(workspaceId: string) {
    const shard = hooks.openShard(workspaceId);
    return { ...shard, query(filter: Parameters<typeof shard.query>[0]) { pageLimits.push(filter?.limit); return shard.query(filter); } };
  } };
  const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot), timeline });
  const record = await manager.create({ agentName: "agentA", mode: "feature", writeSet: ["src/t"] });
  commitFile(record.lease.worktreePath, "src/t/t.ts", "export const t = 1;\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  const shard = timeline.openShard(record.workspaceId);
  let sourceEvents: number;
  try {
    for (let index = 0; index < 1001; index++) {
      shard.appendEvent({ eventId: `merge-page-${index}`, ledgerId: shard.ledgerId, eventType: "agent", actor: { kind: "harness", id: "workspace-manager" }, description: `merge page ${index}`, wallTime: "2026-09-26T12:00:00.000Z" });
    }
    sourceEvents = shard.count();
  } finally { shard.close(); }
  pageLimits.length = 0;
  const receipt = await manager.merge(record.workspaceId);
  assert.equal(pageLimits.length, Math.ceil(sourceEvents / 37));
  assert.ok(pageLimits.every((limit) => limit === 37), "manager forwards the configured bounded page limit");
  const imported = timeline.openCanonical();
  try {
    assert.deepEqual({ imported: receipt.timelineImportedEvents, skipped: receipt.timelineSkippedEvents, lastImported: imported.getEvent("merge-page-1000") !== undefined, sourceRetained: existsSync(join(registryRoot(root), "timeline", "workspace-shards", record.workspaceId)) }, { imported: sourceEvents, skipped: 0, lastImported: true, sourceRetained: true });
  } finally { imported.close(); }
  assert.equal(manager.status(record.workspaceId).state, "merged");

  const canonical = createTimelineStore({ path: join(registryRoot(root), "timeline", "timeline.db"), ledgerId: "workspace-integrator" });
  try {
    const events = canonical.query({ ledgerId: "workspace-integrator", limit: canonical.count() });
    const descriptions = events.map((event) => event.description);
    assert.ok(descriptions.some((line) => line.startsWith("workspace-created")));
    assert.ok(descriptions.some((line) => line.startsWith("workspace-validated")));
    assert.ok(descriptions.some((line) => line.startsWith("workspace-merged")));
    assert.equal(canonical.verifyChain().valid, true);
    const ids = events.map((event) => event.eventId);
    assert.equal(new Set(ids).size, ids.length, "no duplicate event identities");
  } finally {
    canonical.close();
  }
});

test("workspace timeline hooks capture config once and forward document, edge and actual SQLite settings to both stores", (t) => {
  const root = mkWorkspaceTempDir("ws-hook-config");
  const settings = { dbFilename: "configured.db", maxDocumentBytes: 16, maxDocuments: 1, maxEdges: 1, sqliteCacheSize: -321, sqliteBusyTimeoutMs: 37, queryDefaultLimit: 2 };
  const hooks = createWorkspaceTimelineHooks(repositoryRegistry(root), settings);
  Object.assign(settings, { dbFilename: "changed.db", maxDocumentBytes: 1024, maxDocuments: 10, maxEdges: 10, sqliteCacheSize: -999, sqliteBusyTimeoutMs: 999, queryDefaultLimit: 999 });
  const observed: { cache: number; busy: number }[] = [];
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    exec.call(this, sql);
    if (sql.startsWith("PRAGMA cache_size =")) observed.push({ cache: Number(this.prepare("PRAGMA cache_size").get()!.cache_size), busy: Number(this.prepare("PRAGMA busy_timeout").get()!.timeout) });
  });
  for (const open of [() => hooks.openShard("config"), () => hooks.openCanonical()]) {
    const store = open();
    const base = { eventId: "configured", ledgerId: store.ledgerId, eventType: "agent" as const, actor: { kind: "harness", id: "config-test" }, description: "configured", wallTime: "2026-09-26T12:00:00.000Z" };
    try {
      assert.throws(() => store.appendEvent({ ...base, documents: [{ name: "large", contentJson: "x".repeat(17), contentDigest: sha256("x".repeat(17)) }] }), { code: "timeline_document_invalid" });
      assert.throws(() => store.appendEvent({ ...base, documents: [{ name: "a", contentDigest: sha256("a") }, { name: "b", contentDigest: sha256("b") }] }), { code: "timeline_documents_exceeded" });
      assert.throws(() => store.appendEvent({ ...base, edges: [{ edgeType: "causal", targetKind: "external", targetId: "a" }, { edgeType: "causal", targetKind: "external", targetId: "b" }] }), { code: "timeline_edges_exceeded" });
      assert.equal(store.count(), 0);
      store.appendEvent({ ...base, documents: [{ name: "exact", contentJson: "x".repeat(16), contentDigest: sha256("x".repeat(16)) }] });
      assert.equal(store.count(), 1);
    } finally { store.close(); }
  }
  assert.equal(hooks.queryDefaultLimit, 2);
  assert.deepEqual(observed, [{ cache: -321, busy: 37 }, { cache: -321, busy: 37 }]);
  assert.equal(existsSync(join(repositoryRegistry(root).root, "timeline", "configured.db")), true);
  assert.equal(existsSync(join(repositoryRegistry(root).root, "timeline", "changed.db")), false);
});

for (const failure of ["canonical-open", "canonical-close", "shard-close", "import-conflict"] as const) {
  test(`actual merge ${failure} after the land preserves the source and closes acquired handles`, async () => {
    const { root } = initTempRepo("ws-import-failure");
    const workspaceRoot = mkWorkspaceTempDir("ws-import-failure-wt");
    const hooks = createWorkspaceTimelineHooks(registryOf(root));
    let active = false;
    let importing = false;
    let shardCloses = 0;
    let canonicalCloses = 0;
    let heldShard: EventLedgerStoragePort | undefined;
    let heldCanonical: EventLedgerStoragePort | undefined;
    const injected = new Error(`injected ${failure}`);
    const timeline = { ...hooks,
      openShard(workspaceId: string) {
        const shard = hooks.openShard(workspaceId);
        if (!active) return shard;
        importing = true; heldShard = shard;
        return { ...shard, close() { shardCloses++; shard.close(); if (failure === "shard-close") throw injected; } };
      },
      openCanonical() {
        if (!importing) return hooks.openCanonical();
        if (failure === "canonical-open") throw injected;
        const canonical = hooks.openCanonical(); heldCanonical = canonical;
        return { ...canonical, close() { canonicalCloses++; canonical.close(); if (failure === "canonical-close") throw injected; } };
      },
    };
    const { manager } = makeManager(root, { config: makeTestConfig(workspaceRoot), timeline });
    const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src/change"] });
    commitFile(record.lease.worktreePath, "src/change/new.ts", "export const x = 1;\n");
    await manager.validate(record.workspaceId);
    const source = hooks.openShard(record.workspaceId);
    const sourceBefore = source.query(); source.close();
    if (failure === "import-conflict") {
      const canonical = hooks.openCanonical();
      try { canonical.appendEvent({ eventId: sourceBefore[1]!.eventId, ledgerId: canonical.ledgerId, eventType: "agent", actor: { kind: "harness", id: "conflicting" }, description: "conflicting existing row", wallTime: "2026-09-26T12:00:00.000Z" }); }
      finally { canonical.close(); }
    }
    active = true;
    await assert.rejects(() => manager.merge(record.workspaceId), failure === "import-conflict" ? throwsCode("workspace_shard_identity_conflict") : (error: unknown) => error === injected);
    assert.equal(shardCloses, 1, "acquired shard closes even if canonical open or close fails");
    assert.equal(canonicalCloses, failure === "canonical-open" ? 0 : 1, "acquired canonical handle closes even if shard close fails");
    assert.throws(() => heldShard!.count(), { code: "ERR_INVALID_STATE" });
    if (heldCanonical) assert.throws(() => heldCanonical!.count(), { code: "ERR_INVALID_STATE" });
    assert.equal(existsSync(record.lease.worktreePath), true);
    const current = manager.status(record.workspaceId);
    assert.equal(current.state, "merging");
    assert.equal(current.mergeReceipt, null);
    assert.equal(existsSync(join(root, "src/change/new.ts")), true, "the land precedes the import; no rollback is promised");
    // No integrator holds the merge lock any more: recover finishes the teardown.
    const recovered = await manager.recover(record.workspaceId);
    assert.equal(recovered.state, "merged");
    assert.match(recovered.history.at(-1)!.reason, /^recovered: the land on main had happened/u);
    assert.equal(existsSync(record.lease.worktreePath), false);
    assert.equal(rawGit(root, ["branch", "--list", record.lease.branch!]), "");
    const retained = hooks.openShard(record.workspaceId);
    const canonical = hooks.openCanonical();
    try {
      assert.deepEqual(retained.query(), sourceBefore);
      assert.equal(retained.verifyChain().valid, true);
      if (failure !== "canonical-open") assert.ok(canonical.getEvent(sourceBefore[0]!.eventId), "committed valid prefix remains");
      assert.equal(canonical.verifyChain().valid, true);
    } finally { retained.close(); canonical.close(); }
  });
}

for (const failure of ["worktree-remove", "branch-delete", "receipt-save"] as const) {
  test(`actual merge ${failure} after the land retains the shard and never reports a completed merged state`, async () => {
    const { root } = initTempRepo("ws-teardown-failure");
    const workspaceRoot = mkWorkspaceTempDir("ws-teardown-failure-wt");
    const config = makeTestConfig(workspaceRoot);
    const timeline = createWorkspaceTimelineHooks(registryOf(root));
    const { manager, git } = makeManager(root, { config, timeline });
    const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src/change"] });
    commitFile(record.lease.worktreePath, "src/change/new.ts", "export const x = 1;\n");
    await manager.validate(record.workspaceId);
    let persisted: WorkspaceRecord = manager.status(record.workspaceId);
    const injected = new Error(`injected ${failure}`);
    let inject = true;
    const records = { load: () => persisted, list: () => [persisted], olderRecord: () => null, save(next: WorkspaceRecord): WorkspaceRecord {
      if (inject && failure === "receipt-save" && next.state === "merged") throw injected;
      persisted = { ...next, revision: next.revision + 1 };
      return persisted;
    } };
    const failing = createWorkspaceManager({ checkoutRoot: root, engineRelative: "engine", config, timeline, timeouts: TEST_TIMEOUTS, identity: TEST_INTEGRATOR_IDENTITY, commands: makeFakeCommands(), repository: testRepository,
      records,
      git: { ...git,
        worktreeRemove(options) { if (failure === "worktree-remove") throw injected; return git.worktreeRemove(options); },
        deleteBranch(...args) { if (failure === "branch-delete") throw injected; return git.deleteBranch(...args); },
      },
    });
    await assert.rejects(() => failing.merge(record.workspaceId), (error: unknown) => error === injected);
    assert.equal(persisted.state, "merging");
    assert.equal(persisted.mergeReceipt, null);
    assert.equal(existsSync(record.lease.worktreePath), failure === "worktree-remove", "partial teardown remains visible; it is not rolled back");
    assert.equal(rawGit(root, ["branch", "--list", record.lease.branch!]).includes(record.lease.branch!), failure !== "receipt-save");
    assert.equal(existsSync(join(root, "src/change/new.ts")), true, "the land already happened");
    const source = timeline.openShard(record.workspaceId);
    const canonical = timeline.openCanonical();
    try {
      for (const event of source.query()) assert.ok(canonical.getEvent(event.eventId));
      assert.equal(source.verifyChain().valid, true);
      assert.equal(canonical.verifyChain().valid, true);
    } finally { source.close(); canonical.close(); }
    // The integrator is gone: recover finishes whatever teardown remained.
    inject = false;
    const recovering = createWorkspaceManager({ checkoutRoot: root, engineRelative: "engine", config, timeline, timeouts: TEST_TIMEOUTS, identity: TEST_INTEGRATOR_IDENTITY, commands: makeFakeCommands(), repository: testRepository, records, git });
    assert.equal((await recovering.recover(record.workspaceId)).state, "merged");
    assert.equal(existsSync(record.lease.worktreePath), false);
    assert.equal(rawGit(root, ["branch", "--list", record.lease.branch!]), "");
  });
}

test("a ledger-judged suite gate: the target's tip is measured like for like in the worktree; a new or changed failure or an unrecorded run fails; the land imports only the landed tree's run", async () => {
  const { root } = initTempRepo("ws-ledger");
  const ledger = WEB_RUN_HISTORY_PATH;
  commitFailureOwners(root, ["suite.test.ts"]);
  const older = rawGit(root, ["rev-parse", "HEAD"]);
  commitFile(root, "src/older.ts", "export const older = 1;\n");
  const target = rawGit(root, ["rev-parse", "HEAD"]);
  assert.notEqual(older, target);
  // A row as the runners write it: the HEAD it ran at and the tree it measured.
  const row = (headSha: string, failures: Readonly<Record<string, string>>, timestamp: string, extra: Readonly<Record<string, unknown>> = {}) =>
    ({ timestamp, headSha, treeId: rawGit(root, ["rev-parse", `${headSha}^{tree}`]), wallClockMs: 0, cpuMsPerTestFile: 1, testModuleCount: 1, failures: Object.keys(failures), failureDigests: { ...failures }, heavySlot: "held" as const, ...extra });
  const appendRow = (checkout: string, entry: unknown): void => {
    const path = join(checkout, ledger);
    const runs = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { runs: unknown[] }).runs : [];
    writeFile(checkout, ledger, `${JSON.stringify({ runs: [...runs, entry] })}\n`);
  };
  // The landing checkout's ledger holds rows that are NOT a baseline of the
  // target: a clean run of another tree, a dirty-tree run at the target's
  // HEAD (another tree), and a run at the target's HEAD that names no tree.
  appendRow(root, row(older, {}, "2026-09-01T00:00:00.000Z"));
  appendRow(root, row(target, {}, "2026-09-01T00:00:01.000Z", { provisionalFailures: true, treeId: rawGit(root, ["rev-parse", `${older}^{tree}`]) }));
  appendRow(root, row(target, {}, "2026-09-01T00:00:02.000Z", { treeId: undefined }));

  const owned = { "suite.test.ts::an owned failure": "aaaaaaaaaaaaaaaa" };
  let branchFailures: Readonly<Record<string, string>> = owned;
  let recordRun = true;
  const measuredAt: string[] = [];
  const commands = makeFakeCommands({
    suite: (cwd) => {
      const head = rawGit(cwd, ["rev-parse", "HEAD"]);
      measuredAt.push(head);
      const recorded = row(head, head === target ? owned : branchFailures, new Date().toISOString());
      if (head === target) {
        if (recordRun) appendRow(cwd, recorded); // historical target runner keeps its legacy protocol
        return failGate("suite", "npm test exited 1");
      }
      return qualifiedSuiteGate(cwd, "web", recorded, { record: recordRun });
    },
  });
  const config = makeTestConfig(mkWorkspaceTempDir("ws-ledger-wt"), {
    commands: { suite: { cwd: ".", argv: ["true"], timeoutMs: 60_000, ledger: "web" }, regen: { cwd: ".", argv: ["true"], timeoutMs: 60_000 } },
    phases: { setup: [], validate: [], regenerate: ["regen"], merge: ["suite"] },
  });
  const { manager } = makeManager(root, { config, commands });
  const workspace = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(workspace.lease.worktreePath, "src/l.ts", "export const l = 1;\n");
  const head = rawGit(workspace.lease.worktreePath, ["rev-parse", "HEAD"]);

  branchFailures = { ...owned, "suite.test.ts::a new failure": "bbbbbbbbbbbbbbbb" };
  const regressed = await manager.validate(workspace.workspaceId, { full: true });
  assert.deepEqual(measuredAt, [target, head], "the target's tip was measured first, in the worktree (no row of the landing checkout was a baseline of its tree)");
  assert.equal(rawGit(workspace.lease.worktreePath, ["symbolic-ref", "--short", "HEAD"]), workspace.lease.branch, "the worktree is back on its branch");
  const judged = regressed.gates.find((gate) => gate.gate === "suite")!;
  assert.equal(judged.status, "fail");
  assert.deepEqual(judged.details, ["suite.test.ts::a new failure", "suite.test.ts::an owned failure (an owned failure: persists on the target with the same digest; owner FIXTURE-OWNER)"]);

  branchFailures = { "suite.test.ts::an owned failure": "cccccccccccccccc" };
  const changed = (await manager.validate(workspace.workspaceId, { full: true })).gates.find((gate) => gate.gate === "suite")!;
  assert.deepEqual(measuredAt.slice(2), [head], "the target's baseline is measured once per tip");
  assert.equal(changed.status, "fail", "a persisting failure that fails differently is a new defect under an old identity");
  assert.deepEqual(changed.details, ["suite.test.ts::an owned failure (fails differently now)"]);

  recordRun = false;
  const unrecorded = (await manager.validate(workspace.workspaceId, { full: true })).gates.find((gate) => gate.gate === "suite")!;
  assert.equal(unrecorded.status, "fail");
  assert.match(unrecorded.message, /current invocation has no complete measured qualification envelope/u);

  recordRun = true;
  branchFailures = owned;
  // A new manager over an empty worktree ledger: the qualifying validate measures the target's baseline itself, so
  // the worktree's ledger holds a run of ANOTHER tree inside the qualified window, which the land must not import.
  writeFile(workspace.lease.worktreePath, ledger, `${JSON.stringify({ runs: [] })}\n`);
  const { manager: qualifier } = makeManager(root, { config, commands });
  const qualified = await qualifier.validate(workspace.workspaceId, { full: true });
  assert.deepEqual(measuredAt.slice(-2), [target, head], "the qualifying validate measured the target's tip, then the branch");
  assert.equal(qualified.status, "pass", "the owned failure persists on the target: nothing new, the gate passes despite the suite's exit status");
  assert.match(qualified.gates.find((gate) => gate.gate === "suite")!.message, new RegExp(`no new, changed or unowned failure \\(1 persisting \\(1 owned\\), 0 fixed, against the run of ${target}`, "u"));

  const receipt = await qualifier.merge(workspace.workspaceId);
  assert.deepEqual(receipt.importedRuns, ["web: 1"], "only the run of the landed tree is imported, never the target's baseline");
  const landed = JSON.parse(readFileSync(join(root, ledger), "utf8")) as { runs: Readonly<Record<string, unknown>>[] };
  assert.equal(landed.runs.length, 4);
  assert.equal(landed.runs[3]!["importedFrom"], `workspace ${workspace.workspaceId}`);
  assert.equal(landed.runs[3]!["headSha"], head);
});

test("a baseline is found by its TREE: a candidate's row of exactly the target's tree (another HEAD, provisional) is the baseline; a mutation run never is; a self-measured row is the baseline only by the tree it names; a baseline run that recorded nothing, named no tree or left the tree changed is named (WF-1b3c; WF-1b3c-FIX MED-3, N4)", async () => {
  const { root } = initTempRepo("ws-ledger-tree");
  const ledger = WEB_RUN_HISTORY_PATH;
  commitFailureOwners(root, ["suite.test.ts"]);
  const parent = rawGit(root, ["rev-parse", "HEAD"]);
  commitFile(root, "src/landed.ts", "export const landed = 1;\n");
  const target = rawGit(root, ["rev-parse", "HEAD"]);
  const targetTree = rawGit(root, ["rev-parse", "HEAD^{tree}"]);
  const appendRow = (checkout: string, entry: unknown): void => {
    const path = join(checkout, ledger);
    const runs = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { runs: unknown[] }).runs : [];
    writeFile(checkout, ledger, `${JSON.stringify({ runs: [...runs, entry] })}\n`);
  };
  const owned = { "suite.test.ts::an owned failure": "aaaaaaaaaaaaaaaa" };
  const row = (failures: Readonly<Record<string, string>>, extra: Readonly<Record<string, unknown>>) =>
    ({ timestamp: new Date().toISOString(), wallClockMs: 0, cpuMsPerTestFile: 1, testModuleCount: 1, failures: Object.keys(failures), failureDigests: { ...failures }, heavySlot: "held" as const, ...extra });
  // A CANDIDATE's qualification of the tree the commit then landed: measured on the parent HEAD, dirty (provisional), keyed by the tree.
  appendRow(root, row(owned, { headSha: parent, provisionalFailures: true, treeId: targetTree, importedFrom: "/candidate" }));
  let identity: "full" | "none" = "full";
  let recordBaseline = true;
  let leaveScratch = false;
  const measuredAt: string[] = [];
  const commands = makeFakeCommands({
    suite: (cwd) => {
      const head = rawGit(cwd, ["rev-parse", "HEAD"]);
      measuredAt.push(head);
      const isTarget = head === target;
      if (isTarget && leaveScratch) writeFileSync(join(cwd, "left-behind.txt"), "a file the baseline run wrote\n");
      // `none`: a TARGET runner that records no identity (no headSha, no treeId). A run that changed the tree names no
      // tree (the runner's start and end reads differ), only its HEAD.
      const named = isTarget && identity === "none" ? {} : isTarget && leaveScratch ? { headSha: head } : { headSha: head, treeId: rawGit(cwd, ["rev-parse", "HEAD^{tree}"]) };
      if (!isTarget) return qualifiedSuiteGate(cwd, "web", row(owned, named));
      if (recordBaseline) appendRow(cwd, row(owned, named)); // the unchanged target need not emit new completion fields
      return failGate("suite", "npm test exited 1");
    },
    // The branch's regenerate removes what the target's baseline run left behind, so the branch's own gate is judged.
    regen: (cwd) => {
      rmSync(join(cwd, "left-behind.txt"), { force: true });
      return passGate("regen");
    },
  });
  const config = makeTestConfig(mkWorkspaceTempDir("ws-ledger-tree-wt"), {
    commands: { suite: { cwd: ".", argv: ["true"], timeoutMs: 60_000, ledger: "web" }, regen: { cwd: ".", argv: ["true"], timeoutMs: 60_000 } },
    phases: { setup: [], validate: [], regenerate: ["regen"], merge: ["suite"] },
  });
  const { manager } = makeManager(root, { config, commands });
  const workspace = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(workspace.lease.worktreePath, "src/t.ts", "export const t = 1;\n");
  const head = rawGit(workspace.lease.worktreePath, ["rev-parse", "HEAD"]);
  const reused = await manager.validate(workspace.workspaceId, { full: true });
  assert.equal(reused.status, "pass", JSON.stringify(reused.gates));
  assert.deepEqual(measuredAt, [head], "the candidate's row of the target's tree is its baseline: the target was not re-measured");

  // A deliberate mutation run of exactly the target's tree is no baseline: the manager measures the target itself, and
  // the row that run recorded (naming the target's tree) judges.
  writeFile(root, ledger, `${JSON.stringify({ runs: [row(owned, { treeId: targetTree, mutationRun: true })] })}\n`);
  const { manager: fresh } = makeManager(root, { config, commands });
  const measured = await fresh.validate(workspace.workspaceId, { full: true });
  assert.deepEqual(measuredAt.slice(1), [target, head], "measured at the target's tip first, then the branch");
  assert.equal(measured.status, "pass", JSON.stringify(measured.gates));
  assert.match(measured.gates.find((gate) => gate.gate === "suite")!.message, /no new, changed or unowned failure \(1 persisting \(1 owned\)/u);

  // The worktree's own ledger now holds the target's row: drop it (the measurement is per worktree ledger).
  const worktreeLedger = join(workspace.lease.worktreePath, ledger);
  const unmeasuredBy = async (why: string): Promise<void> => {
    writeFile(root, ledger, `${JSON.stringify({ runs: [] })}\n`);
    writeFileSync(worktreeLedger, `${JSON.stringify({ runs: [] })}\n`);
    const { manager: next } = makeManager(root, { config, commands });
    const gate = (await next.validate(workspace.workspaceId, { full: true })).gates.find((entry) => entry.gate === "suite")!;
    assert.equal(gate.status, "fail");
    const said = `unmeasured: no run of the target's tree (${target}) in ${ledger} to judge this run against: the target's baseline run (suite) ${why}`;
    assert.equal(gate.message.slice(0, said.length), said, gate.message);
  };
  // A baseline run whose row names no tree of the target is never adopted as one: the gate says why.
  identity = "none";
  await unmeasuredBy("recorded a run that names no tree of the target");
  // A baseline run that records nothing: the gate says so, never a bare "unmeasured".
  identity = "full";
  recordBaseline = false;
  await unmeasuredBy("recorded no judged run");
  // A baseline run that left the tree changed did not measure the committed tree.
  recordBaseline = true;
  leaveScratch = true;
  await unmeasuredBy("left 1 path(s) changed");
});

for (const ledgerName of ["engine", "web"] as const satisfies readonly SuiteLedgerName[]) {
  test(`zero NEW failures, every remaining failure OWNED (the ${ledgerName} ledger): a planted new failure is refused; a base failure an open task row names by its repository path is accepted; an unowned base failure is refused — a closed row, or a row naming another spelling of the path, owns nothing (LAND-OC-FIX R4)`, async () => {
    const { root } = initTempRepo(`ws-owners-${ledgerName}`);
    const ledger = suiteLedgerPaths("engine")[ledgerName];
    // A failure identity is `<file>::<name>`, the file relative to its runner: the engine's to the engine.
    const file = (name: string): string => ledgerName === "engine" ? `test/${name}` : `tests/${name}`;
    const repositoryPath = (name: string): string => ledgerName === "engine" ? `engine/${file(name)}` : file(name);
    const owned = `${file("owned.test.ts")}::a base failure a task owns`;
    const unowned = `${file("unowned.test.ts")}::a base failure no task owns`;
    const planted = `${file("owned.test.ts")}::a planted new failure`;
    commitTrackerBoard(root, [
      `- [ ] **OWNER-1** fixes the inherited red`,
      `  in ${repositoryPath("owned.test.ts")}:12 (continuation line of the open row; a line suffix is still the path).`,
      `- [x] **DONE-1** once named ${repositoryPath("unowned.test.ts")}; closed rows own nothing.`,
      // A longer name that merely CONTAINS the path declares another file (correctness U2).
      `- [ ] **NEAR-MISS** names ${repositoryPath("unowned.test.ts")}x and \`${repositoryPath("unowned.test.ts")}.bak\`.`,
      // The runner-relative spelling of an engine file is not its repository path.
      ...(ledgerName === "engine" ? [`- [ ] **WRONG-PATH** names ${file("unowned.test.ts")} without the engine prefix.`] : []),
    ]);
    const target = rawGit(root, ["rev-parse", "HEAD"]);
    const digests = { [owned]: "aaaaaaaaaaaaaaaa", [unowned]: "bbbbbbbbbbbbbbbb", [planted]: "cccccccccccccccc" };
    const row = (failures: readonly string[], treeId: string) => ({ timestamp: new Date().toISOString(), headSha: target, treeId,
      wallClockMs: 0, cpuMsPerTestFile: 1, testModuleCount: 1, failures, failureDigests: Object.fromEntries(failures.map((id) => [id, digests[id]!])), heavySlot: "held" as const });
    // The target tree's recorded run: both base failures.
    writeFile(root, ledger, `${JSON.stringify({ runs: [row([owned, unowned], rawGit(root, ["rev-parse", "HEAD^{tree}"]))] })}\n`);
    let branchFailures: readonly string[] = [];
    const measured: string[] = [];
    const commands = makeFakeCommands({
      suite: (cwd) => {
        measured.push(rawGit(cwd, ["rev-parse", "HEAD"]));
        return qualifiedSuiteGate(cwd, ledgerName, row(branchFailures, rawGit(cwd, ["rev-parse", "HEAD^{tree}"])));
      },
    });
    const config = makeTestConfig(mkWorkspaceTempDir(`ws-owners-${ledgerName}-wt`), {
      commands: { suite: { cwd: ".", argv: ["true"], timeoutMs: 60_000, ledger: ledgerName } },
      phases: { setup: [], validate: [], regenerate: [], merge: ["suite"] },
    });
    const { manager } = makeManager(root, { config, commands });
    const workspace = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
    commitFile(workspace.lease.worktreePath, "src/change.ts", "export const change = 1;\n");
    const judge = async (failures: readonly string[]) => {
      branchFailures = failures;
      return (await manager.validate(workspace.workspaceId, { full: true })).gates.find((gate) => gate.gate === "suite")!;
    };
    const ownedLine = `${owned} (an owned failure: persists on the target with the same digest; owner OWNER-1)`;

    const accepted = await judge([owned]);
    assert.equal(accepted.status, "pass", JSON.stringify(accepted));
    assert.match(accepted.message, /no new, changed or unowned failure \(1 persisting \(1 owned\), 1 fixed/u);
    assert.deepEqual(accepted.details, [ownedLine], "the accepted failure is named with its owner");

    const unownedGate = await judge([owned, unowned]);
    assert.equal(unownedGate.status, "fail", "a base failure no open row names is refused");
    assert.match(unownedGate.message, /0 new, 0 changed and 1 unowned failure/u);
    assert.deepEqual(unownedGate.details, [
      `${unowned} (persists from the target, but no open task row of ${ROOT_POLICY.workflow.failureOwners.tracker} names ${repositoryPath("unowned.test.ts")})`,
      ownedLine,
    ]);

    const plantedGate = await judge([owned, planted]);
    assert.equal(plantedGate.status, "fail", "a new failure is refused, even in a file a task owns");
    assert.match(plantedGate.message, /1 new, 0 changed and 0 unowned failure/u);
    assert.deepEqual(plantedGate.details, [planted, ownedLine]);
    assert.ok(measured.every((head) => head !== target), "the target's recorded run was the baseline: its tree was never re-measured");
  });
}

test("a budget breach joins the ONE judgement (UR-24): only SLOTTED target rows recorded before the run count; not worse and owned passes; worse, unowned, unslotted or a fragment-named owner fails", async () => {
  const { root } = initTempRepo("ws-budget");
  const ledger = WEB_RUN_HISTORY_PATH;
  commitTrackerBoard(root, ["- [ ] **BUDGET-OWNER** re-derives `testExecution.webUiSuiteCpuBudget`."]);
  const target = rawGit(root, ["rev-parse", "HEAD"]);
  const targetTree = rawGit(root, ["rev-parse", "HEAD^{tree}"]);
  // The target's runs of its tree: two UNSLOTTED (2204, 2137: they judge nothing), one slotted (2150), and a slotted
  // one recorded AFTER this run (1000: it may not set the bar).
  const baseRow = (cpu: number, at: string, held: boolean) => ({ timestamp: at, headSha: target, treeId: targetTree, wallClockMs: 0, cpuMsPerTestFile: cpu, testModuleCount: 1, failures: [], ...(held ? { heavySlot: "held" } : { heavySlot: "unslotted" }) });
  writeFile(root, ledger, `${JSON.stringify({ runs: [baseRow(2204, "2026-10-02T04:49:08.852Z", false), baseRow(2137, "2026-10-02T04:51:55.567Z", false), baseRow(2150, "2026-10-02T05:00:00.000Z", true), baseRow(1000, "2999-01-01T00:00:00.000Z", true)] })}\n`);
  let cpu = 2140;
  let slot: "held" | "unslotted" = "held";
  let kind: "fail" | "not-judged" = "fail";
  const commands = makeFakeCommands({
    suite: (cwd) => qualifiedSuiteGate(cwd, "web", {
      timestamp: new Date().toISOString(), headSha: rawGit(cwd, ["rev-parse", "HEAD"]), wallClockMs: 0, cpuMsPerTestFile: cpu, testModuleCount: 1, failures: [], heavySlot: slot,
    }, { outcomes: [{ gate: "cpu-per-test-file", kind, message: "over the cap in force" }] }),
  });
  const config = makeTestConfig(mkWorkspaceTempDir("ws-budget-wt"), {
    commands: { suite: { cwd: ".", argv: ["true"], timeoutMs: 60_000, ledger: "web" } },
    phases: { setup: [], validate: [], regenerate: [], merge: ["suite"] },
  });
  const { manager } = makeManager(root, { config, commands });
  const workspace = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src", "docs"] });
  commitFile(workspace.lease.worktreePath, "src/change.ts", "export const change = 1;\n");
  const judge = async () => { const report = await manager.validate(workspace.workspaceId, { full: true }); const found = report.gates.find((gate) => gate.gate === "suite"); assert.ok(found !== undefined, JSON.stringify(report.gates)); return found; };

  const owned = await judge();
  assert.equal(owned.status, "pass", JSON.stringify(owned));
  assert.match(owned.details.join("\n"), /cpu-per-test-file \(testExecution\.webUiSuiteCpuBudget\): 2140\.0; the target's lowest of 1 slotted value\(s\) is 2150\.0; persists from the target, not worse; owner BUDGET-OWNER/u);

  cpu = 2151;
  const worse = await judge();
  assert.equal(worse.status, "fail", "worse than the target's LOWEST slotted value: no allowance");
  assert.match(worse.details.join("\n"), /WORSE than the target: 2151\.0 > 2150\.0/u);
  // A budget gate that did not pass is a breach whatever it calls itself: a "not-judged" is judged the same
  // way, never waved through (UR-24-BUDGETS; design M-A).
  for (const softer of ["not-judged"] as const) {
    kind = softer;
    const softerWorse = await judge();
    assert.equal(softerWorse.status, "fail", `a ${softer} budget gate worse than the target fails`);
    assert.match(softerWorse.details.join("\n"), /WORSE than the target: 2151\.0 > 2150\.0/u);
  }
  kind = "fail";

  cpu = 2140;
  slot = "unslotted";
  const unslotted = await judge();
  assert.equal(unslotted.status, "fail");
  assert.match(unslotted.details.join("\n"), /did not hold the instrument lock: refused, not judged/u);

  slot = "held";
  commitTrackerBoard(workspace.lease.worktreePath, ["- [ ] **NEAR-MISS** re-derives testExecution.webUiSuiteCpuBudgetHistory.", "- [x] **BUDGET-OWNER** re-derived testExecution.webUiSuiteCpuBudget."]);
  const unowned = await judge();
  assert.equal(unowned.status, "fail", "a closed row owns nothing, and a longer name is not the budget's");
  assert.match(unowned.details.join("\n"), /no open task row of docs\/trackers\/TASKS\.md declares testExecution\.webUiSuiteCpuBudget/u);
});

test("a PERFORMANCE budget's breach is judged in the same ONE judgement: owned and not worse than the target's lowest slotted value passes, worse fails; a target with no slotted value of an owned budget is measured first", async () => {
  const { root } = initTempRepo("ws-perf-budget");
  const ledger = WEB_RUN_HISTORY_PATH;
  const gate = `${ROOT_POLICY.workflow.webPerformanceBudgets.gatePrefix}apiResponseMaxMs`;
  commitTrackerBoard(root, ["- [ ] **PERF-OWNER** makes the routes fast: `webUi.performance.apiResponseMaxMs`."]);
  const target = rawGit(root, ["rev-parse", "HEAD"]);
  const targetTree = rawGit(root, ["rev-parse", "HEAD^{tree}"]);
  // The target's one slotted run carries no performance value: it is measured in the lock (750).
  writeFile(root, ledger, `${JSON.stringify({ runs: [{ timestamp: "2026-10-02T05:00:00.000Z", headSha: target, treeId: targetTree, wallClockMs: 0, cpuMsPerTestFile: 1000, testModuleCount: 1, failures: [], heavySlot: "held" }] })}\n`);
  let api = 700;
  const measured: string[] = [];
  // THE PRODUCER RUNS FIRST, on the target too (correctness B-N3): the target is measured through the one sequencer,
  // so its suite reads a profile made on its own tree, never an "unmeasured" one.
  const sequence: string[] = [];
  const commands = makeFakeCommands({
    profile: (cwd) => {
      sequence.push(`profile@${rawGit(cwd, ["rev-parse", "HEAD^{tree}"]) === targetTree ? "target" : "change"}`);
      return passGate("profile");
    },
    suite: (cwd) => {
      const tree = rawGit(cwd, ["rev-parse", "HEAD^{tree}"]);
      sequence.push(`suite@${tree === targetTree ? "target" : "change"}`);
      if (tree === targetTree) measured.push(tree);
      const value = tree === targetTree ? 750 : api;
      return qualifiedSuiteGate(cwd, "web", {
        timestamp: new Date().toISOString(), headSha: rawGit(cwd, ["rev-parse", "HEAD"]), wallClockMs: 0, cpuMsPerTestFile: 1000, testModuleCount: 1, failures: [], heavySlot: "held",
        performanceMeasurements: { apiResponseMaxMs: value },
      }, { outcomes: [{ gate, kind: "fail", message: `webUi.performance.apiResponseMaxMs: ${String(value)} exceeds the budget 250` }] });
    },
  });
  const config = makeTestConfig(mkWorkspaceTempDir("ws-perf-budget-wt"), {
    commands: { profile: { cwd: ".", argv: ["true"], timeoutMs: 60_000 }, suite: { cwd: ".", argv: ["true"], timeoutMs: 60_000, ledger: "web", requires: ["profile"] } },
    phases: { setup: [], validate: [], regenerate: [], merge: ["suite"] },
  });
  const { manager } = makeManager(root, { config, commands });
  const workspace = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(workspace.lease.worktreePath, "src/change.ts", "export const change = 1;\n");
  const judge = async () => (await manager.validate(workspace.workspaceId, { full: true })).gates.find((found) => found.gate === "suite")!;
  const owned = await judge();
  assert.deepEqual(measured, [targetTree], "the target had no slotted value of the owned perf budget: measured once, in the lock");
  assert.deepEqual(sequence.slice(0, 2), ["profile@target", "suite@target"], "the target's measurement runs its producer first, through the one sequencer");
  assert.equal(owned.status, "pass", JSON.stringify(owned));
  assert.match(owned.details.join("\n"), /performance:apiResponseMaxMs \(webUi\.performance\.apiResponseMaxMs\): 700\.0; the target's lowest of 1 slotted value\(s\) is 750\.0; persists from the target, not worse; owner PERF-OWNER/u);
  api = 760;
  const worse = await judge();
  assert.equal(worse.status, "fail");
  assert.match(worse.details.join("\n"), /WORSE than the target: 760\.0 > 750\.0/u);
  assert.equal(budgetFieldOf({ a: { b: 3 } }, "a.b"), 3);
  assert.equal(budgetFieldOf({ a: { b: "3" } }, "a.b"), undefined, "a value that is not a finite number is none");
  assert.equal(budgetFieldOf({ a: null }, "a.b"), undefined);
});

test("a target with NO slotted run is measured in the lock first, then judged strictly: its slotted value is the bar", async () => {
  const { root } = initTempRepo("ws-budget-measure");
  const ledger = WEB_RUN_HISTORY_PATH;
  commitTrackerBoard(root, ["- [ ] **BUDGET-OWNER** `testExecution.webUiSuiteCpuBudget`"]);
  const target = rawGit(root, ["rev-parse", "HEAD"]);
  const targetTree = rawGit(root, ["rev-parse", "HEAD^{tree}"]);
  writeFile(root, ledger, `${JSON.stringify({ runs: [{ timestamp: "2026-10-02T04:49:08.852Z", headSha: target, treeId: targetTree, wallClockMs: 0, cpuMsPerTestFile: 3000, testModuleCount: 1, failures: [], heavySlot: "unslotted" }] })}\n`);
  let workspaceCpu = 1950;
  const measured: string[] = [];
  const commands = makeFakeCommands({
    suite: (cwd) => {
      const tree = rawGit(cwd, ["rev-parse", "HEAD^{tree}"]);
      if (tree === targetTree) measured.push(tree);
      return qualifiedSuiteGate(cwd, "web", {
        timestamp: new Date().toISOString(), headSha: rawGit(cwd, ["rev-parse", "HEAD"]), wallClockMs: 0, cpuMsPerTestFile: tree === targetTree ? 1900 : workspaceCpu, testModuleCount: 1, failures: [], heavySlot: "held",
      }, { outcomes: [{ gate: "cpu-per-test-file", kind: "fail", message: "over the cap" }] });
    },
  });
  const config = makeTestConfig(mkWorkspaceTempDir("ws-budget-measure-wt"), {
    commands: { suite: { cwd: ".", argv: ["true"], timeoutMs: 60_000, ledger: "web" } },
    phases: { setup: [], validate: [], regenerate: [], merge: ["suite"] },
  });
  const { manager } = makeManager(root, { config, commands });
  const workspace = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(workspace.lease.worktreePath, "src/change.ts", "export const change = 1;\n");
  const worse = (await manager.validate(workspace.workspaceId, { full: true })).gates.find((gate) => gate.gate === "suite")!;
  assert.deepEqual(measured, [targetTree], "the target was measured once, in the lock, because it had no slotted run");
  assert.equal(worse.status, "fail", JSON.stringify(worse));
  assert.match(worse.details.join("\n"), /WORSE than the target: 1950\.0 > 1900\.0/u, "the unslotted 3000 is never the bar");
  workspaceCpu = 1890;
  const better = (await manager.validate(workspace.workspaceId, { full: true })).gates.find((gate) => gate.gate === "suite")!;
  assert.equal(better.status, "pass", JSON.stringify(better));
  assert.deepEqual(measured, [targetTree], "a slotted target run, once recorded, is not measured again");
});

test("a read-only validation passes no budget breach: there is no target to own it against", async () => {
  const { root } = initTempRepo("ws-budget-readonly");
  const commands = makeFakeCommands({ suite: (cwd) => qualifiedSuiteGate(cwd, "web", {
    timestamp: new Date().toISOString(), cpuMsPerTestFile: 1, testModuleCount: 1, failures: [], heavySlot: "held",
  }, { outcomes: [{ gate: "cpu-per-test-file", kind: "fail", message: "over the cap" }] }) });
  const config = makeTestConfig(mkWorkspaceTempDir("ws-budget-readonly-wt"), {
    commands: { suite: { cwd: ".", argv: ["true"], timeoutMs: 60_000, ledger: "web" } },
    phases: { setup: [], validate: ["suite"], regenerate: [], merge: [] },
  });
  const { manager } = makeManager(root, { config, commands });
  const workspace = await manager.create({ agentName: "reader", mode: "read-only", writeSet: [] });
  const gate = (await manager.validate(workspace.workspaceId)).gates.find((entry) => entry.gate === "suite")!;
  assert.equal(gate.status, "fail", JSON.stringify(gate));
  assert.match(gate.message, /1 budget breach\(es\); read-only validation has no target comparison/u);
});

test("ONE judge: a new failure the flaky memory holds is a regression — nothing is re-run alone, nothing forgiven (UR-17; the user's 2026-10-07 audit decision)", async () => {
  const { root } = initTempRepo("ws-ledger-flake");
  const ledger = WEB_RUN_HISTORY_PATH;
  commitFailureOwners(root, ["flaky.test.ts"]);
  const older = rawGit(root, ["rev-parse", "HEAD"]);
  commitFile(root, "src/landed.ts", "export const landed = 1;\n");
  const targetTree = rawGit(root, ["rev-parse", "HEAD^{tree}"]);
  const appendRow = (checkout: string, entry: unknown): void => {
    const path = join(checkout, ledger);
    const runs = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { runs: unknown[] }).runs : [];
    writeFile(checkout, ledger, `${JSON.stringify({ runs: [...runs, entry] })}\n`);
  };
  const row = (failures: readonly string[], extra: Readonly<Record<string, unknown>>, timestamp: string) =>
    ({ timestamp, wallClockMs: 0, cpuMsPerTestFile: 1, testModuleCount: 1, failures, heavySlot: "held" as const, ...extra });
  const flaky = "flaky.test.ts::meets load now and then";
  // An earlier committed-tree run failed it, the target's own run did not: the flaky memory holds it.
  appendRow(root, row([flaky], { headSha: older }, "2026-09-01T00:00:00.000Z"));
  appendRow(root, row([], { treeId: targetTree }, "2026-09-01T00:00:01.000Z"));
  const ran: string[] = [];
  const commands = {
    run: async (cwd: string, name: string): Promise<ReturnType<typeof passGate>> => {
      ran.push(name);
      return name === "suite" ? qualifiedSuiteGate(cwd, "web", row([flaky], { treeId: rawGit(cwd, ["rev-parse", "HEAD^{tree}"]) }, new Date().toISOString())) : passGate(name);
    },
  };
  const config = makeTestConfig(mkWorkspaceTempDir("ws-ledger-flake-wt"), {
    commands: { suite: { cwd: ".", argv: ["true"], timeoutMs: 60_000, ledger: "web" }, regen: { cwd: ".", argv: ["true"], timeoutMs: 60_000 } },
    phases: { setup: [], validate: [], regenerate: ["regen"], merge: ["suite"] },
  });
  const { manager } = makeManager(root, { config, commands });
  const workspace = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src/attempt"] });
  commitFile(workspace.lease.worktreePath, "src/attempt/f.ts", "export const f = 1;\n");
  ran.length = 0;
  const gate = (await manager.validate(workspace.workspaceId, { full: true })).gates.find((entry) => entry.gate === "suite")!;
  assert.equal(gate.status, "fail", JSON.stringify(gate));
  assert.deepEqual(gate.details, [flaky], "the known flake is a new failure like any other");
  assert.deepEqual(ran, ["regen", "suite"], "no command but the phases' own ran: nothing was re-run alone");
});

test("a workspace's snapshot refs go with it at abort (A5-design L4), and stay with a quarantined one for inspection", async () => {
  const { root } = initTempRepo("ws-snapshot-refs");
  const config = makeTestConfig(mkWorkspaceTempDir("ws-snapshot-refs-wt"));
  const { manager } = makeManager(root, { config });
  const refsOf = (workspaceId: string): readonly string[] =>
    rawGit(root, ["for-each-ref", "--format=%(refname)", "refs/"]).split("\n").filter((ref) => ref.includes(`/${workspaceId}.`));
  const aborted = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  const kept = await manager.create({ agentName: "keeper", mode: "feature", writeSet: ["lib"] });
  for (const workspace of [aborted, kept]) {
    writeFileSync(join(workspace.lease.worktreePath, "scratch.txt"), "a recovery point\n");
    manager.snapshot(workspace.workspaceId, "one");
    manager.snapshot(workspace.workspaceId, "two");
    assert.equal(refsOf(workspace.workspaceId).length, 2);
  }
  await manager.abort(aborted.workspaceId);
  assert.deepEqual(refsOf(aborted.workspaceId), [], "an aborted workspace leaves no snapshot ref");
  await manager.abort(kept.workspaceId, { quarantine: true });
  assert.equal(refsOf(kept.workspaceId).length, 2, "a quarantined workspace keeps its recovery points");
  // Its quarantine expired: the sweep removes the worktree, the branch and the recovery points (A5-correctness L2).
  const later = makeManager(root, { config, now: () => new Date(Date.now() + 2 * config.quarantineTtlMs) }).manager;
  assert.deepEqual((await later.sweep()).swept, [kept.workspaceId]);
  assert.equal(existsSync(kept.lease.worktreePath), false);
  assert.equal(rawGit(root, ["branch", "--list", kept.lease.branch!]), "", "the expired quarantine's branch is gone");
  assert.deepEqual(refsOf(kept.workspaceId), []);
  assert.equal(later.status(kept.workspaceId).state, "quarantined", "the record stays: the account of what was quarantined");
});

test("the CLI states each command's own outcome: a successful abort or list of a record with a failed validation is a pass", async () => {
  const { root } = initTempRepo("ws-cli-status");
  const commands = makeFakeCommands({ unit: () => failGate("unit") });
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir("ws-cli-status-wt")), commands });
  const record = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/c.ts", "export const c = 1;\n");
  assert.equal((await manager.validate(record.workspaceId)).status, "fail");
  const { runWorkspaceCli } = await import("../../src/workflow/workspace-cli.ts");
  const listed = await runWorkspaceCli(root, ["list"]);
  assert.equal(listed.status, "pass", "the payload holds a failed validation report; listing it succeeded");
  const aborted = await runWorkspaceCli(root, ["abort", record.workspaceId]);
  assert.equal(aborted.status, "pass");
  assert.equal(manager.status(record.workspaceId).state, "aborted");
  await assert.rejects(() => runWorkspaceCli(root, ["validate", record.workspaceId, "--fast"]), (error: unknown) => (error as { code?: unknown }).code === "unknown_flag");
  // A repository git gives no identity (none local; a HOME with no global config) is refused before a workspace is
  // made: the integrator's merge commit would be refused at the end (A5-design L8).
  const saved = { HOME: process.env["HOME"], XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] };
  process.env["HOME"] = mkWorkspaceTempDir("ws-cli-no-identity-home");
  process.env["XDG_CONFIG_HOME"] = process.env["HOME"];
  try {
    await assert.rejects(() => runWorkspaceCli(root, ["create", "--agent", "worker", "--write-set", "src"]), (error: unknown) => (error as { code?: unknown }).code === "workspace_identity_missing");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.equal(manager.list().filter((entry) => entry.state === "active").length, 0, "nothing was made");
});


test("current qualification rejects a reporter failure beside unchanged owned test rows", async () => {
  const { root } = initTempRepo("ws-current-terminal-");
  const ledger = WEB_RUN_HISTORY_PATH;
  commitFailureOwners(root, ["suite.test.ts"]);
  const tree = rawGit(root, ["rev-parse", "HEAD^{tree}"]);
  const failures = ["suite.test.ts::owned failure"];
  const failureDigests = { [failures[0]!]: "aaaaaaaaaaaaaaaa" };
  const baseline = { timestamp: "2026-09-01T00:00:00.000Z", treeId: tree,
    cpuMsPerTestFile: 1, testModuleCount: 1, failures, failureDigests };
  writeFile(root, ledger, JSON.stringify({ runs: [baseline] }));
  let reporterFailure = false;
  const commands = makeFakeCommands({ suite: (cwd) => qualifiedSuiteGate(cwd, "web", {
    ...baseline, timestamp: new Date().toISOString(),
  }, { outcomes: [{ gate: "per-file-pool-share", kind: reporterFailure ? "fail" : "pass",
    message: reporterFailure ? "the reporter measured an actual share failure" : "the measured share passed" }] }) });
  const config = makeTestConfig(mkWorkspaceTempDir("ws-current-terminal-wt"), {
    commands: { suite: { cwd: ".", argv: ["true"], timeoutMs: 60_000, ledger: "web" } },
    phases: { setup: [], validate: [], regenerate: [], merge: ["suite"] },
  });
  const { manager } = makeManager(root, { config, commands });
  const workspace = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(workspace.lease.worktreePath, "src/change.ts", "export const change = 1;\n");
  const positive = await manager.validate(workspace.workspaceId, { full: true });
  assert.equal(positive.status, "pass", "complete owned-only exit1 has its exact historical test reference");
  reporterFailure = true;
  const result = await manager.validate(workspace.workspaceId, { full: true });
  const gate = result.gates.find((gate) => gate.gate === "suite");
  assert.equal(gate?.status, "fail", "zero new test identities must not erase the independent reporter/terminal failure");
  assert.match(gate?.message ?? "", /current non-test gate failed: per-file-pool-share/u,
    "the complete matched certificate fails on its actual non-test outcome, not absent terminal/identity");
});

test("current qualification refuses a dirty read-only checkout and keeps the matched clean control", async () => {
  const { root } = initTempRepo("ws-current-readonly-");
  let calls = 0;
  const commands = makeFakeCommands({ suite: (cwd) => {
    calls += 1;
    return qualifiedSuiteGate(cwd, "web", { timestamp: new Date().toISOString(), cpuMsPerTestFile: 1, testModuleCount: 1, failures: [] });
  } });
  const config = makeTestConfig(mkWorkspaceTempDir("ws-current-readonly-wt"), {
    commands: { suite: { cwd: ".", argv: ["true"], timeoutMs: 60_000, ledger: "web" } },
    phases: { setup: [], validate: ["suite"], regenerate: [], merge: [] },
  });
  const { manager } = makeManager(root, { config, commands });
  const workspace = await manager.create({ agentName: "reader", mode: "read-only", writeSet: [] });
  assert.equal((await manager.validate(workspace.workspaceId)).status, "pass");
  assert.equal(calls, 1);
  writeFile(workspace.lease.worktreePath, "README.md", "dirty bytes never named by HEAD\n");
  const refused = await manager.validate(workspace.workspaceId);
  assert.equal(refused.status, "fail");
  assert.match(refused.gates.find((gate) => gate.gate === "suite")?.message ?? "", /requires a clean checkout before execution/u);
  assert.equal(calls, 1, "the refused dirty tree never runs a borrowed clean-tree command");
});


test("current qualification rejects post-main dirty bytes and a clean changed HEAD with matched complete results", async () => {
  for (const cause of ["clean", "dirty", "new-tree"] as const) {
    const { root } = initTempRepo(`ws-main-current-${cause}`);
    const commands = makeFakeCommands({ suite: (cwd) => {
      const result = qualifiedSuiteGate(cwd, "web", { timestamp: new Date().toISOString(), cpuMsPerTestFile: 1, testModuleCount: 1, failures: [] });
      if (cause === "dirty") writeFile(cwd, "README.md", "dirty after current result\n");
      if (cause === "new-tree") commitFile(cwd, "README.md", "new HEAD after current result\n");
      return result;
    } });
    const config = makeTestConfig(mkWorkspaceTempDir(`ws-main-current-${cause}-wt`), {
      commands: { suite: { cwd: ".", argv: ["true"], timeoutMs: 60_000, ledger: "web" } },
      phases: { setup: [], validate: ["suite"], regenerate: [], merge: [] },
    });
    const { manager } = makeManager(root, { config, commands });
    const workspace = await manager.create({ agentName: `reader-${cause}`, mode: "read-only", writeSet: [] });
    const gate = (await manager.validate(workspace.workspaceId)).gates.find((entry) => entry.gate === "suite")!;
    assert.equal(gate.status, cause === "clean" ? "pass" : "fail");
    if (cause !== "clean") assert.match(gate.message, /current qualification tree changed during execution/u);
  }
});

test("every move of a worktree keeps the config's 0600: the target-baseline checkout and the return to the branch re-apply it (measured: they left it 0664, and the next harness command refused the config)", async () => {
  const { root } = initTempRepo("ws-move-mode");
  const configFile = "engine/bridlewise.config.json";
  commitFile(root, configFile, "{}\n");
  const modes: string[] = [];
  const commands = makeFakeCommands({
    suite: (cwd) => {
      modes.push((statSync(join(cwd, configFile)).mode & 0o777).toString(8));
      return failGate("suite", "measured");
    },
  });
  const config = makeTestConfig(mkWorkspaceTempDir("ws-move-mode-wt"), {
    commands: { suite: { cwd: ".", argv: ["true"], timeoutMs: 60_000, ledger: "web" } },
    phases: { setup: [], validate: ["suite"], regenerate: [], merge: [] },
  });
  const { manager } = makeManager(root, { config, commands });
  const workspace = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  commitFile(workspace.lease.worktreePath, "src/l.ts", "export const l = 1;\n");
  // The target moves and its config differs from the branch's: both checkouts rewrite the file.
  commitFile(root, configFile, "{ }\n");
  await manager.validate(workspace.workspaceId, { full: true });
  assert.ok(modes.length >= 1, "the target's tip was measured in the worktree");
  assert.deepEqual([...new Set(modes)], ["600"], "every measurement saw the config at 0600");
  assert.equal(statSync(join(workspace.lease.worktreePath, configFile)).mode & 0o777, 0o600, "back on the branch, the config is 0600");
});

test("a land keeps the canonical config's 0600: the merge's fast-forward rewrites the config the branch changed, and the one settle point re-applies the mode in the landing checkout (measured without it: 0664, and every harness command there refused)", async () => {
  const { root } = initTempRepo("ws-land-mode");
  const configFile = "engine/bridlewise.config.json";
  commitFile(root, configFile, "{}\n");
  chmodSync(join(root, configFile), 0o600);
  const config = makeTestConfig(mkWorkspaceTempDir("ws-land-mode-wt"), { phases: { setup: [], validate: [], regenerate: [], merge: [] } });
  const { manager } = makeManager(root, { config });
  const workspace = await manager.create({ agentName: "worker", mode: "feature", writeSet: [configFile] });
  commitFile(workspace.lease.worktreePath, configFile, "{ }\n");
  assert.equal((await manager.validate(workspace.workspaceId)).status, "pass");
  const receipt = await manager.merge(workspace.workspaceId);
  assert.equal(receipt.landing, "fast-forward");
  assert.equal(readFileSync(join(root, configFile), "utf8"), "{ }\n", "the land rewrote the config");
  assert.equal(statSync(join(root, configFile)).mode & 0o777, 0o600, "the landing checkout's config keeps 0600");
});

test("a read-only create does not run a heavy setup instrument (a verifier runs single files); a feature create runs it", async () => {
  const { root } = initTempRepo("ws-heavy-setup");
  const ran: string[] = [];
  const commands = makeFakeCommands({ warm: (cwd) => { ran.push(cwd); return { step: "warm", status: "pass", message: "warmed", details: [] }; } });
  const config = makeTestConfig(mkWorkspaceTempDir("ws-heavy-setup-wt"), {
    commands: { warm: { cwd: ".", argv: ["true"], timeoutMs: 60_000, holdsInstrumentLock: true } },
    phases: { setup: ["warm"], validate: [], regenerate: [], merge: [] },
  });
  const { manager } = makeManager(root, { config, commands });
  const reader = await manager.create({ agentName: "verifier", mode: "read-only", writeSet: [] });
  assert.deepEqual(ran, [], "the read-only create ran no heavy setup instrument");
  assert.equal(reader.state, "active");
  const writer = await manager.create({ agentName: "worker", mode: "feature", writeSet: ["src"] });
  assert.deepEqual(ran, [writer.lease.worktreePath], "a feature create warms its checkout");
});

test("the merge receipt lists every frozen-record acceptance the merge lands, for review (design MED-3)", async () => {
  const { root } = initTempRepo("ws-frozen-receipt");
  const manifest = ROOT_POLICY.verification.frozenRecordManifest;
  const base = { schemaVersion: "bridlewise-frozen-records/v1", files: { "docs/history/a.md": "a".repeat(64) } };
  commitFile(root, manifest, `${JSON.stringify(base, null, 2)}\n`);
  const config = makeTestConfig(mkWorkspaceTempDir("ws-frozen-receipt-wt"), { phases: { setup: [], validate: [], regenerate: [], merge: [] } });
  const { manager } = makeManager(root, { config });
  const workspace = await manager.create({ agentName: "worker", mode: "feature", writeSet: [manifest] });
  const acceptance = { path: "docs/history/a.md", from: "a".repeat(64), to: "b".repeat(64), reason: "corrected by its author", acceptedAt: "2026-10-11T00:00:00.000Z" };
  commitFile(workspace.lease.worktreePath, manifest, `${JSON.stringify({ ...base, files: { "docs/history/a.md": "b".repeat(64) }, acceptances: [acceptance] }, null, 2)}\n`);
  assert.equal((await manager.validate(workspace.workspaceId)).status, "pass");
  const receipt = await manager.merge(workspace.workspaceId);
  assert.deepEqual(receipt.frozenAcceptances, [acceptance]);
});

test("the land's TORN completion keeps the config's 0600: the holder's disk already holds the commit's config (written 0664) with its index at the old tip, and landCommit completes the fast-forward and settles the mode", () => {
  const { root } = initTempRepo("ws-torn-mode");
  const configFile = "engine/bridlewise.config.json";
  commitFile(root, configFile, "{}\n");
  const oldTip = rawGit(root, ["rev-parse", "HEAD"]);
  const branch = rawGit(root, ["symbolic-ref", "--short", "HEAD"]);
  // The commit to land, made beside the holder: the config changed.
  rawGit(root, ["checkout", "-q", "-b", "side"]);
  commitFile(root, configFile, "{ }\n");
  const commit = rawGit(root, ["rev-parse", "HEAD"]);
  rawGit(root, ["checkout", "-q", branch]);
  // The torn state: the disk at the commit's bytes, written with an editor's 0664; the index still at the old tip.
  writeFileSync(join(root, configFile), "{ }\n");
  chmodSync(join(root, configFile), 0o664);
  const landed = landCommit(makeGitPort(), root, branch, commit, oldTip, "engine", 60_000);
  assert.equal(landed.landing, "torn-completion", JSON.stringify(landed));
  assert.equal(landed.refusal, null);
  assert.equal(rawGit(root, ["rev-parse", "HEAD"]), commit);
  assert.equal(statSync(join(root, configFile)).mode & 0o777, 0o600, "the completion settles the config's mode");
});
