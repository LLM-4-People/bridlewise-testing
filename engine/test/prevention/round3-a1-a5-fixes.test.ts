import assert from "node:assert/strict";
import test from "node:test";

import { detectDuplicateBodies } from "../../src/quality-packs/prevention/duplicate-body-detector.ts";

/**
 * D3 regression test — Round 3 fixes (A1 empty-recursive-helper + A5 type-aware O4).
 *
 * Round 3 A1 fix: when the recursive helper's body is empty (state update only in
 * the tail call's arguments — the documented Pass 2.5 limitation), extract the
 * tail call's arg assignments as the iteration body. The "loop-mechanic" params
 * (those in the base-case test) are dropped (they correspond to the for-loop's
 * update clause). The remaining changing params are emitted as synthetic
 * `param = arg` assignments (the iteration body).
 *
 * Round 3 A5 fix: type-aware commutative-operand reorder for `+` (only when both
 * operands are known numeric, avoiding string concat) + always-safe reorder for
 * `*`, `==`, `===`, `!=`, `!==`, `&`, `|`, `^`. This makes `i + 1` and `1 + i`
 * produce the same token stream → O4 caught at strict (was 0.90 relaxed-only).
 *
 * Assertions are labeled:
 * - fix-effect: must FAIL pre-fix (the fix is what makes it pass).
 * - no-new-FP: must pass pre-fix AND post-fix (the fix must not introduce a FP).
 *
 * Sources: arXiv 2606.25272 §III-D (O4 — "string concatenations are skipped");
 * type theory (the `+` overloading is a type-lattice problem); tail-call
 * elimination (research/round2-t4a-t4b/tail-call-eliminator-source.md, MIT).
 */

// A1 fixture: empty-recursive-helper (loop↔recursion). The recursive helper's body
// is exactly 2 statements (base case + tail call) — the "iteration body" is in the
// tail call args. Pre-fix: Pass 2.5 returns empty iteration body → not caught.
// Post-fix: A1 fix extracts the tail-call args as the iteration body → caught.
const a1Original = `
export function accumulateAll(values: readonly number[], weights: readonly number[]): { sum: number; weightedSum: number; product: number; count: number; sumSquares: number } {
  let sum = 0;
  let weightedSum = 0;
  let product = 1;
  let count = 0;
  let sumSquares = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const w = weights[i]!;
    sum += v;
    weightedSum += v * w;
    product *= v;
    count += 1;
    sumSquares += v * v;
  }
  return { sum, weightedSum, product, count, sumSquares };
}
`;
const a1Mutant = `
export function accumulateAll(values: readonly number[], weights: readonly number[]): { sum: number; weightedSum: number; product: number; count: number; sumSquares: number } {
  return accumulateStep(values, weights, 0, 0, 0, 1, 0, 0);
}
function accumulateStep(values: readonly number[], weights: readonly number[], i: number, sum: number, weightedSum: number, product: number, count: number, sumSquares: number): { sum: number; weightedSum: number; product: number; count: number; sumSquares: number } {
  if (i >= values.length) return { sum, weightedSum, product, count, sumSquares };
  return accumulateStep(values, weights, i + 1, sum + values[i]!, weightedSum + values[i]! * weights[i]!, product * values[i]!, count + 1, sumSquares + values[i]! * values[i]!);
}
`;

// A5 fixture: type-aware operand reorder. `i + 1` (original) vs `1 + i` (mutant)
// where `i` is a for-loop counter (known numeric) + `1` is a literal (known numeric).
// Pre-fix: `BinaryExpression ID NUM` vs `BinaryExpression NUM ID` → Jaccard < 1.0 → not caught at strict.
// Post-fix: both operands known numeric → reorder to sorted order → same token stream → caught at relaxed (via Pass 2.5).
const a5Original = `
export function collectIndices(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i < end; i++) {
    result.push(i + 1);
    if (i % 2 === 0) { result.push(i + 2); result.push(i + 4); }
    else { result.push(i + 3); result.push(i + 5); }
    result.push(i + 6);
  }
  return result;
}
`;
const a5Mutant = `
export function collectIndices(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i < end; i++) {
    result.push(1 + i);
    if (i % 2 === 0) { result.push(2 + i); result.push(4 + i); }
    else { result.push(3 + i); result.push(5 + i); }
    result.push(6 + i);
  }
  return result;
}
`;

