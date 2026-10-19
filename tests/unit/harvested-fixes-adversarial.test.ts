// @vitest-environment node
/**
 * ADVERSARIAL behavioral tests for the harvested-issue fixes.
 *
 * Covers:
 * recordSummaryTurn redacts PII BEFORE topic extraction.
 * QuickViewIndex rehydrate round-trip (the off-thread build's
 * serialization seam — toBuiltState/fromBuiltState preserve query AND
 * drop the heavy AST cache).
 * quality scoring is config-driven (a weight of 0 disables a
 * penalty; scoreMax/scoreMin are respected — no inline literals).
 *
 * Escalates difficulty: a credential pasted as the FIRST meaningful word
 * (the topic-extraction path would leak PART of the secret without the
 * redactor); a synthetic config that zeroes every penalty (must yield the
 * max score); a built-from-scratch fixture codebase for the rehydrate
 * round-trip (real babel parse, not a stub).
 */
import { describe, test, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import {
  createUnifiedContextManager,
  type TopicRedactor,
} from "../../engine/src/memory/unified/unified-context-manager.ts";
import { resolveUnifiedConfig } from "../../engine/src/memory/unified/unified-config.ts";
import { QuickViewIndex } from "../../engine/src/intelligence/quick-view.ts";
import { computeScore } from "../../server/awareness/quality-bridge.ts";
import { getQualityConfig } from "../../server/kernel/harness-config.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

// ── recordSummaryTurn PII redaction ──

/**
 * A redactor that masks an OpenAI-style `sk-...` key (the same shape the
 * canonical redaction-engine targets). Mirrors redactForLLMContext's
 * value-only masking for the topic-extraction seam (the real engine is
 * injected in production; this stand-in keeps the test hermetic — no
 * dependency on the secret-signals catalog).
 */
const MASK_SK: TopicRedactor = (s) => s.replace(/sk-[a-z0-9]+/gi, "[REDACTED:credential]");
const IDENTITY: TopicRedactor = (s) => s;

describe("— recordSummaryTurn redacts PII before topic extraction", () => {
  test("WITHOUT a redactor the raw secret leaks into the summary topic (the bug)", () => {
    const cm = createUnifiedContextManager(resolveUnifiedConfig(), undefined, undefined, IDENTITY);
    // The secret is the FIRST meaningful (>2 char) token, so extractTopic
    // would pick "secretvalue" as the topic keyword — a partial secret leak.
    cm.recordSummaryTurn(1, "sk-secretvalue is my api key", "sure, here is the plan");
    const block = cm.state().conversationSummaryBlock;
    expect(block, "block must mention the turn").toContain("T1:");
    // This is the BUG (identity redactor) — the secret fragment leaks.
    expect(block).toContain("secretvalue");
  });

  test("WITH a redactor the secret is masked BEFORE topic extraction (the fix)", () => {
    const cm = createUnifiedContextManager(resolveUnifiedConfig(), undefined, undefined, MASK_SK);
    cm.recordSummaryTurn(1, "sk-secretvalue is my api key", "sure, here is the plan");
    const block = cm.state().conversationSummaryBlock;
    expect(block).toContain("T1:");
    // The fix: the redacted content's first token is the "[REDACTED...]"
    // marker, so the topic is "redacted"the raw secret NEVER reaches the
    // stored summary topic.
    expect(block, "raw secret must not leak into the summary topic").not.toContain("secretvalue");
    expect(block, "the redaction marker becomes the topic").toContain("redacted");
  });

  test("the redactor applies to BOTH the user + assistant messages", () => {
    const cm = createUnifiedContextManager(resolveUnifiedConfig(), undefined, undefined, MASK_SK);
    // The user message has no usable token (only a stopword + secret); the
    // assistant message carries the secret. extractTopic falls back to the
    // assistant tokens — which must ALSO be redacted.
    cm.recordSummaryTurn(2, "please", "the key is sk-leakedtoken from the env");
    const block = cm.state().conversationSummaryBlock;
    expect(block, "assistant-side secret must not leak").not.toContain("leakedtoken");
  });

  test("the default (no redactor injected) is identity — existing backend callers are unaffected", () => {
    // Backend runtime callers pass no redactor → identity (additive seam, no
    // behavior change for non-web callers). The topic is extracted from raw
    // content exactly as before.
    const cm = createUnifiedContextManager(resolveUnifiedConfig());
    cm.recordSummaryTurn(1, "refactor the parser module", "done");
    const block = cm.state().conversationSummaryBlock;
    expect(block).toContain("refactor");
  });
});

// ── QuickViewIndex rehydrate round-trip (off-thread build seam) ──

let fixtureRoot = "";

beforeAll(() => {
  fixtureRoot = createTempDir("qv-rehydrate-");
  mkdirSync(join(fixtureRoot, "src"), { recursive: true });
  mkdirSync(join(fixtureRoot, "test"), { recursive: true });
  writeFileSync(
    join(fixtureRoot, "src", "alpha.ts"),
    "export function alpha(x: number): number { return x + 1; }\nexport function caller(): number { return alpha(41); }\n",
  );
  writeFileSync(
    join(fixtureRoot, "test", "alpha.test.ts"),
    'import { alpha } from "../src/alpha";\nfunction run() { return alpha(1); }\n',
  );
});

describe("— QuickViewIndex rehydrate round-trip (toBuiltState/fromBuiltState)", () => {
  test("a rehydrated index answers identically to the directly-built index", () => {
    const original = new QuickViewIndex(fixtureRoot);
    const state = original.toBuiltState();
    const rehydrated = QuickViewIndex.fromBuiltState(state);
    const a = original.query("alpha");
    const b = rehydrated.query("alpha");
    // The rehydrated index must produce the EXACT same structured view
    // (definition, callers, tests, …) as the original — the serialization
    // seam is lossless for everything query reads.
    expect(b).toEqual(a);
    // Sanity: the fixture actually indexed something (the test is meaningful).
    expect(a.totals.definition).toBeGreaterThan(0);
    expect(a.totals.callers).toBeGreaterThan(0);
  });

  test("the rehydrated index DROPS the heavy AST cache (the wedge-fix payoff)", () => {
    const original = new QuickViewIndex(fixtureRoot);
    const state = original.toBuiltState();
    const rehydrated = QuickViewIndex.fromBuiltState(state);
    // programByPath is the full babel AST of every file — the memory + CPU
    // cost that previously wedged the event loop. The rehydrated index must
    // NOT carry it (query only reads the index Maps).
    const internal = rehydrated as unknown as { programByPath?: Map<unknown, unknown>; fileLineCache?: Map<unknown, unknown> };
    expect(internal.programByPath, "AST cache must be dropped on rehydrate").toBeDefined();
    expect(internal.programByPath!.size, "AST cache must be EMPTY on rehydrate").toBe(0);
    expect(internal.fileLineCache, "line cache starts empty (lazy on consumer thread)").toBeDefined();
    expect(internal.fileLineCache!.size).toBe(0);
  });

  test("the rehydrated index lazily re-reads line context on the consumer thread", () => {
    const original = new QuickViewIndex(fixtureRoot);
    const rehydrated = QuickViewIndex.fromBuiltState(original.toBuiltState());
    // query reads call-site context via getLineContext, which lazily reads
    // the file on the consumer thread (fileLineCache was empty). After the
    // query the cache must be populated (proving lazy re-read works).
    const internal = rehydrated as unknown as { fileLineCache: Map<string, readonly string[] | null> };
    expect(internal.fileLineCache.size).toBe(0);
    const res = rehydrated.query("alpha");
    expect(res.totals.callers).toBeGreaterThan(0);
    // The caller context lines were fetched lazily → cache populated.
    expect(internal.fileLineCache.size, "line context was lazily loaded").toBeGreaterThan(0);
  });

  test("the built state is structured-cloneable (plain objects + entry arrays, no functions)", () => {
    const original = new QuickViewIndex(fixtureRoot);
    const state = original.toBuiltState();
    // postMessage uses structured clone, which fails on functions/proxies.
    // Round-trip through JSON (a stricter subset than structured clone) to
    // prove the state is plain data — Maps are entry arrays, no methods.
    const json = JSON.stringify(state);
    const back = JSON.parse(json) as typeof state;
    const rehydrated = QuickViewIndex.fromBuiltState(back);
    // Map entry arrays survive JSON (they're plain arrays); the rehydrated
    // index still answers (the round-trip is lossless for query).
    expect(rehydrated.query("alpha").totals).toEqual(original.query("alpha").totals);
  });
});

// ── quality scoring is config-driven (no inline literals) ──

describe("— computeScore is config-driven", () => {
  // A baseline set of signals that triggers every penalty under the default
  // config (so a weight change is observable in the score).
  const signals = { issueDensity: 0.5, issuesPerKloc: 20, hotspotCount: 10, cloneRatio: 0.5, typedFraction: 0.5 };

  test("the real config's quality weights match bridlewise.config.json (contract)", () => {
    const cfg = getQualityConfig();
    // The defaults the config file declares (webUi.quality) — the single
    // source of truth. These exact values are in bridlewise.config.json.
    expect(cfg.scoreMax).toBe(100);
    expect(cfg.scoreMin).toBe(0);
    expect(cfg.penaltyWeightIssueDensity).toBe(100);
    expect(cfg.penaltyCapIssueDensity).toBe(20);
    expect(cfg.penaltyWeightClones).toBe(30);
  });

  test("a weight of 0 DISABLES that penalty (0 is a valid config value)", () => {
    const defaults = getQualityConfig();
    const withZero = { ...defaults, penaltyWeightIssueDensity: 0, penaltyWeightClones: 0, penaltyWeightUntyped: 0, penaltyWeightHotspots: 0, penaltyWeightIssuesPerKloc: 0 };
    const scoreDefaults = computeScore(defaults, signals.issueDensity, signals.issuesPerKloc, signals.hotspotCount, signals.cloneRatio, signals.typedFraction);
    const scoreZero = computeScore(withZero, signals.issueDensity, signals.issuesPerKloc, signals.hotspotCount, signals.cloneRatio, signals.typedFraction);
    // Zeroing every weight removes every penalty → the score is the max.
    expect(scoreZero).toBe(defaults.scoreMax);
    expect(scoreZero, "zeroed weights must score higher than the defaults").toBeGreaterThan(scoreDefaults);
  });

  test("scoreMax/scoreMin are respected (the score is clamped to the configured range)", () => {
    const defaults = getQualityConfig();
    // Zero signals → no penalties → score is the configured max (scoreMax).
    const tinyMax = { ...defaults, scoreMax: 42, scoreMin: 0 };
    expect(computeScore(tinyMax, 0, 0, 0, 0, 1)).toBe(42);
    // Huge penalties → score drops below scoreMin → clamps to the configured min.
    const raisedMin = { ...defaults, scoreMax: 100, scoreMin: 55 };
    expect(computeScore(raisedMin, 1, 1000, 100, 1, 0)).toBe(55);
  });

  test("a penalty cap bounds each signal so one signal cannot single-handedly zero the score", () => {
    const defaults = getQualityConfig();
    // A single catastrophic signal (issuesPerKloc huge) is capped, so the
    // score only loses penaltyCapIssuesPerKloc — NOT the whole 100.
    const score = computeScore(defaults, 0, 1_000_000, 0, 0, 1);
    expect(score).toBe(defaults.scoreMax - defaults.penaltyCapIssuesPerKloc);
  });
});
