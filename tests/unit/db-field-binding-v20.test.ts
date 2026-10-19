// @vitest-environment node
/**
 * MIGRATION 20 IS A FACT ABOUT THE PAST, AND NEVER A RE-BINDING SOURCE
 * (secc-design H1, secc-security SECC-V-A2):
 *   - it seals with its OWN frozen column list and binding; the golden bytes
 *     are pinned, and they equal the live binding while the live format is
 *     still `bw-field-v1` (a live column the frozen list lacks fails here);
 *   - it is idempotent (a database already bound is left as it is);
 *   - an unbound value in a database that already holds bound ones was put
 *     there later (a pre-v20 copy's ciphertext, the version lowered by an
 *     edit): refused, nothing changed;
 *   - no migration body imports the live list or the live binding, and no
 *     writer moves a row's parent after it was sealed.
 */
import { describe, expect, test } from "vitest";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createTempDir } from "../helpers/temp-dir.ts";
import { preBindingCrypto } from "../helpers/data-loss-helpers.ts";
import { DbClient } from "../../server/db/client.ts";
import { createDbCrypto, ENCRYPTED_COLUMNS, fieldBinding, UNBOUND, type EncryptedColumn, type EncryptedTable } from "../../server/db/db-crypto.ts";
import { runMigrations, v20Binding } from "../../server/db/migrations.ts";
import { BOUND_FIELDS_SCHEMA_VERSION } from "../../server/db/schema.ts";

const OWNER = "v20-owner";

describe("migration 20's frozen binding", () => {
  test("the golden bytes are pinned and equal the live binding for every live encrypted column", () => {
    expect(v20Binding("messages", "content", "m1", "u1", ["c1"])).toBe('["bw-field-v1","messages","content","m1","u1","c1"]');
    expect(v20Binding("auto_checks", "output", "a1", "u1", ["p1", null])).toBe('["bw-field-v1","auto_checks","output","a1","u1","p1",null]');
    for (const [table, shape] of Object.entries(ENCRYPTED_COLUMNS) as [EncryptedTable, (typeof ENCRYPTED_COLUMNS)[EncryptedTable]][]) {
      const row: Record<string, string> = { [shape.key]: `${table}-key` };
      const parents = shape.parents.map((parent) => { row[parent] = `${table}-${parent}`; return row[parent]!; });
      for (const column of shape.columns) {
        expect(fieldBinding(table, column as EncryptedColumn<typeof table>, row, OWNER), `${table}.${column}`).toBe(v20Binding(table, column, row[shape.key]!, OWNER, parents));
      }
    }
  });

  test("it seals EVERY live encrypted column of every table (a live column the frozen list lacks stays unreadable here)", () => {
    const path = join(createTempDir("v20-coverage-"), "web.db");
    const crypto = createDbCrypto({ dbPath: path });
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      expect(runMigrations(db, BOUND_FIELDS_SCHEMA_VERSION - 1, crypto)).toBe(BOUND_FIELDS_SCHEMA_VERSION - 1);
      const now = "2026-09-28T00:00:00Z", seal = (text: string) => crypto.encryptField(text, UNBOUND);
      db.prepare("INSERT INTO users (id, username, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?, 1)").run(OWNER, "owner", seal("hash"), now);
      db.prepare("INSERT INTO projects (id, name, path, created_at, updated_at, config_overlay, user_id) VALUES ('p', ?, ?, ?, ?, ?, ?)").run(seal("n"), seal("/p"), now, now, seal("{}"), OWNER);
      db.prepare("INSERT INTO chats (id, project_id, title, created_at, updated_at) VALUES ('c', 'p', ?, ?, ?)").run(seal("t"), now, now);
      db.prepare("INSERT INTO messages (id, chat_id, role, content, created_at, metadata) VALUES ('m', 'c', 'user', ?, ?, ?)").run(seal("hello"), now, seal("{}"));
      db.prepare("INSERT INTO tool_calls (id, message_id, tool_name, call_id, public_projection, input, output, status, created_at) VALUES ('t', 'm', ?, ?, ?, ?, ?, 'done', ?)").run(seal('"read"'), seal('"id"'), seal("{}"), seal("{}"), seal('""'), now);
      db.prepare("INSERT INTO metrics_snapshots (id, chat_id, snapshot, created_at) VALUES ('s', 'c', ?, ?)").run(seal("{}"), now);
      db.prepare("INSERT INTO auto_checks (id, project_id, chat_id, check_name, status, output, created_at) VALUES ('a', 'p', 'c', 'lint', 'passed', ?, ?)").run(seal("{}"), now);
      db.prepare("INSERT INTO timeline_refs (id, chat_id, event_id, event_type, timestamp, metadata) VALUES ('r', 'c', 'e', 'x', ?, ?)").run(now, seal("{}"));
      db.prepare("INSERT INTO user_model_prefs (id, user_id, config_json, updated_at) VALUES ('mp', ?, ?, ?)").run(OWNER, seal("{}"), now);
      db.prepare("INSERT INTO user_prompt_prefs (id, user_id, prefs_json, updated_at) VALUES ('pp', ?, ?, ?)").run(OWNER, seal("{}"), now);
      expect(runMigrations(db, BOUND_FIELDS_SCHEMA_VERSION, crypto)).toBe(BOUND_FIELDS_SCHEMA_VERSION);
      let checked = 0;
      for (const [table, shape] of Object.entries(ENCRYPTED_COLUMNS) as [EncryptedTable, (typeof ENCRYPTED_COLUMNS)[EncryptedTable]][]) {
        const row = db.prepare(`SELECT * FROM ${table} LIMIT 1`).get() as Record<string, unknown>;
        for (const column of shape.columns) {
          expect(crypto.authenticates(row[column] as string, fieldBinding(table, column as EncryptedColumn<typeof table>, row, OWNER)), `${table}.${column}`).toBe(true);
          checked += 1;
        }
      }
      expect(checked).toBe(Object.values(ENCRYPTED_COLUMNS).reduce((sum, shape) => sum + shape.columns.length, 0));
    } finally { db.close(); }
  });
});

