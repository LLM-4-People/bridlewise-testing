/**
 * EXP451 — N-gram pattern extraction: deterministic, no LLM.
 *
 * Discovers recurring character n-grams inside error causes. An n-gram that
 * appears in many error causes of the same type (above the configured
 * frequency + support thresholds) becomes a pattern. The n-gram is the
 * "subword" signature of the cause family (e.g. "regex" inside
 * "invalid-regex", "invalid-regexx", "bad-regex-arg").
 *
 * Why n-gram (vs frequency analysis): frequency analysis only matches
 * EXACT (type, cause) pairs. N-gram analysis matches the SHARED SUBSTRING
 * across causes of the same family — generalization WITHOUT fuzzy
 * matching (the n-gram rule covers any cause containing the signature
 * substring, including unseen variants).
 *
 * The extracted pattern's `cause` is the n-gram itself, wrapped so the
 * updater's exact-match policy (`^cause$`) does NOT cover it (the n-gram is
 * a SUBSTRING, not an exact cause). The benchmark uses n-gram patterns
 * directly (via the `ngramMatch` matcher); the live learner feeds n-gram
 * signatures to the policy table when the cause catalog has a matching
 * substring.
 *
 * NO LLM. Pure deterministic counting + ranking.
 */

import type { ErrorCollector } from "./collector.ts";
import type { LearningConfig } from "./config.ts";
import type { Pattern } from "./extractor.ts";

/** An n-gram signature discovered for a type. */
export interface NgramPattern extends Pattern {
  /** The discovered n-gram (the signature substring). */
  ngram: string;
  /** The n-gram length (n). */
  n: number;
  /** The fraction of the type's errors whose cause contains this n-gram. */
  support: number;
}

/**
 * Extract all character n-grams of length n from a string. Deterministic
 * (order preserved, duplicates kept — the caller counts).
 */
export function extractNgrams(s: string, n: number): string[] {
  if (n < 1 || s.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= s.length; i += 1) {
    out.push(s.slice(i, i + n));
  }
  return out;
}

/**
 * N-gram pattern extraction. For each known type, count every character
 * n-gram (length in [ngramMin, ngramMax]) across all that type's error
 * causes. An n-gram is a pattern if:
 *   - count >= ngramMinFrequency (absolute count), AND
 *   - support (count / total-of-type) >= ngramMinSupport, AND
 *   - the n-gram is not a trivial substring of a longer admitted n-gram
 *     (dedup: keep the LONGEST n-gram when one n-gram contains another with
 *     the same count — the longer one is the more specific signature).
 *
 * EXP461 (S6): an n-gram is ALSO filtered by discrimination — its error-side
 * count must be >= `ngramMinDiscrimination` × its clean-side frequency. The
 * clean-side frequency is the n-gram's count across the `cleanCauses` of the
 * same type. N-grams common in clean causes (`regex` in `bad-regex-clean`)
 * are dropped, so the substring matcher no longer over-matches clean ops.
 * When `cleanCauses` is omitted or `ngramMinDiscrimination` is 0, the
 * discrimination filter is disabled (the EXP451 behavior).
 *
 * The cap `maxNgramPatternsPerType` bounds per-type output; the global cap
 * `maxNgramPatterns` bounds the total. Ranking is by (count desc, length
 * desc, ngram asc) for stable deterministic ordering.
 */
