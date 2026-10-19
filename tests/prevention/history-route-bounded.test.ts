// @vitest-environment node
/**
 * NO ROUTE RETURNS AN UNBOUNDED COLLECTION (DESIGN-PERFORMANCE §4), measured
 * over real HTTP against a real SQLite file — because the bound is a property
 * of the RESPONSE, and the response is where the route, the view mappers, the
 * redaction walk and `JSON.stringify` all finally meet.
 *
 * Five claims:
 *
 *   A. the tail response is bounded in ROWS and in BYTES, and §5's table asks
 *      for < 500KB for any single collection response;
 *   B. `?limit=` may NARROW the page and may never widen it — otherwise the
 *      unbounded read comes straight back through the query string;
 *   C. the older-page route refuses a request it cannot answer honestly (no
 *      cursor, a cursor this server did not issue) rather than substituting
 *      a page from somewhere else;
 *   D. the reader can walk the whole conversation over HTTP and receives it
 *      exactly, in order;
 *   E. the four other per-chat collections are bounded too, and each response
 *      SAYS the bound was applied — a bounded array that says nothing is the
 *      silent truncation the paging owner exists to make impossible.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { registerChatRoutes } from "../../server/routes/chats.ts";
import { registerProjectRoutes } from "../../server/routes/projects.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { serverConfig } from "../../server/kernel/config.ts";
import type { HistoryPageView, MessageView } from "../../shared/wire-types.ts";

/** §5's budget row: "any collection response < 500KB". */
const PAYLOAD_BUDGET_BYTES = 500_000;

/** Long enough to need several pages at the configured bound — three at the
 * byte budget below, which is what a WALK needs to be a walk. Kept no longer
 * than that: every message here is encrypted and written through the real
 * write path, and this file's seeding is its whole cost. */
const CONVERSATION_LENGTH = 300;
/** Big enough that the whole conversation would blow the payload budget many
 *  times over — the situation the cursor exists for, in miniature. */
const MESSAGE_CHARS = 3_500;

type Reply = Readonly<{ status: number; body: unknown; headers: Headers }>;

let srv: HttpTestServer;
let cookie: string;
let chatId: string;

