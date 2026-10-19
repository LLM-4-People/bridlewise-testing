/**
 * Context manager: the in-context window state.
 *
 * EXP392 splits the trim policy out into `TrimManager` (per the binding
 * directive "Properly split into multiple files"). The ContextManager
 * now owns ONLY the message list + token accounting + the add/remove
 * primitives. Trimming is delegated to a `TrimManager` instance.
 *
 * The public API the injection controller depends on is preserved:
 *   - addSystem / addAwareness / addMemoryInjection / addCriticalContext
 *   - addUser / addAssistant / addToolResult
 *   - trim / pruneTurns (delegated)
 *   - latestUserContent / toLLM / inContextTokens
 *
 * Per "no compaction": evicted turns are stored FULL in memory; they are
 * never summarized or merged. Each turn is either in-context (full) or
 * in-memory (full, retrievable).
 */
import { tokenize } from "./tokenizer.ts";
import type { UnifiedConfig } from "./config.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { TrimManager, KindBudgets } from "./trim-manager.ts";
import type { MessageKind, TrimmedTurn, TurnMessage } from "./types.ts";

export class ContextManager {
  readonly cfg: UnifiedConfig;
  readonly memory: MemoryStore;
  readonly messages: TurnMessage[] = [];
  totalTokens = 0;
  injectedMemoryTokens = 0;
  injectedAwarenessTokens = 0;
  /** The trim manager owning the eviction policy (set via setTrimManager). */
  private trimManager: TrimManager | null = null;

  constructor(cfg: UnifiedConfig, memory: MemoryStore) {
    this.cfg = cfg;
    this.memory = memory;
  }

  /** Wire the trim manager. Required before `trim`/`pruneTurns` can be called. */
  setTrimManager(tm: TrimManager): void {
    this.trimManager = tm;
  }

  private add(role: TurnMessage["role"], content: string, turn: number, kind: MessageKind, hasFact: boolean, moduleTags: readonly string[]): number {
    const tokens = Math.ceil(content.length / 4);
    this.messages.push({ role, content, tokens, turn, kind, hasFact, moduleTags });
    this.totalTokens += tokens;
    return tokens;
  }

  addSystem(content: string, turn = 0): void {
    this.add("system", content, turn, "system", false, []);
  }

  /** Per-turn awareness block: remove the previous one, add the new one. */
  addAwareness(content: string, turn: number): void {
    this.removeKind("awareness");
    const t = this.add("system", content, turn, "awareness", false, []);
    this.injectedAwarenessTokens += t;
  }

  /** Per-turn memory injection: remove the previous one, add the new one. */
  addMemoryInjection(content: string, turn: number): void {
    this.removeKind("memory");
    const t = this.add("system", content, turn, "memory", false, []);
    this.injectedMemoryTokens += t;
  }

  /** EXP435: Per-turn conversation summary block (always in context, replaced each turn). */
  addSummary(content: string, turn: number): void {
    this.removeKind("summary");
    this.add("system", content, turn, "summary", false, []);
  }

  /** Enforced critical-context injection (probe cascade). */
  addCriticalContext(content: string, turn: number): void {
    this.removeKind("critical_context");
    const t = this.add("system", content, turn, "critical_context", false, []);
    this.injectedMemoryTokens += t;
  }

  addUser(content: string, turn: number, hasFact = false, moduleTags: readonly string[] = []): number {
    return this.add("user", content, turn, "user", hasFact, moduleTags);
  }

  addAssistant(content: string, turn: number): void {
    this.add("assistant", content, turn, "assistant", false, []);
  }

  addToolResult(content: string, turn: number): void {
    this.add("user", content, turn, "tool_result", false, []);
  }

  private removeKind(kind: MessageKind): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!.kind === kind) {
        this.totalTokens -= this.messages[i]!.tokens;
        this.messages.splice(i, 1);
      }
    }
  }

  /** Trim, delegating to the TrimManager. */
  trim(currentTurn: number, currentQuery: string, hotModules: readonly string[], kindBudgets: KindBudgets = null): TrimmedTurn[] {
    if (!this.trimManager) throw new Error("ContextManager.trim: no TrimManager wired (call setTrimManager)");
    return this.trimManager.trim(currentTurn, currentQuery, hotModules, kindBudgets);
  }

  /** Drift-correction prune, delegating to the TrimManager. */
  pruneTurns(startTurn: number, endTurn: number): TrimmedTurn[] {
    if (!this.trimManager) throw new Error("ContextManager.pruneTurns: no TrimManager wired");
    return this.trimManager.pruneTurns(startTurn, endTurn);
  }

  latestUserContent(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.kind === "user" || m.kind === "tool_result") return m.content;
    }
    return "";
  }

  toLLM(): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    return this.messages.map((m) => ({ role: m.role, content: m.content }));
  }

  inContextTokens(): number {
    return this.totalTokens;
  }
}

/** Re-export the trim count + eviction log accessors for the runner (the
 *  InjectionController reads these for diagnostics). They delegate to the
 *  TrimManager once wired. */
export function trimCountOf(ctx: ContextManager): number {
  return (ctx as unknown as { trimManager: TrimManager | null }).trimManager?.trimCount ?? 0;
}

export function evictedTurnsOf(ctx: ContextManager): Set<number> {
  return (ctx as unknown as { trimManager: TrimManager | null }).trimManager?.evictedTurns ?? new Set<number>();
}

export { tokenize };