export function extractNgramPatterns(
  collector: ErrorCollector,
  config: LearningConfig,
  cleanCauses?: readonly { type: string; cause: string }[],
): NgramPattern[] {
  if (!config.ngramEnabled) return [];
  // EXP461 (S6): precompute the clean-side n-gram frequency + total per type.
  const cleanFreqByType = new Map<string, Map<string, number>>();
  const cleanTotalByType = new Map<string, number>();
  if (cleanCauses !== undefined && config.ngramMinDiscrimination > 0) {
    for (const c of cleanCauses) {
      let m = cleanFreqByType.get(c.type);
      if (!m) { m = new Map(); cleanFreqByType.set(c.type, m); }
      const seen = new Set<string>();
      for (let n = config.ngramMin; n <= config.ngramMax; n += 1) {
        for (const gram of extractNgrams(c.cause, n)) seen.add(gram);
      }
      for (const gram of seen) m.set(gram, (m.get(gram) ?? 0) + 1);
      cleanTotalByType.set(c.type, (cleanTotalByType.get(c.type) ?? 0) + 1);
    }
  }
  const out: NgramPattern[] = [];
  const knownTypes = Object.keys(config.knownCauses);
  for (const type of knownTypes) {
    const total = collector.typeTotal(type);
    if (total === 0) continue;
    const causeCounts = collector.causeCounts(type);
    const counts = new Map<string, number>();
    for (const [cause, count] of causeCounts) {
      for (let n = config.ngramMin; n <= config.ngramMax; n += 1) {
        for (const gram of extractNgrams(cause, n)) {
          counts.set(gram, (counts.get(gram) ?? 0) + count);
        }
      }
    }
    const cleanFreq = cleanFreqByType.get(type);
    const candidates: NgramPattern[] = [];
    for (const [gram, count] of counts) {
      if (count < config.ngramMinFrequency) continue;
      const support = total > 0 ? count / total : 0;
      if (support < config.ngramMinSupport) continue;
      // EXP461 (S6): discrimination floor — drop n-grams common in clean causes.
      // The metric is a SUPPORT RATIO (errorSupport / cleanSupport): an n-gram
      // is admitted only if its error-side support is >= ngramMinDiscrimination
      // × its clean-side support. cleanSupport 0 → always admitted (truly
      // discriminative). This rejects both "regex" (clean support 1.0) and
      // coincidental short sequences like "d-r" (clean support 0.33) that the
      // absolute-count metric missed.
      if (cleanFreq !== undefined) {
        const cleanCount = cleanFreq.get(gram) ?? 0;
        const cleanTotal = cleanTotalByType.get(type) ?? 1;
        const cleanSupport = cleanCount / cleanTotal;
        const errorSupport = total > 0 ? count / total : 0;
        if (cleanSupport > 0 && errorSupport / cleanSupport < config.ngramMinDiscrimination) continue;
      }
      candidates.push({
        type,
        cause: gram,
        count,
        confidence: support,
        rank: 0,
        ngram: gram,
        n: gram.length,
        support,
      });
    }
    // Dedup: drop an n-gram that is a proper substring of a longer one with
    // >= count (the longer one is more specific AND at least as frequent).
    candidates.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.n !== a.n) return b.n - a.n; // longer first
      return a.ngram < b.ngram ? -1 : a.ngram > b.ngram ? 1 : 0;
    });
    const kept: NgramPattern[] = [];
    for (const c of candidates) {
      const subsumed = kept.some(
        (k) => k.ngram.includes(c.ngram) && k.count >= c.count,
      );
      if (!subsumed) kept.push(c);
    }
    // Cap per type.
    const capped = kept.slice(0, config.maxNgramPatternsPerType);
    for (let i = 0; i < capped.length; i += 1) {
      const p = capped[i];
      if (!p) continue;
      out.push({ ...p, rank: i + 1 });
    }
  }
  // Global cap.
  return out.slice(0, config.maxNgramPatterns);
}

/**
 * N-gram matcher: an operation is covered if its cause contains the
 * n-gram signature of an admitted rule of the same type. This is the
 * deterministic "semantic" matcher (substring containment — a weak but
 * 0-LLM form of semantic similarity). The benchmark compares this against
 * exact, fuzzy, contextual, and compound matchers.
 */
export function ngramMatch(
  op: { type: string; cause: string },
  ngramRules: ReadonlyArray<{ spec: { type: string; causeMatch: string } }>,
): { ruleId?: string; matched: boolean } {
  for (const r of ngramRules) {
    if (r.spec.type !== op.type) continue;
    // The n-gram rule's causeMatch is the n-gram (stored as a plain
    // substring, not anchored). A cause is covered if it CONTAINS the
    // n-gram.
    if (op.cause.includes(r.spec.causeMatch)) {
      return { ruleId: r.spec.causeMatch, matched: true };
    }
  }
  return { matched: false };
}
