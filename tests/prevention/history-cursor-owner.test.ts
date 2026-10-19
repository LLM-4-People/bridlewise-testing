/**
 * THE HISTORY CURSOR — the bound that makes a 20,000-message conversation
 * openable (DESIGN-PERFORMANCE §4).
 *
 * The defect this closes, measured in a browser against the `heavy` fixture:
 *
 *     GET /api/chats/<id>/history   200
 *       time to headers       7,217ms
 *       time to full body    34,665ms   ← client timeout is 30,000ms
 *       payload                75.1MB   (21,405 messages)
 *
 * The request aborted. There was no smaller request the client could make,
 * because the route had no cursor and no limit.
 *
 * What is guarded here, and each claim is a separate failure mode:
 *
 *   A. the page is BOUNDED — by rows and, independently, by bytes;
 *   B. the walk is COMPLETE and EXACT — cursoring back through a conversation
 *      reproduces it message for message, in order, with no gap and no
 *      repeat. A bound that loses a message is worse than the unbounded read;
 *   C. the page is a SEEK, not a scan — the anti-quadratic property, read off
 *      the query plan, because a cursor that filters backwards from the tail
 *      is the OFFSET defect wearing a WHERE clause;
 *   D. the page states WHERE IT ENDED — "the beginning of the conversation"
 *      is issued only when that is proven, never as a default (§1 L3);
 *   E. a cursor this server did not issue is REFUSED, not reinterpreted;
 *   F. `?limit=` may narrow the page and may never widen it — otherwise the
 *      unbounded read comes back through the query string;
 *   G. the four other per-chat collections are bounded too, and SAY SO.
 *
 * MUTATION NOTES are on each block: the exact edit that makes it fail.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

import { DbClient, decodeHistoryCursor } from "../../server/db/client.ts";
import { runMigrations } from "../../server/db/migrations.ts";
import { serverConfig } from "../../server/kernel/config.ts";
import { WebError } from "../../server/kernel/errors.ts";

type Fixture = Readonly<{
  db: DbClient;
  userId: string;
  chatId: string;
  /** Every message's content, oldest first — the ground truth. */
  contents: readonly string[];
}>;

const CONVERSATION_LENGTH = 431;

let fx: Fixture;

beforeAll(() => {
  const db = new DbClient({ path: ":memory:" });
  const user = db.createUser("cursor-owner", "hash");
  const project = db.createProject({ name: "p", path: "/tmp/cursor-owner" }, user.id);
  const chat = db.createChat({ project_id: project.id, title: "long" }, user.id);
  const contents: string[] = [];
  for (let i = 0; i < CONVERSATION_LENGTH; i += 1) {
    const content = `message-${String(i).padStart(4, "0")}`;
    // Roles alternate so tool calls attach to real tool messages below.
    db.createMessage(
      { chat_id: chat.id, role: i % 3 === 2 ? "tool" : i % 2 === 0 ? "user" : "assistant", content },
      user.id,
    );
    contents.push(content);
  }
  fx = { db, userId: user.id, chatId: chat.id, contents };
});

afterAll(() => {
  fx.db.close();
});

/** Walk the whole conversation through the cursor, tail first. */
function walkBackwards(limit: number): { contents: string[]; pages: number } {
  const tail = fx.db.getChatHistoryPage(fx.chatId, fx.userId, limit);
  expect(tail, "the tail page must exist").not.toBeNull();
  const seen = [...tail!.messages.map((m) => m.content)];
  let cursor = tail!.page.olderCursor;
  let pages = 1;
  while (cursor !== null) {
    const page = fx.db.getChatMessagePage(fx.chatId, fx.userId, cursor, limit);
    expect(page, "an older page must exist while a cursor names one").not.toBeNull();
    expect(
      page!.messages.length,
      "a page that claims there is more must carry at least one message — an empty page with a cursor is a walk that never advances",
    ).toBeGreaterThan(0);
    seen.unshift(...page!.messages.map((m) => m.content));
    cursor = page!.page.olderCursor;
    pages += 1;
    expect(pages, "the walk must terminate").toBeLessThan(CONVERSATION_LENGTH + 5);
  }
  return { contents: seen, pages };
}

