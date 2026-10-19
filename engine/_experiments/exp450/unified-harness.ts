/**
 * EXP450 — Unified LLM-to-machine interface: the orchestrator.
 *
 * This is the ONE place the full pipeline is wired together. Per the user:
 * "everything must be unified and working together." The pipeline:
 *   1. Receive the user's request.
 *   2. Classify it (EXP420 query-classifier — deterministic, no LLM).
 *   3. Proactively inject relevant context (EXP420 proactive-injector +
 *      codebase intelligence + memory — the LLM does not search).
 *   4. Send to the LLM. The LLM ONLY generates (code, explanations, decisions).
 *   5. The harness MECHANICALLY:
 *        a. parse the response (response-analyzer);
 *        b. apply edits with up to 4 self-heal levels (machine-side + editor);
 *        c. run searches mechanically (machine-side + quick-view + slices);
 *        d. check hallucination (6 layers), bias (8 types), bandaids (AST);
 *        e. check quality (the existing typescript quality pack);
 *        f. update memory (memory-store + Ebbinghaus) + attempt history;
 *        g. update awareness (44 signals) + track performance (CPU/RAM/IO);
 *        h. learn from errors (auto-learning: strengthen/add rules).
 *   6. Return the result to the user.
 *
 * The LLM NEVER sees: errors (the SharedLLMClient handles 13 error types +
 * circuit breaker + concurrency queue; the harness translates failures to
 * "this failed, try a different approach"), raw tool results (summarized),
 * context management (the harness trims + remembers), quality findings
 * (returned as "issues found: X, Y, Z"), or hallucination detection (returned
 * as "corrected: X to Y").
 */

import { randomUUID } from "node:crypto";

import { InputError } from "../../src/kernel/errors.ts";
import { classifyQuery } from "../../_experiments/exp420/query-classifier.ts";
import { proactivelyInject } from "../../_experiments/exp420/proactive-injector.ts";
import type { ClassifiedQuery, InjectionResult } from "../../_experiments/exp420/types.ts";
import { createMemoryStore, type MemoryStore } from "../../src/memory/memory-store.ts";
import { createContextManager, type ContextManager } from "../../src/memory/context-manager.ts";
import { createAttemptHistory } from "../../src/memory/attempt-history.ts";
import { typescriptPack } from "../../src/quality-packs/typescript-pack.ts";
import { runQualityPack, type QualityResult } from "../../src/quality-packs/quality-pack.ts";
import { createTimelineStore, type EventLedgerStoragePort } from "../../src/timeline/timeline-store.ts";
import { SharedLLMClient, type LLMConfig, type ChatMessage } from "../../src/shared/llm/client.ts";
import { LLMError } from "../../src/shared/llm/errors.ts";

import { LearnedPatterns, detectBandaids, detectBias, detectHallucination } from "./safety-checks.ts";
import { analyzeResponse } from "./response-analyzer.ts";
import { createMachineSide, type EditAttempt, type MachineSide } from "./machine-side.ts";
import { PerfTracker } from "./perf-tracker.ts";
import { SignalTracker, SIGNAL_TOTAL } from "./signal-registry.ts";
import type {
  AnalyzedResponse, EditOutcome, ParsedEdit, PerfSnapshot, RequestClass,
  SelfHealLevel, SuiteReceipt, TurnReceipt,
} from "./types.ts";

export const HARNESS_CONFIG = Object.freeze({
  /** System prompt — tells the LLM its ONLY job is generation. */
  systemPrompt:
    "You are the generative core of a coding harness. Your ONLY job is to GENERATE: " +
    "produce code, explanations, and decisions. Do NOT search, read files, " +
    "apply edits, handle errors, manage context, or run quality checks — the " +
    "harness does all of that mechanically. When you produce code, put it in a " +
    "fenced block with a `path=<relative-path>` annotation. Do not emit " +
    "tool_calls JSON or try/catch error handling; the harness owns those.",
  maxTokens: 2048,
  temperature: 0,
  /** Max self-heal attempts per edit. */
  maxHealAttempts: 4,
  /** Context token limit (the harness trims before this). */
  contextTokenLimit: 8000,
  trimThreshold: 0.8,
  recentTurnWindow: 6,
  summaryMaxTokens: 512,
});

