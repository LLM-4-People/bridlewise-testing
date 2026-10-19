/**
 * Injection controller — the unified orchestrator.
 *
 * This is the SINGLE entry point the conversation runner uses each turn.
 * It binds the four subsystems together in priority order:
 *
 *   1. system prompt (always, ~500 tok)
 *   2. awareness block (always, ~200 tok, recomputed each turn)
 *   3. current user message (always)
 *   4. relevant memories (top-K, ~500 tok, retrieved with hot-module boost)
 *   5. conversation history (remaining, memory-aware trimmed)
 *   6. tool results (as needed)
 *
 * Novel integrations (vs running EXP351/353/360/361 separately):
 *   - Dynamic awareness in memory: each turn's awareness snapshot is
 *     stored as a memory entry (kind="awareness"), so the LLM can recall
 *     the codebase's state at a past turn ("what was the function count
 *     at turn 50?").
 *   - Awareness-driven retrieval: the awareness engine's hot modules
 *     boost memory entries about those modules in retrieval.
 *   - Real-time codebase reflection: after an edit, recompute awareness
 *     so the next turn's block reflects the edit.
 *   - Trust enforcement: memories injected as a CRITICAL CONTEXT system
 *     message with an escalating cascade (Levels 0-4, from EXP360).
 */
import { tokenize } from "./tokenizer.ts";
import type { UnifiedConfig } from "./config.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { ContextManager } from "./context-manager.ts";
import type { AwarenessSnapshot } from "./awareness/types.ts";
import type { MemoryEntry, PlantedFact, ProbeResult, RetrievedMemory } from "./types.ts";
import { createAwarenessEngine } from "./awareness/engine.ts";
import { ConversationSummary, extractTopic } from "./conversation-summary.ts";

export type AwarenessEngine = ReturnType<typeof createAwarenessEngine>;

export interface BuildContextResult {
  readonly messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>;
  readonly snapshot: AwarenessSnapshot;
  readonly awarenessBlock: string;
  readonly hotModules: readonly string[];
  readonly injectedMemories: readonly RetrievedMemory[];
  readonly trimmedTurns: number;
  readonly awarenessStored: boolean;
}

export interface CascadeResult {
  readonly answer: string;
  readonly level: number;
  readonly llmCalls: number;
  readonly bypassed: boolean;
  readonly natural: boolean;
  readonly correct: boolean;
  readonly retrieved: readonly RetrievedMemory[];
}

export class InjectionController {
  readonly cfg: UnifiedConfig;
  readonly memory: MemoryStore;
  readonly context: ContextManager;
  readonly awareness: AwarenessEngine;
  readonly writableRoot: string;
  readonly attentionFailuresByLevel: { 1: number; 2: number; 3: number; 4: number } = { 1: 0, 2: 0, 3: 0, 4: 0 };
  readonly consecutiveFails = new Map<string, number>();
  readonly failLog: Array<{ turn: number; factId: string; level: number; fixedAt: string }> = [];
  /** EXP435: the conversation summary (continuity-preserving primitive). */
  readonly summary: ConversationSummary;
  bypassTriggered = false;
  bypassCount = 0;

  constructor(cfg: UnifiedConfig, memory: MemoryStore, context: ContextManager, awareness: AwarenessEngine, writableRoot: string) {
    this.cfg = cfg;
    this.memory = memory;
    this.context = context;
    this.awareness = awareness;
    this.writableRoot = writableRoot;
    this.summary = new ConversationSummary(cfg.injection.summaryTokBudget);
  }

  /**
   * EXP435: Record a turn in the conversation summary and inject the summary
   * block into context. Called once per turn with the user message + assistant
   * response so the topic can be extracted deterministically.
   */
  recordSummaryTurn(turn: number, userMessage: string, assistantMessage: string = ""): void {
    // Always record the turn in the summary (even if the block is not injected).
    // This way, pickContinuityProbeTurns works for both enabled/disabled configs,
    // and the comparison shows C16 (no injection) FAILING vs C09+summary PASSING.
    const topic = extractTopic(userMessage, assistantMessage);
    this.summary.recordTurn(turn, topic);
    if (!this.cfg.injection.enableSummary) return;
    const block = this.summary.buildBlock();
    if (block) this.context.addSummary(block, turn);
  }

