/**
 * EXP410 — streaming with accumulation + auto-continuation.
 *
 * Stream the response as it arrives (delta events). When the stream ends
 * with finish_reason="length", immediately send a continuation request.
 * The accumulated output is the full output. This is the streaming form
 * of `continuation.ts`.
 *
 * The yield is a stream of deltas that the consumer can render live; the
 * final return value is the stitched result.
 *
 * BOUNDED PROMPT: each round sends a FRESH message list (system + the
 * original prompt + a tail of the accumulated output + the continue
 * instruction) so the prompt size stays constant regardless of total
 * output length. See continuation.ts for the rationale.
 */

import type { BeyondMaxConfig } from "./config.ts";
import { trailingContext, overlapLength } from "./tokens.ts";
import type { ChatMessage, LlmClient } from "./client.ts";

export type StreamAccumulatorEvent =
  | Readonly<{ type: "delta"; text: string; round: number }>
  | Readonly<{ type: "round_end"; round: number; finish: string; tokens: number }>
  | Readonly<{ type: "round_start"; round: number }>
  | Readonly<{ type: "done"; totalChars: number; totalTokens: number; rounds: number; totalMs: number }>;

export type StreamAccumulatorOutcome = Readonly<{
  content: string;
  totalTokens: number;
  rounds: number;
  elapsedMs: number;
}>;

export type StreamAccumulatorOptions = Readonly<{
  system?: string;
  prompt: string;
  maxTotalTokens: number;
  perCallMaxTokens?: number;
  signal?: AbortSignal;
  onEvent?: (e: StreamAccumulatorEvent) => void;
}>;

export async function* generateStreamingWithContinuation(
  client: LlmClient,
  config: BeyondMaxConfig,
  opts: StreamAccumulatorOptions,
): AsyncGenerator<StreamAccumulatorEvent, StreamAccumulatorOutcome, unknown> {
  const policy = config.continuation;
  const perCall = opts.perCallMaxTokens ?? config.api.maxOutputTokens;
  let content = "";
  let totalTokens = 0;
  const t0 = Date.now();
  for (let round = 0; round < policy.maxContinuations; round++) {
    if (opts.signal?.aborted) break;
    if (totalTokens >= opts.maxTotalTokens) break;
    // Fresh, bounded message list each round (see continuation.ts).
    const messages = buildStreamMessages(opts.system, opts.prompt, content, policy.trailingContextChars);
    yield emit({ type: "round_start", round });
    let roundContent = "";
    let finish = "stream_ended";
    let roundTokens = 0;
    for await (const ev of client.stream(messages, perCall, opts.signal)) {
      if (ev.type === "delta") {
        roundContent += ev.text;
        yield emit({ type: "delta", text: ev.text, round });
      } else if (ev.type === "finish") {
        finish = ev.reason;
      } else if (ev.type === "usage") {
        roundTokens = ev.completion;
      }
    }
    // We did not see a usage event in the stream — the API does not always
    // emit usage in streaming mode. Fall back to a conservative estimate.
    if (roundTokens === 0) roundTokens = Math.max(1, Math.round(roundContent.length / 4));
    totalTokens += roundTokens;
    let overlap = 0;
    if (content.length > 0 && roundContent.length > 0) {
      overlap = overlapLength(content, roundContent);
      if (overlap > 0) roundContent = roundContent.slice(overlap);
    }
    content += roundContent;
    yield emit({ type: "round_end", round, finish, tokens: roundTokens });
    if (finish !== "length") {
      const totalMs = Date.now() - t0;
      yield emit({ type: "done", totalChars: content.length, totalTokens, rounds: round + 1, totalMs });
      return Object.freeze({ content, totalTokens, rounds: round + 1, elapsedMs: totalMs });
    }
  }
  const totalMs = Date.now() - t0;
  yield emit({ type: "done", totalChars: content.length, totalTokens, rounds: policy.maxContinuations, totalMs });
  return Object.freeze({ content, totalTokens, rounds: policy.maxContinuations, elapsedMs: totalMs });

  function emit<T extends StreamAccumulatorEvent>(e: T): T {
    opts.onEvent?.(e);
    return e;
  }
}

/**
 * Build a fresh, bounded message list for a streaming continuation round.
 * Same rationale as continuation.ts: keeps the prompt size constant.
 */
function buildStreamMessages(
  system: string | undefined,
  originalPrompt: string,
  accumulatedContent: string,
  trailingContextChars: number,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (system) messages.push({ role: "system", content: system });
  if (accumulatedContent.length === 0) {
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

/**
 * Convenience wrapper: collect the stream into a single result without
 * rendering the deltas. Useful for batch testing.
 */
export async function collectStreamingWithContinuation(
  client: LlmClient,
  config: BeyondMaxConfig,
  opts: StreamAccumulatorOptions,
): Promise<StreamAccumulatorOutcome> {
  const gen = generateStreamingWithContinuation(client, config, opts);
  let result: StreamAccumulatorOutcome | undefined;
  while (true) {
    const next = await gen.next();
    if (next.value && typeof next.value === "object" && "type" in next.value) {
      opts.onEvent?.(next.value as StreamAccumulatorEvent);
    }
    if (next.done) {
      result = next.value as unknown as StreamAccumulatorOutcome;
      break;
    }
  }
  return result ?? Object.freeze({ content: "", totalTokens: 0, rounds: 0, elapsedMs: 0 });
}
