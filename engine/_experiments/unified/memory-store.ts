/**
 * Memory store: TF-IDF retrieval + Ebbinghaus retention + FSRS-4
 * reinforcement + hot-module boost.
 *
 * Builds on EXP351 (TF-IDF cosine retrieval) and EXP360 (Ebbinghaus decay,
 * FSRS-4 reinforcement, fading boost, kind-tagged entries). The novel
 * addition for the unified system is the hot-module boost: when the
 * awareness engine signals that certain modules are "hot" (recently
 * changed / complex / heavily depended on), retrieval boosts memory
 * entries whose tags or tokens mention those modules. This is the
 * "awareness-driven retrieval" directive.
 *
 * The store also accepts kind="awareness" entries — per-turn codebase
 * awareness snapshots stored as memory so the LLM can recall the
 * codebase's state at a past turn ("what was the function count at
 * turn 50?"). This is the "dynamic awareness in memory" directive.
 */
import { termFrequency, tokenize, semanticHash, estimateTokens } from "./tokenizer.ts";
import type { MemoryConfig } from "./config.ts";
import type { MemoryEntry, MemoryKind, RetrievedMemory } from "./types.ts";

export class MemoryStore {
  readonly cfg: MemoryConfig;
  readonly entries: MemoryEntry[] = [];
  readonly df = new Map<string, number>();
  retrievals = 0;
  relevantInjections = 0;
  totalEntriesStored = 0;
  totalReinforced = 0;
  totalPruned = 0;

  constructor(cfg: MemoryConfig) {
    this.cfg = cfg;
  }

  /** Smoothed IDF: ln((1+N)/(1+df)) + 1 (sklearn-style). */
  idf(term: string): number {
    const n = this.entries.length;
    const df = this.df.get(term) ?? 0;
    return Math.log((1 + n) / (1 + df)) + 1;
  }

  /** L2-normalized TF-IDF vector for a token list. */
  tfidfVector(tokens: readonly string[]): Map<string, number> {
    const tf = termFrequency(tokens);
    const vec = new Map<string, number>();
    for (const [term, tfVal] of tf) vec.set(term, tfVal * this.idf(term));
    let norm = 0;
    for (const v of vec.values()) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (const [k, v] of vec) vec.set(k, v / norm);
    return vec;
  }

  /** Ebbinghaus retention R(t) = e^(-t/S). */
  retention(entry: MemoryEntry, currentTurn: number): number {
    const t = currentTurn - (entry.lastAccessedTurn ?? entry.turn);
    return Math.exp(-t / Math.max(0.001, entry.strength));
  }

  /** FSRS-4 reinforcement: S_new = S * (1 + (1 - R) * g(n)). */
  reinforce(entry: MemoryEntry, currentTurn: number): void {
    const r = this.retention(entry, currentTurn);
    const n = entry.accessCount || 1;
    const g = this.cfg.decayReinforceGain * Math.pow(n, -0.5) + 0.1;
    entry.strength = entry.strength * (1 + (1 - r) * g);
    entry.accessCount = (entry.accessCount ?? 0) + 1;
    entry.lastAccessedTurn = currentTurn;
    this.totalReinforced++;
  }

  /** Add an entry. kind="fact" entries are persistent (never pruned). */
  add(turn: number, role: MemoryEntry["role"], content: string, kind: MemoryKind, tags: readonly string[] = []): MemoryEntry | null {
    const tokens = tokenize(content);
    if (tokens.length === 0) return null;
    const hash = semanticHash(tokens);
    const existing = this.entries.find((e) => e.hash === hash);
    if (existing) {
      this.reinforce(existing, turn);
      return existing;
    }
    const tfidf = this.tfidfVector(tokens);
    const entry: MemoryEntry = {
      id: this.entries.length,
      turn,
      turns: [turn],
      role,
      content,
      hash,
      tfidf,
      tokens: estimateTokens(content),
      storedAt: Date.now(),
      kind,
      tags,
      strength: this.cfg.decayInitStrength,
      accessCount: 0,
      lastAccessedTurn: turn,
    };
    this.entries.push(entry);
    const seen = new Set<string>();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.totalEntriesStored++;
    return entry;
  }

