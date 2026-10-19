/**
 * MigrationWriteAuthority (MWA) — public facade.
 *
 * Re-exports the supported contract surface: schema versions, port
 * interfaces, shared types, the pure resource compiler, and genesis record
 * types. The node:sqlite backend implementation is NOT re-exported here — it is
 * an internal implementation detail selected through the
 * `MigrationAuthorityBackendPort` and constructed by `createMigrationWriteAuthority`
 * (Tranche 2) at builder composition.
 *
 * Design authority: MWA-DESIGN §1.
 */

export * from "./contracts.ts";
export {
  compileMigrationResourceSet,
  migrationResourcesConflict,
  validateMigrationResource,
  MWA_RESOURCE_ID_PATTERN,
  MWA_ALIAS_CLOSURE_MIN,
  MWA_ALIAS_CLOSURE_MAX,
  type MigrationResourceSet,
} from "./resources.ts";
export {
  GENESIS_SCHEMA_VERSION,
  verifyGenesisRecord,
  createGenesisRecordIdentity,
  isBeneathCommonDirectory,
  type MigrationWriteAuthorityGenesisRecord,
  type GenesisVerificationFacts,
  type GenesisVerificationResult,
} from "./genesis.ts";
export {
  createMigrationRepositoryFactsAdapter,
  factsBackendError,
  type MigrationRepositoryFactsConfig,
  type MigrationRepositoryFactsAdapter,
} from "./repository-facts.ts";
export {
  createMigrationEffectAdapter,
  type MigrationEffectConfig,
  type MigrationEffectAdapterInput,
} from "./effects.ts";
export {
  createMigrationWriteAuthority,
  type MigrationWriteAuthority,
  type MigrationWriteAuthorityInput,
} from "./authority.ts";
export {
  reconcileMigrationAuthority,
  recoverMigrationAuthority,
  type DestinationClassification,
  type PlannedDestination,
  type ObservedDestination,
  type ReconciliationResult,
  type RecoveryResult,
} from "./recovery.ts";
export {
  createImmutableReceiptPort,
  defaultEvidenceRootPath,
  receiptPathFor,
  type ImmutableReceiptPortInput,
} from "./receipts.ts";
export {
  MWA_QUALIFIED_CAPABILITY,
  MWA_CAPABILITY_ADMITTED,
  isMigrationWriteAuthorityAdmitted,
  MWA_REGISTERED_CAPABILITIES,
} from "./capability.ts";

// The node:sqlite backend implementation (`createNodeSqliteMigrationBackend`)
// is intentionally NOT re-exported here — it is an internal implementation
// detail selected through the `MigrationAuthorityBackendPort` and constructed
// at builder composition.
