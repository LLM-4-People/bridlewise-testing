import {
  collectQualificationFileRecords,
  deriveQualificationTrustBase,
  qualificationFileRecord,
  readQualificationFile,
  QUALIFICATION_AUTHORITY_OWNER
} from "../../shared/qualification-authority.mjs";
import { canonicalHash, sha256 } from "../../../../src/kernel/integrity.ts";
import { defineCommandEffectContract } from "../../shared/command-effect-contract.mjs";
import { defineQualificationTrustBaseLease } from "../../shared/qualification-authority-contract.mjs";

export const trustSha256 = sha256;
export const trustCanonicalHash = canonicalHash;
export const MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT = Object.freeze({
  builderRelativePath: "verification/benchmarks/coordination/migration-write-authority/build-author-receipt.mjs",
  receiptRelativePath: "verification/benchmarks/coordination/migration-write-authority/author-receipt.v2.json",
  schemaRelativePath: "verification/benchmarks/coordination/migration-write-authority/schemas/author-receipt.v2.schema.json",
  receiptSchemaVersion: "migration-write-authority-author-receipt/v2",
  trustBaseSchemaVersion: "migration-write-authority-verifier-trust-base/v2"
});
export const MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS = defineCommandEffectContract({
  commandClass: "build",
  commandId: "migration-write-authority/build-author-receipt",
  defaultMode: "derive",
  modes: [
    {
      availability: "available",
      effects: ["cryptography", "filesystem-read", "process-status"],
      invocation: "default-or-explicit",
      name: "derive",
      unavailableCode: undefined
    },
    {
      availability: "available",
      effects: ["cryptography", "filesystem-read", "process-status"],
      invocation: "explicit-only",
      name: "check",
      unavailableCode: undefined
    },
    {
      availability: "blocked",
      effects: ["cryptography", "filesystem-read", "filesystem-write", "process-status"],
      invocation: "explicit-only",
      name: "write",
      unavailableCode: "production_migration_write_authority_unavailable"
    }
  ]
});

export const MIGRATION_WRITE_AUTHORITY_TRUST_BASE_LEASE = defineQualificationTrustBaseLease({
  leaseId: "migration-write-authority/verifier-trust-base",
  schemaVersion: MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT.trustBaseSchemaVersion,
  rootPackages: ["ajv", "zod"],
  packageDetail: "full",
  nodeDetail: "legacy",
  rootMetadataPaths: ["package.json", "package-lock.json", "node_modules/.package-lock.json"],
  preserveRootMetadataOrder: true,
  includeAuthorityOwner: false,
  packageRootsDerivedInternally: true,
  receiptSchemaRelativePath: MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT.schemaRelativePath,
  receiptTrustBaseJsonPointer: "/properties/verifierTrustBase",
  requiredUseCardinality: 1,
  environmentPolicy: {
    mode: "compiled-source-accesses",
    names: []
  },
  fieldInfluence: {
    "authority-contract": ["schemaVersion", "originClass", "lease"],
    "environment-compiler": ["environmentBindings"],
    "node-observation": ["node"],
    "root-metadata": ["rootMetadata"],
    "package-closure": ["packageRootsDerivedInternally", "packages"],
    "portability-audit": ["portability"],
    "canonical-identity": ["trustBaseIdentity"]
  }
});

export function deriveVerifierTrustBase() {
  return deriveQualificationTrustBase(MIGRATION_WRITE_AUTHORITY_TRUST_BASE_LEASE);
}

export function migrationWriteAuthorityFileRecord(relativePath) {
  return qualificationFileRecord(relativePath);
}

export function migrationWriteAuthorityFileRecords(relativePaths) {
  return collectQualificationFileRecords(relativePaths);
}

export function readMigrationWriteAuthorityFile(relativePath) {
  return readQualificationFile(relativePath);
}

export const migrationWriteAuthorityQualificationOwner = QUALIFICATION_AUTHORITY_OWNER;
