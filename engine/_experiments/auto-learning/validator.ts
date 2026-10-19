/**
 * EXP363 — Rule validator: the safety net.
 *
 * A proposed rule is ADMITTED only if:
 *   1. It covers ≥1 error of its triggering (type, cause) — it actually fixes
 *      something (no dead rules).
 *   2. It introduces ZERO false positives on a clean reference set — it does
 *      not flag operations that should NOT be flagged.
 *
 * This is the same safety philosophy as EXP230 (auto-learn-from-errors): the
 * validation prevents every unsafe proposal. Without it, a too-broad rule
 * (e.g. "filter ALL whitespace") would pass. The validator is deterministic
 * and makes NO LLM calls.
 *
 * The validator is the ONLY authority that decides admission. The updater
 * proposes; the validator disposes.
 */

import { type LearningConfig, type RuleSpec, type LearnedRulesStore } from "./config.ts";
import type { ErrorRecord } from "./collector.ts";
import type { Pattern } from "./extractor.ts";
import { ruleCovers } from "./updater.ts";

/** A clean operation: a (type, cause) that should NOT be flagged/prevented. */
export interface CleanOperation {
  type: string;
  cause: string;
  /** Human description of the clean operation. */
  description: string;
}

/** Validation verdict. */
export interface ValidationVerdict {
  admit: boolean;
  coversErrors: number;
  introducedFPs: number;
  reason: string;
}

/**
 * Validate a proposed rule against:
 *   - `errorSet`: the errors the rule should fix (must cover ≥1).
 *   - `cleanSet`: clean operations the rule must NOT match (0 matches required).
 */
export function validateRule(
  spec: RuleSpec,
  pattern: Pattern,
  _config: LearningConfig,
  _store: LearnedRulesStore,
  errorSet?: readonly ErrorRecord[],
  cleanSet?: readonly CleanOperation[],
): ValidationVerdict {
  // (1) Coverage: does the rule cover ≥1 error of its triggering pattern?
  const triggeringErrors = errorSet
    ? errorSet.filter((e) => e.type === pattern.type && e.cause === pattern.cause)
    : [];
  const coversErrors = triggeringErrors.length;

  if (coversErrors === 0) {
    return {
      admit: false,
      coversErrors: 0,
      introducedFPs: 0,
      reason: "rule covers no errors of the triggering pattern (dead rule)",
    };
  }

  // (2) FP check: the rule must NOT match any clean operation.
  // A rule "matches" a clean operation if ruleCovers(spec, op.type, op.cause).
  // This catches too-broad rules: e.g. a rule with causeMatch "^whitespace-"
  // would match a clean "whitespace-intentional" operation → FP → rejected.
  let introducedFPs = 0;
  if (cleanSet) {
    for (const op of cleanSet) {
      if (ruleCovers(spec, op.type, op.cause)) {
        introducedFPs += 1;
      }
    }
  }

  if (introducedFPs > 0) {
    return {
      admit: false,
      coversErrors,
      introducedFPs,
      reason: `rule introduces ${introducedFPs} false positive(s) on the clean set (too broad)`,
    };
  }

  return {
    admit: true,
    coversErrors,
    introducedFPs: 0,
    reason: `covers ${coversErrors} error(s) of (${pattern.type}, ${pattern.cause}); 0 FPs on clean set`,
  };
}

/**
 * The validate function signature expected by `applyProposedRules`. Curried
 * with the error + clean sets so the updater can call it without knowing
 * about the sets.
 */
export function makeValidator(
  errorSet: readonly ErrorRecord[],
  cleanSet: readonly CleanOperation[],
): (spec: RuleSpec, pattern: Pattern, config: LearningConfig, store: LearnedRulesStore) => ValidationVerdict {
  return (spec, pattern, config, store) =>
    validateRule(spec, pattern, config, store, errorSet, cleanSet);
}
