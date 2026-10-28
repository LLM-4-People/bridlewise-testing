import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { HarnessError } from "../../src/kernel/errors.ts";

import { deepFreeze } from "../../src/kernel/integrity.ts";
import { OLDER_WORKSPACE_SCHEMA_VERSIONS } from "../../src/workflow/workspace-contracts.ts";
import { WorkspaceConflictError } from "../../src/workflow/workspace-manager.ts";
import { createWorkspaceRecordStore, workspaceRecordStores } from "../../src/workflow/workspace-registry.ts";
import type { WorkspaceForgeFactory } from "../../src/workflow/workspace-forge.ts";
import {
  commitFile,
  forgeAt,
  forgeStateOf,
  initTempRepo,
  makeManager,
  makeTestConfig,
  mkWorkspaceTempDir,
  rawGit,
  registryOf,
} from "./workspace-test-support.ts";

/**
 * `ws land` (github-only §5.3, §6.1) against the fake forge's MERGE QUEUE:
 * the published, ready, validated head enters the queue with itself as the
 * expected head; the land is awaited (the test's queue moves while the
 * manager sleeps); only a merge of EXACTLY that head is followed locally and
 * receipted. Each guard has its own test, written to fail without it: the
 * refusal it proves is not the one the next line of defence would give.
 */

/** Matches a HarnessError by its typed code. */
function throwsCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === code;
}

type Step = () => void | Promise<void>;

/**
 * A repository whose `main` tracks a bare forge remote, and a workspace on it
 * PUBLISHED, VALIDATED and READY (pull request #1). `during` runs once on the
 * land's first wait (the queue's move); later waits do nothing.
 */
async function readyFixture(prefix: string) {
  const { root, bare, baseSha } = initTempRepo(prefix);
  const workspaceRoot = mkWorkspaceTempDir(`${prefix}-wt`);
  const config = makeTestConfig(workspaceRoot);
  let during: Step | null = null;
  const sleep = async (): Promise<void> => {
    const step = during;
    during = null;
    if (step !== null) await step();
  };
  const { manager } = makeManager(root, { config, sleep });
  const forge = forgeAt(bare);
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/a.ts", "export const a = 1;\n", "The work");
  const head = (await manager.publish(record.workspaceId)).round.head;
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  await manager.ready(record.workspaceId);
  return {
    root, bare, baseSha, config, manager, forge, record, head, workspaceId: record.workspaceId, branch: record.lease.branch!,
    /** What the land's first wait does. */
    onWait(step: Step): void {
      during = step;
    },
    enqueues: (): number => forge.calls.filter((call) => call.op === "enqueue").length,
    states: (): readonly string[] => manager.status(record.workspaceId).history.map((entry) => entry.to),
  };
}

/** A commit on the forge whose parent is `parent` (another writer's push), not yet on any branch. */
function forgeCommit(bare: string, parent: string, message: string): string {
  return rawGit(bare, ["commit-tree", rawGit(bare, ["rev-parse", `${parent}^{tree}`]), "-p", parent, "-m", message]);
}

test("land: the published head enters the merge queue at itself, the queue's merge of it is followed locally, the workspace is torn down and the land receipted", async () => {
  const fixture = await readyFixture("ws-land");
  const { root, bare, manager, forge, record, head, workspaceId } = fixture;
  fixture.onWait(() => {
    assert.equal(manager.status(workspaceId).state, "merging", "merging names the land while the queue holds it");
    assert.deepEqual(forgeStateOf(manager.status(workspaceId)).land, { head });
    forge.runQueue(1);
  });
  const receipt = await manager.land(workspaceId);
  assert.deepEqual(forge.calls.filter((call) => call.op === "enqueue").map((call) => call.request), [{ number: 1, expectedHeadSha: head }], "ONE enqueue, at the published head");
  const trunk = rawGit(bare, ["rev-parse", "refs/heads/main"]);
  assert.equal(receipt.kind, "land");
  assert.equal(receipt.mergeCommitSha, trunk);
  assert.equal(receipt.landedHead, head);
  assert.equal(receipt.trunkTip, trunk);
  assert.equal(receipt.pullRequest.number, 1);
  assert.deepEqual(receipt.changedPaths, ["src/a.ts"]);
  assert.equal(receipt.follow, "fast-forward");
  assert.equal(receipt.followRefusal, null);
  assert.equal(rawGit(root, ["rev-parse", "refs/heads/main"]), trunk, "the local target followed the trunk");
  assert.equal(rawGit(root, ["show", "HEAD:src/a.ts"]), "export const a = 1;");
  const landed = manager.status(workspaceId);
  assert.equal(landed.state, "merged");
  assert.equal(forgeStateOf(landed).land, null);
  assert.equal(existsSync(record.lease.worktreePath), false, "the worktree is gone");
  assert.equal(rawGit(root, ["branch", "--list", record.lease.branch!]), "", "the local branch is gone (the forge's is the forge's)");
  assert.deepEqual(await manager.land(workspaceId), receipt, "a landed workspace answers its receipt");
});

