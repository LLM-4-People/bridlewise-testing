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
  type CompareAndCommitInput,
  type EffectObservation,
  type FenceInput,
  type GitObjectObservation,
  type GitRefObservation,
  type HeartbeatInput,
  type LiveGrant,
  isLiveGrant,
  type MigrationAuthorityConfig,
  type MigrationAuthorityRootPolicy,
  type MigrationRepositoryFacts,
  type MigrationRepositoryFactsPort,
  type MigrationResource,
  type RecoverInput,
  type RepositoryBinding,
  type ReserveInput,
} from "../../verification/core/coordination/migration-write-authority/contracts.ts";
import { createMigrationWriteAuthority } from "../../verification/core/coordination/migration-write-authority/authority.ts";
import { mkTempDir } from "../support/temp-dir.ts";

const REGISTRY_ID = sha256("registry-v1");
const NORMALIZER_ID = sha256("normalizer-v1");

function makeGenesis(authorityRootPath: string): MigrationWriteAuthorityGenesisRecord {
  return Object.freeze({
    schemaVersion: "bridlewise-migration-authority-genesis/v1",
    repositoryIdentity: "a".repeat(64),
    commonDirectoryIdentity: "b".repeat(64),
    objectStoreIdentity: "c".repeat(64),
    objectFormat: "sha1",
    authorityRootPath,
    authorityRootIdentity: Object.freeze({ device: "10", inode: "20", mode: 0o700, ownerUid: "1000", ownerGid: "1000", links: "3", kind: "directory" }),
    backendSchemaVersion: MWA_BACKEND_SCHEMA_VERSION,
    initialFenceGeneration: "0",
    sqliteVersion: "3.53.1",
    sqliteSourceIdentity: "d".repeat(64),
    genesisWallIso: "2026-07-17T00:00:00.000Z",
    creatingAuthorityIdentity: "e".repeat(64),
    creatingAuthorityKind: "foundation-seed-transaction-authority",
    receiptAuthority: "evidence-only-not-a-bearer-capability",
  });
}

function makeActor(): Actor {
  return Object.freeze({ actorId: "agent-1", taskId: "task-1", subtaskId: "sub-1", attemptId: "11111111-1111-4111-8111-111111111111", processIdentity: sha256("proc-1") });
}
function makeBase(): BaseIdentity {
  return Object.freeze({ commit: "0".repeat(40), tree: "0".repeat(40), index: sha256("index"), candidate: sha256("candidate"), configuration: sha256("config"), policy: sha256("policy"), capabilities: sha256("caps") });
}
function makeRepo(): RepositoryBinding {
  return Object.freeze({ repositoryIdentity: "a".repeat(64), commonDirectoryIdentity: "b".repeat(64), objectStoreIdentity: "c".repeat(64), objectFormat: "sha1" });
}

let clockCounter = 0;
function makeClock(): ClockObservation {
  clockCounter += 1;
  return Object.freeze({ monotonicNanoseconds: (BigInt(clockCounter) * 1_000_000_000n).toString(10), wallClockIso: new Date().toISOString(), processIdentity: Object.freeze({ pid: process.pid, startTimeMs: "1", executableIdentity: sha256("proc-1") }) });
}

const PID = Object.freeze({ device: "1", inode: "1", mode: 0o40755, ownerUid: "0", ownerGid: "0", links: "2", kind: "directory" as const });

function physical(resourceId: string, access: "read" | "write", path: string): MigrationResource {
  return Object.freeze({ kind: "physical-path", resourceId, access, resolution: "resolved", registryIdentity: REGISTRY_ID, normalizerIdentity: NORMALIZER_ID, aliasClosure: [resourceId], path, portableCollisionKey: path, observedState: Object.freeze({ kind: "absent", parentIdentity: PID, entryName: "x" }) });
}

function semantic(resourceId: string, access: "read" | "write", ownerId: string, ancestors: readonly string[] = []): MigrationResource {
  return Object.freeze({ kind: "semantic-owner", resourceId, access, resolution: "resolved", registryIdentity: REGISTRY_ID, normalizerIdentity: NORMALIZER_ID, aliasClosure: [resourceId], ownerKind: "module", ownerId, ancestorOwnerIds: ancestors });
}

