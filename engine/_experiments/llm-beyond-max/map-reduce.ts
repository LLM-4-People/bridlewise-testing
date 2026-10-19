/**
 * EXP410 — map-reduce.
 *
 * Map each sub-task to an LLM call (1 per item), reduce (combine) the
 * results. The reduce step is either deterministic (concatenation, default)
 * or LLM-based (when `llmReduce=true`).
 *
 * Use cases:
 *   - "Find all bugs in 100 files" → 100 map calls → deterministic reduce
 *     (concatenate the bug lists).
 *   - "Refactor 100 files" → 100 map calls → deterministic reduce
 *     (concatenate the per-file diffs).
 *   - "Summarize 100 documents" → 100 map calls → LLM reduce (one summary
 *     of summaries).
 *
 * Concurrency: bounded by `mapReduce.concurrency`. Each in-flight call
 * counts against the API rate limit; we deliberately keep it modest (4 by
 * default) to avoid 429s.
 */

import type { BeyondMaxConfig } from "./config.ts";
import type { ChatMessage, ChatResult, LlmClient } from "./client.ts";

export type MapReduceEvent =
  | Readonly<{ type: "map_start"; index: number; total: number }>
  | Readonly<{ type: "map_done"; index: number; tokens: number; elapsedMs: number; finish: string }>
  | Readonly<{ type: "reduce_start" }>
  | Readonly<{ type: "reduce_done"; tokens: number; elapsedMs: number }>
  | Readonly<{ type: "done"; totalTokens: number; totalMs: number; ok: number; failed: number }>;

export type MapReduceOutcome<T = string> = Readonly<{
  results: ReadonlyArray<readonly (T extends string ? string : T)[]>;
  mapped: readonly (string | null)[];
  reduced: string;
  totalTokens: number;
  elapsedMs: number;
  ok: number;
  failed: number;
}>;

export type MapItem = Readonly<{
  /** Unique id for the item (used in error reporting). */
  id: string;
  /** Prompt for this item. */
  prompt: string;
}>;

export type MapReduceOptions = Readonly<{
  system?: string;
  items: readonly MapItem[];
  /** Optional LLM-based reduce prompt. If omitted, deterministic concat. */
  reducePrompt?: string;
  /** Override configured concurrency. */
  concurrency?: number;
  signal?: AbortSignal;
  onEvent?: (e: MapReduceEvent) => void;
}>;

export async function runMapReduce(
  client: LlmClient,
  config: BeyondMaxConfig,
  opts: MapReduceOptions,
): Promise<MapReduceOutcome> {
  const t0 = Date.now();
  const concurrency = Math.max(1, opts.concurrency ?? config.mapReduce.concurrency);
  const items = opts.items;
  const results: (string | null)[] = new Array(items.length).fill(null);
  let totalTokens = 0;
  let ok = 0;
  let failed = 0;
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      if (opts.signal?.aborted) return;
      const i = cursor;
      cursor++;
      if (i >= items.length) return;
      const item = items[i];
      if (!item) return;
      opts.onEvent?.({ type: "map_start", index: i, total: items.length });
      const messages: ChatMessage[] = [];
      if (opts.system) messages.push({ role: "system", content: opts.system });
      messages.push({ role: "user", content: item.prompt });
      try {
        const r: ChatResult = await client.complete(messages, config.api.maxOutputTokens, opts.signal);
        totalTokens += r.completionTokens;
        results[i] = r.content;
        ok++;
        opts.onEvent?.({ type: "map_done", index: i, tokens: r.completionTokens, elapsedMs: r.elapsedMs, finish: r.finishReason });
      } catch (e) {
        failed++;
        results[i] = null;
        opts.onEvent?.({ type: "map_done", index: i, tokens: 0, elapsedMs: 0, finish: `error:${String(e).slice(0, 64)}` });
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);
  // Reduce.
  let reduced = "";
  if (opts.reducePrompt && config.mapReduce.llmReduce) {
    opts.onEvent?.({ type: "reduce_start" });
    const parts: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const r = results[i];
      parts.push(`## Item ${items[i]?.id ?? i}\n${r ?? "(failed)"}`);
    }
    const rMessages: ChatMessage[] = [];
    if (opts.system) rMessages.push({ role: "system", content: opts.system });
    rMessages.push({
      role: "user",
      content: `${opts.reducePrompt}\n\nInputs:\n${parts.join("\n\n")}`,
    });
    const r = await client.complete(rMessages, config.api.maxOutputTokens, opts.signal);
    totalTokens += r.completionTokens;
    reduced = r.content;
    opts.onEvent?.({ type: "reduce_done", tokens: r.completionTokens, elapsedMs: r.elapsedMs });
  } else {
    reduced = results.map((r, i) => `## Item ${items[i]?.id ?? i}\n${r ?? "(failed)"}`).join("\n\n");
  }
  const totalMs = Date.now() - t0;
  opts.onEvent?.({ type: "done", totalTokens, totalMs, ok, failed });
  return Object.freeze({
    results: Object.freeze([]) as unknown as ReadonlyArray<readonly never[]>,
    mapped: Object.freeze(results),
    reduced,
    totalTokens,
    elapsedMs: totalMs,
    ok,
    failed,
  });
}