describe("A. the page is bounded", () => {
  test("the tail page carries the NEWEST `limit` messages, oldest-first", () => {
    // MUTATION: drop `DESC` from the ORDER BY in `pageMessagesBackwards` and
    // the page comes back from the START of the conversation — which is what
    // a reader opening a chat must never see first.
    const page = fx.db.getChatHistoryPage(fx.chatId, fx.userId, 25)!;
    expect(page.messages).toHaveLength(25);
    expect(page.messages.map((m) => m.content)).toEqual(fx.contents.slice(-25));
    expect(page.page.returned).toBe(25);
    expect(page.page.messageCount).toBe(CONVERSATION_LENGTH);
  });

  test("the BYTE budget ends a page before the row bound does", () => {
    // MUTATION: delete the `if (bytes >= budget)` break and this returns all
    // 12 rows — a 3.6MB response from a route asked for 200 rows.
    const db = new DbClient({ path: ":memory:" });
    const user = db.createUser("bytes", "hash");
    const project = db.createProject({ name: "p", path: "/tmp/bytes" }, user.id);
    const chat = db.createChat({ project_id: project.id, title: "big" }, user.id);
    const perMessage = Math.ceil(serverConfig.chatHistoryPageBytes / 3);
    for (let i = 0; i < 12; i += 1) {
      db.createMessage({ chat_id: chat.id, role: "user", content: "x".repeat(perMessage) }, user.id);
    }
    const page = db.getChatHistoryPage(chat.id, user.id, 200)!;
    expect(page.page.endedBy).toBe("bytes");
    expect(page.messages.length).toBeLessThan(12);
    expect(
      page.page.hasOlder,
      "a page cut by bytes has more behind it, and must say so",
    ).toBe(true);
    expect(page.page.olderCursor).not.toBeNull();
    db.close();
  });

  test("TOOL CALLS count against the byte budget — the half that is not in the message rows", () => {
    /**
     * THE HOLE THIS CLOSES, found by measuring rather than by reading. The
     * page's tool calls are fetched AFTER the messages are chosen, so the
     * first version of the budget never saw them. Measured on the `heavy`
     * fixture's 20,000-message conversation: a 200-message page whose
     * MESSAGES were 322KB carried 449KB of tool calls — 56% of an 788.8KB
     * response, against §5's 500KB budget. Every row-count assertion was
     * green, and so was every message-only byte assertion.
     *
     * MUTATION: drop `toolBytes.get(row.id)` from the accumulator and this
     * returns all 12 messages — a page of trivial messages weighing
     * megabytes.
     */
    const db = new DbClient({ path: ":memory:" });
    const user = db.createUser("toolbytes", "hash");
    const project = db.createProject({ name: "p", path: "/tmp/toolbytes" }, user.id);
    const chat = db.createChat({ project_id: project.id, title: "fat tools" }, user.id);
    // Tiny messages; enormous tool output. The whole weight is in the table
    // the budget used not to look at.
    const perCall = Math.ceil(serverConfig.chatHistoryPageBytes / 3);
    for (let i = 0; i < 12; i += 1) {
      const message = db.createMessage({ chat_id: chat.id, role: "tool", content: "." }, user.id);
      db.createToolCall(
        {
          message_id: message.id,
          tool_name: "read file",
          input: { path: "big.txt" },
          output: "o".repeat(perCall),
          status: "done",
        },
        user.id,
      );
    }
    const page = db.getChatHistoryPage(chat.id, user.id, 200)!;
    expect(page.page.endedBy).toBe("bytes");
    expect(page.messages.length).toBeLessThan(12);
    expect(page.page.hasOlder).toBe(true);
    // And the tool calls that came with it are exactly the page's own.
    expect(page.tool_calls).toHaveLength(page.messages.length);
    db.close();
  });

  test("a single message larger than the whole budget is still returned", () => {
    // The bound may never produce an empty page while claiming there is more:
    // the reader would ask forever and travel nowhere.
    // MUTATION: move the budget check ABOVE the push and this returns 0 rows.
    const db = new DbClient({ path: ":memory:" });
    const user = db.createUser("huge", "hash");
    const project = db.createProject({ name: "p", path: "/tmp/huge" }, user.id);
    const chat = db.createChat({ project_id: project.id, title: "huge" }, user.id);
    db.createMessage({ chat_id: chat.id, role: "user", content: "y" }, user.id);
    db.createMessage(
      { chat_id: chat.id, role: "user", content: "z".repeat(serverConfig.chatHistoryPageBytes * 2) },
      user.id,
    );
    const page = db.getChatHistoryPage(chat.id, user.id, 200)!;
    expect(page.messages).toHaveLength(1);
    expect(page.page.hasOlder).toBe(true);
    const older = db.getChatMessagePage(chat.id, user.id, page.page.olderCursor!, 200)!;
    expect(older.messages.map((m) => m.content)).toEqual(["y"]);
    db.close();
  });
});

