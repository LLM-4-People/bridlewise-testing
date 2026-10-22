// @vitest-environment node
/**
 * CLIENT TELEMETRY INGESTION — the server door's owning arms.
 *
 * The browser's back-channel lands at one POST (the `client.telemetry/ingest`
 * block action), and every promise that door makes is held here by a real
 * HTTP request against the production router + block mounts:
 *
 *   AUTH        — the door is user-authenticated (401 without a session).
 *   VALIDATION  — the typed batch contract is enforced at the door (a
 *                 malformed or oversized batch is a typed 400, never a
 *                 handler crash, never a silent trim).
 *   REDACTION   — a credential in a client error message never reaches the
 *                 ledger: the stored document shows the mask, and ZERO
 *                 canary bytes exist in the SQLite files (witness-proven).
 *   OWNERSHIP   — a claimed run/chat/trace is attributed ONLY when the
 *                 server can prove it is the caller's own; a foreign claim
 *                 is dropped (unattributed), never recorded against
 *                 another user's timeline.
 *   RATE        — a dedicated per-user bucket refuses with a 429 that
 *                 tells the client to count the drop.
 *   OVERFLOW    — a client-stated dropped-events count is itself recorded
 *                 as a fact: the hole lands in the ledger, never silence.
 *
 * Owning-test search (the discipline): no existing guard covers client
 * telemetry ingestion — the subject is new (OF-AUDIT-2's finding), so this
 * file earns its place; the block-action liveness ratchet
 * (tests/prevention/block-action-owner.test.ts) separately forces a
 * round-trip proof for the new action; the sweep/fidelity guards extend
 * by derivation over the registries.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Set the project root BEFORE config resolves, so the timeline ledger this
// test writes lands in its own temp world.
await vi.hoisted(async () => {
  const { createTempDir } = await import("../helpers/temp-dir.ts");
  process.env.HARNESS_WEB_PROJECT_ROOT = createTempDir("ch-client-telemetry-root-");
});

import { serverConfig } from "../../server/kernel/config.ts";
import { getTimelineQuery, getTimelineRecorder } from "../../server/observability/timeline-bridge.ts";
import { createTimelineStore, withRecordingContext } from "../../server/kernel/canonical.ts";
import { rememberOwnCredential } from "../../server/llm/redaction.ts";
import { consumeScopedToken, resetRateLimiter } from "../../server/router/rate-limiter.ts";
import {
  defineClientTelemetryBlocks,
  resetClientTelemetrySummary,
} from "../../server/blocks/client-telemetry.ts";
import { clearBlocks, mountBlockRoutes } from "../../server/blocks/define.ts";
import { createTestUser, type TestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";

const INGEST_PATH = "/api/b/client.telemetry/ingest";

let srv: HttpTestServer;
let userA: TestUser;
let userB: TestUser;
/** A's own chat + run, created through the real DB owner. */
let chatA: { id: string };
let runA: { id: string };
/** A trace whose chain carries A's run (recorded through the real recorder). */
let traceA: string;

beforeAll(async () => {
  getTimelineQuery(); // the sink installs on first open, as production boot does
  srv = await startHttpTestServer({
    prefix: "ch-client-telemetry-",
    register: (router, _db, adb) => {
      clearBlocks();
      defineClientTelemetryBlocks(adb);
      mountBlockRoutes(router);
    },
  });
  userA = createTestUser(srv.db, "tel-alice");
  userB = createTestUser(srv.db, "tel-bob");
  const project = srv.db.createProject({ name: "telemetry-proof", path: process.env.HARNESS_WEB_PROJECT_ROOT! }, userA.userId);
  chatA = srv.db.createChat({ title: "proof chat", project_id: project.id }, userA.userId);
  // A run exists for ownership purposes the way runs always exist here: a
  // message row carrying the run id inside the caller's chat (ownership is
  // derived through the chat, never stored beside the run).
  runA = { id: `run-${randomUUID()}` };
  srv.db.createMessage(
    { chat_id: chatA.id, role: "assistant", content: "proof message", run_id: runA.id },
    userA.userId,
  );
  // A trace that provably matches A's run: one real recorder event, written
  // under A's run + the trace — exactly how a run's request chain exists in
  // production.
  traceA = `trace-${randomUUID()}`;
  withRecordingContext({ actor: { kind: "user", id: userA.userId }, runId: runA.id, traceId: traceA }, () => {
    getTimelineRecorder().recordEvent({
      eventType: "message",
      description: "trace ownership proof",
      outcome: "succeeded",
    });
  });
});

