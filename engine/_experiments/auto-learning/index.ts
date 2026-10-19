/**
 * EXP374 — Auto-learning orchestrator: collector → extractor → multi-cause →
 * updater → validator, with fuzzy generalization + Bayesian updates.
 *
 * Extends EXP363's orchestrator with:
 *   - Multi-cause pattern extraction (MI + Apriori, from multi-cause.ts).
 *   - Fuzzy matching (Levenshtein, from generalizer.ts).
 *   - Contextual guards (context-dependent rules, from generalizer.ts).
 *   - Bayesian rule-probability updates (from bayesian.ts).
 *
 * NO LLM. The learning loop is fully deterministic. An `llmCallCounter` is
 * threaded through so tests can assert 0 LLM calls during learning.
 */

import {
  type LearningConfig,
  type LearnedRulesStore,
  type RuleSpec,
  rootCauseEntriesFor,
} from "./config.ts";
import type { ErrorCollector, ErrorRecord } from "./collector.ts";
import { extractWithUnknown, novelPatterns, type Pattern } from "./extractor.ts";
import { proposeRules, applyProposedRules, type ProposedRule } from "./updater.ts";
import { makeValidator, type CleanOperation } from "./validator.ts";
import {
  extractMultiCausePatterns,
  type MultiCausePattern,
  type MultiCauseResult,
} from "./multi-cause.ts";
import {
  bestFuzzyMatch,
  contextualGuardPasses,
} from "./generalizer.ts";
import { BayesianState } from "./bayesian.ts";

/** Result of one learning round. */
export interface RoundResult {
  round: number;
  errorsObserved: number;
  patternsExtracted: Pattern[];
  patternsNovel: Pattern[];
  rulesProposed: ProposedRule[];
  /** Patterns with no deterministic fix (detected, logged, not fixed). */
  patternsUnmatched: Pattern[];
  /** Novel error types not in the known catalog (detected, no known causes). */
  unknownTypes: string[];
  rulesAdmitted: ProposedRule[];
  rulesRejected: ProposedRule[];
  /** Cumulative rule count after this round. */
  totalRules: number;
  /** EXP374: multi-cause patterns found by MI + Apriori. */
  multiCausePatterns: MultiCausePattern[];
  /** EXP374: high-MI pairs below Apriori support (detected, not frequent enough). */
  highMIPairs: MultiCausePattern[];
  /** EXP374: compound rules admitted this round (from multi-cause). */
  compoundRulesAdmitted: number;
  /** EXP374: fuzzy matches applied this round (generalization). */
  fuzzyMatches: number;
}

/**
 * Run one learning round. The collector should already contain the errors
 * for this round (or accumulated across rounds, per config).
 *
 * EXP374 extensions:
 *   1. Extract multi-cause patterns (MI + Apriori) from compound causes.
 *   2. Propose compound rules for frequent itemsets (via the policy table).
 *   3. Admit compound rules through the same validator (0 FPs required).
 */
