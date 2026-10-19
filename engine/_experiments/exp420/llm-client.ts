/**
 * EXP420 — LLM client + efficiency analyzer.
 *
 * The efficiency analyzer compares three trial modes:
 *   - `without`: send query + a `search_code` tool spec. The LLM may either
 *     answer directly (1 call, 0 round trips) or call the tool, we simulate
 *     the search, then call the LLM again to answer (2 calls, 1 round trip).
 *   - `with`: run the proactive injector first, prepend the result, send
 *     the query WITHOUT the tool spec. The LLM answers directly (1 call,
 *     0 round trips). No tool option is given.
 *   - `hybrid`: same as `with` but only injects if the classifier confidence
 *     is above the threshold.
 *
 * Per AGENTS.md "everything dynamically computed": model, API URL, max
 * tokens, tool spec, and prompt templates are in `LLM_CONFIG`.
 */

import type { RepositoryMap, SymbolSearchResult } from "../../src/intelligence/intelligence-types.ts";
import { searchSymbols } from "../../src/intelligence/symbol-search.ts";
import type { MemoryStore } from "../../src/memory/memory-store.ts";
import type { InjectionResult, TrialMode, TrialResult, QueryKind } from "./types.ts";
import type { ClassifiedQuery } from "./types.ts";

export const LLM_CONFIG = Object.freeze({
  baseUrl: "https://api.example.invalid/v1",
  // From the environment ONLY (a literal key used to sit here as a fallback;
  // it was committed and pushed — rotate it). Unset reads as empty and the
  // provider refuses the request, loudly.
  apiKey: process.env.HARNESS_EXP420_KEY ?? "",
  model: "gemma-4-31b",
  maxToolRoundTrips: 1,
  noToolMaxTokens: 256,
  withToolMaxTokens: 256,
  answerMaxTokens: 256,
  requestTimeoutMs: 60_000,
  /** Max retries on 429 / 5xx. Generous — other processes share the API key. */
  maxRetries: 12,
  /** Initial backoff (ms) — doubles each retry. */
  initialBackoffMs: 800,
  /** Max backoff (ms). */
  maxBackoffMs: 20_000 as number,
  toolSpec: Object.freeze({
    type: "function" as const,
    function: Object.freeze({
      name: "search_code",
      description:
        "Search the codebase for symbols by name. Returns the symbol name, kind, file path, and line number.",
      parameters: Object.freeze({
        type: "object",
        properties: Object.freeze({
          query: Object.freeze({
            type: "string",
            description: "The symbol name or term to search for (e.g. 'makeAssertNode').",
          }),
        }),
        required: Object.freeze(["query"]),
      }),
    }),
  }),
});

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A minimal LLM client call. Returns the assistant message + tool_calls +
 * the usage from the API. Uses the OpenAI chat-completions format.
 *
 * Retries on HTTP 429 (rate limit) and 5xx errors with exponential backoff
 * (per `LLM_CONFIG.maxRetries` / `initialBackoffMs` / `maxBackoffMs`).
 */