test("land preconditions: validated, published, ready, and nothing unpublished — each refused before the forge is asked", async () => {
  const { root } = initTempRepo("ws-land-pre");
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir("ws-land-pre-wt")) });
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/a.ts", "export const a = 1;\n");
  await assert.rejects(() => manager.land(record.workspaceId), throwsCode("workspace_land_precondition_failed"));
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  await assert.rejects(() => manager.land(record.workspaceId), throwsCode("workspace_not_published"));
  await manager.publish(record.workspaceId);
  await assert.rejects(() => manager.land(record.workspaceId), throwsCode("workspace_not_ready"));
  await manager.ready(record.workspaceId);
  commitFile(record.lease.worktreePath, "src/b.ts", "export const b = 1;\n");
  await assert.rejects(() => manager.land(record.workspaceId), throwsCode("workspace_unpublished_commits"));
  const readOnly = await manager.create({ agentName: "reader", mode: "read-only", writeSet: [] });
  await assert.rejects(() => manager.land(readOnly.workspaceId), throwsCode("workspace_read_only"));
});

test("GUARD the published head: a head someone else pushed after ready is refused BEFORE the request — no enqueue, the record never merging — whether or not that head is queued", async () => {
  const fixture = await readyFixture("ws-land-moved");
  const { bare, manager, forge, head, workspaceId, branch } = fixture;
  const intruder = forgeCommit(bare, head, "a reviewer's suggestion");
  rawGit(bare, ["update-ref", `refs/heads/${branch}`, intruder, head]);
  await assert.rejects(() => manager.land(workspaceId), throwsCode("workspace_published_head_moved"));
  assert.equal(fixture.enqueues(), 0, "the forge was never asked");
  // The intruder's head queued by someone else: still refused before anything, never waited on.
  assert.equal((await forge.enqueue(1, { expectedHeadSha: intruder })).kind, "enqueued");
  forge.calls.length = 0;
  await assert.rejects(() => manager.land(workspaceId), throwsCode("workspace_published_head_moved"));
  assert.equal(fixture.enqueues(), 0);
  assert.equal(manager.status(workspaceId).state, "validating");
  assert.ok(!fixture.states().includes("merging"), "the record never named a land");
});

test("GUARD the pull request's state: a pull request closed on the forge is refused before the request, never queued", async () => {
  const fixture = await readyFixture("ws-land-closed");
  const { manager, forge, workspaceId } = fixture;
  forge.pulls.get(1)!.state = "closed";
  await assert.rejects(() => manager.land(workspaceId), throwsCode("workspace_pull_request_closed"));
  assert.equal(fixture.enqueues(), 0);
  assert.ok(!fixture.states().includes("merging"));
});

test("GUARD the pull request's base: a pull request whose base was changed away from the trunk is refused by land and by ready — a merge into another branch is no land", async () => {
  const fixture = await readyFixture("ws-land-base");
  const { manager, forge, workspaceId } = fixture;
  forge.pulls.get(1)!.base = "side";
  await assert.rejects(() => manager.land(workspaceId), throwsCode("workspace_pull_request_base_mismatch"));
  await assert.rejects(() => manager.ready(workspaceId), throwsCode("workspace_pull_request_base_mismatch"));
  assert.equal(fixture.enqueues(), 0);
  assert.ok(!fixture.states().includes("merging"));
});

