import assert from "node:assert/strict";
import test from "node:test";

import { InputError } from "../../src/kernel/errors.ts";
import { FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS } from "../../src/forensics/forensic-structural.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { snapshotJsonValue, snapshotPlainArray } from "../../src/kernel/safe-structural.ts";

test("forensic-structural: limits are owned by ROOT_POLICY.forensics.limits", () => {
  assert.equal(
    FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS.maximumDepth,
    ROOT_POLICY.forensics.limits.maximumDepth,
  );
  assert.equal(
    FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS.maximumNodes,
    ROOT_POLICY.forensics.limits.maximumNodes,
  );
});

test("forensic-structural: limits object is deeply frozen", () => {
  assert.equal(Object.isFrozen(FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS), true);
  assert.throws(
    () => {
      (FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS as { maximumDepth: number }).maximumDepth = 1;
    },
    TypeError,
  );
});

test("forensic-structural: limits are positive safe integers within policy ceilings", () => {
  for (const value of [
    FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS.maximumDepth,
    FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS.maximumNodes,
  ]) {
    assert.equal(Number.isSafeInteger(value), true);
    assert.equal(value > 0, true);
  }
});

test("forensic-structural: snapshotJsonValue accepts input at the depth boundary", () => {
  let value: unknown = "leaf";
  for (let depth = 0; depth < FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS.maximumDepth; depth += 1) {
    value = [value];
  }
  const snapshot = snapshotJsonValue(value, FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "forensic_structural_test");
  assert.equal(Array.isArray(snapshot), true);
});

test("forensic-structural: snapshotJsonValue rejects input beyond the depth boundary with the caller code", () => {
  let value: unknown = "leaf";
  for (let depth = 0; depth <= FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS.maximumDepth; depth += 1) {
    value = [value];
  }
  assert.throws(
    () => snapshotJsonValue(value, FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "forensic_structural_test_depth"),
    (error: unknown) => error instanceof InputError && (error as InputError).code === "forensic_structural_test_depth",
  );
});

test("forensic-structural: snapshotPlainArray rejects input beyond the node boundary", () => {
  const beyond = Array.from({ length: FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS.maximumNodes + 1 }, () => 0);
  assert.throws(
    () => snapshotPlainArray(beyond, FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "forensic_structural_test_nodes"),
    (error: unknown) => error instanceof InputError && (error as InputError).code === "forensic_structural_test_nodes",
  );
});
