// @vitest-environment node
/**
 * Recycle bin: trash is a timestamp. The conversation record cannot be
 * DELETE FROM — SQLite BEFORE DELETE triggers abort it. Live lists hide
 * trashed rows; restore clears the timestamp; files on disk stay.
 */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DbClient } from "../../server/db/client.ts";
import {
  UNDELETABLE_TABLES,
  refuseDeleteTriggerName,
} from "../../server/db/schema.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { bodySays, functionBody } from "../helpers/function-scope.ts";
import { read } from "../helpers/source-scan.ts";
import { modulePathMatching } from "../helpers/module-resolver.ts";

function sqliteOf(db: DbClient): DatabaseSync {
  return (db as unknown as { db: DatabaseSync }).db;
}

describe("recycle bin — trash is hide, not delete", () => {
  test("trashing a project keeps the row and the folder; live lists hide it", () => {
    const folder = createTempDir("recycle-project-");
    writeFileSync(join(folder, "keep.ts"), "export {}\n");
    const dbDir = createTempDir("recycle-db-");
    const db = new DbClient({ path: join(dbDir, "test.db") });
    try {
      const project = db.createProject({ name: "Keep Me", path: folder }, "u1");
      const chat = db.createChat({ project_id: project.id, title: "talk" }, "u1");
      expect(db.deleteProject(project.id, "u1")).toBe(true);
      expect(db.listProjects("u1")).toEqual([]);
      expect(db.getProject(project.id, "u1")).toBeNull();
      expect(existsSync(join(folder, "keep.ts"))).toBe(true);
      const trash = db.listTrash("u1");
      expect(trash.projects.map((p) => p.id)).toEqual([project.id]);
      expect(trash.chats.map((c) => c.id), "a trashed project covers its chats").toEqual([]);
      const restored = db.restoreProject(project.id, "u1");
      expect(restored?.id).toBe(project.id);
      expect(db.listProjects("u1").map((p) => p.id)).toEqual([project.id]);
      expect(db.listChats(project.id, "u1").map((c) => c.id)).toEqual([chat.id]);
    } finally {
      db.close();
    }
  });

  test("trashing a conversation hides it; restore brings it back with its project live", () => {
    const db = new DbClient({ path: ":memory:" });
    try {
      const project = db.createProject({ name: "P", path: "/tmp/p" }, "u1");
      const chat = db.createChat({ project_id: project.id, title: "gone?" }, "u1");
      expect(db.deleteChat(chat.id, "u1")).toBe(true);
      expect(db.listChats(project.id, "u1")).toEqual([]);
      expect(db.getChat(chat.id, "u1")).toBeNull();
      expect(db.listTrash("u1").chats.map((c) => c.id)).toEqual([chat.id]);
      expect(db.restoreChat(chat.id, "u1")?.id).toBe(chat.id);
      expect(db.listChats(project.id, "u1").map((c) => c.id)).toEqual([chat.id]);
    } finally {
      db.close();
    }
  });

  test("deleteProject / deleteChat must not DELETE FROM the row", () => {
    const src = read(modulePathMatching("server/db/client.ts"));
    const project = functionBody(src, "deleteProject", "deleteProject");
    const chat = functionBody(src, "deleteChat", "deleteChat");
    expect(bodySays(project, "trashed_at")).toBe(true);
    expect(bodySays(project, "DELETE FROM")).toBe(false);
    expect(bodySays(chat, "trashed_at")).toBe(true);
    expect(bodySays(chat, "DELETE FROM")).toBe(false);
  });

  test("mutation: a hard DELETE FROM is caught", () => {
    expect(/DELETE FROM projects/.test("UPDATE projects SET trashed_at")).toBe(false);
    expect(/DELETE FROM projects/.test("DELETE FROM projects WHERE id = ?")).toBe(true);
  });

  test("createChat refuses a trashed project — live parent only", () => {
    const db = new DbClient({ path: ":memory:" });
    try {
      const project = db.createProject({ name: "P", path: "/tmp/p" }, "u1");
      expect(db.deleteProject(project.id, "u1")).toBe(true);
      expect(() => db.createChat({ project_id: project.id, title: "nope" }, "u1")).toThrow(
        expect.objectContaining({ code: "chat_parent_not_owned" }),
      );
      expect(db.listTrash("u1").chats).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("the engine aborts DELETE FROM every conversation-record table", () => {
    const db = new DbClient({ path: ":memory:" });
    try {
      const project = db.createProject({ name: "Keep", path: "/tmp/keep" }, "u1");
      const chat = db.createChat({ project_id: project.id, title: "talk" }, "u1");
      const message = db.createMessage({ chat_id: chat.id, role: "user", content: "hi" }, "u1");
      db.createToolCall({ message_id: message.id, tool_name: "t", input: {}, status: "done" }, "u1");
      db.createTimelineRef({
        chat_id: chat.id,
        event_id: "e1",
        event_type: "tool",
        timestamp: new Date().toISOString(),
        metadata: {},
      }, "u1");
      db.createMetricsSnapshot({ chat_id: chat.id, snapshot: { n: 1 } }, "u1");
      db.createAutoCheck({
        project_id: project.id,
        chat_id: chat.id,
        check_name: "lint",
        status: "passed",
        output: "ok",
      }, "u1");
      const sqlite = sqliteOf(db);
      sqlite
        .prepare("INSERT INTO run_executions (run_id, user_id, claimed_at) VALUES (?, ?, ?)")
        .run("run-keep", "u1", new Date().toISOString());

      const countsBefore: Record<string, number> = {};
      for (const table of UNDELETABLE_TABLES) {
        const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        countsBefore[table] = Number(row.n);
        expect(countsBefore[table], table).toBeGreaterThan(0);
        expect(() => sqlite.exec(`DELETE FROM ${table}`), table).toThrow(/never deleted/);
        const after = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        expect(Number(after.n), `${table} still has its rows`).toBe(countsBefore[table]);
      }
      expect(db.getChat(chat.id, "u1")?.id).toBe(chat.id);
      expect(db.getProject(project.id, "u1")?.id).toBe(project.id);
    } finally {
      db.close();
    }
  });

  test("every undeletable table has a refuse_delete trigger", () => {
    const db = new DbClient({ path: ":memory:" });
    try {
      const sqlite = sqliteOf(db);
      const rows = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'refuse_delete_%' ORDER BY name",
        )
        .all() as unknown as ReadonlyArray<{ name: string }>;
      expect(rows.map((r) => r.name)).toEqual(
        [...UNDELETABLE_TABLES].map(refuseDeleteTriggerName).sort(),
      );
    } finally {
      db.close();
    }
  });

  test("DbClient has no DELETE FROM of the conversation record outside the one archive door", () => {
    const src = read(modulePathMatching("server/db/client.ts"));
    // The ONE exception (UD-S15): `purgeConversations`, which the conversation
    // archive calls after a verified archive of every row it removes.
    const purge = functionBody(src, "purgeConversations", "purgeConversations");
    const outside = src.slice(0, purge.offset) + src.slice(purge.offset + purge.body.length);
    for (const table of UNDELETABLE_TABLES) {
      expect(outside, table).not.toMatch(new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, "i"));
      expect(outside, `${table}: only the archive door lifts the refusal`).not.toContain("DROP TRIGGER");
    }
    expect(bodySays(purge, "DELETE FROM chats WHERE id IN (SELECT value FROM json_each(?)) AND trashed_at IS NOT NULL AND project_id IN"), "the user's trashed conversations only").toBe(true);
  });
});
