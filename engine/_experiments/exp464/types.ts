/**
 * EXP464 — Full E2E 10× Harder: extended types.
 *
 * Extends EXP450 with:
 *   - L5-L7 self-healing levels (context-overflow, memory-recall, cross-file).
 *   - 10 codebases, 10 task types, 100 turns per task, 10 interconnected tasks.
 *   - 55 tracked actions.
 *   - Full performance tracking (CPU, RAM, disk IO, tokens/s, latency).
 *
 * Per the binding directives: "e2e tests must be as hard and realistic as
 * possible" + "10× harder" + "track everything."
 */

import type { SelfHealLevel as Exp450SelfHealLevel } from "../../_experiments/exp450/types.ts";

/** Extended self-heal levels L1-L7 (EXP450 had L1-L4 only). */
export type SelfHealLevel = Exp450SelfHealLevel | "L5" | "L6" | "L7";

export const ALL_HEAL_LEVELS: readonly SelfHealLevel[] = Object.freeze([
  "L1", "L2", "L3", "L4", "L5", "L6", "L7",
]);

/** The 10 codebases under test. */
export const CODEBASES = Object.freeze([
  "babel", "typescript", "zod", "express", "lodash",
  "flask", "tokio", "gin", "guava", "redis",
] as const);

export type CodebaseId = typeof CODEBASES[number];

/** The 10 task types per codebase. */
export const TASK_TYPES = Object.freeze([
  "search", "rename", "extract", "inline", "add-param",
  "fix-bug", "add-feature", "refactor-pattern", "cross-file", "multi-step",
] as const);

export type TaskType = typeof TASK_TYPES[number];

/** A task definition for the 10× harder e2e. */
export type E2ETask = Readonly<{
  id: string;
  codebase: CodebaseId;
  taskType: TaskType;
  request: string;
  expectedSymbol: string;
  expectedPath: string | null;
  editPath?: string;
  turns: number;
}>;

/** The 10 interconnected tasks (task N+1 depends on task N). */
export type InterconnectedTask = Readonly<{
  id: string;
  step: number;
  request: string;
  expected: string;
  dependsOn: string | null;
  editPath?: string;
}>;

/** The 55 tracked actions. */
export const ACTION_CATALOG: readonly { id: string; description: string }[] = Object.freeze([
  // Classification actions (5)
  { id: "act.classify", description: "Classify the user request" },
  { id: "act.classify-target", description: "Extract target identifier" },
  { id: "act.classify-kind", description: "Determine request kind" },
  { id: "act.classify-confidence", description: "Compute classification confidence" },
  { id: "act.classify-search-query", description: "Derive search query" },
  // Injection actions (5)
  { id: "act.inject-codebase", description: "Inject codebase context" },
  { id: "act.inject-memory", description: "Inject memory context" },
  { id: "act.inject-hybrid", description: "Inject hybrid (codebase+memory) context" },
  { id: "act.inject-estimate-tokens", description: "Estimate injected tokens" },
  { id: "act.inject-measure-duration", description: "Measure injection duration" },
  // LLM actions (5)
  { id: "act.llm-build-prompt", description: "Build the LLM prompt" },
  { id: "act.llm-send", description: "Send to the LLM" },
  { id: "act.llm-retry", description: "Retry on LLM error" },
  { id: "act.llm-translate-error", description: "Translate error for LLM" },
  { id: "act.llm-track-tokens", description: "Track input vs output tokens" },
  // Response actions (5)
  { id: "act.parse-response", description: "Parse the LLM response" },
  { id: "act.parse-edits", description: "Extract fenced code blocks" },
  { id: "act.parse-searches", description: "Extract search intents" },
  { id: "act.parse-tool-calls", description: "Flag forbidden tool_calls JSON" },
  { id: "act.parse-error-handling", description: "Flag forbidden error-handling blocks" },
  // Edit actions (5)
  { id: "act.edit-apply", description: "Apply an edit atomically" },
  { id: "act.edit-verify-preimage", description: "Verify edit preimage" },
  { id: "act.edit-verify-postwrite", description: "Verify post-write content" },
  { id: "act.edit-rollback", description: "Rollback a failed edit" },
  { id: "act.edit-self-heal", description: "Self-heal a failed edit" },
  // Search actions (5)
  { id: "act.search-symbol", description: "Run a symbol search" },
  { id: "act.search-quick-view", description: "Run a quick-view text search" },
  { id: "act.search-slice", description: "Run an AST slice" },
  { id: "act.search-repo-map", description: "Generate/query the repository map" },
  { id: "act.search-find-reuse", description: "Find reusable logic" },
  // Safety actions (5)
  { id: "act.safety-hallucination", description: "Check hallucination (6 layers)" },
  { id: "act.safety-bias", description: "Check bias (8 types)" },
  { id: "act.safety-bandaid", description: "Check bandaids (AST, no static keywords)" },
  { id: "act.safety-quality", description: "Run quality checks" },
  { id: "act.safety-correct", description: "Auto-correct a detected issue" },
  // Memory actions (5)
  { id: "act.memory-store", description: "Store a memory entry" },
  { id: "act.memory-retrieve", description: "Retrieve from memory" },
  { id: "act.memory-attempt-record", description: "Record an attempt" },
  { id: "act.memory-attempt-retrieve", description: "Retrieve before retry" },
  { id: "act.memory-learn", description: "Learn from an error" },
  // Context actions (5)
  { id: "act.context-add-turn", description: "Add a turn to context" },
  { id: "act.context-trim", description: "Trim the context window" },
  { id: "act.context-summarize", description: "Summarize old turns" },
  { id: "act.context-pin", description: "Pin a critical turn" },
  { id: "act.context-overflow-check", description: "Check for context overflow" },
  // Performance + awareness actions (5)
  { id: "act.perf-cpu", description: "Track CPU usage" },
  { id: "act.perf-ram", description: "Track RAM (heap + RSS)" },
  { id: "act.perf-disk", description: "Track disk IO" },
  { id: "act.perf-tokens", description: "Track tokens/s" },
  { id: "act.perf-latency", description: "Track latency" },
  // Learning + awareness actions (5)
  { id: "act.learn-extract", description: "Extract a learned pattern from an error" },
  { id: "act.learn-apply", description: "Apply a learned pattern to prevent recurrence" },
  { id: "act.learn-feedback-loop", description: "Feed back an error pattern to the learning store" },
  { id: "act.learn-fingerprint", description: "Compute an error fingerprint for deduplication" },
  { id: "act.learn-self-improve", description: "Self-improve the workflow based on patterns" },
]);

