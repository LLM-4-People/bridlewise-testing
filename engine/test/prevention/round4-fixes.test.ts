import assert from "node:assert/strict";
import test from "node:test";

import { detectDuplicateBodies } from "../../src/quality-packs/prevention/duplicate-body-detector.ts";

/**
 * D3 regression test — Round 4 fixes (operator-dropping + ID_NUM + ternary↔if-else + A4 STR_<value>).
 *
 * Round 4 Fix 1 (FINDING 1 from Round 3 Verifier 1 — operator-dropping): emit the operator in the
 * BinaryExpression token (`BinaryExpression_+` / `BinaryExpression_*`) so different operators
 * produce different tokens. Eliminates the operator-dropping FP (`+` vs `*` → same `BinaryExpression`
 * token → Jaccard 1.0 → FP). Category theory: the operator is a parameter to the BinaryExpression
 * functor; preserving it makes the functor faithful.
 *
 * Round 4 Fix 2 (FINDING 2 from Round 3 Verifier 1 — Identifier ID_NUM): emit `ID_NUM` for
 * Identifiers known to be numeric (via `collectKnownNumeric` — for-loop counters, NumericLiteral
 * inits, etc.) and `ID` for unknown-type (might be string). Type-lattice refinement: `ID` →
 * `ID_NUM` ⊔ `ID`. Reduces the FP surface for mixed-type `+` (`i + s` vs `s + i` where `i` is
 * numeric, `s` is unknown → `ID_NUM ID` vs `ID ID_NUM` → different → NOT caught). Residual FP
 * (both unknown-type `a + b` vs `b + a` → both `ID ID` → caught) requires full type inference.
 *
 * Round 4 Fix 3 (N3 ternary↔if-else): normalize `ConditionalExpression` to `DECIDE` with branch
 * distribution. `return x? a: b` → `DECIDE <test> ReturnStatement <a> ReturnStatement <b>`
 * (matches `if (x) return a; else return b;`). Also handles `grade = x? a: b` (assignment
 * distribution) and `const x = cond? a: b` (variable-declaration distribution). Recursively
 * handles nested ternaries in cons/alt. Sources: babel-plugin-transform-ternary-to-if-else
 * (OpenGG, MIT, commit 1441ca53). Automata theory: ternary + if-else both reduce to the same
 * DECIDE state in the CFG.
 *
 * Round 4 "keep on improving" (A4 generalization — STR_<value> for all string literals): emit
 * `STR_<value>` (or `STR_<sha16>` for long/pipe values) for ALL StringLiteral nodes, not just
 * split-idiom delimiters. Fixes the A4 pre-existing FP surface (two functions identical except
 * a string literal → Jaccard 1.0 → FP). Also fixes the N3-CTRL FP (swapped ternary branches
 * with different string values now produce different `STR_<value>` tokens). Category theory:
 * the string value is a parameter to the StringLiteral functor; preserving it makes the functor
 * faithful (same principle as the split-idiom delimiter fix + the operator-dropping fix).
 *
 * Assertions are labeled:
 * - fix-effect: must FAIL pre-fix (the fix is what makes it pass).
 * - no-new-FP: must pass pre-fix AND post-fix (the fix must not introduce a FP).
 * - documented-limitation: a known FP that is NOT fixed (documented for a future round).
 *
 * Sources: babel-plugin-transform-ternary-to-if-else (OpenGG, MIT, commit 1441ca53);
 * arXiv 2606.25272 §III-D (O4 — "string concatenations are skipped"); Babel AST spec (MIT).
 *
 * Re-derivation: to verify fix-effect assertions FAIL pre-fix, revert to `b46b97f` (pre-Round-4):
 * git checkout b46b97f -- src/quality-packs/prevention/duplicate-body-detector.ts
 * node --test --test-reporter=spec test/prevention/round4-fixes.test.ts
 * # fix-effect assertions MUST FAIL (the pre-fix detector produces the wrong result)
 * git checkout HEAD -- src/quality-packs/prevention/duplicate-body-detector.ts # restore
 */

// ============================================================================
// Fix 1 (operator-dropping): `result + v` vs `result * v` — DIFFERENT operators.
// Pre-fix: `BinaryExpression` (no operator) → same token → Jaccard 1.0 → caught (FP).
// Post-fix: `BinaryExpression_+` vs `BinaryExpression_*` → different → NOT caught (FP fixed).
// ============================================================================
const opDropOriginal = `
export function calcAdd(values: readonly number[]): number {
  let result = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    result = result + v;
    count = count + 1;
  }
  return count === 0 ? 0 : result;
}
`;
const opDropMutant = `
export function calcAdd(values: readonly number[]): number {
  let result = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    result = result * v;
    count = count * 1;
  }
  return count === 0 ? 0 : result;
}
`;

