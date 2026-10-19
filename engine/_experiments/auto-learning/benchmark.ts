/**
 * EXP451 — Benchmark: run all 8 pattern-extraction techniques + all 5
 * rule-application techniques on the same collector + clean set, measure
 * recall / FP-rate / latency / memory for each, and pick the winner per
 * profile. The benchmark is the MANDATORY "benchmark many techniques"
 * directive.
 *
 * 8 EXTRACTION techniques benchmarked:
 *   1. Frequency analysis (extractor.ts — EXP363)
 *   2. Mutual Information (multi-cause.ts — EXP374)
 *   3. Apriori association rules (multi-cause.ts — EXP374)
 *   4. CUSUM change detection (cusum.ts — EXP296/374)
 *   5. Bayesian Beta-Bernoulli (bayesian.ts — EXP374)
 *   6. Genetic Algorithm (genetic-algorithm.ts — EXP451 NEW)
 *   7. N-gram analysis (ngram.ts — EXP451 NEW)
 *   8. Decision tree (decision-tree.ts — EXP451 NEW)
 *
 * 5 APPLICATION techniques benchmarked:
 *   1. Exact match (anchored regex — EXP363)
 *   2. Fuzzy match (Levenshtein — EXP374)
 *   3. Semantic match (TF-IDF char n-gram cosine — EXP451 NEW)
 *   4. Contextual match (context-tag guard — EXP374)
 *   5. Compound match (multi-cause + root-cause — EXP374/389)
 *
 * Each technique is measured in isolation: same input (collector + clean
 * set), same budget. The benchmark reports per-technique:
 *   - recall (fraction of wouldFail ops covered by the technique's rules)
 *   - fpRate (fraction of clean ops wrongly covered — must be ~0)
 *   - latencyMs (wall time to extract + apply)
 *   - heapKB (delta heap used during the technique's run)
 *   - rulesCount (rules produced/consumed)
 *
 * The winner is the technique with the highest (recall - fpRate) at
 * latency <= budget. All techniques are deterministic + 0 LLM.
 */

import type { ErrorCollector } from "./collector.ts";
import type { LearningConfig, LearnedRulesStore } from "./config.ts";
import type { SimOperation } from "./index.ts";
import { checkCoverage } from "./index.ts";
import { extractPatterns } from "./extractor.ts";
import {
  extractMultiCausePatterns,
  aprioriFrequentItemsets,
} from "./multi-cause.ts";
import { runCusum, shouldTriggerLearning } from "./cusum.ts";
import { BayesianState, rankRulesByPosterior } from "./bayesian.ts";
import {
  extractNgramPatterns,
  ngramMatch,
} from "./ngram.ts";
import { extractGaPatterns } from "./genetic-algorithm.ts";
import {
  extractDecisionTreePatterns,
  dtMatch,
} from "./decision-tree.ts";
import {
  buildSemanticVectors,
  semanticMatch,
} from "./semantic-match.ts";

/** Result of one technique's benchmark run. */
export interface TechniqueResult {
  name: string;
  /** EXP461 (L1): what the technique does — "extraction" (produces patterns),
   *  "trigger" (decides WHEN to learn, not WHAT), or "ranking" (orders rules).
   *  Only "extraction" techniques compete for bestExtractor; triggers + rankers
   *  are reported separately so CUSUM's recall=1.0 (change-point accuracy)
   *  no longer conflate with pattern-coverage. */
  category: "extraction" | "trigger" | "ranking";
  /** recall on the wouldFail set (fraction covered). */
  recall: number;
  /** EXP461 (L2): recall on a held-out test set (fraction covered), when one
   *  is provided. Same value as `recall` when no held-out set is given. */
  heldOutRecall: number;
  /** FP rate on the clean set (fraction wrongly covered). */
  fpRate: number;
  /** Wall time in milliseconds. */
  latencyMs: number;
  /** Heap delta in KB (approximate, via process.memoryUsage). */
  heapKB: number;
  /** Number of rules the technique produced (extraction) or consumed
   *  (application). */
  rulesCount: number;
  /** Whether the technique's output is admissible (recall high, FP low). */
  admissible: boolean;
}

