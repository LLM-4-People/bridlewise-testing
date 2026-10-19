/**
 * EXP461 — Targeted regression tests for the 6 safety fixes.
 *
 * S2: typeAnnotationText renders TS nodes precisely (was coarse).
 * S3: buildIndexFromSources uses AST structural sets (was regex-only).
 * S4: the response is parsed ONCE (extractReferences + inferClaims share
 * the same AST — was double-parsed).
 * S5: the semantic matcher rejects clean-suffix variants via a surface-
 * form edit-similarity gate (was fpRate 0.621).
 * S6: the n-gram matcher drops non-discriminative n-grams via a clean-
 * frequency discrimination floor (was fpRate 0.448).
 * S1: all 8 bias types trigger (covered in bias-detector-benchmark.test.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildSemanticIndexFromSources, inferClaimsFromAst } from "../../src/safety/hallucination-semantic.ts";
import { buildIndexFromSources } from "../../src/safety/hallucination-detector.ts";
import { resolveHallucinationConfig } from "../../src/safety/hallucination-config.ts";
import { parse } from "@babel/parser";
import { astNode } from "../../src/quality-packs/prevention/ast-helpers.ts";
import { semanticMatch, buildSemanticVectors, editSimilarity } from "../../_experiments/auto-learning/semantic-match.ts";
import { extractNgramPatterns, ngramMatch } from "../../_experiments/auto-learning/ngram.ts";
import { ErrorCollector } from "../../_experiments/auto-learning/collector.ts";
import { loadLearningConfig } from "../../_experiments/auto-learning/config.ts";

// ---------------------------------------------------------------------------
// S2: recursive type rendering (was coarse: {N}, "Function", "tuple", "string")
// ---------------------------------------------------------------------------

test("safety-regression: safety S2: object-type param renders member signatures (was {N})", () => {
  const src = [{ path: "src/t.ts", content: `export function fn(a: { x: number; y: string }): void {}` }];
  const idx = buildSemanticIndexFromSources(src);
  const fn = idx.records.find((r) => r.name === "fn");
  assert.ok(fn, "fn extracted");
  assert.ok(fn!.paramTypes[0]?.includes("x: number"), `object-type param rendered with members (got ${fn!.paramTypes[0]})`);
  assert.ok(fn!.paramTypes[0]?.includes("y: string"), `second member rendered (got ${fn!.paramTypes[0]})`);
});

test("safety-regression: safety S2: tuple return renders element types (was 'tuple')", () => {
  const src = [{ path: "src/t.ts", content: `export function g(): [number, string] { return [1, "x"]; }` }];
  const idx = buildSemanticIndexFromSources(src);
  const g = idx.records.find((r) => r.name === "g");
  assert.equal(g!.returnType, "[number, string]", `tuple rendered with element types (got ${g!.returnType})`);
});

test("safety-regression: safety S2: template-literal type renders the template (was 'string')", () => {
  const src = [{ path: "src/t.ts", content: "export function h(): `val-${number}` { return null as never; }" }];
  const idx = buildSemanticIndexFromSources(src);
  const h = idx.records.find((r) => r.name === "h");
  assert.ok(h!.returnType?.includes("val-"), `template-literal rendered (got ${h!.returnType})`);
  assert.ok(h!.returnType?.includes("${number}"), `template middle rendered (got ${h!.returnType})`);
});

// ---------------------------------------------------------------------------
// S3: AST structural index (was regex-only for types/imports/exports)
// ---------------------------------------------------------------------------

test("safety-regression: safety S3: buildIndexFromSources captures types/imports/exports via AST", () => {
  const src = [{ path: "src/m.ts", content: `
import { foo } from "./other.ts";
export interface Iface { x: number; }
export type Alias = string;
export function bar(): void {}
export default bar;
` }];
  const semIdx = buildSemanticIndexFromSources(src);
  const idx = buildIndexFromSources(src, semIdx);
  assert.ok(idx.types.has("Iface"), "interface captured via AST (was regex)");
  assert.ok(idx.types.has("Alias"), "type alias captured via AST");
  assert.ok(idx.imports.has("./other.ts"), "import source captured via AST");
  assert.ok(idx.symbols.has("bar"), "function symbol captured");
  assert.ok(idx.exports.has("default"), "default export captured via AST");
});

test("safety-regression: safety S3: AST is the single source of truth (no regex false types)", () => {
  // A comment that LOOKS like a type declaration but isn't — regex would
  // falsely capture it; the AST does not.
  const src = [{ path: "src/c.ts", content: `// export type FakeType = string;\nexport function real(): void {}` }];
  const semIdx = buildSemanticIndexFromSources(src);
  const idx = buildIndexFromSources(src, semIdx);
  assert.ok(!idx.types.has("FakeType"), "commented-out type NOT captured (AST, not regex)");
  assert.ok(idx.symbols.has("real"), "real function captured");
});

// ---------------------------------------------------------------------------
// S4: single parse (extractReferences + inferClaims share one AST)
// ---------------------------------------------------------------------------

test("safety-regression: safety S4: inferClaimsFromAst infers from a pre-parsed AST (no re-parse)", () => {
  const cfg = resolveHallucinationConfig();
  const code = "await asyncFetch('url');\n";
  // Parse once.
  const ast = astNode(parse(code, { sourceType: "module", errorRecovery: true, plugins: ["typescript"] }));
  assert.ok(ast !== undefined, "response parsed once");
  const claims = inferClaimsFromAst(ast, cfg);
  assert.ok(claims.some((c) => c.ref === "asyncFetch" && c.field === "async"), "await → async claim inferred from the shared AST");
});

// ---------------------------------------------------------------------------
// S5: semantic matcher surface-form gate (was fpRate 0.621)
// ---------------------------------------------------------------------------

test("safety-regression: safety S5: semantic matcher rejects clean-suffix variant via edit gate", () => {
  // A rule for `invalid-regex` and a clean op `invalid-regex-clean`. With the
  // surface-form gate (>=0.7 edit similarity), the clean-suffix variant is
  // REJECTED (edit similarity 1 - 6/19 ≈ 0.68 < 0.7). Without the gate (0),
  // the cosine match would fire (FP).
  const rules = [{ id: "r1", spec: { type: "tool-call-failed", causeMatch: "invalid-regex" } }];
  const cleanCauses = [{ type: "tool-call-failed", cause: "invalid-regex-clean" }];
  const { vectors, df, corpusSize } = buildSemanticVectors(rules, cleanCauses, 3, 6);
  // Without the gate (0) → matches (the FP EXP451 had).
  const noGate = semanticMatch({ type: "tool-call-failed", cause: "invalid-regex-clean" }, vectors, df, corpusSize, 3, 6, 0.6, 0);
  assert.ok(noGate.matched, "without the gate, clean-suffix variant over-matches (the EXP451 FP)");
  // With the gate (0.7) → rejected.
  const withGate = semanticMatch({ type: "tool-call-failed", cause: "invalid-regex-clean" }, vectors, df, corpusSize, 3, 6, 0.6, 0.7);
  assert.ok(!withGate.matched, "with the gate, clean-suffix variant is rejected (0 FP)");
  // A real family variant (edit dist 1) still matches.
  assert.ok(editSimilarity("invalid-regex", "invalid-regexx") >= 0.7, "real variant clears the gate");
  const realVariant = semanticMatch({ type: "tool-call-failed", cause: "invalid-regexx" }, vectors, df, corpusSize, 3, 6, 0.6, 0.7);
  assert.ok(realVariant.matched, "real family variant still matches with the gate");
});

// ---------------------------------------------------------------------------
// S6: n-gram discrimination (was fpRate 0.448)
// ---------------------------------------------------------------------------

test("safety-regression: safety S6: n-gram extraction drops non-discriminative n-grams", () => {
  const config = loadLearningConfig();
  const collector = new ErrorCollector({ accumulateAcrossRounds: true });
  // Error causes contain "regex"; MANY clean causes ALSO contain "regex"
  // (the EXP451 over-match: `bad-regex-clean` etc.). The n-gram "regex" is
  // common in clean → non-discriminative → must be dropped.
  for (let i = 0; i < 10; i++) collector.record({ type: "tool-call-failed", cause: "invalid-regex", turn: 1, input: "x", expected: "s", actual: "e", context: {} });
  const cleanCauses = [
    { type: "tool-call-failed", cause: "bad-regex-clean" },
    { type: "tool-call-failed", cause: "stale-regex-data" },
    { type: "tool-call-failed", cause: "ok-regex-result" },
  ];
  // Without discrimination (0) → the `regex` n-gram is admitted.
  const noDisc = extractNgramPatterns(collector, { ...config, ngramMinDiscrimination: 0 }, cleanCauses);
  assert.ok(noDisc.some((p) => p.ngram.includes("regex")), "without discrimination, the shared n-gram is admitted (the EXP451 FP source)");
  // With discrimination (5) → error count (10) < 5 × clean count (3) = 15 → dropped.
  const withDisc = extractNgramPatterns(collector, config, cleanCauses);
  assert.ok(!withDisc.some((p) => p.ngram.includes("regex")), "with discrimination, the clean-shared n-gram is dropped");
  // The clean op no longer matches via the n-gram rule.
  const rulesWith = withDisc.map((p) => ({ spec: { type: p.type, causeMatch: p.ngram } }));
  assert.ok(!ngramMatch({ type: "tool-call-failed", cause: "bad-regex-clean" }, rulesWith).matched, "clean op NOT matched with discrimination (0 FP)");
  const rulesWithout = noDisc.map((p) => ({ spec: { type: p.type, causeMatch: p.ngram } }));
  assert.ok(ngramMatch({ type: "tool-call-failed", cause: "bad-regex-clean" }, rulesWithout).matched, "clean op matched WITHOUT discrimination (the EXP451 FP)");
});
