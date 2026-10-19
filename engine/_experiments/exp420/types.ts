/**
 * EXP420 — Proactive context injection. Shared types.
 *
 * User directive: "can we try to inject context based off the user's request,
 * so like if the user or llm is asking x, we run this through memory/codebase
 * intelligence and inject what we have before sending the request to the llm,
 * so the llm does not need to do a call + round trip and can possibly directly
 * answer? or is this not efficient? can we thoroughly test this"
 *
 * The four query kinds (code, memory, action, general) and their confidence
 * are the input the proactive injector consumes. Per AGENTS.md "everything
 * dynamically computed": thresholds + keywords are in the CONFIG in
 * `query-classifier.ts`, not hardcoded in callers.
 */

export type QueryKind = "code" | "memory" | "action" | "general";

export type ClassifiedQuery = Readonly<{
  kind: QueryKind;
  /** 0..1 confidence in the classification. < hybridThreshold → skip injection. */
  confidence: number;
  /** The likely target identifier extracted from the query (e.g. `makeAssertNode`). */
  target: string | null;
  /** Free-text search query derived from the user's input (for memory + code search). */
  searchQuery: string;
}>;

export type InjectionSource = "codebase" | "memory" | "both" | "none";

export type InjectionResult = Readonly<{
  source: InjectionSource;
  /** Markdown-formatted context block to prepend to the LLM prompt. */
  contextBlock: string;
  /** Number of distinct results that were injected. */
  codebaseHits: number;
  memoryHits: number;
  /** Estimated token count of `contextBlock` (chars / 4 heuristic). */
  estimatedTokens: number;
  /** Time spent computing the injection (ms). */
  durationMs: number;
}>;

export const TRIAL_MODES = ["without", "with", "hybrid"] as const;

export type TrialMode = typeof TRIAL_MODES[number];

export type TrialResult = Readonly<{
  query: string;
  kind: QueryKind;
  expectedKind: QueryKind;
  classifierKind: QueryKind;
  classifierConfidence: number;
  classifierTarget: string | null;
  mode: TrialMode;
  /** LLM calls made (1 = direct, 2 = with one tool round trip, etc.). */
  llmCalls: number;
  /** Tool round trips (1 if the LLM called the search tool). */
  roundTrips: number;
  /** Sum of prompt + completion tokens across all LLM calls. */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Wall-clock time of the trial (ms). */
  durationMs: number;
  /** Injection cost (0 for `without`; context tokens for `with`/`hybrid`). */
  injectedTokens: number;
  /** Did the LLM answer correctly per the ground-truth predicate? */
  correct: boolean;
  /** Did the LLM emit a tool_calls request? */
  usedTool: boolean;
  /** Raw LLM answer text (truncated to 500 chars for the receipt). */
  answer: string;
  /** Ground-truth label (file path, memory id, etc.) used by the correctness check. */
  expected: string;
  /** API error (if any). */
  error: string | null;
}>;

export type PerKindSummary = Readonly<{
  kind: QueryKind;
  trials: number;
  /** Average LLM calls per trial. */
  avgLlmCalls: number;
  /** Average round trips per trial. */
  avgRoundTrips: number;
  /** Average total tokens per trial. */
  avgTokens: number;
  /** Average wall-clock time per trial (ms). */
  avgDurationMs: number;
  /** Accuracy (correct / trials). */
  accuracy: number;
  /** Average tokens INJECTED (0 for `without`). */
  avgInjectedTokens: number;
}>;

export type ModeSummary = Readonly<{
  mode: TrialMode;
  trials: number;
  perKind: readonly PerKindSummary[];
  aggregate: Readonly<{
    avgLlmCalls: number;
    avgRoundTrips: number;
    avgTokens: number;
    avgDurationMs: number;
    accuracy: number;
    avgInjectedTokens: number;
  }>;
}>;

export type Exp420Receipt = Readonly<{
  schema: "exp420/v1";
  generatedAt: string;
  codebase: string;
  model: string;
  api: string;
  classifierAccuracy: number;
  classifierConfusion: Readonly<Record<QueryKind, Readonly<Record<QueryKind, number>>>>;
  modes: readonly ModeSummary[];
  trials: readonly TrialResult[];
  config: Readonly<{
    hybridThreshold: number;
    injectionTopK: number;
    maxToolRoundTrips: number;
    queriesPerKind: number;
  }>;
  verdict: Readonly<{
    ship: "SHIP" | "DON'T SHIP" | "HYBRID";
    reasoning: string;
  }>;
}>;
