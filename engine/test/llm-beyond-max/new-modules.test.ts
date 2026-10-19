/**
 * EXP410 — unit tests for the new modules (parallel-chunker, dedup, compress).
 *
 * No network access. Validates the deterministic pieces:
 * - dedup: line-mode, block-mode, Jaccard threshold.
 * - compress: minify strips comments + collapses whitespace; prettify adds
 * newlines; round-trip preserves brace balance.
 * - config: new sections validate.
 */

import { strict as a } from "node:assert";
import { describe, it } from "node:test";

import { dedup, dedupLines, dedupBlocks, countLines, countBlocks } from "../../_experiments/llm-beyond-max/dedup.ts";
import { minify, prettify, compressAndReport, MINIFY_SYSTEM_PROMPT, DEFAULT_COMPRESSION } from "../../_experiments/llm-beyond-max/compress.ts";
import { defaultConfig, withOverrides, validateConfig } from "../../_experiments/llm-beyond-max/config.ts";

describe("dedup.dedupLines", () => {
  it("removes exact duplicate lines (keep first)", () => {
    const input = "import a from 'a';\nimport b from 'b';\nimport a from 'a';\nconst x = 1;";
    const { content, removed } = dedupLines(input, 8);
    a.equal(removed, 1);
    a.equal(content, "import a from 'a';\nimport b from 'b';\nconst x = 1;");
  });
  it("ignores whitespace differences (trimmed match)", () => {
    const input = "  const x = 1;\nconst x = 1;\nconst y = 2;";
    const { content, removed } = dedupLines(input, 8);
    a.equal(removed, 1);
    a.ok(content.includes("const y = 2;"));
  });
  it("passes short lines through", () => {
    const input = "{\n}\n{\n}";
    const { content, removed } = dedupLines(input, 8);
    a.equal(removed, 0);
    a.equal(content, input);
  });
});

describe("dedup.dedupBlocks", () => {
  it("removes identical blocks", () => {
    const block = "function foo() {\n  return 1;\n}";
    const input = `${block}\n\n${block}\n\nfunction bar() {\n  return 2;\n}`;
    const { content, removedBlocks } = dedupBlocks(input, 0.9, 8);
    a.equal(removedBlocks, 1);
    a.ok(content.includes("function bar"));
    a.ok(!content.includes("function foo() {\n  return 1;\n}\n\nfunction foo"));
  });
  it("removes near-identical blocks (Jaccard >= threshold)", () => {
    const block1 = "function foo(a, b) {\n  return a + b;\n}";
    const block2 = "function foo(a, b) {\n  return a + b;\n  // note\n}";
    const input = `${block1}\n\n${block2}\n\nfunction bar() {\n  return 2;\n}`;
    const { removedBlocks } = dedupBlocks(input, 0.5, 8);
    a.equal(removedBlocks, 1);
  });
  it("keeps distinct blocks", () => {
    const input = "function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}";
    const { removedBlocks } = dedupBlocks(input, 0.9, 8);
    a.equal(removedBlocks, 0);
  });
});

describe("dedup.dedup (mode switch)", () => {
  it("mode=none is a passthrough", () => {
    const input = "a\na\na";
    const { content, report } = dedup(input, { mode: "none", blockSimilarityThreshold: 0.9, minLineLengthForDedup: 8 });
    a.equal(content, input);
    a.equal(report.removedLines, 0);
    a.equal(report.charReductionPct, 0);
  });
  it("mode=line reports line reduction", () => {
    const input = "import a from 'a';\nimport a from 'a';\nconst longline = 1;";
    const { content, report } = dedup(input, { mode: "line", blockSimilarityThreshold: 0.9, minLineLengthForDedup: 8 });
    a.ok(report.lineReductionPct > 0);
    a.ok(!content.includes("import a from 'a';\nimport a from 'a';"));
  });
});

describe("dedup.countLines / countBlocks", () => {
  it("counts lines", () => {
    a.equal(countLines("a\nb\nc"), 3);
    a.equal(countLines(""), 0);
  });
  it("counts blocks (blank-line-separated)", () => {
    a.equal(countBlocks("a\nb\n\nc\nd"), 2);
    a.equal(countBlocks(""), 0);
    a.equal(countBlocks("just one block"), 1);
  });
});

