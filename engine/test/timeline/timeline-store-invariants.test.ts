import { DatabaseSync } from "node:sqlite";
import { sha256 } from "../../src/kernel/integrity.ts";
import { ALL_MIGRATIONS } from "../../src/timeline/timeline-schema.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { InputError, SecurityError } from "../../src/kernel/errors.ts";
import { CORRELATION_FIELD_NAMES, LedgerPersistenceUncertainError, MAXIMUM_SEQUENCE, ZERO_CHAIN_HASH } from "../../src/timeline/ledger-primitives.ts";
import { createTimelineStore, type EventLedgerStoragePort } from "../../src/timeline/timeline-store.ts";
import { TIMELINE_FILE_EFFECT_DOCUMENT, TIMELINE_CHECK_STATUS_DOCUMENT, type TimelineStandaloneEventInput } from "../../src/timeline/timeline-types.ts";
import { mkTempDir } from "../support/temp-dir.ts";
import { thrownFailure } from "../support/factories.ts";
import { getDebugSignals, resetDebugSystem } from "../../src/shared/debug/debug-system.ts";

/**
 * Timeline-store invariants (GAP-1 ledger-id consistency, GAP-3 chain-hash
 * non-null, GAP-25 sequence exhaustion).
 *
 * These tests live in a separate file from `timeline-store.test.ts` because
 * that file was being concurrently modified by another agent; isolating them
 * avoids clobbering foreign work while still guarding the same invariants.
 */