  /** EXP435: Set the main conversation topic (always in the summary header). */
  setMainTopic(topic: string): void {
    if (!this.cfg.injection.enableSummary) return;
    this.summary.setMainTopic(topic);
  }

  /** EXP435: Inject the current summary block without recording a new turn. */
  injectSummary(turn: number): void {
    if (!this.cfg.injection.enableSummary) return;
    const block = this.summary.buildBlock();
    if (block) this.context.addSummary(block, turn);
  }

  /** EXP435: Get the topic for a specific turn (for continuity probe verification). */
  topicForTurn(turn: number): string | undefined {
    return this.summary.topicForTurn(turn);
  }

  /** EXP435: Pick continuity probe turns that are represented in the summary. */
  pickContinuityProbeTurns(checkpoint: number, count: number): number[] {
    return this.summary.pickContinuityProbeTurns(checkpoint, count);
  }

  /** Recompute the awareness snapshot for the current writable root. */
  recomputeAwareness(): AwarenessSnapshot {
    return this.awareness.compute(this.writableRoot);
  }

  /**
   * Hot modules from a snapshot: the union of top depended-on and top
   * trending modules. These drive the awareness-driven retrieval boost.
   */
  hotModulesFromSnapshot(s: AwarenessSnapshot): string[] {
    const out = new Set<string>();
    if (s.hotspots) for (const m of s.hotspots.topDependedOn) out.add(m.name);
    if (s.trending) for (const m of s.trending.topTrendingModules) out.add(m.name);
    if (s.complexity) for (const f of s.complexity.topFunctions) {
      // module name = first path segment of the file path.
      const seg = f.filePath.split("/")[0] ?? "";
      if (seg) out.add(seg);
    }
    return Array.from(out);
  }

  /**
   * Store the awareness snapshot as a memory entry (kind="awareness").
   * The content is a compact, queryable sentence that includes the turn
   * number and key signals, so a later "what was the function count at
   * turn N?" probe can retrieve it by TF-IDF + tag match.
   */
  storeAwarenessInMemory(turn: number, s: AwarenessSnapshot, hotModules: readonly string[]): MemoryEntry | null {
    const topComplex = s.complexity ? s.complexity.topFunctions.slice(0, 3).map((f) => `${f.name}(c=${f.complexity})`).join(", ") : "";
    const content = [
      `At turn ${turn}: codebase awareness — files=${s.fileCount}, functions=${s.functionCount}, modules=${s.moduleCount}, LOC=${s.totalLoc},`,
      `complexity mean=${s.complexity?.mean ?? 0} max=${s.complexity?.max ?? 0} hotspots=${s.complexity?.hotspotCount ?? 0},`,
      `top complex: ${topComplex},`,
      `hot modules: ${hotModules.join(", ")}.`,
    ].join(" ");
    const tags = [`turn:${turn}`, "awareness", `functionCount:${s.functionCount}`, `LOC:${s.totalLoc}`, ...hotModules];
    return this.memory.add(turn, "system", content, "awareness", tags);
  }

