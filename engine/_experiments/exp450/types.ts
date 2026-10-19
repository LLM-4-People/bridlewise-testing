/**
 * EXP450 — Unified LLM-to-machine interface: shared types.
 *
 * User directive (binding): "we want to remove responsibilities from llm as
 * much as possible, because like human, they make mistakes, forget things,
 * etc. they're good at generating, which we cannot do mechanically, but we
 * must make it so its only task." + "everything must be unified and working
 * together."
 *
 * The LLM's ONLY task is GENERATION (code content, explanations, decisions,
 * test cases, refactoring strategies). Every mechanical responsibility —
 * search, file read, edit application, error handling, context management,
 * quality checks, hallucination/bias/bandaid prevention, memory, learning,
 * performance tracking — is owned by the harness and NEVER exposed to the
 * LLM. Per the binding directives, errors are translated to "this failed,
 * try a different approach" before they reach the model.
 */

import type { ClassifiedQuery, InjectionResult, QueryKind } from "../../_experiments/exp420/types.ts";
import type { TokenUsage } from "../../src/shared/llm/client.ts";

/** The four request classes the harness distinguishes (from EXP420). */
export type RequestClass = QueryKind;

/** The twelve mechanical responsibilities removed from the LLM. */
export const MECHANICAL_RESPONSIBILITIES = Object.freeze([
  "search",            // harness searches (proactive injection, EXP420)
  "read-files",         // harness slices (EXP334/355/365)
  "edit-files",        // harness applies + verifies (EXP356/404)
  "handle-errors",     // harness handles (SharedLLMClient, EXP421)
  "manage-context",    // harness trims + remembers (EXP435)
  "check-quality",     // harness checks (EXP386)
  "prevent-hallucination", // harness prevents (EXP388)
  "detect-bias",       // harness detects (EXP380)
  "detect-bandaids",   // harness detects (EXP432)
  "manage-memory",     // harness manages (EXP435/433)
  "learn-from-mistakes", // harness learns (EXP389/424)
  "improve-workflow",  // harness improves (EXP424)
] as const);

export type MechanicalResponsibility = typeof MECHANICAL_RESPONSIBILITIES[number];

/** The five generative responsibilities the LLM keeps. */
export const LLM_GENERATIVE_DUTIES = Object.freeze([
  "generate-code",
  "generate-explanations",
  "generate-decisions",
  "generate-tests",
  "generate-refactor-strategy",
] as const);

export type LLMGenerativeDuty = typeof LLM_GENERATIVE_DUTIES[number];

/**
 * A single fenced code block the harness parsed out of the LLM response.
 * The LLM emits markdown with optional path-annotated fences; the harness
 * decides which (if any) to apply mechanically. The LLM never applies.
 */
export type ParsedEdit = Readonly<{
  /** Language tag from the fence (ts, js, tsx, ...). */
  language: string;
  /** Path annotation (`path=...`) when the model named a target file, else null. */
  path: string | null;
  /** Full content inside the fence. */
  content: string;
  /** 0-based index of the fence in the response. */
  index: number;
}>;

/** A parsed search intent the harness will run mechanically. */
export type ParsedSearch = Readonly<{
  query: string;
  kind: "symbol" | "text" | "semantic";
}>;

/** What the harness extracted mechanically from the LLM's generated response. */
export type AnalyzedResponse = Readonly<{
  /** The raw generated text (explanations/decisions the LLM produced). */
  text: string;
  /** Fenced code blocks the harness may apply. */
  edits: readonly ParsedEdit[];
  /** Inline search intents the harness may run (e.g. "search: foo"). */
  searches: readonly ParsedSearch[];
  /** Did the LLM attempt to emit an explicit tool_calls JSON? (Should be 0.) */
  emittedToolCalls: number;
  /** Did the LLM attempt to emit an explicit error-handling block? (Should be 0.) */
  emittedErrorHandling: number;
}>;

export type SelfHealLevel = "L1" | "L2" | "L3" | "L4";

/** The outcome of one mechanical edit application (with auto-heal attempts). */
export type EditOutcome = Readonly<{
  path: string;
  applied: boolean;
  attempts: number;
  healLevelsUsed: readonly SelfHealLevel[];
  finalFeedback: string;
  durationMs: number;
}>;

/** Hallucination finding from one of the 6 mechanical layers. */
export type HallucinationFinding = Readonly<{
  layer: 1 | 2 | 3 | 4 | 5 | 6;
  layerName: string;
  message: string;
  corrected: boolean;
  correction: string | null;
}>;

/** Bias finding from one of the 8 mechanical bias types. */
export type BiasFinding = Readonly<{
  type: string;
  message: string;
  severity: "low" | "medium" | "high";
}>;

/** Bandaid finding (AST-structural, NO static keyword list). */
export type BandaidFinding = Readonly<{
  structural: string;
  message: string;
  rootCause: string;
}>;

/** A single signal observation recorded during a run. */
export type SignalObservation = Readonly<{
  signalId: string;
  value: number;
  unit: string;
}>;

/** Performance snapshot (CPU, RAM, disk IO, tokens, latency). */
export type PerfSnapshot = Readonly<{
  cpuPercent: number;
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
  diskReadMb: number;
  diskWriteMb: number;
  fsReadCount: number;
  fsWriteCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokensPerSecond: number;
  latencyMs: number;
  eventLoopLagMs: number;
}>;

/** The full receipt for one task turn. */
export type TurnReceipt = Readonly<{
  turnId: string;
  userRequest: string;
  requestClass: RequestClass;
  classified: ClassifiedQuery;
  injection: InjectionResult;
  llm: Readonly<{
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
    retries: number;
    truncated: boolean;
    finishReason: string;
    error: string | null;
  }>;
  analyzed: AnalyzedResponse;
  mechanical: Readonly<{
    editsAttempted: number;
    editsApplied: number;
    searchesRun: number;
    toolsDispatched: number;
    qualityChecksRun: number;
    qualityFindings: number;
    memoryOps: number;
    awarenessSignalsUpdated: number;
  }>;
  safety: Readonly<{
    hallucinationCaught: number;
    hallucinationCorrected: number;
    biasCaught: number;
    bandaidCaught: number;
    selfHeal: Readonly<Record<SelfHealLevel, number>>;
  }>;
  perf: PerfSnapshot;
  signals: readonly SignalObservation[];
  /** What the user sees back (generated text + a mechanical summary). */
  result: string;
  correct: boolean;
  durationMs: number;
}>;

/** Aggregate receipt for a full task suite. */
export type SuiteReceipt = Readonly<{
  schema: "exp450/v1";
  generatedAt: string;
  model: string;
  api: string;
  codebase: string;
  tasksTotal: number;
  tasksCorrect: number;
  llmResponsibilitiesRemoved: number;
  llmResponsibilitiesTotal: number;
  llmOnlyGenerated: boolean;
  harnessDidAllMechanical: boolean;
  signalsTracked: number;
  signalsTotal: number;
  perf: Readonly<{
    avgCpuPercent: number;
    avgHeapMb: number;
    avgRssMb: number;
    avgDiskReadMb: number;
    avgDiskWriteMb: number;
    avgTokensPerSecond: number;
    avgLatencyMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
  }>;
  errors: number;
  selfHeal: Readonly<Record<SelfHealLevel, number>>;
  hallucinationCaught: number;
  biasCaught: number;
  bandaidCaught: number;
  improperHandled: number;
  improperTotal: number;
  multiTurnTurns: number;
  multiTurnTasks: number;
  turns: readonly TurnReceipt[];
}>;

export type { TokenUsage };
