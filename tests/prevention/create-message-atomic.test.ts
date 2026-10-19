// @vitest-environment node
/**
 * Prevention test: `createMessage` is ONE transaction, not two auto-commits.
 * (DESIGN-PERFORMANCE §6 item 3.)
 *
 * ── The defect ──
 *
 * `createMessage` did two separate writes on the connection: the INSERT into
 * `messages`, then the `chats.updated_at` bump. As auto-commits that is two
 * COMMITs, two fsyncs — measured at 5.08ms + 6.01ms = 11.0ms, of which the
 * actual work is ~17µs. Every millisecond of it blocks the event loop.
 *
 * ── It is a correctness fix, not only a cost one ──
 *
 * The two writes describe ONE event and are meaningless apart. A crash
 * between them leaves a message the sidebar cannot see: the row exists, but
 * the chat's `updated_at` still claims the conversation is older than its own
 * newest turn, so it sorts below conversations that have not moved. That is a
 * transcript the product holds and does not show — which is why this test
 * asserts ATOMICITY, not speed. A benchmark decays; an invariant does not.
 *
 * ── What is verified ──
 *
 * A1 the pair is atomic: a failure inside the write leaves NEITHER half.
 * A2 the happy path still does both halves (the guard must not be
 *    satisfiable by making the bump a no-op).
 * A3 the write is genuinely inside a transaction — proven from a SECOND
 *    connection, which cannot see either half until COMMIT.
 * A4 it nests: called from inside a caller's own transaction it must not
 *    open a second one, and the caller's rollback must still undo it.
 * A5 one call opens exactly ONE transaction on the connection — the case
 *    A1 and A3 CANNOT see, because both of them wrap the call in an outer
 *    transaction that would sweep up two auto-commits and make the defect
 *    look atomic.
 * B  structure: the two statements live inside one `withTransaction`.
 *
 * ── Mutation-verified (each run) ──
 * Removing the `withTransaction` wrapper (back to two auto-commits) makes
 * A5 and B FAIL — and, importantly, A1/A3/A4 still PASS, which is why A5
 * exists. Deleting the `updated_at` bump makes A2 FAIL.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { DbClient } from "../../server/db/client.ts";
import { createNoopDbCrypto } from "../../server/db/db-crypto.ts";
import { WebError } from "../../server/kernel/errors.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { read, stripCommentsOnly } from "../helpers/source-scan.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
let tmpRoot = "";
beforeEach(() => {
  tmpRoot = createTempDir("create-msg-atomic-");
});

function seed(db: DbClient): { chatId: string; updatedAt: string } {
  const project = db.createProject({ name: "p", path: "/p" }, "u");
  const chat = db.createChat({ project_id: project.id, title: "c" }, "u");
  return { chatId: chat.id, updatedAt: chat.updated_at };
}

describe("A. the message row and the recency bump are one write", () => {
  test("A1 a failure inside the write leaves NEITHER half", () => {
    const path = join(tmpRoot, "a1.db");
    const db = new DbClient({ path, crypto: createNoopDbCrypto() });
    try {
      const { chatId, updatedAt } = seed(db);
      // Fail the write from INSIDE the transaction, after the INSERT has run:
      // a caller-level transaction whose body throws after createMessage
      // returns is the same shape as a crash between the two statements, and
      // it is the only way to observe the intermediate state deterministically
      // (a real crash cannot be scheduled).
      expect(() =>
        db.withTransaction(() => {
          db.createMessage({ chat_id: chatId, role: "user", content: "doomed" }, "u");
          throw new WebError("the write failed after the row was inserted", "test_failure");
        }),
      ).toThrow("the write failed after the row was inserted");

      expect(
        db.listMessages(chatId, "u").length,
        "the message must not survive a rolled-back write",
      ).toBe(0);
      expect(
        db.getChat(chatId, "u")!.updated_at,
        "and neither may the recency bump — a chat that claims activity it has no " +
          "message for is a conversation the sidebar sorts on a lie",
      ).toBe(updatedAt);
    } finally {
      db.close();
    }
  });

  test("A2 the happy path still writes BOTH halves", () => {
    const db = new DbClient({ path: join(tmpRoot, "a2.db"), crypto: createNoopDbCrypto() });
    try {
      const { chatId, updatedAt } = seed(db);
      const msg = db.createMessage({ chat_id: chatId, role: "user", content: "hello" }, "u");
      expect(db.listMessages(chatId, "u").map((m) => m.content)).toEqual(["hello"]);
      const after = db.getChat(chatId, "u")!.updated_at;
      expect(
        after >= updatedAt && after === msg.created_at,
        "the chat's recency must be bumped to the message's own instant — making the " +
          "bump a no-op would satisfy atomicity by doing nothing",
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  test("A3 a second connection sees NEITHER half until the commit", () => {
    const path = join(tmpRoot, "a3.db");
    const setup = new DbClient({ path, crypto: createNoopDbCrypto() });
    const { chatId } = seed(setup);
    setup.close();

    const writer = new DbClient({ path, crypto: createNoopDbCrypto() });
    const reader = new DbClient({ path, crypto: createNoopDbCrypto() });
    try {
      const beforeBump = reader.getChat(chatId, "u")!.updated_at;
      // Timestamps are ISO milliseconds. Without this the chat's creation and
      // the message's insertion land in the SAME millisecond and "the bump
      // moved" is unobservable — the assertion below would hold vacuously.
      const startedAt = Date.now();
      while (Date.now() - startedAt < 2) { /* wait for the clock to advance */ }

      const raw = (writer as unknown as { db: DatabaseSync }).db;
      // A manual BEGIN so the intermediate state is observable. If
      // createMessage were two auto-commits, each would still be inside THIS
      // transaction — so what this really proves is the pair is not visible
      // half-way, which is the property the sidebar depends on.
      raw.exec("BEGIN");
      const written = writer.createMessage(
        { chat_id: chatId, role: "user", content: "in flight" },
        "u",
      );
      expect(written.created_at, "the clock must have advanced, or A3 proves nothing")
        .not.toBe(beforeBump);
      expect(reader.listMessages(chatId, "u").length, "the row is not committed yet").toBe(0);
      expect(reader.getChat(chatId, "u")!.updated_at, "nor is the bump").toBe(beforeBump);
      raw.exec("COMMIT");
      expect(reader.listMessages(chatId, "u").length).toBe(1);
      expect(
        reader.getChat(chatId, "u")!.updated_at,
        "after the commit BOTH halves are visible, and the bump carries the message's " +
          "own instant",
      ).toBe(written.created_at);
    } finally {
      writer.close();
      reader.close();
    }
  });

  test("A5 one createMessage opens exactly ONE transaction on the connection", () => {
    // A1/A3 both put createMessage inside a caller's transaction, where two
    // auto-commits would be swept up by the outer one and look atomic — so
    // neither of them can tell the fix from the defect. This one watches the
    // connection itself with no outer transaction: two auto-commits issue NO
    // BEGIN at all (SQLite commits each statement), and one durable write
    // issues exactly one BEGIN/COMMIT pair. Two fsyncs against one, measured
    // as 11.0ms against ~5.9ms — and one crash window instead of two.
    const db = new DbClient({ path: join(tmpRoot, "a5.db"), crypto: createNoopDbCrypto() });
    try {
      const { chatId } = seed(db);
      const raw = (db as unknown as { db: DatabaseSync }).db;
      const issued: string[] = [];
      const realExec = raw.exec.bind(raw);
      (raw as unknown as { exec: (sql: string) => void }).exec = (sql: string): void => {
        issued.push(sql.trim().toUpperCase());
        realExec(sql);
      };
      try {
        db.createMessage({ chat_id: chatId, role: "user", content: "one write" }, "u");
      } finally {
        (raw as unknown as { exec: (sql: string) => void }).exec = realExec;
      }
      expect(
        issued.filter((s) => s === "BEGIN").length,
        "createMessage must open exactly one transaction — zero means it is back to " +
          "two auto-commits, each with its own fsync and its own crash window",
      ).toBe(1);
      expect(issued.filter((s) => s === "COMMIT").length).toBe(1);
      expect(issued.filter((s) => s.startsWith("SAVEPOINT")).length, "and no savepoint at depth 0").toBe(0);
    } finally {
      db.close();
    }
  });

  test("A4 it nests inside a caller's transaction, and the caller's rollback undoes it", () => {
    const db = new DbClient({ path: join(tmpRoot, "a4.db"), crypto: createNoopDbCrypto() });
    try {
      const { chatId } = seed(db);
      // Committing outer transaction: three messages, one commit.
      db.withTransaction(() => {
        for (let i = 0; i < 3; i += 1) {
          db.createMessage({ chat_id: chatId, role: "user", content: `n-${i}` }, "u");
        }
      });
      expect(db.listMessages(chatId, "u").length).toBe(3);

      // Rolling-back outer transaction: none of it survives.
      expect(() =>
        db.withTransaction(() => {
          db.createMessage({ chat_id: chatId, role: "user", content: "gone" }, "u");
          throw new WebError("outer failure", "test_failure");
        }),
      ).toThrow("outer failure");
      expect(db.listMessages(chatId, "u").map((m) => m.content)).toEqual(["n-0", "n-1", "n-2"]);
    } finally {
      db.close();
    }
  });
});

describe("B. structure — both statements are inside ONE transaction", () => {
  const SRC = stripCommentsOnly(read(modulePathMatching("server/db/client.ts")));

  test("createMessage wraps its INSERT and its bump in a single withTransaction", () => {
    const start = SRC.indexOf("  createMessage(input: MessageCreateInput, userId: string)");
    expect(start, "createMessage must exist").toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf("\n  }\n", start));

    const tx = body.indexOf("this.withTransaction(");
    const insert = body.indexOf("INSERT INTO messages");
    const bump = body.indexOf("UPDATE chats SET updated_at");
    expect(tx, "createMessage must open a transaction").toBeGreaterThan(-1);
    expect(insert, "the INSERT must exist").toBeGreaterThan(-1);
    expect(bump, "the recency bump must exist").toBeGreaterThan(-1);
    expect(insert, "the INSERT must be inside the transaction, not before it").toBeGreaterThan(tx);
    expect(bump, "the bump must be inside the same transaction").toBeGreaterThan(tx);
    expect(
      body.split("this.withTransaction(").length - 1,
      "one transaction, not one per statement",
    ).toBe(1);
  });
});
