import { sha256 } from "../../src/kernel/integrity.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTimelineStore, type EventLedgerStoragePort } from "../../src/timeline/timeline-store.ts";
import { createTimelineQuery, type TimelineQuery } from "../../src/timeline/timeline-query.ts";
import { mkTempDir } from "../support/temp-dir.ts";

const VALID_HASH = "a".repeat(64);

function seedStore(store: EventLedgerStoragePort): void {
  store.appendEvent({
    eventId: "evt-run", ledgerId: store.ledgerId, eventType: "run",
    actor: { kind: "harness", id: "test" },
    correlation: { runId: "run-1" },
    description: "run started", wallTime: "2026-01-01T00:00:00.000Z",
  });
  store.appendEvent({
    eventId: "evt-turn", ledgerId: store.ledgerId, eventType: "turn",
    actor: { kind: "harness", id: "test" },
    correlation: { runId: "run-1", turnId: "turn-1" },
    description: "turn started", wallTime: "2026-01-01T00:00:01.000Z",
  });
  store.appendEvent({
    eventId: "evt-msg", ledgerId: store.ledgerId, eventType: "message",
    actor: { kind: "user", id: "user-1" },
    correlation: { runId: "run-1", turnId: "turn-1", messageId: "msg-1" },
    description: "hello", wallTime: "2026-01-01T00:00:02.000Z",
  });
  store.appendEvent({
    eventId: "evt-token", ledgerId: store.ledgerId, eventType: "token",
    actor: { kind: "harness", id: "test" },
    correlation: { runId: "run-1", turnId: "turn-1" },
    description: "token usage", wallTime: "2026-01-01T00:00:03.000Z",
  });
  store.appendEvent({
    eventId: "evt-agent", ledgerId: store.ledgerId, eventType: "agent",
    actor: { kind: "harness", id: "agent-a" },
    correlation: { runId: "run-1", agentId: "agent-a" },
    description: "agent started", wallTime: "2026-01-01T00:00:04.000Z",
  });
}