export async function llmChat(params: Readonly<{
  messages: ReadonlyArray<Readonly<{ role: string; content: string | null; tool_calls?: readonly unknown[] }>>;
  tools?: readonly unknown[];
  maxTokens?: number;
  timeoutMs?: number;
}>): Promise<{
  content: string | null;
  toolCalls: ReadonlyArray<Readonly<{ id: string; function: Readonly<{ name: string; arguments: string }> }>>;
  finishReason: string;
  usage: Readonly<{ promptTokens: number; completionTokens: number; totalTokens: number }>;
  error: string | null;
}> {
  const body: Record<string, unknown> = {
    model: LLM_CONFIG.model,
    messages: params.messages,
    max_tokens: params.maxTokens ?? LLM_CONFIG.noToolMaxTokens,
    temperature: 0,
  };
  if (params.tools !== undefined && params.tools.length > 0) {
    body.tools = params.tools;
  }

  let backoff: number = LLM_CONFIG.initialBackoffMs;
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= LLM_CONFIG.maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutMs = params.timeoutMs ?? LLM_CONFIG.requestTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${LLM_CONFIG.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LLM_CONFIG.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        lastError = `http_${res.status}: ${text.slice(0, 200)}`;
        // Retry on 429 (rate limit) and 5xx.
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          if (attempt < LLM_CONFIG.maxRetries) {
            await sleep(Math.min(backoff, LLM_CONFIG.maxBackoffMs));
            backoff = Math.min(backoff * 2, LLM_CONFIG.maxBackoffMs);
            continue;
          }
        }
        return {
          content: null,
          toolCalls: [],
          finishReason: "api_error",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          error: lastError,
        };
      }
      const json = (await res.json()) as {
        choices?: ReadonlyArray<Readonly<{
          message: Readonly<{
            content: string | null;
            tool_calls?: ReadonlyArray<Readonly<{
              id: string;
              function: Readonly<{ name: string; arguments: string }>;
            }>>;
          }>;
          finish_reason: string;
        }>>;
        usage?: Readonly<{ prompt_tokens: number; completion_tokens: number; total_tokens: number }>;
      };
      const choice = json.choices?.[0];
      if (choice === undefined) {
        return {
          content: null,
          toolCalls: [],
          finishReason: "no_choice",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          error: "no_choice",
        };
      }
      return {
        content: choice.message.content,
        toolCalls: choice.message.tool_calls ?? [],
        finishReason: choice.finish_reason,
        usage: {
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
          totalTokens: json.usage?.total_tokens ?? 0,
        },
        error: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      if (attempt < LLM_CONFIG.maxRetries) {
        await sleep(Math.min(backoff, LLM_CONFIG.maxBackoffMs));
        backoff = Math.min(backoff * 2, LLM_CONFIG.maxBackoffMs);
        continue;
      }
      return {
        content: null,
        toolCalls: [],
        finishReason: "exception",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        error: msg,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // All retries exhausted.
  return {
    content: null,
    toolCalls: [],
    finishReason: "exhausted",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    error: lastError,
  };
}

/**
 * Simulate the search_code tool by running `searchSymbols` on the codebase.
 */
export function simulateSearchCode(
  map: RepositoryMap,
  toolArgs: string,
): { results: readonly SymbolSearchResult[]; summary: string } {
  let query: string;
  try {
    const parsed = JSON.parse(toolArgs) as { query?: string };
    query = typeof parsed.query === "string" ? parsed.query : toolArgs;
  } catch {
    query = toolArgs;
  }
  const results = searchSymbols(map, {
    name: query,
    kind: null,
    filePath: null,
    directory: null,
    exported: null,
    async: null,
    limit: 5,
    matchMode: "fuzzy",
  });
  const summary = results
    .map(
      (r) =>
        `- ${r.symbol.name} (${r.symbol.kind}, ${r.filePath}:${r.symbol.location.line}, exported:${r.symbol.exported})`,
    )
    .join("\n");
  return { results, summary };
}

/**
 * Run a single trial in a given mode. Returns the metrics (LLM calls,
 * round trips, tokens, time) and the LLM's answer text.
 */
export async function runTrial(params: Readonly<{
  mode: TrialMode;
  classified: ClassifiedQuery;
  expectedKind: QueryKind;
  expected: string;
  query: string;
  map: RepositoryMap;
  memory: MemoryStore;
  injection: InjectionResult;
  correctnessCheck: (answer: string, expected: string) => boolean;
}>): Promise<TrialResult> {
  const start = Date.now();
  let llmCalls = 0;
  let roundTrips = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let usedTool = false;
  let answer = "";
  let error: string | null = null;

  if (params.mode === "with" || params.mode === "hybrid") {
    // WITH injection: send the user's query + the injected context block.
    // No tool spec is provided — the LLM must answer directly.
    const systemPrompt =
      "You are a coding assistant. The user is asking a question. Below is " +
      "context that was proactively retrieved from the codebase/memory. " +
      "Use it to answer. If the context is insufficient, say so.";
    const userMsg =
      params.injection.contextBlock.length > 0
        ? `${params.injection.contextBlock}\n\n---\n\nUser question: ${params.query}`
        : `User question: ${params.query}`;
    const r = await llmChat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
      maxTokens: LLM_CONFIG.answerMaxTokens,
    });
    llmCalls++;
    promptTokens += r.usage.promptTokens;
    completionTokens += r.usage.completionTokens;
    if (r.error !== null) error = r.error;
    answer = r.content ?? "";
  } else {
    // WITHOUT injection: give the LLM the search_code tool. If it calls
    // the tool, simulate it and call the LLM again with the results.
    const systemPrompt =
      "You are a coding assistant. You can answer directly or use the " +
      "search_code tool to find symbols in the codebase. For code " +
      "questions, prefer using search_code.";
    const r1 = await llmChat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: params.query },
      ],
      tools: [LLM_CONFIG.toolSpec],
      maxTokens: LLM_CONFIG.withToolMaxTokens,
    });
    llmCalls++;
    promptTokens += r1.usage.promptTokens;
    completionTokens += r1.usage.completionTokens;
    if (r1.error !== null) error = r1.error;

    if (r1.toolCalls.length > 0 && llmCalls <= LLM_CONFIG.maxToolRoundTrips + 1) {
      usedTool = true;
      roundTrips++;
      const toolCall = r1.toolCalls[0];
      if (toolCall) {
        const { summary } = simulateSearchCode(params.map, toolCall.function.arguments);
        const messages: ReadonlyArray<Readonly<{ role: string; content: string | null; tool_calls?: readonly unknown[] }>> = [
          { role: "system", content: systemPrompt },
          { role: "user", content: params.query },
          {
            role: "assistant",
            content: r1.content,
            tool_calls: r1.toolCalls as readonly unknown[],
          },
          {
            role: "tool",
            content: summary,
          },
        ];
        const r2 = await llmChat({
          messages,
          maxTokens: LLM_CONFIG.answerMaxTokens,
        });
        llmCalls++;
        promptTokens += r2.usage.promptTokens;
        completionTokens += r2.usage.completionTokens;
        if (r2.error !== null) error = r2.error;
        answer = r2.content ?? "";
      } else {
        answer = r1.content ?? "";
      }
    } else {
      answer = r1.content ?? "";
    }
  }

  const durationMs = Date.now() - start;
  const correct = error === null && params.correctnessCheck(answer, params.expected);
  return Object.freeze({
    query: params.query,
    kind: params.classified.kind,
    expectedKind: params.expectedKind,
    classifierKind: params.classified.kind,
    classifierConfidence: params.classified.confidence,
    classifierTarget: params.classified.target,
    mode: params.mode,
    llmCalls,
    roundTrips,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    durationMs,
    injectedTokens: params.injection.estimatedTokens,
    correct,
    usedTool,
    answer: answer.slice(0, 500),
    expected: params.expected,
    error,
  });
}