afterAll(async () => {
  if (srv) await srv.stop();
});

/** One POST through the real door. */
async function ingest(
  user: TestUser | null,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return await jsonRequest(srv.baseUrl, INGEST_PATH, {
    method: "POST",
    body,
    cookie: user === null ? null : user.cookie,
  });
}

/** A minimal well-formed batch. */
function batch(events: unknown[], correlation?: unknown, droppedCount?: number): unknown {
  return {
    events,
    ...(correlation === undefined ? {} : { correlation }),
    ...(droppedCount === undefined ? {} : { droppedCount }),
  };
}

function errorEvent(facts: Record<string, unknown>): unknown {
  return { kind: "client-error", clientTimestamp: Date.now(), facts };
}

function metricEvent(facts: Record<string, unknown>): unknown {
  return { kind: "client-metric", clientTimestamp: Date.now(), facts };
}

/** The newest client-error events recorded for one actor. */
function clientErrorsFor(actorId: string) {
  return getTimelineQuery()
    .byEventType("client-error", { ascending: false, limit: 50 })
    .events.filter((e) => e.actorId === actorId);
}

/** The full record (documents hydrated) for one event. */
function fullRecord(eventId: string) {
  const record = getTimelineQuery().getEvent(eventId);
  expect(record, "the recorded event must be readable back").toBeDefined();
  return record!;
}

