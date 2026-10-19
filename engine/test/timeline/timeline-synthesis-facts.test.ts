import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createTimelineStore, type EventLedgerStoragePort } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createTimelineQuery } from "../../src/timeline/timeline-query.ts";
import {
  TIMELINE_CHECK_STATUS_DOCUMENT,
  TIMELINE_FILE_EFFECT_DOCUMENT,
  TIMELINE_TOKEN_USAGE_DOCUMENT,
} from "../../src/timeline/timeline-types.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { mkTempDir } from "../support/temp-dir.ts";

/**
 * `runActivitySummaries()` + `fileEffectFacts()` — the exact-join reads behind
 * the web UI's SYNTHESIS blocks (conversation pulse / echoes / forecast).
 *
 * Properties pinned, in the same shape as timeline-coverage-counts.test.ts:
 *
 *  1. TRUTH — aggregates and decoded facts match hand-computable seeds,
 *     including the honest lanes: unparsed usage documents are COUNTED (not
 *     folded into sums), undecodable effect documents are COUNTED (not
 *     mistaken for non-matches), and an absent run is a PROVEN absence (no
 *     row), never a row of zeros.
 *  2. RECORDER ROUND-TRIP — a file effect and a token usage written through
 *     the REAL recorder are readable through these ports, which pins the
 *     document-name constants to what the recorder actually writes.
 *  3. DENY-BY-DEFAULT — no scope, an oversized scope, an invalid run id and
 *     an invalid limit are refusals, never a quietly-unbounded read.
 *  4. COST — every emitted statement is index-backed: bounded searches of
 *     idx_event_log_run / idx_event_log_event_type joined through
 *     idx_event_documents_event; no bare table scan and no TEMP B-TREE
 *     (ordering happens in JS).
 */

const AT = (n: number): string => `2026-07-20T00:00:0${n}.000Z`;
const HEX64 = "b".repeat(64);

function usageDoc(promptTokens: number, completionTokens: number): Readonly<{ name: string; contentJson: string; contentDigest: string }> {
  const contentJson = JSON.stringify({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens });
  return { name: TIMELINE_TOKEN_USAGE_DOCUMENT, contentJson, contentDigest: sha256(contentJson) };
}

/**
 * A usage document carrying ONLY the measured pair — the boundary shape that
 * exposed the decoder drift: the store's private decoder required the
 * redundant `totalTokens` and counted this document unparsed (dropping its
 * measured tokens from every run summary), while the dig reader's private
 * decoder accepted it. The ONE decoder is tolerant to the writer's shape:
 * the pair is required, the total is derived when absent.
 */
function usageDocWithoutTotal(promptTokens: number, completionTokens: number): Readonly<{ name: string; contentJson: string; contentDigest: string }> {
  const contentJson = JSON.stringify({ promptTokens, completionTokens });
  return { name: TIMELINE_TOKEN_USAGE_DOCUMENT, contentJson, contentDigest: sha256(contentJson) };
}

function effectDoc(path: string, operation: string): Readonly<{ name: string; contentJson: string; contentDigest: string }> {
  const contentJson = JSON.stringify({ path, operation, preimageDigest: HEX64, postimageDigest: HEX64 });
  return { name: TIMELINE_FILE_EFFECT_DOCUMENT, contentJson, contentDigest: sha256(contentJson) };
}

function checkDoc(checkName: string, fromStatus: string | null, toStatus: string, chatId: string | null): Readonly<{ name: string; contentJson: string; contentDigest: string }> {
  const contentJson = JSON.stringify({ checkId: `chk-${checkName}`, checkName, fromStatus, toStatus, projectId: "proj-1", chatId });
  return { name: TIMELINE_CHECK_STATUS_DOCUMENT, contentJson, contentDigest: sha256(contentJson) };
}

/**
 * The seed, hand-computable.
 *
 * run-a: run(1) + message(2) + tool(2: read×1, write×1) + token(2 usage docs:
 *        100+20, 160+30) + 1 bad usage doc + file-effect on /w/a.ts +
 *        1 failed-outcome event + 1 event with error detail        = 10 events
 * run-b: file-effect on /w/a.ts and /w/b.ts (earlier history)      = 2 events
 * unattributed: file-effect on /w/a.ts with NO run id              = 1 event
 * undecodable: raw file-effect row with no `effect` document       = 1 event
 */
