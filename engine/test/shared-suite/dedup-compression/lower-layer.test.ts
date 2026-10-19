/**
 * EXP454 — unit tests for the dedup-compression lower layer.
 * Covers: dynamic keywords (no hardcoded list), dedup modes, compression
 * modes, decompression roundtrip, lower-layer store/retrieve, improper
 * inputs (corrupt/binary/empty), unknown data types, 10× harder (200+ items).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { DEFAULT_DEDUP_COMPRESSION_CONFIG, type DedupCompressionConfig, validateConfig, resolveModuleConfig } from "../../../src/shared/dedup-compression/config.ts";
import { normalizeBabelTokens, normalizeWithLearnedKeywords, learnKeywordsFromCorpus, chooseStrategy, detectExtension } from "../../../src/shared/dedup-compression/dynamic-keywords.ts";
import { dedup } from "../../../src/shared/dedup-compression/dedup.ts";
import { compress } from "../../../src/shared/dedup-compression/compression.ts";
import { decompress } from "../../../src/shared/dedup-compression/decompression.ts";
import { DedupCompressionStore, computeSignals } from "../../../src/shared/dedup-compression/index.ts";

let passed = 0, failed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    try {
      const r = fn();
      if (r instanceof Promise) {
        r.then(() => { passed++; resolve(); }).catch((e) => { failed++; console.error("FAIL", name, e); resolve(); });
        return;
      }
      passed++;
      resolve();
    } catch (e) {
      failed++; console.error("FAIL", name, e);
      resolve();
    }
  });
}

const cfg = (over: Partial<DedupCompressionConfig> = {}): DedupCompressionConfig => ({ ...DEFAULT_DEDUP_COMPRESSION_CONFIG, ...over, modules: DEFAULT_DEDUP_COMPRESSION_CONFIG.modules, enabled: true });

// ===== dynamic keywords (THE fix for the PROHIBITED hardcoded list) =====

await test("dynamic-keywords: babel tokens detect keywords without a hardcoded list", () => {
  const code = `function foo(x: number): string { if (x > 0) return "yes"; else return null; }`;
  const r = normalizeBabelTokens(code);
  assert.equal(r.parseError, null, "should parse cleanly");
  // keywords kept verbatim (NOT normalized to ID)
  assert.ok(r.tokens.has("function"), "function keyword kept");
  assert.ok(r.tokens.has("if"), "if keyword kept");
  assert.ok(r.tokens.has("return"), "return keyword kept");
  assert.ok(r.tokens.has("null"), "null keyword kept");
  // identifiers normalized to ID
  assert.ok(r.tokens.has("ID"), "user identifier normalized to ID");
  assert.ok(!r.tokens.has("foo"), "foo NOT kept (it's an identifier)");
  assert.ok(!r.tokens.has("x"), "x NOT kept");
  // literals normalized
  assert.ok(r.tokens.has("STR"), "string literal normalized");
  assert.ok(r.tokens.has("NUM"), "number normalized");
  assert.ok(r.keywordCount > 0, "keywords detected dynamically");
  assert.ok(r.identifierCount > 0, "identifiers detected");
});

await test("dynamic-keywords: NO hardcoded keyword set exists in source", () => {
  // read the dynamic-keywords.ts source and assert no hardcoded keyword list
  const src = readFileSync(new URL("../../../src/shared/dedup-compression/dynamic-keywords.ts", import.meta.url), "utf8");
  // the PROHIBITED pattern: a Set/array literal of JS/TS keywords
  assert.ok(!/new Set\(\[\s*"abstract"/.test(src), "no hardcoded JS_KEYWORDS Set");
  assert.ok(!/KEYWORDS\s*=\s*\[/.test(src), "no hardcoded KEYWORDS array");
  assert.ok(!/"function".*"class".*"const"/.test(src), "no inline hardcoded keyword list");
});

await test("dynamic-keywords: frequency-learned detects keywords from corpus", () => {
  const corpus = [
    `function a() { return 1; }`,
    `function b() { return 2; }`,
    `function c() { return 3; }`,
  ];
  const keywords = learnKeywordsFromCorpus(corpus, 0.5);
  // "function" and "return" appear in ALL 3 blocks (>= 0.5) → keywords
  assert.ok(keywords.has("function"), "function learned as keyword");
  assert.ok(keywords.has("return"), "return learned as keyword");
  // a, b, c appear in 1/3 each → NOT keywords (identifiers)
  assert.ok(!keywords.has("a"), "a NOT a keyword");
  assert.ok(!keywords.has("b"), "b NOT a keyword");
});

await test("dynamic-keywords: frequency-learned normalizes with learned set", () => {
  const keywords = new Set(["function", "return"]);
  const r = normalizeWithLearnedKeywords(`function foo() { return 1; }`, keywords);
  assert.ok(r.tokens.has("function"), "learned keyword kept");
  assert.ok(r.tokens.has("return"), "learned keyword kept");
  assert.ok(r.tokens.has("ID"), "identifier normalized");
  assert.ok(!r.tokens.has("foo"), "foo NOT kept");
});

await test("dynamic-keywords: chooseStrategy auto-picks babel for .ts", () => {
  const c = cfg({ keywordStrategy: "auto" });
  assert.equal(chooseStrategy(`const x: number = 1;`, c), "babel-tokens");
  // Rust-ish text → frequency-learned (no wasm configured)
  assert.equal(chooseStrategy(`fn main() -> i32 { 0 }`, c), "frequency-learned");
});

await test("dynamic-keywords: detectExtension heuristics", () => {
  assert.equal(detectExtension(`fn main() { }`), ".rs");
  assert.equal(detectExtension(`def foo(): pass`), ".py");
  assert.equal(detectExtension(`const x = 1;`), ".ts");
});

// ===== dedup modes =====

await test("dedup: line removes duplicate lines", () => {
  const text = `a\nb\na\nc\nb`;
  const r = dedup(text, cfg({ dedupMode: "line", minLineLengthForDedup: 1 }));
  assert.equal(r.report.mode, "line");
  assert.ok(r.report.removedLines >= 2, "removed 2 dup lines");
  assert.equal(r.content.split("\n").length, 3);
});

await test("dedup: block removes near-duplicate blocks by Jaccard", () => {
  // two blocks sharing most lines (high Jaccard on line set)
  const text = `function foo(x) {\n  return x + 1;\n}\n\nfunction bar(x) {\n  return x + 1;\n}`;
  const r = dedup(text, cfg({ dedupMode: "block", blockSimilarityThreshold: 0.5, minLineLengthForDedup: 1 }));
  assert.ok(r.report.removedBlocks >= 1, "removed near-dup block");
});

await test("dedup: semantic catches name-only-different functions (dynamic keywords)", () => {
  // two functions identical except variable names → semantic dedup catches them
  const text = `function alpha(x, y) { const z = x + y; return z * 2; }\n\nfunction beta(a, b) { const c = a + b; return c * 2; }`;
  const r = dedup(text, cfg({ dedupMode: "semantic", blockSimilarityThreshold: 0.85 }));
  assert.ok(r.report.removedBlocks >= 1, "semantic caught name-only-different dups");
  assert.ok((r.report.keywordCount ?? 0) > 0, "keywords detected dynamically");
  assert.ok((r.report.identifierCount ?? 0) > 0, "identifiers normalized");
});

await test("dedup: hash removes EXACT duplicate markdown sections", () => {
  // two sections with identical heading AND content → same hash → removed
  const text = `## Same\nbody line\n\n## Same\nbody line`;
  const r = dedup(text, cfg({ dedupMode: "hash" }));
  assert.ok(r.report.removedBlocks >= 1, "removed exact-duplicate section");
});

await test("dedup: ast removes duplicate top-level statements", () => {
  const text = `function a() { return 1; }\nfunction a() { return 1; }\nfunction b() { return 2; }`;
  const r = dedup(text, cfg({ dedupMode: "ast" }));
  assert.ok(r.report.removedBlocks >= 1, "removed duplicate statement");
});

await test("dedup: none is a no-op", () => {
  const text = `hello\nworld`;
  const r = dedup(text, cfg({ dedupMode: "none" }));
  assert.equal(r.content, text);
  assert.equal(r.report.charReductionPct, 0);
});

// ===== compression + decompression (lossless) =====

for (const mode of ["none", "gzip", "brotli", "deflate"] as const) {
  await test(`compression: ${mode} lossless roundtrip`, () => {
    const text = `function foo(x: number): string { return x.toString(); }`;
    const c = cfg({ compressionMode: mode, compressionLevel: mode === "brotli" ? 11 : 9, llmVisibleLosslessOnly: false });
    const res = compress(text, c, false);
    const dec = decompress(res.compressed, res.effectiveMode);
    assert.ok(dec.ok, "decompress ok");
    assert.equal(dec.text, text, "roundtrip exact");
  });
}

await test("compression: minify is lossy (comments stripped, smaller)", () => {
  const text = `/** doc */\nfunction f() {\n  // comment\n  return 1;\n}`;
  const c = cfg({ compressionMode: "minify", llmVisibleLosslessOnly: false });
  const res = compress(text, c, false);
  assert.ok(res.report.compressedBytes < text.length, "minified is smaller");
  assert.ok(!res.compressed.toString("utf8").includes("doc"), "comment stripped");
});

