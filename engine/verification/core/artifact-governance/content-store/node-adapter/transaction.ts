import { InputError } from "../../../../../src/kernel/errors.ts";
import {
  assertExactWriteAuthorized,
  type ExactWriteEffect,
  type ExactWriteLease,
} from "../../../../../src/modules/effect-boundary/index.ts";

import {
  assertScanMatchesCandidate,
  assertSyntheticQualificationRequest,
  qualificationEffect,
  qualifyCandidate,
} from "./qualification.ts";
import { withObservedContentRootForNodeAdapterInternal } from "./reconstruct.ts";
import { scanContentTree } from "./scan.ts";
import type {
  ContentStoreFirstActivationRequest,
  ContentStoreFirstActivationResult,
} from "./transaction-contracts.ts";
import {
  assertAttemptId,
  buildBasePlan,
  buildExecutionPlan,
  plannedEffects,
  publicPublicationEvent,
  resultFor,
} from "./transaction-plan.ts";
import {
  assertActiveIsAbsentOrIdentical,
  assertClaimedDurability,
  inspectJournal,
  publishStateFile,
  readStateFile,
} from "./transaction-state.ts";

export {
  CONTENT_STORE_FIRST_ACTIVATION_PUBLICATION_ORDER,
  CONTENT_STORE_SYNTHETIC_QUALIFICATION_RESIDUE_DISPOSITION,
  type ContentStoreFirstActivationAuthorization,
  type ContentStoreFirstActivationPlan,
  type ContentStoreFirstActivationRequest,
  type ContentStoreFirstActivationResult,
  type ContentStorePublicationDescriptor,
  type ContentStorePublicationEvent,
  type ContentStorePublicErrorProjection,
  type ContentStoreSyntheticQualification,
  type ContentStoreTransactionHooks,
} from "./transaction-contracts.ts";
export { compileContentStoreSyntheticQualificationLease } from "./qualification.ts";
export { compileContentStoreFirstActivation } from "./transaction-plan.ts";
export { projectContentStorePublicError } from "./transaction-state.ts";

export function publishContentStoreFirstActivation(
  request: ContentStoreFirstActivationRequest,
): ContentStoreFirstActivationResult {
  return executeFirstActivation(request);
}

export function recoverContentStoreFirstActivation(
  request: ContentStoreFirstActivationRequest,
): ContentStoreFirstActivationResult {
  return executeFirstActivation(request);
}

function executeFirstActivation(
  request: ContentStoreFirstActivationRequest,
): ContentStoreFirstActivationResult {
  assertSyntheticRequest(request);
  const base = buildBasePlan(request.candidate, request.attemptId);
  if (request.transactionId !== base.transactionId) {
    throw new InputError("Content store transaction identity is invalid", "content_store_transaction_identity_invalid");
  }
  const effects = plannedEffects(base);
  assertLeaseExactlyMatchesEffects(request.stateLease, effects, "content_store_state_write_lease_plan_mismatch");
  assertAllEffectsAuthorized(request.stateLease, request.stateRoot, effects);
  const qualification = qualificationEffect(request.qualification.destinationRelativePath);
  assertLeaseExactlyMatchesEffects(
    request.qualification.lease,
    [qualification],
    "content_store_qualification_write_lease_plan_mismatch",
  );
  assertExactWriteAuthorized(request.qualification.lease, request.qualification.root, qualification);
  const execution = buildExecutionPlan(base, request.stateLease.writeSetIdentity);
  const sourceScan = scanContentTree(request.sourceRoot);
  assertScanMatchesCandidate(sourceScan, request.candidate);

  return withObservedContentRootForNodeAdapterInternal(request.stateRoot, (stateRootPath) => {
    assertActiveIsAbsentOrIdentical(
      readStateFile(stateRootPath, "active.json"),
      execution.base.activePublication.bytes,
    );
    const initialJournal = inspectJournal(stateRootPath, execution);
    assertClaimedDurability(stateRootPath, execution, initialJournal);
    qualifyCandidate(request, sourceScan);
    request.hooks?.afterQualification?.();

    const alreadyComplete = initialJournal.terminal === "active-published";
    for (const [ordinal, publication] of execution.publications.entries()) {
      const event = publicPublicationEvent(publication, ordinal);
      request.hooks?.beforePublication?.(event);
      publishStateFile(stateRootPath, request.stateRoot, request.stateLease, publication);
      request.hooks?.afterPublication?.(event);
    }

    const finalJournal = inspectJournal(stateRootPath, execution);
    if (finalJournal.terminal !== "active-published") {
      throw new InputError(
        "Content store transaction did not reach its terminal phase",
        "content_store_journal_terminal_missing",
      );
    }
    assertClaimedDurability(stateRootPath, execution, finalJournal);
    return resultFor(execution, alreadyComplete);
  });
}

function assertSyntheticRequest(request: ContentStoreFirstActivationRequest): void {
  if (request.mode !== "synthetic-fixture-only") {
    throw new InputError("Content store production activation is blocked", "content_store_production_activation_blocked");
  }
  assertAttemptId(request.attemptId);
  assertSyntheticQualificationRequest(request);
}

function assertAllEffectsAuthorized(
  lease: ExactWriteLease,
  root: ContentStoreFirstActivationRequest["stateRoot"],
  effects: readonly ExactWriteEffect[],
): void {
  for (const effect of effects) assertExactWriteAuthorized(lease, root, effect);
}

function assertLeaseExactlyMatchesEffects(
  lease: ExactWriteLease,
  effects: readonly ExactWriteEffect[],
  code: string,
): void {
  const expected = effects.map(effectKey).toSorted();
  const actual = lease.effects.map(effectKey).toSorted();
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    throw new InputError("Exact write lease does not match the transaction plan", code);
  }
}

function effectKey(effect: ExactWriteEffect): string {
  return `${effect.operation}:${effect.relativePath}`;
}
