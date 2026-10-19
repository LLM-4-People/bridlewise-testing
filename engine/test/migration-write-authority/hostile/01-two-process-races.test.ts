/**
 * MWA Tranche 4 — Hostile Family 1: two-process / two-worktree races.
 *
 * Two real child processes (forked with the tsx loader) contend on the shared
 * backend DB (same git common directory → same MWA authority). SQLite's
 * `BEGIN IMMEDIATE` + `busy_timeout` serializes the writers; the unique index
 * + cross-lease `migrationResourcesConflict` enforce the conflict. Exactly
 * one writer wins per conflicting resource; disjoint writers coexist.
 *
 * Reps:
 * 1. Equal path write conflict — both write the same file. One accepted, one
 * denied with `resource-conflict`.
 * 2. Ancestor/descendant path conflict — one writes `a/b`, other writes
 * `a/b/c`. Denied with `resource-conflict` (cross-lease natural-key
 * detection).
 * 3. Disjoint paths — both write different files. Both accepted (useful
 * concurrency). Oracle verifies disjoint concurrency.
 *
 * Design authority: MWA-DESIGN §7.2 family 1.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAccepted, assertDenied, createDisposableRepo, createOracle, physical, runTwoProcess, setupMwaForRepo,
} from "./harness.ts";

function childMessage(result: Readonly<{ ok?: boolean; result?: unknown; error?: string }>): unknown {
  assert.equal(result.ok, true, `child error: ${result.error ?? "no message"}`);
  return result.result;
}

test("hostile-01 rep 1: equal path write conflict — one wins, one denied with resource-conflict", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const resource = physical("src/a", "write", "src/a");
    const [r1, r2] = await runTwoProcess(setup,
      { operation: "acquire", resources: [resource], worktreePath: setup.worktree1, resourcePathMap: { "src/a": "src/a" }, clockPid: 101 },
      { operation: "acquire", resources: [resource], worktreePath: setup.worktree2, resourcePathMap: { "src/a": "src/a" }, clockPid: 102 },
    );
    const a1 = childMessage(r1.message as Readonly<{ ok?: boolean; result?: unknown; error?: string }>) as Readonly<{ outcome: string }>;
    const a2 = childMessage(r2.message as Readonly<{ ok?: boolean; result?: unknown; error?: string }>) as Readonly<{ outcome: string }>;
    // Exactly one accepted, one denied with resource-conflict.
    const outcomes = [a1.outcome, a2.outcome].sort();
    assert.deepEqual(outcomes, ["accepted", "denied"], "exactly one accepted, one denied");
    const deniedOne = a1.outcome === "denied" ? a1 : a2;
    assertDenied(deniedOne as Readonly<{ outcome: string }>, "resource-conflict", "denied child must be resource-conflict");
    // Oracle: no double-acquire, chain intact.
    const oracle = createOracle(setup.dbPath);
    const report = oracle.verify();
    assert.equal(report.noDoubleAcquire, true, "no double-acquire of the same resource");
    assert.equal(report.journalChainIntact, true, "journal chain intact");
    assert.equal(report.journalAppendOnly, true, "journal append-only");
  } finally {
    repo.cleanup();
  }
});

test("hostile-01 rep 2: ancestor/descendant path conflict — a/b vs a/b/c denied with resource-conflict", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const resParent = physical("a/b", "write", "a/b");
    const resChild = physical("a/b/c", "write", "a/b/c");
    const [r1, r2] = await runTwoProcess(setup,
      { operation: "acquire", resources: [resParent], worktreePath: setup.worktree1, resourcePathMap: { "a/b": "a/b" }, clockPid: 201 },
      { operation: "acquire", resources: [resChild], worktreePath: setup.worktree2, resourcePathMap: { "a/b/c": "a/b/c" }, clockPid: 202 },
    );
    const a1 = childMessage(r1.message as Readonly<{ ok?: boolean; result?: unknown; error?: string }>) as Readonly<{ outcome: string }>;
    const a2 = childMessage(r2.message as Readonly<{ ok?: boolean; result?: unknown; error?: string }>) as Readonly<{ outcome: string }>;
    // Ancestor/descendant must conflict: exactly one accepted, one denied.
    const outcomes = [a1.outcome, a2.outcome].sort();
    assert.deepEqual(outcomes, ["accepted", "denied"], "ancestor/descendant must conflict cross-lease");
    const deniedOne = a1.outcome === "denied" ? a1 : a2;
    assertDenied(deniedOne as Readonly<{ outcome: string }>, "resource-conflict", "denied child must be resource-conflict");
    const oracle = createOracle(setup.dbPath);
    const report = oracle.verify();
    assert.equal(report.noDoubleAcquire, true, "no double-acquire");
    assert.equal(report.journalChainIntact, true, "journal chain intact");
  } finally {
    repo.cleanup();
  }
});

test("hostile-01 rep 3: disjoint paths — both accepted (useful concurrency); oracle verifies disjoint", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const resA = physical("src/a", "write", "src/a");
    const resB = physical("src/b", "write", "src/b");
    const [r1, r2] = await runTwoProcess(setup,
      { operation: "acquire", resources: [resA], worktreePath: setup.worktree1, resourcePathMap: { "src/a": "src/a" }, clockPid: 301 },
      { operation: "acquire", resources: [resB], worktreePath: setup.worktree2, resourcePathMap: { "src/b": "src/b" }, clockPid: 302 },
    );
    const a1 = childMessage(r1.message as Readonly<{ ok?: boolean; result?: unknown; error?: string }>) as Readonly<{ outcome: string }>;
    const a2 = childMessage(r2.message as Readonly<{ ok?: boolean; result?: unknown; error?: string }>) as Readonly<{ outcome: string }>;
    assertAccepted(a1, "disjoint writer 1 must be accepted");
    assertAccepted(a2, "disjoint writer 2 must be accepted");
    const oracle = createOracle(setup.dbPath);
    const report = oracle.verify();
    assert.equal(report.noDoubleAcquire, true, "no double-acquire");
    assert.equal(report.usefulDisjointConcurrency, true, "oracle must observe useful disjoint concurrency");
    assert.equal(report.journalChainIntact, true, "journal chain intact");
    assert.equal(report.journalAppendOnly, true, "journal append-only");
  } finally {
    repo.cleanup();
  }
});
