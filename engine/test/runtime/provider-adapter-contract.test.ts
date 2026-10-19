import { responsesSse } from "../support/mock-provider.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  createProviderAdapter,
  buildProviderConfig,
  type ChatCompletionRequest,
  type ChatCompletionResult,
  type ChatStreamEvent,
  type ProviderAdapter,
  type ProviderConfig,
} from "../../src/runtime/provider-adapter.ts";
import { address, serve, type UpstreamHandler } from "../support/loopback-upstream.ts";

/**
 * ProviderAdapter contract (GAP-16).
 *
 * A generic suite any `ProviderAdapter` implementation must satisfy. It is
 * run against the real OpenAI-compatible adapter (with a mock fetch) and a
 * minimal fake adapter so the contract is independent of any one
 * implementation.
 */

const VALID_EVENT_TYPES = new Set<string>([
  "start", "error", "reasoning", "response_event", "response", "refusal", "tool_call_done",
  "content", "tool_call_start", "tool_call_delta", "usage", "finish", "model", "headers",
]);

const PROVIDER: ProviderConfig = buildProviderConfig({
  id: "test",
  baseUrl: address("https://api.test.com/v1"),
  timeoutMs: 5000,
  retries: { maxRetries: 0, initialBackoffMs: 1, maxBackoffMs: 10, backoffMultiplier: 2 },
});

const REQUEST: ChatCompletionRequest = { model: "test-model", messages: [{ role: "user", content: "Hi" }], temperature: 0 };

function sseResponse(): string { return responsesSse({ content: "Hi back" }); }

function mockFetch(): UpstreamHandler {
  return async () => new Response(sseResponse(), {headers:{"content-type":"text/event-stream"}});
}

function fakeAdapter(): ProviderAdapter {
  return Object.freeze({
    providerId: "fake",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      yield Object.freeze({ type: "content", text: "fake" });
      yield Object.freeze({ type: "finish", reason: "stop" });
    },
    async chatCompletion(): Promise<ChatCompletionResult> {
      return Object.freeze({ content: "fake", toolCalls: [], usage: undefined, finishReason: "stop" });
    },
  });
}

async function assertAdapterContract(adapter: ProviderAdapter, label: string): Promise<void> {
  assert.equal(typeof adapter.providerId, "string", `${label}: providerId must be a string`);
  assert.ok(adapter.providerId.length > 0, `${label}: providerId must be non-empty`);

  const events: ChatStreamEvent[] = [];
  for await (const event of adapter.streamChatCompletion(REQUEST)) {
    events.push(event);
    assert.ok(
      VALID_EVENT_TYPES.has(event.type),
      `${label}: streamChatCompletion yielded an invalid event type '${event.type}'`,
    );
  }
  assert.ok(events.length > 0, `${label}: streamChatCompletion must yield at least one event`);

  const result = await adapter.chatCompletion(REQUEST);
  assert.ok(Object.isFrozen(result), `${label}: chatCompletion must return a frozen ChatCompletionResult`);
  assert.equal(typeof result.content, "string");
  assert.ok(Array.isArray(result.toolCalls));
  assert.equal(typeof result.finishReason, "string");
}

test("ProviderAdapter contract: real adapter (mock fetch) satisfies the contract", async () => {
  serve(mockFetch());
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: "sk-contract-test" });
  await assertAdapterContract(adapter, "real");
});

test("ProviderAdapter contract: fake adapter satisfies the contract", async () => {
  await assertAdapterContract(fakeAdapter(), "fake");
});

test("ProviderAdapter contract: every ChatStreamEvent variant is type-checked", async () => {
  serve(mockFetch());
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: "sk-contract-test" });
  const events: ChatStreamEvent[] = [];
  for await (const event of adapter.streamChatCompletion(REQUEST)) events.push(event);
  for (const event of events) {
    assert.ok(VALID_EVENT_TYPES.has(event.type), `event type '${event.type}' is not in the valid set`);
  }
});
