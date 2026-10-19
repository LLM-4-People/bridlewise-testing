// @vitest-environment node
/**
 * ARCHIVE, PROVE, THEN REMOVE — THE ONE DOOR THAT REMOVES CONVERSATIONS (UD-S15).
 *
 * The product path only trashes a conversation. `archiveConversations`
 * (`server/db/conversation-archive.ts`) is the maintenance shell's door to
 * remove trashed ones for good: the server proved stopped, a verified copy of
 * the database kept, every owned row (found through the schema's own foreign
 * keys, sealed fields as stored) written to one archive file, the file proved
 * whole against the database, and only then the removal — all or none.
 */
import { describe, expect, test, vi } from "vitest";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DbClient } from "../../server/db/client.ts";
import { archiveConversations, verifyConversationArchive } from "../../server/db/conversation-archive.ts";
import { preArchiveCopyPath } from "../../engine/src/filesystem/database-files.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { configureDebugSystem, createCollectingSink, resetDebugSystem } from "../../engine/src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../engine/src/shared/debug/debug-config.ts";

/** When set, the archive file is damaged right after it is written (a disk that lied, a torn write). */
const damage = vi.hoisted(() => ({ archive: false }));
vi.mock("../../engine/src/filesystem/atomic-write.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../engine/src/filesystem/atomic-write.ts")>();
  return {
    ...real,
    atomicWriteFile: (...args: Parameters<typeof real.atomicWriteFile>) => {
      const result = real.atomicWriteFile(...args);
      if (damage.archive && String(args[0]).endsWith(".jsonl")) appendFileSync(args[0], "{}\n");
      return result;
    },
  };
});

/** A database with two conversations owning rows in every owned table; the first is trashed. */
function seeded(dir: string) {
  const path = join(dir, "web.db");
  const db = new DbClient({ path });
  const user = db.createUser("archivist", "not-a-real-hash");
  const project = db.createProject({ name: "p", path: dir }, user.id);
  const chats = [0, 1].map((index) => {
    const chat = db.createChat({ project_id: project.id, title: `conversation ${String(index)}` }, user.id);
    for (let n = 0; n < 3; n += 1) {
      const message = db.createMessage({ chat_id: chat.id, role: n % 2 === 0 ? "user" : "assistant", content: `message ${String(n)} of ${String(index)}` }, user.id);
      db.createToolCall({ message_id: message.id, tool_name: "read_file", input: { path: "a.ts" }, status: "done" }, user.id);
    }
    db.createMetricsSnapshot({ chat_id: chat.id, snapshot: { tokens: index } }, user.id);
    return chat;
  });
  db.deleteChat(chats[0]!.id, user.id);
  const rowsOf = (id: string) => db.conversationRows([id], user.id);
  const snapshot = { trashed: rowsOf(chats[0]!.id), live: rowsOf(chats[1]!.id) };
  db.close();
  return { path, user, chats, snapshot };
}

