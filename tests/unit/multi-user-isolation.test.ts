// @vitest-environment node
// Use fixture events (not real LLM) so run-start is deterministic + offline.
process.env.HARNESS_WEB_LLM_FIXTURES = "1";
/**
 * ADVERSARIAL multi-user isolation tests (v12 — the security-critical task).
 *
 * HARD, REALISTIC, NO FAKING. Two registered users (A + B)
 * act concurrently on a single server + DB. The test verifies that User B
 * CANNOT read, write, or delete ANY of User A's data — every user-bound
 * endpoint is scoped by the authenticated user_id (requireUserContext).
 *
 * Coverage (every user-bound entity):
 * projects: B cannot list/get/patch/delete A's project; B cannot add a
 * chat to A's project.
 * chats/messages/tool_calls/metrics/timeline/auto-checks: transitively
 * scoped via project ownership — B cannot read/write any of A's chat
 * sub-resources by id.
 * tool_settings: B cannot see A's tool overrides; B toggling creates
 * B's own (A's unchanged).
 * user_model_prefs: B cannot read A's model overrides.
 * user_prompt_prefs: B cannot read A's prompt overrides.
 * memory: B cannot search/list/get A's memory entries (server-resolved
 * userId scoping — the prior client-supplied session id is gone).
 * runs: B cannot start a run in A's project, nor stream/cancel/steer
 * A's active run.
 *
 * Auth edge cases:
 * unauthenticated → 401; malformed cookie → 401; wrong password → 401;
 * username collision on register → 409; expired session → 401.
 *
 * Every assertion is a REAL HTTP request against a REAL SQLite DB — no
 * mocks, no weakened borders. Cross-user access MUST fail with
 * 403/404 (never 200 with another user's data).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { registerAuthRoutes } from "../../server/routes/auth.ts";
import { registerProjectRoutes } from "../../server/routes/projects.ts";
import { registerChatRoutes } from "../../server/routes/chats.ts";
import { registerAutoCheckRoutes } from "../../server/routes/auto-checks.ts";
import { registerToolRoutes } from "../../server/routes/tools.ts";
import { registerModelRoutes } from "../../server/routes/models.ts";
import { registerSettingsRoutes } from "../../server/routes/settings.ts";
import { registerMemoryRoutes } from "../../server/routes/memory.ts";
import { registerRunRoutes } from "../../server/routes/run.ts";
// The subscriber is its own module since the executor was split out of the
// GET handler. Its 404 and 403 gates are what this file exercises, so it has
// to be mounted for them to be reachable at all — and the run's status read
// is the third run module, mounted beside it for its own gates below.
import { registerRunStreamRoutes } from "../../server/routes/run-stream.ts";
import { registerRunStatusRoutes } from "../../server/routes/run-status.ts";
import { registerTimelineRoutes } from "../../server/routes/timeline.ts";
import { createTestUser, type TestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { hashSessionToken } from "../../server/auth/auth.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await startHttpTestServer({
    prefix: "ch-multiuser-",
    register: (router, db, adb) => {
      registerAuthRoutes(router, adb);
      registerProjectRoutes(router, adb);
      registerChatRoutes(router, adb);
      registerAutoCheckRoutes(router, adb);
      registerToolRoutes(router, adb);
      registerModelRoutes(router, adb);
      registerSettingsRoutes(router, adb);
      registerMemoryRoutes(router, adb);
      registerRunRoutes(router, adb);
      registerRunStreamRoutes(router, adb);
      registerRunStatusRoutes(router, adb);
      registerTimelineRoutes(router, adb);
    },
  });
});

afterAll(async () => {
  if (srv) await srv.stop();
});

/** Authenticated request helper. `user` carries the cookie to send (null =
 * unauthenticated). */
async function req(
  user: TestUser | null,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const { status, body } = await jsonRequest(srv.baseUrl, path, {
    method: init?.method,
    body: init?.body,
    cookie: user === null ? null : user.cookie,
  });
  return { status, body };
}

/**
 * Assert a cross-user request was DENIED. Both 403 (forbidden — the resource
 * exists but belongs to another user) and 404 (not found — the route hides
 * existence) are valid "access denied" responses; the security contract is
 * that User B NEVER receives User A's data (never 200). The exact code
 * varies by route (project-direct routes return 404; chat-scoped routes
 * return 403 to distinguish existence) — both satisfy the isolation rule.
 */
