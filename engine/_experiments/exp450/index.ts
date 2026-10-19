/**
 * EXP450 — Unified LLM-to-machine interface: public exports.
 *
 * One barrel for the unified harness + its mechanical subsystems. Per
 * AGENTS.md "properly split into multiple files": each responsibility lives
 * in its own module; this file only re-exports.
 */

export {
  HARNESS_CONFIG,
  createUnifiedHarness,
  type UnifiedHarness,
  type UnifiedHarnessOptions,
} from "./unified-harness.ts";

export {
  SIGNAL_CATALOG,
  SIGNAL_TOTAL,
  SIGNAL_COUNTS_BY_CATEGORY,
  SignalTracker,
  type SignalDef,
  type SignalCategory,
} from "./signal-registry.ts";

export { PerfTracker, PERF_CONFIG } from "./perf-tracker.ts";

export {
  detectHallucination,
  detectBias,
  detectBandaids,
  LearnedPatterns,
  knownSymbolNames,
  knownFilePaths,
  symbolArities,
  SAFETY_CONFIG,
} from "./safety-checks.ts";

export { analyzeResponse, ANALYZER_CONFIG } from "./response-analyzer.ts";

export {
  createMachineSide,
  MACHINE_CONFIG,
  type MachineSide,
  type MachineSideOptions,
  type EditAttempt,
} from "./machine-side.ts";

export {
  MECHANICAL_RESPONSIBILITIES,
  LLM_GENERATIVE_DUTIES,
  type MechanicalResponsibility,
  type LLMGenerativeDuty,
  type RequestClass,
  type TurnReceipt,
  type SuiteReceipt,
  type AnalyzedResponse,
  type ParsedEdit,
  type EditOutcome,
  type SelfHealLevel,
  type PerfSnapshot,
} from "./types.ts";
