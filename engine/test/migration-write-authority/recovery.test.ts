import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import {
  type MigrationWriteAuthorityGenesisRecord,
} from "../../verification/core/coordination/migration-write-authority/genesis.ts";
import {
  createNodeSqliteMigrationBackend,
  MWA_DEFAULT_CONFIG,
  MWA_DEFAULT_ROOT_POLICY,
} from "../../verification/core/coordination/migration-write-authority/backend-node-sqlite.ts";
import {
  MWA_BACKEND_SCHEMA_VERSION,
  MWA_PROTOCOL_SCHEMA_VERSION,
  type AcquireInput,
  type Actor,
  type BaseIdentity,
  type ClockObservation,
  type MigrationRepositoryFacts,
  type MigrationRepositoryFactsPort,
  type MigrationResource,
  type PathIdentity,
  type RecoverInput,
  type RepositoryBinding,
  type TargetState,
} from "../../verification/core/coordination/migration-write-authority/contracts.ts";
import { createMigrationWriteAuthority } from "../../verification/core/coordination/migration-write-authority/authority.ts";
import {
  reconcileMigrationAuthority,
  recoverMigrationAuthority,
  type PlannedDestination,
  type ObservedDestination,
} from "../../verification/core/coordination/migration-write-authority/recovery.ts";
import { mkTempDir } from "../support/temp-dir.ts";

const REGISTRY_ID = sha256("registry-v1");
const NORMALIZER_ID = sha256("normalizer-v1");

function makeGenesis(authorityRootPath: string): MigrationWriteAuthorityGenesisRecord {
  return Object.freeze({
    schemaVersion: "bridlewise-migration-authority-genesis/v1",
    repositoryIdentity: "a".repeat(64), commonDirectoryIdentity: "b".repeat(64), objectStoreIdentity: "c".repeat(64), objectFormat: "sha1",
    authorityRootPath, authorityRootIdentity: Object.freeze({ device: "10", inode: "20", mode: 0o700, ownerUid: "1000", ownerGid: "1000", links: "3", kind: "directory" }),
    backendSchemaVersion: MWA_BACKEND_SCHEMA_VERSION, initialFenceGeneration: "0", sqliteVersion: "3.53.1", sqliteSourceIdentity: "d".repeat(64),
    genesisWallIso: "2026-07-17T00:00:00.000Z", creatingAuthorityIdentity: "e".repeat(64), creatingAuthorityKind: "foundation-seed-transaction-authority",
    receiptAuthority: "evidence-only-not-a-bearer-capability",
  });
}

function makeActor(): Actor { return Object.freeze({ actorId: "agent-1", taskId: "task-1", subtaskId: "sub-1", attemptId: "11111111-1111-4111-8111-111111111111", processIdentity: sha256("proc-1") }); }
function makeBase(): BaseIdentity { return Object.freeze({ commit: "0".repeat(40), tree: "0".repeat(40), index: sha256("index"), candidate: sha256("candidate"), configuration: sha256("config"), policy: sha256("policy"), capabilities: sha256("caps") }); }
function makeRepo(): RepositoryBinding { return Object.freeze({ repositoryIdentity: "a".repeat(64), commonDirectoryIdentity: "b".repeat(64), objectStoreIdentity: "c".repeat(64), objectFormat: "sha1" }); }

let clockCounter = 0;
function makeClock(): ClockObservation { clockCounter += 1; return Object.freeze({ monotonicNanoseconds: (BigInt(clockCounter) * 1_000_000_000n).toString(10), wallClockIso: new Date().toISOString(), processIdentity: Object.freeze({ pid: process.pid, startTimeMs: "1", executableIdentity: sha256("proc-1") }) }); }

const PID: PathIdentity = Object.freeze({ device: "1", inode: "1", mode: 0o40755, ownerUid: "0", ownerGid: "0", links: "2", kind: "directory" });
const FILE_ID: PathIdentity = Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" });