async function get(path: string): Promise<Reply> {
  const res = await fetch(`${srv.baseUrl}${path}`, { headers: { cookie } });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

async function bytesOf(path: string): Promise<number> {
  const res = await fetch(`${srv.baseUrl}${path}`, { headers: { cookie } });
  return Buffer.byteLength(await res.text(), "utf8");
}

beforeAll(async () => {
  srv = await startHttpTestServer({
    prefix: "ch-web-history-bounded-",
    register: (router, db, adb) => {
      registerProjectRoutes(router, adb);
      registerChatRoutes(router, adb);
    },
  });
  const user = createTestUser(srv.db, "history-bounded");
  cookie = user.cookie;
  const project = srv.db.createProject({ name: "p", path: "/tmp/history-bounded" }, user.userId);
  const chat = srv.db.createChat({ project_id: project.id, title: "long one" }, user.userId);
  chatId = chat.id;
  for (let i = 0; i < CONVERSATION_LENGTH; i += 1) {
    srv.db.createMessage(
      {
        chat_id: chatId,
        role: i % 2 === 0 ? "user" : "assistant",
        // Deterministic filler, no secrets: the redaction walk runs over
        // every byte of this on the way out and must find nothing, which is
        // also what makes the payload measurement stable.
        content: `m${String(i).padStart(4, "0")} ${"lorem ipsum dolor sit amet ".repeat(Math.ceil(MESSAGE_CHARS / 27))}`.slice(0, MESSAGE_CHARS),
      },
      user.userId,
    );
  }
});

afterAll(async () => {
  if (srv) await srv.stop();
});

describe("A. the tail response is bounded", () => {
  test("opening the conversation returns a page, not the conversation", async () => {
    // MUTATION: point the route back at `db.getChatHistory` and this returns
    // all 300 messages — 1.05MB — which is the defect, in miniature.
    const r = await get(`/api/chats/${chatId}/history`);
    expect(r.status).toBe(200);
    const body = r.body as { messages: MessageView[]; page: HistoryPageView };
    // Fewer than the row bound, because at 3.5KB a message the BYTE budget
    // bites first — which is the point of having two bounds.
    expect(body.messages.length).toBeGreaterThan(0);
    expect(body.messages.length).toBeLessThanOrEqual(serverConfig.chatHistoryTailRows);
    expect(body.page.endedBy).toBe("bytes");
    expect(body.page.messageCount).toBe(CONVERSATION_LENGTH);
    expect(body.page.hasOlder).toBe(true);
    expect(body.page.olderCursor).not.toBeNull();
    // The TAIL, specifically: a reader opens on the newest words.
    expect(body.messages[body.messages.length - 1]!.content.startsWith("m0299")).toBe(true);
  });

  test("the serialized payload is under §5's 500KB budget", async () => {
    // The bound that actually matters, measured on the wire rather than
    // estimated from row counts. The whole conversation is ~1.05MB.
    // MUTATION: raise `DEFAULT_CHAT_HISTORY_PAGE_BYTES` past the budget and
    // this fails while every row-count assertion above stays green.
    const paged = await bytesOf(`/api/chats/${chatId}/history`);
    expect(paged, `tail page was ${(paged / 1024).toFixed(1)}KB`).toBeLessThan(PAYLOAD_BUDGET_BYTES);
  });

  test("every page of the walk is under budget, not just the first", async () => {
    let cursor: string | null = ((await get(`/api/chats/${chatId}/history`)).body as {
      page: HistoryPageView;
    }).page.olderCursor;
    let pages = 0;
    let worst = 0;
    while (cursor !== null && pages < 20) {
      const path = `/api/chats/${chatId}/history/older?before=${encodeURIComponent(cursor)}`;
      worst = Math.max(worst, await bytesOf(path));
      cursor = ((await get(path)).body as { page: HistoryPageView }).page.olderCursor;
      pages += 1;
    }
    expect(pages).toBeGreaterThan(1);
    expect(worst, `worst older page was ${(worst / 1024).toFixed(1)}KB`).toBeLessThan(
      PAYLOAD_BUDGET_BYTES,
    );
  });
});

describe("B. ?limit may narrow the page and may never widen it", () => {
  test("a smaller limit is honoured", async () => {
    const r = await get(`/api/chats/${chatId}/history?limit=12`);
    expect((r.body as { messages: unknown[] }).messages).toHaveLength(12);
  });

  test("a larger limit is CLAMPED, not obeyed", async () => {
    // MUTATION: drop the `Math.min` in `readLimit` and the first client that
    // writes `?limit=999999` puts the 75MB response back.
    const r = await get(`/api/chats/${chatId}/history?limit=999999`);
    const body = r.body as { messages: unknown[]; page: HistoryPageView };
    expect(body.page.limit).toBe(serverConfig.chatHistoryTailRows);
    expect(body.messages.length).toBeLessThanOrEqual(serverConfig.chatHistoryTailRows);
    expect(body.page.hasOlder).toBe(true);
  });

  test.each(["abc", "0", "-5", ""])("a nonsense limit (%s) falls back to the bound", async (raw) => {
    const r = await get(`/api/chats/${chatId}/history?limit=${raw}`);
    expect((r.body as { page: HistoryPageView }).page.limit).toBe(
      serverConfig.chatHistoryTailRows,
    );
  });
});

describe("C. the older-page route refuses what it cannot answer honestly", () => {
  test("no cursor is a 400, not the newest page", async () => {
    // MUTATION: default a missing `before` to the tail and a client bug turns
    // into an infinite loop that re-delivers the same page forever, silently.
    const r = await get(`/api/chats/${chatId}/history/older`);
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("missing_query");
  });

  test("a cursor this server did not issue is a 400, not a guess", async () => {
    const r = await get(`/api/chats/${chatId}/history/older?before=hand-written`);
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("history_cursor_unreadable");
  });

  test("an unknown chat is a 404 from both doors", async () => {
    expect((await get("/api/chats/nope/history")).status).toBe(404);
    expect((await get("/api/chats/nope/history/older?before=x")).status).toBe(404);
  });
});

describe("D. the reader can walk the whole conversation over HTTP", () => {
  test("the pages reassemble the conversation exactly, in order", async () => {
    // The completeness claim, end to end. A bound that loses a message is a
    // worse defect than the unbounded read it replaced.
    const tail = (await get(`/api/chats/${chatId}/history`)).body as {
      messages: MessageView[];
      page: HistoryPageView;
    };
    const seen = tail.messages.map((m) => m.id);
    let cursor = tail.page.olderCursor;
    while (cursor !== null) {
      const page = (
        await get(`/api/chats/${chatId}/history/older?before=${encodeURIComponent(cursor)}`)
      ).body as { messages: MessageView[]; page: HistoryPageView };
      seen.unshift(...page.messages.map((m) => m.id));
      cursor = page.page.olderCursor;
    }
    expect(seen).toHaveLength(CONVERSATION_LENGTH);
    expect(new Set(seen).size).toBe(CONVERSATION_LENGTH);
    const whole = srv.db.getChatHistory(chatId, srv.db.getUserByUsername("history-bounded")!.id)!;
    expect(seen).toEqual(whole.messages.map((m) => m.id));
  });
});

describe("E. the other per-chat collections are bounded, and say so", () => {
  test.each(["messages", "tool-calls", "metrics", "timeline"])(
    "/%s is bounded and carries X-Collection-Bound",
    async (leaf) => {
      // MUTATION: point any of these back at its `list*` method and it
      // returns every row for the chat with nothing saying so — an array
      // response has nowhere in the body to admit it was cut.
      const r = await get(`/api/chats/${chatId}/${leaf}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect((r.body as unknown[]).length).toBeLessThanOrEqual(
        serverConfig.chatHistoryTailRows,
      );
      const bound = r.headers.get("x-collection-bound");
      expect(bound, `${leaf} must state its bound`).not.toBeNull();
      expect(bound).toContain(`limit=${serverConfig.chatHistoryTailRows}`);
      expect(bound).toMatch(/returned=\d+/);
      expect(bound).toMatch(/more=[01]/);
    },
  );

  test("/messages says there IS more when there is", async () => {
    const r = await get(`/api/chats/${chatId}/messages`);
    expect(r.headers.get("x-collection-bound")).toContain("more=1");
    expect((r.body as unknown[]).length).toBeLessThanOrEqual(serverConfig.chatHistoryTailRows);
    expect((r.body as unknown[]).length).toBeGreaterThan(0);
  });
});
