/**
 * The shared harness for the split rewind suites.
 *
 * The original 1,502-line file accumulated one database, one server, one
 * rewind fold and one memory store across 44 tests. Four files, each with a
 * fresh harness, keep the population exact while resetting that state. The
 * provider measurement point and every request helper live here once.
 */
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { expect } from "vitest";

import { createTempDir } from "./temp-dir.ts";
import { createTestUser } from "./multi-user.ts";
import { rewindProvider, type RewindProvider } from "./rewind-provider-state.ts";
import { createRouter } from "../../server/router/router.ts";
import { isPublicPath } from "../../server/routes/registry.ts";
import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { registerChatRoutes } from "../../server/routes/chats.ts";
import { registerProjectRoutes } from "../../server/routes/projects.ts";
import { registerRunRoutes } from "../../server/routes/run.ts";
import { registerRunStreamRoutes } from "../../server/routes/run-stream.ts";
import { clearBlocks, mountBlockRoutes } from "../../server/blocks/define.ts";
import { defineComposeBlocks } from "../../server/blocks/compose.ts";

export const NUL = "\u0000";
const SESSION_COOKIE = "harness_session=test-rewind-session";

type Json = Record<string, unknown>;
type Conversation = { projectId: string; chatId: string };

export type RewindHarness = {
  readonly provider: RewindProvider;
  start(): Promise<{ db: DbClient; ownerUserId: string; authCookie: string }>;
  stop(): Promise<void>;
  api(method: "GET" | "POST", path: string, body?: unknown, cookie?: string): Promise<{ status: number; body: unknown }>;
  drainRunStream(runId: string, timeoutMs?: number): Promise<string>;
  newConversation(name: string): Promise<Conversation>;
  sendTurn(ids: Conversation, prompt: string, reply: string): Promise<Array<{ role: string; content: string }>>;
  storedMessages(chatId: string): Promise<Array<{ id: string; role: string; content: string; discarded?: boolean }>>;
  rewind(chatId: string, toMessageId: string, mode: "at" | "causing-prompt", cookie?: string): Promise<{ status: number; data: Json }>;
  pairs(req: Array<{ role: string; content: string }>): string[];
  systemOf(req: Array<{ role: string; content: string }>): string;
  withdrawn(chatId: string, cookie?: string): Promise<{ status: number; stretches: Array<{ eventId: string; messageIds: string[]; restored: boolean; anchorMessageId: string }> }>;
  restore(chatId: string, eventId: string, cookie?: string): Promise<{ status: number; body: unknown }>;
};

