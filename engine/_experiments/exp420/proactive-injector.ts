/**
 * EXP420 — Proactive context injector.
 *
 * Given a classified query, runs the harness's memory + codebase intelligence
 * BEFORE the LLM call and returns a context block to prepend. Per the user
 * directive "Run this through memory/codebase intelligence and inject what we
 * have before sending the request to the llm."
 *
 * The injector reuses the harness's existing authorities:
 *   - `searchSymbols` from `src/intelligence/symbol-search.ts` (codebase).
 *   - `createMemoryStore.searchByText` from `src/memory/memory-store.ts` (memory).
 *
 * It does NOT call the LLM and does NOT add new authorities. It only formats
 * the existing search results as a markdown block that the LLM can use to
 * answer directly (skipping the tool-call round trip).
 *
 * Per AGENTS.md "everything dynamically computed": the topK, token budget,
 * and hybridThreshold all come from `INJECTOR_CONFIG` below.
 */

import type { RepositoryMap, SymbolSearchResult } from "../../src/intelligence/intelligence-types.ts";
import { searchSymbols } from "../../src/intelligence/symbol-search.ts";
import type { MemoryStore } from "../../src/memory/memory-store.ts";
import type { ClassifiedQuery, InjectionResult, QueryKind } from "./types.ts";

/**
 * CONFIG — single source of truth for the injector.
 */
export const INJECTOR_CONFIG = Object.freeze({
  /** Top-K results from each source. */
  codebaseTopK: 4,
  memoryTopK: 3,
  /** Soft token budget for the injected context block. */
  tokenBudget: 800,
  /** Hybrid-mode confidence threshold (below → no injection). */
  hybridThreshold: 0.55,
});

/**
 * Proactively inject context for the query.
 *
 * The harness calls this BEFORE the LLM. The LLM then receives the user's
 * query + the injected context block and can often answer directly without
 * calling the search_code tool (saves a round trip).
 */
export function proactivelyInject(
  classified: ClassifiedQuery,
  map: RepositoryMap,
  memory: MemoryStore,
  options?: Readonly<{ hybrid?: boolean; topK?: number }>,
): InjectionResult {
  const start = Date.now();
  const hybrid = options?.hybrid ?? false;
  const topK = options?.topK ?? INJECTOR_CONFIG.codebaseTopK;

  if (hybrid && classified.confidence < INJECTOR_CONFIG.hybridThreshold) {
    return emptyResult(start);
  }

  const codebaseHits = searchCodebase(classified, map, topK);
  const memoryHits = searchMemory(classified, memory, INJECTOR_CONFIG.memoryTopK);

  const codeLines: string[] = formatCodebaseHits(codebaseHits, classified.kind);
  const memLines: string[] = formatMemoryHits(memoryHits, classified.kind);

  const parts: string[] = [];
  if (codeLines.length > 0) {
    parts.push(["## Codebase context (proactively injected)", ...codeLines].join("\n"));
  }
  if (memLines.length > 0) {
    parts.push(["## Memory context (proactively injected)", ...memLines].join("\n"));
  }
  const contextBlock = parts.length > 0 ? parts.join("\n\n") : "";
  const estimatedTokens = Math.ceil(contextBlock.length / 4);

  let source: "codebase" | "memory" | "both" | "none" = "none";
  if (codebaseHits.length > 0 && memoryHits.length > 0) source = "both";
  else if (codebaseHits.length > 0) source = "codebase";
  else if (memoryHits.length > 0) source = "memory";

  return Object.freeze({
    source,
    contextBlock,
    codebaseHits: codebaseHits.length,
    memoryHits: memoryHits.length,
    estimatedTokens,
    durationMs: Date.now() - start,
  });
}

/**
 * Codebase search. For "code" and "action" queries we search the symbol
 * index by the classified target identifier. For "memory" queries we skip
 * codebase search (the LLM is asking about prior decisions, not code).
 */
function searchCodebase(
  classified: ClassifiedQuery,
  map: RepositoryMap,
  topK: number,
): readonly SymbolSearchResult[] {
  if (classified.kind === "memory" || classified.kind === "general") return [];
  if (classified.target === null) {
    // No identifier extracted — fall back to a fuzzy search on the whole query.
    const words = classified.searchQuery
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
      .slice(0, 2);
    if (words.length === 0) return [];
    const target = words.join(" ");
    return searchSymbols(map, {
      name: target, kind: null, filePath: null, directory: null,
      exported: null, async: null, limit: topK, matchMode: "fuzzy",
    });
  }
  // Try exact match first (highest precision), then fuzzy (recall).
  const exact = searchSymbols(map, {
    name: classified.target, kind: null, filePath: null, directory: null,
    exported: null, async: null, limit: topK, matchMode: "exact",
  });
  if (exact.length > 0) return exact;
  return searchSymbols(map, {
    name: classified.target, kind: null, filePath: null, directory: null,
    exported: null, async: null, limit: topK, matchMode: "fuzzy",
  });
}

/**
 * Memory search. For "memory" queries only — the user is asking about a
 * prior decision, not about code. Code/action queries don't need memory.
 *
 * If `target` is extracted and the kind is "memory", we use the target as
 * the search query too (the LLM may be asking "what did we decide about X").
 */
function searchMemory(
  classified: ClassifiedQuery,
  memory: MemoryStore,
  topK: number,
): readonly import("../../src/memory/memory-types.ts").MemorySearchResult[] {
  if (classified.kind !== "memory") return [];
  const q = classified.target !== null ? `${classified.target} ${classified.searchQuery}` : classified.searchQuery;
  return memory.searchByText(q, topK);
}

function formatCodebaseHits(hits: readonly SymbolSearchResult[], _kind: QueryKind): string[] {
  const lines: string[] = [];
  for (const hit of hits) {
    lines.push(
      `- **${hit.symbol.name}** (${hit.symbol.kind}, ${hit.filePath}:${hit.symbol.location.line}) — exported:${hit.symbol.exported} async:${hit.symbol.async} params:${hit.symbol.parameterCount} score:${hit.score.toFixed(2)}`,
    );
  }
  return lines;
}

function formatMemoryHits(
  hits: readonly import("../../src/memory/memory-types.ts").MemorySearchResult[],
  _kind: QueryKind,
): string[] {
  const lines: string[] = [];
  for (const hit of hits) {
    const content = hit.entry.content.length > 180 ? hit.entry.content.slice(0, 180) + "..." : hit.entry.content;
    lines.push(`- (tier:${hit.entry.tier}, score:${hit.score.toFixed(2)}) ${content}`);
  }
  return lines;
}

function emptyResult(start: number): InjectionResult {
  return Object.freeze({
    source: "none",
    contextBlock: "",
    codebaseHits: 0,
    memoryHits: 0,
    estimatedTokens: 0,
    durationMs: Date.now() - start,
  });
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "to", "of", "in", "on",
  "for", "with", "and", "or", "not", "this", "that", "these", "those",
  "what", "where", "when", "which", "how", "why", "who", "find", "show",
  "locate", "rename", "fix", "refactor", "extract", "inline", "delete",
  "remove", "move", "update", "change", "replace", "modify", "implement",
  "create", "generate", "write", "function", "method", "class",
  "component", "parameter", "param", "argument", "field", "file",
  "module", "definition", "implementation", "declaration", "import",
  "usage", "caller", "callee", "remember", "decided", "chose", "picked",
  "selected", "discussed", "mentioned", "previously", "before", "earlier",
  "please", "do", "does", "did", "doing", "have", "has", "had",
]);