export function runLearningRound(
  collector: ErrorCollector,
  store: LearnedRulesStore,
  config: LearningConfig,
  round: number,
  cleanSet: readonly CleanOperation[],
): RoundResult {
  // (1) Extract single-cause recurring patterns + detect novel types.
  // EXP389: pass existingRules so the extractor skips covered patterns
  // BEFORE the per-type cap (the plateau bug fix).
  const existingRules = store.all().map((r) => ({ spec: r.spec }));
  const { patterns: patternsExtracted, unknownTypes } = extractWithUnknown(collector, config, existingRules);

  // (2) Filter to patterns not already covered by an existing rule.
  // (Kept for backward compat — the extractor now skips covered patterns
  // before the cap, so this is a no-op for the standard path. It still
  // protects against callers that pass covered patterns directly.)
  const patternsNovel = novelPatterns(patternsExtracted, existingRules);

  // (3) Propose rules via the deterministic policy table.
  const { proposed: rulesProposed, unmatched: patternsUnmatched } = proposeRules(
    patternsNovel,
    config,
  );

  // (4) Validate + admit. The validator is the safety net (0 FPs required).
  const validate = makeValidator(collector.all(), cleanSet);
  const { admitted: rulesAdmitted, rejected: rulesRejected } = applyProposedRules(
    rulesProposed,
    store,
    config,
    validate,
    round,
  );

  // (5) EXP374: extract multi-cause patterns (MI + Apriori).
  const multiCauseResult: MultiCauseResult = extractMultiCausePatterns(collector, config);

  // (6) EXP374: propose compound rules for multi-cause patterns.
  // The compound policy table (in config) maps compound causes to rules.
  // We propose compound rules through the same updater + validator.
  let compoundRulesAdmitted = 0;
  if (multiCauseResult.patterns.length > 0) {
    const compoundPatterns: Pattern[] = multiCauseResult.patterns.map((mp) => ({
      type: mp.type,
      cause: mp.compoundCause,
      count: mp.count,
      confidence: mp.confidence,
      rank: 0,
    }));
    // Filter to compounds not already covered.
    const novelCompounds = novelPatterns(compoundPatterns, existingRules);
    const { proposed: compoundProposed } = proposeRules(novelCompounds, config);
    const { admitted: compoundAdmitted } = applyProposedRules(
      compoundProposed,
      store,
      config,
      validate,
      round,
    );
    compoundRulesAdmitted = compoundAdmitted.length;
  }

  return {
    round,
    errorsObserved: collector.size(),
    patternsExtracted,
    patternsNovel,
    rulesProposed,
    patternsUnmatched,
    unknownTypes,
    rulesAdmitted,
    rulesRejected,
    totalRules: store.size(),
    multiCausePatterns: multiCauseResult.patterns,
    highMIPairs: multiCauseResult.highMIPairs,
    compoundRulesAdmitted,
    fuzzyMatches: 0, // tracked by applyRulesToOperationsExtended
  };
}

/**
 * LLM-call counter. Tests assert this stays 0 during learning. The actual
 * coding tasks (the harness doing real work) may use the LLM; the LEARNING
 * loop does not.
 */
export class LlmCallCounter {
  private count = 0;
  bump(): void {
    this.count += 1;
  }
  value(): number {
    return this.count;
  }
  reset(): void {
    this.count = 0;
  }
}

/**
 * Simulated operation: an attempt the harness makes. If its (type, cause)
 * is NOT covered by any active rule, it becomes an error (recorded). If a
 * rule covers it, the rule PREVENTS the error.
 *
 * EXP374: `context` is an optional map of context tags (for contextual rules).
 */
export interface SimOperation {
  type: string;
  cause: string;
  /** Whether this operation would fail (become an error) without a rule. */
  wouldFail: boolean;
  /** EXP374: context tags for contextual guards (e.g. { tool: "search" }). */
  context?: Readonly<Record<string, string | number | boolean>>;
}

/** Result of checking an operation against the rules. */
export interface CoverageResult {
  covered: boolean;
  /** Which rule covered it (if any). */
  ruleId?: string;
  /** Was it an exact match, a fuzzy match, a contextual-guarded match, or a root-cause ensemble? */
  matchKind: "exact" | "fuzzy" | "contextual" | "root-cause" | "none";
  /** The fuzzy distance (if fuzzy match). */
  fuzzyDistance?: number;
}

/**
 * Does any active rule cover this operation? The single canonical owner of
 * the coverage decision. Checks in order:
 *   1. Exact regex match (EXP363).
 *   2. Contextual guard (if the rule has a guard, the context must match).
 *   3. Fuzzy match (Levenshtein, if config.fuzzyEnabled).
 *   4. EXP389 Root-cause ensemble: if the error's (type, cause) is in the
 *      ROOT_CAUSE_MAP, check whether every root-cause (type, cause) pair is
 *      covered by some rule in the store. If yes, the original error is
 *      covered (matchKind: "root-cause") — the ensemble of root-cause fixes
 *      fixes the original unfixable error.
 *
 * The `config` and `learnedThreshold` are optional for backward compat with
 * EXP363 callers (who get exact-match-only behavior).
 */
export function isCoveredByRules(
  op: SimOperation,
  store: LearnedRulesStore,
  config?: LearningConfig,
  learnedThreshold?: number | null,
): boolean {
  return checkCoverage(op, store, config, learnedThreshold).covered;
}

/**
 * Full coverage check with details. Returns the match kind + the rule that
 * covered the operation.
 */