export function createRewindHarness(provider: RewindProvider = rewindProvider): RewindHarness {
  let tmpRoot = "";
  let server: Server | undefined;
  let baseUrl = "";
  let db: DbClient | undefined;
  let authCookie = "";
  let ownerUserId = "";

  const requireDb = (): DbClient => {
    if (db === undefined) throw new Error("rewind harness has not started");
    return db;
  };

  async function api(method: "GET" | "POST", path: string, body?: unknown, cookie = authCookie): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: `${cookie}; ${SESSION_COOKIE}`,
        "X-Requested-With": "test",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined };
  }

  async function drainRunStream(runId: string, timeoutMs = 10_000): Promise<string> {
    const res = await fetch(`${baseUrl}/api/run/${runId}/stream`, { headers: { Cookie: `${authCookie}; ${SESSION_COOKIE}` } });
    if (!res.ok || res.body === null) {
      const detail = res.body === null ? "<no body>" : (await res.text()).slice(0, 400);
      throw new Error(`stream failed: ${res.status} url=/api/run/${runId}/stream body=${detail}`);
    }
    const reader = res.body.getReader();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, timeoutMs);
    let buffer = "";
    try {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("event: done")) {
          void reader.cancel().catch(() => undefined);
          break;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) throw new Error(`run ${runId} stream timed out after ${timeoutMs}ms; received ${buffer}`);
    return buffer;
  }

  async function newConversation(name: string): Promise<Conversation> {
    const project = await api("POST", "/api/projects", { name, path: `/${name}` });
    const projectId = (project.body as { id: string }).id;
    const chat = await api("POST", "/api/chats", { projectId, title: name });
    const chatId = (chat.body as { id: string }).id;
    return { projectId, chatId };
  }

  async function sendTurn(ids: Conversation, prompt: string, reply: string): Promise<Array<{ role: string; content: string }>> {
    provider.reply = reply;
    const before = provider.requests.length;
    const start = await api("POST", "/api/run/start", { projectId: ids.projectId, prompt, chatId: ids.chatId });
    if (start.status !== 201) throw new Error(`run start returned ${start.status}: ${JSON.stringify(start.body)}`);
    const runId = (start.body as { runId: string }).runId;
    const frames = await drainRunStream(runId);
    if (provider.requests.length <= before) {
      throw new Error(`run ${runId} accepted for ${ids.chatId} without a provider request; stream: ${frames}`);
    }
    return [...provider.requests[provider.requests.length - 1]!];
  }

  async function storedMessages(chatId: string): Promise<Array<{ id: string; role: string; content: string; discarded?: boolean }>> {
    const res = await api("GET", `/api/chats/${chatId}/messages`);
    if (res.status !== 200) throw new Error(`stored messages returned ${res.status}`);
    return res.body as Array<{ id: string; role: string; content: string; discarded?: boolean }>;
  }

  async function rewind(chatId: string, toMessageId: string, mode: "at" | "causing-prompt", cookie = authCookie): Promise<{ status: number; data: Json }> {
    const res = await api("POST", "/api/b/run.compose/rewind", { chatId, toMessageId, mode }, cookie);
    const data = (res.body as { data?: Json } | undefined)?.data ?? {};
    return { status: res.status, data };
  }

  const pairs = (req: Array<{ role: string; content: string }>): string[] =>
    req.filter((m) => m.role !== "system").map((m) => `${m.role}: ${m.content}`);

  function systemOf(req: Array<{ role: string; content: string }>): string {
    const systems = req.filter((m) => m.role === "system");
    expect(systems).toHaveLength(1);
    return systems[0]!.content;
  }

  async function withdrawn(chatId: string, cookie = authCookie): Promise<{ status: number; stretches: Array<{ eventId: string; messageIds: string[]; restored: boolean; anchorMessageId: string }> }> {
    const res = await api("GET", `/api/b/run.withdrawn?chatId=${encodeURIComponent(chatId)}`, undefined, cookie);
    const data = (res.body as { data?: { stretches?: unknown } } | undefined)?.data;
    return { status: res.status, stretches: (data?.stretches ?? []) as never };
  }

  async function restore(chatId: string, eventId: string, cookie = authCookie): Promise<{ status: number; body: unknown }> {
    return await api("POST", "/api/b/run.compose/restore", { chatId, eventId }, cookie);
  }

  return {
    provider,
    async start() {
      tmpRoot = createTempDir("ch-rewind-");
      db = new DbClient({ path: join(tmpRoot, "rewind.db") });
      const user = createTestUser(db, "rewind-tester");
      authCookie = user.cookie;
      ownerUserId = user.userId;
      const adb = AsyncDbClient.inline(db);
      const router = createRouter({ db: adb, isPublicPath });
      registerProjectRoutes(router, adb);
      registerChatRoutes(router, adb);
      registerRunRoutes(router, adb);
      registerRunStreamRoutes(router, adb);
      clearBlocks();
      defineComposeBlocks(adb);
      mountBlockRoutes(router);
      server = createServer((req, res) => router.dispatch(req, res));
      await new Promise<void>((resolve) => {
        server!.listen(0, "127.0.0.1", () => {
          const address = server!.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;
          baseUrl = `http://127.0.0.1:${port}`;
          resolve();
        });
      });
      return { db: requireDb(), ownerUserId, authCookie };
    },
    async stop() {
      if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
      if (db !== undefined) db.close();
      server = undefined;
      db = undefined;
    },
    api,
    drainRunStream,
    newConversation,
    sendTurn,
    storedMessages,
    rewind,
    pairs,
    systemOf,
    withdrawn,
    restore,
  };
}
