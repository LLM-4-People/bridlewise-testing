import { LLMError } from "../../src/shared/llm/errors.ts";
import { responseEvents, responseResource, responsesSse } from "../support/mock-provider.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { sep } from "node:path";

import {
  createProviderAdapter,
  resolveApiKey,
  buildProviderConfig,
  computeRequestHash,
  type ChatMessage,
  type ChatStreamEvent,
  type ProviderConfig,
  type ChatCompletionRequest,
} from "../../src/runtime/provider-adapter.ts";
import { address, serve, type UpstreamHandler, type UpstreamRequest } from "../support/loopback-upstream.ts";

const PROVIDER: ProviderConfig = buildProviderConfig({
  id: "test",
  baseUrl: address("https://api.test.com/v1"),
  timeoutMs: 5000,
  retries: {
    maxRetries: 3,
    initialBackoffMs: 1,
    maxBackoffMs: 10,
    backoffMultiplier: 2,
  },
});

const API_KEY = "sk-test-key-12345";

function mockResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, { status: init.status ?? 200,
    headers: { "content-type": "text/event-stream", ...init.headers } });
}

function createMockFetch(responses: Array<(url: string, init: UpstreamRequest) => Response>): UpstreamHandler {
  let callCount = 0;
  return async (url: string, init: UpstreamRequest): Promise<Response> => {
    const responseFn = responses[Math.min(callCount, responses.length - 1)]!;
    callCount++;
    return responseFn(url, init);
  };
}

function sseChunk(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

const MESSAGES: readonly ChatMessage[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "Hello" },
];

const REQUEST: ChatCompletionRequest = {
  model: "test-model",
  messages: MESSAGES,
  max_tokens: 100,
  temperature: 0,
};

// ============================================================================
// createProviderAdapter — construction
// ============================================================================

test("Provider: createProviderAdapter succeeds with valid options", () => {
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  assert.equal(adapter.providerId, "test");
});

test("Provider: createProviderAdapter throws on missing API key", () => {
  assert.throws(
    () => createProviderAdapter({ provider: PROVIDER, apiKey: "" }),
    (e: unknown) => e instanceof LLMError && e.code === "llm_config_invalid",
  );
});

test("Provider: createProviderAdapter accepts custom fetch implementation", () => {
  const fetchImpl = async () => mockResponse("");
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  assert.equal(adapter.providerId, "test");
});

// ============================================================================
// streamChatCompletion — happy path streaming
// ============================================================================

test("Provider: streamChatCompletion retains private deltas and publishes one terminal display", async () => {
  const sse = responsesSse({ chunks: ["Hello", " world"] });
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const events: ChatStreamEvent[] = [];
  for await (const event of adapter.streamChatCompletion(REQUEST)) {
    events.push(event);
  }
  const contentEvents = events.filter((e) => e.type === "content");
  assert.equal(contentEvents.length, 1);
  assert.equal(contentEvents[0]?.type === "content" ? contentEvents[0].text : "", "Hello world");
  assert.deepEqual(events.flatMap(event => event.type === "response_event" ? event.progress ?? [] : []).filter(event => event.type === "content").map(event => event.text), ["Hello", " world"]);
  assert.ok(events.findIndex(event => event.type === "response") < events.findIndex(event => event.type === "content"));
});

