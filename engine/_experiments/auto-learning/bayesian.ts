/**
 * EXP374 — Bayesian rule-probability updates.
 *
 * EXP363 admitted rules with no probability tracking (a rule is either in the
 * store or not). EXP374 adds Bayesian inference: each rule has a posterior
 * probability P(rule | evidence). After each round, the posteriors are
 * updated based on whether the rule prevented an error (evidence FOR the
 * rule) or failed to cover an error (evidence AGAINST).
 *
 * Bayes' theorem:
 *   P(rule | error) = P(error | rule) * P(rule) / P(error)
 *
 * In practice, we use a simplified Beta-Bernoulli update:
 *   prior = Beta(α, β)
 *   after observing a success (rule prevented an error): α += learningRate
 *   after observing a failure (rule didn't cover an error): β += learningRate
 *   posterior mean = α / (α + β)
 *
 * Rules with high posterior are "trusted" (applied first); rules with low
 * posterior are "deprioritized" (considered for removal in a future prune).
 *
 * NO LLM. Pure deterministic inference. All thresholds come from the config.
 */

import type { LearningConfig, LearnedRulesStore } from "./config.ts";

/** Bayesian state for a single rule. */
export interface BayesianRuleState {
  ruleId: string;
  /** Alpha (pseudo-count of successes). */
  alpha: number;
  /** Beta (pseudo-count of failures). */
  beta: number;
  /** Posterior mean = alpha / (alpha + beta). */
  posterior: number;
  /** Number of times this rule was updated. */
  updates: number;
}

/** A full Bayesian state map (ruleId → state). */
export class BayesianState {
  private states = new Map<string, BayesianRuleState>();
  private prior: number;
  private learningRate: number;

  constructor(config: LearningConfig) {
    this.prior = config.bayesianPrior;
    this.learningRate = config.bayesianLearningRate;
  }

  /** Register a rule (initialize its state with the prior). */
  register(ruleId: string): void {
    if (this.states.has(ruleId)) return;
    // Beta prior: alpha = beta = prior / (1 - prior) normalized.
    // For prior = 0.5 → alpha = beta = 1 (uniform Beta(1,1)).
    const a = this.prior / (1 - this.prior);
    const b = this.prior / (1 - this.prior);
    this.states.set(ruleId, {
      ruleId,
      alpha: a,
      beta: b,
      posterior: a / (a + b),
      updates: 0,
    });
  }

  /** Observe a success (the rule prevented an error). */
  observeSuccess(ruleId: string): void {
    this.register(ruleId);
    const s = this.states.get(ruleId)!;
    s.alpha += this.learningRate;
    s.posterior = s.alpha / (s.alpha + s.beta);
    s.updates += 1;
  }

  /** Observe a failure (the rule did NOT cover an error it should have). */
  observeFailure(ruleId: string): void {
    this.register(ruleId);
    const s = this.states.get(ruleId)!;
    s.beta += this.learningRate;
    s.posterior = s.alpha / (s.alpha + s.beta);
    s.updates += 1;
  }

  /** Get the posterior for a rule (0..1). Unknown rules get the prior. */
  get(ruleId: string): number {
    const s = this.states.get(ruleId);
    if (!s) return this.prior;
    return s.posterior;
  }

  /** Get the full state for a rule. */
  getState(ruleId: string): BayesianRuleState | undefined {
    return this.states.get(ruleId);
  }

  /** All rule states, sorted by posterior descending (most trusted first). */
  ranked(): readonly BayesianRuleState[] {
    return [...this.states.values()].sort((a, b) => b.posterior - a.posterior);
  }

  /** Number of registered rules. */
  size(): number {
    return this.states.size;
  }

  /**
   * Register all rules in the store. Called after each learning round so the
   * Bayesian state covers every admitted rule.
   */
  registerAll(store: LearnedRulesStore): void {
    for (const rule of store.all()) {
      this.register(rule.id);
    }
  }

  /**
   * Update the Bayesian state based on a round's results. For each admitted
   * rule:
   *   - If the rule prevented ≥1 error (success): observeSuccess.
   *   - If the rule prevented 0 errors AND errors of its type occurred
   *     (failure): observeFailure.
   */
  updateFromRound(
    store: LearnedRulesStore,
    preventedByRule: ReadonlyMap<string, number>,
    errorsByType: ReadonlyMap<string, number>,
  ): void {
    this.registerAll(store);
    for (const rule of store.all()) {
      const prevented = preventedByRule.get(rule.id) ?? 0;
      const errors = errorsByType.get(rule.spec.type) ?? 0;
      if (prevented > 0) {
        this.observeSuccess(rule.id);
      } else if (errors > 0) {
        this.observeFailure(rule.id);
      }
    }
  }
}

/**
 * Rank rules by Bayesian posterior. Rules with high posterior are applied
 * first (they have the most evidence of being useful). Rules with low
 * posterior are deprioritized.
 *
 * @returns a ranked list of ruleIds (most trusted first).
 */
export function rankRulesByPosterior(
  store: LearnedRulesStore,
  bayes: BayesianState,
): readonly string[] {
  const rules = store.all().map((r) => ({
    id: r.id,
    posterior: bayes.get(r.id),
  }));
  rules.sort((a, b) => {
    if (b.posterior !== a.posterior) return b.posterior - a.posterior;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rules.map((r) => r.id);
}
