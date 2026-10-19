/**
 * EXP374 — Multi-cause pattern extraction: Mutual Information (MI) + Apriori
 * frequent-itemset mining.
 *
 * EXP363 extracted only single-cause patterns (per-type frequency analysis).
 * EXP374 adds CORRELATION analysis across causes: if cause A and cause B
 * always co-occur in multi-cause errors, they have a common cause. MI
 * quantifies the correlation; Apriori finds the frequent itemsets.
 *
 * NO LLM. Pure deterministic statistics. All thresholds come from the config.
 *
 * Math:
 *   MI(A;B) = P(A,B) * log2( P(A,B) / (P(A) * P(B)) )
 *   When A and B are independent, MI = 0. When A and B always co-occur,
 *   MI = -log2(P(A)) (maximal). MI is symmetric: MI(A;B) = MI(B;A).
 *
 * Apriori:
 *   1. Find frequent 1-itemsets (support ≥ minSupport).
 *   2. Generate candidate 2-itemsets from frequent 1-itemsets.
 *   3. Prune candidates whose support < minSupport.
 *   4. Repeat up to maxItemsetSize.
 *   5. Generate association rules: {A} → {B} with confidence ≥ minConfidence.
 */

import type { ErrorCollector } from "./collector.ts";
import type { LearningConfig } from "./config.ts";
import { decomposeCause, isCompoundCause, COMPOUND_SEP } from "./config.ts";

/** A co-occurring cause pair (or itemset) discovered by MI / Apriori. */
export interface MultiCausePattern {
  /** The error type this pattern belongs to. */
  type: string;
  /** The sub-causes in the itemset (e.g. ["whitespace-tab-vs-space", "case-sensitivity"]). */
  itemset: string[];
  /** The compound cause string (sub-causes joined by "+"). */
  compoundCause: string;
  /** How many errors contain this itemset. */
  count: number;
  /** Support = count / total-errors-of-type (0..1). */
  support: number;
  /** Mutual information between the sub-causes (bits). 0 = independent. */
  mutualInformation: number;
  /** For association rules {A} → {B}: the confidence P(B|A) (0..1). */
  confidence: number;
}

/** Result of multi-cause extraction. */
export interface MultiCauseResult {
  patterns: MultiCausePattern[];
  /** Pairs with high MI but below Apriori support (detected, not frequent enough). */
  highMIPairs: MultiCausePattern[];
}

/**
 * Compute the Levenshtein distance between two strings. Pure function, no
 * allocation beyond the DP matrix. Used by the multi-cause sub-cause
 * comparator AND by the generalizer (fuzzy matching).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

/**
 * Compute mutual information for a pair of sub-causes (A, B) within a type.
 * MI(A;B) = P(A,B) * log2( P(A,B) / (P(A) * P(B)) ).
 *
 * @param countAB  number of errors containing both A and B
 * @param countA   number of errors containing A
 * @param countB   number of errors containing B
 * @param total    total number of errors of this type
 */
export function mutualInformation(
  countAB: number,
  countA: number,
  countB: number,
  total: number,
): number {
  if (total <= 0 || countAB <= 0) return 0;
  const pAB = countAB / total;
  const pA = countA / total;
  const pB = countB / total;
  if (pA <= 0 || pB <= 0) return 0;
  const ratio = pAB / (pA * pB);
  if (ratio <= 0) return 0;
  return pAB * Math.log2(ratio);
}

/**
 * Apriori: find all frequent itemsets up to maxItemsetSize.
 * An itemset is "frequent" if its support ≥ minSupport.
 *
 * @param transactions  each transaction is a set of items (sub-causes in one error)
 * @param minSupport    minimum support fraction (0..1)
 * @param maxItemsetSize maximum itemset cardinality
 * @returns a map from itemset-key (sorted items joined by "+") to {itemset, count, support}
 */
