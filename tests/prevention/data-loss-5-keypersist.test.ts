// @vitest-environment node
/**
 * Data loss #5: encryption key persistence — a new process with the same key
 * file decrypts all existing data. Split from data-loss-mechanical.test.ts.
 */
import { describe, test, expect } from "vitest";
import { createKeyHome, createTempDir } from "../helpers/temp-dir.ts";
import { DbClient } from "../../server/db/client.ts";
import { databaseKeyFile, databaseSaltFile, type AdmittedKeyHome } from "../../engine/src/filesystem/self-protection/key-home.ts";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One database and the key home its key lives in (the key is NEVER beside the database). */
function keyedStore(prefix: string): Readonly<{ dir: string; dbPath: string; keyHome: AdmittedKeyHome; keyPath: string }> {
  const dir = createTempDir(prefix), dbPath = join(dir, "web.db"), keyHome = createKeyHome(`${prefix}keys-`);
  return { dir, dbPath, keyHome, keyPath: databaseKeyFile(keyHome, dbPath) };
}

describe("data loss #5: encryption key persistence (reboot, same key file)", () => {
  test("a new process with the same key file decrypts all existing data", () => {
    const { dir, dbPath, keyHome, keyPath } = keyedStore("ch-data-loss-keypersist-");
    {
      const db = new DbClient({ path: dbPath, keyHome });
      try {
        db.createProject({ name: "persist-proj", path: "/home/example/persist" }, "sess-persist");
        db.createChat({ project_id: db.listProjects("sess-persist")[0]!.id, title: "persist chat" }, "sess-persist");
      } finally { db.close(); }
    }
    expect(existsSync(keyPath)).toBe(true);
    // The key lives in the key home, never beside its database.
    expect(keyPath.startsWith(dir)).toBe(false);
    const keyBytes = readFileSync(keyPath);
    expect(keyBytes.length).toBe(32);
    {
      const db = new DbClient({ path: dbPath, keyHome });
      try {
        const p = db.listProjects("sess-persist")[0]!;
        expect(p.name).toBe("persist-proj");
        expect(p.path).toBe("/home/example/persist");
        const chats = db.listChats(p.id, "sess-persist");
        expect(chats[0]?.title).toBe("persist chat");
      } finally { db.close(); }
    }
    expect(readFileSync(keyPath).equals(keyBytes)).toBe(true);
  });

  test("the persisted key file has mode 0600 (owner-only read/write)", () => {
    const { dbPath, keyHome, keyPath } = keyedStore("ch-data-loss-keymode-");
    {
      const db = new DbClient({ path: dbPath, keyHome });
      db.createProject({ name: "x", path: "/x" }, "u");
      db.close();
    }
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });
});

// Real process boundaries: each creator completes a distinct private stage
// before either may publish. No timing delay is used to produce contention.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, writeFileSync } from "node:fs";
import { createCipheriv, createSecretKey, scryptSync } from "node:crypto";
import { createDbCrypto, createDbCryptoFromKey, UNBOUND } from "../../server/db/db-crypto.ts";

const CRYPTO_URL = new URL("../../server/db/db-crypto.ts", import.meta.url).href;
type KeyedStore = ReturnType<typeof keyedStore>;
/** A child process opening `store`'s database: its key home in the environment, `dbPath`/`keyPath`/`keyHome` in scope. */
function nativeKeyScript(store: KeyedStore, operation: string): string {
  return `import fs from 'node:fs';import{createHash}from'node:crypto';import{syncBuiltinESMExports}from'node:module';const keyPath=${JSON.stringify(store.keyPath)},dbPath=${JSON.stringify(store.dbPath)},keyHome=${JSON.stringify(store.keyHome)};process.env.HARNESS_KEY_HOME=keyHome;${operation}`;
}
function keyCreator(store: KeyedStore, label: string, afterLink = false) {
  const source = nativeKeyScript(store, `const link=fs.linkSync;fs.linkSync=(stage,target)=>{if(target===keyPath){if(${afterLink})link(stage,target);console.log('READY '+createHash('sha256').update(fs.readFileSync(stage)).digest('hex'));fs.readSync(0,Buffer.alloc(1),0,1,null);if(${afterLink})return;}return link(stage,target);};syncBuiltinESMExports();const{createDbCrypto,UNBOUND}=await import(${JSON.stringify(CRYPTO_URL)});const c=createDbCrypto({dbPath});console.log(JSON.stringify({cipher:c.encryptField(${JSON.stringify(label)},UNBOUND),mode:fs.statSync(keyPath).mode&511}));`);
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "pipe"] });
  const ready = Promise.withResolvers<string>();
  let output = "", stderr = "";
  child.stdout.on("data", (data: Buffer) => { output += data; const match = /^READY ([a-f0-9]{64})$/m.exec(output); if (match) ready.resolve(match[1]!); });
  child.stderr.on("data", (data: Buffer) => { stderr += data; });
  child.on("error", ready.reject);
  const joined = once(child, "close").then(([code, signal]) => { ready.reject(new Error("creator exited before barrier")); return { code, signal, output, stderr }; });
  void ready.promise.catch(() => {});
  return { child, ready: ready.promise, joined };
}