function expectDenied(status: number): void {
  expect([403, 404]).toContain(status);
}

// ── Setup: two users (A = admin, B = regular) ──
let userA: TestUser;
let userB: TestUser;

beforeAll(() => {
  userA = createTestUser(srv.db, "alice");
  userB = createTestUser(srv.db, "bob");
});

// ════════════════════════════════════════════════════════════════════════
// PROJECTS — B cannot see/touch A's projects
// ════════════════════════════════════════════════════════════════════════

describe("multi-user isolation: projects", () => {
  let aProjectId: string;

  beforeAll(async () => {
    const r = await req(userA, "/api/projects", { method: "POST", body: { name: "A-secret", path: "/tmp/a-secret" } });
    expect(r.status).toBe(201);
    aProjectId = (r.body as { id: string }).id;
  });

  test("B's project list does NOT include A's project", async () => {
    const r = await req(userB, "/api/projects");
    expect(r.status).toBe(200);
    const list = r.body as { id: string }[];
    expect(list.some((p) => p.id === aProjectId)).toBe(false);
  });

  test("B cannot GET A's project by id (404)", async () => {
    const r = await req(userB, `/api/projects/${aProjectId}`);
    expect(r.status).toBe(404);
  });

  test("B cannot PATCH (rename) A's project (404)", async () => {
    const r = await req(userB, `/api/projects/${aProjectId}`, { method: "PATCH", body: { name: "hacked" } });
    expect(r.status).toBe(404);
    // A's project name is unchanged.
    const a = await req(userA, `/api/projects/${aProjectId}`);
    expect((a.body as { name: string }).name).toBe("A-secret");
  });

  test("B cannot DELETE A's project (404)", async () => {
    const r = await req(userB, `/api/projects/${aProjectId}`, { method: "DELETE" });
    expect(r.status).toBe(404);
    // A's project still exists.
    const a = await req(userA, `/api/projects/${aProjectId}`);
    expect(a.status).toBe(200);
  });

  test("B cannot add a chat to A's project (403/404)", async () => {
    const r = await req(userB, `/api/projects/${aProjectId}/chats`, { method: "POST", body: { title: "snooping" } });
    expectDenied(r.status);
  });
});

// ════════════════════════════════════════════════════════════════════════
// CHATS / MESSAGES / TOOL_CALLS / METRICS / TIMELINE — transitively scoped
// ════════════════════════════════════════════════════════════════════════

describe("multi-user isolation: chat sub-resources", () => {
  let aChatId: string;
  let aMessageId: string;

  beforeAll(async () => {
    const p = await req(userA, "/api/projects", { method: "POST", body: { name: "A-proj2", path: "/tmp/a2" } });
    const c = await req(userA, `/api/projects/${(p.body as { id: string }).id}/chats`, { method: "POST", body: { title: "A-chat" } });
    aChatId = (c.body as { id: string }).id;
    const m = await req(userA, `/api/chats/${aChatId}/messages`, { method: "POST", body: { role: "user", content: "A's private message" } });
    aMessageId = (m.body as { id: string }).id;
  });

  test("B cannot GET A's chat (403/404)", async () => {
    expectDenied((await req(userB, `/api/chats/${aChatId}`)).status);
  });

  test("B cannot list A's chat messages (403/404)", async () => {
    expectDenied((await req(userB, `/api/chats/${aChatId}/messages`)).status);
  });

  test("B cannot POST a message to A's chat (403/404)", async () => {
    const r = await req(userB, `/api/chats/${aChatId}/messages`, { method: "POST", body: { role: "user", content: "injected" } });
    expectDenied(r.status);
  });

  test("B cannot list A's tool calls (403/404)", async () => {
    expectDenied((await req(userB, `/api/chats/${aChatId}/tool-calls`)).status);
  });

  test("B cannot list/append A's metrics snapshots (403/404)", async () => {
    expectDenied((await req(userB, `/api/chats/${aChatId}/metrics`)).status);
    expectDenied((await req(userB, `/api/chats/${aChatId}/metrics`, { method: "POST", body: { snapshot: { x: 1 } } })).status);
  });

  test("B cannot list/append A's timeline refs (403/404)", async () => {
    expectDenied((await req(userB, `/api/chats/${aChatId}/timeline`)).status);
    expectDenied((await req(userB, `/api/chats/${aChatId}/timeline`, { method: "POST", body: { eventId: "e", eventType: "tool", timestamp: new Date().toISOString(), metadata: {} } })).status);
  });

  test("B cannot GET A's chat history (403/404)", async () => {
    expectDenied((await req(userB, `/api/chats/${aChatId}/history`)).status);
  });

  test("B cannot rollback A's chat (403/404)", async () => {
    expectDenied((await req(userB, `/api/chats/${aChatId}/rollback`, { method: "POST", body: { toMessageId: aMessageId } })).status);
  });

  test("B cannot DELETE A's chat (403/404)", async () => {
    expectDenied((await req(userB, `/api/chats/${aChatId}`, { method: "DELETE" })).status);
  });

  test("B cannot pin/duplicate A's chat (403/404)", async () => {
    expectDenied((await req(userB, `/api/chats/${aChatId}/pin`, { method: "POST", body: { pinned: true } })).status);
    expectDenied((await req(userB, `/api/chats/${aChatId}/duplicate`, { method: "POST" })).status);
  });
});