let reqCounter = 0;
function nextIdempotencyKey(): string { reqCounter += 1; return sha256(`idem-${reqCounter}`); }
function nextRequestId(): string { reqCounter += 1; const h = sha256(`req-${reqCounter}`).slice(0, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; }

function absentState() { return Object.freeze({ kind: "absent" as const, parentIdentity: PID, entryName: "x" }); }

function makeAcquire(resources: readonly MigrationResource[], overrides: Partial<AcquireInput> = {}): AcquireInput {
  return Object.freeze({
    schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "acquire",
    requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
    actor: makeActor(), planIdentity: sha256("plan-1"), base: makeBase(),
    resourceRegistryIdentity: REGISTRY_ID, requestedTtlMs: 60_000, resources, clock: makeClock(), ...overrides,
  });
}

/**
 * Recovery clock: a clock observation well past the lease TTL (60s) so the
 * authority's TTL check passes and recovery is allowed. The liveness mock
 * returns "alive", so the TTL must have elapsed for recovery to succeed.
 */
function makeRecoverClock(): ClockObservation {
  return Object.freeze({ monotonicNanoseconds: "999000000000", wallClockIso: new Date().toISOString(), processIdentity: Object.freeze({ pid: process.pid, startTimeMs: "1", executableIdentity: sha256("proc-1") }) });
}

function makeFactsMock(repo: RepositoryBinding): MigrationRepositoryFactsPort {
  const facts: MigrationRepositoryFacts = Object.freeze({
    schemaVersion: "migration-repository-facts/v1",
    repositoryLocator: "/tmp/disposable",
    commonDirectory: PID, gitDirectory: PID, objectStore: PID, refsDirectory: PID, worktreeRoot: PID,
    index: Object.freeze({ kind: "absent", parentIdentity: PID, entryName: "index" }),
    repositoryState: Object.freeze({ bare: false, insideWorktree: true, objectFormat: "sha1", repositoryFormatVersion: "0" }),
    repositoryBinding: repo,
  });
  return Object.freeze({ acquire: async () => facts });
}

function makeEventsMock(): { events: unknown[]; sink: import("../../verification/core/coordination/migration-write-authority/contracts.ts").MigrationAttemptEventSink } {
  const events: unknown[] = [];
  const receipt = Object.freeze({ receiptHash: "0".repeat(64), cursor: "0".repeat(64) });
  const sink = Object.freeze({
    appendStart: (e: unknown) => { events.push(["start", e]); return receipt; },
    appendTransition: (e: unknown) => { events.push(["transition", e]); return receipt; },
    appendEffectIntent: (e: unknown) => { events.push(["intent", e]); return receipt; },
    appendObservation: (e: unknown) => { events.push(["observation", e]); return receipt; },
    appendTerminal: (e: unknown) => { events.push(["terminal", e]); return receipt; },
  });
  return { events, sink };
}

const clockPortMock = Object.freeze({
  monotonicNanoseconds: () => 1n,
  wallClockIso: () => "2026-01-01T00:00:00.000Z",
  processIdentity: () => Object.freeze({ pid: process.pid, startTimeMs: "1", executableIdentity: sha256("proc-1") }),
  isAlive: () => Object.freeze({ observed: "alive" as const, observedWallIso: "2026-01-01T00:00:00.000Z", evidenceHash: "0".repeat(64) }),
  observe: () => makeClock(),
});

const effectsMock = Object.freeze({
  createFileExclusive: () => ({ kind: "filesystem", effectKind: "filesystem-create", resourceId: "x", observedState: absentState(), observationHash: "0".repeat(64) }) as EffectObservation,
  replaceFile: () => ({ kind: "filesystem", effectKind: "filesystem-replace", resourceId: "x", observedState: absentState(), observationHash: "0".repeat(64) }) as EffectObservation,
  removeFile: () => ({ kind: "filesystem", effectKind: "filesystem-remove", resourceId: "x", observedState: absentState(), observationHash: "0".repeat(64) }) as EffectObservation,
  syncDirectory: () => ({ kind: "filesystem", effectKind: "filesystem-sync", resourceId: "x", observedState: absentState(), observationHash: "0".repeat(64) }) as EffectObservation,
  gitWriteTree: () => ({ kind: "git-object", effectKind: "git-object-create", resourceId: "x", objectName: "0".repeat(40), objectKind: "tree", objectId: "0".repeat(40), observationHash: "0".repeat(64) }) as GitObjectObservation,
  gitCommitTree: () => ({ kind: "git-object", effectKind: "git-object-create", resourceId: "x", objectName: "0".repeat(40), objectKind: "commit", objectId: "0".repeat(40), observationHash: "0".repeat(64) }) as GitObjectObservation,
  gitMktagStrict: () => ({ kind: "git-object", effectKind: "git-object-create", resourceId: "x", objectName: "0".repeat(40), objectKind: "tag", objectId: "0".repeat(40), observationHash: "0".repeat(64) }) as GitObjectObservation,
  gitUpdateRefTransaction: () => ({ kind: "git-ref", effectKind: "git-ref-transaction", resourceId: "x", refName: "refs/heads/x", newObjectId: null, oldObjectId: null, observationHash: "0".repeat(64) }) as GitRefObservation,
  rereadObject: () => ({ kind: "git-object", effectKind: "git-object-create", resourceId: "x", objectName: "0".repeat(40), objectKind: "commit", objectId: "0".repeat(40), observationHash: "0".repeat(64) }) as GitObjectObservation,
  rereadRef: () => ({ kind: "git-ref", effectKind: "git-ref-transaction", resourceId: "x", refName: "refs/heads/x", newObjectId: "0".repeat(40), oldObjectId: null, observationHash: "0".repeat(64) }) as GitRefObservation,
}) as unknown as import("../../verification/core/coordination/migration-write-authority/contracts.ts").MigrationEffectPort;

function mkAuthority(dir: string, overrides: Readonly<{ config?: Partial<MigrationAuthorityConfig>; rootPolicy?: Partial<MigrationAuthorityRootPolicy> }> = {}) {
  const dbPath = join(dir, `mwa-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const config = { ...MWA_DEFAULT_CONFIG, ...overrides.config };
  const rootPolicy = { ...MWA_DEFAULT_ROOT_POLICY, ...overrides.rootPolicy };
  const backend = createNodeSqliteMigrationBackend({ dbPath, config: Object.freeze(config), rootPolicy: Object.freeze(rootPolicy) as MigrationAuthorityRootPolicy, genesisRecord: makeGenesis(join(dir, "mwa-root")) });
  const { events, sink } = makeEventsMock();
  const authority = createMigrationWriteAuthority({
    backend, facts: makeFactsMock(makeRepo()), effects: effectsMock, events: sink, clock: clockPortMock, receipts: null,
    config: Object.freeze(config), rootPolicy: Object.freeze(rootPolicy) as MigrationAuthorityRootPolicy,
  });
  return { authority, backend, events };
}

// ---------------------------------------------------------------------------
// acquire
// ---------------------------------------------------------------------------

test("authority: acquire happy path returns a LiveGrant and emits a start event", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority, events } = mkAuthority(dir);
    const result = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    assert.equal(result.outcome, "accepted");
    if (result.outcome !== "accepted") return;
    assert.equal(typeof result.liveGrant.leaseId, "string");
    assert.equal(result.leaseEvidence.state, "active");
    assert.equal(result.leaseEvidence.receiptAuthority, "evidence-only-never-authority");
    // JSON.stringify drops the Symbol brand → the grant is never serializable
    // back into a valid LiveGrant (the brand is lost).
    const deserialized = JSON.parse(JSON.stringify(result.liveGrant));
    assert.equal(isLiveGrant(deserialized), false, "deserialized grant must not be a valid LiveGrant");
    assert.ok(events.some((e) => (e as unknown[])[0] === "start"));
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authority: acquire denies a resource conflict against an existing lease", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    const r1 = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    assert.equal(r1.outcome, "accepted");
    const r2 = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")], { actor: { ...makeActor(), attemptId: "22222222-2222-4222-8222-222222222222" } }));
    assert.equal(r2.outcome, "denied");
    if (r2.outcome === "denied") assert.equal(r2.error.code, "resource-conflict");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authority: acquire denies a malformed base with base-drift", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    const badBase = { ...makeBase(), index: "not-a-sha" };
    const r = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")], { base: badBase as unknown as BaseIdentity }));
    assert.equal(r.outcome, "denied");
    if (r.outcome === "denied") assert.equal(r.error.code, "base-drift");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authority: acquire denies an unresolved (empty) resource set", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    const r = await authority.acquire(makeAcquire([]));
    assert.equal(r.outcome, "denied");
    if (r.outcome === "denied") assert.equal(r.error.code, "resource-unresolved");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authority: acquire denies a repository binding that does not match live facts", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const dbPath = join(dir, `mwa-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const backend = createNodeSqliteMigrationBackend({ dbPath, config: MWA_DEFAULT_CONFIG, rootPolicy: MWA_DEFAULT_ROOT_POLICY, genesisRecord: makeGenesis(join(dir, "mwa-root")) });
    const wrongRepo: RepositoryBinding = Object.freeze({ repositoryIdentity: "f".repeat(64), commonDirectoryIdentity: "b".repeat(64), objectStoreIdentity: "c".repeat(64), objectFormat: "sha1" });
    const authority = createMigrationWriteAuthority({ backend, facts: makeFactsMock(makeRepo()), effects: effectsMock, events: makeEventsMock().sink, clock: clockPortMock, receipts: null, config: MWA_DEFAULT_CONFIG, rootPolicy: MWA_DEFAULT_ROOT_POLICY });
    const r = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")], { repository: wrongRepo }));
    assert.equal(r.outcome, "denied");
    if (r.outcome === "denied") assert.equal(r.error.code, "repository-mismatch");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// reserve
// ---------------------------------------------------------------------------

test("authority: reserve adds disjoint resources and detects conflicts", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    const grant = acq.liveGrant;
    const leaseEvidence = acq.leaseEvidence;
    const reserveInput: ReserveInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "reserve",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence, liveGrant: grant,
      completeResourceUnion: [physical("src/a", "write", "src/a"), physical("src/b", "write", "src/b")],
    });
    const r1 = authority.reserve(reserveInput);
    assert.equal(r1.outcome, "accepted");
    // Reserve a conflicting resource held by another lease.
    const acq2 = await authority.acquire(makeAcquire([physical("src/other", "write", "src/other")], { actor: { ...makeActor(), attemptId: "33333333-3333-4333-8333-333333333333" } }));
    if (acq2.outcome !== "accepted") throw new Error("acquire2 failed");
    const r2 = authority.reserve(Object.freeze({ ...reserveInput, requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), completeResourceUnion: [physical("src/a", "write", "src/a"), physical("src/other", "write", "src/other")] }));
    assert.equal(r2.outcome, "denied");
    if (r2.outcome === "denied") assert.equal(r2.error.code, "resource-conflict");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authority: reserve rejects an internally conflicting union (cross-kind)", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    // Two semantic owners with the same ownerId conflict intra-set.
    const reserveInput: ReserveInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "reserve",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      completeResourceUnion: [semantic("sem.a", "write", "owner.core"), semantic("sem.b", "write", "owner.core")],
    });
    const r = authority.reserve(reserveInput);
    assert.equal(r.outcome, "denied");
    if (r.outcome === "denied") assert.equal(r.error.code, "resource-conflict");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authority: reserve idempotency replays the same result", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    const reserveInput: ReserveInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "reserve",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      completeResourceUnion: [physical("src/a", "write", "src/a"), physical("src/b", "write", "src/b")],
    });
    assert.equal(authority.reserve(reserveInput).outcome, "accepted");
    assert.equal(authority.reserve(reserveInput).outcome, "accepted");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

