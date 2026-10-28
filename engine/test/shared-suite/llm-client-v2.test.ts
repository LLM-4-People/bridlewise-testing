import { responsesSse, responseResource, responseJsonResponse, responseSseResponse, TEST_TRANSPORT } from "../support/mock-provider.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  SharedLLMClient, LLMError, isLLMError, ALL_ERROR_TYPES,
  RateLimitError, ServerError, OverloadedError, NetworkError, AuthError,
  BadRequestError, ModelNotFoundError, ContextTooLongError, TruncationError,
  InvalidResponseError, TimeoutError, EmptyResponseError, StreamingError,
  parseContextTooLong, resolveLLMConfig, validateLLMConfig,
  DEFAULT_MAX_RETRIES, DEFAULT_BACKOFF, DEFAULT_FAILOVER,
  CircuitBreaker, RequestQueue, LLMStatsCollector, FailoverSelector,
} from "../../src/shared/llm/index.ts";
import type { LLMConfig } from "../../src/shared/llm/config.ts";
import { address, mockDoorClock, onDoorBodyReader, serve, type UpstreamHandler, type UpstreamRequest } from "../support/loopback-upstream.ts";

/**
 * EXP421 — v2 LLM module unit tests. Covers the 13 error types, the typed
 * hierarchy, config resolution/validation, circuit breaker, queue, stats,
 * failover selector, and the streaming/complete happy paths with a mock
 * fetch. The legacy `provider-adapter` contract is covered by the existing
 * 73-test suite; this file asserts the v2-specific surface.
 */

// ── Mock fetch helpers ────────────────────────────────────────────────────

// Each installs the loopback upstream's answer (a real HTTP server on 127.0.0.1).
function mockFetchSse(content: string, model = "test-model", usage?: { input_tokens: number; output_tokens: number; total_tokens: number }): Record<string, never> {
  serve(async () => responseSseResponse({ content, model, ...(usage ? { usage } : {}) }, { headers: { "x-model-id": model } }));
  return {};
}
function mockFetchJson(content: string, model = "test-model", usage?: { input_tokens: number; output_tokens: number; total_tokens: number }): Record<string, never> {
  serve(async () => responseJsonResponse({ content, model, ...(usage ? { usage } : {}) }));
  return {};
}
function mockFetchStatus(status: number, body: string, headers?: Record<string, string>): Record<string, never> {
  serve(async () => new Response(body, { status, headers: { "content-type": "text/plain", ...(headers ?? {}) } }));
  return {};
}
/** Install `handler` as the upstream's answer (the spread keeps a config literal's shape). */
function upstream(handler: UpstreamHandler): Record<string, never> {
  serve(handler);
  return {};
}

function baseConfig(overrides: Partial<LLMConfig> = {}): LLMConfig {
  return {
    baseUrl: address("https://api.test.com/v1"),
    apiKey: "sk-test-key-1234567890",
    allowPrivateAddress: true,
    model: "test-model",
    timeout: 5000,
    maxRetries: { "rate-limit": 1, server: 1, network: 1, overloaded: 1 },
    backoff: { baseMs: 1, factor: 2, maxMs: 5, jitter: 0 },
    concurrency: 1,
    circuitBreaker: { threshold: 100, resetMs: 1000 },
    ...overrides,
  };
}

// Native source fixture; the client owns privacy admission.
const MESSAGES = ({ input: "Hi" });

// ── 13 error types ────────────────────────────────────────────────────────

test("v2: ALL_ERROR_TYPES lists exactly 13 types", () => {
  assert.equal(ALL_ERROR_TYPES.length, 13);
  assert.deepEqual([...ALL_ERROR_TYPES], [
    "rate-limit", "server", "network", "auth", "bad-request", "model-not-found",
    "context-too-long", "truncation", "invalid-response", "timeout", "empty-response",
    "streaming", "overloaded",
  ]);
});

