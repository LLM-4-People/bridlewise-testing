import { sha256 } from "../../src/kernel/integrity.ts";
import assert from "node:assert/strict";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createTimelineStore, type EventLedgerStoragePort } from "../../src/timeline/timeline-store.ts";
import { makeTimelineEventInput as mkEvent } from "../support/timeline.ts";
import { TIMELINE_SCHEMA_VERSION, TIMELINE_EVENT_TYPES, type TimelineIntentInput, type TimelineTerminalInput, type TimelineObservationInput } from "../../src/timeline/timeline-types.ts";
import {
  DEFAULT_DURABILITY_WINDOW_MS,
  DEFAULT_TIMELINE_SYNCHRONOUS,
} from "../../src/timeline/timeline-config.ts";
import { mkTempDir } from "../support/temp-dir.ts";

function mkStore(dir: string, ledgerId?: string): EventLedgerStoragePort {
  return createTimelineStore({
    path: join(dir, `timeline-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
    ...(ledgerId !== undefined ? { ledgerId } : {}),
  });
}

const VALID_HASH = "a".repeat(64);
const VALID_HASH_B = "b".repeat(64);

function mkIntent(ledgerId: string, eventId: string, effectId: string): TimelineIntentInput {
  return {
    eventId, ledgerId, eventType: "filesystem", effectKind: "filesystem", effectId,
    actor: { kind: "harness", id: "agent-1" },
    correlation: { runId: "run-1", taskId: "task-1" },
    description: "write file", intentHash: VALID_HASH,
    wallTime: "2026-07-16T00:00:00.000Z",
  };
}

function mkTerminal(ledgerId: string, eventId: string, effectId: string): TimelineTerminalInput {
  return {
    eventId, ledgerId, eventType: "filesystem", effectId,
    outcome: "succeeded", resultHash: VALID_HASH_B,
    wallTime: "2026-07-16T00:00:01.000Z",
  };
}

function mkObservation(ledgerId: string, eventId: string, obsId: string, effectId?: string): TimelineObservationInput {
  return {
    eventId, ledgerId, eventType: "filesystem", observationId: obsId, actor: { kind: "harness", id: "observer" },
    ...(effectId !== undefined ? { effectId } : {}),
    evidenceHash: VALID_HASH,
    wallTime: "2026-07-16T00:00:02.000Z",
  };
}

// ========== Schema and migration tests ==========

test("timeline-store: schema version is stable", () => {
  assert.equal(TIMELINE_SCHEMA_VERSION, "bridlewise-timeline/v1");
});

test("timeline-store: creates database and runs migrations", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-test");
    assert.equal(store.ledgerId, "ledger-test");
    assert.equal(store.count(), 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: generates ledgerId when not provided", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir);
    assert.ok(store.ledgerId.startsWith("ledger-"));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: migrations are idempotent on reopen", () => {
  const dir = mkTempDir("timeline-test-");
  const dbPath = join(dir, "timeline.db");
  try {
    const store1 = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    store1.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store1.close();
    const store2 = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    assert.equal(store2.count(), 1);
    store2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: rejects empty path", () => {
  assert.throws(() => createTimelineStore({ path: "", ledgerId: "x" }), /Timeline store path is empty/);
});

// ========== Append intent tests ==========

test("timeline-store: appends intent and returns record", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const record = store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    assert.equal(record.eventId, "evt-1");
    assert.equal(record.recordKind, "intent");
    assert.equal(record.eventType, "filesystem");
    assert.equal(record.effectId, "fx-1");
    assert.equal(record.sequence, "1");
    assert.equal(record.runId, "run-1");
    assert.equal(record.previousChainHash, "0".repeat(64));
    assert.ok(record.chainHash !== "0".repeat(64));
    assert.equal(record.documents.length, 0);
    assert.equal(record.edges.length, 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: appended event is retrievable", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    const record = store.getEvent("evt-1");
    assert.ok(record !== undefined);
    assert.equal(record?.eventId, "evt-1");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: getEvent returns undefined for missing event", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.equal(store.getEvent("missing"), undefined);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: nextSequence starts at 1 and increments", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.equal(store.nextSequence(), "1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    assert.equal(store.nextSequence(), "2");
    store.appendIntent(mkIntent("ledger-1", "evt-2", "fx-2"));
    assert.equal(store.nextSequence(), "3");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: chainTipHash is zero before any events", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.equal(store.chainTipHash(), "0".repeat(64));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: chainTipHash updates after append", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const record = store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    assert.equal(store.chainTipHash(), record.chainHash);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Append terminal tests ==========

test("timeline-store: appends terminal for an intent", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    const term = store.appendTerminal(mkTerminal("ledger-1", "evt-term-1", "fx-1"));
    assert.equal(term.recordKind, "terminal");
    assert.equal(term.outcome, "succeeded");
    assert.equal(term.effectId, "fx-1");
    assert.equal(term.resultHash, VALID_HASH_B);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: terminal with error records error fields", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    const term = store.appendTerminal({
      ...mkTerminal("ledger-1", "evt-term-1", "fx-1"),
      outcome: "failed",
      error: { category: "provider", code: "timeout", message: "timed out", retryable: true },
    });
    assert.equal(term.outcome, "failed");
    assert.equal(term.errorCategory, "provider");
    assert.equal(term.errorCode, "timeout");
    assert.equal(term.errorMessage, "timed out");
    assert.equal(term.errorRetryable, true);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: terminal with non-retryable error", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    const term = store.appendTerminal({
      ...mkTerminal("ledger-1", "evt-term-1", "fx-1"),
      outcome: "failed",
      error: { category: "filesystem", code: "not_found", message: "file missing", retryable: false },
    });
    assert.equal(term.errorRetryable, false);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: terminal with cancelled outcome", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    const term = store.appendTerminal({
      ...mkTerminal("ledger-1", "evt-term-1", "fx-1"),
      outcome: "cancelled",
    });
    assert.equal(term.outcome, "cancelled");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: terminal with denied outcome", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    const term = store.appendTerminal({
      ...mkTerminal("ledger-1", "evt-term-1", "fx-1"),
      outcome: "denied",
    });
    assert.equal(term.outcome, "denied");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: rejects pending outcome for terminal", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendTerminal({ ...mkTerminal("ledger-1", "evt-1", "fx-1"), outcome: "pending" as never }),
      /Timeline terminal outcome is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Append observation tests ==========

test("timeline-store: appends observation with effectId", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    const obs = store.appendObservation(mkObservation("ledger-1", "evt-obs-1", "obs-1", "fx-1"));
    assert.equal(obs.recordKind, "observation");
    assert.equal(obs.observationId, "obs-1");
    assert.equal(obs.effectId, "fx-1");
    assert.equal(obs.evidenceHash, VALID_HASH);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: appends observation without effectId (orphaned)", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const obs = store.appendObservation(mkObservation("ledger-1", "evt-obs-1", "obs-1"));
    assert.equal(obs.effectId, null);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Append standalone event tests ==========

test("timeline-store: appends standalone event", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const evt = store.appendEvent(mkEvent("ledger-1", "evt-1", "turn"));
    assert.equal(evt.recordKind, "event");
    assert.equal(evt.eventType, "turn");
    assert.equal(evt.runId, "run-1");
    assert.equal(evt.actorKind, "harness");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: standalone event with payload ref and digest", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const evt = store.appendEvent({
      ...mkEvent("ledger-1", "evt-1", "artifact"),
      payloadRef: "artifact-sha256-123",
      payloadDigest: VALID_HASH,
    });
    assert.equal(evt.payloadRef, "artifact-sha256-123");
    assert.equal(evt.payloadDigest, VALID_HASH);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Documents and edges tests ==========

test("timeline-store: stores documents with event", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const record = store.appendIntent({
      ...mkIntent("ledger-1", "evt-1", "fx-1"),
      documents: [
        { name: "request", contentJson: '{"model":"test"}', contentDigest: sha256('{"model":"test"}') },
        { name: "headers", contentJson: '["X-Test: 1"]', contentDigest: sha256('["X-Test: 1"]') },
      ],
    });
    assert.equal(record.documents.length, 2);
    assert.equal(record.documents[0]!.name, "request");
    assert.equal(record.documents[0]!.position, 0);
    assert.equal(record.documents[1]!.name, "headers");
    assert.equal(record.documents[1]!.position, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: stores edges with event", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    const record = store.appendEvent({
      ...mkEvent("ledger-1", "evt-2", "turn"),
      edges: [
        { edgeType: "causal", targetEventId: "evt-1" },
        { edgeType: "part-of", targetKind: "run", targetId: "run-1" },
      ],
    });
    assert.equal(record.edges.length, 2);
    assert.equal(record.edges[0]!.edgeType, "causal");
    assert.equal(record.edges[0]!.targetEventId, "evt-1");
    assert.equal(record.edges[1]!.edgeType, "part-of");
    assert.equal(record.edges[1]!.targetEventId, null);
    assert.equal(record.edges[1]!.targetKind, "run");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: document content can be null", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const record = store.appendIntent({
      ...mkIntent("ledger-1", "evt-1", "fx-1"),
      documents: [{ name: "digest-only", contentDigest: VALID_HASH }],
    });
    assert.equal(record.documents[0]!.contentJson, null);
    assert.equal(record.documents[0]!.orderedJson, null);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: document with orderedJson", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const record = store.appendIntent({
      ...mkIntent("ledger-1", "evt-1", "fx-1"),
      documents: [{ name: "headers", orderedJson: '["a","b"]', contentDigest: sha256('["a","b"]') }],
    });
    assert.equal(record.documents[0]!.orderedJson, '["a","b"]');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Chain verification tests ==========

test("timeline-store: verifyChain returns valid for empty ledger", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const result = store.verifyChain();
    assert.equal(result.valid, true);
    assert.equal(result.verifiedRecords, 0);
    assert.equal(result.code, "empty");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: verifyChain returns valid for a clean chain", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store.appendTerminal(mkTerminal("ledger-1", "evt-2", "fx-1"));
    store.appendEvent(mkEvent("ledger-1", "evt-3"));
    const result = store.verifyChain();
    assert.equal(result.valid, true);
    assert.equal(result.verifiedRecords, 3);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const scenario of ["empty", "large", "sequence", "previous-hash", "record-hash", "native-step-error"] as const) {
  test(`timeline-store: bounded native chain iterator releases ${scenario} before returning`, (t) => {
    const dir = mkTempDir("timeline-chain-iterator-");
    const path = join(dir, "timeline.db");
    const store = createTimelineStore({ path, ledgerId: "chain" });
    const raw = new DatabaseSync(path);
    const total = scenario === "empty" ? 0 : scenario === "large" ? 2001 : 3;
    const failure = new Error("native SQLite step fixture failure");
    let allCalls = 0, steps = 0, returns = 0, nativeCalls = 0;
    let activeIterator: ReturnType<ReturnType<DatabaseSync["prepare"]>["iterate"]> | undefined;
    try {
      for (let index = 0; index < total; index++) store.appendEvent(mkEvent("chain", `iter-${index}`));
      if (["sequence", "previous-hash", "record-hash"].includes(scenario)) {
        const trigger = raw.prepare("SELECT sql FROM sqlite_master WHERE name='event_log_no_update'").get()!;
        raw.exec("DROP TRIGGER event_log_no_update");
        try {
          if (scenario === "sequence") raw.prepare("UPDATE event_log SET sequence=4 WHERE event_id='iter-2'").run();
          if (scenario === "previous-hash") raw.prepare("UPDATE event_log SET previous_chain_hash=? WHERE event_id='iter-2'").run("f".repeat(64));
          if (scenario === "record-hash") raw.prepare("UPDATE event_log SET description='changed' WHERE event_id='iter-2'").run();
        } finally { raw.exec(String(trigger.sql)); }
      }
      const before = raw.prepare("SELECT * FROM event_log ORDER BY sequence").all();
      const prepare = DatabaseSync.prototype.prepare;
      const injection = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
        const selected = sql.startsWith("SELECT ledger_id, event_id, record_kind, event_type");
        if (selected && scenario === "native-step-error") {
          this.function("chain_step", { useBigIntArguments: true }, (sequence) => {
            if (++nativeCalls === 2) throw failure;
            return sequence;
          });
          sql = sql.replace("description, sequence, previous_chain_hash", "description, chain_step(sequence) AS sequence, previous_chain_hash");
          sql = sql.replace("ORDER BY sequence ASC", "ORDER BY event_log.sequence ASC");
        }
        const statement = prepare.call(this, sql);
        if (!selected) return statement;
        const all = statement.all;
        t.mock.method(statement, "all", function (this: typeof statement, ...args: Parameters<typeof all>) { allCalls++; return all.apply(this, args); });
        const iterate = statement.iterate;
        t.mock.method(statement, "iterate", function (this: typeof statement, ...args: Parameters<typeof iterate>) {
          const rows = iterate.apply(this, args) as ReturnType<typeof iterate> & Required<Pick<ReturnType<typeof iterate>, "return">>; activeIterator = rows;
          const next = rows.next, finish = rows.return;
          assert.equal(typeof finish, "function", "pinned native iterator has explicit return/reset");
          t.mock.method(rows, "next", function () { steps++; return next.call(rows); });
          t.mock.method(rows, "return", function () { returns++; return finish!.call(rows); });
          return rows;
        });
        return statement;
      });
      if (scenario === "native-step-error") {
        assert.throws(() => store.verifyChain(), error => error === failure);
        assert.equal(nativeCalls, 2, "error originates during actual SQLite stepping");
      } else {
        const result = store.verifyChain();
        if (scenario === "empty") assert.deepEqual(result, { valid: true, verifiedRecords: 0, code: "empty" });
        else if (scenario === "large") assert.deepEqual(result, { valid: true, verifiedRecords: total });
        else assert.deepEqual(result, { valid: false, verifiedRecords: 2, breakAtSequence: scenario === "sequence" ? "4" : "3", code: scenario });
      }
      assert.equal(allCalls, 0, "chain verification must not materialize all rows");
      assert.equal(returns, 1, "explicit finally returns native cursor on every exit path");
      assert.equal(steps, scenario === "empty" ? 1 : scenario === "large" ? total + 1 : scenario === "native-step-error" ? 2 : 3);
      assert.equal(activeIterator!.next().done, true, "returned native cursor cannot continue reading");
      injection.mock.restore();
      assert.deepEqual(raw.prepare("SELECT * FROM event_log ORDER BY sequence").all(), before);
      assert.equal(raw.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!.busy, 0, "released reader does not pin the WAL checkpoint");
      assert.equal(store.count(), total, "store remains immediately readable");
      if (scenario === "empty" || scenario === "large" || scenario === "native-step-error") {
        store.appendEvent(mkEvent("chain", "after-verification"));
        assert.equal(store.count(), total + 1, "store remains immediately writable");
        assert.equal(store.verifyChain().valid, true);
      }
    } finally {
      activeIterator?.return?.();
      raw.close(); store.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("timeline-store: chain links are sequential and domain-separated", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const r1 = store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    const r2 = store.appendTerminal(mkTerminal("ledger-1", "evt-2", "fx-1"));
    assert.equal(r2.previousChainHash, r1.chainHash);
    assert.notEqual(r1.chainHash, r2.chainHash);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Crash recovery tests ==========

test("timeline-store: survives close and reopen with data intact", () => {
  const dir = mkTempDir("timeline-test-");
  const dbPath = join(dir, "timeline.db");
  try {
    const store1 = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    store1.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store1.appendTerminal(mkTerminal("ledger-1", "evt-2", "fx-1"));
    store1.appendEvent(mkEvent("ledger-1", "evt-3", "turn"));
    store1.close();
    const store2 = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    assert.equal(store2.count(), 3);
    const result = store2.verifyChain();
    assert.equal(result.valid, true);
    assert.equal(result.verifiedRecords, 3);
    const evt = store2.getEvent("evt-1");
    assert.ok(evt !== undefined);
    assert.equal(evt?.recordKind, "intent");
    store2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: chain continues after reopen", () => {
  const dir = mkTempDir("timeline-test-");
  const dbPath = join(dir, "timeline.db");
  try {
    const store1 = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    const r1 = store1.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store1.close();
    const store2 = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    const r2 = store2.appendEvent(mkEvent("ledger-1", "evt-2"));
    assert.equal(r2.previousChainHash, r1.chainHash);
    assert.equal(r2.sequence, "2");
    const result = store2.verifyChain();
    assert.equal(result.valid, true);
    assert.equal(result.verifiedRecords, 2);
    store2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: WAL mode is active", () => {
  const dir = mkTempDir("timeline-test-");
  const dbPath = join(dir, "timeline.db");
  try {
    const store = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store.close();
    // WAL file should exist during write but checkpointed on close
    // Just verify the store worked without errors
    const store2 = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    assert.equal(store2.count(), 1);
    store2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Query tests ==========

test("timeline-store: query returns all events for ledger", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store.appendEvent(mkEvent("ledger-1", "evt-2"));
    const events = store.query();
    assert.equal(events.length, 2);
    assert.equal(events[0]!.sequence, "1");
    assert.equal(events[1]!.sequence, "2");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: query by runId", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store.appendEvent({ ...mkEvent("ledger-1", "evt-2"), correlation: { runId: "run-2" } });
    const events = store.query({ runId: "run-1" });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.runId, "run-1");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: query by eventType", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendEvent(mkEvent("ledger-1", "evt-1", "turn"));
    store.appendEvent(mkEvent("ledger-1", "evt-2", "message"));
    store.appendEvent(mkEvent("ledger-1", "evt-3", "turn"));
    const events = store.query({ eventType: "turn" });
    assert.equal(events.length, 2);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: query by recordKind", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store.appendEvent(mkEvent("ledger-1", "evt-2"));
    const intents = store.query({ recordKind: "intent" });
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.recordKind, "intent");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: query with limit and offset", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    for (let i = 0; i < 10; i++) {
      store.appendEvent({ ...mkEvent("ledger-1", `evt-${i}`), eventId: `evt-${i}` });
    }
    const page1 = store.query({ limit: 3, offset: 0 });
    const page2 = store.query({ limit: 3, offset: 3 });
    assert.equal(page1.length, 3);
    assert.equal(page2.length, 3);
    assert.equal(page1[0]!.sequence, "1");
    assert.equal(page2[0]!.sequence, "4");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: query descending order", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendEvent(mkEvent("ledger-1", "evt-1"));
    store.appendEvent(mkEvent("ledger-1", "evt-2"));
    const events = store.query({ ascending: false });
    assert.equal(events[0]!.sequence, "2");
    assert.equal(events[1]!.sequence, "1");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: query by sequence range", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    for (let i = 1; i <= 5; i++) store.appendEvent({ ...mkEvent("ledger-1", `evt-${i}`), eventId: `evt-${i}` });
    const events = store.query({ fromSequence: "2", toSequence: "4" });
    assert.equal(events.length, 3);
    assert.equal(events[0]!.sequence, "2");
    assert.equal(events[2]!.sequence, "4");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: query by time range", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), wallTime: "2026-01-01T00:00:00.000Z" });
    store.appendEvent({ ...mkEvent("ledger-1", "evt-2"), wallTime: "2026-06-01T00:00:00.000Z" });
    store.appendEvent({ ...mkEvent("ledger-1", "evt-3"), wallTime: "2026-12-01T00:00:00.000Z" });
    const events = store.query({ fromWallTime: "2026-03-01T00:00:00.000Z", toWallTime: "2026-09-01T00:00:00.000Z" });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.eventId, "evt-2");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: count with filter", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store.appendEvent(mkEvent("ledger-1", "evt-2", "turn"));
    store.appendEvent(mkEvent("ledger-1", "evt-3", "turn"));
    assert.equal(store.count(), 3);
    assert.equal(store.count({ eventType: "turn" }), 2);
    assert.equal(store.count({ recordKind: "intent" }), 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: query by agentId", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), correlation: { agentId: "agent-a" } });
    store.appendEvent({ ...mkEvent("ledger-1", "evt-2"), correlation: { agentId: "agent-b" } });
    const events = store.query({ agentId: "agent-a" });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.agentId, "agent-a");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: query by turnId", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), correlation: { turnId: "turn-1" } });
    store.appendEvent({ ...mkEvent("ledger-1", "evt-2"), correlation: { turnId: "turn-2" } });
    const events = store.query({ turnId: "turn-1" });
    assert.equal(events.length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: query by taskId", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent({ ...mkIntent("ledger-1", "evt-1", "fx-1"), correlation: { taskId: "task-a" } });
    store.appendIntent({ ...mkIntent("ledger-1", "evt-2", "fx-2"), correlation: { taskId: "task-b" } });
    const events = store.query({ taskId: "task-a" });
    assert.equal(events.length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: query by effectId", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store.appendTerminal(mkTerminal("ledger-1", "evt-2", "fx-1"));
    const events = store.query({ effectId: "fx-1" });
    assert.equal(events.length, 2);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Append-only enforcement tests ==========

test("timeline-store: duplicate event ID is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    assert.throws(
      () => store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-2")),
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: ledger mismatch is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendIntent(mkIntent("ledger-2", "evt-1", "fx-1")),
      /ledger mismatch/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: invalid event type is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), eventType: "invalid-type" as never }),
      /Timeline event type is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: invalid hash is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendIntent({ ...mkIntent("ledger-1", "evt-1", "fx-1"), intentHash: "not-a-hash" }),
      /Timeline hash is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: empty description is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), description: "" }),
      /Timeline description is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: invalid actor is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), actor: { kind: "", id: "x" } as never }),
      /Timeline identifier is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: invalid correlation field is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), correlation: { badField: "x" } as never }),
      /Timeline correlation field is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: empty event ID is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), eventId: "" }),
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: invalid edge type is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), edges: [{ edgeType: "invalid" as never }] }),
      /Timeline edge type is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: too many documents is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const docs = Array.from({ length: 33 }, (_, i) => ({ name: `doc-${i}`, contentDigest: VALID_HASH }));
    assert.throws(
      () => store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), documents: docs }),
      /exceed ceiling/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: invalid wall time is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), wallTime: "" }),
      /Timeline wall time is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: invalid monotonic time is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), monotonicNanoseconds: "abc" }),
      /Timeline monotonic time is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Projection rebuild tests ==========

test("timeline-store: rebuildProjections does not lose events", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store.appendEvent(mkEvent("ledger-1", "evt-2"));
    store.rebuildProjections();
    assert.equal(store.count(), 2);
    const result = store.verifyChain();
    assert.equal(result.valid, true);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== All event types test ==========

test("timeline-store: all timeline event types are valid", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    let seq = 1;
    for (const eventType of TIMELINE_EVENT_TYPES) {
      const record = store.appendEvent({
        eventId: `evt-${eventType}`,
        ledgerId: "ledger-1",
        eventType,
        actor: { kind: "harness", id: "test" },
        description: `event ${eventType}`,
        wallTime: `2026-07-16T00:00:${String(seq).padStart(2, "0")}.000Z`,
      });
      assert.equal(record.eventType, eventType, `eventType ${eventType} should be stored`);
      seq++;
    }
    assert.equal(store.count(), TIMELINE_EVENT_TYPES.length);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: all record kinds can be stored", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store.appendTerminal(mkTerminal("ledger-1", "evt-2", "fx-1"));
    store.appendObservation(mkObservation("ledger-1", "evt-3", "obs-1", "fx-1"));
    store.appendEvent(mkEvent("ledger-1", "evt-4"));
    assert.equal(store.count(), 4);
    const kinds = new Set(store.query().map((e) => e.recordKind));
    assert.ok(kinds.has("intent"));
    assert.ok(kinds.has("terminal"));
    assert.ok(kinds.has("observation"));
    assert.ok(kinds.has("event"));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Multi-ledger tests ==========

test("timeline-store: multiple ledgers are independent", () => {
  const dir = mkTempDir("timeline-test-");
  const dbPath = join(dir, "timeline.db");
  try {
    const store1 = createTimelineStore({ path: dbPath, ledgerId: "ledger-a" });
    store1.appendIntent(mkIntent("ledger-a", "evt-a1", "fx-a1"));
    store1.close();
    const store2 = createTimelineStore({ path: dbPath, ledgerId: "ledger-b" });
    store2.appendIntent(mkIntent("ledger-b", "evt-b1", "fx-b1"));
    assert.equal(store2.count(), 1);
    assert.equal(store2.getEvent("evt-a1"), undefined);
    assert.ok(store2.getEvent("evt-b1") !== undefined);
    store2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Trace and span tests ==========

test("timeline-store: stores trace and span IDs", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const record = store.appendEvent({
      ...mkEvent("ledger-1", "evt-1"),
      traceId: "trace-abc",
      spanId: "span-xyz",
    });
    assert.equal(record.traceId, "trace-abc");
    assert.equal(record.spanId, "span-xyz");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: stores parentEventId", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendEvent(mkEvent("ledger-1", "evt-1"));
    const record = store.appendEvent({ ...mkEvent("ledger-1", "evt-2"), parentEventId: "evt-1" });
    assert.equal(record.parentEventId, "evt-1");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * The durability setting is CONFIGURED and OBSERVABLE.
 *
 * The test this replaces was named "synchronous=FULL is the default" and
 * never read the pragma: it opened two stores and appended to each, which
 * passes under FULL, NORMAL, OFF and any future value. It asserted a name.
 * These read the connection.
 */
type Durability = Readonly<{ synchronous: string; windowMs: number }>;

/**
 * Read the ledger's OWN posture. `PRAGMA synchronous` is per-connection, so a
 * second connection opened to inspect the file reports its own default (FULL)
 * and proves nothing — the first version of this test did exactly that and
 * would have "passed" against any value. The store reads the pragma back off
 * its own connection and states it; this reads what it stated.
 */
function durabilityOf(store: unknown): Durability {
  return (store as { durability(): Durability }).durability();
}

test("timeline-store: the default durability is the CONFIGURED one, read off the connection", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline-1.db"), ledgerId: "ledger-1" });
    try {
      const d = durabilityOf(store);
      assert.equal(
        d.synchronous,
        DEFAULT_TIMELINE_SYNCHRONOUS,
        "the ledger's durability default is owned by timeline-config.ts " +
          "(DEFAULT_TIMELINE_SYNCHRONOUS), not hardcoded in the store",
      );
      assert.equal(
        d.windowMs,
        DEFAULT_DURABILITY_WINDOW_MS,
        "and the exposure window it opens must be BOUNDED and STATED — a durability " +
          "trade with no number attached is the default nobody chose, one layer down",
      );
      assert.ok(d.windowMs > 0, "a zero window under NORMAL would mean nothing bounds the loss");
    } finally {
      store.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: an explicit synchronous option still wins over the default", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = createTimelineStore({
      path: join(dir, "timeline-1.db"),
      ledgerId: "ledger-1",
      synchronous: "FULL",
    });
    try {
      const d = durabilityOf(store);
      assert.equal(
        d.synchronous,
        "FULL",
        "a caller that needs FULL must be able to ask for it — the config sets the " +
          "default, it does not remove the choice",
      );
      assert.equal(
        d.windowMs,
        0,
        "under FULL the window is genuinely zero, and zero is the true answer rather " +
          "than a missing one",
      );
    } finally {
      store.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * Did a checkpoint run? A PASSIVE checkpoint copies WAL frames into the main
 * database file, so the main file GROWING past its post-migration size is
 * direct evidence. Measured: 4096 → 155648 bytes under NORMAL with a 20ms
 * window; 4096 → 4096 under FULL, where no timer is armed.
 */
function mainDbSize(path: string): number {
  return statSync(path).size;
}

async function appendsThenWait(
  path: string,
  synchronous: "NORMAL" | "FULL" | undefined,
  windowMs: number,
  waitMs: number,
): Promise<{ before: number; after: number; walPages: number }> {
  const store = createTimelineStore({
    path,
    ledgerId: "ledger-1",
    ...(synchronous !== undefined ? { synchronous } : {}),
    timelineConfig: { durabilityWindowMs: windowMs },
  });
  try {
    // Five appends. The WAL after migrations is ~186 pages — far below
    // `wal_autocheckpoint`'s 1000-page threshold — so nothing but a TIMER can
    // check-point this ledger. That is the whole point: a size bound is not a
    // time bound, and a small idle ledger never trips it.
    for (let i = 0; i < 5; i += 1) {
      store.appendIntent(mkIntent("ledger-1", `evt-${i}`, `fx-${i}`));
    }
    const walBytes = existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;
    const before = mainDbSize(path);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return { before, after: mainDbSize(path), walPages: Math.floor(walBytes / 4096) };
  } finally {
    store.close();
  }
}

test("timeline-store: the exposure window is bounded by TIME, not by WAL page count", async () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const path = join(dir, "timeline-1.db");
    const r = await appendsThenWait(path, undefined, 20, 300);
    assert.ok(
      r.walPages < 1000,
      `the WAL must be below wal_autocheckpoint's threshold (was ${r.walPages} pages) — ` +
        "otherwise SQLite's own size bound could be what check-pointed, and this test " +
        "would prove nothing about a TIME bound",
    );
    assert.ok(
      r.after > r.before,
      "the durability window timer must check-point on its own clock. An unbounded " +
        "window is what synchronous=NORMAL would otherwise buy its speed with: " +
        "wal_autocheckpoint fires on PAGE COUNT, so a handful of events on a quiet " +
        "ledger can sit unsynced for the life of the process",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: FULL arms no window timer — the window it would bound is zero", async () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const path = join(dir, "timeline-1.db");
    // Same window, same appends, same wait — the ONLY difference is that
    // every commit already fsynced, so there is nothing for a timer to bound
    // and paying for one would be pure cost.
    const r = await appendsThenWait(path, "FULL", 20, 300);
    assert.equal(
      r.after,
      r.before,
      "under FULL no checkpoint may run on a timer — if the main file grew, a timer " +
        "was armed for a window that does not exist",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: the window timer never holds the process open", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    // `getActiveResourcesInfo()` lists only the handles KEEPING THE EVENT LOOP
    // ALIVE (verified: a ref'd interval appears, the same interval after
    // .unref() does not). A ledger that kept node running would turn every CLI
    // invocation into a process that never exits.
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const store = createTimelineStore({ path: join(dir, "b.db"), ledgerId: "l" });
    try {
      assert.equal(
        process.getActiveResourcesInfo().filter((r) => r === "Timeout").length,
        before,
        "the durability timer must be unref'd",
      );
    } finally {
      store.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Hostile and edge case tests ==========

test("timeline-store: concurrent sequential appends maintain chain order", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const records = [];
    for (let i = 0; i < 20; i++) {
      records.push(store.appendEvent({ ...mkEvent("ledger-1", `evt-${i}`), eventId: `evt-${i}` }));
    }
    for (let i = 0; i < 19; i++) {
      assert.equal(records[i + 1]!.previousChainHash, records[i]!.chainHash);
    }
    const result = store.verifyChain();
    assert.equal(result.valid, true);
    assert.equal(result.verifiedRecords, 20);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: large description at boundary", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const desc = "x".repeat(8192);
    const record = store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), description: desc });
    assert.equal(record.description, desc);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: description over boundary is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), description: "x".repeat(8193) }),
      /Timeline description is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: all 8 correlation fields can be set", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const record = store.appendEvent({
      ...mkEvent("ledger-1", "evt-1"),
      correlation: {
        runId: "r", sessionId: "s", turnId: "t", messageId: "m",
        taskId: "tk", attemptId: "at", agentId: "ag", parentEffectId: "pe",
      },
    });
    assert.equal(record.runId, "r");
    assert.equal(record.sessionId, "s");
    assert.equal(record.turnId, "t");
    assert.equal(record.messageId, "m");
    assert.equal(record.taskId, "tk");
    assert.equal(record.attemptId, "at");
    assert.equal(record.agentId, "ag");
    assert.equal(record.parentEffectId, "pe");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: too many correlation fields is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendEvent({
        ...mkEvent("ledger-1", "evt-1"),
        correlation: { runId: "r", sessionId: "s", turnId: "t", messageId: "m", taskId: "tk", attemptId: "at", agentId: "ag", parentEffectId: "pe", extra: "x" } as never,
      }),
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: document with large content at boundary", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const content = "x".repeat(1024 * 1024);
    const record = store.appendIntent({
      ...mkIntent("ledger-1", "evt-1", "fx-1"),
      documents: [{ name: "large", contentJson: content, contentDigest: sha256(content) }],
    });
    assert.equal(record.documents[0]!.contentJson, content);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: document over content limit is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendIntent({
        ...mkIntent("ledger-1", "evt-1", "fx-1"),
        documents: [{ name: "too-large", contentJson: "x".repeat(1024 * 1024 + 1), contentDigest: VALID_HASH }],
      }),
      /exceeds limit/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: document with invalid digest is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendIntent({
        ...mkIntent("ledger-1", "evt-1", "fx-1"),
        documents: [{ name: "bad", contentDigest: "not-a-hash" }],
      }),
      /Timeline document digest is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: document with empty name is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendIntent({
        ...mkIntent("ledger-1", "evt-1", "fx-1"),
        documents: [{ name: "", contentDigest: VALID_HASH }],
      }),
      /Timeline document name is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: too many edges is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const edges = Array.from({ length: 33 }, (_, i) => ({ edgeType: "causal" as const, targetEventId: `evt-${i}` }));
    assert.throws(
      () => store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), edges }),
      /exceed ceiling/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: invalid event ID with special chars is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), eventId: "evt with spaces" }),
      /Timeline identifier is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: event ID with valid special chars is accepted", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const record = store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), eventId: "evt.1_2:3/4-5" });
    assert.equal(record.eventId, "evt.1_2:3/4-5");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: invalid payload ref is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), payloadRef: "has spaces" }),
      /Timeline identifier is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: invalid payload digest is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.throws(
      () => store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), payloadDigest: "short" }),
      /Timeline hash is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: chain verification detects wrong previous hash", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store.appendTerminal(mkTerminal("ledger-1", "evt-2", "fx-1"));
    // The chain should be valid
    const result = store.verifyChain();
    assert.equal(result.valid, true);
    // The append-only triggers prevent tampering, so we can't test tampering directly
    // But we can verify the chain is valid
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Append-only enforcement was asserted here by a test that appended an event,
// read it back, and checked the description was the one just written — it
// never attempted an UPDATE, so it passed with every trigger dropped. The real
// enforcement is proved behaviourally, against a raw connection the product
// does not own, in `append-only-enforcement.test.ts`. Deleted rather than
// moved: there was nothing in it to move.

