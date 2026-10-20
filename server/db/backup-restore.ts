/**
 * BACKUP AND RESTORE — one documented flow for the database and the key
 * material that opens it, with a verification step on BOTH sides.
 *
 * THE GAP THIS OWNS: the operator docs said "back up the key home and the
 * SQLite databases before upgrading", and the only copies the product made
 * were internal ones (a pre-migration copy, a pre-re-key copy, the conversation
 * archive's pre-archive copy). None of them was invokable as a backup, none
 * carried the key material, and nothing restored or proved a copy. A backup
 * the operator could not restore is not a backup.
 *
 * A BACKUP is a NEW directory (`--to` must not exist) written whole and proved
 * before it takes its name:
 *
 *   manifest.json   the schema, the source path, the file digests and the
 *                   table counts (written by the one atomic writer, 0600)
 *   database.sqlite the verified copy the one copy writer proves
 *                   (`writeVerifiedCopy`: `quick_check` + the table counts)
 *   <key name>.key  the key material (or `.key.salt` in passphrase mode) and
 *   <key name>.bound the bound-fields marker, copied byte for byte
 *
 * The copy is then proved AGAIN against the key material in the bundle
 * (`databaseKeyProof`): a backup whose key does not open it is refused, not
 * shipped. A database with nothing sealed yet honestly records `empty` — a
 * key can then be proved only by the restored database's own open.
 *
 * A RESTORE reads the manifest as untrusted input, checks every digest and
 * size, `quick_check`s the copy, proves the bundle's key opens it, proves the
 * key home's existing material (when there is any) opens it too, holds the
 * target database ALONE (the server must be stopped), keeps a verified
 * `<db>.pre-restore` copy of what it is about to replace, then publishes the
 * key material (only when the key home has none for this database), copies the
 * database into place atomically and proves the RESULT opens under the key
 * home's key. Any failure puts the pre-restore copy back and says so.
 *
 * WHAT THIS FLOW DOES NOT COVER, stated instead of implied: the timeline
 * ledger is a separate append-only store and is not in the bundle; pre-migration
 * and pre-re-key copies beside the database are not either (their retired keys
 * stay in their own key-home slots); and a database sealed under a key the key
 * home no longer has is refused, never re-keyed by a restore. Restore into a
 * different folder installs the bundle's key under that folder's key name,
 * which is what makes disaster recovery onto a fresh checkout work.
 */

import { closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { movePath } from "../../engine/src/filesystem/move-path.ts";
import { HarnessError } from "../../engine/src/kernel/errors.ts";
import { schemaId } from "../../engine/src/kernel/product-identity.ts";
import {
  ADOPTED_FIXED_SALT_BYTES,
  PERSISTED_KEY_BYTES,
  admitHarnessKeyHome,
  bestEffort,
  canonicalJson,
  createOwnedTemporaryDirectory,
  databaseBindingRecord,
  databaseKeyFile,
  databaseSaltFile,
  ensurePrivateStateDirectory,
  establishWalJournal,
  preRestoreCopyPath,
  publishKeyMaterial,
  registerHarnessStore,
  removeOwnedTemporaryDirectory,
  stagingCopyPath,
  type AdmittedKeyHome,
} from "../kernel/canonical.ts";
import { serverConfig } from "../kernel/config.ts";
import { sha256OfFile } from "../kernel/digest.ts";
import { readFileText } from "../filesystem/file-read.ts";
import { createDbCryptoFromMaterial, databaseKeyProof, type DbCrypto } from "./db-crypto.ts";
import { createPrivateCopyTarget, databaseTableCounts, holdDatabaseAlone, readPrivateKeyFile, writeVerifiedCopy } from "./db-files.ts";

export const DATABASE_BACKUP_SCHEMA = schemaId("database-backup", 1);

/** The file names a bundle holds at its top level. */
const DATABASE_FILE = "database.sqlite";
const MANIFEST_FILE = "manifest.json";
/** A manifest is small by construction; a larger one is not read as input. */
const MAX_MANIFEST_BYTES = 1 << 20;
/** The largest key material this harness writes (the adopted fixed salt) and a bound marker. */
const MAX_KEY_MATERIAL_BYTES = Math.max(PERSISTED_KEY_BYTES, ADOPTED_FIXED_SALT_BYTES);
const MAX_BINDING_BYTES = 64;

const FILE_ENTRY = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  bytes: z.number().int().nonnegative(),
});