function mkStore(dir: string, ledgerId?: string): EventLedgerStoragePort {
  return createTimelineStore({
    path: join(dir, `tl-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
    ...(ledgerId !== undefined ? { ledgerId } : {}),
  });
}

function mkEvent(ledgerId: string, eventId: string, eventType: string = "turn"): TimelineStandaloneEventInput {
  return {
    eventId, ledgerId, eventType: eventType as TimelineStandaloneEventInput["eventType"],
    actor: { kind: "harness", id: "runtime" },
    correlation: { runId: "run-1" },
    description: "invariant event",
    wallTime: "2026-07-16T00:00:00.000Z",
  };
}

const lineageIntent = (ledgerId: string, eventId: string, effectId = "effect") => ({
  ...mkEvent(ledgerId, eventId, "provider"), effectId, effectKind: "provider", intentHash: sha256("intent"),
});
const lineageTerminal = (ledgerId: string, eventId: string, effectId = "effect") => ({
  eventId, ledgerId, effectId, eventType: "provider" as const, outcome: "succeeded" as const,
  resultHash: sha256("result"), wallTime: "2026-09-26T00:00:00Z",
});

test("timeline-store: terminal provenance comes from the actual persisted intent before hashing", () => {
  const dir = mkTempDir("tl-origin-"); const path = join(dir, "timeline.db");
  const store = createTimelineStore({ path, ledgerId: "origin" }); const raw = new DatabaseSync(path);
  try {
    store.appendEvent(mkEvent("origin", "intent-effect"));
    const correlation = Object.fromEntries(CORRELATION_FIELD_NAMES.map((key) => [key, `original-${key}`]));
    const intent = store.appendIntent({ ...lineageIntent("origin", "arbitrary-original-event"),
      actor: { kind: "agent", id: "original-actor", role: "original-role" }, correlation,
      traceId: "original-trace", spanId: "original-span", parentEventId: "intent-effect" });
    const terminal = store.appendTerminal(lineageTerminal("origin", "finished"));
    for (const field of ["actorKind", "actorId", "actorRole", "traceId", "spanId", ...CORRELATION_FIELD_NAMES] as const) {
      assert.equal(terminal[field], intent[field], `originating ${field} must survive terminal append`);
    }
    assert.equal(terminal.parentEventId, intent.eventId, "parent is the actual intent event, not its parent or a reconstructed name");
    assert.deepEqual(store.getEvent(terminal.eventId), terminal);
    assert.equal(raw.prepare("SELECT parent_event_id FROM timeline_projection WHERE event_id = ?").get(terminal.eventId)!.parent_event_id, intent.eventId);
    assert.deepEqual(store.query({ runId: correlation.runId!, recordKind: "terminal" }).map((row) => row.eventId), [terminal.eventId]);
    assert.equal(store.verifyChain().valid, true, "the stored chain covers derived provenance");
  } finally { raw.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const failure of ["orphan", "ambiguous", "duplicate", "event_type_mismatch"] as const) {
  test(`timeline-store: terminal ${failure} is refused without advancing rows or chain`, () => {
    const dir = mkTempDir("tl-lineage-"); const path = join(dir, "timeline.db");
    const store = createTimelineStore({ path, ledgerId: "lineage" }); const raw = new DatabaseSync(path);
    try {
      if (failure !== "orphan") store.appendIntent(lineageIntent("lineage", "original"));
      if (failure === "duplicate") store.appendTerminal(lineageTerminal("lineage", "first-terminal"));
      if (failure === "ambiguous") {
        raw.prepare(`INSERT INTO event_log (event_id,ledger_id,sequence,record_kind,event_type,effect_kind,effect_id,wall_time,actor_kind,actor_id,description,intent_hash,previous_chain_hash,chain_hash)
          VALUES ('legacy-ambiguous','lineage',2,'intent','provider','provider','effect','2026-09-26','agent','legacy','legacy',?,?,?)`).run(sha256("intent"), ZERO_CHAIN_HASH, ZERO_CHAIN_HASH);
      }
      const tables = ["event_log", "event_documents", "event_edges", "timeline_projection"];
      const counts = () => tables.map((table) => raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
      const before = counts(), sequence = store.nextSequence(), chain = store.verifyChain();
      const input = { ...lineageTerminal("lineage", `refused-${failure}`), ...(failure === "event_type_mismatch" ? { eventType: "filesystem" as const } : {}) };
      assert.throws(() => store.appendTerminal(input), (error) => error instanceof SecurityError && error.code === `timeline_terminal_${failure}`);
      assert.deepEqual(counts(), before); assert.equal(store.nextSequence(), sequence); assert.deepEqual(store.verifyChain(), chain);
    } finally { raw.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("timeline-store: lineage lookups are ledger-scoped, transactional and index-backed across reopened connections", (t) => {
  const dir = mkTempDir("tl-lineage-lock-"); const path = join(dir, "timeline.db");
  const observed: { sql: string; args: unknown[] }[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith("SELECT") && sql.includes("effect_id = ?") && /record_kind\s*=\s*'(intent|terminal)'/.test(sql)) {
      for (const method of ["get", "all"] as const) {
        const run = statement[method]; const connection = this;
        t.mock.method(statement, method, function (this: typeof statement, ...args: Parameters<typeof run>) {
          assert.equal(connection.isTransaction, true, "lineage lookup must execute inside BEGIN IMMEDIATE");
          observed.push({ sql, args }); return Reflect.apply(run, this, args);
        });
      }
    }
    return statement;
  });
  const a = createTimelineStore({ path, ledgerId: "a" });
  const b = createTimelineStore({ path, ledgerId: "b" });
  let reopened: EventLedgerStoragePort | undefined;
  try {
    a.appendIntent(lineageIntent("a", "a-original"));
    assert.throws(() => b.appendTerminal(lineageTerminal("b", "b-orphan")), (error) => error instanceof SecurityError && error.code === "timeline_terminal_orphan");
    b.appendIntent(lineageIntent("b", "b-original"));
    assert.throws(() => a.appendIntent(lineageIntent("a", "a-second-intent")), (error) => error instanceof SecurityError && error.code === "timeline_intent_duplicate");
    reopened = createTimelineStore({ path, ledgerId: "a" });
    assert.throws(() => reopened!.appendIntent(lineageIntent("a", "a-reopened-intent")), (error) => error instanceof SecurityError && error.code === "timeline_intent_duplicate");
    assert.equal(reopened.appendTerminal(lineageTerminal("a", "a-terminal")).parentEventId, "a-original");
    assert.throws(() => a.appendTerminal(lineageTerminal("a", "a-second-terminal")), (error) => error instanceof SecurityError && error.code === "timeline_terminal_duplicate");
    assert.equal(b.appendTerminal(lineageTerminal("b", "b-terminal")).parentEventId, "b-original");
    assert.ok(observed.some(({ sql }) => sql.includes("'intent'")), "actual intent lookup was observed");
    assert.ok(observed.some(({ sql }) => sql.includes("'terminal'")), "actual terminal lookup was observed");
    const raw = new DatabaseSync(path);
    try {
      for (const { sql, args } of observed) {
        const plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args as Parameters<ReturnType<typeof raw.prepare>["all"]>).map((row) => String(row.detail)).join("\n");
        assert.match(plan, /^SEARCH \w+ USING (?:COVERING )?INDEX \w+/mu); assert.doesNotMatch(plan, /SCAN event_log|USE TEMP B-TREE/);
      }
    } finally { raw.close(); }
    assert.equal(a.count(), 2); assert.equal(b.count(), 2); assert.equal(a.verifyChain().valid, true); assert.equal(b.verifyChain().valid, true);
  } finally { reopened?.close(); a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: terminal callers cannot override any originating provenance", () => {
  const dir = mkTempDir("tl-provenance-override-"); const store = mkStore(dir, "override");
  try {
    store.appendIntent(lineageIntent("override", "origin"));
    const overrides = { actor: { kind: "agent", id: "foreign" }, correlation: { runId: "foreign" }, traceId: "foreign", spanId: "foreign", parentEventId: "origin",
      actorKind: "agent", actorId: "foreign", actorRole: "foreign", ...Object.fromEntries(CORRELATION_FIELD_NAMES.map((key) => [key, "foreign"])) };
    for (const [key, value] of Object.entries(overrides)) {
      assert.throws(() => store.appendTerminal({ ...lineageTerminal("override", `refused-${key}`), [key]: value }),
        (error) => error instanceof InputError && error.code === "timeline_terminal_provenance_override", key);
    }
    assert.equal(store.count(), 1); assert.equal(store.verifyChain().valid, true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: every public append captures plain JSON before reading caller fields", () => {
  const dir = mkTempDir("tl-capture-"); const store = mkStore(dir, "capture");
  const inputs = {
    appendEvent: mkEvent("capture", "event"),
    appendIntent: lineageIntent("capture", "intent"),
    appendTerminal: lineageTerminal("capture", "terminal"),
    appendObservation: { eventId: "observation", ledgerId: "capture", eventType: "provider", observationId: "observation", evidenceHash: sha256("evidence"), wallTime: "2026-09-26", actor: { kind: "agent", id: "observer" } },
  };
  try {
    assert.deepEqual(Object.keys(store).filter((name) => name.startsWith("append")).sort(), Object.keys(inputs).sort());
    for (const [name, input] of Object.entries(inputs)) {
      const append = store[name as keyof typeof inputs] as (value: unknown) => unknown;
      let reads = 0;
      const getter = { ...input, get eventId() { reads++; return "getter"; } };
      const nested = { ...input, documents: [{ name: "proof", contentDigest: sha256("proof"), get contentJson() { reads++; return "proof"; } }] };
      const proxy = new Proxy({}, { ownKeys() { reads++; throw new Error("proxy trap"); }, get() { reads++; throw new Error("proxy trap"); } });
      for (const value of [getter, nested, proxy, null, [], "scalar", { ...input, documents: [proxy] }, { ...input, extra: undefined }, { ...input, extra: Infinity }]) {
        assert.throws(() => append(value), (error) => error instanceof InputError && error.code === "timeline_input_invalid", name);
        assert.equal(reads, 0, `${name} must not run accessors or proxy traps`);
        assert.equal(store.count(), 0); assert.equal(store.nextSequence(), "1");
      }
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ========== Ledger ID consistency (GAP-1) ==========

test("timeline-store-invariants: every appended event carries the store ledgerId", () => {
  const dir = mkTempDir("tl-invariants-");
  try {
    const store = mkStore(dir, "ledger-consistency");
    for (let i = 0; i < 10; i += 1) {
      store.appendEvent({ ...mkEvent("ledger-consistency", `evt-${i}`), eventId: `evt-${i}` });
    }
    const events = store.query();
    assert.equal(events.length, 10);
    assert.ok(events.every((e) => e.ledgerId === store.ledgerId), "every event ledgerId must equal store.ledgerId");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store-invariants: ledgerId is stable across reopen", () => {
  const dir = mkTempDir("tl-invariants-");
  const dbPath = join(dir, "timeline.db");
  try {
    const store1 = createTimelineStore({ path: dbPath, ledgerId: "ledger-stable" });
    store1.appendEvent(mkEvent("ledger-stable", "evt-1"));
    store1.close();
    const store2 = createTimelineStore({ path: dbPath, ledgerId: "ledger-stable" });
    const events = store2.query();
    assert.ok(events.every((e) => e.ledgerId === store2.ledgerId));
    store2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ========== Chain hash non-null (GAP-3) ==========

test("timeline-store-invariants: every event has a non-null, 64-hex chainHash", () => {
  const dir = mkTempDir("tl-invariants-");
  try {
    const store = mkStore(dir, "ledger-chain");
    const records = [];
    for (let i = 0; i < 10; i += 1) {
      records.push(store.appendEvent({ ...mkEvent("ledger-chain", `evt-${i}`), eventId: `evt-${i}` }));
    }
    const HEX64 = /^[0-9a-f]{64}$/u;
    for (const r of records) {
      assert.ok(typeof r.chainHash === "string" && r.chainHash.length === 64, `chainHash must be 64 chars; got ${r.chainHash}`);
      assert.ok(HEX64.test(r.chainHash), `chainHash must be 64-hex; got ${r.chainHash}`);
      assert.notEqual(r.chainHash, ZERO_CHAIN_HASH, "chainHash must not be the zero hash");
    }
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store-invariants: genesis previousChainHash is ZERO_CHAIN_HASH; others chain to the previous tip", () => {
  const dir = mkTempDir("tl-invariants-");
  try {
    const store = mkStore(dir, "ledger-genesis");
    const records = [];
    for (let i = 0; i < 10; i += 1) {
      records.push(store.appendEvent({ ...mkEvent("ledger-genesis", `evt-${i}`), eventId: `evt-${i}` }));
    }
    assert.equal(records[0]!.previousChainHash, ZERO_CHAIN_HASH, "genesis previousChainHash must be the zero hash");
    for (let i = 1; i < records.length; i += 1) {
      assert.notEqual(records[i]!.previousChainHash, ZERO_CHAIN_HASH, `event ${i} previousChainHash must not be zero`);
      assert.equal(records[i]!.previousChainHash, records[i - 1]!.chainHash, "chain must link previous tip");
    }
    assert.equal(store.chainTipHash(), records[records.length - 1]!.chainHash);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("timeline-store-invariants: actual int64 tip, query, hydration and rebuild retain exact sequence", () => {
  const dir = mkTempDir("tl-int64-");
  const path = join(dir, "timeline.db");
  const store = createTimelineStore({ path, ledgerId: "high" });
  const raw = new DatabaseSync(path);
  try {
    store.appendEvent(mkEvent("high", "first"));
    const row = raw.prepare("SELECT * FROM event_log").get()!;
    row.event_id = "seed-high";
    row.sequence = MAXIMUM_SEQUENCE - 1n;
    const names = Object.keys(row);
    raw.prepare(`INSERT INTO event_log (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map((name) => row[name]!));
    for (const [id, type, sequence, name, payload] of [
      ["high-file", "file-effect", MAXIMUM_SEQUENCE - 3n, TIMELINE_FILE_EFFECT_DOCUMENT, { path: "/proof", operation: "write" }],
      ["high-check", "quality", MAXIMUM_SEQUENCE - 2n, TIMELINE_CHECK_STATUS_DOCUMENT, { checkName: "proof", toStatus: "passed", chatId: "chat-proof" }],
    ] as const) {
      const data = { ...row, event_id: id, event_type: type, sequence };
      raw.prepare(`INSERT INTO event_log (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map((name) => data[name as keyof typeof data]!));
      const json = JSON.stringify(payload);
      raw.prepare("INSERT INTO event_documents (event_id,position,name,content_json,content_digest) VALUES (?,0,?,?,?)").run(id, name, json, sha256(json));
    }
    const contentJson = '{"safe":true}';
    const last = store.appendEvent({ ...mkEvent("high", "last"), outcome: "failed", error: { category: "provider", code: "retry", message: "transient", retryable: true }, documents: [{ name: "proof", contentJson, contentDigest: sha256(contentJson) }], edges: [{ edgeType: "causal", targetEventId: "first" }] });
    assert.equal(last.sequence, MAXIMUM_SEQUENCE.toString());
    assert.equal(last.errorRetryable, true);
    assert.equal(last.documents[0]!.position, 0);
    assert.equal(last.edges[0]!.position, 0);
    assert.deepEqual(store.getEvent("last"), last);
    assert.equal(store.query({ ascending: false })[0]!.sequence, last.sequence);
    assert.equal(store.querySummaries({ ascending: false })[0]!.sequence, last.sequence);
    assert.equal(store.count(), 5);
    assert.equal(store.runActivitySummaries(["run-1"])[0]!.lastSequence, last.sequence);
    assert.equal(store.fileEffectFacts({ paths: ["/proof"] }).facts[0]!.sequence, (MAXIMUM_SEQUENCE - 3n).toString());
    assert.equal(store.checkStatusFacts({ chatIds: ["chat-proof"] }).facts[0]!.sequence, (MAXIMUM_SEQUENCE - 2n).toString());
    assert.equal(store.verifyChain().valid, false, "deliberately sparse fixture is readable, not a valid full chain");
    store.rebuildProjections();
    const offset = raw.prepare("SELECT source_sequence FROM projection_offsets"); offset.setReadBigInts(true);
    assert.equal(offset.get()!.source_sequence, MAXIMUM_SEQUENCE);
    const counts = () => ["event_log", "event_documents", "event_edges", "timeline_projection"].map((table) => raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()!.c);
    const before = counts();
    for (const operation of [() => store.appendEvent(mkEvent("high", "overflow")), () => store.nextSequence()]) {
      assert.throws(operation, (error) => error instanceof SecurityError && error.code === "timeline_sequence_exhausted" && error.message === "Ledger sequence exhausted");
    }
    assert.deepEqual(counts(), before);
  } finally { raw.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const thrown of ["Error", "undefined"] as const) {
  test(`timeline-store-invariants: precommit hydrate failure rolls back all rows (${thrown})`, (t) => {
    const failure = thrownFailure(thrown, "private hydrate failure");
    const dir = mkTempDir("tl-rollback-"); const path = join(dir, "timeline.db");
    const prepare = DatabaseSync.prototype.prepare;
    let fail = true;
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      const stmt = prepare.call(this, sql);
      if (sql === "SELECT * FROM event_log WHERE event_id = ? AND ledger_id = ?") {
        const get = stmt.get;
        t.mock.method(stmt, "get", function (...args: Parameters<typeof get>) { if (fail) { fail = false; throw failure; } return get.apply(stmt, args); });
      }
      return stmt;
    });
    const store = createTimelineStore({ path, ledgerId: "rollback" }); const raw = new DatabaseSync(path);
    try {
      let caught = false;
      try { store.appendEvent({ ...mkEvent("rollback", "rolled-back"), documents: [{ name: "proof", contentJson: "{}", contentDigest: sha256("{}") }], edges: [{ edgeType: "causal", targetKind: "test", targetId: "x" }] }); } catch (error) { caught = true; assert.equal(error, failure); }
      assert.ok(caught);
      for (const table of ["event_log", "event_documents", "event_edges", "timeline_projection"]) assert.equal(raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()!.c, 0);
      assert.equal(store.appendEvent(mkEvent("rollback", "healthy")).sequence, "1");
    } finally { raw.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const phase of ["committed", "rollback", "state"] as const) {
  test(`timeline-store-invariants: ${phase} uncertainty blocks every write but permits recovery reads`, (t) => {
    const dir = mkTempDir("tl-uncertain-"); const path = join(dir, "timeline.db");
    const store = createTimelineStore({ path, ledgerId: "uncertain" });
    const exec = DatabaseSync.prototype.exec;
    let sqlCalls = 0;
    let inject = true;
    const injection = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      sqlCalls += 1;
      if (inject && sql === "COMMIT") {
        if (phase === "committed") exec.call(this, sql);
        if (phase === "state") this.close();
        throw new Error("private primary canary");
      }
      if (inject && sql === "ROLLBACK" && phase === "rollback") throw new Error("private cleanup canary");
      return exec.call(this, sql);
    });
    resetDebugSystem();
    try {
      const uncertain = (error: unknown) => error instanceof LedgerPersistenceUncertainError && error.code === "ledger_persistence_uncertain" && error.message === "Ledger persistence outcome is uncertain" && error.retryable === false && !JSON.stringify(error).includes("canary");
      assert.throws(() => store.appendEvent(mkEvent("uncertain", "maybe")), uncertain);
      // A failed cleanup or state inspection reports once through the central best-effort owner.
      assert.equal(getDebugSignals().bestEffortFailures, phase === "committed" ? 0 : 1);
      inject = false;
      const countBefore = sqlCalls;
      for (const operation of [
        () => store.appendEvent(mkEvent("uncertain", "retry")),
        () => store.appendIntent({ ...mkEvent("uncertain", "intent"), effectKind: "provider", effectId: "fx", intentHash: "a".repeat(64) }),
        () => store.appendTerminal({ eventId: "terminal", ledgerId: "uncertain", eventType: "provider", effectId: "fx", outcome: "succeeded", resultHash: "a".repeat(64), wallTime: "2026-09-24T00:00:00Z" }),
        () => store.appendObservation({ eventId: "observation", ledgerId: "uncertain", eventType: "provider", observationId: "o", actor: { kind: "test", id: "observer" }, evidenceHash: "a".repeat(64), wallTime: "2026-09-24T00:00:00Z" }),
        () => store.rebuildProjections(),
      ]) assert.throws(operation, uncertain);
      assert.equal(sqlCalls, countBefore);
      if (phase === "committed") { assert.equal(store.getEvent("maybe")!.eventId, "maybe"); assert.equal(store.count(), 1); }
    } finally {
      injection.mock.restore();
      if (phase !== "state") store.close();
      else assert.throws(() => store.close(), (error) => error instanceof Error && "code" in error && error.code === "ERR_INVALID_STATE");
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("timeline-store-invariants: rebuild preserves other ledger projection and offsets, including v7 migration", () => {
  const dir = mkTempDir("tl-rebuild-"); const path = join(dir, "timeline.db");
  const raw = new DatabaseSync(path);
  // Genuine pre-composite schema: apply exactly the historical migrations.
  raw.exec("CREATE TABLE schema_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT");
  for (const migration of ALL_MIGRATIONS.filter((m) => m.id < 8)) {
    raw.exec(migration.sql);
    raw.prepare("INSERT INTO schema_migrations VALUES (?,?,?,?)").run(migration.id, migration.name, sha256(migration.sql), "2026-09-24T00:00:00Z");
  }
  raw.prepare("INSERT INTO projection_offsets VALUES (?,?,?,?)").run("timeline_projection", "prior", 12, "b".repeat(64));
  const a = createTimelineStore({ path, ledgerId: "a" }); const b = createTimelineStore({ path, ledgerId: "b" });
  try {
    assert.deepEqual({ ...raw.prepare("SELECT * FROM projection_offsets WHERE source_ledger_id='prior'").get() }, { projection_name: "timeline_projection", source_ledger_id: "prior", source_sequence: 12, chain_mac: "b".repeat(64) });
    a.appendEvent(mkEvent("a", "event-a")); b.appendEvent(mkEvent("b", "event-b"));
    a.rebuildProjections(); b.rebuildProjections();
    const rows = () => raw.prepare("SELECT * FROM timeline_projection ORDER BY event_id").all();
    const offsets = () => raw.prepare("SELECT * FROM projection_offsets ORDER BY source_ledger_id").all();
    const beforeRows = rows(); const beforeOffsets = offsets();
    const sourceFields = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "projection_id"));
    for (const store of [a, b, a, b]) {
      const otherBefore = rows().filter((row) => row.ledger_id !== store.ledgerId);
      store.rebuildProjections();
      assert.deepEqual(rows().filter((row) => row.ledger_id !== store.ledgerId), otherBefore, "other ledger including its physical projection ID is untouched");
      assert.deepEqual(rows().map(sourceFields), beforeRows.map(sourceFields));
      assert.deepEqual(offsets(), beforeOffsets);
      assert.equal(store.verifyChain().valid, true);
    }
  } finally { a.close(); b.close(); raw.close(); rmSync(dir, { recursive: true, force: true }); }
});
