// @vitest-environment node
/**
 * The key's lifecycle tool (`server/db/key-rotation.ts`, `npm run db-key`):
 * an install from before the key home keeps its key BESIDE its database; the
 * tool moves THAT install's key into the key home after proving it opens the
 * database, REGISTERS (never moves) the installs it finds under a folder, and
 * re-keys (a new key, or a new random salt that retires the old shared one)
 * after a verified copy — keeping the retired key beside it, refusing while
 * another process holds the database, finding the timelines that share the
 * key through the registry, and refusing every open while a re-key is
 * unfinished. A server refuses a key that does not open its database.
 */
import { describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createSecretKey, randomBytes, scryptSync } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createKeyHome, createTempDir } from "../helpers/temp-dir.ts";
import { DbClient } from "../../server/db/client.ts";
import { createDbCrypto, createDbCryptoFromKey } from "../../server/db/db-crypto.ts";
import { registerLegacyInstalls, rekeyDatabase, relocateDatabaseKey } from "../../server/db/key-rotation.ts";
import { runDbKeyCli } from "../../scripts/db-key.ts";
import { databaseKeyFile, databaseSaltFile, openStoreRegistry, registerHarnessStore } from "../../engine/src/filesystem/self-protection/key-home.ts";
import { findLegacyInstalls } from "../../engine/src/filesystem/database-files.ts";
import { ROOT_POLICY } from "../../engine/src/kernel/root-policy.ts";

const USER = "rotation-owner";

/** An install the old way: a database whose key file sits beside it (`<folder>/db-key`). */
function legacyInstall(prefix: string, folder?: string): Readonly<{ dir: string; dbPath: string; legacyKey: string; projectId: string }> {
  const dir = folder ?? createTempDir(prefix), dbPath = join(dir, "web.db"), legacyKey = join(dir, "db-key");
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(legacyKey, key, { mode: 0o600 });
  const db = new DbClient({ path: dbPath, crypto: createDbCryptoFromKey({ key: createSecretKey(key), persisted: true, filePath: legacyKey }) });
  const projectId = db.createProject({ name: "kept", path: "/kept/path" }, USER).id;
  db.close();
  return { dir, dbPath, legacyKey, projectId };
}

/** A database created through a key home, with one project. */
function keyedDatabase(prefix: string): Readonly<{ dir: string; dbPath: string; keyHome: ReturnType<typeof createKeyHome>; projectId: string }> {
  const dir = createTempDir(prefix), dbPath = join(dir, "web.db");
  const keyHome = createKeyHome(`${prefix}keys-`);
  const db = new DbClient({ path: dbPath, keyHome });
  const projectId = db.createProject({ name: "rekeyed", path: "/rekeyed" }, USER).id;
  db.close();
  return { dir, dbPath, keyHome, projectId };
}

