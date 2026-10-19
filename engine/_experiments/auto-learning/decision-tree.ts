/**
 * EXP451 — Decision-tree (CART-style) pattern extraction: deterministic,
 * no LLM.
 *
 * Builds a binary decision tree over cause FEATURES (character n-gram
 * presence/absence) → wouldFail label. Each path from root to a leaf
 * labelled "fail" becomes a pattern: the conjunction of n-gram features
 * on that path is the "cause signature." This is a DIFFERENT inductive
 * bias than frequency (which counts exact causes) or GA (which evolves
 * regexes): the tree finds the MINIMAL feature set that separates
 * wouldFail from clean, then expresses each failing region as a rule.
 *
 * Determinism: features are sorted alphabetically; ties broken by
 * feature name; the split chosen is the one with the highest Gini gain,
 * tie-broken by the alphabetically-first feature (stable).
 *
 * The tree is bounded by `dtMaxDepth` (config) and `dtMinSamplesSplit`.
 * Leaves with `dtMinPurity` purity or higher become "fail" rules.
 *
 * NO LLM. Pure deterministic split selection.
 */

import type { ErrorCollector } from "./collector.ts";
import type { LearningConfig } from "./config.ts";
import type { Pattern } from "./extractor.ts";
import { extractNgrams } from "./ngram.ts";

/** A decision-tree node. */
export interface DtNode {
  /** The feature (n-gram) tested at this node (null for leaves). */
  feature: string | null;
  /** The child when the feature IS present in the cause. */
  yes?: DtNode;
  /** The child when the feature is NOT present. */
  no?: DtNode;
  /** The predicted label at a leaf ("fail" | "clean" | null for internal). */
  label: "fail" | "clean" | null;
  /** The number of samples reaching this node. */
  samples: number;
  /** The number of wouldFail samples reaching this node. */
  failCount: number;
}

/** A rule extracted from a root-to-fail-leaf path. */
export interface DtRule extends Pattern {
  /** The conjunction of n-gram features on the path. */
  features: string[];
  /** The leaf's purity (failCount / samples). */
  purity: number;
}

/**
 * Feature extraction: the set of character n-grams (length in
 * [ngramMin, ngramMax]) present in a cause. This is the tree's feature
 * space. Bounded per cause by `dtMaxFeaturesPerCause` (config) to keep the
 * tree tractable.
 */
function featuresFor(cause: string, config: LearningConfig): string[] {
  const grams = new Set<string>();
  for (let n = config.ngramMin; n <= Math.min(config.ngramMax, 6); n += 1) {
    for (const g of extractNgrams(cause, n)) grams.add(g);
  }
  return [...grams].sort().slice(0, config.dtMaxFeaturesPerCause);
}

/** Gini impurity of a label distribution. */
function gini(fail: number, clean: number): number {
  const total = fail + clean;
  if (total === 0) return 0;
  const pf = fail / total;
  const pc = clean / total;
  return 1 - pf * pf - pc * pc;
}

/**
 * Build the tree (recursive). At each node, pick the feature that gives
 * the highest Gini gain. Stop at `dtMaxDepth`, `dtMinSamplesSplit`, or
 * pure node.
 */