test("native key creators publish one complete winner and a third process decrypts both", async () => {
  const store = keyedStore("native-key-first-open-"), { keyPath } = store;
  const creators = [keyCreator(store, "creator-a"), keyCreator(store, "creator-b")];
  const watchdog = setTimeout(() => { for (const c of creators) c.child.kill("SIGKILL"); }, 20_000);
  try {
    const candidates = await Promise.all(creators.map((c) => c.ready));
    expect(new Set(candidates).size).toBe(2);
    expect(existsSync(keyPath)).toBe(false);
    const results = [];
    for (const c of creators) { c.child.stdin.write("x"); results.push(await c.joined); }
    const ciphertexts = results.map((result) => {
      expect(result.code, result.stderr).toBe(0);
      const row = JSON.parse(result.output.split("\n").find((line) => line.startsWith("{"))!) as { cipher: string; mode: number };
      expect(row.mode).toBe(0o600); return row.cipher;
    });
    const third = spawnSync(process.execPath, ["--input-type=module", "-e", nativeKeyScript(store,
      `const{createDbCrypto,UNBOUND}=await import(${JSON.stringify(CRYPTO_URL)});const c=createDbCrypto({dbPath});console.log(JSON.stringify(${JSON.stringify(ciphertexts)}.map(v=>c.decryptField(v,UNBOUND))));`)], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
    expect(third.status, third.stderr).toBe(0);
    expect(JSON.parse(third.stdout)).toEqual(["creator-a", "creator-b"]);
  } finally {
    clearTimeout(watchdog);
    for (const c of creators) if (c.child.exitCode === null) c.child.kill("SIGKILL");
    await Promise.allSettled(creators.map((c) => c.joined));
  }
}, 30_000);

test("missing keys cannot replace an existing or read-only database identity", () => {
  const { dir, dbPath, keyHome, keyPath } = keyedStore("missing-required-key-");
  writeFileSync(dbPath, "existing bytes");
  for (const options of [{ dbPath, keyHome }, { dbPath: join(dir, "absent.db"), keyHome, readOnly: true }]) {
    // No old key beside it: the refusal names this database and the key home's backup.
    expect(() => createDbCrypto(options)).toThrowError(expect.objectContaining({ code: "persisted_key_missing", message: expect.stringContaining("restore the key home") }));
    expect(existsSync(keyPath)).toBe(false);
  }
  // An install from before the key home keeps its key beside the database: the refusal names the exact relocation.
  const legacyDb = join(createTempDir("missing-key-legacy-"), "web.db");
  writeFileSync(join(legacyDb, "..", "db-key"), Buffer.alloc(32, 9), { mode: 0o600 });
  const beside = new DatabaseSync(legacyDb);
  beside.exec("CREATE TABLE rows (value TEXT)");
  beside.close();
  expect(() => createDbCrypto({ dbPath: legacyDb, keyHome })).toThrowError(expect.objectContaining({ code: "persisted_key_missing", message: expect.stringContaining(`npm run db-key -- relocate --db ${legacyDb}`) }));
});

test("a key is minted only where no ciphertext can be orphaned: a database holding sealed fields refuses a missing key, an empty one gets a new key", () => {
  // Holding ciphertext (v20, a project's sealed name and path): the lost key is REFUSED, never replaced — a
  // new key would seal new rows no restored key could read and leave the old ones unreadable.
  const held = keyedStore("key-mint-held-"), owner = "mint-owner";
  const writer = new DbClient({ path: held.dbPath, keyHome: held.keyHome });
  const project = writer.createProject({ name: "sealed", path: "/sealed" }, owner);
  writer.close();
  const original = readFileSync(held.keyPath);
  rmSync(held.keyPath);
  expect(() => new DbClient({ path: held.dbPath, keyHome: held.keyHome })).toThrowError(expect.objectContaining({ code: "persisted_key_missing" }));
  expect(existsSync(held.keyPath), "nothing is minted in its place").toBe(false);
  writeFileSync(held.keyPath, original, { mode: 0o600 });
  const restored = new DbClient({ path: held.dbPath, keyHome: held.keyHome });
  try { expect(restored.getProject(project.id, owner)?.path).toBe("/sealed"); } finally { restored.close(); }
  // Nothing sealed yet (the schema is current, no encrypted column holds a value): a new key loses nothing.
  const empty = keyedStore("key-mint-empty-");
  new DbClient({ path: empty.dbPath, keyHome: empty.keyHome }).close();
  rmSync(empty.keyPath);
  const reopened = new DbClient({ path: empty.dbPath, keyHome: empty.keyHome });
  try {
    expect(existsSync(empty.keyPath)).toBe(true);
    const created = reopened.createProject({ name: "fresh", path: "/fresh" }, owner);
    expect(reopened.getProject(created.id, owner)?.path).toBe("/fresh");
  } finally { reopened.close(); }
  // A pre-encryption (v4) database upgrading without a key: data-loss-3-migration.test.ts.
});

test("existing key permissions and bytes are admitted without replacing the winner", () => {
  const { dbPath, keyHome, keyPath } = keyedStore("key-admission-"), bytes = Buffer.alloc(32, 17);
  for (const [length, mode] of [[31, 0o600], [33, 0o600], [32, 0o644], [32, 0o4600]]) {
    writeFileSync(keyPath, bytes.subarray(0, Math.min(length!,32))); if (length === 33) writeFileSync(keyPath, Buffer.alloc(33, 17));
    chmodSync(keyPath, mode!); const before = readFileSync(keyPath);
    expect(() => createDbCrypto({ dbPath, keyHome })).toThrowError(expect.objectContaining({ code: "persisted_key_file_invalid" }));
    expect(readFileSync(keyPath)).toEqual(before);
  }
});

const FIXED_SALT = "bridlewise-web-db-encryption-salt-v2";
/** A field sealed the way every passphrase installation sealed it before random salts (CRED-F13). */
function fixedSaltWire(passphrase: string, plaintext: string): string {
  const iv = Buffer.alloc(12, 3), cipher = createCipheriv("aes-256-gcm", scryptSync(passphrase, FIXED_SALT, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return "enc:" + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

test("passphrase mode: a new database gets a random persisted salt, never the old shared one", () => {
  const { dbPath, keyHome } = keyedStore("passphrase-salt-new-"), saltPath = databaseSaltFile(keyHome, dbPath);
  const passphrase = "  exact passphrase  ";
  const first = createDbCrypto({ dbPath, passphrase, keyHome });
  expect(statSync(saltPath).mode & 0o777).toBe(0o600);
  expect(readFileSync(saltPath).length).toBe(32);
  expect(readFileSync(saltPath).toString("utf8")).not.toBe(FIXED_SALT);
  expect(() => first.decryptField(fixedSaltWire(passphrase, "shared-salt ciphertext"), UNBOUND)).toThrowError(expect.objectContaining({ code: "db_decryption_failed" }));
  // The salt persists: the same passphrase opens what the first process sealed; another passphrase does not.
  const sealed = first.encryptField("salted", UNBOUND);
  expect(createDbCrypto({ dbPath, passphrase, keyHome }).decryptField(sealed, UNBOUND)).toBe("salted");
  expect(() => createDbCrypto({ dbPath, passphrase: passphrase.trim(), keyHome }).decryptField(sealed, UNBOUND)).toThrowError(expect.objectContaining({ code: "db_decryption_failed" }));
});

test("passphrase mode: a database from before random salts adopts the old salt and keeps its exact ciphertext; a lost salt is refused", () => {
  const { dbPath: path, keyHome } = keyedStore("passphrase-salt-adopt-"), saltPath = databaseSaltFile(keyHome, path);
  const passphrase = "legacy passphrase", user = "legacy-owner";
  // A v19 database sealed under the shared salt (its writer never needed a salt file).
  const legacyKey = { key: createSecretKey(scryptSync(passphrase, FIXED_SALT, 32)), persisted: true, filePath: null };
  const legacy = new DbClient({ path, schemaVersion: 19, crypto: createDbCryptoFromKey(legacyKey) });
  const project = legacy.createProject({ name: "kept", path: "/kept" }, user);
  legacy.close();
  expect(existsSync(saltPath)).toBe(false);
  const opened = new DbClient({ path, passphrase, keyHome });
  try {
    expect(readFileSync(saltPath).toString("utf8")).toBe(FIXED_SALT);
    expect(statSync(saltPath).mode & 0o777).toBe(0o600);
    expect(opened.getProject(project.id, user)!.path).toBe("/kept");
  } finally { opened.close(); }
  // From v20 on the salt is required: losing it is refused like a lost key, and nothing is minted in its place.
  rmSync(saltPath);
  expect(() => createDbCrypto({ dbPath: path, passphrase, keyHome })).toThrowError(expect.objectContaining({ code: "persisted_key_missing" }));
  expect(existsSync(saltPath)).toBe(false);
});

function nativeKeyProbe(store: KeyedStore, setup: string, body: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", nativeKeyScript(store,
    `${setup};syncBuiltinESMExports();const{createDbCrypto,UNBOUND}=await import(${JSON.stringify(CRYPTO_URL)});${body}`)],
  { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
}

test("a FIFO key source refuses without waiting for a writer", () => {
  const store = keyedStore("key-fifo-"), { keyPath } = store;
  expect(spawnSync("mkfifo", [keyPath]).status).toBe(0);
  const child = nativeKeyProbe(store, "", `try{createDbCrypto({dbPath});process.exitCode=1;}catch(e){console.log(JSON.stringify({code:e.code,message:e.message}));}`);
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ code: "persisted_key_file_invalid", message: "Persistent encryption key could not be admitted" });
});

test("restrictive umask still publishes exactly0600 before consumers use the key", () => {
  const store = keyedStore("key-umask-");
  const child = nativeKeyProbe(store, "process.umask(0o777)", `const c=createDbCrypto({dbPath});console.log(JSON.stringify({mode:fs.statSync(keyPath).mode&511,plain:c.decryptField(c.encryptField('dense',UNBOUND),UNBOUND)}));`);
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ mode: 0o600, plain: "dense" });
});

