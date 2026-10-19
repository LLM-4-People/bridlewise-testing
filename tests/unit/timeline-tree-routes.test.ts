// @vitest-environment node
import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { registerTimelineRoutes } from "../../server/routes/timeline.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { createTimelineStore, generateId } from "../../server/kernel/canonical.ts";
import { getTimelineRecorder, getTimelineStore, getTimelineQuery } from "../../server/observability/timeline-bridge.ts";
import { serverConfig } from "../../server/kernel/config.ts";
import { withRecordingContext } from "../../engine/src/timeline/recording-context.ts";
import { sha256 } from "../../engine/src/kernel/integrity.ts";
import { TRACE_ID_HEADER } from "../../shared/constants.ts";
import { defineSpectrumBlocks, SWEEP_CATEGORIES, type SpectrumRead } from "../../server/blocks/spectrum.ts";
import { mountBlockRoutes } from "../../server/blocks/define.ts";
import { blockReadPath } from "../../shared/block-contract.ts";
import { TIMELINE_QUERY_LIMIT } from "../../shared/constants.ts";

type TimelineEventRecord = ReturnType<ReturnType<typeof createTimelineStore>["appendEvent"]>;
type TimelineEventSummariesResult = ReturnType<ReturnType<typeof getTimelineQuery>["eventSummaries"]>;

/**
 * Integration test: real HTTP server with the timeline route. The timeline
 * bridge opens a SQLite ledger (at the default.bridlewise path, which is
 * gitignored). Older shape cases coexist with exact ownership fixtures using fresh users
 * and run IDs, so prior ledger data cannot satisfy their oracles. v12: the route
 * now requires an authenticated user (requireUserContext).
 *
 * The traceId filter cases: a trace is a client-supplied scope over a global
 * ledger, so the route gates it the way explicit runIds are gated —
 * ownership is proven by the trace carrying an event whose run belongs to
 * the caller. The positive case's probe event is written through the REAL
 * recorder (the same writer the run executor uses) inside a real recording
 * context, and the caller's ownership of the run is built through the
 * real ownership mapping (`messages.run_id` under the user's chat) — so the
 * gate is exercised end to end, not against a stubbed ledger.
 *
 * The SAME gate is also pinned here at the sweep.spectrum BLOCK door
 * (`GET /api/b/sweep.spectrum?scope=trace`), which consumes the SAME shared
 * authorization scope (server/blocks/spectrum.ts): the store
 * mechanism (`traceMatchesAnyRun`) is pinned in the engine's port tests
 * and the client's 404-fallback against a mock, but only this harness
 * drives the BLOCK handler with a real db + a foreign user.
 */

let srv: HttpTestServer;
let req: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;
let authCookie: string;
let userId: string;

/** A request that also hands back the response headers, for the
 * x-trace-id the router stamps on every response. */
async function reqWithHeaders(
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; headers: Headers }> {
  const r = await jsonRequest(srv.baseUrl, path, { method: "POST", body, cookie: authCookie });
  return { status: r.status, json: r.body, headers: r.headers };
}

beforeAll(async () => {
  srv = await startHttpTestServer({
    prefix: "ch-web-tl-",
    register: (router, db, adb) => {
      registerTimelineRoutes(router, adb);
      // The OTHER door a client-supplied trace id reaches: the sweep.spectrum
      // block's trace scope, mounted beside the route so the block handler's
      // shared ownership boundary is pinned in the same harness, not implied by it.
      defineSpectrumBlocks(adb);
      mountBlockRoutes(router);
    },
  });
  const tester = createTestUser(srv.db, "tl-tester");
  authCookie = tester.cookie;
  userId = tester.userId;
  req = async (method, path, body) => {
    const { status, body: json } = await jsonRequest(srv.baseUrl, path, { method, body, cookie: authCookie });
    return { status, json };
  };
});

afterAll(async () => {
  if (srv) await srv.stop();
});