test("GUARD a landed workspace answers only its OWN version's land receipt: a record holding an older version's receipt is never answered as this version's", async () => {
  const fixture = await readyFixture("ws-land-receipt-version");
  const { root, manager, forge, workspaceId } = fixture;
  fixture.onWait(() => {
    forge.runQueue(1);
  });
  const receipt = await manager.land(workspaceId);
  const store = createWorkspaceRecordStore(workspaceRecordStores(registryOf(root)));
  const landed = store.load(workspaceId)!;
  const [olderVersion] = OLDER_WORKSPACE_SCHEMA_VERSIONS;
  store.save(deepFreeze({ ...landed, mergeReceipt: { ...receipt, schemaVersion: olderVersion } }) as typeof landed);
  await assert.rejects(() => manager.land(workspaceId), throwsCode("workspace_land_precondition_failed"), "an older receipt is not this version's answer");
});

test("a pull request already queued at the published head (another tool queued it) is waited on, never queued twice", async () => {
  const fixture = await readyFixture("ws-land-queued");
  const { manager, forge, head, workspaceId } = fixture;
  assert.equal((await forge.enqueue(1, { expectedHeadSha: head })).kind, "enqueued");
  forge.calls.length = 0;
  fixture.onWait(() => {
    forge.runQueue(1);
  });
  assert.equal((await manager.land(workspaceId)).landedHead, head);
  assert.equal(fixture.enqueues(), 0);
});

test("GUARD the changed set at land: judged against the trunk as the forge holds it now — a trunk rewound under the workspace makes paths outside the write set part of the land, refused as a conflict before the request", async () => {
  const { root, bare, baseSha } = initTempRepo("ws-land-escape");
  commitFile(root, "docs/x.md", "landed earlier\n");
  rawGit(root, ["push", "-q", "origin", "main"]);
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir("ws-land-escape-wt")) });
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/a.ts", "export const a = 1;\n");
  await manager.publish(record.workspaceId);
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  await manager.ready(record.workspaceId);
  rawGit(bare, ["update-ref", "refs/heads/main", baseSha]);
  await assert.rejects(() => manager.land(record.workspaceId), (error: unknown) =>
    error instanceof WorkspaceConflictError && error.report.conflicts.some((conflict) => conflict.path === "docs/x.md"));
  assert.equal(forgeAt(bare).calls.filter((call) => call.op === "enqueue").length, 0);
  assert.equal(manager.status(record.workspaceId).state, "active");
});

test("PROBE P1: a forge that answers it queued another head than the one asked for is refused (workspace_land_foreign_head): no wait, no receipt", async () => {
  const fixture = await readyFixture("ws-land-p1");
  const { bare, manager, forge, head, workspaceId } = fixture;
  forge.answerEnqueueAt(forgeCommit(bare, head, "not the published head"));
  await assert.rejects(() => manager.land(workspaceId), throwsCode("workspace_land_foreign_head"));
  const record = manager.status(workspaceId);
  assert.equal(record.state, "active");
  assert.equal(record.mergeReceipt, null);
  assert.equal(forgeStateOf(record).land, null);
  assert.ok(existsSync(record.lease.worktreePath), "nothing was torn down");
});

test("PROBE P2: a queue that merged another head than the published one is refused (workspace_land_foreign_head): no local follow, no receipt, the worktree kept", async () => {
  const fixture = await readyFixture("ws-land-p2");
  const { root, bare, manager, forge, head, workspaceId } = fixture;
  const localMain = rawGit(root, ["rev-parse", "refs/heads/main"]);
  fixture.onWait(() => {
    forge.runQueue(1, forgeCommit(bare, head, "a head nobody published"));
  });
  await assert.rejects(() => manager.land(workspaceId), throwsCode("workspace_land_foreign_head"));
  const record = manager.status(workspaceId);
  assert.equal(record.state, "active");
  assert.equal(record.mergeReceipt, null);
  assert.equal(rawGit(root, ["rev-parse", "refs/heads/main"]), localMain, "the local target did not follow");
  assert.ok(existsSync(record.lease.worktreePath));
});

