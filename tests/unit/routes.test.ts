// @vitest-environment node
import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { registerProjectRoutes } from "../../server/routes/projects.ts";
import { registerChatRoutes } from "../../server/routes/chats.ts";
import { registerAutoCheckRoutes } from "../../server/routes/auto-checks.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { makeJsonRequest } from "../helpers/json-request.ts";

/**
 * Integration test: real HTTP server backed by a fresh file-based
 * SQLite DB. Exercises the full request → route → DB → response cycle
 * for every chat/auto-checks endpoint.
 */

let srv: HttpTestServer;
let req: (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: unknown }>;

beforeAll(async () => {
  srv = await startHttpTestServer({
    prefix: "ch-web-routes-",
    register: (router, db, adb) => {
      registerProjectRoutes(router, adb);
      registerChatRoutes(router, adb);
      registerAutoCheckRoutes(router, adb);
    },
  });
  // v12: multi-user — register a user + create an auth session so the routes'
  // requireUserContext gate resolves a caller. The auth cookie is sent with
  // every request below.
  const authCookie = createTestUser(srv.db, "routes-tester").cookie;
  req = makeJsonRequest(() => srv.baseUrl, () => authCookie);
});

afterAll(async () => {
  if (srv) await srv.stop();
});

describe("routes: projects + chats + auto-checks", () => {
  test("POST /api/projects creates a project (201)", async () => {
    const r = await req("/api/projects", { method: "POST", body: { name: "alpha", path: "/a" } });
    expect(r.status).toBe(201);
    expect((r.body as { id: string }).id).toMatch(/-/);
    expect((r.body as { name: string }).name).toBe("alpha");
    expect((r.body as { updatedAt: string }).updatedAt).toBeDefined();
  });

  test("GET /api/projects returns the list", async () => {
    const r = await req("/api/projects");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect((r.body as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  test("GET /api/projects serves the list in REAL-ACTIVITY order (the river's display order)", async () => {
    // The switch-river CLS finding, pinned at the route: the wire order IS
    // the order the river displays — an old-created project whose
    // conversation just moved leads the list, with `updatedAt` carrying the
    // activity instant. The db-client arm pins the measure's SQL; this arm
    // pins that the route + view forward it.
    const older = await req("/api/projects", {
      method: "POST",
      body: { name: "cls-older", path: "/cls/older" },
    });
    await new Promise((res) => setTimeout(res, 3));
    const newer = await req("/api/projects", {
      method: "POST",
      body: { name: "cls-newer", path: "/cls/newer" },
    });
    const olderId = (older.body as { id: string }).id;
    const newerId = (newer.body as { id: string }).id;
    // Real work in the OLDER project: its conversation becomes the newest
    // activity anywhere.
    const chat = await req(`/api/projects/${olderId}/chats`, {
      method: "POST",
      body: { title: "recent work" },
    });
    const chatId = (chat.body as { id: string }).id;
    await req(`/api/chats/${chatId}/messages`, {
      method: "POST",
      body: { role: "user", content: "hello" },
    });

    const list = await req("/api/projects");
    expect(list.status).toBe(200);
    const rows = (list.body as ReadonlyArray<{ id: string; updatedAt: string }>)
      .filter((p) => p.id === olderId || p.id === newerId);
    expect(rows.map((p) => p.id)).toEqual([olderId, newerId]);
    expect(rows[0]!.updatedAt > rows[1]!.updatedAt).toBe(true);
  });

  test("GET /api/projects/:id returns 404 for unknown id", async () => {
    const r = await req("/api/projects/nope");
    expect(r.status).toBe(404);
    expect((r.body as { error: string }).error).toBe("not_found");
  });

  test("DELETE /api/projects/:id removes the project and cascades", async () => {
    // Create a project with a chat + message to verify cascade.
    const p = await req("/api/projects", { method: "POST", body: { name: "del", path: "/del" } });
    const pid = (p.body as { id: string }).id;
    const c = await req(`/api/projects/${pid}/chats`, { method: "POST", body: { title: "del-chat" } });
    expect(c.status).toBe(201);
    const cid = (c.body as { id: string }).id;
    await req(`/api/chats/${cid}/messages`, { method: "POST", body: { role: "user", content: "x" } });

    // Delete the project
    const del = await req(`/api/projects/${pid}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((del.body as { deleted: boolean; id: string }).deleted).toBe(true);

    // Project is gone
    const after = await req(`/api/projects/${pid}`);
    expect(after.status).toBe(404);

    // Chat is gone (cascade)
    const chatAfter = await req(`/api/chats/${cid}/messages`);
    expect(chatAfter.status).toBe(404);

    // Deleting again → 404
    const again = await req(`/api/projects/${pid}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  test("project → many chats: nested + flat + query forms", async () => {
    // Create a project
    const p = await req("/api/projects", { method: "POST", body: { name: "p1", path: "/p1" } });
    const pid = (p.body as { id: string }).id;

    // Nested form: POST /api/projects/:id/chats
    const c1 = await req(`/api/projects/${pid}/chats`, { method: "POST", body: { title: "c1" } });
    expect(c1.status).toBe(201);
    expect((c1.body as { title: string }).title).toBe("c1");

    // Flat form: POST /api/chats with projectId in body
    const c2 = await req("/api/chats", { method: "POST", body: { projectId: pid, title: "c2" } });
    expect(c2.status).toBe(201);
    expect((c2.body as { projectId: string }).projectId).toBe(pid);

    // Nested form: GET /api/projects/:id/chats
    const nestedList = await req(`/api/projects/${pid}/chats`);
    expect(nestedList.status).toBe(200);
    expect((nestedList.body as unknown[]).length).toBe(2);

    // Flat form: GET /api/chats?projectId=X
    const flatList = await req(`/api/chats?projectId=${pid}`);
    expect(flatList.status).toBe(200);
    expect((flatList.body as unknown[]).length).toBe(2);

    // GET /api/chats without projectId → 400
    const badList = await req("/api/chats");
    expect(badList.status).toBe(400);
  });

  test("POST /api/projects/:id/chats returns 404 for unknown project", async () => {
    const r = await req("/api/projects/nope/chats", { method: "POST", body: { title: "x" } });
    expect(r.status).toBe(404);
  });

  test("messages: append + list + history round-trip", async () => {
    const p = await req("/api/projects", { method: "POST", body: { name: "msgs", path: "/m" } });
    const pid = (p.body as { id: string }).id;
    const c = await req(`/api/projects/${pid}/chats`, { method: "POST", body: { title: "msgs-chat" } });
    const cid = (c.body as { id: string }).id;

    // Append a user message
    const m1 = await req(`/api/chats/${cid}/messages`, {
      method: "POST",
      body: { role: "user", content: "hello" },
    });
    expect(m1.status).toBe(201);
    expect((m1.body as { role: string }).role).toBe("user");

    // Append an assistant message
    await req(`/api/chats/${cid}/messages`, {
      method: "POST",
      body: { role: "assistant", content: "hi back" },
    });

    // List messages
    const list = await req(`/api/chats/${cid}/messages`);
    expect(list.status).toBe(200);
    expect((list.body as unknown[]).length).toBe(2);

    // History (composite)
    const history = await req(`/api/chats/${cid}/history`);
    expect(history.status).toBe(200);
    const hist = history.body as { chat: { id: string }; messages: unknown[]; toolCalls: unknown[] };
    expect(hist.chat.id).toBe(cid);
    expect(hist.messages.length).toBe(2);
    expect(hist.toolCalls.length).toBe(0);
  });

  test("timeline refs: append + list", async () => {
    const p = await req("/api/projects", { method: "POST", body: { name: "tl", path: "/tl" } });
    const pid = (p.body as { id: string }).id;
    const c = await req(`/api/projects/${pid}/chats`, { method: "POST", body: { title: "tl-chat" } });
    const cid = (c.body as { id: string }).id;

    const ref = await req(`/api/chats/${cid}/timeline`, {
      method: "POST",
      body: { eventId: "evt-1", eventType: "tool", timestamp: new Date().toISOString(), metadata: { runId: "r1" } },
    });
    expect(ref.status).toBe(201);
    expect((ref.body as { eventId: string }).eventId).toBe("evt-1");

    const list = await req(`/api/chats/${cid}/timeline`);
    expect(list.status).toBe(200);
    expect((list.body as unknown[]).length).toBe(1);
  });

  test("metrics snapshots: append + list", async () => {
    const p = await req("/api/projects", { method: "POST", body: { name: "m", path: "/m" } });
    const pid = (p.body as { id: string }).id;
    const c = await req(`/api/projects/${pid}/chats`, { method: "POST", body: { title: "m-chat" } });
    const cid = (c.body as { id: string }).id;

    const snap = await req(`/api/chats/${cid}/metrics`, {
      method: "POST",
      body: { snapshot: { totalCalls: 42 } },
    });
    expect(snap.status).toBe(201);
    expect((snap.body as { snapshot: { totalCalls: number } }).snapshot.totalCalls).toBe(42);

    const list = await req(`/api/chats/${cid}/metrics`);
    expect(list.status).toBe(200);
    expect((list.body as unknown[]).length).toBe(1);
  });

  /**
   * The trimming route is gone. It used to DELETE the messages after the
   * anchor, which made the deletion the only thing that could be undone — the
   * content was already unrecoverable. Withdrawal replaced it: the rows stay
   * and the fold at read time decides what the model receives.
   *
   * Asserting the 404 alone would pass just as well if the route had been
   * renamed to something that still deletes, so the second half is the one
   * that matters: the messages must still be there afterwards.
   */
  test("the trimming rollback route is gone, and nothing it would have destroyed is", async () => {
    const p = await req("/api/projects", { method: "POST", body: { name: "rb", path: "/rb" } });
    const pid = (p.body as { id: string }).id;
    const c = await req(`/api/projects/${pid}/chats`, { method: "POST", body: { title: "rb-chat" } });
    const cid = (c.body as { id: string }).id;

    const m1 = await req(`/api/chats/${cid}/messages`, { method: "POST", body: { role: "user", content: "first" } });
    await req(`/api/chats/${cid}/messages`, { method: "POST", body: { role: "assistant", content: "second" } });
    await req(`/api/chats/${cid}/messages`, { method: "POST", body: { role: "user", content: "third" } });

    const anchorId = (m1.body as { id: string }).id;
    const rb = await req(`/api/chats/${cid}/rollback`, { method: "POST", body: { toMessageId: anchorId } });
    expect(rb.status).toBe(404);

    const list = await req(`/api/chats/${cid}/messages`);
    expect((list.body as unknown[]).length).toBe(3);
  });

  test("auto-checks: project + chat scoped", async () => {
    const p = await req("/api/projects", { method: "POST", body: { name: "ac", path: "/ac" } });
    const pid = (p.body as { id: string }).id;
    const c = await req(`/api/projects/${pid}/chats`, { method: "POST", body: { title: "ac-chat" } });
    const cid = (c.body as { id: string }).id;

    // Project-scoped check
    const pc = await req(`/api/projects/${pid}/auto-checks`, {
      method: "POST",
      body: { checkName: "lint", status: "passed", output: { errors: 0 } },
    });
    expect(pc.status).toBe(201);
    expect((pc.body as { projectId: string }).projectId).toBe(pid);
    expect((pc.body as { chatId: string | null }).chatId).toBeNull();

    // Chat-scoped check
    const cc = await req(`/api/projects/${pid}/auto-checks`, {
      method: "POST",
      body: { checkName: "typecheck", status: "running", output: {}, chatId: cid },
    });
    expect(cc.status).toBe(201);
    expect((cc.body as { chatId: string | null }).chatId).toBe(cid);

    // List project checks (project-level ONLY — chat_id IS NULL). The
    // chat-scoped "typecheck" does NOT leak into the project list.
    const plist = await req(`/api/projects/${pid}/auto-checks`);
    expect(plist.status).toBe(200);
    expect((plist.body as unknown[]).length).toBe(1);
    expect(((plist.body as Array<{ checkName: string }>)[0]!).checkName).toBe("lint");

    // List chat checks (chat-level ONLY — the chat-scoped one).
    const clist = await req(`/api/chats/${cid}/auto-checks`);
    expect(clist.status).toBe(200);
    expect((clist.body as unknown[]).length).toBe(1);
    expect(((clist.body as Array<{ checkName: string }>)[0]!).checkName).toBe("typecheck");

    // Dedup: re-running the same project-level check replaces, not
    // duplicates. Use a NON-runnable check name ("build") so the caller-
    // supplied status is honored (runnable checks like lint re-run the real
    // check and return its outcome, not the request status).
    const pc2 = await req(`/api/projects/${pid}/auto-checks`, {
      method: "POST",
      body: { checkName: "build", status: "failed", output: { errors: 2 } },
    });
    expect(pc2.status).toBe(201);
    const plist2 = await req(`/api/projects/${pid}/auto-checks`);
    expect((plist2.body as unknown[]).length).toBe(2); // lint + build (not 3)
    const build = (plist2.body as Array<{ checkName: string; status: string }>).find((c) => c.checkName === "build");
    expect(build?.status).toBe("failed"); // caller status honored (non-runnable)
    // Re-running "build" again replaces, not duplicates.
    await req(`/api/projects/${pid}/auto-checks`, {
      method: "POST",
      body: { checkName: "build", status: "passed", output: {} },
    });
    const plist3 = await req(`/api/projects/${pid}/auto-checks`);
    expect((plist3.body as unknown[]).length).toBe(2); // still 2, not 3
  });

  test("auto-checks default status is 'running' when omitted", async () => {
    const p = await req("/api/projects", { method: "POST", body: { name: "ac2", path: "/ac2" } });
    const pid = (p.body as { id: string }).id;
    const r = await req(`/api/projects/${pid}/auto-checks`, {
      method: "POST",
      body: { checkName: "build" },
    });
    expect(r.status).toBe(201);
    expect((r.body as { status: string }).status).toBe("running");
  });

  test("invalid input returns 400 (Zod parse throws with invalid_ code)", async () => {
    // Empty name should fail Zod validation → 400 from the router's
    // statusForError mapping for `invalid_*` codes.
    const r = await req("/api/projects", { method: "POST", body: { name: "", path: "/x" } });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("invalid_project_input");
  });
});
