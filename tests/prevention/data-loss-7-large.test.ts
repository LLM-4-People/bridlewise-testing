// @vitest-environment node
/**
 * Data loss #7: large data — 10 000 messages + 1 000 tool calls survive a
 * reboot. Split from data-loss-mechanical.test.ts for parallelism.
 *
 * This is the heaviest scenario (11 000 individual INSERTs). It runs as its
 * own file so it parallels with the other seven instead of serializing them.
 */
import { describe, test, expect } from "vitest";
import { createTempDir } from "../helpers/temp-dir.ts";
import { DbClient } from "../../server/db/client.ts";
import { createNoopDbCrypto } from "../helpers/data-loss-helpers.ts";
import { join } from "node:path";

describe("data loss #7: large data (10 000 messages, 1 000 tool calls)", () => {
  test("large volume survives a reboot with exact counts", () => {
    const dir = createTempDir("ch-data-loss-large-");
    const dbPath = join(dir, "large.db");
    // The volume test stresses the DB layer with 11 000 rows — the invariant
    // is DURABILITY of large data across a reboot, not encryption (the
    // crypto-durability of encrypted data is covered by data-loss-1/2 with
    // real crypto + small volumes). Using a no-op crypto here removes the
    // per-row AES-256-GCM overhead (11k encrypt + 10k decrypt ≈ 1s) that is
    // orthogonal to the volume-durability invariant. The test still uses a
    // real SQLite file + a real reboot (second DbClient on the same file).
    const crypto = createNoopDbCrypto();
    const MSGS = 10_000;
    const TCS = 1_000;
    {
      const db = new DbClient({ path: dbPath, crypto });
      try {
        const p = db.createProject({ name: "big", path: "/big" }, "sess-big");
        const c = db.createChat({ project_id: p.id, title: "big chat" }, "sess-big");
        // Batch the 11 000 INSERTs into ONE transaction (10–50× faster than
        // 11 000 auto-commits — one fsync at COMMIT instead of 11 000). The
        // invariant (data survives reboot with exact counts) is preserved:
        // the transaction commits before the block closes, so the data is
        // durable on disk before the second DbClient opens the file.
        db.withTransaction(() => {
          for (let i = 0; i < MSGS; i++) {
            db.createMessage({ chat_id: c.id, role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i}` }, "sess-big");
          }
        });
        const msgs = db.listMessages(c.id, "sess-big");
        db.withTransaction(() => {
          for (let i = 0; i < TCS; i++) {
            db.createToolCall({ message_id: msgs[i]!.id, tool_name: "read_file", input: { i }, status: "done" }, "sess-big");
          }
        });
        expect(db.listMessages(c.id, "sess-big").length).toBe(MSGS);
        expect(db.listToolCallsByChat(c.id, "sess-big").length).toBe(TCS);
      } finally { db.close(); }
    }
    {
      const db = new DbClient({ path: dbPath, crypto });
      try {
        const p = db.listProjects("sess-big")[0]!;
        const c = db.listChats(p.id, "sess-big")[0]!;
        const msgs = db.listMessages(c.id, "sess-big");
        expect(msgs.length).toBe(MSGS);
        expect(msgs[0]?.content).toBe("msg-0");
        expect(msgs[MSGS - 1]?.content).toBe(`msg-${MSGS - 1}`);
        expect(db.listToolCallsByChat(c.id, "sess-big").length).toBe(TCS);
        const tcs = db.listToolCallsByChat(c.id, "sess-big");
        const tcInput = tcs[500]!.input as Record<string, number>;
        expect(tcInput.i).toBe(500);
      } finally { db.close(); }
    }
  });
});
