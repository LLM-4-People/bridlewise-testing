/**
 * EXP410 — continuation prompting.
 *
 * When the LLM's output is truncated (finish_reason="length"), send a
 * continuation prompt that feeds the last N tokens back to the model so it
 * resumes exactly where it left off. Stitch the chunks together.
 *
 * Reliability mechanisms:
 *   1. finish_reason detection (only continue on "length", stop on "stop").
 *   2. no-progress abort (if a continuation returns empty, abort).
 *   3. repeat abort (if the same content is repeated across N rounds, abort).
 *   4. bounded continuation budget (maxContinuations).
 *   5. overlap detection (strip accidental repetition at the stitch seam).
 *   6. BOUNDED PROMPT: each round sends a FRESH message list (system + the
 *      original prompt + a tail of the accumulated output + the continue
 *      instruction). This keeps the prompt size constant regardless of how
 *      much has been generated. Without this, the prompt grows linearly
 *      with the accumulated output and overflows the model's context
 *      window at ~500 chunks (observed: HTTP 400 context_length_exceeded
 *      at chunk 31 / ~1M tokens when the full content was sent as the
 *      assistant message each round).
 */

import type { BeyondMaxConfig } from "./config.ts";
import { trailingContext, overlapLength, isRepeat } from "./tokens.ts";
import type { ChatMessage, ChatResult, LlmClient } from "./client.ts";

export type ContinuationEvent =
  | Readonly<{ type: "chunk"; index: number; content: string; finish: string; tokens: number; elapsedMs: number }>
  | Readonly<{ type: "stitch"; index: number; overlapChars: number }>
  | Readonly<{ type: "abort"; reason: string; chunkIndex: number }>
  | Readonly<{ type: "done"; totalChars: number; totalTokens: number; chunks: number; totalMs: number }>;

export type ContinuationOutcome = Readonly<{
  content: string;
  totalTokens: number;
  chunks: number;
  finishReasons: readonly string[];
  elapsedMs: number;
  abortReason?: string;
}>;

export type GenerateOptions = Readonly<{
  /** System prompt (optional). */
  system?: string;
  /** Initial user prompt. */
  prompt: string;
  /** Maximum total tokens to produce (budget guard). */
  maxTotalTokens: number;
  /** Override the per-call max output tokens. */
  perCallMaxTokens?: number;
  /** Signal for cancellation. */
  signal?: AbortSignal;
  /** Observer for streaming events. */
  onEvent?: (e: ContinuationEvent) => void;
  /**
   * Force continuation even when the model emits a non-"length" finish
   * reason (e.g. "stop"). Some models (notably gemma-4-31b) emit "stop"
   * naturally before hitting max_tokens — this option keeps the loop
   * going until `maxTotalTokens` is reached. The continuation prompt
   * explicitly tells the model "you have written N tokens, continue".
   */
  forceContinueUntilTarget?: boolean;
}>;

/**
 * Generate text via continuation prompting. Continues until the model emits
 * a non-"length" finish_reason, the budget is hit, or an abort condition
 * fires. Returns the stitched output and run statistics.
 *
 * The prompt is rebuilt fresh each round (system + original prompt + tail +
 * continue instruction) so the prompt size stays bounded regardless of
 * total output length. This is what makes 100k+ token generation viable
 * within a finite context window.
 */