function buildTree(
  samples: ReadonlyArray<{ cause: string; wouldFail: boolean }>,
  features: readonly string[],
  depth: number,
  config: LearningConfig,
): DtNode {
  const fail = samples.filter((s) => s.wouldFail).length;
  const clean = samples.length - fail;
  const label: "fail" | "clean" | null = depth >= config.dtMaxDepth || samples.length < config.dtMinSamplesSplit
    ? (fail >= clean ? "fail" : "clean")
    : (fail === 0 ? "clean" : clean === 0 ? "fail" : null);
  const node: DtNode = { feature: null, label, samples: samples.length, failCount: fail };
  if (label !== null) return node;
  if (features.length === 0) {
    node.label = fail >= clean ? "fail" : "clean";
    return node;
  }
  // Find the best split (highest Gini gain).
  let bestFeature = features[0] ?? "";
  let bestGain = -Infinity;
  let bestYes: { cause: string; wouldFail: boolean }[] = [];
  let bestNo: { cause: string; wouldFail: boolean }[] = [];
  for (const f of features) {
    const yes = samples.filter((s) => s.cause.includes(f));
    const no = samples.filter((s) => !s.cause.includes(f));
    if (yes.length === 0 || no.length === 0) continue;
    const yf = yes.filter((s) => s.wouldFail).length;
    const nf = no.filter((s) => s.wouldFail).length;
    const gain = gini(fail, clean) - (yes.length / samples.length) * gini(yf, yes.length - yf) - (no.length / samples.length) * gini(nf, no.length - nf);
    if (gain > bestGain || (gain === bestGain && f < bestFeature)) {
      bestGain = gain;
      bestFeature = f;
      bestYes = yes;
      bestNo = no;
    }
  }
  if (bestGain <= 0 || bestYes.length === 0 || bestNo.length === 0) {
    node.label = fail >= clean ? "fail" : "clean";
    return node;
  }
  const remaining = features.filter((f) => f !== bestFeature);
  node.feature = bestFeature;
  node.yes = buildTree(bestYes, remaining, depth + 1, config);
  node.no = buildTree(bestNo, remaining, depth + 1, config);
  return node;
}

/** Extract rules: every root-to-fail-leaf path becomes a DtRule. */
function extractRules(node: DtNode, path: string[], out: DtRule[], type: string): void {
  if (node.label === "fail" && path.length > 0) {
    const purity = node.samples > 0 ? node.failCount / node.samples : 0;
    if (purity >= 0.5 && path.length > 0) {
      out.push({
        type,
        cause: path.join("+"),
        count: node.failCount,
        confidence: purity,
        rank: 0,
        features: [...path],
        purity,
      });
    }
  }
  if (node.yes && node.feature) extractRules(node.yes, [...path, node.feature], out, type);
  if (node.no && node.feature) extractRules(node.no, path, out, type);
}

/**
 * Decision-tree pattern extraction. Builds one tree per type, extracts
 * fail-path rules. Each rule's `cause` is the conjunction of features
 * (joined by "+"); the `dtMatch` matcher covers an op whose cause
 * contains ALL the features.
 */
export function extractDecisionTreePatterns(
  collector: ErrorCollector,
  config: LearningConfig,
  cleanCauses: readonly { type: string; cause: string }[],
): DtRule[] {
  if (!config.dtEnabled) return [];
  const out: DtRule[] = [];
  const knownTypes = Object.keys(config.knownCauses);
  for (const type of knownTypes) {
    const failRecs = collector.all().filter((e) => e.type === type);
    if (failRecs.length === 0) continue;
    const failSamples = failRecs.map((e) => ({ cause: e.cause, wouldFail: true }));
    const cleanSamples = cleanCauses
      .filter((c) => c.type === type)
      .map((c) => ({ cause: c.cause, wouldFail: false }));
    const samples = [...failSamples, ...cleanSamples];
    if (samples.length < config.dtMinSamplesSplit) continue;
    // Feature universe: union of all features across samples.
    const featureSet = new Set<string>();
    for (const s of samples) for (const f of featuresFor(s.cause, config)) featureSet.add(f);
    const features = [...featureSet].sort();
    const tree = buildTree(samples, features, 0, config);
    const rules: DtRule[] = [];
    extractRules(tree, [], rules, type);
    // Cap per type + rank by purity then count.
    rules.sort((a, b) => b.purity - a.purity || b.count - a.count);
    for (let i = 0; i < rules.length && i < config.maxDtRulesPerType; i += 1) {
      const r = rules[i];
      if (r) out.push({ ...r, rank: i + 1 });
    }
  }
  return out.slice(0, config.maxDtRules);
}

/**
 * Decision-tree matcher: an op is covered if its cause contains ALL the
 * features of an admitted rule of the same type.
 */
export function dtMatch(
  op: { type: string; cause: string },
  dtRules: ReadonlyArray<DtRule>,
): { ruleId?: string; matched: boolean } {
  for (const r of dtRules) {
    if (r.type !== op.type) continue;
    if (r.features.every((f) => op.cause.includes(f))) {
      return { ruleId: r.features.join("+"), matched: true };
    }
  }
  return { matched: false };
}
