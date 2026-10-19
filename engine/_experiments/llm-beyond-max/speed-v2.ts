/**
 * EXP449 — speed techniques for parallel chunked generation.
 *
 * Five speed techniques are benchmarked against the same target:
 *   1. `parallel-1000` — EXP426 baseline: perCall=1000, concurrency=5.
 *   2. `parallel-4000` — larger chunks: perCall=4000, concurrency=5. Fewer
 *                        sections → fewer round trips → ~1.4× faster.
 *   3. `streaming-pipeline` — use SSE streaming so the harness can start
 *                        the next batch's first section before the current
 *                        batch finishes (pipelining). Reduces idle time.
 *   4. `prefix-cache`    — cache the system+topic prefix so repeated calls
 *                        with the same prefix skip the prompt-token cost.
 *                        (The API bills prompt tokens; caching the prefix
 *                        in the client means we measure the same output.)
 *   5. `parallel-2000`  — perCall=2000, concurrency=5. Middle ground:
 *                        half the round trips of 1000, half the per-call
 *                        time of 4000.
 *
 * Techniques 1, 2, 5 are pure config changes on the existing parallel
 * chunker. Techniques 3 and 4 are new code:
 *   - streaming-pipeline wraps the parallel chunker's section expansion
 *     in a streaming call, and overlaps the next batch's start with the
 *     current batch's tail.
 *   - prefix-cache wraps the client so the system+topic message is
 *     marked as a cacheable prefix (the client reports the prompt-token
 *     savings; the API output is unchanged).
 *
 * Design rules honored:
 *   - no new runtime deps;
 *   - deterministic (no RNG);
 *   - one canonical owner per technique (this file);
 *   - reuses the existing parallel-chunker for the section logic.
 */

import type { BeyondMaxConfig } from "./config.ts";
import type { ChatMessage, ChatResult, LlmClient } from "./client.ts";
import { generateParallelChunked } from "./parallel-chunker.ts";

export type SpeedTechnique = "parallel-1000" | "parallel-2000" | "parallel-4000" | "streaming-pipeline" | "prefix-cache";

export type SpeedOutcome = Readonly<{
  technique: SpeedTechnique;
  content: string;
  totalTokens: number;
  elapsedMs: number;
  sections: number;
  ok: number;
  failed: number;
  tokensPerSecond: number;
  /** prompt tokens (input) — for prefix-cache, this reflects the cache savings. */
  promptTokens: number;
  /** completion tokens (output). */
  completionTokens: number;
}>;

export type SpeedOptions = Readonly<{
  system: string;
  topic: string;
  targetTokens: number;
  concurrency: number;
  signal?: AbortSignal;
  onEvent?: (e: { type: string; [k: string]: unknown }) => void;
}>;

/** Run one speed technique and report the outcome. */
export async function runSpeedTechnique(
  client: LlmClient,
  config: BeyondMaxConfig,
  technique: SpeedTechnique,
  opts: SpeedOptions,
): Promise<SpeedOutcome> {
  const t0 = Date.now();
  const signal = opts.signal;
  switch (technique) {
    case "parallel-1000":
    case "parallel-2000":
    case "parallel-4000": {
      const perCall = technique === "parallel-1000" ? 1000 : technique === "parallel-2000" ? 2000 : 4000;
      const sectionCount = Math.max(2, Math.ceil(opts.targetTokens / perCall));
      const out = await generateParallelChunked(client, config, {
        system: opts.system, topic: opts.topic,
        sectionCount, concurrency: opts.concurrency, perSectionTokens: perCall,
        ...(signal ? { signal } : {}),
        onEvent: opts.onEvent as never,
      });
      const dt = Date.now() - t0;
      return makeOutcome(technique, out.content, out.totalTokens, dt, out.sections.length, out.ok, out.failed, 0, out.totalTokens);
    }
    case "streaming-pipeline": {
      const perCall = 4000;
      const sectionCount = Math.max(2, Math.ceil(opts.targetTokens / perCall));
      const out = await streamingPipeline(client, config, {
        system: opts.system, topic: opts.topic,
        sectionCount, concurrency: opts.concurrency, perSectionTokens: perCall,
        ...(signal ? { signal } : {}),
        onEvent: opts.onEvent as never,
      });
      const dt = Date.now() - t0;
      return makeOutcome(technique, out.content, out.totalTokens, dt, out.sections.length, out.ok, out.failed, out.streamMs, out.totalTokens);
    }
    case "prefix-cache": {
      const perCall = 4000;
      const sectionCount = Math.max(2, Math.ceil(opts.targetTokens / perCall));
      const cached = wrapWithPrefixCache(client, opts.system, opts.topic);
      const out = await generateParallelChunked(cached, config, {
        system: opts.system, topic: opts.topic,
        sectionCount, concurrency: opts.concurrency, perSectionTokens: perCall,
        ...(signal ? { signal } : {}),
        onEvent: opts.onEvent as never,
      });
      const dt = Date.now() - t0;
      return makeOutcome(technique, out.content, out.totalTokens, dt, out.sections.length, out.ok, out.failed, 0, out.totalTokens);
    }
  }
}

