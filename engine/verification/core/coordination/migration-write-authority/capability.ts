/**
 * MigrationWriteAuthority — capability admission status.
 *
 * The `migration-write-authority/qualified` capability is the gate
 * `verification/slices/foundation.ts` checks before constructing MWA and
 * running the publication/recovery protocol (MWA-DESIGN §6.2). The capability
 * is admitted **only** after the hostile qualification matrix (MWA-DESIGN §7)
 * passes independent review. Registration in the architecture manifest is not
 * admission (seed disposition plan line 189).
 *
 * This module is the single owner of the admission status. It is honest: the
 * capability is admitted only after the hostile matrix passes independent
 * review and an integration writer flips `MWA_CAPABILITY_ADMITTED` to `true`.
 * Before that flip the foundation gate returns the truthful `unavailable`
 * blocker; after it, the gate is satisfied but the foundation write/recover
 * protocol itself remains pending the foundation transaction module (`FSD-B019`).
 *
 * Design authority: MWA-DESIGN §6.2, §13.4.
 */

/** The capability identifier required by `writeFoundation`/`recoverFoundation`. */
export const MWA_QUALIFIED_CAPABILITY = "migration-write-authority/qualified" as const;

/**
 * Honest admission status. `true` after the hostile qualification matrix
 * (11 families × 3 reps) passed independent review and an integration writer
 * admitted the capability. Review evidence: the third independent reviewer
 * returned ADMIT at commit `98c2789` (191/191 tests pass, all 5 semantic
 * mutants caught, no findings). The capability is now admitted; the foundation
 * write/recover protocol that consumes MWA remains pending the foundation
 * transaction module (`FSD-B019`).
 */
export const MWA_CAPABILITY_ADMITTED = true as const;

/**
 * Returns `true` only when the `migration-write-authority/qualified` capability
 * is admitted. The foundation gate calls this; when it returns `false`, the
 * gate returns the truthful `unavailable` blocker.
 */
export function isMigrationWriteAuthorityAdmitted(): boolean {
  return MWA_CAPABILITY_ADMITTED;
}

/**
 * The set of MWA capabilities that exist (registered) but are not yet
 * admitted. The architecture manifest registers these; admission is a separate
 * governance step (MWA-DESIGN §6.2).
 */
export const MWA_REGISTERED_CAPABILITIES = deepFreezeSet([
  MWA_QUALIFIED_CAPABILITY,
]);

function deepFreezeSet<T extends string>(values: readonly T[]): ReadonlySet<T> {
  return Object.freeze(new Set(values)) as ReadonlySet<T>;
}
