// @vitest-environment node
/**
 * Data loss #3: schema migration — plaintext data created at v4 is encrypted
 * by v5 and survives. Split from data-loss-mechanical.test.ts for parallelism.
 */
import { describe, test, expect } from "vitest";
import { createKeyHome, createTempDir } from "../helpers/temp-dir.ts";
import { DbClient } from "../../server/db/client.ts";
import { runMigrations, createNoopDbCrypto, DatabaseSync } from "../helpers/data-loss-helpers.ts";
import { createDbCrypto } from "../../server/db/db-crypto.ts";
import { BOUND_FIELDS_SCHEMA_VERSION } from "../../server/db/schema.ts";
import { databaseKeyFile } from "../../engine/src/filesystem/self-protection/key-home.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("data loss #3: schema migration (v4 → v5 encrypts existing plaintext)", () => {
  test("plaintext data created at v4 is encrypted by v5 and survives", () => {
    const dir = createTempDir("ch-data-loss-migrate-");
    const dbPath = join(dir, "migrate.db");
    const keyHome = createKeyHome("ch-data-loss-migrate-keys-");
    const noop = createNoopDbCrypto();
    {
      const raw = new DatabaseSync(dbPath);
      try {
        raw.exec("PRAGMA foreign_keys = ON");
        runMigrations(raw, 4, noop);
        raw.prepare(
          "INSERT INTO projects (id, name, path, created_at, updated_at, config_overlay, session_id) VALUES (?, ?, ?, ?, ?, NULL, ?)",
        ).run("proj-mig", "migrate-proj", "/secret/path", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "sess-mig");
        raw.prepare(
          "INSERT INTO chats (id, project_id, title, created_at, updated_at, model_id, pinned) VALUES (?, ?, ?, ?, ?, ?, 0)",
        ).run("chat-mig", "proj-mig", "my secret chat", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "gemma-4-31b");
        raw.prepare(
          "INSERT INTO messages (id, chat_id, role, content, created_at, model_event_type, run_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run("msg-mig", "chat-mig", "user", "secret message content", "2026-01-01T00:00:00Z", null, null, null);
      } finally { raw.close(); }
    }
    {
      const raw = new DatabaseSync(dbPath);
      try {
        const row = raw.prepare("SELECT name, path FROM projects WHERE id = ?").get("proj-mig") as { name: string; path: string };
        expect(row.name).toBe("migrate-proj");
        expect(row.path).toBe("/secret/path");
        expect(row.name.startsWith("enc:")).toBe(false);
      } finally { raw.close(); }
    }
    // A v4 install never held ciphertext under a persisted key (v5 is the
    // first migration that writes any), so it has NO key yet and the upgrade
    // mints one: refusing it would strand every pre-encryption install.
    expect(existsSync(databaseKeyFile(keyHome, dbPath)), "a pre-encryption database has no key").toBe(false);
    // Up to the last version before fields are bound to their owners: the
    // v4 row gets its owner there (an owner column never changes after the
    // fields are sealed to it), then the client finishes the upgrade.
    {
      const raw = new DatabaseSync(dbPath);
      try {
        raw.exec("PRAGMA foreign_keys = ON");
        runMigrations(raw, BOUND_FIELDS_SCHEMA_VERSION - 1, createDbCrypto({ dbPath, keyHome }));
        raw.prepare("UPDATE projects SET user_id = ? WHERE id = ?").run("sess-mig", "proj-mig");
      } finally { raw.close(); }
    }
    expect(existsSync(databaseKeyFile(keyHome, dbPath)), "the upgrade minted the key").toBe(true);
    const db = new DbClient({ path: dbPath, keyHome });
    try {
      const p = db.getProject("proj-mig", "sess-mig");
      expect(p?.name).toBe("migrate-proj");
      expect(p?.path).toBe("/secret/path");
      const chat = db.getChat("chat-mig", "sess-mig");
      expect(chat?.title).toBe("my secret chat");
      const msgs = db.listMessages("chat-mig", "sess-mig");
      expect(msgs[0]?.content).toBe("secret message content");
    } finally { db.close(); }
    {
      const raw = new DatabaseSync(dbPath);
      try {
        const row = raw.prepare("SELECT name, path FROM projects WHERE id = ?").get("proj-mig") as { name: string; path: string };
        expect(row.name.startsWith("enc:")).toBe(true);
        expect(row.path.startsWith("enc:")).toBe(true);
        expect(row.path).not.toBe("/secret/path");
      } finally { raw.close(); }
    }
  });
});
