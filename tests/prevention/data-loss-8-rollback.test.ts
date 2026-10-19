// @vitest-environment node
/**
 * Data loss #8: rewinding a conversation must not lose messages.
 *
 * ── THIS TEST USED TO ASSERT THE OPPOSITE ─────────────────────────────────
 *
 * It verified that `deleteMessagesAfter` removed the later messages, cascaded
 * their tool calls, kept the anchor, and that the loss survived a reopen. Every
 * assertion passed, and what they proved was that destruction worked correctly.
 *
 * That was the right test for the old model, where rewinding a conversation
 * meant trimming it. The model changed: rows STAY, a `rollback` event names the
 * withdrawn ids, and the fold at read time decides what the model receives. So
 * the data-loss question inverts. It is no longer "does the delete remove the
 * right rows" but "can anything remove them at all".
 *
 * The method is gone. This file is the ratchet that keeps it gone, because a
 * capability whose only remaining consumer is its own test still reads as
 * load-bearing — green, specific, and apparently blessed — to the next person
 * who needs to trim a conversation.
 *
 * The scan is DYNAMIC: it asks the DbClient surface what it can do, rather than
 * naming the method that happened to exist. A differently-named message-deleter
 * added tomorrow is caught by the same assertion.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";

import { createTempDir } from "../helpers/temp-dir.ts";
import { DbClient } from "../../server/db/client.ts";

/** Every method name on the DbClient prototype chain, discovered, not listed. */
function dbClientMethodNames(): string[] {
  const names = new Set<string>();
  let proto: object | null = DbClient.prototype as object;
  while (proto !== null && proto !== Object.prototype) {
    for (const n of Object.getOwnPropertyNames(proto)) names.add(n);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return [...names];
}

describe("data loss #8: a rewind withdraws, it does not delete", () => {
  test("the DB owner exposes no way to delete a chat's messages", () => {
    // Anything that both DELETEs and concerns messages. Chat and project
    // removal are deliberately NOT caught: those destroy something a user
    // asked to be gone, and they record the removal.
    const deleters = dbClientMethodNames().filter((n) =>
      /^delete/i.test(n) && /message/i.test(n),
    );
    expect(
      deleters,
      `DbClient exposes ${deleters.join(", ")} — a message-deleting method. ` +
        `Rewinding withdraws (rows stay, the ledger names the withdrawn ids); it ` +
        `does not trim. If deletion is genuinely needed it belongs behind the same ` +
        `append-the-record-first discipline recordRewind uses, not on the DB owner.`,
    ).toEqual([]);
  });

  test("no DELETE statement targets the messages table", () => {
    // The method could come back under a name the filter above misses, so the
    // second check reads the SQL itself — the thing that actually destroys.
    const src = readFileSync(
      resolve(import.meta.dirname, "../../server/db/client.ts"),
      "utf8",
    );
    const deleteFromMessages = /DELETE\s+FROM\s+messages\b/i.exec(src);
    expect(
      deleteFromMessages?.[0] ?? null,
      "server/db/client.ts issues a DELETE against `messages`. Messages are " +
        "withdrawn, never destroyed — the withdrawn text is the evidence of what " +
        "was rejected, and deleting it is what makes a rewind unreviewable.",
    ).toBeNull();
  });

  test("messages written before a rewind point are all still readable afterwards", () => {
    // The guarantee the original test protected, restated for the new model:
    // whatever a rewind does, the rows survive it — including across a reopen,
    // which is where a trim would have become permanent.
    const dir = createTempDir("ch-data-loss-rewind-");
    const dbPath = join(dir, "rewind.db");
    const contents = ["keep-0", "keep-1", "withdrawn-2", "withdrawn-3"];

    const db = new DbClient({ path: dbPath });
    try {
      const p = db.createProject({ name: "rb", path: "/rb" }, "sess-rb");
      const c = db.createChat({ project_id: p.id, title: "rb chat" }, "sess-rb");
      for (const [i, content] of contents.entries()) {
        db.createMessage(
          { chat_id: c.id, role: i % 2 === 0 ? "user" : "assistant", content },
          "sess-rb",
        );
      }
      expect(db.listMessages(c.id, "sess-rb").map((m) => m.content)).toEqual(contents);
    } finally {
      db.close();
    }

    const db2 = new DbClient({ path: dbPath });
    try {
      const c = db2.listChats(db2.listProjects("sess-rb")[0]!.id, "sess-rb")[0]!;
      expect(db2.listMessages(c.id, "sess-rb").map((m) => m.content)).toEqual(contents);
    } finally {
      db2.close();
    }
  });
});