test("v2: every error subclass has the right code + errorType + retryable", () => {
  const cases: ReadonlyArray<{ make: () => LLMError; code: string; errorType: string; retryable: boolean; status?: number }> = [
    { make: () => new RateLimitError("m", 1000), code: "llm_rate_limited", errorType: "rate-limit", retryable: true },
    { make: () => new ServerError("m", 500), code: "llm_server_error", errorType: "server", retryable: true, status: 500 },
    { make: () => new OverloadedError("m"), code: "llm_overloaded", errorType: "overloaded", retryable: true },
    { make: () => new NetworkError("m"), code: "llm_network_error", errorType: "network", retryable: true },
    { make: () => new AuthError("m", 401), code: "llm_auth_error", errorType: "auth", retryable: false, status: 401 },
    { make: () => new BadRequestError("m"), code: "llm_bad_request", errorType: "bad-request", retryable: false },
    { make: () => new ModelNotFoundError("m"), code: "llm_model_not_found", errorType: "model-not-found", retryable: false },
    { make: () => new ContextTooLongError("m", {}, 100, 50), code: "llm_context_too_long", errorType: "context-too-long", retryable: false },
    { make: () => new TruncationError("m"), code: "llm_truncation", errorType: "truncation", retryable: false },
    { make: () => new InvalidResponseError("m"), code: "llm_invalid_response", errorType: "invalid-response", retryable: true },
    { make: () => new TimeoutError("m"), code: "llm_timeout", errorType: "timeout", retryable: false },
    { make: () => new EmptyResponseError("m"), code: "llm_empty_response", errorType: "empty-response", retryable: true },
    { make: () => new StreamingError("m"), code: "llm_streaming_error", errorType: "streaming", retryable: true },
  ];
  assert.equal(cases.length, 13);
  for (const c of cases) {
    const e = c.make();
    assert.equal(e.code, c.code, `${c.code}: code`);
    assert.equal(e.errorType, c.errorType, `${c.code}: errorType`);
    assert.equal(e.retryable, c.retryable, `${c.code}: retryable`);
    assert.equal(e.status, c.status, `${c.code}: only observed status`);
    assert.ok(isLLMError(e));
    assert.ok(Object.isFrozen(e.safeDetails), `${c.code}: safeDetails frozen`);
  }
});

test("v2: RateLimitError carries retryAfterMs", () => {
  const e = new RateLimitError("m", 5000);
  assert.equal(e.retryAfterMs, 5000);
});

test("v2: ContextTooLongError carries token counts + parseContextTooLong", () => {
  const parsed = parseContextTooLong("This model's maximum context length is 8192 tokens. However, your messages resulted in 12345 tokens.");
  assert.deepEqual(parsed, { promptTokens: 12345, maxTokens: 8192 });
  assert.equal(parseContextTooLong("no numbers here"), null);
  const e = new ContextTooLongError("m", {}, 12345, 8192);
  assert.equal(e.promptTokens, 12345);
  assert.equal(e.maxTokens, 8192);
});

// ── Config resolution + validation ────────────────────────────────────────

test("v2: resolveLLMConfig applies defaults and validates", () => {
  const r = resolveLLMConfig({ baseUrl: "https://api.test.com/v1", apiKey: "sk-key", allowPrivateAddress: false, model: "m" });
  assert.equal(r.error, null);
  assert.equal(r.config!.timeoutMs, 120_000);
  assert.equal(r.config!.concurrency, 5);
  assert.equal(r.config!.failover.enabled, false);
  assert.deepEqual(r.config!.maxRetries["rate-limit"], DEFAULT_MAX_RETRIES["rate-limit"]);
  assert.deepEqual(r.config!.backoff, DEFAULT_BACKOFF);
});

test("v2: validateLLMConfig rejects bad inputs deterministically", () => {
  assert.match(validateLLMConfig({ baseUrl: "", apiKey: "k", allowPrivateAddress: false, model: "m" })!, /baseUrl/);
  assert.match(validateLLMConfig({ baseUrl: "ftp://x", apiKey: "k", allowPrivateAddress: false, model: "m" })!, /baseUrl/);
  assert.match(validateLLMConfig({ baseUrl: "https://x", apiKey: "", allowPrivateAddress: false, model: "m" })!, /apiKey/);
  assert.match(validateLLMConfig({ baseUrl: "https://x", apiKey: "k", allowPrivateAddress: false, model: "" })!, /model/);
  assert.match(validateLLMConfig({ baseUrl: "https://x", apiKey: "k", allowPrivateAddress: false, model: "m", requestDefaults: { temperature: 5 } })!, /defaults/);
  assert.match(validateLLMConfig({ baseUrl: "https://x", apiKey: "k", allowPrivateAddress: false, model: "m", concurrency: 0 })!, /concurrency/);
  assert.match(validateLLMConfig({ baseUrl: "https://x", apiKey: "k", allowPrivateAddress: false, model: "m", failover: { enabled: "yes" as unknown as boolean } as never })!, /failover/);
});

