/**
 * THE APP KEY CUSTODY — the one credential module through which every App
 * private key passes (the coordinator's ruling: the "host credential broker"
 * of the runbook IS the key home, reached only through this module; when
 * CRED-1's vault lands it moves underneath, and no caller changes).
 *
 * The records live in THE KEY HOME (`src/filesystem/self-protection/key-home.ts`):
 * the one per-user folder where every harness key lives, outside every
 * checkout, closed to group and other, and on the keep-out list. Each App is
 * one record `<key home>/forge-apps/<role>.json` (0600, written atomically and
 * durably): its App id, slug and client id (public facts) and, while it is
 * held, its PEM key.
 *
 * CUSTODY RIGHT AFTER CONVERSION: a converted App's key is stored here FIRST,
 * before any later step, whatever its custody, so a later failure never loses
 * it:
 * - `host` custody (agent, verifier): the record keeps the key; the custody
 *   ({@link keyHomeCustody}) answers the identity and SIGNS, and never hands
 *   the key out;
 * - `environment` custody (door, publisher): the key is HELD here only until
 *   it is in its GitHub environment secret ({@link pushHeldKey}); then the
 *   record keeps the public identity and the push time, and the key is gone
 *   from the host. A push that fails leaves it held, and the next run resumes.
 *
 * A refusal names the role and the file, never the key.
 */
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFile } from "../../filesystem/atomic-write.ts";
import { ensurePrivateStateDirectory, PRIVATE_STATE_FILE_MODE } from "../../filesystem/private-state.ts";
import type { AdmittedKeyHome } from "../../filesystem/self-protection/key-home.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { parseJsonExact } from "../../kernel/json-integrity.ts";
import { auditEvent } from "../../shared/debug/debug-system.ts";
import { FORGE_APPS, forgeApp, type ForgeAppRole } from "./app-registry.ts";
import { ForgeError } from "./codes.ts";

const RECORD_SCHEMA = schemaId("forge-app-key", 2);
/** The key home's folder of App records. */
const APPS_FOLDER = "forge-apps";

/** An App's public identity, as GitHub answered when it was created. */
export type StoredAppIdentity = Readonly<{
  role: ForgeAppRole;
  appId: number;
  slug: string;
  clientId: string;
  storedAt: string;
}>;

/** What GitHub's manifest conversion gives the custody (`POST /app-manifests/{code}/conversions`). */
export type AppKeyMaterial = Readonly<{ appId: number; slug: string; clientId: string; pem: string }>;

/** THE CUSTODY PORT the token minting depends on: the App's client id (a JWT's `iss`), and a signature made with the key it never hands out. */
export type AppKeyCustody = Readonly<{
  clientId: (role: ForgeAppRole) => string;
  /** RSASSA-PKCS1-v1_5 with SHA-256 (JWT `RS256`) over `data`. */
  signRs256: (role: ForgeAppRole, data: Uint8Array) => Uint8Array;
}>;

function recordFile(keyHome: AdmittedKeyHome, role: ForgeAppRole): string {
  return join(keyHome, APPS_FOLDER, `${role}.json`);
}

function hostCustodied(role: ForgeAppRole): void {
  const custody = FORGE_APPS[role].custody;
  if (custody.kind !== "host") {
    throw new ForgeError("forge_request_invalid", `The ${role} App's key lives in the GitHub environment '${custody.environment}' (secret ${custody.keySecret}), never on the host: it is only held here until it is pushed there.`, { role, environment: custody.environment });
  }
}

function environmentCustodied(role: ForgeAppRole): void {
  if (FORGE_APPS[role].custody.kind !== "environment") throw new ForgeError("forge_request_invalid", `The ${role} App's key stays in the host custody; it is never pushed anywhere.`, { role });
}

function privateKeyOf(pem: string, role: ForgeAppRole, file: string): KeyObject {
  let key: KeyObject;
  try { key = createPrivateKey({ key: pem, format: "pem" }); } catch {
    throw new ForgeError("forge_app_key_invalid", `The ${role} App's key is not a PEM private key.`, { role, file });
  }
  if (key.asymmetricKeyType !== "rsa") throw new ForgeError("forge_app_key_invalid", `The ${role} App's key is not an RSA key (GitHub App keys are).`, { role, file });
  return key;
}

