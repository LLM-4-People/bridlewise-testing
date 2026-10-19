/**
 * EXP410 — OpenAI-compatible chat client.
 *
 * A thin wrapper around the /chat/completions endpoint that supports both
 * streaming (SSE) and non-streaming modes, retries on transient errors, and
 * surfaces the `finish_reason` so callers can detect truncation.
 *
 * We do not import the harness's existing provider-adapter — that module is
 * tightly coupled to the central config/metrics/root-policy contracts, and
 * the experiment needs a self-contained, dependency-free client. We reuse
 * the SSE parsing approach (sentinel + per-event JSON) but in a minimal form.
 */

import type { LlmApiConfig, ModelId } from "./config.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = Readonly<{
  role: ChatRole;
  content: string;
}>;

export type ChatResult = Readonly<{
  content: string;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  elapsedMs: number;
}>;

export type StreamEvent =
  | Readonly<{ type: "delta"; text: string }>
  | Readonly<{ type: "finish"; reason: string }>
  | Readonly<{ type: "usage"; prompt: number; completion: number; total: number }>;

const SSE_DONE = ROOT_POLICY.contracts.chatStreamDoneSentinel;

export class LlmClientError extends Error {
  public readonly kind: string;
  public readonly retryable: boolean;
  public readonly status: number | undefined;
  constructor(message: string, kind: string, retryable: boolean, status?: number) {
    super(message);
    this.name = "LlmClientError";
    this.kind = kind;
    this.retryable = retryable;
    this.status = status;
  }
}

export type LlmClient = Readonly<{
  model: ModelId;
  config: LlmApiConfig;
  complete(messages: readonly ChatMessage[], maxTokens?: number, signal?: AbortSignal): Promise<ChatResult>;
  stream(messages: readonly ChatMessage[], maxTokens?: number, signal?: AbortSignal): AsyncGenerator<StreamEvent, ChatResult, unknown>;
}>;

type LlmClientInternal = {
  readonly model: ModelId;
  readonly config: LlmApiConfig;
  readonly complete: (messages: readonly ChatMessage[], maxTokens?: number, signal?: AbortSignal) => Promise<ChatResult>;
  readonly stream: (messages: readonly ChatMessage[], maxTokens?: number, signal?: AbortSignal) => AsyncGenerator<StreamEvent, ChatResult, unknown>;
};

export function createLlmClient(model: ModelId, config: LlmApiConfig): LlmClient {
  return makeClient(model, config);
}

function makeClient(model: ModelId, config: LlmApiConfig): LlmClient {
  // Per-client pacing state. Shared across all calls from this client so
  // back-to-back invocations space out and respect the API rate limit.
  let lastCallEndMs = 0;
  const internal: LlmClientInternal = {
    model,
    config,
    async complete(messages, maxTokens, signal) {
      await pace(config.minInterCallMs, lastCallEndMs, signal);
      try {
        return await collectInternal(model, config, messages, maxTokens ?? config.maxOutputTokens, false, signal);
      } finally {
        lastCallEndMs = Date.now();
      }
    },
    async *stream(messages, maxTokens, signal) {
      await pace(config.minInterCallMs, lastCallEndMs, signal);
      try {
        return yield* streamInternal(model, config, messages, maxTokens ?? config.maxOutputTokens, signal);
      } finally {
        lastCallEndMs = Date.now();
      }
    },
  };
  return internal;
}

async function pace(minInterCallMs: number, lastCallEndMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (minInterCallMs <= 0) return;
  if (lastCallEndMs === 0) return;
  const elapsed = Date.now() - lastCallEndMs;
  const wait = minInterCallMs - elapsed;
  if (wait <= 0) return;
  await sleep(wait);
  if (signal?.aborted) return;
}

