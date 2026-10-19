/**
 * EXP450 — Signal registry: the 253 exposure items the unified harness tracks.
 *
 * Per the binding directives: "Exposed as many signals, actions, customization
 * as possible — use the shared exposure system (EXP425)" and "Track ALL signals
 * (253 exposure items)." This module is the single source of truth for the
 * signal catalog. Each signal has a stable id, a category, a description, and
 * a unit. The harness records observations keyed by id; the test verifies all
 * 253 were tracked across the suite.
 *
 * Categories (15) and their counts sum to exactly 253:
 *   classification(4) + injection(8) + llm-call(12) + response-analysis(10) +
 *   edit(15) + search(12) + tool(10) + hallucination(6) + bias(8) +
 *   bandaid(10) + quality(23) + memory(20) + awareness(44) + performance(33) +
 *   learning(10) + error-handling(13) + context(11) + safety(4) = 253
 *
 * Per AGENTS.md "everything dynamically computed": the registry is a frozen
 * data structure, not hardcoded reads. New signals are added here (the ONE
 * owner) and every consumer reads from `SIGNAL_CATALOG`.
 */

export type SignalCategory =
  | "classification" | "injection" | "llm-call" | "response-analysis"
  | "edit" | "search" | "tool" | "hallucination" | "bias" | "bandaid"
  | "quality" | "memory" | "awareness" | "performance" | "learning"
  | "error-handling" | "context" | "safety";

export type SignalDef = Readonly<{
  id: string;
  category: SignalCategory;
  description: string;
  unit: string;
}>;

/** Helper to build a signal def tersely. */
function sig(category: SignalCategory, id: string, unit: string, description: string): SignalDef {
  return Object.freeze({ id, category, description, unit });
}