describe("relocate: ONE install's key moves into the key home, proven", () => {
  test("the key moves, the database opens from the key home, and a re-run is idempotent", () => {
    const install = legacyInstall("rotation-relocate-");
    const keyHome = createKeyHome("rotation-relocate-keys-");
    const bytes = readFileSync(install.legacyKey);
    // Before: the database's key is not in the key home — refused, naming the tool with this database's own path.
    expect(() => new DbClient({ path: install.dbPath, keyHome })).toThrow(expect.objectContaining({
      code: "persisted_key_missing",
      message: expect.stringContaining(`db-key -- relocate --db ${install.dbPath}`),
    }));
    const moved = relocateDatabaseKey({ dbPath: install.dbPath, keyHome });
    expect(moved).toMatchObject({ outcome: "moved", mode: "key", to: databaseKeyFile(keyHome, install.dbPath) });
    expect(existsSync(install.legacyKey), "the old copy beside the database is gone").toBe(false);
    expect(readFileSync(moved.to)).toEqual(bytes);
    expect(statSync(moved.to).mode & 0o777).toBe(0o600);
    const db = new DbClient({ path: install.dbPath, keyHome });
    try { expect(db.getProject(install.projectId, USER)?.path).toBe("/kept/path"); } finally { db.close(); }
    expect(relocateDatabaseKey({ dbPath: install.dbPath, keyHome }).outcome).toBe("already-moved");
  });

  test("a wrong key is refused and nothing moves; a DIFFERENT key already in the home is a conflict that says which one opens the database", () => {
    const install = legacyInstall("rotation-wrong-");
    const keyHome = createKeyHome("rotation-wrong-keys-");
    const right = readFileSync(install.legacyKey);
    writeFileSync(install.legacyKey, randomBytes(32));
    expect(() => relocateDatabaseKey({ dbPath: install.dbPath, keyHome })).toThrow(expect.objectContaining({ code: "db_key_relocation_wrong_key" }));
    expect(existsSync(install.legacyKey)).toBe(true);
    expect(existsSync(databaseKeyFile(keyHome, install.dbPath))).toBe(false);
    writeFileSync(install.legacyKey, right);
    writeFileSync(databaseKeyFile(keyHome, install.dbPath), randomBytes(32), { mode: 0o600 });
    expect(() => relocateDatabaseKey({ dbPath: install.dbPath, keyHome })).toThrow(expect.objectContaining({
      code: "db_key_relocation_conflict",
      message: expect.stringContaining(`The key home's key does NOT open the database; the old key ${install.legacyKey} opens it.`),
    }));
    expect(existsSync(install.legacyKey)).toBe(true);
    // An interrupted publish of an older tool (an empty key file) is named as not opening it, never a raw fault.
    writeFileSync(databaseKeyFile(keyHome, install.dbPath), Buffer.alloc(0), { mode: 0o600 });
    expect(() => relocateDatabaseKey({ dbPath: install.dbPath, keyHome })).toThrow(expect.objectContaining({ code: "db_key_relocation_conflict", message: expect.stringContaining("does NOT open") }));
  });

  test("a database with nothing sealed proves no key: refused unless forced (so no unrelated 32-byte file is taken)", () => {
    const dir = createTempDir("rotation-empty-"), dbPath = join(dir, "web.db");
    new DatabaseSync(dbPath).close();
    const stranger = join(dir, "db-key");
    writeFileSync(stranger, randomBytes(32), { mode: 0o600 });
    const keyHome = createKeyHome("rotation-empty-keys-");
    expect(() => relocateDatabaseKey({ dbPath, keyHome })).toThrow(expect.objectContaining({ code: "db_key_relocation_unproven" }));
    expect(existsSync(stranger), "nothing moved or deleted").toBe(true);
    expect(relocateDatabaseKey({ dbPath, keyHome, forceEmpty: true }).outcome).toBe("moved");
  });

  test("a key file reached through a link, or readable by others, is refused", () => {
    const install = legacyInstall("rotation-unsafe-");
    const keyHome = createKeyHome("rotation-unsafe-keys-");
    chmodSync(install.legacyKey, 0o644);
    expect(() => relocateDatabaseKey({ dbPath: install.dbPath, keyHome })).toThrow(expect.objectContaining({ code: "db_key_file_invalid" }));
    chmodSync(install.legacyKey, 0o600);
    const linked = join(install.dir, "linked-key");
    symlinkSync(install.legacyKey, linked);
    expect(() => relocateDatabaseKey({ dbPath: install.dbPath, from: linked, keyHome })).toThrow(expect.objectContaining({ code: "db_key_file_invalid" }));
  });

  test("passphrase mode moves the salt beside the key file's old place", () => {
    const dir = createTempDir("rotation-salt-"), dbPath = join(dir, "web.db");
    const passphrase = "a passphrase", salt = randomBytes(32);
    writeFileSync(join(dir, "db-key.salt"), salt, { mode: 0o600 });
    const db = new DbClient({ path: dbPath, crypto: createDbCryptoFromKey({ key: createSecretKey(scryptSync(passphrase, salt, 32)), persisted: true, filePath: null }) });
    const id = db.createProject({ name: "salted", path: "/salted" }, USER).id;
    db.close();
    const keyHome = createKeyHome("rotation-salt-keys-");
    expect(relocateDatabaseKey({ dbPath, passphrase, keyHome })).toMatchObject({ outcome: "moved", mode: "passphrase-salt", to: databaseSaltFile(keyHome, dbPath) });
    const reopened = new DbClient({ path: dbPath, passphrase, keyHome });
    try { expect(reopened.getProject(id, USER)?.path).toBe("/salted"); } finally { reopened.close(); }
  });
});