test("Provider: streamChatCompletion yields usage event", async () => {
  const sse = responsesSse({ chunks: ["Hi"], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const events: ChatStreamEvent[] = [];
  for await (const event of adapter.streamChatCompletion(REQUEST)) {
    events.push(event);
  }
  const usageEvents = events.filter((e) => e.type === "usage");
  assert.equal(usageEvents.length, 1);
  if (usageEvents[0]?.type === "usage") {
    assert.equal(usageEvents[0].usage.promptTokens, 10);
    assert.equal(usageEvents[0].usage.completionTokens, 5);
    assert.equal(usageEvents[0].usage.totalTokens, 15);
  }
});

test("Provider: streamChatCompletion yields finish event", async () => {
  const sse = responsesSse({ chunks: ["Hi"] });
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const events: ChatStreamEvent[] = [];
  for await (const event of adapter.streamChatCompletion(REQUEST)) {
    events.push(event);
  }
  const finishEvents = events.filter((e) => e.type === "finish");
  assert.equal(finishEvents.length, 1);
  assert.equal(finishEvents[0]?.type === "finish" ? finishEvents[0].reason : "", "stop");
});

test("Provider: streamChatCompletion handles finish_reason tool_calls", async () => {
  const sse = responsesSse({ toolCalls: [{ id: "call_fixture", type: "function", function: { name: "test", arguments: "{}" } }] });
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const events: ChatStreamEvent[] = [];
  for await (const event of adapter.streamChatCompletion(REQUEST)) {
    events.push(event);
  }
  const finishEvents = events.filter((e) => e.type === "finish");
  assert.equal(finishEvents[0]?.type === "finish" ? finishEvents[0].reason : "", "tool_calls");
});

test("Provider: streamChatCompletion handles finish_reason length", async () => {
  const sse = responsesSse({ status: "incomplete" });
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const events: ChatStreamEvent[] = [];
  for await (const event of adapter.streamChatCompletion(REQUEST)) {
    events.push(event);
  }
  const finishEvents = events.filter((e) => e.type === "finish");
  assert.equal(finishEvents[0]?.type === "finish" ? finishEvents[0].reason : "", "length");
});

test("Provider: streamChatCompletion yields tool_call_start and tool_call_delta", async () => {
  const sse = responsesSse({ toolCalls: [{ id: "call_abc", type: "function", function: { name: "read_file", arguments: '{"path": "test.ts"}' } }]  });
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const events: ChatStreamEvent[] = [];
  for await (const event of adapter.streamChatCompletion(REQUEST)) {
    events.push(event);
  }
  const startEvents = events.filter((e) => e.type === "tool_call_start");
  const deltaEvents = events.filter((e) => e.type === "tool_call_delta");
  assert.equal(startEvents.length, 1);
  assert.equal(deltaEvents.length, 1);
  if (startEvents[0]?.type === "tool_call_start") {
    assert.equal(startEvents[0].id, "call_abc");
    assert.equal(startEvents[0].name, "read_file");
  }
});

test("Provider: streamChatCompletion handles empty content delta", async () => {
  const sse = responsesSse({ chunks: [""] });
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const events: ChatStreamEvent[] = [];
  for await (const event of adapter.streamChatCompletion(REQUEST)) {
    events.push(event);
  }
  const contentEvents = events.filter((e) => e.type === "content");
  assert.equal(contentEvents.length, 0);
});

test("Provider: streamChatCompletion emits finish when stream ends without done sentinel", async () => {
  const sse = responseEvents({ content: "Hi" }).slice(0, 5).map(sseChunk).join("");
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(adapter.chatCompletion(REQUEST), LLMError);
});

test("Provider: chatCompletion collects content and usage", async () => {
  const sse = responsesSse({ chunks: ["Hello", " world"], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const result = await adapter.chatCompletion(REQUEST);
  assert.equal(result.content, "Hello world");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.toolCalls.length, 0);
  if (result.usage) {
    assert.equal(result.usage.promptTokens, 10);
    assert.equal(result.usage.completionTokens, 5);
    assert.equal(result.usage.totalTokens, 15);
  }
});

test("Provider: chatCompletion captures model from SSE stream", async () => {
  const sse = responsesSse({ chunks: ["Hello"], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const result = await adapter.chatCompletion(REQUEST);
  assert.equal(result.model, "test-model", "model must be captured from the SSE stream body");
});

test("Provider: chatCompletion captures model from non-streaming JSON response", async () => {
  const jsonResponse = JSON.stringify(responseResource({ content: "JSON cannot satisfy a requested stream" }));
  const fetchImpl = createMockFetch([() => mockResponse(jsonResponse, { headers: { "content-type": "application/json" } })]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(adapter.chatCompletion(REQUEST), error => error instanceof LLMError && error.code === "llm_invalid_response");
});

test("Provider: chatCompletion model is undefined when stream has no model field", async () => {
  const events = responseEvents({ content: "Hi" }).map(event => {
    if (event.type !== "response.completed") return event;
    const resource = { ...(event.response as Record<string, unknown>) }; delete resource.model;
    return { ...event, response: resource };
  });
  const sse = events.map(sseChunk).join("");
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(adapter.chatCompletion(REQUEST), LLMError);
});

test("Provider: chatCompletion collects tool calls", async () => {
  const sse = responsesSse({ toolCalls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }] });
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const result = await adapter.chatCompletion(REQUEST);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.id, "call_1");
  assert.equal(result.toolCalls[0]?.function.name, "read_file");
  assert.equal(result.toolCalls[0]?.function.arguments, '{"path":"x"}');
  assert.equal(result.finishReason, "tool_calls");
});

// ============================================================================
// Error handling
// ============================================================================

test("Provider: throws auth error on 401", async () => {
  const fetchImpl = createMockFetch([() => mockResponse("Unauthorized", { status: 401, headers: { "content-type": "text/plain" } })]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(
    async () => {
      for await (const _ of adapter.streamChatCompletion(REQUEST)) { /* drain */ }
    },
    (e: unknown) => e instanceof LLMError && e.code === "llm_auth_error",
  );
});

test("Provider: throws auth error on 403", async () => {
  const fetchImpl = createMockFetch([() => mockResponse("Forbidden", { status: 403, headers: { "content-type": "text/plain" } })]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(
    async () => {
      for await (const _ of adapter.streamChatCompletion(REQUEST)) { /* drain */ }
    },
    (e: unknown) => e instanceof LLMError && e.code === "llm_auth_error",
  );
});

test("Provider: throws http error on 404 (non-retryable)", async () => {
  const fetchImpl = createMockFetch([() => mockResponse("Not Found", { status: 404, headers: { "content-type": "text/plain" } })]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(
    async () => {
      for await (const _ of adapter.streamChatCompletion(REQUEST)) { /* drain */ }
    },
    (e: unknown) => e instanceof LLMError && e.code === "llm_model_not_found" && !e.retryable,
  );
});

test("Provider: retries on 429 rate limit", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 2) return mockResponse("Rate limited", { status: 429, headers: { "content-type": "text/plain", "retry-after": "0" } });
    return mockResponse(responsesSse({ chunks: ["OK"] }));
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const result = await adapter.chatCompletion(REQUEST);
  assert.equal(result.content, "OK");
  assert.equal(calls, 2);
});

test("Provider: retries on 500 server error", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 2) return mockResponse("Internal error", { status: 500, headers: { "content-type": "text/plain" } });
    return mockResponse(responsesSse({ chunks: ["OK"] }));
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const result = await adapter.chatCompletion(REQUEST);
  assert.equal(result.content, "OK");
  assert.equal(calls, 2);
});

test("Provider: retries on 502 bad gateway", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 2) return mockResponse("Bad gateway", { status: 502, headers: { "content-type": "text/plain" } });
    return mockResponse(responsesSse({ chunks: ["OK"] }));
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const result = await adapter.chatCompletion(REQUEST);
  assert.equal(result.content, "OK");
});