test("a key publication that fails part-way (a write or a close of the private temporary) is a typed refusal that leaves no key and no temporary", () => {
  // THE ONE WRITER (`publishKeyMaterial` → `atomicWriteFile` exclusive + durable):
  // the key is written to a private owned temporary and linked under its
  // name only when complete; any failure before that leaves nothing behind.
  for (const primaryFailure of [false, true]) {
    const store = keyedStore("key-close-"), { keyPath, keyHome } = store;
    const child = nativeKeyProbe(store, `
      const temporary=/\\/\\.[^/]+\\.write-\\d+-\\d+-[0-9a-f]+\\.tmp$/;
      const opens=new Map(),open=fs.openSync,close=fs.closeSync,write=fs.writeSync;
      fs.openSync=(p,...a)=>{const fd=open(p,...a);opens.set(fd,String(p));return fd;};
      let closeCalls=0;
      fs.closeSync=(fd)=>{const p=opens.get(fd);opens.delete(fd);close(fd);if(temporary.test(p??'')&&p.slice(0,p.lastIndexOf('/'))===keyHome){closeCalls++;throw new Error('PRIVATE_CLOSE_CANARY '+keyPath);}};
      if(${primaryFailure})fs.writeSync=(fd,...a)=>{const p=opens.get(fd)??'';if(temporary.test(p)&&p.slice(0,p.lastIndexOf('/'))===keyHome)throw new Error('PRIVATE_WRITE_CANARY '+keyPath);return write(fd,...a);};`,
      `try{createDbCrypto({dbPath});process.exitCode=1;}catch(e){console.log(JSON.stringify({code:e.code,message:e.message,closed:closeCalls>0,files:fs.readdirSync(keyHome).filter((name)=>name!=='stores')}));}`);
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ code: "persisted_key_publication_failed", message: "Persistent encryption key could not be admitted", closed: true, files: [] });
    expect(child.stderr).not.toContain("PRIVATE_"); expect(child.stderr).not.toContain(keyPath);
  }
});



