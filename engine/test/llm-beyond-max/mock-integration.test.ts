/**
 * EXP410 — integration tests for the beyond-max modules with a MOCK LLM.
 *
 * No network access. The mock client simulates truncation (finish_reason=
 * "length") at a fixed per-call token cap, then emits "stop" after N
 * chunks. We verify that the continuation, chunker, outline-expand,
 * sliding-window, and stream-accumulator modules stitch the chunks into
 * the expected output.
 */

import { strict as a } from "node:assert";
import { describe, it } from "node:test";

import type { BeyondMaxConfig } from "../../_experiments/llm-beyond-max/config.ts";
import { defaultConfig, withOverrides } from "../../_experiments/llm-beyond-max/config.ts";
import type { ChatMessage, ChatResult, LlmClient, StreamEvent } from "../../_experiments/llm-beyond-max/client.ts";
import { generateWithContinuation } from "../../_experiments/llm-beyond-max/continuation.ts";
import { generateChunked } from "../../_experiments/llm-beyond-max/chunker.ts";
import { generateOutlineExpand } from "../../_experiments/llm-beyond-max/outline-expand.ts";
import { generateSlidingWindow } from "../../_experiments/llm-beyond-max/sliding-window.ts";
import { generateStreamingWithContinuation } from "../../_experiments/llm-beyond-max/stream-accumulator.ts";
import { runMapReduce } from "../../_experiments/llm-beyond-max/map-reduce.ts";

/**
 * Build a mock LLM client. Each call produces a 200-char chunk. After
 * `chunksBeforeStop` chunks, the model emits "stop" instead of "length".
 * The chunk content is `"CHUNK_<i>_"` followed by filler, so we can
 * verify the order + that no chunks were dropped.
 */
function mockClient(chunksBeforeStop: number, chunkChars: number = 200, maxTokens: number = 50): LlmClient {
  let i = 0;
  const config = withOverrides(defaultConfig(), { api: { maxOutputTokens: maxTokens, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 } });
  const complete = async (_messages: readonly ChatMessage[], _maxTokens?: number, _signal?: AbortSignal): Promise<ChatResult> => {
    const idx = i++;
    const chunk = `CHUNK_${idx}_${"x".repeat(Math.max(0, chunkChars - 10))}`;
    const finish = idx >= chunksBeforeStop ? "stop" : "length";
    return Object.freeze({
      content: chunk,
      finishReason: finish,
      promptTokens: 10,
      completionTokens: maxTokens,
      totalTokens: maxTokens + 10,
      elapsedMs: 1,
    });
  };
  async function* stream(_messages: readonly ChatMessage[], _maxTokens?: number, _signal?: AbortSignal): AsyncGenerator<StreamEvent, ChatResult, unknown> {
    const idx = i++;
    const chunk = `CHUNK_${idx}_${"x".repeat(Math.max(0, chunkChars - 10))}`;
    const finish = idx >= chunksBeforeStop ? "stop" : "length";
    yield { type: "delta", text: chunk };
    yield { type: "finish", reason: finish };
    yield { type: "usage", prompt: 10, completion: maxTokens, total: maxTokens + 10 };
    return Object.freeze({
      content: chunk,
      finishReason: finish,
      promptTokens: 10,
      completionTokens: maxTokens,
      totalTokens: maxTokens + 10,
      elapsedMs: 1,
    });
  }
  return { model: "gemma-4-31b", config, complete, stream } as unknown as LlmClient;
}