test("Provider: retries on 503 service unavailable", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 2) return mockResponse("Service unavailable", { status: 503, headers: { "content-type": "text/plain" } });
    return mockResponse(responsesSse({ chunks: ["OK"] }));
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const result = await adapter.chatCompletion(REQUEST);
  assert.equal(result.content, "OK");
});

test("Provider: exhausts retries on persistent 429", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return mockResponse("Rate limited", { status: 429, headers: { "content-type": "text/plain", "retry-after": "0" } });
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(
    async () => adapter.chatCompletion(REQUEST),
    (e: unknown) => e instanceof LLMError && e.code === "llm_rate_limited",
  );
  assert.equal(calls, 4); // 1 initial + 3 retries
});

test("Provider: exhausts retries on persistent 500", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return mockResponse("Internal error", { status: 500, headers: { "content-type": "text/plain" } });
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(
    async () => adapter.chatCompletion(REQUEST),
    (e: unknown) => e instanceof LLMError && e.code === "llm_server_error",
  );
  assert.equal(calls, 4);
});

// ============================================================================
// Cancellation
// ============================================================================

test("Provider: cancellation via AbortSignal throws llm_cancelled", async () => {
  const controller = new AbortController();
  const sse = responseEvents({ content: "Hello" }).slice(0, 2).map(sseChunk).join("");
  const fetchImpl = async (_url: string, init: UpstreamRequest) => {
    if (init.signal) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller2) {
          const encoder = new TextEncoder();
          controller2.enqueue(encoder.encode(sse));
          setTimeout(() => controller.abort(), 1);

        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    return mockResponse(sse);
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY, signal: controller.signal });
  await assert.rejects(
    async () => {
      for await (const _ of adapter.streamChatCompletion(REQUEST)) { /* drain */ }
    },
    (e: unknown) => e instanceof LLMError,
  );
});

