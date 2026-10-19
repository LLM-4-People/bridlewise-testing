// @vitest-environment node
// Use fixture events (not real LLM) so the test is deterministic.
process.env.HARNESS_WEB_LLM_FIXTURES = "1";
/**
 * End-to-end test for the 748% context-trim bug fix (TASKS.md line 9-10).
 *
 * Reproduces the user's EXACT symptom: a chat with a huge prior history
 * (well over the token limit). Before the fix, the "context" SSE event
 * reported `contextTokens: 245022, contextTokenLimit: 32768,
 * contextTrimmed: false` — the raw unbounded history was sent to the LLM.
 *
 * After the fix, the unified context manager trims the history after
 * seeding (before the first turn), so the "context" event reports the
 * ACTUAL trimmed token count (within the limit) and `contextTrimmed: true`.
 */
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
// The subscriber is its own module since the executor was split out of the
// GET handler. Driving a run needs both halves mounted.
import { registerRunStreamRoutes } from "../../server/routes/run-stream.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

let tmpRoot = "";
let server: Server;
let baseUrl: string;
let db: DbClient;
let authCookie: string;
let userId: string;

beforeAll(async () => {
  tmpRoot = createTempDir("ch-ctx-trim-e2e-");
  const dbPath = join(tmpRoot, "ctx-trim.db");
  db = new DbClient({ path: dbPath });
  // v12: register a user so the routes' requireUserContext gate resolves.
  const testUser = createTestUser(db, "ctx-trim-tester");
  authCookie = testUser.cookie;
  userId = testUser.userId;

  const adb = AsyncDbClient.inline(db);
  const router = createRouter({ db: adb, isPublicPath });
  registerProjectRoutes(router, adb);
  registerChatRoutes(router, adb);
  registerRunRoutes(router, adb);
  registerRunStreamRoutes(router, adb);

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

const TEST_SESSION_COOKIE = "harness_session=test-ctx-trim-e2e-session";

async function postJson(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `${authCookie}; ${TEST_SESSION_COOKIE}`, "X-Requested-With": "test" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

/** Consume the SSE stream until the "context" event arrives, return its data. */
async function readContextEvent(url: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { Cookie: `${authCookie}; ${TEST_SESSION_COOKIE}` } });
  if (!res.ok || !res.body) throw new Error(`SSE connection failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const timer = setTimeout(() => { try { reader.cancel(); } catch { /* ok */ } }, timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let eventName = "";
        let dataLine = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) eventName = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLine = line.slice(6);
        }
        if (eventName === "context" && dataLine) {
          clearTimeout(timer);
          try { reader.cancel(); } catch { /* ok */ }
          return JSON.parse(dataLine) as Record<string, unknown>;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  throw new Error("no context event received before timeout");
}

describe("context SSE event — huge history is trimmed within the budget (748% fix)", () => {
  test("a chat with a 245K-token-scale history reports a trimmed history within the limit", async () => {
    // Seed a project + chat with a HUGE prior history: many user/assistant
    // pairs, each ~3K chars (~750 tokens). 40 pairs ≈ 60K tokens, well over
    // the default 32768 limit — reproducing the user's over-limit symptom.
    const p = await postJson("/api/projects", { name: "ctx-trim-proj", path: "/ctx-trim" });
    const pid = (p.body as { id: string }).id;
    const c = await postJson("/api/chats", { projectId: pid, title: "huge-history" });
    const chatId = (c.body as { id: string }).id;

    const big = "x".repeat(3000);
    const runId = "seed-run";
    for (let i = 0; i < 40; i++) {
      db.createMessage({ chat_id: chatId, role: "user", content: `user ${i} ${big}`, run_id: runId }, userId);
      const a = db.createMessage({ chat_id: chatId, role: "assistant", content: "", model_event_type: "start", run_id: runId }, userId);
      db.updateMessageContent(a.id, `assistant ${i} ${big}`, userId);
    }
    // Sanity: the raw history far exceeds the default 32768-token limit.
    // (40 pairs * 2 messages * ~750 tokens ≈ 60K tokens.)

    // Start a run bound to the chat with a short prompt.
    const start = await postJson("/api/run/start", { projectId: pid, chatId, prompt: "summarize" });
    expect(start.status).toBe(201);
    const runIdStarted = (start.body as { runId: string }).runId;

    // Open the SSE stream and read the "context" event (sent before the
    // first turn, after seeding + trim).
    const ctx = await readContextEvent(`${baseUrl}/api/run/${runIdStarted}/stream`);

    // THE FIX, ON THE FIELD THAT OWNS IT: the event's historyTokens is
    // the trimmed history channel alone — the portion the context
    // limit's trim budget actually governs — and it must be within the
    // limit with contextTrimmed true. (The old 748% bug reported the raw
    // 60K-token history with trimmed: false; when contextTokens later
    // became the trimmed-history estimate it carried this assertion; now
    // that contextTokens is the FULL per-call cost — system prompt +
    // history + tool schemas, the UIE-054 fix — the history bound lives
    // on historyTokens, served beside it for exactly this question.)
    const historyTokens = ctx.historyTokens as number;
    const contextTokenLimit = ctx.contextTokenLimit as number;
    const contextTrimmed = ctx.contextTrimmed as boolean;
    expect(contextTokenLimit).toBeGreaterThan(0);
    // Allow a small headroom for the always-in-context summary block.
    expect(historyTokens,
      `historyTokens (${historyTokens}) must be within the limit (~${contextTokenLimit}); before the fix this reported ~60000 (748%)`).toBeLessThanOrEqual(contextTokenLimit + 300);
    expect(contextTrimmed).toBe(true);
    // AND THE TOTAL IS BIGGER THAN ITS HISTORY ALONE — the request
    // carries channels the trim never governed (the system prompt, the
    // tool schemas), and a total that equaled the history would mean the
    // event had quietly gone back to counting one channel under a
    // whole-request name.
    const contextTokens = ctx.contextTokens as number;
    expect(contextTokens).toBeGreaterThan(historyTokens);
  }, 15000);
});

describe("context SSE event — the total counts every channel the request carries (UIE-054)", () => {
  // THE MEASURED DISHONESTY (drive 8, chat d7c0a29f): the event's
  // contextTokens was the HISTORY channel alone under a comment claiming
  // "the tokens ACTUALLY sent to the LLM" — on a fresh chat the gauge
  // read ~5.9k against the same call's ledger prompt=12,122 (the system
  // prompt and the tool schemas — a ~6.8k per-call constant — were
  // counted by no surface). The fixed contract: contextTokens is the
  // full per-call cost — the served system prompt + the history + the
  // schemas — and every channel is verifiable from data the event
  // ITSELF serves, so this arm needs no internals to pin it.
  test("a fresh chat's total includes the system prompt and the tool schemas, not the history alone", async () => {
    const { estimateTokens } = await import("../../engine/src/memory/unified/tokenizer.ts");
    const p = await postJson("/api/projects", { name: "ctx-channels-proj", path: "/ctx-channels" });
    const pid = (p.body as { id: string }).id;
    const c = await postJson("/api/chats", { projectId: pid, title: "fresh-chat" });
    const chatId = (c.body as { id: string }).id;

    const start = await postJson("/api/run/start", { projectId: pid, chatId, prompt: "hello there" });
    expect(start.status).toBe(201);
    const runId = (start.body as { runId: string }).runId;
    const ctx = await readContextEvent(`${baseUrl}/api/run/${runId}/stream`);

    const contextTokens = ctx.contextTokens as number;
    const historyTokens = (ctx.historyTokens as number | undefined) ?? 0;
    const systemTokens = estimateTokens(ctx.systemPrompt as string);
    const toolCount = ctx.toolCount as number;

    // LIVENESS: the event served real channels — a system prompt with
    // real body, tools actually offered.
    expect(systemTokens).toBeGreaterThan(0);
    expect(toolCount).toBeGreaterThan(0);

    // THE SYSTEM CHANNEL IS COUNTED: the total must reach at least the
    // system prompt plus the history. Under the history-only regression
    // this reds hard — a fresh chat's history is a handful of tokens
    // against a system prompt of thousands.
    expect(
      contextTokens,
      `contextTokens (${contextTokens}) must count the system prompt (${systemTokens}) + history (${historyTokens}), not the history alone`,
    ).toBeGreaterThanOrEqual(systemTokens + historyTokens);

    // THE SCHEMA CHANNEL IS COUNTED: with tools offered, the request
    // carries their OpenAI schemas beside the messages, so the total must
    // exceed the system + history sum by a positive remainder. A mutation
    // that drops the schema channel lands exactly on the sum.
    expect(
      contextTokens - systemTokens - historyTokens,
      "the schema remainder must be positive when tools are offered — the request carries their JSON schemas",
    ).toBeGreaterThan(0);

    await runToSettle(`${baseUrl}/api/run/${runId}/stream`, runId);
  }, 15000);
});

/** Consume the SSE stream to its end so the run settles and the suite
 * leaves no executor mid-flight (the context event alone is read before
 * the first turn, so the run is otherwise still starting). */
async function runToSettle(url: string, runId: string): Promise<void> {
  const { runFeedState } = await import("../../server/run/run-feed.ts");
  const res = await fetch(url, { headers: { Cookie: `${authCookie}; ${TEST_SESSION_COOKIE}` } });
  if (res.body !== null) {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // the stream ended; whatever arrived is what arrived
    }
  }
  const deadline = Date.now() + 8_000;
  while (runFeedState(runId)?.ended !== true && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("context SSE event — the limit is the ACTIVE MODEL's own window", () => {
  // The gauge denominates its fill from this event, and the model the run
  // speaks as can declare its own context window in Settings. A run that
  // kept the harness-wide limit while the model declared a smaller one
  // would send requests the provider refuses — the exact over-window
  // failure the trim exists to prevent — while the gauge claimed
  // headroom that was not there.

  test("a run whose model declares 8192 denominates the event by 8192", async () => {
    // The chat names no model, so the stored default answers — the same
    // resolution the credential takes. Give THAT model a window, far from
    // the harness-wide default, so the two answers cannot be confused.
    const windowed = 8_192;
    db.upsertUserModelPrefs(userId, {
      providers: [{
        id: "test-provider",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test-key-not-a-real-credential",
        models: [{ id: "gemma-4-31b", contextWindow: windowed }],
      }],
      defaultProvider: "test-provider",
      defaultModel: "gemma-4-31b",
    });
    // Restore the seeded bare shape afterwards so any later arm sees the
    // harness-wide limit it seeded.
    try {
      const p = await postJson("/api/projects", { name: "model-window-proj", path: "/model-window" });
      const pid = (p.body as { id: string }).id;
      const c = await postJson("/api/chats", { projectId: pid, title: "windowed-model" });
      const chatId = (c.body as { id: string }).id;

      const start = await postJson("/api/run/start", { projectId: pid, chatId, prompt: "hello" });
      expect(start.status).toBe(201);
      const runId = (start.body as { runId: string }).runId;

      const ctx = await readContextEvent(`${baseUrl}/api/run/${runId}/stream`);
      expect(ctx.contextTokenLimit,
        `the event must denominate by the model's declared window (${windowed}), not the harness-wide limit`,
      ).toBe(windowed);
      await runToSettle(`${baseUrl}/api/run/${runId}/stream`, runId);
    } finally {
      db.upsertUserModelPrefs(userId, {
        providers: [{
          id: "test-provider",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "test-key-not-a-real-credential",
          models: [{ id: "gemma-4-31b" }, { id: "qwen3.6-35b-fast" }],
        }],
        defaultProvider: "test-provider",
        defaultModel: "gemma-4-31b",
      });
    }
  }, 15000);
});