describe("continuation", () => {
  it("stitches N chunks then stops", async () => {
    const client = mockClient(3, 100, 50);
    const cfg: BeyondMaxConfig = withOverrides(defaultConfig(), {
      api: { maxOutputTokens: 50, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 },
      continuation: { maxContinuations: 20, trailingContextChars: 80, abortOnNoProgress: true, repeatAbortWindow: 3 },
    });
    const out = await generateWithContinuation(client, cfg, { prompt: "write X", maxTotalTokens: 100_000 });
    a.equal(out.chunks, 4, `expected 4 chunks (3 length + 1 stop), got ${out.chunks}`);
    a.ok(out.content.length > 300, `content len=${out.content.length}`);
    // Verify all 4 chunks present in order.
    for (let k = 0; k < 4; k++) {
      a.ok(out.content.includes(`CHUNK_${k}_`), `missing CHUNK_${k}_`);
    }
  });
  it("aborts on repeat loop", async () => {
    // A mock that always emits the same chunk with finish=length.
    let i = 0;
    const config = withOverrides(defaultConfig(), { api: { maxOutputTokens: 50, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 } });
    const client: LlmClient = {
      model: "gemma-4-31b",
      config,
      async complete() {
        i++;
        return Object.freeze({ content: "SAME_CHUNK_x".repeat(20), finishReason: "length", promptTokens: 5, completionTokens: 50, totalTokens: 55, elapsedMs: 1 });
      },
      async *stream() {
        yield { type: "delta", text: "SAME_CHUNK_x".repeat(20) };
        yield { type: "finish", reason: "length" };
        return Object.freeze({ content: "SAME_CHUNK_x".repeat(20), finishReason: "length", promptTokens: 5, completionTokens: 50, totalTokens: 55, elapsedMs: 1 });
      },
    } as unknown as LlmClient;
    const cfg: BeyondMaxConfig = withOverrides(defaultConfig(), {
      api: { maxOutputTokens: 50, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 },
      continuation: { maxContinuations: 20, trailingContextChars: 80, abortOnNoProgress: true, repeatAbortWindow: 3 },
    });
    const out = await generateWithContinuation(client, cfg, { prompt: "write X", maxTotalTokens: 100_000 });
    a.ok(out.abortReason === "repeat_loop", `expected repeat_loop, got ${out.abortReason}`);
    a.ok(i > 0);
  });
  it("keeps the prompt bounded across many rounds (regression: context overflow at 100k)", async () => {
    // Regression: the continuation loop used to push the FULL accumulated
    // content as the assistant message each round, so the prompt grew
    // linearly with the output and overflowed the model's context window
    // at ~chunk 31 / ~1M tokens (observed HTTP 400 context_length_exceeded
    // during the 100k-token run). The fix: rebuild a fresh, bounded
    // message list each round (system + prompt + tail + instruction).
    // This test verifies the message list sent to the client does NOT
    // grow across rounds — it stays constant in size.
    const seenMessageLengths: number[] = [];
    let round = 0;
    const config = withOverrides(defaultConfig(), { api: { maxOutputTokens: 50, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 } });
    const client: LlmClient = {
      model: "gemma-4-31b",
      config,
      async complete(messages: readonly ChatMessage[], _m?: number, _s?: AbortSignal): Promise<ChatResult> {
        // Record the total prompt size (chars) the client received.
        const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
        seenMessageLengths.push(totalChars);
        const idx = round++;
        // Always emit "length" so the loop continues; each chunk is unique.
        const chunk = `UNIQUE_CHUNK_${idx}_${"z".repeat(100)}`;
        return Object.freeze({ content: chunk, finishReason: "length", promptTokens: 10, completionTokens: 50, totalTokens: 60, elapsedMs: 1 });
      },
      async *stream(): AsyncGenerator<StreamEvent, ChatResult, unknown> { throw new Error("unused"); },
    } as unknown as LlmClient;
    const cfg: BeyondMaxConfig = withOverrides(defaultConfig(), {
      api: { maxOutputTokens: 50, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 },
      continuation: { maxContinuations: 12, trailingContextChars: 80, abortOnNoProgress: true, repeatAbortWindow: 3 },
    });
    const out = await generateWithContinuation(client, cfg, { prompt: "write X (prompt of fixed length)", maxTotalTokens: 1_000_000 });
    // We ran all 12 rounds (every chunk was unique + finish=length + budget not hit).
    a.equal(out.chunks, 12, `expected 12 chunks, got ${out.chunks}`);
    a.ok(seenMessageLengths.length === 12, `expected 12 calls, got ${seenMessageLengths.length}`);
    // The prompt size must stay bounded in ABSOLUTE terms: every round's
    // prompt should be under a small constant (system + prompt + tail +
    // instruction). The old bug grew the prompt by ~chunk size each round
    // (linear growth) — for 12 rounds × ~110 chars that would be ~1320.
    // The bounded prompt should stay under ~600 chars (prompt + 80-char
    // tail + ~120-char instruction).
    for (const len of seenMessageLengths) {
      a.ok(len < 600, `prompt too large: ${len} (all: ${seenMessageLengths.join(",")})`);
    }
    // And the prompt must be constant from round 2 onward (the tail grows
    // to the trailingContextChars cap, then stays there). The old bug would
    // make each round's prompt strictly larger than the previous.
    const fromRound2 = seenMessageLengths.slice(1);
    const maxFromRound2 = Math.max(...fromRound2);
    const minFromRound2 = Math.min(...fromRound2);
    a.ok(maxFromRound2 - minFromRound2 <= 2, `prompt not constant from round 2: range [${minFromRound2}, ${maxFromRound2}] (all: ${seenMessageLengths.join(",")})`);
    // The decisive boundedness check: simulate a LONG run (120 rounds) and
    // verify the prompt is STILL under the same absolute cap. The old bug
    // would make the prompt grow to ~120×110 = ~13200 chars (22× the cap).
    const longSeen: number[] = [];
    let longRound = 0;
    const longClient: LlmClient = {
      model: "gemma-4-31b",
      config,
      async complete(messages: readonly ChatMessage[]): Promise<ChatResult> {
        longSeen.push(messages.reduce((n, m) => n + m.content.length, 0));
        const idx = longRound++;
        return Object.freeze({ content: `L_${idx}_${"z".repeat(100)}`, finishReason: "length", promptTokens: 10, completionTokens: 50, totalTokens: 60, elapsedMs: 1 });
      },
      async *stream(): AsyncGenerator<StreamEvent, ChatResult, unknown> { throw new Error("unused"); },
    } as unknown as LlmClient;
    const longCfg: BeyondMaxConfig = withOverrides(defaultConfig(), {
      api: { maxOutputTokens: 50, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 },
      continuation: { maxContinuations: 120, trailingContextChars: 80, abortOnNoProgress: true, repeatAbortWindow: 3 },
    });
    const longOut = await generateWithContinuation(longClient, longCfg, { prompt: "write X (prompt of fixed length)", maxTotalTokens: 1_000_000 });
    a.equal(longOut.chunks, 120, `expected 120 chunks (maxContinuations), got ${longOut.chunks}`);
    // For a longer run the bounded prompt stays flat while the output grows;
    // the old bug would make the last prompt ~120×110 = ~13200 chars (22× the cap).
    const longLast = longSeen[longSeen.length - 1] ?? 0;
    a.ok(longLast < 600, `long-run prompt too large: ${longLast}`);
    a.ok(longLast < longOut.content.length / 4, `long-run prompt ${longLast} not bounded relative to output ${longOut.content.length}`);
  });
});

