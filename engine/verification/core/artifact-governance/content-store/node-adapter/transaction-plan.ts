import { InputError } from "../../../../../src/kernel/errors.ts";
import { canonicalDomainHash, deepFreeze, sha256 } from "../../../../../src/kernel/integrity.ts";
import { compileExactWriteLease, type ExactWriteEffect } from
  "../../../../../src/modules/effect-boundary/index.ts";

import { contentRegistryBytes, type ContentStoreCandidate } from "../candidate.ts";
import {
  CONTENT_STORE_ACTIVE_SCHEMA_VERSION,
  CONTENT_STORE_JOURNAL_PHASE_REGISTRY,
  CONTENT_STORE_JOURNAL_SCHEMA_VERSION,
  type ContentActiveRegistry,
  type ContentJournal,
} from "../domain/contracts.ts";
import { assertSha256, canonicalDocumentBytes } from "../domain/identities.ts";
import {
  contentPackIndexBytes,
  parseContentPack,
  readContentPackBytes,
} from "../pack.ts";
import { contentTreeBytes, parseContentTreeBytes } from "../tree.ts";
import type { ContentRootCapability } from "./reconstruct.ts";
import {
  CONTENT_STORE_FIRST_ACTIVATION_PUBLICATION_ORDER,
  CONTENT_STORE_SYNTHETIC_QUALIFICATION_RESIDUE_DISPOSITION,
  type BasePlan,
  type ContentStoreFirstActivationAuthorization,
  type ContentStoreFirstActivationPlan,
  type ContentStoreFirstActivationResult,
  type ContentStorePublicationEvent,
  type ExecutionPlan,
  type JournalPhase,
  type PlannedPublication,
  type PublicationOrderId,
} from "./transaction-contracts.ts";

export const CONTENT_STORE_SYNTHETIC_ATTEMPT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function compileContentStoreFirstActivation(
  stateRoot: ContentRootCapability,
  candidate: ContentStoreCandidate,
  attemptId: string,
): ContentStoreFirstActivationAuthorization {
  const base = buildBasePlan(candidate, attemptId);
  const effects = plannedEffects(base);
  const lease = compileExactWriteLease(stateRoot, effects);
  return Object.freeze({ lease, plan: publicPlan(buildExecutionPlan(base, lease.writeSetIdentity)) });
}

export function buildBasePlan(candidate: ContentStoreCandidate, attemptId: string): BasePlan {
  assertAttemptId(attemptId);
  const candidateObjects = candidateObjectPublications(candidate);
  const registryBytes = contentRegistryBytes(candidate.registry);
  const registrySha256 = sha256(registryBytes);
  const planIdentity = canonicalDomainHash("content-store.first-activation-plan/v1", {
    protocol: "flat-append-only-first-activation/v1",
    publicationOrder: CONTENT_STORE_FIRST_ACTIVATION_PUBLICATION_ORDER,
    registryIdentity: candidate.registry.registryIdentity,
    registrySha256,
    objects: candidateObjects.map(({ bytes: _bytes, fileName: _fileName, ...descriptor }) => descriptor),
    priorActiveIdentity: null,
    productionActivation: false,
  });
  const transactionId = canonicalDomainHash("content-store.first-activation-transaction/v1", {
    planIdentity,
    attemptId,
    attemptAuthority: "caller-supplied-synthetic-unadmitted",
    attemptChronologyClaim: false,
  });
  const activePayload = {
    schemaVersion: CONTENT_STORE_ACTIVE_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    registryByteLength: registryBytes.byteLength,
    registrySha256,
    registryIdentity: candidate.registry.registryIdentity,
    priorActiveIdentity: null,
  };
  const active: ContentActiveRegistry = deepFreeze({
    ...activePayload,
    activeIdentity: canonicalDomainHash("content-store.active-registry/v1", activePayload),
  });
  const activePublication = plannedPublication({
    id: "active-registry",
    orderId: "active-registry",
    kind: "active",
    relativePath: "active.json",
    fileName: "active.json",
    bytes: canonicalDocumentBytes(active),
  });
  return Object.freeze({
    attemptId,
    transactionId,
    planIdentity,
    registryIdentity: candidate.registry.registryIdentity,
    registrySha256,
    activeIdentity: active.activeIdentity,
    candidateObjects,
    activePublication,
  });
}

export function plannedEffects(base: BasePlan): readonly ExactWriteEffect[] {
  return Object.freeze([
    ...CONTENT_STORE_JOURNAL_PHASE_REGISTRY.map((phase) => ({
      operation: "publish-file" as const,
      relativePath: journalFileName(base.transactionId, phase.fileName),
    })),
    ...base.candidateObjects.map((publication) => ({
      operation: "publish-file" as const,
      relativePath: publication.relativePath,
    })),
    { operation: "publish-file" as const, relativePath: "active.json" },
  ]);
}