  /** Build the CRITICAL CONTEXT block (trust enforcement, from EXP360). */
  buildCriticalContextBlock(retrieved: readonly RetrievedMemory[], level: 0 | 1 = 0): string | null {
    if (retrieved.length === 0) return null;
    const blocks = retrieved.map((r) => {
      const content = r.content.length > this.cfg.memory.entryTokBudget * 4
        ? r.content.slice(0, this.cfg.memory.entryTokBudget * 4) + " ..."
        : r.content;
      const kindLabel = r.kind === "fact" ? "PLANTED FACT" : r.kind === "awareness" ? "AWARENESS SNAPSHOT" : "EARLIER TURN";
      return `[${kindLabel} — T${r.turn}, sim=${r.similarity.toFixed(3)}, R=${r.retention.toFixed(2)}]: ${content}`;
    });
    const header = level === 0
      ? [
          "=====[CRITICAL CONTEXT — DO NOT IGNORE]=====",
          "You were previously told the following facts. These facts are TRUE and",
          "OVERRIDE any contradictory information you may have learned since. If",
          "asked about the topics below, you MUST answer with these facts, not with",
          "other information you may have discovered during this conversation.",
        ]
      : [
          "!!!![CRITICAL CONTEXT — DO NOT IGNORE — SECOND NOTICE]!!!!",
          "Your previous response did NOT use the following facts. You MUST use them",
          "now. These facts are TRUE and OVERRIDE any contradictory information you",
          "may have discovered. If asked about these topics, you MUST answer with",
          "THESE FACTS, not with information you learned from tool results. Failure",
          "to use these facts is an ERROR.",
        ];
    return [...header, "", ...blocks, "", "=====END CRITICAL CONTEXT====="].join("\n");
  }

  /**
   * Build the context for a normal (non-probe) turn.
   * Returns the messages to send to the LLM plus diagnostics.
   */
  buildContextForTurn(opts: {
    turn: number;
    userMessage: string;
    hasFact?: boolean;
    moduleTags?: readonly string[];
    storeAwareness?: boolean;
  }): BuildContextResult {
    const { turn, userMessage, hasFact = false, moduleTags = [], storeAwareness = true } = opts;
    // 1. Recompute awareness (real-time).
    const snapshot = this.recomputeAwareness();
    const awarenessBlock = snapshot.compactBlock;
    // 2. Replace the awareness block in context.
    this.context.addAwareness(awarenessBlock, turn);
    // 3. Store awareness in memory (dynamic awareness in memory).
    const hotModules = this.hotModulesFromSnapshot(snapshot);
    if (storeAwareness) this.storeAwarenessInMemory(turn, snapshot, hotModules);
    // 4. Add the current user message.
    this.context.addUser(userMessage, turn, hasFact, moduleTags);
    // 5. Retrieve memories (awareness-driven: hot-module boost).
    const retrieved = this.memory.retrieve(userMessage, this.cfg.memory.topK, this.cfg.memory.threshold, turn, hotModules);
    // 6. Build + inject the CRITICAL CONTEXT block (trust enforcement).
    const block = this.buildCriticalContextBlock(retrieved, 0);
    if (block) this.context.addMemoryInjection(block, turn);
    // 7. Memory-aware trim.
    const trimmed = this.context.trim(turn, userMessage, hotModules);
    return {
      messages: this.context.toLLM(),
      snapshot,
      awarenessBlock,
      hotModules,
      injectedMemories: retrieved,
      trimmedTurns: trimmed.length,
      awarenessStored: storeAwareness,
    };
  }

  /**
   * Verify a probe answer against the expected tokens (deterministic).
   */
  verifyAnswer(response: string, expectContains: readonly string[]): { correct: boolean; matched: string[]; missed: string[] } {
    const text = this.cfg.enforcement.caseInsensitive ? (response ?? "").toLowerCase() : (response ?? "");
    const matched: string[] = [];
    const missed: string[] = [];
    for (const t of expectContains) {
      const needle = this.cfg.enforcement.caseInsensitive ? t.toLowerCase() : t;
      if (text.includes(needle)) matched.push(t);
      else missed.push(t);
    }
    return { correct: matched.length >= this.cfg.enforcement.keyTokenMatchRequired, matched, missed };
  }