test("GUARD the trunk holds the merge: a merge the forge reports that the trunk does not hold is unconfirmed — no receipt, the land still in flight (retriable)", async () => {
  const fixture = await readyFixture("ws-land-unconfirmed");
  const { bare, manager, forge, head, workspaceId } = fixture;
  // A real merge of the published head, which the trunk does not hold.
  const base = rawGit(bare, ["rev-parse", "refs/heads/main"]);
  const merge = rawGit(bare, ["commit-tree", rawGit(bare, ["rev-parse", `${head}^{tree}`]), "-p", base, "-p", head, "-m", "a merge off the trunk"]);
  fixture.onWait(() => {
    Object.assign(forge.pulls.get(1)!, { merged: true, mergeCommitSha: merge, state: "closed", queuedHead: null });
  });
  await assert.rejects(() => manager.land(workspaceId), throwsCode("workspace_land_unconfirmed"));
  const record = manager.status(workspaceId);
  assert.equal(record.state, "merging");
  assert.equal(record.mergeReceipt, null);
  assert.deepEqual(forgeStateOf(record).land, { head });
});

test("the queue's own verdicts: a pull request dropped from the queue, or whose head moved while queued, ends the land (the record active); a refused enqueue returns it to validating", async () => {
  const dropped = await readyFixture("ws-land-dropped");
  dropped.onWait(() => {
    dropped.forge.dropFromQueue(1);
  });
  await assert.rejects(() => dropped.manager.land(dropped.workspaceId), throwsCode("workspace_land_dequeued"));
  assert.equal(dropped.manager.status(dropped.workspaceId).state, "active");

  const moved = await readyFixture("ws-land-moved-queued");
  moved.onWait(() => {
    rawGit(moved.bare, ["update-ref", `refs/heads/${moved.branch}`, forgeCommit(moved.bare, moved.head, "pushed while queued")]);
  });
  await assert.rejects(() => moved.manager.land(moved.workspaceId), throwsCode("workspace_published_head_moved"));
  assert.equal(moved.manager.status(moved.workspaceId).state, "active");

  const refused = await readyFixture("ws-land-refused");
  refused.forge.pulls.get(1)!.draft = true;
  await assert.rejects(() => refused.manager.land(refused.workspaceId), throwsCode("workspace_enqueue_refused"));
  assert.equal(refused.manager.status(refused.workspaceId).state, "validating");
  assert.equal(forgeStateOf(refused.manager.status(refused.workspaceId)).land, null);
});

test("a land not merged within its wait budget stays merging (workspace_land_pending); land resumes the wait without a second request, and recover looks once", async () => {
  const { root, bare } = initTempRepo("ws-land-pending");
  const config = makeTestConfig(mkWorkspaceTempDir("ws-land-pending-wt"), { landing: { pollIntervalMs: 1, timeoutMs: 1 } });
  const { manager } = makeManager(root, { config, sleep: () => new Promise((done) => { setTimeout(done, 5); }) });
  const forge = forgeAt(bare);
  const record = await manager.create({ agentName: "writer", mode: "feature", writeSet: ["src"] });
  commitFile(record.lease.worktreePath, "src/a.ts", "export const a = 1;\n");
  await manager.publish(record.workspaceId);
  assert.equal((await manager.validate(record.workspaceId)).status, "pass");
  await manager.ready(record.workspaceId);
  await assert.rejects(() => manager.land(record.workspaceId), throwsCode("workspace_land_pending"));
  assert.equal(manager.status(record.workspaceId).state, "merging");
  await assert.rejects(() => manager.abort(record.workspaceId), throwsCode("workspace_abort_denied"), "a land in flight is never aborted under the queue");
  assert.equal((await manager.recover(record.workspaceId)).state, "merging", "still queued: recover leaves it");
  forge.runQueue(1);
  const receipt = await manager.land(record.workspaceId);
  assert.equal(receipt.kind, "land");
  assert.equal(forge.calls.filter((call) => call.op === "enqueue").length, 1, "one request for the whole land");
});

