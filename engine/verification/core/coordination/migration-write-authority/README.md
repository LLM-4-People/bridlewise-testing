# migration write authority

The `engine/verification/core/coordination/migration-write-authority/` folder of the development surface.

## What each file does

- `INTEGRATION-RECEIPT.md` — the `INTEGRATION-RECEIPT` module.
- `authority.ts` — migrationWriteAuthority — the application-facing coordinator.
- `backend-node-sqlite.ts` — migrationWriteAuthority — node:sqlite backend implementing `MigrationAuthorityBackendPort`. Owns lease state and monotonic fencing generations.
- `capability.ts` — migrationWriteAuthority — capability admission status.
- `contracts.ts` — migrationWriteAuthority.
- `effects.ts` — migrationWriteAuthority — `MigrationEffectPort` adapter.
- `genesis.ts` — migrationWriteAuthority — genesis record types + verifier.
- `index.ts` — migrationWriteAuthority.
- `internal.ts` — migrationWriteAuthority — shared internal helpers.
- `receipts.ts` — migrationWriteAuthority — `ImmutableReceiptPort` adapter.
- `recovery.ts` — migrationWriteAuthority — reconciliation and recovery. `reconcileMigrationAuthority` independently observes each planned destination and classifies….
- `repository-facts.ts` — migrationWriteAuthority — `MigrationRepositoryFactsPort` adapter.
- `resources.ts` — migrationWriteAuthority — pure resource compiler + conflict detector. `compileMigrationResourceSet` validates registered lexical + semantic….

## Where it lives and what consumes it

The folder lives at `engine/verification/core/coordination/migration-write-authority/`.
