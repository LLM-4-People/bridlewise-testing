// @vitest-environment node
/**
 * Migration 19 — the stored MCP tool names a later run READS BACK move from
 * the retired `mcp:<server>:<tool>` spelling (not a legal Responses function
 * name) to the naming owner's `mcp__<server>__<tool>`, once, with the real
 * field encryption in place: per-user tool switches (`tool_settings`, plain),
 * the tool-call history replayed to the model (`tool_calls.tool_name`,
 * encrypted JSON) and its display derivative (`public_projection.toolName`,
 * encrypted JSON). Built-in names, and names whose server id the owner no
 * longer accepts, are left exactly as they were.
 *
 * FROZEN: the expected names are LITERALS, never computed by the live naming
 * owner — the migration carries its own copy of the v19 rule, and this file
 * pins it, so a later change to `engine/src/mcp/tool-name.ts` cannot change
 * what a database migrated tomorrow receives. The runner's generic guards
 * are measured here too: the pre-upgrade copy and the newer-schema refusal.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createKeyHome, createTempDir } from "../helpers/temp-dir.ts";
import { runMigrations } from "../../server/db/migrations.ts";
import { createDbCrypto, UNBOUND } from "../../server/db/db-crypto.ts";

/** v19's own names for the fixture's pairs — literals (see the header). */
const GOLDEN = {
  "mcp:srv:admin.tools.list": "mcp__srv__admin_tools_list_ab37440b",
  "mcp:fs:read_file": "mcp__fs__read_file",
} as const;
/** An over-long tool name: sanitised, cut, and tagged to exactly 128 characters. */
const LONG_OLD = `mcp:srv:${"t".repeat(200)}`;
const LONG_GOLDEN = `mcp__srv__${"t".repeat(109)}_2c271fbc`;

const CREATED = "2026-09-28T00:00:00Z";

