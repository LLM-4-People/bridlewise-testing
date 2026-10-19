import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createTimelineStore, type EventLedgerStoragePort } from "../../src/timeline/timeline-store.ts";
import {
  TIMELINE_EVENT_TYPES,
  type TimelineEventType,
} from "../../src/timeline/timeline-types.ts";
import { mkTempDir } from "../support/temp-dir.ts";

/**
 * `occurrenceCounts()` + `recordingGapCounts()` — the aggregate reads behind
 * the web UI's DARKFIELD/ANNUNCIATOR coverage instruments.
 *
 * Two properties matter and both are pinned here:
 *
 *  1. TRUTH — the counts match hand-computable seeds, including the
 *     file-vs-ledger scope statement (`ledgers`) when a second ledger shares
 *     the file, and the derived sums (`totalEvents`, `edgeRows`) equal their
 *     group totals.
 *
 *  2. COST — every statement the two methods emit is index-backed: covering
 *     scans for the grouped counts and the IS-NULL run gap, covering searches
 *     for the per-ledger trace gap, type-bounded searches for the typed gaps.
 *     Asserted via EXPLAIN QUERY PLAN on the same statements (the idiom the
 *     trace-index test in timeline-store.test.ts established): no bare table
 *     scan, no temp B-tree.
 */

const VALID_HASH = "a".repeat(64);
const AT = "2026-07-16T00:00:00.000Z";

function seed(store: EventLedgerStoragePort, ledgerId: string): void {
  store.appendEvent({
    eventId: `${ledgerId}-e1`, ledgerId, eventType: "run",
    actor: { kind: "user", id: "u-1" }, description: "run started",
    wallTime: AT, traceId: "trace-1", correlation: { runId: "run-a" },
  });
  store.appendEvent({
    eventId: `${ledgerId}-e2`, ledgerId, eventType: "tool",
    actor: { kind: "user", id: "u-1" }, description: "tool inside the run",
    wallTime: AT, correlation: { runId: "run-a" },
    edges: [
      { edgeType: "causal", targetEventId: `${ledgerId}-e1` },
      { edgeType: "part-of", targetEventId: `${ledgerId}-e1` },
    ],
  });
  store.appendEvent({
    eventId: `${ledgerId}-e3`, ledgerId, eventType: "tool",
    actor: { kind: "harness", id: "sink" }, description: "tool outside any run",
    wallTime: AT,
  });
  store.appendIntent({
    eventId: `${ledgerId}-i1`, ledgerId, eventType: "filesystem",
    effectKind: "filesystem", effectId: "fx-1",
    actor: { kind: "user", id: "u-1" }, description: "write intent",
    intentHash: VALID_HASH, wallTime: AT, traceId: "trace-2",
    correlation: { runId: "run-a" },
  });
  store.appendTerminal({
    eventId: `${ledgerId}-t1`, ledgerId, eventType: "filesystem",
    effectId: "fx-1", outcome: "succeeded", resultHash: VALID_HASH, wallTime: AT,
  });
}
// Per ledger: 5 events (run 1, tool 2, filesystem 2); kinds event 3 /
// intent 1 / terminal 1; edges causal 1 + part-of 1; without run: e3 + t1
// (terminals carry no correlation) = 2; without trace: e2, e3, t1 = 3.

