/**
 * EXP374 — Generalizer: fuzzy rules, learned thresholds, contextual guards,
 * and rule composition.
 *
 * EXP363 used only exact-match rules ("if cause is exactly X, apply rule Y").
 * EXP374 adds generalizable rules:
 *   - **Fuzzy rules**: "if cause is SIMILAR to X (Levenshtein < threshold),
 *     apply rule Y." This lets the system generalize to unseen-but-similar
 *     causes (the generalization test).
 *   - **Learned thresholds**: instead of a hardcoded Levenshtein threshold,
 *     learn the optimal threshold from the error distribution (the threshold
 *     that separates FPs from TPs).
 *   - **Contextual guards**: "if cause is X AND context.tool is search,
 *     apply rule Y." Context-dependent rules (the contextual error category).
 *   - **Rule composition**: combine multiple rules. If rule A catches 60%
 *     and rule B catches 40%, together they catch 80%.
 *
 * NO LLM. Pure deterministic computation. All thresholds come from the config.
 */

import type { LearningConfig, LearnedRulesStore, RuleSpec } from "./config.ts";
import { levenshtein } from "./multi-cause.ts";
import { CONTEXTUAL_FIXABLE_TAGS_BY_TYPE } from "./config.ts";

/** A fuzzy match result: the rule + the distance to the error's cause. */
export interface FuzzyMatch {
  ruleId: string;
  spec: RuleSpec;
  /** The learned cause this rule matches (the rule's causeMatch, un-anchored). */
  learnedCause: string;
  /** The error's cause that fuzzy-matched. */
  matchedCause: string;
  /** Levenshtein distance (lower = more similar). */
  distance: number;
  /** Whether the threshold was learned or fixed. */
  thresholdSource: "learned" | "fixed";
}

/**
 * Extract the "canonical cause" from a rule's `causeMatch` regex. The policy
 * uses `^cause$` (anchored), so the canonical cause is the regex with anchors
 * and escapes stripped. This is the cause the rule was learned for.
 */
export function canonicalCauseFromRegex(causeMatch: string): string {
  // Strip ^...$ and un-escape regex metacharacters.
  let s = causeMatch;
  if (s.startsWith("^")) s = s.slice(1);
  if (s.endsWith("$")) s = s.slice(0, -1);
  return s.replace(/\\([.*+?^${}()|[\]\\])/g, "$1");
}

/**
 * Find the best fuzzy match for an uncovered error among all learned rules.
 * Returns the rule with the smallest Levenshtein distance to the error's
 * cause, IF the distance is within the threshold.
 *
 * @param errorType   the error's type
 * @param errorCause  the error's cause
 * @param store       the learned-rules store
 * @param config      the learning config (owns the threshold bounds)
 * @param learnedThreshold  the learned threshold (if fuzzyLearnThreshold is
 *                          true; null = use fuzzyMaxDistance)
 */
export function bestFuzzyMatch(
  errorType: string,
  errorCause: string,
  store: LearnedRulesStore,
  config: LearningConfig,
  learnedThreshold: number | null,
): FuzzyMatch | null {
  if (!config.fuzzyEnabled) return null;
  const threshold = learnedThreshold ?? config.fuzzyMaxDistance;

  let best: FuzzyMatch | null = null;
  for (const rule of store.all()) {
    if (rule.spec.type !== errorType) continue;
    const learnedCause = canonicalCauseFromRegex(rule.spec.causeMatch);
    if (learnedCause.length === 0) continue;
    const dist = levenshtein(errorCause, learnedCause);
    if (dist === 0) continue; // exact match — handled by isCoveredByRules
    if (dist > threshold) continue;
    if (best === null || dist < best.distance) {
      best = {
        ruleId: rule.id,
        spec: rule.spec,
        learnedCause,
        matchedCause: errorCause,
        distance: dist,
        thresholdSource: learnedThreshold !== null ? "learned" : "fixed",
      };
    }
  }
  return best;
}

/**
 * Learn the optimal Levenshtein threshold from the error distribution.
 *
 * Given a set of error causes (positives — should be matched) and clean
 * causes (negatives — should NOT be matched), find the threshold `d` that
 * maximizes the separation: the smallest `d` such that all positives are
 * within `d` of some learned cause AND all negatives are beyond `d`.
 *
 * If no perfect separator exists, use the threshold that maximizes the
 * F1 score (the harmonic mean of precision and recall).
 *
 * @param learnedCauses  the canonical causes of all learned rules (per type)
 * @param positiveCauses  error causes that SHOULD fuzzy-match (the errors)
 * @param negativeCauses  clean causes that should NOT fuzzy-match (the FPs)
 * @param config          the learning config (owns the distance bounds)
 * @returns the optimal threshold, or null if no threshold separates them
 */