const MANIFEST = z.strictObject({
  schema: z.literal(DATABASE_BACKUP_SCHEMA),
  createdAt: z.string().min(1),
  source: z.string().min(1),
  database: FILE_ENTRY,
  key: z.strictObject({
    mode: z.enum(["key", "passphrase-salt"]),
    material: FILE_ENTRY,
    binding: FILE_ENTRY.optional(),
  }),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});

type Manifest = z.infer<typeof MANIFEST>;
export type DatabaseKeyMode = Manifest["key"]["mode"];

export type DatabaseBackupResult = Readonly<{
  database: string;
  destination: string;
  manifest: string;
  copy: string;
  /** The database copy's SHA-256, as the manifest records it. */
  digest: string;
  bytes: number;
  keyMode: DatabaseKeyMode;
  keyFile: string;
  /** What the bundle's own key proof said about the copy (`empty`: nothing sealed yet). */
  keyProof: "opens" | "empty";
  counts: Readonly<Record<string, number>>;
  createdAt: string;
}>;

export type DatabaseRestoreResult = Readonly<{
  database: string;
  source: string;
  digest: string;
  counts: Readonly<Record<string, number>>;
  keyMode: DatabaseKeyMode;
  /** `backup` when the key home had no material for the target and the bundle's was installed; `existing` when its own key was kept. */
  keySource: "backup" | "existing";
  keyProof: "opens" | "empty";
  /** The verified copy of what the restore replaced, when there was a database there. */
  preRestoreCopy?: string;
}>;

function refuseBackup(message: string, code: string): never {
  throw new HarnessError(message, code);
}

/** One material's mode, from the passphrase the caller configured. */
function keyModeFor(passphrase: string): DatabaseKeyMode {
  return passphrase.length > 0 ? "passphrase-salt" : "key";
}

/** Where the key home keeps the live material for `dbPath` in `mode`. */
function keyMaterialPath(keyHome: AdmittedKeyHome, dbPath: string, mode: DatabaseKeyMode): string {
  return mode === "passphrase-salt" ? databaseSaltFile(keyHome, dbPath) : databaseKeyFile(keyHome, dbPath);
}

/** The live key material of `dbPath`; a missing or wrong-sized material is a typed refusal naming the remedy. */
function liveKeyMaterial(keyHome: AdmittedKeyHome, dbPath: string, mode: DatabaseKeyMode, code: string): Readonly<{ path: string; bytes: Buffer }> {
  const path = keyMaterialPath(keyHome, dbPath, mode);
  const bytes = readPrivateKeyFile(path, code);
  if (bytes === undefined) {
    refuseBackup(
      `The key home (${keyHome}) holds no ${mode === "passphrase-salt" ? "passphrase salt" : "key"} for ${dbPath}. A backup carries the material that opens the database; ` +
        `an install still keeping its key beside the database can move it with \`npm run db-key -- relocate --db ${dbPath}\`. Nothing was changed.`,
      code,
    );
  }
  assertKeyMaterialSize(bytes, mode, code);
  return Object.freeze({ path, bytes });
}

function assertKeyMaterialSize(bytes: Uint8Array, mode: DatabaseKeyMode, code: string): void {
  const allowed = mode === "passphrase-salt" ? [PERSISTED_KEY_BYTES, ADOPTED_FIXED_SALT_BYTES] : [PERSISTED_KEY_BYTES];
  if (!allowed.includes(bytes.length)) refuseBackup(`The ${mode === "passphrase-salt" ? "passphrase salt" : "key"} is ${String(bytes.length)} bytes, not one this harness writes; nothing was changed.`, code);
}

/** A crypto over the material a bundle (or a key home) holds. */
function cryptoFor(material: Uint8Array, mode: DatabaseKeyMode, passphrase: string): DbCrypto {
  return createDbCryptoFromMaterial(material, mode === "passphrase-salt" ? passphrase : "");
}

function quickCheck(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
  return row === undefined ? "no result" : String(Object.values(row)[0]);
}

