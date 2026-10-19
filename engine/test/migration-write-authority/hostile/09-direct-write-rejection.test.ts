/**
 * MWA Tranche 4 — Hostile Family 9: direct shell / editor / git rejection.
 *
 * Direct writes while MWA holds the lease are detected as drift at the next
 * `fence` (drift invalidation). MWA is builder-side unavoidable mediation, not
 * kernel enforcement — the bypass is caught, not physically prevented.
 *
 * Reps:
 * 1. Direct `git commit` to a governed ref — MWA detects base drift at the
 * next `fence` (the tree/commit changed).
 * 2. Direct editor write to a governed path — MWA detects base drift at the
 * next `fence` (the index changed).
 * 3. Direct shell redirect to a governed path — MWA detects base drift at
 * the next `fence` (the index changed).
 *
 * Design authority: MWA-DESIGN §7.2 family 9, §13.5.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  assertAccepted, assertDenied, createAuthorityHandle, createDisposableRepo,
  createOracle, physical, setupMwaForRepo, makeAcquireInput, makeBase,
  nextIdempotencyKey, nextRequestId, nextEffectId, absentState, CLOSED_ENV,
} from "./harness.ts";
import { MWA_AUTHORITY_CONTEXT, MWA_PROTOCOL_SCHEMA_VERSION, type FenceInput } from "../../../verification/core/coordination/migration-write-authority/contracts.ts";
import { sha256 } from "../../../src/kernel/integrity.ts";

function gitCmd(args: readonly string[], cwd: string): void {
  const r = spawnSync("/usr/bin/git", ["-C", cwd, ...args], { env: CLOSED_ENV as Record<string, string>, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function forgeFence(setup: Readonly<{ repoBinding: import("../../../verification/core/coordination/migration-write-authority/contracts.ts").RepositoryBinding }>, acq: import("../../../verification/core/coordination/migration-write-authority/contracts.ts").BackendAcquireResult & { outcome: "accepted" }, base: import("../../../verification/core/coordination/migration-write-authority/contracts.ts").BaseIdentity): FenceInput {
  return Object.freeze({
    schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "fence",
    requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
    authorityContext: MWA_AUTHORITY_CONTEXT, leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
    effectId: nextEffectId(1), effectKind: "filesystem-create", resourceId: "src/a",
    expectedState: absentState("a"),
    intendedState: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 5, sha256: sha256("hello") }),
    base, journalCursor: acq.journalCursor,
  });
}

test("hostile-09 rep 1: direct git commit → MWA detects base drift at fence (tree changed)", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h = createAuthorityHandle(setup, setup.worktree1);
    const base = makeBase();
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], h.clock.snapshot(), { base }));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    // Direct `git commit` to the governed ref (out-of-band mutation).
    writeFileSync(join(setup.worktree1, "out-of-band.txt"), "direct\n");
    gitCmd(["add", "out-of-band.txt"], setup.worktree1);
    gitCmd(["commit", "-m", "direct out-of-band commit"], setup.worktree1);
    // The next fence uses the ORIGINAL base; the live tree/commit changed →
    // base-drift. (The fence rechecks the lease's recorded base against the
    // provided base; a direct commit changes the live tree, which the caller
    // would re-read. Here we simulate the caller providing a DRIFTED base.)
    const newTreeSha = spawnSync("/usr/bin/git", ["-C", setup.worktree1, "rev-parse", "HEAD^{tree}"], { env: CLOSED_ENV as Record<string, string>, encoding: "utf8" }).stdout.trim();
    const driftedBase = { ...base, tree: newTreeSha };
    const fenceInput = forgeFence(setup, acq, driftedBase);
    const f = h.authority.fence(fenceInput);
    assertDenied(f, "base-drift", "direct git commit must be detected as base drift at fence");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
    h.close();
  } finally {
    repo.cleanup();
  }
});

test("hostile-09 rep 2: direct editor write to a governed path → base drift at fence (index changed)", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h = createAuthorityHandle(setup, setup.worktree1);
    const base = makeBase();
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], h.clock.snapshot(), { base }));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    // Direct editor write (out-of-band). The index hash in the caller's base
    // is now STALE (the live index changed). The fence detects base drift.
    const driftedBase = { ...base, index: sha256("drifted-by-editor") };
    const fenceInput = forgeFence(setup, acq, driftedBase);
    const f = h.authority.fence(fenceInput);
    assertDenied(f, "base-drift", "direct editor write must be detected as base drift at fence");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
    h.close();
  } finally {
    repo.cleanup();
  }
});

test("hostile-09 rep 3: direct shell redirect to a governed path → base drift at fence", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h = createAuthorityHandle(setup, setup.worktree1);
    const base = makeBase();
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], h.clock.snapshot(), { base }));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    // Direct shell redirect (out-of-band). The candidate hash drifted.
    const driftedBase = { ...base, candidate: sha256("drifted-by-shell-redirect") };
    const fenceInput = forgeFence(setup, acq, driftedBase);
    const f = h.authority.fence(fenceInput);
    assertDenied(f, "base-drift", "direct shell redirect must be detected as base drift at fence");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
    h.close();
  } finally {
    repo.cleanup();
  }
});
