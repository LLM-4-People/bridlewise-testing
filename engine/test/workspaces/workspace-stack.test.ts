import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceConflictError } from "../../src/workflow/workspace-manager.ts";
import {
  commitFile,
  forgeAt,
  forgeStateOf,
  initTempRepo,
  makeManager,
  makeTestConfig,
  mkWorkspaceTempDir,
  rawGit,
} from "./workspace-test-support.ts";

/**
 * STACKS (github-only N6, V-14): an ordered chain of workspaces, each landed
 * through the same `ws land`. A stacked workspace starts at its parent's
 * published head and is judged from it while the parent is open. Its pull
 * request is opened against the TRUNK like any other — never against the
 * parent's branch, which the forge deletes when the parent lands (the fake
 * forge's `delete_branch_on_merge` closes the pull requests based on it) —
 * and it lands only after its parent did.
 */

/** Matches a HarnessError by its typed code. */
function throwsCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === code;
}

/** A repository whose `main` tracks a bare forge remote; the land's waits run `onWait`'s queue step once each. */
function stackFixture(prefix: string) {
  const { root, bare } = initTempRepo(prefix);
  const config = makeTestConfig(mkWorkspaceTempDir(`${prefix}-wt`));
  const steps: (() => void)[] = [];
  const { manager } = makeManager(root, { config, sleep: async () => { steps.shift()?.(); } });
  const forge = forgeAt(bare);
  return {
    root, bare, config, manager, forge,
    /** What the next land's first wait does (the queue's move). */
    onWait(step: () => void): void {
      steps.push(step);
    },
  };
}

/** A workspace whose round is published, validated and ready. */
async function readyWorkspace(manager: ReturnType<typeof stackFixture>["manager"], workspaceId: string): Promise<string> {
  const head = (await manager.publish(workspaceId)).round.head;
  assert.equal((await manager.validate(workspaceId)).status, "pass");
  await manager.ready(workspaceId);
  return head;
}