/** The copy's source facts (table counts) must be exactly the copy's facts, and SQLite must call it ok. */
function assertDatabaseCopy(db: DatabaseSync, counts: Readonly<Record<string, number>>, what: string, code: string): void {
  const verdict = quickCheck(db);
  if (verdict !== "ok") refuseBackup(`${what} did not verify (SQLite quick_check: ${verdict}); nothing was changed.`, code);
  if (!isDeepStrictEqual(databaseTableCounts(db), counts)) refuseBackup(`${what} does not hold the rows its manifest names; nothing was changed.`, code);
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Copy `source` over `target` through a private staging name in the target's
 * own folder, fsync it, then move it into place. One filesystem, one rename;
 * a copy that did not land never replaces the target.
 */
function copyIntoPlace(source: string, target: string): void {
  const staging = stagingCopyPath(target);
  createPrivateCopyTarget(staging);
  try {
    copyFileSync(source, staging);
    const fd = openSync(staging, constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    movePath(staging, target);
    syncDirectory(dirname(target));
  } catch (error) {
    bestEffort(() => rmSync(staging, { force: true }));
    throw error;
  }
}

/** A provenance/digest entry for one file in the bundle, refusing a link or a folder. */
function fileEntry(path: string, name: string): Readonly<{ name: string; sha256: string; bytes: number }> {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) refuseBackup(`${path} is not a regular file; nothing was changed.`, "db_backup_path_unsafe");
  return Object.freeze({ name, sha256: sha256OfFile(path), bytes: stat.size });
}

/** Is `name` a top-level bundle file name this manifest may name? */
function bundlePath(directory: string, name: string): string {
  if (name !== basename(name) || name === "." || name === "..") refuseBackup(`The backup manifest names ${JSON.stringify(name)}, which is not a file in its folder; nothing was changed.`, "db_restore_manifest_invalid");
  return join(directory, name);
}

/**
 * BACK UP one database and the key material that opens it into a NEW folder.
 * The source is held alone (a running server refuses the operation) and left
 * in WAL mode; the destination is staged beside its final name and renamed
 * only after every check passes.
 */
export function createDatabaseBackup(options: Readonly<{ dbPath: string; to: string; keyHome?: AdmittedKeyHome; passphrase?: string; now?: () => Date }>): DatabaseBackupResult {
  const database = resolve(options.dbPath);
  if (database === ":memory:") refuseBackup("An in-memory database has no files to back up.", "db_backup_database_missing");
  const source = lstatSync(database, { throwIfNoEntry: false });
  if (source === undefined) refuseBackup(`There is no database at ${database}.`, "db_backup_database_missing");
  if (!source.isFile()) refuseBackup(`${database} is not a regular file; a backup copies a regular database file, never a link or a folder.`, "db_backup_path_unsafe");
  const destination = resolve(options.to);
  if (existsSync(destination)) refuseBackup(`${destination} already exists; a backup is written into a NEW folder (nothing there is overwritten).`, "db_backup_destination_exists");
  const passphrase = options.passphrase ?? "";
  const mode = keyModeFor(passphrase);
  const keyHome = options.keyHome ?? admitHarnessKeyHome([database]);
  const material = liveKeyMaterial(keyHome, database, mode, "db_backup_key_missing");
  const bindingPath = databaseBindingRecord(keyHome, database);
  const binding = readPrivateKeyFile(bindingPath, "db_backup_key_invalid");
  const crypto = cryptoFor(material.bytes, mode, passphrase);
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  ensurePrivateStateDirectory(dirname(destination));
  const staging = createOwnedTemporaryDirectory(dirname(destination), `${basename(destination)}.staging-`);
  try {
    const copyPath = join(staging, DATABASE_FILE);
    let counts: Readonly<Record<string, number>>;
    let sourceProof: ReturnType<typeof databaseKeyProof>;
    const raw = new DatabaseSync(database);
    try {
      holdDatabaseAlone(raw, database, "db_backup_database_busy");
      counts = databaseTableCounts(raw);
      sourceProof = databaseKeyProof(raw, crypto);
      if (sourceProof === "wrong") refuseBackup(`The key home's material does not open ${database} (a sealed value did not decrypt); nothing was backed up.`, "db_backup_wrong_key");
      writeVerifiedCopy(raw, copyPath, (copy) => isDeepStrictEqual(databaseTableCounts(copy), counts), "the backup copy of the database");
    } finally {
      try { establishWalJournal(raw, serverConfig.dbBusyTimeoutMs); } finally { raw.close(); }
    }
    // The key material travels as the bytes the database opens under, never
    // as a rendered value: the backup is only useful if the pair is exact.
    publishKeyMaterial(join(staging, basename(material.path)), material.bytes);
    if (binding !== undefined) publishKeyMaterial(join(staging, basename(bindingPath)), binding);
    // PROVE THE COPY with the very material that travels beside it, not only
    // the source: a copy that does not open under its key is not a backup.
    const copy = new DatabaseSync(copyPath, { readOnly: true });
    let copyProof: ReturnType<typeof databaseKeyProof>;
    try {
      copyProof = databaseKeyProof(copy, crypto);
      assertDatabaseCopy(copy, counts, "the backup copy of the database", "db_backup_unverified");
    } finally {
      copy.close();
    }
    if (copyProof === "wrong") refuseBackup("The backup copy does not open under the key material written beside it; nothing was kept.", "db_backup_unverified");
    const databaseEntry = fileEntry(copyPath, DATABASE_FILE);
    const materialEntry = fileEntry(join(staging, basename(material.path)), basename(material.path));
    const bindingEntry = binding === undefined ? undefined : fileEntry(join(staging, basename(bindingPath)), basename(bindingPath));
    const manifest: Manifest = {
      schema: DATABASE_BACKUP_SCHEMA,
      createdAt,
      source: database,
      database: databaseEntry,
      key: { mode, material: materialEntry, ...(bindingEntry === undefined ? {} : { binding: bindingEntry }) },
      counts: { ...counts },
    };
    const manifestPath = join(staging, MANIFEST_FILE);
    const written = atomicWriteFile(manifestPath, canonicalJson(manifest), { exclusive: true, durable: true, exactMode: 0o600, createParentDirectories: false });
    if (!written.success) refuseBackup(`The backup manifest could not be written at ${manifestPath}: ${written.reason ?? "unknown"}; nothing was kept.`, "db_backup_unwritten");
    movePath(staging, destination);
    syncDirectory(dirname(destination));
    return Object.freeze({
      database,
      destination,
      manifest: join(destination, MANIFEST_FILE),
      copy: join(destination, DATABASE_FILE),
      digest: databaseEntry.sha256,
      bytes: databaseEntry.bytes,
      keyMode: mode,
      keyFile: join(destination, basename(material.path)),
      keyProof: copyProof,
      counts: Object.freeze({ ...counts }),
      createdAt,
    });
  } catch (error) {
    if (existsSync(staging)) removeOwnedTemporaryDirectory(staging);
    throw error;
  }
}

/** The verified contents of a bundle, before anything in the target is touched. */
type VerifiedBundle = Readonly<{
  manifest: Manifest;
  directory: string;
  databasePath: string;
  keyMaterial: Buffer;
  binding: Buffer | undefined;
  crypto: DbCrypto;
  keyProof: "opens" | "empty";
}>;

function readManifest(directory: string): Manifest {
  const path = join(directory, MANIFEST_FILE);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) refuseBackup(`${path} is not a regular file; nothing was changed.`, "db_restore_manifest_missing");
  if (stat.size > MAX_MANIFEST_BYTES) refuseBackup(`${path} is larger than a backup manifest can be (${String(stat.size)} bytes); nothing was changed.`, "db_restore_manifest_invalid");
  let text: string;
  try {
    text = readFileText(path);
  } catch (error) {
    refuseBackup(`${path} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"}); nothing was changed.`, "db_restore_manifest_missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HarnessError(`${path} is not valid JSON; nothing was changed.`, "db_restore_manifest_invalid");
  }
  const checked = MANIFEST.safeParse(parsed);
  if (!checked.success) refuseBackup(`${path} does not describe a ${DATABASE_BACKUP_SCHEMA} backup; nothing was changed.`, "db_restore_manifest_invalid");
  return checked.data;
}

function verifyBundleFile(directory: string, entry: Manifest["database"]): string {
  const path = bundlePath(directory, entry.name);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) refuseBackup(`${path}, named by the backup manifest, is missing or not a regular file; nothing was changed.`, "db_restore_unverified");
  if (stat.size !== entry.bytes) refuseBackup(`${path} is ${String(stat.size)} bytes; the manifest records ${String(entry.bytes)}. The backup is damaged; nothing was changed.`, "db_restore_unverified");
  if (sha256OfFile(path) !== entry.sha256) refuseBackup(`${path}'s digest does not match the manifest. The backup is damaged; nothing was changed.`, "db_restore_unverified");
  return path;
}

