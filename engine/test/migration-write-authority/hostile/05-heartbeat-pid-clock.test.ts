/**
 * MWA Tranche 4 — Hostile Family 5: heartbeat / PID / clock / deadlock.
 *
 * Reps:
 * 1. Heartbeat loss — recovery is DENIED while the TTL hasn't elapsed and the
 * process is alive; recovery SUCCEEDS after advancing the clock past the
 * TTL (MWA-DESIGN §4.5 liveness/TTL check).
 * 2. PID reuse — `processIdentity` mismatch detected; recovery denied for a
 * wrong process identity.
 * 3. Clock regression — monotonic moves backward → `clock-regression`.
 * Plus: deadlock/orphan recovery — `recover` with a newer fence succeeds
 * (after the TTL has elapsed).
 *
 * Design authority: MWA-DESIGN §7.2 family 5 and §4.5 (liveness/TTL gate).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAccepted, assertDenied, createAuthorityHandle, createControllableClock,
  createDisposableRepo, createOracle, inspectLease, grantForLease, physical,
  setupMwaForRepo, makeAcquireInput, nextIdempotencyKey, nextRequestId,
} from "./harness.ts";
import {
  createLiveGrant, MWA_AUTHORITY_CONTEXT, MWA_PROTOCOL_SCHEMA_VERSION,
  type HeartbeatInput, type RecoverInput,
} from "../../../verification/core/coordination/migration-write-authority/contracts.ts";
import { sha256 } from "../../../src/kernel/integrity.ts";

/**
 * Helper: builds a RecoverInput for an active lease. The `clock` uses the
 * controllable clock's snapshot so the authority's liveness check sees the
 * right process identity. The caller is responsible for advancing the clock
 * past the TTL when the recovery should be allowed.
 */
function makeRecoverInput(setup: ReturnType<typeof setupMwaForRepo> extends Promise<infer T> ? T : never, lease: ReturnType<typeof inspectLease>, clock: { snapshot: () => { monotonicNanoseconds: string; wallClockIso: string; processIdentity: { pid: number; startTimeMs: string; executableIdentity: string } } }, grant: ReturnType<typeof grantForLease>, recoveryGen: string, fenceIdSuffix: string): RecoverInput {
  return Object.freeze({
    schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "recover",
    requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
    authorityContext: MWA_AUTHORITY_CONTEXT,
    leaseEvidence: Object.freeze({ leaseId: lease.leaseId, generation: lease.generation, fenceIdentity: lease.fenceIdentity, state: "active", receiptAuthority: "evidence-only-never-authority" }),
    liveGrant: grant,
    journalIdentity: sha256("journal"), observationIdentity: sha256("obs"), directionPreference: "next",
    clock: clock.snapshot(),
    recoveryFence: Object.freeze({ generation: recoveryGen, fenceIdentity: sha256(`recovery-fence-${fenceIdSuffix}`), supersedesGeneration: lease.generation, supersedesFenceIdentity: lease.fenceIdentity }),
  });
}