describe("client telemetry ingest — auth + validation at the door", () => {
  test("an unauthenticated batch is refused (401)", async () => {
    const res = await ingest(null, batch([errorEvent({ message: "x" })]));
    expect(res.status).toBe(401);
  });

  test("a malformed batch is a typed 400, not a handler crash", async () => {
    const res = await ingest(userA, { nonsense: true });
    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toBe("invalid_block_input");
  });

  test("an unknown event kind is refused by name", async () => {
    const res = await ingest(userA, batch([{ kind: "client-invention", clientTimestamp: 1, facts: {} }]));
    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toBe("invalid_block_input");
  });

  test("a batch over the per-request event cap is refused whole (never silently trimmed)", async () => {
    const events = Array.from({ length: 33 }, () => errorEvent({ message: "overflow" }));
    const res = await ingest(userA, batch(events));
    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toBe("invalid_block_input");
    // And nothing from it landed.
    expect(clientErrorsFor(userA.userId).filter((e) => e.description.includes("overflow"))).toHaveLength(0);
  });

  test("a valid batch records each event, attributed to the caller", async () => {
    const before = clientErrorsFor(userA.userId).length;
    const res = await ingest(userA, batch([
      errorEvent({ message: "Uncaught TypeError: boom is not a function", source: "app.js", line: 42, column: 7 }),
      metricEvent({ longTaskMs: 87, longTaskCount: 2 }),
    ]));
    expect(res.status).toBe(200);
    const out = (res.body as { data?: { recorded?: number; correlation?: string; droppedRecorded?: number } }).data;
    expect(out?.recorded).toBe(2);
    expect(out?.correlation).toBe("none");
    expect(out?.droppedRecorded).toBe(0);

    const errors = clientErrorsFor(userA.userId);
    expect(errors.length).toBe(before + 1);
    const event = errors[0]!;
    // The actor is a SERVER fact — never claimed by the body.
    expect(event.actorKind).toBe("user");
    expect(event.actorId).toBe(userA.userId);
    expect(event.outcome).toBe("failed");
    expect(event.errorCode).toBe("client_error");
    expect(event.errorCategory).toBe("client");
    expect(event.description).toContain("browser error");
    // The document carries the facts, and NO wallTime is taken from the
    // client's clock (the server stamps the event's own time).
    const record = fullRecord(event.eventId);
    const doc = record.documents.find((d) => d.name === "client-facts");
    expect(doc, "the client-facts document must exist").toBeDefined();
    const facts = JSON.parse(doc!.contentJson ?? "{}") as Record<string, unknown>;
    expect(facts["message"]).toBe("Uncaught TypeError: boom is not a function");
    expect(facts["line"]).toBe(42);
    expect(record.wallTime).toBeTruthy();
    expect(event.traceId, "an unclaimed batch still hangs off the ingest request's own trace").toBeTruthy();
  });

  test("a caught warning is recorded as a warning and does not inflate the client-error count", async () => {
    const mod = await import("../../server/blocks/client-telemetry.ts");
    const before = mod.clientTelemetrySummary().clientErrors;
    const res = await ingest(userA, batch([
      errorEvent({ severity: "warn", category: "sse", message: "stream error: socket closed" }),
    ]));
    expect(res.status).toBe(200);
    const event = clientErrorsFor(userA.userId).find((e) => e.description.includes("stream error: socket closed"));
    expect(event, "the warning is a recorded fact, not a dropped one").toBeDefined();
    expect(event!.description).toContain("browser warning");
    expect(event!.errorCode).toBe("client_warning");
    expect(mod.clientTelemetrySummary().clientErrors, "a warning is not an uncaught error").toBe(before);
  });

  test("a client-stated dropped count is recorded as its own fact (the hole is never silent)", async () => {
    const res = await ingest(userA, batch([metricEvent({ bootMs: 1234 })], undefined, 5));
    expect(res.status).toBe(200);
    const out = (res.body as { data?: { recorded?: number; droppedRecorded?: number } }).data;
    expect(out?.droppedRecorded).toBe(1);
    expect(out?.recorded).toBe(2);
    const metrics = getTimelineQuery().byEventType("client-metric", { ascending: false, limit: 50 }).events;
    const drop = metrics.find((e) => e.description.includes("droppedClientEvents"));
    expect(drop, "the dropped count landed as a client-metric event").toBeDefined();
    const facts = JSON.parse(fullRecord(drop!.eventId).documents[0]!.contentJson ?? "{}") as Record<string, unknown>;
    expect(facts["droppedClientEvents"]).toBe(5);
  });

  // ── EVERY per-fact bound, each with its own arm ────────────────────────────
  //
  // The schema's inline trust-boundary limits (server/blocks/client-telemetry.ts:
  // the 2000-char fact-value cap, the 24-key fact cap, the 256-char correlation
  // id caps, the 1M droppedCount cap, the finite-number fact) are the only
  // thing standing between an untrusted body and the ledger's documents.
  // Each row proves ONE bound refuses at the door as a typed 400 and that
  // NOTHING from the refused batch landed. NaN/Infinity cannot ride a JSON
  // body (JSON.stringify coerces both to null) — the arms prove the door's
  // honest answer to that wire reality: the null that arrives is refused by
  // the fact-value union, so a non-finite number never becomes a document.
  test.each([
    ["a fact value over the 2000-char cap", (m: string) =>
      batch([errorEvent({ message: m, blob: "x".repeat(2001) })])],
    ["more than 24 facts on one event", (m: string) =>
      batch([errorEvent(Object.fromEntries(
        [["message", m] as const, ...Array.from({ length: 24 }, (_, i) => [`pad${i}`, i] as const)],
      ))])],
    ["a correlation id over the 256-char cap", (m: string) =>
      batch([errorEvent({ message: m })], { runId: "r".repeat(257) })],
    ["a droppedCount over the 1M cap", (m: string) =>
      batch([errorEvent({ message: m })], undefined, 1_000_001)],
    ["a non-finite number fact (NaN)", (m: string) =>
      batch([errorEvent({ message: m, ratio: Number.NaN })])],
    ["a non-finite number fact (Infinity)", (m: string) =>
      batch([errorEvent({ message: m, ratio: Number.POSITIVE_INFINITY })])],
  ])("%s is a typed 400, and nothing from it landed", async (_claim, makeBatch) => {
    const marker = `bound-proof-${randomUUID().replaceAll("-", "")}`;
    const res = await ingest(userA, makeBatch(marker));
    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toBe("invalid_block_input");
    expect(clientErrorsFor(userA.userId).filter((e) => e.description.includes(marker))).toHaveLength(0);
  });
});

