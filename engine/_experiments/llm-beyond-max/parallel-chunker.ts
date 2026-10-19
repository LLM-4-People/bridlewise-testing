/**
 * EXP410 — parallel chunked generation.
 *
 * Generate an outline (1 LLM call), then generate each section IN PARALLEL
 * using a bounded worker pool. This is the SPEED strategy: with a 5-slot
 * shared concurrency budget, 5 sections in parallel = ~5× speedup vs
 * sequential generation.
 *
 * Unlike `continuation.ts` (sequential, each chunk continues from the
 * previous), parallel chunks are INDEPENDENT — each chunk generates one
 * section of the outline. The outline guarantees structural coherence
 * (the section headings are fixed before any expansion begins).
 *
 * Reliability:
 *   - Each section is an independent LLM call; a failure in one does not
 *     block the others.
 *   - The shared client honors the API's `retry_strategy` for
 *     `concurrent_budget_exceeded` (429) with exponential backoff.
 *   - The worker pool bounds concurrency to `config.parallelChunker.concurrency`
 *     (default 5 — the neuralwatt shared-slot budget for gemma-4-31b).
 *
 * Speed analysis (gemma-4-31b, 5-slot budget, perCall=1000):
 *   - Sequential: 10 chunks × 12s = 120s.
 *   - Parallel (5 concurrent): 2 batches × 12s = 24s. ~5× speedup.
 *
 * This is the canonical approach for the 10k, 100k, and report tasks
 * where structural coherence (via outline) is sufficient.
 */

import type { BeyondMaxConfig } from "./config.ts";
import type { ChatMessage, ChatResult, LlmClient } from "./client.ts";

export type ParallelChunkerEvent =
  | Readonly<{ type: "outline"; outline: string; sections: number }>
  | Readonly<{ type: "section_start"; index: number; heading: string }>
  | Readonly<{ type: "section_done"; index: number; tokens: number; elapsedMs: number; finish: string }>
  | Readonly<{ type: "section_error"; index: number; error: string }>
  | Readonly<{ type: "done"; sections: number; ok: number; failed: number; totalTokens: number; totalMs: number }>;

export type ParallelChunkerOutcome = Readonly<{
  content: string;
  outline: string;
  sections: readonly string[];
  sectionContents: readonly (string | null)[];
  totalTokens: number;
  elapsedMs: number;
  ok: number;
  failed: number;
}>;

export type ParallelChunkerOptions = Readonly<{
  system?: string;
  /** Document / module topic. */
  topic: string;
  /** Force a specific section count (overrides config). */
  sectionCount?: number;
  /** Force a specific concurrency (overrides config). */
  concurrency?: number;
  /** Force a specific per-section max tokens (overrides config). */
  perSectionTokens?: number;
  signal?: AbortSignal;
  onEvent?: (e: ParallelChunkerEvent) => void;
}>;

export async function generateParallelChunked(
  client: LlmClient,
  config: BeyondMaxConfig,
  opts: ParallelChunkerOptions,
): Promise<ParallelChunkerOutcome> {
  const t0 = Date.now();
  const sectionCount = opts.sectionCount ?? config.parallelChunker.sectionCount;
  const concurrency = Math.max(1, opts.concurrency ?? config.parallelChunker.concurrency);
  const perSection = opts.perSectionTokens ?? config.parallelChunker.maxTokensPerSection;
  // Step 1: outline (1 LLM call, ≤1500 tokens).
  // The outline system prompt is outline-friendly (allows markdown). The
  // user-provided system may say "Emit ONLY TypeScript" — that would
  // break outline parsing (the model would emit code, not headings). So
  // the outline step uses a fixed, outline-friendly system prompt and
  // ignores the user-provided system for this one call.
  const OUTLINE_SYS = "You are a precise outline generator. Output ONLY markdown section headings in the form '## <short title>'. No body text, no code, no explanation, no numbering. Each heading on its own line.";
  const outlineMessages: ChatMessage[] = [{ role: "system", content: OUTLINE_SYS }];
  outlineMessages.push({
    role: "user",
    content: `Create a precise outline for the following document. The outline must have EXACTLY ${sectionCount} sections. Each section heading is a single line in the form "## <short title>". Output ONLY the ${sectionCount} outline headings, nothing else (no body text, no description, no numbering).\n\nDocument topic: ${opts.topic}`,
  });
  const outlineResult: ChatResult = await client.complete(outlineMessages, Math.min(config.api.maxOutputTokens, 1500), opts.signal);
  const outline = outlineResult.content;
  const sections = outline.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && /^#{1,4}\s/u.test(l))
    .slice(0, sectionCount);
  if (sections.length === 0) {
    throw new Error(`Outline generation produced no section headings: ${outline.slice(0, 200)}`);
  }
  opts.onEvent?.({ type: "outline", outline, sections: sections.length });
  // Step 2: expand each section in parallel (bounded worker pool).
  const sectionContents: (string | null)[] = new Array(sections.length).fill(null);
  let totalTokens = outlineResult.completionTokens;
  let ok = 0;
  let failed = 0;
  let cursor = 0;
  async function worker(workerId: number): Promise<void> {
    while (true) {
      if (opts.signal?.aborted) return;
      const i = cursor;
      cursor++;
      if (i >= sections.length) return;
      const heading = (sections[i] ?? "").replace(/^#{1,4}\s/u, "");
      opts.onEvent?.({ type: "section_start", index: i, heading });
      const expandMessages: ChatMessage[] = [];
      if (opts.system) expandMessages.push({ role: "system", content: opts.system });
      expandMessages.push({
        role: "user",
        content: `You are writing ONE section (section ${i + 1} of ${sections.length}) of a long document about: "${opts.topic}". The section heading is "${heading}". Write the body of this section only. Do NOT repeat the heading. Do NOT write any other section. Be exhaustive. Emit ONLY the section body (TypeScript code if the topic is code, prose if the topic is prose). Aim for at least ${Math.max(200, perSection - 100)} tokens. Do NOT stop early. Do NOT include any preamble or explanation. (worker ${workerId})`,
      });
      try {
        const r: ChatResult = await client.complete(expandMessages, perSection, opts.signal);
        totalTokens += r.completionTokens;
        sectionContents[i] = r.content;
        ok++;
        opts.onEvent?.({ type: "section_done", index: i, tokens: r.completionTokens, elapsedMs: r.elapsedMs, finish: r.finishReason });
      } catch (e) {
        failed++;
        sectionContents[i] = null;
        opts.onEvent?.({ type: "section_error", index: i, error: String(e).slice(0, 200) });
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker(w));
  await Promise.all(workers);
  // Step 3: assemble (deterministic reduce).
  const content = sections.map((h, i) => `${h}\n\n${sectionContents[i] ?? "(failed)"}`).join("\n\n");
  const totalMs = Date.now() - t0;
  opts.onEvent?.({ type: "done", sections: sections.length, ok, failed, totalTokens, totalMs });
  return Object.freeze({
    content,
    outline,
    sections: Object.freeze(sections),
    sectionContents: Object.freeze(sectionContents),
    totalTokens,
    elapsedMs: totalMs,
    ok,
    failed,
  });
}