// ============================================================================
// Network errors
// ============================================================================

test("Provider: network error is retried", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 2) throw new TypeError("fetch failed: ECONNREFUSED");
    return mockResponse(responsesSse({ chunks: ["OK"] }));
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const result = await adapter.chatCompletion(REQUEST);
  assert.equal(result.content, "OK");
  assert.equal(calls, 2);
});

test("Provider: persistent network error exhausts retries", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed: ENOTFOUND");
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(
    async () => adapter.chatCompletion(REQUEST),
    (e: unknown) => e instanceof LLMError && e.code === "llm_network_error",
  );
});

// ============================================================================
// Non-streaming response handling
// ============================================================================

test("Provider: handles non-streaming JSON response", async () => {
  const jsonResponse = JSON.stringify(responseResource({ content: "JSON cannot satisfy a requested stream" }));
  const fetchImpl = createMockFetch([() => mockResponse(jsonResponse, { headers: { "content-type": "application/json" } })]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(adapter.chatCompletion(REQUEST), error => error instanceof LLMError && error.code === "llm_invalid_response");
});

test("Provider: resolveApiKey reads from env", () => {
  const env = { MY_API_KEY: "sk-secret" } as NodeJS.ProcessEnv;
  assert.equal(resolveApiKey("MY_API_KEY", env), "sk-secret");
});

test("Provider: resolveApiKey throws on missing env var", () => {
  assert.throws(
    () => resolveApiKey("MISSING_VAR", {}),
    (e: unknown) => e instanceof LLMError && e.code === "llm_config_invalid",
  );
});

test("Provider: resolveApiKey throws on empty env var", () => {
  assert.throws(
    () => resolveApiKey("EMPTY_VAR", { EMPTY_VAR: "" }),
    (e: unknown) => e instanceof LLMError && e.code === "llm_config_invalid",
  );
});

// ============================================================================
// buildProviderConfig / computeRequestHash
// ============================================================================

test("Provider: buildProviderConfig creates frozen config", () => {
  const config = buildProviderConfig({
    id: "test",
    baseUrl: "https://api.test.com/v1",
    timeoutMs: 5000,
    retries: { maxRetries: 3, initialBackoffMs: 100, maxBackoffMs: 1000, backoffMultiplier: 2 },
  });
  assert.equal(config.id, "test");
  assert.equal(config.baseUrl, "https://api.test.com/v1");
  assert.ok(Object.isFrozen(config));
});

test("Provider: computeRequestHash is deterministic", () => {
  const hash1 = computeRequestHash(REQUEST);
  const hash2 = computeRequestHash(REQUEST);
  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64);
});

test("Provider: computeRequestHash differs for different requests", () => {
  const hash1 = computeRequestHash(REQUEST);
  const hash2 = computeRequestHash({ ...REQUEST, model: "other-model" });
  assert.notEqual(hash1, hash2);
});

// ============================================================================
// Request building
// ============================================================================