  /**
   * Retrieve top-K entries relevant to the query.
   *
   * Score = cosine similarity + fadingBoost (if R < 0.5) + hotModuleBoost
   * (if the entry mentions a hot module). Retrieved entries are reinforced
   * (FSRS-4). The hot-module boost is the awareness-driven retrieval
   * directive: memories about currently-hot modules rank higher.
   *
   * EXP409 sweep: the scoring is selected by `cfg.retrievalStrategy`:
   *   - `tfidf`:       score = dot                       (pure lexical)
   *   - `ebbinghaus`:  score = retention × strength      (reinforce decaying)
   *   - `hybrid`:      score = dot × (1 + retention)     (balanced)
   *   - `hybrid-boost`:score = dot + fadingBoost + hotBoost (EXP392 default)
   * The `threshold` filter is always applied on `dot` (the lexical signal)
   * so non-lexical strategies don't return irrelevant entries.
   */
  retrieve(
    queryText: string,
    topK: number,
    threshold: number,
    currentTurn: number,
    hotModules: readonly string[] = [],
  ): RetrievedMemory[] {
    this.retrievals++;
    const qTokens = tokenize(queryText);
    if (qTokens.length === 0 || this.entries.length === 0) return [];
    const qVec = this.tfidfVector(qTokens);
    const hotSet = new Set(hotModules.map((m) => m.toLowerCase()));
    const strategy = this.cfg.retrievalStrategy ?? "hybrid-boost";
    const scored: Array<{ entry: MemoryEntry; sim: number; score: number; r: number }> = [];
    for (const e of this.entries) {
      let dot = 0;
      const [small, large] = qVec.size < e.tfidf.size ? [qVec, e.tfidf] : [e.tfidf, qVec];
      for (const [k, v] of small) {
        const w = large.get(k);
        if (w !== undefined) dot += v * w;
      }
      if (dot < 0) dot = 0;
      const r = this.retention(e, currentTurn);
      let score: number;
      switch (strategy) {
        case "tfidf":
          score = dot;
          break;
        case "ebbinghaus":
          // Reinforce decaying memories: weight by retention × strength.
          score = r * e.strength;
          break;
        case "hybrid":
          // Balanced: lexical scaled by (1 + retention) so well-retained
          // entries get a mild boost without dominating the lexical signal.
          score = dot * (1 + r);
          break;
        case "hybrid-boost":
        default: {
          // EXP392 default: TF-IDF + fadingBoost (when R<0.5) + hot-module boost.
          score = dot;
          if (r < 0.5) score += this.cfg.fadingBoost;
          if (hotSet.size > 0) {
            let hot = false;
            for (const tag of e.tags) {
              if (hotSet.has(tag.toLowerCase())) { hot = true; break; }
            }
            if (!hot) {
              for (const t of e.tfidf.keys()) {
                if (hotSet.has(t)) { hot = true; break; }
              }
            }
            if (hot) score += 0.10;
          }
          break;
        }
      }
      scored.push({ entry: e, sim: dot, score, r });
    }
    scored.sort((a, b) => b.score - a.score);
    // The threshold filter is always on the lexical similarity so
    // non-lexical strategies don't return irrelevant entries.
    const top = scored.slice(0, topK).filter((s) => s.sim >= threshold);
    if (top.length > 0) this.relevantInjections++;
    for (const s of top) this.reinforce(s.entry, currentTurn);
    return top.map((s) => ({
      id: s.entry.id,
      turn: s.entry.turn,
      turns: s.entry.turns,
      role: s.entry.role,
      content: s.entry.content,
      similarity: s.sim,
      score: s.score,
      retention: s.r,
      strength: s.entry.strength,
      kind: s.entry.kind,
      tags: s.entry.tags,
      hash: s.entry.hash,
    }));
  }

  /** Prune fully-decayed non-fact entries. Facts are persistent anchors. */
  pruneFaded(currentTurn: number): number {
    const before = this.entries.length;
    const keep: MemoryEntry[] = [];
    for (const e of this.entries) {
      if (e.kind === "fact" || e.kind === "awareness") {
        keep.push(e);
        continue;
      }
      const r = this.retention(e, currentTurn);
      if (r < this.cfg.pruneThreshold) {
        this.totalPruned++;
      } else {
        keep.push(e);
      }
    }
    this.entries.length = 0;
    this.entries.push(...keep);
    return before - this.entries.length;
  }

  /** Recompute all TF-IDF vectors after DF changes. */
  recomputeAllTfidf(): void {
    for (const e of this.entries) {
      e.tfidf = this.tfidfVector(tokenize(e.content));
    }
  }

  toJSON(): unknown {
    return {
      entries: this.entries.map((e) => ({
        id: e.id, turn: e.turn, role: e.role, content: e.content,
        hash: e.hash, tokens: e.tokens, kind: e.kind, tags: e.tags,
        strength: e.strength, accessCount: e.accessCount,
        lastAccessedTurn: e.lastAccessedTurn,
      })),
      stats: {
        totalEntriesStored: this.totalEntriesStored,
        retrievals: this.retrievals,
        relevantInjections: this.relevantInjections,
        totalReinforced: this.totalReinforced,
        totalPruned: this.totalPruned,
      },
    };
  }
}