test("v2: DEFAULT_FAILOVER is off by default", () => {
  assert.equal(DEFAULT_FAILOVER.enabled, false);
});

// ── Circuit breaker ───────────────────────────────────────────────────────

test("v2: CircuitBreaker opens after threshold failures and half-opens after reset", () => {
  const cb = new CircuitBreaker(3, 1000);
  assert.equal(cb.getState(), "closed");
  cb.recordFailure(); cb.recordFailure();
  assert.equal(cb.getState(), "closed");
  cb.recordFailure();
  assert.equal(cb.getState(), "open");
  assert.equal(cb.allow(), false);
  // After resetMs, transitions to half-open and allows one trial.
  const future = Date.now() + 2000;
  assert.equal(cb.allow(future), true);
  assert.equal(cb.getState(), "half-open");
  cb.recordSuccess();
  assert.equal(cb.getState(), "closed");
  // Half-open failure re-opens.
  cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
  assert.equal(cb.getState(), "open");
  const snap = cb.snapshot();
  assert.equal(snap.threshold, 3);
  assert.equal(snap.resetMs, 1000);
});

test("v2: CircuitBreaker rejects bad construction", () => {
  assert.throws(() => new CircuitBreaker(0, 1000));
  assert.throws(() => new CircuitBreaker(3, 0));
});

// ── Queue ────────────────────────────────────────────────────────────────

test("v2: RequestQueue bounds concurrency in FIFO order", async () => {
  const q = new RequestQueue({ maxConcurrency: 2 });
  const order: string[] = [];
  const req = { model: "m", provider: "p" };
  const a = q.run(req, async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 20)); order.push("a-end"); });
  const b = q.run(req, async () => { order.push("b-start"); await new Promise((r) => setTimeout(r, 5)); order.push("b-end"); });
  const c = q.run(req, async () => { order.push("c-start"); order.push("c-end"); });
  await Promise.all([a, b, c]);
  // a and b start together (concurrency 2); c waits for a slot.
  assert.equal(order[0], "a-start");
  assert.equal(order[1], "b-start");
  assert.ok(order.indexOf("c-start") > 1, "c must start after a or b releases a slot");
  assert.equal(q.maxConcurrencyValue(), 2);
});

// ── Stats (per-model + per-provider) ──────────────────────────────────────

test("v2: LLMStatsCollector tracks per-model + per-provider + failover", () => {
  const s = new LLMStatsCollector();
  s.recordRequest("gemma", "neuralwatt");
  s.recordRequest("gemma", "neuralwatt");
  s.recordError("rate-limit", "gemma", "neuralwatt");
  s.recordTokens({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }, "gemma", "neuralwatt");
  s.recordLatency(100, "gemma", "neuralwatt");
  s.recordFailover("rate-limit");
  const snap = s.snapshot(false);
  assert.equal(snap.totalRequests, 2);
  assert.equal(snap.totalErrors, 1);
  assert.equal(snap.totalTokens.total, 15);
  assert.equal(snap.byModel.gemma?.requests, 2);
  assert.equal(snap.byProvider.neuralwatt?.errors, 1);
  assert.equal(snap.failovers, 1);
  assert.equal(snap.lastFailoverReason, "rate-limit");
});

// ── Failover selector ────────────────────────────────────────────────────

test("v2: FailoverSelector disabled by default (single target)", () => {
  const cfg = resolveLLMConfig({ baseUrl: "https://x", apiKey: "k", allowPrivateAddress: false, model: "m" }).config!;
  const f = new FailoverSelector(cfg);
  assert.equal(f.enabled(), false);
  assert.equal(f.targetsCount(), 1);
  assert.equal(f.current().model, "m");
});