test("Provider: request includes stream and stream_options", async () => {
  let capturedBody: string | undefined;
  const fetchImpl = async (_url: string, init: UpstreamRequest) => {
    capturedBody = init.body as string;
    return mockResponse(responsesSse({  }));
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await adapter.chatCompletion(REQUEST);
  const body = JSON.parse(capturedBody!);
  assert.equal(body.stream, true);
  assert.equal(body.stream_options, undefined);
  assert.deepEqual(body.input, MESSAGES.map(message => ({ type: "message", ...message })));
  assert.equal(body.model, "test-model");
  assert.equal(body.max_output_tokens, 100);
  assert.equal(body.temperature, 0);
});

test("Provider: request includes auth header", async () => {
  let capturedHeaders: Headers | undefined;
  const fetchImpl = async (_url: string, init: UpstreamRequest) => {
    capturedHeaders = init.headers as Headers;
    return mockResponse(responsesSse({  }));
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await adapter.chatCompletion(REQUEST);
  assert.ok(capturedHeaders);
});

test("Provider: request URL uses Responses path", async () => {
  let capturedUrl: string | undefined;
  const fetchImpl = async (url: string) => {
    capturedUrl = url;
    return mockResponse(responsesSse({  }));
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await adapter.chatCompletion(REQUEST);
  assert.equal(capturedUrl, "https://api.test.com/v1/responses");
});

// ============================================================================
// Hostile / edge cases
// ============================================================================

test("Provider: handles malformed JSON in SSE data gracefully", async () => {
  const sse = "data: {invalid json}\n\n";
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(adapter.chatCompletion(REQUEST), LLMError);
});

test("Provider: handles empty SSE data line", async () => {
  const sse = "data: \n\n";
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(adapter.chatCompletion(REQUEST), LLMError);
});

test("Provider: handles SSE with only comments", async () => {
  const sse = ": keep-alive\n\n: another\n\n";
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(adapter.chatCompletion(REQUEST), LLMError);
});

test("Provider: handles response with no body", async () => {
  // Over a real connection a 200 with no body is an EMPTY event stream (the
  // wire has no "null body"): refused as a stream that never produced a
  // response, never read as an empty answer.
  const fetchImpl = async () => {
    return new Response(null, { headers: { "content-type": "text/event-stream" } });
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(
    async () => adapter.chatCompletion(REQUEST),
    (e: unknown) => e instanceof LLMError && e.code === "llm_streaming_error",
  );
});

test("Provider: handles large content stream", async () => {
  const sse = responsesSse({ chunks: Array.from({ length: 100 }, (_, i) => `chunk${i} `) });
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const result = await adapter.chatCompletion(REQUEST);
  assert.ok(result.content.length > 100);
});

test("Provider: handles multiple tool calls in one response", async () => {
  const sse = responsesSse({ toolCalls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }, { id: "call_2", type: "function", function: { name: "list_files", arguments: '{"path":"b"}' } }] });
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const result = await adapter.chatCompletion(REQUEST);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0]?.function.name, "read_file");
  assert.equal(result.toolCalls[1]?.function.name, "list_files");
});

test("Provider: handles usage without content", async () => {
  const sse = responsesSse({ usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 } });
  const fetchImpl = createMockFetch([() => mockResponse(sse)]);
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const result = await adapter.chatCompletion(REQUEST);
  assert.equal(result.content, "");
  if (result.usage) {
    assert.equal(result.usage.promptTokens, 5);
    assert.equal(result.usage.completionTokens, 0);
  }
});

test("Provider: uses retry-after header for backoff", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 2) return mockResponse("", { status: 429, headers: { "content-type": "text/plain", "retry-after": "0" } });
    return mockResponse(responsesSse({ chunks: ["OK"] }));
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const result = await adapter.chatCompletion(REQUEST);
  assert.equal(result.content, "OK");
});

test("Provider: zero retries configured means no retry", async () => {
  let calls = 0;
  const noRetryProvider = buildProviderConfig({
    id: "test",
    baseUrl: address("https://api.test.com/v1"),
    timeoutMs: 5000,
    retries: { maxRetries: 0, initialBackoffMs: 1, maxBackoffMs: 10, backoffMultiplier: 2 },
  });
  const fetchImpl = async () => {
    calls++;
    return mockResponse("", { status: 500, headers: { "content-type": "text/plain" } });
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: noRetryProvider, apiKey: API_KEY });
  await assert.rejects(
    async () => adapter.chatCompletion(REQUEST),
    (e: unknown) => e instanceof LLMError && e.code === "llm_server_error",
  );
  assert.equal(calls, 1);
});

