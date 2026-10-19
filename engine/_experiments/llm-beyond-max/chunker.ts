/**
 * EXP410 — chunked generation.
 *
 * Break a task into N chunks. Generate each chunk in a separate LLM call.
 * Pass a SUMMARY of prior chunks in the context for the next chunk so the
 * model stays coherent across chunk boundaries.
 *
 * Two modes:
 *   - "exact": the caller supplies the N chunk prompts (e.g., "edit file
 *     X.ts"). The chunks are independent — no summary needed.
 *   - "outline": the caller supplies a single task + N (the chunk count).
 *     The orchestrator asks the LLM for an outline (N sections), then
 *     generates each section in a separate call. The prior section's last
 *     paragraph is fed as context to the next section.
 *
 * Stitch: concatenation of all chunks in order.
 */

import type { BeyondMaxConfig } from "./config.ts";
import { trailingContext } from "./tokens.ts";
import type { ChatMessage, ChatResult, LlmClient } from "./client.ts";

export type ChunkedEvent =
  | Readonly<{ type: "outline"; outline: string }>
  | Readonly<{ type: "chunk"; index: number; total: number; tokens: number; elapsedMs: number; finish: string }>
  | Readonly<{ type: "done"; chunks: number; totalTokens: number; totalMs: number }>;

export type ChunkedOutcome = Readonly<{
  content: string;
  chunks: readonly string[];
  totalTokens: number;
  elapsedMs: number;
  outline?: string;
}>;

export type ChunkedOptions = Readonly<{
  system?: string;
  /** Single task: orchestrator generates an outline of N sections. */
  task?: string;
  /** Explicit per-chunk prompts (overrides `task`). */
  chunkPrompts?: readonly string[];
  /** Number of chunks (when using `task`). */
  chunkCount?: number;
  signal?: AbortSignal;
  onEvent?: (e: ChunkedEvent) => void;
}>;

export async function generateChunked(
  client: LlmClient,
  config: BeyondMaxConfig,
  opts: ChunkedOptions,
): Promise<ChunkedOutcome> {
  const t0 = Date.now();
  const perCall = config.api.maxOutputTokens;
  let outline: string | undefined;
  let prompts: readonly string[];
  if (opts.chunkPrompts && opts.chunkPrompts.length > 0) {
    prompts = opts.chunkPrompts;
  } else if (opts.task) {
    const n = opts.chunkCount ?? config.chunker.chunkCount;
    outline = await generateOutline(client, config, opts.system, opts.task, n, opts.signal);
    opts.onEvent?.({ type: "outline", outline });
    prompts = outlineToPrompts(outline, opts.task);
  } else {
    throw new Error("ChunkedOptions: provide either `task` or `chunkPrompts`");
  }
  const chunks: string[] = [];
  let totalTokens = 0;
  let accumulated = "";
  for (let i = 0; i < prompts.length; i++) {
    if (opts.signal?.aborted) break;
    const summary = i > 0 ? trailingContext(accumulated, config.chunker.summaryChars) : "";
    const messages: ChatMessage[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: buildChunkPrompt(prompts[i] ?? "", summary, i, prompts.length) });
    const r: ChatResult = await client.complete(messages, perCall, opts.signal);
    totalTokens += r.completionTokens;
    chunks.push(r.content);
    accumulated += r.content;
    opts.onEvent?.({ type: "chunk", index: i, total: prompts.length, tokens: r.completionTokens, elapsedMs: r.elapsedMs, finish: r.finishReason });
  }
  const content = chunks.join("\n\n");
  opts.onEvent?.({ type: "done", chunks: prompts.length, totalTokens, totalMs: Date.now() - t0 });
  const frozen: ChunkedOutcome = Object.freeze({
    content,
    chunks: Object.freeze(chunks),
    totalTokens,
    elapsedMs: Date.now() - t0,
    ...(outline !== undefined ? { outline } : {}),
  });
  return frozen;
}

function buildChunkPrompt(section: string, summary: string, i: number, total: number): string {
  const parts: string[] = [];
  parts.push(`You are writing section ${i + 1} of ${total} of a long document. Write ONLY this section. Do not write any other section. Do not include the section number unless it is in the heading.`);
  if (summary.length > 0) {
    parts.push(`\nThe previous section ended with:\n"""\n${summary}\n"""\nContinue the narrative coherently from that point. Do NOT repeat text from the previous section.`);
  }
  parts.push(`\nSection to write: ${section}`);
  return parts.join("\n");
}

async function generateOutline(
  client: LlmClient,
  config: BeyondMaxConfig,
  system: string | undefined,
  task: string,
  n: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const messages: ChatMessage[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({
    role: "user",
    content: `Create a precise outline for the following task. The outline must have exactly ${n} sections. Each section must be a single line in the form "## <short title>: <one-sentence description>". Output ONLY the ${n} outline lines, nothing else.\n\nTask: ${task}`,
  });
  const r = await client.complete(messages, Math.min(config.api.maxOutputTokens, 1500), signal);
  return r.content;
}

function outlineToPrompts(outline: string, task: string): readonly string[] {
  const lines = outline.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && /^#{1,4}\s/.test(l));
  if (lines.length === 0) {
    // Fallback: treat each non-empty line as a section.
    return outline.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  }
  // Strip leading ## markers and prepend the task as context.
  return lines.map((l) => `For the task "${task.slice(0, 200)}", write the following section in full:\n${l.replace(/^#{1,4}\s/, "")}`);
}