describe("chunker", () => {
  it("generates each section and joins", async () => {
    const client = mockClient(0, 200, 100);
    const cfg: BeyondMaxConfig = withOverrides(defaultConfig(), {
      api: { maxOutputTokens: 100, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 },
    });
    const out = await generateChunked(client, cfg, {
      chunkPrompts: ["section A", "section B", "section C"],
    });
    a.equal(out.chunks.length, 3);
    a.ok(out.content.includes("CHUNK_0_"));
    a.ok(out.content.includes("CHUNK_1_"));
    a.ok(out.content.includes("CHUNK_2_"));
  });
});

describe("outlineExpand", () => {
  it("generates outline then expands each section", async () => {
    // Outline call returns 4 headings, each expansion returns content.
    let i = 0;
    const config = withOverrides(defaultConfig(), { api: { maxOutputTokens: 100, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 } });
    const client: LlmClient = {
      model: "gemma-4-31b",
      config,
      async complete(_messages: readonly ChatMessage[], _m?: number, _s?: AbortSignal) {
        i++;
        if (i === 1) {
          return Object.freeze({ content: "## Intro\n## Body\n## Detail\n## Conclusion", finishReason: "stop", promptTokens: 5, completionTokens: 10, totalTokens: 15, elapsedMs: 1 });
        }
        return Object.freeze({ content: `EXPANSION_${i}_`.repeat(20), finishReason: "stop", promptTokens: 5, completionTokens: 50, totalTokens: 55, elapsedMs: 1 });
      },
      async *stream(): AsyncGenerator<StreamEvent, ChatResult, unknown> { throw new Error("unused"); },
    } as unknown as LlmClient;
    const cfg: BeyondMaxConfig = withOverrides(defaultConfig(), {
      api: { maxOutputTokens: 100, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 },
      outlineExpand: { maxSections: 8, maxTokensPerSection: 100 },
    });
    const out = await generateOutlineExpand(client, cfg, { topic: "babel AST" });
    a.equal(out.sections.length, 4);
    a.equal(out.sectionContents.length, 4);
    a.ok(out.content.includes("## Intro"));
    a.ok(out.content.includes("EXPANSION_2_"));
  });
});