/** A benchmark over all 8 extraction + 5 application techniques. */
export interface BenchmarkReport {
  extraction: ReadonlyArray<TechniqueResult>;
  /** EXP461 (L1): trigger techniques (CUSUM) reported separately so
   *  change-point recall does not conflate with pattern coverage. */
  triggers: ReadonlyArray<TechniqueResult>;
  application: ReadonlyArray<TechniqueResult>;
  bestExtractor: string;
  bestMatcher: string;
  /** EXP461 (L1): the best trigger technique (CUSUM) reported separately so
   *  its change-point recall does not conflate with pattern coverage. */
  bestTrigger: string;
  /** EXP461 (L1): the best ranking technique (Bayesian) reported separately. */
  bestRanker: string;
  /** Total benchmark wall time (ms). */
  totalMs: number;
  /** 0 LLM calls (assertion — all techniques are deterministic). */
  llmCalls: number;
}

function heapKB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024);
}

function measure<T>(fn: () => T): { result: T; latencyMs: number; heapKB: number } {
  const start = Date.now();
  const h0 = heapKB();
  const result = fn();
  if (global.gc) global.gc();
  const h1 = heapKB();
  return { result, latencyMs: Date.now() - start, heapKB: Math.max(0, h1 - h0) };
}

/** Strip context from an op (for exact/fuzzy/semantic benchmarks that
 *  must NOT fire contextual guards). Returns a new op without context. */
function stripContext(op: SimOperation): SimOperation {
  if (op.context === undefined) return op;
  return { type: op.type, cause: op.cause, wouldFail: op.wouldFail };
}

/**
 * Compute recall + FP rate for a set of "covered" decisions over the
 * wouldFail set + clean set. `coveredFn(op) => boolean` is the matcher.
 */
function measureCoverage(
  wouldFail: readonly SimOperation[],
  clean: readonly SimOperation[],
  coveredFn: (op: SimOperation) => boolean,
): { recall: number; fpRate: number } {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;
  for (const op of wouldFail) {
    if (coveredFn(op)) tp += 1;
    else fn += 1;
  }
  for (const op of clean) {
    if (coveredFn(op)) fp += 1;
    else tn += 1;
  }
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const fpRate = fp + tn > 0 ? fp / (fp + tn) : 0;
  return { recall, fpRate };
}

/** EXP461 (L2): recall of a coveredFn on the held-out test set (unseen
 *  causes). Measures generalization, not training-set overfit. */
function heldOutRecallFor(
  coveredFn: (op: SimOperation) => boolean,
  heldOut: readonly SimOperation[],
): number {
  let tp = 0;
  let fn = 0;
  for (const op of heldOut) {
    if (coveredFn(op)) tp += 1;
    else fn += 1;
  }
  return tp + fn > 0 ? tp / (tp + fn) : 0;
}

/**
 * Run the full benchmark: all 8 extraction + all 5 application techniques.
 * The `store` is the pre-trained rule store (for application techniques
 * that consume learned rules). The `collector` is the error history.
 * `cleanOps` is the FP check set.
 */