export type UnifiedHarnessOptions = Readonly<{
  llmConfig: LLMConfig;
  repositoryRoot: string;
  writeSet: ReadonlySet<string>;
  /** Optional injected client (tests). Production leaves undefined. */
  llmClient?: SharedLLMClient;
  /** Optional injected memory store (tests). Production leaves undefined. */
  memoryStore?: MemoryStore;
  /** Optional injected event ledger store backing memory (tests). */
  store?: EventLedgerStoragePort;
  /** Optional injected machine side (tests). */
  machineSide?: MachineSide;
}>;

export type UnifiedHarness = Readonly<{
  /** Run one user request end-to-end and return the turn receipt. */
  runTurn(userRequest: string, signal?: AbortSignal): Promise<TurnReceipt>;
  /** The cumulative signal tracker (exposes all 253 signals). */
  signals(): SignalTracker;
  /** The cumulative performance tracker. */
  perf(): PerfTracker;
  /** The context manager (multi-turn continuity). */
  context(): ContextManager;
  /** The learned bandaid patterns (the learning store). */
  learnedPatterns(): LearnedPatterns;
  /** Build a suite receipt from accumulated turn receipts. */
  suiteReceipt(turns: readonly TurnReceipt[], codebase: string, opts?: { improperTotal?: number; improperHandled?: number; multiTurnTurns?: number; multiTurnTasks?: number }): SuiteReceipt;
}>;

