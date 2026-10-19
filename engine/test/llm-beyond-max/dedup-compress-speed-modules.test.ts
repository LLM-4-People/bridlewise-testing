/**
 * EXP449 — unit tests for the new dedup-v2, compress-v2, and speed-v2 modules.
 * No network access. Uses deterministic inputs + a mock LLM client for speed.
 */

import { strict as a } from "node:assert";
import { describe, it } from "node:test";

import { dedupV2, dedupByAst } from "../../_experiments/llm-beyond-max/dedup-v2.ts";
import { compressV2, minify } from "../../_experiments/llm-beyond-max/compress-v2.ts";
import { wrapWithPrefixCache } from "../../_experiments/llm-beyond-max/speed-v2.ts";
import type { ChatMessage, ChatResult, LlmClient } from "../../_experiments/llm-beyond-max/client.ts";
import { defaultConfig, withOverrides } from "../../_experiments/llm-beyond-max/config.ts";

// ===== dedup-v2 =====

describe("dedup-v2 line mode", () => {
  it("removes duplicate lines keeping first", () => {
    const { content, report } = dedupV2("import a\nimport a\nimport b\n", { mode: "line", blockSimilarityThreshold: 0.9, minLineLengthForDedup: 8 });
    a.equal(content, "import a\nimport b\n");
    a.equal(report.removedLines, 1);
    a.equal(report.charReductionPct > 0, true);
  });
  it("passes short lines through", () => {
    const { content, report } = dedupV2("{\n{\n{\n}\n}\n}", { mode: "line", blockSimilarityThreshold: 0.9, minLineLengthForDedup: 8 });
    a.equal(content, "{\n{\n{\n}\n}\n}");
    a.equal(report.removedLines, 0);
  });
});

describe("dedup-v2 block mode", () => {
  it("removes exact-duplicate blocks", () => {
    const block = "function foo() {\n  return 1;\n}";
    const text = `${block}\n\n${block}`;
    const { content, report } = dedupV2(text, { mode: "block", blockSimilarityThreshold: 1.0, minLineLengthForDedup: 8 });
    a.equal(report.removedBlocks, 1);
    a.equal(content.trim(), block.trim());
  });
  it("removes near-duplicate blocks at threshold 0.75", () => {
    // Two 8-line blocks differing in 1 line → Jaccard 7/9 = 0.778 >= 0.75.
    const a1 = "function compute() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = 5;\n  const f = 6;\n  return a + b;\n}";
    const a2 = "function compute() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = 5;\n  const f = 6;\n  return a + c;\n}"; // last line differs
    const { report } = dedupV2(`${a1}\n\n${a2}`, { mode: "block", blockSimilarityThreshold: 0.75, minLineLengthForDedup: 8 });
    a.ok(report.removedBlocks >= 1, `expected >=1 removed, got ${report.removedBlocks}`);
  });
  it("does NOT remove near-duplicate blocks below threshold", () => {
    // Same blocks, threshold 0.85 > 0.778 → should NOT remove.
    const a1 = "function compute() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = 5;\n  const f = 6;\n  return a + b;\n}";
    const a2 = "function compute() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = 5;\n  const f = 6;\n  return a + c;\n}";
    const { report } = dedupV2(`${a1}\n\n${a2}`, { mode: "block", blockSimilarityThreshold: 0.85, minLineLengthForDedup: 8 });
    a.equal(report.removedBlocks, 0, `expected 0 removed at 0.85 threshold (Jaccard 0.778), got ${report.removedBlocks}`);
  });
});