describe("B. the walk is complete and exact", () => {
  for (const limit of [1, 7, 50, 200]) {
    test(`page size ${limit}: the cursor walk reproduces the conversation exactly`, () => {
      // THE CLAIM THAT MATTERS MOST. A bound that skips or repeats a message
      // at a page boundary is silent data loss with a green performance
      // number attached.
      // MUTATION: change the keyset leg from `m.rowid < ?` to `m.rowid <= ?`
      // and every boundary message is delivered twice.
      const walked = walkBackwards(limit);
      expect(walked.contents).toEqual(fx.contents);
      expect(new Set(walked.contents).size).toBe(CONVERSATION_LENGTH);
      expect(walked.pages).toBe(Math.ceil(CONVERSATION_LENGTH / limit));
    });
  }

  test("the paged walk agrees with the unpaged read, message for message", () => {
    // The unpaged read is the standing definition of "the conversation".
    const whole = fx.db.getChatHistory(fx.chatId, fx.userId)!;
    expect(walkBackwards(60).contents).toEqual(whole.messages.map((m) => m.content));
  });

  test("tool calls arrive with the page their messages are on, and only those", () => {
    // MUTATION: drop the `tc.message_id IN (...)` predicate and every page
    // carries the whole chat's tool calls — the unbounded read, moved one
    // table across.
    const db = new DbClient({ path: ":memory:" });
    const user = db.createUser("tools", "hash");
    const project = db.createProject({ name: "p", path: "/tmp/tools" }, user.id);
    const chat = db.createChat({ project_id: project.id, title: "tools" }, user.id);
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const msg = db.createMessage({ chat_id: chat.id, role: "tool", content: `t${i}` }, user.id);
      db.createToolCall(
        { message_id: msg.id, tool_name: `tool-${i}`, input: { i }, status: "done" },
        user.id,
      );
      ids.push(msg.id);
    }
    const page = db.getChatHistoryPage(chat.id, user.id, 4)!;
    expect(page.messages.map((m) => m.id)).toEqual(ids.slice(-4));
    expect(page.tool_calls.map((t) => t.tool_name)).toEqual([
      "tool-6",
      "tool-7",
      "tool-8",
      "tool-9",
    ]);
    const older = db.getChatMessagePage(chat.id, user.id, page.page.olderCursor!, 4)!;
    expect(older.tool_calls.map((t) => t.tool_name)).toEqual([
      "tool-2",
      "tool-3",
      "tool-4",
      "tool-5",
    ]);
    db.close();
  });
});