test("GUARD finishing is idempotent: a recover that finished the land between the land's read and its finish leaves the land its receipt, torn down once", async () => {
  const fixture = await readyFixture("ws-land-idempotent");
  const { root, config, forge, workspaceId } = fixture;
  const other = makeManager(root, { config }).manager;
  let raced = false;
  // The land's read sees the merge; before it finishes, a recover elsewhere finishes it.
  const racing: WorkspaceForgeFactory = (target) => {
    const real = forgeAt(target.remoteUrl);
    return { ...real, pullRequest: async (number) => {
      const read = await real.pullRequest(number);
      if (read.merged && !raced && other.status(workspaceId).state === "merging") {
        raced = true;
        await other.recover(workspaceId);
      }
      return read;
    } };
  };
  assert.equal((await forge.enqueue(1, { expectedHeadSha: fixture.head })).kind, "enqueued");
  forge.runQueue(1);
  const { manager } = makeManager(root, { config, forge: racing });
  const receipt = await manager.land(workspaceId);
  assert.ok(raced, "the recover ran between the read and the finish");
  assert.equal(manager.status(workspaceId).state, "merged");
  assert.deepEqual(manager.status(workspaceId).mergeReceipt, receipt, "the one receipt the recover wrote");
});

test("a local target that holds commits the trunk does not is not moved: the land is receipted with the follow refused, named", async () => {
  const fixture = await readyFixture("ws-land-follow-refused");
  const { root, manager, forge, workspaceId } = fixture;
  commitFile(root, "docs/local-only.md", "a local commit\n");
  const localMain = rawGit(root, ["rev-parse", "refs/heads/main"]);
  fixture.onWait(() => {
    forge.runQueue(1);
  });
  const receipt = await manager.land(workspaceId);
  assert.equal(receipt.follow, "refused");
  assert.match(receipt.followRefusal ?? "", /holds commits the trunk/u);
  assert.equal(rawGit(root, ["rev-parse", "refs/heads/main"]), localMain);
  assert.equal(manager.status(workspaceId).state, "merged", "the land happened on the forge: it is receipted");
});

test("abort closes the workspace's open pull request (its branch kept)", async () => {
  const fixture = await readyFixture("ws-land-abort");
  const { bare, manager, forge, workspaceId, branch, head } = fixture;
  await manager.abort(workspaceId, { reason: "superseded" });
  const pull = forge.pulls.get(1)!;
  assert.equal(pull.state, "closed");
  assert.match(pull.comments.at(-1) ?? "", /ended: superseded\. Its branch is kept\./u);
  assert.equal(rawGit(bare, ["rev-parse", `refs/heads/${branch}`]), head);
});

/**
 * Another pull request in the forge's merge queue (ahead of this one): a
 * commit on `main`'s base writing each of `files`, pushed as its own branch,
 * opened, readied and queued — as another lane's land would leave it.
 */
async function queueAnotherPullRequest(fixture: Awaited<ReturnType<typeof readyFixture>>, files: Readonly<Record<string, string>>, branch = "another-lane"): Promise<number> {
  const { bare, baseSha, forge } = fixture;
  const scratch = mkWorkspaceTempDir(`ws-queue-${branch}`);
  rawGit(scratch, ["clone", "-q", bare, "."]);
  rawGit(scratch, ["checkout", "-q", "-b", branch, baseSha]);
  for (const [path, text] of Object.entries(files)) commitFile(scratch, path, text, `Another lane's ${path}`);
  rawGit(scratch, ["push", "-q", "origin", `${branch}:${branch}`]);
  const pull = await forge.openDraftPullRequest({ head: branch, base: "main", title: branch, body: "" });
  await forge.markReadyForReview(pull.number);
  const answer = await forge.enqueue(pull.number, { expectedHeadSha: rawGit(bare, ["rev-parse", `refs/heads/${branch}`]) });
  assert.equal(answer.kind, "enqueued", "the other pull request is in the queue (liveness)");
  return pull.number;
}