/** The record as written: the public identity, the key while held, and when an environment key was pushed. */
type StoredRecord = StoredAppIdentity & Readonly<{ pem: string | null; pushedAt: string | null }>;

function writeRecord(keyHome: AdmittedKeyHome, record: StoredRecord): void {
  const file = recordFile(keyHome, record.role);
  ensurePrivateStateDirectory(join(keyHome, APPS_FOLDER));
  const written = atomicWriteFile(file, `${JSON.stringify({ schemaVersion: RECORD_SCHEMA, ...record })}\n`, { requiredMode: PRIVATE_STATE_FILE_MODE, durable: true });
  if (!written.success) throw new ForgeError("forge_app_key_unavailable", `The ${record.role} App's record could not be written to the key home (${written.reason ?? "unknown"}).`, { role: record.role, file });
}

/**
 * STORE a converted App's key material for `role` — the FIRST step after a
 * conversion, for every custody — replacing any earlier record (a rotated
 * key). The PEM is checked to be an RSA private key and the identity to be
 * well formed before anything is written.
 */
export function storeAppKey(keyHome: AdmittedKeyHome, role: ForgeAppRole, material: AppKeyMaterial): StoredAppIdentity {
  forgeApp(role);
  const file = recordFile(keyHome, role);
  privateKeyOf(material.pem, role, file);
  if (!Number.isSafeInteger(material.appId) || material.appId <= 0 || !/^[a-z0-9-]+$/u.test(material.slug) || !/^[A-Za-z0-9.]+$/u.test(material.clientId)) {
    throw new ForgeError("forge_request_invalid", `The ${role} App's identity is malformed (App id, slug or client id).`, { role });
  }
  const identity: StoredAppIdentity = Object.freeze({ role, appId: material.appId, slug: material.slug, clientId: material.clientId, storedAt: new Date().toISOString() });
  writeRecord(keyHome, { ...identity, pem: material.pem, pushedAt: null });
  auditEvent("forge-app-key-stored", { role, appId: identity.appId, slug: identity.slug, custody: FORGE_APPS[role].custody.kind });
  return identity;
}

function readRecord(keyHome: AdmittedKeyHome, role: ForgeAppRole): StoredRecord | undefined {
  forgeApp(role);
  const file = recordFile(keyHome, role);
  const stats = statSync(file, { throwIfNoEntry: false });
  if (stats === undefined) return undefined;
  if (!stats.isFile()) throw new ForgeError("forge_app_key_invalid", `The ${role} App's key record is not a regular file.`, { role, file });
  if ((stats.mode & 0o077) !== 0) throw new ForgeError("forge_app_key_invalid", `The ${role} App's key record is readable by other accounts (mode ${(stats.mode & 0o777).toString(8)}).`, { role, file });
  const parsed = parseJsonExact(readFileSync(file, "utf8"))?.value as Record<string, unknown> | undefined;
  if (parsed === undefined || parsed.schemaVersion !== RECORD_SCHEMA || parsed.role !== role || (typeof parsed.pem !== "string" && parsed.pem !== null)
    || (typeof parsed.pushedAt !== "string" && parsed.pushedAt !== null)
    || typeof parsed.appId !== "number" || typeof parsed.slug !== "string" || typeof parsed.clientId !== "string" || typeof parsed.storedAt !== "string") {
    throw new ForgeError("forge_app_key_invalid", `The ${role} App's key record is not a ${RECORD_SCHEMA} record.`, { role, file });
  }
  return parsed as unknown as StoredRecord;
}

/** A host-custody record with its key, or the typed refusal. */
function hostRecord(keyHome: AdmittedKeyHome, role: ForgeAppRole): StoredRecord & Readonly<{ pem: string }> {
  hostCustodied(role);
  const record = readRecord(keyHome, role);
  if (record === undefined) throw new ForgeError("forge_app_key_unavailable", `No key is stored for the ${role} App.`, { role, file: recordFile(keyHome, role) });
  if (record.pem === null) throw new ForgeError("forge_app_key_invalid", `The ${role} App's record holds no key.`, { role, file: recordFile(keyHome, role) });
  return record as StoredRecord & Readonly<{ pem: string }>;
}