describe("timeline route: query + event detail endpoints", () => {
  test("owned HTTP detail preserves exact inline representations and digest-only absence", async () => {
    const owner = createTestUser(srv.db, "document-owner");
    const other = createTestUser(srv.db, "document-other");
    const project = srv.db.createProject({ name: "documents", path: "/tmp/documents" }, owner.userId);
    const chat = srv.db.createChat({ project_id: project.id, title: "documents" }, owner.userId);
    const runId = generateId("run");
    srv.db.createMessage({ chat_id: chat.id, role: "user", content: "documents", run_id: runId }, owner.userId);
    const documents = [
      { name: "empty", contentJson: "", contentDigest: sha256("") },
      { name: "ordered", orderedJson: '{ "b": 2, "a": 1 }\r\n', contentDigest: sha256('{ "b": 2, "a": 1 }\r\n') },
      { name: "raw", contentJson: "raw\u0000suffix\r\n", contentDigest: sha256("raw\u0000suffix\r\n") },
      { name: "json-null", contentJson: "null", contentDigest: sha256("null") },
      { name: "reference", contentDigest: sha256("reference") },
    ];
    const event = getTimelineRecorder().recordEvent({ eventType: "artifact", description: "exact document text", correlation: { runId }, documents });
    const response = await jsonRequest(srv.baseUrl, `/api/timeline/events/${event.eventId}`, { method: "GET", cookie: owner.cookie });
    expect(response.status).toBe(200);
    expect((response.body as TimelineEventRecord).documents.map(({ name, contentJson, orderedJson, contentDigest }) => ({ name, contentJson, orderedJson, contentDigest }))).toEqual(documents.map((document) => ({ name: document.name, contentJson: "contentJson" in document ? document.contentJson : null, orderedJson: "orderedJson" in document ? document.orderedJson : null, contentDigest: document.contentDigest })));
    const denied = await jsonRequest(srv.baseUrl, `/api/timeline/events/${event.eventId}`, { method: "GET", cookie: other.cookie });
    expect(denied.status).toBe(404);
  });

  test("terminal detail and query retain the originating owner's scope across foreign context", async () => {
    const owner = createTestUser(srv.db, "terminal-origin");
    const foreign = createTestUser(srv.db, "terminal-foreign");
    const ownedRun = (user: typeof owner, name: string) => {
      const project = srv.db.createProject({ name, path: `/tmp/${name}` }, user.userId);
      const chat = srv.db.createChat({ project_id: project.id, title: name }, user.userId);
      const runId = generateId("run");
      srv.db.createMessage({ chat_id: chat.id, role: "user", content: name, run_id: runId }, user.userId);
      return runId;
    };
    const originRun = ownedRun(owner, "terminal-origin-run");
    const foreignRun = ownedRun(foreign, "terminal-foreign-run");
    const traceId = generateId("trace");
    const recorder = getTimelineRecorder();
    const intent = withRecordingContext({ actor: { kind: "user", id: owner.userId }, runId: originRun, traceId, spanId: "original-span" }, () => recorder.beginEffect({
      effectId: generateId("effect"), kind: "provider", actor: { kind: "agent", id: "origin-agent", role: "author" }, description: "owned provider operation", intentHash: sha256("intent"),
    }));
    const terminal = withRecordingContext({ actor: { kind: "user", id: foreign.userId }, runId: foreignRun, traceId: generateId("trace"), spanId: "foreign-span" }, () => recorder.endEffect(intent.record.effectId, { outcome: "succeeded", resultHash: sha256("result") }));
    const ownDetail = await jsonRequest(srv.baseUrl, `/api/timeline/events/${terminal.receipt.eventId}`, { method: "GET", cookie: owner.cookie });
    expect(ownDetail.status).toBe(200);
    expect(ownDetail.body).toMatchObject({ eventId: terminal.receipt.eventId, parentEventId: intent.receipt.eventId, actorId: "origin-agent", actorRole: "author", runId: originRun, traceId, spanId: "original-span" });
    const foreignDetail = await jsonRequest(srv.baseUrl, `/api/timeline/events/${terminal.receipt.eventId}`, { method: "GET", cookie: foreign.cookie });
    expect(foreignDetail.status).toBe(404);
    const query = { effectId: intent.record.effectId, recordKind: "terminal" };
    const ownQuery = await jsonRequest(srv.baseUrl, "/api/timeline/query", { method: "POST", cookie: owner.cookie, body: query });
    expect(ownQuery.status).toBe(200);
    expect((ownQuery.body as { events: TimelineEventRecord[] }).events.map((row) => row.eventId)).toEqual([terminal.receipt.eventId]);
    const foreignQuery = await jsonRequest(srv.baseUrl, "/api/timeline/query", { method: "POST", cookie: foreign.cookie, body: query });
    expect(foreignQuery.status).toBe(200);
    expect((foreignQuery.body as { events: TimelineEventRecord[] }).events).toEqual([]);
  });

  test("POST /api/timeline/query returns 200 with correct shape", async () => {
    const { status, json } = await req("POST", "/api/timeline/query", {});
    expect(status).toBe(200);
    const result = json as { events: unknown[]; total: number; hasMore: boolean };
    expect(Array.isArray(result.events)).toBe(true);
    expect(typeof result.total).toBe("number");
    expect(typeof result.hasMore).toBe("boolean");
  });

  test("an unscoped query with no limit serves the product's page, never the store's 1,000-row default", async () => {
    // THE DEFAULT PAGE IS THE PRODUCT'S PAGE. Every real caller asks for
    // TIMELINE_QUERY_LIMIT rows (the one shared owner); a caller naming no
    // limit must not receive the engine store's 1,000-row default — a
    // ~1 MB page for a forgotten `limit` (measured live: the perf mint's
    // empty-body sample of this route rode that default over its 250ms
    // budget). Seed MORE than one page through the REAL recorder, then ask
    // for the unscoped default: the page is exactly one product page, with
    // the honest hasMore + cursor for the rest.
    const project = srv.db.createProject({ name: "page-bound-probe", path: "/tmp/page-bound-probe" }, userId);
    const chat = srv.db.createChat({ project_id: project.id, title: "page bound probe" }, userId);
    const runId = generateId("run");
    srv.db.createMessage(
      { chat_id: chat.id, role: "user", content: "page bound probe", run_id: runId },
      userId,
    );
    const seeded = TIMELINE_QUERY_LIMIT + 5;
    withRecordingContext(
      { actor: { kind: "user", id: userId }, traceId: generateId("trace"), runId },
      () => {
        for (let i = 0; i < seeded; i += 1) {
          getTimelineRecorder().recordEvent({
            eventType: "run",
            description: `page bound probe event ${i}`,
            correlation: { runId },
          });
        }
      },
    );
    const { status, json } = await req("POST", "/api/timeline/query", {});
    expect(status).toBe(200);
    const result = json as { events: unknown[]; hasMore: boolean; nextCursor: string | null };
    expect(result.events).toHaveLength(TIMELINE_QUERY_LIMIT);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });

  test("POST /api/timeline/query rejects invalid body with 400", async () => {
    const { status } = await req("POST", "/api/timeline/query", { limit: -1 });
    expect(status).toBe(400);
  });

  test("GET /api/timeline/events/:eventId returns 404 for unknown event", async () => {
    const { status, json } = await req("GET", "/api/timeline/events/nonexistent-id-xyz");
    expect(status).toBe(404);
    const result = json as { error: string; eventId: string };
    expect(result.error).toBe("not_found");
    expect(result.eventId).toBe("nonexistent-id-xyz");
  });

  test("POST /api/timeline/query accepts eventType filter", async () => {
    const { status, json } = await req("POST", "/api/timeline/query", { eventType: "tool" });
    expect(status).toBe(200);
    const result = json as { events: unknown[] };
    expect(Array.isArray(result.events)).toBe(true);
  });

  test("POST /api/timeline/query with explicit ledgerId is respected", async () => {
    const { status, json } = await req("POST", "/api/timeline/query", { ledgerId: "ledger-custom" });
    expect(status).toBe(200);
    const result = json as { events: unknown[] };
    expect(Array.isArray(result.events)).toBe(true);
  });

  // ── the traceId scope: gated like every client-supplied scope ──────────
  describe("POST /api/timeline/query traceId filter", () => {
    test("a trace the caller cannot prove ownership of is a hidden absence (404), never a leak", async () => {
      // The test's OWN request trace: the router mints one per request, the
      // http lane records it — but a query request produces no run, so no
      // event of that trace carries a run the caller owns. Deny-by-default
      // must refuse exactly this: an existing, even self-produced, trace
      // with no ownership-provable event.
      const probe = await reqWithHeaders("/api/timeline/query", {});
      expect(probe.status).toBe(200);
      const ownTraceId = probe.headers.get(TRACE_ID_HEADER);
      expect(ownTraceId).toMatch(/^trace-/u);
      const { status, json } = await req("POST", "/api/timeline/query", { traceId: ownTraceId });
      expect(status).toBe(404);
      // The router's typed-error contract for NotFoundError, verbatim —
      // not just "some 404": the error code and the message's subject.
      expect(json).toMatchObject({ error: "not_found" });
      expect(JSON.stringify(json)).toContain(ownTraceId);
    });

    test("a trace carrying an event of the caller's own run returns exactly that trace's events", async () => {
      // Ownership mapping: a message row carrying the run id under the
      // user's chat — the same authority `allRunIdsForUser` reads.
      const project = srv.db.createProject({ name: "trace-probe", path: "/tmp/trace-probe" }, userId);
      const chat = srv.db.createChat({ project_id: project.id, title: "trace probe" }, userId);
      const runId = generateId("run");
      srv.db.createMessage(
        { chat_id: chat.id, role: "user", content: "trace filter probe", run_id: runId },
        userId,
      );
      const traceId = generateId("trace");
      const marker = `trace filter probe event ${traceId}`;
      // The probe event goes through the REAL recorder inside a REAL
      // recording context, the same ambient path a run's events ride.
      withRecordingContext(
        { actor: { kind: "user", id: userId }, traceId, runId },
        () => getTimelineRecorder().recordEvent({
          eventType: "run",
          description: marker,
          correlation: { runId },
        }),
      );
      const { status, json } = await req("POST", "/api/timeline/query", { traceId });
      expect(status).toBe(200);
      const result = json as { events: { traceId: string | null; description: string }[]; total: number };
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.events.every((e) => e.traceId === traceId)).toBe(true);
      expect(result.events.some((e) => e.description === marker)).toBe(true);
    });
  });

  // ── the SAME gate at the sweep.spectrum BLOCK door ─────────────────────
  //
  // The route above is one of TWO server doors a client-supplied trace id
  // reaches; `sweep.spectrum` (scope=trace) is the other, and its handler
  // Shares the list authorization boundary and must enforce it at this door.
  describe("GET /api/b/sweep.spectrum scope=trace — the block door's ownership gate", () => {
    test("a foreign user's trace is a hidden absence (404); the owner reads the trace's chain", async () => {
      // The two-user fixture, the route arms' shape: user B's run is made
      // ownable through the REAL mapping (`messages.run_id` under B's
      // chat) and B's trace is seeded through the REAL recorder inside a
      // REAL recording context — the same writer a run's events ride.
      const owner = createTestUser(srv.db, "spectrum-owner");
      const project = srv.db.createProject({ name: "spectrum-probe", path: "/tmp/spectrum-probe" }, owner.userId);
      const chat = srv.db.createChat({ project_id: project.id, title: "spectrum probe" }, owner.userId);
      const runId = generateId("run");
      srv.db.createMessage(
        { chat_id: chat.id, role: "user", content: "spectrum trace probe", run_id: runId },
        owner.userId,
      );
      const traceId = generateId("trace");
      const marker = `spectrum trace probe event ${traceId}`;
      withRecordingContext(
        { actor: { kind: "user", id: owner.userId }, traceId, runId },
        () => getTimelineRecorder().recordEvent({
          eventType: "run",
          description: marker,
          correlation: { runId },
        }),
      );

      const traceRead = (cookie: string) =>
        jsonRequest(
          srv.baseUrl,
          `${blockReadPath("sweep.spectrum")}?scope=trace&traceId=${encodeURIComponent(traceId)}`,
          { cookie },
        );

      // The foreign caller (this file's own tester) owns no run inside B's
      // trace: deny-by-default answers 404 — the router's typed-error
      // contract verbatim, hiding the trace's existence, never a leak.
      const foreign = await traceRead(authCookie);
      expect(foreign.status).toBe(404);
      expect(foreign.body).toMatchObject({ error: "not_found" });
      expect(JSON.stringify(foreign.body)).toContain(traceId);

      // The owner sees only rows attributed to their runs, even in a trace.
      const own = await traceRead(owner.cookie);
      expect(own.status).toBe(200);
      const body = own.body as { data?: { header?: { events?: number; attributedOnly?: boolean } } };
      expect(body.data?.header?.events).toBeGreaterThanOrEqual(1);
      expect(body.data?.header?.attributedOnly).toBe(true);
    });
  });
});

