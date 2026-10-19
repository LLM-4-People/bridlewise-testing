/**
 * MigrationWriteAuthority — reconciliation and recovery.
 *
 * `reconcileMigrationAuthority` independently observes each planned
 * destination and classifies it as `previous`, `next`, or `unknown` against
 * the journaled previous/next identities. If every destination is in the
 * closed previous-or-next set, recovery may either complete to next or
 * compensate to previous; the direction is recorded before any effect. An
 * unknown byte identity, missing journal fact, or ambiguous observation
 * yields `blocked-unknown-effect` — recovery preserves the journal and
 * evidence; it never guesses, deletes evidence, infers success from absence,
 * or starts a new plan.
 *
 * `recoverMigrationAuthority` reacquires the exact repository's authority with
 * a strictly newer fence (via `authority.recover`, which delegates to
 * `backend.recover`) and then reconciles. The actual effect application
 * (completing to next or compensating to previous) uses the recovered fence
 * through the authority's fence/compareAndCommit protocol and is the caller's
 * responsibility; this module owns the reconciliation decision.
 *
 * Design authority: MWA-DESIGN §4.8.
 */

import { canonicalHash, deepFreeze } from "../../../../src/kernel/integrity.ts";
import {
  type BackendError,
  type BackendResult,
  type RecoverInput,
  type TargetState,
} from "./contracts.ts";
import { stateIdentity } from "./internal.ts";
import type { MigrationWriteAuthority } from "./authority.ts";

// ---------------------------------------------------------------------------
// Reconciliation types
// ---------------------------------------------------------------------------

export type DestinationClassification = "previous" | "next" | "unknown";

export type PlannedDestination = Readonly<{
  resourceId: string;
  /** The journaled pre-effect state, or null if the journal records an absence. */
  journaledPrevious: TargetState | null;
  /** The journaled intended post-effect state, or null if the plan permits next absence. */
  journaledNext: TargetState | null;
  /** The plan explicitly permits the previous state to be a typed absence. */
  allowsPreviousAbsence: boolean;
  /** The plan explicitly permits the next state to be a typed absence. */
  allowsNextAbsence: boolean;
}>;

export type ObservedDestination = Readonly<{
  resourceId: string;
  observedState: TargetState;
}>;

export type ReconciliationResult = Readonly<{
  outcome: "complete-to-next" | "compensate-to-previous" | "blocked-unknown-effect";
  classifications: readonly Readonly<{ resourceId: string; classification: DestinationClassification }>[];
  /** The direction recorded before any effect; null when blocked. */
  direction: "next" | "previous" | null;
}>;

export type RecoveryResult = Readonly<{
  outcome: "recovered" | "blocked-unknown-effect" | "denied";
  reconciliation: ReconciliationResult;
  backendResult?: BackendResult;
  error?: BackendError;
}>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyDestination(planned: PlannedDestination, observed: TargetState): DestinationClassification {
  const observedId = canonicalHash(observed);
  const nextId = stateIdentity(planned.journaledNext);
  const previousId = stateIdentity(planned.journaledPrevious);
  if (nextId !== null && observedId === nextId) return "next";
  if (previousId !== null && observedId === previousId) return "previous";
  // Typed absence permitted by the plan: an absent observation matches a
  // journaled-absent end when the plan explicitly permits it.
  if (observed.kind === "absent") {
    if (planned.journaledNext === null && planned.allowsNextAbsence) return "next";
    if (planned.journaledPrevious === null && planned.allowsPreviousAbsence) return "previous";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// reconcileMigrationAuthority
// ---------------------------------------------------------------------------

export function reconcileMigrationAuthority(input: Readonly<{
  destinations: readonly PlannedDestination[];
  observations: readonly ObservedDestination[];
}>): ReconciliationResult {
  if (input.destinations.length === 0) {
    return deepFreeze({
      outcome: "blocked-unknown-effect",
      classifications: [],
      direction: null,
    });
  }
  const obsByResource = new Map<string, TargetState>();
  for (const obs of input.observations) obsByResource.set(obs.resourceId, obs.observedState);

  const classifications: { resourceId: string; classification: DestinationClassification }[] = [];
  let allNext = true;
  let allPrevious = true;
  for (const planned of input.destinations) {
    const observed = obsByResource.get(planned.resourceId);
    if (observed === undefined) {
      // Missing observation for a planned destination → unknown (never infer).
      classifications.push(deepFreeze({ resourceId: planned.resourceId, classification: "unknown" }));
      allNext = false;
      allPrevious = false;
      continue;
    }
    const classification = classifyDestination(planned, observed);
    classifications.push(deepFreeze({ resourceId: planned.resourceId, classification }));
    if (classification !== "next") allNext = false;
    if (classification !== "previous") allPrevious = false;
  }

  if (allNext) {
    return deepFreeze({ outcome: "complete-to-next", classifications: deepFreeze(classifications), direction: "next" });
  }
  if (allPrevious) {
    return deepFreeze({ outcome: "compensate-to-previous", classifications: deepFreeze(classifications), direction: "previous" });
  }
  return deepFreeze({ outcome: "blocked-unknown-effect", classifications: deepFreeze(classifications), direction: null });
}

// ---------------------------------------------------------------------------
// recoverMigrationAuthority
// ---------------------------------------------------------------------------

export function recoverMigrationAuthority(input: Readonly<{
  authority: MigrationWriteAuthority;
  recoverInput: RecoverInput;
  destinations: readonly PlannedDestination[];
  observations: readonly ObservedDestination[];
}>): RecoveryResult {
  // Reacquire with a strictly newer fence (authority.recover → backend.recover
  // validates generation > current and supersedesGeneration/fenceIdentity).
  const backendResult = input.authority.recover(input.recoverInput);
  if (backendResult.outcome === "denied") {
    return deepFreeze({
      outcome: "denied",
      reconciliation: deepFreeze({ outcome: "blocked-unknown-effect", classifications: [], direction: null }),
      error: backendResult.error,
    });
  }
  const reconciliation = reconcileMigrationAuthority({
    destinations: input.destinations,
    observations: input.observations,
  });
  if (reconciliation.outcome === "blocked-unknown-effect") {
    // Preserve the journal and evidence; never guess. The caller must not
    // apply any effect; the recovered fence remains but no direction is taken.
    return deepFreeze({ outcome: "blocked-unknown-effect", reconciliation, backendResult });
  }
  return deepFreeze({ outcome: "recovered", reconciliation, backendResult });
}