const C: readonly SignalDef[] = Object.freeze([
  // classification (4)
  sig("classification", "cls.kind-code", "count", "Query classified as code"),
  sig("classification", "cls.kind-memory", "count", "Query classified as memory"),
  sig("classification", "cls.kind-action", "count", "Query classified as action"),
  sig("classification", "cls.kind-general", "count", "Query classified as general"),
  // injection (8)
  sig("injection", "inj.codebase-hits", "count", "Codebase symbols injected"),
  sig("injection", "inj.memory-hits", "count", "Memory entries injected"),
  sig("injection", "inj.tokens", "tokens", "Tokens injected into prompt"),
  sig("injection", "inj.duration", "ms", "Injection wall time"),
  sig("injection", "inj.source-codebase", "count", "Injection sourced from codebase"),
  sig("injection", "inj.source-memory", "count", "Injection sourced from memory"),
  sig("injection", "inj.source-both", "count", "Injection sourced from both"),
  sig("injection", "inj.source-none", "count", "No injection available"),
  // llm-call (12)
  sig("llm-call", "llm.requests", "count", "LLM completion requests"),
  sig("llm-call", "llm.retries", "count", "LLM retries (handled by harness)"),
  sig("llm-call", "llm.input-tokens", "tokens", "Input/prompt tokens"),
  sig("llm-call", "llm.output-tokens", "tokens", "Output/completion tokens"),
  sig("llm-call", "llm.total-tokens", "tokens", "Total tokens (in+out)"),
  sig("llm-call", "llm.tokens-per-second", "tokens/s", "Generation throughput"),
  sig("llm-call", "llm.latency", "ms", "LLM request latency"),
  sig("llm-call", "llm.truncated", "count", "Responses truncated by max tokens"),
  sig("llm-call", "llm.circuit-open", "count", "Circuit breaker open events"),
  sig("llm-call", "llm.errors-handled", "count", "Errors handled (LLM never sees)"),
  sig("llm-call", "llm.finish-stop", "count", "Finish reason: stop"),
  sig("llm-call", "llm.finish-other", "count", "Finish reason: length/tool/etc"),
  // response-analysis (10)
  sig("response-analysis", "resp.edits-parsed", "count", "Fenced edits parsed from response"),
  sig("response-analysis", "resp.searches-parsed", "count", "Search intents parsed from response"),
  sig("response-analysis", "resp.tool-calls-emitted", "count", "LLM attempted tool_calls (should be 0)"),
  sig("response-analysis", "resp.error-handling-emitted", "count", "LLM attempted error handling (should be 0)"),
  sig("response-analysis", "resp.code-blocks", "count", "Total fenced code blocks"),
  sig("response-analysis", "resp.path-annotated", "count", "Fences with a path annotation"),
  sig("response-analysis", "resp.explanation-chars", "chars", "Explanation/decision text length"),
  sig("response-analysis", "resp.empty", "count", "Empty responses"),
  sig("response-analysis", "resp.generated", "count", "Non-empty generated responses"),
  sig("response-analysis", "resp.parse-duration", "ms", "Response parse wall time"),
  // edit (15)
  sig("edit", "edit.attempted", "count", "Edit applications attempted"),
  sig("edit", "edit.applied", "count", "Edits applied successfully"),
  sig("edit", "edit.rolled-back", "count", "Edits rolled back"),
  sig("edit", "edit.preimage-mismatch", "count", "Preimage hash mismatches (L1 heal)"),
  sig("edit", "edit.syntax-error", "count", "Post-edit syntax errors (L2 heal)"),
  sig("edit", "edit.quality-fail", "count", "Post-edit quality failures (L3 heal)"),
  sig("edit", "edit.hallucination", "count", "Post-edit hallucination (L4 heal)"),
  sig("edit", "edit.zero-delta-verified", "count", "Failed edits with verified zero delta"),
  sig("edit", "edit.write-set-denied", "count", "Edits denied by write set"),
  sig("edit", "edit.path-invalid", "count", "Edits with invalid paths"),
  sig("edit", "edit.atomic-write", "count", "Atomic writes performed"),
  sig("edit", "edit.postwrite-verified", "count", "Post-write hash verifications"),
  sig("edit", "edit.replaceFile", "count", "replaceFile operations"),
  sig("edit", "edit.applyPatch", "count", "applyPatch operations"),
  sig("edit", "edit.insertText", "count", "insertText operations"),
  // search (12)
  sig("search", "search.symbol-exact", "count", "Exact symbol searches run"),
  sig("search", "search.symbol-fuzzy", "count", "Fuzzy symbol searches run"),
  sig("search", "search.text", "count", "Quick-view text searches run"),
  sig("search", "search.semantic", "count", "Semantic searches run"),
  sig("search", "search.results", "count", "Search results returned"),
  sig("search", "search.top1-hit", "count", "Search top-1 correct hits"),
  sig("search", "search.duration", "ms", "Search wall time"),
  sig("search", "search.codebase-indexed", "count", "Codebase maps generated"),
  sig("search", "search.slice-returned", "count", "AST slices returned (not full files)"),
  sig("search", "search.full-file-avoided", "count", "Full-file reads avoided"),
  sig("search", "search.reuse-candidates", "count", "Reuse candidates discovered"),
  sig("search", "search.dep-graph", "count", "Dependency graph builds"),
  // tool (10)
  sig("tool", "tool.dispatched", "count", "Tool calls dispatched by harness"),
  sig("tool", "tool.read-file", "count", "read_file tool invocations"),
  sig("tool", "tool.list-files", "count", "list_files tool invocations"),
  sig("tool", "tool.execute-command", "count", "execute_command invocations"),
  sig("tool", "tool.intelligence", "count", "Intelligence tool invocations"),
  sig("tool", "tool.git", "count", "Git tool invocations"),
  sig("tool", "tool.concurrent", "count", "Concurrent tool batches"),
  sig("tool", "tool.errors", "count", "Tool errors (handled by harness)"),
  sig("tool", "tool.cancelled", "count", "Tool calls cancelled"),
  sig("tool", "tool.duration", "ms", "Tool dispatch wall time"),
  // hallucination (6)
  sig("hallucination", "halluc.l1-symbol", "count", "L1: hallucinated symbol (not in codebase)"),
  sig("hallucination", "halluc.l2-path", "count", "L2: hallucinated file path"),
  sig("hallucination", "halluc.l3-signature", "count", "L3: hallucinated API signature"),
  sig("hallucination", "halluc.l4-import", "count", "L4: hallucinated import"),
  sig("hallucination", "halluc.l5-version", "count", "L5: hallucinated version/feature"),
  sig("hallucination", "halluc.l6-invented-fact", "count", "L6: invented non-code fact"),
  // bias (8)
  sig("bias", "bias.length", "count", "Length bias (prefer long answers)"),
  sig("bias", "bias.recency", "count", "Recency bias (prefer recent context)"),
  sig("bias", "bias.familiarity", "count", "Familiarity bias (prefer known patterns)"),
  sig("bias", "bias.confirmation", "count", "Confirmation bias (prefer injected context)"),
  sig("bias", "bias.anchoring", "count", "Anchoring bias (over-rely on first result)"),
  sig("bias", "bias.availability", "count", "Availability bias (over-weight available)"),
  sig("bias", "bias.sampling", "count", "Sampling/temperature bias"),
  sig("bias", "bias.repetition", "count", "Repetition bias (repeat prior turn)"),
  // bandaid (10)
  sig("bandaid", "bandaid.try-catch-swallow", "count", "AST: swallowed catch block"),
  sig("bandaid", "bandaid.hardcoded-success", "count", "AST: hardcoded success value"),
  sig("bandaid", "bandaid.special-case", "count", "AST: one-off special-case branch"),
  sig("bandaid", "bandaid.silent-default", "count", "AST: silent default fallback"),
  sig("bandaid", "bandaid.workaround-comment", "count", "AST: workaround comment marker"),
  sig("bandaid", "bandaid.todo-fixme", "count", "AST: TODO/FIXME/HACK marker"),
  sig("bandaid", "bandaid.empty-catch", "count", "AST: empty catch block"),
  sig("bandaid", "bandaid.broad-catch", "count", "AST: overly-broad catch"),
  sig("bandaid", "bandaid.return-early-bypass", "count", "AST: early return bypass"),
  sig("bandaid", "bandaid.learned-pattern", "count", "Learned bandaid pattern (no static list)"),
  // quality (23)
  sig("quality", "q.syntax", "count", "Syntax check runs"),
  sig("quality", "q.type", "count", "Type check runs"),
  sig("quality", "q.undefined-symbol", "count", "Undefined symbol check runs"),
  sig("quality", "q.dead-symbol", "count", "Dead symbol check runs"),
  sig("quality", "q.unused-export", "count", "Unused export check runs"),
  sig("quality", "q.dead-branch", "count", "Dead branch check runs"),
  sig("quality", "q.duplicate-logic", "count", "Duplicate logic check runs"),
  sig("quality", "q.duplicate-body", "count", "Duplicate body check runs"),
  sig("quality", "q.esm-cjs", "count", "ESM/CJS mismatch check runs"),
  sig("quality", "q.duplicated-literals", "count", "Duplicated literals check runs"),
  sig("quality", "q.schema-drift", "count", "Schema drift check runs"),
  sig("quality", "q.config-outside-contract", "count", "Config-outside-contract check runs"),
  sig("quality", "q.errors-found", "count", "Quality errors found"),
  sig("quality", "q.warnings-found", "count", "Quality warnings found"),
  sig("quality", "q.infos-found", "count", "Quality infos found"),
  sig("quality", "q.passed", "count", "Quality checks passed"),
  sig("quality", "q.failed", "count", "Quality checks failed"),
  sig("quality", "q.not-applicable", "count", "Quality checks not applicable"),
  sig("quality", "q.tool-errors", "count", "Quality tool errors"),
  sig("quality", "q.duration", "ms", "Quality check wall time"),
  sig("quality", "q.exit-code-fail", "count", "Quality results with exitCode 1"),
  sig("quality", "q.packs-run", "count", "Quality packs resolved + run"),
  sig("quality", "q.total-diagnostics", "count", "Total diagnostics emitted"),
  // memory (20)
  sig("memory", "mem.add-present", "count", "Present-tier additions"),
  sig("memory", "mem.add-short", "count", "Short-term additions"),
  sig("memory", "mem.add-long", "count", "Long-term additions"),
  sig("memory", "mem.search-text", "count", "Text searches"),
  sig("memory", "mem.search-agent", "count", "Agent searches"),
  sig("memory", "mem.search-topic", "count", "Topic searches"),
  sig("memory", "mem.search-tags", "count", "Tag searches"),
  sig("memory", "mem.search-tier", "count", "Tier searches"),
  sig("memory", "mem.promote-present", "count", "Present promotions"),
  sig("memory", "mem.promote-long", "count", "Long-term promotions"),
  sig("memory", "mem.demote-short", "count", "Short-term demotions"),
  sig("memory", "mem.attempt-record", "count", "Attempt records"),
  sig("memory", "mem.attempt-retrieve", "count", "Attempt retrievals before retry"),
  sig("memory", "mem.corrupted", "count", "Corrupted entries detected"),
  sig("memory", "mem.estimate-tokens", "count", "Token estimate calls"),
  sig("memory", "mem.total-tokens", "tokens", "Memory total tokens"),
  sig("memory", "mem.count", "count", "Memory entry count"),
  sig("memory", "mem.duration", "ms", "Memory op wall time"),
  sig("memory", "mem.ebbinghaus-decay", "count", "Ebbinghaus decay applications"),
  sig("memory", "mem.trim-evicted", "count", "Context-trim evictions"),
  // awareness (44) — 44 live signals the harness maintains
  sig("awareness", "aware.turn-count", "count", "Current turn count"),
  sig("awareness", "aware.token-budget-used", "tokens", "Context tokens used"),
  sig("awareness", "aware.token-budget-limit", "tokens", "Context token limit"),
  sig("awareness", "aware.files-touched", "count", "Files touched this run"),
  sig("awareness", "aware.edits-applied", "count", "Edits applied this run"),
  sig("awareness", "aware.searches-run", "count", "Searches run this run"),
  sig("awareness", "aware.tools-dispatched", "count", "Tools dispatched this run"),
  sig("awareness", "aware.errors-handled", "count", "Errors handled this run"),
  sig("awareness", "aware.heal-used", "count", "Self-heal invocations this run"),
  sig("awareness", "aware.hallucinations", "count", "Hallucinations caught this run"),
  sig("awareness", "aware.bias-findings", "count", "Bias findings this run"),
  sig("awareness", "aware.bandaid-findings", "count", "Bandaid findings this run"),
  sig("awareness", "aware.quality-findings", "count", "Quality findings this run"),
  sig("awareness", "aware.memory-entries", "count", "Memory entry total"),
  sig("awareness", "aware.attempts-recorded", "count", "Attempts recorded total"),
  sig("awareness", "aware.active-agent", "count", "Active agent id"),
  sig("awareness", "aware.active-model", "count", "Active model id"),
  sig("awareness", "aware.active-codebase", "count", "Active codebase id"),
  sig("awareness", "aware.repository-modules", "count", "Repository module count"),
  sig("awareness", "aware.repository-symbols", "count", "Repository symbol count"),
  sig("awareness", "aware.circuit-state", "count", "LLM circuit state (closed/open/half)"),
  sig("awareness", "aware.queue-active", "count", "LLM queue active slots"),
  sig("awareness", "aware.queue-pending", "count", "LLM queue pending requests"),
  sig("awareness", "aware.context-trimmed", "count", "Context trim events"),
  sig("awareness", "aware.context-summaries", "count", "Context summaries created"),
  sig("awareness", "aware.pinned-turns", "count", "Pinned context turns"),
  sig("awareness", "aware.recent-window", "count", "Recent context window size"),
  sig("awareness", "aware.last-classification", "count", "Last classification kind"),
  sig("awareness", "aware.last-injection-source", "count", "Last injection source"),
  sig("awareness", "aware.last-finish-reason", "count", "Last LLM finish reason"),
  sig("awareness", "aware.last-edit-outcome", "count", "Last edit applied/rolled-back"),
  sig("awareness", "aware.last-quality-exit", "count", "Last quality exit code"),
  sig("awareness", "aware.last-halluc-layer", "count", "Last hallucination layer"),
  sig("awareness", "aware.last-bias-type", "count", "Last bias type"),
  sig("awareness", "aware.last-bandaid", "count", "Last bandaid structural"),
  sig("awareness", "aware.last-error-type", "count", "Last error type"),
  sig("awareness", "aware.last-heal-level", "count", "Last self-heal level"),
  sig("awareness", "aware.uptime-ms", "ms", "Run uptime"),
  sig("awareness", "aware.heap-used-mb", "MB", "Current heap used"),
  sig("awareness", "aware.rss-mb", "MB", "Current RSS"),
  sig("awareness", "aware.event-loop-lag", "ms", "Event loop lag"),
  sig("awareness", "aware.cpu-percent", "percent", "CPU usage"),
  sig("awareness", "aware.disk-read-mb", "MB", "Disk read MB"),
  sig("awareness", "aware.disk-write-mb", "MB", "Disk write MB"),
  // performance (33)
  sig("performance", "perf.cpu-percent", "percent", "CPU percent (process)"),
  sig("performance", "perf.heap-used-mb", "MB", "Heap used (V8)"),
  sig("performance", "perf.heap-total-mb", "MB", "Heap total (V8)"),
  sig("performance", "perf.rss-mb", "MB", "Resident set size"),
  sig("performance", "perf.external-mb", "MB", "External memory"),
  sig("performance", "perf.arraybuffers-mb", "MB", "ArrayBuffer memory"),
  sig("performance", "perf.disk-read-mb", "MB", "Disk bytes read"),
  sig("performance", "perf.disk-write-mb", "MB", "Disk bytes written"),
  sig("performance", "perf.fs-read-count", "count", "FS read count"),
  sig("performance", "perf.fs-write-count", "count", "FS write count"),
  sig("performance", "perf.input-tokens", "tokens", "Input tokens"),
  sig("performance", "perf.output-tokens", "tokens", "Output tokens"),
  sig("performance", "perf.total-tokens", "tokens", "Total tokens"),
  sig("performance", "perf.tokens-per-second", "tokens/s", "Tokens per second"),
  sig("performance", "perf.latency-ms", "ms", "Request latency"),
  sig("performance", "perf.llm-duration-ms", "ms", "LLM call duration"),
  sig("performance", "perf.inject-duration-ms", "ms", "Injection duration"),
  sig("performance", "perf.edit-duration-ms", "ms", "Edit duration"),
  sig("performance", "perf.search-duration-ms", "ms", "Search duration"),
  sig("performance", "perf.quality-duration-ms", "ms", "Quality duration"),
  sig("performance", "perf.memory-duration-ms", "ms", "Memory op duration"),
  sig("performance", "perf.parse-duration-ms", "ms", "Response parse duration"),
  sig("performance", "perf.event-loop-lag-ms", "ms", "Event loop lag"),
  sig("performance", "perf.wall-ms", "ms", "Turn wall time"),
  sig("performance", "perf.suite-wall-ms", "ms", "Suite wall time"),
  sig("performance", "perf.input-chars", "chars", "Prompt chars"),
  sig("performance", "perf.output-chars", "chars", "Output chars"),
  sig("performance", "perf.compression-ratio", "ratio", "Tool-result compression ratio"),
  sig("performance", "perf.overhead-percent", "percent", "Instrumentation overhead"),
  sig("performance", "perf.p50-latency", "ms", "p50 latency"),
  sig("performance", "perf.p95-latency", "ms", "p95 latency"),
  sig("performance", "perf.p99-latency", "ms", "p99 latency"),
  sig("performance", "perf.throughput", "tasks/s", "Task throughput"),
  // learning (10)
  sig("learning", "learn.error-recorded", "count", "Errors recorded for learning"),
  sig("learning", "learn.pattern-extracted", "count", "Patterns extracted from errors"),
  sig("learning", "learn.rule-strengthened", "count", "Existing rules strengthened"),
  sig("learning", "learn.rule-added", "count", "New prevention rules added"),
  sig("learning", "learn.retroactive-rerun", "count", "Retroactive checks rerun"),
  sig("learning", "learn.attempt-reused", "count", "Past attempts reused before retry"),
  sig("learning", "learn.feedback-loop", "count", "Feedback applied to next turn"),
  sig("learning", "learn.workflow-improved", "count", "Workflow self-improvements"),
  sig("learning", "learn.fingerprint-match", "count", "Attempt fingerprint matches"),
  sig("learning", "learn.stale-context", "count", "Stale context detected"),
  // error-handling (13)
  sig("error-handling", "err.rate-limit", "count", "429 rate-limit handled"),
  sig("error-handling", "err.server", "count", "5xx server errors handled"),
  sig("error-handling", "err.network", "count", "Network errors handled"),
  sig("error-handling", "err.auth", "count", "Auth errors handled"),
  sig("error-handling", "err.bad-request", "count", "Bad-request errors handled"),
  sig("error-handling", "err.model-not-found", "count", "Model-not-found handled"),
  sig("error-handling", "err.context-too-long", "count", "Context-too-long handled"),
  sig("error-handling", "err.invalid-response", "count", "Invalid-response handled"),
  sig("error-handling", "err.timeout", "count", "Timeout handled"),
  sig("error-handling", "err.empty-response", "count", "Empty-response handled"),
  sig("error-handling", "err.overloaded", "count", "Overloaded handled"),
  sig("error-handling", "err.translated", "count", "Errors translated for LLM"),
  sig("error-handling", "err.suppressed-leak", "count", "Raw errors suppressed from LLM"),
  // context (11)
  sig("context", "ctx.turns", "count", "Active context turns"),
  sig("context", "ctx.summaries", "count", "Context summaries"),
  sig("context", "ctx.tokens", "tokens", "Context token count"),
  sig("context", "ctx.limit", "tokens", "Context token limit"),
  sig("context", "ctx.trim-threshold", "tokens", "Trim threshold tokens"),
  sig("context", "ctx.over-threshold", "count", "Turns over threshold"),
  sig("context", "ctx.trim-events", "count", "Trim invocations"),
  sig("context", "ctx.pinned", "count", "Pinned turns"),
  sig("context", "ctx.retrieved", "count", "Retrieved turns"),
  sig("context", "ctx.replaced", "count", "replaceTurns calls"),
  sig("context", "ctx.cleared", "count", "clear() calls"),
  // safety (4)
  sig("safety", "safety.write-set-enforced", "count", "Write-set enforced"),
  sig("safety", "safety.path-boundary", "count", "Path boundary enforced"),
  sig("safety", "safety.preimage-verified", "count", "Preimage verified before write"),
  sig("safety", "safety.postwrite-verified", "count", "Post-write verified"),
]);