describe("scan: installs still keeping a key beside their database are REGISTERED, never moved", () => {
  test("found at any depth (web databases and timeline-only folders); --apply registers each and moves no key; one outcome per install", () => {
    const root = createTempDir("rotation-scan-");
    const nested = legacyInstall("rotation-scan-a-");
    // A legacy `.code-harness` state folder two levels down.
    const deep = legacyInstall("", join(root, "lab", "checkout", ".code-harness"));
    // An engine timeline kept with its key (no web database beside it).
    const engine = join(root, "engine-state");
    mkdirSync(engine);
    writeFileSync(join(engine, "db-key"), randomBytes(32), { mode: 0o600 });
    const timeline = new DatabaseSync(join(engine, "timeline.db"));
    timeline.exec("CREATE TABLE event_log (sequence INTEGER)");
    timeline.close();
    // A folder with a stray `db-key` but no database is not an install; nor is a wrong-sized one.
    mkdirSync(join(root, "stray"));
    writeFileSync(join(root, "stray", "db-key"), randomBytes(32), { mode: 0o600 });
    mkdirSync(join(root, "odd"));
    writeFileSync(join(root, "odd", "db-key"), randomBytes(12), { mode: 0o600 });
    new DatabaseSync(join(root, "odd", "web.db")).close();
    const found = findLegacyInstalls([root, nested.dir], ROOT_POLICY.selfProtection.legacyInstalls.scanFolderBudget);
    expect(found.truncated).toBe(false);
    expect(found.installs.map((install) => install.folder).sort()).toEqual([deep.dir, engine, nested.dir].sort());
    const keyHome = createKeyHome("rotation-scan-keys-");
    const outcomes = registerLegacyInstalls(found.installs, keyHome);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["registered", "registered", "registered"]);
    for (const install of [nested, deep]) expect(existsSync(install.legacyKey), "the key stays where that install's code reads it").toBe(true);
    const registered = openStoreRegistry(keyHome).records().map((record) => record.path);
    expect(registered).toEqual(expect.arrayContaining([nested.dbPath, deep.dbPath, join(engine, "timeline.db")]));
    expect(findLegacyInstalls([root, nested.dir], ROOT_POLICY.selfProtection.legacyInstalls.scanFolderBudget).installs.length, "a scan never changes what it finds").toBe(3);
  });

  test("the walk is bounded (sec-e-design H3): it stops at its folder budget and says so, never enters the one skip list, and counts a folder it cannot list", () => {
    const root = createTempDir("rotation-scan-budget-");
    for (const name of ["a", "b", "c", "d"]) mkdirSync(join(root, name, "inner"), { recursive: true });
    const install = legacyInstall("", join(root, "node_modules", "pkg", ".bridlewise"));
    const whole = findLegacyInstalls([root], 1000);
    expect(whole).toMatchObject({ truncated: false, foldersWalked: 9, unlistableFolders: 0 });
    expect(whole.installs, `a skipped folder is never entered (${install.dir})`).toEqual([]);
    const bounded = findLegacyInstalls([root], 3);
    expect(bounded).toMatchObject({ truncated: true, foldersWalked: 3 });
    expect(findLegacyInstalls([join(root, "absent")], 10)).toMatchObject({ truncated: false, foldersWalked: 1, unlistableFolders: 1, installs: [] });
  });
});

describe("the shape check past its bounds fails CLOSED (sec-e-correctness M-4)", () => {
  const bound = ROOT_POLICY.selfProtection.legacyInstalls.maximumSiblingsRead;
  const fill = (at: string, count: number) => { for (let i = 0; i < count; i += 1) writeFileSync(join(at, `filler-${String(i).padStart(4, "0")}.txt`), ""); };

  test("a scan registers an install behind filler files and one with a LINKED key; a key beside more files than one look reads is REFUSED, never registered blind", () => {
    const root = createTempDir("rotation-scan-bounds-");
    const crowded = legacyInstall("", join(root, "crowded"));
    fill(crowded.dir, bound * 3);
    const linked = legacyInstall("", join(root, "linked"));
    const kept = join(root, "kept-key");
    renameSync(linked.legacyKey, kept);
    symlinkSync(kept, linked.legacyKey);
    const exhausted = join(root, "exhausted");
    mkdirSync(exhausted);
    writeFileSync(join(exhausted, "db-key"), randomBytes(32), { mode: 0o600 });
    fill(exhausted, bound + 1);
    const found = findLegacyInstalls([root], ROOT_POLICY.selfProtection.legacyInstalls.scanFolderBudget);
    expect(found.installs.map((install) => [install.folder, install.databases, install.searchExhausted])).toEqual([
      [crowded.dir, [crowded.dbPath], undefined],
      [exhausted, [], true],
      [linked.dir, [linked.dbPath], undefined],
    ]);
    const keyHome = createKeyHome("rotation-scan-bounds-keys-");
    const outcomes = registerLegacyInstalls(found.installs, keyHome);
    expect(outcomes.map((outcome) => [outcome.folder, outcome.outcome, outcome.outcome === "refused" ? outcome.code : null])).toEqual([
      [crowded.dir, "registered", null],
      [exhausted, "refused", "legacy_install_search_exhausted"],
      [linked.dir, "registered", null],
    ]);
    expect(openStoreRegistry(keyHome).records().map((record) => record.path).sort()).toEqual([crowded.dbPath, linked.dbPath].sort());
  });

  test("a database keeping its key beside it is never given a NEW key, however many files surround it or whatever it is called", () => {
    const dir = createTempDir("rotation-kept-beside-");
    const dbPath = join(dir, "state");
    writeFileSync(join(dir, "db-key"), randomBytes(32), { mode: 0o600 });
    fill(dir, bound * 3);
    const empty = new DatabaseSync(dbPath);
    empty.exec("CREATE TABLE rows (value TEXT)");
    empty.close();
    const keyHome = createKeyHome("rotation-kept-beside-keys-");
    expect(() => createDbCrypto({ dbPath, keyHome })).toThrowError(expect.objectContaining({ code: "persisted_key_missing", message: expect.stringContaining(`relocate --db ${dbPath}`) }));
    expect(existsSync(databaseKeyFile(keyHome, dbPath)), "no key is minted beside the old one").toBe(false);
  });
});

