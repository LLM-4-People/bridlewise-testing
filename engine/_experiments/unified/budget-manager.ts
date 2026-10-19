/**
 * Budget manager: per-component context budgeting (novel approach 1).
 *
 * The user directive lists four novel approaches to try; "context
 * budgeting" is the first. Give each component a token budget and trim
 * if exceeded:
 *   - system      ≤ 500 tokens (the persistent system prompt)
 *   - awareness  ≤ 200 tokens (per-turn awareness block)
 *   - memory     ≤ 1000 tokens (per-turn memory injection / critical context)
 *   - history    ≤ 5000 tokens (conversation user/assistant turns)
 *   - tools      ≤ 1300 tokens (tool results)
 *
 * The TrimManager accepts an optional `KindBudgets` and, when supplied,
 * first evicts from the kind that most exceeds its budget (budget-aware)
 * before falling back to the global least-relevant policy. This keeps a
 * single large tool result from evicting the system prompt or the
 * awareness block, and keeps a flood of tool results from crowding out
 * the conversation history.
 *
 * Every budget comes from `UnifiedConfig.budget` (no static constants
 * here). The defaults above are the documented starting point; the
 * caller can override them.
 */
import type { MessageKind } from "./types.ts";
import type { KindBudgets } from "./trim-manager.ts";

export type BudgetConfig = Readonly<{
  system: number;
  awareness: number;
  memory: number;
  history: number;
  tools: number;
}>;

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = Object.freeze({
  system: 500,
  awareness: 200,
  memory: 1000,
  history: 5000,
  tools: 1300,
});

export class BudgetManager {
  readonly cfg: BudgetConfig;
  constructor(cfg: BudgetConfig = DEFAULT_BUDGET_CONFIG) {
    this.cfg = cfg;
  }

  /** Map a message kind to its budget kind. history = user+assistant; tools = tool_result. */
  private budgetForKind(kind: MessageKind): number | null {
    switch (kind) {
      case "system": return this.cfg.system;
      case "awareness": return this.cfg.awareness;
      case "memory": return this.cfg.memory;
      case "critical_context": return this.cfg.memory; // critical context shares the memory budget
      case "user": case "assistant": return this.cfg.history;
      case "tool_result": return this.cfg.tools;
      default: return null;
    }
  }

  /** Build the `KindBudgets` object the TrimManager consumes. */
  toKindBudgets(): KindBudgets {
    const out: Partial<Record<MessageKind, number>> = {};
    for (const k of ["system", "awareness", "memory", "user", "assistant", "tool_result", "critical_context"] as const) {
      const b = this.budgetForKind(k);
      if (b != null) out[k] = b;
    }
    return out;
  }

  /** Audit: per-kind tokens currently in-context vs budget. Returns overflow per kind. */
  audit(messages: ReadonlyArray<{ kind: MessageKind; tokens: number }>): Record<string, { tokens: number; budget: number; overflow: number }> {
    const byKind = new Map<MessageKind, number>();
    for (const m of messages) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + m.tokens);
    const out: Record<string, { tokens: number; budget: number; overflow: number }> = {};
    for (const [kind, tokens] of byKind) {
      const budget = this.budgetForKind(kind) ?? 0;
      out[kind] = { tokens, budget, overflow: budget > 0 ? Math.max(0, tokens - budget) : 0 };
    }
    return out;
  }
}

export { DEFAULT_BUDGET_CONFIG as BUDGET_DEFAULTS };
