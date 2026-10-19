import assert from "node:assert/strict";
import test from "node:test";

import { detectDuplicateBodies } from "../../src/quality-packs/prevention/duplicate-body-detector.ts";

/**
 * D3 regression test — Round 5.1 (conditional ID_NUM in walkIterationBody).
 *
 * Round 4 Fix 2 (ID_NUM) emitted `ID_NUM` for known-numeric Identifiers in `walkV2`
 * (Pass 2) ONLY — NOT in `walkIterationBody` (Pass 2.5). This was a deliberate
 * design choice to avoid regressing T4a/A1 (loop↔recursion), where the loop-form
 * has known-numeric counters but the recursive-form doesn't (emitting ID_NUM only
 * in walkV2 avoids the asymmetry that would make Pass 2.5 miss T4a/A1).
 *
 * The RESIDUAL FP (Round 4 Fix-up): with a 4+ statement iteration body (≥30
 * iteration-body tokens), Pass 2.5 fired at production-relaxed (mt=30).
 * `walkIterationBody` used `ID` (not `ID_NUM`) for both `i` and `s`, so `i + s`
 * and `s + i` both → `BinaryExpression_+ ID ID` → Jaccard 1.0 → CAUGHT (FP for
 * string `s` — string concat is NOT commutative: `3 + "x"` = "3x" ≠ "x3").
 *
 * Round 5.1 FIX (conditional ID_NUM): `walkIterationBody` now emits `ID_NUM` for
 * known-numeric Identifiers (same as walkV2). `collectKnownNumeric` is extended
 * to infer recursive-helper params from STRICTLY-NUMERIC DIRECT usage (`<=`, `>=`,
 * `<`, `>`, `-`, `*`, `/`, `%`, `++`, `--` — NOT `+` which is overloaded for string
 * concat). Pass 2.5 applies the refinement CONDITIONALLY per pair: when both
 * forms' `knownNumeric` sets are EQUAL, the with-ID_NUM shingles are used (ID_NUM
 * distinguishes `i + s` vs `s + i` → fixes the residual FP); when the sets DIFFER,
 * the fallback `ID_NUM → ID` shingles are used (avoids regressing T4a where the
 * for-loop form infers more numerics via `let x = 0` than the recursive form's
 * params — e.g., `count` is `let count = 0` → ID_NUM in for-loop but only
 * `count + 1` (`+` is NOT strictly-numeric) → ID in recursive).
 *
 * After Round 5.1 (conditional ID_NUM), the residual is FIXED. Tests now assert
 * NOT-CAUGHT. The fix-effect assertions (tests 1 + 3) are VERIFIED to FAIL pre-fix
 * (at Round 4 candidate commit `583d6b2`): the residual IS CAUGHT at production-
 * relaxed + strict mt=30 (the pre-Round-5.1 behavior). Test 2 (NOT caught at
 * production-strict) is a no-new-FP guard that passes pre + post fix.
 *
 * Expected detector behavior (current detector, post-Round-5.1):
 * - production-relaxed (0.9, mt=30, bs=80): NOT caught (residual FIXED — both
 * forms' knownNumeric sets are EQUAL {i}, so the with-ID_NUM shingles are
 * used; `i + s` → `BinaryExpression_+ ID_NUM ID` vs `s + i` →
 * `BinaryExpression_+ ID ID_NUM` → different → NOT caught).
 * - production-strict (1.0, mt=100, bs=80): NOT caught (Pass 2.5 iteration body
 * ~48 tokens < 100 → filtered; Pass 2 fires but ID_NUM makes `i + s` vs
 * `s + i` differ in walkV2 too).
 * - strict (1.0, mt=30, bs=80): NOT caught (Pass 2.5 fires; conditional ID_NUM
 * applies; the with-ID_NUM shingles differ → NOT caught).
 *
 * V5 results after Round 5.1: strict 0/10, relaxed 5/10 (was 0/10 + 6/10 — the
 * ID-MIX-LARGE control FP is removed; the 5 equivalent TPs are preserved).
 * V3 results: strict 7/11, relaxed 11/11 (T4a STILL caught at strict — the
 * conditional approach falls back to ID for T4a because the for-loop form's
 * knownNumeric {i, count, depth} differs from the recursive form's {i, depth}).
 */

const RELAXED = { jaccardThreshold: 0.9, minTokenCount: 30, minBodySize: 80 };
const STRICT_MT100 = { jaccardThreshold: 1.0, minTokenCount: 100, minBodySize: 80 };
const STRICT_MT30 = { jaccardThreshold: 1.0, minTokenCount: 30, minBodySize: 80 };

