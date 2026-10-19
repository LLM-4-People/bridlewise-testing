import assert from "node:assert/strict";
import test from "node:test";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { EXECUTION_OUTCOMES } from "../../src/kernel/execution-closure.ts";
import { TIMELINE_OUTCOMES } from "../../src/timeline/timeline-types.ts";

/**
 * Outcomes vocabulary consistency (SSOT-8, GAP-20).
 *
 * The terminal-outcome vocabulary is declared in three places that must
 * agree as a set:
 * - root-policy `forensics.outcomes`
 * - execution-closure `EXECUTION_OUTCOMES`
 * - timeline-types `TIMELINE_OUTCOMES`
 *
 * Order may differ between the authorities, but the set of values must
 * match exactly. A drift here means a terminal recorded by one layer would
 * be rejected or misclassified by another. This test compares the three as
 * sets so any addition or removal must be applied to all three at once.
 */

function asSet(values: readonly string[]): Set<string> {
  return new Set(values);
}

test("Outcomes consistency: root-policy forensics.outcomes === EXECUTION_OUTCOMES as a set", () => {
  assert.deepEqual(
    [...asSet(ROOT_POLICY.forensics.outcomes)].sort(),
    [...asSet(EXECUTION_OUTCOMES)].sort(),
  );
});

test("Outcomes consistency: root-policy forensics.outcomes === TIMELINE_OUTCOMES as a set", () => {
  assert.deepEqual(
    [...asSet(ROOT_POLICY.forensics.outcomes)].sort(),
    [...asSet(TIMELINE_OUTCOMES)].sort(),
  );
});

test("Outcomes consistency: EXECUTION_OUTCOMES === TIMELINE_OUTCOMES as a set", () => {
  assert.deepEqual(
    [...asSet(EXECUTION_OUTCOMES)].sort(),
    [...asSet(TIMELINE_OUTCOMES)].sort(),
  );
});

test("Outcomes consistency: all three authorities contain pending/succeeded/failed/cancelled/denied", () => {
  const expected = ["pending", "succeeded", "failed", "cancelled", "denied"];
  for (const authority of [
    ROOT_POLICY.forensics.outcomes,
    EXECUTION_OUTCOMES,
    TIMELINE_OUTCOMES,
  ]) {
    const set = asSet(authority);
    for (const outcome of expected) {
      assert.ok(set.has(outcome), `outcome '${outcome}' missing from an authority`);
    }
  }
});
