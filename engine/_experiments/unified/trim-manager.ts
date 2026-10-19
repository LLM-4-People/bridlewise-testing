/**
 * Trim manager: memory-aware eviction, extracted from the context
 * manager per the binding directive "Properly split into multiple
 * files — context-manager.ts, trim-manager.ts, injection-controller.ts,
 * memory-store.ts, awareness-engine.ts, bias-detector.ts".
 *
 * EXP378 kept the trim logic inside `ContextManager`. EXP392 extracts it
 * so the trim policy is independently testable + swappable. The behavior
 * is preserved byte-for-byte: the relevance score, the minRecent
 * protection, and the "evict least-relevant + save to memory full (no
 * compaction)" policy are identical to EXP378.
 *
 * Relevance = recencyWeight × exp(-age/decay)
 *            + relevanceWeight × tfidfSim(turn, query)
 *            + factsWeight × hasFact
 *            + hotModuleWeight × hotOverlap.
 *
 * The most recent `minRecentTurnsKept` evictable turns are protected
 * (continuity). Evicted turns are saved to memory FULL — never
 * summarized or merged (per "no compaction").
 *
 * Novel (EXP392): the trim manager also accepts an OPTIONAL per-kind
 * budget from `BudgetManager`. When a budget is supplied, trimming
 * targets the kind that most exceeds its budget first, then falls back
 * to the least-relevant policy. This implements the "context budgeting"
 * novel approach: system ≤ 500, awareness ≤ 200, memory ≤ 1000, history
 * ≤ 5000, tools ≤ 1300. When no budget is supplied, behavior is exactly
 * EXP378's.
 */
import { tokenize } from "./tokenizer.ts";
import type { UnifiedConfig } from "./config.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { ContextManager } from "./context-manager.ts";
import type { MessageKind, TrimmedTurn, TurnMessage } from "./types.ts";

/** Optional per-kind token budgets (from BudgetManager). Null = no per-kind budget. */
export type KindBudgets = Readonly<Partial<Record<MessageKind, number>>> | null;

export class TrimManager {
  readonly cfg: UnifiedConfig;
  readonly memory: MemoryStore;
  readonly context: ContextManager;
  trimCount = 0;
  readonly evictedTurns = new Set<number>();
  readonly driftedTurnsPruned = new Set<number>();
  /** Records the relevance score at which each turn was evicted (evidence). */
  readonly evictionLog: Array<{ turn: number; score: number; reason: string }> = [];

  constructor(cfg: UnifiedConfig, memory: MemoryStore, context: ContextManager) {
    this.cfg = cfg;
    this.memory = memory;
    this.context = context;
  }

  /** Evictable message kinds (system / awareness / memory / critical_context persist). */
  isEvictable(m: TurnMessage): boolean {
    return m.kind === "user" || m.kind === "assistant" || m.kind === "tool_result";
  }

  /**
   * Relevance score for a message under the current query / hot modules.
   * Higher = more relevant = more likely to stay in-context.
   */
  relevanceScore(m: TurnMessage, currentTurn: number, queryVec: Map<string, number>, hotSet: Set<string>): number {
    const inj = this.cfg.injection;
    const age = Math.max(0, currentTurn - m.turn);
    const recency = Math.exp(-age / Math.max(1, inj.recencyDecayTurns));
    let sim = 0;
    if (queryVec.size > 0) {
      const mVec = this.memory.tfidfVector(tokenize(m.content));
      const [small, large] = mVec.size < queryVec.size ? [mVec, queryVec] : [queryVec, mVec];
      for (const [k, v] of small) {
        const w = large.get(k);
        if (w !== undefined) sim += v * w;
      }
      if (sim < 0) sim = 0;
    }
    let hot = 0;
    if (hotSet.size > 0) {
      for (const tag of m.moduleTags) {
        if (hotSet.has(tag.toLowerCase())) { hot = 1; break; }
      }
      if (hot === 0) {
        for (const t of tokenize(m.content)) {
          if (hotSet.has(t)) { hot = 1; break; }
        }
      }
    }
    return inj.recencyWeight * recency + inj.relevanceWeight * sim + inj.factsWeight * (m.hasFact ? 1 : 0) + inj.hotModuleWeight * hot;
  }