// 6-statement body: `i + s` (original) vs `s + i` (mutant). `i` is a for-loop counter
// (known-numeric → ID_NUM in both walkV2 AND walkIterationBody post-Round-5.1).
// `s` is a function param used only in `+` (overloaded → NOT inferred numeric → ID).
// Both forms' knownNumeric sets are EQUAL ({i}) → Pass 2.5 applies the with-ID_NUM
// refinement → `i + s` → `BinaryExpression_+ ID_NUM ID` vs `s + i` →
// `BinaryExpression_+ ID ID_NUM` → DIFFERENT → NOT caught (residual FIXED).
// The iteration body is ~48 tokens (≥30 → Pass 2.5 fires at production-relaxed).
// The whole function is ≥100 normalized tokens (passes mt=100 for Pass 2).
const idMixLargeOriginal = `
export function mixAddLarge(n: number, s: string): string {
  let a = "";
  let b = "";
  let c = "";
  let d = "";
  let e = "";
  let f = "";
  for (let i = 0; i < n; i++) {
    a = a + (i + s);
    b = b + (i + s);
    c = c + (i + s);
    d = d + (i + s);
    e = e + (i + s);
    f = f + (i + s);
  }
  return a + b + c + d + e + f;
}
`;
const idMixLargeMutant = `
export function mixAddLarge(n: number, s: string): string {
  let a = "";
  let b = "";
  let c = "";
  let d = "";
  let e = "";
  let f = "";
  for (let i = 0; i < n; i++) {
    a = a + (s + i);
    b = b + (s + i);
    c = c + (s + i);
    d = d + (s + i);
    e = e + (s + i);
    f = f + (s + i);
  }
  return a + b + c + d + e + f;
}
`;

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

test("fix-effect: Round 5.1 conditional ID_NUM — `i + s` vs `s + i` 6-stmt body NOT caught at production-relaxed", () => {
  const sources = [
    { path: "id-orig.ts", content: idMixLargeOriginal },
    { path: "id-mut.ts", content: idMixLargeMutant },
  ];
  // fix-effect (VERIFIED to FAIL pre-Round-5.1 at candidate `583d6b2`): both forms'
  // knownNumeric sets are EQUAL ({i} — `i` is the for-loop counter; `s` is a param
  // used only in `+` → NOT inferred). Pass 2.5 applies the with-ID_NUM refinement →
  // `i + s` → `BinaryExpression_+ ID_NUM ID` vs `s + i` → `BinaryExpression_+ ID ID_NUM`
  // → DIFFERENT → NOT caught (residual FP FIXED). Pre-Round-5.1, walkIterationBody
  // used ID for both → `BinaryExpression_+ ID ID` for both → Jaccard 1.0 → CAUGHT (FP).
  const rRelaxed = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...RELAXED });
  assert.equal(verdict(rRelaxed.findings, "id-orig.ts", "id-mut.ts"), false, "Round 5.1 fix: 6-stmt `i + s` vs `s + i` NOT caught at production-relaxed (conditional ID_NUM — both forms' knownNumeric sets equal {i} → with-ID_NUM shingles differ)");
});

test("no-new-FP: NOT caught at production-strict (size filter on iteration body) — passes pre + post fix", () => {
  const sources = [
    { path: "id-orig.ts", content: idMixLargeOriginal },
    { path: "id-mut.ts", content: idMixLargeMutant },
  ];
  // At production-strict (mt=100), Pass 2.5's iteration body (~48 tokens) is below mt=100 →
  // filtered out. Pass 2 fires (whole function ≥100 tokens) but ID_NUM makes `i + s` vs
  // `s + i` differ in walkV2 too → NOT caught. This assertion is a no-new-FP guard that
  // passes pre + post fix (the residual only surfaced at mt≤30 pre-Round-5.1).
  const rStrict = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...STRICT_MT100 });
  assert.equal(verdict(rStrict.findings, "id-orig.ts", "id-mut.ts"), false, "NOT caught at production-strict (iteration body <100 tokens → Pass 2.5 filtered; Pass 2 differs via ID_NUM)");
});

test("fix-effect: Round 5.1 conditional ID_NUM — NOT caught at strict mt=30 (conditional ID_NUM applies)", () => {
  const sources = [
    { path: "id-orig.ts", content: idMixLargeOriginal },
    { path: "id-mut.ts", content: idMixLargeMutant },
  ];
  // fix-effect (VERIFIED to FAIL pre-Round-5.1 at candidate `583d6b2`): at strict (1.0)
  // with mt=30, Pass 2.5 fires (iteration body ≥30 tokens). Both forms' knownNumeric
  // sets are EQUAL ({i}) → the with-ID_NUM shingles are used → `i + s` vs `s + i`
  // differ → NOT caught. Pre-Round-5.1, walkIterationBody used ID for both → Jaccard 1.0
  // → CAUGHT (the strong residual, not a size-filter artifact).
  const rStrict30 = detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [], ...STRICT_MT30 });
  assert.equal(verdict(rStrict30.findings, "id-orig.ts", "id-mut.ts"), false, "Round 5.1 fix: NOT caught at strict mt=30 (conditional ID_NUM — both forms' knownNumeric sets equal {i} → with-ID_NUM shingles differ)");
});