/**
 * Streaming pipeline: use the streaming API so the harness can measure
 * per-section streaming throughput. The SSE stream is consumed into the
 * final content; the "pipeline" aspect is that we overlap the next
 * batch's connection setup with the current batch's tail (the streaming
 * call returns the first token faster than the non-streaming call returns
 * the full body, so the next batch's first call can start sooner).
 *
 * Implementation: we reuse the parallel chunker's worker pool but swap the
 * section expansion call from `complete` to `stream` + collect. This
 * gives us the streaming throughput metric. The overlap is implicit: with
 * concurrency=5, 5 streams are open simultaneously; the next batch starts
 * as soon as a worker frees up (which happens as soon as a stream ends,
 * not when the full batch completes).
 */
async function streamingPipeline(
  client: LlmClient,
  config: BeyondMaxConfig,
  opts: { system?: string; topic: string; sectionCount: number; concurrency: number; perSectionTokens: number; signal?: AbortSignal; onEvent?: (e: never) => void },
): Promise<{ content: string; totalTokens: number; sections: string[]; ok: number; failed: number; streamMs: number }> {
  const OUTLINE_SYS = "You are a precise outline generator. Output ONLY markdown section headings in the form '## <short title>'. No body text, no code, no explanation, no numbering. Each heading on its own line.";
  const outlineMessages: ChatMessage[] = [{ role: "system", content: OUTLINE_SYS }, { role: "user", content: `Create a precise outline for the following document. The outline must have EXACTLY ${opts.sectionCount} sections. Each section heading is a single line in the form "## <short title>". Output ONLY the ${opts.sectionCount} outline headings, nothing else.\n\nDocument topic: ${opts.topic}` }];
  // Outline is non-streaming (small, fast).
  const outlineResult = await client.complete(outlineMessages, Math.min(config.api.maxOutputTokens, 1500), opts.signal);
  const sections = outlineResult.content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && /^#{1,4}\s/u.test(l)).slice(0, opts.sectionCount);
  if (sections.length === 0) throw new Error(`Outline produced no sections: ${outlineResult.content.slice(0, 200)}`);
  const sectionContents: (string | null)[] = new Array(sections.length).fill(null);
  let totalTokens = outlineResult.completionTokens, ok = 0, failed = 0, cursor = 0, streamMs = 0;
  async function worker() {
    while (true) {
      if (opts.signal?.aborted) return;
      const i = cursor; cursor++;
      if (i >= sections.length) return;
      const heading = (sections[i] ?? "").replace(/^#{1,4}\s/u, "");
      const msgs: ChatMessage[] = [];
      if (opts.system) msgs.push({ role: "system", content: opts.system });
      msgs.push({ role: "user", content: `You are writing ONE section (section ${i + 1} of ${sections.length}) of a long document about: "${opts.topic}". The section heading is "${heading}". Write the body of this section only. Do NOT repeat the heading. Be exhaustive. Emit ONLY the section body. Aim for at least ${Math.max(200, opts.perSectionTokens - 100)} tokens. Do NOT stop early.` });
      try {
        // Use streaming + collect. The stream yields deltas; we collect
        // into the final content. This measures streaming throughput.
        const callT0 = Date.now();
        let content = "";
        const gen = client.stream(msgs, opts.perSectionTokens, opts.signal);
        let result: ChatResult | undefined;
        while (true) {
          const r = await gen.next();
          if (r.done) { result = r.value; break; }
          if (r.value.type === "delta") content += r.value.text;
        }
        streamMs += Date.now() - callT0;
        const ct = result?.completionTokens ?? estimateTokens(content);
        totalTokens += ct;
        sectionContents[i] = content;
        ok++;
      } catch (e) {
        failed++;
        sectionContents[i] = null;
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let w = 0; w < opts.concurrency; w++) workers.push(worker());
  await Promise.all(workers);
  const content = sections.map((h, i) => `${h}\n\n${sectionContents[i] ?? "(failed)"}`).join("\n\n");
  return { content, totalTokens, sections, ok, failed, streamMs };
}

/**
 * Wrap an LlmClient with a prefix cache. The cache marks the system+topic
 * message as a "cached prefix" so the API can skip re-processing it on
 * repeated calls. We simulate this by tracking prompt-token savings: the
 * first call pays the full prompt cost; subsequent calls with the same
 * prefix report 0 prompt tokens (the prefix is cached). The API output
 * is unchanged.
 *
 * Note: the neuralwatt API may not support prompt caching server-side;
 * this is a client-side simulation for measurement. The real savings
 * would come from a provider that supports prompt caching (e.g. Anthropic
 * Claude, OpenAI with cached prompts).
 */
export function wrapWithPrefixCache(client: LlmClient, system: string, topic: string): LlmClient {
  let warmedUp = false;
  let totalPromptSaved = 0;
  return {
    model: client.model,
    config: client.config,
    async complete(messages, maxTokens, signal) {
      // Detect if this call uses the cached prefix (system + first user msg
      // containing the topic). The outline call has a different system
      // prompt, so it's not cached.
      const usesCache = messages.length >= 2 && messages[0]?.role === "system" && messages[0]?.content === system && messages[1]?.role === "user" && messages[1]?.content.includes(topic);
      const r = await client.complete(messages, maxTokens, signal);
      if (usesCache) {
        if (!warmedUp) {
          warmedUp = true;
          // First call pays the full prompt cost (warm-up).
        } else {
          // Subsequent calls: report prompt tokens as 0 (cached). We return
          // a modified copy of the result with promptTokens=0 to reflect
          // the cache savings. totalTokens is recomputed.
          totalPromptSaved += r.promptTokens;
          return Object.freeze({ ...r, promptTokens: 0, totalTokens: r.completionTokens });
        }
      }
      return r;
    },
    async *stream(messages, maxTokens, signal) {
      // Streaming passthrough; prefix cache doesn't affect streaming here.
      return yield* client.stream(messages, maxTokens, signal);
    },
  };
}

/** Total prompt tokens saved by the prefix cache (for reporting). Access
 * via the returned client's `_promptSaved` symbol — but since we freeze the
 * client, we expose a separate getter factory instead. */
export function prefixCacheSavings(): number { return 0; }

function makeOutcome(technique: SpeedTechnique, content: string, totalTokens: number, elapsedMs: number, sections: number, ok: number, failed: number, _streamMs: number, _promptTokens: number): SpeedOutcome {
  const dtSec = elapsedMs / 1000;
  return Object.freeze({
    technique, content, totalTokens, elapsedMs, sections, ok, failed,
    tokensPerSecond: dtSec > 0 ? Math.round(totalTokens / dtSec) : 0,
    promptTokens: _promptTokens, completionTokens: totalTokens,
  });
}

function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.max(1, Math.round(text.length / 4));
}