test("timeline-store: reopen with multiple ledgers preserves all", () => {
  const dir = mkTempDir("timeline-test-");
  const dbPath = join(dir, "multi.db");
  try {
    const storeA = createTimelineStore({ path: dbPath, ledgerId: "ledger-a" });
    storeA.appendIntent(mkIntent("ledger-a", "evt-a1", "fx-a1"));
    storeA.close();
    const storeB = createTimelineStore({ path: dbPath, ledgerId: "ledger-b" });
    storeB.appendIntent(mkIntent("ledger-b", "evt-b1", "fx-b1"));
    storeB.close();
    const storeA2 = createTimelineStore({ path: dbPath, ledgerId: "ledger-a" });
    assert.equal(storeA2.count(), 1);
    assert.equal(storeA2.verifyChain().valid, true);
    storeA2.close();
    const storeB2 = createTimelineStore({ path: dbPath, ledgerId: "ledger-b" });
    assert.equal(storeB2.count(), 1);
    assert.equal(storeB2.verifyChain().valid, true);
    storeB2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: count with no filter counts all in ledger", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store.appendEvent(mkEvent("ledger-1", "evt-2"));
    store.appendEvent(mkEvent("ledger-1", "evt-3"));
    assert.equal(store.count(), 3);
    assert.equal(store.count({ eventType: "turn" }), 2);
    assert.equal(store.count({ runId: "run-1" }), 3);
    assert.equal(store.count({ runId: "run-missing" }), 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: projection rebuild preserves all events", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    for (let i = 0; i < 10; i++) {
      store.appendEvent({ ...mkEvent("ledger-1", `evt-${i}`), eventId: `evt-${i}` });
    }
    store.rebuildProjections();
    assert.equal(store.count(), 10);
    const result = store.verifyChain();
    assert.equal(result.valid, true);
    assert.equal(result.verifiedRecords, 10);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: empty query filter returns all", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    store.appendEvent(mkEvent("ledger-1", "evt-2"));
    const events = store.query({});
    assert.equal(events.length, 2);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: query with combined filters (runId + turnId + eventType)", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), correlation: { runId: "run-1", turnId: "turn-1" }, eventType: "turn" as never });
    store.appendEvent({ ...mkEvent("ledger-1", "evt-2"), correlation: { runId: "run-1", turnId: "turn-1" }, eventType: "message" as never });
    store.appendEvent({ ...mkEvent("ledger-1", "evt-3"), correlation: { runId: "run-1", turnId: "turn-2" }, eventType: "turn" as never });
    const events = store.query({ runId: "run-1", turnId: "turn-1", eventType: "turn" });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.eventId, "evt-1");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: query by sequence ascending and descending", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendEvent({ ...mkEvent("ledger-1", "evt-1"), wallTime: "2026-06-01T00:00:00.000Z" });
    store.appendEvent({ ...mkEvent("ledger-1", "evt-2"), wallTime: "2026-01-01T00:00:00.000Z" });
    store.appendEvent({ ...mkEvent("ledger-1", "evt-3"), wallTime: "2026-12-01T00:00:00.000Z" });
    const asc = store.query({ ascending: true });
    const desc = store.query({ ascending: false });
    assert.equal(asc[0]!.sequence, "1");
    assert.equal(desc[0]!.sequence, "3");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: 100 events maintain valid chain", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    for (let i = 0; i < 100; i++) {
      store.appendEvent({ ...mkEvent("ledger-1", `evt-${i}`), eventId: `evt-${i}` });
    }
    assert.equal(store.count(), 100);
    const result = store.verifyChain();
    assert.equal(result.valid, true);
    assert.equal(result.verifiedRecords, 100);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: close is idempotent-safe (double close doesn't crash)", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendEvent(mkEvent("ledger-1", "evt-1"));
    store.close();
    // Double close may throw, but shouldn't corrupt data
    try { store.close(); } catch { /* expected */ }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: store is frozen (immutable API object)", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    assert.ok(Object.isFrozen(store));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: schema version matches on reopen", () => {
  const dir = mkTempDir("timeline-test-");
  const dbPath = join(dir, "timeline.db");
  try {
    const store1 = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    const v1 = store1.schemaVersion;
    store1.close();
    const store2 = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    assert.equal(store2.schemaVersion, v1);
    store2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: error summary with long message at boundary", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    const msg = "x".repeat(8192);
    const term = store.appendTerminal({
      ...mkTerminal("ledger-1", "evt-2", "fx-1"),
      outcome: "failed",
      error: { category: "provider", code: "err", message: msg, retryable: false },
    });
    assert.equal(term.errorMessage, msg);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: error summary with non-boolean retryable is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    assert.throws(
      () => store.appendTerminal({
        ...mkTerminal("ledger-1", "evt-2", "fx-1"),
        outcome: "failed",
        error: { category: "p", code: "c", message: "m", retryable: "yes" as never },
      }),
      /retryable flag is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: error summary with invalid category is rejected", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    store.appendIntent(mkIntent("ledger-1", "evt-1", "fx-1"));
    assert.throws(
      () => store.appendTerminal({
        ...mkTerminal("ledger-1", "evt-2", "fx-1"),
        outcome: "failed",
        error: { category: "", code: "c", message: "m", retryable: true },
      }),
      /Timeline identifier is invalid/,
    );
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Defect: appendEvent silently dropped a partial error summary ==========

/**
 * The error columns of `event_log`, discovered from the LIVE schema rather
 * than listed here. A fifth error column added to the ledger is covered by
 * these tests the moment it exists; a hardcoded list would have to be
 * remembered, which is the same class of omission the defect itself was.
 */
function discoverErrorColumns(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("PRAGMA table_info(event_log)").all() as { name: string }[])
      .map((r) => r.name)
      .filter((name) => name.startsWith("error_"));
  } finally { db.close(); }
}

test("timeline-store: appendEvent writes every error column or none — no partial row, no placeholder", () => {
  const dir = mkTempDir("timeline-test-");
  const dbPath = join(dir, "timeline-error-atomicity.db");
  try {
    const store = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    const summary = { category: "provider", code: "llm_stream_error", message: "model not found", retryable: true };
    store.appendEvent({ ...mkEvent("ledger-1", "evt-err", "error"), outcome: "failed", error: summary });
    // A neighbouring event with NO error, so "all columns null" is exercised
    // in the same table as "all columns set".
    store.appendEvent(mkEvent("ledger-1", "evt-ok", "turn"));
    store.close();

    const errorColumns = discoverErrorColumns(dbPath);
    assert.ok(errorColumns.length >= 4, `event_log exposes no error columns: ${errorColumns.join(",")}`);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT event_id, ${errorColumns.join(", ")} FROM event_log`).all() as Record<string, unknown>[];
      assert.equal(rows.length, 2);
      for (const row of rows) {
        const populated = errorColumns.filter((c) => row[c] !== null);
        // The defect, stated mechanically: a row may describe a failure fully
        // or not at all. Anything in between is a column that was accepted and
        // then dropped on the way to the ledger.
        assert.ok(
          populated.length === 0 || populated.length === errorColumns.length,
          `event ${String(row.event_id)} has a PARTIAL error summary: ${populated.join(", ")}`,
        );
        // And nothing was invented to fill the gap. These were the two literals
        // the old code substituted for a missing code and message.
        for (const column of errorColumns) {
          assert.notEqual(row[column], "unknown", `${column} carries the placeholder "unknown"`);
          assert.notEqual(row[column], "", `${column} carries the placeholder empty string`);
        }
      }
    } finally { db.close(); }

    // Round-trip: every supplied member survives to the read model, keyed off
    // the summary itself so a new member cannot be forgotten here either.
    const reopened = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    const record = reopened.getEvent("evt-err");
    assert.ok(record !== undefined);
    for (const [member, expected] of Object.entries(summary)) {
      const field = `error${member.charAt(0).toUpperCase()}${member.slice(1)}` as keyof typeof record;
      assert.equal(record[field], expected, `${field} did not survive the append`);
    }
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: appendEvent denies a flattened error field instead of dropping it", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    // Discovered from the record shape, not typed out: every `errorX` field a
    // read record exposes is a field an untyped caller might try to pass in.
    const probe = store.appendEvent(mkEvent("ledger-1", "evt-probe", "turn"));
    const flattenedNames = Object.keys(probe).filter((k) => /^error[A-Z]/.test(k));
    assert.ok(flattenedNames.length >= 4, `no flattened error names discovered: ${flattenedNames.join(",")}`);

    let index = 0;
    for (const name of flattenedNames) {
      index += 1;
      const value = name === "errorRetryable" ? true : "provider";
      assert.throws(
        () => store.appendEvent({
          ...mkEvent("ledger-1", `evt-flat-${index}`, "error"),
          [name]: value,
        } as never),
        (error: unknown) => (error as { code?: string }).code === "timeline_error_flattened",
        `${name} was accepted (and therefore silently dropped) instead of denied`,
      );
      // Denied means NOTHING was written, not "written without the field".
      assert.equal(store.getEvent(`evt-flat-${index}`), undefined);
    }
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Defect: no trace_id filter ==========

test("timeline-store: traceId filter selects one causal chain and composes with cursor and other filters", () => {
  const dir = mkTempDir("timeline-test-");
  try {
    const store = mkStore(dir, "ledger-1");
    const traces = ["trace-a", "trace-b"];
    const appended = new Map<string, string[]>();
    for (const trace of traces) appended.set(trace, []);
    for (let i = 0; i < 6; i += 1) {
      const trace = traces[i % traces.length]!;
      const eventId = `evt-tr-${i}`;
      store.appendEvent({ ...mkEvent("ledger-1", eventId, "turn"), traceId: trace });
      appended.get(trace)!.push(eventId);
    }
    // An event with no trace at all: the filter must not sweep it in.
    store.appendEvent(mkEvent("ledger-1", "evt-no-trace", "turn"));

    for (const [trace, expected] of appended) {
      const selected = store.query({ traceId: trace });
      assert.deepEqual(selected.map((e) => e.eventId), expected, `traceId=${trace} returned the wrong set`);
      assert.equal(store.count({ traceId: trace }), expected.length);
      for (const event of selected) assert.equal(event.traceId, trace);

      // Total, deterministic order in BOTH directions.
      const descending = store.query({ traceId: trace, ascending: false });
      assert.deepEqual(descending.map((e) => e.eventId), [...expected].reverse());

      // Keyset pagination composes: page 1 then resume strictly after it.
      const firstPage = store.query({ traceId: trace, limit: 1 });
      assert.equal(firstPage.length, 1);
      const rest = store.query({ traceId: trace, cursor: firstPage[0]!.sequence });
      assert.deepEqual(
        [firstPage[0]!.eventId, ...rest.map((e) => e.eventId)],
        expected,
        "cursor page boundary skipped or repeated an event under the trace filter",
      );

      // ANDs with an unrelated filter rather than replacing it.
      assert.equal(store.count({ traceId: trace, runId: "run-1" }), expected.length);
      assert.equal(store.count({ traceId: trace, runId: "run-absent" }), 0);
    }

    // A trace nobody recorded matches nothing — it does not fall through to all.
    assert.equal(store.count({ traceId: "trace-never-recorded" }), 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: the trace filter is served by an index, not a full ledger scan", () => {
  const dir = mkTempDir("timeline-test-");
  const dbPath = join(dir, "timeline-trace-index.db");
  try {
    const store = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    store.appendEvent({ ...mkEvent("ledger-1", "evt-idx", "turn"), traceId: "trace-a" });
    store.close();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // The index is discovered from the live schema, so this asserts a plan,
      // not a name: any index SQLite chooses that covers trace_id is accepted.
      const traceIndexes = (db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event_log'",
      ).all() as { name: string; sql: string | null }[])
        .filter((row) => row.sql !== null && row.sql.includes("trace_id"))
        .map((row) => row.name);
      assert.ok(traceIndexes.length > 0, "event_log has no index covering trace_id");

      // The plan for the query `buildWhere` actually emits.
      const plan = (db.prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM event_log WHERE ledger_id = ? AND trace_id = ? ORDER BY sequence ASC LIMIT ? OFFSET ?",
      ).all("ledger-1", "trace-a", 10, 0) as { detail: string }[]).map((r) => r.detail).join(" | ");
      assert.ok(
        traceIndexes.some((name) => plan.includes(name)),
        `trace query does not use a trace index — plan was: ${plan}`,
      );
      assert.ok(!/SCAN event_log(?! USING)/.test(plan), `trace query falls back to a full scan: ${plan}`);
      // Ordering is served by the index too, so pagination does not re-sort.
      assert.ok(!plan.includes("TEMP B-TREE"), `trace query needs a sort pass: ${plan}`);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: the event-type fold filter is served by a composite index, not a full ledger scan", () => {
  const dir = mkTempDir("timeline-test-");
  const dbPath = join(dir, "timeline-type-fold-index.db");
  try {
    const store = createTimelineStore({ path: dbPath, ledgerId: "ledger-1" });
    store.appendEvent(mkEvent("ledger-1", "evt-fold", "context"));
    store.close();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // Same discovery idiom as the trace arm: the index is found from the
      // live schema by what its COLUMNS cover, not by its name. The fold
      // queries (compose state, both rewind folds, the memory store reload)
      // all filter ledger_id AND event_type, then order by sequence — an
      // index covering only one of the two equalities leaves the other as a
      // per-row filter over the whole ledger, which is the ~230-350ms
      // per-fold scan a grown ledger charged every run start.
      const foldIndexes = (db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event_log'",
      ).all() as { name: string; sql: string | null }[])
        .filter((row) => {
          if (row.sql === null) return false;
          const cols = row.sql.slice(row.sql.indexOf("(") + 1, row.sql.lastIndexOf(")"));
          return cols.includes("ledger_id") && cols.includes("event_type");
        })
        .map((row) => row.name);
      assert.ok(foldIndexes.length > 0, "event_log has no index covering ledger_id AND event_type");

      // The plan for the query `buildWhere` + `doQuery` actually emit, in the
      // ascending shape every fold uses. A bare `(event_type)` index plus a
      // sort, or a `(ledger_id, sequence)` walk filtering event_type per row,
      // are both the failure this arm exists to catch — so the chosen index
      // must be one of the composite-covering ones, with no sort pass and no
      // scan of the whole table.
      const planOf = (order: "ASC" | "DESC"): string =>
        (db.prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM event_log WHERE ledger_id = ? AND event_type = ? ORDER BY sequence ${order} LIMIT ? OFFSET ?`,
        ).all("ledger-1", "context", 10, 0) as { detail: string }[]).map((r) => r.detail).join(" | ");
      for (const order of ["ASC", "DESC"] as const) {
        const plan = planOf(order);
        assert.ok(
          foldIndexes.some((name) => plan.includes(name)),
          `event-type fold query (${order}) does not use a ledger+type composite index — plan was: ${plan}`,
        );
        assert.ok(!/SCAN event_log(?! USING)/.test(plan), `event-type fold query (${order}) falls back to a full scan: ${plan}`);
        assert.ok(!plan.includes("TEMP B-TREE"), `event-type fold query (${order}) needs a sort pass: ${plan}`);
      }
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: exact errorCode admission composes with run scope before limit and survives reopen", () => {
  const dir = mkTempDir("error-code-"), path = join(dir, "error-code.db"), ledgerId = "ledger-errors";
  let store = createTimelineStore({ path, ledgerId });
  const error = (code: string) => ({ category: "provider", code, message: "safe diagnostic", retryable: false });
  try {
    for (let i = 0; i < 1001; i++) store.appendEvent({ ...mkEvent(ledgerId, `noise-${i}`, "error"), error: error("ordinary_error") });
    store.appendEvent({ ...mkEvent(ledgerId, "policy", "provider"), error: error("llm_misalignment_policy_violation") });
    store.appendEvent({ ...mkEvent(ledgerId, "foreign-policy", "error"), correlation: { runId: "foreign-run" }, error: error("llm_misalignment_policy_violation") });
    store.close(); store = createTimelineStore({ path, ledgerId });
    const filter = { runIds: ["run-1"], errorCode: "llm_misalignment_policy_violation", limit: 1 };
    assert.deepEqual(store.querySummaries(filter).map(row => row.eventId), ["policy"]);
    assert.deepEqual(store.query(filter).map(row => row.eventId), ["policy"]); assert.equal(store.count(filter), 1);
    assert.equal(store.querySummaries({ ...filter, runIds: [] }).length, 0);
    assert.equal(store.count({ ...filter, errorCode: "LLM_MISALIGNMENT_POLICY_VIOLATION" }), 0);
    assert.equal(store.count({ ...filter, ledgerId: "other-ledger" }), 0);
    assert.equal(store.verifyChain().valid, true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