// ============================================================================
// Fix 2 (ID_NUM): `i + s` vs `s + i` where `i` is a for-loop counter (known-numeric)
// and `s` is a function param (unknown-type). NOT equivalent for string `s`.
// Pre-fix (no ID_NUM): `i` → `ID`, `s` → `ID` → `BinaryExpression_+ ID ID` (both same) → caught (FP).
// Post-fix (ID_NUM): `i` → `ID_NUM`, `s` → `ID` → `BinaryExpression_+ ID_NUM ID` vs `BinaryExpression_+ ID ID_NUM`
// → different → NOT caught (FP fixed).
// ============================================================================
const idMixOriginal = `
export function mixAdd(n: number, s: string): string {
  let a = "";
  let b = "";
  let c = "";
  for (let i = 0; i < n; i++) {
    a = a + (i + s);
    b = b + (i + s);
    c = c + (i + s);
  }
  return a + b + c;
}
`;
const idMixMutant = `
export function mixAdd(n: number, s: string): string {
  let a = "";
  let b = "";
  let c = "";
  for (let i = 0; i < n; i++) {
    a = a + (s + i);
    b = b + (s + i);
    c = c + (s + i);
  }
  return a + b + c;
}
`;

// ============================================================================
// Fix 3 (N3 ternary↔if-else): `return x? "a": "b"` ↔ `if (x) return "a"; else return "b";`.
// Pre-fix: `ConditionalExpression` (default case) vs `IfStatement` (DECIDE case) → different → NOT caught.
// Post-fix: both → `DECIDE <test> ReturnStatement <a> ReturnStatement <b>` → same → caught.
// ============================================================================
const n3ReturnOriginal = `
export function classify(x: number): string {
  const threshold = 10;
  const label: string = x > threshold ? "big" : "small";
  const note: string = x > threshold ? "above" : "below";
  return label + "-" + note;
}
`;
const n3ReturnMutant = `
export function classify(x: number): string {
  const threshold = 10;
  let label: string;
  if (x > threshold) { label = "big"; } else { label = "small"; }
  let note: string;
  if (x > threshold) { note = "above"; } else { note = "below"; }
  return label + "-" + note;
}
`;

// ============================================================================
// A4 generalization (STR_<value> for all string literals): two functions with DIFFERENT
// string values but the same structure. Pre-fix: `STR` (no value) → same → Jaccard 1.0 → caught (FP).
// Post-fix: `STR_big` vs `STR_small` → different → NOT caught (FP fixed).
// This is the N3-CTRL case: ternary with swapped branches (different string values).
// ============================================================================
const a4Original = `
export function classifySwap(x: number): string {
  const threshold = 10;
  const label: string = x > threshold ? "big" : "small";
  const note: string = x > threshold ? "above" : "below";
  return label + "-" + note;
}
`;
const a4Mutant = `
export function classifySwap(x: number): string {
  const threshold = 10;
  let label: string;
  if (x > threshold) { label = "small"; } else { label = "big"; }
  let note: string;
  if (x > threshold) { note = "below"; } else { note = "above"; }
  return label + "-" + note;
}
`;

// ============================================================================
// No-new-FP control: OP-SAME (`a + b` vs `b + a`, both unknown-type, numeric `+`).
// Pre-fix AND post-fix: both `ID ID` → same → caught. This is the PRE-EXISTING FP
// (both unknown-type `+` → caught, but string concat is not commutative). The ID_NUM
// fix does NOT fix this (both unknown → both `ID`). Documented limitation.
// ============================================================================
const opSameOriginal = `
export function swapAdd(a: number, b: number): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < 10; i++) {
    sum = sum + a + b;
    count = count + 1;
  }
  return count === 0 ? 0 : sum;
}
`;
const opSameMutant = `
export function swapAdd(a: number, b: number): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < 10; i++) {
    sum = sum + b + a;
    count = count + 1;
  }
  return count === 0 ? 0 : sum;
}
`;

const RELAXED = { jaccardThreshold: 0.9, minTokenCount: 30, minBodySize: 80 };
const STRICT = { jaccardThreshold: 1.0, minTokenCount: 100, minBodySize: 80 };

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

// ============================================================================
// Fix 1 tests (operator-dropping)
// ============================================================================

test("Fix 1 (operator-dropping): `result + v` vs `result * v` NOT caught at production (fix-effect)", () => {
  const sources = [
    { path: "op-orig.ts", content: opDropOriginal },
    { path: "op-mut.ts", content: opDropMutant },
  ];
  // fix-effect: pre-fix (no operator in token) → `BinaryExpression` both → Jaccard 1.0 → caught (FP).
  // Post-fix: `BinaryExpression_+` vs `BinaryExpression_*` → different → NOT caught.
  const rRelaxed = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...RELAXED });
  assert.equal(verdict(rRelaxed.findings, "op-orig.ts", "op-mut.ts"), false, "operator-dropping `+` vs `*` must NOT be caught post-fix (FP fixed by Fix 1)");
});

