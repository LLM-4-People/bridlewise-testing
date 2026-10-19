/**
 * Public API for the unified context + memory + awareness system.
 *
 * The system is split into:
 *   - config.ts              central configuration (single owner of thresholds)
 *   - types.ts               shared contracts
 *   - tokenizer.ts           TF-IDF tokenizer + token estimation
 *   - memory-store.ts        TF-IDF + Ebbinghaus + hot-module boost
 *   - context-manager.ts     trim-as-you-go + memory-aware trimming
 *   - injection-controller.ts unified orchestrator (priority injection,
 *                           awareness-in-memory, trust enforcement)
 *   - awareness/             the dynamic codebase awareness engine
 *                           (14 signals, real-time, reused from EXP361)
 *
 * The runner (`scripts/exp378-unified.mjs`) wires these together against a
 * real LLM and the babel codebase.
 */
export { buildUnifiedConfig } from "./config.ts";
export type { UnifiedConfig, ApiConfig, WindowConfig, MemoryConfig, InjectionConfig, EnforcementConfig, ProbeConfig } from "./config.ts";
export { MemoryStore } from "./memory-store.ts";
export { ContextManager, trimCountOf, evictedTurnsOf } from "./context-manager.ts";
export { TrimManager } from "./trim-manager.ts";
export type { KindBudgets } from "./trim-manager.ts";
export { InjectionController, extractJSON } from "./injection-controller.ts";
export type { AwarenessEngine, BuildContextResult, CascadeResult } from "./injection-controller.ts";
export { BiasDetector, DEFAULT_BIAS_CONFIG } from "./bias-detector.ts";
export type { BiasConfig, BiasObservation, BiasReport } from "./bias-detector.ts";
export { BudgetManager, BUDGET_DEFAULTS } from "./budget-manager.ts";
export type { BudgetConfig } from "./budget-manager.ts";
export { tokenize, termFrequency, semanticHash, estimateTokens } from "./tokenizer.ts";
export type { TurnMessage, MessageKind, MemoryEntry, MemoryKind, RetrievedMemory, TrimmedTurn, PlantedFact, ProbeResult, AwarenessMemoryPayload } from "./types.ts";
export { createAwarenessEngine } from "./awareness/engine.ts";
export { configureAwareness } from "./awareness/config.ts";
export type { AwarenessConfig } from "./awareness/config.ts";
export type { AwarenessSnapshot } from "./awareness/types.ts";