describe("slidingWindow", () => {
  it("produces N windows and stitches", async () => {
    let i = 0;
    const config = withOverrides(defaultConfig(), { api: { maxOutputTokens: 100, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 } });
    const client: LlmClient = {
      model: "gemma-4-31b",
      config,
      async complete(): Promise<ChatResult> {
        const idx = i++;
        const finish = idx >= 3 ? "stop" : "length";
        return Object.freeze({ content: `WINDOW_${idx}_${"y".repeat(100)}`, finishReason: finish, promptTokens: 5, completionTokens: 50, totalTokens: 55, elapsedMs: 1 });
      },
      async *stream(): AsyncGenerator<StreamEvent, ChatResult, unknown> { throw new Error("unused"); },
    } as unknown as LlmClient;
    const cfg: BeyondMaxConfig = withOverrides(defaultConfig(), {
      api: { maxOutputTokens: 100, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 },
      slidingWindow: { overlapTokens: 20, windowTokens: 100 },
      continuation: { maxContinuations: 20, trailingContextChars: 80, abortOnNoProgress: true, repeatAbortWindow: 3 },
    });
    const out = await generateSlidingWindow(client, cfg, { prompt: "write code", maxTotalTokens: 100_000 });
    a.ok(out.windows >= 1);
    a.ok(out.content.includes("WINDOW_0_"));
    a.ok(out.content.includes("WINDOW_1_"));
  });
});

describe("streamAccumulator", () => {
  it("streams deltas and continues until stop", async () => {
    const client = mockClient(2, 100, 50);
    const cfg: BeyondMaxConfig = withOverrides(defaultConfig(), {
      api: { maxOutputTokens: 50, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 },
      continuation: { maxContinuations: 20, trailingContextChars: 80, abortOnNoProgress: true, repeatAbortWindow: 3 },
    });
    const deltas: string[] = [];
    const gen = generateStreamingWithContinuation(client, cfg, { prompt: "write X", maxTotalTokens: 100_000, onEvent: (e) => {
      if (e.type === "delta") deltas.push(e.text);
    } });
    let result = null;
    while (true) {
      const n = await gen.next();
      if (n.done) { result = n.value as unknown as { content: string }; break; }
    }
    a.ok(result !== null);
    a.ok(deltas.length >= 3, `deltas=${deltas.length}`);
    a.ok((result as { content: string }).content.includes("CHUNK_0_"));
    a.ok((result as { content: string }).content.includes("CHUNK_2_"));
  });
});

describe("mapReduce", () => {
  it("maps each item and concatenates", async () => {
    let i = 0;
    const config = withOverrides(defaultConfig(), { api: { maxOutputTokens: 100, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 } });
    const client: LlmClient = {
      model: "gemma-4-31b",
      config,
      async complete(): Promise<ChatResult> {
        const idx = i++;
        return Object.freeze({ content: `result_${idx}`, finishReason: "stop", promptTokens: 5, completionTokens: 5, totalTokens: 10, elapsedMs: 1 });
      },
      async *stream(): AsyncGenerator<StreamEvent, ChatResult, unknown> { throw new Error("unused"); },
    } as unknown as LlmClient;
    const cfg: BeyondMaxConfig = withOverrides(defaultConfig(), {
      api: { maxOutputTokens: 100, apiKey: "", baseUrl: "", requestTimeoutMs: 60_000, maxRetries: 0, temperature: 0 },
      mapReduce: { concurrency: 2, llmReduce: false },
    });
    const items = Array.from({ length: 5 }, (_, k) => ({ id: `f${k}`, prompt: `edit file ${k}` }));
    const out = await runMapReduce(client, cfg, { items });
    a.equal(out.ok, 5);
    a.equal(out.failed, 0);
    a.equal(out.mapped.length, 5);
    // All 5 results present (order may differ with concurrency).
    const ids = new Set(out.mapped);
    a.equal(ids.size, 5);
    a.ok(out.reduced.includes("result_"));
  });
});
