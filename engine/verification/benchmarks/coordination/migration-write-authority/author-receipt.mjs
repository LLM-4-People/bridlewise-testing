import {
  deriveVerifierTrustBase,
  MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT,
  migrationWriteAuthorityFileRecords
} from "./author-trust-base.mjs";

export const MIGRATION_WRITE_AUTHORITY_ARTIFACTS = Object.freeze([
  "verification/benchmarks/coordination/migration-write-authority/qualification-contract.v2.json",
  "verification/benchmarks/coordination/migration-write-authority/author-receipt.mjs",
  MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT.builderRelativePath,
  "verification/benchmarks/coordination/migration-write-authority/author-trust-base.d.mts",
  "verification/benchmarks/coordination/migration-write-authority/author-trust-base.mjs",
  "verification/benchmarks/shared/command-effect-contract.d.mts",
  "verification/benchmarks/shared/command-effect-contract.mjs",
  "verification/benchmarks/shared/qualification-parser.mjs",
  "verification/benchmarks/shared/qualification-authority-contract.d.mts",
  "verification/benchmarks/shared/qualification-authority-contract.mjs",
  "verification/benchmarks/shared/qualification-authority-inventory.mjs",
  "verification/benchmarks/shared/qualification-authority-inventory.schema.json",
  "verification/benchmarks/shared/qualification-authority-inventory.v5.json",
  "verification/benchmarks/shared/qualification-authority-audit.mjs",
  "verification/benchmarks/shared/test-qualification-authority.mjs",
  "verification/benchmarks/shared/qualification-authority.mjs",
  "scripts/verification/architecture.ts",
  "scripts/tooling/verification/command-effect-inventory.ts",
  "scripts/verification/effect-surface.ts",
  "scripts/tooling/verification/governed-source.ts",
  "scripts/verification/static-source.ts",
  "verification/benchmarks/coordination/migration-write-authority/schemas/qualification-contract.schema.json",
  "verification/benchmarks/coordination/migration-write-authority/schemas/authority-protocol.schema.json",
  "verification/benchmarks/coordination/migration-write-authority/fixtures/authority-protocol-fixtures.v2.json",
  "verification/benchmarks/coordination/migration-write-authority/build-protocol-fixtures.mjs",
  "verification/benchmarks/coordination/migration-write-authority/repository-facts.mjs",
  "verification/benchmarks/coordination/migration-write-authority/repository-facts-contract.mjs",
  "verification/benchmarks/coordination/migration-write-authority/schemas/repository-facts-run.schema.json",
  "verification/benchmarks/coordination/migration-write-authority/validate-repository-facts.mjs",
  "verification/benchmarks/coordination/migration-write-authority/test-repository-facts.mjs",
  "verification/benchmarks/coordination/migration-write-authority/validate-contracts.mjs",
  "verification/benchmarks/coordination/migration-write-authority/test-contracts.mjs",
  MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT.schemaRelativePath,
  "src/integrity.ts",
  "src/json-integrity.ts",
  "src/errors.ts",
  "src/architecture-manifest.ts",
  "src/filesystem/immutable-receipt.ts",
  "scripts/verification/safe-repository-reader.ts",
  "src/linux-path.ts",
  "src/ordered.ts",
  "src/path-boundary.ts",
  "src/root-policy.ts",
  "src/runtime-capabilities.ts",
  "src/classification-catalog.ts",
  "src/requirements.ts",
  "src/secret-signals.ts"
]);

export function buildMigrationWriteAuthorityAuthorReceiptValue() {
  return Object.freeze({
    schemaVersion: MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT.receiptSchemaVersion,
    status: "author-snapshot-unadmitted-externally-pinned-hash-required",
    artifacts: migrationWriteAuthorityFileRecords(MIGRATION_WRITE_AUTHORITY_ARTIFACTS),
    verifierTrustBase: deriveVerifierTrustBase(),
    claims: Object.freeze({
      coWeakeningPreventedByExternalReceiptHash: true,
      serializedReceiptConfersAuthority: false,
      independentAcceptance: false,
      runtimeQualification: false
    })
  });
}