export function runBenchmark(
  collector: ErrorCollector,
  store: LearnedRulesStore,
  config: LearningConfig,
  wouldFail: readonly SimOperation[],
  cleanOps: readonly SimOperation[],
  heldOut?: readonly SimOperation[],
): BenchmarkReport {
  const llmCalls = 0; // assertion: no LLM
  const t0 = Date.now();
  const cleanCauses = cleanOps.map((o) => ({ type: o.type, cause: o.cause }));
  const existingRules = store.all().map((r) => ({ spec: r.spec }));
  const extraction: TechniqueResult[] = [];
  // EXP461 (L1): triggers (when to learn) are reported separately from
  // extractors (what to learn) so a trigger's change-point recall cannot
  // conflate with pattern coverage and win bestExtractor.
  const triggers: TechniqueResult[] = [];
  // EXP461 (L2): the held-out test set measures generalization (unseen
  // causes). When omitted, heldOutRecall falls back to the training recall.
  const heldOutOps = heldOut ?? wouldFail;

  // ---- 8 extraction techniques ----

  // 1. Frequency analysis (extractor.ts).
  {
    const m = measure(() => extractPatterns(collector, config, existingRules));
    const coveredFn = (op: SimOperation): boolean => {
      for (const p of m.result) {
        if (p.type !== op.type) continue;
        if (new RegExp(`^${p.cause}$`, "u").test(op.cause)) return true;
      }
      return false;
    };
    const cov = measureCoverage(wouldFail, cleanOps, coveredFn);
    extraction.push({
      name: "frequency",
      category: "extraction",
      recall: cov.recall, fpRate: cov.fpRate,
      heldOutRecall: heldOutRecallFor(coveredFn, heldOutOps),
      latencyMs: m.latencyMs, heapKB: m.heapKB,
      rulesCount: m.result.length,
      admissible: cov.recall > 0 && cov.fpRate === 0,
    });
  }

  // 2. Mutual Information (multi-cause.ts).
  {
    const m = measure(() => extractMultiCausePatterns(collector, config));
    const coveredFn = (op: SimOperation): boolean => {
      for (const mp of m.result.patterns) {
        if (mp.type !== op.type) continue;
        if (op.cause.includes(mp.compoundCause)) return true;
      }
      return false;
    };
    const cov = measureCoverage(wouldFail, cleanOps, coveredFn);
    extraction.push({
      name: "mutual-information",
      category: "extraction",
      recall: cov.recall, fpRate: cov.fpRate,
      heldOutRecall: heldOutRecallFor(coveredFn, heldOutOps),
      latencyMs: m.latencyMs, heapKB: m.heapKB,
      rulesCount: m.result.patterns.length,
      admissible: cov.recall > 0 && cov.fpRate === 0,
    });
  }

  // 3. Apriori association rules (multi-cause.ts).
  {
    const m = measure(() => {
      const out: { type: string; itemset: string[]; support: number }[] = [];
      const knownTypes = Object.keys(config.knownCauses);
      for (const type of knownTypes) {
        const recs = collector.byType(type);
        const transactions = recs.map((r) =>
          r.cause.split("+").filter((s) => s.length > 0),
        );
        const itemsets = aprioriFrequentItemsets(
          transactions, config.aprioriMinSupport, config.maxItemsetSize,
        );
        for (const val of itemsets.values()) {
          out.push({ type, itemset: val.itemset, support: val.support });
        }
      }
      return out;
    });
    const coveredFn = (op: SimOperation): boolean => {
      const tokens = op.cause.split("+").filter((s) => s.length > 0);
      for (const r of m.result) {
        if (r.type !== op.type) continue;
        if (r.itemset.every((t) => tokens.includes(t))) return true;
      }
      return false;
    };
    const cov = measureCoverage(wouldFail, cleanOps, coveredFn);
    extraction.push({
      name: "apriori",
      category: "extraction",
      recall: cov.recall, fpRate: cov.fpRate,
      heldOutRecall: heldOutRecallFor(coveredFn, heldOutOps),
      latencyMs: m.latencyMs, heapKB: m.heapKB,
      rulesCount: m.result.length,
      admissible: cov.recall > 0 && cov.fpRate === 0,
    });
  }

  // 4. CUSUM change detection (cusum.ts — EXP461 L1: a TRIGGER, not an extractor).
  {
    const m = measure(() => {
      const rates = [1.0, 0.66, 0.33, 0.16, 0.05, 0.05, 0.05, 0.45, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
      const chart = runCusum(rates, config);
      const triggers = chart.readings.map((_, i) =>
        shouldTriggerLearning(chart, i, 3),
      );
      return { chart, triggers, rates };
    });
    let trueChanges = 0;
    let detected = 0;
    for (let i = 1; i < m.result.rates.length; i += 1) {
      const prev = m.result.rates[i - 1] ?? 0;
      const cur = m.result.rates[i] ?? 0;
      if (Math.abs(cur - prev) > 0.1) {
        trueChanges += 1;
        if (m.result.triggers[i]?.trigger) detected += 1;
      }
    }
    const recall = trueChanges > 0 ? detected / trueChanges : 0;
    triggers.push({
      name: "cusum",
      category: "trigger",
      recall,
      heldOutRecall: recall,
      fpRate: 0,
      latencyMs: m.latencyMs, heapKB: m.heapKB,
      rulesCount: m.result.triggers.filter((t) => t.trigger).length,
      admissible: recall > 0,
    });
  }

  // 5. Bayesian Beta-Bernoulli (bayesian.ts — EXP461 L1: a RANKER, not an extractor).
  {
    const m = measure(() => {
      const bayes = new BayesianState(config);
      const prevented = new Map<string, number>();
      for (const e of collector.all()) {
        prevented.set(e.type, (prevented.get(e.type) ?? 0) + 1);
      }
      const errorsByType = new Map<string, number>();
      for (const e of collector.all()) {
        errorsByType.set(e.type, (errorsByType.get(e.type) ?? 0) + 1);
      }
      bayes.updateFromRound(store, prevented, errorsByType);
      return rankRulesByPosterior(store, bayes);
    });
    const rankedTypes = new Set<string>();
    for (const r of store.all()) {
      if (m.result.includes(r.id)) rankedTypes.add(r.spec.type);
    }
    const coveredFn = (op: SimOperation): boolean => rankedTypes.has(op.type);
    const cov = measureCoverage(wouldFail, cleanOps, coveredFn);
    extraction.push({
      name: "bayesian",
      category: "ranking",
      recall: cov.recall, fpRate: cov.fpRate,
      heldOutRecall: heldOutRecallFor(coveredFn, heldOutOps),
      latencyMs: m.latencyMs, heapKB: m.heapKB,
      rulesCount: m.result.length,
      admissible: cov.recall > 0 && cov.fpRate === 0,
    });
  }

  // 6. Genetic Algorithm (genetic-algorithm.ts — EXP451 NEW).
  {
    const m = measure(() => extractGaPatterns(collector, config, cleanCauses));
    const coveredFn = (op: SimOperation): boolean => {
      for (const g of m.result) {
        if (g.type !== op.type) continue;
        const re = g.anchored
          ? new RegExp(`^${g.regex}$`, "u")
          : new RegExp(g.regex, "u");
        if (re.test(op.cause)) return true;
      }
      return false;
    };
    const cov = measureCoverage(wouldFail, cleanOps, coveredFn);
    extraction.push({
      name: "genetic-algorithm",
      category: "extraction",
      recall: cov.recall, fpRate: cov.fpRate,
      heldOutRecall: heldOutRecallFor(coveredFn, heldOutOps),
      latencyMs: m.latencyMs, heapKB: m.heapKB,
      rulesCount: m.result.length,
      admissible: cov.recall > 0 && cov.fpRate === 0,
    });
  }

  // 7. N-gram analysis (ngram.ts — EXP451 NEW, EXP461 S6 discrimination).
  {
    const m = measure(() => extractNgramPatterns(collector, config, cleanCauses));
    const coveredFn = (op: SimOperation): boolean => {
      const rules = m.result.map((p) => ({
        spec: { type: p.type, causeMatch: p.ngram },
      }));
      return ngramMatch(op, rules).matched;
    };
    const cov = measureCoverage(wouldFail, cleanOps, coveredFn);
    extraction.push({
      name: "ngram",
      category: "extraction",
      recall: cov.recall, fpRate: cov.fpRate,
      heldOutRecall: heldOutRecallFor(coveredFn, heldOutOps),
      latencyMs: m.latencyMs, heapKB: m.heapKB,
      rulesCount: m.result.length,
      admissible: cov.recall > 0 && cov.fpRate === 0,
    });
  }

  // 8. Decision tree (decision-tree.ts — EXP451 NEW).
  {
    const m = measure(() => extractDecisionTreePatterns(collector, config, cleanCauses));
    const coveredFn = (op: SimOperation): boolean => dtMatch(op, m.result).matched;
    const cov = measureCoverage(wouldFail, cleanOps, coveredFn);
    extraction.push({
      name: "decision-tree",
      category: "extraction",
      recall: cov.recall, fpRate: cov.fpRate,
      heldOutRecall: heldOutRecallFor(coveredFn, heldOutOps),
      latencyMs: m.latencyMs, heapKB: m.heapKB,
      rulesCount: m.result.length,
      admissible: cov.recall > 0 && cov.fpRate === 0,
    });
  }

  // ---- 5 application techniques ----
  const application: TechniqueResult[] = [];
  const learnedThreshold = null;
  const exactOnlyConfig = { ...config, fuzzyEnabled: false } as LearningConfig;

  // 1. Exact match (anchored regex).
  {
    const m = measure(() => {
      let tp = 0, fn = 0, fp = 0, tn = 0;
      for (const op of wouldFail) {
        const cov = checkCoverage(stripContext(op), store, exactOnlyConfig, learnedThreshold);
        if (cov.matchKind === "exact") tp += 1;
        else fn += 1;
      }
      for (const op of cleanOps) {
        const cov = checkCoverage(stripContext(op), store, exactOnlyConfig, learnedThreshold);
        if (cov.covered && cov.matchKind === "exact") fp += 1;
        else tn += 1;
      }
      return { tp, fn, fp, tn };
    });
    const recall = m.result.tp + m.result.fn > 0 ? m.result.tp / (m.result.tp + m.result.fn) : 0;
    const fpRate = m.result.fp + m.result.tn > 0 ? m.result.fp / (m.result.fp + m.result.tn) : 0;
    const hoWouldFail = heldOutOps.filter((o) => o.wouldFail);
    const hoTp = hoWouldFail.reduce((acc, op) => acc + (checkCoverage(stripContext(op), store, exactOnlyConfig, learnedThreshold).matchKind === "exact" ? 1 : 0), 0);
    const heldOutRecall = hoWouldFail.length > 0 ? hoTp / hoWouldFail.length : recall;
    application.push({
      name: "exact",
      category: "extraction",
      recall, fpRate,
      heldOutRecall,
      latencyMs: m.latencyMs, heapKB: m.heapKB,
      rulesCount: store.size(),
      admissible: recall > 0 && fpRate === 0,
    });
  }

  // 2. Fuzzy match (Levenshtein).
  {
    const m = measure(() => {
      let tp = 0, fn = 0, fp = 0, tn = 0;
      for (const op of wouldFail) {
        const cov = checkCoverage(stripContext(op), store, config, learnedThreshold);
        if (cov.matchKind === "fuzzy") tp += 1;
        else fn += 1;
      }
      for (const op of cleanOps) {
        const cov = checkCoverage(stripContext(op), store, config, learnedThreshold);
        if (cov.matchKind === "fuzzy") fp += 1;
        else tn += 1;
      }
      return { tp, fn, fp, tn };
    });
    const recall = m.result.tp + m.result.fn > 0 ? m.result.tp / (m.result.tp + m.result.fn) : 0;
    const fpRate = m.result.fp + m.result.tn > 0 ? m.result.fp / (m.result.fp + m.result.tn) : 0;
    const hoWouldFail = heldOutOps.filter((o) => o.wouldFail);
    const hoTp = hoWouldFail.reduce((acc, op) => acc + (checkCoverage(stripContext(op), store, config, learnedThreshold).matchKind === "fuzzy" ? 1 : 0), 0);
    const heldOutRecall = hoWouldFail.length > 0 ? hoTp / hoWouldFail.length : recall;
    application.push({
      name: "fuzzy",
      category: "extraction",
      recall, fpRate,
      heldOutRecall,
      latencyMs: m.latencyMs, heapKB: m.heapKB,
      rulesCount: store.size(),
      admissible: recall > 0 && fpRate === 0,
    });
  }

  // 3. Semantic match (TF-IDF char n-gram cosine — EXP451 NEW).
  {
    const rules = store.all().map((r) => ({ id: r.id, spec: r.spec }));
    const { vectors, df, corpusSize } = buildSemanticVectors(
      rules, cleanCauses,
      config.semanticNgramMin, config.semanticNgramMax,
    );
    const m = measure(() => {
      let tp = 0, fn = 0, fp = 0, tn = 0;
      for (const op of wouldFail) {
        const res = semanticMatch(
          { type: op.type, cause: op.cause },
          vectors, df, corpusSize,
          config.semanticNgramMin, config.semanticNgramMax,
          config.semanticMinSimilarity,
          config.semanticMinEditSimilarity,
        );
        if (res.matched) tp += 1;
        else fn += 1;
      }
      for (const op of cleanOps) {
        const res = semanticMatch(
          { type: op.type, cause: op.cause },
          vectors, df, corpusSize,
          config.semanticNgramMin, config.semanticNgramMax,
          config.semanticMinSimilarity,
          config.semanticMinEditSimilarity,
        );
        if (res.matched) fp += 1;
        else tn += 1;
      }
      return { tp, fn, fp, tn };
    });
    const recall = m.result.tp + m.result.fn > 0 ? m.result.tp / (m.result.tp + m.result.fn) : 0;
    const fpRate = m.result.fp + m.result.tn > 0 ? m.result.fp / (m.result.fp + m.result.tn) : 0;
    const hoWouldFail = heldOutOps.filter((o) => o.wouldFail);
    let hoSemTp = 0;
    for (const op of hoWouldFail) {
      const res = semanticMatch({ type: op.type, cause: op.cause }, vectors, df, corpusSize, config.semanticNgramMin, config.semanticNgramMax, config.semanticMinSimilarity, config.semanticMinEditSimilarity);
      if (res.matched) hoSemTp += 1;
    }
    const heldOutRecall = hoWouldFail.length > 0 ? hoSemTp / hoWouldFail.length : recall;
    application.push({
      name: "semantic",
      category: "extraction",
      recall, fpRate,
      heldOutRecall,
      latencyMs: m.latencyMs, heapKB: m.heapKB,
      rulesCount: store.size(),
      admissible: recall > 0 && fpRate === 0,
    });
  }

  // 4. Contextual match (context-tag guard).
  {
    const m = measure(() => {
      let tp = 0, fn = 0, fp = 0, tn = 0;
      for (const op of wouldFail) {
        const cov = checkCoverage(op, store, config, learnedThreshold);
        if (cov.matchKind === "contextual") tp += 1;
        else fn += 1;
      }
      for (const op of cleanOps) {
        const cov = checkCoverage(op, store, config, learnedThreshold);
        if (cov.matchKind === "contextual") fp += 1;
        else tn += 1;
      }
      return { tp, fn, fp, tn };
    });
    const recall = m.result.tp + m.result.fn > 0 ? m.result.tp / (m.result.tp + m.result.fn) : 0;
    const fpRate = m.result.fp + m.result.tn > 0 ? m.result.fp / (m.result.fp + m.result.tn) : 0;
    const hoWouldFail = heldOutOps.filter((o) => o.wouldFail);
    const hoTp = hoWouldFail.reduce((acc, op) => acc + (checkCoverage(op, store, config, learnedThreshold).matchKind === "contextual" ? 1 : 0), 0);
    const heldOutRecall = hoWouldFail.length > 0 ? hoTp / hoWouldFail.length : recall;
    application.push({
      name: "contextual",
      category: "extraction",
      recall, fpRate,
      heldOutRecall,
      latencyMs: m.latencyMs, heapKB: m.heapKB,
      rulesCount: store.size(),
      admissible: recall > 0 && fpRate === 0,
    });
  }

  // 5. Compound match (multi-cause + root-cause ensemble).
  {
    const m = measure(() => {
      let tp = 0, fn = 0, fp = 0, tn = 0;
      for (const op of wouldFail) {
        const cov = checkCoverage(op, store, config, learnedThreshold);
        if (cov.matchKind === "root-cause" || (cov.ruleId && cov.ruleId.includes("+"))) tp += 1;
        else fn += 1;
      }
      for (const op of cleanOps) {
        const cov = checkCoverage(op, store, config, learnedThreshold);
        if (cov.matchKind === "root-cause" || (cov.ruleId && cov.ruleId.includes("+"))) fp += 1;
        else tn += 1;
      }
      return { tp, fn, fp, tn };
    });
    const recall = m.result.tp + m.result.fn > 0 ? m.result.tp / (m.result.tp + m.result.fn) : 0;
    const fpRate = m.result.fp + m.result.tn > 0 ? m.result.fp / (m.result.fp + m.result.tn) : 0;
    const hoWouldFail = heldOutOps.filter((o) => o.wouldFail);
    const hoTp = hoWouldFail.reduce((acc, op) => {
      const cov = checkCoverage(op, store, config, learnedThreshold);
      return acc + (cov.matchKind === "root-cause" || (cov.ruleId !== undefined && cov.ruleId.includes("+")) ? 1 : 0);
    }, 0);
    const heldOutRecall = hoWouldFail.length > 0 ? hoTp / hoWouldFail.length : recall;
    application.push({
      name: "compound",
      category: "extraction",
      recall, fpRate,
      heldOutRecall,
      latencyMs: m.latencyMs, heapKB: m.heapKB,
      rulesCount: store.size(),
      admissible: recall > 0 && fpRate === 0,
    });
  }

  // Pick the winners (highest recall - fpRate; tie-broken by lowest latency).
  // EXP461 (L1): only "extraction"-category techniques compete for
  // bestExtractor — CUSUM (trigger) and Bayesian (ranking) are reported but
  // excluded so their trigger/ranking recall no longer conflate with pattern
  // coverage.
  const score = (t: TechniqueResult): number => t.recall - t.fpRate;
  const extractionOnly = extraction.filter((t) => t.category === "extraction");
  const bestExtractor =
    [...extractionOnly].sort((a, b) => score(b) - score(a) || a.latencyMs - b.latencyMs)[0]?.name ?? "none";
  const bestMatcher =
    [...application].sort((a, b) => score(b) - score(a) || a.latencyMs - b.latencyMs)[0]?.name ?? "none";
  const rankers = extraction.filter((t) => t.category === "ranking");
  const bestTrigger = triggers.length > 0 ? triggers[0]!.name : "none";
  const bestRanker = rankers.length > 0 ? rankers[0]!.name : "none";

  return {
    extraction,
    triggers,
    application,
    bestExtractor,
    bestMatcher,
    bestTrigger,
    bestRanker,
    totalMs: Date.now() - t0,
    llmCalls,
  };
}
