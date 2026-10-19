/**
 * EXP410 — sliding window generation.
 *
 * Generate the output in a sliding window. Each window overlaps the
 * previous by `overlapTokens` tokens. The overlap ensures coherence at
 * the stitch seams. The model sees the last `overlapTokens` of the
 * previous window as priming context.
 *
 * Use case: editing a large file where the edit itself is larger than the
 * max output window. Each window produces the next slice of the file;
 * the overlap primes the model on what it just wrote.
 *
 * Stitch: window N's overlap is dropped (it's the same as window N-1's tail).
 *
 * Reliability: detect repetition (model echoing the overlap verbatim and
 * never advancing). On detection, force a "skip forward" prompt.
 */

import type { BeyondMaxConfig } from "./config.ts";
import { estimateCharsForTokens, trailingContext } from "./tokens.ts";
import type { ChatMessage, ChatResult, LlmClient } from "./client.ts";

export type SlidingWindowEvent =
  | Readonly<{ type: "window_start"; index: number; primedChars: number }>
  | Readonly<{ type: "window_done"; index: number; tokens: number; elapsedMs: number; finish: string; producedChars: number }>
  | Readonly<{ type: "stitch"; index: number; overlapChars: number }>
  | Readonly<{ type: "skip_forward"; index: number }>
  | Readonly<{ type: "done"; totalChars: number; totalTokens: number; windows: number; totalMs: number }>;

export type SlidingWindowOutcome = Readonly<{
  content: string;
  totalTokens: number;
  windows: number;
  elapsedMs: number;
  abortReason?: string;
}>;

export type SlidingWindowOptions = Readonly<{
  system?: string;
  /** Instruction describing what to generate (e.g. "write the body of the doFoo function"). */
  prompt: string;
  /** Total target tokens to produce. */
  maxTotalTokens: number;
  /** Override window size. */
  windowTokens?: number;
  /** Override overlap size. */
  overlapTokens?: number;
  signal?: AbortSignal;
  onEvent?: (e: SlidingWindowEvent) => void;
}>;

export async function generateSlidingWindow(
  client: LlmClient,
  config: BeyondMaxConfig,
  opts: SlidingWindowOptions,
): Promise<SlidingWindowOutcome> {
  const windowTokens = opts.windowTokens ?? config.slidingWindow.windowTokens;
  const overlapTokens = opts.overlapTokens ?? config.slidingWindow.overlapTokens;
  if (overlapTokens >= windowTokens) throw new Error("overlap must be < window");
  const t0 = Date.now();
  let content = "";
  let totalTokens = 0;
  let lastProduced = "";
  let stuckStreak = 0;
  let windowsProduced = 0;
  for (let i = 0; i < config.continuation.maxContinuations; i++) {
    if (opts.signal?.aborted) break;
    if (totalTokens >= opts.maxTotalTokens) break;
    const overlapChars = Math.min(content.length, estimateCharsForTokens(overlapTokens));
    const primer = content.length > 0 ? trailingContext(content, overlapChars) : "";
    const messages: ChatMessage[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    let userMsg: string;
    if (i === 0) {
      userMsg = `${opts.prompt}\n\nProduce the next ${windowTokens} tokens. Do NOT include any preamble. Start writing directly.`;
    } else {
      userMsg = `${opts.prompt}\n\nContinue writing from exactly where the previous window ended. The previous window's last ${overlapTokens} tokens were:\n"""\n${primer}\n"""\nContinue from that point. Produce the next ${windowTokens} tokens. Do NOT repeat the priming text. Do NOT include any preamble.`;
    }
    messages.push({ role: "user", content: userMsg });
    opts.onEvent?.({ type: "window_start", index: i, primedChars: primer.length });
    const r: ChatResult = await client.complete(messages, windowTokens, opts.signal);
    totalTokens += r.completionTokens;
    let produced = r.content;
    opts.onEvent?.({ type: "window_done", index: i, tokens: r.completionTokens, elapsedMs: r.elapsedMs, finish: r.finishReason, producedChars: produced.length });
    if (produced.length === 0) {
      stuckStreak++;
      if (stuckStreak >= 3) {
        windowsProduced = i + 1;
        const totalMs = Date.now() - t0;
        opts.onEvent?.({ type: "done", totalChars: content.length, totalTokens, windows: windowsProduced, totalMs });
        return Object.freeze({ content, totalTokens, windows: windowsProduced, elapsedMs: totalMs, abortReason: "stuck_empty" });
      }
      continue;
    }
    // Strip the overlap if the model echoed it verbatim.
    if (primer.length > 0) {
      const trimmed = stripLeadingOverlap(produced, primer);
      if (trimmed.length !== produced.length) {
        opts.onEvent?.({ type: "stitch", index: i, overlapChars: produced.length - trimmed.length });
        produced = trimmed;
      }
    }
    // Stuck detection: did this window produce the same content as last?
    if (produced === lastProduced && produced.length > 0) {
      stuckStreak++;
      if (stuckStreak >= 3) {
        windowsProduced = i + 1;
        const totalMs = Date.now() - t0;
        opts.onEvent?.({ type: "done", totalChars: content.length, totalTokens, windows: windowsProduced, totalMs });
        return Object.freeze({ content, totalTokens, windows: windowsProduced, elapsedMs: totalMs, abortReason: "stuck_repeat" });
      }
      // Force a skip-forward.
      opts.onEvent?.({ type: "skip_forward", index: i });
      content += "\n\n[...continuing...]\n\n";
      lastProduced = produced;
      windowsProduced = i + 1;
      continue;
    }
    stuckStreak = 0;
    content += produced;
    lastProduced = produced;
    windowsProduced = i + 1;
    if (r.finishReason !== "length") {
      const totalMs = Date.now() - t0;
      opts.onEvent?.({ type: "done", totalChars: content.length, totalTokens, windows: windowsProduced, totalMs });
      return Object.freeze({ content, totalTokens, windows: windowsProduced, elapsedMs: totalMs });
    }
  }
  const totalMs = Date.now() - t0;
  opts.onEvent?.({ type: "done", totalChars: content.length, totalTokens, windows: windowsProduced, totalMs });
  return Object.freeze({ content, totalTokens, windows: windowsProduced, elapsedMs: totalMs });
}

function stripLeadingOverlap(produced: string, primer: string): string {
  // Try exact suffix-prefix match (same as overlapLength).
  const max = Math.min(primer.length, produced.length, 4096);
  for (let n = max; n > 0; n--) {
    if (primer.endsWith(produced.slice(0, n))) return produced.slice(n);
  }
  // Try a softer match: strip the longest common whitespace-trimmed prefix.
  const p = produced.trimStart();
  const pr = primer.trim();
  if (p.length > 0 && pr.length > 0 && pr.endsWith(p.slice(0, Math.min(64, p.length)))) {
    return p.slice(Math.min(64, p.length));
  }
  return produced;
}
