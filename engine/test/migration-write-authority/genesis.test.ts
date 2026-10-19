import assert from "node:assert/strict";
import test from "node:test";

import {
  createGenesisRecordIdentity,
  GENESIS_SCHEMA_VERSION,
  isBeneathCommonDirectory,
  verifyGenesisRecord,
  type GenesisVerificationFacts,
  type MigrationWriteAuthorityGenesisRecord,
} from "../../verification/core/coordination/migration-write-authority/genesis.ts";
import { MWA_BACKEND_SCHEMA_VERSION } from "../../verification/core/coordination/migration-write-authority/contracts.ts";

function pathIdentity(mode: number, kind: "file" | "directory" = "directory") {
  return Object.freeze({
    device: "10", inode: "20", mode, ownerUid: "1000", ownerGid: "1000", links: "3", kind,
  });
}

function makeRecord(overrides: Partial<MigrationWriteAuthorityGenesisRecord> = {}): MigrationWriteAuthorityGenesisRecord {
  return Object.freeze({
    schemaVersion: GENESIS_SCHEMA_VERSION,
    repositoryIdentity: "a".repeat(64),
    commonDirectoryIdentity: "b".repeat(64),
    objectStoreIdentity: "c".repeat(64),
    objectFormat: "sha1",
    authorityRootPath: "/repo/.git/bridlewise-migration-authority",
    authorityRootIdentity: pathIdentity(0o700),
    backendSchemaVersion: MWA_BACKEND_SCHEMA_VERSION,
    initialFenceGeneration: "0",
    sqliteVersion: "3.53.1",
    sqliteSourceIdentity: "d".repeat(64),
    genesisWallIso: "2026-07-17T00:00:00.000Z",
    creatingAuthorityIdentity: "e".repeat(64),
    creatingAuthorityKind: "foundation-seed-transaction-authority",
    receiptAuthority: "evidence-only-not-a-bearer-capability",
    ...overrides,
  });
}