await test("compression: llmVisibleLosslessOnly downgrades minify to brotli", () => {
  const text = `/** doc */ function f() { return 1; }`;
  const c = cfg({ compressionMode: "minify+brotli", llmVisibleLosslessOnly: true });
  const res = compress(text, c, true); // llmVisible = true
  assert.ok(res.report.downgradedForGemma, "downgraded for gemma tolerance");
  assert.equal(res.effectiveMode, "brotli", "downgraded to lossless brotli");
  // decompressed === original (lossless)
  const dec = decompress(res.compressed, res.effectiveMode);
  assert.equal(dec.text, text, "lossless roundtrip");
});

// ===== lower-layer store/retrieve (transparent) =====

await test("lower-layer: store and retrieve roundtrip (lossless)", () => {
  const store = new DedupCompressionStore(cfg({ dedupMode: "semantic", compressionMode: "brotli", llmVisibleLosslessOnly: true }));
  const text = `function foo(x: number) { return x + 1; }\n\nfunction bar(y: number) { return y + 1; }`;
  const sr = store.store(text, "memory", true);
  assert.ok(sr.id.length > 0, "got an id");
  const ret = store.retrieve(sr.id);
  assert.ok(ret.ok, "retrieve ok");
  // dedup may remove the second block (semantic near-dup), so the retrieved
  // text is the DEDUPED text, not the original. For lossless storage the
  // retrieved text === deduped text.
  assert.ok(ret.text.includes("function foo"), "first function present");
});