describe("client telemetry ingest — a credential never reaches the ledger", () => {
  // A canary shaped like a real provider key and unique per run, PROVEN to
  // the redaction owner the way a server-held credential is (registered
  // through the owner's own remember API), so this arm exercises the
  // ROUTE's redaction wiring, not the detector's cleverness against an
  // unknown shape.
  const canary = `sk-clienttelcanary-${randomUUID().replaceAll("-", "")}`;
  const witness = `witness-${randomUUID().replaceAll("-", "")}`;

  test("an error message quoting the canary lands masked, and zero canary bytes exist on disk", async () => {
    rememberOwnCredential(canary, "client telemetry canary");
    const res = await ingest(userA, batch([
      errorEvent({ message: `fetch failed: key ${canary} rejected (marker ${witness})`, source: "app.js" }),
    ]));
    expect(res.status).toBe(200);
    const event = clientErrorsFor(userA.userId)[0]!;
    const record = fullRecord(event.eventId);
    const docText = JSON.stringify(record.documents) + record.description + (record.errorMessage ?? "");
    // The witness MUST be there (the scan is proven live), the canary MUST
    // NOT be (the masking worked), and the mask IS.
    expect(docText).toContain(witness);
    expect(docText).not.toContain(canary);
    expect(docText).toContain("[REDACTED");
    // Zero canary bytes in every file SQLite may hold this ledger in, and
    // the witness present in the union — a scan whose witness is nowhere
    // would be a blind scan, and a clean blind scan proves nothing.
    let witnessHits = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${serverConfig.timelineDbPath}${suffix}`;
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      expect(bytes.indexOf(canary), `${file} holds canary bytes`).toBe(-1);
      if (bytes.indexOf(witness) !== -1) witnessHits += 1;
    }
    expect(witnessHits, "the witness is in no ledger file — the scan is blind").toBeGreaterThanOrEqual(1);
  });
});

describe("client telemetry ingest — ownership of the claimed correlation", () => {
  test("A's own run + trace is attributed (verified)", async () => {
    const res = await ingest(userA, batch(
      [metricEvent({ ingestLagMs: 3, ingestFrames: 12 })],
      { runId: runA.id, chatId: chatA.id, traceId: traceA },
    ));
    expect(res.status).toBe(200);
    const out = (res.body as { data?: { correlation?: string } }).data;
    expect(out?.correlation).toBe("verified");
    const metrics = getTimelineQuery().byEventType("client-metric", { ascending: false, limit: 50 }).events;
    const mine = metrics.find(
      (e) => e.actorId === userA.userId && e.runId === runA.id && e.description.includes("ingestLagMs"),
    );
    expect(mine, "the event carries A's run id").toBeDefined();
    expect(mine!.traceId).toBe(traceA);
  });

  test("B claiming A's run records UNATTRIBUTED — nothing lands on A's timeline", async () => {
    const aEventsBefore = getTimelineQuery()
      .byRuns([runA.id], { ascending: false, limit: 200 })
      .events.filter((e) => e.actorId === userA.userId).length;
    const res = await ingest(userB, batch(
      [errorEvent({ message: "bob's page broke" })],
      { runId: runA.id, chatId: chatA.id, traceId: traceA },
    ));
    expect(res.status).toBe(200);
    const out = (res.body as { data?: { correlation?: string; recorded?: number } }).data;
    expect(out?.correlation).toBe("unattributed");
    expect(out?.recorded).toBe(1);
    // B's fact landed — attributed to B ALONE.
    const bEvent = clientErrorsFor(userB.userId).find((e) => e.description.includes("bob's page broke"));
    expect(bEvent).toBeDefined();
    expect(bEvent!.runId).toBeNull();
    expect(bEvent!.traceId).not.toBe(traceA);
    // A's run timeline did NOT grow by B's fact.
    const aEventsAfter = getTimelineQuery()
      .byRuns([runA.id], { ascending: false, limit: 200 })
      .events.filter((e) => e.actorId === userA.userId).length;
    expect(aEventsAfter).toBe(aEventsBefore);
  });

  test("a claimed trace with no provably-owned event is dropped, not attributed", async () => {
    const foreignTrace = `trace-${randomUUID()}`;
    const res = await ingest(userB, batch([metricEvent({ longTaskMs: 60, longTaskCount: 1 })], { traceId: foreignTrace }));
    expect(res.status).toBe(200);
    const out = (res.body as { data?: { correlation?: string } }).data;
    expect(out?.correlation).toBe("unattributed");
    expect(getTimelineQuery().byTrace(foreignTrace, { limit: 50 }).events).toHaveLength(0);
  });

  test("an owned trace in another ledger does not authorize write correlation here", async () => {
    const traceId = `trace-${randomUUID()}`;
    const other = createTimelineStore({ path: serverConfig.timelineDbPath, ledgerId: `ledger-${randomUUID()}` });
    try {
      other.appendEvent({ ledgerId: other.ledgerId, eventId: `event-${randomUUID()}`, eventType: "message",
        actor: { kind: "user", id: userA.userId }, correlation: { runId: runA.id }, traceId,
        description: "another ledger's owned trace", wallTime: "2026-01-01T00:00:00.000Z" });
      expect(other.traceMatchesAnyRun(traceId, [runA.id], other.ledgerId)).toBe(true);
      const res = await ingest(userA, batch([metricEvent({ longTaskMs: 75, longTaskCount: 1 })], { traceId }));
      expect(res.status).toBe(200);
      expect((res.body as { data: { correlation: string; recorded: number } }).data).toMatchObject({ correlation: "unattributed", recorded: 1 });
      expect(getTimelineQuery().byTrace(traceId, { limit: 50 }).events).toEqual([]);
    } finally { other.close(); }
  });
});

describe("client telemetry ingest — the dedicated rate bucket", () => {
  test("an exhausted per-user bucket refuses with a 429 that names the remedy", async () => {
    resetRateLimiter();
    // Drain the telemetry bucket for user B through the SAME scoped-bucket
    // door the handler consumes from (the limiter owner's own primitive,
    // scope + server-established owner id — the key is derived inside the
    // limiter, so this arm proves the DOOR refuses when the bucket is
    // empty).
    while (consumeScopedToken("client-telemetry", userB.userId)) {
      /* drain */
    }
    const res = await ingest(userB, batch([errorEvent({ message: "budget test" })]));
    expect(res.status).toBe(429);
    const body = res.body as { error?: string; message?: string };
    expect(body.error).toBe("client_telemetry_rate_limited");
    expect(body.message).toContain("counted client-side");
    expect(clientErrorsFor(userB.userId).filter((e) => e.description.includes("budget test"))).toHaveLength(0);
    resetRateLimiter();
  });
});

describe("client telemetry ingest — the live summary the exposure signals read", () => {
  test("errors and worst long tasks accumulate through the real door", async () => {
    resetClientTelemetrySummary();
    const res = await ingest(userA, batch([
      errorEvent({ message: "summary one" }),
      metricEvent({ longTaskMs: 120, longTaskCount: 3 }),
      metricEvent({ longTaskMs: 45, longTaskCount: 1 }),
    ]));
    expect(res.status).toBe(200);
    const summary = (await import("../../server/blocks/client-telemetry.ts")).clientTelemetrySummary();
    expect(summary.clientErrors).toBe(1);
    expect(summary.worstLongTaskMs).toBe(120);
    resetClientTelemetrySummary();
  });
});