test("v2: FailoverSelector enabled with multi-model + multi-provider", () => {
  const cfg = resolveLLMConfig({
    baseUrl: "https://x", apiKey: "k", allowPrivateAddress: false, model: "gemma", providerId: "p",
    failover: { enabled: true, models: ["gemma", "qwen"], providers: ["neuralwatt", "openai"], strategy: "round-robin" },
    providers: [
      { id: "neuralwatt", baseUrl: "https://neuralwatt/v1", apiKey: "k1" },
      { id: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k2" },
    ],
  }).config!;
  const f = new FailoverSelector(cfg);
  assert.equal(f.enabled(), true);
  assert.equal(f.targetsCount(), 4); // 2 models × 2 providers
  const first = f.current();
  assert.equal(first.model, "gemma");
  assert.equal(first.providerId, "neuralwatt");
  f.next();
  assert.equal(f.current().model, "gemma");
  assert.equal(f.current().providerId, "openai");
  f.next();
  assert.equal(f.current().model, "qwen");
  assert.ok(f.shouldFailover("rate-limit"));
  assert.equal(f.shouldFailover("auth"), false, "auth is not a trigger");
});

test("v2: FailoverSelector least-latency picks the fastest target", () => {
  const cfg = resolveLLMConfig({
    baseUrl: "https://x", apiKey: "k", allowPrivateAddress: false, model: "gemma", providerId: "p",
    failover: { enabled: true, models: ["gemma", "qwen"], providers: ["p"], strategy: "least-latency" },
  }).config!;
  const f = new FailoverSelector(cfg);
  f.recordLatency(0, 500);
  f.recordLatency(1, 50);
  f.next();
  assert.equal(f.current().model, "qwen", "least-latency should pick the 50ms target");
});

// ── Client happy paths (mock fetch) ───────────────────────────────────────

test("v2: complete returns content + usage + model", async () => {
  const client = new SharedLLMClient(baseConfig({
    ...(mockFetchJson("Hello", "gemma-4-31b", { input_tokens: 5, output_tokens: 3, total_tokens: 8 })),
  }) as never);
  const r = await client.create(({ ...MESSAGES, model: "gemma-4-31b"  }), {});
  assert.equal(r.content, "Hello");
  assert.equal(r.model, "gemma-4-31b");
  assert.equal(r.usage?.totalTokens, 8);
  assert.equal(r.finishReason, "stop");
  assert.equal(r.truncated, false);
  assert.equal(r.retries, 0);
});

test("v2: stream yields content + headers + finish chunks", async () => {
  const client = new SharedLLMClient(baseConfig({
    ...(mockFetchSse("Streamed", "gemma-4-31b")),
  }) as never);
  const chunks: string[] = [];
  for await (const c of client.stream(({ ...MESSAGES, model: "gemma-4-31b"  }), {})) {
    if (c.type === "content") chunks.push(c.text);
    if (c.type === "headers") assert.ok(c.headers["x-model-id"] === "gemma-4-31b");
  }
  assert.deepEqual(chunks, ["Streamed"]);
});

test("v2: getStats / getCircuit / getQueue expose the v2 signals", async () => {
  const client = new SharedLLMClient(baseConfig({
    ...(mockFetchJson("ok", "m")),
  }) as never);
  await client.create(({ ...MESSAGES, model: "m"  }), {});
  const stats = client.getStats();
  assert.equal(stats.totalRequests, 1);
  assert.equal(stats.byModel.m?.requests, 1);
  assert.equal(stats.circuitOpen, false);
  const circuit = client.getCircuit();
  assert.equal(circuit.state, "closed");
  const queue = client.getQueue();
  assert.equal(queue.maxConcurrency, 1);
  assert.equal(queue.active, 0);
});

test("v2: 429 retries rate-limit budget then throws RateLimitError", async () => {
  const client = new SharedLLMClient(baseConfig({
    ...(mockFetchStatus(429, "rate limited", { "retry-after": "0" })),
    maxRetries: { "rate-limit": 2 },
  }) as never);
  await assert.rejects(
    async () => client.create(({ ...MESSAGES, model: "m"  }), {}),
    (e: unknown) => isLLMError(e) && (e as LLMError).code === "llm_rate_limited",
  );
  // 1 initial + 2 retries → totalRetries === 2 (totalRequests counts calls, not attempts).
  assert.equal(client.getStats().totalRetries, 2);
});

test("v2: 401 auth error is non-retryable (one attempt)", async () => {
  const client = new SharedLLMClient(baseConfig({
    ...(mockFetchStatus(401, "Unauthorized")),
  }) as never);
  await assert.rejects(
    async () => client.create(({ ...MESSAGES, model: "m"  }), {}),
    (e: unknown) => isLLMError(e) && (e as LLMError).code === "llm_auth_error" && !(e as LLMError).retryable,
  );
  assert.equal(client.getStats().totalRequests, 1);
});

test("v2: 400 + context_length_exceeded → ContextTooLongError with token counts", async () => {
  const body = "This model's maximum context length is 8192 tokens. However, your messages resulted in 12345 tokens.";
  const client = new SharedLLMClient(baseConfig({
    ...(mockFetchStatus(400, body)),
  }) as never);
  await assert.rejects(
    async () => client.create(({ ...MESSAGES, model: "m"  }), {}),
    (e: unknown) => {
      if (!isLLMError(e)) return false;
      const err = e as ContextTooLongError;
      return err.code === "llm_context_too_long" && err.promptTokens === 12345 && err.maxTokens === 8192;
    },
  );
});

test("v2: 404 → ModelNotFoundError (non-retryable)", async () => {
  const client = new SharedLLMClient(baseConfig({
    ...(mockFetchStatus(404, "Not Found")),
  }) as never);
  await assert.rejects(
    async () => client.create(({ ...MESSAGES, model: "m"  }), {}),
    (e: unknown) => isLLMError(e) && (e as LLMError).code === "llm_model_not_found" && !(e as LLMError).retryable,
  );
});

test("v2: 529 → OverloadedError with longer backoff (overloaded multiplier)", async () => {
  const client = new SharedLLMClient(baseConfig({
    ...(mockFetchStatus(529, "overloaded")),
    maxRetries: { overloaded: 1 },
    backoff: { baseMs: 10, factor: 2, maxMs: 100, jitter: 0 },
  }) as never);
  await assert.rejects(
    async () => client.create(({ ...MESSAGES, model: "m"  }), {}),
    (e: unknown) => isLLMError(e) && (e as LLMError).code === "llm_overloaded",
  );
  assert.equal(client.getStats().totalRetries, 1);
});

test("v2: network error (ECONNREFUSED) is retried; persistent throws NetworkError", async () => {
  const client = new SharedLLMClient(baseConfig({
    // The upstream drops the connection: what a refused/reset network gives the client.
    ...upstream(() => { throw new TypeError("connection dropped"); }),
    maxRetries: { network: 2 },
  }) as never);
  await assert.rejects(
    async () => client.create(({ ...MESSAGES, model: "m"  }), {}),
    (e: unknown) => isLLMError(e) && (e as LLMError).code === "llm_network_error",
  );
  assert.equal(client.getStats().totalRetries, 2);
});

test("v2: a transport failure that is not a network one (a server that does not speak HTTP) → llm_unexpected_error (non-retryable, one attempt)", async () => {
  // Through the door's REAL transport: a peer answering bytes that are not
  // HTTP is a parse failure of the client, not a refused/reset network.
  const { createServer } = await import("node:net");
  let connections = 0;
  const garbage = createServer((socket) => { connections++; socket.end("NOT-HTTP garbage\r\n\r\n"); });
  await new Promise<void>((resolve) => garbage.listen(0, "127.0.0.1", resolve));
  try {
    const port = (garbage.address() as import("node:net").AddressInfo).port;
    const client = new SharedLLMClient(baseConfig({ baseUrl: `http://127.0.0.1:${port}/v1` }) as never);
    await assert.rejects(
      async () => client.create(({ ...MESSAGES, model: "m"  }), {}),
      (e: unknown) => isLLMError(e) && (e as LLMError).code === "llm_unexpected_error" && !(e as LLMError).retryable,
    );
    assert.equal(client.getStats().totalRequests, 1);
    assert.equal(connections, 1, "one attempt");
  } finally {
    garbage.close();
    garbage.unref();
  }
});

test("v2: timeout throws TimeoutError when fetch hangs past timeoutMs", async () => {
  // The upstream never answers; it lets go when the client goes away.
  const hang = (_url: string, init: UpstreamRequest) => new Promise<Response>((_resolve, reject) => {
    if (init.signal.aborted) { reject(new Error("aborted")); return; }
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const client = new SharedLLMClient(baseConfig({
    ...upstream(hang),
    timeout: 50,
    maxRetries: { timeout: 0 },
  }) as never);
  await assert.rejects(
    async () => client.create(({ ...MESSAGES, model: "m"  }), {}),
    (e: unknown) => isLLMError(e) && (e as LLMError).code === "llm_timeout",
  );
});

test("v2: empty response → EmptyResponseError (retryable)", async () => {
  // A 200 JSON response with empty content + no tool calls → EmptyResponseError.
  const emptyJson = JSON.stringify(responseResource({ model: "m", content: "", usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } }));
  const c2 = new SharedLLMClient(baseConfig({
    ...(mockFetchStatus(200, emptyJson, { "content-type": "application/json" })),
  }) as never);
  const result = await c2.create(MESSAGES);
  assert.equal(result.status, "completed");
  assert.equal(result.content, "");
});

test("v2: a reasoning-only completion exhausted at length is truncation, never a successful empty answer", async () => {
  let calls = 0;
  const client = new SharedLLMClient(baseConfig({ ...upstream(async () => {
    calls++;
    return new Response(JSON.stringify(responseResource({ model:"m", status:"incomplete", output:[], usage:{input_tokens:17,output_tokens:1,total_tokens:18} })), {headers:{"content-type":"application/json"}});
  }) }) as never);
  await assert.rejects(client.create(({ ...MESSAGES, max_output_tokens: 16 }), { truncateAsError: true }), (error: unknown) => {
    assert.ok(error instanceof TruncationError);
    assert.match(error.message, /limits/);
    assert.doesNotMatch(error.message, /private reasoning/);
    return true;
  });
  assert.equal(calls,1);
});

test("v2: truncateAsError treats finish_reason=length as TruncationError", async () => {
  const sse = responsesSse({ content: "hi", model: "m", status: "incomplete" });
  const client = new SharedLLMClient(baseConfig({ ...upstream(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } })), maxRetries: { truncation: 0 } }) as never);
  await assert.rejects(
    async () => {
      for await (const _ of client.stream(({ ...MESSAGES, model: "m" }), {truncateAsError: true})) { /* drain */ }
    },
    (e: unknown) => isLLMError(e) && (e as LLMError).code === "llm_truncation",
  );
});

