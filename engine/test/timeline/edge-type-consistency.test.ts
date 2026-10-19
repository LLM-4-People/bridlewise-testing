import assert from "node:assert/strict";
import test from "node:test";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { TIMELINE_EDGE_TYPES } from "../../src/timeline/timeline-types.ts";

/**
 * Edge type vocabulary consistency (SSOT-9, GAP-19).
 *
 * The evidence-graph edge vocabulary is declared once in the root policy
 * (`evidenceGraphArchitecture.edgeTypes`) and projected into the timeline
 * implementation (`TIMELINE_EDGE_TYPES`). These must be identical: same
 * values, same order. A drift here (e.g. "causal" in one place and "caused"
 * in another) silently splits the edge vocabulary and breaks graph
 * queries that join on edge type. This test imports both authorities and
 * asserts exact equality so any future drift fails the build.
 */

test("Edge type consistency: root-policy edgeTypes and TIMELINE_EDGE_TYPES are identical", () => {
  const fromRootPolicy = ROOT_POLICY.evidenceGraphArchitecture.edgeTypes;
  assert.deepEqual([...fromRootPolicy], [...TIMELINE_EDGE_TYPES]);
});

test("Edge type consistency: edge vocabulary has exactly 8 types", () => {
  assert.equal(TIMELINE_EDGE_TYPES.length, 8);
  assert.equal(ROOT_POLICY.evidenceGraphArchitecture.edgeTypes.length, 8);
});

test("Edge type consistency: vocabulary contains 'causal' (not 'caused')", () => {
  assert.ok((TIMELINE_EDGE_TYPES as readonly string[]).includes("causal"));
  assert.ok((ROOT_POLICY.evidenceGraphArchitecture.edgeTypes as readonly string[]).includes("causal"));
  assert.ok(
    !(TIMELINE_EDGE_TYPES as readonly string[]).includes("caused"),
    "'caused' must not appear in the edge vocabulary (it diverges from 'causal')",
  );
});

test("Edge type consistency: order is stable across both authorities", () => {
  const rp = ROOT_POLICY.evidenceGraphArchitecture.edgeTypes;
  for (let i = 0; i < rp.length; i += 1) {
    assert.equal(rp[i], TIMELINE_EDGE_TYPES[i], `edge type at index ${i} differs`);
  }
});
