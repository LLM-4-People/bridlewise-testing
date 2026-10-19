// @vitest-environment node
/**
 * Data loss #2: crash simulation — WAL mode means a crash (no close) does
 * NOT lose data. Split from data-loss-mechanical.test.ts for parallelism.
 */
import { describe, test, expect } from "vitest";
import { createTempDir } from "../helpers/temp-dir.ts";
import { DbClient } from "../../server/db/client.ts";
import { seedFullGraph } from "../helpers/data-loss-helpers.ts";
import { join } from "node:path";

describe("data loss #2: crash simulation (WAL — no clean close)", () => {
  test("data survives when the process is killed without db.close", () => {
    const dir = createTempDir("ch-data-loss-crash-");
    const dbPath = join(dir, "crash.db");
    const ids = (() => {
      const db = new DbClient({ path: dbPath });
      return seedFullGraph(db, "sess-crash");
      // INTENTIONALLY do NOT call db.close() — simulate a crash.
    })();
    const db2 = new DbClient({ path: dbPath });
    try {
      const p = db2.getProject(ids.project.id, "sess-crash");
      expect(p?.path).toBe("/home/example/loss-project");
      const msgs = db2.listMessages(ids.chat.id, "sess-crash");
      expect(msgs.length).toBe(2);
      expect(msgs[1]?.content).toBe("assistant msg before reboot");
      const tcs = db2.listToolCallsByChat(ids.chat.id, "sess-crash");
      expect(tcs[0]?.status).toBe("done");
    } finally { db2.close(); }
  });
});