describe("migration 19: MCP tool names", () => {
  it("renames the retired spelling in switches, call history and projections — and nothing else", () => {
    const dir = createTempDir("mcp-name-migration-");
    const dbPath = join(dir, "harness.db");
    const crypto = createDbCrypto({ dbPath });
    const db = new DatabaseSync(dbPath);
    try {
      expect(runMigrations(db, 18, crypto)).toBe(18);
      // The rows' parents (message, chat, project) are not this migration's
      // subject; the fixture plants only the rows it renames.
      db.exec("PRAGMA foreign_keys = OFF");
      const setting = db.prepare("INSERT INTO tool_settings (id, user_id, tool_name, enabled, config, updated_at) VALUES (?, 'u1', ?, 0, NULL, ?)");
      setting.run("s1", "mcp:fs:read_file", CREATED);
      setting.run("s2", "read_file", CREATED);
      setting.run("s3", "mcp:old_srv:x", CREATED);
      const call = db.prepare("INSERT INTO tool_calls (id, message_id, tool_name, public_projection, input, status, created_at) VALUES (?, 'm1', ?, ?, ?, 'done', ?)");
      const encrypted = (value: unknown): string => crypto.encryptField(JSON.stringify(value), UNBOUND)!;
      call.run("c1", encrypted("mcp:srv:admin.tools.list"), encrypted({ observationKey: "k1", toolName: "mcp:srv:admin.tools.list", input: {}, output: null }), encrypted({}), CREATED);
      call.run("c2", encrypted("edit"), null, encrypted({}), CREATED);

      expect(runMigrations(db, 19, crypto)).toBe(19);

      const settings = new Map((db.prepare("SELECT id, tool_name FROM tool_settings").all() as { id: string; tool_name: string }[]).map((r) => [r.id, r.tool_name]));
      expect(settings.get("s1")).toBe(GOLDEN["mcp:fs:read_file"]);
      expect(settings.get("s2"), "a built-in switch is untouched").toBe("read_file");
      expect(settings.get("s3"), "a server id the owner refuses can own no tool — left, never guessed").toBe("mcp:old_srv:x");
      const decrypted = (raw: string | null): unknown => (raw === null ? null : JSON.parse(crypto.decryptField(raw, UNBOUND)!));
      const calls = new Map((db.prepare("SELECT id, tool_name, public_projection FROM tool_calls").all() as { id: string; tool_name: string; public_projection: string | null }[]).map((r) => [r.id, r]));
      expect(calls.get("c1")!.tool_name.startsWith("enc:"), "the renamed name is stored encrypted").toBe(true);
      expect(decrypted(calls.get("c1")!.tool_name)).toBe(GOLDEN["mcp:srv:admin.tools.list"]);
      expect(decrypted(calls.get("c1")!.public_projection)).toEqual({ observationKey: "k1", toolName: GOLDEN["mcp:srv:admin.tools.list"], input: {}, output: null });
      expect(decrypted(calls.get("c2")!.tool_name), "a built-in call is untouched").toBe("edit");
      expect(calls.get("c2")!.public_projection).toBeNull();
    } finally {
      db.close();
    }
  });

  it("renames across batches (more rows than one batch), including a name the digest truncates to 128 characters", () => {
    const dir = createTempDir("mcp-name-migration-batches-");
    const dbPath = join(dir, "harness.db");
    const crypto = createDbCrypto({ dbPath });
    const db = new DatabaseSync(dbPath);
    try {
      expect(runMigrations(db, 18, crypto)).toBe(18);
      db.exec("PRAGMA foreign_keys = OFF");
      const call = db.prepare("INSERT INTO tool_calls (id, message_id, tool_name, public_projection, input, status, created_at) VALUES (?, 'm1', ?, NULL, ?, 'done', ?)");
      const encrypted = (value: unknown): string => crypto.encryptField(JSON.stringify(value), UNBOUND)!;
      const rows = 1234;
      // The seed is ONE transaction: 1234 autocommitted inserts are 1234
      // journal fsyncs — 138 ms on a tmpfs, past the 30 s test timeout on a
      // disk temp root. The migration under test still meets 1234 rows.
      db.exec("BEGIN");
      for (let i = 0; i < rows; i++) call.run(`c${i}`, encrypted(i % 2 === 0 ? LONG_OLD : "edit"), encrypted({}), CREATED);
      db.exec("COMMIT");
      expect(runMigrations(db, 19, crypto)).toBe(19);
      const names = (db.prepare("SELECT tool_name FROM tool_calls ORDER BY rowid").all() as { tool_name: string }[])
        .map((r) => JSON.parse(crypto.decryptField(r.tool_name, UNBOUND)!) as string);
      expect(names.filter((n) => n === LONG_GOLDEN).length).toBe(rows / 2);
      expect(names.filter((n) => n === "edit").length).toBe(rows / 2);
      expect(LONG_GOLDEN.length).toBe(128);
    } finally {
      db.close();
    }
  });

  it("copies a file database before its first pending migration, and refuses a database newer than this code", () => {
    const dir = createTempDir("mcp-name-migration-backup-");
    const dbPath = join(dir, "harness.db");
    const crypto = createDbCrypto({ dbPath });
    const db = new DatabaseSync(dbPath);
    try {
      expect(runMigrations(db, 18, crypto)).toBe(18);
      expect(existsSync(`${dbPath}.pre-v19`), "no copy while nothing is pending").toBe(false);
      expect(runMigrations(db, 19, crypto)).toBe(19);
      expect(existsSync(`${dbPath}.pre-v19`), "the pre-upgrade copy exists").toBe(true);
      expect(statSync(`${dbPath}.pre-v19`).mode & 0o777).toBe(0o600);
      const copy = new DatabaseSync(`${dbPath}.pre-v19`, { readOnly: true });
      try {
        expect((copy.prepare("SELECT max(version) AS v FROM schema_version").get() as { v: number }).v, "the copy is the state BEFORE the upgrade").toBe(18);
      } finally {
        copy.close();
      }
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(999, CREATED);
      expect(() => runMigrations(db, undefined, crypto)).toThrow(expect.objectContaining({ code: "db_schema_newer" }));
    } finally {
      db.close();
    }
  });

  it("never bricks boot: a rename collision keeps the later row's old name, an unreadable row is kept, and ONLY an all-unreadable table (a wrong key) is refused typed", () => {
    const dir = createTempDir("mcp-name-migration-robust-");
    const dbPath = join(dir, "harness.db");
    const crypto = createDbCrypto({ dbPath });
    const db = new DatabaseSync(dbPath);
    try {
      expect(runMigrations(db, 18, crypto)).toBe(18);
      db.exec("PRAGMA foreign_keys = OFF");
      // v19's plain and digest spaces overlap: both map to mcp__srv__foo_bar_70bdbd8f (secb SECB-V-5).
      const setting = db.prepare("INSERT INTO tool_settings (id, user_id, tool_name, enabled, config, updated_at) VALUES (?, 'u1', ?, 0, NULL, ?)");
      setting.run("s1", "mcp:srv:foo.bar", CREATED);
      setting.run("s2", "mcp:srv:foo_bar_70bdbd8f", CREATED);
      const call = db.prepare("INSERT INTO tool_calls (id, message_id, tool_name, public_projection, input, status, created_at) VALUES (?, 'm1', ?, NULL, ?, 'done', ?)");
      const encrypted = (value: unknown): string => crypto.encryptField(JSON.stringify(value), UNBOUND)!;
      call.run("good", encrypted("mcp:fs:read_file"), encrypted({}), CREATED);
      call.run("bad", "enc:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", encrypted({}), CREATED);

      expect(runMigrations(db, 19, crypto)).toBe(19);
      const settings = (db.prepare("SELECT id, tool_name FROM tool_settings ORDER BY id").all() as { id: string; tool_name: string }[]).map((r) => r.tool_name);
      expect(settings).toEqual(["mcp__srv__foo_bar_70bdbd8f", "mcp:srv:foo_bar_70bdbd8f"]);
      const calls = new Map((db.prepare("SELECT id, tool_name FROM tool_calls").all() as { id: string; tool_name: string }[]).map((r) => [r.id, r.tool_name]));
      expect(JSON.parse(crypto.decryptField(calls.get("good")!, UNBOUND)!)).toBe("mcp__fs__read_file");
      expect(calls.get("bad"), "an unreadable row is kept exactly as it was").toBe("enc:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    } finally {
      db.close();
    }
    // A table where NOTHING can be read: the key is not this database's.
    const wrongDir = createTempDir("mcp-name-migration-wrong-key-");
    const wrongPath = join(wrongDir, "harness.db");
    const writer = createDbCrypto({ dbPath: wrongPath });
    const other = createDbCrypto({ dbPath: wrongPath, keyHome: createKeyHome("mcp-name-migration-other-key-") });
    const wrong = new DatabaseSync(wrongPath);
    try {
      expect(runMigrations(wrong, 18, writer)).toBe(18);
      wrong.exec("PRAGMA foreign_keys = OFF");
      wrong.prepare("INSERT INTO tool_calls (id, message_id, tool_name, public_projection, input, status, created_at) VALUES ('c', 'm1', ?, NULL, ?, 'done', ?)")
        .run(writer.encryptField(JSON.stringify("mcp:fs:read_file"), UNBOUND)!, writer.encryptField("{}", UNBOUND)!, CREATED);
      expect(() => runMigrations(wrong, 19, other)).toThrow(expect.objectContaining({ code: "db_migration_undecodable" }));
      expect((wrong.prepare("SELECT max(version) AS v FROM schema_version").get() as { v: number }).v, "nothing was changed").toBe(18);
    } finally {
      wrong.close();
    }
  });

  it("the pre-upgrade copy is always fresh and verified, never written through a link, and retained two deep", () => {
    const dir = createTempDir("mcp-name-migration-copy-");
    const dbPath = join(dir, "harness.db");
    const crypto = createDbCrypto({ dbPath });
    const db = new DatabaseSync(dbPath);
    try {
      expect(runMigrations(db, 18, crypto)).toBe(18);
      // A LINK at the copy's name: refused, and nothing reaches its target.
      const elsewhere = join(dir, "elsewhere.db");
      symlinkSync(elsewhere, `${dbPath}.pre-v19`);
      expect(() => runMigrations(db, 19, crypto)).toThrow(expect.objectContaining({ code: "db_backup_path_unsafe" }));
      expect(existsSync(elsewhere), "the link was not followed").toBe(false);
      rmSync(`${dbPath}.pre-v19`);
      // An EMPTY file at the name (a crashed copy): replaced by a verified one, not trusted.
      writeFileSync(`${dbPath}.pre-v19`, "");
      // Older copies beyond the retention (2): purged once the new copy is in place.
      writeFileSync(`${dbPath}.pre-v10`, "old");
      writeFileSync(`${dbPath}.pre-v11`, "old");
      expect(runMigrations(db, 19, crypto)).toBe(19);
      expect(statSync(`${dbPath}.pre-v19`).size, "a real copy, not the empty file").toBeGreaterThan(0);
      expect(statSync(`${dbPath}.pre-v19`).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir).filter((name) => name.includes(".pre-v")).sort()).toEqual(["harness.db.pre-v11", "harness.db.pre-v19"]);
      expect(readdirSync(dir).filter((name) => name.includes(".staging")), "no staging residue").toEqual([]);
    } finally {
      db.close();
    }
  });
});
