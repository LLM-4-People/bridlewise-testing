// @vitest-environment node
/**
 * BACKUP AND RESTORE — ONE FLOW, WITH A VERIFICATION STEP ON BOTH SIDES.
 *
 * The gap this covers: the docs told operators to back up the database and key
 * home, but no command made such a backup and nothing restored or proved one.
 * These tests exercise the real flow end to end: a backup carries the database
 * and its key material, the backup is proved to open under that material, a
 * restore holds the database alone, keeps the replaced database as a verified
 * `<db>.pre-restore`, and proves the restored database opens before it is
 * called done.
 */
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DbClient } from "../../server/db/client.ts";
import { createDatabaseBackup, restoreDatabaseBackup } from "../../server/db/backup-restore.ts";
import { databaseKeyFile, databaseSaltFile, preRestoreCopyPath } from "../../server/kernel/canonical.ts";
import { createKeyHome, createTempDir } from "../helpers/temp-dir.ts";

function seeded(dir: string, keyHome: ReturnType<typeof createKeyHome>, passphrase?: string) {
  const path = join(dir, "web.db");
  const db = new DbClient({ path, keyHome, ...(passphrase === undefined ? {} : { passphrase }) });
  const user = db.createUser("archivist", "not-a-real-hash");
  const project = db.createProject({ name: "p", path: dir }, user.id);
  const chat = db.createChat({ project_id: project.id, title: "backed up" }, user.id);
  db.createMessage({ chat_id: chat.id, role: "user", content: "hello before the backup" }, user.id);
  db.close();
  return { path, user, chat };
}

