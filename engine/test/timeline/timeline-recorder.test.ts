import { InputError, SecurityError } from "../../src/kernel/errors.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { CORRELATION_FIELD_NAMES, LedgerPersistenceUncertainError } from "../../src/timeline/ledger-primitives.ts";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder, type TimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { mkTempDir } from "../support/temp-dir.ts";

function mkRecorder(dir: string, ledgerId = "ledger-test"): TimelineRecorder {
  const store = createTimelineStore({
    path: join(dir, `rec-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
    ledgerId,
  });
  return createTimelineRecorder({ store });
}

const VALID_HASH = "a".repeat(64);

/** What the ledger holds as begun and not ended: the recorder keeps no other copy (SCALE-CR1 C6). */
function pendingIds(rec: TimelineRecorder): readonly string[] {
  return rec.pendingEffects().map((event) => event.eventId);
}

test("timeline-recorder: every recording entry captures main JSON arguments before caller reads", () => {
  const dir = mkTempDir("tl-rec-capture-");
  const correlation = { runId: "run", turnId: "turn" };
  const common = { description: "request", correlation };
  const inputs = {
    beginEffect: { ...common, effectId: "effect", kind: "provider", actor: { kind: "agent", id: "actor" }, intentHash: VALID_HASH },
    endEffect: { outcome: "succeeded", resultHash: VALID_HASH },
    observeExternalEffect: { observationId: "observation", kind: "provider", evidenceHash: VALID_HASH },
    recordEvent: { ...common, eventType: "provider" },
    recordRun: common, recordTurn: common, recordMessage: common,
    recordTokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, correlation },
    recordResource: { metric: "cpu", value: 1, unit: "ms", correlation },
    recordTest: { ...common, passed: true, testCount: 1 },
    recordGitOperation: { ...common, operation: "status" },
    recordCommit: { ...common, commitSha: "abc123" },
    recordFileEffect: { ...common, effectId: "file", path: "/test", operation: "write", preimageDigest: sha256("old"), postimageDigest: sha256("new"), preimageContent: "old" },
  };
  try {
    for (const [name, input] of Object.entries(inputs)) {
      const rec = mkRecorder(dir, `capture-${name}`);
      try {
        assert.deepEqual(Object.keys(rec).filter((key) => key.startsWith("record") || ["beginEffect", "endEffect", "observeExternalEffect"].includes(key)).sort(), Object.keys(inputs).sort());
        if (name === "endEffect") rec.beginEffect(inputs.beginEffect as Parameters<typeof rec.beginEffect>[0]);
        const invoke = (value: unknown) => name === "endEffect"
          ? rec.endEffect("effect", value as Parameters<typeof rec.endEffect>[1])
          : (rec[name as keyof typeof inputs] as (value: unknown) => unknown)(value);
        const pendingBefore = pendingIds(rec), rows = rec.store.count();
        let reads = 0;
        const key = Object.keys(input)[0]!;
        const getter = Object.defineProperty({ ...input }, key, { enumerable: true, get() { reads++; return (input as Record<string, unknown>)[key]; } });
        const proxy = new Proxy({}, { ownKeys() { reads++; throw new Error("proxy trap"); }, get() { reads++; throw new Error("proxy trap"); } });
        const nested = { ...input, extra: { get secret() { reads++; return "secret"; } } };
        for (const value of [getter, nested, proxy, null, [], "scalar", { ...input, extra: proxy }, { ...input, extra: undefined }, { ...input, extra: NaN }]) {
          assert.throws(() => invoke(value), (error) => error instanceof InputError && error.code === "timeline_recorder_input_invalid", name);
          assert.equal(reads, 0, `${name} must not execute caller code`);
          assert.equal(rec.store.count(), rows); assert.deepEqual(pendingIds(rec), pendingBefore);
        }
        invoke(input);
        assert.equal(rec.store.count(), rows + 1, `${name} still admits a plain input after refusals`);
      } finally { rec.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: terminal callers cannot silently supply originating provenance", () => {
  const dir = mkTempDir("tl-rec-terminal-override-");
  const rec = mkRecorder(dir, "recorder-override");
  try {
    rec.beginEffect({ effectId: "effect", kind: "provider", actor: { kind: "agent", id: "origin" }, description: "operation", intentHash: VALID_HASH });
    const before = pendingIds(rec);
    const overrides = { actor: { kind: "agent", id: "foreign" }, correlation: { runId: "foreign" }, traceId: "foreign", spanId: "foreign", parentEventId: "foreign",
      actorKind: "agent", actorId: "foreign", actorRole: "foreign", ...Object.fromEntries(CORRELATION_FIELD_NAMES.map((key) => [key, "foreign"])) };
    for (const [key, value] of Object.entries(overrides)) {
      assert.throws(() => rec.endEffect("effect", { outcome: "succeeded", resultHash: VALID_HASH, [key]: value }),
        (error) => error instanceof InputError && error.code === "timeline_terminal_provenance_override", key);
      assert.deepEqual(pendingIds(rec), before);
      assert.equal(rec.store.count(), 1);
    }
    rec.endEffect("effect", { outcome: "succeeded", resultHash: VALID_HASH });
    assert.equal(rec.store.count(), 2);
    assert.equal(rec.verifyTimelineChain().valid, true);
  } finally { rec.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: creates a recorder over its store, with no in-memory closure", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    assert.equal(rec.ledgerId, "ledger-1");
    assert.equal("closure" in rec, false);
    assert.ok(rec.store !== undefined);
    assert.ok(rec.query !== undefined);
    assert.ok(rec.rollback !== undefined);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: beginEffect records the intent in the store", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    const intent = rec.beginEffect({
      effectId: "fx-1",
      kind: "filesystem",
      actor: { kind: "harness", id: "agent-1" },
      correlation: { runId: "run-1" },
      description: "write file",
      intentHash: VALID_HASH,
    });
    assert.equal(intent.record.effectId, "fx-1");
    assert.equal(rec.store.count(), 1);
    const record = rec.store.query({ effectId: "fx-1" })[0];
    assert.ok(record !== undefined);
    assert.equal(record.recordKind, "intent");
    assert.equal(record.eventType, "filesystem");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: endEffect records the terminal in the store", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.beginEffect({
      effectId: "fx-1", kind: "filesystem",
      actor: { kind: "harness", id: "agent-1" },
      description: "write file", intentHash: VALID_HASH,
    });
    const terminal = rec.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH });
    assert.equal(terminal.record.outcome, "succeeded");
    assert.equal(rec.store.count(), 2);
    const terminals = rec.store.query({ recordKind: "terminal" });
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]!.outcome, "succeeded");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: endEffect with failed outcome and error", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.beginEffect({
      effectId: "fx-1", kind: "provider",
      actor: { kind: "harness", id: "agent-1" },
      description: "api call", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-1", {
      outcome: "failed", resultHash: VALID_HASH,
      error: { category: "provider", code: "timeout", message: "timed out", retryable: true },
    });
    const terminals = rec.store.query({ recordKind: "terminal" });
    assert.equal(terminals[0]!.outcome, "failed");
    assert.equal(terminals[0]!.errorCode, "timeout");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: observeExternalEffect records the observation in the store", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.beginEffect({
      effectId: "fx-1", kind: "filesystem",
      actor: { kind: "harness", id: "agent-1" },
      description: "write file", intentHash: VALID_HASH,
    });
    const obs = rec.observeExternalEffect({
      observationId: "obs-1",
      effectId: "fx-1",
      kind: "filesystem",
      evidenceHash: VALID_HASH,
    });
    assert.equal(obs.record.observationId, "obs-1");
    assert.equal(rec.store.count(), 2);
    const obsRecords = rec.store.query({ recordKind: "observation" });
    assert.equal(obsRecords.length, 1);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: recordEvent records standalone events", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.recordEvent({ eventType: "run", description: "run started" });
    assert.equal(rec.store.count(), 1);
    const events = rec.store.query({ eventType: "run" });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.recordKind, "event");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: recordRun records a run event", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    const result = rec.recordRun({ description: "run-1 started", correlation: { runId: "run-1" } });
    assert.ok(result.eventId.startsWith("evt-"));
    assert.ok(result.sequence === "1");
    assert.ok(result.chainHash.length === 64);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: recordTurn records a turn event", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.recordRun({ description: "run-1", correlation: { runId: "run-1" } });
    rec.recordTurn({ description: "turn-1", correlation: { runId: "run-1", turnId: "turn-1" } });
    const turns = rec.store.query({ eventType: "turn" });
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.turnId, "turn-1");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: recordMessage records a message event", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.recordMessage({ description: "user message", correlation: { runId: "run-1", messageId: "msg-1" } });
    const msgs = rec.store.query({ eventType: "message" });
    assert.equal(msgs.length, 1);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: recordTokenUsage records token usage with document", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.recordTokenUsage({
      promptTokens: 100, completionTokens: 50, totalTokens: 150,
      correlation: { runId: "run-1", turnId: "turn-1" },
    });
    const events = rec.store.query({ eventType: "token" });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.documents.length, 1);
    assert.equal(events[0]!.documents[0]!.name, "usage");
    const usage = JSON.parse(events[0]!.documents[0]!.contentJson ?? "{}");
    assert.equal(usage.promptTokens, 100);
    assert.equal(usage.totalTokens, 150);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: recordResource records resource metrics", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.recordResource({ metric: "memory", value: 128, unit: "MB", correlation: {} });
    const events = rec.store.query({ eventType: "resource" });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.documents[0]!.name, "metric");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: recordTest records test results", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.recordTest({ description: "unit tests", passed: true, testCount: 42, correlation: {} });
    const events = rec.store.query({ eventType: "test" });
    assert.equal(events.length, 1);
    const result = JSON.parse(events[0]!.documents[0]!.contentJson ?? "{}");
    assert.equal(result.passed, true);
    assert.equal(result.testCount, 42);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: recordGitOperation records git events", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.recordGitOperation({ operation: "commit", description: "commit changes", correlation: {} });
    const events = rec.store.query({ eventType: "git" });
    assert.equal(events.length, 1);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: recordCommit records commit events", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.recordCommit({ commitSha: "abc123", description: "commit", correlation: {} });
    const events = rec.store.query({ eventType: "commit" });
    assert.equal(events.length, 1);
    const commit = JSON.parse(events[0]!.documents[0]!.contentJson ?? "{}");
    assert.equal(commit.commitSha, "abc123");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: recordFileEffect records file effect with preimage", () => {
  const dir = mkTempDir("tl-rec-test-");
  const rec = mkRecorder(dir, "ledger-1");
  try {
    const receipt = rec.recordFileEffect({
      effectId: "fx-1", path: "/test/file.txt", operation: "write",
      preimageDigest: sha256("old content"), postimageDigest: VALID_HASH,
      description: "write file.txt",
      correlation: { runId: "run-1" },
      preimageContent: "old content",
    });
    const events = rec.store.query({ eventType: "file-effect" });
    assert.equal(events.length, 1);
    assert.deepEqual(receipt, { eventId: events[0]!.eventId, sequence: events[0]!.sequence, chainHash: events[0]!.chainHash });
    assert.equal(events[0]!.effectId, null);
    assert.equal(events[0]!.documents.length, 2);
    assert.equal(events[0]!.documents[0]!.name, "effect");
    assert.equal(events[0]!.documents[1]!.name, "preimage");
    assert.equal(events[0]!.documents[1]!.contentJson, "old content");
  } finally { rec.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: recordFileEffect without preimage content", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.recordFileEffect({
      effectId: "fx-1", path: "/test/file.txt", operation: "mkdir",
      preimageDigest: VALID_HASH, postimageDigest: VALID_HASH,
      description: "mkdir",
      correlation: {},
    });
    const events = rec.store.query({ eventType: "file-effect" });
    assert.equal(events[0]!.documents.length, 1);
    assert.equal(events[0]!.documents[0]!.name, "effect");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: pendingEffects is the store's begun-and-not-ended intents", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.beginEffect({
      effectId: "fx-1", kind: "filesystem",
      actor: { kind: "harness", id: "agent-1" },
      description: "write file", intentHash: VALID_HASH,
    });
    const pending = rec.pendingEffects();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.effectId, "fx-1");
    assert.equal(pending[0]!.recordKind, "intent");
    rec.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH });
    assert.deepEqual(rec.pendingEffects(), []);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: verifyTimelineChain verifies the durable store chain", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.beginEffect({
      effectId: "fx-1", kind: "filesystem",
      actor: { kind: "harness", id: "agent-1" },
      description: "write file", intentHash: VALID_HASH,
    });
    const result = rec.verifyTimelineChain();
    assert.equal(result.valid, true);
    assert.equal(result.verifiedRecords, 1);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: close persists data (crash recovery)", () => {
  const dir = mkTempDir("tl-rec-test-");
  const dbPath = join(dir, "rec.db");
  try {
    const store1 = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    const rec1 = createTimelineRecorder({ store: store1 });
    rec1.beginEffect({
      effectId: "fx-1", kind: "filesystem",
      actor: { kind: "harness", id: "agent-1" },
      description: "write file", intentHash: VALID_HASH,
    });
    rec1.endEffect("fx-1", { outcome: "succeeded", resultHash: VALID_HASH });
    rec1.recordEvent({ eventType: "turn", description: "turn-1" });
    rec1.close();
    // Reopen the same store and verify data
    const store2 = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    assert.equal(store2.count(), 3);
    const result = store2.verifyChain();
    assert.equal(result.valid, true);
    assert.equal(result.verifiedRecords, 3);
    store2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: base correlation is merged into events", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const store = createTimelineStore({
      path: join(dir, "test.db"),
      ledgerId: "ledger-1",
    });
    const rec = createTimelineRecorder({
      store,
      correlation: { runId: "run-base", agentId: "agent-base" },
    });
    rec.recordEvent({ eventType: "message", description: "hello" });
    const events = rec.store.query({ eventType: "message" });
    assert.equal(events[0]!.runId, "run-base");
    assert.equal(events[0]!.agentId, "agent-base");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: per-event correlation overrides base correlation", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const store = createTimelineStore({
      path: join(dir, "test.db"),
      ledgerId: "ledger-1",
    });
    const rec = createTimelineRecorder({
      store,
      correlation: { runId: "run-base" },
    });
    rec.recordEvent({ eventType: "message", description: "hello", correlation: { runId: "run-override" } });
    const events = rec.store.query({ eventType: "message" });
    assert.equal(events[0]!.runId, "run-override");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: full lifecycle recording (run→turn→provider→tool→terminal)", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-1");
    rec.recordRun({ description: "run started", correlation: { runId: "run-1" } });
    rec.recordTurn({ description: "turn-1", correlation: { runId: "run-1", turnId: "turn-1" } });
    rec.beginEffect({
      effectId: "fx-prov", kind: "provider",
      actor: { kind: "harness", id: "session" },
      correlation: { runId: "run-1", turnId: "turn-1" },
      description: "provider request", intentHash: VALID_HASH,
    });
    rec.endEffect("fx-prov", { outcome: "succeeded", resultHash: VALID_HASH });
    rec.recordTokenUsage({
      promptTokens: 10, completionTokens: 5, totalTokens: 15,
      correlation: { runId: "run-1", turnId: "turn-1" },
    });
    assert.equal(rec.store.count(), 5);
    const result = rec.verifyTimelineChain();
    assert.equal(result.valid, true);
    assert.equal(result.verifiedRecords, 5);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: injected clock is used for standalone event wallTime (MAINT-3)", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const store = createTimelineStore({
      path: join(dir, "clock-test.db"),
      ledgerId: "ledger-clock",
    });
    const fixedWallTime = "2026-01-15T12:00:00.000Z";
    const clock = { now: () => ({ wallTime: fixedWallTime, monotonicNanoseconds: "1000" }) };
    const rec = createTimelineRecorder({ store, clock });
    rec.recordEvent({ eventType: "run", description: "fixed-time event" });
    const events = rec.store.query({ eventType: "run" });
    assert.equal(events.length, 1);
    assert.equal(
      events[0]!.wallTime,
      fixedWallTime,
      "standalone event wallTime must come from the injected clock, not new Date() (MAINT-3)",
    );
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: injected clock is used for file-effect wallTime (MAINT-3)", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const store = createTimelineStore({
      path: join(dir, "clock-file.db"),
      ledgerId: "ledger-clock-file",
    });
    const fixedWallTime = "2026-02-20T08:30:00.000Z";
    const clock = { now: () => ({ wallTime: fixedWallTime, monotonicNanoseconds: "2000" }) };
    const rec = createTimelineRecorder({ store, clock });
    rec.recordFileEffect({
      effectId: "fx-1",
      path: "/test/clock.txt",
      operation: "write",
      preimageDigest: VALID_HASH,
      postimageDigest: VALID_HASH,
      description: "write with injected clock",
      correlation: { runId: "run-1" },
    });
    const events = rec.store.query({ eventType: "file-effect" });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.wallTime, fixedWallTime);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: without a clock, wallTime falls back to new Date (MAINT-3)", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-no-clock");
    const before = new Date().toISOString();
    rec.recordEvent({ eventType: "turn", description: "default clock event" });
    const after = new Date().toISOString();
    const events = rec.store.query({ eventType: "turn" });
    assert.equal(events.length, 1);
    assert.ok(
      events[0]!.wallTime >= before && events[0]!.wallTime <= after,
      "without an injected clock, wallTime should fall back to the current time",
    );
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Ambient attribution of recordFileEffect (the file-effect run_id defect) ──
//
// Measured against the live web ledger: run_id was NULL on 0/2,149 (later
// 0/2,456) file-effect rows, which blocked synthesis.echoes, custody parcel
// grouping and hot-paths. The verified root cause was NOT a recorder drop —
// every historic row was written before the run boundary landed, or by a
// process legitimately outside any boundary. These tests pin the recorder
// behaviour BOTH ways so the choke point can never regress silently:
//
// - inside `withRecordingContext({runId})`, a file effect recorded with an
//   EMPTY correlation (exactly what the editor bridge passes) inherits the
//   ambient runId/turnId/actor, and a `withSpan` wrap supplies trace/span —
//   the same inheritance `recordEvent` gets, because both flow through
//   `mergeCorrelation` + `ambientProvenance`;
// - outside any boundary, the effect stays honestly unattributed.
//
// MUTATION-VERIFIED: removing the ambient block from `mergeCorrelation` (or
// bypassing `mergeCorrelation` in `recordFileEffect`) fails the first test;
// hardcoding a fallback run id fails the second.

import { withRecordingContext, withSpan } from "../../src/timeline/recording-context.ts";

test("timeline-recorder: recordFileEffect inherits ambient runId/turnId/actor/trace inside a recording boundary", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-ambient");
    withRecordingContext({ actor: { kind: "agent", id: "llm-1" }, runId: "run-amb", turnId: "turn-2" }, () => {
      withSpan("tool:edit:1", () => {
        rec.recordFileEffect({
          effectId: "fx-amb-1",
          path: "/p/inside.ts",
          operation: "write",
          preimageDigest: VALID_HASH,
          postimageDigest: VALID_HASH,
          description: "write /p/inside.ts",
          // EMPTY on purpose — the editor bridge passes exactly this so the
          // recorder merges the ambient context.
          correlation: {},
        });
      });
    });
    const event = rec.store.query({ eventType: "file-effect" })[0];
    assert.ok(event !== undefined);
    assert.equal(event.runId, "run-amb");
    assert.equal(event.turnId, "turn-2");
    assert.equal(event.actorKind, "agent");
    assert.equal(event.actorId, "llm-1");
    assert.equal(event.traceId, "tool:edit:1");
    assert.equal(event.spanId, "tool:edit:1");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: recordFileEffect outside any boundary stays honestly unattributed", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-ambient-out");
    rec.recordFileEffect({
      effectId: "fx-amb-2",
      path: "/p/outside.ts",
      operation: "write",
      preimageDigest: VALID_HASH,
      postimageDigest: VALID_HASH,
      description: "write /p/outside.ts",
      correlation: {},
    });
    const event = rec.store.query({ eventType: "file-effect" })[0];
    assert.ok(event !== undefined);
    // No boundary → no run/turn/trace. A fabricated fallback here would make
    // the ledger confidently wrong, which is worse than an honest NULL.
    assert.equal(event.runId, null);
    assert.equal(event.turnId, null);
    assert.equal(event.traceId, null);
    assert.equal(event.spanId, null);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: an explicit correlation stays most-specific over the ambient context", () => {
  const dir = mkTempDir("tl-rec-test-");
  try {
    const rec = mkRecorder(dir, "ledger-ambient-exp");
    withRecordingContext({ actor: { kind: "agent", id: "llm-1" }, runId: "run-ambient" }, () => {
      rec.recordFileEffect({
        effectId: "fx-amb-3",
        path: "/p/explicit.ts",
        operation: "write",
        preimageDigest: VALID_HASH,
        postimageDigest: VALID_HASH,
        description: "write /p/explicit.ts",
        correlation: { runId: "run-explicit" },
      });
    });
    const event = rec.store.query({ eventType: "file-effect" })[0];
    assert.equal(event?.runId, "run-explicit");
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: paired receipts retain documents and the store's one sequence domain", () => {
  const dir = mkTempDir("tl-paired-"); const rec = mkRecorder(dir);
  const contentJson = '{"proof":"private native retained separately"}';
  const documents = [{ name: "provider-request", contentJson, contentDigest: sha256(contentJson) }];
  try {
    const intent = rec.beginEffect({ effectId: "paired", kind: "provider", actor: { kind: "agent", id: "one" }, description: "request", intentHash: VALID_HASH }, { documents });
    rec.recordEvent({ eventType: "message", description: "intervening event" });
    const terminal = rec.endEffect("paired", { outcome: "failed", resultHash: VALID_HASH, error: { category: "provider", code: "retry", message: "transient", retryable: true } }, { documents, edges: [{ edgeType: "causal", targetEventId: intent.receipt.eventId }] });
    assert.equal(intent.receipt.sequence, "1"); assert.equal(terminal.receipt.sequence, "3");
    assert.equal(intent.record.effectId, "paired"); assert.equal(terminal.record.effectId, "paired");
    assert.equal("chainHash" in intent.record || "sequence" in terminal.record, false, "no second, in-memory chain");
    for (const result of [intent, terminal]) {
      const row = rec.store.getEvent(result.receipt.eventId)!;
      assert.equal(result.receipt.chainHash, row.chainHash);
      assert.equal(result.receipt.sequence, row.sequence);
      assert.equal(row.documents[0]!.contentJson, contentJson);
      assert.equal(row.documents[0]!.contentDigest, documents[0]!.contentDigest);
      assert.ok(Object.isFrozen(result) && Object.isFrozen(result.receipt));
    }
    assert.equal(rec.store.getEvent(terminal.receipt.eventId)!.errorRetryable, true);
    assert.equal(rec.store.getEvent(terminal.receipt.eventId)!.edges[0]!.targetEventId, intent.receipt.eventId);
  } finally { rec.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: a legacy orphan terminal prevents a new intent without mutating history", () => {
  const dir = mkTempDir("tl-legacy-terminal-");
  const path = join(dir, "timeline.db");
  const store = createTimelineStore({ path, ledgerId: "legacy" });
  const raw = new DatabaseSync(path);
  const rec = createTimelineRecorder({ store });
  try {
    // Old direct-store callers could persist a terminal without an intent.
    // Preserve this deliberately unverified historical row exactly as found.
    raw.prepare(`INSERT INTO event_log (event_id,ledger_id,sequence,record_kind,event_type,effect_id,outcome,result_hash,wall_time,actor_kind,actor_id,description,previous_chain_hash,chain_hash)
      VALUES ('legacy-terminal','legacy',1,'terminal','provider','legacy-effect','succeeded',?,'2026-09-26','harness','timeline-store','terminal:succeeded',?,?)`).run(VALID_HASH, "0".repeat(64), "0".repeat(64));
    const before = store.query(), chain = store.verifyChain(), pending = pendingIds(rec);
    const refusal = (error: unknown) => error instanceof SecurityError && error.code === "timeline_intent_already_terminal";
    assert.throws(() => store.appendIntent({ eventId: "new-direct-intent", ledgerId: "legacy", eventType: "provider", effectKind: "provider", effectId: "legacy-effect", actor: { kind: "agent", id: "new" }, description: "new operation", intentHash: VALID_HASH, wallTime: "2026-09-26" }), refusal);
    assert.throws(() => rec.beginEffect({ effectId: "legacy-effect", kind: "provider", actor: { kind: "agent", id: "new" }, description: "new operation", intentHash: VALID_HASH }), refusal);
    assert.deepEqual(store.query(), before);
    assert.deepEqual(store.verifyChain(), chain);
    assert.deepEqual(pendingIds(rec), pending);
    assert.equal(store.nextSequence(), "2");
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM timeline_projection").get()!.n, 0);
  } finally { raw.close(); rec.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: failed append leaves the ledger and routing unchanged until acknowledged", () => {
  const dir = mkTempDir("tl-paired-failure-");
  const store = createTimelineStore({ path: join(dir, "timeline.db"), ledgerId: "paired" });
  let failIntent = true; let failTerminal = true;
  const rec = createTimelineRecorder({ store: { ...store,
    appendIntent(input) { if (failIntent) throw new Error("private intent diagnostic"); return store.appendIntent(input); },
    appendTerminal(input) { if (failTerminal) throw new Error("private terminal diagnostic"); return store.appendTerminal(input); },
  } });
  const input = { effectId: "paired", kind: "provider", actor: { kind: "harness", id: "runtime" }, description: "request", intentHash: VALID_HASH } as const;
  try {
    const refusal = (error: unknown) => error instanceof SecurityError && error.code === "timeline_store_append_failed" && error.message === "Timeline store append failed";
    assert.throws(() => rec.beginEffect(input), refusal);
    assert.deepEqual(pendingIds(rec), []); assert.equal(store.count(), 0);
    failIntent = false;
    rec.beginEffect(input);
    assert.throws(() => rec.endEffect("paired", { outcome: "succeeded", resultHash: VALID_HASH }), refusal);
    assert.deepEqual(pendingIds(rec), ["intent-paired"]); assert.equal(store.count(), 1);
    failTerminal = false;
    const result = rec.endEffect("paired", { outcome: "succeeded", resultHash: VALID_HASH });
    assert.equal(store.getEvent(result.receipt.eventId)!.eventType, "provider");
    // The second terminal is refused by the one pairing owner, the store.
    assert.throws(() => rec.endEffect("paired", { outcome: "succeeded", resultHash: VALID_HASH }), (error) => error instanceof SecurityError && error.code === "timeline_terminal_duplicate");
    assert.equal(store.count(), 2);
  } finally { rec.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: an effect begun before a restart is ended through the ledger's own intent", () => {
  const dir = mkTempDir("tl-restored-"); const path = join(dir, "timeline.db");
  const first = createTimelineRecorder({ store: createTimelineStore({ path, ledgerId: "restore" }), correlation: { sessionId: "extra-session" } });
  first.beginEffect({ effectId: "pending", kind: "provider", actor: { kind: "agent", id: "one" }, correlation: { runId: "explicit-run" }, description: "request", intentHash: VALID_HASH });
  first.close();
  const store = createTimelineStore({ path, ledgerId: "restore" });
  const empty = createTimelineStore({ path: join(dir, "other.db"), ledgerId: "restore" });
  try {
    const unbound = (error: unknown) => error instanceof SecurityError && error.code === "timeline_recorder_intent_unbound";
    assert.throws(() => createTimelineRecorder({ store: empty }).endEffect("pending", { outcome: "cancelled", resultHash: VALID_HASH }), unbound);
    assert.equal(store.getEvent("intent-pending")!.sessionId, "extra-session");
    const restored = createTimelineRecorder({ store });
    assert.deepEqual(pendingIds(restored), ["intent-pending"]);
    const terminal = restored.endEffect("pending", { outcome: "cancelled", resultHash: VALID_HASH });
    assert.equal(store.getEvent(terminal.receipt.eventId)!.eventType, "provider");
    assert.equal(store.getEvent(terminal.receipt.eventId)!.runId, "explicit-run");
    assert.deepEqual(restored.pendingEffects(), []);
    assert.equal(store.verifyChain().valid, true);
  } finally { store.close(); empty.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: an uncertain storage acknowledgment never lets the effect be recorded twice", () => {
  const dir = mkTempDir("tl-rec-uncertain-"); const store = createTimelineStore({ path: join(dir, "timeline.db"), ledgerId: "uncertain" });
  let attempts = 0;
  const rec = createTimelineRecorder({ store: { ...store, appendIntent(input) { attempts += 1; store.appendIntent(input); throw new LedgerPersistenceUncertainError(); } } });
  const input = { effectId: "uncertain", kind: "provider", actor: { kind: "harness", id: "runtime" }, description: "request", intentHash: VALID_HASH } as const;
  try {
    assert.throws(() => rec.beginEffect(input), (error) => error instanceof LedgerPersistenceUncertainError && error.code === "ledger_persistence_uncertain");
    // The retry reaches the store, whose pairing owner refuses a second intent for the effect.
    assert.throws(() => rec.beginEffect(input), (error) => error instanceof SecurityError && error.code === "timeline_intent_duplicate");
    assert.equal(attempts, 2); assert.equal(store.count(), 1);
    assert.equal(store.getEvent("intent-uncertain")!.effectId, "uncertain");
  } finally { rec.close(); rmSync(dir, { recursive: true, force: true }); }
});


test("timeline-recorder: evidence cannot override admitted identity or outcome", () => {
  const dir = mkTempDir("tl-evidence-shape-"); const rec = mkRecorder(dir);
  const input = { effectId: "exact", kind: "provider", actor: { kind: "harness", id: "runtime" }, description: "request", intentHash: VALID_HASH } as const;
  const evidence = { documents: [], eventId: "substituted", effectId: "substituted", intentHash: "b".repeat(64) };
  try {
    const refused = (error: unknown) => error instanceof InputError && error.code === "timeline_evidence_invalid";
    assert.throws(() => rec.beginEffect(input, evidence), refused);
    assert.deepEqual(pendingIds(rec), []); assert.equal(rec.store.count(), 0);
    rec.beginEffect(input);
    const pending = pendingIds(rec);
    const terminalEvidence = { ...evidence, outcome: "failed" };
    assert.throws(() => rec.endEffect("exact", { outcome: "succeeded", resultHash: VALID_HASH }, terminalEvidence), refused);
    assert.throws(() => rec.observeExternalEffect({ observationId: "exact-observation", kind: "provider", evidenceHash: VALID_HASH }, evidence), refused);
    assert.deepEqual(pendingIds(rec), pending); assert.equal(rec.store.count(), 1);
    rec.endEffect("exact", { outcome: "succeeded", resultHash: VALID_HASH });
  } finally { rec.close(); rmSync(dir, { recursive: true, force: true }); }
});


test("timeline-recorder: all generic document doors retain canonical ordered text", () => {
  const dir = mkTempDir("tl-rec-ordered-"); const recorder = mkRecorder(dir);
  const orderedJson = " \u0000ordered\r\n";
  const documents = [{ name: "ordered", orderedJson, contentDigest: sha256(orderedJson) }];
  try {
    const event = recorder.recordEvent({ eventType: "artifact", description: "ordered event", documents });
    const rows = [event, ...["recordRun", "recordTurn", "recordMessage"].map((method) => {
      const input = { description: "ordered lifecycle", correlation: { runId: "run" }, documents };
      if (method === "recordRun") return recorder.recordRun(input);
      if (method === "recordTurn") return recorder.recordTurn(input);
      return recorder.recordMessage(input);
    })];
    for (const row of rows) {
      const actual = recorder.store.getEvent(row.eventId)!.documents;
      assert.equal(actual.length, 1); assert.equal(actual[0]!.contentJson, null);
      assert.equal(actual[0]!.orderedJson, orderedJson); assert.equal(actual[0]!.contentDigest, sha256(orderedJson));
    }
  } finally { recorder.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-recorder: an edited .env's preimage never reaches the ledger file in the clear, and a rollback restores it exactly (CRED-F12)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = mkTempDir("tl-rec-env-");
  const token = `ghp_${"Q7rX2mV9kL4pT8wZ3nB6yC1dF5hJ0sA2uE4i"}`;
  const password = "Wq9!zR3#pL7@vN2x";
  const preimage = `GITHUB_TOKEN=${token}\nDB_PASSWORD=${password}\n`;
  const rec = mkRecorder(dir, "env-ledger");
  try {
    rec.recordFileEffect({
      effectId: "fx-env", path: "/project/.env", operation: "write",
      preimageDigest: sha256(preimage), postimageDigest: VALID_HASH,
      description: "edit .env", correlation: {}, preimageContent: preimage,
    });
    const [event] = rec.store.query({ eventType: "file-effect" });
    const shown = event!.documents.find((document) => document.name === "preimage")!;
    // The public projection is redacted and marked protected, naming its original's digest ...
    assert.equal(shown.projectionDisposition, "protected");
    assert.equal(shown.originalDigest, sha256(preimage));
    assert.equal(shown.contentJson!.includes(token) || shown.contentJson!.includes(password), false);
    // ... and the rollback restores the EXACT original from its seal, never the masked text.
    let restored: string | undefined;
    const result = rec.rollback.execute({ targetSequence: "0", fileRestorer: {
      canRestore: () => true,
      restore: (effect) => { restored = effect.documents.find((document) => document.name === "preimage")!.contentJson!; return true; },
    } });
    assert.equal(result.restoredCount, 1);
    assert.equal(restored, preimage);
  } finally { rec.close(); }
  // ... and the exact bytes are kept only sealed: no file of the ledger holds either value.
  for (const name of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, name)).toString("latin1");
    assert.equal(bytes.includes(token), false, `${name} holds the token`);
    assert.equal(bytes.includes(password), false, `${name} holds the password`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("timeline-recorder: a secret file's pre-image hides EVERY value, whatever its grammar — no 4 characters of a secret reach the ledger (a3-correctness M-2)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = mkTempDir("tl-rec-env-grammar-");
  // The detector's value grammar stopped at a `#` (9 of CRED-F12's own 16 characters stayed),
  // and missed a quoted value and one with spaces whole.
  const secrets = ["Wq9!zR3#pL7@vN2x", "qU0t3d#s3cr3T v4lu3", "Zx7 Kq9 Wm4 Lp2", "p#Ssw0rD-Xq8-Zk2"];
  const preimage = `DB_PASSWORD=${secrets[0]}\nQUOTED='${secrets[1]}'\nSPACED=${secrets[2]}\nEARLY_HASH=${secrets[3]}\n# DB_OLD=${secrets[0]}\n`;
  const rec = mkRecorder(dir, "env-grammar-ledger");
  try {
    rec.recordFileEffect({
      effectId: "fx-env-grammar", path: "/project/.env.production", operation: "write",
      preimageDigest: sha256(preimage), postimageDigest: VALID_HASH,
      description: "edit .env.production", correlation: {}, preimageContent: preimage,
    });
    const [event] = rec.store.query({ eventType: "file-effect" });
    const shown = event!.documents.find((document) => document.name === "preimage")!;
    assert.equal(shown.projectionDisposition, "protected");
    // The file's STRUCTURE stays readable: its keys and the comment marker, each value one marker.
    assert.equal(shown.contentJson, "DB_PASSWORD=[REDACTED:secret]\nQUOTED=[REDACTED:secret]\nSPACED=[REDACTED:secret]\nEARLY_HASH=[REDACTED:secret]\n# DB_OLD=[REDACTED:secret]\n");
    assert.equal(rec.store.originalDocuments(event!.eventId, "rollback")!.find((document) => document.name === "preimage")!.contentJson, preimage, "the original is sealed exactly");
  } finally { rec.close(); }
  for (const name of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, name)).toString("latin1");
    for (const secret of secrets) {
      for (let at = 0; at + 4 <= secret.length; at += 1) {
        assert.equal(bytes.includes(secret.slice(at, at + 4)), false, `${name} holds ${JSON.stringify(secret.slice(at, at + 4))} of ${JSON.stringify(secret)}`);
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

test("timeline-recorder: an edited JSON file's pre-image keeps a byte count but never a credential or card number held as a JSON number (REDACT-NUM, MF-A)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = mkTempDir("tl-rec-json-numbers-");
  const preimage = JSON.stringify({ db: { password: 84729361528374 }, billing: { card_number: 4539148803436467 }, rss: 245748169 });
  const rec = mkRecorder(dir, "json-number-ledger");
  try {
    rec.recordFileEffect({
      effectId: "fx-json", path: "/project/settings.json", operation: "write",
      preimageDigest: sha256(preimage), postimageDigest: VALID_HASH,
      description: "edit settings.json", correlation: {}, preimageContent: preimage,
    });
    const [event] = rec.store.query({ eventType: "file-effect" });
    const shown = event!.documents.find((document) => document.name === "preimage")!;
    assert.equal(shown.contentJson, '{"db":{"password":[REDACTED:credential]},"billing":{"card_number":[REDACTED:pii]},"rss":245748169}');
    assert.equal(shown.projectionDisposition, "protected");
  } finally { rec.close(); }
  for (const name of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, name)).toString("latin1");
    assert.equal(bytes.includes("84729361528374") || bytes.includes("4539148803436467"), false, `${name} holds a value in the clear`);
  }
  rmSync(dir, { recursive: true, force: true });
});