function makeFacts(overrides: Partial<GenesisVerificationFacts> = {}): GenesisVerificationFacts {
  return Object.freeze({
    repositoryIdentity: "a".repeat(64),
    commonDirectoryIdentity: "b".repeat(64),
    objectStoreIdentity: "c".repeat(64),
    objectFormat: "sha1",
    commonDirectoryPath: "/repo/.git",
    authorityRootPath: "/repo/.git/bridlewise-migration-authority",
    authorityRootIdentity: pathIdentity(0o700),
    backendSchemaVersion: MWA_BACKEND_SCHEMA_VERSION,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Identity computation
// ---------------------------------------------------------------------------

test("genesis: createGenesisRecordIdentity is a deterministic sha256", () => {
  const record = makeRecord();
  const id = createGenesisRecordIdentity(record);
  assert.equal(id.length, 64);
  assert.equal(createGenesisRecordIdentity(record), id);
  // A different record yields a different identity.
  const other = makeRecord({ sqliteVersion: "3.53.0" });
  assert.notEqual(createGenesisRecordIdentity(other), id);
});

// ---------------------------------------------------------------------------
// Verification: match
// ---------------------------------------------------------------------------

test("genesis: verifyGenesisRecord accepts a matching record", () => {
  const record = makeRecord();
  const facts = makeFacts();
  const result = verifyGenesisRecord(record, facts);
  assert.equal(result.verified, true);
  assert.equal((result as { genesisIdentity: string }).genesisIdentity, createGenesisRecordIdentity(record));
});

// ---------------------------------------------------------------------------
// Verification: mismatch
// ---------------------------------------------------------------------------

test("genesis: verifyGenesisRecord rejects repository identity mismatch", () => {
  const record = makeRecord();
  const facts = makeFacts({ repositoryIdentity: "f".repeat(64) });
  const result = verifyGenesisRecord(record, facts);
  assert.equal(result.verified, false);
  assert.equal((result as { code: string }).code, "repository-mismatch");
});

test("genesis: verifyGenesisRecord rejects objectFormat mismatch", () => {
  const record = makeRecord();
  const facts = makeFacts({ objectFormat: "sha256" });
  const result = verifyGenesisRecord(record, facts);
  assert.equal(result.verified, false);
  assert.equal((result as { code: string }).code, "repository-mismatch");
});

test("genesis: verifyGenesisRecord rejects a non-0700 authority root", () => {
  const record = makeRecord({ authorityRootIdentity: pathIdentity(0o755) });
  const facts = makeFacts();
  const result = verifyGenesisRecord(record, facts);
  assert.equal(result.verified, false);
  assert.equal((result as { code: string }).code, "backend-corrupt");
});

test("genesis: verifyGenesisRecord rejects an authority root not beneath the common dir", () => {
  const record = makeRecord({ authorityRootPath: "/tmp/evil" });
  const facts = makeFacts();
  const result = verifyGenesisRecord(record, facts);
  assert.equal(result.verified, false);
  assert.equal((result as { code: string }).code, "backend-corrupt");
});

test("genesis: verifyGenesisRecord rejects schema version drift", () => {
  const record = makeRecord({ schemaVersion: "bridlewise-migration-authority-genesis/v2" as typeof GENESIS_SCHEMA_VERSION });
  const facts = makeFacts();
  const result = verifyGenesisRecord(record, facts);
  assert.equal(result.verified, false);
  assert.equal((result as { code: string }).code, "schema-unsupported");
});

test("genesis: verifyGenesisRecord rejects backend schema version drift", () => {
  const record = makeRecord({ backendSchemaVersion: "bridlewise-migration-authority-backend/v2" as typeof MWA_BACKEND_SCHEMA_VERSION });
  const facts = makeFacts();
  const result = verifyGenesisRecord(record, facts);
  assert.equal(result.verified, false);
  assert.equal((result as { code: string }).code, "schema-unsupported");
});

test("genesis: verifyGenesisRecord rejects a non-evidence receipt authority", () => {
  const record = makeRecord({ receiptAuthority: "bearer-capability" as "evidence-only-not-a-bearer-capability" });
  const facts = makeFacts();
  const result = verifyGenesisRecord(record, facts);
  assert.equal(result.verified, false);
  assert.equal((result as { code: string }).code, "backend-corrupt");
});

test("genesis: verifyGenesisRecord rejects an invalid creating authority kind", () => {
  const record = makeRecord({ creatingAuthorityKind: "self-bootstrap" as "foundation-seed-transaction-authority" });
  const facts = makeFacts();
  const result = verifyGenesisRecord(record, facts);
  assert.equal(result.verified, false);
  assert.equal((result as { code: string }).code, "backend-corrupt");
});

test("genesis: verifyGenesisRecord rejects a non-zero initial fence generation", () => {
  const record = makeRecord({ initialFenceGeneration: "1" as "0" });
  const facts = makeFacts();
  const result = verifyGenesisRecord(record, facts);
  assert.equal(result.verified, false);
  assert.equal((result as { code: string }).code, "backend-corrupt");
});

// ---------------------------------------------------------------------------
// isBeneathCommonDirectory
// ---------------------------------------------------------------------------

test("genesis: isBeneathCommonDirectory accepts a direct child and rejects escapes", () => {
  assert.equal(isBeneathCommonDirectory("/repo/.git/mwa", "/repo/.git"), true);
  assert.equal(isBeneathCommonDirectory("/repo/.git/mwa/", "/repo/.git/"), true);
  assert.equal(isBeneathCommonDirectory("/repo/.git", "/repo/.git"), false);
  assert.equal(isBeneathCommonDirectory("/repo/.gitevil", "/repo/.git"), false);
  assert.equal(isBeneathCommonDirectory("/tmp/evil", "/repo/.git"), false);
  assert.equal(isBeneathCommonDirectory("/repo/.git/mwa/../evil", "/repo/.git"), false);
  assert.equal(isBeneathCommonDirectory("", "/repo/.git"), false);
});
