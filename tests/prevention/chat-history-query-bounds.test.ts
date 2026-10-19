// @vitest-environment node
/**
 * Prevention test: the per-chat history reads are BOUNDED per statement,
 * and bounding them cost nobody a single row.
 *
 * ── The defect ──
 *
 * `getChatHistory` fanned out to four `LIMIT`-less SELECTs (messages, tool
 * calls, metrics snapshots, timeline refs). Every matching row was
 * materialised in one go and then AES-decrypted and Zod-validated
 * individually. The cost of opening a chat therefore grew without any
 * ceiling, driven entirely by how long the conversation was.
 *
 * ── Why the fix is a PAGE SIZE and not a cap ──
 *
 * The obvious repair — `LIMIT 500` — would be a worse bug than the one it
 * fixes: a chat with 600 messages would silently render 500, and nothing
 * anywhere would say so. A transcript that quietly loses its oldest turns
 * is indistinguishable from data loss. So the reads page until the table
 * is exhausted: every statement is bounded, and the caller still receives
 * everything. Truncation is not "explained" — it is impossible.
 *
 * ── What is verified ──
 *
 * A. The bound exists and comes from the config owner, not a literal.
 * B. Behaviour with a deliberately TINY page size (3), so every read
 *    crosses many page boundaries:
 *    B1 every row is returned, in order, for all four reads;
 *    B2 exact counts across page boundaries (n-1, n, n+1 rows around the
 *       page size) — the off-by-one page-boundary cases;
 *    B3 `getChatHistory` — the fan-out that motivated the defect — is
 *       complete.
 * C. Structure: all four reads go through the single paging owner, no
 *    `LIMIT`-less history SELECT is left behind, the walk is a KEYSET (not
 *    an OFFSET — see below), each cursor is unique, and each declared
 *    ordering is total (dynamic discovery over comment-stripped source).
 *
 * ── Why the bound is now a keyset ──
 *
 * `LIMIT ? OFFSET ?` made the bounded walk accidentally O(n²): OFFSET is not
 * a seek, so SQLite produced and DISCARDED the skipped rows on every page,
 * and re-sorted the whole matching set each time because no index satisfied
 * the ORDER BY. Measured on the 23,930-message conversation in the `heavy`
 * fixture: 10,423ms at page 100, 2,513ms at the production page size of 500,
 * 130ms unpaged. The bound was charging 19× for a ceiling it never applied.
 * Keyset paging seeks past the previous page's last row instead — 58.5ms for
 * the same rows, faster than not paging at all.
 *
 * ── Mutation-verified ──
 * Replacing the paging loop with a single bounded query (a real cap) makes
 * B1/B2/B3 FAIL. Reverting any one read to a direct `LIMIT`-less SELECT
 * makes C FAIL. Removing the `LIMIT ?` from the owner makes C FAIL. Going
 * back to OFFSET paging makes C FAIL. Dropping the rowid from a cursor makes
 * C FAIL, and — because it is a real defect, not only a naming one — dropping
 * it from the MESSAGES cursor while several messages share a timestamp makes
 * B1 FAIL by losing rows.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { join } from "node:path";

// A tiny page size, applied BEFORE the config singleton is re-resolved by
// the vitest setup file's beforeAll. Every read below therefore crosses
// several page boundaries — with the production default (500) these tests
// would fit in one page and prove nothing.
const PAGE_ROWS = 3;
process.env["HARNESS_WEB_CHAT_HISTORY_PAGE_ROWS"] = String(PAGE_ROWS);

import { DbClient } from "../../server/db/client.ts";
import { serverConfig, DEFAULT_CHAT_HISTORY_PAGE_ROWS } from "../../server/kernel/config.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { read, stripCommentsOnly } from "../helpers/source-scan.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
let tmpRoot = "";

beforeEach(() => {
  tmpRoot = createTempDir("chat-bounds-");
});

function freshDb(): DbClient {
  return new DbClient({ path: join(tmpRoot, `b-${Math.random().toString(36).slice(2)}.db`) });
}

function seedChat(db: DbClient): { projectId: string; chatId: string } {
  const project = db.createProject({ name: "p", path: "/proj" }, "u");
  const chat = db.createChat({ project_id: project.id, title: "c" }, "u");
  return { projectId: project.id, chatId: chat.id };
}

describe("A. the bound is a named config value, not a literal in the query", () => {
  test("the page size is owned by server/config.ts and is env-overridable", () => {
    expect(DEFAULT_CHAT_HISTORY_PAGE_ROWS).toBeGreaterThan(0);
    expect(
      serverConfig.chatHistoryPageRows,
      "the env override must reach the resolved config (otherwise the bound is not configurable)",
    ).toBe(PAGE_ROWS);
  });

  test("server/db/client.ts reads the bound from config rather than declaring one", () => {
    const src = stripCommentsOnly(read(modulePathMatching("server/db/client.ts")));
    expect(src).toContain("serverConfig.chatHistoryPageRows");
    expect(
      src,
      "the page size must not be redeclared in the DB layer — one owner",
    ).not.toMatch(/const\s+\w*PAGE_ROWS\w*\s*=\s*\d/);
  });
});

describe("B. paging returns EVERY row — bounding the statement truncated nothing", () => {
  test("B1 all four per-chat reads return every row, in order", () => {
    const db = freshDb();
    const { projectId, chatId } = seedChat(db);
    const total = PAGE_ROWS * 4 + 1; // several full pages plus a partial one

    for (let i = 0; i < total; i += 1) {
      const msg = db.createMessage(
        { chat_id: chatId, role: "user", content: `m-${String(i).padStart(3, "0")}` },
        "u",
      );
      db.createToolCall(
        { message_id: msg.id, tool_name: `tool-${i}`, input: { i }, status: "done" },
        "u",
      );
      db.createMetricsSnapshot({ chat_id: chatId, snapshot: { i } }, "u");
      db.createTimelineRef(
        {
          chat_id: chatId,
          event_id: `evt-${i}`,
          event_type: "test",
          timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString(),
          metadata: { i },
        },
        "u",
      );
    }

    expect(db.listMessages(chatId, "u").map((m) => m.content)).toEqual(
      Array.from({ length: total }, (_, i) => `m-${String(i).padStart(3, "0")}`),
    );
    expect(db.listToolCallsByChat(chatId, "u").length).toBe(total);
    expect(db.listMetricsSnapshots(chatId, "u").length).toBe(total);
    expect(db.listTimelineRefs(chatId, "u").map((t) => t.event_id)).toEqual(
      Array.from({ length: total }, (_, i) => `evt-${i}`),
    );
  });

  test("B2 exact counts at the page boundaries (n-1, n, n+1, 2n)", () => {
    for (const count of [PAGE_ROWS - 1, PAGE_ROWS, PAGE_ROWS + 1, PAGE_ROWS * 2]) {
      const db = freshDb();
      const { chatId } = seedChat(db);
      for (let i = 0; i < count; i += 1) {
        db.createMessage({ chat_id: chatId, role: "user", content: `m${i}` }, "u");
      }
      expect(
        db.listMessages(chatId, "u").length,
        `a chat with ${count} messages (page size ${PAGE_ROWS}) must return all ${count}`,
      ).toBe(count);
    }
  });

  test("B3 getChatHistory — the fan-out that motivated the defect — is complete", () => {
    const db = freshDb();
    const { chatId } = seedChat(db);
    const total = PAGE_ROWS * 3 + 2;
    for (let i = 0; i < total; i += 1) {
      db.createMessage({ chat_id: chatId, role: "user", content: `m${i}` }, "u");
      db.createMetricsSnapshot({ chat_id: chatId, snapshot: { i } }, "u");
    }
    const history = db.getChatHistory(chatId, "u");
    expect(history).not.toBeNull();
    expect(history!.messages.length).toBe(total);
    expect(history!.metrics_snapshots.length).toBe(total);
    // The LAST snapshot is what the client hydrates its metrics from — a
    // truncating read would hand it the wrong one, silently.
    expect(
      (history!.metrics_snapshots[total - 1]!.snapshot as { i: number }).i,
      "the newest snapshot must survive paging (the client reads the last one)",
    ).toBe(total - 1);
  });

  test("B5 rows sharing a timestamp survive a page boundary (the cursor must be unique)", () => {
    // The case a `created_at`-only cursor loses. Messages written back to
    // back share an ISO millisecond routinely — a run streaming its turns
    // does exactly this — so `WHERE created_at > <last>` would step OVER
    // every sibling in the same millisecond and drop them silently. The
    // cursor is the rowid for precisely this reason.
    const db = freshDb();
    const { chatId } = seedChat(db);
    const total = PAGE_ROWS * 5;
    for (let i = 0; i < total; i += 1) {
      db.createMessage({ chat_id: chatId, role: "user", content: `m-${String(i).padStart(3, "0")}` }, "u");
    }
    const rows = db.listMessages(chatId, "u");
    // Prove the premise: without ties this test would pass for the wrong
    // reason. Written this fast, many rows DO share a millisecond.
    const distinct = new Set(rows.map((m) => m.created_at)).size;
    expect(
      distinct,
      "these writes must share timestamps, or the tie case is not exercised at all",
    ).toBeLessThan(total);
    expect(rows.map((m) => m.content)).toEqual(
      Array.from({ length: total }, (_, i) => `m-${String(i).padStart(3, "0")}`),
    );
  });

  test("B6 several tool calls under ONE message survive a page boundary (composite cursor)", () => {
    // Tool calls page on `(m.rowid, tc.rowid)` because their scope comes from
    // the chat two joins away. A cursor of `m.rowid` alone would skip every
    // tool call after the first of whichever message straddles a boundary.
    const db = freshDb();
    const { chatId } = seedChat(db);
    const msg = db.createMessage({ chat_id: chatId, role: "user", content: "one turn" }, "u");
    const total = PAGE_ROWS * 4 + 1;
    for (let i = 0; i < total; i += 1) {
      db.createToolCall(
        { message_id: msg.id, tool_name: `tool-${String(i).padStart(3, "0")}`, input: { i }, status: "done" },
        "u",
      );
    }
    expect(
      db.listToolCallsByChat(chatId, "u").map((t) => t.tool_name),
      "every tool call of a single message must survive, however many pages it spans",
    ).toEqual(Array.from({ length: total }, (_, i) => `tool-${String(i).padStart(3, "0")}`));
  });

  test("B4 a chat's rows stay scoped to that chat across pages", () => {
    const db = freshDb();
    const project = db.createProject({ name: "p", path: "/proj" }, "u");
    const mine = db.createChat({ project_id: project.id, title: "mine" }, "u");
    const other = db.createChat({ project_id: project.id, title: "other" }, "u");
    for (let i = 0; i < PAGE_ROWS * 2 + 1; i += 1) {
      db.createMessage({ chat_id: mine.id, role: "user", content: `mine-${i}` }, "u");
      db.createMessage({ chat_id: other.id, role: "user", content: `other-${i}` }, "u");
    }
    const rows = db.listMessages(mine.id, "u");
    expect(rows.every((r) => r.content.startsWith("mine-"))).toBe(true);
    expect(rows.length).toBe(PAGE_ROWS * 2 + 1);
    // And another user still sees nothing (paging must not widen the scope).
    expect(db.listMessages(mine.id, "someone-else").length).toBe(0);
  });
});

describe("C. no unbounded history SELECT survives (dynamic discovery)", () => {
  const SRC = stripCommentsOnly(read(modulePathMatching("server/db/client.ts")));
  const HISTORY_READS = [
    "listMessages",
    "listToolCallsByChat",
    "listMetricsSnapshots",
    "listTimelineRefs",
  ] as const;

  test("the paging owner exists and is the thing that applies the bound", () => {
    expect(SRC, "there must be a single paging owner").toMatch(
      /private\s+pageAllRows</,
    );
    expect(
      SRC,
      "the owner must append the LIMIT — that is the whole point of it",
    ).toMatch(/LIMIT \?/);
  });

  test("the bound is a KEYSET, not an OFFSET (the O(n²) shape must not return)", () => {
    // OFFSET is not a seek: SQLite produces and discards the skipped rows on
    // every page, so the walk cost pages × n rather than n. Measured on the
    // same 23,930-message conversation: 2,513ms paged at 500 against 130ms
    // unpaged — a bound that was never a cap, charging 19× for the privilege.
    expect(
      SRC,
      "OFFSET paging is quadratic by construction — the owner must seek past the " +
        "last row's cursor instead of counting rows it will throw away",
    ).not.toMatch(/\bOFFSET\b/);
    expect(SRC, "the owner must build a keyset predicate").toMatch(/keysetPredicate\(/);
    expect(SRC, "and bind it from the last row of the previous page").toMatch(/keysetValues\(/);
  });

  test("every per-chat history read goes through the paging owner", () => {
    const notPaged: string[] = [];
    for (const name of HISTORY_READS) {
      const start = SRC.indexOf(`  ${name}(chatId: string, userId: string)`);
      expect(start, `${name} must exist in server/db/client.ts`).toBeGreaterThan(-1);
      const body = SRC.slice(start, SRC.indexOf("\n  }\n", start));
      if (!body.includes("this.pageAllRows(")) notPaged.push(name);
    }
    expect(
      notPaged,
      "these reads issue their own SELECT instead of going through the bounded " +
        "paging owner — an unbounded per-chat read is back",
    ).toEqual([]);
  });

  test("each paged read's CURSOR is unique (a cursor with ties skips rows at a boundary)", () => {
    const missing: string[] = [];
    for (const name of HISTORY_READS) {
      const start = SRC.indexOf(`  ${name}(chatId: string, userId: string)`);
      const body = SRC.slice(start, SRC.indexOf("\n  }\n", start));
      // The cursor must end in a rowid — SQLite's only guaranteed-unique
      // column. A cursor on `created_at` alone would make two rows sharing a
      // timestamp straddle a page boundary, and one of them would be dropped.
      const cursor = /cursor:\s*\[([\s\S]*?)\]/.exec(body)?.[1] ?? "";
      if (!/\.rowid["']?\s*,/.test(cursor) && !/\.rowid\b/.test(cursor)) missing.push(name);
    }
    expect(
      missing,
      "a paging cursor with ties is not stable across pages — a row can be silently " +
        "skipped at a boundary, which is the truncation this fix forbids",
    ).toEqual([]);
  });

  test("each paged read declares a TOTAL ordering, terminated by the unique cursor alias", () => {
    const missing: string[] = [];
    for (const name of HISTORY_READS) {
      const start = SRC.indexOf(`  ${name}(chatId: string, userId: string)`);
      const body = SRC.slice(start, SRC.indexOf("\n  }\n", start));
      // The walk advances on rowid; the CALLER is owed the declared order,
      // applied in memory. It must still be total, or the same two rows
      // sharing a timestamp come back in an order that varies between runs.
      const order = /order:\s*\[([^\]]*)\]/.exec(body)?.[1] ?? "";
      const parts = order.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      if (parts.length < 2 || !parts[parts.length - 1]!.includes("__row")) missing.push(name);
    }
    expect(
      missing,
      "the declared ordering must end in the unique cursor alias, or two rows with " +
        "the same timestamp have no defined order",
    ).toEqual([]);
  });
});