describe("migration 20 is idempotent and refuses to re-bind", () => {
  function upgradedDatabase(prefix: string): Readonly<{ dir: string; path: string; messageId: string; copy: string }> {
    const dir = createTempDir(prefix), path = join(dir, "web.db");
    const old = new DbClient({ path, schemaVersion: BOUND_FIELDS_SCHEMA_VERSION - 1, crypto: preBindingCrypto(path) });
    const project = old.createProject({ name: "p", path: "/p" }, OWNER);
    const chat = old.createChat({ project_id: project.id, title: "t" }, OWNER);
    const message = old.createMessage({ chat_id: chat.id, role: "user", content: "mine" }, OWNER);
    old.close();
    // Keep a pre-v20 copy (what a backup holds), then upgrade.
    const copy = join(dir, "pre-v20-copy.db");
    copyFileSync(path, copy);
    new DbClient({ path }).close();
    return { dir, path, messageId: message.id, copy };
  }

  test("re-running over an upgraded database changes nothing", () => {
    const { path, messageId } = upgradedDatabase("v20-idempotent-");
    const before = (new DatabaseSync(path, { readOnly: true })).prepare("SELECT content FROM messages WHERE id = ?").get(messageId) as { content: string };
    const raw = new DatabaseSync(path);
    raw.prepare("DELETE FROM schema_version WHERE version = ?").run(BOUND_FIELDS_SCHEMA_VERSION);
    raw.close();
    const db = new DbClient({ path });
    try {
      expect(db.schemaVersion).toBe(BOUND_FIELDS_SCHEMA_VERSION);
      expect(db.getMessage(messageId, OWNER)!.content).toBe("mine");
    } finally { db.close(); }
    const after = (new DatabaseSync(path, { readOnly: true })).prepare("SELECT content FROM messages WHERE id = ?").get(messageId) as { content: string };
    expect(after.content).toBe(before.content);
  });

  test("a pre-v20 copy's ciphertext planted into another user's row with the version lowered is REFUSED, not sealed to it", () => {
    const { path, copy, messageId } = upgradedDatabase("v20-rebind-");
    const bob = new DbClient({ path });
    const bobProject = bob.createProject({ name: "bob", path: "/bob" }, "bob");
    const bobChat = bob.createChat({ project_id: bobProject.id, title: "bob chat" }, "bob");
    const bobMessage = bob.createMessage({ chat_id: bobChat.id, role: "user", content: "bob's own" }, "bob");
    bob.close();
    const alicesOld = (new DatabaseSync(copy, { readOnly: true })).prepare("SELECT content FROM messages WHERE id = ?").get(messageId) as { content: string };
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE messages SET content = ? WHERE id = ?").run(alicesOld.content, bobMessage.id);
    raw.prepare("DELETE FROM schema_version WHERE version = ?").run(BOUND_FIELDS_SCHEMA_VERSION);
    raw.close();
    expect(() => new DbClient({ path })).toThrow(expect.objectContaining({ code: "db_migration_rebinding_refused" }));
    const unchanged = new DatabaseSync(path, { readOnly: true });
    try {
      expect((unchanged.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(BOUND_FIELDS_SCHEMA_VERSION - 1);
      expect((unchanged.prepare("SELECT content FROM messages WHERE id = ?").get(bobMessage.id) as { content: string }).content).toBe(alicesOld.content);
    } finally { unchanged.close(); }
  });
});

describe("the per-row proof lives outside the database (secd-security SECD-C1)", () => {
  function plantedDatabase(prefix: string): Readonly<{ path: string; bobMessage: string; alicesOld: string; record: string }> {
    const dir = createTempDir(prefix), path = join(dir, "web.db");
    const old = new DbClient({ path, schemaVersion: BOUND_FIELDS_SCHEMA_VERSION - 1, crypto: preBindingCrypto(path) });
    const project = old.createProject({ name: "p", path: "/p" }, OWNER);
    const chat = old.createChat({ project_id: project.id, title: "t" }, OWNER);
    const message = old.createMessage({ chat_id: chat.id, role: "user", content: "ALICE-SECRET-PRE-V20" }, OWNER);
    old.close();
    const copy = join(dir, "pre-v20-copy.db");
    copyFileSync(path, copy);
    const upgraded = new DbClient({ path });
    const record = createDbCrypto({ dbPath: path }).bindingRecord!;
    const bobProject = upgraded.createProject({ name: "bob", path: "/bob" }, "bob");
    const bobChat = upgraded.createChat({ project_id: bobProject.id, title: "bob chat" }, "bob");
    const bobMessage = upgraded.createMessage({ chat_id: bobChat.id, role: "user", content: "bob's own" }, "bob").id;
    upgraded.close();
    const alicesOld = ((new DatabaseSync(copy, { readOnly: true })).prepare("SELECT content FROM messages WHERE id = ?").get(message.id) as { content: string }).content;
    return { path, bobMessage, alicesOld, record };
  }

  test("the upgrade records, in the key home, that the key now seals bound fields", () => {
    const { record } = plantedDatabase("v20-record-");
    expect(existsSync(record)).toBe(true);
    expect(statSync(record).mode & 0o777).toBe(0o600);
  });

  test("BYPASS 1 — every bound value stashed away (the in-database count reads 0): the planted value is still REFUSED", () => {
    const { path, bobMessage, alicesOld } = plantedDatabase("v20-bypass-stash-");
    const raw = new DatabaseSync(path);
    // Every sealed value replaced by plaintext (stashed aside to be put back after): nothing bound is left to count.
    raw.exec("CREATE TABLE stash AS SELECT rowid AS r, content, metadata FROM messages");
    raw.exec("UPDATE messages SET content = 'x', metadata = NULL");
    for (const [table, columns] of [["projects", ["name", "path", "config_overlay"]], ["chats", ["title"]], ["users", ["password_hash"]]] as const) {
      raw.exec(`UPDATE ${table} SET ${columns.map((column) => `${column} = 'x'`).join(", ")}`);
    }
    raw.prepare("UPDATE messages SET content = ? WHERE id = ?").run(alicesOld, bobMessage);
    raw.prepare("DELETE FROM schema_version WHERE version = ?").run(BOUND_FIELDS_SCHEMA_VERSION);
    raw.close();
    expect(() => new DbClient({ path })).toThrow(expect.objectContaining({ code: "db_migration_rebinding_refused" }));
    const unchanged = new DatabaseSync(path, { readOnly: true });
    try {
      expect((unchanged.prepare("SELECT content FROM messages WHERE id = ?").get(bobMessage) as { content: string }).content, "not sealed to Bob's row").toBe(alicesOld);
    } finally { unchanged.close(); }
  });

  test("BYPASS 2 — every owner id rewritten so no bound value reads (the count reads 0): the planted value is still REFUSED", () => {
    const { path, bobMessage, alicesOld } = plantedDatabase("v20-bypass-owner-");
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec("UPDATE projects SET user_id = 'zz-' || user_id");
    raw.exec("UPDATE users SET id = 'zz-' || id");
    raw.prepare("UPDATE messages SET content = ? WHERE id = ?").run(alicesOld, bobMessage);
    raw.prepare("DELETE FROM schema_version WHERE version = ?").run(BOUND_FIELDS_SCHEMA_VERSION);
    raw.close();
    expect(() => new DbClient({ path })).toThrow(expect.objectContaining({ code: "db_migration_rebinding_refused" }));
  });
});

describe("the frozen migration and the parent columns stay what they are", () => {
  test("no migration body imports the live encrypted-column list or the live binding", () => {
    const source = readFileSync(new URL("../../server/db/migrations.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/db-crypto\.ts"/gu)].map((match) => match[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const names of imports) {
      expect(names, "migrations use their own frozen copies").not.toMatch(/\bENCRYPTED_COLUMNS\b|\bfieldBinding\b|\bsealRow\b|\bopenRow\b/u);
    }
    // Planted: the detector sees it.
    expect('import { ENCRYPTED_COLUMNS } from "./db-crypto.ts"').toMatch(/import\s*\{([^}]*)\}\s*from\s*"\.\/db-crypto\.ts"/u);
  });

  test("no writer of the database client moves a row's parent (the binding includes it)", () => {
    const source = readFileSync(new URL("../../server/db/client.ts", import.meta.url), "utf8");
    const moves: string[] = [];
    for (const [table, shape] of Object.entries(ENCRYPTED_COLUMNS)) {
      for (const parent of [...shape.parents, "user_id"]) {
        // Inside the SET clause only (a WHERE naming the parent is ownership, not a move).
        const pattern = new RegExp(`UPDATE\\s+${table}\\s+SET\\s+((?:(?!\\bWHERE\\b)[^\`;])*)\\b${parent}\\s*=`, "u");
        if (pattern.test(source)) moves.push(`${table}.${parent}`);
      }
    }
    expect(moves).toEqual([]);
    // Planted: the detector sees a parent move.
    expect(/UPDATE\s+messages\s+SET[^`;]*\bchat_id\s*=/u.test("UPDATE messages SET chat_id = ? WHERE id = ?")).toBe(true);
  });
});