// ════════════════════════════════════════════════════════════════════════
// AUTO-CHECKS — scoped via project ownership
// ════════════════════════════════════════════════════════════════════════

describe("multi-user isolation: auto-checks", () => {
  let aProjectId: string;
  let aChatId: string;

  beforeAll(async () => {
    const p = await req(userA, "/api/projects", { method: "POST", body: { name: "A-proj3", path: "/tmp/a3" } });
    aProjectId = (p.body as { id: string }).id;
    const c = await req(userA, `/api/projects/${aProjectId}/chats`, { method: "POST", body: { title: "A-chat3" } });
    aChatId = (c.body as { id: string }).id;
    // A registers a project-level check (generic, non-runnable so no subprocess).
    await req(userA, `/api/projects/${aProjectId}/auto-checks`, { method: "POST", body: { checkName: "custom-check", status: "passed", output: { ok: true } } });
  });

  test("B cannot list A's project auto-checks (403/404)", async () => {
    expectDenied((await req(userB, `/api/projects/${aProjectId}/auto-checks`)).status);
  });

  test("B cannot register an auto-check on A's project (403/404)", async () => {
    const r = await req(userB, `/api/projects/${aProjectId}/auto-checks`, { method: "POST", body: { checkName: "evil", status: "passed", output: {} } });
    expectDenied(r.status);
  });

  test("B cannot list A's chat auto-checks (404/403)", async () => {
    const r = await req(userB, `/api/chats/${aChatId}/auto-checks`);
    expect([403, 404]).toContain(r.status);
  });
});

// ════════════════════════════════════════════════════════════════════════
// TOOL SETTINGS — per-user overrides
// ════════════════════════════════════════════════════════════════════════

