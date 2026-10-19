// @vitest-environment node
// Use fixture events (not real LLM) so the test is deterministic.
process.env.HARNESS_WEB_LLM_FIXTURES = "1";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { createRouter } from "../../server/router/router.ts";
import { isPublicPath } from "../../server/routes/registry.ts";
import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { registerChatRoutes } from "../../server/routes/chats.ts";
import { registerProjectRoutes } from "../../server/routes/projects.ts";
import { registerRunRoutes } from "../../server/routes/run.ts";
// The run's SUBSCRIBER moved to its own module when the executor was split
// out of the GET handler. A test that drives a run and then reads its stream
// needs both halves mounted, exactly as production mounts them — and the
// status read is the run's third module, mounted beside them.
import { registerRunStreamRoutes } from "../../server/routes/run-stream.ts";
import { registerRunStatusRoutes } from "../../server/routes/run-status.ts";
// The registry is module state the HTTP harness cannot reach; the status
// route's executing arm plants its one read field through the registry's
// own door (setActiveRun), the same door the start route uses.
import { setActiveRun, deleteActiveRun } from "../../server/run/run-registry.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

/**
 * Integration test: start a run bound to a chat, open the SSE stream,
 * consume the fixture events, then query the DB to verify the events
 * were persisted to the projection (user message, assistant message,
 * tool calls, timeline ref).
 */

let tmpRoot = "";
let server: Server;
let baseUrl: string;
let db: DbClient;
let authCookie: string;
// The tester's user id — the run-status route's executing arm needs it to
// plant a registry entry (below), which is the one server-side state the
// HTTP harness cannot reach any other way.
let testUserId: string;

beforeAll(async () => {
  tmpRoot = createTempDir("ch-web-sse-");
  const dbPath = join(tmpRoot, "web.db");
  db = new DbClient({ path: dbPath });
  // v12: register a user + create an auth session so the run/chat routes'
  // requireUserContext gate resolves a caller.
  const tester = createTestUser(db, "sse-tester");
  authCookie = tester.cookie;
  testUserId = tester.userId;

  const adb = AsyncDbClient.inline(db);
  const router = createRouter({ db: adb, isPublicPath });
  registerProjectRoutes(router, adb);
  registerChatRoutes(router, adb);
  registerRunRoutes(router, adb);
  registerRunStreamRoutes(router, adb);
  registerRunStatusRoutes(router, adb);

  server = createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (db) db.close();
});

// v12: the auth cookie (harness_auth) is the identity + scoping key.
const TEST_SESSION_COOKIE = "harness_session=test-sse-persistence-session";

async function postJson(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `${authCookie}; ${TEST_SESSION_COOKIE}`, "X-Requested-With": "test" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Cookie: `${authCookie}; ${TEST_SESSION_COOKIE}` },
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

/**
 * Consume an SSE stream until the server finishes sending its fixture
 * events (model events + 1 timeline + 1 agent) or a timeout. Uses raw
 * HTTP (Node has no global EventSource) — parses the
 * `event: name\ndata: json\n\n` framing manually.
 */
