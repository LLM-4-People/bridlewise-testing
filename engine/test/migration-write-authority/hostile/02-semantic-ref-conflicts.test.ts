/**
 * MWA Tranche 4 — Hostile Family 2: semantic / generated / ref conflicts.
 *
 * Physically disjoint worktrees but the same semantic owner / git-ref /
 * package-surface conflict through the shared backend. Includes substring-
 * matching mutants: resources that share a substring but are NOT the same
 * natural key must NOT conflict (reject substring matching per MWA-DESIGN
 * §4.7: "registered hierarchy/ownership edges, not substring").
 *
 * Reps:
 * 1. Same semantic-owner (module) — conflict through shared backend.
 * 2. Same git-ref (ref-family) — conflict.
 * 3. Same package-surface — conflict. Plus substring mutant: `owner.core`
 * vs `owner.core.extra` must NOT conflict (disjoint).
 *
 * Design authority: MWA-DESIGN §7.2 family 2.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAccepted, assertDenied, createAuthorityHandle, createDisposableRepo,
  createOracle, gitRef, packageSurface, semantic, setupMwaForRepo,
  makeAcquireInput,
} from "./harness.ts";
import { sha256 } from "../../../src/kernel/integrity.ts";

test("hostile-02 rep 1: same semantic-owner conflicts across leases (disjoint worktrees)", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h1 = createAuthorityHandle(setup, setup.worktree1);
    const h2 = createAuthorityHandle(setup, setup.worktree2);
    const owner = semantic("owner.core", "write", "owner.core");
    const r1 = await h1.authority.acquire(makeAcquireInput(setup.repoBinding, [owner], h1.clock.snapshot()));
    assertAccepted(r1, "first semantic-owner acquire must be accepted");
    // Second lease (different worktree, same shared backend) conflicts.
    const r2 = await h2.authority.acquire(makeAcquireInput(setup.repoBinding, [owner], h2.clock.snapshot(), {
      actor: { actorId: "agent-2", taskId: "t2", subtaskId: "s2", attemptId: "22222222-2222-4222-8222-222222222222", processIdentity: sha256("proc-2") },
    }));
    assertDenied(r2, "resource-conflict", "same semantic-owner across leases must conflict");
    const oracle = createOracle(setup.dbPath);
    const report = oracle.verify();
    assert.equal(report.noDoubleAcquire, true);
    assert.equal(report.journalChainIntact, true);
    h1.close(); h2.close();
  } finally {
    repo.cleanup();
  }
});

test("hostile-02 rep 2: same git-ref family conflicts across leases", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h1 = createAuthorityHandle(setup, setup.worktree1);
    const h2 = createAuthorityHandle(setup, setup.worktree2);
    const refA = gitRef("ref.a", "write", "refs/heads/x", "family-1");
    const refB = gitRef("ref.b", "write", "refs/heads/y", "family-1");
    const r1 = await h1.authority.acquire(makeAcquireInput(setup.repoBinding, [refA], h1.clock.snapshot()));
    assertAccepted(r1, "first git-ref acquire must be accepted");
    const r2 = await h2.authority.acquire(makeAcquireInput(setup.repoBinding, [refB], h2.clock.snapshot(), {
      actor: { actorId: "agent-2", taskId: "t2", subtaskId: "s2", attemptId: "33333333-3333-4333-8333-333333333333", processIdentity: sha256("proc-2") },
    }));
    assertDenied(r2, "resource-conflict", "same git-ref family across leases must conflict");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().noDoubleAcquire, true);
    h1.close(); h2.close();
  } finally {
    repo.cleanup();
  }
});

test("hostile-02 rep 3: same package-surface conflicts; substring mutant does NOT conflict", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h1 = createAuthorityHandle(setup, setup.worktree1);
    const h2 = createAuthorityHandle(setup, setup.worktree2);
    const surf1 = packageSurface("pkg.export.a", "write", "export", "surface-1");
    const surf2 = packageSurface("pkg.export.b", "write", "export", "surface-1");
    // Same surface kind + surface id → conflict.
    const r1 = await h1.authority.acquire(makeAcquireInput(setup.repoBinding, [surf1], h1.clock.snapshot()));
    assertAccepted(r1, "first package-surface acquire must be accepted");
    const r2 = await h2.authority.acquire(makeAcquireInput(setup.repoBinding, [surf2], h2.clock.snapshot(), {
      actor: { actorId: "agent-2", taskId: "t2", subtaskId: "s2", attemptId: "44444444-4444-4444-8444-444444444444", processIdentity: sha256("proc-2") },
    }));
    assertDenied(r2, "resource-conflict", "same package-surface across leases must conflict");
    // Substring mutant: `owner.core` vs `owner.core.extra` are DIFFERENT owners
    // (no registered ancestor edge) → must NOT conflict (disjoint). Both accepted.
    const ownerA = semantic("owner.core", "write", "owner.core");
    const ownerB = semantic("owner.core.extra", "write", "owner.core.extra");
    const h3 = createAuthorityHandle(setup, setup.worktree1);
    const h4 = createAuthorityHandle(setup, setup.worktree2);
    const r3 = await h3.authority.acquire(makeAcquireInput(setup.repoBinding, [ownerA], h3.clock.snapshot(), {
      actor: { actorId: "agent-3", taskId: "t3", subtaskId: "s3", attemptId: "55555555-5555-4555-8555-555555555555", processIdentity: sha256("proc-3") },
    }));
    assertAccepted(r3, "owner.core must be accepted");
    const r4 = await h4.authority.acquire(makeAcquireInput(setup.repoBinding, [ownerB], h4.clock.snapshot(), {
      actor: { actorId: "agent-4", taskId: "t4", subtaskId: "s4", attemptId: "66666666-6666-4666-8666-666666666666", processIdentity: sha256("proc-4") },
    }));
    assertAccepted(r4, "owner.core.extra (substring mutant) must NOT conflict with owner.core");
    const oracle = createOracle(setup.dbPath);
    const report = oracle.verify();
    assert.equal(report.noDoubleAcquire, true);
    assert.equal(report.usefulDisjointConcurrency, true, "substring-disjoint owners coexist");
    assert.equal(report.journalChainIntact, true);
    h1.close(); h2.close(); h3.close(); h4.close();
  } finally {
    repo.cleanup();
  }
});