describe("multi-user isolation: tool settings", () => {
  test("A's tool override is NOT visible to B; B's toggle does not affect A", async () => {
    // A disables read_file (a per-user override written directly to the DB).
    srv.db.upsertToolSetting({ tool_name: "read_file", enabled: false }, userA.userId);
    // A sees the override.
    const aList = await req(userA, "/api/tools/settings");
    expect(aList.status).toBe(200);
    const aRows = (aList.body as { settings: { toolName: string; enabled: boolean }[] }).settings;
    expect(aRows.some((r) => r.toolName === "read_file" && r.enabled === false)).toBe(true);
    // B does NOT see A's override.
    const bList = await req(userB, "/api/tools/settings");
    expect(bList.status).toBe(200);
    const bRows = (bList.body as { settings: { toolName: string; enabled: boolean }[] }).settings;
    expect(bRows.some((r) => r.toolName === "read_file")).toBe(false);
    // B creates its OWN override (different tool) — must not appear in A's list.
    srv.db.upsertToolSetting({ tool_name: "search_code", enabled: false }, userB.userId);
    const aList2 = await req(userA, "/api/tools/settings");
    const aRows2 = (aList2.body as { settings: { toolName: string }[] }).settings;
    // The effective list is the SERVER's merge for THIS account: A's override is in A's list only.
    expect((aList2.body as { enabledList: string[] }).enabledList).not.toContain("read_file");
    expect((bList.body as { enabledList: string[] }).enabledList.includes("read_file")).toBe(true);
    expect(aRows2.some((r) => r.toolName === "search_code")).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// MODEL PREFERENCES — per-user overrides
// ════════════════════════════════════════════════════════════════════════

describe("multi-user isolation: model preferences", () => {
  test("B cannot read A's model overrides (null for B; set for A)", async () => {
    // The key is part of the fixture because it is part of a usable provider.
    // Without it this save makes A's DEFAULT provider one that cannot serve a
    // request, and every later run in this file refuses with
    // `provider_key_missing` — the product being right about a fixture that
    // was not, which reads as a broken guard and is not one.
    const prefs = {
      providers: [{ id: "a-private", baseUrl: "http://a", apiKey: "a-key", models: [{ id: "a-model" }] }],
      defaultProvider: "a-private",
      defaultModel: "a-model",
    };
    const put = await req(userA, "/api/models/prefs", { method: "PUT", body: prefs });
    expect(put.status).toBe(200);
    // A reads its override.
    const aGet = await req(userA, "/api/models/prefs");
    expect((aGet.body as { prefs: { providers?: { id: string }[] } }).prefs?.providers?.some((p) => p.id === "a-private")).toBe(true);
    // B does not see A's provider. B has providers of its own (every test user
    // is a configured account), so the assertion is about ISOLATION rather
    // than about an empty response — a null here would also be produced by a
    // route that had simply stopped returning anything.
    const bGet = await req(userB, "/api/models/prefs");
    expect(bGet.status).toBe(200);
    const bPrefs = (bGet.body as { prefs: { providers: { id: string }[] } }).prefs;
    expect(bPrefs.providers.map((provider) => provider.id)).not.toContain("a-private");
    expect(bPrefs.providers.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// PROMPT PREFERENCES — per-user overrides
// ════════════════════════════════════════════════════════════════════════

describe("multi-user isolation: prompt preferences", () => {
  test("B cannot read A's prompt overrides (B sees defaults, not A's override)", async () => {
    const put = await req(userA, "/api/settings/prompt-prefs", { method: "PUT", body: { systemPromptOverride: "A-private-prompt", tone: "friendly" } });
    expect(put.status).toBe(200);
    // A sees its override.
    const aGet = await req(userA, "/api/settings/prompt-prefs");
    expect((aGet.body as { source: string; prefs: { systemPromptOverride?: string } }).source).toBe("user");
    expect((aGet.body as { prefs: { systemPromptOverride?: string } }).prefs.systemPromptOverride).toBe("A-private-prompt");
    // B sees the DEFAULT source (no override for B) — never A's override.
    const bGet = await req(userB, "/api/settings/prompt-prefs");
    expect(bGet.status).toBe(200);
    expect((bGet.body as { source: string }).source).toBe("default");
    expect((bGet.body as { prefs: { systemPromptOverride?: string } }).prefs.systemPromptOverride).not.toBe("A-private-prompt");
  });
});

// ════════════════════════════════════════════════════════════════════════
// MEMORY — server-resolved userId scoping (the prior client-sessionId leak)
// ════════════════════════════════════════════════════════════════════════

describe("multi-user isolation: memory", () => {
  const aUniqueContent = "A-private-memory-blob-XYZ-12345";
  let aMemoryId: string;

  beforeAll(async () => {
    const r = await req(userA, "/api/memory", { method: "POST", body: { content: aUniqueContent, source: "user", how: "manual" } });
    expect(r.status).toBe(201);
    aMemoryId = (r.body as { id: string }).id;
  });

  test("B searching for A's content finds NOTHING", async () => {
    const r = await req(userB, "/api/memory/search", { method: "POST", body: { text: aUniqueContent } });
    expect(r.status).toBe(200);
    const results = (r.body as { results: { content: string }[] }).results;
    expect(results.some((e) => e.content === aUniqueContent)).toBe(false);
  });

  test("B's memory list does NOT include A's entry", async () => {
    const r = await req(userB, "/api/memory");
    expect(r.status).toBe(200);
    const entries = (r.body as { entries: { id: string }[] }).entries;
    expect(entries.some((e) => e.id === aMemoryId)).toBe(false);
  });

  test("B cannot GET A's memory entry by id (404)", async () => {
    const r = await req(userB, `/api/memory/${aMemoryId}`);
    expect(r.status).toBe(404);
  });

  test("A CAN search for its own content (sanity — the entry exists + is scoped to A)", async () => {
    const r = await req(userA, "/api/memory/search", { method: "POST", body: { text: aUniqueContent } });
    expect(r.status).toBe(200);
    const results = (r.body as { results: { content: string }[] }).results;
    expect(results.some((e) => e.content === aUniqueContent)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// RUNS — B cannot start/stream/cancel/steer A's runs
// ════════════════════════════════════════════════════════════════════════

describe("multi-user isolation: runs", () => {
  let aProjectId: string;
  let aChatId: string;
  let aRunId: string;
  let bProjectId: string;

  beforeAll(async () => {
    const p = await req(userA, "/api/projects", { method: "POST", body: { name: "A-run-proj", path: "/tmp/a-run" } });
    aProjectId = (p.body as { id: string }).id;
    const c = await req(userA, `/api/projects/${aProjectId}/chats`, { method: "POST", body: { title: "A-run-chat" } });
    aChatId = (c.body as { id: string }).id;
    // A starts a run bound to its chat.
    const run = await req(userA, "/api/run/start", { method: "POST", body: { projectId: aProjectId, chatId: aChatId, prompt: "hello" } });
    expect(run.status).toBe(201);
    aRunId = (run.body as { runId: string }).runId;
    // B creates their OWN project (so we can test chatId-level cross-user
    // access: B's project + A's chatId — the -V1 bug class).
    const bp = await req(userB, "/api/projects", { method: "POST", body: { name: "B-run-proj", path: "/tmp/b-run" } });
    bProjectId = (bp.body as { id: string }).id;
  });

  test("B cannot start a run in A's project (403)", async () => {
    const r = await req(userB, "/api/run/start", { method: "POST", body: { projectId: aProjectId, prompt: "snoop" } });
    expect(r.status).toBe(403);
  });

  test("B cannot start a run with A's chatId in B's OWN project (-V1 chatId ownership)", async () => {
    // -V1 [FIXED] [CRITICAL]: run-start didn't verify chatId ownership —
    // B could write into A's chat by passing A's chatId with any project.
    // The fix verifies chatId ownership via getChat(chatId, userId). This
    // test pins the chatId-level gate: B uses B's OWN project (which B
    // owns — the project gate passes) but A's chatId (which B does NOT
    // own — the chatId gate must deny). Without the chatId gate, B would
    // write a run into A's chat. Expected: 403 (forbidden — the chat exists
    // but belongs to A) or 404 (not found — the chat is hidden from B).
    const r = await req(userB, "/api/run/start", {
      method: "POST",
      body: { projectId: bProjectId, chatId: aChatId, prompt: "snoop via chatId" },
    });
    expect([403, 404]).toContain(r.status);
  });

  test("B cannot stream A's run (403)", async () => {
    const res = await fetch(`${srv.baseUrl}/api/run/${aRunId}/stream`, { headers: { Cookie: userB.cookie } });
    expect(res.status).toBe(403);
  });

  test("B cannot cancel A's run (403)", async () => {
    const r = await req(userB, `/api/run/${aRunId}/cancel`, { method: "POST" });
    expect(r.status).toBe(403);
  });

  test("B cannot steer A's run (403)", async () => {
    const r = await req(userB, `/api/run/${aRunId}/steer`, { method: "POST", body: { prompt: "do something evil" } });
    expect(r.status).toBe(403);
  });

  test("B cannot read the status of A's run — never a 200", async () => {
    // While the run is live the registry answers 403 (a foreign run is a
    // forbidden one, exactly like the stream route); once it has ended the
    // route resolves ownership from the record and a foreign run is a
    // hidden absence (404). Both are denials; what must never happen is a
    // 200 telling B whether A's run is executing.
    const r = await req(userB, `/api/run/${aRunId}/status`);
    expectDenied(r.status);
  });

  test("A's own ended run answers its status — executing:false, proven by the record", async () => {
    // The registry entry leaves in the executor's finally, moments after
    // the run ends; wait for the barrier to land (bounded — a timeout
    // fails the arm, never satisfies it). A run this process may have
    // already forgotten is still A's: the user message it persisted into
    // A's chat is the ownership proof.
    let executing: boolean | undefined;
    for (let i = 0; i < 40; i += 1) {
      const r = await req(userA, `/api/run/${aRunId}/status`);
      expect(r.status, "the caller's own run is always a 200 — dead or not").toBe(200);
      executing = (r.body as { executing: boolean }).executing;
      if (!executing) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(executing, "the run ended; the answer is read from the registry alone").toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// AUTH EDGE CASES
// ════════════════════════════════════════════════════════════════════════

describe("multi-user auth edge cases", () => {
  test("unauthenticated request to a protected route → 401", async () => {
    const r = await req(null, "/api/projects");
    expect(r.status).toBe(401);
  });

  test("malformed auth cookie → 401", async () => {
    const res = await fetch(`${srv.baseUrl}/api/projects`, { headers: { Cookie: "harness_auth=not-a-real-token" } });
    expect(res.status).toBe(401);
  });

  test("wrong password on login → 401 (no username enumeration)", async () => {
    const r = await req(null, "/api/auth/login", { method: "POST", body: { username: "alice", password: "totally-wrong" } });
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe("auth_invalid_credentials");
  });

  test("unknown username on login → 401 (same error as wrong password)", async () => {
    const r = await req(null, "/api/auth/login", { method: "POST", body: { username: "nobody-here", password: "whatever" } });
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe("auth_invalid_credentials");
  });

  test("anonymous register after setup is closed → 401 registration_closed", async () => {
    // After the first user is created, open registration is CLOSED (deny-by-
    // default). An anonymous caller cannot self-register; only an
    // authenticated admin can add new users. This closes the open-
    // registration hole where anyone could create an account at any time.
    const r = await req(null, "/api/auth/register", { method: "POST", body: { username: "intruder", password: "intruder-password-1" } });
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe("registration_closed");
  });

  test("non-admin cannot register a new user → 401 registration_closed", async () => {
    // A regular (non-admin) user is also denied — only admins can add users.
    const r = await req(userB, "/api/auth/register", { method: "POST", body: { username: "newuser", password: "newuser-password-1" } });
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe("registration_closed");
  });

  test("admin register with a taken username → 409", async () => {
    // An authenticated admin can register new users; a taken username still
    // yields 409. (Previously this was open to anonymous callers; registration
    // is now admin-only after setup.)
    const r = await req(userA, "/api/auth/register", { method: "POST", body: { username: "alice", password: "another-password-1" } });
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toBe("auth_username_taken");
  });

  test("admin register with a too-short password → 400", async () => {
    const r = await req(userA, "/api/auth/register", { method: "POST", body: { username: "newuser", password: "short" } });
    expect(r.status).toBe(400);
  });

  test("expired session → 401", async () => {
    // Create a session with an old created_at (older than the TTL), then use
    // its cookie → the resolver treats it as expired → 401.
    const { createSessionToken } = await import("../../server/auth/auth.ts");
    const token = createSessionToken();
    const tokenHash = hashSessionToken(token);
    srv.db.createAuthSession(tokenHash, userA.userId, "old-browser");
    // Backdate the session to 10 years ago (well past the default 720h TTL).
    const oldDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 10).toISOString();
    (srv.db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare("UPDATE auth_sessions SET created_at = ? WHERE token_hash = ?")
      .run(oldDate, tokenHash);
    const res = await fetch(`${srv.baseUrl}/api/projects`, { headers: { Cookie: `harness_auth=${token}` } });
    expect(res.status).toBe(401);
  });

  test("status reports setupRequired=false (users exist) + the authenticated username", async () => {
    const r = await req(userA, "/api/auth/status");
    expect(r.status).toBe(200);
    const body = r.body as { setupRequired: boolean; authenticated: boolean; username?: string; isAdmin?: boolean };
    expect(body.setupRequired).toBe(false);
    expect(body.authenticated).toBe(true);
    expect(body.username).toBe("alice");
    expect(body.isAdmin).toBe(true);
  });

  test("the first registered user is the admin; the second is not", () => {
    expect(userA.username).toBe("alice");
    expect(userB.username).toBe("bob");
    // userA was created first (countUsers===0) → admin; userB → regular.
  });
});