// The real read boundary: the DB owns users/runs, the ledger owns rows, and
// correlation never promotes another row into the caller's authorized set.
describe("timeline authorization across users, pagination and ledgers", () => {
  let a: ReturnType<typeof createTestUser>;
  let b: ReturnType<typeof createTestUser>;
  let empty: ReturnType<typeof createTestUser>;
  let chatA: string, projectA: string, chatB: string, projectB: string;
  const runs = [generateId("run"), generateId("run"), generateId("run")];
  const traceId = generateId("trace");
  const turnId = generateId("turn"), agentId = generateId("agent"), taskId = generateId("task");
  const neighborLedger = generateId("ledger");
  const onlyNeighborTrace = generateId("trace"), borrowedTrace = generateId("trace");
  const rows: TimelineEventRecord[] = [];
  let neighbor: TimelineEventRecord, onlyNeighbor: TimelineEventRecord;
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  const list = async (cookie: string, body: unknown) => {
    const response = await jsonRequest(srv.baseUrl, "/api/timeline/query", { method: "POST", cookie, body });
    expect(response.status).toBe(200);
    return response.body as TimelineEventSummariesResult;
  };
  const ids = (result: TimelineEventSummariesResult) => result.events.map((e) => e.eventId);
  const expectedA = () => [rows[0]!, rows[3]!, rows[5]!];
  beforeAll(() => {
    a = createTestUser(srv.db, "scope-a"); b = createTestUser(srv.db, "scope-b"); empty = createTestUser(srv.db, "scope-empty");
    function own(user: typeof a, name: string, runIds: string[]) {
      const project = srv.db.createProject({ name, path: `/tmp/${name}` }, user.userId);
      const chat = srv.db.createChat({ project_id: project.id, title: name }, user.userId);
      for (const run_id of runIds) srv.db.createMessage({ chat_id: chat.id, role: "user", content: name, run_id }, user.userId);
      return { project: project.id, chat: chat.id };
    }
    ({ project: projectA, chat: chatA } = own(a, "scope-a", [runs[0]!, runs[1]!]));
    ({ project: projectB, chat: chatB } = own(b, "scope-b", [runs[2]!]));
    const store = getTimelineStore();
    const seed = (target: typeof store, runId: string | undefined, minute: number, trace = traceId, failed = false) => target.appendEvent({
      ledgerId: target.ledgerId, eventId: generateId("event"), eventType: "message",
      actor: { kind: "user", id: a.userId }, description: "scope evidence",
      wallTime: at(minute), traceId: trace,
      correlation: { ...(runId !== undefined ? { runId } : {}), turnId, agentId, taskId },
      outcome: failed ? "failed" : "succeeded",
    });
    rows.push(seed(store, runs[0], 0), seed(store, runs[2], -100, traceId, true), seed(store, undefined, 100, traceId, true),
      seed(store, runs[1], 10, traceId, true), seed(store, runs[2], 50), seed(store, runs[0], 20));
    // This positive membership in the default ledger must not authorize the
    // foreign-only row with the same trace identifier in the selected ledger.
    seed(store, runs[0], 30, borrowedTrace);
    const other = createTimelineStore({ path: serverConfig.timelineDbPath, ledgerId: neighborLedger });
    try {
      neighbor = seed(other, runs[0], -200, traceId, true);
      onlyNeighbor = seed(other, runs[0], 5, onlyNeighborTrace);
      seed(other, runs[2], 5, borrowedTrace);
    } finally { other.close(); }
  });

  test("bare and alternate filters always intersect owned runs before returning rows", async () => {
    const expected = expectedA().map((e) => e.eventId);
    for (const filter of [{}, { turnId }, { agentId }, { taskId }, { eventType: "message" }, { recordKind: "event" }]) {
      // A fixed wall bound excludes the separate default-ledger trace probe.
      const result = await list(a.cookie, { ...filter, toWallTime: at(20), ascending: true });
      expect(ids(result), JSON.stringify(filter)).toEqual(expected);
      expect(result.total).toBe(3);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    }
    const none = await list(empty.cookie, {});
    expect(ids(none)).toEqual([]); expect(none.total).toBe(0);
  });

  test("effect IDs narrow owned rows and never grant access to another run", async () => {
    const store = getTimelineStore();
    for (const [runId, owned] of [[runs[0]!, true], [runs[2]!, false]] as const) {
      const effectId = generateId("effect");
      const intent = store.appendIntent({ ledgerId: store.ledgerId, eventId: generateId("event"), effectId,
        eventType: "provider", effectKind: "provider", intentHash: "a".repeat(64),
        actor: { kind: "user", id: a.userId }, correlation: { runId }, description: "effect scope witness", wallTime: at(40) });
      const result = await list(a.cookie, { effectId });
      expect(ids(result)).toEqual(owned ? [intent.eventId] : []);
      expect(result.total).toBe(owned ? 1 : 0);
    }
  });

  test("explicit empty presence and singular/plural union retain their exact selection semantics", async () => {
    for (const filter of [{ runIds: [] }, { runIds: [], chatId: chatA }, { runIds: [], projectId: projectA }, { runIds: [runs[2]] }]) {
      const result = await list(a.cookie, filter);
      expect(ids(result)).toEqual([]); expect(result.total).toBe(0); expect(result.hasMore).toBe(false); expect(result.nextCursor).toBeNull();
    }
    const singular = await list(a.cookie, { runId: runs[0], runIds: [], traceId, ascending: true });
    expect(ids(singular)).toEqual([rows[0]!.eventId, rows[5]!.eventId]);
    const union = await list(a.cookie, { runId: runs[0], runIds: [runs[1], runs[2], runs[1]], traceId, ascending: true });
    expect(ids(union)).toEqual(expectedA().map((e) => e.eventId)); expect(union.total).toBe(3);
  });

  test("mixed-trace pagination filters rows and totals before limit, in both directions", async () => {
    for (const ascending of [true, false]) {
      const expected = ascending ? expectedA() : expectedA().toReversed();
      let cursor: string | undefined;
      for (let i = 0; i < expected.length; i += 1) {
        const page = await list(a.cookie, { traceId, ascending, limit: 1, ...(cursor !== undefined ? { cursor } : {}) });
        expect(ids(page)).toEqual([expected[i]!.eventId]); expect(page.total).toBe(3);
        expect(page.hasMore).toBe(i < 2);
        expect(page.nextCursor).toBe(i < 2 ? expected[i]!.sequence : null);
        cursor = page.nextCursor ?? undefined;
      }
    }
    const other = await list(b.cookie, { traceId, ascending: true });
    expect(ids(other)).toEqual([rows[1]!.eventId, rows[4]!.eventId]); expect(other.total).toBe(2);
    const offset = await list(a.cookie, { traceId, ascending: true, limit: 1, offset: 1 });
    expect(ids(offset)).toEqual([rows[3]!.eventId]); expect(offset.total).toBe(3); expect(offset.hasMore).toBe(true);
  });

  test("explicit ledger selection and trace membership use the same ledger", async () => {
    expect(ids(await list(a.cookie, { ledgerId: neighborLedger, traceId }))).toEqual([neighbor.eventId]);
  });

  test("trace membership accepts ownership only in the selected alternate ledger", async () => {
    expect(ids(await list(a.cookie, { ledgerId: neighborLedger, traceId: onlyNeighborTrace }))).toEqual([onlyNeighbor.eventId]);
  });

  test("trace membership cannot borrow ownership from a different ledger", async () => {
    const denied = await jsonRequest(srv.baseUrl, "/api/timeline/query", {
      method: "POST", cookie: a.cookie, body: { ledgerId: neighborLedger, traceId: borrowedTrace },
    });
    expect(denied.status).toBe(404);
    expect(denied.body).toMatchObject({ error: "not_found", message: `Trace ${borrowedTrace} not found` });
  });

  test("explicit ledger selection also applies without a trace filter", async () => {
    expect(ids(await list(a.cookie, { ledgerId: neighborLedger, runIds: [runs[0]], ascending: true }))).toEqual([neighbor.eventId, onlyNeighbor.eventId]);
  });

  test("chat/project priority and event-detail hidden absences remain intact", async () => {
    for (const filter of [{ chatId: chatB, runId: runs[0] }, { projectId: projectB }]) {
      const denied = await jsonRequest(srv.baseUrl, "/api/timeline/query", { method: "POST", cookie: a.cookie, body: filter });
      expect(denied.status).toBe(404); expect(denied.body).toMatchObject({ error: "not_found", message: "chatId" in filter ? `Chat ${filter.chatId} not found` : `Project ${filter.projectId} not found` });
    }
    expect(ids(await list(a.cookie, { chatId: chatA, projectId: projectB, traceId, ascending: true }))).toEqual(expectedA().map((e) => e.eventId));
    for (const row of [rows[1]!, rows[2]!]) {
      const denied = await jsonRequest(srv.baseUrl, `/api/timeline/events/${row.eventId}`, { cookie: a.cookie });
      expect(denied.status).toBe(404); expect(denied.body).toEqual({ error: "not_found", eventId: row.eventId });
    }
    const owned = await jsonRequest(srv.baseUrl, `/api/timeline/events/${rows[0]!.eventId}`, { cookie: a.cookie });
    expect(owned.status).toBe(200); expect(owned.body).toMatchObject({ eventId: rows[0]!.eventId, runId: runs[0] });
  });

  test("spectrum aggregates only owned rows in the default ledger, including time range and error cells", async () => {
    for (const scope of [{ scope: "trace", traceId }, { scope: "chat", chatId: chatA }, { scope: "project", projectId: projectA }]) {
      const query = new URLSearchParams({ ...scope, bins: "2", until: String(Date.parse(at(20))) });
      const response = await jsonRequest(srv.baseUrl, `${blockReadPath("sweep.spectrum")}?${query}`, { cookie: a.cookie });
      expect(response.status).toBe(200);
      const result = (response.body as { data: SpectrumRead }).data;
      expect(result.header).toMatchObject({ attributedOnly: true, events: 3, t0: Date.parse(at(0)), t1: Date.parse(at(20)), binMs: 600001, bins: 2, unbinnable: 0 });
      const bytes = Buffer.from(result.packed, "base64");
      const cells = Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readInt16LE(i * 2));
      const expected = Array.from({ length: (SWEEP_CATEGORIES.length + 1) * 2 }, () => 0);
      expected[0] = 2; expected[1] = 1; expected[SWEEP_CATEGORIES.length * 2] = 1;
      expect(cells).toEqual(expected);
    }
  });
});