test("occurrenceCounts counts real rows per vocabulary value, with derived sums", () => {
  const dir = mkTempDir("timeline-coverage-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: "ledger-cov" });
  try {
    seed(store, "ledger-cov");
    const occ = store.occurrenceCounts();
    assert.equal(occ.totalEvents, 5);
    assert.deepEqual(occ.ledgers, [{ ledgerId: "ledger-cov", events: 5 }]);
    assert.deepEqual(occ.eventTypeCounts, { run: 1, tool: 2, filesystem: 2 });
    assert.deepEqual(occ.recordKindCounts, { event: 3, intent: 1, terminal: 1 });
    assert.deepEqual(occ.edgeTypeCounts, { causal: 1, "part-of": 1 });
    assert.equal(occ.edgeRows, 2);
    assert.ok(Object.isFrozen(occ) && Object.isFrozen(occ.eventTypeCounts));
  } finally { store.close(); }
});

test("occurrenceCounts is file-scoped and SAYS so: a second ledger in the file is visible, never merged silently", () => {
  const dir = mkTempDir("timeline-coverage-");
  const path = join(dir, "t.db");
  const a = createTimelineStore({ path, ledgerId: "ledger-a" });
  try { seed(a, "ledger-a"); } finally { a.close(); }
  const b = createTimelineStore({ path, ledgerId: "ledger-b" });
  try {
    b.appendEvent({
      eventId: "b-e1", ledgerId: "ledger-b", eventType: "memory",
      actor: { kind: "harness", id: "other" }, description: "another ledger's event",
      wallTime: AT,
    });
    const occ = b.occurrenceCounts();
    // The counts span the FILE (both ledgers)…
    assert.equal(occ.totalEvents, 6);
    assert.equal(occ.eventTypeCounts["memory"], 1);
    // …and the scope statement names both, so nothing is silently merged.
    assert.deepEqual(
      [...occ.ledgers].sort((x, y) => x.ledgerId.localeCompare(y.ledgerId)),
      [{ ledgerId: "ledger-a", events: 5 }, { ledgerId: "ledger-b", events: 1 }],
    );
    // The ledger-scoped read is unchanged — the two answer different questions.
    assert.equal(b.count(), 1);
  } finally { b.close(); }
});

test("recordingGapCounts matches hand-computed run/trace gaps, whole-file and type-bounded", () => {
  const dir = mkTempDir("timeline-coverage-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: "ledger-cov" });
  try {
    seed(store, "ledger-cov");
    assert.deepEqual(store.recordingGapCounts(), { events: 5, withoutRun: 1, withoutTrace: 2 });
    assert.deepEqual(store.recordingGapCounts("tool"), { events: 2, withoutRun: 1, withoutTrace: 2 });
    // A type that never occurred: counted zeros, because the search really ran.
    assert.deepEqual(store.recordingGapCounts("rollback"), { events: 0, withoutRun: 0, withoutTrace: 0 });
  } finally { store.close(); }
});

test("recordingGapCounts DENIES an undeclared event type instead of answering 0 for it", () => {
  const dir = mkTempDir("timeline-coverage-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: "ledger-cov" });
  try {
    assert.throws(
      () => store.recordingGapCounts("not-a-type" as TimelineEventType),
      (error: unknown) =>
        (error as { code?: string }).code === "timeline_event_type_invalid",
    );
  } finally { store.close(); }
});

test("every statement the two methods emit is index-backed — no table scan, no temp B-tree", () => {
  const dir = mkTempDir("timeline-coverage-");
  const path = join(dir, "t.db");
  const store = createTimelineStore({ path, ledgerId: "ledger-cov" });
  try { seed(store, "ledger-cov"); } finally { store.close(); }

  // The statements doOccurrenceCounts/doRecordingGapCounts actually emit —
  // same mirroring idiom as the trace-index plan test in timeline-store.test.ts.
  const STATEMENTS: readonly string[] = [
    "SELECT ledger_id AS k, COUNT(*) AS c FROM event_log GROUP BY ledger_id",
    "SELECT event_type AS k, COUNT(*) AS c FROM event_log GROUP BY event_type",
    "SELECT record_kind AS k, COUNT(*) AS c FROM event_log GROUP BY record_kind",
    "SELECT edge_type AS k, COUNT(*) AS c FROM event_edges GROUP BY edge_type",
    "SELECT COUNT(*) AS c FROM event_log WHERE run_id IS NULL",
    "SELECT COUNT(*) AS c FROM event_log WHERE ledger_id = ? AND trace_id IS NULL",
    "SELECT COUNT(*) AS c FROM event_log WHERE event_type = ?",
    "SELECT COUNT(*) AS c FROM event_log WHERE event_type = ? AND run_id IS NULL",
    "SELECT COUNT(*) AS c FROM event_log WHERE event_type = ? AND trace_id IS NULL",
  ];

  const db = new DatabaseSync(path, { readOnly: true });
  try {
    for (const sql of STATEMENTS) {
      const params = Array.from({ length: sql.split("?").length - 1 }, () => "x");
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
        .map((r) => r.detail)
        .join(" | ");
      assert.match(plan, /USING (COVERING )?INDEX/, `not index-backed: ${sql}\nplan: ${plan}`);
      assert.ok(!/SCAN (event_log|event_edges)(?! USING)/.test(plan), `full table scan: ${sql}\nplan: ${plan}`);
      assert.ok(!plan.includes("TEMP B-TREE"), `needs a sort/group pass: ${sql}\nplan: ${plan}`);
    }
  } finally { db.close(); }
});

test("the occurrence keys are ledger truth, joinable against the declared registry", () => {
  // The caller-side join (declared vs occurred) only works if the keys here
  // are the raw column values. Seeded types must appear verbatim and be
  // members of the declared registry.
  const dir = mkTempDir("timeline-coverage-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: "ledger-cov" });
  try {
    seed(store, "ledger-cov");
    const declared = new Set<string>(TIMELINE_EVENT_TYPES);
    for (const key of Object.keys(store.occurrenceCounts().eventTypeCounts)) {
      assert.ok(declared.has(key), `occurrence key "${key}" is not a declared event type`);
    }
  } finally { store.close(); }
});
