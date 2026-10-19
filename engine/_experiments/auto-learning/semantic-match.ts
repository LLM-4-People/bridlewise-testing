/**
 * EXP451 — Semantic matcher: deterministic TF-IDF character n-gram cosine
 * similarity. NO LLM, NO embedding API.
 *
 * "Semantic" here means subword-level similarity: two causes are similar
 * if they share many weighted character n-grams (the same family of word
 * even if the surface form differs). E.g. "invalid-regex" and
 * "bad-regex-arg" share the n-gram "regex" (high TF-IDF weight because
 * it's rare across the corpus) → high cosine → semantic match.
 *
 * This is the deterministic, 0-LLM alternative to embedding-based semantic
 * matching (which would require an LLM or an embedding model). The
 * benchmark compares it against exact, fuzzy (Levenshtein), contextual,
 * and compound matchers.
 *
 * TF-IDF over character n-grams is a well-established lexical-semantic
 * technique (used by search engines, dedup, and clustering before
 * embeddings were practical). It is:
 *   - deterministic (same corpus → same vectors),
 *   - 0 LLM / 0 external API,
 *   - captures subword similarity (the "semantic" signal),
 *   - bounded by the corpus size (no unbounded memory).
 */

import { extractNgrams } from "./ngram.ts";
import { levenshtein } from "./multi-cause.ts";

/** A learned rule's semantic vector. */
export interface SemanticRuleVector {
  ruleId: string;
  type: string;
  cause: string;
  /** The TF-IDF vector (n-gram → weight). */
  vector: Map<string, number>;
  /** The L2 norm of the vector (for cosine). */
  norm: number;
}

/** Document frequency: how many causes contain each n-gram. */
export type DfMap = ReadonlyMap<string, number>;

/**
 * Build the document-frequency map from a corpus of causes. The corpus is
 * the universe of causes to compute IDF against (the learned rules'
 * causes + the clean set's causes, per the config).
 */
export function buildDfMap(corpus: readonly string[], ngramMin: number, ngramMax: number): DfMap {
  const df = new Map<string, number>();
  for (const cause of corpus) {
    const grams = new Set<string>();
    for (let n = ngramMin; n <= ngramMax; n += 1) {
      for (const g of extractNgrams(cause, n)) grams.add(g);
    }
    for (const g of grams) df.set(g, (df.get(g) ?? 0) + 1);
  }
  return df;
}

/** Compute the TF-IDF vector for a single cause. */
export function tfidfVector(
  cause: string,
  df: DfMap,
  corpusSize: number,
  ngramMin: number,
  ngramMax: number,
): Map<string, number> {
  const tf = new Map<string, number>();
  for (let n = ngramMin; n <= ngramMax; n += 1) {
    for (const g of extractNgrams(cause, n)) {
      tf.set(g, (tf.get(g) ?? 0) + 1);
    }
  }
  const vec = new Map<string, number>();
  let norm = 0;
  for (const [g, count] of tf) {
    const dfVal = df.get(g) ?? 0;
    if (dfVal === 0) continue; // n-gram not in corpus → 0 weight
    const idf = Math.log((corpusSize + 1) / (dfVal + 1)) + 1; // smooth IDF
    const w = count * idf;
    vec.set(g, w);
    norm += w * w;
  }
  return vec;
}

function l2norm(vec: Map<string, number>): number {
  let s = 0;
  for (const w of vec.values()) s += w * w;
  return Math.sqrt(s);
}

/** Cosine similarity between two TF-IDF vectors. */
export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  // Iterate the smaller vector.
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [g, w] of small) {
    const w2 = large.get(g);
    if (w2 !== undefined) dot += w * w2;
  }
  const na = l2norm(a);
  const nb = l2norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot / (na * nb);
}

/**
 * Build the semantic vectors for a set of learned rules. The corpus for
 * IDF is the rules' causes + the clean set's causes (so the IDF penalizes
 * n-grams common across the corpus — the "stopword" n-grams).
 */
export function buildSemanticVectors(
  rules: ReadonlyArray<{ id: string; spec: { type: string; causeMatch: string } }>,
  cleanCauses: readonly { type: string; cause: string }[],
  ngramMin: number,
  ngramMax: number,
): { vectors: SemanticRuleVector[]; df: DfMap; corpusSize: number } {
  // The rule's "cause" for vectorization is the canonical cause extracted
  // from the causeMatch regex (strip anchors `^...$`).
  const ruleCauses = rules.map((r) => r.spec.causeMatch.replace(/^\^/, "").replace(/\$$/, ""));
  const cleanCauseStrings = cleanCauses.map((c) => c.cause);
  const corpus = [...ruleCauses, ...cleanCauseStrings];
  const df = buildDfMap(corpus, ngramMin, ngramMax);
  const corpusSize = corpus.length;
  const vectors: SemanticRuleVector[] = rules.map((r, i) => {
    const cause = ruleCauses[i] ?? "";
    const vector = tfidfVector(cause, df, corpusSize, ngramMin, ngramMax);
    return {
      ruleId: r.id,
      type: r.spec.type,
      cause,
      vector,
      norm: l2norm(vector),
    };
  });
  return { vectors, df, corpusSize };
}

/** Normalized surface-form similarity (1 - normalizedLevenshtein). EXP461
 *  (S5): the secondary gate for the semantic matcher. A clean-suffix variant
 *  (`invalid-regex-clean` vs `invalid-regex`) has high cosine but low surface
 *  similarity (the `-clean` suffix inflates the edit distance); a real family
 *  variant (`invalid-regexx`, edit dist 1) clears the gate. */
export function editSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Semantic matcher: an op is covered by the rule whose TF-IDF cosine
 * similarity to the op's cause is the highest (above the threshold). The
 * threshold is config-driven (`semanticMinSimilarity`).
 *
 * EXP461 (S5): a match now requires BOTH a high TF-IDF cosine (subword
 * similarity) AND a high surface-form edit similarity (`semanticMinEditSimilarity`,
 * 0 disables). The cosine alone over-matched clean causes sharing rare
 * n-grams with rule causes (EXP451 fpRate 0.621); the surface gate rejects
 * clean-suffix variants without losing real family variants.
 *
 * Returns the best match (highest cosine) above the threshold, or no
 * match. Type-filtered (only rules of the op's type are considered).
 */
export function semanticMatch(
  op: { type: string; cause: string },
  vectors: ReadonlyArray<SemanticRuleVector>,
  df: DfMap,
  corpusSize: number,
  ngramMin: number,
  ngramMax: number,
  threshold: number,
  minEditSimilarity?: number,
): { ruleId?: string; matched: boolean; similarity: number } {
  const editFloor = minEditSimilarity ?? 0;
  const opVec = tfidfVector(op.cause, df, corpusSize, ngramMin, ngramMax);
  let best: { ruleId: string; sim: number } | null = null;
  for (const v of vectors) {
    if (v.type !== op.type) continue;
    if (v.norm === 0) continue;
    const sim = cosine(opVec, v.vector);
    if (sim < threshold) continue;
    // EXP461 (S5): surface-form gate — reject clean-suffix variants.
    if (editFloor > 0 && editSimilarity(op.cause, v.cause) < editFloor) continue;
    if (!best || sim > best.sim) {
      best = { ruleId: v.ruleId, sim };
    }
  }
  if (!best) return { matched: false, similarity: 0 };
  return { ruleId: best.ruleId, matched: true, similarity: best.sim };
}
