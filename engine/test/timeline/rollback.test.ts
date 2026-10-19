import assert from "node:assert/strict";
import { rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { canonicalHash, sha256 } from "../../src/kernel/integrity.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder, type TimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createRollbackController, type FileEffectRestorer } from "../../src/timeline/rollback.ts";
import { mkTempDir } from "../support/temp-dir.ts";
import { makeTimelineEventInput } from "../support/timeline.ts";
import { TIMELINE_FILE_EFFECT_DOCUMENT } from "../../src/timeline/timeline-types.ts";

const VALID_HASH = "a".repeat(64);
const VALID_HASH_B = "b".repeat(64);

function mkRecorder(dir: string, ledgerId = "ledger-rb"): TimelineRecorder {
  const store = createTimelineStore({
    path: join(dir, `rb-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
    ledgerId,
  });
  return createTimelineRecorder({ store });
}

/** A file effect's documents as the recorder writes them: its effect document (with the pre-image digest it recorded) and the pre-image. */
function fileEffectDocuments(preimage: string, recordedPreimage = preimage) {
  const effect = JSON.stringify({ path: "fixture.txt", operation: "write", preimageDigest: sha256(recordedPreimage), postimageDigest: VALID_HASH });
  return [
    { name: TIMELINE_FILE_EFFECT_DOCUMENT, contentJson: effect, contentDigest: sha256(effect) },
    { name: "preimage", contentJson: preimage, contentDigest: sha256(preimage) },
  ];
}

function mkFileRestorer(filePath: string, restoreContent: string): FileEffectRestorer {
  return Object.freeze({
    canRestore: () => true,
    restore: () => {
      try {
        writeFileSync(filePath, restoreContent);
        return true;
      } catch {
        return false;
      }
    },
  });
}

// ========== Plan tests ==========

test("rollback: plan for empty timeline returns no effects", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    const rb = rec.rollback;
    const plan = rb.plan({ targetSequence: "0" });
    assert.equal(plan.effects.length, 0);
    assert.equal(plan.reversibleCount, 0);
    assert.equal(plan.irreversibleCount, 0);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: plan identifies reversible file effects", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    rec.recordFileEffect({
      effectId: "fx-1", path: "/test/file.txt", operation: "write",
      preimageDigest: VALID_HASH, postimageDigest: VALID_HASH_B,
      description: "write file.txt", correlation: {},
    });
    const plan = rec.rollback.plan({ targetSequence: "0" });
    // `recordFileEffect` writes a standalone `event` record. The planner used
    // to scan only `terminal` records, so this asserted 0 — a test that
    // certified the defect under a name that promised the opposite.
    assert.equal(plan.effects.length, 1, "a recorded file effect must be visible to the planner");
    assert.equal(plan.effects[0]!.eventType, "file-effect");
    assert.equal(plan.effects[0]!.rollbackKind, "file-effect");
    assert.equal(plan.effects[0]!.reversible, true);
    assert.equal(plan.reversibleCount, 1);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: plan includes terminal records after target sequence", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    rec.beginEffect({
      effectId: "fx-1", kind: "filesystem",
      actor: { kind: "harness", id: "test" },
      description: "write", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH });
    rec.beginEffect({
      effectId: "fx-2", kind: "filesystem",
      actor: { kind: "harness", id: "test" },
      description: "write 2", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-2", { outcome: "succeeded", resultHash: VALID_HASH });
    const plan = rec.rollback.plan({ targetSequence: "2" });
    // After sequence 2 (intent+terminal for fx-1), the next events are intent+terminal for fx-2
    // Only terminal records are counted as effects
    assert.ok(plan.effects.length >= 1);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: plan classifies irreversible effects", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    rec.beginEffect({
      effectId: "fx-prov", kind: "provider",
      actor: { kind: "harness", id: "test" },
      description: "api call", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-prov", { outcome: "succeeded", resultHash: VALID_HASH });
    const plan = rec.rollback.plan({ targetSequence: "0" });
    assert.ok(plan.irreversibleCount >= 1);
    const prov = plan.irreversibleEffects.find((e) => e.eventType === "provider");
    assert.ok(prov !== undefined);
    assert.ok(prov.reason !== undefined);
    assert.ok(prov.reason!.includes("irreversible"));
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Execute tests ==========

test("rollback: execute with no effects returns zero restored", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    const result = rec.rollback.execute({ targetSequence: "0" });
    assert.equal(result.restoredCount, 0);
    assert.equal(result.skippedCount, 0);
    assert.equal(result.failedCount, 0);
    assert.ok(result.rollbackEventId.length > 0);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: execute appends a rollback event to the timeline", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    const countBefore = rec.store.count();
    rec.rollback.execute({ targetSequence: "0" });
    const countAfter = rec.store.count();
    assert.equal(countAfter, countBefore + 2);
    const rollbackEvents = rec.store.query({ eventType: "rollback", recordKind: "terminal" });
    assert.equal(rollbackEvents.length, 1);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: file effect is restored via FileEffectRestorer", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const filePath = join(dir, "test.txt");
    writeFileSync(filePath, "old content");
    const rec = mkRecorder(dir);
    rec.recordFileEffect({
      effectId: "fx-1", path: filePath, operation: "write",
      preimageDigest: sha256("old content"),
      postimageDigest: sha256("new content"),
      description: "write file",
      correlation: {},
      preimageContent: "old content",
    });
    // Overwrite the file to simulate the effect having happened.
    writeFileSync(filePath, "new content");
    const restorer = mkFileRestorer(filePath, "old content");
    const rb = createRollbackController(rec.store);
    const result = rb.execute({
      targetSequence: "0",
      fileRestorer: restorer,
    });
    // A recorded file effect is a standalone `event` record. The planner used
    // to scan only `terminal` records, so this asserted 0 restored — the
    // defect, certified by a test whose name promised restoration.
    assert.equal(result.restoredCount, 1, "the recorded file effect must be restorable");
    assert.equal(result.failedCount, 0);
    assert.equal(readFileSync(filePath, "utf8"), "old content", "the preimage must be back on disk");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: original evidence is preserved after rollback", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    rec.beginEffect({
      effectId: "fx-1", kind: "filesystem",
      actor: { kind: "harness", id: "test" },
      description: "write", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH });
    const eventCountBefore = rec.store.count();
    rec.rollback.execute({ targetSequence: "0" });
    const eventCountAfter = rec.store.count();
    // Original events are preserved, rollback event is added
    assert.equal(eventCountAfter, eventCountBefore + 2);
    // The original intent and terminal are still there
    const intents = rec.store.query({ recordKind: "intent" });
    assert.equal(intents.filter((event) => event.eventType !== "rollback").length, 1);
    const terminals = rec.store.query({ recordKind: "terminal" });
    assert.equal(terminals.filter((event) => event.eventType !== "rollback").length, 1);
    // The rollback event is added
    const rollbacks = rec.store.query({ eventType: "rollback", recordKind: "terminal" });
    assert.equal(rollbacks.length, 1);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: rollback event has rolled-back-by edges to restored events", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    // Two reversible effects in two different record kinds: a standalone
    // `event` (what `recordEvent`/`recordFileEffect` produce) and an
    // intent+terminal pair. BOTH must be restored and BOTH must get an edge —
    // the planner used to see only the terminal.
    rec.recordEvent({ eventType: "test", description: "test run", correlation: {} });
    const store = rec.store;
    store.appendIntent({
      eventId: "evt-intent-1", ledgerId: store.ledgerId,
      eventType: "file-effect", effectKind: "filesystem", effectId: "fx-1",
      actor: { kind: "harness", id: "test" },
      description: "file write", intentHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:00.000Z",
    });
    store.appendTerminal({
      eventId: "evt-term-1", ledgerId: store.ledgerId,
      eventType: "file-effect", effectId: "fx-1",
      documents: fileEffectDocuments("old"),
      outcome: "succeeded", resultHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:01.000Z",
    });
    const rb = createRollbackController(store);
    const result = rb.execute({
      targetSequence: "0",
      fileRestorer: Object.freeze({ canRestore: () => true, restore: () => true }),
    });
    assert.equal(result.restoredCount, 2, "both the standalone event and the terminal are restorable");
    const rollbackEvent = store.getEvent(result.rollbackEventId);
    assert.ok(rollbackEvent !== undefined);
    const rolledBack = rollbackEvent.edges.filter((e) => e.edgeType === "rolled-back-by");
    assert.equal(rolledBack.length, 2, "every restored effect gets an edge");
    const targets = rolledBack.map((e) => e.targetEventId);
    assert.ok(targets.includes("evt-term-1"), `terminal must be linked, got ${targets.join(", ")}`);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: chain remains valid after rollback", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    rec.beginEffect({
      effectId: "fx-1", kind: "filesystem",
      actor: { kind: "harness", id: "test" },
      description: "write", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH });
    rec.rollback.execute({ targetSequence: "0" });
    const result = rec.verifyTimelineChain();
    assert.equal(result.valid, true);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: irreversible effects are skipped with typed reason", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    rec.beginEffect({
      effectId: "fx-prov", kind: "provider",
      actor: { kind: "harness", id: "test" },
      description: "api call", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-prov", { outcome: "succeeded", resultHash: VALID_HASH });
    const result = rec.rollback.execute({ targetSequence: "0" });
    assert.ok(result.skippedCount >= 1);
    assert.equal(result.failedCount, 0);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: failed restoration is recorded", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    const store = rec.store;
    store.appendIntent({
      eventId: "evt-intent-1", ledgerId: store.ledgerId,
      eventType: "file-effect", effectKind: "filesystem", effectId: "fx-1",
      actor: { kind: "harness", id: "test" },
      description: "file write", intentHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:00.000Z",
    });
    store.appendTerminal({
      eventId: "evt-term-1", ledgerId: store.ledgerId,
      eventType: "file-effect", effectId: "fx-1",
      documents: fileEffectDocuments("old"),
      outcome: "succeeded", resultHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:01.000Z",
    });
    const rb = createRollbackController(store);
    const result = rb.execute({
      targetSequence: "0",
      fileRestorer: Object.freeze({ canRestore: () => false, restore: () => false }),
    });
    assert.equal(result.restoredCount, 0);
    assert.equal(result.failedCount, 1);
    assert.equal(result.failedEffects.length, 1);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: no fileRestorer means file effects fail", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    const store = rec.store;
    store.appendIntent({
      eventId: "evt-intent-1", ledgerId: store.ledgerId,
      eventType: "file-effect", effectKind: "filesystem", effectId: "fx-1",
      actor: { kind: "harness", id: "test" },
      description: "file write", intentHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:00.000Z",
    });
    store.appendTerminal({
      eventId: "evt-term-1", ledgerId: store.ledgerId,
      eventType: "file-effect", effectId: "fx-1",
      outcome: "succeeded", resultHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:01.000Z",
    });
    const rb = createRollbackController(store);
    const result = rb.execute({ targetSequence: "0" });
    assert.equal(result.restoredCount, 0);
    assert.equal(result.failedCount, 1);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: canRollback identifies reversible terminal records", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    const store = rec.store;
    store.appendIntent({
      eventId: "origin-fx-1", ledgerId: store.ledgerId, eventType: "file-effect",
      effectKind: "file-effect", effectId: "fx-1", actor: { kind: "harness", id: "test" },
      description: "planned file-effect", intentHash: VALID_HASH, wallTime: "2026-01-01T00:00:00.000Z",
    });
    store.appendTerminal({
      eventId: "evt-term-1", ledgerId: store.ledgerId,
      eventType: "file-effect", effectId: "fx-1",
      outcome: "succeeded", resultHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:01.000Z",
    });
    const event = store.getEvent("evt-term-1");
    assert.ok(event !== undefined);
    assert.equal(rec.rollback.canRollback(event!), true);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: canRollback accepts a standalone effect record and rejects a bare intent", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    const store = rec.store;
    // A standalone `event` record — the kind `recordFileEffect` writes. This
    // used to be rejected, which is what made recorded file writes
    // structurally un-rollbackable.
    store.appendEvent({
      eventId: "evt-1", ledgerId: store.ledgerId, eventType: "file-effect",
      actor: { kind: "harness", id: "test" },
      description: "file write", wallTime: "2026-01-01T00:00:00.000Z",
    });
    const standalone = store.getEvent("evt-1");
    assert.ok(standalone !== undefined);
    assert.equal(
      rec.rollback.canRollback(standalone!),
      true,
      "a recorded file effect must be rollback-able",
    );

    // An `intent` is the non-completing half of a pair: its terminal
    // represents the effect, so counting the intent would double-count it.
    store.appendIntent({
      eventId: "evt-intent-x", ledgerId: store.ledgerId,
      eventType: "file-effect", effectKind: "filesystem", effectId: "fx-x",
      actor: { kind: "harness", id: "test" },
      description: "pending write", intentHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:02.000Z",
    });
    const intent = store.getEvent("evt-intent-x");
    assert.ok(intent !== undefined);
    assert.equal(rec.rollback.canRollback(intent!), false, "a bare intent is not a completed effect");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: canRollback rejects irreversible event types", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    const store = rec.store;
    store.appendIntent({
      eventId: "origin-fx-1", ledgerId: store.ledgerId, eventType: "provider",
      effectKind: "provider", effectId: "fx-1", actor: { kind: "harness", id: "test" },
      description: "planned provider", intentHash: VALID_HASH, wallTime: "2026-01-01T00:00:00.000Z",
    });
    store.appendTerminal({
      eventId: "evt-term-1", ledgerId: store.ledgerId,
      eventType: "provider", effectId: "fx-1",
      outcome: "succeeded", resultHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:01.000Z",
    });
    const event = store.getEvent("evt-term-1");
    assert.ok(event !== undefined);
    assert.equal(rec.rollback.canRollback(event!), false);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: rollback preserves timeline append-only invariant", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    rec.beginEffect({
      effectId: "fx-1", kind: "filesystem",
      actor: { kind: "harness", id: "test" },
      description: "write", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH });
    const idOfFirstIntent = rec.store.query({ recordKind: "intent" })[0]!.eventId;
    rec.rollback.execute({ targetSequence: "0" });
    // The original intent should still be there and unchanged
    const intent = rec.store.getEvent(idOfFirstIntent);
    assert.ok(intent !== undefined);
    assert.equal(intent?.recordKind, "intent");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: rollback of rollback creates a second rollback event", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    rec.beginEffect({
      effectId: "fx-1", kind: "filesystem",
      actor: { kind: "harness", id: "test" },
      description: "write", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH });
    rec.rollback.execute({ targetSequence: "0", description: "first rollback" });
    const firstRbCount = rec.store.query({ eventType: "rollback", recordKind: "terminal" }).length;
    assert.equal(firstRbCount, 1);
    // Rollback again — this should create a second rollback event
    // The first rollback event is recordKind=event, not terminal, so it won't be in the effects list
    rec.rollback.execute({ targetSequence: "0", description: "second rollback" });
    const secondRbCount = rec.store.query({ eventType: "rollback", recordKind: "terminal" }).length;
    assert.equal(secondRbCount, 2);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: rollback plan documents contain plan info", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    rec.beginEffect({
      effectId: "fx-prov", kind: "provider",
      actor: { kind: "harness", id: "test" },
      description: "api call", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-prov", { outcome: "succeeded", resultHash: VALID_HASH });
    rec.rollback.execute({ targetSequence: "0" });
    const rollbackEvents = rec.store.query({ eventType: "rollback", recordKind: "terminal" });
    assert.equal(rollbackEvents.length, 1);
    assert.ok(rollbackEvents[0]!.documents.length >= 1);
    assert.equal(rollbackEvents[0]!.documents[0]!.name, "rollback-plan");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: custom actor and description", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    rec.rollback.execute({
      targetSequence: "0",
      actor: { kind: "user", id: "user-1", role: "admin" },
      description: "manual rollback by user",
    });
    const rollbackEvents = rec.store.query({ eventType: "rollback", recordKind: "terminal" });
    assert.equal(rollbackEvents[0]!.actorKind, "user");
    assert.equal(rollbackEvents[0]!.actorId, "user-1");
    assert.equal(rollbackEvents[0]!.actorRole, "admin");
    assert.equal(rec.store.getEvent(rollbackEvents[0]!.parentEventId!)!.description, "manual rollback by user");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: targetSequence 0 rolls back everything", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    rec.beginEffect({
      effectId: "fx-1", kind: "filesystem",
      actor: { kind: "harness", id: "test" },
      description: "write 1", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH });
    rec.beginEffect({
      effectId: "fx-2", kind: "filesystem",
      actor: { kind: "harness", id: "test" },
      description: "write 2", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-2", { outcome: "succeeded", resultHash: VALID_HASH });
    rec.beginEffect({
      effectId: "fx-3", kind: "filesystem",
      actor: { kind: "harness", id: "test" },
      description: "write 3", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-3", { outcome: "succeeded", resultHash: VALID_HASH });
    const plan = rec.rollback.plan({ targetSequence: "0" });
    assert.ok(plan.effects.length >= 3); // at least 3 terminal records
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: test and checkpoint types are reversible without restorer", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    const store = rec.store;
    store.appendIntent({
      eventId: "origin-fx-1", ledgerId: store.ledgerId, eventType: "test",
      effectKind: "test", effectId: "fx-1", actor: { kind: "harness", id: "test" },
      description: "planned test", intentHash: VALID_HASH, wallTime: "2026-01-01T00:00:00.000Z",
    });
    store.appendTerminal({
      eventId: "evt-term-1", ledgerId: store.ledgerId,
      eventType: "test", effectId: "fx-1",
      outcome: "succeeded", resultHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:01.000Z",
    });
    store.appendIntent({
      eventId: "origin-fx-2", ledgerId: store.ledgerId, eventType: "checkpoint",
      effectKind: "checkpoint", effectId: "fx-2", actor: { kind: "harness", id: "test" },
      description: "planned checkpoint", intentHash: VALID_HASH, wallTime: "2026-01-01T00:00:00.000Z",
    });
    store.appendTerminal({
      eventId: "evt-term-2", ledgerId: store.ledgerId,
      eventType: "checkpoint", effectId: "fx-2",
      outcome: "succeeded", resultHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:02.000Z",
    });
    const result = rec.rollback.execute({ targetSequence: "0" });
    assert.equal(result.restoredCount, 2);
    assert.equal(result.failedCount, 0);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: rollback result has correct plan reference", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    const result = rec.rollback.execute({ targetSequence: "0" });
    assert.ok(result.plan !== undefined);
    assert.equal(result.plan.targetSequence, "0");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Additional hostile and edge case tests ==========

test("rollback: invalid target sequence is rejected", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    assert.throws(
      () => rec.rollback.plan({ targetSequence: "abc" }),
      /Timeline sequence is invalid/,
    );
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: negative target sequence is rejected", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    assert.throws(
      () => rec.rollback.plan({ targetSequence: "-1" }),
      /Timeline sequence is invalid/,
    );
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: target sequence beyond current is empty plan", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    rec.beginEffect({
      effectId: "fx-1", kind: "filesystem",
      actor: { kind: "harness", id: "test" },
      description: "write", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH });
    const plan = rec.rollback.plan({ targetSequence: "100" });
    assert.equal(plan.effects.length, 0);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: rollback terminal is paired with the rollback ID", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    const result = rec.rollback.execute({ targetSequence: "0" });
    const rbEvent = rec.store.getEvent(result.rollbackEventId);
    assert.ok(rbEvent !== undefined);
    assert.ok(rbEvent?.effectId !== null);
    assert.equal(rbEvent?.effectId, result.rollbackId);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: rollback with file restorer that succeeds", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const filePath = join(dir, "file.txt");
    writeFileSync(filePath, "old");
    const rec = mkRecorder(dir);
    const store = rec.store;
    store.appendIntent({
      eventId: "evt-intent-1", ledgerId: store.ledgerId,
      eventType: "file-effect", effectKind: "filesystem", effectId: "fx-1",
      actor: { kind: "harness", id: "test" },
      description: "file write", intentHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:00.000Z",
    });
    store.appendTerminal({
      eventId: "evt-term-1", ledgerId: store.ledgerId,
      eventType: "file-effect", effectId: "fx-1",
      documents: fileEffectDocuments("old"),
      outcome: "succeeded", resultHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:01.000Z",
    });
    const restorer = Object.freeze({
      canRestore: () => true,
      restore: () => { writeFileSync(filePath, "old"); return true; },
    });
    const result = rec.rollback.execute({ targetSequence: "0", fileRestorer: restorer });
    assert.equal(result.restoredCount, 1);
    assert.equal(result.failedCount, 0);
    assert.equal(readFileSync(filePath, "utf8"), "old");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: git effects are classified as irreversible", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    const store = rec.store;
    store.appendIntent({
      eventId: "origin-fx-1", ledgerId: store.ledgerId, eventType: "git",
      effectKind: "git", effectId: "fx-1", actor: { kind: "harness", id: "test" },
      description: "planned git", intentHash: VALID_HASH, wallTime: "2026-01-01T00:00:00.000Z",
    });
    store.appendTerminal({
      eventId: "evt-term-1", ledgerId: store.ledgerId,
      eventType: "git", effectId: "fx-1",
      outcome: "succeeded", resultHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:01.000Z",
    });
    const plan = rec.rollback.plan({ targetSequence: "0" });
    const gitEffect = plan.irreversibleEffects.find((e) => e.eventType === "git");
    assert.ok(gitEffect !== undefined);
    assert.ok(gitEffect!.reason !== undefined);
    assert.ok(gitEffect!.reason!.includes("guarded git port"));
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: commit effects are classified as irreversible", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    const store = rec.store;
    store.appendIntent({
      eventId: "origin-fx-1", ledgerId: store.ledgerId, eventType: "commit",
      effectKind: "commit", effectId: "fx-1", actor: { kind: "harness", id: "test" },
      description: "planned commit", intentHash: VALID_HASH, wallTime: "2026-01-01T00:00:00.000Z",
    });
    store.appendTerminal({
      eventId: "evt-term-1", ledgerId: store.ledgerId,
      eventType: "commit", effectId: "fx-1",
      outcome: "succeeded", resultHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:01.000Z",
    });
    const plan = rec.rollback.plan({ targetSequence: "0" });
    assert.ok(plan.irreversibleCount >= 1);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: plan target sequence zero includes all terminals", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    for (let i = 0; i < 5; i++) {
      rec.beginEffect({
        effectId: `fx-${i}`, kind: "filesystem",
        actor: { kind: "harness", id: "test" },
        description: `write ${i}`, intentHash: VALID_HASH,
      });
      rec.endEffect(`fx-${i}`, { outcome: "succeeded", resultHash: VALID_HASH });
    }
    const plan = rec.rollback.plan({ targetSequence: "0" });
    assert.ok(plan.effects.length >= 5);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback: plan at specific sequence excludes earlier terminals", () => {
  const dir = mkTempDir("tl-rollback-test-");
  try {
    const rec = mkRecorder(dir);
    rec.beginEffect({
      effectId: "fx-1", kind: "filesystem",
      actor: { kind: "harness", id: "test" },
      description: "write 1", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH });
    // This is sequence 3 (intent=1, terminal=2, next intent=3)
    rec.beginEffect({
      effectId: "fx-2", kind: "filesystem",
      actor: { kind: "harness", id: "test" },
      description: "write 2", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-2", { outcome: "succeeded", resultHash: VALID_HASH });
    // Target sequence 2: only effects AFTER sequence 2 are included
    const plan = rec.rollback.plan({ targetSequence: "2" });
    // Only the second terminal (sequence 4) should be included
    assert.ok(plan.effects.length >= 1);
    // The first terminal (sequence 2) should NOT be included
    const firstTerm = plan.effects.find((e) => e.effectId === "fx-1");
    assert.equal(firstTerm, undefined);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


for (const withIrreversible of [false, true]) {
  test(`rollback: full plan reference and separate exact summary (${withIrreversible})`, () => {
    const dir = mkTempDir("tl-rollback-documents-"); const rec = mkRecorder(dir);
    try {
      if (withIrreversible) {
        rec.beginEffect({ effectId: "provider", kind: "provider", actor: { kind: "test", id: "author" }, description: "request", intentHash: VALID_HASH });
        rec.endEffect("provider", { outcome: "succeeded", resultHash: VALID_HASH });
      }
      const before = rec.store.query();
      const plan = rec.rollback.plan({ targetSequence: "0" });
      const result = rec.rollback.execute({ targetSequence: "0" });
      const event = rec.store.getEvent(result.rollbackEventId)!;
      const reference = event.documents.find((doc) => doc.name === "rollback-plan")!;
      assert.equal(reference.contentJson, null); assert.equal(reference.orderedJson, null);
      assert.equal(reference.contentDigest, canonicalHash({ ...plan, rollbackId: result.rollbackId }));
      const summary = event.documents.find((doc) => doc.name === "rollback-irreversible-effects");
      assert.equal(event.documents.length, withIrreversible ? 2 : 1);
      if (withIrreversible) {
        const expected = JSON.stringify(plan.irreversibleEffects.map((effect) => ({ eventId: effect.eventId, reason: effect.reason ?? "irreversible" })));
        assert.ok(summary); assert.equal(summary.contentJson, expected); assert.equal(summary.contentDigest, sha256(expected));
      } else assert.equal(summary, undefined);
      assert.deepEqual(rec.store.query().filter((row) => row.effectId !== result.rollbackId), before);
      assert.equal(rec.verifyTimelineChain().valid, true);
    } finally { rec.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const olderProtected of [false, true]) {
  test(`rollback: the plan covers every later event (more than a page) and restores each pre-image exactly (older pre-image protected=${olderProtected})`, async () => {
    const { registerKnownSecret } = await import("../../src/privacy/secret-intelligence.ts");
    const dir = mkTempDir("rollback-whole-plan-"); const file = join(dir, "restored.txt");
    const rec = mkRecorder(dir); const secret = "rollback_private_preimage_7P9wL2qR8v";
    registerKnownSecret(secret, "rollback-preflight-test");
    const old = olderProtected ? secret : "oldest exact bytes\0\r\n";
    let canRestore = 0, restored = 0;
    try {
      rec.recordFileEffect({ effectId: "old-file", path: file, operation: "write", preimageDigest: sha256(old), postimageDigest: VALID_HASH, preimageContent: old, description: "old effect", correlation: {} });
      for (let index = 0; index < 1000; index++) rec.recordEvent({ eventType: "turn", description: "intervening row", correlation: {} });
      rec.recordFileEffect({ effectId: "new-file", path: file, operation: "write", preimageDigest: sha256("intermediate"), postimageDigest: VALID_HASH, preimageContent: "intermediate", description: "new effect", correlation: {} });
      writeFileSync(file, "current bytes");
      const restorer: FileEffectRestorer = {
        canRestore: () => { canRestore++; return true; },
        restore: (effect) => { const preimage = effect.documents.find((doc) => doc.name === "preimage")!; writeFileSync(file, preimage.contentJson ?? preimage.orderedJson!); restored++; return true; },
      };
      // A pre-image holding a secret is stored masked (protected) and its
      // original sealed; the plan shows the masked text, the restorer gets the
      // exact bytes from the seal (a masked restore would corrupt the file).
      const [recorded] = rec.store.query({ eventType: "file-effect", limit: 1 });
      const stored = recorded!.documents.find((doc) => doc.name === "preimage")!;
      assert.equal(stored.projectionDisposition, olderProtected ? "protected" : "exact");
      assert.equal(stored.contentJson!.includes(secret), false);
      const result = rec.rollback.execute({ targetSequence: "0", fileRestorer: restorer });
      assert.equal(result.plan.effects.length, 1002); assert.equal(result.restoredCount, 2);
      assert.equal(canRestore, 2); assert.equal(restored, 2); assert.equal(readFileSync(file, "utf8"), old);
      assert.equal(JSON.stringify(result.plan).includes(secret), false, "the plan carries the masked projection, never the sealed original");
      const terminal = rec.store.getEvent(result.rollbackEventId)!;
      assert.equal(terminal.recordKind, "terminal"); assert.equal(terminal.outcome, "succeeded");
      assert.equal(rec.store.getEvent(terminal.parentEventId!)!.recordKind, "intent");
      assert.deepEqual(terminal.edges.map((edge) => edge.edgeType), ["rolled-back-by", "rolled-back-by"]);
      assert.equal(rec.store.verifyChain().valid, true);
    } finally { rec.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const refusedKind of ["intent", "terminal"] as const) {
  test(`rollback: ${refusedKind} ledger refusal preserves actual effect ordering and pending evidence`, async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = mkTempDir("rollback-admission-"); const path = join(dir, "timeline.db"), file = join(dir, "file.txt");
    const store = createTimelineStore({ path, ledgerId: "rollback-admission" }); const rec = createTimelineRecorder({ store });
    let callbacks = 0;
    try {
      rec.recordFileEffect({ effectId: "file", path: file, operation: "write", preimageDigest: sha256("old"), postimageDigest: sha256("new"), preimageContent: "old", description: "file effect", correlation: {} });
      writeFileSync(file, "new");
      const raw = new DatabaseSync(path);
      try { raw.exec(`CREATE TRIGGER refuse_rollback BEFORE INSERT ON event_log WHEN NEW.event_type='rollback' ${refusedKind === "terminal" ? "AND NEW.record_kind='terminal'" : ""} BEGIN SELECT RAISE(ABORT,'fixture ledger refusal'); END`); }
      finally { raw.close(); }
      assert.throws(() => rec.rollback.execute({ targetSequence: "0", fileRestorer: {
        canRestore: () => { callbacks++; return true; },
        restore: (effect) => { callbacks++; writeFileSync(file, effect.documents.find((doc) => doc.name === "preimage")!.contentJson!); return true; },
      } }), { code: "ERR_SQLITE_ERROR", errcode: 1811 });
      assert.equal(callbacks, refusedKind === "intent" ? 0 : 2);
      assert.equal(readFileSync(file, "utf8"), refusedKind === "intent" ? "new" : "old");
      const rows = store.query({ eventType: "rollback" });
      assert.equal(rows.length, refusedKind === "intent" ? 0 : 1);
      if (refusedKind === "terminal") { assert.equal(rows[0]!.recordKind, "intent"); assert.equal(rows[0]!.outcome, null); }
    } finally { rec.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const throwsAt of ["canRestore", "restore"] as const) {
  test(`rollback: ${throwsAt} exception retains the pending intent and actual file outcome`, () => {
    const dir = mkTempDir("rollback-callback-"); const file = join(dir, "file.txt"); const rec = mkRecorder(dir);
    const failure = new Error("fixture callback refusal"); let canCalls = 0, restoreCalls = 0;
    try {
      rec.recordFileEffect({ effectId: "file", path: file, operation: "write", preimageDigest: sha256("old"), postimageDigest: sha256("new"), preimageContent: "old", description: "write", correlation: {} });
      writeFileSync(file, "new");
      assert.throws(() => rec.rollback.execute({ targetSequence: "0", fileRestorer: {
        canRestore: () => { canCalls++; if (throwsAt === "canRestore") throw failure; return true; },
        restore: (effect) => { restoreCalls++; writeFileSync(file, effect.documents.find((doc) => doc.name === "preimage")!.contentJson!); throw failure; },
      } }), (error: unknown) => error === failure);
      assert.equal(canCalls, 1); assert.equal(restoreCalls, throwsAt === "restore" ? 1 : 0);
      assert.equal(readFileSync(file, "utf8"), throwsAt === "restore" ? "old" : "new");
      const rows = rec.store.query({ eventType: "rollback" }); assert.equal(rows.length, 1);
      const intent = rows[0]!; assert.equal(intent.recordKind, "intent"); assert.equal(intent.outcome, null);
      assert.equal(rec.store.getEvent(intent.eventId)?.effectId, intent.effectId);
      assert.equal(rec.store.verifyChain().valid, true);
    } finally { rec.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const unavailable of ["missing", "digest-only", "foreign-ledger"] as const) {
  test(`rollback: a ${unavailable} pre-image refuses before either callback or a new intent`, () => {
    const dir = mkTempDir("rollback-no-preimage-"); const rec = mkRecorder(dir); let calls = 0;
    try {
      rec.store.appendEvent({ ...makeTimelineEventInput(rec.store.ledgerId, "file-event", "file-effect"),
        documents: unavailable === "missing" ? [] : [{ name: "preimage", contentDigest: sha256("unretained bytes") }],
      });
      const before = rec.store.query();
      assert.throws(() => rec.rollback.execute({ targetSequence: "0", ...(unavailable === "foreign-ledger" ? { ledgerId: "different-ledger" } : {}),
        fileRestorer: { canRestore: () => { calls++; return true; }, restore: () => { calls++; return true; } },
      }), { code: unavailable === "foreign-ledger" ? "timeline_ledger_mismatch" : "timeline_rollback_preimage_unavailable" });
      assert.equal(calls, 0); assert.deepEqual(rec.store.query(), before);
    } finally { rec.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("rollback: a pre-image that is not the bytes its effect recorded refuses before either callback or a new intent (a3-design H1)", () => {
  const dir = mkTempDir("rollback-masked-preimage-"); const rec = mkRecorder(dir); let calls = 0;
  const original = "API_TOKEN=Xq7Lm2Pz9Rt4Vw8Ks3Nb6Yc1\n", masked = "API_TOKEN=[REDACTED:secret]\n";
  try {
    // What a copy path that lost the seal produced: the masked text as an `exact` pre-image of an effect that recorded the original's digest.
    rec.store.appendEvent({ ...makeTimelineEventInput(rec.store.ledgerId, "file-event", "file-effect"), documents: fileEffectDocuments(masked, original) });
    const before = rec.store.query();
    assert.throws(() => rec.rollback.execute({ targetSequence: "0",
      fileRestorer: { canRestore: () => { calls++; return true; }, restore: () => { calls++; return true; } },
    }), { code: "timeline_rollback_preimage_unavailable" });
    assert.equal(calls, 0, "no callback ran"); assert.deepEqual(rec.store.query(), before, "nothing was recorded");
    // The bytes the effect recorded are restored.
    rec.store.appendEvent({ ...makeTimelineEventInput(rec.store.ledgerId, "file-event-2", "file-effect"), documents: fileEffectDocuments(original) });
    assert.throws(() => rec.rollback.execute({ targetSequence: "0", fileRestorer: { canRestore: () => true, restore: () => true } }), { code: "timeline_rollback_preimage_unavailable" }, "the whole batch is admitted first");
  } finally { rec.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const discovery of ["empty", "gap", "duplicate"] as const) {
  test(`rollback: a planning page that is ${discovery} refuses an incomplete plan before any callback or record`, () => {
    const dir = mkTempDir("rollback-discovery-"); const rec = mkRecorder(dir); const file = join(dir, "file.txt"); let calls = 0;
    try {
      for (const [effectId, preimageContent] of [["old-file", "oldest"], ["new-file", "middle"]]) {
        rec.recordFileEffect({ effectId: effectId!, path: file, operation: "write", preimageDigest: sha256(preimageContent!), postimageDigest: sha256("current"), preimageContent: preimageContent!, description: "write", correlation: {} });
      }
      writeFileSync(file, "current"); const before = rec.store.query();
      const controller = createRollbackController({ ...rec.store, query(filter) {
        const rows = rec.store.query(filter);
        if (discovery === "empty") return [];
        if (discovery === "gap") return rows.slice(1);
        return [rows[0]!, ...rows];
      } });
      const execute = () => controller.execute({ targetSequence: "0", fileRestorer: {
        canRestore: () => { calls++; return true; },
        restore: (effect) => { calls++; writeFileSync(file, effect.documents.find((doc) => doc.name === "preimage")!.contentJson!); return true; },
      } });
      assert.throws(execute, { code: "timeline_rollback_plan_incomplete" }); assert.equal(calls, 0); assert.deepEqual(rec.store.query(), before); assert.equal(readFileSync(file, "utf8"), "current");
    } finally { rec.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