// No-new-FP control: STRING concat operands. `prefix + s` (original) vs `s + prefix`
// (mutant) where `prefix` is a STRING literal (NOT known numeric). The operand-reorder
// must NOT reorder `+` when an operand is a string (string concat is not commutative:
// `"a" + "b" ≠ "b" + "a"`). Pre-fix: not caught (different token order). Post-fix:
// must STILL not be caught (the `+` is NOT reordered because `prefix` is a string).
// This is a no-new-FP guard: the fix must not introduce a FP on string concat.
const a5StringControlOriginal = `
export function buildLabels(prefix: string, values: readonly string[]): string[] {
  const labels: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    labels.push(prefix + v);
    if (i % 2 === 0) { labels.push(prefix + v + "x"); }
    else { labels.push(prefix + v + "y"); }
    labels.push(prefix + v + "z");
  }
  return labels;
}
`;
const a5StringControlMutant = `
export function buildLabels(prefix: string, values: readonly string[]): string[] {
  const labels: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    labels.push(v + prefix);
    if (i % 2 === 0) { labels.push("x" + v + prefix); }
    else { labels.push("y" + v + prefix); }
    labels.push("z" + v + prefix);
  }
  return labels;
}
`;

const RELAXED = { jaccardThreshold: 0.9, minTokenCount: 30, minBodySize: 80 };
const STRICT = { jaccardThreshold: 1.0, minTokenCount: 100, minBodySize: 80 };
const STRICT_MT30 = { jaccardThreshold: 1.0, minTokenCount: 30, minBodySize: 80 };

function verdict(findings: readonly { file: string; cluster: string }[], origPath: string, mutPath: string): boolean {
  const byCluster = new Map<string, { file: string; cluster: string }[]>();
  for (const f of findings) {
    if (!byCluster.has(f.cluster)) byCluster.set(f.cluster, []);
    byCluster.get(f.cluster)!.push(f);
  }
  for (const [, fs] of byCluster) {
    if (fs.some((f) => f.file === origPath) && fs.some((f) => f.file === mutPath)) return true;
  }
  return false;
}

test("A1 empty-recursive-helper: caught at production-relaxed (fix-effect — pre-fix misses)", () => {
  const sources = [
    { path: "a1-orig.ts", content: a1Original },
    { path: "a1-mut.ts", content: a1Mutant },
  ];
  const r = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...RELAXED });
  assert.equal(verdict(r.findings, "a1-orig.ts", "a1-mut.ts"), true, "A1 must be caught at production-relaxed post-fix");
});

test("A1 empty-recursive-helper: not caught at strict mt=100 (iteration body < 100 tokens — size filter)", () => {
  const sources = [
    { path: "a1-orig.ts", content: a1Original },
    { path: "a1-mut.ts", content: a1Mutant },
  ];
  const r = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...STRICT });
  // The iteration body is ~47 tokens (< 100), so Pass 2.5 doesn't fire at strict mt=100.
  // This is a size-filter artifact, not a Jaccard boundary. Documented.
  assert.equal(verdict(r.findings, "a1-orig.ts", "a1-mut.ts"), false, "A1 not caught at strict mt=100 (size filter)");
});

test("A5 type-aware operand-reorder: caught at production-relaxed (fix-effect — pre-fix misses at strict mt=30)", () => {
  const sources = [
    { path: "a5-orig.ts", content: a5Original },
    { path: "a5-mut.ts", content: a5Mutant },
  ];
  const r = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...RELAXED });
  assert.equal(verdict(r.findings, "a5-orig.ts", "a5-mut.ts"), true, "A5 must be caught at production-relaxed post-fix");
});

test("A5 type-aware operand-reorder: caught at strict mt=30 (fix-effect — Jaccard 1.0 via operand-reorder)", () => {
  const sources = [
    { path: "a5-orig.ts", content: a5Original },
    { path: "a5-mut.ts", content: a5Mutant },
  ];
  const r = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...STRICT_MT30 });
  // The operand-reorder makes `i + 1` and `1 + i` produce the same sorted token stream
  // → Jaccard 1.0 → caught at strict mt=30. Pre-fix: Jaccard < 1.0 → not caught at strict.
  assert.equal(verdict(r.findings, "a5-orig.ts", "a5-mut.ts"), true, "A5 must be caught at strict mt=30 post-fix (operand-reorder → Jaccard 1.0)");
});

test("A5 no-new-FP: STRING concat `prefix + v` vs `v + prefix` NOT caught at production (string concat not reordered)", () => {
  const sources = [
    { path: "str-orig.ts", content: a5StringControlOriginal },
    { path: "str-mut.ts", content: a5StringControlMutant },
  ];
  // `prefix` is a string (not known numeric) → `+` is NOT reordered → different token streams → not caught.
  // This must pass BOTH pre-fix (no reorder) AND post-fix (no reorder for string `+`).
  const rRelaxed = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...RELAXED });
  assert.equal(verdict(rRelaxed.findings, "str-orig.ts", "str-mut.ts"), false, "String concat must NOT be caught at production-relaxed (no FP from operand-reorder)");
  const rStrict = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...STRICT_MT30 });
  assert.equal(verdict(rStrict.findings, "str-orig.ts", "str-mut.ts"), false, "String concat must NOT be caught at strict mt=30 (no FP)");
});
