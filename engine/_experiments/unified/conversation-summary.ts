/**
 * Conversation summary — the continuity-preserving primitive for EXP435.
 *
 * The user directive: "about trim results; we need real conversation
 * continuity, this is a multi turn harness." EXP427 found C16
 * (evict-to-0%) is most token-efficient but has NO conversation continuity.
 * C09 (preserve continuity) is better for real conversations. EXP435 adds
 * a deterministic, hierarchical, token-capped conversation summary that
 * is ALWAYS in context so the LLM knows the conversation flow.
 *
 * DESIGN — hierarchical deterministic summary:
 *
 *   1. Record one (turn, topic) pair per turn. The topic is a short
 *      deterministic token extracted from the user message + assistant
 *      response (NOT LLM-based — pure extraction). Topics are ~3-6 chars
 *      (a keyword, a tool name, a fact tag, a probe label).
 *
 *   2. Build a hierarchical block capped at `tokenBudget` (default 200):
 *        Level 0 (recent):   last 10 turns, 1 line each.
 *        Level 1 (medium):   last 100 turns, every 10th turn.
 *        Level 2 (old):      last 1000 turns, every 100th turn.
 *        Level 3 (ancient):  all history, every 1000th turn.
 *      Total ~32 lines at 5000 turns → ~160 tokens (within 200 budget).
 *      The hierarchy gives the LLM the FULL conversation flow at
 *      decreasing resolution for older turns. At turn 5000, the LLM
 *      can see "T1000:refactor" and know we discussed the refactor at
 *      turn 1000 — without holding 5000 lines in context.
 *
 *   3. The block is rebuilt every turn (deterministic, no LLM call) and
 *      injected as a "summary" message kind (always in context, replaced
 *      each turn via `addSummary` in ContextManager).
 *
 * The summary NEVER replaces fact recall (memory store handles that).
 * It gives the LLM the FLOW — "we discussed X, then Y, then Z, now W" —
 * which is exactly what C16's evict-to-0% loses.
 */
import { tokenize } from "./tokenizer.ts";

/** One entry in the conversation summary (turn + topic). */
export interface SummaryEntry {
  readonly turn: number;
  readonly topic: string;
}

/**
 * Hierarchical conversation summary.
 *
 * The summary is a list of (turn, topic) pairs, one per turn. The block
 * is built hierarchically (recent turns at high resolution, old turns at
 * low resolution) and capped at a token budget.
 */
export class ConversationSummary {
  private readonly entries: SummaryEntry[] = [];
  private readonly tokenBudget: number;
  private mainTopic = "";
  /** Level sizes (turns per level). Level 0 = 1 line/turn, level 1 = 1 line/10 turns, etc. */
  private readonly levelSteps = [1, 10, 100, 1000];

  constructor(tokenBudget = 200) {
    this.tokenBudget = tokenBudget;
  }

  /**
   * Set the main topic of the conversation (e.g. "refactor assertion factory").
   * The main topic is ALWAYS in the summary block header so the LLM knows the
   * overall task even when the first turn is no longer in the hierarchical levels.
   */
  setMainTopic(topic: string): void {
    this.mainTopic = topic.slice(0, 40);
  }

  /**
   * Record a turn's topic. Called once per turn with a deterministic topic.
   * The topic should be a short keyword (3-12 chars) extracted from the
   * user message + assistant response. If the same turn is recorded twice,
   * the later recording wins (updates the topic).
   */
  recordTurn(turn: number, topic: string): void {
    const cleanTopic = topic.slice(0, 24).replace(/\s+/g, "_").toLowerCase();
    const existingIdx = this.entries.findIndex((e) => e.turn === turn);
    if (existingIdx >= 0) {
      (this.entries as Array<{ turn: number; topic: string }>)[existingIdx]!.topic = cleanTopic;
    } else {
      this.entries.push({ turn, topic: cleanTopic });
      this.entries.sort((a, b) => a.turn - b.turn);
    }
  }

  /** Number of recorded turns. */
  size(): number {
    return this.entries.length;
  }