test("every successful existing-key read acknowledges file and directory sync", () => {
  const store = keyedStore("key-reader-sync-"), { keyPath, keyHome } = store;
  createDbCrypto({ dbPath: store.dbPath, keyHome });
  const original = readFileSync(keyPath);
  for (const denyDirectorySync of [false, true]) {
    const child = nativeKeyProbe(store, `
      const opens=new Map(),open=fs.openSync,sync=fs.fsyncSync;
      fs.openSync=(p,...a)=>{const fd=open(p,...a);opens.set(fd,String(p));return fd;};let fileSync=0,dirSync=0;
      fs.fsyncSync=fd=>{const p=opens.get(fd);if(p===keyPath)fileSync++;if(p===keyHome){dirSync++;if(${denyDirectorySync})throw new Error('PRIVATE_SYNC_CANARY '+p);}return sync(fd);};`,
      `let code=null;try{createDbCrypto({dbPath});}catch(e){code=e.code;}console.log(JSON.stringify({fileSync,dirSync,code}));`);
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ fileSync: 1, dirSync: 1, code: denyDirectorySync ? "persisted_key_sync_failed" : null });
    expect(readFileSync(keyPath)).toEqual(original);
    expect(child.stderr).not.toContain("PRIVATE_"); expect(child.stderr).not.toContain(keyPath);
  }
});

