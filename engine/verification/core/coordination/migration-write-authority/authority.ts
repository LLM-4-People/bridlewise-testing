/**
 * MigrationWriteAuthority — the application-facing coordinator.
 *
 * Holds the six ports and enforces the lifecycle/effect protocol. It does not
 * own generator semantics, journal state (the backend does), filesystem
 * primitives (the effect port does), or policy (root-policy does).
 *
 * `acquire` re-reads repository facts, validates the caller's repository
 * binding against the live facts, compiles the resource set (catching intra-set
 * cross-kind conflicts via `migrationResourcesConflict`), and delegates to
 * `backend.acquire`. Cross-lease conflicts are enforced at two levels: the
 * backend's `resource_write_unique` partial unique index (one writer per
 * resourceId) and the backend's cross-lease natural-key conflict check (which
 * runs `migrationResourcesConflict` pairwise against every existing
 * reservation inside the same `BEGIN IMMEDIATE` transaction — MWA-DESIGN §4.7).
 *
 * Design authority: MWA-DESIGN §4. The `LiveGrant` is the opaque
 * Symbol-branded nominal from `contracts.ts`; `LeaseEvidence` carries
 * `receiptAuthority: "evidence-only-never-authority"`.
 */

import { extractErrorMessage, InputError } from "../../../../src/kernel/errors.ts";
import { canonicalHash, deepFreeze, generateId, sha256 } from "../../../../src/kernel/integrity.ts";
import {
  MWA_AUTHORITY_CONTEXT,
  MWA_BACKEND_SCHEMA_VERSION,
  MWA_LEASE_EVIDENCE_AUTHORITY,
  MWA_PROTOCOL_SCHEMA_VERSION,
  type AcquireInput,
  type AttemptEffectIntentEvent,
  type AttemptObservationEvent,
  type AttemptStartEvent,
  type AttemptTerminalEvent,
  type BackendAcquireResult,
  type BackendError,
  type BackendFenceResult,
  type BackendInspectResult,
  type BackendOpenFacts,
  type BackendOpenResult,
  type BackendResult,
  type CheckpointInput,
  type CompareAndCommitInput,
  type EffectKind,
  type FenceInput,
  type HeartbeatInput,
  type InspectInput,
  type LeaseEvidence,
  type MigrationAttemptEventSink,
  type MigrationAuthorityBackendPort,
  type MigrationAuthorityConfig,
  type MigrationAuthorityRootPolicy,
  type MigrationClockProcessPort,
  type MigrationEffectPort,
  type MigrationRepositoryFactsPort,
  type RecoverInput,
  type ReleaseInput,
  type ReleaseDisposition,
  type ReserveInput,
  type Sha256,
} from "./contracts.ts";
import { compileMigrationResourceSet, toBackendError } from "./resources.ts";
import { denied } from "./internal.ts";

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

export type MigrationWriteAuthority = Readonly<{
  readonly openFacts: BackendOpenFacts;
  acquire(input: AcquireInput): Promise<BackendAcquireResult>;
  reserve(input: ReserveInput): BackendResult;
  heartbeat(input: HeartbeatInput): BackendResult;
  checkpoint(input: CheckpointInput): BackendResult;
  fence(input: FenceInput): BackendFenceResult;
  compareAndCommit(input: CompareAndCommitInput): BackendResult;
  release(input: ReleaseInput): BackendResult;
  inspect(input: InspectInput): BackendInspectResult;
  recover(input: RecoverInput): BackendResult;
  close(): void;
}>;