/** Read and prove every byte a restore will use, without touching the target. */
function verifyBundle(directory: string, passphrase: string): VerifiedBundle {
  const manifest = readManifest(directory);
  const databasePath = verifyBundleFile(directory, manifest.database);
  if (manifest.key.material.bytes > MAX_KEY_MATERIAL_BYTES) refuseBackup(`${manifest.key.material.name} is larger than any key material this harness writes; nothing was changed.`, "db_restore_key_invalid");
  if (manifest.key.binding !== undefined && manifest.key.binding.bytes > MAX_BINDING_BYTES) refuseBackup(`${manifest.key.binding.name} is larger than a bound-fields marker; nothing was changed.`, "db_restore_manifest_invalid");
  const materialPath = verifyBundleFile(directory, manifest.key.material);
  const binding = manifest.key.binding === undefined ? undefined : readFileSync(verifyBundleFile(directory, manifest.key.binding));
  const keyMaterial = readFileSync(materialPath);
  assertKeyMaterialSize(keyMaterial, manifest.key.mode, "db_restore_key_invalid");
  const crypto = cryptoFor(keyMaterial, manifest.key.mode, passphrase);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let keyProof: ReturnType<typeof databaseKeyProof>;
  try {
    keyProof = databaseKeyProof(db, crypto);
    if (keyProof === "wrong") refuseBackup(`The backup's key material does not open its database copy (a sealed value did not decrypt). The backup is not usable; nothing was changed.`, "db_restore_wrong_key");
    assertDatabaseCopy(db, manifest.counts, "The backup's database copy", "db_restore_unverified");
  } finally {
    db.close();
  }
  return Object.freeze({ manifest, directory, databasePath, keyMaterial, binding, crypto, keyProof });
}

