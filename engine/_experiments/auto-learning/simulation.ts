/**
 * EXP374 — Auto-learning simulation engine: 10 rounds of HARDER errors.
 *
 * Extends EXP363's 5-round engine with:
 *   - 10 rounds (not 5) per the user's "at least 5" directive.
 *   - 200 errors/round across 10 categories (20 each): 5 fixable single-cause
 *     + multi-cause + contextual + temporal + cross-module + adversarial.
 *   - The error rate DECREASES but does NOT reach 0% (the harder errors are
 *     unfixable by simple rules — "if agents get 100%, tests are too easy").
 *   - CUSUM detection of error-rate shifts (from cusum.ts).
 *   - Bayesian rule-probability updates (from bayesian.ts).
 *   - Generalization test: after 10 rounds, inject 50 NEW errors (unseen
 *     types + similar-but-unseen causes). The fuzzy matcher should catch the
 *     similar causes; novel types should be logged (detection).
 *
 * The simulation is deterministic: the same config + seed produces the same
 * batches, the same rule admissions, and the same error-rate series.
 * Every threshold comes from the loaded `LearningConfig` (no static constants).
 */

import {
  type LearningConfig,
  LearnedRulesStore,
  FIXABLE_CAUSES_BY_TYPE,
  UNFIXABLE_CAUSES_BY_TYPE,
  COMPOUND_CAUSES_BY_TYPE,
  CONTEXTUAL_CAUSES_BY_TYPE,
  CONTEXTUAL_FIXABLE_TAGS_BY_TYPE,
  TEMPORAL_CAUSES_BY_TYPE,
  CROSS_MODULE_CAUSES_BY_TYPE,
  CONTEXT_KEY,
  isCompoundCause,
  loadLearningConfig,
} from "./config.ts";
import { ErrorCollector, type ErrorRecord } from "./collector.ts";
import {
  runLearningRound,
  applyRulesToOperations,
  isCoveredByRules,
  checkCoverage,
  LlmCallCounter,
  BayesianState,
  type SimOperation,
  type RoundResult,
} from "./index.ts";
import type { CleanOperation } from "./validator.ts";
import { runCusum, type CusumChart } from "./cusum.ts";
import { learnFuzzyThreshold, canonicalCauseFromRegex } from "./generalizer.ts";
import { LearningBiasDetector, computeCoverageByType, type BiasReport } from "./bias-detector.ts";

/** A measurement of one round's batch under a rule set. */
export interface BatchMeasurement {
  total: number;
  prevented: number;
  errors: number;
  falsePositives: number;
  errorRate: number;
  fpRate: number;
  fuzzyMatches: number;
}

/** A full round's record (pre + learn + post). */
export interface SimulationRound {
  round: number;
  pre: BatchMeasurement;
  post: BatchMeasurement;
  recordedErrors: number;
  result: RoundResult;
  llmCalls: number;
  /** EXP374: Bayesian posteriors after this round. */
  bayesianSize: number;
}

/** A full simulation report. */
export interface SimulationReport {
  rounds: SimulationRound[];
  postErrorRates: number[];
  preErrorRates: number[];
  fpRates: number[];
  totalRulesAdmitted: number;
  totalLlmCalls: number;
  config: LearningConfig;
  /** EXP374: the CUSUM chart over the post-round error rates. */
  cusumChart: CusumChart;
  /** EXP374: the learned fuzzy threshold (or null if not learned). */
  learnedFuzzyThreshold: number | null;
  /** EXP374: the Bayesian state after all rounds. */
  bayesianSize: number;
  /** EXP389: the learning-bias report (per-type coverage + under-learned types). */
  biasReport?: BiasReport;
  /** EXP389: per-round root-cause-ensemble coverage count. */
  rootCauseCoverages?: number[];
  /** EXP389: the final plateau rate (the asymptotic post-error rate). */
  plateauRate?: number;
}

/** Build a deterministic batch of operations for a round. */
export function buildBatch(
  causesByType: Readonly<Record<string, readonly string[]>>,
  perCause: number,
  wouldFail: boolean,
): SimOperation[] {
  const ops: SimOperation[] = [];
  for (const type of Object.keys(causesByType)) {
    const causes = causesByType[type] ?? [];
    for (const cause of causes) {
      for (let i = 0; i < perCause; i += 1) {
        ops.push({ type, cause, wouldFail });
      }
    }
  }
  return ops;
}

/** Measure a batch under the current rules. Pure: does NOT mutate the store. */
export function measureBatch(
  ops: readonly SimOperation[],
  store: LearnedRulesStore,
  config?: LearningConfig,
  learnedThreshold?: number | null,
): BatchMeasurement {
  const { prevented, errors, falsePositives, fuzzyMatches } = applyRulesToOperations(
    ops, store, config, learnedThreshold,
  );
  const total = ops.length;
  return {
    total,
    prevented,
    errors: errors.length,
    falsePositives,
    errorRate: total > 0 ? errors.length / total : 0,
    fpRate: total > 0 ? falsePositives / total : 0,
    fuzzyMatches,
  };
}