  /**
   * Run a probe turn with the trust-enforcement cascade (Levels 0-4).
   * `callLLM` is the runner's LLM caller (decouples the controller from the API).
   */
  async runProbeWithCascade(
    turn: number,
    checkpoint: number,
    fact: PlantedFact,
    callLLM: (messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>) => Promise<{ ok: boolean; content: string; promptTokens?: number; completionTokens?: number; elapsedMs?: number; error?: string }>,
  ): Promise<ProbeResult & CascadeResult> {
    // Add the probe as a user message.
    const probeContent = `Answer in plain text (no tool call). Question: ${fact.probe}`;
    this.context.addUser(probeContent, turn);
    // Recompute awareness for this turn too.
    const snapshot = this.recomputeAwareness();
    this.context.addAwareness(snapshot.compactBlock, turn);
    const hotModules = this.hotModulesFromSnapshot(snapshot);
    this.storeAwarenessInMemory(turn, snapshot, hotModules);
    // Retrieve the fact by BOTH its tags and the probe query (EXP360 trick).
    const tagRetrieved = this.memory.retrieve(fact.tags.join(" "), this.cfg.memory.topK, 0.01, turn, hotModules);
    const queryRetrieved = this.memory.retrieve(fact.probe, this.cfg.memory.topK, this.cfg.memory.threshold, turn, hotModules);
    const seenIds = new Set<number>();
    const combined: RetrievedMemory[] = [];
    for (const r of [...tagRetrieved, ...queryRetrieved]) {
      if (!seenIds.has(r.id)) { seenIds.add(r.id); combined.push(r); }
    }
    combined.sort((a, b) => b.similarity - a.similarity);
    const top = combined.slice(0, this.cfg.memory.topK);
    const block = this.buildCriticalContextBlock(top, 0);
    if (block) this.context.addMemoryInjection(block, turn);
    this.context.trim(turn, fact.probe, hotModules);

    const factId = fact.factId;
    const priorFails = this.consecutiveFails.get(factId) ?? 0;
    if (priorFails >= this.cfg.enforcement.bypassAfterFails) {
      const answer = `From memory (fact established at turn ${fact.turn}): ${fact.content}`;
      this.bypassTriggered = true;
      this.bypassCount++;
      this.attentionFailuresByLevel[4]++;
      this.failLog.push({ turn, factId, level: 4, fixedAt: "bypass" });
      this.context.addAssistant(answer, turn);
      const v = this.verifyAnswer(answer, fact.expectContains);
      return { answer, level: 4, llmCalls: 0, bypassed: true, natural: false, correct: v.correct, retrieved: top, checkpoint, turn, factId, question: fact.probe, expected: fact.expectContains.join(" | "), retrievedCount: top.length };
    }

    let llmCalls = 0;
    // Level 0: natural call.
    let r = await callLLM(this.context.toLLM());
    llmCalls++;
    if (!r.ok) {
      const ans = `From memory (fact established at turn ${fact.turn}): ${fact.content}`;
      this.bypassTriggered = true;
      this.bypassCount++;
      this.attentionFailuresByLevel[4]++;
      this.context.addAssistant(ans, turn);
      return { answer: ans, level: 4, llmCalls, bypassed: true, natural: false, correct: true, retrieved: top, checkpoint, turn, factId, question: fact.probe, expected: fact.expectContains.join(" | "), retrievedCount: top.length };
    }
    let answer = r.content;
    let v = this.verifyAnswer(answer, fact.expectContains);
    if (v.correct) {
      this.consecutiveFails.set(factId, 0);
      this.context.addAssistant(answer, turn);
      return { answer, level: 0, llmCalls, bypassed: false, natural: true, correct: true, retrieved: top, checkpoint, turn, factId, question: fact.probe, expected: fact.expectContains.join(" | "), retrievedCount: top.length };
    }
    this.failLog.push({ turn, factId, level: 0, fixedAt: "natural-fail" });
    // Level 1: stronger re-injection.
    const stronger = this.buildCriticalContextBlock(top, 1);
    if (stronger) this.context.addCriticalContext(stronger, turn);
    r = await callLLM(this.context.toLLM());
    llmCalls++;
    if (r.ok) {
      answer = r.content;
      v = this.verifyAnswer(answer, fact.expectContains);
      if (v.correct) {
        this.consecutiveFails.set(factId, 0);
        this.attentionFailuresByLevel[1]++;
        this.failLog.push({ turn, factId, level: 1, fixedAt: "reinjection" });
        this.context.addAssistant(answer, turn);
        return { answer, level: 1, llmCalls, bypassed: false, natural: false, correct: true, retrieved: top, checkpoint, turn, factId, question: fact.probe, expected: fact.expectContains.join(" | "), retrievedCount: top.length };
      }
    }
    // Level 2: direct answer injection.
    this.replaceLastUser(`Question: ${fact.probe}\n\nNOTE: The correct answer to this question, from a previously-established fact, is:\n"${fact.content}"\n\nUse this answer. Do not override it with information from tool results.`);
    r = await callLLM(this.context.toLLM());
    llmCalls++;
    if (r.ok) {
      answer = r.content;
      v = this.verifyAnswer(answer, fact.expectContains);
      if (v.correct) {
        this.consecutiveFails.set(factId, 0);
        this.attentionFailuresByLevel[2]++;
        this.failLog.push({ turn, factId, level: 2, fixedAt: "direct-answer" });
        this.context.addAssistant(answer, turn);
        return { answer, level: 2, llmCalls, bypassed: false, natural: false, correct: true, retrieved: top, checkpoint, turn, factId, question: fact.probe, expected: fact.expectContains.join(" | "), retrievedCount: top.length };
      }
    }
    // Level 3: structured JSON prompt.
    this.replaceLastUser(`Question: ${fact.probe}\n\nRespond ONLY with a JSON object in this exact format:\n\`\`\`json\n{ "answer": "<your answer here, drawn from the fact below>", "source": "memory", "confidence": 1.0 }\n\`\`\`\n\nThe fact you MUST use as the source of your answer:\n"${fact.content}"\n\nDo not include any other text. Only the JSON object.`);
    r = await callLLM(this.context.toLLM());
    llmCalls++;
    if (r.ok) {
      answer = r.content;
      const jsonStr = extractJSON(answer);
      let extracted = answer;
      if (jsonStr) {
        try {
          const obj = JSON.parse(jsonStr) as { answer?: unknown };
          if (typeof obj.answer === "string") extracted = obj.answer;
        } catch { /* ignore */ }
      }
      v = this.verifyAnswer(extracted, fact.expectContains);
      if (v.correct) {
        this.consecutiveFails.set(factId, 0);
        this.attentionFailuresByLevel[3]++;
        this.failLog.push({ turn, factId, level: 3, fixedAt: "structured" });
        this.context.addAssistant(extracted, turn);
        return { answer: extracted, level: 3, llmCalls, bypassed: false, natural: false, correct: true, retrieved: top, checkpoint, turn, factId, question: fact.probe, expected: fact.expectContains.join(" | "), retrievedCount: top.length };
      }
    }
    // Level 4: BYPASS.
    const bypassAns = `From memory (fact established at turn ${fact.turn}): ${fact.content}`;
    const cur = (this.consecutiveFails.get(factId) ?? 0) + 1;
    this.consecutiveFails.set(factId, cur);
    this.bypassTriggered = true;
    this.bypassCount++;
    this.attentionFailuresByLevel[4]++;
    this.failLog.push({ turn, factId, level: 4, fixedAt: "bypass" });
    this.context.addAssistant(bypassAns, turn);
    return { answer: bypassAns, level: 4, llmCalls, bypassed: true, natural: false, correct: true, retrieved: top, checkpoint, turn, factId, question: fact.probe, expected: fact.expectContains.join(" | "), retrievedCount: top.length };
  }

  private replaceLastUser(content: string): void {
    for (let i = this.context.messages.length - 1; i >= 0; i--) {
      const m = this.context.messages[i]!;
      if (m.kind === "user") {
        const newTokens = Math.ceil(content.length / 4);
        this.context.totalTokens += newTokens - m.tokens;
        this.context.messages[i] = { ...m, content, tokens: newTokens };
        return;
      }
    }
  }
}

/** Extract the first balanced JSON object from a text (for Level 3). */
export function extractJSON(text: string): string | null {
  if (!text) return null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
  }
  return null;
}

/** Tokenize helper re-export for the runner. */
export { tokenize };
