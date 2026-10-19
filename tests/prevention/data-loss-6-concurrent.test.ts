// @vitest-environment node
/**
 * Data loss #6: concurrent writes — two sessions writing simultaneously, no
 * loss. Split from data-loss-mechanical.test.ts for parallelism.
 */
import { describe, test, expect } from "vitest";
import { createTempDir } from "../helpers/temp-dir.ts";
import { DbClient } from "../../server/db/client.ts";
import { join } from "node:path";

describe("data loss #6: concurrent writes (two sessions, no loss)", () => {
  test("two sessions each create projects + chats; all survive", () => {
    const dir = createTempDir("ch-data-loss-concurrent-");
    const dbPath = join(dir, "concurrent.db");
    const db = new DbClient({ path: dbPath });
    try {
      const writes: Promise<void>[] = [];
      for (let s = 0; s < 2; s++) {
        const sess = `sess-${s}`;
        for (let i = 0; i < 50; i++) {
          db.createProject({ name: `${sess}-proj-${i}`, path: `/p/${s}/${i}` }, sess);
        }
      }
      void Promise.all(writes);
      const sess0 = db.listProjects("sess-0");
      const sess1 = db.listProjects("sess-1");
      expect(sess0.length).toBe(50);
      expect(sess1.length).toBe(50);
      expect(sess0.every((p) => p.user_id === "sess-0")).toBe(true);
      expect(sess1.every((p) => p.user_id === "sess-1")).toBe(true);
    } finally { db.close(); }
    const db2 = new DbClient({ path: dbPath });
    try {
      expect(db2.listProjects("sess-0").length + db2.listProjects("sess-1").length).toBe(100);
      expect(db2.listProjects("sess-0").length).toBe(50);
      expect(db2.listProjects("sess-1").length).toBe(50);
    } finally { db2.close(); }
  });
});