test("V-14: a two-part stack lands through the merge queue, each part on its own: the child is published against the trunk with only its own commits, waits for its parent, survives the parent's branch deletion, and lands its own change", async () => {
  const { root, bare, manager, forge, onWait } = stackFixture("ws-stack");
  const parent = await manager.create({ agentName: "base", mode: "feature", writeSet: ["src/a"] });
  commitFile(parent.lease.worktreePath, "src/a/one.ts", "export const one = 1;\n", "The parent's work");
  const parentHead = await readyWorkspace(manager, parent.workspaceId);

  const child = await manager.create({ agentName: "next", mode: "feature", writeSet: ["src/b"], stackOn: parent.workspaceId });
  assert.equal(forgeStateOf(child).stackedOn, parent.workspaceId);
  assert.equal(child.lease.baseSha, parentHead, "a stacked workspace starts at its parent's published head");
  assert.equal(child.lease.targetBranch, parent.lease.targetBranch);
  commitFile(child.lease.worktreePath, "src/b/two.ts", "export const two = 2;\n", "The child's work");
  forge.calls.length = 0;
  const round = (await manager.publish(child.workspaceId)).round;
  assert.equal(round.commits.length, 1, "only the child's own commit is re-made: the parent's twins are already on the forge");
  assert.equal(forge.calls.filter((call) => call.op === "createCommit").length, 1);
  assert.equal(rawGit(bare, ["rev-parse", `${round.head}^`]), parentHead, "the child's twin sits on its parent's published head");
  const pull = forge.pulls.get(2)!;
  assert.equal(pull.base, "main", "the child's pull request targets the trunk, never its parent's branch");
  assert.match(pull.body, /\*\*Stacked on\*\* #1/u);
  assert.match(pull.body, /The child's work/u);
  assert.doesNotMatch(pull.body, /The parent's work/u, "the body lists only the child's own commits");
  const validated = await manager.validate(child.workspaceId);
  assert.deepEqual(validated.changedPaths, ["src/b/two.ts"], "judged from the parent's published head");
  await manager.ready(child.workspaceId);

  await assert.rejects(() => manager.land(child.workspaceId), throwsCode("workspace_stack_parent_unlanded"));
  await assert.rejects(() => manager.merge(child.workspaceId), throwsCode("workspace_stack_parent_unlanded"), "the local integrator waits too");
  assert.equal(forge.calls.filter((call) => call.op === "enqueue").length, 0, "the child was never queued before its parent");
  assert.equal(manager.status(child.workspaceId).state, "validating");

  onWait(() => { forge.runQueue(1); });
  assert.equal((await manager.land(parent.workspaceId)).landedHead, parentHead);
  assert.equal(rawGit(bare, ["branch", "--list", parent.lease.branch!]), "", "the forge deleted the parent's branch on merge");
  assert.equal(forge.pulls.get(2)!.state, "open", "the child's pull request is untouched: it was never based on that branch");

  onWait(() => { forge.runQueue(2); });
  const landed = await manager.land(child.workspaceId);
  assert.equal(landed.landedHead, round.head);
  assert.deepEqual(landed.changedPaths, ["src/b/two.ts"], "the child's receipt names its own change");
  assert.equal(rawGit(bare, ["rev-parse", "refs/heads/main^2"]), round.head, "the queue merged exactly the child's published head");
  assert.equal(rawGit(root, ["show", "main:src/a/one.ts"]), "export const one = 1;");
  assert.equal(rawGit(root, ["show", "main:src/b/two.ts"]), "export const two = 2;");
  assert.equal(manager.status(child.workspaceId).state, "merged");
});

test("a stack is its own: a child may lease its parent's paths, and the parent lands over its child's pending lease; a sibling stays a rival", async () => {
  const { manager, forge, onWait } = stackFixture("ws-stack-overlap");
  const parent = await manager.create({ agentName: "base", mode: "feature", writeSet: ["src/a"] });
  commitFile(parent.lease.worktreePath, "src/a/one.ts", "export const one = 1;\n");
  const parentHead = await readyWorkspace(manager, parent.workspaceId);
  const child = await manager.create({ agentName: "next", mode: "feature", writeSet: ["src/a"], stackOn: parent.workspaceId });
  await assert.rejects(() => manager.create({ agentName: "sibling", mode: "feature", writeSet: ["src/a"], stackOn: parent.workspaceId }), (error: unknown) =>
    error instanceof WorkspaceConflictError && error.report.conflicts.some((conflict) => conflict.otherWorkspaceId === child.workspaceId));
  onWait(() => { forge.runQueue(1); });
  assert.equal((await manager.land(parent.workspaceId)).landedHead, parentHead, "its own child's lease never blocks the parent");
});

test("a parent that published another head, or ended without landing, leaves its child refused until it is rebased or ended", async () => {
  const { manager } = stackFixture("ws-stack-moved");
  const parent = await manager.create({ agentName: "base", mode: "feature", writeSet: ["src/a"] });
  commitFile(parent.lease.worktreePath, "src/a/one.ts", "export const one = 1;\n");
  await manager.publish(parent.workspaceId);
  const child = await manager.create({ agentName: "next", mode: "feature", writeSet: ["src/b"], stackOn: parent.workspaceId });
  commitFile(child.lease.worktreePath, "src/b/two.ts", "export const two = 2;\n");
  // The parent publishes another round: the child no longer stands on its published head.
  commitFile(parent.lease.worktreePath, "src/a/more.ts", "export const more = 1;\n");
  const moved = (await manager.publish(parent.workspaceId)).round.head;
  await assert.rejects(() => manager.validate(child.workspaceId), throwsCode("workspace_stack_parent_moved"));
  await assert.rejects(() => manager.publish(child.workspaceId), throwsCode("workspace_stack_parent_moved"));
  rawGit(child.lease.worktreePath, ["rebase", "-q", moved]);
  assert.deepEqual((await manager.validate(child.workspaceId)).changedPaths, ["src/b/two.ts"], "rebased onto the parent's new head, it is judged from there");
  assert.equal((await manager.publish(child.workspaceId)).round.commits.length, 1);
  // The parent ends without landing: nothing the child stands on will land.
  await manager.abort(parent.workspaceId, { reason: "abandoned" });
  await assert.rejects(() => manager.publish(child.workspaceId), throwsCode("workspace_stack_parent_ended"));
  await assert.rejects(() => manager.validate(child.workspaceId), throwsCode("workspace_stack_parent_ended"));
});

test("create --stack-on refuses what cannot be stacked on: an unpublished parent, a read-only one, an ended one, and a child that names its own target, base or overlay", async () => {
  const { manager } = stackFixture("ws-stack-create");
  const parent = await manager.create({ agentName: "base", mode: "feature", writeSet: ["src/a"] });
  await assert.rejects(() => manager.create({ agentName: "next", mode: "feature", writeSet: ["src/b"], stackOn: parent.workspaceId }), throwsCode("workspace_not_published"));
  commitFile(parent.lease.worktreePath, "src/a/one.ts", "export const one = 1;\n");
  await manager.publish(parent.workspaceId);
  for (const extra of [{ target: "main" }, { base: "main" }] as const) {
    await assert.rejects(() => manager.create({ agentName: "next", mode: "feature", writeSet: ["src/b"], stackOn: parent.workspaceId, ...extra }), throwsCode("workspace_stack_invalid"));
  }
  await assert.rejects(() => manager.create({ agentName: "next", mode: "read-only", writeSet: [], stackOn: parent.workspaceId }), throwsCode("workspace_stack_invalid"));
  const reader = await manager.create({ agentName: "reader", mode: "read-only", writeSet: [] });
  await assert.rejects(() => manager.create({ agentName: "next", mode: "feature", writeSet: ["src/b"], stackOn: reader.workspaceId }), throwsCode("workspace_stack_invalid"));
  await manager.abort(parent.workspaceId);
  await assert.rejects(() => manager.create({ agentName: "next", mode: "feature", writeSet: ["src/b"], stackOn: parent.workspaceId }), throwsCode("workspace_stack_parent_ended"));
  assert.deepEqual(manager.list().filter((record) => record.state === "active").map((record) => record.workspaceId), [reader.workspaceId], "nothing was made");
});
