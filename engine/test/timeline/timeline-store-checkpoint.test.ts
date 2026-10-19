import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTempDir } from "../support/temp-dir.ts";

/**
 * INVARIANT #52: when the WAL checkpoint fails on close, the store must
 * return { checkpointSuccess: false } and emit a stderr message — it must
 * not silently swallow the failure or pretend success.
 *
 * NOTE: EventLedgerStoragePort.close is typed as `void` in the interface
 * but the concrete store returns `{ checkpointSuccess: boolean }`. We cast
 * the result to read the field.
 */

type CloseResult = { checkpointSuccess: boolean };

function closeStore(store: { close(): void }): CloseResult {
  return store.close() as unknown as CloseResult;
}

function captureStderr<T>(fn: () => T): { stderr: string; result: T } {
  let captured = "";
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => { captured += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    const result = fn();
    process.stderr.write = original;
    return { stderr: captured, result };
  } catch (error) {
    process.stderr.write = original;
    throw error;
  }
}

test("TimelineStore checkpoint: successful close returns checkpointSuccess true", () => {
  const dir = createTempDir("tl-checkpoint-ok-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline.db") });
    store.appendEvent({
      eventId: "evt-1",
      ledgerId: store.ledgerId,
      eventType: "run",
      actor: { kind: "harness", id: "test" },
      description: "test event",
      wallTime: new Date().toISOString(),
    });
    const result = closeStore(store);
    assert.equal(result.checkpointSuccess, true, "a normal close must report checkpointSuccess: true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TimelineStore checkpoint: checkpoint failure surfaces { checkpointSuccess: false } and a stderr message", () => {
  const dir = createTempDir("tl-checkpoint-fail-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline.db") });
    store.appendEvent({
      eventId: "evt-1",
      ledgerId: store.ledgerId,
      eventType: "run",
      actor: { kind: "harness", id: "test" },
      description: "test event",
      wallTime: new Date().toISOString(),
    });
    // Fail the actual checkpoint while retaining the real database close.
    const prepare = DatabaseSync.prototype.prepare;
    let checkpointCalls = 0;
    DatabaseSync.prototype.prepare = function (sql: string) {
      if (sql === "PRAGMA main.wal_checkpoint(TRUNCATE)") {
        checkpointCalls++;
        throw new Error("fixture-secret");
      }
      return prepare.call(this, sql);
    };
    try {
      const { stderr, result } = captureStderr(() => closeStore(store));
      assert.equal(result.checkpointSuccess, false);
      assert.equal(checkpointCalls, 1);
      assert.match(stderr, /\[debug\] diagnostic unavailable/);
      assert.equal(stderr.includes("fixture-secret"), false);
    } finally { DatabaseSync.prototype.prepare = prepare; }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TimelineStore checkpoint: close result has the expected shape", () => {
  const dir = createTempDir("tl-checkpoint-shape-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline.db") });
    const result = closeStore(store);
    assert.ok(typeof result.checkpointSuccess === "boolean", "close() must return { checkpointSuccess: boolean }");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TimelineStore checkpoint: a real pinned old reader reports incomplete checkpoint while close releases its handle", () => {
  const dir = createTempDir("tl-checkpoint-reader-"); const path = join(dir, "timeline.db");
  const store = createTimelineStore({ path, ledgerId: "checkpoint", timelineConfig: { sqliteBusyTimeoutMs: 0, durabilityWindowMs: 0 } });
  const append = (eventId: string) => store.appendEvent({ eventId, ledgerId: store.ledgerId, eventType: "run", actor: { kind: "harness", id: "test" }, description: "checkpoint", wallTime: new Date().toISOString() });
  append("before-reader"); const reader = new DatabaseSync(path);
  let storeOpen = true;
  try {
    reader.exec("BEGIN"); assert.equal((reader.prepare("SELECT count(*) AS n FROM event_log").get() as { n: number }).n, 1);
    append("after-reader"); assert.equal((reader.prepare("SELECT count(*) AS n FROM event_log").get() as { n: number }).n, 1);
    const probe = new DatabaseSync(path);
    try {
      probe.exec("PRAGMA busy_timeout=0");
      const passive = probe.prepare("PRAGMA main.wal_checkpoint(PASSIVE)").get() as { busy: number; log: number; checkpointed: number };
      const truncate = probe.prepare("PRAGMA main.wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number; checkpointed: number };
      assert.equal(passive.busy, 0); assert.ok(passive.log > passive.checkpointed);
      assert.equal(truncate.busy, 1); assert.ok(truncate.log > truncate.checkpointed);
    } finally { probe.close(); }
    // The store's own TRUNCATE is blocked the same way: it throws nothing, and
    // its result row still says it did not complete.
    const result = closeStore(store); storeOpen = false; assert.equal(result.checkpointSuccess, false);
    reader.exec("ROLLBACK");
    const reopened = createTimelineStore({ path, ledgerId: "checkpoint", timelineConfig: { durabilityWindowMs: 0 } });
    assert.equal(reopened.count(), 2); assert.equal(closeStore(reopened).checkpointSuccess, true);
  } finally { if (reader.isTransaction) reader.exec("ROLLBACK"); reader.close(); if (storeOpen) store.close(); rmSync(dir, { recursive: true, force: true }); }
});