test("v2: circuit opens after threshold consecutive failures", async () => {
  const client = new SharedLLMClient(baseConfig({
    ...(mockFetchStatus(500, "err")),
    maxRetries: { server: 0 },
    circuitBreaker: { threshold: 2, resetMs: 1000 },
  }) as never);
  // First call: 1 server failure → circuit consecutiveFailures = 1 (closed).
  await assert.rejects(async () => client.create(({ ...MESSAGES, model: "m"  }), {}));
  // Second call: another failure → consecutiveFailures = 2 → open.
  await assert.rejects(async () => client.create(({ ...MESSAGES, model: "m"  }), {}));
  assert.equal(client.getCircuit().state, "open");
  // Third call: circuit open → throws llm_circuit_open without a request.
  await assert.rejects(
    async () => client.create(({ ...MESSAGES, model: "m"  }), {}),
    (e: unknown) => isLLMError(e) && (e as LLMError).code === "llm_circuit_open",
  );
});

test("native client snapshots raw input before first stream pull", async () => {
  for (const content of ["benign prefix original text suffix", "prefix sk-test-key-1234567890 suffix"]) {
    let sent: {input: unknown};
    const client = new SharedLLMClient(baseConfig({ ...upstream(async (_url, init) => { sent = JSON.parse(String(init.body)); return responseSseResponse({ content: "done" }); }) }));
    const source = { input: [{ role: "user" as const, content }] };
    const stream = client.stream(source);
    source.input[0]!.content = "mutated after call";
    for await (const chunk of stream) void chunk;
    assert.deepEqual(sent!.input, [{role:"user", content: content.startsWith("benign") ? content : "prefix [REDACTED:secret] suffix"}]);
  }
});

