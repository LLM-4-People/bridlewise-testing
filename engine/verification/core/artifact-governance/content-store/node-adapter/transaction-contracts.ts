import type { ExactWriteEffect, ExactWriteLease } from "../../../../../src/modules/effect-boundary/index.ts";

import type { ContentStoreCandidate } from "../candidate.ts";
import {
  CONTENT_STORE_FIRST_ACTIVATION_STAGE_REGISTRY,
  CONTENT_STORE_JOURNAL_PHASE_REGISTRY,
  type ContentJournal,
} from "../domain/contracts.ts";
import type { ContentRootCapability } from "./reconstruct.ts";

export const CONTENT_STORE_FIRST_ACTIVATION_PUBLICATION_ORDER = Object.freeze(
  CONTENT_STORE_FIRST_ACTIVATION_STAGE_REGISTRY.map((stage) => stage.id),
) as readonly (typeof CONTENT_STORE_FIRST_ACTIVATION_STAGE_REGISTRY[number]["id"])[];

export const CONTENT_STORE_SYNTHETIC_QUALIFICATION_RESIDUE_DISPOSITION =
  "caller-owned-no-delete-cleanup-authority" as const;

export type PublicationOrderId = typeof CONTENT_STORE_FIRST_ACTIVATION_STAGE_REGISTRY[number]["id"];
export type JournalPhase = typeof CONTENT_STORE_JOURNAL_PHASE_REGISTRY[number]["id"];

export type ContentStoreSyntheticQualification = Readonly<{
  mode: "caller-owned-transient-synthetic-qualification";
  root: ContentRootCapability;
  lease: ExactWriteLease;
  destinationRelativePath: string;
  residueDisposition: typeof CONTENT_STORE_SYNTHETIC_QUALIFICATION_RESIDUE_DISPOSITION;
}>;

export type ContentStorePublicationDescriptor = Readonly<{
  id: string;
  orderId: PublicationOrderId;
  kind: "active" | "index" | "journal" | "pack" | "registry" | "tree";
  relativePath: string;
  byteLength: number;
  sha256: string;
}>;

export type ContentStoreFirstActivationPlan = Readonly<{
  mode: "synthetic-fixture-only";
  planIdentity: string;
  attemptId: string;
  attemptAuthority: "caller-supplied-synthetic-unadmitted";
  attemptChronologyClaim: false;
  transactionId: string;
  effects: readonly ExactWriteEffect[];
  writeSetIdentity: string;
  publications: readonly ContentStorePublicationDescriptor[];
  registryIdentity: string;
  activeIdentity: string;
  productionActivation: false;
  replacementAuthorityAvailable: false;
  renameAuthorityAvailable: false;
  deleteOrCleanupAuthorityAvailable: false;
}>;

export type ContentStoreFirstActivationAuthorization = Readonly<{
  lease: ExactWriteLease;
  plan: ContentStoreFirstActivationPlan;
}>;

export type ContentStorePublicationEvent = ContentStorePublicationDescriptor & Readonly<{
  ordinal: number;
}>;

export type ContentStoreTransactionHooks = Readonly<{
  afterQualification?: () => void;
  beforePublication?: (event: ContentStorePublicationEvent) => void;
  afterPublication?: (event: ContentStorePublicationEvent) => void;
}>;

export type ContentStoreFirstActivationRequest = Readonly<{
  mode: "synthetic-fixture-only";
  attemptId: string;
  transactionId: string;
  stateRoot: ContentRootCapability;
  stateLease: ExactWriteLease;
  qualification: ContentStoreSyntheticQualification;
  sourceRoot: string;
  candidate: ContentStoreCandidate;
  hooks?: ContentStoreTransactionHooks;
}>;

export type ContentStoreFirstActivationResult = Readonly<{
  status: "synthetic-first-activation-complete";
  disposition: "created-or-resumed" | "already-complete";
  planIdentity: string;
  attemptId: string;
  attemptAuthority: "caller-supplied-synthetic-unadmitted";
  attemptChronologyClaim: false;
  transactionId: string;
  registryIdentity: string;
  activeIdentity: string;
  terminalPhase: "active-published";
  qualificationResidueDisposition: typeof CONTENT_STORE_SYNTHETIC_QUALIFICATION_RESIDUE_DISPOSITION;
  productionActivation: false;
  replacementAuthorityAvailable: false;
  renameAuthorityAvailable: false;
  deleteOrCleanupAuthorityAvailable: false;
}>;

export type ContentStorePublicErrorProjection = Readonly<{
  name: "InputError" | "SecurityError" | "HarnessError";
  message: string;
  code: string;
  retryable: false;
  safeDetails: Readonly<Record<string, never>>;
}>;

export type PlannedPublication = ContentStorePublicationDescriptor & Readonly<{
  bytes: Uint8Array;
  fileName: string;
}>;

export type BasePlan = Readonly<{
  attemptId: string;
  transactionId: string;
  planIdentity: string;
  registryIdentity: string;
  registrySha256: string;
  activeIdentity: string;
  candidateObjects: readonly PlannedPublication[];
  activePublication: PlannedPublication;
}>;

export type ExecutionPlan = Readonly<{
  base: BasePlan;
  effects: readonly ExactWriteEffect[];
  journals: ReadonlyMap<JournalPhase, ContentJournal>;
  publications: readonly PlannedPublication[];
}>;

export type JournalInspection = Readonly<{
  phases: ReadonlyMap<JournalPhase, ContentJournal>;
  terminal: JournalPhase | null;
}>;
