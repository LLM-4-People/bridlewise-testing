/**
 * EXP420 — Public surface for the proactive-injection experiment.
 */

export {
  CLASSIFIER_CONFIG,
  classifyQuery,
} from "./query-classifier.ts";

export {
  INJECTOR_CONFIG,
  proactivelyInject,
} from "./proactive-injector.ts";

export {
  LLM_CONFIG,
  llmChat,
  simulateSearchCode,
  runTrial,
} from "./llm-client.ts";

export {
  summarizeMode,
  analyzeEfficiency,
} from "./efficiency-analyzer.ts";
export type { EfficiencyVerdict } from "./efficiency-analyzer.ts";

// The vocabularies travel with their types: a consumer that imports the type
// and then writes the members out again has made a second declaration the
// compiler cannot hold to the first.
export { TRIAL_MODES } from "./types.ts";

export type {
  ClassifiedQuery,
  Exp420Receipt,
  InjectionResult,
  InjectionSource,
  ModeSummary,
  PerKindSummary,
  QueryKind,
  TrialMode,
  TrialResult,
} from "./types.ts";
