import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createTimelineStore, type EventLedgerStoragePort } from "../../src/timeline/timeline-store.ts";
import { mkTempDir } from "../support/temp-dir.ts";

/**
 * `spectrum()` — the time-binned density aggregation behind the web UI's
 * SWEEP band (blocks `sweep.spectrum`).
 *
 * Same two properties the other aggregate reads pin, both asserted here:
 *
 *  1. TRUTH — bins match hand-computable seeds at every scope (current-ledger,
 *     time-bounded, run-bounded, proven-empty), the observed t0/t1 are what
 *     was actually seen, every matched event lands in exactly one bin, and
 *     failure is counted from recorded outcome/error columns only.
 *
 *  2. COST — every statement is index-backed, EXPLAIN-asserted: the
 *     actual ledger/run/trace/time statements seek an index, without a bare
 *     table scan or TEMP B-TREE. Ledger isolation is applied in every arm.
 */

const LEDGER = "ledger-spec";

/** Minute `m` of a fixed hour, ISO — hand-computable bin arithmetic. */
function minute(m: number): string {
  return new Date(Date.UTC(2026, 6, 1, 0, m, 0, 0)).toISOString();
}

// The seed, hand-computable. Span minute 0..39 → with bins=4 and the store's
// width rule binMs = ceil((39min + 1ms) / 4) the bins split at ~10-minute
// edges: [0..~10) [~10..~20) [~20..~30) [~30..40].
//   m0  run   (run-a)               → bin 0
//   m10 tool  failed + error_code   (run-a) → bin 1, error
//   m19 tool  succeeded (run-b)     → bin 1
//   m25 memory (no run), error_code only → bin 2, error
//   m39 tool  succeeded (run-a)     → bin 3
function seed(store: EventLedgerStoragePort): void {
  store.appendEvent({
    eventId: "s-e1", ledgerId: LEDGER, eventType: "run",
    actor: { kind: "user", id: "u-1" }, description: "run started",
    wallTime: minute(0), correlation: { runId: "run-a" },
  });
  store.appendEvent({
    eventId: "s-e2", ledgerId: LEDGER, eventType: "tool",
    actor: { kind: "user", id: "u-1" }, description: "tool:grep",
    wallTime: minute(10), correlation: { runId: "run-a" }, outcome: "failed",
    error: { category: "tool", code: "tool_failed", message: "boom", retryable: false },
  });
  store.appendEvent({
    eventId: "s-e3", ledgerId: LEDGER, eventType: "tool",
    actor: { kind: "user", id: "u-1" }, description: "tool:read_file",
    wallTime: minute(19), correlation: { runId: "run-b" }, outcome: "succeeded",
  });
  store.appendEvent({
    eventId: "s-e4", ledgerId: LEDGER, eventType: "memory",
    actor: { kind: "harness", id: "sink" }, description: "memory stored",
    wallTime: minute(25), outcome: "failed",
    error: { category: "memory", code: "memory_failed", message: "x", retryable: false },
  });
  store.appendEvent({
    eventId: "s-e5", ledgerId: LEDGER, eventType: "tool",
    actor: { kind: "user", id: "u-1" }, description: "tool:grep",
    wallTime: minute(39), correlation: { runId: "run-a" }, outcome: "succeeded",
  });
}

/**
 * The trace lane: one request's causal chain inside run-a plus unattributed
 * rows — the shape a trace scope must isolate exactly. Trace t-1 covers
 * s-t1 (m0, header, attributed to run-a), s-t3 (m19, tool-input, no run)
 * and s-t4 (m25, memory, no run); trace t-2 covers only s-t2 (m10, a FAILED
 * tool) — so scoping by t-1 proves both inclusion of the chain and exclusion
 * of the neighboring failure.
 */
function seedTraces(store: EventLedgerStoragePort): void {
  store.appendEvent({
    eventId: "s-t1", ledgerId: LEDGER, eventType: "header",
    actor: { kind: "user", id: "u-1" }, description: "request header received",
    wallTime: minute(0), traceId: "t-1", correlation: { runId: "run-a" },
  });
  store.appendEvent({
    eventId: "s-t2", ledgerId: LEDGER, eventType: "tool",
    actor: { kind: "user", id: "u-1" }, description: "tool:read_file",
    wallTime: minute(10), traceId: "t-2", outcome: "failed",
    error: { category: "tool", code: "tool_failed", message: "boom", retryable: false },
  });
  store.appendEvent({
    eventId: "s-t3", ledgerId: LEDGER, eventType: "tool-input",
    actor: { kind: "user", id: "u-1" }, description: "tool input recorded",
    wallTime: minute(19), traceId: "t-1", outcome: "succeeded",
  });
  store.appendEvent({
    eventId: "s-t4", ledgerId: LEDGER, eventType: "memory",
    actor: { kind: "harness", id: "sink" }, description: "memory stored",
    wallTime: minute(25), traceId: "t-1",
  });
}