export function learnFuzzyThreshold(
  learnedCauses: readonly string[],
  positiveCauses: readonly string[],
  negativeCauses: readonly string[],
  config: LearningConfig,
): number | null {
  if (!config.fuzzyEnabled) return null;
  const lo = config.fuzzyMinDistance;
  const hi = config.fuzzyMaxDistance;

  // For each candidate threshold in [lo, hi], compute precision, recall, F1.
  let bestF1 = -1;
  let bestThreshold: number | null = null;

  for (let d = lo; d <= hi; d += 1) {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;

    for (const pos of positiveCauses) {
      const minDist = Math.min(
        ...learnedCauses.map((c) => levenshtein(pos, c)),
      );
      if (minDist <= d && minDist > 0) {
        truePositives += 1;
      } else if (minDist === 0) {
        // exact match — not a fuzzy case
        truePositives += 1;
      } else {
        falseNegatives += 1;
      }
    }
    for (const neg of negativeCauses) {
      const minDist = Math.min(
        ...learnedCauses.map((c) => levenshtein(neg, c)),
      );
      if (minDist <= d && minDist > 0) {
        falsePositives += 1;
      }
    }

    const precision = truePositives + falsePositives > 0
      ? truePositives / (truePositives + falsePositives)
      : 1;
    const recall = truePositives + falseNegatives > 0
      ? truePositives / (truePositives + falseNegatives)
      : 1;
    const f1 = precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;

    // Prefer the threshold with 0 FPs (precision = 1) if one exists.
    if (falsePositives === 0 && f1 >= bestF1) {
      bestF1 = f1;
      bestThreshold = d;
    } else if (bestThreshold === null && f1 > bestF1) {
      // Fallback: max F1 if no 0-FP threshold exists.
      bestF1 = f1;
      bestThreshold = d;
    }
  }

  // If we found a 0-FP threshold, prefer it. Otherwise use the max-F1.
  return bestThreshold;
}

/**
 * Contextual guard: should a rule be applied given the error's context?
 *
 * A contextual rule's action contains "ONLY when <contextKey>=<value>". The
 * generalizer parses this guard and checks the error's context. If the
 * context matches, the rule applies; otherwise it does NOT (the rule is
 * context-dependent).
 *
 * @returns true if the rule should apply (no guard, or guard matches).
 */
export function contextualGuardPasses(
  spec: RuleSpec,
  errorContext: Readonly<Record<string, string | number | boolean>>,
): boolean {
  // Parse the guard from the action text: "ONLY when tool=search".
  const guardMatch = spec.action.match(/ONLY when (\w+)=(\S+)/);
  if (!guardMatch) return true; // no guard → always applies
  const [, key, value] = guardMatch;
  if (!key || !value) return true;
  const actual = errorContext[key];
  if (actual === undefined) return false; // context missing → guard fails
  return String(actual) === value;
}

/**
 * Get the fixable context tag for a (type, cause) pair, if it's a contextual
 * cause. Returns the tag value (e.g. "search") or null if not contextual.
 */
export function getFixableContextTag(
  type: string,
  cause: string,
): string | null {
  const tags = CONTEXTUAL_FIXABLE_TAGS_BY_TYPE[type];
  if (!tags) return null;
  return tags[cause] ?? null;
}

/**
 * Rule composition: given a set of rules, compute the combined coverage.
 * If rule A covers 60% of errors and rule B covers 40%, and they cover
 * DISJOINT sets, the composition covers 100%. If they overlap, the
 * composition covers less than the sum.
 *
 * @param ruleCoverages  per-rule coverage fractions (0..1)
 * @returns the combined coverage (0..1), assuming independence
 */
export function composedCoverage(ruleCoverages: readonly number[]): number {
  // P(A or B) = 1 - P(not A) * P(not B) (independence assumption).
  let probNotCovered = 1;
  for (const cov of ruleCoverages) {
    probNotCovered *= (1 - cov);
  }
  return 1 - probNotCovered;
}
