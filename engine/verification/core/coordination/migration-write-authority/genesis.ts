/**
 * MigrationWriteAuthority — genesis record types + verifier (pure).
 *
 * MWA cannot create its own genesis: the activation lock cannot hash itself
 * (MWA-DESIGN §5.1), and receipts cannot authenticate themselves. The initial
 * authority root + DB + first journal entry must be created by an external,
 * single-use authority. The genesis record is **evidence**, not a bearer
 * capability: the first `acquire` verifies the live facts match the record.
 *
 * Design authority: MWA-DESIGN §5.2.
 */

import { canonicalHash, deepFreeze, SHA256_HEX_REGEX } from "../../../../src/kernel/integrity.ts";
import {
  MWA_BACKEND_SCHEMA_VERSION,
  MWA_RECEIPT_AUTHORITY,
  type BackendErrorCode,
  type PathIdentity,
  type Sha256,
} from "./contracts.ts";

export const GENESIS_SCHEMA_VERSION = "bridlewise-migration-authority-genesis/v1" as const;

/**
 * The full genesis record written by the external
 * `FoundationSeedTransactionAuthority`. Persisted as
 * `authority_meta.genesis_record_identity` AND as an external immutable
 * receipt. `receiptAuthority` is evidence-only — never a bearer capability.
 */
export type MigrationWriteAuthorityGenesisRecord = Readonly<{
  schemaVersion: typeof GENESIS_SCHEMA_VERSION;
  repositoryIdentity: Sha256;
  commonDirectoryIdentity: Sha256;
  objectStoreIdentity: Sha256;
  objectFormat: "sha1" | "sha256";
  authorityRootPath: string;
  authorityRootIdentity: PathIdentity;
  backendSchemaVersion: typeof MWA_BACKEND_SCHEMA_VERSION;
  initialFenceGeneration: "0";
  sqliteVersion: string;
  sqliteSourceIdentity: Sha256;
  genesisWallIso: string;
  creatingAuthorityIdentity: Sha256;
  creatingAuthorityKind: "foundation-seed-transaction-authority";
  receiptAuthority: typeof MWA_RECEIPT_AUTHORITY;
}>;

/** Live repository facts the verifier checks the genesis record against. */
export type GenesisVerificationFacts = Readonly<{
  repositoryIdentity: Sha256;
  commonDirectoryIdentity: Sha256;
  objectStoreIdentity: Sha256;
  objectFormat: "sha1" | "sha256";
  commonDirectoryPath: string;
  authorityRootPath: string;
  authorityRootIdentity: PathIdentity;
  backendSchemaVersion: string;
}>;

export type GenesisVerificationResult =
  | Readonly<{ verified: true; genesisIdentity: Sha256 }>
  | Readonly<{ verified: false; code: BackendErrorCode; message: string }>;

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && SHA256_HEX_REGEX.test(value);
}

function fail(code: BackendErrorCode, message: string): GenesisVerificationResult {
  return deepFreeze({ verified: false, code, message });
}

/**
 * Verifies a genesis record against live repository facts. Returns
 * `{ verified: true, genesisIdentity }` on match, or `{ verified: false, ... }`
 * with a typed backend error code on any mismatch. Checks:
 * - schema/backend versions are the closed constants;
 * - receipt authority is evidence-only;
 * - the creating authority kind is the single allowed kind;
 * - the authority root is a `0700` private child of the common directory;
 * - the authority root path is lexically beneath the common directory;
 * - repository/common-directory/object-store identities and object format
 *   match the live facts.
 */