test("spectrum bins match the hand-computed seed at current-ledger scope", () => {
  const dir = mkTempDir("timeline-spectrum-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: LEDGER });
  try {
    seed(store);
    const s = store.spectrum({ bins: 4 });
    assert.equal(s.events, 5);
    assert.equal(s.unbinnable, 0);
    assert.equal(s.t0, minute(0));
    assert.equal(s.t1, minute(39));
    assert.equal(s.bins, 4);
    // Observed span 39min; width = ceil((39*60_000 + 1) / 4).
    assert.equal(s.binMs, Math.ceil((39 * 60_000 + 1) / 4));
    assert.deepEqual(s.eventTypeBins, {
      run: [1, 0, 0, 0],
      tool: [0, 2, 0, 1],
      memory: [0, 0, 1, 0],
    });
    assert.deepEqual(s.errorBins, [0, 1, 1, 0]);
    // Every matched event is in exactly one bin — the sum is the population.
    let total = 0;
    for (const row of Object.values(s.eventTypeBins)) for (const c of row) total += c;
    assert.equal(total, s.events - s.unbinnable);
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.eventTypeBins) && Object.isFrozen(s.errorBins));
  } finally { store.close(); }
});

test("spectrum honors run scope and time bounds; empty runIds is a proven-empty spectrum", () => {
  const dir = mkTempDir("timeline-spectrum-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: LEDGER });
  try {
    seed(store);
    // run-a only: events at m0, m10, m39 — observed range is run-a's own.
    const runScoped = store.spectrum({ bins: 2, runIds: ["run-a"] });
    assert.equal(runScoped.events, 3);
    assert.equal(runScoped.t0, minute(0));
    assert.equal(runScoped.t1, minute(39));
    assert.deepEqual(runScoped.eventTypeBins, { run: [1, 0], tool: [1, 1] });
    assert.deepEqual(runScoped.errorBins, [1, 0]);

    // Duplicated run ids do not double-count.
    assert.equal(store.spectrum({ bins: 2, runIds: ["run-a", "run-a"] }).events, 3);

    // `toWallTime` is the `until` convention: only events at or before it.
    const until = store.spectrum({ bins: 2, toWallTime: minute(19) });
    assert.equal(until.events, 3);
    assert.equal(until.t1, minute(19));

    // Run + time bounds compose.
    const both = store.spectrum({ bins: 2, runIds: ["run-a"], toWallTime: minute(10) });
    assert.equal(both.events, 2);

    // Explicitly-empty run set: NOTHING matches — null range, no invented
    // zero-rows over an invented span.
    const empty = store.spectrum({ bins: 4, runIds: [] });
    assert.equal(empty.events, 0);
    assert.equal(empty.t0, null);
    assert.equal(empty.t1, null);
    assert.equal(empty.binMs, 0);
    assert.deepEqual(empty.eventTypeBins, {});
    assert.deepEqual(empty.errorBins, []);
  } finally { store.close(); }
});

test("spectrum honors TRACE scope: one request's chain, its own range, honest absence", () => {
  const dir = mkTempDir("timeline-spectrum-");
  const path = join(dir, "t.db");
  const store = createTimelineStore({ path, ledgerId: LEDGER });
  try {
    seed(store);
    seedTraces(store);
    // A second ledger SHARING the file plants the SAME trace id — the file
    // is a multi-ledger database, and a trace scope must stay inside THIS
    // ledger's chain. (A trace_id-only predicate would cross the border:
    // this arm is what keeps the ledger_id binding honest.)
    const neighbor = createTimelineStore({ path, ledgerId: "ledger-other" });
    try {
      neighbor.appendEvent({
        eventId: "s-x1", ledgerId: "ledger-other", eventType: "tool",
        actor: { kind: "user", id: "u-1" }, description: "tool:grep",
        wallTime: minute(5), traceId: "t-1", outcome: "succeeded",
      });
    } finally { neighbor.close(); }

    // t-1's chain: m0 header (in run-a), m19 tool-input, m25 memory — the
    // chain crosses attributed and unattributed rows without dragging
    // run-a's OTHER events in, the neighbor ledger's t-1 row in, and t-2's
    // failed tool (m10) in.
    const traced = store.spectrum({ bins: 2, traceId: "t-1" });
    assert.equal(traced.events, 3);
    assert.equal(traced.t0, minute(0));
    assert.equal(traced.t1, minute(25));
    assert.deepEqual(traced.eventTypeBins, { header: [1, 0], "tool-input": [0, 1], memory: [0, 1] });
    assert.deepEqual(traced.errorBins, [0, 0]);

    // A trace + time bound composes like every other scope.
    const until = store.spectrum({ bins: 2, traceId: "t-1", toWallTime: minute(19) });
    assert.equal(until.events, 2);
    assert.equal(until.t1, minute(19));

    // A trace + run conjunction narrows the chain by attribution too —
    // only the chain's run-a row survives both filters.
    const conj = store.spectrum({ bins: 2, traceId: "t-1", runIds: ["run-a"] });
    assert.equal(conj.events, 1);

    // An unknown trace is a PROVEN-EMPTY scope — null range, no invented
    // bins over an invented span.
    const absent = store.spectrum({ bins: 4, traceId: "t-none" });
    assert.equal(absent.events, 0);
    assert.equal(absent.t0, null);
    assert.equal(absent.t1, null);
    assert.equal(absent.binMs, 0);
    assert.deepEqual(absent.eventTypeBins, {});
    assert.deepEqual(absent.errorBins, []);
  } finally { store.close(); }
});

test("spectrum DENIES invalid bins and invalid run ids instead of guessing", () => {
  const dir = mkTempDir("timeline-spectrum-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: LEDGER });
  try {
    for (const bins of [0, -1, 2001, 1.5, Number.NaN]) {
      assert.throws(
        () => store.spectrum({ bins }),
        (error: unknown) => (error as { code?: string }).code === "timeline_spectrum_bins_invalid",
        `bins=${bins} must be refused`,
      );
    }
    assert.throws(
      () => store.spectrum({ bins: 4, runIds: [""] }),
      (error: unknown) => (error as { code?: string }).code === "timeline_run_id_invalid",
    );
    // An empty trace id is the same refusal, not a zero-row guess.
    assert.throws(
      () => store.spectrum({ bins: 4, traceId: "" }),
      (error: unknown) => (error as { code?: string }).code === "timeline_trace_id_invalid",
    );
  } finally { store.close(); }
});

test("a single-instant spectrum still has a bin width, and everything lands in bin 0", () => {
  const dir = mkTempDir("timeline-spectrum-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: LEDGER });
  try {
    store.appendEvent({
      eventId: "one-1", ledgerId: LEDGER, eventType: "run",
      actor: { kind: "user", id: "u-1" }, description: "r", wallTime: minute(5),
    });
    store.appendEvent({
      eventId: "one-2", ledgerId: LEDGER, eventType: "tool",
      actor: { kind: "user", id: "u-1" }, description: "tool:x", wallTime: minute(5),
    });
    const s = store.spectrum({ bins: 8 });
    assert.equal(s.binMs, 1);
    assert.deepEqual(s.eventTypeBins, { run: [1, 0, 0, 0, 0, 0, 0, 0], tool: [1, 0, 0, 0, 0, 0, 0, 0] });
  } finally { store.close(); }
});

test("spectrum's actual SELECT statements seek indexes without a temporary sort", (t) => {
  const dir = mkTempDir("timeline-spectrum-plans-");
  const path = join(dir, "t.db");
  const store = createTimelineStore({ path, ledgerId: LEDGER });
  const statements = new Set<string>();
  const prepare = DatabaseSync.prototype.prepare;
  try {
    seed(store);
    seedTraces(store);
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql.startsWith("SELECT wall_time, event_type, outcome, error_code FROM event_log")) statements.add(sql);
      return prepare.call(this, sql);
    });
    for (const filter of [
      {}, { fromWallTime: minute(0) }, { fromWallTime: minute(0), toWallTime: minute(39) },
      { runIds: ["run-a", "run-b"] }, { runIds: ["run-a", "run-b"], toWallTime: minute(39) },
      { traceId: "t-1" }, { traceId: "t-1", toWallTime: minute(39) },
      { traceId: "t-1", runIds: ["run-a", "run-b"] },
    ]) store.spectrum({ ...filter, bins: 2 });
    assert.equal(statements.size, 8, "all scope/time shapes must reach the actual SQL owner");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      for (const sql of statements) {
        assert.match(sql, /WHERE ledger_id = \?/, "every arm must bind this ledger");
        const params = Array.from({ length: sql.split("?").length - 1 }, () => "x");
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((row) => row.detail).join(" | ");
        assert.match(plan, /SEARCH event_log USING (?:COVERING )?INDEX/, sql + "\n" + plan);
        assert.ok(!plan.includes("TEMP B-TREE"), sql + "\n" + plan);
      }
    } finally { db.close(); }
  } finally { t.mock.restoreAll(); store.close(); }
});