export const ACTION_TOTAL: number = ACTION_CATALOG.length;

/** Per-codebase, per-task-type, per-turn result. */
export type TurnResult = Readonly<{
  codebase: CodebaseId;
  taskType: TaskType;
  taskId: string;
  turn: number;
  expected: { symbol: string; path: string | null };
  actual: { symbol: string | null; path: string | null; modified: boolean };
  correct: boolean;
  signalsObserved: number;
  actionsTracked: number;
  errors: number;
  selfHeal: Readonly<Record<SelfHealLevel, number>>;
  hallucinationCaught: number;
  biasDetected: number;
  bandaidRejected: number;
  memoryStored: number;
  memoryRetrieved: number;
  contextTrims: number;
  contextOverflow: boolean;
  maxContextTokens: number;
  perf: Readonly<{
    cpuPercent: number;
    ramMb: number;
    diskIoMb: number;
    inputTokens: number;
    outputTokens: number;
    tokensPerSecond: number;
    latencyMs: number;
  }>;
  durationMs: number;
}>;

/** Aggregate result for the full 10× harder e2e. */
export type E2EAggregate = Readonly<{
  schema: "exp464/v1";
  generatedAt: string;
  model: string;
  codebasesTotal: number;
  tasksPerCodebase: number;
  turnsPerTask: number;
  totalTurns: number;
  completedTurns: number;
  interconnectedTasksTotal: number;
  interconnectedTasksCorrect: number;
  signalsTracked: number;
  signalsTotal: number;
  actionsTracked: number;
  actionsTotal: number;
  errors: number;
  selfHeal: Readonly<Record<SelfHealLevel, number>>;
  hallucinationCaught: number;
  biasDetected: number;
  bandaidRejected: number;
  memoryStored: number;
  memoryRetrieved: number;
  memoryRecallPercent: number;
  contextTrims: number;
  contextOverflow: number;
  maxContextTokens: number;
  perf: Readonly<{
    avgCpuPercent: number;
    avgRamMb: number;
    avgDiskIoMb: number;
    avgTokensPerSecond: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalWallMs: number;
  }>;
  perCodebase: ReadonlyArray<Readonly<{
    codebase: CodebaseId;
    tasksCorrect: number;
    tasksTotal: number;
    turnsCorrect: number;
    turnsTotal: number;
  }>>;
  perTaskType: ReadonlyArray<Readonly<{
    taskType: TaskType;
    correct: number;
    total: number;
  }>>;
  tenXHarder: Readonly<{
    attempted: boolean;
    codebasesTested: number;
    tasksTested: number;
    turnsTested: number;
  }>;
}>;
