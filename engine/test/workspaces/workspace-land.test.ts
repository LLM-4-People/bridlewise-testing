import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { WorkspaceManager } from "../../src/workflow/workspace-manager.ts";
import {
  commitFile,
  forgeAt,
  initTempRepo,
  makeManager,
  makeTestConfig,
  mkWorkspaceTempDir,
  pushTrunk,
  rawGit,
} from "./workspace-test-support.ts";

/**
 * THE LAND through the forge's merge queue (`ws land`): the async merge
 * request guarded by the published head, the wait on the queue (the request's
 * result, then the pull request's own state), every way a land ends without
 * landing, the bounded wait and its resumption, recover and sweep, and abort's
 * pull request. The fake forge's queue is real git over a bare repository.
 */

/** Matches a HarnessError by its typed code. */
function throwsCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === code;
}

/** A repository on a fake forge, a manager, and a validated, published, READY workspace changing `src/<name>.ts`. */
async function readyFixture(prefix: string, options: Readonly<{ timeoutMs?: number; now?: () => Date }> = {}) {
  const { root, bare } = initTempRepo(prefix);
  const config = makeTestConfig(mkWorkspaceTempDir(`${prefix}-wt`), options.timeoutMs === undefined ? {} : { landing: { pollIntervalMs: 1, timeoutMs: options.timeoutMs } });
  const { manager } = makeManager(root, { config, ...(options.now === undefined ? {} : { now: options.now }) });
  const forge = forgeAt(bare);
  const ready = async (name: string, target: WorkspaceManager = manager) => {
    const record = await target.create({ agentName: name, mode: "feature", writeSet: [`src/${name}.ts`] });
    commitFile(record.lease.worktreePath, `src/${name}.ts`, `export const ${name} = 1;\n`);
    assert.equal((await target.validate(record.workspaceId)).status, "pass");
    await target.publish(record.workspaceId);
    return target.ready(record.workspaceId);
  };
  return { root, bare, config, manager, forge, ready };
}

test("a refused land request changes nothing: the record stays validated and the next land asks again", async () => {
  const { bare, manager, forge, ready } = await readyFixture("ws-land-refused");
  const record = await ready("refused");
  const trunk = rawGit(bare, ["rev-parse", "main"]);
  forge.setRequestRefusal({ kind: "refused", status: 422, message: "Required status check \"bridlewise/door\" is expected" });
  await assert.rejects(() => manager.land(record.workspaceId), (error: unknown) =>
    throwsCode("workspace_land_refused")(error) && String((error as Error).message).includes("bridlewise/door"));
  assert.equal(manager.status(record.workspaceId).state, "validating");
  assert.equal(rawGit(bare, ["rev-parse", "main"]), trunk);
  forge.setRequestRefusal(null);
  assert.equal((await manager.land(record.workspaceId)).landing, "fast-forward");
});

test("a pull request the queue dequeues (its group failed) ends the land: the record goes back to active and the trunk is untouched", async () => {
  const { bare, manager, forge, ready } = await readyFixture("ws-land-dequeued");
  const record = await ready("dequeued");
  const trunk = rawGit(bare, ["rev-parse", "main"]);
  forge.setQueueVerdict(() => "fail");
  await assert.rejects(() => manager.land(record.workspaceId), throwsCode("workspace_land_dequeued"));
  const ended = manager.status(record.workspaceId);
  assert.equal(ended.state, "active", "the queue judged it: new work is needed");
  assert.equal(ended.forge?.mergeRequest, null);
  assert.ok(existsSync(record.lease.worktreePath), "the workspace is kept for the fix");
  assert.equal(rawGit(bare, ["rev-parse", "main"]), trunk);
});

test("a head pushed after the request cancels it: the land fails and the record goes back to active", async () => {
  const { root, bare, config, forge, ready } = await readyFixture("ws-land-moved");
  const record = await ready("moved");
  const branch = record.lease.branch!;
  forge.setQueueVerdict(() => "hold");
  // Someone pushes to the branch between the request and the queue's turn.
  const realRequest = forge.requestMerge;
  const pushingForge = { ...forge, requestMerge: async (number: number, request: Readonly<{ sha: string }>) => {
    const answer = await realRequest(number, request);
    const tree = rawGit(bare, ["rev-parse", `refs/heads/${branch}^{tree}`]);
    rawGit(bare, ["update-ref", `refs/heads/${branch}`, rawGit(bare, ["commit-tree", tree, "-p", `refs/heads/${branch}`, "-m", "pushed meanwhile"])]);
    return answer;
  } };
  const { manager: pushed } = makeManager(root, { config, forge: () => pushingForge });
  await assert.rejects(() => pushed.land(record.workspaceId), (error: unknown) =>
    throwsCode("workspace_land_failed")(error) && String((error as Error).message).includes("head of the pull request changed"));
  assert.equal(pushed.status(record.workspaceId).state, "active");
});

test("a land that outlives its wait stays merging; land resumes it and recover looks once; the receipt is the same land's", async () => {
  let clock = Date.parse("2026-10-21T12:00:00.000Z");
  const { root, config, manager, forge, ready } = await readyFixture("ws-land-pending", { timeoutMs: 1_000, now: () => new Date(clock) });
  const record = await ready("pending");
  forge.setQueueVerdict(() => "hold");
  const { manager: ticking } = makeManager(root, {
    config,
    now: () => new Date(clock),
    sleep: async () => { forge.advanceQueue(); clock += 400; },
  });
  await assert.rejects(() => ticking.land(record.workspaceId), throwsCode("workspace_land_pending"));
  const waiting = manager.status(record.workspaceId);
  assert.equal(waiting.state, "merging");
  assert.equal(waiting.forge?.mergeRequest, "merge-1");
  assert.equal(forge.pulls.get(1)!.queued, true, "it is in the queue");
  assert.equal((await manager.recover(record.workspaceId)).state, "merging", "recover looks once: still queued");
  assert.deepEqual(await manager.sweep(), [], "the sweep leaves a queued land to the queue");
  await assert.rejects(() => manager.abort(record.workspaceId), throwsCode("workspace_abort_denied"));

  forge.setQueueVerdict(() => "pass");
  const receipt = await manager.land(record.workspaceId);
  assert.equal(receipt.mergeRequest, "merge-1", "the land resumed the same request");
  assert.equal(forge.calls.filter((call) => call.op === "requestMerge").length, 1, "the forge was asked once");
  assert.equal(manager.status(record.workspaceId).state, "merged");
});