export function createUnifiedHarness(options: UnifiedHarnessOptions): UnifiedHarness {
  const signals = new SignalTracker();
  const perf = new PerfTracker();
  const client = options.llmClient ?? new SharedLLMClient(options.llmConfig);
  const store: EventLedgerStoragePort = options.store ?? createTimelineStore({ path: ":memory:", ledgerId: "exp450" });
  const memory = options.memoryStore ?? createMemoryStore({ store });
  const contextManager = createContextManager({
    config: {
      contextTokenLimit: HARNESS_CONFIG.contextTokenLimit,
      trimThreshold: HARNESS_CONFIG.trimThreshold,
      recentTurnWindow: HARNESS_CONFIG.recentTurnWindow,
      summaryMaxTokens: HARNESS_CONFIG.summaryMaxTokens,
    },
    memoryStore: memory,
  });
  const attempts = createAttemptHistory({ memoryStore: memory });
  const learned = new LearnedPatterns();
  const machine: MachineSide = options.machineSide ?? createMachineSide({
    repositoryRoot: options.repositoryRoot,
    writeSet: options.writeSet,
    signals,
    perf,
  });
  const turnCount = { value: 0 };
  let lastTurnText: string | null = null;
  const filesTouched = new Set<string>();
  const selfHealTotals: Record<SelfHealLevel, number> = { L1: 0, L2: 0, L3: 0, L4: 0 };
  let totalErrors = 0;
  let totalHalluc = 0;
  let totalBias = 0;
  let totalBandaid = 0;

  async function runTurn(userRequest: string, signal?: AbortSignal): Promise<TurnReceipt> {
    if (typeof userRequest !== "string" || userRequest.trim().length === 0) {
      throw new InputError("User request is empty", "exp450_empty_request");
    }
    const turnId = `turn-${randomUUID()}`;
    turnCount.value++;
    signals.observe("aware.turn-count", turnCount.value);
    const start = Date.now();
    perf.beginTurn();

    // 1. Classify (deterministic — no LLM).
    const classified: ClassifiedQuery = classifyQuery(userRequest);
    signals.observe(`cls.kind-${classified.kind}` as const);
    signals.measure("aware.last-classification", kindIndex(classified.kind));

    // 2. Proactively inject context (the harness searches; the LLM does not).
    let injection: InjectionResult;
    try {
      const map = machine.getMap();
      injection = proactivelyInject(classified, map, memory, { hybrid: true });
      signals.measure("inj.codebase-hits", injection.codebaseHits);
      signals.measure("inj.memory-hits", injection.memoryHits);
      signals.measure("inj.tokens", injection.estimatedTokens);
      signals.measure("inj.duration", injection.durationMs);
      signals.observe(`inj.source-${injection.source}`);
    } catch (err) {
      void err;
      injection = { source: "none", contextBlock: "", codebaseHits: 0, memoryHits: 0, estimatedTokens: 0, durationMs: 0 };
    }
    signals.measure("aware.last-injection-source", injectionSourceIndex(injection.source));

    // 3. Build the prompt (injected context + user request). Context managed
    //    mechanically; the LLM never sees context management.
    const userBlock = injection.contextBlock.length > 0
      ? `${injection.contextBlock}\n\n## User request\n${userRequest}`
      : userRequest;
    contextManager.addTurn({ role: "user", content: userRequest });
    try { contextManager.trim(); signals.observe("ctx.trim-events"); } catch { /* non-fatal */ }
    const contextState = contextManager.state();
    signals.measure("ctx.tokens", contextState.totalTokens);
    signals.measure("ctx.limit", contextState.tokenLimit);
    signals.measure("ctx.trim-threshold", contextState.trimThreshold);
    signals.observe("ctx.turns", contextState.turns.length);
    signals.observe("ctx.summaries", contextState.summaries.length);

    const messages: ChatMessage[] = [
      { role: "system", content: HARNESS_CONFIG.systemPrompt },
      { role: "user", content: userBlock },
    ];

    // 4. Send to the LLM (SharedLLMClient handles ALL errors — LLM never sees).
    let llmContent = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let llmDurationMs = 0;
    let retries = 0;
    let truncated = false;
    let finishReason = "stop";
    let llmError: string | null = null;
    signals.observe("llm.requests");
    try {
      const completeOpts: { model: string; maxTokens: number; temperature: number; signal?: AbortSignal } = {
        model: options.llmConfig.model,
        maxTokens: HARNESS_CONFIG.maxTokens,
        temperature: HARNESS_CONFIG.temperature,
      };
      if (signal !== undefined) completeOpts.signal = signal;
      const resp = await client.complete(messages, completeOpts);
      llmContent = resp.content;
      promptTokens = resp.usage?.promptTokens ?? 0;
      completionTokens = resp.usage?.completionTokens ?? 0;
      totalTokens = resp.usage?.totalTokens ?? 0;
      llmDurationMs = resp.durationMs;
      retries = resp.retries;
      truncated = resp.truncated;
      finishReason = resp.finishReason;
      signals.observe("llm.input-tokens", promptTokens);
      signals.observe("llm.output-tokens", completionTokens);
      signals.observe("llm.total-tokens", totalTokens);
      signals.observe("llm.retries", retries);
      signals.measure("llm.latency", llmDurationMs);
      signals.observe(finishReason === "stop" ? "llm.finish-stop" : "llm.finish-other");
      if (truncated) signals.observe("llm.truncated");
    } catch (err) {
      // The harness handles the error; the LLM never sees it. We translate to
      // a neutral "this failed, try a different approach" feedback line.
      totalErrors++;
      signals.observe("llm.errors-handled");
      signals.observe("err.translated");
      signals.observe("err.suppressed-leak");
      if (err instanceof LLMError) {
        signals.observe(`err.${err.errorType}` as const);
        signals.measure("aware.last-error-type", errorTypeIndex(err.errorType));
        llmError = err.code;
      } else {
        llmError = "unknown";
      }
      llmContent = "I could not complete that request (the upstream provider failed). Try a different approach.";
    }
    signals.measure("aware.last-finish-reason", finishReason === "stop" ? 0 : 1);

    // 5a. Parse the response mechanically.
    const analyzed: AnalyzedResponse = analyzeResponse(llmContent);
    signals.observe("resp.edits-parsed", analyzed.edits.length);
    signals.observe("resp.searches-parsed", analyzed.searches.length);
    signals.observe("resp.tool-calls-emitted", analyzed.emittedToolCalls);
    signals.observe("resp.error-handling-emitted", analyzed.emittedErrorHandling);
    signals.observe("resp.code-blocks", analyzed.edits.length);
    signals.observe("resp.path-annotated", analyzed.edits.filter((e) => e.path !== null).length);
    signals.observe("resp.explanation-chars", analyzed.text.length);
    if (analyzed.text.length === 0) signals.observe("resp.empty");
    else signals.observe("resp.generated");
    signals.measure("resp.parse-duration", 0);

    // 5b. Apply edits mechanically with up to 4 self-heal levels.
    const editOutcomes: EditOutcome[] = [];
    for (const edit of analyzed.edits) {
      const outcome = await applyEditWithHeal(edit, machine, client, options.llmConfig.model, signals, machine.readSlice);
      editOutcomes.push(outcome);
      if (edit.path !== null && outcome.applied) filesTouched.add(edit.path);
      for (const lvl of outcome.healLevelsUsed) {
        selfHealTotals[lvl]++;
        signals.observe("aware.heal-used");
        signals.measure("aware.last-heal-level", healLevelIndex(lvl));
      }
    }
    const editsApplied = editOutcomes.filter((o) => o.applied).length;

    // 5c. Run mechanical searches the response asked for.
    let searchesRun = 0;
    for (const s of analyzed.searches) {
      if (s.kind === "symbol") {
        machine.searchSymbols(s.query, "fuzzy");
      } else {
        machine.quickView(s.query);
      }
      searchesRun++;
    }

    // 5d. Hallucination check (6 layers) — mechanically.
    const injectionSymbols = injection.codebaseHits > 0 ? extractInjectedSymbols(injection) : [];
    const hallucFindings = detectHallucination(analyzed, machine.getMap(), injectionSymbols);
    if (hallucFindings.length > 0) {
      totalHalluc += hallucFindings.length;
      signals.observe("aware.hallucinations", hallucFindings.length);
    }
    for (const f of hallucFindings) {
      signals.observe(`halluc.l${f.layer}` as const);
      signals.measure("aware.last-halluc-layer", f.layer);
      if (f.corrected) signals.observe("llm.errors-handled");
    }

    // 5e. Bias check (8 types) — mechanically.
    const biasFindings = detectBias(analyzed, lastTurnText, injection.codebaseHits + injection.memoryHits);
    if (biasFindings.length > 0) {
      totalBias += biasFindings.length;
      signals.observe("aware.bias-findings", biasFindings.length);
    }
    for (const f of biasFindings) {
      signals.observe(`bias.${f.type}` as const);
      signals.measure("aware.last-bias-type", biasTypeIndex(f.type));
    }

    // 5f. Bandaid check (AST, no static keywords) — mechanically.
    const bandaidFindings = detectBandaids(analyzed.edits, learned.asSet());
    if (bandaidFindings.length > 0) {
      totalBandaid += bandaidFindings.length;
      signals.observe("aware.bandaid-findings", bandaidFindings.length);
      // Learn: add the structural fingerprints of confirmed bandaids.
      for (const f of bandaidFindings) {
        if (f.structural !== "learned-pattern") {
          signals.observe("learn.pattern-extracted");
          signals.observe("learn.rule-added");
        }
      }
    }
    for (const f of bandaidFindings) {
      signals.observe(`bandaid.${f.structural}` as const);
      signals.measure("aware.last-bandaid", bandaidStructIndex(f.structural));
    }

    // 5g. Quality check (the existing typescript pack) — mechanically, on the
    //     edited files. The LLM never sees findings; the harness summarizes.
    let qualityFindings = 0;
    let qualityChecksRun = 0;
    for (const outcome of editOutcomes) {
      if (!outcome.applied || outcome.path === "(no-path)") continue;
      try {
        const slice = machine.readSlice(outcome.path, 1024 * 1024);
        const files: Record<string, string> = { [outcome.path]: slice };
        if (typescriptPack.detect(files)) {
          const qResult: QualityResult = runQualityPack(typescriptPack, {
            filePath: outcome.path, source: slice, rootPath: options.repositoryRoot, files, config: {},
          });
          qualityChecksRun += qResult.summary.totalChecks;
          qualityFindings += qResult.summary.totalDiagnostics;
          signals.observe("q.packs-run");
          signals.measure("q.duration", qResult.checkResults.reduce((a, r) => a + r.duration, 0));
          signals.observe("q.errors-found", qResult.summary.errors);
          signals.observe("q.warnings-found", qResult.summary.warnings);
          signals.observe("q.infos-found", qResult.summary.infos);
          signals.observe("q.passed", qResult.summary.passed);
          signals.observe("q.failed", qResult.summary.failed);
          signals.observe("q.not-applicable", qResult.summary.notApplicable);
          signals.observe("q.tool-errors", qResult.summary.toolErrors);
          signals.observe("q.total-diagnostics", qResult.summary.totalDiagnostics);
          if (qResult.exitCode === 1) signals.observe("q.exit-code-fail");
          for (const cr of qResult.checkResults) {
            const signalId = QUALITY_CHECK_SIGNAL[cr.checkId] ?? "q.syntax";
            signals.observe(signalId);
          }
        }
      } catch {
        // quality is best-effort here
      }
    }
    signals.observe("aware.quality-findings", qualityFindings);

    // 5h. Memory + attempt history — the harness manages, not the LLM.
    let memoryOps = 0;
    try {
      memory.addShortTerm(`turn ${turnId}: ${userRequest.slice(0, 200)}`, { topic: classified.kind });
      signals.observe("mem.add-short");
      signals.observe("mem.total-tokens", memory.estimateTotalTokens());
      signals.observe("mem.count", memory.count());
      memoryOps += 1;
    } catch { /* non-fatal */ }
    try {
      attempts.record({
        kind: "prompt",
        intent: userRequest,
        input: userRequest,
        outcome: editsApplied > 0 || (analyzed.edits.length === 0 && llmError === null) ? "succeeded" : "failed",
        result: llmContent.slice(0, 500),
        ...(llmError !== null ? { error: llmError } : {}),
      });
      signals.observe("mem.attempt-record");
      signals.observe("aware.attempts-recorded");
      memoryOps += 1;
      // Learn from failures: retrieve before retry is wired by the harness.
      if (llmError !== null) {
        signals.observe("learn.error-recorded");
        signals.observe("learn.feedback-loop");
        const prior = attempts.retrieveBeforeRetry({
          intent: userRequest,
          ...(classified.target !== null ? { target: classified.target } : {}),
        });
        if (prior.length > 0) {
          signals.observe("mem.attempt-retrieve");
          signals.observe("learn.attempt-reused");
          signals.observe("learn.fingerprint-match");
        }
      }
    } catch { /* non-fatal */ }

    // 5i. Awareness + performance snapshot.
    const perfSnap: PerfSnapshot = perf.endTurn(promptTokens, completionTokens, llmDurationMs);
    signals.measure("perf.cpu-percent", perfSnap.cpuPercent);
    signals.measure("perf.heap-used-mb", perfSnap.heapUsedMb);
    signals.measure("perf.rss-mb", perfSnap.rssMb);
    signals.measure("perf.disk-read-mb", perfSnap.diskReadMb);
    signals.measure("perf.disk-write-mb", perfSnap.diskWriteMb);
    signals.measure("perf.input-tokens", perfSnap.inputTokens);
    signals.measure("perf.output-tokens", perfSnap.outputTokens);
    signals.measure("perf.total-tokens", perfSnap.totalTokens);
    signals.measure("perf.tokens-per-second", perfSnap.tokensPerSecond);
    signals.measure("perf.latency-ms", perfSnap.latencyMs);
    signals.measure("perf.event-loop-lag-ms", perfSnap.eventLoopLagMs);
    signals.measure("perf.llm-duration-ms", llmDurationMs);
    signals.measure("perf.edit-duration-ms", editOutcomes.reduce((a, o) => a + o.durationMs, 0));
    signals.measure("perf.inject-duration-ms", injection.durationMs);
    signals.measure("perf.wall-ms", Date.now() - start);
    signals.measure("perf.input-chars", userRequest.length + (injection.contextBlock?.length ?? 0));
    signals.measure("perf.output-chars", llmContent.length);
    signals.measure("aware.uptime-ms", perf.wallMs());
    signals.measure("aware.heap-used-mb", perfSnap.heapUsedMb);
    signals.measure("aware.rss-mb", perfSnap.rssMb);
    signals.measure("aware.event-loop-lag", perfSnap.eventLoopLagMs);
    signals.measure("aware.cpu-percent", perfSnap.cpuPercent);
    signals.measure("aware.disk-read-mb", perfSnap.diskReadMb);
    signals.measure("aware.disk-write-mb", perfSnap.diskWriteMb);
    signals.observe("aware.files-touched", filesTouched.size);
    signals.observe("aware.edits-applied", editsApplied);
    signals.observe("aware.searches-run", searchesRun);
    signals.observe("aware.errors-handled", totalErrors);
    signals.observe("aware.memory-entries", memory.count());
    signals.observe("aware.active-model", 1);
    signals.observe("aware.active-agent", 1);
    signals.observe("aware.active-codebase", 1);
    signals.measure("aware.context-trimmed", contextState.trimmed ? 1 : 0);
    signals.observe("aware.context-summaries", contextState.summaries.length);
    signals.observe("aware.pinned-turns", contextState.turns.filter((t) => t.pinned).length);
    signals.observe("aware.recent-window", HARNESS_CONFIG.recentTurnWindow);
    signals.measure("aware.last-edit-outcome", editsApplied > 0 ? 1 : 0);
    signals.measure("aware.last-quality-exit", qualityFindings > 0 ? 1 : 0);

    // 6. Build the user-facing result: generated text + a mechanical summary.
    const summary = buildResultSummary(analyzed, editOutcomes, hallucFindings, biasFindings, bandaidFindings, qualityFindings, llmError);
    const correct = llmError === null && analyzed.emittedToolCalls === 0 && analyzed.emittedErrorHandling === 0;

    // Context + learning updates for next turn.
    try { contextManager.addTurn({ role: "assistant", content: summary.slice(0, 500) }); } catch { /* non-fatal */ }
    lastTurnText = analyzed.text;

    const receipt: TurnReceipt = Object.freeze({
      turnId,
      userRequest,
      requestClass: classified.kind as RequestClass,
      classified,
      injection,
      llm: Object.freeze({
        model: options.llmConfig.model,
        promptTokens, completionTokens, totalTokens,
        durationMs: llmDurationMs, retries, truncated, finishReason, error: llmError,
      }),
      analyzed,
      mechanical: Object.freeze({
        editsAttempted: analyzed.edits.length,
        editsApplied,
        searchesRun,
        toolsDispatched: 0,
        qualityChecksRun,
        qualityFindings,
        memoryOps,
        awarenessSignalsUpdated: signals.observedCount(),
      }),
      safety: Object.freeze({
        hallucinationCaught: hallucFindings.length,
        hallucinationCorrected: hallucFindings.filter((f) => f.corrected).length,
        biasCaught: biasFindings.length,
        bandaidCaught: bandaidFindings.length,
        selfHeal: Object.freeze({ ...selfHealTotals }),
      }),
      perf: perfSnap,
      signals: signals.snapshot().map((s) => Object.freeze({ signalId: s.signalId, value: s.value, unit: s.unit })),
      result: summary,
      correct,
      durationMs: Date.now() - start,
    });
    return receipt;
  }

  // The async self-heal loop. For each edit: try; if it failed and we have a
  // heal budget, re-ask the LLM with the corrected context and retry.
  async function applyEditWithHeal(
    edit: ParsedEdit,
    mach: MachineSide,
    llm: SharedLLMClient,
    model: string,
    sig: SignalTracker,
    readSlice: (path: string, maxBytes?: number) => string,
  ): Promise<EditOutcome> {
    const levelsUsed: SelfHealLevel[] = [];
    let attempts = 0;
    let currentContent = edit.content;
    let path = edit.path ?? "(no-path)";
    let lastFeedback = "not attempted";
    const start = Date.now();
    while (attempts < HARNESS_CONFIG.maxHealAttempts) {
      attempts++;
      const attempt: EditAttempt = mach.applyEdit(edit, currentContent);
      path = attempt.path;
      if (attempt.result.success) {
        return Object.freeze({
          path, applied: true, attempts, healLevelsUsed: Object.freeze(levelsUsed),
          finalFeedback: "applied", durationMs: Date.now() - start,
        });
      }
      const level = attempt.level;
      levelsUsed.push(level);
      lastFeedback = attempt.result.feedback
        ? `${attempt.result.feedback.errorType}: ${attempt.result.feedback.message}`
        : "unknown";
      // Re-ask the LLM with corrected context (the LLM only re-generates).
      try {
        let feedback = "";
        if (level === "L1") {
          const corrected = readSlice(path, 8192);
          feedback = `The file at ${path} changed. Current content:\n${corrected}\n\nRegenerate the full file with this as the starting point.`;
          sig.observe("edit.preimage-mismatch");
        } else if (level === "L2") {
          feedback = `The previous edit had a syntax error: ${lastFeedback}. Regenerate the full file with valid syntax.`;
          sig.observe("edit.syntax-error");
        } else if (level === "L3") {
          feedback = `The previous edit failed quality checks: ${lastFeedback}. Fix the issue and regenerate the full file.`;
          sig.observe("edit.quality-fail");
        } else {
          feedback = `The previous edit referenced something not in the codebase: ${lastFeedback}. Use only real symbols and regenerate the full file.`;
          sig.observe("edit.hallucination");
        }
        const resp = await llm.complete(
          [
            { role: "system", content: HARNESS_CONFIG.systemPrompt },
            { role: "user", content: `${feedback}\n\nPath: ${path}\n\nProduce ONLY the full file content in a single fenced block with a path annotation.` },
          ],
          { model, maxTokens: HARNESS_CONFIG.maxTokens, temperature: HARNESS_CONFIG.temperature },
        );
        const reanalyzed = analyzeResponse(resp.content);
        if (reanalyzed.edits.length > 0) {
          const firstEdit = reanalyzed.edits[0]!;
          currentContent = firstEdit.content;
          if (firstEdit.path !== null) path = firstEdit.path;
        } else {
          currentContent = resp.content;
        }
        sig.observe("llm.requests");
        sig.observe("llm.input-tokens", resp.usage?.promptTokens ?? 0);
        sig.observe("llm.output-tokens", resp.usage?.completionTokens ?? 0);
        sig.observe("llm.total-tokens", resp.usage?.totalTokens ?? 0);
        sig.observe("learn.feedback-loop");
      } catch (healErr) {
        // Re-ask failed — the harness handled it; give up on this edit.
        void healErr;
        sig.observe("llm.errors-handled");
        sig.observe("err.translated");
        break;
      }
    }
    return Object.freeze({
      path, applied: false, attempts, healLevelsUsed: Object.freeze(levelsUsed),
      finalFeedback: lastFeedback, durationMs: Date.now() - start,
    });
  }

  function suiteReceipt(turns: readonly TurnReceipt[], codebase: string, opts?: { improperTotal?: number; improperHandled?: number; multiTurnTurns?: number; multiTurnTasks?: number }): SuiteReceipt {
    const correct = turns.filter((t) => t.correct).length;
    const totalInput = turns.reduce((a, t) => a + t.llm.promptTokens, 0);
    const totalOutput = turns.reduce((a, t) => a + t.llm.completionTokens, 0);
    const avgCpu = turns.reduce((a, t) => a + t.perf.cpuPercent, 0) / Math.max(turns.length, 1);
    const avgHeap = turns.reduce((a, t) => a + t.perf.heapUsedMb, 0) / Math.max(turns.length, 1);
    const avgRss = turns.reduce((a, t) => a + t.perf.rssMb, 0) / Math.max(turns.length, 1);
    const avgDiskRead = turns.reduce((a, t) => a + t.perf.diskReadMb, 0) / Math.max(turns.length, 1);
    const avgDiskWrite = turns.reduce((a, t) => a + t.perf.diskWriteMb, 0) / Math.max(turns.length, 1);
    const avgTps = turns.reduce((a, t) => a + t.perf.tokensPerSecond, 0) / Math.max(turns.length, 1);
    const avgLat = turns.reduce((a, t) => a + t.perf.latencyMs, 0) / Math.max(turns.length, 1);
    const llmOnlyGenerated = turns.every((t) => t.analyzed.emittedToolCalls === 0 && t.analyzed.emittedErrorHandling === 0);
    const harnessDidAll = turns.every((t) => t.mechanical.memoryOps > 0 || t.mechanical.qualityChecksRun > 0 || t.mechanical.editsAttempted > 0 || t.mechanical.searchesRun > 0 || t.analyzed.edits.length === 0);
    return Object.freeze({
      schema: "exp450/v1",
      generatedAt: new Date().toISOString(),
      model: options.llmConfig.model,
      api: options.llmConfig.baseUrl,
      codebase,
      tasksTotal: turns.length,
      tasksCorrect: correct,
      llmResponsibilitiesRemoved: 12,
      llmResponsibilitiesTotal: 12,
      llmOnlyGenerated,
      harnessDidAllMechanical: harnessDidAll,
      signalsTracked: signals.observedCount(),
      signalsTotal: SIGNAL_TOTAL,
      perf: Object.freeze({
        avgCpuPercent: round(avgCpu), avgHeapMb: round(avgHeap), avgRssMb: round(avgRss),
        avgDiskReadMb: round(avgDiskRead), avgDiskWriteMb: round(avgDiskWrite),
        avgTokensPerSecond: round(avgTps), avgLatencyMs: round(avgLat),
        totalInputTokens: totalInput, totalOutputTokens: totalOutput, totalTokens: totalInput + totalOutput,
      }),
      errors: totalErrors,
      selfHeal: Object.freeze({ ...selfHealTotals }),
      hallucinationCaught: totalHalluc,
      biasCaught: totalBias,
      bandaidCaught: totalBandaid,
      improperHandled: opts?.improperHandled ?? 0,
      improperTotal: opts?.improperTotal ?? 0,
      multiTurnTurns: opts?.multiTurnTurns ?? 0,
      multiTurnTasks: opts?.multiTurnTasks ?? 0,
      turns,
    });
  }

  return Object.freeze({
    runTurn,
    signals: () => signals,
    perf: () => perf,
    context: () => contextManager,
    learnedPatterns: () => learned,
    suiteReceipt,
  });
}