export function checkCoverage(
  op: SimOperation,
  store: LearnedRulesStore,
  config?: LearningConfig,
  learnedThreshold?: number | null,
): CoverageResult {
  // (1) Exact regex match + contextual guard.
  for (const r of store.all()) {
    if (r.spec.type !== op.type) continue;
    if (!new RegExp(r.spec.causeMatch, "u").test(op.cause)) continue;
    // Check contextual guard (if the rule has one).
    if (op.context && !contextualGuardPasses(r.spec, op.context)) {
      continue; // guard fails → rule doesn't apply in this context
    }
    return {
      covered: true,
      ruleId: r.id,
      matchKind: op.context && r.spec.action.includes("ONLY when") ? "contextual" : "exact",
    };
  }

  // (2) Fuzzy match (if enabled).
  if (config?.fuzzyEnabled) {
    const fuzzy = bestFuzzyMatch(op.type, op.cause, store, config, learnedThreshold ?? null);
    if (fuzzy) {
      // Check contextual guard on the fuzzy-matched rule too.
      if (op.context && !contextualGuardPasses(fuzzy.spec, op.context)) {
        // guard fails → fuzzy match doesn't apply
      } else {
        return {
          covered: true,
          ruleId: fuzzy.ruleId,
          matchKind: "fuzzy",
          fuzzyDistance: fuzzy.distance,
        };
      }
    }
  }

  // (3) EXP389 Root-cause ensemble: trace the error to its root cause(s). If
  // every root-cause (type, cause) pair is covered by some rule in the store,
  // the original error is covered by the ensemble of those root-cause fixes.
  // This makes "unfixable" errors fixable when their root cause has a fix.
  const rootCauses = rootCauseEntriesFor(op.type, op.cause);
  if (rootCauses.length > 0) {
    let allCovered = true;
    const coveringRuleIds: string[] = [];
    for (const [rType, rCause] of rootCauses) {
      let covered = false;
      for (const r of store.all()) {
        if (r.spec.type !== rType) continue;
        if (!new RegExp(r.spec.causeMatch, "u").test(rCause)) continue;
        covered = true;
        coveringRuleIds.push(r.id);
        break;
      }
      if (!covered) {
        allCovered = false;
        break;
      }
    }
    if (allCovered) {
      return {
        covered: true,
        ruleId: coveringRuleIds.join("+"),
        matchKind: "root-cause",
      };
    }
  }

  return { covered: false, matchKind: "none" };
}

/**
 * Apply active rules to a batch of operations. Returns:
 *   - `prevented`: operations a rule caught (would have failed, rule covers).
 *   - `errors`: operations that became errors (no rule covered them).
 *   - `falsePositives`: clean operations a rule WRONGLY caught (should be 0).
 *
 * The `falsePositives` count is the FP check: a rule should never prevent a
 * clean operation (one with `wouldFail: false`).
 *
 * EXP374: also tracks prevented-by-rule (for Bayesian updates) and fuzzy
 * matches (for the generalization metric).
 */
export function applyRulesToOperations(
  ops: readonly SimOperation[],
  store: LearnedRulesStore,
  config?: LearningConfig,
  learnedThreshold?: number | null,
): {
  prevented: number;
  errors: SimOperation[];
  falsePositives: number;
  preventedByRule: Map<string, number>;
  fuzzyMatches: number;
} {
  let prevented = 0;
  let falsePositives = 0;
  let fuzzyMatches = 0;
  const errors: SimOperation[] = [];
  const preventedByRule = new Map<string, number>();

  for (const op of ops) {
    const result = checkCoverage(op, store, config, learnedThreshold);
    if (result.covered) {
      if (op.wouldFail) {
        prevented += 1;
        if (result.ruleId) {
          preventedByRule.set(result.ruleId, (preventedByRule.get(result.ruleId) ?? 0) + 1);
        }
        if (result.matchKind === "fuzzy") fuzzyMatches += 1;
      } else {
        falsePositives += 1;
      }
    } else {
      if (op.wouldFail) {
        errors.push(op);
      }
    }
  }

  return { prevented, errors, falsePositives, preventedByRule, fuzzyMatches };
}

export type { ErrorRecord, ErrorCollector, CleanOperation, Pattern, RuleSpec };
export { BayesianState };