/** Where `role`'s App stands in the custody: nothing stored, its key held (an environment key not yet pushed), or done. */
export type AppKeyState = Readonly<{ state: "absent" }> | Readonly<{ state: "held" | "done"; identity: StoredAppIdentity; pushedAt: string | null }>;

export function appKeyState(keyHome: AdmittedKeyHome, role: ForgeAppRole): AppKeyState {
  const record = readRecord(keyHome, role);
  if (record === undefined) return { state: "absent" };
  const identity: StoredAppIdentity = Object.freeze({ role: record.role, appId: record.appId, slug: record.slug, clientId: record.clientId, storedAt: record.storedAt });
  const held = FORGE_APPS[role].custody.kind === "environment" && record.pem !== null;
  return Object.freeze({ state: held ? "held" : "done", identity, pushedAt: record.pushedAt });
}

/**
 * PUSH a held environment key: `push` receives the key and the identity (it
 * writes the environment secret and variable); only when it succeeds is the
 * key dropped from the record (the identity and the push time stay). A push
 * that throws leaves the key held, for the next run to resume.
 */
export async function pushHeldKey(keyHome: AdmittedKeyHome, role: ForgeAppRole, push: (pem: string, identity: StoredAppIdentity) => Promise<void>): Promise<StoredAppIdentity> {
  environmentCustodied(role);
  const record = readRecord(keyHome, role);
  if (record === undefined || record.pem === null) throw new ForgeError("forge_app_key_unavailable", `No ${role} App key is held to push.`, { role, file: recordFile(keyHome, role) });
  const identity: StoredAppIdentity = Object.freeze({ role: record.role, appId: record.appId, slug: record.slug, clientId: record.clientId, storedAt: record.storedAt });
  await push(record.pem, identity);
  writeRecord(keyHome, { ...identity, pem: null, pushedAt: new Date().toISOString() });
  auditEvent("forge-app-key-pushed", { role, appId: identity.appId, slug: identity.slug });
  return identity;
}

/** THE CUSTODY over an admitted key home. */
export function keyHomeCustody(keyHome: AdmittedKeyHome): AppKeyCustody {
  return Object.freeze({
    clientId: (role: ForgeAppRole): string => hostRecord(keyHome, role).clientId,
    signRs256: (role: ForgeAppRole, data: Uint8Array): Uint8Array => {
      const record = hostRecord(keyHome, role);
      return sign("sha256", data, privateKeyOf(record.pem, role, recordFile(keyHome, role)));
    },
  });
}

/**
 * THE CUSTODY OF AN ENVIRONMENT APP INSIDE ITS OWN JOB: the door's and the
 * publisher's keys exist only as their protected environment's secret (GH-KEYS).
 * A workflow job that declares that environment is handed the key
 * (`keySecret`) and the client id (`clientIdVariable`) in its process
 * environment. They are read at each use, held nowhere else, and never
 * written. Outside such a job they are absent (`forge_app_key_unavailable`),
 * and a host App never signs through here.
 */
export function environmentKeyCustody(): AppKeyCustody {
  const handed = (role: ForgeAppRole): Readonly<{ keySecret: string; clientIdVariable: string }> => {
    const custody = FORGE_APPS[role].custody;
    if (custody.kind !== "environment") throw new ForgeError("forge_app_key_unavailable", `The ${role} App's key lives in the key home, not in an environment.`, { role });
    for (const variable of [custody.keySecret, custody.clientIdVariable]) {
      if ((process.env[variable] ?? "").trim() === "") {
        throw new ForgeError("forge_app_key_unavailable", `${variable} is not set: the ${role} App's key and client id exist only inside a job of the '${custody.environment}' environment.`, { role, variable, environment: custody.environment });
      }
    }
    return custody;
  };
  return Object.freeze({
    clientId: (role: ForgeAppRole): string => process.env[handed(role).clientIdVariable]!.trim(),
    signRs256: (role: ForgeAppRole, data: Uint8Array): Uint8Array => sign("sha256", data, privateKeyOf(process.env[handed(role).keySecret]!, role, handed(role).keySecret)),
  });
}
