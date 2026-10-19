import { responsesSse, responseResource } from "../support/mock-provider.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { SharedLLMClient, isLLMError, LLMError } from "../../src/shared/llm/index.ts";
import { address, serve, type UpstreamRequest } from "../support/loopback-upstream.ts";

/**
 * EXP421 — per-model + per-provider failover (OPTIONAL, default off).
 *
 * Mock two models on one provider: model A always returns 429 (rate-limit),
 * model B returns 200. With failover enabled and rate-limit as a trigger, the
 * client must fail A → fall back to B → succeed, and record exactly one
 * failover. Per the user note, glm and gemma share concurrency on neuralwatt
 * so failover is not useful THERE — but it is genuinely useful when models
 * live on different providers, which the second test exercises.
 */

// Native source fixture; the client owns privacy admission.
const MESSAGES = ({ input: "Hi", model: "gemma" });

function sse(content: string, model: string): string { return responsesSse({ content, model }); }
function jsonBody(content: string, model: string): string { return JSON.stringify(responseResource({ content, model, usage: { input_tokens:2, output_tokens:3, total_tokens:5 } })); }
/** A real HTTP answer from the loopback upstream. */
function answer(status: number, body: string, contentType: string, extra: Readonly<Record<string, string>> = {}): Response {
  return new Response(body, { status, headers: { "content-type": contentType, ...extra } });
}

function failoverConfig(models: readonly string[], providers: readonly string[], strategy: "round-robin" | "priority" | "least-latency" = "round-robin"): Record<string, unknown> {
  return {
    baseUrl: address("https://api.test.com/v1"),
    apiKey: "sk-test-key-1234567890",
    allowPrivateAddress: true,
    model: models[0] ?? "a",
    timeout: 5000,
    maxRetries: { "rate-limit": 0, server: 0, network: 0, overloaded: 0 },
    backoff: { baseMs: 1, factor: 2, maxMs: 5, jitter: 0 },
    concurrency: 1,
    circuitBreaker: { threshold: 100, resetMs: 1000 },
    failover: { enabled: true, models, providers, strategy, triggerOnError: ["rate-limit", "server", "network", "overloaded"] },
    providers: providers.map((id) => ({ id, baseUrl: address(`https://${id}/v1`), apiKey: `sk-${id}-key` })),
  };
}

test("failover: model A 429 → fallback to model B succeeds (single provider)", async () => {
  serve(async (_url: string, init: UpstreamRequest) => {
    const body = JSON.parse(String(init.body)) as { model: string };
    if (body.model === "gemma") return answer(429, "rate limited", "text/plain", { "retry-after": "0" });
    return answer(200, jsonBody("from-qwen", "qwen"), "application/json");
  });
  const client = new SharedLLMClient(failoverConfig(["gemma", "qwen"], ["neuralwatt"]) as never);
  const r = await client.create(MESSAGES);
  assert.equal(r.content, "from-qwen");
  assert.equal(r.model, "qwen");
  assert.equal(r.failovers, 1);
  assert.equal(client.getStats().failovers, 1);
  assert.equal(client.getStats().lastFailoverReason, "rate-limit");
});

test("failover: provider A 500 → fallback to provider B succeeds", async () => {
  serve(async (url: string) => {
    // Provider A (neuralwatt) returns 500; provider B (openai) returns 200.
    if (new URL(url).host === "neuralwatt") return answer(500, "err", "text/plain");
    return answer(200, jsonBody("from-openai", "gemma"), "application/json");
  });
  const client = new SharedLLMClient(failoverConfig(["gemma"], ["neuralwatt", "openai"]) as never);
  const r = await client.create(MESSAGES);
  assert.equal(r.content, "from-openai");
  assert.equal(r.provider, "openai");
  assert.equal(r.failovers, 1);
});

test("failover: disabled (default) does NOT failover — throws on 429", async () => {
  serve(async () => answer(429, "rl", "text/plain", { "retry-after": "0" }));
  const cfg: Record<string, unknown> = {
    baseUrl: address("https://api.test.com/v1"), apiKey: "sk-test-key-1234567890", allowPrivateAddress: true, model: "gemma",
    timeout: 5000, maxRetries: { "rate-limit": 0 }, backoff: { baseMs: 1, factor: 2, maxMs: 5, jitter: 0 },
    concurrency: 1, circuitBreaker: { threshold: 100, resetMs: 1000 },
  };
  const client = new SharedLLMClient(cfg as never);
  await assert.rejects(
    async () => client.create(MESSAGES),
    (e: unknown) => isLLMError(e) && (e as LLMError).code === "llm_rate_limited",
  );
  assert.equal(client.getStats().failovers, 0);
});

test("failover: non-trigger error (auth) does NOT failover", async () => {
  serve(async (_url: string, init: UpstreamRequest) => {
    const body = JSON.parse(String(init.body)) as { model: string };
    if (body.model === "gemma") return answer(401, "unauth", "text/plain");
    return answer(200, sse("from-qwen", "qwen"), "text/event-stream");
  });
  const client = new SharedLLMClient(failoverConfig(["gemma", "qwen"], ["neuralwatt"]) as never);
  // auth is non-retryable and non-trigger → throws immediately, no failover.
  await assert.rejects(
    async () => client.create(MESSAGES),
    (e: unknown) => isLLMError(e) && (e as LLMError).code === "llm_auth_error",
  );
  assert.equal(client.getStats().failovers, 0);
});

test("failover: getCurrentTarget reflects the active selection", async () => {
  serve(async () => answer(200, sse("ok", "gemma"), "text/event-stream"));
  const client = new SharedLLMClient(failoverConfig(["gemma", "qwen"], ["neuralwatt", "openai"]) as never);
  const t = client.getCurrentTarget();
  assert.equal(t.model, "gemma");
  assert.equal(t.providerId, "neuralwatt");
});
