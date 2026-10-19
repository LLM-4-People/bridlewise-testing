/**
 * MWA Tranche 4 — Hostile Family 3: reader/writer parallelism.
 *
 * Reps:
 * 1. reader/reader — coexist (both acquire read, both succeed).
 * 2. reader/writer — writer blocks reader (reader denied with resource-conflict).
 * 3. disjoint writer/writer — coexist (different resources, both succeed).
 *
 * Oracle: no double-acquire, no torn reads (the unique index prevents two
 * writers; read/read coexist; read is blocked by an overlapping write).
 *
 * Design authority: MWA-DESIGN §7.2 family 3.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAccepted, assertDenied, createAuthorityHandle, createDisposableRepo,
  createOracle, physical, setupMwaForRepo, makeAcquireInput,
} from "./harness.ts";
import { sha256 } from "../../../src/kernel/integrity.ts";

test("hostile-03 rep 1: reader/reader coexist (both acquire read, both succeed)", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h1 = createAuthorityHandle(setup, setup.worktree1);
    const h2 = createAuthorityHandle(setup, setup.worktree2);
    const res = physical("src/a", "read", "src/a");
    const r1 = await h1.authority.acquire(makeAcquireInput(setup.repoBinding, [res], h1.clock.snapshot()));
    assertAccepted(r1, "first reader must be accepted");
    const r2 = await h2.authority.acquire(makeAcquireInput(setup.repoBinding, [res], h2.clock.snapshot(), {
      actor: { actorId: "agent-2", taskId: "t2", subtaskId: "s2", attemptId: "22222222-2222-4222-8222-222222222222", processIdentity: sha256("proc-2") },
    }));
    assertAccepted(r2, "second reader on the same resource must coexist");
    const oracle = createOracle(setup.dbPath);
    const report = oracle.verify();
    assert.equal(report.noDoubleAcquire, true, "read/read does not double-acquire");
    assert.equal(report.journalChainIntact, true);
    h1.close(); h2.close();
  } finally {
    repo.cleanup();
  }
});

test("hostile-03 rep 2: reader/writer — writer blocks reader (resource-conflict)", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h1 = createAuthorityHandle(setup, setup.worktree1);
    const h2 = createAuthorityHandle(setup, setup.worktree2);
    const writer = physical("src/a", "write", "src/a");
    const reader = physical("src/a", "read", "src/a");
    const r1 = await h1.authority.acquire(makeAcquireInput(setup.repoBinding, [writer], h1.clock.snapshot()));
    assertAccepted(r1, "writer must be accepted");
    const r2 = await h2.authority.acquire(makeAcquireInput(setup.repoBinding, [reader], h2.clock.snapshot(), {
      actor: { actorId: "agent-2", taskId: "t2", subtaskId: "s2", attemptId: "33333333-3333-4333-8333-333333333333", processIdentity: sha256("proc-2") },
    }));
    assertDenied(r2, "resource-conflict", "reader must be blocked by an overlapping write (no torn reads)");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().noDoubleAcquire, true);
    h1.close(); h2.close();
  } finally {
    repo.cleanup();
  }
});

test("hostile-03 rep 3: disjoint writer/writer coexist (different resources, both succeed)", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h1 = createAuthorityHandle(setup, setup.worktree1);
    const h2 = createAuthorityHandle(setup, setup.worktree2);
    const w1 = physical("src/a", "write", "src/a");
    const w2 = physical("src/b", "write", "src/b");
    const r1 = await h1.authority.acquire(makeAcquireInput(setup.repoBinding, [w1], h1.clock.snapshot()));
    assertAccepted(r1, "writer 1 must be accepted");
    const r2 = await h2.authority.acquire(makeAcquireInput(setup.repoBinding, [w2], h2.clock.snapshot(), {
      actor: { actorId: "agent-2", taskId: "t2", subtaskId: "s2", attemptId: "44444444-4444-4444-8444-444444444444", processIdentity: sha256("proc-2") },
    }));
    assertAccepted(r2, "disjoint writer 2 must coexist");
    const oracle = createOracle(setup.dbPath);
    const report = oracle.verify();
    assert.equal(report.noDoubleAcquire, true);
    assert.equal(report.usefulDisjointConcurrency, true, "disjoint writers coexist");
    assert.equal(report.journalChainIntact, true);
    h1.close(); h2.close();
  } finally {
    repo.cleanup();
  }
});