test("authority: heartbeat extends an active lease; rejects a stale generation", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    const hb: HeartbeatInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "heartbeat",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      requestedTtlMs: 120_000, clock: makeClock(),
    });
    assert.equal(authority.heartbeat(hb).outcome, "accepted");
    // Stale generation → generation-stale.
    const stale = { ...(acq.liveGrant as object), generation: "0" } as unknown as LiveGrant;
    const hbStale: HeartbeatInput = Object.freeze({ ...hb, liveGrant: stale, requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey() });
    const r = authority.heartbeat(hbStale);
    assert.equal(r.outcome, "denied");
    if (r.outcome === "denied") assert.equal(r.error.code, "generation-stale");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// checkpoint
// ---------------------------------------------------------------------------

test("authority: checkpoint records completed effects and a next safe action", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    const r = authority.checkpoint(Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "checkpoint",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      completedEffectIdentities: [sha256("eff1")], remainingWriteResourceIds: ["src/a"], nextSafeAction: "fence-next-effect", journalCursor: acq.journalCursor,
    }));
    assert.equal(r.outcome, "accepted");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// fence
// ---------------------------------------------------------------------------

test("authority: fence grants a token; rejects a stale journal cursor", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    const intended = Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 5, sha256: sha256("hello") });
    const fenceInput: FenceInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "fence",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      effectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", effectKind: "filesystem-replace", resourceId: "src/a",
      expectedState: absentState(), intendedState: intended, base: makeBase(), journalCursor: acq.journalCursor,
    });
    const r = authority.fence(fenceInput);
    assert.equal(r.outcome, "accepted");
    // Stale journal cursor → journal-mismatch.
    const staleFence: FenceInput = Object.freeze({ ...fenceInput, journalCursor: "0".repeat(64), requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), effectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    const r2 = authority.fence(staleFence);
    assert.equal(r2.outcome, "denied");
    if (r2.outcome === "denied") assert.equal(r2.error.code, "journal-mismatch");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// compareAndCommit
// ---------------------------------------------------------------------------

test("authority: compareAndCommit succeeds on CAS match; fails on mismatch", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    const intended = Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 5, sha256: sha256("hello") });
    const fenceInput: FenceInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "fence",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      effectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", effectKind: "filesystem-replace", resourceId: "src/a",
      expectedState: absentState(), intendedState: intended, base: makeBase(), journalCursor: acq.journalCursor,
    });
    const fr = authority.fence(fenceInput);
    if (fr.outcome !== "accepted") throw new Error("fence failed");
    const commitOk: CompareAndCommitInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "compare-and-commit",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      effectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", fenceIdentity: fr.fenceToken.fenceIdentity, resourceId: "src/a",
      base: makeBase(), expectedState: absentState(), intendedState: intended, observedState: intended, effectResultIdentity: sha256("eff"), journalCursor: acq.journalCursor,
    });
    assert.equal(authority.compareAndCommit(commitOk).outcome, "accepted");
    // CAS mismatch: observed!= intended.
    const observed = Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 3, sha256: sha256("bad") });
    const fenceInput2: FenceInput = Object.freeze({ ...fenceInput, effectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey() });
    const fr2 = authority.fence(fenceInput2);
    if (fr2.outcome !== "accepted") throw new Error("fence2 failed");
    const commitBad: CompareAndCommitInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "compare-and-commit",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      effectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", fenceIdentity: fr2.fenceToken.fenceIdentity, resourceId: "src/a",
      base: makeBase(), expectedState: absentState(), intendedState: intended, observedState: observed, effectResultIdentity: sha256("eff"), journalCursor: acq.journalCursor,
    });
    const r = authority.compareAndCommit(commitBad);
    assert.equal(r.outcome, "denied");
    if (r.outcome === "denied") assert.equal(r.error.code, "cas-mismatch");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// release + inspect