/** Publish the bundle's material under the target's key name (only when the key home has none). */
function installBundleKey(keyHome: AdmittedKeyHome, target: string, bundle: VerifiedBundle): void {
  const materialPath = keyMaterialPath(keyHome, target, bundle.manifest.key.mode);
  publishKeyMaterial(materialPath, bundle.keyMaterial);
  // The marker is not proof of anything on its own; it records that this key
  // has sealed bound fields, so the bound-fields migration never re-seals an
  // unbound value planted later.
  if (bundle.binding !== undefined) {
    const bindingPath = databaseBindingRecord(keyHome, target);
    if (!existsSync(bindingPath)) publishKeyMaterial(bindingPath, bundle.binding);
  }
}

/**
 * RESTORE one verified bundle over `dbPath` (or into a fresh path). The target
 * is held alone, kept as a verified `<db>.pre-restore` copy, replaced
 * atomically, and the result is proved to open under the key home's key. A
 * failed proof puts the pre-restore copy back.
 */
export function restoreDatabaseBackup(options: Readonly<{ from: string; dbPath: string; keyHome?: AdmittedKeyHome; passphrase?: string }>): DatabaseRestoreResult {
  const directory = resolve(options.from);
  const target = resolve(options.dbPath);
  if (target === ":memory:") refuseBackup("An in-memory database cannot be restored from files.", "db_restore_path_unsafe");
  const passphrase = options.passphrase ?? "";
  const bundle = verifyBundle(directory, passphrase);
  const configuredMode = keyModeFor(passphrase);
  if (configuredMode !== bundle.manifest.key.mode) {
    refuseBackup(
      `The backup carries ${bundle.manifest.key.mode === "passphrase-salt" ? "a passphrase salt" : "a key file"}, but this host is configured for ` +
        `${configuredMode === "passphrase-salt" ? "a passphrase (HARNESS_WEB_DB_KEY is set)" : "a key file (HARNESS_WEB_DB_KEY is unset)"}. Nothing was changed.`,
      "db_restore_key_mode_mismatch",
    );
  }
  const keyHome = options.keyHome ?? admitHarnessKeyHome([target]);
  const materialPath = keyMaterialPath(keyHome, target, bundle.manifest.key.mode);
  const existing = readPrivateKeyFile(materialPath, "db_restore_key_invalid");
  const crypto = existing === undefined ? bundle.crypto : cryptoFor(existing, bundle.manifest.key.mode, passphrase);
  const keySource: "backup" | "existing" = existing === undefined ? "backup" : "existing";
  if (existing !== undefined) {
    // The key home's own material must open the backup too, or replacing this
    // database would leave the restored rows unreadable to the server.
    const probe = new DatabaseSync(bundle.databasePath, { readOnly: true });
    try {
      if (databaseKeyProof(probe, crypto) === "wrong") {
        refuseBackup(
          `The key home holds a DIFFERENT ${bundle.manifest.key.mode === "passphrase-salt" ? "passphrase salt" : "key"} for ${target} and it does not open the backup. ` +
            `Nothing was changed. Restore into a fresh folder, or move the existing key home material aside first.`,
          "db_restore_key_conflict",
        );
      }
    } finally {
      probe.close();
    }
  }
  const present = lstatSync(target, { throwIfNoEntry: false });
  if (present !== undefined && !present.isFile()) refuseBackup(`${target}, where the database goes, is not a regular file (a link or a folder); a restore never writes through one.`, "db_restore_path_unsafe");
  let preRestoreCopy: string | undefined;
  if (present !== undefined) {
    const current = new DatabaseSync(target);
    try {
      holdDatabaseAlone(current, target, "db_restore_database_busy");
      if (databaseKeyProof(current, crypto) === "wrong") {
        refuseBackup(`${target} does not open under the key this restore would leave in the key home, so its pre-restore copy could not be read afterwards. Nothing was changed.`, "db_restore_key_conflict");
      }
      const before = databaseTableCounts(current);
      const copy = preRestoreCopyPath(target);
      writeVerifiedCopy(current, copy, (verified) => isDeepStrictEqual(databaseTableCounts(verified), before), "the pre-restore copy of the database");
      preRestoreCopy = copy;
    } finally {
      // LEFT IN DELETE MODE ON PURPOSE: the file is about to be replaced, and
      // returning it to WAL would leave a stale -wal beside the new database.
      // A restore that stops here leaves a valid database; the next server
      // open enters WAL itself.
      current.close();
    }
  } else {
    ensurePrivateStateDirectory(dirname(target));
  }
  if (existing === undefined) installBundleKey(keyHome, target, bundle);
  // Registered BEFORE the swap: a failed copy must not leave a restored
  // database outside the registry (its records are harmless when the path is
  // unchanged or absent).
  registerHarnessStore(keyHome, target);
  let keyProof: "opens" | "empty" = bundle.keyProof;
  try {
    copyIntoPlace(bundle.databasePath, target);
    const restored = new DatabaseSync(target, { readOnly: true });
    try {
      assertDatabaseCopy(restored, bundle.manifest.counts, "The restored database", "db_restore_unverified");
      const proof = databaseKeyProof(restored, crypto);
      if (proof === "wrong") refuseBackup("The restored database does not open under the key home's key; the pre-restore copy is being put back.", "db_restore_unverified");
      keyProof = proof;
    } finally {
      restored.close();
    }
  } catch (error) {
    const reason = `${error instanceof Error ? error.message : String(error)}`;
    if (preRestoreCopy !== undefined) {
      try {
        copyIntoPlace(preRestoreCopy, target);
      } catch (rollbackError) {
        throw new HarnessError(
          `${reason} The pre-restore copy at ${preRestoreCopy} could NOT be put back (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}); the target may hold the unverified copy.`,
          "db_restore_rollback_failed",
        );
      }
      throw new HarnessError(`${reason} The pre-restore copy at ${preRestoreCopy} was put back.`, (error as { code?: string }).code ?? "db_restore_unverified");
    }
    rmSync(target, { force: true });
    throw error;
  }
  return Object.freeze({
    database: target,
    source: bundle.manifest.source,
    digest: bundle.manifest.database.sha256,
    counts: Object.freeze({ ...bundle.manifest.counts }),
    keyMode: bundle.manifest.key.mode,
    keySource,
    keyProof,
    ...(preRestoreCopy === undefined ? {} : { preRestoreCopy }),
  });
}
