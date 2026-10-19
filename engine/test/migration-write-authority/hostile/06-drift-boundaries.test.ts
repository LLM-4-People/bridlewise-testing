/**
 * MWA Tranche 4 — Hostile Family 6: drift before each boundary.
 *
 * Drift injected before each boundary must fail closed with the typed drift
 * error. MWA is builder-side mediation: out-of-band mutation is detected at
 * the next `fence` (drift invalidation), not prevented by a lock.
 *
 * Reps:
 * 1. Base drift before fence — `base-drift` (the fence rechecks the recorded
 * base; a changed base fails).
 * 2. Index/tree drift before fence — `base-drift` (a changed base identity).
 * 3. Config/policy drift before commit — `base-drift` (the base's config/
 * policy hash changed; the fence rechecks the recorded base).
 *
 * Design authority: MWA-DESIGN §7.2 family 6.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAccepted, assertDenied, createAuthorityHandle, createDisposableRepo,
  createOracle, physical, setupMwaForRepo, makeAcquireInput, makeBase,
  nextIdempotencyKey, nextRequestId, nextEffectId, absentState,
} from "./harness.ts";
import { MWA_AUTHORITY_CONTEXT, MWA_PROTOCOL_SCHEMA_VERSION, type FenceInput } from "../../../verification/core/coordination/migration-write-authority/contracts.ts";
import { sha256 } from "../../../src/kernel/integrity.ts";

function forgeFence(setup: Readonly<{ repoBinding: import("../../../verification/core/coordination/migration-write-authority/contracts.ts").RepositoryBinding }>, acq: import("../../../verification/core/coordination/migration-write-authority/contracts.ts").BackendAcquireResult & { outcome: "accepted" }, baseOverrides: Partial<import("../../../verification/core/coordination/migration-write-authority/contracts.ts").BaseIdentity>): FenceInput {
  return Object.freeze({
    schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "fence",
    requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
    authorityContext: MWA_AUTHORITY_CONTEXT, leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
    effectId: nextEffectId(1), effectKind: "filesystem-create", resourceId: "src/a",
    expectedState: absentState("a"),
    intendedState: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 5, sha256: sha256("hello") }),
    base: { ...makeBase(), ...baseOverrides }, journalCursor: acq.journalCursor,
  });
}

test("hostile-06 rep 1: base drift before fence — base-drift (index changed)", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h = createAuthorityHandle(setup, setup.worktree1);
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], h.clock.snapshot()));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    // Drift: the index hash changed between acquire and fence.
    const fenceInput = forgeFence(setup, acq, { index: sha256("drifted-index") });
    const f = h.authority.fence(fenceInput);
    assertDenied(f, "base-drift", "drifted index must be detected at fence");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
    h.close();
  } finally {
    repo.cleanup();
  }
});

test("hostile-06 rep 2: tree drift before fence — base-drift (tree changed)", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h = createAuthorityHandle(setup, setup.worktree1);
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], h.clock.snapshot()));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    // Drift: the tree identity changed.
    const fenceInput = forgeFence(setup, acq, { tree: "1".repeat(40) });
    const f = h.authority.fence(fenceInput);
    assertDenied(f, "base-drift", "drifted tree must be detected at fence");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
    h.close();
  } finally {
    repo.cleanup();
  }
});

test("hostile-06 rep 3: config/policy drift before fence — base-drift (config changed)", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h = createAuthorityHandle(setup, setup.worktree1);
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], h.clock.snapshot()));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    // Drift: the configuration hash changed.
    const fenceInput = forgeFence(setup, acq, { configuration: sha256("drifted-config") });
    const f = h.authority.fence(fenceInput);
    assertDenied(f, "base-drift", "drifted configuration must be detected at fence");
    // Policy drift mutant.
    const fenceInput2 = forgeFence(setup, acq, { policy: sha256("drifted-policy") });
    const f2 = h.authority.fence(fenceInput2);
    assertDenied(f2, "base-drift", "drifted policy must be detected at fence");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
    h.close();
  } finally {
    repo.cleanup();
  }
});