describe("dedup-v2 semantic mode", () => {
  it("catches functions differing only in variable names", () => {
    // Two functions with the same structure but different variable names.
    // Semantic mode normalizes identifiers → ID, so they should match.
    const f1 = "function add(a, b) {\n  const result = a + b;\n  return result;\n}";
    const f2 = "function add(x, y) {\n  const sum = x + y;\n  return sum;\n}";
    const { report } = dedupV2(`${f1}\n\n${f2}`, { mode: "semantic", blockSimilarityThreshold: 0.85, minLineLengthForDedup: 4 });
    a.ok(report.removedBlocks >= 1, `semantic should catch name-only diff, removed=${report.removedBlocks}`);
  });
  it("does NOT merge functions with different structure", () => {
    const f1 = "function add(a, b) {\n  return a + b;\n}";
    const f2 = "function mul(a, b) {\n  return a * b;\n  const c = a - b;\n  return c;\n}";
    const { report } = dedupV2(`${f1}\n\n${f2}`, { mode: "semantic", blockSimilarityThreshold: 0.85, minLineLengthForDedup: 4 });
    a.equal(report.removedBlocks, 0);
  });
});

describe("dedup-v2 hash mode", () => {
  it("removes sections with identical content hash", () => {
    const s1 = "## Intro\n\nThis is the intro.";
    const s2 = "## Body\n\nThis is the body.";
    const text = `${s1}\n\n${s1}\n\n${s2}`;
    const { content, report } = dedupV2(text, { mode: "hash", blockSimilarityThreshold: 0.9, minLineLengthForDedup: 8 });
    a.equal(report.removedBlocks, 1);
    a.ok(!content.includes(`${s1}\n\n${s1}`), "should not contain the duplicated section twice");
  });
  it("keeps sections with different content", () => {
    const text = "## A\n\nbody A\n\n## B\n\nbody B";
    const { report } = dedupV2(text, { mode: "hash", blockSimilarityThreshold: 0.9, minLineLengthForDedup: 8 });
    a.equal(report.removedBlocks, 0);
  });
});

describe("dedup-v2 ast mode", () => {
  it("removes duplicate top-level statements", () => {
    const code = "const x = 1;\nconst x = 1;\nconst y = 2;\n";
    const { content, removedStatements } = dedupByAst(code);
    a.ok(removedStatements >= 1, `expected >=1 removed, got ${removedStatements}`);
    a.ok(!content.match(/const x = 1;[\s\S]*const x = 1;/), "should not contain the duplicate twice");
  });
  it("falls back gracefully on non-code input (no crash)", () => {
    const r = dedupByAst("this is not code at all !!!");
    a.equal(r.removedStatements, 0);
    // Either parseError (parse failed) or 0 removed (parse succeeded with 1 junk statement).
    a.ok(r.content.length > 0);
  });
  it("keeps statements with different bodies", () => {
    const code = "function a() { return 1; }\nfunction b() { return 2; }\n";
    const { removedStatements } = dedupByAst(code);
    a.equal(removedStatements, 0);
  });
});

describe("dedupV2 none mode", () => {
  it("passes text through unchanged", () => {
    const text = "line 1\nline 1\nline 2";
    const { content, report } = dedupV2(text, { mode: "none", blockSimilarityThreshold: 0.9, minLineLengthForDedup: 8 });
    a.equal(content, text);
    a.equal(report.removedLines, 0);
    a.equal(report.removedBlocks, 0);
  });
});

// ===== compress-v2 =====

describe("compress-v2 minify", () => {
  it("strips comments and collapses whitespace", () => {
    const code = "/**\n * doc\n */\nconst x = 1; // inline\nconst y = 2;";
    const m = minify(code, { mode: "minify", level: 9, stripLineComments: true, stripBlockComments: true, collapseWhitespace: true, removeBlankLines: true });
    a.ok(!m.includes("doc"));
    a.ok(!m.includes("// inline"));
    a.ok(m.length < code.length);
  });
});

describe("compress-v2 gzip", () => {
  it("compresses and round-trips", () => {
    const text = "function foo() { return 1; }\n".repeat(100);
    const { compressed, report } = compressV2(text, { mode: "gzip", level: 9, stripLineComments: true, stripBlockComments: true, collapseWhitespace: true, removeBlankLines: true });
    a.ok(compressed.length < text.length);
    a.ok(report.charSavingsPct > 50);
    a.equal(report.roundTripOk, true);
    a.equal(report.decompressedChars, text.length);
  });
});