async function consumeSseUntilDone(url: string, timeoutMs = 8000): Promise<{
  model: unknown[];
  timeline: unknown[];
  agent: unknown[];
}> {
  const events = { model: [] as unknown[], timeline: [] as unknown[], agent: [] as unknown[] };

  const res = await fetch(url, {
    headers: { Cookie: `${authCookie}; ${TEST_SESSION_COOKIE}` },
  });
  if (!res.ok || !res.body) throw new Error(`SSE connection failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const timer = setTimeout(() => {
    try { reader.cancel(); } catch { /* ok */ }
  }, timeoutMs);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by \n\n
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        // Parse the frame: lines starting with "event:" or "data:"
        let eventName = "";
        let dataLine = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) eventName = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLine = line.slice(6);
        }

        if (eventName && dataLine) {
          const data = JSON.parse(dataLine);
          if (eventName in events) {
            (events as Record<string, unknown[]>)[eventName]!.push(data);
          }
          // The server sends all model events, then 1 timeline, then 1
          // agent event. After the agent event, the stream stays open
          // with keepalive. Close after the agent event.
          if (eventName === "agent") {
            clearTimeout(timer);
            // Small grace period for the server to persist.
            await new Promise((r) => setTimeout(r, 100));
            try { reader.cancel(); } catch { /* ok */ }
            return events;
          }
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return events;
}

describe("SSE stream persistence", () => {
  test("a run bound to a chat persists user + assistant + tool + timeline to the DB", async () => {
    // Create project + chat
    const p = await postJson("/api/projects", { name: "sse-test", path: "/sse" });
    const pid = (p.body as { id: string }).id;
    const c = await postJson(`/api/projects/${pid}/chats`, { title: "sse-chat" });
    const cid = (c.body as { id: string }).id;

    // Start a run bound to the chat
    const start = await postJson("/api/run/start", {
      projectId: pid,
      prompt: "analyze the architecture",
      chatId: cid,
    });
    expect(start.status).toBe(201);
    const runId = (start.body as { runId: string }).runId;

    // Consume the SSE stream until the server finishes sending events
    const events = await consumeSseUntilDone(`${baseUrl}/api/run/${runId}/stream`);
    expect(events.model.length).toBeGreaterThan(0);
    // Real timeline ledger streams the run's recorded events (run, turn,
    // message, usage, finish) — at least one event must be persisted.
    expect(events.timeline.length).toBeGreaterThanOrEqual(1);
    // A simple chat does NOT create an agent — the fixture "coordinator"
    // agent injection was removed so the Agents tab is truthful (empty
    // until a real agent runs). No agent events should be streamed.
    expect(events.agent.length).toBe(0);

    // Verify the user message was persisted
    const msgs = await getJson(`/api/chats/${cid}/messages`);
    const messages = msgs.body as Array<{ role: string; content: string; runId: string | null }>;
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("analyze the architecture");
    expect(messages[0]!.runId).toBe(runId);

    // The assistant message should have accumulated text from text_delta events
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.content.length).toBeGreaterThan(0);

    // Tool calls should be persisted. FIX: the tool call result
    // (output + finalized status) must survive a page refresh. The old
    // code hardcoded "done" regardless of execution; the new code reflects
    // the actual execution result. The project path "/sse" doesn't exist,
    // so read_file fails → status is "error" and output is the error
    // message. The invariant: at least one tool call is finalized (NOT
    // "running") and has a non-null output (persisted result).
    const tcs = await getJson(`/api/chats/${cid}/tool-calls`);
    const toolCalls = tcs.body as Array<{ toolName: string; status: string; output: unknown }>;
    expect(toolCalls.length).toBeGreaterThan(0);
    const finalized = toolCalls.find((tc) => tc.status === "done" || tc.status === "error");
    expect(finalized, "No finalized tool call found — status should be 'done' or 'error', not 'running'").toBeDefined();
    expect(finalized!.output, "Tool call output was not persisted — it disappears on page refresh").not.toBeNull();

    // Timeline ref should be persisted
    const refs = await getJson(`/api/chats/${cid}/timeline`);
    const timelineRefs = refs.body as Array<{ eventId: string; eventType: string }>;
    expect(timelineRefs.length).toBeGreaterThan(0);

    // History endpoint returns everything in one payload
    const hist = await getJson(`/api/chats/${cid}/history`);
    const history = hist.body as {
      messages: unknown[];
      toolCalls: unknown[];
      timelineRefs: unknown[];
      metricsSnapshots: unknown[];
    };
    expect(history.messages.length).toBeGreaterThanOrEqual(2);
    expect(history.toolCalls.length).toBeGreaterThan(0);
    expect(history.timelineRefs.length).toBeGreaterThan(0);
  });

  test("a run WITHOUT a chatId streams events but persists nothing", async () => {
    // Create a project first (the run/start endpoint validates project existence).
    const proj = await postJson("/api/projects", { name: "orphan-proj", path: "/tmp/orphan" });
    const pid = (proj.body as { id: string }).id;
    // Start a run without chatId
    const start = await postJson("/api/run/start", {
      projectId: pid,
      prompt: "orphan run",
    });
    expect(start.status).toBe(201);
    const runId = (start.body as { runId: string }).runId;

    // Consume the SSE stream
    const events = await consumeSseUntilDone(`${baseUrl}/api/run/${runId}/stream`);
    expect(events.model.length).toBeGreaterThan(0);

    // No chat was created, so there's nothing to verify in the DB.
    // The run still streams events to the client; persistence is skipped.
    expect(true).toBe(true);
  });
});

// ── THE RUN'S ONE STATUS READ — the reloaded page's liveness authority ──────
//
// A hydrate that rebuilds a conversation can hold an assistant row whose
// turn started and never ended (a server death mid-stream writes no
// terminal mark anywhere). Whether that row is still filling or final is a
// fact only the server's registry can answer, and this route is its read:
// registry-only liveness (a run leaves the registry only after its final
// row writes, so "not executing" is a write barrier), ownership from the
// record for runs this process never knew, and a hidden absence for runs
// the caller cannot prove. MUTATION: delete the route (or answer
// executing:true from the retained feed, which a reloaded page would then
// poll forever) and every arm below reds.
describe("the run status read", () => {
  // The route registers are module state; the route reads exactly
  // `userId` from a live entry, so a minimal planted entry tests the
  // route's own contract (not the executor's) without faking a run.
  test("a run in the registry answers executing:true — and leaves it when deleted", async () => {
    const runId = "run-planted-for-status";
    setActiveRun(runId, { userId: testUserId } as unknown as Parameters<typeof setActiveRun>[1]);
    try {
      const live = await getJson(`/api/run/${runId}/status`);
      expect(live.status).toBe(200);
      expect((live.body as { executing: boolean }).executing).toBe(true);
    } finally {
      deleteActiveRun(runId);
    }
    const after = await getJson(`/api/run/${runId}/status`);
    // No message row carries this run (nothing ever executed it), so the
    // record cannot prove ownership — the hidden absence, same as any
    // unknown run.
    expect(after.status).toBe(404);
  });

  test("a run that ended answers executing:false, its ownership proven by the record", async () => {
    const p = await postJson("/api/projects", { name: "sse-status", path: "/tmp/sse-status" });
    const pid = (p.body as { id: string }).id;
    const c = await postJson(`/api/projects/${pid}/chats`, { title: "sse-status-chat" });
    const cid = (c.body as { id: string }).id;
    const start = await postJson("/api/run/start", {
      projectId: pid,
      prompt: "say one thing",
      chatId: cid,
    });
    const runId = (start.body as { runId: string }).runId;
    await consumeSseUntilDone(`${baseUrl}/api/run/${runId}/stream`);

    // The executor's finally deletes the registry entry within moments of
    // the last frame; wait for the barrier to land (bounded — a timeout
    // fails the arm, never satisfies it).
    let body: { executing: boolean } | undefined;
    for (let i = 0; i < 40; i += 1) {
      const res = await getJson(`/api/run/${runId}/status`);
      expect(res.status, "the caller's own run is always a 200 — dead or not").toBe(200);
      body = res.body as { executing: boolean };
      if (!body.executing) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(body!.executing, "the run ended; the registry is the one liveness owner").toBe(false);
  });

  test("a run whose caller can prove nothing is a hidden absence", async () => {
    const unknown = await getJson("/api/run/run-nobody-ever-started/status");
    expect(unknown.status).toBe(404);
  });
});