test("read-only connections report the same owned schema version as the writer", () => {
  const dir = createTempDir("key-reader-schema-"); const path = join(dir, "web.db");
  const writer = new DbClient({ path });
  const expected = writer.schemaVersion; writer.close();
  const reader = new DbClient({ path, readOnly: true });
  try { expect(expected).toBeGreaterThan(0); expect(reader.schemaVersion).toBe(expected); }
  finally { reader.close(); }
});

test("a reader establishes its own sync acknowledgment while the publisher is held immediately after linking", async () => {
  const store = keyedStore("key-linked-reader-"), { keyPath, keyHome } = store;
  const creator = keyCreator(store, "publisher", true);
  const watchdog = setTimeout(() => creator.child.kill("SIGKILL"), 20_000);
  try {
    await creator.ready;
    expect(existsSync(keyPath)).toBe(true); expect(readFileSync(keyPath).length).toBe(32);
    const before = readFileSync(keyPath);
    const reader = nativeKeyProbe(store, `
      const opens=new Map(),open=fs.openSync,sync=fs.fsyncSync;
      fs.openSync=(p,...a)=>{const fd=open(p,...a);opens.set(fd,String(p));return fd;};let fileSync=0,dirSync=0;
      fs.fsyncSync=fd=>{const p=opens.get(fd);if(p===keyPath)fileSync++;if(p===keyHome)dirSync++;return sync(fd);};`,
      `const c=createDbCrypto({dbPath});console.log(JSON.stringify({fileSync,dirSync,cipher:c.encryptField('reader',UNBOUND)}));`);
    expect(reader.status, reader.stderr).toBe(0);
    const observed = JSON.parse(reader.stdout) as { fileSync: number; dirSync: number; cipher: string };
    expect(observed.fileSync).toBe(1); expect(observed.dirSync).toBe(1);
    expect(creator.child.exitCode).toBeNull(); expect(readFileSync(keyPath)).toEqual(before);
    creator.child.stdin.write("x"); const completed = await creator.joined;
    expect(completed.code, completed.stderr).toBe(0);
    const published = JSON.parse(completed.output.split("\n").find((line) => line.startsWith("{"))!) as { cipher: string };
    const crypto = createDbCrypto({ dbPath: store.dbPath, keyHome });
    expect(crypto.decryptField(observed.cipher, UNBOUND)).toBe("reader"); expect(crypto.decryptField(published.cipher, UNBOUND)).toBe("publisher");
  } finally {
    clearTimeout(watchdog); if (creator.child.exitCode === null) creator.child.kill("SIGKILL"); await creator.joined;
  }
}, 30_000);