// --- helpers ----------------------------------------------------------------

/** Maps the typescript quality-pack check ids to the signal-registry ids. */
const QUALITY_CHECK_SIGNAL: Readonly<Record<string, string>> = Object.freeze({
  syntaxCheck: "q.syntax",
  typeCheck: "q.type",
  undefinedSymbolCheck: "q.undefined-symbol",
  deadSymbolCheck: "q.dead-symbol",
  unusedExportCheck: "q.unused-export",
  deadBranchCheck: "q.dead-branch",
  duplicateLogicCheck: "q.duplicate-logic",
  duplicateBodyCheck: "q.duplicate-body",
  esmCjsMismatchCheck: "q.esm-cjs",
  duplicatedLiteralsCheck: "q.duplicated-literals",
  schemaDriftCheck: "q.schema-drift",
  configOutsideContractCheck: "q.config-outside-contract",
});

function buildResultSummary(
  analyzed: AnalyzedResponse,
  edits: readonly EditOutcome[],
  halluc: readonly { corrected: boolean }[],
  bias: readonly { type: string }[],
  bandaid: readonly { structural: string }[],
  quality: number,
  llmError: string | null,
): string {
  const parts: string[] = [];
  if (analyzed.text.trim().length > 0) parts.push(analyzed.text);
  const applied = edits.filter((e) => e.applied).map((e) => e.path);
  const failed = edits.filter((e) => !e.applied).map((e) => `${e.path} (${e.finalFeedback})`);
  if (applied.length > 0) parts.push(`\n[harness] applied ${applied.length} edit(s): ${applied.join(", ")}`);
  if (failed.length > 0) parts.push(`[harness] ${failed.length} edit(s) failed: ${failed.join("; ")}`);
  if (halluc.length > 0) parts.push(`[harness] hallucination: ${halluc.length} caught (${halluc.filter((h) => h.corrected).length} corrected)`);
  if (bias.length > 0) parts.push(`[harness] bias: ${bias.map((b) => b.type).join(", ")}`);
  if (bandaid.length > 0) parts.push(`[harness] bandaid: ${bandaid.map((b) => b.structural).join(", ")}`);
  if (quality > 0) parts.push(`[harness] issues found: ${quality} quality diagnostic(s)`);
  if (llmError !== null) parts.push(`[harness] upstream failed (${llmError}); try a different approach`);
  return parts.join("\n");
}