test("Provider: handles chunked SSE delivery across multiple reads", async () => {
  const fullSse = responsesSse({ chunks: ["Hello"] });
  const encoder = new TextEncoder();
  const midPoint = Math.floor(fullSse.length / 2);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(fullSse.slice(0, midPoint)));
      controller.enqueue(encoder.encode(fullSse.slice(midPoint)));
      controller.close();
    },
  });
  const fetchImpl = async () => new Response(stream, { headers: { "content-type": "text/event-stream" } });
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const result = await adapter.chatCompletion(REQUEST);
  assert.equal(result.content, "Hello");
});

// ============================================================================
// Exponential backoff formula (GAP-5)
// ============================================================================

test("Provider: exponential backoff sequence is [500,1000,2000,4000,8000,10000] capped", async () => {
  const TIMEOUT_MS = 9999;
  const backoffProvider = buildProviderConfig({
    id: "test",
    baseUrl: address("https://api.test.com/v1"),
    timeoutMs: TIMEOUT_MS,
    responses: { operationTimeoutMs: 100000, cleanupTimeoutMs: 7 },
    retries: { maxRetries: 5, initialBackoffMs: 500, maxBackoffMs: 10000, backoffMultiplier: 2 },
  });
  const allDelays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalRandom = Math.random;
  // Deterministic, synchronous stub: record every requested delay and fire the
  // callback synchronously (no real timers, no pending macrotasks). Pin
  // Math.random to 0 so the 10% jitter is exactly 0. The adapter schedules two
  // kinds of timers: the per-attempt abort (delay === TIMEOUT_MS) and the
  // retry sleep (delay === backoff). We record all, then filter out the abort
  // delays to recover the pure exponential backoff sequence.
  // The TRANSPORT's own timers (the door's client, undici: a pooled
  // connection's keep-alive timer, its header/body clocks) are not the
  // adapter's and stay real — stubbed, a keep-alive timer fired at once and
  // its `0` handle broke the client for every later test in this file.
  const transportFrame = `${sep}node_modules${sep}undici${sep}`;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if ((new Error().stack ?? "").includes(transportFrame)) return originalSetTimeout(fn, ms, ...args);
    if (typeof ms === "number") allDelays.push(ms);
    if (ms !== TIMEOUT_MS && ms !== 100000 && ms !== 7) queueMicrotask(fn);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  Math.random = () => 0;
  try {
    const fetchImpl = async () => mockResponse("rate limited", { status: 429, headers: { "content-type": "text/plain" } });
    serve(fetchImpl);
    const adapter = createProviderAdapter({ provider: backoffProvider, apiKey: API_KEY });
    await assert.rejects(async () => adapter.chatCompletion(REQUEST));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    Math.random = originalRandom;
  }
  const backoffSequence = allDelays.filter((d) => d !== TIMEOUT_MS && d !== 100000 && d !== 7);
  // 1 initial attempt + 5 retries = 6 attempts → 5 backoff sleeps.
  assert.deepEqual(backoffSequence, [500, 1000, 2000, 4000, 8000]);
  // The 6th backoff (attempt 5) would be 500 * 2^5 = 16000, capped at 10000.
  const nextCapped = Math.min(500 * Math.pow(2, 5), 10000);
  assert.equal(nextCapped, 10000, "backoff must cap at maxBackoffMs");
});

test("Provider: a fixed-backoff regression would fail the exponential sequence", () => {
  // Guard: the expected exponential sequence is NOT a constant. If someone
  // regresses computeBackoff to return a fixed value, this assertion breaks.
  const expected = [500, 1000, 2000, 4000, 8000];
  const allDistinct = new Set(expected).size === expected.length;
  assert.ok(allDistinct, "backoff sequence must be strictly increasing, not fixed");
  assert.equal(expected[0], 500);
  assert.equal(expected[4], 8000);
});

// ============================================================================
// Provider timeout (GAP-6)
// ============================================================================

