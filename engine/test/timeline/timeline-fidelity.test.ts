/**
 * Timeline fidelity — what is recorded reaches the ledger, and what the ledger
 * holds can be read out completely.
 *
 * Every test here guards a defect that was MEASURED against a real 26,635-event
 * ledger, not a hypothetical one:
 *
 *   - `trace_id` and `span_id` were NULL on 100% of events. The ambient
 *     recording context computed both on every wrapped effect and nothing read
 *     them on the way to the store.
 *   - All 404 tool events had a NULL `run_id`, so the tool lane was empty in
 *     every run/chat/project-scoped view even though the calls were recorded.
 *   - Failed tool events had NULL `error_category`/`error_code`/`error_message`
 *     — a timeline that reports a failure and cannot say what failed.
 *   - `timeline_projection`, the browsing read model, carried 13 of the
 *     ledger's columns and dropped actor attribution, trace/span identity,
 *     parent event and all error detail.
 *   - The paginated query returned the OLDEST page of a capped window, and had
 *     no way to reach anything beyond it.
 *
 * The projection test uses DYNAMIC DISCOVERY: it reads the live schema with
 * `PRAGMA table_info` rather than naming columns, so adding a column to
 * `event_log` fails this test until the column is either projected or listed
 * as a deliberate exclusion. A test that needs editing when you add a column
 * would be the same defect it is guarding.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createTimelineStore, type EventLedgerStoragePort } from "../../src/timeline/timeline-store.ts";
import { createTimelineQuery } from "../../src/timeline/timeline-query.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { CORRELATION_FIELD_NAMES } from "../../src/timeline/ledger-primitives.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { PROJECTION_EXCLUDED_EVENT_COLUMNS } from "../../src/timeline/timeline-schema.ts";
import { recordEffect, setEffectSink, type EffectRecord } from "../../src/timeline/recorded-effect.ts";
import { withRecordingContext } from "../../src/timeline/recording-context.ts";
import { DEFAULT_TIMELINE_QUERY_ASCENDING } from "../../src/kernel/config-contracts.ts";
import { mkTempDir } from "../support/temp-dir.ts";

let dbCounter = 0;

function mkStore(dir: string): EventLedgerStoragePort {
  dbCounter += 1;
  return createTimelineStore({
    path: join(dir, `fidelity-${dbCounter}.db`),
    ledgerId: "ledger-fidelity",
  });
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkTempDir("tl-fidelity-");
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Ambient provenance reaches the ledger ─────────────────────────────────

for (const ending of ["foreign", "outside", "restored"] as const) {
  test(`recorder: terminal keeps originating provenance when ending ${ending}`, () => {
    withTempDir((dir) => {
      const path = join(dir, "origin.db");
      let store = createTimelineStore({ path, ledgerId: "origin" });
      let recorder = createTimelineRecorder({ store });
      const correlation = Object.fromEntries(CORRELATION_FIELD_NAMES.map((key) => [key, `origin-${key}`]));
      const originContext = { actor: { kind: "user", id: "origin-user" }, traceId: "origin-trace", spanId: "origin-span", runId: "ambient-origin" };
      const foreignContext = { actor: { kind: "user", id: "foreign-user" }, traceId: "foreign-trace", spanId: "foreign-span", runId: "foreign-run", sessionId: "foreign-session", turnId: "foreign-turn", agentId: "foreign-agent" };
      try {
        const intent = withRecordingContext(originContext, () => recorder.beginEffect({ effectId: "effect", kind: "provider", actor: { kind: "agent", id: "origin-agent", role: "owner" }, correlation, description: "origin", intentHash: sha256("intent") }));
        const sparse = recorder.beginEffect({ effectId: "sparse", kind: "provider", actor: { kind: "agent", id: "sparse" }, description: "sparse", intentHash: sha256("sparse") });
        if (ending === "restored") {
          // A restart: a new recorder over the reopened ledger ends what the
          // first began, through the ledger's own intent (no in-memory copy).
          recorder.close();
          store = createTimelineStore({ path, ledgerId: "origin" });
          recorder = withRecordingContext(foreignContext, () => createTimelineRecorder({ store, correlation: { runId: "foreign-default", sessionId: "foreign-default" } }));
        }
        for (const pending of [intent, sparse]) {
          const finish = () => recorder.endEffect(pending.record.effectId, { outcome: "succeeded", resultHash: sha256("result") });
          const terminal = ending === "outside" ? finish() : withRecordingContext(foreignContext, finish);
          const original = store.getEvent(pending.receipt.eventId)!;
          const stored = store.getEvent(terminal.receipt.eventId)!;
          for (const field of ["actorKind", "actorId", "actorRole", "traceId", "spanId", ...CORRELATION_FIELD_NAMES] as const) assert.equal(stored[field], original[field], `${ending}: original ${field}, including absent values`);
          assert.equal(stored.parentEventId, original.eventId);
        }
        assert.deepEqual(store.query({ runId: correlation.runId!, recordKind: "terminal" }).map((row) => row.effectId), ["effect"]);
        assert.deepEqual(store.query({ runId: "foreign-run", recordKind: "terminal" }), []);
        assert.equal(store.verifyChain().valid, true);
      } finally { recorder.close(); }
    });
  });
}

test("recorder: observations retain observer provenance for unknown and foreign effects", () => {
  withTempDir((dir) => {
    const store = mkStore(dir); const recorder = createTimelineRecorder({ store });
    try {
      withRecordingContext({ actor: { kind: "user", id: "origin" }, runId: "origin-run", traceId: "origin-trace" }, () =>
        recorder.beginEffect({ effectId: "known", kind: "provider", actor: { kind: "agent", id: "origin-agent" }, description: "origin", intentHash: sha256("intent") }));
      for (const effectId of ["known", "unknown"]) {
        const observation = withRecordingContext({ actor: { kind: "user", id: "observer", role: "auditor" }, runId: "observer-run", sessionId: "observer-session", turnId: "observer-turn", agentId: "observer-agent", traceId: "observer-trace", spanId: "observer-span" }, () =>
          recorder.observeExternalEffect({ observationId: `observe-${effectId}`, effectId, kind: "provider", evidenceHash: sha256("evidence") }));
        const stored = store.getEvent(observation.receipt.eventId)!;
        assert.equal(stored.actorId, "observer"); assert.equal(stored.actorRole, "auditor");
        assert.equal(stored.runId, "observer-run"); assert.equal(stored.sessionId, "observer-session"); assert.equal(stored.turnId, "observer-turn"); assert.equal(stored.agentId, "observer-agent");
        assert.equal(stored.traceId, "observer-trace"); assert.equal(stored.spanId, "observer-span"); assert.equal(stored.parentEventId, null);
      }
      assert.equal(store.query({ runId: "observer-run", recordKind: "observation" }).length, 2);
      assert.equal(store.query({ runId: "origin-run", recordKind: "observation" }).length, 0);
      assert.equal(store.verifyChain().valid, true);
    } finally { recorder.close(); }
  });
});

test("recorder: trace and span identity come from the ambient context", () => {
  withTempDir((dir) => {
    const store = mkStore(dir);
    const recorder = createTimelineRecorder({ store });
    withRecordingContext(
      { actor: { kind: "user", id: "user-1" }, traceId: "trace-abc", spanId: "span-xyz" },
      () => {
        recorder.recordEvent({ eventType: "tool", description: "tool:read_file" });
      },
    );
    const event = store.query({})[0];
    assert.ok(event !== undefined);
    assert.equal(event.traceId, "trace-abc");
    assert.equal(event.spanId, "span-xyz");
    // Attribution comes from the same context, and the two must agree — an
    // event traced to a span but attributed to the wrong actor is worse than
    // an untraced one.
    assert.equal(event.actorKind, "user");
    assert.equal(event.actorId, "user-1");
    store.close();
  });
});

test("recorder: correlation is inherited from the ambient context", () => {
  withTempDir((dir) => {
    const store = mkStore(dir);
    const recorder = createTimelineRecorder({ store });
    withRecordingContext(
      { actor: { kind: "harness", id: "web" }, runId: "run-1", turnId: "turn-1", sessionId: "sess-1" },
      () => {
        // No `correlation` argument — exactly how the effect sink records, and
        // exactly the case that produced 404 tool events with no run id.
        recorder.recordEvent({ eventType: "tool", description: "tool:write_file" });
      },
    );
    const event = store.query({})[0];
    assert.ok(event !== undefined);
    assert.equal(event.runId, "run-1");
    assert.equal(event.turnId, "turn-1");
    assert.equal(event.sessionId, "sess-1");
    store.close();
  });
});

test("recorder: an explicit correlation still wins over the ambient one", () => {
  withTempDir((dir) => {
    const store = mkStore(dir);
    const recorder = createTimelineRecorder({ store });
    withRecordingContext(
      { actor: { kind: "harness", id: "web" }, runId: "run-ambient" },
      () => {
        recorder.recordEvent({
          eventType: "run",
          description: "run started",
          correlation: { runId: "run-explicit" },
        });
      },
    );
    const event = store.query({})[0];
    assert.ok(event !== undefined);
    assert.equal(event.runId, "run-explicit");
    store.close();
  });
});

test("recorder: a wrapped effect is traceable end to end", () => {
  withTempDir((dir) => {
    const store = mkStore(dir);
    const recorder = createTimelineRecorder({ store });
    setEffectSink((record) => {
      recorder.recordEvent({
        eventType: "tool",
        description: `${record.kind}:${record.name}`,
        outcome: record.outcome,
      });
    });
    try {
      withRecordingContext({ actor: { kind: "user", id: "u" }, runId: "run-7" }, () => {
        recordEffect("tool", "read_file", () => "content");
      });
    } finally {
      setEffectSink(undefined);
    }
    const event = store.query({})[0];
    assert.ok(event !== undefined);
    // The wrapper opened a span and the span opened a trace; both must have
    // survived the trip to the ledger, along with the run the effect ran in.
    assert.ok(event.spanId !== null, "span id was not persisted");
    assert.ok(event.traceId !== null, "trace id was not persisted");
    assert.equal(event.runId, "run-7");
    store.close();
  });
});

// ── Failure detail survives ───────────────────────────────────────────────

test("recordEffect: documentsOf lands the effect's captured documents on its event", () => {
  // The documents channel: an effect that captured payloads about its own
  // work (a provider call's request and response, for one) hands them to the
  // wrapper through `documentsOf`, and the wrapper delivers them to the sink
  // beside its own timing measurement. A documentsOf that is dropped between
  // the wrapper and the sink is a capture that never existed.
  withTempDir((dir) => {
    const store = mkStore(dir);
    let seen: EffectRecord | undefined;
    setEffectSink((record) => { seen = record; });
    try {
      const docs = [
        { name: "llm-request", contentJson: '[{"role":"user"}]', contentDigest: "a".repeat(64) },
        { name: "llm-response", contentJson: '{"text":"ok"}', contentDigest: "b".repeat(64) },
      ];
      recordEffect("llm", "cap-model", () => "streamed", {
        documentsOf: () => docs,
      });
    } finally {
      setEffectSink(undefined);
    }
    assert.ok(seen !== undefined, "the sink never saw the effect record");
    assert.ok(seen!.documents !== undefined, "documentsOf output was dropped by the wrapper");
    assert.equal(seen!.documents!.length, 2);
    assert.deepEqual(
      seen!.documents!.map((d) => d.name),
      ["llm-request", "llm-response"],
    );
    // A getter that yields nothing (or only empty arrays) must present as NO
    // documents field, not an empty one the sink has to second-guess.
    setEffectSink((record) => { seen = record; });
    try {
      recordEffect("llm", "cap-model-empty", () => "streamed", { documentsOf: () => [] });
    } finally {
      setEffectSink(undefined);
    }
    assert.ok(seen !== undefined);
    assert.equal(seen!.documents, undefined, "an empty documents list must not be forwarded as a field");
    store.close();
  });
});

test("recordEffect: a broken documentsOf costs the documents, never the work", () => {
  // Same contract as a broken `errorOf`: an observer must not be able to
  // break — or change the outcome of — the effect it observes.
  withTempDir((dir) => {
    const store = mkStore(dir);
    let seen: EffectRecord | undefined;
    setEffectSink((record) => { seen = record; });
    try {
      const result = recordEffect("tool", "throwing-docs", () => "work-done", {
        documentsOf: () => { throw new Error("broken extractor"); },
      });
      assert.equal(result, "work-done", "the effect's result must pass through unchanged");
      assert.equal(seen!.documents, undefined);
      assert.equal(seen!.outcome, "succeeded");
    } finally {
      setEffectSink(undefined);
    }
    store.close();
  });
});

test("recordEffect: a result-signalled failure reports why", () => {
  const seen: EffectRecord[] = [];
  setEffectSink((record) => { seen.push(record); });
  try {
    recordEffect(
      "tool",
      "read_file",
      () => ({ success: false, output: "ENOENT: no such file" }),
      {
        failedWhen: (r) => !r.success,
        errorOf: (r) => ({ message: r.output, code: "tool_error" }),
      },
    );
  } finally {
    setEffectSink(undefined);
  }
  const record = seen[0];
  assert.ok(record !== undefined);
  assert.equal(record.outcome, "failed");
  assert.equal(record.error?.message, "ENOENT: no such file");
  assert.equal(record.error?.code, "tool_error");
});

test("recordEffect: a success never carries invented failure detail", () => {
  const seen: EffectRecord[] = [];
  setEffectSink((record) => { seen.push(record); });
  try {
    recordEffect(
      "tool",
      "read_file",
      () => ({ success: true, output: "ok" }),
      {
        failedWhen: (r) => !r.success,
        errorOf: () => ({ message: "should never be recorded" }),
      },
    );
  } finally {
    setEffectSink(undefined);
  }
  assert.equal(seen[0]?.outcome, "succeeded");
  assert.equal(seen[0]?.error, undefined);
});

// ── The browsing read model is not lossy ──────────────────────────────────

test("projection: carries every event_log column that is not a declared exclusion", () => {
  withTempDir((dir) => {
    const path = join(dir, "projection.db");
    const store = createTimelineStore({ path, ledgerId: "ledger-proj" });
    store.appendEvent({
      eventId: "evt-1",
      ledgerId: "ledger-proj",
      eventType: "error",
      actor: { kind: "user", id: "user-9", role: "operator" },
      correlation: { runId: "run-1", turnId: "turn-1", agentId: "agent-1" },
      description: "it broke",
      wallTime: "2026-01-01T00:00:00.000Z",
      traceId: "trace-1",
      spanId: "span-1",
      outcome: "failed",
      error: {
        category: "provider",
        code: "llm_stream_error",
        message: "model not found",
        retryable: true,
      },
    });
    store.close();

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const columnsOf = (table: string): string[] =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
      const eventColumns = columnsOf("event_log");
      const projectionColumns = new Set(columnsOf("timeline_projection"));
      assert.ok(eventColumns.length > 0, "event_log has no columns — schema did not apply");

      const excluded = new Set(PROJECTION_EXCLUDED_EVENT_COLUMNS);
      const required = eventColumns.filter((c) => !excluded.has(c));
      const missing = required.filter((c) => !projectionColumns.has(c));
      assert.deepEqual(
        missing,
        [],
        `timeline_projection drops browsing columns: ${missing.join(", ")}`,
      );

      // Present is not the same as populated. Every required column must hold
      // the SAME value the ledger holds, or the read model is lossy in a way a
      // column list cannot see.
      const eventRow = db.prepare("SELECT * FROM event_log WHERE event_id = ?").get("evt-1") as Record<string, unknown>;
      const projRow = db.prepare("SELECT * FROM timeline_projection WHERE event_id = ?").get("evt-1") as Record<string, unknown>;
      assert.ok(projRow !== undefined, "no projection row was written for the event");
      const disagreements = required.filter((c) => projRow[c] !== eventRow[c]);
      assert.deepEqual(
        disagreements,
        [],
        `projection disagrees with the ledger on: ${disagreements.join(", ")}`,
      );
      // The exclusions must be real exclusions, not columns that happen to be
      // absent by accident.
      for (const column of PROJECTION_EXCLUDED_EVENT_COLUMNS) {
        assert.ok(
          eventColumns.includes(column),
          `${column} is excluded from the projection but is not an event_log column`,
        );
      }
    } finally {
      db.close();
    }
  });
});

test("projection: a rebuild reproduces the full surface", () => {
  withTempDir((dir) => {
    const path = join(dir, "rebuild.db");
    const store = createTimelineStore({ path, ledgerId: "ledger-rb" });
    store.appendEvent({
      eventId: "evt-1",
      ledgerId: "ledger-rb",
      eventType: "tool",
      actor: { kind: "agent", id: "agent-2" },
      correlation: { runId: "run-2" },
      description: "tool:git_status",
      wallTime: "2026-01-01T00:00:00.000Z",
      traceId: "trace-2",
    });
    store.rebuildProjections();
    store.close();

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT actor_kind, actor_id, trace_id, run_id FROM timeline_projection WHERE event_id = ?")
        .get("evt-1") as Record<string, unknown>;
      assert.equal(row.actor_kind, "agent");
      assert.equal(row.actor_id, "agent-2");
      assert.equal(row.trace_id, "trace-2");
      assert.equal(row.run_id, "run-2");
    } finally {
      db.close();
    }
  });
});

// ── Ordering and pagination ───────────────────────────────────────────────

function seedSequential(store: EventLedgerStoragePort, count: number): void {
  for (let i = 1; i <= count; i += 1) {
    store.appendEvent({
      eventId: `evt-${i}`,
      ledgerId: store.ledgerId,
      eventType: "run",
      actor: { kind: "harness", id: "test" },
      correlation: { runId: "run-1" },
      description: `event ${i}`,
      // Deliberately IDENTICAL wall times: ordering must come from the total
      // order of `sequence`, not from a timestamp that ties. With 176 tied
      // wall-time groups in the real ledger, a timestamp sort is not an order.
      wallTime: "2026-01-01T00:00:00.000Z",
    });
  }
}

test("query: the paginated read is newest-first by default", () => {
  withTempDir((dir) => {
    const store = mkStore(dir);
    seedSequential(store, 10);
    const query = createTimelineQuery(store);
    const page = query.all({ limit: 3 });
    assert.equal(DEFAULT_TIMELINE_QUERY_ASCENDING, false);
    assert.deepEqual(
      page.events.map((e) => e.sequence),
      ["10", "9", "8"],
      "a capped page must show the most recent events, not the oldest",
    );
    store.close();
  });
});

test("query: ordering is total even when wall times tie", () => {
  withTempDir((dir) => {
    const store = mkStore(dir);
    seedSequential(store, 25);
    const query = createTimelineQuery(store);
    const first = query.all({ limit: 25 }).events.map((e) => e.sequence);
    const second = query.all({ limit: 25 }).events.map((e) => e.sequence);
    assert.deepEqual(first, second, "the same query returned a different order");
    assert.equal(new Set(first).size, 25, "the order is not a permutation of the set");
    store.close();
  });
});

test("query: the cursor walks the whole ledger exactly once", () => {
  withTempDir((dir) => {
    const store = mkStore(dir);
    seedSequential(store, 25);
    const query = createTimelineQuery(store);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page: ReturnType<typeof query.all> = query.all({
        limit: 10,
        ...(cursor !== null ? { cursor } : {}),
      });
      pages += 1;
      for (const event of page.events) seen.push(event.sequence);
      // The matching-set size must not shrink as the walk proceeds, or the UI
      // counts down while the user reads.
      assert.equal(page.total, 25, "total changed mid-walk");
      cursor = page.nextCursor;
      if (cursor === null) break;
      assert.ok(pages < 10, "pagination did not terminate");
    }

    assert.equal(pages, 3);
    assert.equal(seen.length, 25, "the walk did not cover the ledger");
    assert.equal(new Set(seen).size, 25, "the walk returned duplicates");
    assert.deepEqual(
      seen,
      Array.from({ length: 25 }, (_, i) => String(25 - i)),
      "the walk did not stay in order across pages",
    );
    store.close();
  });
});

test("query: the last page reports no cursor", () => {
  withTempDir((dir) => {
    const store = mkStore(dir);
    seedSequential(store, 3);
    const query = createTimelineQuery(store);
    const page = query.all({ limit: 10 });
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null, "a complete page must not offer a next cursor");
    store.close();
  });
});

test("query: the cursor works in ascending order too", () => {
  withTempDir((dir) => {
    const store = mkStore(dir);
    seedSequential(store, 6);
    const query = createTimelineQuery(store);
    const first = query.all({ limit: 3, ascending: true });
    assert.deepEqual(first.events.map((e) => e.sequence), ["1", "2", "3"]);
    assert.ok(first.nextCursor !== null);
    const second = query.all({ limit: 3, ascending: true, cursor: first.nextCursor });
    assert.deepEqual(
      second.events.map((e) => e.sequence),
      ["4", "5", "6"],
      "an ascending cursor must move forward, not backward",
    );
    store.close();
  });
});

test("query: a malformed cursor is rejected, not silently ignored", () => {
  withTempDir((dir) => {
    const store = mkStore(dir);
    seedSequential(store, 3);
    const query = createTimelineQuery(store);
    for (const bad of ["", "abc", "-1", "01", "1; DROP TABLE event_log"]) {
      assert.throws(
        () => query.all({ cursor: bad }),
        /cursor/i,
        `cursor ${JSON.stringify(bad)} was accepted`,
      );
    }
    // Rejecting is only correct if it did not also destroy the ledger.
    assert.equal(query.all({}).total, 3);
    store.close();
  });
});