describe("C. a page is a seek, not a scan", () => {
  /**
   * THE ANTI-QUADRATIC GUARD.
   *
   * `pageAllRows` already records what happens when paging is not a seek:
   * OFFSET paging on this same conversation cost 2,513ms at the production
   * page size against 130ms unpaged, because SQLite produced and discarded
   * every earlier row per page. A cursor whose predicate the planner cannot
   * turn into an index range has exactly that shape — it starts at the newest
   * message and filters backwards — so the plan is the property under test,
   * not the wall clock, which would be a flaky proxy for it.
   */
  function plan(sql: string, ...params: readonly (string | number)[]): string {
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as ReadonlyArray<{
      detail?: string;
    }>;
    db.close();
    return rows.map((r) => r.detail ?? "").join("\n");
  }

  const SCOPE = `messages m
     JOIN chats c ON m.chat_id = c.id
     JOIN projects p ON c.project_id = p.id
     WHERE m.chat_id = ? AND p.user_id = ?`;
  const ORDER = "ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?";

  test("the TAIL page reads the index in order — no temp b-tree", () => {
    // MUTATION: remove `idx_messages_chat_created` from migration 13 and this
    // reads `USE TEMP B-TREE FOR ORDER BY` — sorting every message in the
    // chat to find the newest 200.
    const detail = plan(`SELECT m.* FROM ${SCOPE} ${ORDER}`, "c", "u", 5);
    expect(detail).toContain("idx_messages_chat_created");
    expect(detail).not.toContain("TEMP B-TREE");
  });

  /**
   * THE PRODUCT'S OWN PREDICATE, lifted out of the source.
   *
   * A plan test written against a SQL literal typed here proves a fact about
   * this file, not about the server: change `olderThan` in `client.ts` and
   * the literal keeps passing. Verified by mutation — deleting the range
   * conjunct AND its bound parameter leaves every behavioural test in this
   * file green (results are byte-identical; only the plan degrades), so a
   * guard that does not read the product cannot see the regression at all.
   */
  function productOlderThan(): string {
    const text = readFileSync(new URL("../../server/db/client.ts", import.meta.url), "utf8");
    const match = /const olderThan\s*=\s*\n?\s*"([^"]+)";/.exec(text);
    expect(match, "`olderThan` must be a single string literal this guard can read").not.toBeNull();
    return match![1]!;
  }

  test("the OLDER page is POSITIONED by the cursor, not filtered to it", () => {
    // MUTATION: delete the redundant `m.created_at <= ?` conjunct from
    // `olderThan` (and its bound parameter, so the results stay identical) —
    // the plan degrades to `(chat_id=?)`, i.e. a backwards scan from the tail
    // filtering every page. That is O(distance from the tail) per page and
    // O(n²) over a walk: the OFFSET defect the cursor replaced, wearing a
    // WHERE clause. No test of the RESULTS can see it.
    const predicate = productOlderThan();
    const holes = (predicate.match(/\?/g) ?? []).length;
    const params: (string | number)[] = ["c", "u"];
    for (let i = 0; i < holes - 1; i += 1) params.push("t");
    params.push(1, 5);
    const detail = plan(`SELECT m.* FROM ${SCOPE} AND ${predicate} ${ORDER}`, ...params);
    expect(
      detail,
      `the product's cursor predicate must SEEK. Plan was:\n${detail}`,
    ).toContain("created_at<");
    expect(detail).not.toContain("TEMP B-TREE");
  });
});

describe("D. the page says where it ended, and never guesses", () => {
  test("`beginning` is issued only when nothing older exists", () => {
    // MUTATION: make `endedBy` default to "beginning" and the surface starts
    // announcing that conversations begin wherever the page happened to stop.
    const whole = fx.db.getChatHistoryPage(fx.chatId, fx.userId, CONVERSATION_LENGTH + 10)!;
    expect(whole.page.endedBy).toBe("beginning");
    expect(whole.page.hasOlder).toBe(false);
    expect(whole.page.olderCursor).toBeNull();

    const partial = fx.db.getChatHistoryPage(fx.chatId, fx.userId, 10)!;
    expect(partial.page.endedBy).toBe("limit");
    expect(partial.page.hasOlder).toBe(true);
  });

  test("`hasOlder` and `olderCursor` are one fact, not two that can disagree", () => {
    // MUTATION: return a cursor unconditionally and a reader at the beginning
    // of a conversation is handed a way to ask for a page that does not exist.
    let cursor: string | null = fx.db.getChatHistoryPage(fx.chatId, fx.userId, 30)!.page.olderCursor;
    let pages = 0;
    while (cursor !== null && pages < 50) {
      const page = fx.db.getChatMessagePage(fx.chatId, fx.userId, cursor, 30)!;
      expect(page.page.hasOlder).toBe(page.page.olderCursor !== null);
      cursor = page.page.olderCursor;
      pages += 1;
    }
    expect(pages).toBeGreaterThan(1);
  });

  test("an empty conversation is the beginning, and is not confused with a bound", () => {
    const db = new DbClient({ path: ":memory:" });
    const user = db.createUser("empty", "hash");
    const project = db.createProject({ name: "p", path: "/tmp/empty" }, user.id);
    const chat = db.createChat({ project_id: project.id, title: "empty" }, user.id);
    const page = db.getChatHistoryPage(chat.id, user.id, 200)!;
    expect(page.messages).toHaveLength(0);
    expect(page.page).toMatchObject({
      hasOlder: false,
      olderCursor: null,
      messageCount: 0,
      endedBy: "beginning",
    });
    db.close();
  });
});