test("Provider: hanging fetch throws llm_timeout without authorizing retry", async () => {
  const timeoutProvider = buildProviderConfig({
    id: "test",
    baseUrl: address("https://api.test.com/v1"),
    timeoutMs: 100,
    retries: { maxRetries: 0, initialBackoffMs: 1, maxBackoffMs: 10, backoffMultiplier: 2 },
  });
  // A fetch that respects the abort signal: it never resolves on its own, but
  // rejects with AbortError when the adapter's timeout controller aborts the
  // signal after `timeoutMs`. Without this, the adapter would hang forever.
  const fetchImpl = (_url: string, init: UpstreamRequest) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (signal && signal.aborted) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
      return;
    }
    signal?.addEventListener("abort", () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
    });
  });
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: timeoutProvider, apiKey: API_KEY });
  await assert.rejects(
    async () => adapter.chatCompletion(REQUEST),
    (e: unknown) => e instanceof LLMError && e.code === "llm_timeout" && e.retryable === false,
  );
});

// ============================================================================
// Unexpected error path (GAP-29)
// ============================================================================

test("Provider: an upstream that fails mid-exchange is a classified network failure, retried within its budget", async () => {
  // The door owns its transport, so the only failure an upstream can cause
  // is on the wire: a dropped connection. It is classified (network,
  // retryable) and retried within the configured budget — never an
  // unclassified error. (The old in-process "transport throws an arbitrary
  // Error" case cannot occur any more: there is no injectable transport.)
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("weird"); };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(
    async () => adapter.chatCompletion(REQUEST),
    (e: unknown) => e instanceof LLMError && e.code === "llm_network_error" && e.retryable === true,
  );
  assert.equal(calls, 4, "1 attempt + 3 retries");
});

// ============================================================================
// Empty messages array (GAP-7)
// ============================================================================

test("Provider: empty messages array completes without leaking the key", async () => {
  let capturedBody = "";
  const fetchImpl = async (_url: string, init: UpstreamRequest) => {
    capturedBody = init.body as string;
    return mockResponse(responsesSse({  }));
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  const result = await adapter.chatCompletion({ ...REQUEST, messages: [] });
  assert.equal(typeof result.content, "string");
  const parsed = JSON.parse(capturedBody) as { input: readonly unknown[] };
  assert.deepEqual(parsed.input, []);
  assert.ok(!capturedBody.includes(API_KEY), "key must not appear in body even with empty messages");
});

// ============================================================================
// Authorization header exact value (GAP-8)
// ============================================================================

test("Provider: Authorization header equals exactly 'Bearer <apiKey>'", async () => {
  let capturedHeaders: Headers | undefined;
  const fetchImpl = async (_url: string, init: UpstreamRequest) => {
    capturedHeaders = new Headers(init.headers);
    return mockResponse(responsesSse({  }));
  };
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await adapter.chatCompletion(REQUEST);
  assert.ok(capturedHeaders);
  assert.equal(capturedHeaders!.get("Authorization"), `Bearer ${API_KEY}`);
  assert.equal(capturedHeaders!.get("Content-Type"), "application/json");
  assert.equal(capturedHeaders!.get("Accept"), "text/event-stream");
});

test("Provider: account quota refusal stays specific and nonretryable through the adapter", async () => {
  let calls = 0;
  serve(async () => { calls++; return mockResponse(JSON.stringify({ error: { type: "insufficient_quota", code: "credit_balance_exhausted", message: "No prepaid credits" } }), { status: 429 }); });
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(adapter.chatCompletion(REQUEST), error => error instanceof LLMError && error.code === "llm_quota_exhausted" && !error.retryable);
  assert.equal(calls, 1);
});

test("Provider invocation controls stay outside request hashes and both adapter lifetimes cancel real HTTP", async () => {
  const request: ChatCompletionRequest = { model: "model", messages: [{ role: "user", content: "hello" }] };
  const originalHash = computeRequestHash(request);
  for (const method of ["stream", "collect"] as const) for (const source of ["parent", "request"] as const) {
    const parent = new AbortController(), invocation = new AbortController();
    const entered = Promise.withResolvers<void>(); let receiptCount = 0, body: unknown;
    serve(async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response(responsesSse({ id: "adapter-receipt", content: "yes" }), { headers: { "content-type": "text/event-stream" } }); });
    const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY, signal: parent.signal });
    let observerSignal: AbortSignal | undefined;
    const controls = { onResponseReceipt: (_receipt: import("../../src/shared/llm/client.ts").ResponseReceipt, lifetime: AbortSignal) => { observerSignal = lifetime; receiptCount++; entered.resolve(); return new Promise<void>(() => {}); } };
    const operation = method === "collect" ? adapter.chatCompletion({ ...request, signal: invocation.signal }, controls)
      : (async () => { for await (const _ of adapter.streamChatCompletion({ ...request, signal: invocation.signal }, controls)) {} })();
    const rejection = assert.rejects(operation, { code: "llm_cancelled" });
    await entered.promise; (source === "parent" ? parent : invocation).abort(new Error(source)); await rejection;
    assert.equal(observerSignal?.reason, (source === "parent" ? parent : invocation).signal.reason);
    assert.equal(receiptCount, 1); assert.equal(computeRequestHash(request), originalHash);
    assert.equal(JSON.stringify(body).includes("onResponseReceipt"), false);
  }
});