test("sweep finishes a land the queue merged after its wait stopped", async () => {
  let clock = Date.parse("2026-10-21T12:00:00.000Z");
  const { root, config, manager, forge, ready } = await readyFixture("ws-land-sweep", { timeoutMs: 1_000, now: () => new Date(clock) });
  const record = await ready("swept");
  forge.setQueueVerdict(() => "hold");
  const { manager: ticking } = makeManager(root, {
    config,
    now: () => new Date(clock),
    sleep: async () => { forge.advanceQueue(); clock += 400; },
  });
  await assert.rejects(() => ticking.land(record.workspaceId), throwsCode("workspace_land_pending"));
  forge.setQueueVerdict(() => "pass");
  forge.advanceQueue();
  assert.deepEqual(await manager.sweep(), [record.workspaceId]);
  const merged = manager.status(record.workspaceId);
  assert.equal(merged.state, "merged");
  assert.equal(merged.mergeReceipt?.landing, "fast-forward");
  assert.equal(readFileSync(join(root, "src/swept.ts"), "utf8"), "export const swept = 1;\n");
});

test("the local target follows the trunk's tip: a land merged after another lands both, and the receipt names the merge and the tip", async () => {
  const { root, bare, manager, forge, ready } = await readyFixture("ws-land-follow");
  const first = await ready("first");
  const second = await ready("second");
  forge.setQueueVerdict((pull) => (pull.number === 2 ? "pass" : "hold"));
  await manager.land(second.workspaceId);
  forge.setQueueVerdict(() => "pass");
  const receipt = await manager.land(first.workspaceId);
  assert.equal(receipt.trunkTip, rawGit(bare, ["rev-parse", "main"]));
  assert.equal(receipt.mergeCommitSha, receipt.trunkTip, "the first one merged last: it is the tip");
  assert.equal(rawGit(root, ["rev-parse", "main"]), receipt.trunkTip);
  assert.ok(existsSync(join(root, "src/first.ts")) && existsSync(join(root, "src/second.ts")));
  assert.equal(receipt.landing, "fast-forward");
});

test("a pull request already merged on the forge (a land another tool finished) is finished at once", async () => {
  const { manager, forge, ready } = await readyFixture("ws-land-already");
  const record = await ready("already");
  forge.pulls.get(1)!.queued = true;
  forge.advanceQueue();
  assert.equal(forge.pulls.get(1)!.merged, true);
  const receipt = await manager.land(record.workspaceId);
  assert.equal(receipt.mergeRequest, null, "no request was needed");
  assert.equal(receipt.mergeCommitSha, forge.pulls.get(1)!.mergeCommitSha);
});

test("abort closes the pull request with the reason and keeps the forge's branch; a closed pull request ends a land", async () => {
  const { root, bare, config, manager, forge, ready } = await readyFixture("ws-land-abort");
  const record = await ready("abandoned");
  const aborted = await manager.abort(record.workspaceId, { reason: "superseded by another approach" });
  assert.equal(aborted.state, "aborted");
  const pull = forge.pulls.get(1)!;
  assert.equal(pull.state, "closed");
  assert.equal(pull.comments[0], `Workspace \`${record.workspaceId}\` ended: superseded by another approach. Its branch is kept.`);
  assert.notEqual(rawGit(bare, ["branch", "--list", record.lease.branch!]), "", "the forge's branch is kept");

  // A pull request closed while it waits in the queue (by a maintainer) ends the land.
  const closing = await ready("closing");
  forge.setQueueVerdict(() => "hold");
  const { manager: watching } = makeManager(root, { config, sleep: async () => {
    forge.advanceQueue();
    const pull = forge.pulls.get(2)!;
    pull.state = "closed";
    pull.queued = false;
  } });
  await assert.rejects(() => watching.land(closing.workspaceId), throwsCode("workspace_pull_request_closed"));
  assert.equal(watching.status(closing.workspaceId).state, "active");
});

test("an expired lease's sweep closes its pull request too", async () => {
  const { root, config, forge, ready } = await readyFixture("ws-land-expired");
  const record = await ready("expired");
  const later = makeManager(root, { config, now: () => new Date(Date.now() + 2 * config.leaseTtlMs) }).manager;
  assert.deepEqual(await later.sweep(), [record.workspaceId]);
  assert.equal(forge.pulls.get(1)!.state, "closed");
  assert.match(forge.pulls.get(1)!.comments[0] ?? "", /lease-expired/u);
});

test("the trunk moved on the forge since the fork point (a disjoint land): the land merges onto the moved trunk", async () => {
  const { root, bare, manager, ready } = await readyFixture("ws-land-moved-trunk");
  const record = await ready("late");
  commitFile(root, "docs/elsewhere.md", "# another land\n");
  pushTrunk(root);
  const moved = rawGit(bare, ["rev-parse", "main"]);
  const receipt = await manager.land(record.workspaceId);
  assert.equal(receipt.preMergeHeadSha, moved);
  assert.equal(rawGit(root, ["rev-parse", "HEAD"]), receipt.mergeCommitSha);
});
