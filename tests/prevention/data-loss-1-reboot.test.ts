// @vitest-environment node
/**
 * Data loss #1: reboot persistence — all data types survive a clean
 * close + brand-new DbClient. Split from data-loss-mechanical.test.ts so
 * the eight scenarios run in parallel instead of sequentially (4s → ~0.5s).
 */
import { describe, test, expect } from "vitest";
import { createTempDir } from "../helpers/temp-dir.ts";
import { DbClient } from "../../server/db/client.ts";
import { seedFullGraph } from "../helpers/data-loss-helpers.ts";
import { join } from "node:path";

describe("data loss #1: reboot persistence (all data types)", () => {
  test("all entity types survive a clean close + brand-new DbClient", () => {
    const dir = createTempDir("ch-data-loss-reboot-");
    const dbPath = join(dir, "reboot.db");
    const ids = (() => {
      const db = new DbClient({ path: dbPath });
      try { return seedFullGraph(db, "sess-1"); } finally { db.close(); }
    })();
    const db2 = new DbClient({ path: dbPath });
    try {
      const p = db2.getProject(ids.project.id, "sess-1");
      expect(p?.name).toBe("loss-test");
      expect(p?.path).toBe("/home/example/loss-project");
      expect(p?.user_id).toBe("sess-1");
      const chats = db2.listChats(ids.project.id, "sess-1");
      expect(chats[0]?.title).toBe("loss chat");
      expect(chats[0]?.model_id).toBe("gemma-4-31b");
      const msgs = db2.listMessages(ids.chat.id, "sess-1");
      expect(msgs.map((m) => m.content)).toEqual(["user msg before reboot", "assistant msg before reboot"]);
      expect(msgs[1]?.run_id).toBe("run-loss-1");
      const meta = msgs[1]?.metadata as Record<string, unknown> | null;
      expect(meta?.reasoning).toBe("thinking");
      const tcs = db2.listToolCallsByChat(ids.chat.id, "sess-1");
      expect(tcs[0]?.tool_name).toBe("read_file");
      expect(tcs[0]?.status).toBe("done");
      expect(tcs[0]?.duration_ms).toBe(7);
      const tcOut = tcs[0]?.output as Record<string, unknown>;
      expect(tcOut?.ok).toBe(true);
      const snaps = db2.listMetricsSnapshots(ids.chat.id, "sess-1");
      expect((snaps[0]?.snapshot as Record<string, number>).totalTokens).toBe(15);
      const checks = db2.listAutoChecksByChat(ids.chat.id, "sess-1");
      expect(checks[0]?.check_name).toBe("typecheck");
      expect(checks[0]?.status).toBe("passed");
      const refs = db2.listTimelineRefs(ids.chat.id, "sess-1");
      expect(refs[0]?.event_id).toBe("evt-1");
      expect((refs[0]?.metadata as Record<string, unknown>).runId).toBe("run-loss-1");
    } finally { db2.close(); }
  });
});