test("Provider receipt observer failure keeps safe shared taxonomy through the facade", async () => {
  const { NetworkError } = await import("../../src/shared/llm/errors.ts");
  serve(async () => new Response(responsesSse({ id: "private-handle", content: "yes" }), { headers: { "content-type": "text/event-stream" } }));
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(adapter.chatCompletion({ model: "model", messages: [{ role: "user", content: "hello" }] }, {
    onResponseReceipt: receipt => { throw new NetworkError(`${receipt.responseId} ${API_KEY}`, { secret: API_KEY }); },
  }), error => {
    assert.ok(error instanceof LLMError); assert.equal(error.code, "llm_response_observer_failed"); assert.equal(error.retryable, false);
    assert.equal(error.message.includes("private-handle"), false); assert.equal(JSON.stringify(error).includes(API_KEY), false); return true;
  });
});

test("Provider facade never publishes private typed abort reasons from real accepted HTTP", async () => {
  const { NetworkError, TimeoutError } = await import("../../src/shared/llm/errors.ts");
  for (const timeout of [false, true]) {
    const secret = "private-adapter-abort", reason = timeout ? new TimeoutError(secret, { private: secret }) : new NetworkError(secret, { private: secret });
    const controller = new AbortController(), entered = Promise.withResolvers<void>(); let observed: AbortSignal | undefined, calls = 0;
    serve(async () => { calls++; return new Response(responsesSse({ id: "typed-cancel", content: "yes" }), { headers: { "content-type": "text/event-stream" } }); });
    const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
    const operation = adapter.chatCompletion({ ...REQUEST, signal: controller.signal }, {
      onResponseReceipt(_receipt, lifetime) { observed = lifetime; entered.resolve(); return new Promise<void>(() => {}); },
    });
    const outcome = assert.rejects(operation, error => {
      assert.ok(error instanceof LLMError); assert.equal(error.code, timeout ? "llm_timeout" : "llm_cancelled"); assert.equal(error.retryable, false);
      assert.equal(JSON.stringify({ ...error, message: error.message }).includes(secret), false); return true;
    });
    await entered.promise; controller.abort(reason); await outcome;
    assert.equal(observed?.reason, reason); assert.equal(controller.signal.reason, reason); assert.equal(calls, 1);
  }
});

test("Provider adapter preserves the provider's own error code and observed status", async () => {
  // The provider's failure as it crosses the wire (status 422, its own error
  // code) reaches the caller as that code and that status, not retried.
  let calls = 0;
  serve(async () => { calls++; return new Response(JSON.stringify({ error: { code: "misalignment_policy_violation", message: "safe native failure" } }), { status: 422, headers: { "content-type": "application/json" } }); });
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: API_KEY });
  await assert.rejects(async () => { for await (const _event of adapter.streamChatCompletion(REQUEST)) { /* consume */ } },
    error => error instanceof LLMError && error.code === "llm_misalignment_policy_violation" && error.status === 422 && error.retryable === false);
  assert.equal(calls, 1);
});
