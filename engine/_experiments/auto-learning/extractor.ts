/**
 * EXP363 — Pattern extractor: deterministic, statistical pattern discovery.
 *
 * NO LLM. Pure frequency analysis over the collector's records:
 *   - Per type, count (type, cause) pairs.
 *   - Compute confidence = count / total-of-type.
 *   - Rank by count (or confidence, per config), tie-broken alphabetically.
 *   - Return the top-N per type meeting (minFrequency, minConfidence).
 *
 * Also reports `unknownTypes`: types present in the collector but NOT in the
 * config's known-causes catalog. These are NOVEL error classes the system
 * has DETECTED (logged) but cannot extract patterns for (no known causes).
 * This is the generalization path: the system logs novel errors even when it
 * cannot fix them.
 *
 * The extractor is the LEARNING step: it identifies WHICH error patterns
 * recur often enough to warrant a rule. It does NOT decide the rule (that's
 * the updater's job, via the deterministic policy table in config).
 */

import type { ErrorCollector } from "./collector.ts";
import type { LearningConfig } from "./config.ts";

/** A discovered recurring pattern. */
export interface Pattern {
  type: string;
  cause: string;
  count: number;
  /** count / total-of-type. 0..1. */
  confidence: number;
  /** 1 = most frequent within its type. */
  rank: number;
}

/** Result of extraction: patterns + novel types (generalization signal). */
export interface ExtractionResult {
  patterns: Pattern[];
  /** Types in the collector not in config.knownCauses (detected, no known causes). */
  unknownTypes: string[];
}

/**
 * Extract recurring patterns from the collector. Deterministic: given the
 * same collector + config, the output is identical (sorted, then tie-broken
 * by cause alphabetically for stable ordering).
 *
 * Per-type cap: `maxPatternsPerTypePerRound`. Global cap: `maxPatternsPerRound`.
 *
 * EXP389 BUG FIX: when `existingRules` is provided, patterns already covered
 * by an existing rule are skipped BEFORE the per-type cap. The EXP374
 * extractor returned the top-N patterns by count, then `novelPatterns`
 * filtered AFTER the cap — so when the top-N were already covered (e.g.
 * `ctx-*` rules admitted in R1 kept ranking #1-#2 for `tool-call-failed`
 * forever), NO new patterns were extracted for that type. The 20
 * `single-cause-tool-call-failed` errors never got rules — a real plateau
 * bug. The fix: skip covered patterns BEFORE the cap so the cap applies to
 * NOVEL patterns only. This is "extract novel patterns," not "extract top-N
 * then filter."
 */
export function extractPatterns(
  collector: ErrorCollector,
  config: LearningConfig,
  existingRules?: { spec: { type: string; causeMatch: string } }[],
): Pattern[] {
  const out: Pattern[] = [];
  const knownTypes = Object.keys(config.knownCauses);
  const covered = (type: string, cause: string): boolean => {
    if (!existingRules || existingRules.length === 0) return false;
    return existingRules.some((r) => {
      if (r.spec.type !== type) return false;
      return new RegExp(r.spec.causeMatch, "u").test(cause);
    });
  };

  for (const type of knownTypes) {
    const total = collector.typeTotal(type);
    if (total === 0) continue;
    const counts = collector.causeCounts(type);
    const typePatterns: Pattern[] = [];
    for (const [cause, count] of counts) {
      // EXP389: skip patterns already covered by an existing rule BEFORE
      // the cap (the bug fix — see docstring).
      if (covered(type, cause)) continue;
      const confidence = total > 0 ? count / total : 0;
      if (count < config.minPatternFrequency) continue;
      if (confidence < config.minConfidence) continue;
      typePatterns.push({ type, cause, count, confidence, rank: 0 });
    }
    // Rank within type: by count (default) or confidence, then by cause.
    const sortKey = config.rankByCount
      ? (p: Pattern) => p.count
      : (p: Pattern) => p.confidence;
    typePatterns.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      if (kb !== ka) return kb - ka; // descending
      return a.cause < b.cause ? -1 : a.cause > b.cause ? 1 : 0;
    });
    // Cap per type (now applies to NOVEL patterns only).
    const perTypeCap = typePatterns.slice(0, config.maxPatternsPerTypePerRound);
    for (let i = 0; i < perTypeCap.length; i += 1) {
      const p = perTypeCap[i];
      if (!p) continue;
      out.push({ type: p.type, cause: p.cause, count: p.count, confidence: p.confidence, rank: i + 1 });
    }
  }

  // Global cap (preserve per-type ranking order; stable).
  return out.slice(0, config.maxPatternsPerRound);
}

/** Extract patterns + report unknown types (novel error classes detected). */
export function extractWithUnknown(
  collector: ErrorCollector,
  config: LearningConfig,
  existingRules?: { spec: { type: string; causeMatch: string } }[],
): ExtractionResult {
  const patterns = extractPatterns(collector, config, existingRules);
  const knownTypes = new Set(Object.keys(config.knownCauses));
  const observed = collector.observedTypes();
  const unknownTypes = observed.filter((t) => !knownTypes.has(t));
  return { patterns, unknownTypes };
}

/**
 * Patterns not yet covered by an existing rule. A pattern is "covered" if a
 * learned rule's `causeMatch` regex matches the pattern's cause AND the rule's
 * type matches. This prevents re-extracting patterns that already have rules.
 */
export function novelPatterns(
  patterns: Pattern[],
  existingRules: { spec: { type: string; causeMatch: string } }[],
): Pattern[] {
  return patterns.filter((p) => {
    const covered = existingRules.some((r) => {
      if (r.spec.type !== p.type) return false;
      return new RegExp(r.spec.causeMatch, "u").test(p.cause);
    });
    return !covered;
  });
}
