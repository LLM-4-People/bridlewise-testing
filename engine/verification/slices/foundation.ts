import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { deepFreeze } from "../../src/kernel/integrity.ts";
import {
  FOUNDATION_GENERATION_LOCK_PATH,
  compileFoundationPlan,
  validateFoundationDag,
  type FoundationPlan,
} from "../core/foundation-cascade.ts";
import { isMigrationWriteAuthorityAdmitted } from "../core/coordination/migration-write-authority/capability.ts";

const MODULE_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(MODULE_PATH), "..", "..");

const TRANSACTION_AUTHORITY_BLOCKER: FoundationSliceBlocker = deepFreeze({
  code: "foundation_transaction_authority_unavailable",
  ownerId: "foundation-transaction",
  reason:
    "No qualified cross-worktree MigrationWriteAuthority is admitted (prerequisite 1 of 6).",
  requiredCapabilities: ["migration-write-authority/qualified"],
});

/**
 * Returned when MWA is admitted but the foundation write protocol is not yet
 * implemented. The capability gate is satisfied; the protocol that consumes it
 * requires the foundation transaction module (`FSD-B019`).
 */
const WRITE_PROTOCOL_PENDING_BLOCKER: FoundationSliceBlocker = deepFreeze({
  code: "foundation_write_protocol_pending_implementation",
  ownerId: "foundation-transaction",
  reason:
    "MWA is admitted but the foundation write protocol requires the foundation transaction module (FSD-B019), which is not yet implemented.",
  requiredCapabilities: [],
});

/**
 * Returned when MWA is admitted but the foundation recover protocol is not yet
 * implemented. The capability gate is satisfied; the protocol that consumes it
 * requires the foundation transaction module (`FSD-B019`).
 */
const RECOVER_PROTOCOL_PENDING_BLOCKER: FoundationSliceBlocker = deepFreeze({
  code: "foundation_recover_protocol_pending_implementation",
  ownerId: "foundation-transaction",
  reason:
    "MWA is admitted but the foundation recover protocol requires the foundation transaction module (FSD-B019), which is not yet implemented.",
  requiredCapabilities: [],
});

export type FoundationSliceMode = "plan" | "check" | "write" | "recover";

export const FOUNDATION_SLICE_MODES = deepFreeze(
  ["plan", "check", "write", "recover"] as const satisfies readonly FoundationSliceMode[],
);

export type FoundationSliceDisposition =
  | "blocked"
  | "drift-detected"
  | "clean"
  | "unavailable";

export type FoundationSliceBlocker = Readonly<{
  code: string;
  ownerId: string;
  reason: string;
  requiredCapabilities: readonly string[];
}>;

export type FoundationSliceStage = Readonly<{
  stage: string;
  ordinal: number;
  ownerId: string;
  disposition: string;
  blockers: readonly FoundationSliceBlocker[];
}>;

export type FoundationSliceResult = Readonly<{
  mode: FoundationSliceMode;
  disposition: FoundationSliceDisposition;
  schemaVersion: string;
  compilerRevision: string;
  planIdentity: string;
  stageRegistryIdentity: string;
  rootPolicyIdentity: string;
  activationLockPath: string;
  activationLockPresent: boolean;
  artifactManifestPath: string;
  transactionBlockers: readonly FoundationSliceBlocker[];
  stages: readonly FoundationSliceStage[];
}>;

export function planFoundation(): FoundationSliceResult {
  validateFoundationDag();
  const plan = compileFoundationPlan();
  return summarizeResult("plan", plan, false, "blocked", []);
}

export function checkFoundation(): FoundationSliceResult {
  validateFoundationDag();
  const plan = compileFoundationPlan();
  const activationLockPresent = existsSync(
    resolve(REPOSITORY_ROOT, FOUNDATION_GENERATION_LOCK_PATH),
  );
  const disposition: FoundationSliceDisposition =
    plan.compilationDisposition === "blocked"
      ? (activationLockPresent ? "drift-detected" : "blocked")
      : "clean";
  return summarizeResult("check", plan, activationLockPresent, disposition, []);
}

export function writeFoundation(): FoundationSliceResult {
  validateFoundationDag();
  const plan = compileFoundationPlan();
  const gate = resolveTransactionAuthorityGate();
  if (gate !== null) {
    return summarizeResult("write", plan, false, "unavailable", [gate]);
  }
  // Capability admitted: construct MWA from config + repository facts, acquire
  // lease, validate base, stage plan, fence→CAS each destination, publish
  // artifact manifest, reopen + verify, release (MWA-DESIGN §6.3). This path
  // requires the foundation transaction module (`FSD-B019`); it is not yet
  // implemented. Return the honest "protocol pending" blocker rather than
  // throwing: the capability gate is satisfied, the protocol is pending.
  return summarizeResult("write", plan, false, "unavailable", [
    WRITE_PROTOCOL_PENDING_BLOCKER,
  ]);
}

export function recoverFoundation(): FoundationSliceResult {
  validateFoundationDag();
  const plan = compileFoundationPlan();
  const gate = resolveTransactionAuthorityGate();
  if (gate !== null) {
    return summarizeResult("recover", plan, false, "unavailable", [gate]);
  }
  // Capability admitted: reacquire MWA with a newer fence, validate journal,
  // reconcile, complete or compensate (MWA-DESIGN §6.4). This path requires
  // the foundation transaction module (`FSD-B019`); it is not yet implemented.
  // Return the honest "protocol pending" blocker rather than throwing.
  return summarizeResult("recover", plan, false, "unavailable", [
    RECOVER_PROTOCOL_PENDING_BLOCKER,
  ]);
}

/**
 * Capability gate for the MigrationWriteAuthority (MWA-DESIGN §6.2). Returns
 * the truthful `unavailable` blocker when the `migration-write-authority/qualified`
 * capability is not admitted (hostile matrix not passed), or `null` when the
 * capability is admitted and the write/recover protocol may proceed.
 */
function resolveTransactionAuthorityGate(): FoundationSliceBlocker | null {
  if (isMigrationWriteAuthorityAdmitted()) {
    return null;
  }
  return TRANSACTION_AUTHORITY_BLOCKER;
}

function summarizeResult(
  mode: FoundationSliceMode,
  plan: FoundationPlan,
  activationLockPresent: boolean,
  disposition: FoundationSliceDisposition,
  transactionBlockers: readonly FoundationSliceBlocker[],
): FoundationSliceResult {
  return deepFreeze({
    mode,
    disposition,
    schemaVersion: plan.schemaVersion,
    compilerRevision: plan.compilerRevision,
    planIdentity: plan.planIdentity,
    stageRegistryIdentity: plan.stageRegistryIdentity,
    rootPolicyIdentity: plan.rootPolicyIdentity,
    activationLockPath: plan.activationLockPath,
    activationLockPresent,
    artifactManifestPath: plan.artifactManifestPath,
    transactionBlockers,
    stages: plan.stages.map((stage) => deepFreeze({
      stage: stage.stage,
      ordinal: stage.ordinal,
      ownerId: stage.ownerId,
      disposition: stage.disposition,
      blockers: stage.blockers.map((blocker) => deepFreeze({
        code: blocker.code,
        ownerId: blocker.ownerId,
        reason: blocker.reason,
        requiredCapabilities: blocker.requiredCapabilities,
      })),
    })),
  });
}