test("spectrum run and bare scopes stay inside their store ledger", () => {
  const dir = mkTempDir("timeline-spectrum-ledgers-");
  const path = join(dir, "t.db");
  const store = createTimelineStore({ path, ledgerId: LEDGER });
  const other = createTimelineStore({ path, ledgerId: "ledger-neighbor" });
  try {
    seed(store);
    const bare = store.spectrum({ bins: 2 });
    const runs = store.spectrum({ bins: 2, runIds: ["run-a"] });
    other.appendEvent({ eventId: "neighbor-same-run", ledgerId: other.ledgerId, eventType: "tool",
      actor: { kind: "user", id: "u" }, correlation: { runId: "run-a" },
      description: "another ledger", outcome: "failed", wallTime: minute(-100) });
    assert.deepEqual(store.spectrum({ bins: 2 }), bare);
    assert.deepEqual(store.spectrum({ bins: 2, runIds: ["run-a"] }), runs);
    assert.deepEqual(store.spectrum({ bins: 2, runIds: ["run-a"], toWallTime: minute(39) }), runs);
    assert.equal(other.spectrum({ bins: 2 }).events, 1);
    assert.equal(other.spectrum({ bins: 2, runIds: ["run-a"] }).events, 1);
  } finally { other.close(); store.close(); }
});