// ---------------------------------------------------------------------------

test("authority: release transitions to released; inspect reads it; emits a terminal event", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority, events } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    const r = authority.release(Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "release",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      disposition: "completed", journalCursor: acq.journalCursor,
    }));
    assert.equal(r.outcome, "accepted");
    if (r.outcome === "accepted") assert.equal(r.leaseEvidence.state, "released");
    assert.ok(events.some((e) => (e as unknown[])[0] === "terminal"));
    const ir = authority.inspect(Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "inspect",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(), leaseId: acq.leaseEvidence.leaseId,
    }));
    assert.equal(ir.outcome, "accepted");
    if (ir.outcome === "accepted") assert.equal(ir.lease.state, "released");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authority: inspect returns lease-missing for an unknown lease", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    const ir = authority.inspect(Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "inspect",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(), leaseId: "00000000-0000-4000-8000-000000000000",
    }));
    assert.equal(ir.outcome, "denied");
    if (ir.outcome === "denied") assert.equal(ir.error.code, "lease-missing");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// recover
// ---------------------------------------------------------------------------

test("authority: recover with a newer generation fences the old lease; rejects a stale fence", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    const acq = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    if (acq.outcome !== "accepted") throw new Error("acquire failed");
    const recoveryGeneration = String(Number(acq.leaseEvidence.generation) + 5);
    const recoverInput: RecoverInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "recover",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: makeRepo(),
      authorityContext: "process-private-live-grant-required-out-of-band", leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      journalIdentity: acq.journalCursor, observationIdentity: sha256("obs"), directionPreference: "next",
      clock: makeRecoverClock(),
      recoveryFence: Object.freeze({ generation: recoveryGeneration, fenceIdentity: sha256("rf"), supersedesGeneration: acq.leaseEvidence.generation, supersedesFenceIdentity: acq.leaseEvidence.fenceIdentity }),
    });
    assert.equal(authority.recover(recoverInput).outcome, "accepted");
    // Stale fence (not newer) → generation-stale.
    const staleRecover: RecoverInput = Object.freeze({ ...recoverInput, requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), recoveryFence: Object.freeze({ generation: acq.leaseEvidence.generation, fenceIdentity: sha256("rf2"), supersedesGeneration: acq.leaseEvidence.generation, supersedesFenceIdentity: acq.leaseEvidence.fenceIdentity }) });
    const r = authority.recover(staleRecover);
    assert.equal(r.outcome, "denied");
    if (r.outcome === "denied") assert.equal(r.error.code, "generation-stale");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cross-kind conflict detection (semantic/generated/ref/package) at acquire
