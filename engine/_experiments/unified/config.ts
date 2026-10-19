/**
 * Central configuration for the unified context + memory + awareness system.
 *
 * This is the SINGLE owner of every threshold, cap, weight, and budget used
 * by the context manager, memory store, injection controller, and
 * enforcement cascade. Per the user directive ("everything dynamically
 * computed, no static variables/consts other than configurables"), no
 * numeric constant that is not derived from runtime state lives outside
 * this module. The awareness engine has its own config
 * (`awareness/config.ts`) which is consumed here through
 * `buildAwarenessConfig`.
 */
import { experimentApiFromEnvironment } from "../experiment-environment.ts";
import { configureAwareness } from "./awareness/config.ts";
import type { AwarenessConfig } from "./awareness/config.ts";
import { DEFAULT_BIAS_CONFIG, type BiasConfig } from "./bias-detector.ts";
import { DEFAULT_BUDGET_CONFIG, type BudgetConfig } from "./budget-manager.ts";

/** API + model configuration. */
export type ApiConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  models: Readonly<{ primary: string; reasoning: string }>;
  maxTokens: number;
  temperature: number;
  perCallTimeoutMs: number;
  maxRetries: number;
  backoffBaseMs: number;
}>;

/** Trim-strategy selector (EXP409 sweep — what to evict when trimming). */
export type TrimStrategy = "least-relevant" | "oldest" | "largest" | "random";

/** Retrieval-strategy selector (EXP409 sweep — what to recall from memory). */
export type RetrievalStrategy = "tfidf" | "ebbinghaus" | "hybrid" | "hybrid-boost";

/** Context-window configuration. */
export type WindowConfig = Readonly<{
  /** Physical context budget (tokens). The unified system targets 8K. */
  capacity: number;
  /** Trim when total exceeds capacity * trimThreshold. */
  trimThreshold: number;
  /**
   * EXP409 sweep — trim step (fraction of capacity). When trimming, evict
   * until totalTokens <= capacity * (trimThreshold - trimStep). This gives
   * a hysteresis band so we don't trim again on the very next turn.
   * 0.10 = evict down to 10% below the threshold; 0.50 = evict down to 50%
   * below the threshold (aggressive).
   */
  trimStep: number;
  /** EXP409 sweep — which turns to evict. */
  trimStrategy: TrimStrategy;
}>;

/** Memory-store configuration (TF-IDF + Ebbinghaus). */
export type MemoryConfig = Readonly<{
  topK: number;
  threshold: number;
  entryTokBudget: number;
  decayInitStrength: number;
  decayReinforceGain: number;
  pruneThreshold: number;
  fadingBoost: number;
  recencyTurns: number;
  /**
   * EXP409 sweep — retrieval strategy.
   * - `tfidf`: pure TF-IDF cosine similarity (no Ebbinghaus fading, no hot-module boost).
   * - `ebbinghaus`: retention × strength (reinforce decaying memories; ignores TF-IDF).
   * - `hybrid`: TF-IDF × (1 + retention) — balanced lexical + memory-strength.
   * - `hybrid-boost`: EXP392 default — TF-IDF + fadingBoost + hot-module boost.
   */
  retrievalStrategy: RetrievalStrategy;
}>;

/** Injection-controller configuration. */
export type InjectionConfig = Readonly<{
  systemPromptTokBudget: number;
  awarenessTokBudget: number;
  memoryTokBudget: number;
  /** EXP435: token budget for the conversation summary block (always in context). */
  summaryTokBudget: number;
  /** EXP435: enable the conversation summary (continuity-preserving trim). */
  enableSummary: boolean;
  /** Weight for recency in memory-aware trimming. */
  recencyWeight: number;
  /** Weight for TF-IDF relevance to current query. */
  relevanceWeight: number;
  /** Weight for has-fact boost. */
  factsWeight: number;
  /** Weight for hot-module overlap boost. */
  hotModuleWeight: number;
  /** Recency decay (turns) — exp(-(currentTurn-turn)/recencyDecayTurns). */
  recencyDecayTurns: number;
  /** Always keep the most recent N turns (continuity). */
  minRecentTurnsKept: number;
}>;

/** Attention enforcement cascade configuration (from EXP360). */
export type EnforcementConfig = Readonly<{
  keyTokenMatchRequired: number;
  caseInsensitive: boolean;
  bypassAfterFails: number;
  maxEscalation: number;
}>;