function mkQuery(dir: string): { query: TimelineQuery; store: EventLedgerStoragePort } {
  const store = createTimelineStore({
    path: join(dir, `q-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
    ledgerId: "ledger-q",
  });
  seedStore(store);
  return { query: createTimelineQuery(store), store };
}

// a2-design H1: the configured `timeline.queryDefaultLimit` is THE default of
// a query that names no limit — in the store and in the query layer over it
// (both used to read the code constant, so the operator's value moved shard
// imports only). An explicit limit still wins.
test("timeline-query: a query without a limit returns the configured timeline.queryDefaultLimit rows", () => {
  const dir = mkTempDir("tl-query-default-limit-");
  try {
    const store = createTimelineStore({ path: join(dir, "limit.db"), ledgerId: "ledger-limit", timelineConfig: { queryDefaultLimit: 2 } });
    seedStore(store);
    assert.equal(store.query().length, 2, "the store's unbounded query");
    assert.equal(store.querySummaries().length, 2, "the store's unbounded summary query");
    const query = createTimelineQuery(store);
    const page = query.all();
    assert.equal(page.events.length, 2, "the query layer passes an absent limit to the store");
    assert.equal(page.total, 5);
    assert.equal(page.hasMore, true);
    assert.equal(query.eventSummaries().events.length, 2);
    assert.equal(query.all({ limit: 4 }).events.length, 4, "an explicit limit wins");
    assert.throws(() => query.all({ limit: -1 }), (error: unknown) => error instanceof Error && (error as { code?: string }).code === "timeline_query_limit_invalid");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeline-query: byRun filters by runId", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.byRun("run-1");
    assert.equal(result.total, 5);
    assert.equal(result.events.length, 5);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: byRun returns empty for missing run", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.byRun("run-missing");
    assert.equal(result.total, 0);
    assert.equal(result.events.length, 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── PREVENTION (exp505): multi-run filtering (chat/project scope) ──
// Regression: the canonical timeline only supported a single `runId` filter.
// A chat or project maps to MULTIPLE runs, so the web UI had no server-side
// way to scope the ledger (it returned ALL events and filtered client-side,
// which leaked events from other chats/projects). This test guards the
// `byRuns` / `runIds` `IN (...)` filter added to fix the root cause.
function seedMultiRun(store: EventLedgerStoragePort): void {
  const runs = ["run-A", "run-B", "run-C"];
  for (const runId of runs) {
    store.appendEvent({
      eventId: `evt-${runId}-run`, ledgerId: store.ledgerId, eventType: "run",
      actor: { kind: "harness", id: "test" },
      correlation: { runId },
      description: `${runId} started`, wallTime: "2026-01-01T00:00:00.000Z",
    });
    store.appendEvent({
      eventId: `evt-${runId}-msg`, ledgerId: store.ledgerId, eventType: "message",
      actor: { kind: "harness", id: "test" },
      correlation: { runId, messageId: `${runId}-m` },
      description: `${runId} message`, wallTime: "2026-01-01T00:00:01.000Z",
    });
  }
  // An event with no runId (should never match a runIds filter).
  store.appendEvent({
    eventId: "evt-no-run", ledgerId: store.ledgerId, eventType: "message",
    actor: { kind: "harness", id: "test" },
    description: "orphan", wallTime: "2026-01-01T00:00:02.000Z",
  });
}

test("timeline-query: byRuns filters by multiple runIds (IN (...))", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const store = createTimelineStore({
      path: join(dir, `q-multi-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
      ledgerId: "ledger-multi",
    });
    seedMultiRun(store);
    const query = createTimelineQuery(store);
    // Filter to run-A + run-B (a chat/project with two runs).
    const result = query.byRuns(["run-A", "run-B"]);
    assert.equal(result.total, 4);
    const runIds = new Set(result.events.map((e) => e.runId));
    assert.ok(runIds.has("run-A"));
    assert.ok(runIds.has("run-B"));
    assert.ok(!runIds.has("run-C"));
    assert.ok(!runIds.has(null));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: byRuns with empty array matches nothing (not all)", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const store = createTimelineStore({
      path: join(dir, `q-empty-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
      ledgerId: "ledger-empty",
    });
    seedMultiRun(store);
    const query = createTimelineQuery(store);
    const result = query.byRuns([]);
    // Empty runIds = "match no runs" = zero events (distinct from no run
    // filter). A chat/project with no runs must show NO events, not all.
    assert.equal(result.total, 0);
    assert.equal(result.events.length, 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: all with runIds option filters like byRuns", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const store = createTimelineStore({
      path: join(dir, `q-opt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
      ledgerId: "ledger-opt",
    });
    seedMultiRun(store);
    const query = createTimelineQuery(store);
    const result = query.all({ runIds: ["run-C"] });
    assert.equal(result.total, 2);
    assert.ok(result.events.every((e) => e.runId === "run-C"));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: byTurn filters by runId and turnId", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.byTurn("run-1", "turn-1");
    assert.equal(result.total, 3);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: byAgent filters by agentId", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.byAgent("agent-a");
    assert.equal(result.total, 1);
    assert.equal(result.events[0]!.eventType, "agent");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: byEventType filters by event type", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.byEventType("message");
    assert.equal(result.total, 1);
    assert.equal(result.events[0]!.eventId, "evt-msg");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: byRecordKind filters by record kind", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.byRecordKind("event");
    assert.equal(result.total, 5);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: byTimeRange filters by time window", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.byTimeRange("2026-01-01T00:00:01.500Z", "2026-01-01T00:00:03.500Z");
    assert.equal(result.total, 2);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: bySequenceRange filters by sequence window", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.bySequenceRange("2", "4");
    assert.equal(result.total, 3);
    // The paginated query service is newest-first by default
    // (DEFAULT_TIMELINE_QUERY_ASCENDING), so the window comes back 4,3,2.
    assert.equal(result.events[0]!.sequence, "4");
    assert.equal(result.events[2]!.sequence, "2");
    const ascending = query.bySequenceRange("2", "4", { ascending: true });
    assert.equal(ascending.events[0]!.sequence, "2");
    assert.equal(ascending.events[2]!.sequence, "4");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: all returns all events", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.all();
    assert.equal(result.total, 5);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: pagination with limit and offset", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const page1 = query.all({ limit: 2, offset: 0 });
    const page2 = query.all({ limit: 2, offset: 2 });
    assert.equal(page1.events.length, 2);
    assert.equal(page2.events.length, 2);
    assert.equal(page1.hasMore, true);
    assert.notEqual(page1.events[0]!.eventId, page2.events[0]!.eventId);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: hasMore is false on last page", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.all({ limit: 10, offset: 0 });
    assert.equal(result.hasMore, false);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: getEvent returns a specific event", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const event = query.getEvent("evt-msg");
    assert.ok(event !== undefined);
    assert.equal(event?.eventId, "evt-msg");
    assert.equal(event?.eventType, "message");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: getEvent returns undefined for missing", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    assert.equal(query.getEvent("missing"), undefined);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: edges returns edges for an event", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const store = createTimelineStore({ path: join(dir, "q.db"), ledgerId: "ledger-q" });
    store.appendEvent({
      eventId: "evt-1", ledgerId: "ledger-q", eventType: "turn",
      actor: { kind: "harness", id: "test" },
      description: "turn", wallTime: "2026-01-01T00:00:00.000Z",
    });
    store.appendEvent({
      eventId: "evt-2", ledgerId: "ledger-q", eventType: "message",
      actor: { kind: "harness", id: "test" },
      description: "msg", wallTime: "2026-01-01T00:00:01.000Z",
      edges: [{ edgeType: "causal", targetEventId: "evt-1" }],
    });
    const query = createTimelineQuery(store);
    const edges = query.edges("evt-2");
    assert.equal(edges.length, 1);
    assert.equal(edges[0]!.edgeType, "causal");
    assert.equal(edges[0]!.targetEventId, "evt-1");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: edges returns empty for event with no edges", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const edges = query.edges("evt-run");
    assert.equal(edges.length, 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: traverse follows edges to target events", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const store = createTimelineStore({ path: join(dir, "q.db"), ledgerId: "ledger-q" });
    store.appendEvent({
      eventId: "evt-1", ledgerId: "ledger-q", eventType: "run",
      actor: { kind: "harness", id: "test" },
      description: "run", wallTime: "2026-01-01T00:00:00.000Z",
    });
    store.appendEvent({
      eventId: "evt-2", ledgerId: "ledger-q", eventType: "turn",
      actor: { kind: "harness", id: "test" },
      description: "turn", wallTime: "2026-01-01T00:00:01.000Z",
      edges: [{ edgeType: "part-of", targetEventId: "evt-1" }],
    });
    store.appendEvent({
      eventId: "evt-3", ledgerId: "ledger-q", eventType: "message",
      actor: { kind: "harness", id: "test" },
      description: "msg", wallTime: "2026-01-01T00:00:02.000Z",
      edges: [{ edgeType: "part-of", targetEventId: "evt-2" }, { edgeType: "causal", targetEventId: "evt-1" }],
    });
    const query = createTimelineQuery(store);
    const targets = query.traverse("evt-3");
    assert.equal(targets.length, 2);
    const partOf = query.traverse("evt-3", "part-of");
    assert.equal(partOf.length, 1);
    assert.equal(partOf[0]!.eventId, "evt-2");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: timeline returns events array", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const events = query.timeline();
    assert.equal(events.length, 5);
    assert.equal(events[0]!.sequence, "1");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: summary returns aggregate counts", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const summary = query.summary();
    assert.equal(summary.totalEvents, 5);
    assert.ok(summary.byType["run"] === 1);
    assert.ok(summary.byType["turn"] === 1);
    assert.ok(summary.byType["message"] === 1);
    assert.ok(summary.byType["token"] === 1);
    assert.ok(summary.byType["agent"] === 1);
    assert.equal(summary.firstWallTime, "2026-01-01T00:00:00.000Z");
    assert.equal(summary.lastWallTime, "2026-01-01T00:00:04.000Z");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: summary with filter", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const summary = query.summary({ runId: "run-1", eventType: "message" });
    assert.equal(summary.totalEvents, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: descending order", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.all({ ascending: false });
    assert.equal(result.events[0]!.sequence, "5");
    assert.equal(result.events[4]!.sequence, "1");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: byEffectId filters by effect ID", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const store = createTimelineStore({ path: join(dir, "q.db"), ledgerId: "ledger-q" });
    store.appendIntent({
      eventId: "evt-1", ledgerId: "ledger-q", eventType: "filesystem",
      effectKind: "filesystem", effectId: "fx-1",
      actor: { kind: "harness", id: "test" },
      description: "write", intentHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:00.000Z",
    });
    store.appendTerminal({
      eventId: "evt-2", ledgerId: "ledger-q", eventType: "filesystem",
      effectId: "fx-1", outcome: "succeeded", resultHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:01.000Z",
    });
    const query = createTimelineQuery(store);
    const result = query.byEffectId("fx-1");
    assert.equal(result.total, 2);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: invalid limit is rejected", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    assert.throws(() => query.all({ limit: -1 }), /Timeline query limit is invalid/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: invalid offset is rejected", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    assert.throws(() => query.all({ offset: -1 }), /Timeline query offset is invalid/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: invalid sequence bounds are rejected before the store sees them", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    for (const bounds of [{ fromSequence: "not-a-sequence" }, { toSequence: "1e3" }, { fromSequence: "9223372036854775808" }]) {
      assert.throws(
        () => query.all(bounds),
        (error: unknown) => (error as { code?: string }).code === "timeline_query_sequence_invalid",
        JSON.stringify(bounds),
      );
    }
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: an unparseable wall-time bound is rejected, never answered as an empty page", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    for (const bounds of [{ fromWallTime: "yesterday" }, { toWallTime: "2026-01-01" }]) {
      assert.throws(
        () => query.all(bounds),
        (error: unknown) => (error as { code?: string }).code === "timeline_query_wall_time_invalid",
        JSON.stringify(bounds),
      );
    }
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: combined filters (runId + eventType)", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.all({ runId: "run-1", eventType: "turn" });
    assert.equal(result.total, 1);
    assert.equal(result.events[0]!.eventType, "turn");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: byTask filters by task ID", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const store = createTimelineStore({ path: join(dir, "q.db"), ledgerId: "ledger-q" });
    store.appendIntent({
      eventId: "evt-1", ledgerId: "ledger-q", eventType: "filesystem",
      effectKind: "filesystem", effectId: "fx-1",
      actor: { kind: "harness", id: "test" },
      correlation: { taskId: "task-1" },
      description: "write", intentHash: VALID_HASH,
      wallTime: "2026-01-01T00:00:00.000Z",
    });
    const query = createTimelineQuery(store);
    const result = query.byTask("task-1");
    assert.equal(result.total, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: empty store summary", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const store = createTimelineStore({ path: join(dir, "q.db"), ledgerId: "ledger-q" });
    const query = createTimelineQuery(store);
    const summary = query.summary();
    assert.equal(summary.totalEvents, 0);
    assert.equal(summary.firstWallTime, null);
    assert.equal(summary.lastWallTime, null);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Additional edge case tests ==========

test("timeline-query: byRun with descending order", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.byRun("run-1", { ascending: false });
    assert.equal(result.events[0]!.sequence, "5");
    assert.equal(result.events[4]!.sequence, "1");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: byTurn with limit", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.byTurn("run-1", "turn-1", { limit: 1 });
    assert.equal(result.events.length, 1);
    assert.ok(result.hasMore);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: byEventType with offset", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const store = createTimelineStore({ path: join(dir, "q.db"), ledgerId: "ledger-q" });
    for (let i = 0; i < 5; i++) {
      store.appendEvent({
        eventId: `evt-${i}`, ledgerId: "ledger-q", eventType: "turn",
        actor: { kind: "harness", id: "test" },
        description: `turn ${i}`, wallTime: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    const query = createTimelineQuery(store);
    const result = query.byEventType("turn", { offset: 2, limit: 2 });
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0]!.sequence, "3");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: traverse with no matching edge type", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const store = createTimelineStore({ path: join(dir, "q.db"), ledgerId: "ledger-q" });
    store.appendEvent({
      eventId: "evt-2", ledgerId: "ledger-q", eventType: "run",
      actor: { kind: "harness", id: "test" },
      description: "run", wallTime: "2026-01-01T00:00:01.000Z",
    });
    store.appendEvent({
      eventId: "evt-1", ledgerId: "ledger-q", eventType: "turn",
      actor: { kind: "harness", id: "test" },
      description: "turn", wallTime: "2026-01-01T00:00:00.000Z",
      edges: [{ edgeType: "causal", targetEventId: "evt-2" }],
    });
    const query = createTimelineQuery(store);
    const targets = query.traverse("evt-1", "part-of");
    assert.equal(targets.length, 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: traverse on missing event returns empty", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const targets = query.traverse("missing-evt");
    assert.equal(targets.length, 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: edges on missing event returns empty", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const edges = query.edges("missing-evt");
    assert.equal(edges.length, 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: summary byEventType returns correct types", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const summary = query.byEventType("token");
    assert.equal(summary.total, 1);
    assert.equal(summary.events[0]!.eventType, "token");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: byTimeRange with exact boundaries", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    // Event at 2026-01-01T00:00:02.000Z (evt-msg)
    const result = query.byTimeRange("2026-01-01T00:00:02.000Z", "2026-01-01T00:00:02.000Z");
    assert.equal(result.total, 1);
    assert.equal(result.events[0]!.eventId, "evt-msg");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: bySequenceRange with single sequence", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.bySequenceRange("3", "3");
    assert.equal(result.total, 1);
    assert.equal(result.events[0]!.sequence, "3");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: byAgent returns events with agentId", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.byAgent("agent-a");
    assert.equal(result.total, 1);
    assert.equal(result.events[0]!.agentId, "agent-a");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: byAgent for missing agent returns empty", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.byAgent("agent-missing");
    assert.equal(result.total, 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: all with large limit returns all", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const result = query.all({ limit: 10000 });
    assert.equal(result.events.length, 5);
    assert.equal(result.hasMore, false);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: pagination returns correct pages", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const allPages: string[] = [];
    let offset = 0;
    const limit = 2;
    while (true) {
      const page = query.all({ limit, offset });
      if (page.events.length === 0) break;
      for (const e of page.events) allPages.push(e.eventId);
      offset += limit;
    }
    assert.equal(allPages.length, 5);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── The flat-lane page: summary rows, attachments behind the detail door ──

test("timeline-query: eventSummaries returns rows without attachments in the all-shaped envelope", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    // Give the events attachments: the projection must elide them without
    // changing the envelope.
    store.appendEvent({
      eventId: "evt-with-docs", ledgerId: store.ledgerId, eventType: "message",
      actor: { kind: "harness", id: "test" },
      correlation: { runId: "run-1" },
      description: "carries attachments", wallTime: "2026-01-01T00:00:05.000Z",
      documents: [{ name: "doc", contentJson: `{"i":1}`, contentDigest: sha256(`{"i":1}`) }],
      edges: [{ edgeType: "causal", targetEventId: "evt-msg" }],
    });
    const page = query.eventSummaries({ runId: "run-1" });
    assert.equal(page.total, 6);
    assert.equal(page.events.length, 6);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
    for (const e of page.events) {
      assert.equal("documents" in e, false, "a summary row must not carry documents");
      assert.equal("edges" in e, false, "a summary row must not carry edges");
      // The full record for the same event stays reachable through the
      // detail door, attachments included.
      const full = query.getEvent(e.eventId);
      assert.ok(full !== undefined);
      if (e.eventId === "evt-with-docs") {
        assert.equal(full.documents.length, 1);
        assert.equal(full.edges.length, 1);
      }
    }
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: eventSummaries rows agree with all field-for-field (the derivation cannot drift)", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const full = query.all({ limit: 100 });
    const summaries = query.eventSummaries({ limit: 100 });
    assert.equal(summaries.events.length, full.events.length);
    for (let i = 0; i < full.events.length; i++) {
      const row = full.events[i]!;
      const summary = summaries.events[i]!;
      for (const key of Object.keys(summary) as (keyof typeof summary)[]) {
        assert.deepEqual(summary[key], (row as unknown as Record<string, unknown>)[key],
          `field ${String(key)} must agree between the summary row and the full record`);
      }
    }
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query: eventSummaries paginates with the same keyset cursor as all", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { query, store } = mkQuery(dir);
    const firstPage = query.eventSummaries({ limit: 2, ascending: true });
    assert.equal(firstPage.events.length, 2);
    assert.equal(firstPage.hasMore, true);
    assert.ok(firstPage.nextCursor !== null);
    const secondPage = query.eventSummaries({ limit: 2, ascending: true, cursor: firstPage.nextCursor });
    const seen = new Set([...firstPage.events, ...secondPage.events].map((e) => e.eventId));
    assert.equal(seen.size, 4, "the cursor must resume exactly, never re-showing a row");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── The lean trace-ownership proof (one indexed lookup, never a page scan) ──

test("timeline-query port: traceMatchesAnyRun answers ownership without fetching the trace", () => {
  const dir = mkTempDir("tl-query-test-");
  try {
    const { store } = mkQuery(dir);
    store.appendEvent({
      eventId: "evt-trace-owned", ledgerId: store.ledgerId, eventType: "message",
      actor: { kind: "user", id: "user-1" }, traceId: "trace-1",
      correlation: { runId: "run-owned" },
      description: "inside an owned trace", wallTime: "2026-01-01T00:00:06.000Z",
    });
    store.appendEvent({
      eventId: "evt-trace-other", ledgerId: store.ledgerId, eventType: "message",
      actor: { kind: "user", id: "user-2" }, traceId: "trace-2",
      correlation: { runId: "run-foreign" },
      description: "inside a foreign trace", wallTime: "2026-01-01T00:00:07.000Z",
    });
    store.appendEvent({
      eventId: "evt-trace-unattributed", ledgerId: store.ledgerId, eventType: "message",
      actor: { kind: "user", id: "user-1" }, traceId: "trace-3",
      description: "a trace with no run at all", wallTime: "2026-01-01T00:00:08.000Z",
    });
    assert.equal(store.traceMatchesAnyRun("trace-1", ["run-owned"], store.ledgerId), true);
    assert.equal(store.traceMatchesAnyRun("trace-1", ["run-foreign"], store.ledgerId), false,
      "a foreign run id must not prove ownership of another trace");
    assert.equal(store.traceMatchesAnyRun("trace-2", ["run-owned"], store.ledgerId), false);
    assert.equal(store.traceMatchesAnyRun("trace-3", ["run-owned"], store.ledgerId), false,
      "a trace that produced no run can prove no ownership");
    assert.equal(store.traceMatchesAnyRun("trace-1", [], store.ledgerId), false,
      "a caller with no runs owns no trace");
    assert.equal(store.traceMatchesAnyRun("trace-absent", ["run-owned"], store.ledgerId), false);
    // Chunked membership: the owned id sits in a later chunk.
    const manyRuns = Array.from({ length: 550 }, (_, i) => `run-unrelated-${i}`).concat(["run-owned"]);
    assert.equal(store.traceMatchesAnyRun("trace-1", manyRuns, store.ledgerId), true);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-query port: trace membership uses the explicitly selected ledger", () => {
  const dir = mkTempDir("tl-query-ledgers-");
  const path = join(dir, "shared.db");
  const a = createTimelineStore({ path, ledgerId: "ledger-a" });
  const b = createTimelineStore({ path, ledgerId: "ledger-b" });
  try {
    for (const [store, runId] of [[a, "run-owned"], [b, "run-foreign"]] as const) {
      store.appendEvent({ ledgerId: store.ledgerId, eventId: `event-${store.ledgerId}`, eventType: "message",
        actor: { kind: "harness", id: "fixture" }, traceId: "same-trace", correlation: { runId }, description: "scope witness",
        wallTime: "2026-01-01T00:00:00.000Z" });
    }
    assert.equal(a.traceMatchesAnyRun("same-trace", ["run-owned"], "ledger-a"), true);
    assert.equal(a.traceMatchesAnyRun("same-trace", ["run-owned"], "ledger-b"), false);
    assert.equal(a.traceMatchesAnyRun("same-trace", ["run-foreign"], "ledger-b"), true);
    assert.equal(b.traceMatchesAnyRun("same-trace", ["run-owned"], "ledger-a"), true);
    assert.equal(a.traceMatchesAnyRun("same-trace", [], "ledger-a"), false);
  } finally { b.close(); a.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const reader of ["count", "querySummaries", "eventSummaries"] as const) {
  test(`timeline-query: ${reader} admits a wide owned-run set with exact membership and pagination`, () => {
    const dir = mkTempDir("tl-query-wide-runs-");
    const { store, query } = mkQuery(dir);
    try {
      store.appendEvent({ ledgerId: store.ledgerId, eventId: "wide-tail-event", eventType: "message",
        actor: { kind: "harness", id: "fixture" }, correlation: { runId: "run-tail" }, description: "tail membership",
        wallTime: "2026-01-01T00:00:05.000Z" });
      const runIds = ["run-1", ...Array.from({ length: 40_000 }, (_, i) => `absent-run-${i}`), "run-1", "run-tail"];
      if (reader === "count") {
        assert.equal(store.count({ runIds }), 6);
      } else if (reader === "querySummaries") {
        assert.deepEqual(store.querySummaries({ runIds, limit: 1, offset: 1 }), store.querySummaries({ runIds: ["run-1", "run-tail"], limit: 1, offset: 1 }));
        assert.deepEqual(store.querySummaries({ runIds, limit: 1, offset: 5 }).map((row) => row.eventId), ["wide-tail-event"]);
      } else {
        let cursor: string | undefined;
        for (let i = 0; i < 6; i += 1) {
          const filter = { limit: 1, ascending: true, ...(cursor !== undefined ? { cursor } : {}) };
          const actual = query.eventSummaries({ ...filter, runIds });
          assert.deepEqual(actual, query.eventSummaries({ ...filter, runIds: ["run-1", "run-tail"] }));
          assert.equal(actual.events.length, 1); assert.equal(actual.total, 6);
          assert.equal(actual.hasMore, i < 5);
          if (i === 5) assert.equal(actual.events[0]!.eventId, "wide-tail-event");
          cursor = actual.nextCursor ?? undefined;
        }
      }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("shared run-set selection emits one bound set and indexed event searches", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkTempDir("tl-query-selection-plans-");
  const path = join(dir, "shared.db");
  const store = createTimelineStore({ path, ledgerId: "ledger-query-plans" });
  const statements = new Set<string>();
  const prepare = DatabaseSync.prototype.prepare;
  try {
    seedStore(store);
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: InstanceType<typeof DatabaseSync>, sql: string) {
      if (sql.startsWith("SELECT") && sql.includes("FROM event_log") && sql.includes("json_each")) statements.add(sql);
      return prepare.call(this, sql);
    });
    const runIds = ["run-1", "run-1", "run-absent"];
    assert.equal(store.count({ runIds }), 5);
    assert.equal(store.querySummaries({ runIds, limit: 1 }).length, 1);
    assert.equal(store.traceMatchesAnyRun("absent-trace", runIds, store.ledgerId), false);
    assert.equal(store.spectrum({ runIds, bins: 2 }).events, 5);
    assert.equal(statements.size, 4);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      for (const sql of statements) {
        assert.equal((sql.match(/json_each\(\?\)/g) ?? []).length, 1);
        const params = Array.from({ length: sql.split("?").length - 1 }, () => "[]");
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((row) => row.detail).join(" | ");
        assert.match(plan, /SEARCH event_log USING (?:COVERING )?INDEX/, sql + "\n" + plan);
        assert.ok(!plan.includes("TEMP B-TREE"), sql + "\n" + plan);
      }
    } finally { db.close(); }
  } finally { t.mock.restoreAll(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