test("hostile-05 rep 1: heartbeat loss — recovery denied before TTL, succeeds after TTL elapsed", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const clock = createControllableClock();
    const h = createAuthorityHandle(setup, setup.worktree1, { clock });
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], clock.snapshot()));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    // The lease holder's heartbeat stops (no heartbeat calls). The lease is
    // acquired with requestedTtlMs=60_000 (60s) at monotonic=0.
    const lease = inspectLease(setup, acq.leaseEvidence.leaseId);
    assert.equal(lease.state, "active");
    const grant = grantForLease(lease);

    // --- Phase 1: TTL has NOT elapsed and process is alive → recovery DENIED ---
    // The clock is still at 0; the TTL (60s) has not elapsed.
    const recoveryGen = String(Number(lease.generation) + 10);
    const deniedInput = makeRecoverInput(setup, lease, clock, grant, recoveryGen, "1a");
    const deniedRec = h.authority.recover(deniedInput);
    assertDenied(deniedRec, "lease-state-invalid", "recovery must be denied while TTL has not elapsed and process is alive");
    // The lease must still be active (not fenced).
    const leaseAfterDeny = inspectLease(setup, acq.leaseEvidence.leaseId);
    assert.equal(leaseAfterDeny.state, "active", "lease must remain active after denied recovery");

    // --- Phase 2: advance the clock past the TTL → recovery SUCCEEDS ---
    clock.advance(61_000_000_000n); // 61 seconds > 60s TTL
    const acceptedInput = makeRecoverInput(setup, lease, clock, grant, recoveryGen, "1b");
    const rec = h.authority.recover(acceptedInput);
    assertAccepted(rec, "recovery with a newer fence must succeed after TTL elapsed");
    const afterLease = inspectLease(setup, acq.leaseEvidence.leaseId);
    assert.equal(afterLease.state, "fenced", "old lease must be fenced after recovery");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
    h.close();
  } finally {
    repo.cleanup();
  }
});

test("hostile-05: recovery of a genuinely active lease (TTL not elapsed, process alive) → denied with lease-state-invalid", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const clock = createControllableClock();
    const h = createAuthorityHandle(setup, setup.worktree1, { clock });
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], clock.snapshot()));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    const lease = inspectLease(setup, acq.leaseEvidence.leaseId);
    assert.equal(lease.state, "active");
    const grant = grantForLease(lease);
    // The clock has NOT advanced; TTL has not elapsed; process is alive.
    // A newer fence alone is NOT sufficient — the liveness/TTL gate must deny.
    const recoveryGen = String(Number(lease.generation) + 100);
    const recoverInput = makeRecoverInput(setup, lease, clock, grant, recoveryGen, "active");
    const rec = h.authority.recover(recoverInput);
    assertDenied(rec, "lease-state-invalid", "recovery of a genuinely active lease must be denied");
    // The lease must still be active (not fenced).
    const leaseAfter = inspectLease(setup, acq.leaseEvidence.leaseId);
    assert.equal(leaseAfter.state, "active", "lease must remain active after denied recovery");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
    h.close();
  } finally {
    repo.cleanup();
  }
});

test("hostile-05 rep 2: PID reuse — wrong processIdentity recovery denied (process-identity-ambiguous)", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const clock = createControllableClock({ executableIdentity: sha256("original-exec") });
    const h = createAuthorityHandle(setup, setup.worktree1, { clock });
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], clock.snapshot()));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    const lease = inspectLease(setup, acq.leaseEvidence.leaseId);
    // A different process (reused PID) with a WRONG processIdentity tries to
    // recover. The backend's `validateGrant` checks the grant's processIdentity
    // against the lease's stored process_identity.
    const wrongGrant = createLiveGrant({
      leaseId: lease.leaseId, generation: lease.generation, fenceIdentity: lease.fenceIdentity,
      repositoryIdentity: lease.repositoryIdentity, resourceRegistryIdentity: lease.resourceRegistryIdentity,
      processIdentity: sha256("different-exec-identity"),
    });
    // Advance the clock past the TTL so the authority's liveness/TTL check
    // passes; the denial must come from the backend's process-identity check.
    clock.advance(61_000_000_000n);
    const recoveryGen = String(Number(lease.generation) + 10);
    const recoverInput: RecoverInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "recover",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
      authorityContext: MWA_AUTHORITY_CONTEXT,
      leaseEvidence: Object.freeze({ leaseId: lease.leaseId, generation: lease.generation, fenceIdentity: lease.fenceIdentity, state: "active", receiptAuthority: "evidence-only-never-authority" }),
      liveGrant: wrongGrant,
      journalIdentity: sha256("journal"), observationIdentity: sha256("obs"), directionPreference: "next",
      clock: clock.snapshot(),
      recoveryFence: Object.freeze({ generation: recoveryGen, fenceIdentity: sha256("recovery-fence-2"), supersedesGeneration: lease.generation, supersedesFenceIdentity: lease.fenceIdentity }),
    });
    const rec = h.authority.recover(recoverInput);
    assertDenied(rec, "process-identity-ambiguous", "wrong processIdentity must be denied");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
    h.close();
  } finally {
    repo.cleanup();
  }
});