describe("the database backup and restore flow", () => {
  test("a backup carries the database and its key; restoring it brings the rows back and keeps the replaced database", () => {
    const dir = createTempDir("db-backup-roundtrip-");
    const keyHome = createKeyHome("db-backup-roundtrip-");
    const { path, user, chat } = seeded(dir, keyHome);
    const backupDirectory = join(dir, "backup");
    const backup = createDatabaseBackup({ dbPath: path, to: backupDirectory, keyHome, now: () => new Date("2026-10-20T00:00:00.000Z") });
    expect(backup.keyProof).toBe("opens");
    expect(backup.keyMode).toBe("key");
    expect(backup.createdAt).toBe("2026-10-20T00:00:00.000Z");
    expect(existsSync(join(backupDirectory, "manifest.json"))).toBe(true);
    expect(readFileSync(join(backupDirectory, "manifest.json"), "utf8")).toContain(backup.digest);
    // A change after the backup is what the restore must remove.
    const current = new DbClient({ path, keyHome });
    try {
      current.createMessage({ chat_id: chat.id, role: "assistant", content: "written after the backup" }, user.id);
    } finally { current.close(); }
    const restored = restoreDatabaseBackup({ from: backupDirectory, dbPath: path, keyHome });
    expect(restored.database).toBe(path);
    expect(restored.keySource).toBe("existing");
    expect(restored.keyProof).toBe("opens");
    expect(restored.preRestoreCopy).toBe(preRestoreCopyPath(path));
    const db = new DbClient({ path, keyHome });
    try {
      expect(db.listMessages(chat.id, user.id).map((message) => message.content)).toEqual(["hello before the backup"]);
      expect(db.getUserByUsername("archivist")?.id).toBe(user.id);
    } finally { db.close(); }
    // What the restore replaced is kept, verified, beside it — including the later message.
    const replaced = new DbClient({ path: preRestoreCopyPath(path), keyHome });
    try {
      expect(replaced.listMessages(chat.id, user.id).map((message) => message.content)).toEqual(["hello before the backup", "written after the backup"]);
    } finally { replaced.close(); }
  });

  test("a damaged backup is refused before the target is touched", () => {
    const dir = createTempDir("db-backup-damaged-");
    const keyHome = createKeyHome("db-backup-damaged-");
    const { path, user, chat } = seeded(dir, keyHome);
    const backupDirectory = join(dir, "backup");
    createDatabaseBackup({ dbPath: path, to: backupDirectory, keyHome });
    writeFileSync(join(backupDirectory, "database.sqlite"), "this is not the database the manifest names", "utf8");
    const before = new DbClient({ path, keyHome });
    try {
      before.createMessage({ chat_id: chat.id, role: "assistant", content: "still here" }, user.id);
    } finally { before.close(); }
    expect(() => restoreDatabaseBackup({ from: backupDirectory, dbPath: path, keyHome })).toThrow(expect.objectContaining({ code: "db_restore_unverified" }));
    const db = new DbClient({ path, keyHome });
    try {
      expect(db.listMessages(chat.id, user.id).map((message) => message.content)).toEqual(["hello before the backup", "still here"]);
    } finally { db.close(); }
  });

  test("a lost database and a lost key home are both recovered from the backup", () => {
    const dir = createTempDir("db-backup-recovery-");
    const keyHome = createKeyHome("db-backup-recovery-");
    const { path, user, chat } = seeded(dir, keyHome);
    const backupDirectory = join(dir, "backup");
    createDatabaseBackup({ dbPath: path, to: backupDirectory, keyHome });
    rmSync(path, { force: true });
    rmSync(databaseKeyFile(keyHome, path), { force: true });
    const restored = restoreDatabaseBackup({ from: backupDirectory, dbPath: path, keyHome });
    expect(restored.keySource).toBe("backup");
    expect(restored.preRestoreCopy).toBeUndefined();
    expect(restored.keyProof).toBe("opens");
    const db = new DbClient({ path, keyHome });
    try {
      expect(db.listMessages(chat.id, user.id).map((message) => message.content)).toEqual(["hello before the backup"]);
    } finally { db.close(); }
  });

  test("a passphrase install backs up its salt and restores under the same passphrase", () => {
    const dir = createTempDir("db-backup-passphrase-");
    const keyHome = createKeyHome("db-backup-passphrase-");
    const passphrase = "a-test-passphrase-not-a-real-one";
    const { path, user, chat } = seeded(dir, keyHome, passphrase);
    const backupDirectory = join(dir, "backup");
    const backup = createDatabaseBackup({ dbPath: path, to: backupDirectory, keyHome, passphrase });
    expect(backup.keyMode).toBe("passphrase-salt");
    expect(backup.keyProof).toBe("opens");
    rmSync(path, { force: true });
    rmSync(databaseSaltFile(keyHome, path), { force: true });
    const restored = restoreDatabaseBackup({ from: backupDirectory, dbPath: path, keyHome, passphrase });
    expect(restored.keySource).toBe("backup");
    const db = new DbClient({ path, keyHome, passphrase });
    try {
      expect(db.listMessages(chat.id, user.id).map((message) => message.content)).toEqual(["hello before the backup"]);
    } finally { db.close(); }
  });

  test("a backup is refused while a server (another connection) holds the database, and writes nothing", () => {
    const dir = createTempDir("db-backup-busy-");
    const keyHome = createKeyHome("db-backup-busy-");
    const { path } = seeded(dir, keyHome);
    const backupDirectory = join(dir, "backup");
    const server = new DbClient({ path, keyHome });
    try {
      expect(() => createDatabaseBackup({ dbPath: path, to: backupDirectory, keyHome })).toThrow(expect.objectContaining({ code: "db_backup_database_busy" }));
    } finally { server.close(); }
    expect(existsSync(backupDirectory)).toBe(false);
  });

  test("a different key in the key home refuses the restore instead of leaving unreadable rows", () => {
    const one = createTempDir("db-backup-conflict-one-");
    const two = createTempDir("db-backup-conflict-two-");
    const keyHome = createKeyHome("db-backup-conflict-");
    const { path: backedUp } = seeded(one, keyHome);
    const backupDirectory = join(one, "backup");
    createDatabaseBackup({ dbPath: backedUp, to: backupDirectory, keyHome });
    const target = join(two, "web.db");
    const { user, chat } = seeded(two, keyHome);
    const db = new DbClient({ path: target, keyHome });
    try {
      const before = db.listMessages(chat.id, user.id).map((message) => message.content);
      expect(() => restoreDatabaseBackup({ from: backupDirectory, dbPath: target, keyHome })).toThrow(expect.objectContaining({ code: "db_restore_key_conflict" }));
      expect(db.listMessages(chat.id, user.id).map((message) => message.content)).toEqual(before);
    } finally { db.close(); }
    expect(existsSync(preRestoreCopyPath(target))).toBe(false);
  });
});
