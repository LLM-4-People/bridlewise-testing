/**
 * MWA Tranche 4 — Hostile Family 8: partial / unknown effects.
 *
 * All partial or ambiguous effects remain `blocked-unknown-effect` until exact
 * reconciliation. Recovery never guesses, deletes evidence, or infers success
 * from absence.
 *
 * Reps:
 * 1. Partial git command (killed mid-update-ref) — the recovery's
 * `reconcileMigrationAuthority` classifies the ambiguous observation as
 * `blocked-unknown-effect`.
 * 2. Unknown filesystem effect (a file that matches neither the journaled
 * previous nor the journaled next) — `blocked-unknown-effect`.
 * 3. Ambiguous close (a destination whose observation is missing) —
 * `blocked-unknown-effect` (never infer from absence).
 *
 * Design authority: MWA-DESIGN §7.2 family 8, §4.8.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createDisposableRepo, createOracle, setupMwaForRepo, absentState,
} from "./harness.ts";
import {
  reconcileMigrationAuthority, type PlannedDestination, type ObservedDestination,
} from "../../../verification/core/coordination/migration-write-authority/recovery.ts";
import { sha256 } from "../../../src/kernel/integrity.ts";

test("hostile-08 rep 1: partial git command (killed mid-update-ref) → blocked-unknown-effect", () => {
  // A partial git update-ref leaves the ref in an unknown state (neither the
  // journaled previous nor next). The recovery must block.
  const planned: PlannedDestination = Object.freeze({
    resourceId: "ref.heads.x", journaledPrevious: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "1", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 40, sha256: sha256("prev-ref") }),
    journaledNext: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 40, sha256: sha256("next-ref") }),
    allowsPreviousAbsence: false, allowsNextAbsence: false,
  });
  // Unknown: a THIRD value (partial command left the ref at an unexpected oid).
  const observed: ObservedDestination = Object.freeze({
    resourceId: "ref.heads.x",
    observedState: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "3", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 40, sha256: sha256("unknown-partial-ref") }),
  });
  const reconciliation = reconcileMigrationAuthority({ destinations: [planned], observations: [observed] });
  assert.equal(reconciliation.outcome, "blocked-unknown-effect", "partial git command must block");
  assert.equal(reconciliation.direction, null);
});

test("hostile-08 rep 2: unknown filesystem effect → blocked-unknown-effect", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    // The file was written with UNEXPECTED content (neither previous nor next).
    const planned: PlannedDestination = Object.freeze({
      resourceId: "src/a", journaledPrevious: absentState("a"),
      journaledNext: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 5, sha256: sha256("hello") }),
      allowsPreviousAbsence: true, allowsNextAbsence: false,
    });
    const observed: ObservedDestination = Object.freeze({
      resourceId: "src/a",
      observedState: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 8, sha256: sha256("corrupt!") }),
    });
    const reconciliation = reconcileMigrationAuthority({ destinations: [planned], observations: [observed] });
    assert.equal(reconciliation.outcome, "blocked-unknown-effect", "unknown FS effect must block");
    assert.equal(reconciliation.direction, null);
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
  } finally {
    repo.cleanup();
  }
});

test("hostile-08 rep 3: ambiguous close (missing observation) → blocked-unknown-effect (never infer from absence)", () => {
  // A planned destination with NO observation (the close was ambiguous — the
  // observation was lost). Recovery must NEVER infer from absence.
  const planned: PlannedDestination = Object.freeze({
    resourceId: "src/a", journaledPrevious: absentState("a"),
    journaledNext: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 5, sha256: sha256("hello") }),
    allowsPreviousAbsence: true, allowsNextAbsence: false,
  });
  // No observation for src/a — missing.
  const reconciliation = reconcileMigrationAuthority({ destinations: [planned], observations: [] });
  assert.equal(reconciliation.outcome, "blocked-unknown-effect", "missing observation must block (never infer from absence)");
  assert.equal(reconciliation.direction, null);
  // The classification for the missing destination is "unknown".
  assert.equal(reconciliation.classifications[0]!.classification, "unknown");
});