  /**
   * Memory-aware trim: evict the configured-strategy victim until total
   * tokens fall below the trim target. The most recent
   * `minRecentTurnsKept` evictable turns are protected (continuity).
   * Evicted messages are saved to memory (full content, no compaction).
   *
   * When `kindBudgets` is supplied, first trim the kind that most exceeds
   * its budget (budget-aware), then fall back to the global policy for
   * the global target.
   *
   * EXP409 sweep parameters (from `cfg.window`):
   *   - `trimStep`: evict until `totalTokens <= capacity * (trimThreshold - trimStep)`
   *     (hysteresis band so we don't trim on the very next turn). When
   *     `trimStep = 0`, behavior is identical to EXP392 (evict only until
   *     `<= threshold`).
   *   - `trimStrategy`: which turn to evict — `least-relevant` (EXP392
   *     default), `oldest`, `largest` (biggest token savings), `random`
   *     (baseline). The budget-aware path uses the strategy to pick the
   *     victim WITHIN the over-budget kind.
   */
  trim(currentTurn: number, currentQuery: string, hotModules: readonly string[], kindBudgets: KindBudgets = null): TrimmedTurn[] {
    const stepFrac = Math.max(0, Math.min(this.cfg.window.trimThreshold, this.cfg.window.trimStep));
    const target = this.cfg.window.capacity * (this.cfg.window.trimThreshold - stepFrac);
    const evicted: TrimmedTurn[] = [];
    const hotSet = new Set(hotModules.map((m) => m.toLowerCase()));
    const qVec = this.memory.tfidfVector(tokenize(currentQuery));
    const minRecent = this.cfg.injection.minRecentTurnsKept;
    const strategy = this.cfg.window.trimStrategy;
    // Deterministic per-call RNG seed (reproducible random strategy).
    const rngSeed = (currentTurn * 0x9e3779b9) ^ (currentQuery.length * 0x85ebca6b) ^ 0xc2b2ae35;

    const evictOne = (): TrimmedTurn | null => {
      const evictableIdx: number[] = [];
      for (let i = 0; i < this.context.messages.length; i++) {
        if (this.isEvictable(this.context.messages[i]!)) evictableIdx.push(i);
      }
      const protectedStartIdx = evictableIdx.length > minRecent ? evictableIdx[evictableIdx.length - minRecent]! : -1;
      const candidates: Array<{ idx: number; m: TurnMessage; score: number; budgetReason?: string }> = [];
      for (const idx of evictableIdx) {
        if (idx <= protectedStartIdx) {
          const m = this.context.messages[idx]!;
          const score = this.relevanceScore(m, currentTurn, qVec, hotSet);
          candidates.push({ idx, m, score });
        }
      }
      if (candidates.length === 0) return null;
      // Budget-aware: if a kind budget is exceeded, prefer evicting that kind.
      if (kindBudgets) {
        const byKind = new Map<MessageKind, number>();
        for (const c of candidates) {
          byKind.set(c.m.kind, (byKind.get(c.m.kind) ?? 0) + c.m.tokens);
        }
        let overBudgetKind: MessageKind | null = null;
        let maxOverflow = 0;
        for (const [kind, tokens] of byKind) {
          const budget = kindBudgets[kind];
          if (budget != null && tokens > budget) {
            const overflow = tokens - budget;
            if (overflow > maxOverflow) { maxOverflow = overflow; overBudgetKind = kind; }
          }
        }
        if (overBudgetKind) {
          const kindCands = candidates.filter((c) => c.m.kind === overBudgetKind);
          sortByStrategy(kindCands, strategy, rngSeed);
          const victim = kindCands[0]!;
          return this.evict(victim.idx, victim.m, victim.score, `budget:${overBudgetKind}`);
        }
      }
      // Global policy.
      sortByStrategy(candidates, strategy, rngSeed);
      const victim = candidates[0]!;
      const reason = strategy === "least-relevant" ? "least-relevant"
        : strategy === "oldest" ? "oldest"
        : strategy === "largest" ? "largest"
        : "random";
      return this.evict(victim.idx, victim.m, victim.score, reason);
    };

    // EXP409: evict until we reach the TARGET (threshold - step), not just
    // the threshold. This creates the hysteresis band. When trimStep=0,
    // behavior is identical to EXP392 (evict until <= threshold).
    while (this.context.totalTokens > target) {
      const e = evictOne();
      if (!e) break;
      evicted.push(e);
    }
    return evicted;
  }

  private evict(idx: number, m: TurnMessage, score: number, reason: string): TrimmedTurn {
    this.context.messages.splice(idx, 1);
    this.context.totalTokens -= m.tokens;
    this.trimCount++;
    this.evictedTurns.add(m.turn);
    this.memory.add(m.turn, m.role, m.content, "turn", m.moduleTags);
    this.evictionLog.push({ turn: m.turn, score, reason });
    return { turn: m.turn, role: m.role, content: m.content, kind: m.kind, tokens: m.tokens, relevanceScore: score };
  }

  /** Drift-correction Level 2: prune turns in [startTurn, endTurn]. */
  pruneTurns(startTurn: number, endTurn: number): TrimmedTurn[] {
    const pruned: TrimmedTurn[] = [];
    for (let i = this.context.messages.length - 1; i >= 0; i--) {
      const m = this.context.messages[i]!;
      if (m.turn >= startTurn && m.turn <= endTurn && this.isEvictable(m)) {
        this.memory.add(m.turn, m.role, m.content, "turn", m.moduleTags);
        this.driftedTurnsPruned.add(m.turn);
        this.context.totalTokens -= m.tokens;
        pruned.unshift({ turn: m.turn, role: m.role, content: m.content, kind: m.kind, tokens: m.tokens, relevanceScore: 0 });
        this.context.messages.splice(i, 1);
      }
    }
    return pruned;
  }
}

/**
 * Sort candidates by the configured trim strategy (EXP409 sweep).
 * - `least-relevant`: lowest score first (EXP392 default).
 * - `oldest`: smallest turn number first (ignore relevance).
 * - `largest`: most tokens first (save the most space per eviction).
 * - `random`: deterministic per-call shuffle using a Mulberry32 PRNG
 *   seeded from the supplied seed (reproducible).
 */
function sortByStrategy(candidates: Array<{ idx: number; m: TurnMessage; score: number }>, strategy: string, seed: number): void {
  switch (strategy) {
    case "oldest":
      candidates.sort((a, b) => a.m.turn - b.m.turn);
      break;
    case "largest":
      candidates.sort((a, b) => b.m.tokens - a.m.tokens);
      break;
    case "random": {
      const rng = mulberry32(seed >>> 0);
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
      }
      break;
    }
    case "least-relevant":
    default:
      candidates.sort((a, b) => a.score - b.score);
      break;
  }
}

/** Mulberry32 PRNG — small, fast, deterministic. Returns a function producing
 *  floats in [0, 1). Used by the `random` trim strategy so runs are reproducible. */
function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
