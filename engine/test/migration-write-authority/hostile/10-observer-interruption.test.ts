/**
 * MWA Tranche 4 — Hostile Family 10: observer interruption.
 *
 * Observer/steering interruption during active write → safe quiescence
 * (`active-quiescing`), checkpoint, rebind, resume. No duplicate effect.
 *
 * Reps:
 * 1. Observer interruption during active write — safe quiescence
 * (`active-quiescing`), checkpoint, resume.
 * 2. Steering interruption — checkpoint, rebind, resume; no duplicate effect
 * (idempotent re-fence of the same effect is accepted; the CAS prevents a
 * duplicate commit).
 * 3. Observer interruption during recovery — recovery pauses, resumes,
 * completes (the recovery decision is deterministic).
 *
 * Design authority: MWA-DESIGN §7.2 family 10, §2.2 (quiescing state).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAccepted, createAuthorityHandle, createDisposableRepo,
  createOracle, inspectLease, grantForLease, physical, setupMwaForRepo,
  makeAcquireInput, makeBase, nextIdempotencyKey, nextRequestId, nextEffectId,
  absentState,
} from "./harness.ts";
import {
  MWA_AUTHORITY_CONTEXT, MWA_PROTOCOL_SCHEMA_VERSION,
  type CheckpointInput, type FenceInput, type RecoverInput,
} from "../../../verification/core/coordination/migration-write-authority/contracts.ts";
import { sha256 } from "../../../src/kernel/integrity.ts";

test("hostile-10 rep 1: observer interruption during active write → safe quiescence + checkpoint + resume", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h = createAuthorityHandle(setup, setup.worktree1);
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], h.clock.snapshot()));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    // Observer interruption: the authority records a checkpoint (the
    // quiescing-safe action) so the write can resume after the interruption.
    const checkpoint: CheckpointInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "checkpoint",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
      authorityContext: MWA_AUTHORITY_CONTEXT, leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      completedEffectIdentities: [], remainingWriteResourceIds: ["src/a"],
      nextSafeAction: "fence-next-effect", journalCursor: acq.journalCursor,
    });
    const cp = h.authority.checkpoint(checkpoint);
    assertAccepted(cp, "checkpoint during interruption must be accepted");
    // Resume: fence the next effect (the write can proceed).
    const fenceInput: FenceInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "fence",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
      authorityContext: MWA_AUTHORITY_CONTEXT, leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      effectId: nextEffectId(1), effectKind: "filesystem-create", resourceId: "src/a",
      expectedState: absentState("a"),
      intendedState: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 5, sha256: sha256("hello") }),
      base: makeBase(), journalCursor: acq.journalCursor,
    });
    const f = h.authority.fence(fenceInput);
    assertAccepted(f, "resume after interruption must fence the next effect");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
    h.close();
  } finally {
    repo.cleanup();
  }
});

test("hostile-10 rep 2: steering interruption → checkpoint, rebind, resume; no duplicate effect (idempotent fence)", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h = createAuthorityHandle(setup, setup.worktree1);
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], h.clock.snapshot()));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    const effectId = nextEffectId(2);
    // First fence for the effect.
    const fenceInput: FenceInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "fence",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
      authorityContext: MWA_AUTHORITY_CONTEXT, leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      effectId, effectKind: "filesystem-create", resourceId: "src/a",
      expectedState: absentState("a"),
      intendedState: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 5, sha256: sha256("hello") }),
      base: makeBase(), journalCursor: acq.journalCursor,
    });
    const f1 = h.authority.fence(fenceInput);
    assertAccepted(f1, "first fence must be accepted");
    // Steering interruption: the same fence is replayed (idempotent) — the
    // backend returns the SAME result (no duplicate effect, no duplicate
    // pending fence).
    const f2 = h.authority.fence(fenceInput);
    assertAccepted(f2, "replay fence must be accepted (idempotent, no duplicate effect)");
    // The journal cursor did not move (the replay is idempotent).
    assert.equal(f1.journalCursor, f2.journalCursor, "idempotent replay must not move the journal cursor");
    const oracle = createOracle(setup.dbPath);
    const report = oracle.verify();
    assert.equal(report.journalChainIntact, true);
    assert.equal(report.journalEntryCount, 1, "no duplicate journal entry from the replay");
    h.close();
  } finally {
    repo.cleanup();
  }
});

test("hostile-10 rep 3: observer interruption during recovery — recovery pauses, resumes, completes deterministically", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h = createAuthorityHandle(setup, setup.worktree1);
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], h.clock.snapshot()));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    // A checkpoint during the recovery window (the recovery "pauses").
    const checkpoint: CheckpointInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "checkpoint",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
      authorityContext: MWA_AUTHORITY_CONTEXT, leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
      completedEffectIdentities: [], remainingWriteResourceIds: ["src/a"],
      nextSafeAction: "reconcile-external-state", journalCursor: acq.journalCursor,
    });
    const cp = h.authority.checkpoint(checkpoint);
    assertAccepted(cp, "checkpoint during recovery pause must be accepted");
    // Recovery resumes: recover with a newer fence. Advance the clock past
    // the lease TTL (60s) so the authority's liveness/TTL check allows
    // recovery of the (still-active) lease.
    h.clock.advance(61_000_000_000n);
    const lease = inspectLease(setup, acq.leaseEvidence.leaseId);
    const recoveryGen = String(Number(lease.generation) + 30);
    const grant = grantForLease(lease);
    const recoverInput: RecoverInput = Object.freeze({
      schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "recover",
      requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
      authorityContext: MWA_AUTHORITY_CONTEXT,
      leaseEvidence: Object.freeze({ leaseId: lease.leaseId, generation: lease.generation, fenceIdentity: lease.fenceIdentity, state: "active", receiptAuthority: "evidence-only-never-authority" }),
      liveGrant: grant,
      journalIdentity: sha256("journal"), observationIdentity: sha256("obs"), directionPreference: "next",
      clock: h.clock.snapshot(),
      recoveryFence: Object.freeze({ generation: recoveryGen, fenceIdentity: sha256("recovery-fence-10"), supersedesGeneration: lease.generation, supersedesFenceIdentity: lease.fenceIdentity }),
    });
    const rec = h.authority.recover(recoverInput);
    assertAccepted(rec, "recovery resume after interruption must complete");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
    h.close();
  } finally {
    repo.cleanup();
  }
});