export async function generateWithContinuation(
  client: LlmClient,
  config: BeyondMaxConfig,
  opts: GenerateOptions,
): Promise<ContinuationOutcome> {
  const policy = config.continuation;
  const perCall = opts.perCallMaxTokens ?? config.api.maxOutputTokens;
  let content = "";
  let totalTokens = 0;
  const finishReasons: string[] = [];
  let lastChunkContent = "";
  let repeatStreak = 0;
  const t0 = Date.now();
  for (let i = 0; i < policy.maxContinuations; i++) {
    if (opts.signal?.aborted) {
      const abort: ContinuationEvent = { type: "abort", reason: "cancelled", chunkIndex: i };
      opts.onEvent?.(abort);
      return freeze({
        content, totalTokens, chunks: i, finishReasons, elapsedMs: Date.now() - t0, abortReason: "cancelled",
      });
    }
    if (totalTokens >= opts.maxTotalTokens) {
      opts.onEvent?.({ type: "done", totalChars: content.length, totalTokens, chunks: i, totalMs: Date.now() - t0 });
      return freeze({ content, totalTokens, chunks: i, finishReasons, elapsedMs: Date.now() - t0 });
    }
    // Fresh, bounded message list each round. This keeps the prompt size
    // constant (system + prompt + tail + instruction) regardless of how
    // much has been generated — the design that makes 100k+ token output
    // viable within a finite context window.
    const messages = buildContinuationMessages(opts.system, opts.prompt, content, policy.trailingContextChars);
    const result: ChatResult = await client.complete(messages, perCall, opts.signal);
    finishReasons.push(result.finishReason);
    totalTokens += result.completionTokens;
    let chunk = result.content;
    if (chunk.length === 0) {
      if (policy.abortOnNoProgress) {
        opts.onEvent?.({ type: "abort", reason: "no_progress_empty_chunk", chunkIndex: i });
        return freeze({
          content, totalTokens, chunks: i, finishReasons, elapsedMs: Date.now() - t0, abortReason: "no_progress_empty_chunk",
        });
      }
      continue;
    }
    if (lastChunkContent.length > 0 && isRepeat(lastChunkContent, chunk)) {
      repeatStreak++;
      if (repeatStreak >= policy.repeatAbortWindow) {
        opts.onEvent?.({ type: "abort", reason: "repeat_loop", chunkIndex: i });
        return freeze({
          content, totalTokens, chunks: i, finishReasons, elapsedMs: Date.now() - t0, abortReason: "repeat_loop",
        });
      }
      // Skip the repeated content; do not append.
      continue;
    }
    repeatStreak = 0;
    // Stitch: detect accidental overlap (model repeating end of prev).
    let overlap = 0;
    if (content.length > 0) {
      overlap = overlapLength(content, chunk);
      if (overlap > 0) {
        chunk = chunk.slice(overlap);
      }
    }
    content += chunk;
    lastChunkContent = chunk;
    opts.onEvent?.({ type: "chunk", index: i, content: chunk, finish: result.finishReason, tokens: result.completionTokens, elapsedMs: result.elapsedMs });
    if (overlap > 0) {
      opts.onEvent?.({ type: "stitch", index: i, overlapChars: overlap });
    }
    if (result.finishReason !== "length") {
      // Model finished naturally. If `forceContinueUntilTarget` is set and
      // we haven't hit the target, keep going (gemma emits "stop" early).
      if (!opts.forceContinueUntilTarget || totalTokens >= opts.maxTotalTokens) {
        opts.onEvent?.({ type: "done", totalChars: content.length, totalTokens, chunks: i + 1, totalMs: Date.now() - t0 });
        return freeze({ content, totalTokens, chunks: i + 1, finishReasons, elapsedMs: Date.now() - t0 });
      }
      // Forced continuation: the chunk event was already emitted above;
      // fall through to the next iteration.
      continue;
    }
  }
  opts.onEvent?.({ type: "done", totalChars: content.length, totalTokens, chunks: policy.maxContinuations, totalMs: Date.now() - t0 });
  return freeze({ content, totalTokens, chunks: policy.maxContinuations, finishReasons, elapsedMs: Date.now() - t0 });
}

/**
 * Build a fresh, bounded message list for a continuation round. The prompt
 * contains the system message (if any), the original task, a tail of the
 * accumulated output, and the continue instruction. The size is constant
 * regardless of how much has been generated.
 */
function buildContinuationMessages(
  system: string | undefined,
  originalPrompt: string,
  accumulatedContent: string,
  trailingContextChars: number,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (system) messages.push({ role: "system", content: system });
  if (accumulatedContent.length === 0) {
    // First round: just the original prompt.
    messages.push({ role: "user", content: originalPrompt });
    return messages;
  }
  const tail = trailingContext(accumulatedContent, trailingContextChars);
  const soFarTokens = Math.round(accumulatedContent.length / 4);
  messages.push({
    role: "user",
    content: `${originalPrompt}\n\nYou have already written ~${soFarTokens} tokens. Continue EXACTLY from where you left off. Do NOT repeat any text already written. The last text was:\n"""\n${tail}\n"""\nContinue from that point. Produce the next chunk. Do not include any preamble or summary.`,
  });
  return messages;
}

function freeze<T extends object>(o: T): Readonly<T> {
  return Object.freeze(o) as Readonly<T>;
}
