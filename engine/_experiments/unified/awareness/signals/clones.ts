/**
 * Clones signal: Jaccard-shingle clone family count, clone coverage,
 * and top families.
 *
 * Reuses the EXP335 / EXP340 approach: shingle each function body (k=
 * `cloneShingleK`), bucket by shingle, compute Jaccard only for pairs
 * sharing a shingle. Union-Find builds clone families.
 *
 * EXP340 (Bell): 12-13% of clones are "isolated" (no common witness —
 * pure copy-paste). EXP345 (wavelet): F1=0.877, training-free. We use
 * the Jaccard baseline — it is the simplest training-free detector.
 */
import type { SignalContext, FunctionRecord } from "../types.ts";

type Fn = { filePath: string; name: string; tokens: readonly string[]; bodyChars: number };

export function computeClones(ctx: SignalContext) {
  const minBody = ctx.config.thresholds.cloneMinBodySize;
  const minTokens = ctx.config.thresholds.cloneMinTokens;
  const threshold = ctx.config.thresholds.cloneJaccardThreshold;
  const k = ctx.config.thresholds.cloneShingleK;
  const bucketCap = ctx.config.thresholds.cloneBucketCap;

  const allFns: Fn[] = ctx.fileAnalyses.flatMap(fa =>
    fa.functions
      .filter(f => f.bodyChars >= minBody && f.tokens.length >= minTokens)
      .map(f => ({ filePath: f.filePath, name: f.name, tokens: f.tokens, bodyChars: f.bodyChars }))
  );
  if (allFns.length < 2) {
    return { clones: { familyCount: 0, cloneCoverage: 0, topFamilies: [] } };
  }

  // Shingle each function.
  const shinglesByFn: string[][] = allFns.map(f => shingles(f.tokens, k));
  // Bucket: shingle → [fn indexes].
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < shinglesByFn.length; i += 1) {
    const seen = new Set<string>();
    for (const s of shinglesByFn[i]!) {
      if (seen.has(s)) continue;
      seen.add(s);
      if (!buckets.has(s)) buckets.set(s, []);
      buckets.get(s)!.push(i);
    }
  }
  // Drop non-discriminative shingles (appearing in > bucketCap functions).
  for (const [s, idxs] of buckets) {
    if (idxs.length > bucketCap) buckets.delete(s);
  }
  // Candidate pairs (sharing a shingle).
  const parent = Array.from({ length: allFns.length }, (_, i) => i);
  const find = (i: number): number => {
    let cur = i;
    while (parent[cur] !== cur) {
      const up: number = parent[cur]!;
      const next: number = parent[up] ?? up;
      parent[cur] = next;
      cur = next;
    }
    return cur;
  };
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };
  let duplicateCount = 0;
  void duplicateCount; // duplicateCount is informational; we use Union-Find for families.
  const seenPairs = new Set<number>();
  for (const idxs of buckets.values()) {
    for (let i = 0; i < idxs.length; i += 1) {
      for (let j = i + 1; j < idxs.length; j += 1) {
        const a = idxs[i]!;
        const b = idxs[j]!;
        const key = a * allFns.length + b;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const jaccard = jaccardOf(shinglesByFn[a]!, shinglesByFn[b]!);
        if (jaccard >= threshold) {
          union(a, b);
          duplicateCount += 1;
        }
      }
    }
  }
  // Build families.
  const families = new Map<number, number[]>();
  for (let i = 0; i < allFns.length; i += 1) {
    const r = find(i);
    if (!families.has(r)) families.set(r, []);
    families.get(r)!.push(i);
  }
  // Only families with > 1 member are clones.
  let familyCount = 0;
  let clonedFunctions = 0;
  const familyList: Array<{ representative: string; members: number; avgJaccard: number }> = [];
  for (const idxs of families.values()) {
    if (idxs.length > 1) {
      familyCount += 1;
      clonedFunctions += idxs.length;
      // Representative = first member's name.
      const rep = allFns[idxs[0]!]!;
      // Compute avg Jaccard among family members (sample up to 10).
      const sample = idxs.slice(0, 10);
      let sum = 0; let count = 0;
      for (let i = 0; i < sample.length; i += 1) {
        for (let j = i + 1; j < sample.length; j += 1) {
          sum += jaccardOf(shinglesByFn[sample[i]!]!, shinglesByFn[sample[j]!]!);
          count += 1;
        }
      }
      const avg = count > 0 ? sum / count : 1;
      familyList.push({ representative: `${rep.filePath}:${rep.name}`, members: idxs.length, avgJaccard: round(avg, 3) });
    }
  }
  familyList.sort((a, b) => b.members - a.members);
  const topFamilies = familyList.slice(0, ctx.config.topN.topCloneFamilies);
  const cloneCoverage = allFns.length > 0 ? clonedFunctions / allFns.length : 0;
  return {
    clones: {
      familyCount,
      cloneCoverage: round(cloneCoverage, 4),
      topFamilies,
    },
  };
}

/** Generate k-shingles from a token list. */
function shingles(tokens: readonly string[], k: number): string[] {
  if (tokens.length < k) return [tokens.join(" ")];
  const out: string[] = [];
  for (let i = 0; i <= tokens.length - k; i += 1) {
    out.push(tokens.slice(i, i + k).join("\u0001"));
  }
  return out;
}

/** Jaccard similarity of two shingle sets. */
function jaccardOf(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function round(n: number, d: number): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// Suppress unused warning for FunctionRecord re-export.
export type { FunctionRecord };