export function aprioriFrequentItemsets(
  transactions: readonly (readonly string[])[],
  minSupport: number,
  maxItemsetSize: number,
): Map<string, { itemset: string[]; count: number; support: number }> {
  const total = transactions.length;
  if (total === 0 || maxItemsetSize < 1) return new Map();
  const minCount = Math.max(1, Math.ceil(minSupport * total));

  // Count 1-itemsets.
  const counts = new Map<string, number>();
  for (const txn of transactions) {
    for (const item of txn) {
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
  }
  const frequent1: string[] = [];
  for (const [item, count] of counts) {
    if (count >= minCount) frequent1.push(item);
  }
  frequent1.sort();

  const result = new Map<string, { itemset: string[]; count: number; support: number }>();
  for (const item of frequent1) {
    const count = counts.get(item) ?? 0;
    result.set(item, { itemset: [item], count, support: count / total });
  }

  if (maxItemsetSize < 2) return result;

  // Generate 2-itemsets from frequent 1-itemsets.
  let currentLevel: string[][] = [];
  for (let i = 0; i < frequent1.length; i += 1) {
    for (let j = i + 1; j < frequent1.length; j += 1) {
      currentLevel.push([frequent1[i]!, frequent1[j]!]);
    }
  }

  let size = 2;
  while (currentLevel.length > 0 && size <= maxItemsetSize) {
    const nextLevel: string[][] = [];
    for (const itemset of currentLevel) {
      // Count support.
      let count = 0;
      const itemSet = new Set(itemset);
      for (const txn of transactions) {
        let allPresent = true;
        for (const item of itemset) {
          if (!txn.includes(item)) {
            allPresent = false;
            break;
          }
        }
        if (allPresent) count += 1;
      }
      if (count >= minCount) {
        const sorted = [...itemset].sort();
        result.set(sorted.join(COMPOUND_SEP), {
          itemset: sorted,
          count,
          support: count / total,
        });
        // Generate candidates for the next level by extending this itemset.
        if (size < maxItemsetSize) {
          for (const item of frequent1) {
            if (!itemSet.has(item)) {
              nextLevel.push([...itemset, item]);
            }
          }
        }
      }
    }
    // Dedup candidates (multiple itemsets can generate the same extension).
    const seen = new Set<string>();
    currentLevel = nextLevel.filter((cand) => {
      const key = [...cand].sort().join(COMPOUND_SEP);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    size += 1;
  }

  return result;
}

/**
 * Extract multi-cause patterns from the collector. For each error type:
 *   1. Decompose compound causes into sub-cause transactions.
 *   2. Run Apriori to find frequent itemsets.
 *   3. Compute MI for each pair.
 *   4. Return patterns meeting (miThreshold, aprioriMinSupport).
 */
export function extractMultiCausePatterns(
  collector: ErrorCollector,
  config: LearningConfig,
): MultiCauseResult {
  const patterns: MultiCausePattern[] = [];
  const highMIPairs: MultiCausePattern[] = [];

  const types = collector.observedTypes();
  for (const type of types) {
    const records = collector.byType(type);
    const total = records.length;
    if (total === 0) continue;

    // Build transactions: each error's sub-causes.
    const transactions: string[][] = [];
    for (const r of records) {
      if (isCompoundCause(r.cause)) {
        transactions.push([...decomposeCause(r.cause)]);
      } else {
        transactions.push([r.cause]);
      }
    }

    // Apriori frequent itemsets.
    const frequent = aprioriFrequentItemsets(
      transactions,
      config.aprioriMinSupport,
      config.maxItemsetSize,
    );

    // For each frequent itemset of size ≥ 2, compute MI for the pair.
    const subCounts = new Map<string, number>();
    for (const txn of transactions) {
      for (const item of txn) {
        subCounts.set(item, (subCounts.get(item) ?? 0) + 1);
      }
    }

    for (const [, info] of frequent) {
      if (info.itemset.length < 2) continue;
      // For pairs (size 2): compute MI + confidence.
      if (info.itemset.length === 2) {
        const [a, b] = info.itemset as [string, string];
        const countA = subCounts.get(a) ?? 0;
        const countB = subCounts.get(b) ?? 0;
        const mi = mutualInformation(info.count, countA, countB, total);
        // Association rule confidence: P(B|A) = count(A,B) / count(A).
        // Use the max of P(B|A) and P(A|B) for a symmetric confidence.
        const confAB = countA > 0 ? info.count / countA : 0;
        const confBA = countB > 0 ? info.count / countB : 0;
        const conf = Math.max(confAB, confBA);
        const pattern: MultiCausePattern = {
          type,
          itemset: info.itemset,
          compoundCause: info.itemset.join(COMPOUND_SEP),
          count: info.count,
          support: info.support,
          mutualInformation: mi,
          confidence: conf,
        };
        // Primary criterion: Apriori support (the compound is frequent
        // enough to warrant a rule). Confidence + MI are additional signals.
        // A compound rule matches the FULL compound cause (not sub-causes
        // independently), so confidence P(B|A) is less relevant than support.
        if (info.support >= config.aprioriMinSupport) {
          patterns.push(pattern);
        } else if (mi >= config.miThreshold) {
          highMIPairs.push(pattern);
        }
      }
    }
  }

  // Sort by MI descending, then by count, then alphabetically (deterministic).
  const sortFn = (a: MultiCausePattern, b: MultiCausePattern): number => {
    if (b.mutualInformation !== a.mutualInformation) return b.mutualInformation - a.mutualInformation;
    if (b.count !== a.count) return b.count - a.count;
    return a.compoundCause < b.compoundCause ? -1 : a.compoundCause > b.compoundCause ? 1 : 0;
  };
  patterns.sort(sortFn);
  highMIPairs.sort(sortFn);

  return { patterns, highMIPairs };
}
