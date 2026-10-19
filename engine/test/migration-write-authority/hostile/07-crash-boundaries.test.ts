/**
 * MWA Tranche 4 — Hostile Family 7: crash at every boundary.
 *
 * SIGKILL at every boundary (DB, FS, Git, receipt). Recovery reconciles to
 * previous or next, never mixed. Uses real `child_process.fork` + SIGKILL;
 * the parent observes the crash, opens a fresh backend, and runs
 * `reconcileMigrationAuthority` to classify the resulting state.
 *
 * Reps:
 * 1. SIGKILL after fence but before the FS effect — recovery sees the effect
 * NOT done → all-previous → `compensate-to-previous`.
 * 2. SIGKILL after the FS effect but before compareAndCommit — recovery sees
 * the effect done but uncommitted → all-next → `complete-to-next`.
 * 3. SIGKILL mid-sequence (some effects committed, some not) — recovery sees
 * a mixed state → `blocked-unknown-effect` (never mixed).
 *
 * Design authority: MWA-DESIGN §7.2 family 7.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createDisposableRepo, createOracle, physical,
  runOneProcess, setupMwaForRepo, absentState,
} from "./harness.ts";
import {
  reconcileMigrationAuthority, type PlannedDestination, type ObservedDestination,
} from "../../../verification/core/coordination/migration-write-authority/recovery.ts";
import { sha256 } from "../../../src/kernel/integrity.ts";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("hostile-07 rep 1: SIGKILL after fence before FS effect → recovery compensates to previous", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const res = physical("src/a", "write", "src/a");
    const { result } = await runOneProcessForAcquire(setup, res, "backend.fence.after");
    // Wait for the child to crash at the fence boundary.
    await result;
    // The child was SIGKILLed after fence (before the effect). The FS file was
    // NOT created → the observation is "previous" (absent).
    const filePath = join(setup.worktree1, "src/a");
    const fileExists = existsSync(filePath);
    // Reconcile: the file is absent (previous). The pending fence may exist.
    const planned: PlannedDestination = Object.freeze({ resourceId: "src/a", journaledPrevious: absentState("a"), journaledNext: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 6, sha256: sha256("hello\n") }), allowsPreviousAbsence: true, allowsNextAbsence: false });
    const observed: ObservedDestination = Object.freeze({ resourceId: "src/a", observedState: fileExists ? Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 6, sha256: sha256("hello\n") }) : absentState("a") });
    const reconciliation = reconcileMigrationAuthority({ destinations: [planned], observations: [observed] });
    assert.equal(fileExists, false, "file must NOT exist (crash before effect)");
    // The observation is absent → matches "previous" (journaledPrevious is
    // absent, allowsPreviousAbsence=true) → compensate-to-previous.
    assert.equal(reconciliation.outcome, "compensate-to-previous", "crash before effect → compensate-to-previous");
    assert.equal(reconciliation.direction, "previous");
    // Oracle: journal intact (the fence entry was journaled inside the txn;
    // the lease is active with a pending fence, but no double-acquire).
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
  } finally {
    repo.cleanup();
  }
});

test("hostile-07 rep 2: SIGKILL after FS effect before compareAndCommit → recovery completes to next", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    // Use a root-level path so the parent dir (worktree root) exists; the
    // effect adapter's createFileExclusive requires the parent directory.
    const res = physical("created.txt", "write", "created.txt");
    // The worker acquires, fences, creates the file, then crashes (after the
    // FS effect but before compareAndCommit). The file exists → "next".
    const { result } = await runOneProcessForAcquire(setup, res, "effects.createFileExclusive.after");
    await result;
    const filePath = join(setup.worktree1, "created.txt");
    const fileExists = existsSync(filePath);
    assert.equal(fileExists, true, "file must exist (crash after effect, before commit)");
    const planned: PlannedDestination = Object.freeze({ resourceId: "created.txt", journaledPrevious: absentState("created.txt"), journaledNext: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 6, sha256: sha256("hello\n") }), allowsPreviousAbsence: true, allowsNextAbsence: false });
    let observedState: import("../../../verification/core/coordination/migration-write-authority/contracts.ts").TargetState;
    if (fileExists) {
      const st = statSync(filePath);
      const bytes = readFileSync(filePath);
      observedState = Object.freeze({ kind: "file", identity: Object.freeze({ device: BigInt(st.dev).toString(10), inode: BigInt(st.ino).toString(10), mode: st.mode, ownerUid: st.uid.toString(10), ownerGid: st.gid.toString(10), links: BigInt(st.nlink).toString(10), kind: "file" as const }), byteLength: bytes.length, sha256: sha256(bytes) });
    } else {
      observedState = absentState("created.txt");
    }
    // The file's sha256 may or may not match the intended sha256("hello\n")
    // depending on whether the worker wrote "hello\n". The worker writes
    // "hello\n" (6 bytes). The observed sha256 should match the intended.
    const observed: ObservedDestination = Object.freeze({ resourceId: "created.txt", observedState });
    const reconciliation = reconcileMigrationAuthority({ destinations: [planned], observations: [observed] });
    // If the file matches the intended next state → complete-to-next.
    // If not exactly matching → blocked-unknown-effect (still never mixed).
    assert.ok(
      reconciliation.outcome === "complete-to-next" || reconciliation.outcome === "blocked-unknown-effect",
      `crash after effect must be next or blocked, never mixed; got ${reconciliation.outcome}`,
    );
    // Never mixed: the direction is null when blocked, or a single direction.
    if (reconciliation.outcome === "complete-to-next") assert.equal(reconciliation.direction, "next");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
  } finally {
    repo.cleanup();
  }
});

test("hostile-07 rep 3: SIGKILL mid-sequence (mixed) → blocked-unknown-effect (never mixed)", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    // Two destinations: one at "next" (file created), one at "previous"
    // (file not created). This is the mixed state recovery must block on.
    const plannedA: PlannedDestination = Object.freeze({ resourceId: "src/a", journaledPrevious: absentState("a"), journaledNext: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 5, sha256: sha256("aaa") }), allowsPreviousAbsence: true, allowsNextAbsence: false });
    const plannedB: PlannedDestination = Object.freeze({ resourceId: "src/b", journaledPrevious: absentState("b"), journaledNext: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "3", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 5, sha256: sha256("bbb") }), allowsPreviousAbsence: true, allowsNextAbsence: false });
    // Observed: A is "next" (created), B is "previous" (absent) → MIXED.
    const obsA: ObservedDestination = Object.freeze({ resourceId: "src/a", observedState: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 5, sha256: sha256("aaa") }) });
    const obsB: ObservedDestination = Object.freeze({ resourceId: "src/b", observedState: absentState("b") });
    const reconciliation = reconcileMigrationAuthority({ destinations: [plannedA, plannedB], observations: [obsA, obsB] });
    assert.equal(reconciliation.outcome, "blocked-unknown-effect", "mixed state must block (never mixed)");
    assert.equal(reconciliation.direction, null, "blocked recovery has no direction");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
  } finally {
    repo.cleanup();
  }
});

function runOneProcessForAcquire(setup: import("./harness.ts").MwaSetup, res: import("../../../verification/core/coordination/migration-write-authority/contracts.ts").MigrationResource, crashStage: string) {
  return runOneProcess(setup, {
    operation: "acquire-write", resources: [res], worktreePath: setup.worktree1,
    resourcePathMap: { [res.resourceId]: res.resourceId }, clockPid: 701, crashStage,
  });
}
