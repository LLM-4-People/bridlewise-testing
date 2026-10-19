/**
 * Bias detector for the unified context + memory system.
 *
 * The user directive (2026-07-21): "add something regarding bias." After
 * many multi-turns, the in-context window + retrieved memories can be
 * biased toward:
 *   - EARLY turns (anchoring bias): facts planted early have been in
 *     memory longer, accumulated reinforcement, and may dominate
 *     retrieval even when a more recent turn is more relevant.
 *   - RECENT turns (recency bias): recent turns are fresh in-context
 *     and the exp-decay relevance boosts them, so the LLM may ignore
 *     established facts in favor of the most recent context.
 *
 * This module is DETERMINISTIC and owns the bias measurement + a
 * balanced-retrieval prevention strategy. Every threshold comes from
 * `UnifiedConfig.bias` (no static constants here).
 *
 * Detection: for each probe answer, record which memory-entry turns the
 * LLM's answer draws from (by token overlap). Aggregate the referenced
 * turn distribution. Flag:
 *   - recencyBias  if share(early) < earlyFloor   (too few early refs)
 *   - anchoringBias if share(recent) < recentFloor (too few recent refs)
 *
 * Prevention: `balancedRetrieve` wraps `MemoryStore.retrieve` and
 * re-ranks the top-K so it contains a MIX of early + recent +
 * mid-age relevant entries (not all from one end). This is the
 * "memory retrieval is BALANCED" directive.
 *
 * This is NOT the eight-type bias model from EXP380 (confirmation,
 * anchoring, selection, recency, availability, representation,
 * sampling, metric). EXP380's detector is broader and operates on
 * search/read/suggest events. EXP392's detector is narrowly scoped to
 * CONTEXT bias — the bias introduced by the context manager's
 * eviction + retrieval policy over a long conversation. The two are
 * complementary; EXP392 focuses on the infinite-context failure mode.
 */
import { tokenize, termFrequency } from "./tokenizer.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { RetrievedMemory } from "./types.ts";

/** Bias configuration (added to UnifiedConfig). */
export type BiasConfig = Readonly<{
  /** Turn percentile defining "early" (turns ≤ earlyPct * maxTurn). */
  earlyPct: number;
  /** Turn percentile defining "recent" (turns ≥ (1 - recentPct) * maxTurn). */
  recentPct: number;
  /** Minimum share of early-turn references (below = recency bias). */
  earlyFloor: number;
  /** Minimum share of recent-turn references (below = anchoring bias). */
  recentFloor: number;
  /** Minimum samples before evaluating bias. */
  minSamples: number;
  /**
   * Balanced-retrieval split: target share of top-K from early / mid /
   * recent buckets when re-ranking. Must sum to 1.0.
   */
  balancedEarly: number;
  balancedMid: number;
  balancedRecent: number;
}>;

/** Default bias config (the single static value, owned here). */
export const DEFAULT_BIAS_CONFIG: BiasConfig = Object.freeze({
  earlyPct: 0.20,
  recentPct: 0.20,
  earlyFloor: 0.10,
  recentFloor: 0.10,
  minSamples: 5,
  balancedEarly: 0.30,
  balancedMid: 0.40,
  balancedRecent: 0.30,
});

/** One recorded probe-answer observation. */
export interface BiasObservation {
  readonly turn: number;
  readonly factId: string;
  /** Turns the answer references (by memory-entry token overlap). */
  readonly referencedTurns: readonly number[];
  readonly answerTokens: readonly string[];
}

/** Aggregate bias report. */
export interface BiasReport {
  readonly observations: number;
  readonly referencedTurnDistribution: Readonly<Record<string, number>>;
  readonly earlyShare: number;
  readonly recentShare: number;
  readonly midShare: number;
  readonly recencyBias: boolean;
  readonly anchoringBias: boolean;
  readonly balanced: boolean;
  readonly flagged: boolean;
  readonly summary: string;
}

export class BiasDetector {
  readonly cfg: BiasConfig;
  readonly observations: BiasObservation[] = [];
  /** Running count of referenced turns (turn -> count). */
  readonly referencedTurnCounts = new Map<number, number>();

  constructor(cfg: BiasConfig = DEFAULT_BIAS_CONFIG) {
    this.cfg = cfg;
  }

  /**
   * Record a probe answer + the memories retrieved for it. Infer which
   * turns the answer draws from by token overlap between the answer and
   * each retrieved memory entry.
   */
  recordAnswer(turn: number, factId: string, answer: string, retrieved: readonly RetrievedMemory[]): BiasObservation {
    const answerTokens = tokenize(answer);
    const answerSet = new Set(answerTokens);
    const referenced: number[] = [];
    for (const r of retrieved) {
      // Token overlap between the answer and the memory entry.
      const memTokens = tokenize(r.content);
      let overlap = 0;
      for (const t of memTokens) if (answerSet.has(t)) overlap++;
      // If the answer shares ≥ 2 non-trivial tokens with the memory, count it as referenced.
      if (overlap >= 2 || r.kind === "fact") {
        referenced.push(r.turn);
        for (const t of r.turns) {
          this.referencedTurnCounts.set(t, (this.referencedTurnCounts.get(t) ?? 0) + 1);
        }
      }
    }
    const obs: BiasObservation = { turn, factId, referencedTurns: referenced, answerTokens };
    this.observations.push(obs);
    return obs;
  }