async function sendRequest(
  model: ModelId,
  config: LlmApiConfig,
  messages: readonly ChatMessage[],
  maxTokens: number,
  stream: boolean,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const url = `${config.baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: config.temperature,
    stream,
  };
  let attempt = 0;
  const maxRetries = config.maxRetries;
  let lastErr: LlmClientError | undefined;
  while (attempt <= maxRetries) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.requestTimeoutMs);
    const combined = signal ? mergeSignals(signal, ctrl.signal) : ctrl.signal;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
      clearTimeout(timer);
      if (r.status === 429 || r.status >= 500) {
        // The neuralwatt API returns a JSON body describing the retry
        // strategy for concurrent_budget_exceeded (the dominant 429 mode
        // for shared 5-slot models). Parse it and honor the suggested
        // backoff. Fall back to the retry-after header, then to a fixed
        // exponential backoff.
        const backoff = await computeBackoffMs(r, attempt);
        lastErr = new LlmClientError(`HTTP ${r.status}`, "transient", true, r.status);
        if (attempt >= maxRetries) throw lastErr;
        await sleep(backoff);
        if (signal?.aborted) {
          throw new LlmClientError("Aborted by caller", "aborted", false);
        }
        attempt++;
        continue;
      }
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new LlmClientError(
          `HTTP ${r.status}: ${text.slice(0, 256)}`,
          r.status === 401 || r.status === 403 ? "auth" : "http",
          false,
          r.status,
        );
      }
      return r;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof LlmClientError) {
        if (!e.retryable || attempt >= maxRetries) throw e;
        const backoff = Math.min(30_000, 500 * 2 ** attempt);
        await sleep(backoff);
        attempt++;
        lastErr = e;
        continue;
      }
      if (isAbort(e)) {
        throw new LlmClientError(
          signal?.aborted ? "Aborted by caller" : "Request timed out",
          "aborted",
          false,
        );
      }
      lastErr = new LlmClientError(
        `Network error: ${String(e).slice(0, 200)}`,
        "network",
        true,
      );
      if (attempt >= maxRetries) throw lastErr;
      const backoff = Math.min(30_000, 500 * 2 ** attempt);
      await sleep(backoff);
      attempt++;
    }
  }
  throw lastErr ?? new LlmClientError("Unreachable", "unknown", false);
}

/**
 * Compute the backoff (ms) for a 429/5xx response. Honors the API's
 * `retry_strategy` body field (concurrent_drain: suggested_initial_delay_s,
 * max_delay_s, backoff_base, jitter) and the `retry-after` header. Falls
 * back to a fixed exponential backoff.
 */
async function computeBackoffMs(r: Response, attempt: number): Promise<number> {
  const raHeader = r.headers.get("retry-after");
  let retryAfterS: number | undefined;
  if (raHeader !== null) {
    const n = Number(raHeader);
    if (Number.isFinite(n)) retryAfterS = n;
  }
  let strategy: {
    suggested_initial_delay_s?: number;
    max_delay_s?: number;
    backoff_base?: number;
    jitter?: boolean;
  } | undefined;
  try {
    const j = (await r.clone().json()) as {
      error?: { retry_strategy?: typeof strategy; retry_after?: number };
    };
    strategy = j.error?.retry_strategy;
    if (retryAfterS === undefined && Number.isFinite(j.error?.retry_after)) {
      retryAfterS = j.error?.retry_after;
    }
  } catch {
    // Body wasn't JSON or could not be cloned; fall back to defaults.
  }
  const initialS = strategy?.suggested_initial_delay_s ?? (retryAfterS ?? 1);
  const maxS = strategy?.max_delay_s ?? 30;
  const base = strategy?.backoff_base ?? 2;
  const jitter = strategy?.jitter ?? true;
  const exp = Math.min(maxS, initialS * base ** attempt);
  let ms = exp * 1000;
  if (jitter) {
    // ±25% jitter
    const j = 0.75 + Math.random() * 0.5;
    ms = ms * j;
  }
  return Math.max(250, Math.round(ms));
}

async function collectInternal(
  model: ModelId,
  config: LlmApiConfig,
  messages: readonly ChatMessage[],
  maxTokens: number,
  _stream: boolean,
  signal: AbortSignal | undefined,
): Promise<ChatResult> {
  const t0 = Date.now();
  const r = await sendRequest(model, config, messages, maxTokens, false, signal);
  const json = (await r.json()) as {
    choices?: ReadonlyArray<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  const choice = json.choices?.[0];
  const content = choice?.message?.content ?? "";
  const finish = choice?.finish_reason ?? "stop";
  const u = json.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return Object.freeze({
    content,
    finishReason: finish,
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens,
    totalTokens: u.total_tokens,
    elapsedMs: Date.now() - t0,
  });
}

async function* streamInternal(
  model: ModelId,
  config: LlmApiConfig,
  messages: readonly ChatMessage[],
  maxTokens: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<StreamEvent, ChatResult, unknown> {
  const t0 = Date.now();
  const r = await sendRequest(model, config, messages, maxTokens, true, signal);
  if (!r.body) throw new LlmClientError("Stream has no body", "malformed", false);
  let content = "";
  let finish = "stream_ended";
  let prompt = 0;
  let completion = 0;
  let total = 0;
  const reader = r.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (raw.length === 0 || !raw.startsWith("data:")) continue;
        const data = raw.slice(5).trim();
        if (data === SSE_DONE) {
          finish = "stop";
          break;
        }
        try {
          const parsed = JSON.parse(data) as {
            choices?: ReadonlyArray<{
              delta?: { content?: string };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
          };
          for (const c of parsed.choices ?? []) {
            const d = c.delta?.content;
            if (d && d.length > 0) {
              content += d;
              yield { type: "delta", text: d };
            }
            if (c.finish_reason) finish = c.finish_reason;
          }
          if (parsed.usage) {
            prompt = parsed.usage.prompt_tokens;
            completion = parsed.usage.completion_tokens;
            total = parsed.usage.total_tokens;
            yield { type: "usage", prompt, completion, total };
          }
        } catch {
          // ignore malformed chunk
        }
      }
      if (finish === "stop") break;
    }
  } finally {
    reader.releaseLock();
  }
  if (finish !== "stop" && finish !== "length") finish = "stream_ended";
  const result: ChatResult = Object.freeze({
    content,
    finishReason: finish,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    elapsedMs: Date.now() - t0,
  });
  return result;
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  a.addEventListener("abort", () => ctrl.abort(a.reason));
  b.addEventListener("abort", () => ctrl.abort(b.reason));
  return ctrl.signal;
}

function isAbort(e: unknown): boolean {
  if (e instanceof Error && e.name === "AbortError") return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