export function verifyGenesisRecord(
  record: MigrationWriteAuthorityGenesisRecord,
  facts: GenesisVerificationFacts,
): GenesisVerificationResult {
  if (record === null || typeof record !== "object") {
    return fail("backend-corrupt", "genesis record is not an object");
  }
  if (record.schemaVersion !== GENESIS_SCHEMA_VERSION) {
    return fail("schema-unsupported", "genesis schemaVersion mismatch");
  }
  if (record.backendSchemaVersion !== MWA_BACKEND_SCHEMA_VERSION) {
    return fail("schema-unsupported", "genesis backendSchemaVersion mismatch");
  }
  if (record.receiptAuthority !== MWA_RECEIPT_AUTHORITY) {
    return fail("backend-corrupt", "genesis receiptAuthority is not evidence-only");
  }
  if (record.creatingAuthorityKind !== "foundation-seed-transaction-authority") {
    return fail("backend-corrupt", "genesis creatingAuthorityKind is invalid");
  }
  if (record.initialFenceGeneration !== "0") {
    return fail("backend-corrupt", "genesis initialFenceGeneration must be 0");
  }
  if (!isSha256(record.creatingAuthorityIdentity)) {
    return fail("backend-corrupt", "genesis creatingAuthorityIdentity is invalid");
  }
  if (!isSha256(record.sqliteSourceIdentity)) {
    return fail("backend-corrupt", "genesis sqliteSourceIdentity is invalid");
  }
  // Authority root is a 0700 private directory.
  if ((record.authorityRootIdentity.mode & 0o777) !== 0o700) {
    return fail("backend-corrupt", "genesis authority root is not 0700");
  }
  if (record.authorityRootIdentity.kind !== "directory") {
    return fail("backend-corrupt", "genesis authority root is not a directory");
  }
  // Repository binding matches live facts.
  if (record.repositoryIdentity !== facts.repositoryIdentity) {
    return fail("repository-mismatch", "genesis repositoryIdentity does not match live facts");
  }
  if (record.commonDirectoryIdentity !== facts.commonDirectoryIdentity) {
    return fail("repository-mismatch", "genesis commonDirectoryIdentity does not match live facts");
  }
  if (record.objectStoreIdentity !== facts.objectStoreIdentity) {
    return fail("repository-mismatch", "genesis objectStoreIdentity does not match live facts");
  }
  if (record.objectFormat !== facts.objectFormat) {
    return fail("repository-mismatch", "genesis objectFormat does not match live facts");
  }
  if (facts.backendSchemaVersion !== MWA_BACKEND_SCHEMA_VERSION) {
    return fail("schema-unsupported", "live backend schema version is unsupported");
  }
  // Authority root path is lexically beneath the common directory (a private
  // child, outside every candidate/tracked content namespace).
  if (!isBeneathCommonDirectory(record.authorityRootPath, facts.commonDirectoryPath)) {
    return fail("backend-corrupt", "genesis authority root is not beneath the common directory");
  }
  if (record.authorityRootPath !== facts.authorityRootPath) {
    return fail("backend-corrupt", "genesis authority root path does not match live facts");
  }
  const genesisIdentity = createGenesisRecordIdentity(record);
  return deepFreeze({ verified: true, genesisIdentity });
}

/**
 * Computes the canonical sha256 identity of a genesis record. The identity is
 * the canonical hash of the record (sorted keys, no symbol/prototype). It is
 * stored as `authority_meta.genesis_record_identity` and used by `acquire` to
 * bind the live lease to the verified genesis.
 */
export function createGenesisRecordIdentity(record: MigrationWriteAuthorityGenesisRecord): Sha256 {
  return canonicalHash(record);
}

/**
 * True when `authorityRootPath` is lexically beneath `commonDirectoryPath` and
 * does not escape via `..`. The authority root must be a private child of the
 * exact Git common directory, outside tracked/candidate/Git-owned namespaces.
 */
export function isBeneathCommonDirectory(authorityRootPath: string, commonDirectoryPath: string): boolean {
  if (typeof authorityRootPath !== "string" || typeof commonDirectoryPath !== "string") return false;
  if (authorityRootPath.length === 0 || commonDirectoryPath.length === 0) return false;
  const root = authorityRootPath.endsWith("/") ? authorityRootPath.slice(0, -1) : authorityRootPath;
  const common = commonDirectoryPath.endsWith("/") ? commonDirectoryPath.slice(0, -1) : commonDirectoryPath;
  if (root === common) return false;
  if (!root.startsWith(common + "/")) return false;
  if (root.includes("/../") || root.includes("/..")) return false;
  return true;
}