test("Fix 1 (operator-dropping): NOT caught at strict mt=1 (fix-effect — not a size-filter artifact)", () => {
  const sources = [
    { path: "op-orig.ts", content: opDropOriginal },
    { path: "op-mut.ts", content: opDropMutant },
  ];
  const rStrict = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...STRICT, minTokenCount: 1 });
  assert.equal(verdict(rStrict.findings, "op-orig.ts", "op-mut.ts"), false, "operator-dropping must NOT be caught at strict mt=1 post-fix");
});

// ============================================================================
// Fix 2 tests (ID_NUM)
// ============================================================================

test("Fix 2 (ID_NUM): `i + s` vs `s + i` (i known-numeric, s unknown) NOT caught at production (fix-effect)", () => {
  const sources = [
    { path: "id-orig.ts", content: idMixOriginal },
    { path: "id-mut.ts", content: idMixMutant },
  ];
  // fix-effect: pre-fix (no ID_NUM) → `i` → `ID`, `s` → `ID` → `BinaryExpression_+ ID ID` both → caught (FP).
  // Post-fix (ID_NUM in walkV2 only): `i` → `ID_NUM`, `s` → `ID` → `ID_NUM ID` vs `ID ID_NUM` → different → NOT caught in Pass 2.
  // NOTE: at production-relaxed (mt=30), the iteration body is ~24 tokens < 30 → Pass 2.5 filtered out → NOT caught.
  // At strict mt=1, Pass 2.5 fires (walkIterationBody has NO ID_NUM fix — intentionally, to avoid
  // regressing T4a/A1 where the loop-form has known-numeric counters but the recursive-form doesn't).
  // So the ID-MIX pair IS caught at strict mt=1 via Pass 2.5 (residual FP at low mt, documented).
  // The production behavior (mt=30/100) is correct: NOT caught (FP fixed at production).
  const rRelaxed = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...RELAXED });
  assert.equal(verdict(rRelaxed.findings, "id-orig.ts", "id-mut.ts"), false, "mixed-type `i + s` vs `s + i` must NOT be caught at production-relaxed post-fix (FP fixed by ID_NUM at production)");
});

test("Fix 2 (ID_NUM): residual FP at strict mt=1 via Pass 2.5 — FIXED by Round 5.1 (conditional ID_NUM)", () => {
  const sources = [
    { path: "id-orig.ts", content: idMixOriginal },
    { path: "id-mut.ts", content: idMixMutant },
  ];
  // Round 5.1 fix-effect (VERIFIED to FAIL pre-Round-5.1 at candidate `583d6b2`):
  // at strict mt=1, Pass 2.5 fires (iteration body ~24 tokens ≥ 1). Both forms'
  // knownNumeric sets are EQUAL ({i} — `i` is the for-loop counter; `s` is a param
  // used only in `+` → NOT inferred). Pass 2.5 applies the with-ID_NUM shingles →
  // `i + s` → `BinaryExpression_+ ID_NUM ID` vs `s + i` → `BinaryExpression_+ ID ID_NUM`
  // → DIFFERENT → NOT caught (residual FP FIXED at ALL mt including mt=1).
  // Pre-Round-5.1, walkIterationBody used ID for both → `BinaryExpression_+ ID ID`
  // for both → Jaccard 1.0 → CAUGHT (the documented residual FP at low mt).
  // After Round 5.1 (conditional ID_NUM), the residual is FIXED. Tests now assert
  // NOT-CAUGHT. The conditional application avoids regressing T4a/A1 (where the
  // for-loop form's knownNumeric set differs from the recursive form's → fallback
  // to ID). The trade-off is gone: ID_NUM is now in walkIterationBody CONDITIONALLY
  // (only when both forms' knownNumeric sets are equal), so the residual FP is
  // eliminated without regressing T4a/A1.
  const rStrict = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...STRICT, minTokenCount: 1 });
  assert.equal(verdict(rStrict.findings, "id-orig.ts", "id-mut.ts"), false, "Round 5.1 fix: NOT caught at strict mt=1 (conditional ID_NUM — both forms' knownNumeric sets equal {i} → with-ID_NUM shingles differ)");
});

// ============================================================================
// Fix 3 tests (N3 ternary↔if-else)
// ============================================================================

