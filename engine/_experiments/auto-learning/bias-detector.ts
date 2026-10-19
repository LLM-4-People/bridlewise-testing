/**
 * EXP389 — Learning-bias detector.
 *
 * The user directive: "Add something regarding bias" + "if agents get 100%,
 * tests are too easy." A learner that only learns rules for the MOST COMMON
 * error types has a COVERAGE BIAS: rare types get no rules. The bias detector
 * tracks per-type coverage and flags under-learned types (types with errors
 * but few/no rules). The PREVENTION is the EXP389 extraction bug fix: the
 * extractor now skips covered patterns BEFORE the per-type cap, so
 * under-learned types get their patterns extracted (not blocked by
 * already-covered common types).
 *
 * What "bias" means here (precise):
 *   - COVERAGE BIAS: a type with errors but 0 rules (or coverage < threshold).
 *     The learner "ignored" this type. Detected by comparing per-type
 *     error counts to per-type rule counts.
 *   - FREQUENCY BIAS: a type whose errors are rare (count < average) gets
 *     fewer extraction slots. The minPatternFrequency threshold amplifies
 *     this. Detected by comparing per-type error counts to the mean.
 *   - RARE-TYPE BIAS: a type that appears in the catalog but has 0 errors in
 *     the collector. Not a bias per se, but a "blind spot" — the learner has
 *     no data for it.
 *
 * The detector is a REPORTING tool (deterministic, no LLM). The PREVENTION
 * lives in the extractor (the EXP389 bug fix). The detector verifies the
 * prevention worked: after the fix, no type with errors should have 0 rules
 * (unless the type is genuinely unfixable — adversarial / contextual-
 * validate).
 *
 * All thresholds come from the config (no static constants).
 */

import type { LearningConfig, LearnedRulesStore } from "./config.ts";
import { checkCoverage } from "./index.ts";

/** Per-type bias stats. */
export interface TypeBiasStats {
  type: string;
  /** Total errors of this type in the collector. */
  errors: number;
  /** Rules admitted for this type. */
  rules: number;
  /** Coverage = errors with a covering rule / total errors (0..1). */
  coverage: number;
  /** True if this type has errors but 0 rules (the most severe bias). */
  hasZeroRuleBias: boolean;
  /** True if coverage < biasCoverageThreshold (under-learned). */
  isUnderlearned: boolean;
  /** True if errors < mean-errors-per-type (frequency bias — rare type). */
  isRare: boolean;
}

/** A full bias report. */
export interface BiasReport {
  /** Per-type stats, sorted by coverage ascending (worst first). */
  perType: TypeBiasStats[];
  /** Types with errors but 0 rules (the bias the prevention targets). */
  zeroRuleTypes: string[];
  /** Types with coverage < biasCoverageThreshold. */
  underlearnedTypes: string[];
  /** Types with errors < mean (rare types — frequency bias). */
  rareTypes: string[];
  /** The mean errors per type (for the frequency-bias computation). */
  meanErrorsPerType: number;
  /** True if NO zero-rule bias remains (the prevention worked). */
  preventionWorked: boolean;
  /** The configured coverage threshold (from config). */
  biasCoverageThreshold: number;
}

/**
 * The learning-bias detector. Tracks per-type stats over a round and reports
 * which types are under-learned. The detector itself does NOT fix bias — it
 * reports it. The prevention is the extractor's novel-pattern extraction
 * (the EXP389 bug fix).
 */
export class LearningBiasDetector {
  private readonly errorsByType = new Map<string, number>();
  private readonly rulesByType = new Map<string, number>();
  private readonly coverageByType = new Map<string, number>();
  private readonly config: LearningConfig;

  constructor(config: LearningConfig) {
    this.config = config;
  }

  /**
   * Record a round's per-type stats. Called after each learning round.
   *
   * @param errorsByType  total errors per type (from the collector / batch)
   * @param store         the learned-rules store (rules per type)
   * @param coverageByType  per-type coverage fraction (0..1)
   */
  track(
    errorsByType: ReadonlyMap<string, number>,
    store: LearnedRulesStore,
    coverageByType: ReadonlyMap<string, number>,
  ): void {
    for (const [type, n] of errorsByType) {
      this.errorsByType.set(type, n);
    }
    for (const [type, cov] of coverageByType) {
      this.coverageByType.set(type, cov);
    }
    const rulesPerType = new Map<string, number>();
    for (const rule of store.all()) {
      const t = rule.spec.type;
      rulesPerType.set(t, (rulesPerType.get(t) ?? 0) + 1);
    }
    for (const [t, n] of rulesPerType) {
      this.rulesByType.set(t, Math.max(this.rulesByType.get(t) ?? 0, n));
    }
  }

  /** Build a bias report from the tracked stats. */
  report(): BiasReport {
    const types = new Set<string>([
      ...this.errorsByType.keys(),
      ...this.rulesByType.keys(),
      ...this.coverageByType.keys(),
    ]);
    const perType: TypeBiasStats[] = [];
    let totalErrors = 0;
    for (const n of this.errorsByType.values()) totalErrors += n;
    const meanErrorsPerType = types.size > 0 ? totalErrors / types.size : 0;
    const threshold = this.config.biasCoverageThreshold;

    for (const type of types) {
      const errors = this.errorsByType.get(type) ?? 0;
      const rules = this.rulesByType.get(type) ?? 0;
      const coverage = this.coverageByType.get(type) ?? 0;
      perType.push({
        type,
        errors,
        rules,
        coverage,
        hasZeroRuleBias: errors > 0 && rules === 0,
        isUnderlearned: errors > 0 && coverage < threshold,
        isRare: errors > 0 && errors < meanErrorsPerType,
      });
    }

    // Sort by coverage ascending (worst first), then by errors descending.
    perType.sort((a, b) => {
      if (a.coverage !== b.coverage) return a.coverage - b.coverage;
      return b.errors - a.errors;
    });

    const zeroRuleTypes = perType.filter((s) => s.hasZeroRuleBias).map((s) => s.type);
    const underlearnedTypes = perType.filter((s) => s.isUnderlearned).map((s) => s.type);
    const rareTypes = perType.filter((s) => s.isRare).map((s) => s.type);

    return {
      perType,
      zeroRuleTypes,
      underlearnedTypes,
      rareTypes,
      meanErrorsPerType,
      preventionWorked: zeroRuleTypes.length === 0,
      biasCoverageThreshold: threshold,
    };
  }
}

/**
 * Compute per-type coverage from a batch + a store. Returns a map
 * type → coverage fraction (0..1). Used by the bias detector.
 */
export function computeCoverageByType(
  ops: readonly { type: string; cause: string; wouldFail: boolean; context?: Readonly<Record<string, string | number | boolean>> }[],
  store: LearnedRulesStore,
  config: LearningConfig,
  learnedThreshold: number | null,
): Map<string, number> {
  const totals = new Map<string, number>();
  const covered = new Map<string, number>();
  for (const op of ops) {
    if (!op.wouldFail) continue;
    totals.set(op.type, (totals.get(op.type) ?? 0) + 1);
    if (checkCoverage(op, store, config, learnedThreshold).covered) {
      covered.set(op.type, (covered.get(op.type) ?? 0) + 1);
    }
  }
  const out = new Map<string, number>();
  for (const [type, n] of totals) {
    out.set(type, n > 0 ? (covered.get(type) ?? 0) / n : 0);
  }
  return out;
}