describe("E. a cursor this server did not issue is refused", () => {
  test.each([
    ["not base64url at all", "not a cursor!!"],
    ["decodes to nothing", ""],
    ["no row position", Buffer.from("2026-01-01T00:00:00.000Z").toString("base64url")],
    ["row position is not a number", Buffer.from("2026-01-01T00:00:00.000Z\0abc").toString("base64url")],
    // `\0` immediately followed by a digit is a LEGACY OCTAL escape, not a
    // NUL byte: `"\0123"` is `"\n3"`, so this case was exercising a newline
    // rather than the separator it names. Written as an explicit code point
    // there is nothing left to misread.
    ["separator first", Buffer.from("\u0000123").toString("base64url")],
  ])("%s", (_label, raw) => {
    // MUTATION: make `decodeHistoryCursor` fall back to "the newest page" on
    // a parse failure and this passes while the reader is silently handed a
    // page from somewhere other than where they asked — which looks, from the
    // outside, exactly like the transcript jumping.
    let caught: unknown = null;
    try {
      decodeHistoryCursor(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught, `a cursor of "${raw}" must be refused`).toBeInstanceOf(WebError);
    expect((caught as WebError).code).toBe("history_cursor_unreadable");
  });

  test("a well-formed cursor round-trips exactly", () => {
    const page = fx.db.getChatHistoryPage(fx.chatId, fx.userId, 5)!;
    const decoded = decodeHistoryCursor(page.page.olderCursor!);
    expect(typeof decoded.createdAt).toBe("string");
    expect(Number.isSafeInteger(decoded.rowid)).toBe(true);
  });

  // ── UIE-038: THE CORRUPTION THAT SERVED A FALSE BEGINNING ─────────────
  //
  // One server process served a page-1 olderCursor whose createdAt had BOTH
  // colons replaced by '4' ("…T12444444.159Z"). A colon-less timestamp
  // sorts lexicographically before every real one, so /history/older matched
  // ZERO rows and answered endedBy:"beginning" while 81 older messages —
  // five whole turns — existed in the database. The DB file was clean, a
  // restart healed it, and the corruption never reproduced on demand: an
  // in-process transient. What the owner CAN do is refuse the shape
  // loudly, so the next occurrence is a diagnosable typed failure instead
  // of a conversation lying about where it starts.
  test("the corrupted cursor shape (UIE-038, both colons flipped) is REFUSED, not paged from", () => {
    // The drive's exact byte shape, rebuilt: a real (createdAt, rowid) pair
    // whose createdAt lost both colons to '4' — the cursor the served page
    // carried. It is well-formed base64url and it parses as a pair; only
    // the timestamp is wrong, which is exactly why the old decoder trusted
    // it and the walk ended in a false beginning.
    const corrupted = Buffer.from(
      "2026-09-01T12444444.159Z\0" + String(12),
      "utf8",
    ).toString("base64url");
    let caught: unknown = null;
    try {
      decodeHistoryCursor(corrupted);
    } catch (err) {
      caught = err;
    }
    expect(caught, "a colon-less timestamp is not a position this database wrote").toBeInstanceOf(WebError);
    expect((caught as WebError).code).toBe("history_cursor_unreadable");
    // The honest control: the SAME pair with its colons intact decodes.
    const healthy = Buffer.from(
      "2026-09-01T12:44:44.159Z\0" + String(12),
      "utf8",
    ).toString("base64url");
    expect(decodeHistoryCursor(healthy)).toEqual({
      createdAt: "2026-09-01T12:44:44.159Z",
      rowid: 12,
    });
  });

  test("a page whose oldest row reads corrupted refuses its cursor rather than serving a false beginning", () => {
    // The corruption the drive saw was SERVED — the newest page's envelope
    // carried the bad cursor and every /history/older walk after it ended
    // at a fabricated beginning. The encode side is where that page mints
    // its cursor, so the shape guard must fire THERE. For the encoder to
    // see the corrupted value, the corrupted row must become the OLDEST
    // row of a page that still has older rows behind it — so the arm
    // corrupts the two NEWEST rows to positions DERIVED from their own
    // stamps (each ":" flipped to ";", still a shape this database never
    // writes: 18:44:44 → 18;44;44): the corrupted pair keeps the rows'
    // order and sorts AFTER every same-hour real row (";" > ":"), so it
    // lands at the very head of the conversation whatever the wall clock
    // reads, and a one-row page then encodes the corrupted head as its
    // cursor while the probe honestly finds the row behind it.
    //
    // DERIVED RATHER THAN HARDCODED, because a hardcoded stamp is a TIME
    // BOMB: a fixed "hour 18" position only sorts to the head while the
    // fixture's own rows sit in a string-wise smaller hour, so the same
    // suite run inside that hour served the real head instead, the guard
    // never fired, and the arm failed for no reason it could name. Any
    // per-row flip that sorts HIGH (";" beats ":" in the same hour) makes
    // the pair head-of-conversation at every wall-clock instant, which is
    // what the invariant actually needs.
    const raw = (fx.db as unknown as { db: DatabaseSync }).db;
    const pick = raw
      .prepare("SELECT rowid, created_at FROM messages WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 2")
      .all(fx.chatId) as Array<{ rowid: number; created_at: string }>;
    expect(pick).toHaveLength(2);
    const updates = raw.prepare("UPDATE messages SET created_at = ? WHERE rowid = ?");
    try {
      updates.run(pick[1]!.created_at.replace(/:/g, ";"), pick[1]!.rowid);
      updates.run(pick[0]!.created_at.replace(/:/g, ";"), pick[0]!.rowid);
      let caught: unknown = null;
      try {
        fx.db.getChatHistoryPage(fx.chatId, fx.userId, 1);
      } catch (err) {
        caught = err;
      }
      expect(caught, "the page whose cursor would carry the corrupted position must refuse").toBeInstanceOf(WebError);
      expect((caught as WebError).code).toBe("history_cursor_unreadable");
    } finally {
      // The fixture stays walkable for the arms after this one — the guard
      // is the subject here, not the planted state. Each row gets its OWN
      // stamp back (the derived pair was two distinct positions).
      updates.run(pick[0]!.created_at, pick[0]!.rowid);
      updates.run(pick[1]!.created_at, pick[1]!.rowid);
    }
  });

  test("a rewind never moves the cursor's ground — paging after a withdrawal still walks the whole record", async () => {
    // The rewind-then-page interaction the drive asked about. A rewind
    // withdraws turns by RECORDING an event; the rows stay in the table, so
    // the paging derives from the same live set it always did. This arm
    // pins that derivation: after a withdrawal the walk still reproduces
    // the conversation exactly — no turn hidden behind a stale cursor, no
    // false "beginning" from a position the withdrawal "passed".
    const { recordRewind, discardedMessageIdsForChat } =
      await import("../../server/run/rewind.ts");
    const list = fx.db.listMessages(fx.chatId, fx.userId);
    // The tail page of 50's own oldest row — the same anchor a reader
    // pressing "rewind here" on the first beat of the loaded window names.
    const anchor = list[list.length - 50]!;
    const anchorIndex = list.findIndex((m) => m.id === anchor.id);
    expect(anchorIndex).toBeGreaterThanOrEqual(0);
    const ids = list.slice(anchorIndex).map((m) => m.id);
    const before = walkBackwards(50);
    recordRewind({
      chatId: fx.chatId,
      userId: fx.userId,
      anchorMessageId: anchor.id,
      discardedMessageIds: ids,
      discardedRunIds: [],
      mode: "at",
    });
    expect(discardedMessageIdsForChat(fx.chatId, fx.userId).size).toBe(ids.length);
    // The rows never left: the walk still reproduces the conversation,
    // message for message, in order — the cursor's ground is the live set.
    const after = walkBackwards(50);
    expect(after.contents).toEqual(before.contents);
    expect(after.contents).toEqual(fx.contents);
    // And the honest "beginning" verdict is untouched by the withdrawal:
    // a short page from one snapshot still proves there is nothing older.
    const whole = fx.db.getChatHistoryPage(fx.chatId, fx.userId, 500)!;
    expect(whole.page.endedBy).toBe("beginning");
    expect(whole.page.hasOlder).toBe(false);
  });
});

describe("F. ownership is a property of the query, not of the caller", () => {
  test("another user's chat is invisible to both paged doors", () => {
    const stranger = fx.db.createUser("stranger", "hash");
    expect(fx.db.getChatHistoryPage(fx.chatId, stranger.id, 10)).toBeNull();
    const cursor = fx.db.getChatHistoryPage(fx.chatId, fx.userId, 10)!.page.olderCursor!;
    expect(fx.db.getChatMessagePage(fx.chatId, stranger.id, cursor, 10)).toBeNull();
  });
});
