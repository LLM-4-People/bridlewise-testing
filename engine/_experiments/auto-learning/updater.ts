/**
 * EXP363 — Rule updater: deterministic pattern→rule proposal.
 *
 * NO LLM. The updater looks up each pattern in the config's policy table
 * (an array of `{type, causeMatch→rule}`). If a pattern matches an entry,
 * the updater proposes that entry's rule spec. If NO entry matches (an
 * unknown error pattern), the updater returns `null` — the system has
 * detected the pattern (it's logged in the collector) but has no
 * deterministic fix for it. This is the "generalization" behavior: the
 * system logs novel errors even when it cannot fix them.
 *
 * The LLM is the LAST RESORT (per the user directive) and is NOT invoked
 * here. A future LLM-fallback path would live in a separate module and be
 * gated behind an explicit config flag.
 */

import {
  type LearningConfig,
  type RuleSpec,
  type LearnedRulesStore,
  ruleMatchesCause,
} from "./config.ts";
import type { Pattern } from "./extractor.ts";

/** A proposed rule: the spec + the pattern that triggered it. */
export interface ProposedRule {
  spec: RuleSpec;
  pattern: Pattern;
  /** The policy-entry index that produced this proposal (for audit). */
  policyIndex: number;
}

/**
 * Propose rules for the given patterns using the config's policy table.
 * Deterministic: a pattern matches the FIRST policy entry whose type matches
 * AND whose `causeMatch` regex matches the pattern's cause.
 *
 * Returns `{ proposed, unmatched }`:
 *   - `proposed`: patterns that matched a policy entry (have a candidate rule).
 *   - `unmatched`: patterns with NO policy entry (detected but not fixable
 *     deterministically). These are logged for the generalization test.
 */
export function proposeRules(
  patterns: Pattern[],
  config: LearningConfig,
): { proposed: ProposedRule[]; unmatched: Pattern[] } {
  const proposed: ProposedRule[] = [];
  const unmatched: Pattern[] = [];

  for (const pattern of patterns) {
    const entryIdx = config.policy.findIndex(
      (e) => e.type === pattern.type && new RegExp(e.causeMatch, "u").test(pattern.cause),
    );
    if (entryIdx < 0) {
      unmatched.push(pattern);
      continue;
    }
    const entry = config.policy[entryIdx];
    if (entry === undefined) {
      unmatched.push(pattern);
      continue;
    }
    proposed.push({ spec: entry.rule, pattern, policyIndex: entryIdx });
  }

  return { proposed, unmatched };
}

/**
 * Apply proposed rules to the store. Each rule is validated by the
 * `validator` before insertion. Returns the rules actually admitted.
 * The updater itself does NOT validate — it delegates to the validator
 * (separation of concerns: the updater maps patterns→specs, the validator
 * decides admission).
 */
export function applyProposedRules(
  proposed: ProposedRule[],
  store: LearnedRulesStore,
  config: LearningConfig,
  validate: (spec: RuleSpec, pattern: Pattern, config: LearningConfig, store: LearnedRulesStore) => {
    admit: boolean;
    coversErrors: number;
    introducedFPs: number;
    reason: string;
  },
  round: number,
): { admitted: ProposedRule[]; rejected: ProposedRule[] } {
  const admitted: ProposedRule[] = [];
  const rejected: ProposedRule[] = [];

  for (const p of proposed) {
    // Respect the maxRules ceiling (config, not a static const).
    if (store.size() >= config.maxRules) {
      rejected.push(p);
      continue;
    }
    // Dedup: skip if an identical rule id is already in the store.
    if (store.has(p.spec.id)) {
      rejected.push(p);
      continue;
    }
    const verdict = validate(p.spec, p.pattern, config, store);
    if (!verdict.admit) {
      rejected.push(p);
      continue;
    }
    store.upsert({
      id: p.spec.id,
      spec: p.spec,
      addedAtRound: round,
      coversErrors: verdict.coversErrors,
      introducedFPs: verdict.introducedFPs,
      admittedBy: verdict.reason,
    });
    admitted.push(p);
  }

  return { admitted, rejected };
}

/**
 * Does a rule spec cover a given (type, cause)? The single owner of the
 * coverage decision used by the validator and simulator.
 */
export function ruleCovers(spec: RuleSpec, type: string, cause: string): boolean {
  return ruleMatchesCause(spec, type, cause);
}