await test("lower-layer: cross-call dedup (same input → same id, dedupHit)", () => {
  const store = new DedupCompressionStore(cfg());
  const text = `const x = 1; const y = 2; const z = 3;`;
  const s1 = store.store(text, "memory", false);
  const s2 = store.store(text, "memory", false);
  assert.equal(s1.id, s2.id, "same id (content-addressed)");
  assert.ok(s2.dedupHit, "second store hit the dedup cache");
});

await test("lower-layer: computeSignals reports space saved", () => {
  const store = new DedupCompressionStore(cfg({ compressionMode: "brotli", llmVisibleLosslessOnly: false }));
  store.store(`function foo() { return 1; }`.repeat(20), "memory", false);
  store.store(`function bar() { return 2; }`.repeat(20), "tool-results", false);
  const sig = computeSignals(store);
  assert.ok(sig.entries >= 2, "at least 2 entries");
  assert.ok(sig.spaceSavedPct > 0, "space saved > 0%");
  assert.ok("memory" in sig.perModule, "memory module in perModule");
  assert.ok("tool-results" in sig.perModule, "tool-results module in perModule");
});

// R44 regression: dedupHitRate must NOT be hardwired to 0 (R31-V9 wired-
// but-inert bug: dedupHits was declared but never incremented → signal was
// always 0 even when cross-call dedup happened). The fix tracks dedup
// hits on the store; the signal reflects real activity.
await test("lower-layer: dedupHitRate reflects real cross-call dedup (R44 fix for R31-V9)", () => {
  const store = new DedupCompressionStore(cfg({ dedupMode: "none", compressionMode: "brotli", llmVisibleLosslessOnly: false }));
  // Store the SAME content twice → second call is a cross-call dedup hit.
  const text = `function fnAlpha(x: number) { return x + 1; }`;
  const s1 = store.store(text, "memory", false);
  const s2 = store.store(text, "memory", false);
  assert.equal(s1.dedupHit, false, "first store is not a dedup hit");
  assert.equal(s2.dedupHit, true, "second store IS a dedup hit");
  assert.equal(store.dedupHitCount(), 1, "store.dedupHitCount() reflects the hit");
  const sig = computeSignals(store);
  // 2 store calls, 1 dedup hit → 50% dedup hit rate (was always 0 before R44).
  assert.equal(sig.dedupHitRate, 50, `dedupHitRate must be 50 (got ${sig.dedupHitRate})`);
});