  /** Compute the aggregate bias report at the current maxTurn. */
  report(maxTurn: number): BiasReport {
    const earlyBound = Math.max(1, Math.floor(this.cfg.earlyPct * maxTurn));
    const recentBound = Math.ceil((1 - this.cfg.recentPct) * maxTurn);
    let early = 0, mid = 0, recent = 0, total = 0;
    const dist: Record<string, number> = {};
    for (const [, count] of this.referencedTurnCounts) {
      total += count;
    }
    for (const [turnStr, count] of this.referencedTurnCounts) {
      const turn = Number(turnStr);
      dist[turnStr] = count;
      if (turn <= earlyBound) early += count;
      else if (turn >= recentBound) recent += count;
      else mid += count;
    }
    const earlyShare = total > 0 ? early / total : 0;
    const recentShare = total > 0 ? recent / total : 0;
    const midShare = total > 0 ? mid / total : 0;
    const enough = this.observations.length >= this.cfg.minSamples;
    const recencyBias = enough && earlyShare < this.cfg.earlyFloor;
    const anchoringBias = enough && recentShare < this.cfg.recentFloor;
    const balanced = enough && !recencyBias && !anchoringBias;
    const flagged = recencyBias || anchoringBias;
    const summary = flagged
      ? `BIAS DETECTED: ${recencyBias ? "recency" : ""}${recencyBias && anchoringBias ? "+" : ""}${anchoringBias ? "anchoring" : ""} (early=${earlyShare.toFixed(2)}, recent=${recentShare.toFixed(2)}, mid=${midShare.toFixed(2)})`
      : `balanced (early=${earlyShare.toFixed(2)}, recent=${recentShare.toFixed(2)}, mid=${midShare.toFixed(2)})`;
    return { observations: this.observations.length, referencedTurnDistribution: dist, earlyShare, recentShare, midShare, recencyBias, anchoringBias, balanced, flagged, summary };
  }

  /**
   * Balanced retrieval: wrap `MemoryStore.retrieve` and re-rank the
   * top-K so it contains a MIX of early / mid / recent entries (not all
   * from one end). This is the "memory retrieval is BALANCED" prevention.
   *
   * The re-rank preserves the relevance order WITHIN each bucket, then
   * interleaves buckets by the configured split (balancedEarly/Mid/Recent).
   * Entries that don't fit a bucket's quota stay by relevance.
   */
  balancedRetrieve(
    store: MemoryStore,
    query: string,
    topK: number,
    threshold: number,
    currentTurn: number,
    maxTurn: number,
    hotModules: readonly string[] = [],
  ): RetrievedMemory[] {
    // Retrieve a larger pool (3× topK) so we have enough to re-rank across buckets.
    const pool = store.retrieve(query, Math.max(topK * 3, topK + 6), threshold, currentTurn, hotModules);
    if (pool.length <= topK) return pool;
    const earlyBound = Math.max(1, Math.floor(this.cfg.earlyPct * maxTurn));
    const recentBound = Math.ceil((1 - this.cfg.recentPct) * maxTurn);
    const early = pool.filter((r) => r.turn <= earlyBound);
    const mid = pool.filter((r) => r.turn > earlyBound && r.turn < recentBound);
    const recent = pool.filter((r) => r.turn >= recentBound);
    const earlyQuota = Math.round(topK * this.cfg.balancedEarly);
    const midQuota = Math.round(topK * this.cfg.balancedMid);
    const recentQuota = Math.max(0, topK - earlyQuota - midQuota);
    // Sort each bucket by score (already sorted, but be explicit).
    early.sort((a, b) => b.score - a.score);
    mid.sort((a, b) => b.score - a.score);
    recent.sort((a, b) => b.score - a.score);
    const out: RetrievedMemory[] = [];
    const seen = new Set<number>();
    const push = (r: RetrievedMemory | undefined): void => {
      if (r && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
    };
    // Interleave by quota: round-robin fill, favoring higher-scored buckets.
    for (let i = 0; i < earlyQuota; i++) push(early[i]);
    for (let i = 0; i < midQuota; i++) push(mid[i]);
    for (let i = 0; i < recentQuota; i++) push(recent[i]);
    // Top up from the remaining pool by score (in case a bucket was short).
    if (out.length < topK) {
      for (const r of pool) {
        if (out.length >= topK) break;
        push(r);
      }
    }
    return out.slice(0, topK);
  }
}

/** Re-export termFrequency for tests. */
export { termFrequency };