// Discovery uses the same HTTP/error owner, with one deadline covering the
// response body as well as headers. These exercise real abortable sockets.
test("model discovery bounds the whole request and distinguishes cancellation", async (t) => {
  const { createServer } = await import("node:http");
  const { fetchProviderModels } = await import("../../src/shared/llm/client.ts");
  const observed: string[]=[]; let holding="";
  const receipts = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>(), readers = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const server=createServer((req,res)=>{
    observed.push(req.url!); holding=req.url!; receipts.get(req.url!)?.resolve();
    if(req.url==="/headers/models") return;
    if(req.url==="/body/models" || req.url==="/error-body/models") {res.writeHead(req.url.startsWith("/error")?401:200,{"content-type":"application/json"});res.write("{");return;}
    if(req.url==="/oversize/models") {res.end("x".repeat(200));return;}
    if(req.url==="/error-limit/models") {res.writeHead(401);res.end("x".repeat(200));return;}
    if(req.url==="/redirect/models") {res.writeHead(302,{location:"/good/models"});res.end();return;}
    res.end(JSON.stringify({object:"list",data:[{id:"test"}]}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  // Closed even when the test is cancelled at its timeout (a `finally` of a never-settling body never runs).
  t.after(()=>{server.closeAllConnections();server.close();});
  const address=server.address();assert(address && typeof address!=="string");
  const root="http://127.0.0.1:"+address.port;
  const timeoutMs = baseConfig().timeout!;
  // One request is in flight at a time: a door body read is the one the server is holding.
  onDoorBodyReader(t, () => readers.get(holding)?.resolve());
  const query=(path:string,signal?:AbortSignal)=>fetchProviderModels({baseUrl:root+path,providerId:"test",apiKey:"test-only",headers:{},timeoutMs,maxBytes:100,transport:TEST_TRANSPORT,allowPrivateAddress:true,...(signal === undefined ? {} : {signal})});
  mockDoorClock(t);
  try {
    assert.deepEqual(await query("/good"),{object:"list",data:[{id:"test"}]});
    for(const path of ["/headers","/body","/error-body"]) {
      const entered = Promise.withResolvers<void>(); (path === "/headers" ? receipts : readers).set(path+"/models", entered);
      const rejected = assert.rejects(query(path), error=>error instanceof TimeoutError && !error.message.includes("caller"));
      await entered.promise; t.mock.timers.tick(timeoutMs); await rejected;
    }
    const cancel=new AbortController();const request=query("/body",cancel.signal);cancel.abort();
    await assert.rejects(request,error=>error instanceof LLMError && error.code==="llm_cancelled");
    await assert.rejects(query("/oversize"),error=>error instanceof InvalidResponseError && error.code==="llm_invalid_response" && error.message.includes("byte bound"));
    await assert.rejects(query("/error-limit"),error=>error instanceof AuthError && error.message.includes("byte bound"));
    const before=observed.length;
    // The outbound policy refuses a redirect by name (never follows it, never a bare network failure).
    await assert.rejects(query("/redirect"),error=>error instanceof LLMError && error.code==="outbound_redirect_refused" && error.errorType==="bad-request" && !error.retryable);
    assert.deepEqual(observed.slice(before),["/redirect/models"],"credentials must not follow a redirect");
    assert.equal(observed.filter(path=>path==="/headers/models").length,1,"no adaptive retry");
  } finally {t.mock.timers.reset();}
});

test("nonstreaming completions retain one deadline through body read and release it on success", async (t) => {
  const {createServer}=await import("node:http");
  let calls=0, holding="";
  const receipts = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>(), readers = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const server=createServer((req,res)=>{
    calls++; holding=req.url!; receipts.get(req.url!)?.resolve();
    if(req.url==="/headers/responses")return;
    if(req.url==="/body/responses"){res.writeHead(200,{"content-type":"application/json"});res.write("{");return;}
    res.end(JSON.stringify(responseResource({content:"done"})));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  // Closed even when the test is cancelled at its timeout (a `finally` of a never-settling body never runs).
  t.after(()=>{server.closeAllConnections();server.close();});
  const address=server.address();assert(address&&typeof address!=="string");
  const baseUrl="http://127.0.0.1:"+address.port;
  const timeout = baseConfig().timeout!;
  // One request is in flight at a time: a door body read is the one the server is holding.
  onDoorBodyReader(t, () => readers.get(holding)?.resolve());
  const client=(path:string)=>new SharedLLMClient(baseConfig({baseUrl:baseUrl+path,timeout,maxRetries:Object.fromEntries(ALL_ERROR_TYPES.map(type=>[type,0]))}));
  mockDoorClock(t);
  try {
    for(const path of ["/headers","/body"]){
      const before=calls;
      const entered = Promise.withResolvers<void>(); (path === "/headers" ? receipts : readers).set(path+"/responses", entered);
      const rejected = assert.rejects(client(path).create(MESSAGES),error=>error instanceof TimeoutError&&error.code==="llm_timeout"&&!error.message.includes("caller"));
      await entered.promise; t.mock.timers.tick(timeout); await rejected;
      assert.equal(calls-before,1);
    }
    const cancel=new AbortController();const pending=client("/body").create(MESSAGES,{signal:cancel.signal});cancel.abort();
    await assert.rejects(pending,error=>error instanceof LLMError&&error.code==="llm_cancelled");
    // Every abort signal the request path listens on, captured through the
    // real transport (the door's request lifetime is one of them).
    const watched=new Set<AbortSignal>();
    const listen=EventTarget.prototype.addEventListener;
    t.mock.method(EventTarget.prototype,"addEventListener",function(this:EventTarget,type:string,...rest:unknown[]){if(this instanceof AbortSignal&&type==="abort")watched.add(this);return (listen as (...a:unknown[])=>void).call(this,type,...rest);});
    const completed=await client("/good").create(MESSAGES);
    (EventTarget.prototype.addEventListener as unknown as {mock:{restore():void}}).mock.restore();
    assert.equal(completed.content,"done");assert(watched.size>0,"the request path listened on its lifetime");
    t.mock.timers.tick(timeout + 1);
    assert.deepEqual([...watched].filter(signal=>signal.aborted),[],"early success clears the deadline instead of leaving scheduled abort work");
  }finally{t.mock.timers.reset();}
});

test("Public abort projection preserves private reason identity but never copies its diagnostics", async () => {
  const { checkAborted } = await import("../../src/shared/llm/provider-http.ts");
  const genuine = new DOMException("private-abort-canary", "TimeoutError");
  Object.defineProperty(genuine, "name", { get() { throw "private-abort-canary"; } });
  const cases: readonly [unknown, string][] = [
    ["private-abort-canary", "llm_cancelled"], [new Error("private-abort-canary"), "llm_cancelled"],
    [new NetworkError("private-abort-canary", { responseId: "private-abort-canary" }), "llm_cancelled"],
    [new LLMError("private-abort-canary", "private-abort-canary", "timeout", true, { detail: "private-abort-canary" }, 503), "llm_cancelled"],
    [new TimeoutError("private-abort-canary", { detail: "private-abort-canary" }), "llm_timeout"],
    [new DOMException("private-abort-canary", "TimeoutError"), "llm_timeout"], [genuine, "llm_timeout"],
    [{ name: "TimeoutError", message: "private-abort-canary" }, "llm_cancelled"],
    [Object.create(DOMException.prototype), "llm_cancelled"],
    [new Proxy({}, { getPrototypeOf() { throw new Error("private-abort-canary"); } }), "llm_cancelled"],
  ];
  for (const [reason, code] of cases) {
    const signal = AbortSignal.abort(reason);
    assert.equal(signal.reason, reason);
    assert.throws(() => checkAborted(signal), error => {
      assert.ok(error instanceof LLMError); assert.equal(error.code, code); assert.notEqual(error, reason);
      assert.equal(error.retryable, false); assert.deepEqual(error.safeDetails, {}); assert.equal(error.cause, undefined); assert.equal(error.status, undefined);
      assert.equal(JSON.stringify(error).includes("private-abort-canary"), false); assert.equal(error.message.includes("private-abort-canary"), false);
      return true;
    });
  }
});

test("Direct model discovery abort uses the same safe reason projection before and during body reads", async () => {
  const { fetchProviderModels } = await import("../../src/shared/llm/client.ts");
  for (const phase of ["before", "body"] as const) {
    const controller = new AbortController(), entered = Promise.withResolvers<void>(); let calls = 0;
    const reason = new NetworkError("private-catalog-reason", { detail: "private-catalog-reason" });
    if (phase === "before") controller.abort(reason);
    serve(async () => { calls++; return new Response(new ReadableStream({ pull() { entered.resolve(); } })); });
    const operation = fetchProviderModels({ baseUrl: address("https://discovery.test/v1"), apiKey: "inert-key", providerId: "test", headers: {}, timeoutMs: 1000, maxBytes: 1000, transport: TEST_TRANSPORT,
      allowPrivateAddress: true, signal: controller.signal });
    const outcome = assert.rejects(operation, error => error instanceof LLMError && error.code === "llm_cancelled" && error !== reason && !JSON.stringify(error).includes("private-catalog-reason"));
    if (phase === "body") { await entered.promise; controller.abort(reason); }
    await outcome; assert.equal(calls, phase === "before" ? 0 : 1); assert.equal(controller.signal.reason, reason);
  }
});