/**
 * Build the clean set: near-miss causes for each fixable cause. A precise
 * (exact-match) rule does NOT match `${cause}-clean`; a too-broad rule WOULD.
 * Used for the FP check + the validator safety-net test.
 */
export function buildCleanSet(_config: LearningConfig): CleanOperation[] {
  const out: CleanOperation[] = [];
  for (const type of Object.keys(FIXABLE_CAUSES_BY_TYPE)) {
    const causes = FIXABLE_CAUSES_BY_TYPE[type] ?? [];
    for (const cause of causes) {
      out.push({
        type,
        cause: `${cause}-clean`,
        description: `legitimate operation near-miss to ${cause}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// EXP389 — Harder batch: 360 errors/round across 18 categories (20 each).
// EXP374 had 10 categories × 20 = 200. EXP389 adds 8 NEW fixable categories
// (per the user's directive) to dilute the unfixable fraction and lower the
// plateau from 30% (post-bug-fix) to <20%.
// ---------------------------------------------------------------------------

/** The 18 harder categories (for reporting). */
export const HARDER_CATEGORIES = [
  "tool-call-failed",
  "edit-preimage-mismatch",
  "hallucination-detected",
  "false-positive",
  "false-negative",
  "multi-cause",
  "contextual",
  "temporal",
  "cross-module",
  "adversarial",
  // EXP389 new fixable categories (8).
  "context-too-long",
  "tool-call-timeout",
  "tool-call-rate-limit",
  "edit-conflict",
  "memory-retrieval-failure",
  "awareness-staleness",
  "hallucination-pattern",
  "bias-pattern",
] as const;

/** The 8 EXP389 new fixable types (for reporting + bias detection). */
export const EXP389_NEW_FIXABLE_TYPES = [
  "context-too-long",
  "tool-call-timeout",
  "tool-call-rate-limit",
  "edit-conflict",
  "memory-retrieval-failure",
  "awareness-staleness",
  "hallucination-pattern",
  "bias-pattern",
] as const;

/** A global counter for adversarial noise causes (unique per op). */
let adversarialCounter = 0;

/**
 * Build a harder batch of 360 operations for a round. Categories:
 *   1-5.  Fixable single-cause (4 causes × 5 = 20 per type, 100 total).
 *   6.    Multi-cause (compound causes, 4 × 5 = 20).
 *   7.    Contextual (2 causes × 2 contexts × 5 = 20; 10 fixable + 10 unfixable).
 *   8.    Temporal (1 cause × 20 = 20; turn > threshold; unfixable).
 *   9.    Cross-module (1 fixable × 10 + 1 compound × 10 = 20; 10 + 10 unfixable).
 *   10.   Adversarial (20 unique noise causes; unfixable).
 *   11-18. EXP389 new fixable types (4 causes × 5 = 20 per type, 160 total).
 *
 * Total: 100 + 20 + 20 + 20 + 20 + 20 + 160 = 360 ops/round.
 *
 * EXP389 bug-fix: extractPatterns now skips covered patterns before the
 * per-type cap, so ALL single-cause errors (incl. tool-call-failed) get
 * rules. The post-fix plateau (no new categories) would be 60/360 if we
 * added the 8 new unfixable-equivalent; but the 8 new categories ARE
 * fixable, so they're covered → the plateau drops to the truly-unfixable
 * fraction: 60/360 = 16.7% (ctx-validate 10 + xmod-compound 10 + temporal
 * 20 + adversarial 20).
 */
export function buildHarderBatch(
  round: number,
  config: LearningConfig,
): SimOperation[] {
  const ops: SimOperation[] = [];
  const perCause = 5; // 4 causes × 5 = 20 per category

  // Cat 1-5 (EXP363/374): fixable single-cause (first 4 causes per type).
  // Cat 11-18 (EXP389): the 8 new fixable types (also 4 causes × 5 = 20).
  // Together: 13 types × 20 = 260 single-cause errors/round.
  for (const type of Object.keys(FIXABLE_CAUSES_BY_TYPE)) {
    const causes = (FIXABLE_CAUSES_BY_TYPE[type] ?? []).slice(0, 4);
    for (const cause of causes) {
      for (let i = 0; i < perCause; i += 1) {
        ops.push({ type, cause, wouldFail: true });
      }
    }
  }

  // Cat 6: multi-cause (compound causes).
  for (const type of Object.keys(COMPOUND_CAUSES_BY_TYPE)) {
    const compounds = COMPOUND_CAUSES_BY_TYPE[type] ?? [];
    for (const compound of compounds) {
      for (let i = 0; i < perCause; i += 1) {
        ops.push({ type, cause: compound, wouldFail: true });
      }
    }
  }

  // Cat 7: contextual (2 causes × 2 contexts × 5 = 20).
  for (const type of Object.keys(CONTEXTUAL_CAUSES_BY_TYPE)) {
    const causes = CONTEXTUAL_CAUSES_BY_TYPE[type] ?? [];
    const fixableTags = CONTEXTUAL_FIXABLE_TAGS_BY_TYPE[type] ?? {};
    for (const cause of causes) {
      const fixableTag = fixableTags[cause] ?? "search";
      const unfixableTag = "validate";
      // 5 ops in the fixable context (rule applies → prevented).
      for (let i = 0; i < perCause; i += 1) {
        ops.push({
          type, cause, wouldFail: true,
          context: { [CONTEXT_KEY]: fixableTag },
        });
      }
      // 5 ops in the unfixable context (guard fails → error).
      for (let i = 0; i < perCause; i += 1) {
        ops.push({
          type, cause, wouldFail: true,
          context: { [CONTEXT_KEY]: unfixableTag },
        });
      }
    }
  }

  // Cat 8: temporal (turn > threshold; unfixable cause).
  const temporalTurn = config.temporalTurnThreshold + round;
  for (const type of Object.keys(TEMPORAL_CAUSES_BY_TYPE)) {
    const causes = TEMPORAL_CAUSES_BY_TYPE[type] ?? [];
    for (const cause of causes) {
      for (let i = 0; i < config.errorsPerCategory; i += 1) {
        ops.push({ type, cause, wouldFail: true, context: { turn: temporalTurn } });
      }
    }
  }

  // Cat 9: cross-module (1 fixable × 10 + 1 compound × 10 = 20).
  for (const type of Object.keys(CROSS_MODULE_CAUSES_BY_TYPE)) {
    const causes = CROSS_MODULE_CAUSES_BY_TYPE[type] ?? [];
    for (const cause of causes) {
      const isCompound = isCompoundCause(cause);
      const count = isCompound ? 10 : 10; // 10 each
      for (let i = 0; i < count; i += 1) {
        ops.push({
          type, cause, wouldFail: true,
          context: { sourceModule: "search", targetModule: "editor" },
        });
      }
    }
  }

  // Cat 10: adversarial (20 unique noise causes; unfixable).
  const advType = "false-positive";
  for (let i = 0; i < config.errorsPerCategory; i += 1) {
    adversarialCounter += 1;
    const noiseCause = `${config.adversarialPrefix}${adversarialCounter.toString(36).padStart(4, "0")}`;
    ops.push({ type: advType, cause: noiseCause, wouldFail: true });
  }

  return ops;
}

/** Convert a failed operation into an ErrorRecord for the collector. */
function recordFailedOps(
  collector: ErrorCollector,
  ops: readonly SimOperation[],
  turn: number,
): number {
  let n = 0;
  for (const op of ops) {
    if (!op.wouldFail) continue;
    collector.record({
      type: op.type,
      cause: op.cause,
      turn,
      input: `op:${op.type}/${op.cause}`,
      expected: "success",
      actual: "error",
      context: { ...(op.context ?? {}), wouldFail: true },
    });
    n += 1;
  }
  return n;
}

function runPrePhase(
  collector: ErrorCollector,
  store: LearnedRulesStore,
  batch: SimOperation[],
  turn: number,
  config: LearningConfig,
  learnedThreshold: number | null,
): { pre: BatchMeasurement; recordedErrors: number } {
  const pre = measureBatch(batch, store, config, learnedThreshold);
  const failedOps = batch.filter(
    (op) => op.wouldFail && !isCoveredByRules(op, store, config, learnedThreshold),
  );
  const recordedErrors = recordFailedOps(collector, failedOps, turn);
  return { pre, recordedErrors };
}

/**
 * EXP374 — Run the full 10-round HARDER simulation. Returns a report with
 * the error-rate series (should DECREASE but NOT reach 0%), FP rates (must
 * all be 0), CUSUM chart, Bayesian state, and the learned fuzzy threshold.
 */
export function runHarderSimulation(opts?: {
  config?: LearningConfig;
  rounds?: number;
  storePath?: string;
}): SimulationReport {
  // The harder simulation overrides maxPatternsPerTypePerRound + maxRules
  // to learn faster across 10 rounds (2 causes/type/round covers all 4
  // single-cause + 2 contextual per type in 3 rounds, leaving 7 rounds for
  // compounds + cross-module).
  const baseConfig = opts?.config ?? loadLearningConfig();
  const config = loadLearningConfig({
    // Preserve the base config's key thresholds (so test overrides like
    // high minPatternFrequency or empty policy actually affect the harder
    // simulation).
    minPatternFrequency: baseConfig.minPatternFrequency,
    minConfidence: baseConfig.minConfidence,
    accumulateAcrossRounds: baseConfig.accumulateAcrossRounds,
    rankByCount: baseConfig.rankByCount,
    policy: [...baseConfig.policy] as never,
    knownCauses: Object.fromEntries(
      Object.entries(baseConfig.knownCauses).map(([k, v]) => [k, [...v]]),
    ) as never,
    aprioriMinSupport: baseConfig.aprioriMinSupport,
    aprioriMinConfidence: baseConfig.aprioriMinConfidence,
    miThreshold: baseConfig.miThreshold,
    maxItemsetSize: baseConfig.maxItemsetSize,
    fuzzyEnabled: baseConfig.fuzzyEnabled,
    fuzzyMinDistance: baseConfig.fuzzyMinDistance,
    fuzzyMaxDistance: baseConfig.fuzzyMaxDistance,
    fuzzyLearnThreshold: baseConfig.fuzzyLearnThreshold,
    cusumEnabled: baseConfig.cusumEnabled,
    cusumTargetRate: baseConfig.cusumTargetRate,
    cusumThreshold: baseConfig.cusumThreshold,
    cusumSlack: baseConfig.cusumSlack,
    bayesianEnabled: baseConfig.bayesianEnabled,
    bayesianPrior: baseConfig.bayesianPrior,
    bayesianLearningRate: baseConfig.bayesianLearningRate,
    rounds: baseConfig.rounds,
    errorsPerCategory: baseConfig.errorsPerCategory,
    temporalTurnThreshold: baseConfig.temporalTurnThreshold,
    adversarialPrefix: baseConfig.adversarialPrefix,
    rootCauseEnsembleEnabled: baseConfig.rootCauseEnsembleEnabled,
    biasCoverageThreshold: baseConfig.biasCoverageThreshold,
    exp389Rounds: baseConfig.exp389Rounds,
    // Override: learn faster across 10 rounds.
    maxPatternsPerTypePerRound: Math.max(baseConfig.maxPatternsPerTypePerRound, 2),
    maxPatternsPerRound: Math.max(baseConfig.maxPatternsPerRound, 32),
    maxRules: Math.max(baseConfig.maxRules, 256),
  });
  const rounds = opts?.rounds ?? config.rounds;
  const collector = new ErrorCollector({
    accumulateAcrossRounds: config.accumulateAcrossRounds,
  });
  const store = new LearnedRulesStore(opts?.storePath);
  const llm = new LlmCallCounter();
  const bayes = new BayesianState(config);
  const cleanSet = buildCleanSet(config);
  const biasDetector = new LearningBiasDetector(config);
  adversarialCounter = 0; // reset for determinism

  let learnedThreshold: number | null = null;
  const simulationRounds: SimulationRound[] = [];
  const rootCauseCoverages: number[] = [];

  for (let r = 1; r <= rounds; r += 1) {
    const batch = buildHarderBatch(r, config);
    const { pre, recordedErrors } = runPrePhase(
      collector, store, batch, r, config, learnedThreshold,
    );
    const result = runLearningRound(collector, store, config, r, cleanSet);
    const post = measureBatch(batch, store, config, learnedThreshold);

    // EXP374: learn the fuzzy threshold after round 1 (once we have rules).
    if (config.fuzzyEnabled && config.fuzzyLearnThreshold && store.size() > 0 && learnedThreshold === null) {
      const learnedCauses = store.all().map((r2) => canonicalCauseFromRegex(r2.spec.causeMatch));
      const positiveCauses = collector.all().map((e) => e.cause);
      const negativeCauses = cleanSet.map((c) => c.cause);
      learnedThreshold = learnFuzzyThreshold(learnedCauses, positiveCauses, negativeCauses, config);
    }

    // EXP374: Bayesian update — track prevented-by-rule.
    const postResult = applyRulesToOperations(batch, store, config, learnedThreshold);
    const errorsByType = new Map<string, number>();
    for (const op of batch) {
      if (op.wouldFail) {
        errorsByType.set(op.type, (errorsByType.get(op.type) ?? 0) + 1);
      }
    }
    bayes.updateFromRound(store, postResult.preventedByRule, errorsByType);

    // EXP389: track root-cause-ensemble coverage count for this round.
    let rootCauseCount = 0;
    for (const op of batch) {
      if (!op.wouldFail) continue;
      const cov = checkCoverage(op, store, config, learnedThreshold);
      if (cov.matchKind === "root-cause") rootCauseCount += 1;
    }
    rootCauseCoverages.push(rootCauseCount);

    // EXP389: track per-type coverage for the bias detector.
    const coverageByType = computeCoverageByType(batch, store, config, learnedThreshold);
    biasDetector.track(errorsByType, store, coverageByType);

    simulationRounds.push({
      round: r, pre, post, recordedErrors, result,
      llmCalls: llm.value(),
      bayesianSize: bayes.size(),
    });
  }

  const cusumChart = runCusum(
    simulationRounds.map((r) => r.post.errorRate),
    config,
  );

  const postErrorRates = simulationRounds.map((r) => r.post.errorRate);
  // EXP389: the plateau rate is the final post-error rate (the asymptotic
  // value the series converges to). It should be < 20% per the user's target.
  const plateauRate = postErrorRates[postErrorRates.length - 1] ?? 0;

  return {
    rounds: simulationRounds,
    postErrorRates,
    preErrorRates: simulationRounds.map((r) => r.pre.errorRate),
    fpRates: simulationRounds.map((r) => r.post.fpRate),
    totalRulesAdmitted: store.size(),
    totalLlmCalls: llm.value(),
    config,
    cusumChart,
    learnedFuzzyThreshold: learnedThreshold,
    bayesianSize: bayes.size(),
    biasReport: biasDetector.report(),
    rootCauseCoverages,
    plateauRate,
  };
}

/**
 * EXP389 — Run the full 15-round HARDER simulation (per the user's "at least
 * 5 rounds" + "be thorough" directives — 3× the minimum). Returns the same
 * report as `runHarderSimulation` but with 15 rounds + the bias report +
 * root-cause-ensemble coverage.
 *
 * The 15-round series should plateau at < 20% (the target). The plateau is
 * the truly-unfixable fraction: contextual-validate (intentional validation)
 * + adversarial (random noise).
 */
export function runExp389Simulation(opts?: {
  config?: LearningConfig;
  storePath?: string;
}): SimulationReport {
  const baseConfig = opts?.config ?? loadLearningConfig();
  const config = loadLearningConfig({
    ...baseConfig,
    rounds: baseConfig.exp389Rounds, // 15
    maxPatternsPerTypePerRound: Math.max(baseConfig.maxPatternsPerTypePerRound, 2),
    maxPatternsPerRound: Math.max(baseConfig.maxPatternsPerRound, 32),
    maxRules: Math.max(baseConfig.maxRules, 256),
  } as never);
  return runHarderSimulation({ config, rounds: config.exp389Rounds, ...(opts?.storePath !== undefined ? { storePath: opts.storePath } : {}) });
}

// ---------------------------------------------------------------------------
// EXP374 — Generalization test: after 10 rounds, inject 50 NEW errors
// (unseen types + similar-but-unseen causes). The fuzzy matcher should catch
// the similar causes; novel types should be logged (detection).
// ---------------------------------------------------------------------------

/** Result of the generalization test. */
export interface GeneralizationResult {
  total: number;
  /** Errors of UNSEEN types (should be detected as unknownTypes). */
  unseenTypeErrors: number;
  /** Errors of seen types but unseen causes similar to learned causes. */
  similarCauseErrors: number;
  /** How many similar-cause errors were caught by fuzzy matching. */
  fuzzyCaught: number;
  /** How many unseen-type errors were detected (logged as unknownTypes). */
  unseenTypesDetected: number;
  /** The list of unseen types detected. */
  detectedTypes: string[];
  /** FP rate on the clean set (must be 0). */
  fpRate: number;
  /** LLM calls during the generalization test (must be 0). */
  llmCalls: number;
}

/**
 * Run the generalization test against a pre-trained store. Injects:
 *   - 25 errors of UNSEEN types (e.g. "runtime-crash", "memory-leak").
 *     The system should DETECT them (log as unknownTypes) but cannot FIX
 *     them (no rules exist for unseen types).
 *   - 25 errors of SEEN types with SIMILAR-but-unseen causes (e.g.
 *     "invalid-regexx" for tool-call-failed, Levenshtein distance 1 from
 *     "invalid-regex"). The fuzzy matcher should CATCH these (generalization).
 */
export function runGeneralizationTest(
  store: LearnedRulesStore,
  config: LearningConfig,
  learnedThreshold: number | null,
): GeneralizationResult {
  const collector = new ErrorCollector({ accumulateAcrossRounds: true });
  const llm = new LlmCallCounter();
  const cleanSet = buildCleanSet(config);

  // (1) 25 errors of unseen types.
  const unseenTypes = [
    "runtime-crash", "memory-leak", "deadlock-detected",
    "stack-overflow", "null-pointer-deref",
  ];
  const unseenOps: SimOperation[] = [];
  for (const type of unseenTypes) {
    for (let i = 0; i < 5; i += 1) {
      unseenOps.push({ type, cause: `unseen-${type}-cause`, wouldFail: true });
    }
  }

  // (2) 25 errors of seen types with similar-but-unseen causes.
  // For each of the 5 fixable types, pick the first cause and create a
  // similar variant (Levenshtein distance 1-2).
  const similarOps: SimOperation[] = [];
  const similarVariants: Array<{ type: string; cause: string }> = [
    { type: "tool-call-failed", cause: "invalid-regexx" },       // +1 char from "invalid-regex"
    { type: "edit-preimage-mismatch", cause: "whitespace-tab-vs-space2" }, // +1 char
    { type: "hallucination-detected", cause: "nonexistent-symbol2" },     // +1 char
    { type: "false-positive", cause: "rename-only-clone2" },             // +1 char
    { type: "false-negative", cause: "comment-only-diff2" },             // +1 char
  ];
  for (const v of similarVariants) {
    for (let i = 0; i < 5; i += 1) {
      similarOps.push({ type: v.type, cause: v.cause, wouldFail: true });
    }
  }

  const allOps = [...unseenOps, ...similarOps];

  // Record all wouldFail ops (they're all errors — no rule covers unseen types).
  for (const op of allOps) {
    if (op.wouldFail) {
      collector.record({
        type: op.type, cause: op.cause, turn: 1,
        input: `op:${op.type}/${op.cause}`, expected: "success", actual: "error",
        context: { generalization: true },
      });
    }
  }

  // Count fuzzy catches among similar-cause ops.
  let fuzzyCaught = 0;
  for (const op of similarOps) {
    const result = checkCoverage(op, store, config, learnedThreshold);
    if (result.covered && result.matchKind === "fuzzy") fuzzyCaught += 1;
  }

  // Detect unseen types.
  const observedTypes = collector.observedTypes();
  const knownTypes = new Set(Object.keys(config.knownCauses));
  const detectedTypes = observedTypes.filter((t) => !knownTypes.has(t));

  // FP check on the clean set.
  const cleanBatch: SimOperation[] = cleanSet.map((c) => ({
    type: c.type, cause: c.cause, wouldFail: false,
  }));
  const cleanMeas = measureBatch(cleanBatch, store, config, learnedThreshold);

  return {
    total: allOps.length,
    unseenTypeErrors: unseenOps.length,
    similarCauseErrors: similarOps.length,
    fuzzyCaught,
    unseenTypesDetected: detectedTypes.length,
    detectedTypes,
    fpRate: cleanMeas.fpRate,
    llmCalls: llm.value(),
  };
}

// ---------------------------------------------------------------------------
// EXP389 — Typescript generalization test: train on the babel profile (the
// 15-round simulation), test on a TYPESCRIPT profile (a different "codebase"
// with the same categories but different cause names + 5 unseen TS-specific
// types + a root-cause-ensemble case). Verifies the learned rules generalize
// to a new codebase via:
//   (1) Fuzzy matching: similar-but-unseen causes (Levenshtein 1-2) are caught
//       by the fuzzy matcher (rules learned on babel apply to typescript).
//   (2) Root-cause ensemble: a NEW compound cause in typescript whose root
//       cause has a rule (learned on babel) is covered by the ensemble.
//   (3) Unseen-type detection: 5 typescript-specific types (type-checker-error,
//       module-resolution-error, etc.) are detected as unknownTypes.
//   (4) Learning-bias check: the typescript profile has a rare type (low
//       count); the bias detector should flag it (rareTypes non-empty).
//   (5) 0 FPs on the clean set + 0 LLM calls.
// ---------------------------------------------------------------------------

/** Result of the typescript generalization test. */
export interface TypescriptGeneralizationResult {
  /** Total injected typescript errors. */
  total: number;
  /** Errors with similar-but-unseen causes (fuzzy-match targets). */
  similarCauseErrors: number;
  /** How many similar-cause errors were caught by fuzzy matching. */
  fuzzyCaught: number;
  /** Errors of unseen typescript types (detection targets). */
  unseenTypeErrors: number;
  /** How many unseen types were detected (logged as unknownTypes). */
  unseenTypesDetected: number;
  /** The list of unseen types detected. */
  detectedTypes: string[];
  /** A NEW compound cause in typescript whose root cause has a rule. */
  rootCauseCompoundErrors: number;
  /** How many root-cause-compound errors were covered by the ensemble. */
  rootCauseCaught: number;
  /** FP rate on the clean set (must be 0). */
  fpRate: number;
  /** LLM calls (must be 0). */
  llmCalls: number;
  /** The bias report on the typescript profile (rare-type detection). */
  biasReport: BiasReport;
  /** True if the rules generalize (fuzzy + root-cause both caught ≥1). */
  generalizes: boolean;
}

/**
 * Run the typescript generalization test against a pre-trained store (the
 * store trained on the babel profile via runExp389Simulation or
 * runHarderSimulation). The typescript profile is a different "codebase"
 * with:
 *   - The SAME 13 fixable types as babel, but with DIFFERENT cause names
 *     (Levenshtein distance 1-2 from the babel causes). Tests fuzzy matching.
 *   - 5 UNSEEN typescript-specific types (e.g. "type-checker-error"). Tests
 *     unseen-type detection.
 *   - 1 NEW compound cause whose root cause has a rule (tests root-cause
 *     ensemble generalization to a new compound).
 *   - 1 RARE type (only 2 errors) to trigger the bias detector's rare-type
 *     flag (tests bias detection on the new profile).
 *
 * The rules learned on babel should generalize to typescript via fuzzy
 * matching + root-cause ensemble. The unseen types should be detected. The
 * rare type should be flagged by the bias detector.
 */
export function runTypescriptGeneralizationTest(
  store: LearnedRulesStore,
  config: LearningConfig,
  learnedThreshold: number | null,
): TypescriptGeneralizationResult {
  const collector = new ErrorCollector({ accumulateAcrossRounds: true });
  const llm = new LlmCallCounter();
  const cleanSet = buildCleanSet(config);

  // (1) Similar-but-unseen causes: for each of 8 babel fixable types, inject
  // 5 errors with a typescript-variant cause (Levenshtein 1-2 from the babel
  // cause). The fuzzy matcher should catch these.
  const similarVariants: Array<{ type: string; cause: string }> = [
    { type: "tool-call-failed", cause: "invalid-regexx" },            // +1 char
    { type: "edit-preimage-mismatch", cause: "whitespace-tab-vs-space2" }, // +1 char
    { type: "hallucination-detected", cause: "nonexistent-symbol2" }, // +1 char
    { type: "false-positive", cause: "rename-only-clone2" },          // +1 char
    { type: "false-negative", cause: "comment-only-diff2" },          // +1 char
    // EXP389 new types: typescript-variant causes.
    { type: "context-too-long", cause: "history-exceeds-max-tokens2" },// +1 char
    { type: "tool-call-timeout", cause: "execution-exceeded-deadline2" },// +1 char
    { type: "edit-conflict", cause: "race-condition2" },             // +1 char
  ];
  const similarOps: SimOperation[] = [];
  for (const v of similarVariants) {
    for (let i = 0; i < 5; i += 1) {
      similarOps.push({ type: v.type, cause: v.cause, wouldFail: true });
    }
  }

  // (2) Unseen typescript-specific types: 5 types not in the babel catalog.
  const unseenTypes = [
    "type-checker-error",
    "module-resolution-error",
    "syntax-error-detected",
    "binding-error",
    "transform-error",
  ];
  const unseenOps: SimOperation[] = [];
  for (const type of unseenTypes) {
    for (let i = 0; i < 5; i += 1) {
      unseenOps.push({ type, cause: `ts-${type}-cause`, wouldFail: true });
    }
  }

  // (3) A NEW compound cause in typescript whose root cause has a rule.
  // The compound "search-stale-preimage+race-condition" is in the
  // ROOT_CAUSE_MAP. Even though the compound cause is unseen in typescript,
  // the root-cause ensemble should cover it (the race-condition rule was
  // learned on babel).
  const rootCauseCompoundOps: SimOperation[] = [];
  for (let i = 0; i < 5; i += 1) {
    rootCauseCompoundOps.push({
      type: "edit-preimage-mismatch",
      cause: "search-stale-preimage+race-condition",
      wouldFail: true,
      context: { sourceModule: "search", targetModule: "editor" },
    });
  }

  // (4) A RARE type: only 2 errors (below the mean). The bias detector
  // should flag it as a rare type. Use a babel type NOT in similarOps so
  // its total count stays at 2 (well below the mean of ~5).
  const rareType = "tool-call-rate-limit";
  const rareOps: SimOperation[] = [];
  for (let i = 0; i < 2; i += 1) {
    rareOps.push({
      type: rareType,
      cause: "api-returned-429-ts-variant",
      wouldFail: true,
    });
  }

  const allOps = [...similarOps, ...unseenOps, ...rootCauseCompoundOps, ...rareOps];

  // Record all wouldFail ops.
  for (const op of allOps) {
    if (op.wouldFail) {
      collector.record({
        type: op.type, cause: op.cause, turn: 1,
        input: `ts:${op.type}/${op.cause}`, expected: "success", actual: "error",
        context: { generalization: "typescript", ...(op.context ?? {}) },
      });
    }
  }

  // Count fuzzy catches among similar-cause ops.
  let fuzzyCaught = 0;
  for (const op of similarOps) {
    const result = checkCoverage(op, store, config, learnedThreshold);
    if (result.covered && result.matchKind === "fuzzy") fuzzyCaught += 1;
  }

  // Count root-cause-ensemble catches.
  let rootCauseCaught = 0;
  for (const op of rootCauseCompoundOps) {
    const result = checkCoverage(op, store, config, learnedThreshold);
    if (result.covered && result.matchKind === "root-cause") rootCauseCaught += 1;
  }

  // Detect unseen types.
  const observedTypes = collector.observedTypes();
  const knownTypes = new Set(Object.keys(config.knownCauses));
  const detectedTypes = observedTypes.filter((t) => !knownTypes.has(t));

  // FP check on the clean set.
  const cleanBatch: SimOperation[] = cleanSet.map((c) => ({
    type: c.type, cause: c.cause, wouldFail: false,
  }));
  const cleanMeas = measureBatch(cleanBatch, store, config, learnedThreshold);

  // Bias detector on the typescript profile.
  const biasDetector = new LearningBiasDetector(config);
  const errorsByType = new Map<string, number>();
  for (const op of allOps) {
    if (op.wouldFail) errorsByType.set(op.type, (errorsByType.get(op.type) ?? 0) + 1);
  }
  const coverageByType = computeCoverageByType(allOps, store, config, learnedThreshold);
  biasDetector.track(errorsByType, store, coverageByType);
  const biasReport = biasDetector.report();

  const generalizes = fuzzyCaught >= 1 && rootCauseCaught >= 1;

  return {
    total: allOps.length,
    similarCauseErrors: similarOps.length,
    fuzzyCaught,
    unseenTypeErrors: unseenOps.length,
    unseenTypesDetected: detectedTypes.length,
    detectedTypes,
    rootCauseCompoundErrors: rootCauseCompoundOps.length,
    rootCauseCaught,
    fpRate: cleanMeas.fpRate,
    llmCalls: llm.value(),
    biasReport,
    generalizes,
  };
}

// ---------------------------------------------------------------------------
// EXP363 backward-compat: the original 5-round simulation (kept for the
// regression test). The 10-round harder simulation is runHarderSimulation.
// ---------------------------------------------------------------------------

/** EXP363 5-round simulation (backward compat). */
export function runSimulation(opts?: {
  config?: LearningConfig;
  rounds?: number;
  perCause?: number;
  storePath?: string;
}): SimulationReport {
  const config = opts?.config ?? loadLearningConfig();
  const rounds = opts?.rounds ?? 5;
  const perCause = opts?.perCause ?? 4;
  const collector = new ErrorCollector({
    accumulateAcrossRounds: config.accumulateAcrossRounds,
  });
  const store = new LearnedRulesStore(opts?.storePath);
  const llm = new LlmCallCounter();
  const cleanSet = buildCleanSet(config);
  const simulationRounds: SimulationRound[] = [];
  const baseCauses: Readonly<Record<string, readonly string[]>> = FIXABLE_CAUSES_BY_TYPE;

  for (let r = 1; r <= rounds; r += 1) {
    const batch = buildBatch(baseCauses, perCause, true);
    const { pre, recordedErrors } = runPrePhase(collector, store, batch, r, config, null);
    const result = runLearningRound(collector, store, config, r, cleanSet);
    const post = measureBatch(batch, store, config, null);
    simulationRounds.push({
      round: r, pre, post, recordedErrors, result,
      llmCalls: llm.value(), bayesianSize: 0,
    });
  }

  const cusumChart = runCusum(
    simulationRounds.map((r) => r.post.errorRate), config,
  );

  return {
    rounds: simulationRounds,
    postErrorRates: simulationRounds.map((r) => r.post.errorRate),
    preErrorRates: simulationRounds.map((r) => r.pre.errorRate),
    fpRates: simulationRounds.map((r) => r.post.fpRate),
    totalRulesAdmitted: store.size(),
    totalLlmCalls: llm.value(),
    config, cusumChart,
    learnedFuzzyThreshold: null, bayesianSize: 0,
  };
}

// ---------------------------------------------------------------------------
// EXP363 backward-compat: the harder phase (unfixable + novel + multi-cause).
// ---------------------------------------------------------------------------

export interface HarderPhaseResult {
  total: number;
  errors: number;
  errorRate: number;
  fpRate: number;
  detectedUnfixable: number;
  novelTypeLogged: boolean;
  novelType: string;
  unmatchedPatterns: number;
  llmCalls: number;
  newRulesAdmitted: number;
}

export function runHarderPhase(
  store: LearnedRulesStore,
  config: LearningConfig,
  opts?: { perCause?: number; novelType?: string },
): HarderPhaseResult {
  const perCause = opts?.perCause ?? 4;
  const novelType = opts?.novelType ?? "context-window-overflow";
  const collector = new ErrorCollector({ accumulateAcrossRounds: config.accumulateAcrossRounds });
  const llm = new LlmCallCounter();
  const cleanSet = buildCleanSet(config);

  const unfixableBatch = buildBatch(UNFIXABLE_CAUSES_BY_TYPE, perCause, true);
  const novelCauses: Readonly<Record<string, readonly string[]>> = {
    [novelType]: ["long-history-truncation", "tool-output-too-large"],
  };
  const novelBatch = buildBatch(novelCauses, perCause, true);
  const multiCauses: Record<string, string[]> = {};
  for (const type of Object.keys(FIXABLE_CAUSES_BY_TYPE)) {
    const firstFixable = (FIXABLE_CAUSES_BY_TYPE[type] ?? [])[0];
    if (firstFixable) multiCauses[type] = [`${firstFixable}+race-condition`];
  }
  const multiBatch = buildBatch(multiCauses, perCause, true);
  const harderBatch = [...unfixableBatch, ...novelBatch, ...multiBatch];

  const before = measureBatch(harderBatch, store, config, null);
  const failed = harderBatch.filter(
    (op) => op.wouldFail && !isCoveredByRules(op, store, config, null),
  );
  for (const op of failed) {
    collector.record({
      type: op.type, cause: op.cause, turn: 1,
      input: `op:${op.type}/${op.cause}`, expected: "success", actual: "error",
      context: { wouldFail: true, phase: "harder" },
    });
  }

  const result = runLearningRound(collector, store, config, 1, cleanSet);
  const cleanBatch: SimOperation[] = cleanSet.map((c) => ({
    type: c.type, cause: c.cause, wouldFail: false,
  }));
  const cleanMeas = measureBatch(cleanBatch, store, config, null);

  return {
    total: harderBatch.length,
    errors: before.errors,
    errorRate: before.errorRate,
    fpRate: cleanMeas.fpRate,
    detectedUnfixable: result.patternsUnmatched.length,
    novelTypeLogged: collector.observedTypes().includes(novelType),
    novelType, unmatchedPatterns: result.patternsUnmatched.length,
    llmCalls: llm.value(), newRulesAdmitted: result.rulesAdmitted.length,
  };
}

export { loadLearningConfig, ErrorCollector, LearnedRulesStore };
export type { ErrorRecord, SimOperation, RoundResult, LearningConfig };
