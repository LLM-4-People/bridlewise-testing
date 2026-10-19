/**
 * MigrationWriteAuthority (MWA) — pure contract layer.
 *
 * Owns the protocol/backend/journal/resource-registry schema versions, the
 * closed lifecycle state machine, the five closed resource kinds, the six
 * narrow port interfaces, all request/result types, the closed error catalog,
 * and the opaque in-process `LiveGrant`. This file has no I/O and no
 * `node:sqlite` dependency; it imports only the canonical integrity/errors
 * single sources of truth.
 *
 * Design authority: `docs/research/coordination/migration-write-authority-qualification.md`
 * and `/home/example/code-harness-workspaces/orchestrator-state/mwa-design/MWA-DESIGN.md`.
 * Field shapes mirror the v2 benchmark protocol schema
 * (`verification/benchmarks/coordination/migration-write-authority/schemas/authority-protocol.schema.json`)
 * as TypeScript types; the benchmark schema remains evidence, not
 * implementation authority — the production contract is authored here.
 */

import type { CanonicalValue } from "../../../../src/kernel/integrity.ts";
import { deepFreeze } from "../../../../src/kernel/integrity.ts";

// ---------------------------------------------------------------------------
// Schema version constants (single owners)
// ---------------------------------------------------------------------------

export const MWA_PROTOCOL_SCHEMA_VERSION = "migration-authority-message/v2" as const;
export const MWA_BACKEND_SCHEMA_VERSION = "bridlewise-migration-authority-backend/v1" as const;
export const MWA_RESOURCE_REGISTRY_VERSION = "bridlewise-migration-resource-registry/v1" as const;
export const MWA_JOURNAL_SCHEMA_VERSION = "migration-authority-journal/v1" as const;

/**
 * Domain-segregated chain-hash prefix for the MWA journal. Separate from the
 * execution-closure and timeline domains per `ledger-primitives.ts` so an
 * MWA chain and a timeline chain over identical envelopes still produce
 * disjoint hash spaces.
 */
export const MWA_LEDGER_DOMAIN = "bridlewise/migration-authority-ledger/v1\u0000";

/**
 * Authority stage for MWA receipts. Matches
 * `ROOT_POLICY.receipts.immutableExecution.authorityStage` (durable-local,
 * unadmitted until the canonical-ledger port is qualified in a later tranche).
 */
export const MWA_RECEIPT_AUTHORITY = "evidence-only-not-a-bearer-capability" as const;
export const MWA_LEASE_EVIDENCE_AUTHORITY = "evidence-only-never-authority" as const;
export const MWA_AUTHORITY_CONTEXT = "process-private-live-grant-required-out-of-band" as const;

// ---------------------------------------------------------------------------
// Primitive shared types (mirror the v2 schema `$defs`)
// ---------------------------------------------------------------------------

export type Sha256 = string;
export type Uuid = string;
export type StableId = string;
export type PositiveIntegerString = string;
export type ObjectId = string;

/** Closed repository binding. Matches the v2 schema `repositoryBinding`. */
export type RepositoryBinding = Readonly<{
  repositoryIdentity: Sha256;
  commonDirectoryIdentity: Sha256;
  objectStoreIdentity: Sha256;
  objectFormat: "sha1" | "sha256";
}>;

/** Closed actor identity. Matches the v2 schema `actor`. */
export type Actor = Readonly<{
  actorId: StableId;
  taskId: StableId;
  subtaskId: StableId;
  attemptId: Uuid;
  processIdentity: Sha256;
}>;

/** Closed base identity. Matches the v2 schema `baseIdentity`. */
export type BaseIdentity = Readonly<{
  commit: ObjectId | null;
  tree: ObjectId | null;
  index: Sha256;
  candidate: Sha256;
  configuration: Sha256;
  policy: Sha256;
  capabilities: Sha256;
}>;

/** Descriptor-verified physical path identity. Matches the v2 `physicalIdentity`. */
export type PathIdentity = Readonly<{
  device: PositiveIntegerString;
  inode: PositiveIntegerString;
  mode: number;
  ownerUid: string;
  ownerGid: string;
  links: PositiveIntegerString;
  kind: "file" | "directory";
}>;

/** Typed absence of a directory entry. Matches the v2 `typedAbsence`. */
export type TypedAbsence = Readonly<{
  kind: "absent";
  parentIdentity: PathIdentity;
  entryName: string;
}>;

