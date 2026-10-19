import type { CommandEffectContract } from "../../shared/command-effect-contract.mjs";
import type { QualificationTrustBaseLease } from "../../shared/qualification-authority-contract.mjs";

export const trustSha256: (bytes: string | Uint8Array) => string;
export const trustCanonicalHash: (value: unknown) => string;
export const MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT: Readonly<{
  builderRelativePath: string;
  receiptRelativePath: string;
  schemaRelativePath: string;
  receiptSchemaVersion: string;
  trustBaseSchemaVersion: string;
}>;
export const MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS: CommandEffectContract;
export const MIGRATION_WRITE_AUTHORITY_TRUST_BASE_LEASE: QualificationTrustBaseLease;
export function deriveVerifierTrustBase(): Readonly<Record<string, unknown>>;
export function migrationWriteAuthorityFileRecord(relativePath: string): Readonly<Record<string, unknown>>;
export function migrationWriteAuthorityFileRecords(
  relativePaths: readonly string[],
): readonly Readonly<Record<string, unknown>>[];
export function readMigrationWriteAuthorityFile(relativePath: string): Buffer;
export const migrationWriteAuthorityQualificationOwner: string;
