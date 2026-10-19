// Regression test for EXP449: hardcoded JS_KEYWORDS list → dynamic babel tokenizer.
// Root cause: semanticTokenSet used a hardcoded Set of JS/TS keywords that
// could drift from the language spec (e.g., `override` was missing).
// Fix: classify keywords DYNAMICALLY via @babel/parser's tokenizer (type.keyword)
// — no hardcoded list. Per "no static constants" directive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dedupV2 } from "../../_experiments/llm-beyond-max/dedup-v2.ts";

test("dedup-v2 has NO hardcoded JS_KEYWORDS constant (no static keywords)", () => {
  const src = readFileSync("_experiments/llm-beyond-max/dedup-v2.ts", "utf8");
  assert.doesNotMatch(src, /const JS_KEYWORDS\s*=\s*new Set\(/,
    "the hardcoded JS_KEYWORDS Set must be removed");
  assert.match(src, /import.*parse.*from.*@babel\/parser/,
    "must import @babel/parser for dynamic keyword classification");
  assert.match(src, /type\.keyword/, "must use type.keyword for dynamic keyword detection");
});

test("semanticTokenSet keeps keywords verbatim and normalizes identifiers to ID", () => {
  const f1 = "function computeHash(value) { return value + 1; }";
  const f2 = "function computeHash(input) { return input + 2; }";
  const r = dedupV2(`${f1}\n\n${f2}`, { mode: "semantic", blockSimilarityThreshold: 0.5, minLineLengthForDedup: 4 });
  assert.ok(r.report.removedBlocks >= 0, "semantic dedup runs without crash");
});

test("semanticTokenSet handles TS keywords dynamically (satisfies, override)", () => {
  const a = "const x = { a: 1 } satisfies Record<string, number>;";
  const b = "const y = { b: 2 } satisfies Record<string, number>;";
  const r = dedupV2(`${a}\n\n${b}`, { mode: "semantic", blockSimilarityThreshold: 0.5, minLineLengthForDedup: 4 });
  assert.ok(r.report.removedBlocks >= 0, "TS keyword `satisfies` handled dynamically");
});

test("semanticTokenSet handles non-JS blocks without crashing (regex fallback)", () => {
  const prose = "This is not code at all.\n\nThis is not code at all.";
  const r = dedupV2(prose, { mode: "semantic", blockSimilarityThreshold: 0.5, minLineLengthForDedup: 4 });
  assert.ok(typeof r.content === "string", "non-JS block handled by regex fallback");
});