/** Target state of a physical path: typed absence, file, or directory. */
export type TargetState = Readonly<
  | { readonly kind: "absent"; readonly parentIdentity: PathIdentity; readonly entryName: string }
  | { readonly kind: "file"; readonly identity: PathIdentity; readonly byteLength: number; readonly sha256: Sha256 }
  | { readonly kind: "directory"; readonly identity: PathIdentity; readonly entrySetIdentity: Sha256 }
>;

// ---------------------------------------------------------------------------
// Process / clock evidence
// ---------------------------------------------------------------------------

/** Process identity: pid + start time + executable identity hash. Evidence, not truth. */
export type ProcessIdentity = Readonly<{
  pid: number;
  startTimeMs: PositiveIntegerString;
  executableIdentity: Sha256;
}>;

export type ProcessLivenessEvidence = Readonly<{
  observed: "alive" | "dead" | "ambiguous-after-restart";
  observedWallIso: string;
  evidenceHash: Sha256;
}>;

/** Persisted clock observation: wall-clock evidence + process-local monotonic. */
export type ClockObservation = Readonly<{
  monotonicNanoseconds: PositiveIntegerString;
  wallClockIso: string;
  processIdentity: ProcessIdentity;
}>;

// ---------------------------------------------------------------------------
// Lifecycle state machine (closed)
// ---------------------------------------------------------------------------

export const MWA_LEASE_STATES = deepFreeze([
  "active",
  "quiescing",
  "reconciling",
  "released",
  "expired",
  "fenced",
  "blocked-unknown-effect",
] as const satisfies readonly string[]);

export type LeaseState = (typeof MWA_LEASE_STATES)[number];

/** Closed transition enum from the v2 schema `journalEntry.transition`. */
export const MWA_LEASE_TRANSITIONS = deepFreeze([
  "requested-active",
  "active-quiescing",
  "active-expired",
  "active-fenced",
  "quiescing-reconciling",
  "reconciling-released",
  "reconciling-blocked-unknown-effect",
  "active-released",
] as const satisfies readonly string[]);

export type LeaseTransition = (typeof MWA_LEASE_TRANSITIONS)[number];

/**
 * Preregistered valid transitions. The backend rejects any transition not in
 * this map. `requested-active` is the genesis/creation transition (acquire):
 * its from-state is the virtual `"requested"` marker (a lease is created
 * active, not transitioned from a real state). `isLeaseTransitionValid` and
 * `leaseTransitionToken` skip creation transitions since `"requested"` is not
 * a real `LeaseState` and acquire creates the lease rather than transitioning it.
 */
export const MWA_VALID_TRANSITIONS: Readonly<Record<LeaseTransition, readonly [LeaseState | "requested", LeaseState]>> = deepFreeze({
  "requested-active": ["requested", "active"],
  "active-quiescing": ["active", "quiescing"],
  "active-expired": ["active", "expired"],
  "active-fenced": ["active", "fenced"],
  "quiescing-reconciling": ["quiescing", "reconciling"],
  "reconciling-released": ["reconciling", "released"],
  "reconciling-blocked-unknown-effect": ["reconciling", "blocked-unknown-effect"],
  "active-released": ["active", "released"],
});

export function isLeaseState(value: unknown): value is LeaseState {
  return typeof value === "string" && (MWA_LEASE_STATES as readonly string[]).includes(value);
}

export function isLeaseTransition(value: unknown): value is LeaseTransition {
  return typeof value === "string" && (MWA_LEASE_TRANSITIONS as readonly string[]).includes(value);
}

/** Returns true when `from -> to` is a preregistered valid state transition. */
export function isLeaseTransitionValid(from: LeaseState, to: LeaseState): boolean {
  for (const t of MWA_LEASE_TRANSITIONS) {
    const edge = MWA_VALID_TRANSITIONS[t];
    if (edge === undefined) continue;
    if (edge[0] === "requested") continue; // creation, not a state transition
    if (edge[0] === from && edge[1] === to) return true;
  }
  return false;
}