describe("compress.minify", () => {
  it("strips line comments", () => {
    const input = "const x = 1; // comment\nconst y = 2;";
    const out = minify(input, { ...DEFAULT_COMPRESSION, stripBlockComments: false });
    a.ok(!out.includes("// comment"));
    a.ok(out.includes("const y = 2;"));
  });
  it("strips block comments and JSDoc", () => {
    const input = "/**\n * JSDoc\n */\nfunction foo() {\n  return 1;\n}\n/* inline */\nconst x = 2;";
    const out = minify(input, { ...DEFAULT_COMPRESSION, stripLineComments: false });
    a.ok(!out.includes("JSDoc"));
    a.ok(!out.includes("inline"));
    a.ok(out.includes("function foo"));
  });
  it("collapses whitespace", () => {
    const input = "const    x   =   1;";
    const out = minify(input, { ...DEFAULT_COMPRESSION, stripLineComments: false, stripBlockComments: false });
    a.ok(!out.includes("    "));
  });
  it("removes blank lines", () => {
    const input = "a\n\n\nb\n\n";
    const out = minify(input, { ...DEFAULT_COMPRESSION, stripLineComments: false, stripBlockComments: false });
    a.ok(!out.includes("\n\n"));
  });
  it("mode=none is a passthrough", () => {
    const input = "const x = 1; // comment";
    const out = minify(input, { mode: "none", stripLineComments: true, stripBlockComments: true, collapseWhitespace: true, removeBlankLines: true });
    a.equal(out, input);
  });
});

describe("compress.prettify", () => {
  it("adds newlines after semicolons and braces", () => {
    const min = "function foo(){return 1;}";
    const pretty = prettify(min);
    a.ok(pretty.includes("\n"));
    a.ok(pretty.split("\n").length >= 3);
  });
  it("indents based on brace nesting", () => {
    const min = "function foo(){const x=1;return x;}";
    const pretty = prettify(min);
    const lines = pretty.split("\n");
    a.ok(lines.some((l) => l.startsWith("  ")));
  });
  it("preserves brace balance", () => {
    const min = "function foo(){if(true){return 1;}return 2;}";
    const pretty = prettify(min);
    const opens = (pretty.match(/\{/g) ?? []).length;
    const closes = (pretty.match(/\}/g) ?? []).length;
    a.equal(opens, closes);
  });
});

describe("compress.compressAndReport", () => {
  it("reports a compression ratio < 1 for minifiable input", () => {
    const input = "/**\n * JSDoc\n */\nfunction foo() {\n  // comment\n  return 1;\n}\n\n\nconst x = 2;";
    const { report } = compressAndReport(input, DEFAULT_COMPRESSION);
    a.ok(report.compressionRatio < 1, `expected ratio < 1, got ${report.compressionRatio}`);
    a.ok(report.charSavingsPct > 0);
    a.ok(report.expansionRatio >= 1, `expected expansion >= 1, got ${report.expansionRatio}`);
  });
  it("mode=none reports ratio = 1", () => {
    const input = "const x = 1;";
    const { report } = compressAndReport(input, { mode: "none", stripLineComments: true, stripBlockComments: true, collapseWhitespace: true, removeBlankLines: true });
    a.equal(report.compressionRatio, 1);
    a.equal(report.charSavingsPct, 0);
  });
});

describe("compress.MINIFY_SYSTEM_PROMPT", () => {
  it("tells the model to emit minified TypeScript", () => {
    a.ok(MINIFY_SYSTEM_PROMPT.includes("minified"));
    a.ok(MINIFY_SYSTEM_PROMPT.includes("no JSDoc"));
    a.ok(MINIFY_SYSTEM_PROMPT.includes("no comments"));
  });
});

describe("config.newSections", () => {
  it("default config has parallelChunker + dedup + compression", () => {
    const c = defaultConfig();
    a.equal(c.parallelChunker.concurrency, 5);
    a.equal(c.parallelChunker.sectionCount, 10);
    a.equal(c.dedup.mode, "line");
    a.equal(c.compression.mode, "minify");
  });
  it("withOverrides merges the new sections one level deep", () => {
    const c = withOverrides(defaultConfig(), {
      parallelChunker: { sectionCount: 20 },
      dedup: { mode: "block" },
      compression: { mode: "none" },
    });
    a.equal(c.parallelChunker.sectionCount, 20);
    a.equal(c.parallelChunker.concurrency, 5);
    a.equal(c.dedup.mode, "block");
    a.equal(c.dedup.blockSimilarityThreshold, 0.9);
    a.equal(c.compression.mode, "none");
    a.equal(c.compression.stripLineComments, true);
  });
  it("validateConfig rejects bad new values", () => {
    a.ok(validateConfig(withOverrides(defaultConfig(), { parallelChunker: { sectionCount: 0 } })) !== null);
    a.ok(validateConfig(withOverrides(defaultConfig(), { parallelChunker: { concurrency: 0 } })) !== null);
    a.ok(validateConfig(withOverrides(defaultConfig(), { parallelChunker: { concurrency: 99 } })) !== null);
    a.ok(validateConfig(withOverrides(defaultConfig(), { dedup: { blockSimilarityThreshold: 0.3 } })) !== null);
    a.ok(validateConfig(withOverrides(defaultConfig(), { compression: { mode: "invalid" as "minify" } })) !== null);
  });
});