/** The single source of truth — the full signal catalog. */
export const SIGNAL_CATALOG: readonly SignalDef[] = C;

/** Total number of exposure signals (must equal 253). */
export const SIGNAL_TOTAL: number = SIGNAL_CATALOG.length;

/** Signal ids indexed for O(1) lookup. */
export const SIGNAL_IDS: Readonly<Set<string>> = new Set(SIGNAL_CATALOG.map((s) => s.id));

/** Group counts (for verification + the receipt). */
export const SIGNAL_COUNTS_BY_CATEGORY: Readonly<Record<SignalCategory, number>> = Object.freeze(
  ((): Record<SignalCategory, number> => {
    const acc = {} as Record<SignalCategory, number>;
    for (const s of SIGNAL_CATALOG) {
      acc[s.category] = (acc[s.category] ?? 0) + 1;
    }
    return acc;
  })(),
);

/** A mutable per-run signal accumulator. */
export class SignalTracker {
  private readonly counts = new Map<string, number>();
  private readonly seen = new Set<string>();

  /** Increment a signal by `delta` (default 1). No-op if the id is unknown. */
  observe(signalId: string, delta: number = 1): void {
    if (!SIGNAL_IDS.has(signalId)) return;
    this.seen.add(signalId);
    this.counts.set(signalId, (this.counts.get(signalId) ?? 0) + delta);
  }

  /** Record a one-shot measurement value (replaces rather than increments). */
  measure(signalId: string, value: number): void {
    if (!SIGNAL_IDS.has(signalId)) return;
    this.seen.add(signalId);
    this.counts.set(signalId, value);
  }

  get(signalId: string): number {
    return this.counts.get(signalId) ?? 0;
  }

  observedCount(): number {
    return this.seen.size;
  }

  unobservedIds(): readonly string[] {
    const missing: string[] = [];
    for (const s of SIGNAL_CATALOG) {
      if (!this.seen.has(s.id)) missing.push(s.id);
    }
    return missing;
  }

  snapshot(): readonly { signalId: string; value: number; unit: string }[] {
    const out: { signalId: string; value: number; unit: string }[] = [];
    for (const s of SIGNAL_CATALOG) {
      const value = this.counts.get(s.id) ?? 0;
      out.push({ signalId: s.id, value, unit: s.unit });
    }
    return out;
  }
}
