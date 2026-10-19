/**
 * EXP410 — unit tests for the deterministic pieces.
 *
 * No network access. Validates the token estimator, coherence checker,
 * overlap detector, and config validator. The LLM-dependent modules are
 * covered by integration tests in scripts/exp410-*.ts.
 */

import { strict as a } from "node:assert";
import { describe, it } from "node:test";

import { estimateTokens, estimateCharsForTokens, trailingContext, leadingContext, overlapLength, isRepeat } from "../../_experiments/llm-beyond-max/tokens.ts";
import { assessCoherence } from "../../_experiments/llm-beyond-max/coherence.ts";
import { defaultConfig, withOverrides, validateConfig } from "../../_experiments/llm-beyond-max/config.ts";

describe("tokens.estimateTokens", () => {
  it("estimates 1 token per 4 chars", () => {
    a.equal(estimateTokens(""), 0);
    a.equal(estimateTokens("abcd"), 1);
    a.equal(estimateTokens("abcdefgh"), 2);
  });
  it("rounds to nearest token", () => {
    a.equal(estimateTokens("ab"), 1);
    a.equal(estimateTokens("abcde"), 1);
  });
  it("round-trips with estimateCharsForTokens", () => {
    const t = 100;
    const chars = estimateCharsForTokens(t);
    a.equal(estimateTokens("x".repeat(chars)), t);
  });
});

describe("tokens.trailingContext", () => {
  it("returns the whole text if shorter than chars", () => {
    a.equal(trailingContext("hello", 10), "hello");
  });
  it("snaps to a word boundary", () => {
    const out = trailingContext("the quick brown fox jumps", 10);
    a.ok(out.length <= 10);
    a.ok(!out.startsWith(" "), `expected no leading space, got: ${out}`);
  });
});

describe("tokens.leadingContext", () => {
  it("returns the whole text if shorter than chars", () => {
    a.equal(leadingContext("hello", 10), "hello");
  });
  it("snaps to a word boundary", () => {
    const out = leadingContext("the quick brown fox jumps", 10);
    a.ok(out.length <= 10);
    a.ok(!out.endsWith(" "), `expected no trailing space, got: ${out}`);
  });
});

describe("tokens.overlapLength", () => {
  it("detects suffix-prefix overlap", () => {
    a.equal(overlapLength("hello world", "world peace"), 5);
  });
  it("returns 0 when there is no overlap", () => {
    a.equal(overlapLength("abc", "xyz"), 0);
  });
  it("handles empty strings", () => {
    a.equal(overlapLength("", "abc"), 0);
    a.equal(overlapLength("abc", ""), 0);
  });
});

describe("tokens.isRepeat", () => {
  it("detects when next is a repeat of the end of prev", () => {
    // minRepeatChars default is 200; ensure both prev and next are long enough.
    const tail = "the quick brown fox jumps over the lazy dog. ".repeat(6);
    const next = "the quick brown fox jumps over the lazy dog. ".repeat(6);
    a.equal(isRepeat(tail, next), true);
  });
  it("returns false for genuinely new content", () => {
    a.equal(isRepeat("the quick brown fox", "now we discuss something entirely new"), false);
  });
  it("returns false for short next content", () => {
    a.equal(isRepeat("prev", "abc"), false);
  });
});

describe("assessCoherence", () => {
  it("scores a clean document at 1.0", () => {
    const text = "# Title\n\nThis is a clean essay about AST traversal. It covers visitors, scopes, bindings, and types. The code blocks are balanced:\n\n```\nconst x = 1;\n```\n\nMore text follows about performance considerations.";
    const r = assessCoherence(text);
    a.ok(r.score >= 0.9, `score=${r.score} notes=${r.notes.join("; ")}`);
    a.equal(r.codeFenceCount, 2);
    a.equal(r.headingCount, 1);
  });
  it("penalizes repetition", () => {
    // A long run of the same character: every 200-char window is identical.
    const repeat = "A".repeat(2000);
    const r = assessCoherence(repeat);
    a.ok(r.repetitionScore < 1.0, `repetitionScore=${r.repetitionScore}`);
    a.ok(r.repeatLoops > 0, `repeatLoops=${r.repeatLoops}`);
    a.ok(r.score < 1.0, `score=${r.score}`);
  });
  it("flags unbalanced code fences", () => {
    const text = "# Title\n\n```\nconst x = 1;\n";
    const r = assessCoherence(text);
    a.equal(r.codeFenceCount, 1);
    a.ok(r.notes.includes("unbalanced code fences"));
  });
});

describe("config.validateConfig", () => {
  it("accepts the default config", () => {
    a.equal(validateConfig(defaultConfig()), null);
  });
  it("rejects oversized overlap", () => {
    const c = withOverrides(defaultConfig(), { slidingWindow: { overlapTokens: 600, windowTokens: 500 } });
    const err = validateConfig(c);
    a.ok(err !== null && err.includes("overlap"), err ?? "no error");
  });
  it("rejects zero concurrency", () => {
    const c = withOverrides(defaultConfig(), { mapReduce: { concurrency: 0, llmReduce: false } });
    const err = validateConfig(c);
    a.ok(err !== null && err.includes("concurrency"), err ?? "no error");
  });
});

describe("config.withOverrides", () => {
  it("merges one level deep", () => {
    const base = defaultConfig();
    const o = withOverrides(base, { api: { maxOutputTokens: 1000 } });
    a.equal(o.api.maxOutputTokens, 1000);
    a.equal(o.api.baseUrl, base.api.baseUrl);
    a.equal(o.continuation.maxContinuations, base.continuation.maxContinuations);
  });
});