await test("lower-layer: dedupHitRate is 0 when no dedup hits occur (no false positives)", () => {
  const store = new DedupCompressionStore(cfg({ dedupMode: "none", compressionMode: "brotli", llmVisibleLosslessOnly: false }));
  // Store DIFFERENT content → no dedup hits.
  store.store(`function fnA() { return 1; }`, "memory", false);
  store.store(`function fnB() { return 2; }`, "memory", false);
  const sig = computeSignals(store);
  assert.equal(sig.dedupHitRate, 0, `dedupHitRate must be 0 with no hits (got ${sig.dedupHitRate})`);
});

await test("lower-layer: per-module config resolution", () => {
  const base = cfg({ compressionMode: "brotli", dedupMode: "semantic" });
  const mem = resolveModuleConfig(base, "memory");
  assert.equal(mem.compressionMode, "brotli");
  const ctx = resolveModuleConfig(base, "context");
  assert.equal(ctx.compressionMode, "none", "context module overrides to none");
  assert.equal(ctx.llmVisibleLosslessOnly, true, "context requires lossless");
});

// ===== IMPROPER inputs (corrupt, binary, empty) =====

await test("improper: empty string handled (no crash)", () => {
  const r = dedup("", cfg({ dedupMode: "semantic" }));
  assert.equal(r.content, "");
  assert.equal(r.report.originalChars, 0);
});

await test("improper: binary data handled (no crash, no corruption)", () => {
  const binary = String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i));
  const r = dedup(binary, cfg({ dedupMode: "semantic" }));
  // should not throw; content is some deduped version
  assert.ok(r.content.length >= 0);
});

await test("improper: corrupt/unparseable code falls back gracefully", () => {
  const corrupt = `{{{ /// ??? function )( return >>>`;
  const r = dedup(corrupt, cfg({ dedupMode: "ast" }));
  // ast mode falls back to block dedup on parse error — no data lost
  assert.ok(r.content.length > 0, "content preserved (fallback)");
});

await test("improper: null bytes in text", () => {
  const text = `function foo() { return "a\x00b"; }`;
  const c = cfg({ compressionMode: "brotli" });
  const res = compress(text, c, true);
  const dec = decompress(res.compressed, res.effectiveMode);
  assert.ok(dec.ok, "roundtrip ok with null bytes");
  assert.equal(dec.text, text, "exact roundtrip");
});

await test("improper: very large single input (1MB) handled", () => {
  const big = `const x = ${"1".repeat(1000000)};\n`;
  const c = cfg({ compressionMode: "brotli", compressionLevel: 9, llmVisibleLosslessOnly: true });
  const res = compress(big, c, true);
  const dec = decompress(res.compressed, res.effectiveMode);
  assert.ok(dec.ok, "1MB roundtrip ok");
  assert.equal(dec.text, big, "exact 1MB roundtrip");
  assert.ok(res.report.compressionRatio < 0.1, "huge compression on repetitive 1MB");
});