test("Fix 3 (N3 ternary↔if-else return): `return x? a: b` ↔ `if (x) return a; else return b;` caught (fix-effect)", () => {
  const sources = [
    { path: "n3-orig.ts", content: n3ReturnOriginal },
    { path: "n3-mut.ts", content: n3ReturnMutant },
  ];
  // fix-effect: pre-fix (no ternary→DECIDE) → `ConditionalExpression` vs `IfStatement DECIDE` → different → NOT caught.
  // Post-fix (ternary→DECIDE distribution): both → `DECIDE <test> ReturnStatement <a> ReturnStatement <b>` → caught.
  const rRelaxed = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...RELAXED });
  assert.equal(verdict(rRelaxed.findings, "n3-orig.ts", "n3-mut.ts"), true, "ternary↔if-else return must be caught post-fix (Fix 3)");
});

// ============================================================================
// A4 generalization tests (STR_<value> for all string literals)
// ============================================================================

test("A4 (STR_<value>): swapped ternary branches with DIFFERENT string values NOT caught (no-new-FP for N3+A4 combo)", () => {
  const sources = [
    { path: "a4-orig.ts", content: a4Original },
    { path: "a4-mut.ts", content: a4Mutant },
  ];
  // no-new-FP: this passes pre-fix (N3 not normalized → different structure → NOT caught)
  // AND post-fix (N3 normalized → structure matches, but A4 STR_<value> → different values → NOT caught).
  // The N3 fix makes the structure match; the A4 fix makes the string values differ.
  // Together they ensure the swapped-branches control is NOT caught (correct TN).
  const rRelaxed = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...RELAXED });
  assert.equal(verdict(rRelaxed.findings, "a4-orig.ts", "a4-mut.ts"), false, "swapped ternary branches (different strings) must NOT be caught (N3+A4 combo)");
});

test("A4 (STR_<value>): two functions same structure DIFFERENT string values NOT caught (fix-effect)", () => {
  // Pure A4 fix-effect: two functions with the SAME structure (no ternary, just a simple
  // function with a string literal) but DIFFERENT string values.
  // Pre-A4-fix: `STR` (no value) → same → Jaccard 1.0 → caught (FP — the A4 pre-existing FP).
  // Post-A4-fix: `STR_hello` vs `STR_world` → different → NOT caught (FP fixed).
  const a4PureOriginal = `
export function greet(name: string): string {
  let message = "";
  let count = 0;
  for (let i = 0; i < name.length; i++) {
    message = message + "hello";
    count = count + 1;
  }
  return message + count;
}
`;
  const a4PureMutant = `
export function greet(name: string): string {
  let message = "";
  let count = 0;
  for (let i = 0; i < name.length; i++) {
    message = message + "world";
    count = count + 1;
  }
  return message + count;
}
`;
  const sources = [
    { path: "a4pure-orig.ts", content: a4PureOriginal },
    { path: "a4pure-mut.ts", content: a4PureMutant },
  ];
  // fix-effect: pre-fix (STR, no value) → both `STR` → same → caught (FP — A4 pre-existing FP).
  // Post-fix (STR_<value>): `STR_hello` vs `STR_world` → different → NOT caught (FP fixed).
  const rRelaxed = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...RELAXED });
  assert.equal(verdict(rRelaxed.findings, "a4pure-orig.ts", "a4pure-mut.ts"), false, "same-structure different-string-values must NOT be caught post-fix (A4 FP fixed by STR_<value>)");
  // Also verify at strict mt=1 (not a size-filter artifact).
  const rStrict = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...STRICT, minTokenCount: 1 });
  assert.equal(verdict(rStrict.findings, "a4pure-orig.ts", "a4pure-mut.ts"), false, "same-structure different-string-values NOT caught at strict mt=1 (A4 fix, not size-filter)");
});

// ============================================================================
// No-new-FP + documented limitation tests
// ============================================================================

test("No-new-FP + documented limitation: `a + b` vs `b + a` (both unknown-type) IS caught (pre-existing FP, documented)", () => {
  const sources = [
    { path: "same-orig.ts", content: opSameOriginal },
    { path: "same-mut.ts", content: opSameMutant },
  ];
  // no-new-FP: this must pass pre-fix AND post-fix (the ID_NUM fix does NOT fix both-unknown-type).
  // This is the DOCUMENTED PRE-EXISTING FP: both `a` and `b` are unknown-type → both `ID` →
  // `BinaryExpression_+ ID ID` regardless of order → caught. For numeric inputs, `+` IS commutative
  // (equivalent), so this is a TP in the numeric case. But for string inputs, `+` is NOT commutative
  // (FP). The ID_NUM fix reduces the surface (known-numeric → `ID_NUM`) but doesn't eliminate it
  // for unknown-type pairs. Fixing requires full type inference (out of scope).
  const rRelaxed = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...RELAXED });
  assert.equal(verdict(rRelaxed.findings, "same-orig.ts", "same-mut.ts"), true, "both-unknown-type `a + b` vs `b + a` IS caught (pre-existing FP, documented — ID_NUM does not fix unknown-type pairs)");
});
