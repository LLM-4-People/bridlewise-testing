import { responsesSse } from "../support/mock-provider.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  createProviderAdapter,
  buildProviderConfig,
  type ProviderConfig,
  type ChatCompletionRequest,
  type ChatMessage,
} from "../../src/runtime/provider-adapter.ts";
import { address, serve, type UpstreamRequest } from "../support/loopback-upstream.ts";

/**
 * Security invariant (GAP-4): the API key must NEVER appear in the request
 * body. The provider adapter places the key only in the `Authorization`
 * header; the JSON body carries the model, messages, and stream options.
 * If a key ever leaked into the body, any request log or upstream cache
 * would persist the credential. This test captures `init.body` from a mock
 * fetch and asserts the key is not a substring of it across several key
 * shapes (short, long, special characters).
 */

const PROVIDER: ProviderConfig = buildProviderConfig({
  id: "test",
  baseUrl: address("https://api.test.com/v1"),
  timeoutMs: 5000,
  retries: { maxRetries: 0, initialBackoffMs: 1, maxBackoffMs: 10, backoffMultiplier: 2 },
});

function sseFinish(): string { return responsesSse({ content: "" }); }

function mockResponse(body: string): Response {
  return new Response(body, {headers:{"content-type":"text/event-stream"}});
}

const MESSAGES: readonly ChatMessage[] = [{ role: "user", content: "Hello" }];
const REQUEST: ChatCompletionRequest = { model: "test-model", messages: MESSAGES, temperature: 0 };

interface CapturedCall { url: string; body: string; headers: unknown; }

/** Answers the door's requests for this test and records each one. */
function capturingFetch(_apiKey: string): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = async (url: string, init?: UpstreamRequest): Promise<Response> => {
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "", headers: init?.headers });
    return mockResponse(sseFinish());
  };
  serve(fetchImpl);
  return { calls };
}

test("Provider security: API key is absent from request body (short key)", async () => {
  const apiKey = "sk-short123";
  const { calls } = capturingFetch(apiKey);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey });
  await adapter.chatCompletion(REQUEST);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0]!.body.includes(apiKey), "short key must not appear in the request body");
});

test("Provider security: API key is absent from request body (long key)", async () => {
  const apiKey = `sk-${"a".repeat(120)}`;
  const { calls } = capturingFetch(apiKey);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey });
  await adapter.chatCompletion(REQUEST);
  assert.ok(!calls[0]!.body.includes(apiKey), "long key must not appear in the request body");
});

test("Provider security: API key is absent from request body (special characters)", async () => {
  const apiKey = "sk-special_-.~+/==";
  const { calls } = capturingFetch(apiKey);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey });
  await adapter.chatCompletion(REQUEST);
  assert.ok(!calls[0]!.body.includes(apiKey), "special-char key must not appear in the request body");
});

test("Provider security: API key is absent from request body across retries", async () => {
  const apiKey = "sk-retry-key-abcdef";
  let calls = 0;
  const bodies: string[] = [];
  const fetchImpl = async (_url: string, init?: UpstreamRequest): Promise<Response> => {
    calls++;
    if (typeof init?.body === "string") bodies.push(init.body);
    if (calls < 3) {
      return new Response("rate limited", {status:429,headers:{"retry-after":"0"}});
    }
    return mockResponse(sseFinish());
  };
  const retryProvider = buildProviderConfig({
    id: "test", baseUrl: address("https://api.test.com/v1"), timeoutMs: 5000,
    retries: { maxRetries: 3, initialBackoffMs: 1, maxBackoffMs: 5, backoffMultiplier: 2 },
  });
  serve(fetchImpl);
  const adapter = createProviderAdapter({ provider: retryProvider, apiKey });
  await adapter.chatCompletion(REQUEST);
  assert.equal(bodies.length, 3);
  for (const body of bodies) {
    assert.ok(!body.includes(apiKey), "key must not appear in any retried request body");
  }
});

test("Provider security: body still carries model and messages without the key", async () => {
  const apiKey = "sk-never-in-body-987";
  const { calls } = capturingFetch(apiKey);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey });
  await adapter.chatCompletion(REQUEST);
  const parsed = JSON.parse(calls[0]!.body) as { model: string; input: readonly ChatMessage[]; stream: boolean };
  assert.equal(parsed.model, "test-model");
  assert.equal(parsed.stream, true);
  assert.equal(parsed.input[0]!.content, "Hello");
});