test("hostile-05 rep 3: clock regression — monotonic moves backward → clock-regression; orphan recovery succeeds after TTL", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const clock = createControllableClock();
    const h = createAuthorityHandle(setup, setup.worktree1, { clock });
    // Advance the clock past zero so the lease's persisted monotonic is
    // non-zero; a regression to a lower value is then detectable.
    clock.advance(1_000_000_000n);
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], clock.snapshot()));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    // Heartbeat with a regressed monotonic clock → clock-regression.
    clock.regressMonotonic(0n);
    const hb: HeartbeatInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "heartbeat",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
      authorityContext: MWA_AUTHORITY_CONTEXT, leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      requestedTtlMs: 120_000, clock: clock.snapshot(),
    });
    const hbResult = h.authority.heartbeat(hb);
    assertDenied(hbResult, "clock-regression", "regressed monotonic clock must be denied");
    // Orphan/deadlock recovery: advance the clock past the TTL (the lease
    // was acquired at ~1s with TTL=60s) and recover with a newer fence.
    clock.advance(62_000_000_000n); // >60s from the acquire monotonic
    const lease = inspectLease(setup, acq.leaseEvidence.leaseId);
    const recoveryGen = String(Number(lease.generation) + 20);
    const grant = grantForLease(lease);
    const recoverInput: RecoverInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "recover",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
      authorityContext: MWA_AUTHORITY_CONTEXT,
      leaseEvidence: Object.freeze({ leaseId: lease.leaseId, generation: lease.generation, fenceIdentity: lease.fenceIdentity, state: "active", receiptAuthority: "evidence-only-never-authority" }),
      liveGrant: grant,
      journalIdentity: sha256("journal"), observationIdentity: sha256("obs"), directionPreference: "next",
      clock: clock.snapshot(),
      recoveryFence: Object.freeze({ generation: recoveryGen, fenceIdentity: sha256("recovery-fence-3"), supersedesGeneration: lease.generation, supersedesFenceIdentity: lease.fenceIdentity }),
    });
    const rec = h.authority.recover(recoverInput);
    assertAccepted(rec, "orphan recovery with a newer fence must succeed after TTL");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
    h.close();
  } finally {
    repo.cleanup();
  }
});

test("hostile-05: recovery proceeds when the holder process is dead (before TTL elapses) — exercises isAlive=dead branch", async () => {
  // MINOR regression: the `processDead === true` branch in authority.ts
  // recovery must be exercised. The controllable clock's `setLivenessObserved`
  // makes `isAlive` return `observed: "dead"`. The TTL has NOT elapsed (clock
  // not advanced past 60s), but the holder process is dead, so the liveness
  // check passes and recovery PROCEEDS (fences the old lease).
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const clock = createControllableClock();
    const h = createAuthorityHandle(setup, setup.worktree1, { clock });
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], clock.snapshot()));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    const lease = inspectLease(setup, acq.leaseEvidence.leaseId);
    assert.equal(lease.state, "active");
    const grant = grantForLease(lease);
    // The holder process is dead (before TTL elapses). The liveness check
    // passes because processDead === true, so recovery PROCEEDS.
    clock.setLivenessObserved("dead");
    const recoveryGen = String(Number(lease.generation) + 10);
    const recoverInput = makeRecoverInput(setup, lease, clock, grant, recoveryGen, "dead");
    const rec = h.authority.recover(recoverInput);
    assertAccepted(rec, "recovery must proceed when the holder process is dead (before TTL)");
    const afterLease = inspectLease(setup, acq.leaseEvidence.leaseId);
    assert.equal(afterLease.state, "fenced", "old lease must be fenced after recovery");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
    h.close();
  } finally {
    repo.cleanup();
  }
});
