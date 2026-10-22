/**
 * THE HOST'S APP KEY CUSTODY — where the private keys of the Apps whose
 * custody is `host` (the agent and the verifier, `app-registry.ts`) live, and
 * the only code that ever holds one in memory.
 *
 * The keys live in THE KEY HOME (`src/filesystem/self-protection/key-home.ts`):
 * the one per-user folder where every harness key lives, outside every
 * checkout, closed to group and other, and on the keep-out list, so no
 * confined process, project or file door reaches it. Each App is one record
 * `<key home>/forge-apps/<role>.json` (mode 0600): its App id, slug and client
 * id (public facts) and its PEM key. cred-final's credential broker
 * (`engine/src/credentials/`, CRED-3) does not exist yet; when it does, this
 * module becomes its client and the records move into it — the custody port
 * ({@link AppKeyCustody}) is what the minting code depends on, never a path.
 *
 * The key NEVER leaves this module: the custody SIGNS (a JWT's signing input)
 * and answers the public identity; nothing returns, logs or serializes the
 * key, and a refusal names the role and the file, never its content.
 */
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFile } from "../../filesystem/atomic-write.ts";
import { ensurePrivateStateDirectory, PRIVATE_STATE_FILE_MODE } from "../../filesystem/private-state.ts";
import { admitHarnessKeyHome, type AdmittedKeyHome } from "../../filesystem/self-protection/key-home.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { parseJsonExact } from "../../kernel/json-integrity.ts";
import { auditEvent } from "../../shared/debug/debug-system.ts";
import { FORGE_APPS, forgeApp, type ForgeAppRole } from "./app-registry.ts";
import { ForgeError } from "./codes.ts";

const RECORD_SCHEMA = schemaId("forge-app-key", 1);
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

/** THE CUSTODY PORT the token minting depends on: the identity, and a signature made with the key it never hands out. */
export type AppKeyCustody = Readonly<{
  identity: (role: ForgeAppRole) => StoredAppIdentity;
  /** RSASSA-PKCS1-v1_5 with SHA-256 (JWT `RS256`) over `data`. */
  signRs256: (role: ForgeAppRole, data: Uint8Array) => Uint8Array;
}>;

function recordFile(keyHome: AdmittedKeyHome, role: ForgeAppRole): string {
  return join(keyHome, APPS_FOLDER, `${role}.json`);
}

function hostCustodied(role: ForgeAppRole): void {
  const custody = FORGE_APPS[role].custody;
  if (custody.kind !== "host") {
    throw new ForgeError("forge_request_invalid", `The ${role} App's key lives in the GitHub environment '${custody.environment}' (secret ${custody.keySecret}), never on the host.`, { role, environment: custody.environment });
  }
}

function privateKeyOf(pem: string, role: ForgeAppRole, file: string): KeyObject {
  let key: KeyObject;
  try { key = createPrivateKey({ key: pem, format: "pem" }); } catch {
    throw new ForgeError("forge_app_key_invalid", `The ${role} App's key is not a PEM private key.`, { role, file });
  }
  if (key.asymmetricKeyType !== "rsa") throw new ForgeError("forge_app_key_invalid", `The ${role} App's key is not an RSA key (GitHub App keys are).`, { role, file });
  return key;
}

/**
 * STORE an App's key material for `role` (host custody only), replacing any
 * earlier record (a rotated key). The PEM is checked to be an RSA private key
 * before anything is written; the record is written atomically at 0600.
 */
export function storeAppKey(keyHome: AdmittedKeyHome, role: ForgeAppRole, material: AppKeyMaterial): StoredAppIdentity {
  forgeApp(role);
  hostCustodied(role);
  const file = recordFile(keyHome, role);
  privateKeyOf(material.pem, role, file);
  if (!Number.isSafeInteger(material.appId) || material.appId <= 0 || !/^[a-z0-9-]+$/u.test(material.slug) || !/^[A-Za-z0-9.]+$/u.test(material.clientId)) {
    throw new ForgeError("forge_request_invalid", `The ${role} App's identity is malformed (App id, slug or client id).`, { role });
  }
  const identity: StoredAppIdentity = Object.freeze({ role, appId: material.appId, slug: material.slug, clientId: material.clientId, storedAt: new Date().toISOString() });
  ensurePrivateStateDirectory(join(keyHome, APPS_FOLDER));
  const written = atomicWriteFile(file, `${JSON.stringify({ schemaVersion: RECORD_SCHEMA, ...identity, pem: material.pem })}\n`, { requiredMode: PRIVATE_STATE_FILE_MODE, durable: true });
  if (!written.success) throw new ForgeError("forge_app_key_unavailable", `The ${role} App's key could not be written to the key home (${written.reason ?? "unknown"}).`, { role, file });
  auditEvent("forge-app-key-stored", { role, appId: identity.appId, slug: identity.slug });
  return identity;
}

type StoredRecord = StoredAppIdentity & Readonly<{ pem: string }>;

function readRecord(keyHome: AdmittedKeyHome, role: ForgeAppRole): StoredRecord {
  forgeApp(role);
  hostCustodied(role);
  const file = recordFile(keyHome, role);
  const stats = statSync(file, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile()) throw new ForgeError("forge_app_key_unavailable", `No key is stored for the ${role} App.`, { role, file });
  if ((stats.mode & 0o077) !== 0) throw new ForgeError("forge_app_key_invalid", `The ${role} App's key record is readable by other accounts (mode ${(stats.mode & 0o777).toString(8)}).`, { role, file });
  const parsed = parseJsonExact(readFileSync(file, "utf8"))?.value as Record<string, unknown> | undefined;
  if (parsed === undefined || parsed.schemaVersion !== RECORD_SCHEMA || parsed.role !== role || typeof parsed.pem !== "string"
    || typeof parsed.appId !== "number" || typeof parsed.slug !== "string" || typeof parsed.clientId !== "string" || typeof parsed.storedAt !== "string") {
    throw new ForgeError("forge_app_key_invalid", `The ${role} App's key record is not a ${RECORD_SCHEMA} record.`, { role, file });
  }
  return parsed as unknown as StoredRecord;
}

/** THE CUSTODY over an admitted key home. */
export function keyHomeCustody(keyHome: AdmittedKeyHome): AppKeyCustody {
  return Object.freeze({
    identity: (role: ForgeAppRole): StoredAppIdentity => {
      const record = readRecord(keyHome, role);
      return Object.freeze({ role: record.role, appId: record.appId, slug: record.slug, clientId: record.clientId, storedAt: record.storedAt });
    },
    signRs256: (role: ForgeAppRole, data: Uint8Array): Uint8Array => {
      const record = readRecord(keyHome, role);
      return sign("sha256", data, privateKeyOf(record.pem, role, recordFile(keyHome, role)));
    },
  });
}

/** The custody over THE harness key home (admitted through its one admission). */
export function harnessAppKeyCustody(): AppKeyCustody {
  return keyHomeCustody(admitHarnessKeyHome([]));
}