describe("rekey: a new key (or salt) for every encrypted field, safely", () => {
  test("every field is re-sealed under a NEW key; the RETIRED key is kept and still opens the pre-re-key copy", () => {
    const { dbPath, keyHome, projectId } = keyedDatabase("rotation-rekey-");
    const before = readFileSync(databaseKeyFile(keyHome, dbPath));
    const result = rekeyDatabase({ dbPath, keyHome });
    expect(result).toMatchObject({ outcome: "rekeyed", mode: "key", retired: databaseKeyFile(keyHome, dbPath, before) });
    expect(result.fields).toBeGreaterThan(0);
    expect(statSync(result.copy).mode & 0o777).toBe(0o600);
    expect(readFileSync(databaseKeyFile(keyHome, dbPath)).equals(before)).toBe(false);
    expect(readFileSync(result.retired), "the old key is kept, retired").toEqual(before);
    expect(statSync(result.retired).mode & 0o777).toBe(0o600);
    const reopened = new DbClient({ path: dbPath, keyHome });
    try { expect(reopened.getProject(projectId, USER)?.path).toBe("/rekeyed"); } finally { reopened.close(); }
    // RESTORE: the pre-re-key copy opens with the retired key (the one way back).
    const restoredHome = createKeyHome("rotation-restore-keys-");
    const restoredDir = createTempDir("rotation-restore-");
    const restored = join(restoredDir, "web.db");
    writeFileSync(restored, readFileSync(result.copy));
    writeFileSync(databaseKeyFile(restoredHome, restored), readFileSync(result.retired), { mode: 0o600 });
    const back = new DbClient({ path: restored, keyHome: restoredHome });
    try { expect(back.getProject(projectId, USER)?.path).toBe("/rekeyed"); } finally { back.close(); }
  });

  test("a SECOND re-key keeps the first retired key in its own slot: a copy from before the first still opens (sec-e-correctness M-1)", () => {
    const { dir, dbPath, keyHome, projectId } = keyedDatabase("rotation-rekey-twice-");
    const original = readFileSync(databaseKeyFile(keyHome, dbPath));
    // A pre-migration copy taken under the ORIGINAL key (what `.pre-v<N>` copies are).
    const oldest = join(dir, "web.db.pre-v20");
    const first = rekeyDatabase({ dbPath, keyHome });
    writeFileSync(oldest, readFileSync(first.copy));
    const middle = readFileSync(databaseKeyFile(keyHome, dbPath));
    const second = rekeyDatabase({ dbPath, keyHome });
    expect(second.retired, "each retired key has its own slot").not.toBe(first.retired);
    expect(readFileSync(first.retired), "the first retired key is still kept").toEqual(original);
    expect(readFileSync(second.retired)).toEqual(middle);
    for (const [copy, retired] of [[oldest, first.retired], [second.copy, second.retired]] as const) {
      const restoredHome = createKeyHome("rotation-rekey-twice-restore-keys-");
      const restored = join(createTempDir("rotation-rekey-twice-restore-"), "web.db");
      writeFileSync(restored, readFileSync(copy));
      writeFileSync(databaseKeyFile(restoredHome, restored), readFileSync(retired), { mode: 0o600 });
      const back = new DbClient({ path: restored, keyHome: restoredHome });
      try { expect(back.getProject(projectId, USER)?.path, `${copy} opens under ${retired}`).toBe("/rekeyed"); } finally { back.close(); }
    }
  });

  test("REFUSED while another process holds the database (a running server's WAL connection); nothing changes", () => {
    const { dbPath, keyHome, projectId } = keyedDatabase("rotation-busy-");
    const before = readFileSync(databaseKeyFile(keyHome, dbPath));
    const server = new DbClient({ path: dbPath, keyHome });
    try {
      expect(() => rekeyDatabase({ dbPath, keyHome })).toThrow(expect.objectContaining({ code: "db_rekey_database_busy" }));
      expect(server.getProject(projectId, USER)?.path).toBe("/rekeyed");
    } finally {
      server.close();
    }
    expect(readFileSync(databaseKeyFile(keyHome, dbPath))).toEqual(before);
    expect(existsSync(databaseKeyFile(keyHome, dbPath, before)), "no retired key: nothing started").toBe(false);
  });

  test("a timeline sharing the key — beside the database OR configured elsewhere (the registry's pairing) — with history refuses the re-key", () => {
    for (const elsewhere of [false, true]) {
      const { dir, dbPath, keyHome } = keyedDatabase(`rotation-timeline-${elsewhere ? "far" : "near"}-`);
      const folder = elsewhere ? createTempDir("rotation-timeline-far-folder-") : dir;
      const timelinePath = join(folder, "timeline.db");
      const timeline = new DatabaseSync(timelinePath);
      timeline.exec("CREATE TABLE event_log (sequence INTEGER); INSERT INTO event_log VALUES (1);");
      timeline.close();
      if (elsewhere) registerHarnessStore(keyHome, timelinePath, dbPath);
      const before = readFileSync(databaseKeyFile(keyHome, dbPath));
      expect(() => rekeyDatabase({ dbPath, keyHome }), elsewhere ? "configured elsewhere" : "beside").toThrow(expect.objectContaining({ code: "db_rekey_timeline_bound" }));
      expect(readFileSync(databaseKeyFile(keyHome, dbPath))).toEqual(before);
    }
  });

  test("a crash after the commit, before the key moved: every open is refused until the re-run finishes it", () => {
    const { dbPath, keyHome, projectId } = keyedDatabase("rotation-crash-");
    const target = databaseKeyFile(keyHome, dbPath);
    const old = readFileSync(target);
    rekeyDatabase({ dbPath, keyHome });
    // Reconstruct the crash state: the fields are under the NEW key, the new key staged, the old key in place.
    renameSync(target, `${target}.next`);
    writeFileSync(target, old, { mode: 0o600 });
    expect(() => new DbClient({ path: dbPath, keyHome }), "a server start is refused, not run on the old key").toThrow(expect.objectContaining({ code: "persisted_key_rekey_in_flight" }));
    expect(rekeyDatabase({ dbPath, keyHome }).outcome).toBe("finished-interrupted");
    const reopened = new DbClient({ path: dbPath, keyHome });
    try { expect(reopened.getProject(projectId, USER)?.path).toBe("/rekeyed"); } finally { reopened.close(); }
  });

  test("a server handed a key that does not open its database refuses to start (nothing is sealed under it)", () => {
    const { dbPath, keyHome } = keyedDatabase("rotation-wrong-key-");
    const other = createKeyHome("rotation-wrong-key-other-");
    writeFileSync(databaseKeyFile(other, dbPath), randomBytes(32), { mode: 0o600 });
    expect(() => new DbClient({ path: dbPath, keyHome: other })).toThrow(expect.objectContaining({ code: "db_key_wrong" }));
    new DbClient({ path: dbPath, keyHome }).close();
  });

  test("the CLI (a thin shell over the database.key.* actions) prints one JSON line and exits 1 with the refusal code", async () => {
    const writes: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { writes.push(chunk); return true; }) as typeof process.stdout.write;
    try {
      expect(await runDbKeyCli(["relocate", "--db", join(createTempDir("rotation-cli-"), "absent.db")])).toBe(1);
    } finally {
      process.stdout.write = write;
    }
    expect(JSON.parse(writes.join("").trim())).toMatchObject({ refused: "db_key_relocation_source_missing" });
  });
});