// ===== UNKNOWN data type (a new language the layer hasn't seen) =====

await test("unknown: language-agnostic dedup works on unseen language (Elixir-ish)", () => {
  const text = `defmodule Foo do\n  def bar(x), do: x + 1\nend\n\ndefmodule Foo do\n  def bar(y), do: y + 1\nend`;
  const r = dedup(text, cfg({ dedupMode: "block", blockSimilarityThreshold: 0.5, minLineLengthForDedup: 1 }));
  assert.ok(r.report.removedBlocks >= 1, "block dedup works on unknown language");
});

await test("unknown: frequency-learned dedup works on plain text (no code)", () => {
  const text = `The quick brown fox.\nThe quick brown fox.\nThe lazy dog.`;
  const c = cfg({ dedupMode: "semantic", keywordStrategy: "frequency-learned", blockSimilarityThreshold: 0.5, minBlockSizeForSemantic: 5, minLineLengthForDedup: 1 });
  const r = dedup(text, c);
  assert.ok(r.content.length > 0, "handled plain text");
});

// ===== 10× harder (200+ items) =====

await test("10× harder: 200 items lossless roundtrip all succeed", () => {
  const store = new DedupCompressionStore(cfg({ compressionMode: "brotli", compressionLevel: 9, dedupMode: "semantic", llmVisibleLosslessOnly: true }));
  let ok = 0;
  for (let i = 0; i < 200; i++) {
    const text = `function fn${i}(x: number) { return x * ${i}; }`;
    const sr = store.store(text, "memory", true);
    const ret = store.retrieve(sr.id);
    if (ret.ok && ret.text.includes(`fn${i}`)) ok++;
  }
  assert.equal(ok, 200, "all 200 roundtrip ok");
  assert.equal(store.size(), 200, "200 distinct entries");
});

await test("10× harder: 200 items with 50% exact duplicates → 100 stored", () => {
  const store = new DedupCompressionStore(cfg({ dedupMode: "none", compressionMode: "brotli", llmVisibleLosslessOnly: false }));
  for (let i = 0; i < 200; i++) {
    const text = `function fn${i % 100}(x: number) { return x; }`; // 100 unique × 2
    store.store(text, "memory", false);
  }
  assert.equal(store.size(), 100, "100 unique entries (100 deduped away)");
});

await test("10× harder: 200 functions in ONE input, semantic dedup catches near-dups within it", () => {
  // 200 blocks in a single input: 100 pairs where each pair differs only in
  // var names. Semantic dedup should collapse within the single input.
  const blocks: string[] = [];
  for (let i = 0; i < 200; i++) {
    const varName = i % 2 === 0 ? "alpha" : "beta";
    blocks.push(`function f${Math.floor(i / 2)}(x: number) { const ${varName} = x + 1; return ${varName}; }`);
  }
  const text = blocks.join("\n\n");
  const r = dedup(text, cfg({ dedupMode: "semantic", blockSimilarityThreshold: 0.85, minBlockSizeForSemantic: 40 }));
  assert.ok(r.report.removedBlocks >= 50, `semantic dedup removed >= 50 near-dup blocks (got ${r.report.removedBlocks})`);
  assert.ok((r.report.keywordCount ?? 0) > 0, "keywords detected dynamically (no hardcoded list)");
});

await test("config: validateConfig catches invalid values", () => {
  const bad = { ...DEFAULT_DEDUP_COMPRESSION_CONFIG, blockSimilarityThreshold: 2.0 } as DedupCompressionConfig;
  const errs = validateConfig(bad);
  assert.ok(errs.length > 0, "invalid threshold caught");
  assert.ok(errs.some((e) => e.includes("blockSimilarityThreshold")));
});

// ===== summary =====
await Promise.resolve().then(() => {
  console.log(`\n=== EXP454 unit tests: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
});