describe("the conversation archive", () => {
  test("a trashed conversation is archived whole, proved, then removed with everything it owned; the live one is untouched", () => {
    const dir = createTempDir("conversation-archive-");
    const { path, user, chats, snapshot } = seeded(dir);
    const result = archiveConversations({ dbPath: path, chatIds: [chats[0]!.id], now: () => new Date("2026-10-02T00:00:00.000Z") });
    expect(result.archived).toEqual({ chats: 1, messages: 3, tool_calls: 3, metrics_snapshots: 1, auto_checks: 0, timeline_refs: 0 });
    expect(result.removed).toEqual(result.archived);
    expect(result.archive).toBe(join(`${path}.archive`, "conversations-2026-10-02T00-00-00-000Z.jsonl"));
    expect(statSync(result.archive).mode & 0o777).toBe(0o600);
    // The archive proves itself against the rows as they were (sealed fields as stored).
    expect(verifyConversationArchive(result.archive, snapshot.trashed)).toBe(result.digest);
    expect(readFileSync(result.archive, "utf8")).not.toContain("message 0 of 0");
    const db = new DbClient({ path });
    try {
      expect(db.conversationRows([chats[0]!.id], user.id).tables.every((entry) => entry.rows.length === 0), "nothing the conversation owned remains").toBe(true);
      expect(db.conversationRows([chats[1]!.id], user.id)).toEqual(snapshot.live);
      expect(db.listMessages(chats[1]!.id, user.id).map((message) => message.content)).toEqual(["message 0 of 1", "message 1 of 1", "message 2 of 1"]);
    } finally { db.close(); }
    // The database as it stood is kept, verified, beside it — and still holds the conversation.
    const copy = new DbClient({ path: preArchiveCopyPath(path) });
    try { expect(copy.conversationRows([chats[0]!.id], user.id)).toEqual(snapshot.trashed); } finally { copy.close(); }
  });

  test("a conversation that is not in the recycle bin is refused and nothing is removed", () => {
    const dir = createTempDir("conversation-archive-live-");
    const { path, user, chats, snapshot } = seeded(dir);
    expect(() => archiveConversations({ dbPath: path, chatIds: [chats[0]!.id, chats[1]!.id] })).toThrow(expect.objectContaining({ code: "db_archive_not_trashed" }));
    const db = new DbClient({ path });
    try {
      expect(db.conversationRows([chats[0]!.id], user.id)).toEqual(snapshot.trashed);
      // Another user's client cannot read or remove them (the one-owner scope).
      expect(db.conversationRows([chats[0]!.id], "another-user").tables.every((entry) => entry.rows.length === 0)).toBe(true);
      expect(() => db.purgeConversations([chats[0]!.id], "another-user")).toThrow(expect.objectContaining({ code: "db_purge_not_trashed" }));
    } finally { db.close(); }
    expect(() => archiveConversations({ dbPath: path, chatIds: [] })).toThrow(expect.objectContaining({ code: "db_archive_chats_invalid" }));
    expect(() => archiveConversations({ dbPath: path, chatIds: [chats[0]!.id, chats[0]!.id] })).toThrow(expect.objectContaining({ code: "db_archive_chats_invalid" }));
  });

  test("a database another process holds (a running server) is refused before anything is copied or changed", () => {
    const dir = createTempDir("conversation-archive-busy-");
    const { path, user, chats } = seeded(dir);
    const server = new DbClient({ path });
    try {
      expect(() => archiveConversations({ dbPath: path, chatIds: [chats[0]!.id] })).toThrow(expect.objectContaining({ code: "db_archive_database_busy" }));
      expect(() => statSync(preArchiveCopyPath(path))).toThrow(expect.objectContaining({ code: "ENOENT" }));
      expect(server.conversationRows([chats[0]!.id], user.id).tables[0]!.rows).toHaveLength(1);
    } finally { server.close(); }
  });

  test("an archive that does not prove whole is never followed by a removal (step 5 before step 6)", () => {
    const dir = createTempDir("conversation-archive-damaged-");
    const { path, user, chats, snapshot } = seeded(dir);
    damage.archive = true;
    try {
      expect(() => archiveConversations({ dbPath: path, chatIds: [chats[0]!.id] })).toThrow(expect.objectContaining({ code: "db_archive_unverified" }));
    } finally { damage.archive = false; }
    const db = new DbClient({ path });
    try { expect(db.conversationRows([chats[0]!.id], user.id), "nothing was removed").toEqual(snapshot.trashed); } finally { db.close(); }
  });

  test("the removal is an AUDIT event (the always-recorded floor), naming the archive and its digest", () => {
    const dir = createTempDir("conversation-archive-audit-");
    const { path, chats } = seeded(dir);
    const sink = createCollectingSink();
    configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, enabled: false, sinks: { ...DEBUG_CONFIG_DEFAULTS.sinks, enabledSinks: ["collecting"] } }, [sink]);
    try {
      const result = archiveConversations({ dbPath: path, chatIds: [chats[0]!.id] });
      const audits = sink.events.filter((event) => event.kind === "audit" && event.category === "database.conversations.archived");
      expect(audits).toHaveLength(1);
      expect(audits[0]!.context).toMatchObject({ archive: result.archive, digest: result.digest, conversations: 1 });
    } finally { resetDebugSystem(); }
  });

  test("an archive whose bytes changed does not verify", () => {
    const dir = createTempDir("conversation-archive-tamper-");
    const { path, chats, snapshot } = seeded(dir);
    const result = archiveConversations({ dbPath: path, chatIds: [chats[0]!.id] });
    const text = readFileSync(result.archive, "utf8");
    const tampered = join(dir, "tampered.jsonl");
    expect(text).toContain('"table":"messages"');
    writeFileSync(tampered, text.replace('"table":"messages"', '"table":"messagez"'));
    expect(() => verifyConversationArchive(tampered, snapshot.trashed)).toThrow(expect.objectContaining({ code: "db_archive_unverified" }));
    const truncated = join(dir, "truncated.jsonl");
    writeFileSync(truncated, text.split("\n").slice(0, 3).join("\n"));
    expect(() => verifyConversationArchive(truncated, snapshot.trashed)).toThrow(expect.objectContaining({ code: "db_archive_unverified" }));
  });
});