/** Returns the transition token (if any) for `from -> to`. */
export function leaseTransitionToken(from: LeaseState, to: LeaseState): LeaseTransition | undefined {
  for (const t of MWA_LEASE_TRANSITIONS) {
    const edge = MWA_VALID_TRANSITIONS[t];
    if (edge === undefined) continue;
    if (edge[0] === "requested") continue; // creation, not a state transition
    if (edge[0] === from && edge[1] === to) return t;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Resource kinds (five closed kinds)
// ---------------------------------------------------------------------------

export type ResourceAccess = "read" | "write";

export type ResourceCommon = Readonly<{
  resourceId: StableId;
  access: ResourceAccess;
  resolution: "resolved";
  registryIdentity: Sha256;
  normalizerIdentity: Sha256;
  aliasClosure: readonly StableId[];
}>;

export type PhysicalPathResource = Readonly<ResourceCommon & {
  kind: "physical-path";
  path: string;
  portableCollisionKey: string;
  observedState: TargetState;
}>;

export type OwnerKind =
  | "module"
  | "bounded-context"
  | "public-symbol"
  | "private-state"
  | "port"
  | "policy"
  | "config"
  | "event"
  | "traceability";

export type SemanticOwnerResource = Readonly<ResourceCommon & {
  kind: "semantic-owner";
  ownerKind: OwnerKind;
  ownerId: StableId;
  ancestorOwnerIds: readonly StableId[];
}>;

export type GeneratedOutputResource = Readonly<ResourceCommon & {
  kind: "generated-output";
  generatorId: StableId;
  outputPath: string;
  authorityKey: StableId;
}>;

export type GitRefResource = Readonly<ResourceCommon & {
  kind: "git-ref";
  refName: string;
  refFamilyId: StableId;
  expectedOld: ObjectId | null;
  intendedObjectKind: "commit" | "tag";
}>;

export type SurfaceKind = "export" | "script" | "compiler" | "dependency" | "executable-registry";

export type PackageSurfaceResource = Readonly<ResourceCommon & {
  kind: "package-surface";
  surfaceKind: SurfaceKind;
  surfaceId: StableId;
}>;

/** Closed discriminated union of the five resource kinds. */
export type MigrationResource =
  | PhysicalPathResource
  | SemanticOwnerResource
  | GeneratedOutputResource
  | GitRefResource
  | PackageSurfaceResource;

export type ResourceKind = MigrationResource["kind"];

export function isMigrationResourceKind(value: unknown): value is ResourceKind {
  return (
    value === "physical-path" ||
    value === "semantic-owner" ||
    value === "generated-output" ||
    value === "git-ref" ||
    value === "package-surface"
  );
}

/**
 * Registered authority that produced a resource set: the `registryIdentity`
 * and `normalizerIdentity` every resource in the set must match. The resource
 * compiler validates resources against this registry; unknown/unregistered/
 * unnormalizable resources fail closed with `resource-unresolved`.
 */
export type MigrationResourceRegistry = Readonly<{
  registryIdentity: Sha256;
  normalizerIdentity: Sha256;
}>;

// ---------------------------------------------------------------------------
// Opaque in-process LiveGrant (Symbol-branded nominal type)
// ---------------------------------------------------------------------------

const liveGrantBrand: unique symbol = Symbol("bridlewise.mwa.live-grant");

/**
 * Opaque in-process capability returned by `acquire` and re-validated by every
 * subsequent operation. The Symbol-branded field is dropped by
 * `JSON.stringify`, so a `LiveGrant` is never serializable and never a bearer
 * token: the backend always re-validates `generation`/`fenceIdentity`/
 * `repositoryIdentity` against the persisted lease row inside the same
 * `BEGIN IMMEDIATE` transaction that grants an effect fence.
 */
export interface LiveGrant {
  readonly [liveGrantBrand]: true;
  readonly leaseId: Uuid;
  readonly generation: PositiveIntegerString;
  readonly fenceIdentity: Sha256;
  readonly repositoryIdentity: Sha256;
  readonly resourceRegistryIdentity: Sha256;
  readonly processIdentity: Sha256;
}

export function isLiveGrant(value: unknown): value is LiveGrant {
  if (value === null || typeof value !== "object") return false;
  const grant = value as Record<symbol, unknown> & Record<string, unknown>;
  return grant[liveGrantBrand] === true && typeof grant.leaseId === "string";
}

/**
 * Construct a `LiveGrant`. `@internal` — only the backend implementation
 * constructs live grants; the backend re-validates every field against the
 * persisted lease row, so a fabricated grant grants nothing.
 */
export function createLiveGrant(fields: Omit<LiveGrant, typeof liveGrantBrand>): LiveGrant {
  const grant = { [liveGrantBrand]: true as const, ...fields } as LiveGrant;
  return Object.freeze(grant) as LiveGrant;
}

/** Per-effect fence token granted by `fence`. Carries the generation and
 * fenceIdentity that `compareAndCommit` must match. */
export type FenceToken = Readonly<{
  leaseId: Uuid;
  effectId: Uuid;
  generation: PositiveIntegerString;
  fenceIdentity: Sha256;
}>;

// ---------------------------------------------------------------------------
// Serializable lease evidence
// ---------------------------------------------------------------------------

export type LeaseEvidence = Readonly<{
  leaseId: Uuid;
  generation: PositiveIntegerString;
  fenceIdentity: Sha256;
  state: LeaseState;
  receiptAuthority: "evidence-only-never-authority";
}>;

// ---------------------------------------------------------------------------
// Closed error catalog
// ---------------------------------------------------------------------------

export const MWA_BACKEND_ERROR_CODES = deepFreeze([
  "repository-mismatch",
  "base-drift",
  "configuration-drift",
  "policy-drift",
  "capability-drift",
  "resource-unresolved",
  "resource-conflict",
  "resource-order-invalid",
  "lease-missing",
  "lease-expired",
  "lease-state-invalid",
  "generation-stale",
  "grant-invalid",
  "idempotency-conflict",
  "backend-busy",
  "backend-corrupt",
  "schema-unsupported",
  "clock-regression",
  "process-identity-ambiguous",
  "journal-mismatch",
  "cas-mismatch",
  "effect-unknown",
  "filesystem-unsupported",
  "operation-unsupported",
] as const satisfies readonly string[]);

export type BackendErrorCode = (typeof MWA_BACKEND_ERROR_CODES)[number];

export type BackendError = Readonly<{
  code: BackendErrorCode;
  message: string;
  /** Bounded, hashed diagnostics — never raw paths, contents, or secrets. */
  diagnosticHash?: Sha256;
}>;

export function isBackendErrorCode(value: unknown): value is BackendErrorCode {
  return typeof value === "string" && (MWA_BACKEND_ERROR_CODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Result types (discriminated unions)
// ---------------------------------------------------------------------------

export type BackendResult =
  | Readonly<{ outcome: "accepted"; leaseEvidence: LeaseEvidence; journalCursor: Sha256 }>
  | Readonly<{ outcome: "denied"; error: BackendError; partialReservationRetained: false }>;

export type BackendAcquireResult =
  | Readonly<{ outcome: "accepted"; liveGrant: LiveGrant; leaseEvidence: LeaseEvidence; journalCursor: Sha256 }>
  | Readonly<{ outcome: "denied"; error: BackendError; partialReservationRetained: false }>;

export type BackendFenceResult =
  | Readonly<{ outcome: "accepted"; fenceToken: FenceToken; leaseEvidence: LeaseEvidence; journalCursor: Sha256 }>
  | Readonly<{ outcome: "denied"; error: BackendError; partialReservationRetained: false }>;

export type BackendInspectResult =
  | Readonly<{
      outcome: "accepted";
      lease: Readonly<{
        leaseId: Uuid;
        state: LeaseState;
        generation: PositiveIntegerString;
        fenceIdentity: Sha256;
        repositoryIdentity: Sha256;
        resourceRegistryIdentity: Sha256;
        planIdentity: Sha256;
        acquiredWallIso: string;
        acquiredMonotonicNs: PositiveIntegerString;
        lastHeartbeatWallIso: string;
        lastHeartbeatMonotonicNs: PositiveIntegerString;
        requestedTtlMs: number;
        processIdentity: Sha256;
        journalCursor: Sha256;
        reservations: readonly Readonly<{ resourceId: StableId; access: ResourceAccess }>[];
      }>;
      journalCursor: Sha256;
    }>
  | Readonly<{ outcome: "denied"; error: BackendError; partialReservationRetained: false }>;

// ---------------------------------------------------------------------------
// Request input types
// ---------------------------------------------------------------------------

export type RequestCommon = Readonly<{
  schemaVersion: typeof MWA_PROTOCOL_SCHEMA_VERSION;
  messageKind: "request";
  operation: "acquire" | "reserve" | "heartbeat" | "checkpoint" | "fence" | "compare-and-commit" | "release" | "inspect" | "recover";
  requestId: Uuid;
  idempotencyKey: Sha256;
  repository: RepositoryBinding;
}>;

export type AuthorizedRequestCommon = Readonly<{
  authorityContext: typeof MWA_AUTHORITY_CONTEXT;
  leaseEvidence: LeaseEvidence;
}>;

export type AcquireInput = Readonly<RequestCommon & {
  operation: "acquire";
  actor: Actor;
  planIdentity: Sha256;
  base: BaseIdentity;
  resourceRegistryIdentity: Sha256;
  requestedTtlMs: number;
  resources: readonly MigrationResource[];
  clock: ClockObservation;
}>;

export type ReserveInput = Readonly<RequestCommon & AuthorizedRequestCommon & {
  operation: "reserve";
  liveGrant: LiveGrant;
  completeResourceUnion: readonly MigrationResource[];
}>;

export type HeartbeatInput = Readonly<RequestCommon & AuthorizedRequestCommon & {
  operation: "heartbeat";
  liveGrant: LiveGrant;
  requestedTtlMs: number;
  clock: ClockObservation;
}>;

export type NextSafeAction = "none" | "revalidate" | "fence-next-effect" | "reconcile-external-state" | "release";

export type CheckpointInput = Readonly<RequestCommon & AuthorizedRequestCommon & {
  operation: "checkpoint";
  liveGrant: LiveGrant;
  completedEffectIdentities: readonly Sha256[];
  remainingWriteResourceIds: readonly StableId[];
  nextSafeAction: NextSafeAction;
  journalCursor: Sha256;
}>;

export type EffectKind =
  | "filesystem-create"
  | "filesystem-replace"
  | "filesystem-remove"
  | "filesystem-sync"
  | "git-object-create"
  | "git-ref-transaction"
  | "immutable-event-append";

export type FenceInput = Readonly<RequestCommon & AuthorizedRequestCommon & {
  operation: "fence";
  liveGrant: LiveGrant;
  effectId: Uuid;
  effectKind: EffectKind;
  resourceId: StableId;
  expectedState: TargetState;
  intendedState: TargetState;
  base: BaseIdentity;
  journalCursor: Sha256;
}>;

export type CompareAndCommitInput = Readonly<RequestCommon & AuthorizedRequestCommon & {
  operation: "compare-and-commit";
  liveGrant: LiveGrant;
  effectId: Uuid;
  fenceIdentity: Sha256;
  resourceId: StableId;
  base: BaseIdentity;
  expectedState: TargetState;
  intendedState: TargetState;
  observedState: TargetState;
  effectResultIdentity: Sha256;
  journalCursor: Sha256;
}>;

export type ReleaseDisposition =
  | "completed"
  | "cancelled"
  | "superseded"
  | "failed-known-no-effect"
  | "blocked-unknown-effect";

export type ReleaseInput = Readonly<RequestCommon & AuthorizedRequestCommon & {
  operation: "release";
  liveGrant: LiveGrant;
  disposition: ReleaseDisposition;
  journalCursor: Sha256;
}>;

export type InspectInput = Readonly<RequestCommon & {
  operation: "inspect";
  leaseId: Uuid;
}>;

export type RecoveryFence = Readonly<{
  generation: PositiveIntegerString;
  fenceIdentity: Sha256;
  supersedesGeneration: PositiveIntegerString;
  supersedesFenceIdentity: Sha256;
}>;

export type RecoverInput = Readonly<RequestCommon & AuthorizedRequestCommon & {
  operation: "recover";
  liveGrant: LiveGrant;
  journalIdentity: Sha256;
  observationIdentity: Sha256;
  directionPreference: "previous" | "next";
  recoveryFence: RecoveryFence;
  /**
   * Clock observation at the time of the recovery request. The authority uses
   * `clock.processIdentity` for the liveness check (is the holder dead?) and
   * `clock.monotonicNanoseconds` for the TTL check (has the TTL elapsed since
   * the last heartbeat?). Required so the authority can enforce MWA-DESIGN
   * §4.5: "the old lease is expired or fenced (TTL elapsed by persisted
   * wall-clock + monotonic evidence, or process isAlive === 'dead')."
   */
  clock: ClockObservation;
}>;

// ---------------------------------------------------------------------------
// Backend open facts (capability probe result)
// ---------------------------------------------------------------------------

export type BackendOpenFacts = Readonly<{
  schemaVersion: typeof MWA_BACKEND_SCHEMA_VERSION;
  sqliteVersion: string;
  sqliteSourceIdentity: Sha256;
  journalMode: "delete";
  synchronous: "extra";
  foreignKeys: true;
  defensiveVerified: boolean;
  platform: string;
}>;

export type BackendOpenResult =
  | Readonly<{ outcome: "accepted"; facts: BackendOpenFacts }>
  | Readonly<{ outcome: "denied"; error: BackendError; partialReservationRetained: false }>;

// ---------------------------------------------------------------------------
// Root-policy view + config view (ceilings the backend validates against)
// ---------------------------------------------------------------------------

/**
 * Immutable ceilings the backend validates `BackendOpenFacts` against on every
 * open. Tranche 3 wires `ROOT_POLICY.migrationAuthority.backend` into this
 * view; Tranche 1 passes it explicitly to keep the foundation cascade's
 * `ROOT_POLICY_HASH` literal stable.
 */
export type MigrationAuthorityRootPolicy = Readonly<{
  backend: Readonly<{
    requiredJournalMode: "delete";
    requiredSynchronous: "extra";
    requiredForeignKeys: true;
    requiredDefensive: true;
    walAllowed: false;
  }>;
  limits: Readonly<{
    maxLeaseTtlMs: number;
    maxHeartbeatIntervalMs: number;
    maxResourcesPerLease: number;
    maxBusyTimeoutMs: number;
    maxFencingGeneration: PositiveIntegerString;
  }>;
}>;

/** Operator-selectable runtime config (bounded by `MigrationAuthorityRootPolicy`). */
export type MigrationAuthorityConfig = Readonly<{
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  busyTimeoutMs: number;
  checkpointCadenceMs: number;
  recoveryDirectionPreference: "previous" | "next";
}>;

// ---------------------------------------------------------------------------
// Effect port observation types
// ---------------------------------------------------------------------------

export type FenceContext = Readonly<{
  leaseId: Uuid;
  generation: PositiveIntegerString;
  fenceIdentity: Sha256;
  effectId: Uuid;
  resourceId: StableId;
}>;

export type EffectObservation = Readonly<{
  kind: "filesystem";
  effectKind: EffectKind;
  resourceId: StableId;
  observedState: TargetState;
  intendedBytes?: number;
  observedBytes?: number;
  observationHash: Sha256;
}>;

export type GitObjectObservation = Readonly<{
  kind: "git-object";
  effectKind: "git-object-create";
  resourceId: StableId;
  objectName: string;
  objectKind: "commit" | "tree" | "tag";
  objectId: ObjectId;
  observationHash: Sha256;
}>;

export type GitRefObservation = Readonly<{
  kind: "git-ref";
  effectKind: "git-ref-transaction";
  resourceId: StableId;
  refName: string;
  newObjectId: ObjectId | null;
  oldObjectId: ObjectId | null;
  observationHash: Sha256;
}>;

// ---------------------------------------------------------------------------
// Git plumbing effect input types
// ---------------------------------------------------------------------------

/**
 * Git plumbing effect inputs. Tranche 1 committed the `GitObjectObservation` /
 * `GitRefObservation` observation types and the `EffectKind` git variants but
 * narrowed `MigrationEffectPort` to filesystem-only. Tranche 2 completes the
 * port additively with these six plumbing methods (MWA-DESIGN §2.6). The
 * adapter holds the working directory and author/committer identity at
 * construction, so per-call inputs carry only the effect-specific data.
 */
export type GitWriteTreeInput = Readonly<{ grant: LiveGrant; fence: FenceContext; resourceId: StableId }>;

export type GitCommitTreeInput = Readonly<{
  grant: LiveGrant;
  fence: FenceContext;
  resourceId: StableId;
  treeObjectId: ObjectId;
  /** Explicit parents; empty for a root commit. Order is preserved. */
  parents: readonly ObjectId[];
  message: string;
}>;

export type GitMktagInput = Readonly<{
  grant: LiveGrant;
  fence: FenceContext;
  resourceId: StableId;
  /** Raw tag object bytes; `git mktag --strict` validates the format. */
  tagBytes: Uint8Array;
}>;

/** One command in a `git update-ref --stdin -z` transaction. */
export type GitRefTxCommand = Readonly<
  | { readonly kind: "start" }
  | { readonly kind: "verify"; readonly refName: string; readonly expectedOld: ObjectId | null }
  | { readonly kind: "create"; readonly refName: string; readonly newObjectId: ObjectId }
  | { readonly kind: "update"; readonly refName: string; readonly newObjectId: ObjectId; readonly expectedOld: ObjectId | null }
  | { readonly kind: "delete"; readonly refName: string; readonly expectedOld: ObjectId | null }
  | { readonly kind: "prepare" }
  | { readonly kind: "commit" }
>;

export type GitRefTxInput = Readonly<{
  grant: LiveGrant;
  fence: FenceContext;
  resourceId: StableId;
  commands: readonly GitRefTxCommand[];
}>;

export type RereadObjectInput = Readonly<{
  grant: LiveGrant;
  fence: FenceContext;
  resourceId: StableId;
  objectId: ObjectId;
  expectedKind: "commit" | "tree" | "tag";
}>;

export type RereadRefInput = Readonly<{
  grant: LiveGrant;
  fence: FenceContext;
  resourceId: StableId;
  refName: string;
}>;

// ---------------------------------------------------------------------------
// Receipt port types
// ---------------------------------------------------------------------------

export type AppendReceipt = Readonly<{
  receiptHash: Sha256;
  cursor: Sha256;
}>;

export type ReceiptResult =
  | Readonly<{ outcome: "accepted"; receipt: AppendReceipt }>
  | Readonly<{ outcome: "blocked"; error: BackendError; partialReservationRetained: false }>;

// ---------------------------------------------------------------------------
// Event sink types (per-attempt evidence)
// ---------------------------------------------------------------------------

export type AttemptStartEvent = Readonly<{
  leaseId: Uuid;
  generation: PositiveIntegerString;
  repositoryIdentity: Sha256;
  fenceIdentity: Sha256;
  journalCursor: Sha256;
  eventHash: Sha256;
}>;

export type AttemptTransitionEvent = Readonly<{
  leaseId: Uuid;
  transition: LeaseTransition;
  journalCursor: Sha256;
  eventHash: Sha256;
}>;

export type AttemptEffectIntentEvent = Readonly<{
  leaseId: Uuid;
  effectId: Uuid;
  effectKind: EffectKind;
  resourceId: StableId;
  fenceIdentity: Sha256;
  journalCursor: Sha256;
  eventHash: Sha256;
}>;

export type AttemptObservationEvent = Readonly<{
  leaseId: Uuid;
  effectId: Uuid;
  observationHash: Sha256;
  journalCursor: Sha256;
  eventHash: Sha256;
}>;

export type AttemptTerminalEvent = Readonly<{
  leaseId: Uuid;
  disposition: ReleaseDisposition;
  journalCursor: Sha256;
  eventHash: Sha256;
}>;

// ---------------------------------------------------------------------------
// The six port interfaces
// ---------------------------------------------------------------------------

/**
 * Port 1 — owns lease state and monotonic fencing generations. Does not own
 * tasks, plans, Git, files, receipts, or the canonical ledger.
 */
export type MigrationAuthorityBackendPort = Readonly<{
  acquire(input: AcquireInput): BackendAcquireResult;
  reserve(input: ReserveInput): BackendResult;
  heartbeat(input: HeartbeatInput): BackendResult;
  checkpoint(input: CheckpointInput): BackendResult;
  fence(input: FenceInput): BackendFenceResult;
  compareAndCommit(input: CompareAndCommitInput): BackendResult;
  release(input: ReleaseInput): BackendResult;
  inspect(input: InspectInput): BackendInspectResult;
  recover(input: RecoverInput): BackendResult;
  open(): BackendOpenResult;
  close(): void;
}>;

/** Port 2 — read-only repository facts; no policy decisions. */
export type MigrationRepositoryFactsPort = Readonly<{
  acquire(): Promise<MigrationRepositoryFacts>;
}>;

export type MigrationRepositoryFacts = Readonly<{
  schemaVersion: "migration-repository-facts/v1";
  repositoryLocator: string;
  commonDirectory: PathIdentity;
  gitDirectory: PathIdentity;
  objectStore: PathIdentity;
  refsDirectory: PathIdentity;
  worktreeRoot: PathIdentity | null;
  index: PathIdentity | TypedAbsence;
  repositoryState: Readonly<{
    bare: boolean;
    insideWorktree: boolean;
    objectFormat: "sha1" | "sha256";
    repositoryFormatVersion: string;
  }>;
  repositoryBinding: RepositoryBinding;
}>;

/** Port 3 — enumerated filesystem + Git-plumbing effects. Never decides policy. */
export type MigrationEffectPort = Readonly<{
  createFileExclusive(input: Readonly<{ grant: LiveGrant; fence: FenceContext; resourceId: StableId; intendedBytes: Uint8Array; intendedMode: number }>): EffectObservation | BackendError;
  replaceFile(input: Readonly<{ grant: LiveGrant; fence: FenceContext; resourceId: StableId; intendedBytes: Uint8Array; intendedMode: number }>): EffectObservation | BackendError;
  removeFile(input: Readonly<{ grant: LiveGrant; fence: FenceContext; resourceId: StableId }>): EffectObservation | BackendError;
  syncDirectory(input: Readonly<{ grant: LiveGrant; fence: FenceContext; directory: string }>): EffectObservation | BackendError;
  /** Write a tree object from the authorized index (`git write-tree`). */
  gitWriteTree(input: Readonly<GitWriteTreeInput>): GitObjectObservation | BackendError;
  /** Create a commit object with explicit parents + message (`git commit-tree`). */
  gitCommitTree(input: Readonly<GitCommitTreeInput>): GitObjectObservation | BackendError;
  /** Create a tag object with `--strict` validation (`git mktag --strict`). */
  gitMktagStrict(input: Readonly<GitMktagInput>): GitObjectObservation | BackendError;
  /** Atomic ref transaction via `git update-ref --stdin -z` (start/verify/create/update/delete/prepare/commit). */
  gitUpdateRefTransaction(input: Readonly<GitRefTxInput>): GitRefObservation | BackendError;
  /** Reopen and verify an existing object (`git cat-file`). */
  rereadObject(input: Readonly<RereadObjectInput>): GitObjectObservation | BackendError;
  /** Reopen and verify an existing ref (`git rev-parse --verify`). */
  rereadRef(input: Readonly<RereadRefInput>): GitRefObservation | BackendError;
}>;

/** Port 4 — appends per-attempt events through the immutable receipt writer. */
export type MigrationAttemptEventSink = Readonly<{
  appendStart(event: AttemptStartEvent): AppendReceipt;
  appendTransition(event: AttemptTransitionEvent): AppendReceipt;
  appendEffectIntent(event: AttemptEffectIntentEvent): AppendReceipt;
  appendObservation(event: AttemptObservationEvent): AppendReceipt;
  appendTerminal(event: AttemptTerminalEvent): AppendReceipt;
}>;

/** Port 5 — monotonic time, wall-clock evidence, process liveness. Never decides lease validity. */
export type MigrationClockProcessPort = Readonly<{
  monotonicNanoseconds(): bigint;
  wallClockIso(): string;
  processIdentity(): ProcessIdentity;
  isAlive(processIdentity: ProcessIdentity): ProcessLivenessEvidence;
  observe(): ClockObservation;
}>;

/** Port 6 — separates durable local, repository-artifact, and canonical-ledger admission. */
export type ImmutableReceiptPort = Readonly<{
  createDurableLocal(input: Readonly<{ eventHash: Sha256; bytes: Uint8Array }>): ReceiptResult;
  /**
   * Admit an artifact into the repository evidence root (outside the worktree).
   * Append-only under the evidence root; content-addressed. Reused by the
   * genesis tool to bind the genesis record outside the MWA authority root.
   */
  admitRepositoryArtifact(input: Readonly<{ eventHash: Sha256; bytes: Uint8Array; namespace: string }>): ReceiptResult;
  /**
   * Admit into the canonical ledger. Blocked until S3.2 (storage architecture).
   * Returns a typed `blocked-canonical-ledger-unavailable` blocker — never a
   * silent skip or fake success (MWA-DESIGN §2.9).
   */
  admitCanonicalLedger(input: Readonly<{ eventHash: Sha256; bytes: Uint8Array }>): ReceiptResult;
  readHead(cursor: Sha256): Readonly<{ receiptHash: Sha256; cursor: Sha256 }> | undefined;
}>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type ReadonlyJsonValue = CanonicalValue;