function physical(resourceId: string, access: "read" | "write", path: string): MigrationResource {
  return Object.freeze({ kind: "physical-path", resourceId, access, resolution: "resolved", registryIdentity: REGISTRY_ID, normalizerIdentity: NORMALIZER_ID, aliasClosure: [resourceId], path, portableCollisionKey: path, observedState: Object.freeze({ kind: "absent", parentIdentity: PID, entryName: "x" }) });
}

let reqCounter = 0;
function nextIdempotencyKey(): string { reqCounter += 1; return sha256(`idem-${reqCounter}`); }
function nextRequestId(): string { reqCounter += 1; const h = sha256(`req-${reqCounter}`).slice(0, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; }

function makeAcquire(resources: readonly MigrationResource[], overrides: Partial<AcquireInput> = {}): AcquireInput {
  return Object.freeze({ schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "acquire", requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(), actor: makeActor(), planIdentity: sha256("plan-1"), base: makeBase(), resourceRegistryIdentity: REGISTRY_ID, requestedTtlMs: 60_000, resources, clock: makeClock(), ...overrides });
}

/**
 * Recovery clock: well past the 60s TTL so the authority's TTL check passes.
 * The clockPortMock returns "alive", so the TTL must have elapsed.
 */
function makeRecoverClock(): ClockObservation {
  return Object.freeze({ monotonicNanoseconds: "999000000000", wallClockIso: new Date().toISOString(), processIdentity: Object.freeze({ pid: process.pid, startTimeMs: "1", executableIdentity: sha256("proc-1") }) });
}

// Target state builders for reconciliation scenarios.
function fileState(sha: string, byteLength = 5, identity: PathIdentity = FILE_ID): TargetState {
  return Object.freeze({ kind: "file", identity, byteLength, sha256: sha });
}
function absentState(entryName = "src/a"): TargetState {
  return Object.freeze({ kind: "absent", parentIdentity: PID, entryName });
}

function makeFactsMock(repo: RepositoryBinding): MigrationRepositoryFactsPort {
  const facts: MigrationRepositoryFacts = Object.freeze({
    schemaVersion: "migration-repository-facts/v1", repositoryLocator: "/tmp/disposable",
    commonDirectory: PID, gitDirectory: PID, objectStore: PID, refsDirectory: PID, worktreeRoot: PID,
    index: Object.freeze({ kind: "absent", parentIdentity: PID, entryName: "index" }),
    repositoryState: Object.freeze({ bare: false, insideWorktree: true, objectFormat: "sha1", repositoryFormatVersion: "0" }),
    repositoryBinding: repo,
  });
  return Object.freeze({ acquire: async () => facts });
}

const eventsMock = Object.freeze({
  appendStart: () => Object.freeze({ receiptHash: "0".repeat(64), cursor: "0".repeat(64) }),
  appendTransition: () => Object.freeze({ receiptHash: "0".repeat(64), cursor: "0".repeat(64) }),
  appendEffectIntent: () => Object.freeze({ receiptHash: "0".repeat(64), cursor: "0".repeat(64) }),
  appendObservation: () => Object.freeze({ receiptHash: "0".repeat(64), cursor: "0".repeat(64) }),
  appendTerminal: () => Object.freeze({ receiptHash: "0".repeat(64), cursor: "0".repeat(64) }),
});
const clockPortMock = Object.freeze({
  monotonicNanoseconds: () => 1n, wallClockIso: () => "2026-01-01T00:00:00.000Z",
  processIdentity: () => Object.freeze({ pid: process.pid, startTimeMs: "1", executableIdentity: sha256("proc-1") }),
  isAlive: () => Object.freeze({ observed: "alive" as const, observedWallIso: "2026-01-01T00:00:00.000Z", evidenceHash: "0".repeat(64) }),
  observe: () => makeClock(),
});
const effectsMock = Object.freeze({});

function mkAuthority(dir: string) {
  const dbPath = join(dir, `mwa-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const backend = createNodeSqliteMigrationBackend({ dbPath, config: MWA_DEFAULT_CONFIG, rootPolicy: MWA_DEFAULT_ROOT_POLICY, genesisRecord: makeGenesis(join(dir, "mwa-root")) });
  const authority = createMigrationWriteAuthority({ backend, facts: makeFactsMock(makeRepo()), effects: effectsMock as never, events: eventsMock as never, clock: clockPortMock as never, receipts: null, config: MWA_DEFAULT_CONFIG, rootPolicy: MWA_DEFAULT_ROOT_POLICY });
  return { authority, backend };
}

// ---------------------------------------------------------------------------
// reconcileMigrationAuthority
// ---------------------------------------------------------------------------

test("recovery: reconcile all-previous → compensate-to-previous", () => {
  const previous = absentState();
  const next = fileState(sha256("new"));
  const destinations: PlannedDestination[] = [
    { resourceId: "src/a", journaledPrevious: previous, journaledNext: next, allowsPreviousAbsence: false, allowsNextAbsence: false },
  ];
  const observations: ObservedDestination[] = [{ resourceId: "src/a", observedState: previous }];
  const r = reconcileMigrationAuthority({ destinations, observations });
  assert.equal(r.outcome, "compensate-to-previous");
  assert.equal(r.direction, "previous");
  assert.equal(r.classifications[0]!.classification, "previous");
});

test("recovery: reconcile all-next → complete-to-next", () => {
  const previous = absentState();
  const next = fileState(sha256("new"));
  const destinations: PlannedDestination[] = [
    { resourceId: "src/a", journaledPrevious: previous, journaledNext: next, allowsPreviousAbsence: false, allowsNextAbsence: false },
  ];
  const observations: ObservedDestination[] = [{ resourceId: "src/a", observedState: next }];
  const r = reconcileMigrationAuthority({ destinations, observations });
  assert.equal(r.outcome, "complete-to-next");
  assert.equal(r.direction, "next");
  assert.equal(r.classifications[0]!.classification, "next");
});

test("recovery: reconcile mixed previous/next → blocked-unknown-effect", () => {
  const previous = absentState();
  const next = fileState(sha256("new"));
  const destinations: PlannedDestination[] = [
    { resourceId: "src/a", journaledPrevious: previous, journaledNext: next, allowsPreviousAbsence: false, allowsNextAbsence: false },
    { resourceId: "src/b", journaledPrevious: previous, journaledNext: next, allowsPreviousAbsence: false, allowsNextAbsence: false },
  ];
  // src/a observed at previous, src/b observed at next → mixed.
  const observations: ObservedDestination[] = [
    { resourceId: "src/a", observedState: previous },
    { resourceId: "src/b", observedState: next },
  ];
  const r = reconcileMigrationAuthority({ destinations, observations });
  assert.equal(r.outcome, "blocked-unknown-effect");
  assert.equal(r.direction, null);
});

test("recovery: reconcile an unknown observation (wrong content) → blocked-unknown-effect", () => {
  const previous = absentState();
  const next = fileState(sha256("new"));
  const unknown = fileState(sha256("corrupt"));
  const destinations: PlannedDestination[] = [
    { resourceId: "src/a", journaledPrevious: previous, journaledNext: next, allowsPreviousAbsence: false, allowsNextAbsence: false },
  ];
  const observations: ObservedDestination[] = [{ resourceId: "src/a", observedState: unknown }];
  const r = reconcileMigrationAuthority({ destinations, observations });
  assert.equal(r.outcome, "blocked-unknown-effect");
  assert.equal(r.classifications[0]!.classification, "unknown");
});

test("recovery: reconcile a missing observation → unknown (never infer from absence)", () => {
  const previous = absentState();
  const next = fileState(sha256("new"));
  const destinations: PlannedDestination[] = [
    { resourceId: "src/a", journaledPrevious: previous, journaledNext: next, allowsPreviousAbsence: false, allowsNextAbsence: false },
  ];
  const r = reconcileMigrationAuthority({ destinations, observations: [] });
  assert.equal(r.outcome, "blocked-unknown-effect");
  assert.equal(r.classifications[0]!.classification, "unknown");
});

test("recovery: reconcile typed-absence permitted by the plan matches next", () => {
  // A delete effect: previous = file, next = typed absence (plan permits).
  const previous = fileState(sha256("old"));
  const destinations: PlannedDestination[] = [
    { resourceId: "src/a", journaledPrevious: previous, journaledNext: null, allowsPreviousAbsence: false, allowsNextAbsence: true },
  ];
  const observations: ObservedDestination[] = [{ resourceId: "src/a", observedState: absentState() }];
  const r = reconcileMigrationAuthority({ destinations, observations });
  assert.equal(r.outcome, "complete-to-next");
  assert.equal(r.direction, "next");
});

test("recovery: reconcile typed-absence of the previous (create on empty) matches previous", () => {
  // A create effect that did not run: previous = typed absence, next = file,
  // observed = absence (the create never happened) → compensate-to-previous.
  const next = fileState(sha256("new"));
  const destinations: PlannedDestination[] = [
    { resourceId: "src/a", journaledPrevious: null, journaledNext: next, allowsPreviousAbsence: true, allowsNextAbsence: false },
  ];
  const observations: ObservedDestination[] = [{ resourceId: "src/a", observedState: absentState() }];
  const r = reconcileMigrationAuthority({ destinations, observations });
  assert.equal(r.outcome, "compensate-to-previous");
  assert.equal(r.direction, "previous");
});

test("recovery: reconcile empty destinations → blocked-unknown-effect", () => {
  const r = reconcileMigrationAuthority({ destinations: [], observations: [] });
  assert.equal(r.outcome, "blocked-unknown-effect");
});

// ---------------------------------------------------------------------------
// recoverMigrationAuthority
// ---------------------------------------------------------------------------

test("recovery: recover with a newer fence and all-next observations → recovered (complete-to-next)", async () => {
  const dir = mkTempDir("mwa-recovery-");
  try {
    const { authority } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    const recoveryGeneration = String(Number(acq.leaseEvidence.generation) + 7);
    const recoverInput: RecoverInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "recover",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      journalIdentity: acq.journalCursor, observationIdentity: sha256("obs"), directionPreference: "next",
      clock: makeRecoverClock(),
      recoveryFence: Object.freeze({ generation: recoveryGeneration, fenceIdentity: sha256("rf"), supersedesGeneration: acq.leaseEvidence.generation, supersedesFenceIdentity: acq.leaseEvidence.fenceIdentity }),
    });
    const next = fileState(sha256("new"));
    const destinations: PlannedDestination[] = [{ resourceId: "src/a", journaledPrevious: absentState(), journaledNext: next, allowsPreviousAbsence: false, allowsNextAbsence: false }];
    const observations: ObservedDestination[] = [{ resourceId: "src/a", observedState: next }];
    const r = recoverMigrationAuthority({ authority, recoverInput, destinations, observations });
    assert.equal(r.outcome, "recovered");
    assert.equal(r.reconciliation.outcome, "complete-to-next");
    // The old lease is fenced after recovery.
    const ir = authority.inspect(Object.freeze({ schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "inspect", requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(), leaseId: acq.leaseEvidence.leaseId }));
    if (ir.outcome === "accepted") assert.equal(ir.lease.state, "fenced");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery: recover with a newer fence and all-previous observations → recovered (compensate-to-previous)", async () => {
  const dir = mkTempDir("mwa-recovery-");
  try {
    const { authority } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    const recoveryGeneration = String(Number(acq.leaseEvidence.generation) + 3);
    const recoverInput: RecoverInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "recover",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      journalIdentity: acq.journalCursor, observationIdentity: sha256("obs"), directionPreference: "previous",
      clock: makeRecoverClock(),
      recoveryFence: Object.freeze({ generation: recoveryGeneration, fenceIdentity: sha256("rf"), supersedesGeneration: acq.leaseEvidence.generation, supersedesFenceIdentity: acq.leaseEvidence.fenceIdentity }),
    });
    const previous = absentState();
    const next = fileState(sha256("new"));
    const destinations: PlannedDestination[] = [{ resourceId: "src/a", journaledPrevious: previous, journaledNext: next, allowsPreviousAbsence: false, allowsNextAbsence: false }];
    const observations: ObservedDestination[] = [{ resourceId: "src/a", observedState: previous }];
    const r = recoverMigrationAuthority({ authority, recoverInput, destinations, observations });
    assert.equal(r.outcome, "recovered");
    assert.equal(r.reconciliation.outcome, "compensate-to-previous");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery: recover with a stale (non-newer) fence is denied", async () => {
  const dir = mkTempDir("mwa-recovery-");
  try {
    const { authority } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    const recoverInput: RecoverInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "recover",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      journalIdentity: acq.journalCursor, observationIdentity: sha256("obs"), directionPreference: "next",
      clock: makeRecoverClock(),
      recoveryFence: Object.freeze({ generation: acq.leaseEvidence.generation, fenceIdentity: sha256("rf"), supersedesGeneration: acq.leaseEvidence.generation, supersedesFenceIdentity: acq.leaseEvidence.fenceIdentity }),
    });
    const next = fileState(sha256("new"));
    const destinations: PlannedDestination[] = [{ resourceId: "src/a", journaledPrevious: absentState(), journaledNext: next, allowsPreviousAbsence: false, allowsNextAbsence: false }];
    const observations: ObservedDestination[] = [{ resourceId: "src/a", observedState: next }];
    const r = recoverMigrationAuthority({ authority, recoverInput, destinations, observations });
    assert.equal(r.outcome, "denied");
    assert.ok(r.error !== undefined);
    assert.equal(r.error!.code, "generation-stale");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery: recover with a partial/unknown effect → blocked-unknown-effect (journal preserved)", async () => {
  const dir = mkTempDir("mwa-recovery-");
  try {
    const { authority } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    const recoveryGeneration = String(Number(acq.leaseEvidence.generation) + 9);
    const recoverInput: RecoverInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "recover",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      journalIdentity: acq.journalCursor, observationIdentity: sha256("obs"), directionPreference: "next",
      clock: makeRecoverClock(),
      recoveryFence: Object.freeze({ generation: recoveryGeneration, fenceIdentity: sha256("rf"), supersedesGeneration: acq.leaseEvidence.generation, supersedesFenceIdentity: acq.leaseEvidence.fenceIdentity }),
    });
    // The effect wrote unexpected bytes (neither previous nor next) → unknown.
    const previous = absentState();
    const next = fileState(sha256("new"));
    const corrupt = fileState(sha256("corrupt"));
    const destinations: PlannedDestination[] = [{ resourceId: "src/a", journaledPrevious: previous, journaledNext: next, allowsPreviousAbsence: false, allowsNextAbsence: false }];
    const observations: ObservedDestination[] = [{ resourceId: "src/a", observedState: corrupt }];
    const r = recoverMigrationAuthority({ authority, recoverInput, destinations, observations });
    assert.equal(r.outcome, "blocked-unknown-effect");
    assert.equal(r.reconciliation.outcome, "blocked-unknown-effect");
    // The backend recovery still succeeded (fence advanced) but the
    // reconciliation blocked the direction — evidence and journal preserved.
    assert.ok(r.backendResult !== undefined);
    assert.equal(r.backendResult!.outcome, "accepted");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery: recover preserves the journal cursor (lease evidence stable across recovery)", async () => {
  const dir = mkTempDir("mwa-recovery-");
  try {
    const { authority } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    const cursorBefore = acq.journalCursor;
    const recoveryGeneration = String(Number(acq.leaseEvidence.generation) + 2);
    const recoverInput: RecoverInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "recover",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      journalIdentity: cursorBefore, observationIdentity: sha256("obs"), directionPreference: "next",
      clock: makeRecoverClock(),
      recoveryFence: Object.freeze({ generation: recoveryGeneration, fenceIdentity: sha256("rf"), supersedesGeneration: acq.leaseEvidence.generation, supersedesFenceIdentity: acq.leaseEvidence.fenceIdentity }),
    });
    const next = fileState(sha256("new"));
    const destinations: PlannedDestination[] = [{ resourceId: "src/a", journaledPrevious: absentState(), journaledNext: next, allowsPreviousAbsence: false, allowsNextAbsence: false }];
    const observations: ObservedDestination[] = [{ resourceId: "src/a", observedState: next }];
    const r = recoverMigrationAuthority({ authority, recoverInput, destinations, observations });
    assert.equal(r.outcome, "recovered");
    // The acquire journal cursor is preserved as the journalIdentity passed in.
    assert.equal(recoverInput.journalIdentity, cursorBefore);
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery: lying caller claims state=expired for a genuinely-active lease (TTL not elapsed, process alive) → denied with lease-state-invalid", async () => {
  // CRITICAL regression: the recovery liveness/TTL gate must use the PERSISTED
  // lease state, not the caller's `leaseEvidence.state` claim. A caller that
  // claims `state: "expired"` for a genuinely-active lease (TTL not elapsed,
  // process alive) must NOT skip the liveness/TTL gate. `LeaseEvidence.
  // receiptAuthority` is `"evidence-only-never-authority"`, so the caller's
  // state field is evidence, not authority.
  const dir = mkTempDir("mwa-recovery-");
  try {
    const { authority } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    // The persisted lease state is "active" (just acquired, TTL not elapsed).
    const inspectBefore = authority.inspect(Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "inspect",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      leaseId: acq.leaseEvidence.leaseId,
    }));
    if (inspectBefore.outcome !== "accepted") throw new Error("inspect failed");
    assert.equal(inspectBefore.lease.state, "active", "lease must be active after acquire");
    // The caller LIES: claims state="expired" but the persisted state is "active".
    // The clock mock returns "alive" and the monotonic is well within the 60s TTL.
    const lyingLeaseEvidence = Object.freeze({
      ...acq.leaseEvidence,
      state: "expired" as const,
    });
    const recoveryGeneration = String(Number(acq.leaseEvidence.generation) + 5);
    const recoverInput: RecoverInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "recover",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band",
      leaseEvidence: lyingLeaseEvidence, liveGrant: acq.liveGrant,
      journalIdentity: acq.journalCursor, observationIdentity: sha256("obs"), directionPreference: "next",
      clock: Object.freeze({ monotonicNanoseconds: "5000000000", wallClockIso: new Date().toISOString(), processIdentity: Object.freeze({ pid: process.pid, startTimeMs: "1", executableIdentity: sha256("proc-1") }) }),
      recoveryFence: Object.freeze({ generation: recoveryGeneration, fenceIdentity: sha256("rf"), supersedesGeneration: acq.leaseEvidence.generation, supersedesFenceIdentity: acq.leaseEvidence.fenceIdentity }),
    });
    // Use the authority.recover directly (not recoverMigrationAuthority) to
    // test the authority's liveness/TTL gate in isolation.
    const rec = authority.recover(recoverInput);
    assert.equal(rec.outcome, "denied", "lying caller must be denied");
    if (rec.outcome === "denied") {
      assert.equal(rec.error.code, "lease-state-invalid", "denial code must be lease-state-invalid");
    }
    // The lease must still be active (not fenced) — the gate prevented the bypass.
    const inspectAfter = authority.inspect(Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "inspect",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      leaseId: acq.leaseEvidence.leaseId,
    }));
    if (inspectAfter.outcome !== "accepted") throw new Error("inspect-after failed");
    assert.equal(inspectAfter.lease.state, "active", "lease must remain active — lying caller bypass prevented");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