test("trace/run intersection admits large owned-run sets without losing or duplicating rows", () => {
  const dir = mkTempDir("timeline-spectrum-many-runs-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: LEDGER });
  try {
    seed(store); seedTraces(store);
    store.appendEvent({ ledgerId: LEDGER, eventId: "wide-tail", eventType: "tool",
      actor: { kind: "user", id: "u-1" }, description: "tail membership", traceId: "t-1",
      correlation: { runId: "run-tail" }, wallTime: minute(30), outcome: "failed" });
    const expected = store.spectrum({ bins: 2, traceId: "t-1", runIds: ["run-a", "run-tail"] });
    const runIds = ["run-a", ...Array.from({ length: 40_000 }, (_, i) => `absent-run-${i}`), "run-a", "run-tail"];
    store.appendEvent({ ledgerId: LEDGER, eventId: "wide-foreign", eventType: "tool",
      actor: { kind: "user", id: "u-1" }, description: "foreign run", traceId: "t-1",
      correlation: { runId: "foreign-run" }, wallTime: minute(-100), outcome: "failed" });
    const neighbor = createTimelineStore({ path: join(dir, "t.db"), ledgerId: "ledger-neighbor" });
    try {
      neighbor.appendEvent({ ledgerId: neighbor.ledgerId, eventId: "wide-neighbor", eventType: "tool",
        actor: { kind: "user", id: "u-1" }, description: "neighbor ledger", traceId: "t-1",
        correlation: { runId: "run-a" }, wallTime: minute(100), outcome: "failed" });
    } finally { neighbor.close(); }
    assert.deepEqual(store.spectrum({ bins: 2, traceId: "t-1", runIds }), expected);
    assert.equal(expected.events, 2);
    assert.equal(expected.t0, minute(0)); assert.equal(expected.t1, minute(30));
    assert.deepEqual(expected.eventTypeBins, { header: [1, 0], tool: [0, 1] });
    assert.deepEqual(expected.errorBins, [0, 1]);
    assert.equal(store.spectrum({ bins: 2, traceId: "t-1", runIds: [] }).events, 0);
  } finally { store.close(); }
});
