/**
 * EXP450 — Response analyzer: mechanically parse the LLM's generated response.
 *
 * The LLM's ONLY job is to GENERATE content. It emits markdown: explanations,
 * decisions, and fenced code blocks (the generated edit content). The
 * harness mechanically parses this into:
 *   - `edits`: fenced code blocks with optional `path=...` annotations.
 *   - `searches`: inline "search: X" intents the harness will run.
 *   - counters for forbidden LLM behaviors (explicit `tool_calls` JSON,
 *     explicit error-handling blocks) — these should be 0 because the harness
 *     owns those responsibilities.
 *
 * No LLM call is made here. Pure deterministic parsing.
 */

import type { AnalyzedResponse, ParsedEdit, ParsedSearch } from "./types.ts";

export const ANALYZER_CONFIG = Object.freeze({
  /** Regex for fenced code blocks with an optional path annotation. */
  fencePattern: /```([A-Za-z0-9]+)\s*(?:path=([^\s`]+))?\s*\n([\s\S]*?)```/g,
  /** Inline search intent: "search: foo" or "find symbol: foo". */
  searchPattern: /\b(?:search|find symbol|find text):\s*([^\n]+)/gi,
  /** Detect an explicit OpenAI-style tool_calls JSON block (forbidden). */
  toolCallPattern: /"tool_calls"\s*:\s*\[/i,
  /** Detect an explicit error-handling block the LLM should not emit. */
  errorHandlingPattern: /\b(?:catch\s*\(|try\s*\{|on(?:Error|Failure)\s*[=:(])/g,
});

/** Parse the generated response into structured edits + searches + counters. */
export function analyzeResponse(rawText: string): AnalyzedResponse {
  const edits: ParsedEdit[] = [];
  let match: RegExpExecArray | null;
  const fence = new RegExp(ANALYZER_CONFIG.fencePattern.source, ANALYZER_CONFIG.fencePattern.flags);
  let index = 0;
  while ((match = fence.exec(rawText)) !== null) {
    const language = match[1] ?? "";
    const path = match[2] ?? null;
    const content = match[3] ?? "";
    if (content.trim().length > 0) {
      edits.push(Object.freeze({ language, path: path === null ? null : path, content, index }));
      index++;
    }
  }
  const searches: ParsedSearch[] = [];
  const searchRe = new RegExp(ANALYZER_CONFIG.searchPattern.source, ANALYZER_CONFIG.searchPattern.flags);
  while ((match = searchRe.exec(rawText)) !== null) {
    const query = (match[1] ?? "").trim().replace(/[`*]/g, "");
    if (query.length > 0) {
      const kind: ParsedSearch["kind"] = /symbol/i.test(match[0] ?? "") ? "symbol" : "text";
      searches.push(Object.freeze({ query, kind }));
    }
  }
  const emittedToolCalls = (rawText.match(ANALYZER_CONFIG.toolCallPattern) ?? []).length;
  const emittedErrorHandling = (rawText.match(ANALYZER_CONFIG.errorHandlingPattern) ?? []).length;
  // The text the user sees is the response with fenced blocks summarized out
  // (the harness will show "applied: <path>" instead of dumping the code).
  const text = rawText;
  return Object.freeze({
    text,
    edits: Object.freeze(edits),
    searches: Object.freeze(searches),
    emittedToolCalls,
    emittedErrorHandling,
  });
}