export function buildExecutionPlan(base: BasePlan, writeSetIdentity: string): ExecutionPlan {
  assertSha256(writeSetIdentity, "content_store_write_set_identity_invalid");
  const journals = new Map<JournalPhase, ContentJournal>();
  const journalPublications = new Map<JournalPhase, PlannedPublication>();
  for (const phase of CONTENT_STORE_JOURNAL_PHASE_REGISTRY) {
    const payload = {
      schemaVersion: CONTENT_STORE_JOURNAL_SCHEMA_VERSION,
      transactionId: base.transactionId,
      planIdentity: base.planIdentity,
      attemptId: base.attemptId,
      attemptAuthority: "caller-supplied-synthetic-unadmitted" as const,
      attemptChronologyClaim: false as const,
      phase: phase.id,
      registryIdentity: base.registryIdentity,
      registrySha256: base.registrySha256,
      priorActiveIdentity: null,
      writeSetIdentity,
    };
    const journal: ContentJournal = deepFreeze({
      ...payload,
      journalIdentity: canonicalDomainHash("content-store.journal/v1", payload),
    });
    journals.set(phase.id, journal);
    const fileName = journalFileName(base.transactionId, phase.fileName);
    journalPublications.set(phase.id, plannedPublication({
      id: `journal-${phase.id}`,
      orderId: phase.id === "prepared" ? "journal-prepared" :
        phase.id === "objects-published" ? "journal-objects-published" : "journal-active-published",
      kind: "journal",
      relativePath: fileName,
      fileName,
      bytes: canonicalDocumentBytes(journal),
    }));
  }

  const publications: PlannedPublication[] = [];
  for (const orderId of CONTENT_STORE_FIRST_ACTIVATION_PUBLICATION_ORDER) {
    if (orderId === "journal-prepared") publications.push(journalPublications.get("prepared")!);
    else if (orderId === "pack-and-index-objects") {
      publications.push(...base.candidateObjects.filter((value) => value.kind === "pack" || value.kind === "index"));
    } else if (orderId === "tree-object") {
      publications.push(...base.candidateObjects.filter((value) => value.kind === "tree"));
    } else if (orderId === "registry-object") {
      publications.push(...base.candidateObjects.filter((value) => value.kind === "registry"));
    } else if (orderId === "journal-objects-published") {
      publications.push(journalPublications.get("objects-published")!);
    } else if (orderId === "active-registry") publications.push(base.activePublication);
    else publications.push(journalPublications.get("active-published")!);
  }
  return Object.freeze({ base, effects: plannedEffects(base), journals, publications: Object.freeze(publications) });
}

export function publicPublicationEvent(
  publication: PlannedPublication,
  ordinal: number,
): ContentStorePublicationEvent {
  const { bytes: _bytes, fileName: _fileName, ...descriptor } = publication;
  return deepFreeze({ ...descriptor, ordinal });
}

export function resultFor(execution: ExecutionPlan, alreadyComplete: boolean): ContentStoreFirstActivationResult {
  return deepFreeze({
    status: "synthetic-first-activation-complete" as const,
    disposition: alreadyComplete ? "already-complete" as const : "created-or-resumed" as const,
    planIdentity: execution.base.planIdentity,
    attemptId: execution.base.attemptId,
    attemptAuthority: "caller-supplied-synthetic-unadmitted" as const,
    attemptChronologyClaim: false as const,
    transactionId: execution.base.transactionId,
    registryIdentity: execution.base.registryIdentity,
    activeIdentity: execution.base.activeIdentity,
    terminalPhase: "active-published" as const,
    qualificationResidueDisposition: CONTENT_STORE_SYNTHETIC_QUALIFICATION_RESIDUE_DISPOSITION,
    productionActivation: false as const,
    replacementAuthorityAvailable: false as const,
    renameAuthorityAvailable: false as const,
    deleteOrCleanupAuthorityAvailable: false as const,
  });
}

export function assertAttemptId(attemptId: string): void {
  if (!CONTENT_STORE_SYNTHETIC_ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw new InputError("Content store attempt identity is invalid", "content_store_attempt_identity_invalid");
  }
}

export function journalFileName(transactionId: string, phaseFileName: string): string {
  return `journal-${transactionId}-${phaseFileName}`;
}