  /**
   * Build the hierarchical summary block capped at `tokenBudget` tokens.
   * The block is a multi-line string:
   *   [CONVERSATION SUMMARY — T1..T5000 — 5000 turns]
   *   T4995:refactor T4990:list_files T4985:search_code ...
   *   (Level 0: last 10 turns)
   *   T4900:edit T4910:probe ...
   *   (Level 1: last 100 turns, every 10th)
   *   T4000:refactor T4100:list_functions ...
   *   (Level 2: last 1000 turns, every 100th)
   *   T1000:refactor T2000:edit ...
   *   (Level 3: all history, every 1000th)
   *
   * Lines are packed multiple-per-line to save tokens. The block is
   * truncated to fit the budget.
   */
  buildBlock(): string {
    if (this.entries.length === 0) return "";
    const maxTurn = this.entries[this.entries.length - 1]!.turn;
    const lines: string[] = [];
    const mainTopicStr = this.mainTopic ? ` — main: ${this.mainTopic}` : "";
    lines.push(`[CONVERSATION SUMMARY — T1..T${maxTurn} — ${this.entries.length} turns${mainTopicStr}]`);

    // Build hierarchical levels. Each level covers a range and samples
    // every `step` turns. Levels are concatenated RECENT-FIRST so the
    // most recent (highest resolution) is at the top (always included when
    // truncated). Ancient levels are at the bottom (truncated first).
    for (let level = 0; level < this.levelSteps.length; level++) {
      const step = this.levelSteps[level]!;
      // Level boundary: level 0 = last 10 turns, level 1 = last 100, etc.
      const levelRange = step * 10;
      const levelStart = Math.max(1, maxTurn - levelRange + 1);
      // For level 0, levelEnd = maxTurn. For level 1, levelEnd = maxTurn - 10 (don't overlap level 0).
      // For level 2, levelEnd = maxTurn - 100. For level 3, levelEnd = maxTurn - 1000.
      const actualEnd = level === 0 ? maxTurn : maxTurn - this.levelSteps[level - 1]! * 10;
      if (actualEnd < levelStart) continue;

      // Sample every `step` turns within [levelStart, actualEnd].
      const levelLines: string[] = [];
      // Align to step boundary so the sampling is deterministic.
      const firstTurn = Math.ceil(levelStart / step) * step;
      for (let t = firstTurn; t <= actualEnd; t += step) {
        const entry = this.entries.find((e) => e.turn === t);
        if (entry) levelLines.push(`T${entry.turn}:${entry.topic}`);
      }
      if (levelLines.length === 0) continue;
      // Pack multiple per line (8 entries per line) to save tokens.
      const packed: string[] = [];
      for (let i = 0; i < levelLines.length; i += 8) {
        packed.push(levelLines.slice(i, i + 8).join(" "));
      }
      const levelLabel = level === 0 ? "recent" : level === 1 ? "medium" : level === 2 ? "old" : "ancient";
      lines.push(`(${levelLabel}) ${packed.join(" | ")}`);
    }

    let block = lines.join("\n");
    // Truncate to token budget (4 chars/token estimate).
    const charBudget = this.tokenBudget * 4;
    if (block.length > charBudget) {
      block = block.slice(0, charBudget) + " ...";
    }
    return block;
  }

  /**
   * Get the topic for a specific turn (for continuity probe verification).
   * Returns undefined if the turn was not recorded.
   */
  topicForTurn(turn: number): string | undefined {
    return this.entries.find((e) => e.turn === turn)?.topic;
  }

  /**
   * Check if a turn is represented in the current summary block.
   * A turn is "represented" if it appears in one of the hierarchical levels.
   */
  isTurnInSummary(turn: number): boolean {
    const maxTurn = this.entries[this.entries.length - 1]?.turn ?? 0;
    if (maxTurn === 0) return false;
    for (let level = 0; level < this.levelSteps.length; level++) {
      const step = this.levelSteps[level]!;
      const levelRange = step * 10;
      const levelStart = Math.max(1, maxTurn - levelRange + 1);
      const actualEnd = level === 0 ? maxTurn : maxTurn - this.levelSteps[level - 1]! * 10;
      if (turn < levelStart || turn > actualEnd) continue;
      // Check if the turn aligns to the step boundary OR is in level 0.
      if (level === 0) return true; // level 0 has every turn.
      if (turn % step === 0) return true;
    }
    return false;
  }