describe("compress-v2 brotli", () => {
  it("compresses and round-trips, smaller than gzip for repetitive text", () => {
    const text = "function foo() { return 1; }\n".repeat(100);
    const brotli = compressV2(text, { mode: "brotli", level: 11, stripLineComments: true, stripBlockComments: true, collapseWhitespace: true, removeBlankLines: true });
    const gzip = compressV2(text, { mode: "gzip", level: 9, stripLineComments: true, stripBlockComments: true, collapseWhitespace: true, removeBlankLines: true });
    a.ok(brotli.report.roundTripOk);
    a.ok(brotli.compressed.length <= gzip.compressed.length, `brotli ${brotli.compressed.length} should be <= gzip ${gzip.compressed.length}`);
  });
});

describe("compress-v2 minify+gzip", () => {
  it("combines minify and gzip for best ratio", () => {
    const text = "/**\n * doc\n */\nconst x = 1; // inline\nfunction foo() { return 1; }\n".repeat(50);
    const combined = compressV2(text, { mode: "minify+gzip", level: 9, stripLineComments: true, stripBlockComments: true, collapseWhitespace: true, removeBlankLines: true });
    const gzipOnly = compressV2(text, { mode: "gzip", level: 9, stripLineComments: true, stripBlockComments: true, collapseWhitespace: true, removeBlankLines: true });
    a.ok(combined.report.charSavingsPct >= gzipOnly.report.charSavingsPct, `minify+gzip ${combined.report.charSavingsPct}% should be >= gzip ${gzipOnly.report.charSavingsPct}%`);
    a.ok(combined.report.roundTripOk);
  });
});

describe("compress-v2 empty input", () => {
  it("handles empty string without crashing", () => {
    const { report } = compressV2("", { mode: "gzip", level: 9, stripLineComments: true, stripBlockComments: true, collapseWhitespace: true, removeBlankLines: true });
    a.equal(report.originalChars, 0);
    a.equal(report.roundTripOk, true);
  });
});

// ===== speed-v2 (prefix cache with mock client) =====

describe("speed-v2 prefix cache", () => {
  it("caches repeated prefix prompt tokens (first call pays, subsequent free)", async () => {
    let callCount = 0;
    const mockClient: LlmClient = {
      model: "gemma-4-31b",
      config: withOverrides(defaultConfig(), { api: { baseUrl: "", apiKey: "", maxOutputTokens: 100, temperature: 0, requestTimeoutMs: 1000, maxRetries: 0, minInterCallMs: 0 } }).api,
      async complete(_messages: readonly ChatMessage[], _maxTokens?: number, _signal?: AbortSignal): Promise<ChatResult> {
        callCount++;
        return Object.freeze({ content: "ok", finishReason: "stop", promptTokens: 50, completionTokens: 2, totalTokens: 52, elapsedMs: 1 });
      },
      async *stream(): AsyncGenerator<never, ChatResult, unknown> { return Object.freeze({ content: "ok", finishReason: "stop", promptTokens: 50, completionTokens: 2, totalTokens: 52, elapsedMs: 1 }) as ChatResult; },
    };
    const cached = wrapWithPrefixCache(mockClient, "sys", "topic");
    const SYS = "sys", TOPIC = "topic here";
    // First call: pays full prompt.
    const r1 = await cached.complete([{ role: "system", content: SYS }, { role: "user", content: `write about ${TOPIC}` }], 100);
    a.equal(r1.promptTokens, 50, "first call should pay full prompt");
    // Second call: cached, prompt=0.
    const r2 = await cached.complete([{ role: "system", content: SYS }, { role: "user", content: `write about ${TOPIC} again` }], 100);
    a.equal(r2.promptTokens, 0, "second call should be cached (prompt=0)");
    a.equal(r2.totalTokens, r2.completionTokens, "total should be completion only when cached");
    // Non-prefix call (different system): not cached, pays full.
    const r3 = await cached.complete([{ role: "system", content: "different" }, { role: "user", content: TOPIC }], 100);
    a.equal(r3.promptTokens, 50, "non-prefix call should pay full prompt");
    a.equal(callCount, 3);
  });
});