function seed(store: EventLedgerStoragePort, ledgerId: string): void {
  const ev = (
    eventId: string,
    eventType: Parameters<EventLedgerStoragePort["appendEvent"]>[0]["eventType"],
    wallTime: string,
    extra: Partial<Parameters<EventLedgerStoragePort["appendEvent"]>[0]> = {},
  ): void => {
    store.appendEvent({
      eventId, ledgerId, eventType,
      actor: { kind: "user", id: "u-1" },
      description: extra.description ?? `${eventType} event`,
      wallTime,
      ...extra,
    });
  };
  // run-b first (earlier history for "echoes")
  ev("b-f1", "file-effect", AT(0), {
    correlation: { runId: "run-b" }, description: "write /w/a.ts",
    documents: [effectDoc("/w/a.ts", "write")],
  });
  ev("b-f2", "file-effect", AT(1), {
    correlation: { runId: "run-b" }, description: "write /w/b.ts",
    documents: [effectDoc("/w/b.ts", "write")],
  });
  // run-a
  ev("a-run", "run", AT(2), { correlation: { runId: "run-a" } });
  ev("a-m1", "message", AT(2), { correlation: { runId: "run-a" }, description: "user prompt" });
  ev("a-m2", "message", AT(3), { correlation: { runId: "run-a" }, description: "assistant message" });
  ev("a-t1", "tool", AT(3), { correlation: { runId: "run-a" }, description: "tool:read_file" });
  ev("a-t2", "tool", AT(4), { correlation: { runId: "run-a" }, description: "tool:write_file" });
  ev("a-u1", "token", AT(4), { correlation: { runId: "run-a" }, documents: [usageDoc(100, 20)] });
  ev("a-u2", "token", AT(5), { correlation: { runId: "run-a" }, documents: [usageDoc(160, 30)] });
  ev("a-u3", "token", AT(5), { correlation: { runId: "run-a" }, documents: [usageDocWithoutTotal(40, 10)] });
  ev("a-ubad", "token", AT(5), {
    correlation: { runId: "run-a" },
    documents: [{ name: TIMELINE_TOKEN_USAGE_DOCUMENT, contentJson: "not json", contentDigest: sha256("not json") }],
  });
  ev("a-f1", "file-effect", AT(6), {
    correlation: { runId: "run-a" }, description: "write /w/a.ts",
    documents: [effectDoc("/w/a.ts", "write")],
  });
  ev("a-fail", "process", AT(7), { correlation: { runId: "run-a" }, outcome: "failed" });
  ev("a-err", "error", AT(7), {
    correlation: { runId: "run-a" },
    error: { category: "tool", code: "tool_failed", message: "boom", retryable: false },
  });
  // unattributed file effect (the live ledger's known recording gap)
  ev("x-f1", "file-effect", AT(8), {
    description: "write /w/a.ts",
    documents: [effectDoc("/w/a.ts", "write")],
  });
}
// run-a expectations: events 12? No — a-ubad is a token event too. run-a rows:
// a-run, a-m1, a-m2, a-t1, a-t2, a-u1, a-u2, a-u3, a-ubad, a-f1, a-fail,
// a-err = 12.

/** Insert one raw file-effect row with NO documents (the undecodable lane). */
function insertUndecodable(dbPath: string, ledgerId: string): void {
  const raw = new DatabaseSync(dbPath);
  raw.prepare(
    `INSERT INTO event_log (event_id, ledger_id, sequence, record_kind, event_type,
       wall_time, actor_kind, actor_id, description, previous_chain_hash, chain_hash)
     VALUES (?, ?, ?, 'event', 'file-effect', ?, 'harness', 'raw-writer', 'docless file effect', 'x', 'x')`,
  ).run("raw-f1", ledgerId, 999_999, AT(9));
  raw.close();
}