function publicPlan(execution: ExecutionPlan): ContentStoreFirstActivationPlan {
  return deepFreeze({
    mode: "synthetic-fixture-only" as const,
    planIdentity: execution.base.planIdentity,
    attemptId: execution.base.attemptId,
    attemptAuthority: "caller-supplied-synthetic-unadmitted" as const,
    attemptChronologyClaim: false as const,
    transactionId: execution.base.transactionId,
    effects: execution.effects,
    writeSetIdentity: execution.journals.get("prepared")!.writeSetIdentity,
    publications: execution.publications.map(({ bytes: _bytes, fileName: _fileName, ...descriptor }) => descriptor),
    registryIdentity: execution.base.registryIdentity,
    activeIdentity: execution.base.activeIdentity,
    productionActivation: false as const,
    replacementAuthorityAvailable: false as const,
    renameAuthorityAvailable: false as const,
    deleteOrCleanupAuthorityAvailable: false as const,
  });
}

function candidateObjectPublications(candidate: ContentStoreCandidate): readonly PlannedPublication[] {
  assertCandidateDecision(candidate);
  const treeBytes = contentTreeBytes(candidate.tree);
  const parsedTree = parseContentTreeBytes(treeBytes);
  if (parsedTree.treeIdentity !== candidate.tree.treeIdentity ||
    candidate.registry.treeIdentity !== candidate.tree.treeIdentity ||
    candidate.registry.treeByteLength !== treeBytes.byteLength ||
    candidate.registry.treeSha256 !== sha256(treeBytes) ||
    candidate.registry.admissionDecisionIdentity !== candidate.decision.decisionIdentity ||
    candidate.registry.packs.length !== candidate.packs.length) {
    throw new InputError("Content store candidate closure is invalid", "content_store_candidate_closure_invalid");
  }
  const publications: PlannedPublication[] = [];
  for (const [index, pack] of candidate.packs.entries()) {
    const packBytes = readContentPackBytes(pack);
    const parsedPack = parseContentPack(packBytes, candidate.registry.packCeilingBytes);
    const indexBytes = contentPackIndexBytes(pack.index);
    const registryPack = candidate.registry.packs[index];
    if (registryPack === undefined || parsedPack.sha256 !== pack.sha256 ||
      parsedPack.index.indexIdentity !== pack.index.indexIdentity ||
      registryPack.packByteLength !== packBytes.byteLength ||
      registryPack.packSha256 !== sha256(packBytes) ||
      registryPack.indexIdentity !== pack.index.indexIdentity ||
      registryPack.indexByteLength !== indexBytes.byteLength ||
      registryPack.indexSha256 !== sha256(indexBytes)) {
      throw new InputError("Content store pack closure is invalid", "content_store_candidate_pack_closure_invalid");
    }
    publications.push(plannedPublication({ id: `pack-${index}`, orderId: "pack-and-index-objects", kind: "pack",
      relativePath: `pack-${pack.sha256}.pack`, fileName: `pack-${pack.sha256}.pack`, bytes: packBytes }));
    publications.push(plannedPublication({ id: `index-${index}`, orderId: "pack-and-index-objects", kind: "index",
      relativePath: `index-${registryPack.indexSha256}.json`, fileName: `index-${registryPack.indexSha256}.json`,
      bytes: indexBytes }));
  }
  publications.push(plannedPublication({ id: "tree", orderId: "tree-object", kind: "tree",
    relativePath: `tree-${candidate.registry.treeSha256}.json`, fileName: `tree-${candidate.registry.treeSha256}.json`,
    bytes: treeBytes }));
  const registryBytes = contentRegistryBytes(candidate.registry);
  const registryPath = `registry-${sha256(registryBytes)}.json`;
  publications.push(plannedPublication({ id: "registry", orderId: "registry-object", kind: "registry",
    relativePath: registryPath, fileName: registryPath, bytes: registryBytes }));
  return Object.freeze(publications);
}

function assertCandidateDecision(candidate: ContentStoreCandidate): void {
  const payload = { status: candidate.decision.status, blockers: candidate.decision.blockers,
    blobCount: candidate.decision.blobCount };
  if (candidate.decision.status !== "admitted" || candidate.decision.blockers.length !== 0 ||
    canonicalDomainHash("content-store.admission-decision/v1", payload) !== candidate.decision.decisionIdentity) {
    throw new InputError("Content store candidate is not admitted", "content_store_candidate_not_admitted");
  }
}

function plannedPublication(input: Readonly<{
  id: string;
  orderId: PublicationOrderId;
  kind: PlannedPublication["kind"];
  relativePath: string;
  fileName: string;
  bytes: Uint8Array;
}>): PlannedPublication {
  const bytes = Uint8Array.from(input.bytes);
  return Object.freeze({ ...input, bytes, byteLength: bytes.byteLength, sha256: sha256(bytes) });
}