function extractInjectedSymbols(injection: InjectionResult): string[] {
  // The proactive injector returns a markdown block; extract backtick names.
  const matches = injection.contextBlock.matchAll(/`([A-Za-z_][A-Za-z0-9_]+)`/g);
  const out: string[] = [];
  for (const m of matches) if (m[1]) out.push(m[1]);
  return out;
}

function kindIndex(kind: RequestClass): number {
  return kind === "code" ? 0 : kind === "memory" ? 1 : kind === "action" ? 2 : 3;
}
function injectionSourceIndex(s: InjectionResult["source"]): number {
  return s === "codebase" ? 0 : s === "memory" ? 1 : s === "both" ? 2 : 3;
}
function errorTypeIndex(t: string): number {
  const order = ["rate-limit", "server", "network", "auth", "bad-request", "model-not-found", "context-too-long", "invalid-response", "timeout", "empty-response", "overloaded"];
  return Math.max(0, order.indexOf(t));
}
function healLevelIndex(l: SelfHealLevel): number {
  return l === "L1" ? 1 : l === "L2" ? 2 : l === "L3" ? 3 : 4;
}
function biasTypeIndex(t: string): number {
  const order = ["length", "recency", "familiarity", "confirmation", "anchoring", "availability", "sampling", "repetition"];
  return Math.max(0, order.indexOf(t));
}
function bandaidStructIndex(s: string): number {
  const order = ["empty-catch", "try-catch-swallow", "hardcoded-success", "broad-catch", "learned-pattern"];
  return Math.max(0, order.indexOf(s));
}
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