test("runActivitySummaries: aggregates match the hand-computed seed; absent runs are absent, not zeroed", () => {
  const dir = mkTempDir("timeline-synth-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: "ledger-synth" });
  try {
    seed(store, "ledger-synth");
    const summaries = store.runActivitySummaries(["run-a", "run-b", "run-never", "run-a"]);
    // run-never has no rows and no summary; the duplicate run-a is deduplicated.
    assert.deepEqual(summaries.map((s) => s.runId), ["run-a", "run-b"]);

    const a = summaries[0];
    assert.ok(a !== undefined);
    assert.equal(a.events, 12);
    assert.deepEqual(a.eventTypeCounts, {
      run: 1, message: 2, tool: 2, token: 4, "file-effect": 1, process: 1, error: 1,
    });
    assert.deepEqual(a.toolDescriptionCounts, { "tool:read_file": 1, "tool:write_file": 1 });
    assert.equal(a.errorEvents, 1);
    assert.equal(a.failedOutcomes, 1);
    assert.equal(a.firstWallTime, AT(2));
    assert.equal(a.lastWallTime, AT(7));
    // tokens: three decodable samples (100+20, 160+30, and the pair-only
    // 40+10 boundary document whose total is DERIVED as 50 — the drift case:
    // the store's former private decoder counted it unparsed), one
    // counted-unparsed doc
    assert.equal(a.tokenUsage.samples, 3);
    assert.equal(a.tokenUsage.unparsedDocuments, 1);
    assert.equal(a.tokenUsage.promptTokensSum, 300);
    assert.equal(a.tokenUsage.completionTokensSum, 60);
    assert.equal(a.tokenUsage.totalTokensSum, 360);
    assert.equal(a.tokenUsage.first?.promptTokens, 100);
    // The newest sample is the pair-only boundary document (it is appended
    // after a-u2, so it carries the highest sequence) — the drift case
    // answering "last" too, not just the sums.
    assert.equal(a.tokenUsage.last?.promptTokens, 40);
    assert.ok(BigInt(a.tokenUsage.first?.sequence ?? "0") < BigInt(a.tokenUsage.last?.sequence ?? "0"));

    const b = summaries[1];
    assert.ok(b !== undefined);
    assert.equal(b.events, 2);
    assert.deepEqual(b.eventTypeCounts, { "file-effect": 2 });
    assert.equal(b.tokenUsage.samples, 0);
    assert.equal(b.tokenUsage.first, null);
    assert.equal(b.tokenUsage.last, null);
  } finally { store.close(); }
});

test("fileEffectFacts: exact path join over decoded effect documents, with counted undecodables", () => {
  const dir = mkTempDir("timeline-synth-");
  const path = join(dir, "t.db");
  const store = createTimelineStore({ path, ledgerId: "ledger-synth" });
  try {
    seed(store, "ledger-synth");
  } finally { store.close(); }
  insertUndecodable(path, "ledger-synth");
  const reopened = createTimelineStore({ path, ledgerId: "ledger-synth" });
  try {
    // Path-driven: everything that ever touched /w/a.ts, in ledger order.
    const byPath = reopened.fileEffectFacts({ paths: ["/w/a.ts"] });
    assert.equal(byPath.fileEffectEventsExamined, 5); // b-f1 b-f2 a-f1 x-f1 raw-f1
    assert.equal(byPath.undecodableEffects, 1); // raw-f1 has no effect document
    assert.equal(byPath.truncated, false);
    assert.deepEqual(byPath.facts.map((f) => f.eventId), ["b-f1", "a-f1", "x-f1"]);
    assert.deepEqual(byPath.facts.map((f) => f.runId), ["run-b", "run-a", null]);
    const first = byPath.facts[0];
    assert.equal(first?.path, "/w/a.ts");
    assert.equal(first?.operation, "write");
    assert.equal(first?.wallTime, AT(0));
    assert.ok(BigInt(first?.sequence ?? "0") > 0n);

    // Run-driven: which files did run-b touch.
    const byRun = reopened.fileEffectFacts({ runIds: ["run-b"] });
    assert.deepEqual(byRun.facts.map((f) => f.path), ["/w/a.ts", "/w/b.ts"]);
    assert.equal(byRun.fileEffectEventsExamined, 2);
    assert.equal(byRun.undecodableEffects, 0);

    // Intersection: run-b AND /w/b.ts.
    const both = reopened.fileEffectFacts({ runIds: ["run-b"], paths: ["/w/b.ts"] });
    assert.deepEqual(both.facts.map((f) => f.eventId), ["b-f2"]);

    // Truncation is stated, never silent.
    const capped = reopened.fileEffectFacts({ paths: ["/w/a.ts"], limit: 2 });
    assert.equal(capped.truncated, true);
    assert.equal(capped.facts.length, 2);
    assert.deepEqual(capped.facts.map((f) => f.eventId), ["b-f1", "a-f1"]);
  } finally { reopened.close(); }
});

test("recorder round-trip: what recordFileEffect/recordTokenUsage write is what the ports read", () => {
  const dir = mkTempDir("timeline-synth-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: "ledger-rt" });
  const recorder = createTimelineRecorder({ store, actor: { kind: "harness", id: "test" } });
  try {
    recorder.recordFileEffect({
      effectId: "fx-rt-1",
      path: "/rt/target.ts",
      operation: "write",
      preimageDigest: HEX64,
      postimageDigest: HEX64,
      description: "write /rt/target.ts",
      correlation: { runId: "run-rt" },
    });
    recorder.recordTokenUsage({
      promptTokens: 450, completionTokens: 120, totalTokens: 570,
      correlation: { runId: "run-rt", turnId: "turn-1" },
    });
    // MUTATION GUARD: if the document-name constants ever drift from what the
    // recorder writes, both reads below come back empty/unparsed.
    const facts = store.fileEffectFacts({ runIds: ["run-rt"] });
    assert.equal(facts.facts.length, 1);
    assert.equal(facts.facts[0]?.path, "/rt/target.ts");
    assert.equal(facts.facts[0]?.operation, "write");
    assert.equal(facts.undecodableEffects, 0);
    const summary = store.runActivitySummaries(["run-rt"])[0];
    assert.equal(summary?.tokenUsage.samples, 1);
    assert.equal(summary?.tokenUsage.totalTokensSum, 570);
    assert.equal(summary?.tokenUsage.unparsedDocuments, 0);
  } finally { store.close(); }
});

/**
 * The check-status seed, hand-computable. Written as `quality` events with a
 * `check-status` document — the shape the web UI's auto-checks owner records
 * beside its latest-status upsert (the append-only history stream that makes
 * `checksFlipped` derivable at all).
 *
 * run-c: typecheck null→passed, typecheck passed→failed        = 2 events
 * chat-only (no run — a panel-run check): lint null→warning,
 *   its document naming chat-1                                 = 1 event
 * chat-2 (a DIFFERENT chat, run-d): typecheck null→passed      = 1 event
 * undecodable: quality event with no document, run-c           = 1 event
 */
function seedCheckStatus(store: EventLedgerStoragePort, ledgerId: string): void {
  const ev = (
    eventId: string,
    wallTime: string,
    extra: Partial<Parameters<EventLedgerStoragePort["appendEvent"]>[0]> = {},
  ): void => {
    store.appendEvent({
      eventId, ledgerId, eventType: "quality",
      actor: { kind: "harness", id: "web-ui" },
      description: extra.description ?? "quality event",
      wallTime,
      ...extra,
    });
  };
  ev("c-k1", AT(0), {
    correlation: { runId: "run-c" }, description: "check:typecheck unrecorded→passed",
    documents: [checkDoc("typecheck", null, "passed", "chat-1")],
  });
  ev("c-k2", AT(1), {
    correlation: { runId: "run-c" }, description: "check:typecheck passed→failed",
    documents: [checkDoc("typecheck", "passed", "failed", "chat-1")],
  });
  ev("x-k1", AT(2), {
    description: "check:lint unrecorded→warning",
    documents: [checkDoc("lint", null, "warning", "chat-1")],
  });
  ev("d-k1", AT(3), {
    correlation: { runId: "run-d" }, description: "check:typecheck unrecorded→passed",
    documents: [checkDoc("typecheck", null, "passed", "chat-2")],
  });
  ev("c-kbad", AT(4), { correlation: { runId: "run-c" }, description: "docless quality event" });
}

test("checkStatusFacts: decoded from→to history, run-scoped, chat-scoped and their union", () => {
  const dir = mkTempDir("timeline-synth-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: "ledger-chk" });
  try {
    seedCheckStatus(store, "ledger-chk");

    // Run-driven: run-c's own history, in ledger order, from→to decoded from
    // the document (never parsed out of the description).
    const byRun = store.checkStatusFacts({ runIds: ["run-c"] });
    assert.deepEqual(byRun.facts.map((f) => f.eventId), ["c-k1", "c-k2"]);
    assert.deepEqual(byRun.facts.map((f) => [f.checkName, f.fromStatus, f.toStatus]), [
      ["typecheck", null, "passed"],
      ["typecheck", "passed", "failed"],
    ]);
    assert.equal(byRun.facts[0]?.chatId, "chat-1");
    assert.equal(byRun.facts[0]?.runId, "run-c");
    assert.equal(byRun.checkEventsExamined, 3); // c-k1 c-k2 c-kbad
    assert.equal(byRun.undecodableCheckEvents, 1); // c-kbad
    assert.equal(byRun.truncated, false);

    // Chat-driven: reaches the panel-run check that has NO run attribution —
    // the whole reason the chat route exists.
    const byChat = store.checkStatusFacts({ chatIds: ["chat-1"] });
    assert.deepEqual(byChat.facts.map((f) => f.eventId), ["c-k1", "c-k2", "x-k1"]);
    assert.equal(byChat.facts[2]?.runId, null);
    // The event-type-bounded pass examined every quality event; chat-2's
    // record is examined but not matched, and the docless one is counted.
    assert.equal(byChat.checkEventsExamined, 5);
    assert.equal(byChat.undecodableCheckEvents, 1);

    // Union: a conversation's history is "recorded by its runs OR against
    // the chat" — deduplicated by event id, never double-counted.
    const union = store.checkStatusFacts({ runIds: ["run-c"], chatIds: ["chat-1"] });
    assert.deepEqual(union.facts.map((f) => f.eventId), ["c-k1", "c-k2", "x-k1"]);

    // Truncation is stated, never silent.
    const capped = store.checkStatusFacts({ chatIds: ["chat-1"], limit: 2 });
    assert.equal(capped.truncated, true);
    assert.deepEqual(capped.facts.map((f) => f.eventId), ["c-k1", "c-k2"]);

    // THE QUERY SHAPE BEHIND `checksFlipped`, against the real store: with
    // the history stream recorded, flips ARE derivable — walk the settled
    // statuses per check in ledger order and count changes. Before the
    // stream existed the upsert destroyed this at write time.
    const flips = byChat.facts
      .filter((f) => f.toStatus !== "running")
      .reduce((acc, f) => {
        const prev = acc.last.get(f.checkName);
        if (prev !== undefined && prev !== f.toStatus) acc.count += 1;
        acc.last.set(f.checkName, f.toStatus);
        return acc;
      }, { count: 0, last: new Map<string, string>() });
    assert.equal(flips.count, 1); // typecheck passed→failed; lint never flipped
  } finally { store.close(); }
});

test("checkStatusFacts deny-by-default: no scope, bad ids and bad limits are refusals", () => {
  const dir = mkTempDir("timeline-synth-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: "ledger-chk" });
  const code = (expected: string) => (error: unknown): boolean =>
    (error as { code?: string }).code === expected;
  try {
    assert.throws(() => store.checkStatusFacts({}), code("timeline_check_status_scope_missing"));
    assert.throws(() => store.checkStatusFacts({ runIds: [], chatIds: [] }), code("timeline_check_status_scope_missing"));
    assert.throws(() => store.checkStatusFacts({ runIds: ["not a valid id!"] }), code("timeline_run_id_invalid"));
    assert.throws(() => store.checkStatusFacts({ chatIds: ["not a valid id!"] }), code("timeline_check_status_chat_id_invalid"));
    assert.throws(() => store.checkStatusFacts({ chatIds: ["chat-1"], limit: 0 }), code("timeline_check_status_limit_invalid"));
    assert.throws(() => store.checkStatusFacts({ chatIds: ["chat-1"], limit: 10_001 }), code("timeline_check_status_limit_invalid"));
  } finally { store.close(); }
});

test("the query API passes both reads through to the store port unchanged", () => {
  const dir = mkTempDir("timeline-synth-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: "ledger-synth" });
  try {
    seed(store, "ledger-synth");
    const query = createTimelineQuery(store);
    assert.deepEqual(query.runActivitySummaries(["run-b"]), store.runActivitySummaries(["run-b"]));
    assert.deepEqual(query.fileEffectFacts({ paths: ["/w/b.ts"] }), store.fileEffectFacts({ paths: ["/w/b.ts"] }));
    assert.deepEqual(query.checkStatusFacts({ runIds: ["run-b"] }), store.checkStatusFacts({ runIds: ["run-b"] }));
  } finally { store.close(); }
});

test("deny-by-default: no scope, oversized scope, bad run id and bad limit are refusals", () => {
  const dir = mkTempDir("timeline-synth-");
  const store = createTimelineStore({ path: join(dir, "t.db"), ledgerId: "ledger-synth" });
  const code = (expected: string) => (error: unknown): boolean =>
    (error as { code?: string }).code === expected;
  try {
    assert.throws(() => store.fileEffectFacts({}), code("timeline_file_effect_scope_missing"));
    assert.throws(() => store.fileEffectFacts({ paths: [] }), code("timeline_file_effect_scope_missing"));
    assert.throws(
      () => store.fileEffectFacts({ paths: Array.from({ length: 201 }, (_, i) => `/p/${i}`) }),
      code("timeline_file_effect_paths_exceeded"),
    );
    assert.throws(() => store.fileEffectFacts({ paths: [""] }), code("timeline_file_effect_path_invalid"));
    assert.throws(
      () => store.fileEffectFacts({ paths: ["/w/a.ts"], limit: 0 }),
      code("timeline_file_effect_limit_invalid"),
    );
    assert.throws(
      () => store.fileEffectFacts({ paths: ["/w/a.ts"], limit: 10_001 }),
      code("timeline_file_effect_limit_invalid"),
    );
    assert.throws(() => store.fileEffectFacts({ runIds: ["not a valid id!"] }), code("timeline_run_id_invalid"));
    assert.throws(() => store.runActivitySummaries(["not a valid id!"]), code("timeline_run_id_invalid"));
    assert.throws(
      () => store.runActivitySummaries(Array.from({ length: 501 }, (_, i) => `run-${i}`)),
      code("timeline_run_summary_runs_exceeded"),
    );
  } finally { store.close(); }
});

test("every statement the two reads emit is index-backed — no table scan, no temp B-tree", () => {
  const dir = mkTempDir("timeline-synth-");
  const path = join(dir, "t.db");
  const store = createTimelineStore({ path, ledgerId: "ledger-synth" });
  try { seed(store, "ledger-synth"); } finally { store.close(); }

  // Mirrors of the statements doRunActivitySummaries / doFileEffectFacts
  // actually emit — the same idiom as timeline-coverage-counts.test.ts.
  const STATEMENTS: readonly string[] = [
    "SELECT sequence, event_type, description, outcome, error_code, wall_time FROM event_log WHERE run_id = ?",
    "SELECT e.sequence AS sequence, d.content_json AS content_json FROM event_log e " +
      "JOIN event_documents d ON d.event_id = e.event_id AND d.name = ? " +
      "WHERE e.run_id = ? AND e.event_type = ?",
    "SELECT e.event_id AS event_id, e.sequence AS sequence, e.run_id AS run_id, e.trace_id AS trace_id, " +
      "e.wall_time AS wall_time, e.description AS description, d.content_json AS content_json " +
      "FROM event_log e LEFT JOIN event_documents d ON d.event_id = e.event_id AND d.name = ? " +
      "WHERE e.run_id IN (?,?) AND e.event_type = ?",
    "SELECT e.event_id AS event_id, e.sequence AS sequence, e.run_id AS run_id, e.trace_id AS trace_id, " +
      "e.wall_time AS wall_time, e.description AS description, d.content_json AS content_json " +
      "FROM event_log e LEFT JOIN event_documents d ON d.event_id = e.event_id AND d.name = ? " +
      "WHERE e.event_type = ?",
    // doCheckStatusFacts — run-driven and chat-driven (event-type-bounded).
    "SELECT e.event_id AS event_id, e.sequence AS sequence, e.run_id AS run_id, " +
      "e.wall_time AS wall_time, d.content_json AS content_json " +
      "FROM event_log e LEFT JOIN event_documents d ON d.event_id = e.event_id AND d.name = ? " +
      "WHERE e.run_id IN (?,?) AND e.event_type = ?",
    "SELECT e.event_id AS event_id, e.sequence AS sequence, e.run_id AS run_id, " +
      "e.wall_time AS wall_time, d.content_json AS content_json " +
      "FROM event_log e LEFT JOIN event_documents d ON d.event_id = e.event_id AND d.name = ? " +
      "WHERE e.event_type = ?",
  ];

  const db = new DatabaseSync(path, { readOnly: true });
  try {
    for (const sql of STATEMENTS) {
      const params = Array.from({ length: sql.split("?").length - 1 }, () => "x");
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
        .map((r) => r.detail)
        .join(" | ");
      assert.match(plan, /USING (COVERING )?INDEX/, `not index-backed: ${sql}\nplan: ${plan}`);
      assert.ok(!/SCAN (event_log|event_documents)(?! USING)/.test(plan), `full table scan: ${sql}\nplan: ${plan}`);
      assert.ok(!plan.includes("TEMP B-TREE"), `needs a sort/group pass: ${sql}\nplan: ${plan}`);
    }
  } finally { db.close(); }
});