// ---------------------------------------------------------------------------

test("authority: acquire rejects an intra-set semantic conflict", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    // Two semantic-owner resources with the same ownerId conflict.
    const r = await authority.acquire(makeAcquire([semantic("sem.a", "write", "owner.core"), semantic("sem.b", "write", "owner.core")]));
    assert.equal(r.outcome, "denied");
    if (r.outcome === "denied") assert.equal(r.error.code, "resource-conflict");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authority: acquire rejects an intra-set git-ref family conflict", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    const refA: MigrationResource = Object.freeze({ kind: "git-ref", resourceId: "ref.a", access: "write", resolution: "resolved", registryIdentity: REGISTRY_ID, normalizerIdentity: NORMALIZER_ID, aliasClosure: ["ref.a"], refName: "refs/heads/x", refFamilyId: "family-1", expectedOld: null, intendedObjectKind: "commit" });
    const refB: MigrationResource = Object.freeze({ kind: "git-ref", resourceId: "ref.b", access: "write", resolution: "resolved", registryIdentity: REGISTRY_ID, normalizerIdentity: NORMALIZER_ID, aliasClosure: ["ref.b"], refName: "refs/heads/y", refFamilyId: "family-1", expectedOld: null, intendedObjectKind: "commit" });
    const r = await authority.acquire(makeAcquire([refA, refB]));
    assert.equal(r.outcome, "denied");
    if (r.outcome === "denied") assert.equal(r.error.code, "resource-conflict");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Worktree rules: disjoint paths coexist, shared semantic conflicts
// ---------------------------------------------------------------------------

test("authority: disjoint physical paths coexist across leases; shared semantic owner conflicts", async () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const { authority } = mkAuthority(dir);
    const r1 = await authority.acquire(makeAcquire([physical("src/a", "write", "src/a")]));
    assert.equal(r1.outcome, "accepted");
    // Disjoint path → coexist.
    const r2 = await authority.acquire(makeAcquire([physical("src/b", "write", "src/b")], { actor: { ...makeActor(), attemptId: "55555555-5555-4555-8555-555555555555" } }));
    assert.equal(r2.outcome, "accepted");
    // Same semantic owner (same resourceId) → conflict through the shared backend.
    const r3 = await authority.acquire(makeAcquire([semantic("owner.core", "write", "owner.core")], { actor: { ...makeActor(), attemptId: "66666666-6666-4666-8666-666666666666" } }));
    assert.equal(r3.outcome, "accepted");
    const r4 = await authority.acquire(makeAcquire([semantic("owner.core", "write", "owner.core")], { actor: { ...makeActor(), attemptId: "77777777-7777-4777-8777-777777777777" } }));
    assert.equal(r4.outcome, "denied");
    if (r4.outcome === "denied") assert.equal(r4.error.code, "resource-conflict");
    authority.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Initialization: open facts verified against root-policy ceilings
// ---------------------------------------------------------------------------

test("authority: init throws when the backend open fails root-policy ceilings (WAL allowed)", () => {
  const dir = mkTempDir("mwa-auth-");
  try {
    const dbPath = join(dir, `mwa-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const backend = createNodeSqliteMigrationBackend({ dbPath, config: MWA_DEFAULT_CONFIG, rootPolicy: { ...MWA_DEFAULT_ROOT_POLICY, backend: { ...MWA_DEFAULT_ROOT_POLICY.backend, walAllowed: true as false } }, genesisRecord: makeGenesis(join(dir, "mwa-root")) });
    assert.throws(() => createMigrationWriteAuthority({ backend, facts: makeFactsMock(makeRepo()), effects: effectsMock, events: makeEventsMock().sink, clock: clockPortMock, receipts: null, config: MWA_DEFAULT_CONFIG, rootPolicy: { ...MWA_DEFAULT_ROOT_POLICY, backend: { ...MWA_DEFAULT_ROOT_POLICY.backend, walAllowed: true as false } } as MigrationAuthorityRootPolicy }), /denied|schema-unsupported|backend/u);
    backend.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