/** Probe schedule configuration. */
export type ProbeConfig = Readonly<{
  checkpoints: readonly number[];
}>;

/** The full unified configuration. */
export type UnifiedConfig = Readonly<{
  api: ApiConfig;
  window: WindowConfig;
  memory: MemoryConfig;
  injection: InjectionConfig;
  enforcement: EnforcementConfig;
  probes: ProbeConfig;
  awareness: AwarenessConfig;
  bias: BiasConfig;
  budget: BudgetConfig;
}>;

/**
 * Build a unified config from a partial override. The API block comes from
 * the environment (`experimentApiFromEnvironment`); every other value falls back to
 * the documented defaults. The awareness config is built with a tight
 * 200-token compact budget so the awareness block fits the injection budget.
 */
export function buildUnifiedConfig(override: Readonly<Partial<UnifiedConfig>> & { api?: Partial<ApiConfig> }): UnifiedConfig {
  const llmCfg = experimentApiFromEnvironment();
  return {
    api: {
      baseUrl: override.api?.baseUrl ?? llmCfg.baseUrl,
      apiKey: override.api?.apiKey ?? llmCfg.apiKey,
      models: {
        primary: override.api?.models?.primary ?? "gemma-4-31b",
        reasoning: override.api?.models?.reasoning ?? "glm-5.2",
      },
      maxTokens: override.api?.maxTokens ?? 800,
      temperature: override.api?.temperature ?? 0,
      perCallTimeoutMs: override.api?.perCallTimeoutMs ?? 60_000,
      maxRetries: override.api?.maxRetries ?? 4,
      backoffBaseMs: override.api?.backoffBaseMs ?? 2500,
    },
    window: {
      capacity: override.window?.capacity ?? 8000,
      trimThreshold: override.window?.trimThreshold ?? 0.80,
      trimStep: override.window?.trimStep ?? 0.10,
      trimStrategy: override.window?.trimStrategy ?? "least-relevant",
    },
    memory: {
      topK: override.memory?.topK ?? 5,
      threshold: override.memory?.threshold ?? 0.08,
      entryTokBudget: override.memory?.entryTokBudget ?? 250,
      decayInitStrength: override.memory?.decayInitStrength ?? 1.5,
      decayReinforceGain: override.memory?.decayReinforceGain ?? 1.0,
      pruneThreshold: override.memory?.pruneThreshold ?? 0.05,
      fadingBoost: override.memory?.fadingBoost ?? 0.15,
      recencyTurns: override.memory?.recencyTurns ?? 5,
      retrievalStrategy: override.memory?.retrievalStrategy ?? "hybrid-boost",
    },
    injection: {
      systemPromptTokBudget: override.injection?.systemPromptTokBudget ?? 500,
      awarenessTokBudget: override.injection?.awarenessTokBudget ?? 200,
      memoryTokBudget: override.injection?.memoryTokBudget ?? 500,
      summaryTokBudget: override.injection?.summaryTokBudget ?? 200,
      enableSummary: override.injection?.enableSummary ?? false,
      recencyWeight: override.injection?.recencyWeight ?? 0.40,
      relevanceWeight: override.injection?.relevanceWeight ?? 0.40,
      factsWeight: override.injection?.factsWeight ?? 0.10,
      hotModuleWeight: override.injection?.hotModuleWeight ?? 0.10,
      recencyDecayTurns: override.injection?.recencyDecayTurns ?? 20,
      minRecentTurnsKept: override.injection?.minRecentTurnsKept ?? 4,
    },
    enforcement: {
      keyTokenMatchRequired: override.enforcement?.keyTokenMatchRequired ?? 1,
      caseInsensitive: override.enforcement?.caseInsensitive ?? true,
      bypassAfterFails: override.enforcement?.bypassAfterFails ?? 3,
      maxEscalation: override.enforcement?.maxEscalation ?? 4,
    },
    probes: {
      checkpoints: override.probes?.checkpoints ?? [50, 100],
    },
    awareness: override.awareness ?? configureAwareness({ useGitHistory: false, compactTokenBudget: 200 }),
    bias: override.bias ?? DEFAULT_BIAS_CONFIG,
    budget: override.budget ?? DEFAULT_BUDGET_CONFIG,
  };
}