  /**
   * Pick N continuity probe turns for a checkpoint. The turns are selected
   * from the hierarchical levels so they ARE represented in the summary
   * block at the checkpoint. This ensures the continuity probes are
   * answerable from the summary alone.
   *
   * Selection: distribute probes across levels (recent, medium, old, ancient).
   * Only picks turns that are BOTH recorded AND in the summary block at maxTurn.
   */
  pickContinuityProbeTurns(checkpoint: number, count: number): number[] {
    const maxTurn = checkpoint;
    const turns: number[] = [];
    const tryAdd = (t: number): boolean => {
      if (t < 1 || t >= maxTurn) return false;
      if (turns.includes(t)) return false;
      if (!this.topicForTurn(t)) return false;
      if (!this.isTurnInSummary(t)) return false;
      turns.push(t);
      return true;
    };
    // Level 0 (recent): last 10 turns — pick 3.
    for (let i = 1; i <= 3 && turns.length < count; i++) {
      tryAdd(maxTurn - i);
    }
    // Level 1 (medium): every 10th turn in last 100 — pick 3.
    for (let i = 1; i <= 3 && turns.length < count; i++) {
      tryAdd(maxTurn - i * 10);
    }
    // Level 2 (old): every 100th turn in last 1000 — pick 2.
    for (let i = 1; i <= 2 && turns.length < count; i++) {
      tryAdd(maxTurn - i * 100);
    }
    // Level 3 (ancient): every 1000th turn — pick 2.
    for (let i = 1; i <= 2 && turns.length < count; i++) {
      tryAdd(maxTurn - i * 1000);
    }
    return turns.slice(0, count);
  }
}

/**
 * Extract a deterministic short topic from a turn's user message + assistant
 * response. The topic is a keyword (3-24 chars) that captures the essence of
 * the turn. This is NOT LLM-based — pure deterministic extraction.
 *
 * Extraction rules (in priority order):
 *   1. If the user message contains "IMPORTANT NOTE for later": extract
 *      the first keyword from the note (after the colon).
 *   2. If the user message contains "Answer in plain text" (a probe):
 *      extract "probe" + the first keyword from the question.
 *   3. If the user message contains "Call {tool}" or "call {tool}":
 *      extract the tool name.
 *   4. If the user message mentions "refactor": extract "refactor".
 *   5. If the assistant response is a tool call JSON: extract the tool name.
 *   6. Otherwise: extract the first non-stopword from the user message.
 */
export function extractTopic(userMessage: string, assistantMessage: string = ""): string {
  const STOPWORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "can", "shall", "to", "of", "in",
    "on", "at", "by", "for", "with", "about", "against", "between", "into",
    "through", "during", "before", "after", "above", "below", "from", "up",
    "down", "out", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "any",
    "both", "each", "few", "more", "most", "other", "some", "such", "no",
    "nor", "not", "only", "own", "same", "so", "than", "too", "very", "s",
    "t", "just", "don", "now", "let", "us", "our", "we", "you", "your",
    "this", "that", "these", "those", "i", "me", "my", "myself", "what",
    "which", "who", "whom", "continue", "call", "next", "tool", "answer",
    "plain", "text", "question", "good", "progress", "now", "let", "look",
    "examine", "review", "check", "see", "get", "make", "go", "new", "task",
    "important", "note", "for", "later", "remember", "this",
  ]);

  // Rule 1: IMPORTANT NOTE for later — extract the first keyword from the note.
  const noteMatch = userMessage.match(/IMPORTANT NOTE for later:\s*(.+?)(?:Remember this|Continue|$)/i);
  if (noteMatch) {
    const noteContent = noteMatch[1]!.trim();
    const tokens = tokenize(noteContent);
    for (const t of tokens) {
      if (!STOPWORDS.has(t) && t.length >= 3) return t.slice(0, 24);
    }
  }

  // Rule 2: probe — extract "probe" + the first keyword from the question.
  const probeMatch = userMessage.match(/Answer in plain text.*Question:\s*(.+)/i);
  if (probeMatch) {
    const question = probeMatch[1]!.trim();
    const tokens = tokenize(question);
    for (const t of tokens) {
      if (!STOPWORDS.has(t) && t.length >= 3) return "probe_" + t.slice(0, 18);
    }
    return "probe";
  }

  // Rule 3: Call {tool} — extract the tool name (skip stopwords).
  const callMatch = userMessage.match(/\b(?:Call|call)\s+(\w+)/);
  if (callMatch && !STOPWORDS.has(callMatch[1]!.toLowerCase())) {
    return callMatch[1]!.slice(0, 24);
  }

  // Rule 4: refactor mention.
  if (/\brefactor\b/i.test(userMessage)) return "refactor";

  // Rule 5: assistant response is a tool call JSON — extract the tool name.
  if (assistantMessage) {
    const toolMatch = assistantMessage.match(/"tool"\s*:\s*"(\w+)"/);
    if (toolMatch) return toolMatch[1]!.slice(0, 24);
  }

  // Rule 6: first non-stopword from the user message.
  const tokens = tokenize(userMessage);
  for (const t of tokens) {
    if (!STOPWORDS.has(t) && t.length >= 3) return t.slice(0, 24);
  }
  return "turn";
}