export type MigrationWriteAuthorityInput = Readonly<{
  backend: MigrationAuthorityBackendPort;
  facts: MigrationRepositoryFactsPort;
  effects: MigrationEffectPort;
  events: MigrationAttemptEventSink;
  clock: MigrationClockProcessPort;
  receipts: unknown; // ImmutableReceiptPort (Tranche 3 wires canonical-ledger admission)
  config: MigrationAuthorityConfig;
  rootPolicy: MigrationAuthorityRootPolicy;
}>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSha256Like(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

/**
 * Validates the `BaseIdentity` shape. `commit`/`tree` may be a 40/64-hex object
 * id or null (unborn/empty index); `index`/`candidate`/`configuration`/
 * `policy`/`capabilities` must be 64-hex sha256 digests. A malformed base fails
 * closed with `base-drift` so a caller cannot acquire against an inconsistent
 * baseline. The backend rechecks semantic base drift at fence time against
 * the lease's recorded base.
 */
function validateBase(base: unknown): BackendError | null {
  if (base === null || typeof base !== "object") {
    return { code: "base-drift", message: "base is not an object" };
  }
  const b = base as Record<string, unknown>;
  if (b.commit !== null && !isSha256Like(b.commit) && !/^[0-9a-f]{40,64}$/u.test(String(b.commit))) {
    return { code: "base-drift", message: "base.commit is invalid" };
  }
  if (b.tree !== null && !isSha256Like(b.tree) && !/^[0-9a-f]{40,64}$/u.test(String(b.tree))) {
    return { code: "base-drift", message: "base.tree is invalid" };
  }
  for (const key of ["index", "candidate", "configuration", "policy", "capabilities"] as const) {
    if (!isSha256Like(b[key])) return { code: "base-drift", message: `base.${key} is invalid` };
  }
  return null;
}

function eventHash(fields: Readonly<Record<string, unknown>>): Sha256 {
  return canonicalHash(fields);
}

function makeStartEvent(
  leaseId: string,
  generation: string,
  repositoryIdentity: string,
  fenceIdentity: string,
  journalCursor: string,
): AttemptStartEvent {
  const base = { leaseId, generation, repositoryIdentity, fenceIdentity, journalCursor };
  return deepFreeze({ ...base, eventHash: eventHash(base) }) as AttemptStartEvent;
}

function makeEffectIntentEvent(
  leaseId: string,
  effectId: string,
  effectKind: EffectKind,
  resourceId: string,
  fenceIdentity: string,
  journalCursor: string,
): AttemptEffectIntentEvent {
  const base = { leaseId, effectId, effectKind, resourceId, fenceIdentity, journalCursor };
  return deepFreeze({ ...base, eventHash: eventHash(base) }) as AttemptEffectIntentEvent;
}

function makeObservationEvent(
  leaseId: string,
  effectId: string,
  observationHash: string,
  journalCursor: string,
): AttemptObservationEvent {
  const base = { leaseId, effectId, observationHash, journalCursor };
  return deepFreeze({ ...base, eventHash: eventHash(base) }) as AttemptObservationEvent;
}

function makeTerminalEvent(
  leaseId: string,
  disposition: ReleaseDisposition,
  journalCursor: string,
): AttemptTerminalEvent {
  const base = { leaseId, disposition, journalCursor };
  return deepFreeze({ ...base, eventHash: eventHash(base) }) as AttemptTerminalEvent;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMigrationWriteAuthority(input: MigrationWriteAuthorityInput): MigrationWriteAuthority {
  const backend = input.backend;
  const factsPort = input.facts;
  const events = input.events;
  const rootPolicy = input.rootPolicy;

  // ----- initialization (MWA-DESIGN §4.1) -----

  const openResult: BackendOpenResult = backend.open();
  if (openResult.outcome === "denied") {
    throw new InputError(`backend open denied: ${openResult.error.code}`, "backend_corrupt");
  }
  const openFacts = openResult.facts;
  verifyOpenFacts(openFacts, rootPolicy);

  function verifyOpenFacts(facts: BackendOpenFacts, rp: MigrationAuthorityRootPolicy): void {
    if (facts.schemaVersion !== MWA_BACKEND_SCHEMA_VERSION) {
      throw new InputError("backend schema version unsupported", "schema-unsupported");
    }
    if (facts.journalMode !== rp.backend.requiredJournalMode) {
      throw new InputError(`journal mode ${facts.journalMode} != ${rp.backend.requiredJournalMode}`, "schema-unsupported");
    }
    if (facts.synchronous !== rp.backend.requiredSynchronous) {
      throw new InputError(`synchronous ${facts.synchronous} != ${rp.backend.requiredSynchronous}`, "schema-unsupported");
    }
    if (facts.foreignKeys !== rp.backend.requiredForeignKeys) {
      throw new InputError("foreign keys not enforced", "schema-unsupported");
    }
    if (rp.backend.requiredDefensive && !facts.defensiveVerified) {
      throw new InputError("defensive mode not verified", "backend_corrupt");
    }
  }

  // ----- acquire -----

  async function acquire(acquireInput: AcquireInput): Promise<BackendAcquireResult> {
    // Re-read repository facts and validate the caller's repository binding
    // against the live facts (MWA-DESIGN §4.2 step 1).
    let liveFacts;
    try {
      liveFacts = await factsPort.acquire();
    } catch (error) {
      return denied({ code: "repository-mismatch", message: extractErrorMessage(error) }) as BackendAcquireResult;
    }
    if (acquireInput.repository.repositoryIdentity !== liveFacts.repositoryBinding.repositoryIdentity) {
      return denied({ code: "repository-mismatch", message: "repositoryIdentity does not match live facts" }) as BackendAcquireResult;
    }
    if (acquireInput.repository.commonDirectoryIdentity !== liveFacts.repositoryBinding.commonDirectoryIdentity) {
      return denied({ code: "repository-mismatch", message: "commonDirectoryIdentity does not match live facts" }) as BackendAcquireResult;
    }
    if (acquireInput.repository.objectStoreIdentity !== liveFacts.repositoryBinding.objectStoreIdentity) {
      return denied({ code: "repository-mismatch", message: "objectStoreIdentity does not match live facts" }) as BackendAcquireResult;
    }
    if (acquireInput.repository.objectFormat !== liveFacts.repositoryBinding.objectFormat) {
      return denied({ code: "repository-mismatch", message: "objectFormat does not match live facts" }) as BackendAcquireResult;
    }
    // Validate the resource set: registry match + intra-set cross-kind
    // conflicts (MWA-DESIGN §4.7). `compileMigrationResourceSet` runs
    // `migrationResourcesConflict` pairwise over the set.
    if (acquireInput.resources.length === 0) {
      return denied({ code: "resource-unresolved", message: "resource set is empty" }) as BackendAcquireResult;
    }
    const normalizerIdentity = acquireInput.resources[0]!.normalizerIdentity;
    try {
      compileMigrationResourceSet({
        registry: { registryIdentity: acquireInput.resourceRegistryIdentity, normalizerIdentity },
        resources: acquireInput.resources,
      });
    } catch (error) {
      return denied(toBackendError(error)) as BackendAcquireResult;
    }
    // Validate base shape (well-formed; the backend rechecks base drift at
    // fence time against the lease's recorded base).
    const baseError = validateBase(acquireInput.base);
    if (baseError !== null) return denied(baseError) as BackendAcquireResult;
    // Delegate to the backend (atomic reserve + fence generation + journal).
    const result = backend.acquire(acquireInput);
    if (result.outcome === "accepted") {
      // Emit the attempt-start event (unavoidable logging).
      const startEvent = makeStartEvent(
        result.leaseEvidence.leaseId,
        result.leaseEvidence.generation,
        acquireInput.repository.repositoryIdentity,
        result.leaseEvidence.fenceIdentity,
        result.journalCursor,
      );
      events.appendStart(startEvent);
    }
    return result;
  }

  // ----- reserve -----

  function reserve(reserveInput: ReserveInput): BackendResult {
    // Compile the complete union (never drops): validates the union has no
    // internal cross-kind conflict. The backend enforces cross-lease
    // per-resourceId uniqueness.
    if (reserveInput.completeResourceUnion.length === 0) {
      return denied({ code: "resource-unresolved", message: "reserve union is empty" });
    }
    const normalizerIdentity = reserveInput.completeResourceUnion[0]!.normalizerIdentity;
    try {
      compileMigrationResourceSet({
        registry: { registryIdentity: reserveInput.liveGrant.resourceRegistryIdentity, normalizerIdentity },
        resources: reserveInput.completeResourceUnion,
      });
    } catch (error) {
      return denied(toBackendError(error));
    }
    return backend.reserve(reserveInput);
  }

  // ----- heartbeat -----

  function heartbeat(heartbeatInput: HeartbeatInput): BackendResult {
    return backend.heartbeat(heartbeatInput);
  }

  // ----- checkpoint -----

  function checkpoint(checkpointInput: CheckpointInput): BackendResult {
    return backend.checkpoint(checkpointInput);
  }

  // ----- fence -----

  function fence(fenceInput: FenceInput): BackendFenceResult {
    const result = backend.fence(fenceInput);
    if (result.outcome === "accepted") {
      const intentEvent = makeEffectIntentEvent(
        result.fenceToken.leaseId,
        result.fenceToken.effectId,
        fenceInput.effectKind,
        fenceInput.resourceId,
        result.fenceToken.fenceIdentity,
        result.journalCursor,
      );
      events.appendEffectIntent(intentEvent);
    }
    return result;
  }

  // ----- compareAndCommit -----

  function compareAndCommit(commitInput: CompareAndCommitInput): BackendResult {
    const result = backend.compareAndCommit(commitInput);
    if (result.outcome === "accepted") {
      const obsEvent = makeObservationEvent(
        commitInput.leaseEvidence.leaseId,
        commitInput.effectId,
        commitInput.effectResultIdentity,
        result.journalCursor,
      );
      events.appendObservation(obsEvent);
    }
    return result;
  }

  // ----- release -----

  function release(releaseInput: ReleaseInput): BackendResult {
    const result = backend.release(releaseInput);
    if (result.outcome === "accepted") {
      const terminalEvent = makeTerminalEvent(
        releaseInput.leaseEvidence.leaseId,
        releaseInput.disposition,
        result.journalCursor,
      );
      events.appendTerminal(terminalEvent);
    }
    return result;
  }

  // ----- inspect -----

  function inspect(inspectInput: InspectInput): BackendInspectResult {
    return backend.inspect(inspectInput);
  }

  // ----- recover -----

  function recover(recoverInput: RecoverInput): BackendResult {
    // MWA-DESIGN §4.5: before fencing an active lease, verify the holder is
    // dead or the TTL has elapsed. The authority checks liveness via the clock
    // port and TTL via the lease's persisted last-heartbeat monotonic +
    // requested TTL. Expired/fenced leases are already known to be stale and
    // skip the liveness/TTL check.
    //
    // The gate uses the PERSISTED lease state from `backend.inspect`, NOT the
    // caller's `leaseEvidence.state` claim. `LeaseEvidence.receiptAuthority`
    // is `"evidence-only-never-authority"`, so the caller's state field is
    // evidence, not authority. A caller that claims `state: "expired"` for a
    // genuinely-active lease (TTL not elapsed, process alive) must NOT skip
    // the liveness/TTL gate. Gating on the persisted state closes that bypass.
    const inspectInput: InspectInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION,
      messageKind: "request",
      operation: "inspect",
      requestId: generateId("mwa-inspect"),
      idempotencyKey: sha256(generateId("mwa-inspect-idem")),
      repository: recoverInput.repository,
      leaseId: recoverInput.leaseEvidence.leaseId,
    });
    const inspectResult = backend.inspect(inspectInput);
    if (inspectResult.outcome === "denied") {
      return denied(inspectResult.error);
    }
    if (inspectResult.lease.state === "active") {
      const lease = inspectResult.lease;
      // Liveness: is the holder process dead?
      const liveness = input.clock.isAlive(recoverInput.clock.processIdentity);
      const processDead = liveness.observed === "dead";
      // TTL: has the TTL elapsed since the last heartbeat?
      const lastHbMonotonic = BigInt(lease.lastHeartbeatMonotonicNs);
      const currentMonotonic = BigInt(recoverInput.clock.monotonicNanoseconds);
      const ttlNs = BigInt(lease.requestedTtlMs) * 1_000_000n;
      const ttlElapsed = currentMonotonic - lastHbMonotonic >= ttlNs;
      if (!processDead && !ttlElapsed) {
        // The lease is genuinely active: the process is alive (or ambiguous)
        // and the TTL has not elapsed. Deny recovery to prevent fencing a
        // live holder (MWA-DESIGN §4.5).
        return denied({
          code: "lease-state-invalid",
          message: "recovery denied: lease is genuinely active (TTL not elapsed, process alive)",
        });
      }
    }
    return backend.recover(recoverInput);
  }

  // ----- close -----

  function close(): void {
    backend.close();
  }

  return deepFreeze({
    openFacts,
    acquire,
    reserve,
    heartbeat,
    checkpoint,
    fence,
    compareAndCommit,
    release,
    inspect,
    recover,
    close,
  }) as MigrationWriteAuthority;
}

// ---------------------------------------------------------------------------
// Internal: unwrap a (possibly sync) facts.acquire() result
// ---------------------------------------------------------------------------

// Re-export lease-evidence authority constant for consumers.
export { MWA_LEASE_EVIDENCE_AUTHORITY, MWA_AUTHORITY_CONTEXT, MWA_PROTOCOL_SCHEMA_VERSION };
export type { LeaseEvidence };