test("QUEUE PREFLIGHT: a pull request that conflicts with one ahead of it in the merge queue is refused BEFORE the queue — never enqueued, the record untouched, the conflict named", async () => {
  const fixture = await readyFixture("ws-queue-conflict");
  const { manager, forge, workspaceId } = fixture;
  const before = manager.status(workspaceId);
  // The same file, different bytes: the queue would merge #2, then drop this one.
  const ahead = await queueAnotherPullRequest(fixture, { "src/a.ts": "export const a = 2;\n" });
  const enqueuesBefore = fixture.enqueues();
  await assert.rejects(() => manager.land(workspaceId), (error: unknown) => {
    assert.ok(throwsCode("workspace_queue_conflict")(error), String(error));
    assert.match(String((error as Error).message), new RegExp(`conflicts with the merge queue ahead of it \\(#${String(ahead)}\\) in src/a\\.ts`, "u"));
    return true;
  });
  assert.equal(fixture.enqueues(), enqueuesBefore, "no enqueue: the queue was never entered");
  assert.ok(forge.calls.some((call) => call.op === "mergeQueue"), "the queue was read");
  // The preflight is read-only and runs before the record moves: nothing to recover, nothing to misread as a dequeue.
  assert.equal(manager.status(workspaceId).state, before.state, "the record never moved");
  assert.equal(manager.status(workspaceId).history.length, before.history.length);
  assert.equal(forgeStateOf(manager.status(workspaceId)).land, null);
});

test("QUEUE PREFLIGHT: a preflight the forge cannot answer leaves the workspace as it was — never merging with nothing queued", async () => {
  const fixture = await readyFixture("ws-queue-unanswered");
  const { manager, forge, workspaceId } = fixture;
  const before = manager.status(workspaceId);
  forge.failMergeQueueWith(new HarnessError("network down", "forge_unreachable", true));
  await assert.rejects(() => manager.land(workspaceId), /network down/u);
  assert.equal(fixture.enqueues(), 0);
  assert.equal(manager.status(workspaceId).state, before.state, "the record never moved: recover has nothing to misread");
  assert.equal(forgeStateOf(manager.status(workspaceId)).land, null);
});

test("QUEUE PREFLIGHT: the queue is read in its own order, and an entry that conflicts with the entries ahead of it is passed over, never used as a base", async () => {
  // #2 writes src/d.ts; #3 writes src/d.ts too (so it conflicts with #2: the queue will drop it) and src/a.ts
  // (which conflicts with this workspace's src/a.ts). In the queue's order [#2, #3], #3 is passed over and this
  // pull request merges cleanly onto main + #2: it is enqueued. Read in the other order, or with #3's
  // conflicting merge used as a base, the preflight would wrongly refuse it on src/a.ts.
  const fixture = await readyFixture("ws-queue-order");
  const { manager, forge, workspaceId, head } = fixture;
  const second = await queueAnotherPullRequest(fixture, { "src/d.ts": "export const d = 2;\n" }, "lane-two");
  const third = await queueAnotherPullRequest(fixture, { "src/d.ts": "export const d = 3;\n", "src/a.ts": "export const a = 3;\n" }, "lane-three");
  assert.deepEqual((await forge.mergeQueue("main")).map((entry) => entry.number), [second, third], "the queue's order (liveness)");
  fixture.onWait(() => {
    forge.dropFromQueue(1);
  });
  await assert.rejects(() => manager.land(workspaceId));
  assert.deepEqual(forge.calls.filter((call) => call.op === "enqueue" && (call.request as { number: number }).number === 1).map((call) => call.request), [{ number: 1, expectedHeadSha: head }],
    "enqueued: the entry that conflicts with the queue ahead of it was passed over");
});

test("QUEUE PREFLIGHT: a queue ahead that touches other files is no conflict — the pull request is enqueued", async () => {
  const fixture = await readyFixture("ws-queue-clean");
  const { manager, forge, workspaceId, head } = fixture;
  await queueAnotherPullRequest(fixture, { "src/other.ts": "export const other = 1;\n" });
  fixture.onWait(() => {
    forge.dropFromQueue(1);
  });
  await assert.rejects(() => manager.land(workspaceId));
  assert.deepEqual(forge.calls.filter((call) => call.op === "enqueue" && (call.request as { number: number }).number === 1).map((call) => call.request), [{ number: 1, expectedHeadSha: head }], "enqueued at its head: the queue ahead merges cleanly with it");
});
