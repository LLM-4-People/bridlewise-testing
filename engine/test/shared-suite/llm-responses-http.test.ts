import { InputError, SecurityError } from "../../src/kernel/errors.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { configureDebugSystem, createCollectingSink, getDebugSignals, resetDebugSystem } from "../../src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../src/shared/debug/debug-config.ts";
import { SharedLLMClient, fetchProviderModels } from "../../src/shared/llm/client.ts";
import { ALL_ERROR_TYPES, LLMError, NetworkError } from "../../src/shared/llm/errors.ts";
import { responseEvents, responseJsonResponse, responseSseResponse, responseResource, TEST_FAILURE_OPTIONS, TEST_TRANSPORT } from "../support/mock-provider.ts";
import { ResponseStreamState } from "../../src/shared/llm/responses-stream.ts";
import type { LLMConfig } from "../../src/shared/llm/config.ts";
import { address, mockDoorClock, onDoorBodyReader, serve, type UpstreamHandler } from "../support/loopback-upstream.ts";
const request = ({ input: "witness", model: "test-model" });
/**
 * A client for provider "a" (`https://a.test/v1`), answered by `handler` on the
 * real loopback upstream. Its default deadlines are real I/O bounds no test
 * here asserts, so they are generous: a loaded machine never trips them. A
 * test that asserts a deadline sets its own and drives it with the mocked
 * clock (`mockDoorClock`), never a wall-clock wait (WFDEL-FLAKE-LLM-REST).
 */
function client(handler: UpstreamHandler, options: Partial<LLMConfig> = {}) {
  serve(handler);
  return new SharedLLMClient({ baseUrl: address("https://a.test/v1"), apiKey: "test-http-secret-value", allowPrivateAddress: true, providerId: "a", model: "test-model", timeout: 10_000,
    maxRetries: Object.fromEntries(ALL_ERROR_TYPES.map(type => [type, 0])), backoff: { baseMs: 1, maxMs: 2, factor: 2, jitter: 0 },
    responses: { operationTimeoutMs: 30_000, cleanupTimeoutMs: 5 }, ...options });
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
const billedUsage = { input_tokens: 8, output_tokens: 2, total_tokens: 10 };
const zeroUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
function sse(events: readonly unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("Responses REST operations preserve documented envelopes, query and nullable request fields", async () => {
  const calls: { url: URL; method: string; body: unknown }[] = [];
  const c = client(async (url, init) => {
    const parsed = new URL(String(url)); calls.push({ url: parsed, method: init!.method!, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (parsed.pathname.endsWith("/input_items")) return json({ object: "list", data: [{ type: "message", role: "user", content: "witness" }], first_id: null, last_id: null, has_more: false });
    if (parsed.pathname.endsWith("/input_tokens")) return json({ object: "response.input_tokens", input_tokens: 12 });
    if (parsed.pathname.endsWith("/compact")) return json({ object: "response.compaction", id: "cmp_1", created_at: 1, output: [], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 }, extension: true });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return responseJsonResponse({ id: "resp/one", content: "ok" });
  });
  await c.create(request);
  assert.equal((await c.retrieve("resp/one", { include: ["reasoning.encrypted_content"], include_obfuscation: false })).content, "ok");
  assert.equal((await c.cancel("resp/one")).response.id, "resp/one");
  assert.equal((await c.listInputItems("resp/one", { limit: 3, order: "asc", include: ["a", "b"] })).response.has_more, false);
  assert.equal((await c.compact(({ model: null, input: null }))).response.extension, true);
  assert.equal((await c.countInputTokens(({ model: null, input: null, personality: "none" }))).response.input_tokens, 12);
  assert.equal((await c.delete("resp/one")).response, undefined);
  assert.equal(calls[1]!.url.pathname, "/v1/responses/resp%2Fone");
  assert.deepEqual(calls[3]!.url.searchParams.getAll("include[]"), ["a", "b"]);
  assert.deepEqual(calls[4]!.body, { model: null, input: null });
  assert.equal(calls[6]!.method, "DELETE");
});

test("Pending resource polling settles token usage once and enforces ownership bounds", async () => {
  let creates = 0;
  const c = client(async (url, init) => {
    if (init?.method === "POST") { creates++; return responseJsonResponse({ id: "pending", status: "queued" }); }
    return responseJsonResponse({ id: String(url).endsWith("/external") ? "external" : "pending", content: "done", usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } });
  }, { responses: { maximumTrackedResponses: 1 } });
  assert.equal((await c.create(request)).status, "queued");
  await assert.rejects(c.create(request), { code: "responses_pending_limit" }); assert.equal(creates, 1);
  await c.retrieve("pending"); await c.retrieve("pending");
  assert.equal(c.getStats().totalTokens.total, 10);
  await c.retrieve("external"); assert.equal(c.getStats().totalTokens.total, 10);
});

test("Resource continuations and count stay at origin after unrelated provider failover", async () => {
  const calls: string[] = []; let aCreates = 0;
  const c = client(async (url, init) => {
    const u = new URL(String(url)); calls.push(u.host + u.pathname);
    if (u.pathname.endsWith("/input_tokens")) return json({ object: "response.input_tokens", input_tokens: 2 });
    if (u.host === "a.test" && init?.method === "POST" && ++aCreates > 1) return json({ error: { message: "temporary" } }, 503);
    return responseJsonResponse({ id: u.host === "a.test" ? "origin-a" : "origin-b", content: "ok" });
  }, { providers: [{ id: "b", baseUrl: address("https://b.test/v1"), apiKey: "provider-b-secret" }], failover: { enabled: true, providers: ["a", "b"], models: [], strategy: "priority", triggerOnError: ["server"] } });
  await c.create(request); await c.create(request); await c.retrieve("origin-a");
  await c.countInputTokens(({ previous_response_id: "origin-a" }));
  assert.equal(calls.at(-2), "a.test/v1/responses/origin-a"); assert.equal(calls.at(-1), "a.test/v1/responses/input_tokens");
});

test("Terminal tools are delivered after admission and HTTP deadlines are released", async t => {
  // The ORDER is asserted: after release, time past BOTH deadlines aborts
  // nothing. The deadlines run on the mocked clock, so the machine's load
  // cannot expire them before the loopback answers (wf-1b3a-design M8).
  mockDoorClock(t);
  let signal: AbortSignal | null | undefined;
  let delivered = false;
  const c = client(async (_url, init) => { signal = init?.signal; return responseSseResponse({ toolCalls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }] }); }, { timeout: 15, responses: { operationTimeoutMs: 25 } });
  for await (const chunk of c.stream(request)) if (chunk.type === "tool_call_done") {
    delivered = true;
    assert.equal(c.getQueue().active, 0); t.mock.timers.tick(35); assert.equal(signal?.aborted, false);
  }
  assert.equal(delivered, true, "the terminal tool call was never delivered");
});

test("Retained stream checkpoint resumes with starting_after and no duplicate execution", async () => {
  const events = responseEvents({ toolCalls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }] });
  const cut = events.length - 1; const seen: string[] = []; let calls = 0;
  const c = client(async url => { seen.push(String(url)); return new Response((calls++ ? events.slice(cut) : events.slice(0, cut)).map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }); });
  const state = new ResponseStreamState(); let tools = 0;
  await assert.rejects(async () => { for await (const event of c.stream(request, { state })) if (event.type === "tool_call_done") tools++; }, { code: "llm_streaming_error" });
  for await (const event of c.resume(state)) if (event.type === "tool_call_done") tools++;
  assert.equal(tools, 1); assert.equal(new URL(seen[1]!).searchParams.get("starting_after"), String(cut - 1));
});

test("Ambiguous mutable or hosted delivery never retries; quota is nonretryable and secret-safe", async () => {
  for (const body of [{ conversation: "conv_1" }, { tools: [{ type: "web_search" }] }]) {
    let calls = 0; const c = client(async () => { calls++; throw new TypeError("fetch failed"); }, { maxRetries: { network: 3 } });
    await assert.rejects(c.create(({ input: "hi", ...body })), { code: "llm_delivery_uncertain", retryable: false });
    assert.equal(calls, 1);
  }
  let calls = 0;
  const c = client(async () => { calls++; return json({ error: { code: "insufficient_quota", message: "account test-http-secret-value exhausted" } }, 429); }, { maxRetries: { "rate-limit": 3 } });
  await assert.rejects(c.create(request), error => error instanceof LLMError && error.code === "llm_quota_exhausted" && !error.message.includes("test-http-secret-value"));
  assert.equal(calls, 1);
});

test("Body cancellation rejection and stalled cleanup cannot retain admission", async () => {
  for (const cancel of [() => Promise.reject(new Error("cancel rejected")), () => new Promise<void>(() => {})]) {
    const c = client(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: {bad}\n\n")); }, cancel }), { headers: { "content-type": "text/event-stream" } }));
    await assert.rejects(async () => { for await (const _event of c.stream(request)) { /* consume */ } });
    assert.equal(c.getQueue().active, 0);
  }
});

test("Model discovery registers authentication secrets before provider error observations", async () => {
  const key = "discovery-only-secret-credential";
  serve(async () => json({ error: { message: `wrong key ${key}` } }, 401));
  await assert.rejects(fetchProviderModels({ baseUrl: address("https://discover.test"), providerId: "discovery", apiKey: key, headers: {}, timeoutMs: 100, maxBytes: 1000, transport: TEST_TRANSPORT,
    allowPrivateAddress: true }), error => error instanceof LLMError && !error.message.includes(key));
});

test("SSE response budget bounds aggregate bytes across otherwise valid frames", async () => {
  const transcript = responseEvents({ chunks: ["one", "two", "three"] }).map(event => `data: ${JSON.stringify(event)}\n\n`);
  const c = client(async () => new Response(new ReadableStream({ start(controller) { for (const frame of transcript) controller.enqueue(new TextEncoder().encode(frame)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } }),
    { responses: { maximumResponseBytes: 900 } });
  await assert.rejects(async () => { for await (const _event of c.stream(request)) { /* consume */ } }, error => error instanceof LLMError && error.code === "llm_invalid_response" && error.message.includes("byte bound"));
});

test("Captured headers mask credential names and known-secret echoes at the shared owner", async () => {
  const c = client(async () => responseJsonResponse({ content: "safe" }, { headers: { "x-provider-note": "test-http-secret-value", "set-cookie": "session=private", "x-request-id": "trace-witness" } }),
    { responses: { capturedResponseHeaders: ["x-provider-note", "set-cookie", "x-request-id"] } });
  const result = await c.create(request);
  assert.equal(result.headers["x-request-id"], "trace-witness");
  assert.ok(!JSON.stringify(result.headers).includes("test-http-secret-value")); assert.ok(!JSON.stringify(result.headers).includes("session=private"));
});

test("Rate-limit token counts remain observable while secret echoes stay redacted", async () => {
  const c = client(async () => responseJsonResponse({ content: "safe" }, { headers: {
    "x-ratelimit-limit-tokens": "50000", "x-ratelimit-remaining-tokens": "41000",
    "x-ratelimit-reset-tokens": "6m0s", "x-ratelimit-limit-requests": "test-http-secret-value",
  } }));
  const result = await c.create(request);
  assert.equal(result.headers["x-ratelimit-limit-tokens"], "50000");
  assert.equal(result.headers["x-ratelimit-remaining-tokens"], "41000");
  assert.equal(result.headers["x-ratelimit-reset-tokens"], "6m0s");
  assert.ok(!JSON.stringify(result.headers).includes("test-http-secret-value"));
});

test("Rejected target selection does not consume response ownership capacity", async () => {
  const c = client(async () => responseJsonResponse({ content: "valid" }), { responses: { maximumTrackedResponses: 1, operationTimeoutMs: 100 } });
  await assert.rejects(c.create(request, { provider: "missing" }), { code: "llm_config_invalid" });
  assert.equal((await c.create(request)).content, "valid");
});

test("Resource retrieval refuses a provider's mismatched response identity", async () => {
  const c = client(async () => responseJsonResponse({ id: "different-resource", content: "wrong" }));
  await assert.rejects(c.retrieve("requested-resource"), { code: "responses_identity_changed" });
});

test("Response IDs are provider-scoped and cannot silently change implicit origin", async () => {
  const calls: string[] = [];
  const c = client(async (url) => {
    calls.push(new URL(String(url)).host);
    return responseJsonResponse({ id: "provider-local-id", content: "ok", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } });
  }, { providers: [{ id: "b", baseUrl: address("https://b.test/v1"), apiKey: "provider-b-secret" }] });
  await c.create(request, { provider: "a" }); await c.create(request, { provider: "b" });
  assert.equal(c.getStats().totalTokens.total, 12);
  await assert.rejects(c.retrieve("provider-local-id"), { code: "responses_provider_required" });
  await c.retrieve("provider-local-id", {}, { provider: "a" });
  await c.retrieve("provider-local-id", {}, { provider: "b" });
  assert.deepEqual(calls, ["a.test", "b.test", "a.test", "b.test"]);
  assert.equal(c.getStats().totalTokens.total, 12);
});

test("Repeated known response IDs are accounted once and local retirement releases pending ownership", async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return responseJsonResponse({ id: calls <= 2 ? "same-id" : "queued-id", status: calls <= 2 ? "completed" : "queued",
      ...(calls <= 2 ? { usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } : {}) });
  }, { responses: { maximumTrackedResponses: 1 } });
  await c.create(request); await c.create(request);
  assert.equal(c.getStats().totalTokens.total, 6);
  await c.create(request);
  assert.equal(c.getResponseTracking().pending, 1);
  assert.equal(c.retireResponse("queued-id"), true);
  assert.equal(c.retireResponse("queued-id"), false);
  assert.equal(c.getResponseTracking().pending, 0);
  assert.equal(c.getResponseTracking().unavailableUsage, 1);
  assert.equal(c.getStats().totalTokens.total, 6);
  assert.equal(calls, 3, "retirement must not issue a remote cancellation");
});

test("A streaming response converts its reservation without consuming two ownership slots", async () => {
  let calls = 0;
  const c = client(async () => responseSseResponse({ id: `concurrent-${++calls}`, content: "ok" }),
    { responses: { maximumTrackedResponses: 2 } });
  for await (const event of c.stream(request)) if (event.type === "start") {
    assert.equal(c.getResponseTracking().reserved, 0);
    for await (const _event of c.stream(request)) { /* second slot is available */ }
  }
  assert.equal(calls, 2);
  assert.equal(c.getResponseTracking().pending, 0);
});

test("Configured protocol identities cannot bypass privacy through late model selection", async () => {
  let calls = 0;
  assert.throws(() => client(async () => { calls++; return responseJsonResponse({ content: "bad" }); },
    { model: "test-http-secret-value" }), { code: "responses_identity_sensitive" });
  const c = client(async () => { calls++; return responseJsonResponse({ content: "bad" }); });
  await assert.rejects(c.create(({ model: "test-http-secret-value", input: "safe" })), { code: "responses_identity_sensitive" });
  assert.equal(calls, 0);
  assert.equal(c.getResponseTracking().reserved, 0);
});

test("Observed OpenAI quota errors share one nonretryable classifier across HTTP and SSE", async () => {
  const quota = { type: "insufficient_quota", code: "credit_balance_exhausted", message: "Account test-http-secret-value has no credits", param: null };
  for (const response of [() => json({ error: quota }, 429), () => {
    const events = [
      { type: "response.created", sequence_number: 0, response: { id: "quota-response", object: "response", model: "test-model", status: "in_progress", output: [] } },
      { type: "response.in_progress", sequence_number: 1, response: { id: "quota-response", object: "response", model: "test-model", status: "in_progress", output: [] } },
      { type: "error", sequence_number: 2, error: quota },
      { type: "response.failed", sequence_number: 3, response: { id: "quota-response", object: "response", model: "test-model", status: "failed", output: [], error: { code: quota.code, message: quota.message } } },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }]) {
    let calls = 0; const chunks: string[] = [];
    const c = client(async () => { calls++; return response(); }, { maxRetries: { "rate-limit": 3, server: 3 } });
    const streaming = response().headers.get("content-type") === "text/event-stream";
    await assert.rejects(async () => {
      if (streaming) for await (const chunk of c.stream(request)) {
        chunks.push(chunk.type);
        if (chunk.type === "response") { assert.equal(chunk.status, "failed"); assert.equal(chunk.response.id, "quota-response"); assert.equal(c.getQueue().active, 0); }
      }
      else await c.create(request);
    }, error => error instanceof LLMError && error.code === "llm_quota_exhausted" && error.retryable === false && !error.message.includes("test-http-secret-value"));
    assert.equal(calls, 1);
    if (streaming) { assert.ok(chunks.indexOf("response") < chunks.indexOf("error")); assert.ok(!chunks.includes("tool_call_done")); assert.equal(c.getResponseTracking().pending, 0); }
  }
});

test("Documented quota and spend codes remain nonretryable without HTTP status or broad type", async () => {
  const { classifyProviderFailure } = await import("../../src/shared/llm/provider-failure.ts");
  for (const code of ["credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"]) {
    const error = classifyProviderFailure({ code, message: "Account needs attention" }, TEST_FAILURE_OPTIONS);
    assert.equal(error.code, "llm_quota_exhausted"); assert.equal(error.retryable, false);
  }
  assert.equal(classifyProviderFailure({ type: "insufficient_quota", code: "future_account_code", message: "Quota" }, TEST_FAILURE_OPTIONS).retryable, false);
  const rate = classifyProviderFailure({ code: "rate_limit_exceeded", message: "Wait" }, { ...TEST_FAILURE_OPTIONS, status: 429, retryAfterMs: 500 });
  assert.equal(rate.code, "llm_rate_limited"); assert.equal(rate.retryable, true);
});

// Provider-scoped ownership is independent from terminal usage availability.
test("Terminal missing usage reconciles later exactly once, including valid zero", async () => {
  for (const missing of [null, undefined]) for (const usage of [billedUsage, zeroUsage]) {
    const c = client(async (_url, init) => responseJsonResponse({ id: "late", content: "done",
      ...(init?.method === "POST" ? missing === undefined ? {} : { usage: missing } : { usage }) }));
    await c.create(request);
    assert.equal(c.getResponseTracking().pending, 0);
    assert.equal(c.getResponseTracking().unavailableUsage, 1);
    assert.equal(c.retireResponse("late"), false);
    await c.retrieve("late"); await c.retrieve("late");
    assert.equal(c.getStats().totalTokens.total, usage.total_tokens);
    assert.equal(c.getResponseTracking().unavailableUsage, 0);
  }
});

test("Provisional usage never claims final billing or releases pending ownership", async () => {
  let terminal = false;
  const provisionalUsage = { input_tokens: 60, output_tokens: 30, total_tokens: 90 };
  const c = client(async () => responseJsonResponse({ id: "provisional", status: terminal ? "completed" : "queued", usage: terminal ? billedUsage : provisionalUsage }));
  await c.create(request); await c.cancel("provisional");
  assert.equal(c.getResponseTracking().pending, 1); assert.equal(c.getStats().totalTokens.total, 0);
  terminal = true; await c.retrieve("provisional");
  assert.equal(c.getResponseTracking().pending, 0); assert.equal(c.getStats().totalTokens.total, 10);
  const streamed = client(async () => responseSseResponse({ id: "streamed", content: "done", usage: billedUsage }));
  for await (const event of streamed.stream(request)) if (event.type === "start") assert.equal(streamed.getStats().totalTokens.total, 0);
  assert.equal(streamed.getStats().totalTokens.total, 10);
});

test("Concurrent cancel and retrieve reconcile terminal usage in either completion order", async () => {
  for (const cancelUsage of [null, billedUsage]) for (const cancelFirst of [false, true]) {
    const cancel = Promise.withResolvers<Response>(), retrieve = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>(); let controls = 0;
    const c = client(async (url, init) => {
      if (init?.method === "POST" && !String(url).endsWith("/cancel")) return responseJsonResponse({ id: "race", status: "queued", usage: null });
      if (++controls === 2) started.resolve();
      return String(url).endsWith("/cancel") ? cancel.promise : retrieve.promise;
    }, { responses: { operationTimeoutMs: 2000 }, timeout: 1000 });
    await c.create(request);
    const cancellations = c.cancel("race"), retrieval = c.retrieve("race"); await started.promise;
    if (cancelFirst) { cancel.resolve(responseJsonResponse({ id: "race", status: "cancelled", usage: cancelUsage })); await cancellations; }
    retrieve.resolve(responseJsonResponse({ id: "race", usage: billedUsage })); await retrieval;
    if (!cancelFirst) { cancel.resolve(responseJsonResponse({ id: "race", status: "cancelled", usage: cancelUsage })); await cancellations; }
    assert.equal(c.getStats().totalTokens.total, 10); assert.equal(c.getResponseTracking().pending, 0);
    assert.equal(c.getResponseTracking().unavailableUsage, 0);
  }
});

test("Local retire and documented deletion envelopes preserve later owned usage", async () => {
  for (const action of ["retire", "delete200", "delete204"] as const) for (const usageFirst of [false, true]) {
    let deletes = 0;
    const c = client(async (_url, init) => {
      if (init?.method === "DELETE") { deletes++; return action === "delete204" ? new Response(null, { status: 204 }) : json({ object: "response", id: "retained", deleted: true }); }
      return responseJsonResponse({ id: "retained", status: init?.method === "POST" ? "queued" : "completed", usage: init?.method === "POST" ? null : billedUsage });
    });
    await c.create(request);
    if (usageFirst) await c.retrieve("retained");
    if (action === "retire") assert.equal(c.retireResponse("retained"), !usageFirst);
    else assert.equal((await c.delete("retained")).response?.deleted, action === "delete200" ? true : undefined);
    assert.equal(c.getResponseTracking().pending, 0);
    await c.retrieve("retained"); await c.retrieve("retained");
    assert.equal(c.getResponseTracking().unavailableUsage, 0); assert.equal(c.getStats().totalTokens.total, 10);
    assert.equal(c.retireResponse("retained"), false); assert.equal(deletes, action === "retire" ? 0 : 1);
  }
  for (const failure of ["http", "wrong-id", "empty"] as const) {
    const c = client(async (_url, init) => init?.method !== "DELETE" ? responseJsonResponse({ id: "retained", status: "queued" })
      : failure === "http" ? json({ error: { message: "rejected" } }, 400) : failure === "empty" ? new Response(null, { status: 200 }) : json({ object: "response", id: "wrong", deleted: true }));
    await c.create(request);
    await assert.rejects(c.delete("retained"), { code: failure === "http" ? "llm_bad_request" : failure === "empty" ? "llm_invalid_response" : "responses_identity_changed" });
    assert.equal(c.getResponseTracking().pending, 1);
  }
});

test("Evicted and external responses never regain ownership and unresolved evictions stay visible", async () => {
  let creates = 0;
  const c = client(async (url, init) => init?.method === "POST" && !String(url).endsWith("/cancel")
    ? responseJsonResponse({ id: `owned-${++creates}`, status: "queued", usage: null })
    : init?.method === "DELETE" ? json({ object: "response", id: "external", deleted: true })
      : responseJsonResponse({ id: String(url).includes("external") ? "external" : "owned-1", usage: billedUsage }),
  { responses: { maximumTrackedResponses: 1 } });
  await c.create(request); assert.equal(c.retireResponse("owned-1"), true); await c.create(request);
  assert.equal(c.getResponseTracking().tracked, 1); assert.equal(c.getResponseTracking().pending, 1);
  assert.equal(c.getResponseTracking().unavailableUsage, 0);
  assert.equal(c.getResponseTracking().evictedUnavailableUsage, 1);
  await c.retrieve("owned-1"); await c.retrieve("external"); await c.cancel("external"); await c.delete("external");
  assert.equal(c.retireResponse("external"), false); assert.equal(c.getStats().totalTokens.total, 0);
  assert.equal(c.getResponseTracking().pending, 1); assert.equal(c.getResponseTracking().evictedUnavailableUsage, 1);
});

test("Late usage remains scoped to the originating provider for colliding response IDs", async () => {
  const c = client(async (url, init) => responseJsonResponse({ id: "same", status: init?.method === "POST" ? "queued" : "completed",
    usage: init?.method === "POST" ? null : new URL(String(url)).host === "a.test" ? billedUsage : { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }),
  { providers: [{ id: "b", baseUrl: address("https://b.test/v1"), apiKey: "provider-b-secret" }] });
  await c.create(request, { provider: "a" }); await c.create(request, { provider: "b" });
  c.retireResponse("same", "a"); c.retireResponse("same", "b");
  await c.retrieve("same", {}, { provider: "b" }); await c.retrieve("same", {}, { provider: "a" });
  assert.equal(c.getStats().byProvider.a?.totalTokens, 10); assert.equal(c.getStats().byProvider.b?.totalTokens, 5);
  assert.equal(c.getResponseTracking().unavailableUsage, 0);
});

test("Validated terminal usage survives whole-resource observation failure without leaking labels or retrying", async () => {
  for (const streaming of [false, true]) {
    let calls = 0; const logs: unknown[] = [];
    const deep = { a: { b: { c: { d: { e: { f: { g: "bounded" } } } } } } };
    const fixture = { id: "observed", model: "admin44xyz", content: "my password is admin44xyz", usage: billedUsage };
    const c = client(async () => { calls++; return streaming
      ? sse(responseEvents(fixture).map(event => String(event.type).startsWith("response.completed") ? { ...event, response: { ...responseResource(fixture), extension: deep } } : event))
      : json({ ...responseResource(fixture), extension: deep }); },
    { responses: { maximumDepth: 6 }, maxRetries: { network: 2, "invalid-response": 2 }, logger: { log: event => { logs.push(event); } } });
    await assert.rejects(async () => { if (streaming) for await (const _event of c.stream(request)) { /* consume */ } else await c.create(request); }, { code: "llm_unexpected_error" });
    assert.equal(calls, 1); assert.equal(c.getStats().totalTokens.total, 10); assert.equal(c.getResponseTracking().pending, 0);
    assert.ok(!JSON.stringify([logs, c.getStats()]).includes("admin44xyz"));
  }
});

test("Accepted terminal accounting survives stream cleanup failure and observer failure exactly once", async t => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return new Response(responseEvents({ id: "cleanup", content: "done", usage: billedUsage }).map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }, { maxRetries: { network: 2 } });
  // The client's own body reader fails at its release, after the terminal event was accepted.
  const restore = onDoorBodyReader(t, reader => { const release = reader.releaseLock.bind(reader);
    reader.releaseLock = () => { release(); throw new NetworkError("cleanup witness"); }; });
  await assert.rejects(async () => { for await (const _event of c.stream(request)) { /* consume */ } }, { code: "llm_network_error" });
  restore();
  assert.equal(calls, 1); assert.equal(c.getStats().totalTokens.total, 10); assert.equal(c.getResponseTracking().pending, 0);
  const observed = client(async () => responseJsonResponse({ id: "metric", usage: billedUsage }));
  assert.equal((await observed.create(request, { metricsSink() { throw new Error("observer witness"); } })).response.id, "metric");
  await observed.retrieve("metric"); assert.equal(observed.getStats().totalTokens.total, 10);
});

test("Compaction validates native usage and accounts each accepted invocation while estimates stay nonbillable", async () => {
  const body = ({ model: null, input: null });
  for (const usage of [billedUsage, zeroUsage]) {
    const c = client(async (url, init) => {
      if (String(url).endsWith("/input_tokens")) return json({ object: "response.input_tokens", input_tokens: 900 });
      assert.equal(JSON.parse(String(init?.body)).model, null, "provider default request must remain wire-null");
      return json({ object: "response.compaction", id: "same-compaction", created_at: 1, output: [], usage });
    });
    await c.compact(body); await c.compact(body); await c.countInputTokens(({}));
    assert.equal(c.getStats().totalTokens.total, usage.total_tokens * 2);
    assert.equal(c.getStats().byModel["test-model"]?.totalTokens, 0, "wire-null compaction has no selected-model charge scope; only the normal count request selects its configured model");
    assert.equal(c.getResponseTracking().tracked, 0); assert.equal(c.getResponseTracking().unavailableUsage, 0);
  }
  for (const usage of [undefined, null, {}, { input_tokens: 1, output_tokens: 2, total_tokens: 4 }]) {
    const c = client(async () => json({ object: "response.compaction", id: "invalid", created_at: 1, output: [], ...(usage === undefined ? {} : { usage }) }));
    await assert.rejects(c.compact(body), error => error instanceof LLMError && error.code === "llm_invalid_response" && error.safeDetails.protocolCode === "responses_compact_malformed");
    assert.equal(c.getStats().totalTokens.total, 0);
  }
  const c = client(async () => json({ object: "response.compaction", id: "accepted", created_at: 1, output: [], usage: billedUsage }));
  assert.equal((await c.compact(body, { metricsSink() { throw new Error("compact observer witness"); } })).response.id, "accepted");
  assert.equal(c.getStats().totalTokens.total, 10);
});

test("Only max_output_tokens incompleteness is treated as output truncation across JSON and SSE", async () => {
  for (const reason of ["max_output_tokens", "content_filter", "steered", "max_messages", "future", null, undefined]) for (const streaming of [false, true]) {
    const fixture = { status: "incomplete" as const, content: "partial" };
    const resource = { ...responseResource(fixture), incomplete_details: reason === undefined ? {} : { reason } };
    const c = client(async () => streaming ? sse(responseEvents(fixture).map(event => event.type === "response.incomplete" ? { ...event, response: resource } : event)) : json(resource));
    const invoke = async () => { if (streaming) { for await (const event of c.stream(request, { truncateAsError: true })) if (event.type === "finish") assert.equal(event.truncated, reason === "max_output_tokens"); }
      else assert.equal((await c.create(request, { truncateAsError: true })).truncated, false); };
    if (reason === "max_output_tokens") await assert.rejects(invoke(), { code: "llm_truncation" }); else await invoke();
  }
});

test("Coral documented insufficient_credits is exact nonretryable quota across HTTP and nested SSE", async () => {
  for (const field of ["code", "type"] as const) for (const streaming of [false, true]) {
    const error = { code: field === "code" ? "insufficient_credits" : null, type: field === "type" ? "insufficient_credits" : "billing", message: "Credits exhausted", param: null };
    let calls = 0;
    const c = client(async () => { calls++; return streaming ? sse([
      ...responseEvents({ id: "coral-quota", output: [] }).slice(0, 2),
      { type: "error", sequence_number: 2, error },
      { type: "response.failed", sequence_number: 3, response: { ...responseResource({ id: "coral-quota", status: "failed" }), error } },
    ]) : json({ error }, 429); }, { maxRetries: { "rate-limit": 2 } });
    await assert.rejects(async () => { if (streaming) for await (const _event of c.stream(request)) { /* consume */ } else await c.create(request); },
      error => error instanceof LLMError && error.code === "llm_quota_exhausted" && error.retryable === false);
    assert.equal(calls, 1);
  }
  for (const code of ["rate_limit_exceeded", "insufficient_credits_extra"]) {
    let calls = 0;
    const c = client(async () => ++calls === 1 ? json({ error: { code, message: "retry" } }, 429) : responseJsonResponse({ content: "recovered" }), { maxRetries: { "rate-limit": 1 } });
    assert.equal((await c.create(request)).content, "recovered"); assert.equal(calls, 2);
  }
});

test("Accepted JSON resource prevents retry and failover when HTTP teardown fails", async t => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return new Response(JSON.stringify(responseResource({ id: "accepted-json", usage: billedUsage })));
  }, { maxRetries: { network: 2 }, providers: [{ id: "b", baseUrl: address("https://b.test/v1"), apiKey: "provider-b-secret" }],
    failover: { enabled: true, providers: ["a", "b"], models: [], strategy: "priority", triggerOnError: ["network"] } });
  // The client's own response fails at TEARDOWN: once its body was read to the
  // end, asking the response for its body again throws (the real transport's
  // body, reached through the platform Response's own accessor).
  const tracked = new Set<ReadableStream<Uint8Array>>(), completed = new Set<ReadableStream<Uint8Array>>();
  const restore = onDoorBodyReader(t, (reader, stream) => { tracked.add(stream); const release = reader.releaseLock.bind(reader);
    reader.releaseLock = () => { release(); completed.add(stream); }; });
  const bodyOf = Object.getOwnPropertyDescriptor(Response.prototype, "body")!.get!;
  const getter = t.mock.getter(Response.prototype, "body", function (this: Response) {
    const body = bodyOf.call(this) as ReadableStream<Uint8Array> | null;
    if (body !== null && completed.has(body)) throw new NetworkError("teardown witness");
    return body;
  });
  await assert.rejects(c.create(request), { code: "llm_network_error" });
  getter.mock.restore(); restore();
  assert.ok(tracked.size > 0, "the fault was injected into the client's real body");
  assert.equal(calls, 1); assert.equal(c.getStats().totalTokens.total, 10);
  assert.equal(c.getResponseTracking().pending, 0); assert.equal(c.getStats().failovers, 0);
});

test("Validated DELETE success retires local ownership before fallible observations", async () => {
  for (const status of [200, 204]) {
    const c = client(async (_url, init) => init?.method === "DELETE"
      ? status === 204 ? new Response(null, { status }) : json({ object: "response", id: "deleted", deleted: true })
      : responseJsonResponse({ id: "deleted", status: init?.method === "POST" ? "queued" : "completed", usage: init?.method === "POST" ? null : billedUsage }));
    await c.create(request);
    const deletion = await c.delete("deleted", { metricsSink() { throw new Error("delete observer witness"); } });
    assert.equal(deletion.response?.deleted ?? (status === 204), true);
    assert.equal(c.getResponseTracking().pending, 0); assert.equal(c.getResponseTracking().unavailableUsage, 1);
    await c.retrieve("deleted"); assert.equal(c.getStats().totalTokens.total, 10); assert.equal(c.getResponseTracking().unavailableUsage, 0);
  }
});

test("Malformed terminal snapshots cannot claim usage before stream reconciliation", async () => {
  const events = responseEvents({ id: "unreconciled", content: "original", usage: billedUsage });
  const c = client(async () => sse(events.map(event => event.type === "response.completed"
    ? { ...event, response: responseResource({ id: "unreconciled", content: "changed", usage: billedUsage }) } : event)));
  await assert.rejects(async () => { for await (const _event of c.stream(request)) { /* consume */ } },
    error => error instanceof LLMError && error.safeDetails.protocolCode === "responses_final_payload_changed");
  assert.equal(c.getStats().totalTokens.total, 0); assert.equal(c.getResponseTracking().pending, 1);
  assert.equal(c.retireResponse("unreconciled"), true);
});

test("Compaction retries account only an accepted invocation and mismatched retrieval never settles ownership", async () => {
  let attempts = 0;
  const c = client(async () => ++attempts === 1 ? json({ error: { message: "temporary" } }, 503)
    : json({ object: "response.compaction", id: "after-retry", created_at: 1, output: [], usage: billedUsage }), { maxRetries: { server: 1 } });
  await c.compact(({ model: "test-model", input: [] }));
  assert.equal(attempts, 2); assert.equal(c.getStats().totalTokens.total, 10); assert.equal(c.getResponseTracking().tracked, 0);
  const owned = client(async (_url, init) => responseJsonResponse({ id: init?.method === "POST" ? "expected" : "other", status: init?.method === "POST" ? "queued" : "completed", usage: billedUsage }));
  await owned.create(request);
  await assert.rejects(owned.retrieve("expected"), { code: "responses_identity_changed" });
  assert.equal(owned.getStats().totalTokens.total, 0); assert.equal(owned.getResponseTracking().pending, 1);
});

test("Private receipts precede native events and JSON results without adopting external resources", async () => {
  for (const streaming of [false, true]) {
    const receipts: import("../../src/shared/llm/client.ts").ResponseReceipt[] = [];
    const c = client(async () => streaming ? responseSseResponse({ id: "receipt", content: "done" }) : responseJsonResponse({ id: "receipt", status: "queued" }));
    const options = { onResponseReceipt: (receipt: import("../../src/shared/llm/client.ts").ResponseReceipt) => { receipts.push(receipt); } };
    if (streaming) for await (const chunk of c.stream(request, options)) { if (chunk.type !== "headers") assert.equal(receipts.length, 1); }
    else await c.create(request, options);
    assert.equal(receipts.length, 1); assert.equal(Object.isFrozen(receipts[0]), true);
    assert.deepEqual(Object.keys(receipts[0]!).sort(), ["providerId", "requestedModel", "responseId", "retire"]);
    assert.equal(receipts[0]!.responseId, "receipt"); assert.equal(receipts[0]!.providerId, "a"); assert.equal(receipts[0]!.requestedModel, "test-model");
    assert.equal(receipts[0]!.retire(), !streaming); assert.equal(receipts[0]!.retire(), false);
  }
  const c = client(async () => responseJsonResponse({ id: "external", usage: billedUsage }));
  await c.retrieve("external", {}, { onResponseReceipt: receipt => assert.equal(receipt.retire(), false) });
  assert.equal(c.getStats().totalTokens.total, 0); assert.equal(c.getResponseTracking().tracked, 0);
});

test("Receipt publication survives diagnostic failure and refuses duplicate callback effects after rejection", async () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: "bound" } } } } } } };
  let calls = 0, receipts = 0;
  const c = client(async () => { calls++; return json({ ...responseResource({ id: "receipt-failure", usage: billedUsage }), extension: deep }); }, { responses: { maximumDepth: 6 }, maxRetries: { network: 2 } });
  await assert.rejects(c.create(request, { onResponseReceipt(receipt) { receipts++; assert.equal(receipt.responseId, "receipt-failure"); assert.equal(c.getStats().totalTokens.total, 10); throw new NetworkError("receipt refusal"); } }), { code: "llm_unexpected_error" });
  assert.equal(receipts, 1); assert.equal(calls, 1);
  for (const asynchronous of [false, true]) {
    let requests = 0; const rejecting = client(async () => { requests++; return responseJsonResponse({ id: "accepted", status: "queued" }); }, { maxRetries: { network: 2 } });
    await assert.rejects(rejecting.create(request, { onResponseReceipt() { if (asynchronous) return Promise.reject(new NetworkError("receipt rejected")); throw new NetworkError("receipt thrown"); } }), { code: "llm_response_observer_failed" });
    assert.equal(requests, 1); assert.equal(rejecting.getResponseTracking().pending, 1);
  }
});

test("Checkpoint and once-only receipt bind to first accepted provider after failover", async () => {
  const events = responseEvents({ id: "accepted-b", content: "done", usage: billedUsage });
  const cut = events.length - 1, calls: string[] = []; let receipts = 0;
  const c = client(async (url, init) => {
    const u = new URL(String(url)); calls.push(`${u.host} ${init?.method}`);
    if (u.host === "a.test") return json({ ok: true });
    return sse(init?.method === "GET" ? events.slice(cut) : events.slice(0, cut));
  }, { providers: [{ id: "b", baseUrl: address("https://b.test/v1"), apiKey: "provider-b-secret" }],
    failover: { enabled: true, providers: ["a", "b"], models: [], strategy: "priority", triggerOnError: ["invalid-response"] } });
  const state = new ResponseStreamState();
  const options = { state, onResponseReceipt(receipt: import("../../src/shared/llm/client.ts").ResponseReceipt) { receipts++; assert.equal(receipt.providerId, "b"); } };
  await assert.rejects(async () => { for await (const _event of c.stream(request, options)) { /* consume */ } }, { code: "llm_streaming_error" });
  for await (const _event of c.resume(state, {}, options)) { /* consume */ }
  assert.deepEqual(calls, ["a.test POST", "b.test POST", "b.test GET"]); assert.equal(receipts, 1); assert.equal(c.getStats().totalTokens.total, 10);
});

test("Accepted receipt callback is bounded by caller and actual HTTP attempt, with no replay", async t => {
  mockDoorClock(t);
  for (const source of ["caller", "request"] as const) {
    const entered = Promise.withResolvers<void>(), observer = Promise.withResolvers<void>();
    const controller = new AbortController(); let calls = 0;
    const c = client(async () => { calls++; return responseJsonResponse({ id: "pending-receipt", status: "queued" }); }, { timeout: 100,
      responses: { operationTimeoutMs: 1000 }, maxRetries: { timeout: 2, network: 2 } });
    let observedSignal: AbortSignal | undefined;
    const pending = c.create(request, { signal: controller.signal, onResponseReceipt: (_receipt, signal) => { observedSignal = signal; entered.resolve(); return observer.promise; } });
    const outcome = assert.rejects(pending, { code: source === "caller" ? "llm_cancelled" : "llm_timeout" });
    await entered.promise;
    if (source === "caller") controller.abort({ privateReason: "caller ended" }); else t.mock.timers.tick(100);
    try {
      assert.equal(observedSignal?.aborted, true, "the receipt must use the active request deadline");
      if (source === "caller") assert.equal(observedSignal?.reason, controller.signal.reason);
      else assert.equal(observedSignal?.reason.code, "llm_timeout");
    } finally {
      // Drain a deliberately broken lifetime in mutation runs without a hanging promise.
      if (!observedSignal?.aborted) t.mock.timers.tick(1000);
      await outcome;
    }
    observer.reject(new NetworkError("late observer rejection")); await Promise.resolve();
    assert.equal(calls, 1); assert.equal(c.getQueue().active, 0); assert.equal(c.getResponseTracking().pending, 1);
    assert.equal(c.retireResponse("pending-receipt"), true);
  }
});

test("A retained unpublished receipt is delivered before resume HTTP and only when observed", async () => {
  const events = responseEvents({ id: "retained-receipt", content: "later" });
  const state = new ResponseStreamState(); let calls = 0, deliveries = 0;
  const c = client(async () => { calls++; return calls === 1 ? sse(events.slice(0, 2)) : json({ error: { message: "unavailable" } }, 503); });
  await assert.rejects(async () => { for await (const _ of c.stream(request, { state })) { /* retain checkpoint */ } }, { code: "llm_streaming_error" });
  const options = { onResponseReceipt: () => { deliveries++; assert.equal(calls, 1); throw new NetworkError("observer rejected"); } };
  await assert.rejects(async () => { for await (const _ of c.resume(state, {}, options)) {} }, { code: "llm_response_observer_failed" });
  assert.equal(calls, 1); assert.equal(deliveries, 1);
  await assert.rejects(async () => { for await (const _ of c.resume(state, {}, options)) {} }, { code: "llm_server_error" });
  assert.equal(calls, 2); assert.equal(deliveries, 1);
});

test("Receipt gates native progress, rejects wrong identities, and survives SSE diagnostic failure", async () => {
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); let delivered = 0;
  const c = client(async () => responseSseResponse({ id: "gated", content: "done" }));
  const iterator = c.stream(request, { onResponseReceipt: () => { delivered++; entered.resolve(); return gate.promise; } });
  let progressed = false; const next = iterator.next().then(value => { progressed = true; return value; });
  await entered.promise; assert.equal(progressed, false); gate.resolve(); await next;
  for await (const _ of iterator) {} assert.equal(delivered, 1);
  let wrong = 0;
  const foreign = client(async () => responseJsonResponse({ id: "foreign", content: "bad" }));
  await assert.rejects(foreign.retrieve("expected", {}, { onResponseReceipt: () => { wrong++; } }), { code: "responses_identity_changed" });
  assert.equal(wrong, 0);
  const events = responseEvents({ id: "deep-stream", content: "ok", usage: billedUsage });
  let deep: Record<string, unknown> = {}; for (let i = 0; i < 9; i++) deep = { nested: deep };
  (events.at(-1) as { response: Record<string, unknown> }).response.extension = deep;
  let receipt: import("../../src/shared/llm/client.ts").ResponseReceipt | undefined;
  const fresh = client(async () => sse(events), { responses: { maximumDepth: 6 } });
  await assert.rejects(async () => { for await (const _ of fresh.stream(request, { onResponseReceipt: value => { receipt = value; } })) {} }, { code: "llm_unexpected_error" });
  assert.equal(receipt?.responseId, "deep-stream"); assert.equal(fresh.getStats().totalTokens.total, 10);
});

test("Receipt local retirement keeps its truthful result when the optional logger rejects", async () => {
  let rejectLog = false;
  const c = client(async () => responseJsonResponse({ id: "retire-log", status: "queued" }), {
    logger: { log: () => { if (rejectLog) throw new Error("untrusted logger payload"); } } });
  let receipt: import("../../src/shared/llm/client.ts").ResponseReceipt | undefined;
  await c.create(request, { onResponseReceipt: value => { receipt = value; } });
  rejectLog = true; assert.equal(receipt!.retire(), true); assert.equal(receipt!.retire(), false);
  assert.equal(c.getResponseTracking().pending, 0);
});

test("Retained receipts never retire a later re-adopted same-ID entry or acquire external ownership", async () => {
  let index = 0;
  const c = client(async (_url, init) => init?.method === "GET" ? responseJsonResponse({ id: "X", status: "queued" })
    : responseJsonResponse(++index === 2 ? { id: "Y", content: "done", usage: zeroUsage } : { id: "X", status: "queued" }),
    { responses: { maximumTrackedResponses: 1 } });
  let external: import("../../src/shared/llm/client.ts").ResponseReceipt | undefined;
  await c.retrieve("X", {}, { onResponseReceipt: value => { external = value; } });
  const receipts: import("../../src/shared/llm/client.ts").ResponseReceipt[] = [];
  const options = { onResponseReceipt: (value: import("../../src/shared/llm/client.ts").ResponseReceipt) => { receipts.push(value); } };
  await c.create(request, options); assert.equal(external!.retire(), false); assert.equal(receipts[0]!.retire(), true);
  await c.create(request); await c.create(request, options);
  assert.equal(receipts[0]!.retire(), false); assert.equal(external!.retire(), false);
  assert.equal(c.getResponseTracking().pending, 1); assert.equal(receipts[1]!.retire(), true);
});

test("Accepted diagnostic failure remains primary when receipt observer hits the request deadline", async t => {
  mockDoorClock(t);
  let extension: unknown = {}; for (let i = 0; i < 9; i++) extension = { child: extension };
  const resource = { ...responseResource({ id: "failed-observation", content: "done", usage: billedUsage }), extension };
  const entered = Promise.withResolvers<void>(); let receipt: import("../../src/shared/llm/client.ts").ResponseReceipt | undefined;
  const c = client(async () => json(resource), { timeout: 100, responses: { operationTimeoutMs: 1000, maximumDepth: 6 } });
  const pending = c.create(request, { onResponseReceipt: value => { receipt = value; entered.resolve(); return new Promise<void>(() => {}); } });
  const rejection = assert.rejects(pending, { code: "llm_unexpected_error" });
  await entered.promise; t.mock.timers.tick(100); await rejection;
  assert.equal(receipt?.responseId, "failed-observation"); assert.equal(c.getStats().totalTokens.total, 10);
  assert.equal(c.getQueue().active, 0);
});

test("Low-level iterator return retains owned receipt and late usage until explicit caller retirement", async () => {
  const c = client(async (_url, init) => init?.method === "GET" ? responseJsonResponse({ id: "returned", content: "done", usage: billedUsage })
    : responseSseResponse({ id: "returned", content: "done" }));
  let receipt: import("../../src/shared/llm/client.ts").ResponseReceipt | undefined;
  const iterator = c.stream(request, { onResponseReceipt: value => { receipt = value; } });
  await iterator.next(); await iterator.next(); await iterator.return(undefined as never);
  assert.equal(c.getResponseTracking().pending, 1); assert.equal(c.getQueue().active, 0);
  assert.equal(receipt!.retire(), true); await c.retrieve("returned");
  assert.equal(c.getStats().totalTokens.total, 10); assert.equal(c.getResponseTracking().unavailableUsage, 0);
});

test("Accepted mutable create receipt failure preserves its typed cause instead of delivery ambiguity", async () => {
  let calls = 0;
  const c = client(async () => { calls++; return responseJsonResponse({ id: "mutable-accepted", status: "queued" }); });
  await assert.rejects(c.create(({ model: "test-model", input: "act", conversation: "known-conversation" }), {
    onResponseReceipt: () => { throw new NetworkError("observer failure"); },
  }), { code: "llm_response_observer_failed" });
  assert.equal(calls, 1); assert.equal(c.getResponseTracking().pending, 1);
});

test("Private receipt observer diagnostics cannot expose the handle or held credentials", async () => {
  for (const late of [false, true]) for (const arbitraryCode of [false, true]) {
    const id = "private-receipt-identity", secret = "shortKey77", state = new ResponseStreamState(); let calls = 0;
    const c = client(async () => { calls++; return late ? sse(responseEvents({ id, content: "later" }).slice(0, 2)) : responseJsonResponse({ id, status: "queued" }); }, { apiKey: secret });
    if (late) await assert.rejects(async () => { for await (const _ of c.stream(request, { state })) {} }, { code: "llm_streaming_error" });
    const options = { onResponseReceipt: (receipt: import("../../src/shared/llm/client.ts").ResponseReceipt) => {
      if (arbitraryCode) throw new LLMError("private observer", `${receipt.responseId}-${secret}`, "network", true, { secret }, 503);
      throw new NetworkError(`private receipt ${receipt.responseId} ${secret}`, { copied: secret, receipt: receipt.responseId });
    } };
    const operation = late ? (async () => { for await (const _ of c.resume(state, {}, options)) {} })() : c.create(request, options);
    await assert.rejects(operation, error => {
      assert.ok(error instanceof LLMError); assert.equal(error.code, "llm_response_observer_failed"); assert.equal(error.errorType, "network"); assert.equal(error.retryable, false);
      assert.equal(JSON.stringify({ ...error, message: error.message }).includes(id), false);
      assert.equal(JSON.stringify({ ...error, message: error.message }).includes(secret), false); return true;
    });
    assert.equal(calls, 1);
  }
});

async function observerTurn(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
/** Real loopback I/O takes more than one turn: take turns (bounded by wall time) until `condition` holds; answers whether it did. */
async function until(condition: () => boolean, withinMs = 3000): Promise<boolean> {
  const deadline = performance.now() + withinMs;
  while (!condition() && performance.now() < deadline) await observerTurn();
  return condition();
}
/**
 * A body whose read FAILS after the status and headers arrived: one byte is
 * sent (so the status line and headers reach the client), then the stream
 * errors and the upstream drops the connection mid-body — the real-transport
 * form of a response body that cannot be read.
 */
function failingBody(message: string): ReadableStream<Uint8Array> {
  let pulls = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (pulls++ === 0) { controller.enqueue(new TextEncoder().encode("{")); return undefined; }
    return new Promise<void>((resolve) => setTimeout(() => { controller.error(new Error(message)); resolve(); }, 20));
  } });
}

test("Admission handoff abort cannot invoke required observers or leak acquired ownership", async () => {
  const controller = new AbortController(), gate = Promise.withResolvers<void>(); let callbacks = 0, calls = 0, settled = false;
  const reason = new NetworkError("private-handoff-reason");
  const c = client(async () => { calls++; return responseJsonResponse({ content: "done" }); }); c.pauseQueue();
  const operation = c.create(request, { signal: controller.signal, onRequest() { callbacks++; return gate.promise; } });
  const outcome = operation.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  try {
    await observerTurn(); assert.equal(c.getQueue().pending, 1);
    c.resumeQueue(); controller.abort(reason); await observerTurn();
    assert.equal(settled, true); assert.equal(callbacks, 0); assert.equal(calls, 0);
    assert.equal(c.getQueue().active, 0); assert.equal(c.getQueue().pending, 0); assert.equal(c.getResponseTracking().reserved, 0);
  } finally { gate.resolve(); await outcome; }
  const error = await outcome; assert.ok(error instanceof LLMError); assert.equal(error.code, "llm_cancelled"); assert.notEqual(error, reason);
});

test("Required request observer uses the actual attempt signal and is bounded in every predispatch lifetime", async t => {
  mockDoorClock(t);
  for (const phase of ["caller", "attempt", "operation"] as const) {
    const controller = new AbortController(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    let lifetime: AbortSignal | undefined, calls = 0, settled = false;
    const c = client(async () => { calls++; return responseJsonResponse({ content: "done" }); }, { timeout: phase === "operation" ? 1000 : 100, responses: { operationTimeoutMs: phase === "operation" ? 100 : 1000 } });
    const pending = c.create(request, { signal: controller.signal, onRequest(_event, signal) { lifetime = signal; entered.resolve(); return gate.promise; } });
    const outcome = pending.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    await entered.promise;
    if (phase === "caller") controller.abort(new NetworkError("private-request-reason")); else t.mock.timers.tick(100);
    try {
      await observerTurn(); assert.equal(settled, true, `${phase} deadline must stop waiting before callback settlement`);
      assert.equal(lifetime?.aborted, true); if (phase === "caller") assert.equal(lifetime?.reason, controller.signal.reason);
      assert.equal(calls, 0); assert.equal(c.getQueue().active, 0); assert.equal(c.getResponseTracking().reserved, 0);
    } finally { gate.resolve(); await outcome; }
    const error = await outcome; assert.ok(error instanceof LLMError); assert.equal(error.code, phase === "caller" ? "llm_cancelled" : "llm_timeout");
    assert.equal(JSON.stringify({ ...error, message: error.message }).includes("private-request-reason"), false);
  }
});

test("Required request observer faults never authorize retries, failover or ambiguous delivery", async () => {
  for (const mutable of [false, true]) for (const asynchronous of [false, true]) {
    let callbacks = 0, calls = 0;
    const c = client(async () => { calls++; return responseJsonResponse({ content: "done" }); }, { maxRetries: { network: 2 },
      providers: [{ id: "b", baseUrl: address("https://b.test/v1"), apiKey: "other-inert-key" }],
      failover: { enabled: true, providers: ["a", "b"], models: [], strategy: "priority", triggerOnError: ["network"] } });
    const body = mutable ? ({ input: "witness", conversation: "conv_owned" }) : request;
    await assert.rejects(c.create(body, { provider: "a", onRequest() { callbacks++; const error = new NetworkError("private-observer-fault", { value: "private-observer-fault" }); if (asynchronous) return Promise.reject(error); throw error; } }), error => {
      assert.ok(error instanceof LLMError); assert.equal(error.code, "llm_request_observer_failed"); assert.equal(error.retryable, false);
      assert.equal(error.message.includes("private-observer-fault"), false); assert.deepEqual(error.safeDetails, {}); return true;
    });
    assert.equal(callbacks, 1); assert.equal(calls, 0); assert.equal(c.getStats().failovers, 0); assert.equal(c.getStats().totalRetries, 0);
    assert.equal(c.getQueue().active, 0); assert.equal(c.getResponseTracking().reserved, 0); assert.equal(c.getCircuit().consecutiveFailures, 0);
  }
});

test("Headers are prepared before required observation, and dispatched mutable failures stay uncertain", async () => {
  let callbacks = 0, calls = 0;
  const c = client(async () => { calls++; throw new TypeError("fetch failed"); }, { headers: { "bad header": "invalid" }, maxRetries: { "bad-request": 2, network: 2 } });
  // The outbound policy's header allowlist refuses before dispatch, typed, never retried.
  await assert.rejects(c.create(request, { onRequest() { callbacks++; } }), { code: "outbound_header_invalid", errorType: "bad-request" });
  assert.equal(callbacks, 0); assert.equal(calls, 0); assert.equal(c.getStats().totalRetries, 0);
  const mutable = client(async () => { calls++; throw new TypeError("fetch failed"); });
  await assert.rejects(mutable.create(({ input: "witness", conversation: "conv_owned" })), { code: "llm_delivery_uncertain" });
  assert.equal(calls, 1);
});

test("A second-attempt local observer failure does not damage provider health or repeat dispatch", async () => {
  let calls = 0, callbacks = 0;
  const c = client(async () => { calls++; return json({ error: { message: "unavailable" } }, 503); }, { maxRetries: { server: 1 }, adaptive: { enabled: true }, circuitBreaker: { threshold: 1, resetMs: 1000 } });
  const adaptiveBefore = c.getAdaptive();
  await assert.rejects(c.create(request, { onRequest() { if (++callbacks === 2) throw new NetworkError("private-second-attempt"); } }), { code: "llm_request_observer_failed" });
  assert.equal(calls, 1); assert.equal(callbacks, 2); assert.equal(c.getStats().totalRetries, 1); assert.equal(c.getCircuit().consecutiveFailures, 0); assert.deepEqual(c.getAdaptive(), adaptiveBefore);
});

test("Zero-dispatch request preparation cannot consume retry or failover budgets", async () => {
  let calls = 0, observers = 0;
  const c = client(async () => { calls++; return responseJsonResponse({ content: "done" }); }, { responses: { maximumRequestBytes: 20 }, maxRetries: { "invalid-response": 2 } });
  await assert.rejects(c.create(request, { onRequest() { observers++; } }), error => error instanceof InputError && error.code === "responses_request_too_large");
  assert.equal(calls, 0); assert.equal(observers, 0); assert.equal(c.getStats().totalRetries, 0); assert.equal(c.getCircuit().consecutiveFailures, 0);
});

for (const observer of ["logger", "metrics"] as const) for (const timing of ["sync", "async"] as const) {
  test(`Optional ${observer} ${timing} faults preserve native outcomes and diagnostics`, async t => {
    const asynchronous = timing === "async";
    for (const mode of ["json", "sse", "failed", "retry"] as const) {
      const sink = createCollectingSink();
      configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { enabledSinks: ["collecting"] } }, [sink]);
      t.after(resetDebugSystem);
      let calls = 0, observations = 0;
      const fault = () => { observations++; const error = new NetworkError("private-optional-observer", { responseId: "private-optional-observer" });
        if (asynchronous) return Promise.resolve().then(() => { throw error; }); throw error; };
      const c = client(async () => { calls++;
        if (mode === "failed" || mode === "retry" && calls === 1) return json({ error: { message: "provider unavailable" } }, 503);
        return mode === "sse" ? responseSseResponse({ id: "optional", content: "done", usage: billedUsage }) : responseJsonResponse({ id: "optional", content: "done", usage: billedUsage });
      }, { ...(observer === "logger" ? { logger: { log: fault } } : {}), maxRetries: { server: mode === "retry" ? 1 : 0 } });
      const options = observer === "metrics" ? { metricsSink: fault } : {};
      if (mode === "failed") await assert.rejects(c.create(request, options), { code: "llm_server_error" });
      else if (mode === "sse") { const types: string[] = []; for await (const event of c.stream(request, options)) types.push(event.type); assert.equal(types.at(-1), "finish"); assert.ok(types.includes("response")); }
      else assert.equal((await c.create(request, options)).response.id, "optional");
      await observerTurn();
      assert.equal(calls, mode === "retry" ? 2 : 1); assert.equal(observations, calls); assert.equal(getDebugSignals().bestEffortFailures, calls);
      assert.equal(sink.events.filter(event => event.code === "best_effort_failed").length, calls);
      assert.equal(JSON.stringify(sink.events).includes("private-optional-observer"), false);
      assert.equal(c.getQueue().active, 0); assert.equal(c.getResponseTracking().reserved, 0);
      assert.equal(c.getStats().totalTokens.total, mode === "failed" ? 0 : 10);
    }
  });
}

test("Pending optional observers invoke immediately without holding native results, and late rejection is contained", async t => {
  for (const observer of ["logger", "metrics"] as const) {
    const sink = createCollectingSink(); configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { enabledSinks: ["collecting"] } }, [sink]); t.after(resetDebugSystem);
    const gate = Promise.withResolvers<void>(); let invoked = false, settled = false;
    const callback = () => { invoked = true; return gate.promise; };
    const c = client(async () => responseJsonResponse({ content: "done", usage: billedUsage }), observer === "logger" ? { logger: { log: callback } } : {});
    const outcome = c.create(request, observer === "metrics" ? { metricsSink: callback } : {}).then(value => { settled = true; return value; });
    try {
      assert.equal(await until(() => invoked), true); assert.equal(await until(() => settled), true, "optional observers cannot hold the operation");
      assert.equal((await outcome).content, "done"); assert.equal(c.getQueue().active, 0); assert.equal(c.getStats().totalTokens.total, 10);
    } finally { gate.reject(new NetworkError("private-late-observer")); await outcome.catch(() => undefined); }
    await observerTurn();
    assert.equal(getDebugSignals().bestEffortFailures, 1); assert.equal(JSON.stringify(sink.events).includes("private-late-observer"), false);
  }
});

test("Receipt taxonomy inspection contains hostile prototypes and getters on create and retained resume", async () => {
  for (const late of [false, true]) for (const trap of ["prototype", "taxonomy"] as const) {
    const secret = "private-receipt-trap", state = new ResponseStreamState(); let calls = 0;
    const c = client(async () => { calls++; return late ? sse(responseEvents({ id: "hostile", content: "later" }).slice(0, 2)) : responseJsonResponse({ id: "hostile", status: "queued" }); });
    if (late) await assert.rejects(async () => { for await (const _ of c.stream(request, { state })) {} }, { code: "llm_streaming_error" });
    const thrown = new NetworkError(secret, { copied: secret });
    const hostile = trap === "prototype" ? new Proxy({}, { getPrototypeOf() { throw thrown; } })
      : Object.defineProperty(new NetworkError(secret), "errorType", { get() { throw thrown; } });
    const options = { onResponseReceipt() { throw hostile; } };
    await assert.rejects(late ? (async () => { for await (const _ of c.resume(state, {}, options)) {} })() : c.create(request, options), error => {
      assert.ok(error instanceof LLMError); assert.equal(error.code, "llm_response_observer_failed"); assert.equal(error.errorType, "invalid-response");
      assert.equal(error.retryable, false); assert.deepEqual(error.safeDetails, {}); assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify({ ...error, message: error.message }).includes(secret), false); return true;
    });
    assert.equal(calls, 1); assert.equal(c.getResponseTracking().pending, 1); assert.equal(c.getQueue().active, 0);
  }
});

test("Private abort reasons remain safe across pre-call, body reads, retry sleep and retained receipt", async t => {
  mockDoorClock(t);
  for (const phase of ["pre", "json", "sse", "backoff", "resume"] as const) {
    const controller = new AbortController(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const secret = "private-phase-reason", reason = new NetworkError(secret, { copied: secret });
    // `signal` is the CLIENT's retained lifetime (from the receipt); the upstream's own request signal is not the client's.
    const state = new ResponseStreamState(); let calls = 0, signal: AbortSignal | null | undefined, settled = false;
    const c = client(async () => {
      calls++;
      if (phase === "backoff") return json({ error: { message: "unavailable" } }, 503);
      if (phase === "resume") return sse(responseEvents({ id: "phase-resume", content: "later" }).slice(0, 2));
      return new Response(new ReadableStream<Uint8Array>({ start(stream) {
        if (phase === "sse") stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(responseEvents({ id: "phase-stream", content: "later" })[0])}\n\n`));
        entered.resolve();
      } }), { headers: { "content-type": phase === "sse" ? "text/event-stream" : "application/json" } });
    }, { maxRetries: { server: 1 }, backoff: { baseMs: 50, maxMs: 50, factor: 1, jitter: 0 }, timeout: 1000, responses: { operationTimeoutMs: 2000 } });
    if (phase === "pre") controller.abort(reason);
    if (phase === "resume") await assert.rejects(async () => { for await (const _ of c.stream(request, { state })) {} }, { code: "llm_streaming_error" });
    const options = { signal: controller.signal,
      metricsSink: () => { if (phase === "backoff") entered.resolve(); },
      onResponseReceipt: (_receipt: unknown, lifetime: AbortSignal) => { if (phase === "resume") { signal = lifetime; entered.resolve(); return gate.promise; } return undefined; },
    };
    const pending = phase === "sse" ? (async () => { for await (const _ of c.stream(request, options)) {} })()
      : phase === "resume" ? (async () => { for await (const _ of c.resume(state, {}, options)) {} })() : c.create(request, options);
    const outcome = pending.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    if (phase !== "pre") { await entered.promise; controller.abort(reason); }
    try {
      assert.equal(await until(() => settled), true, `${phase} must settle before any callback recovery`);
      const error = await outcome; assert.ok(error instanceof LLMError); assert.equal(error.code, "llm_cancelled"); assert.notEqual(error, reason);
      assert.equal(JSON.stringify({ ...error, message: error.message }).includes(secret), false); assert.deepEqual(error.safeDetails, {});
      assert.equal(controller.signal.reason, reason); if (signal) assert.equal(signal.reason, reason);
      assert.equal(calls, phase === "pre" ? 0 : 1); assert.equal(c.getQueue().active, 0); assert.equal(c.getQueue().pending, 0); assert.equal(c.getResponseTracking().reserved, 0);
      if (phase === "backoff") { assert.equal(c.getStats().totalRetries, 1); t.mock.timers.tick(50); await observerTurn(); assert.equal(calls, 1); }
      if (phase === "resume") assert.equal(c.getResponseTracking().pending, 1);
    } finally { gate.resolve(); await outcome; }
  }
});

test("Public display waits for terminal context while private progress and receipt remain available", async () => {
  const secret = "terminal44private", events = responseEvents({ chunks: ["copied ", secret] });
  const final = events.at(-1)! as { response: Record<string, unknown> }; final.response.metadata = { password: secret };
  let reached = false; const chunks: import("../../src/shared/llm/client.ts").StreamChunk[] = [];
  let wire!: ReadableStreamDefaultController<Uint8Array>, receipts = 0;
  const encoder = new TextEncoder(), encode = (values: readonly unknown[]) => encoder.encode(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(""));
  const c = client(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; controller.enqueue(encode(events.slice(0, -1))); } }),
    { headers: { "content-type": "text/event-stream", "x-request-id": secret, "x-ratelimit-remaining-tokens": "4" } }));
  const running = (async () => { for await (const chunk of c.stream(request, { onResponseReceipt() { receipts++; } })) {
    chunks.push(chunk); if (chunk.type === "response_event" && chunk.event.type === "response.output_item.done") reached = true;
  } })().then(() => ({ error: undefined }), (error: unknown) => ({ error }));
  try {
    assert.equal(await until(() => reached), true, "private progress must arrive before releasing terminal bytes"); assert.equal(receipts, 1);
    assert.equal(chunks.some(chunk => ["headers", "content", "refusal", "reasoning", "model"].includes(chunk.type)), false);
    // Private progress arrives before the terminal bytes; a piece is held back only while its end could still grow into
    // this client's held key ("…te" of "terminal44private" may begin "test-http-secret-value"), so its chunking is not a contract.
    const progressText = chunks.flatMap(chunk => chunk.type === "response_event" ? chunk.progress ?? [] : []).map(part => part.type === "content" ? part.text : "").join("");
    assert.ok(progressText.startsWith(`copied ${secret.slice(0, -2)}`), progressText);
  } finally { if (wire.desiredSize !== null) { wire.enqueue(encode(events.slice(-1))); wire.close(); } await running; }
  assert.equal((await running).error, undefined);
  const terminal = chunks.find(chunk => chunk.type === "response")!;
  assert.equal(terminal.type, "response"); if (terminal.type !== "response") return;
  assert.equal(JSON.stringify(terminal.observation).includes(secret), false);
  assert.equal(JSON.stringify(terminal.response).includes(secret), true);
  assert.equal(chunks.filter(chunk => chunk.type === "content").length, 1);
});

test("Endpoint envelopes preserve native bodies and explicit absence with one qualified header view", async () => {
  const secret = "endpoint44private", opaque = "opaque endpoint payload";
  const headers = { "x-password": secret, "x-request-id": secret };
  const native = {
    compact: { object: "response.compaction", id: "cmp_1", created_at: 1, output: [{ type: "compaction", encrypted_content: opaque }], usage: billedUsage, extension: secret },
    page: { object: "list", data: [{ type: "reasoning", encrypted_content: opaque, summary: [] }], first_id: null, last_id: null, has_more: false, extension: secret },
    count: { object: "response.input_tokens", input_tokens: 0, extension: secret },
    deletion: { object: "response", id: "known", deleted: true, extension: secret },
  };
  const c = client(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = path.endsWith("/compact") ? native.compact : path.endsWith("/input_items") ? native.page : path.endsWith("/input_tokens") ? native.count : native.deletion;
    return path.endsWith("/absent") && init?.method === "DELETE" ? new Response(null, { status: 204, headers }) : new Response(JSON.stringify(body), { headers });
  });
  const results = [await c.compact(({ model: "test-model", input: [] })), await c.listInputItems("known"),
    await c.countInputTokens(({ input: [] })), await c.delete("known")];
  for (const [index, result] of results.entries()) {
    assert.deepEqual(result.response, Object.values(native)[index]);
    assert.ok(result.observation); assert.equal(JSON.stringify(result.observation).includes(secret), false); assert.equal(JSON.stringify(result.observation).includes(opaque), false);
    assert.equal(result.headers, result.observation.headers); assert.equal(Object.isFrozen(result.observation), true);
    assert.ok(Object.hasOwn(result.headers, "x-request-id"));
    assert.equal((result.observation.response as { object: string }).object, (Object.values(native)[index] as { object: string }).object);
  }
  assert.equal((results[0]!.observation!.response as { usage: { total_tokens: number } }).usage.total_tokens, 10);
  assert.equal((results[2]!.observation!.response as { input_tokens: number }).input_tokens, 0);
  const absent = await c.delete("absent"); assert.equal(absent.response, undefined); assert.equal(Object.hasOwn(absent.observation!, "response"), false);
  assert.ok(absent.observation); assert.equal(JSON.stringify(absent.observation).includes(secret), false);
});

test("Resume envelope uses actual retrieval headers with retained omitted evidence", async () => {
  const secret = "resume44private", events = responseEvents({ chunks: ["my password may be ", secret] });
  const split = events.findIndex(event => event.type === "response.output_text.done"); let calls = 0;
  const resource = responseResource({ status: "failed", output: [] }); resource.error = { code: "server_error", message: "failed" };
  const c = client(async () => { const body = ++calls === 1 ? events.slice(0, split) : [{ type: "response.failed", sequence_number: split, response: resource }];
    return new Response(body.map(value => `data: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "x-request-id": calls === 1 ? "original-attempt" : secret, "x-model-id": calls === 1 ? "original-model" : "retrieved-model" } }); });
  const state = new ResponseStreamState(); await assert.rejects(async () => { for await (const _ of c.stream(request, { state })) {} }, { code: "llm_streaming_error" });
  let view: unknown;
  await assert.rejects(async () => { for await (const chunk of c.resume(state)) if (chunk.type === "response") view = chunk.observation; }, { code: "llm_response_failed" });
  assert.ok(view); assert.equal(JSON.stringify(view).includes(secret), false); assert.equal(JSON.stringify(view).includes("original-attempt"), false);
  const headers = (view as { headers: Record<string, string> }).headers; assert.equal(headers["x-model-id"], "retrieved-model"); assert.ok(Object.hasOwn(headers, "x-request-id"));
});

test("Accepted evidence survives failed public projection after teardown for JSON and SSE", async () => {
  for (const streaming of [false, true]) {
    const toolCalls = [{ id: "private-call", type: "function" as const, function: { name: "effect", arguments: "{}" } }];
    const resource = responseResource({ content: "private accepted evidence", toolCalls, usage: billedUsage });
    let deep: Record<string, unknown> = {}; for (let i = 0; i < 10; i++) deep = { nested: deep }; resource.extension = deep;
    const events = responseEvents({ content: "private accepted evidence", toolCalls, usage: billedUsage }); (events.at(-1) as { response: unknown }).response = resource;
    let calls = 0, observed = 0, evidence: import("../../src/shared/llm/client.ts").ResponseEvidence | undefined;
    const c = client(async () => { calls++; return streaming ? sse(events) : json(resource); }, { responses: { maximumDepth: 6 } });
    const options = { onResponseEvidence(value: import("../../src/shared/llm/client.ts").ResponseEvidence) {
      observed++; evidence = value; assert.equal(c.getQueue().active, 0); assert.equal(c.getStats().totalTokens.total, 10);
      throw new NetworkError("private observer witness");
    } };
    const chunks: import("../../src/shared/llm/client.ts").StreamChunk[] = [];
    await assert.rejects(streaming ? (async () => { for await (const chunk of c.stream(request, options)) chunks.push(chunk); })() : c.create(request, options), { code: "llm_unexpected_error" });
    assert.equal(calls, 1); assert.equal(observed, 1); assert.deepEqual(evidence!.response, resource); assert.equal(evidence!.observation, undefined);
    if (streaming) {
      assert.equal(chunks.filter(chunk => chunk.type === "response").length, 1);
      assert.equal(chunks.some(chunk => ["content", "headers", "model", "finish", "tool_call_done"].includes(chunk.type)), false);
    }
  }
});

test("Private evidence observer is abort-bounded after HTTP teardown without replay", async () => {
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), controller = new AbortController();
  let calls = 0, observed = 0;
  const c = client(async () => { calls++; return responseJsonResponse({ content: "done", usage: billedUsage }); });
  let settled = false;
  const outcome = c.create(request, { signal: controller.signal, onResponseEvidence(_value, signal) {
    observed++; assert.equal(c.getQueue().active, 0); assert.equal(signal.aborted, false); entered.resolve(); return gate.promise;
  } }).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  try { const first = await Promise.race([entered.promise.then(() => "entered"), outcome.then(() => "settled")]); assert.equal(first, "entered"); controller.abort(new Error("private evidence observer abort")); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, true); }
  finally { gate.resolve(); await outcome; }
  const result = await outcome; assert.ok("error" in result); assert.equal(result.error.code, "llm_cancelled"); assert.equal(result.error.message.includes("private evidence"), false);
  assert.equal(observed, 1); assert.equal(calls, 1); assert.equal(c.getStats().totalTokens.total, 10);
});


test("Retained context bound fails closed after accepted native evidence and accounting", async () => {
  const state = new ResponseStreamState({ maximumObservationBytes: 8 });
  const c = client(async () => responseSseResponse({ content: "private", usage: billedUsage }));
  const chunks: import("../../src/shared/llm/client.ts").StreamChunk[] = [];
  await assert.rejects(async () => { for await (const chunk of c.stream(request, { state })) chunks.push(chunk); },
    error => error instanceof LLMError && error.code === "llm_invalid_response" && error.safeDetails.protocolCode === "responses_observation_context_unavailable");
  assert.equal(c.getStats().totalTokens.total, 10); assert.ok(chunks.some(chunk => chunk.type === "response" && chunk.response.output.length === 1 && chunk.observation === undefined));
  assert.equal(chunks.some(chunk => ["content", "headers", "model", "finish", "tool_call_done"].includes(chunk.type)), false);
});

test("Earlier native error taxonomy beats terminal observation and evidence callback failures", async () => {
  const events = [...responseEvents({ content: "not successful", usage: billedUsage })];
  events.splice(2, 0, { type: "error", error: { code: "credit_balance_exhausted", message: "private earlier error", param: null } });
  let deep: unknown = {}; for (let i = 0; i < 12; i++) deep = { nested: deep }; (events.at(-1) as { response: Record<string, unknown> }).response.extension = deep;
  const c = client(async () => sse(events.map((event, sequence_number) => ({ ...event, sequence_number }))), { responses: { maximumDepth: 6 } });
  let captured = false;
  await assert.rejects(async () => { for await (const _ of c.stream(request, { onResponseEvidence() { captured = true; throw new NetworkError("secondary private error"); } })) {} },
    error => error instanceof LLMError && error.code === "llm_quota_exhausted" && !error.retryable && !error.message.includes("private"));
  assert.equal(captured, true); assert.equal(c.getStats().totalTokens.total, 10);
});

// verify/a2-correctness NEW-3: the DECODER attaches its one classification to
// the failed resource chunk (the mocks synthesize `failure` themselves, so no
// test proved the decoder does), and the client's teardown fallback — the
// resource re-yielded when the operation fails after the terminal event —
// carries that SAME failure, so a consumer's throwing observer or an abort
// cannot replace the provider's classified failure.
test("A failed terminal resource carries the decoder's classified failure, also on the teardown fallback", async () => {
  const failed = { ...responseResource({ id: "failed-fallback", status: "failed" }), error: { code: "rate_limit_exceeded", message: "slow down" } };
  const state = new ResponseStreamState();
  const decoded = [
    ...state.consume({ type: "response.created", sequence_number: 0, response: { ...failed, status: "in_progress", error: null } }, undefined, TEST_FAILURE_OPTIONS),
    ...state.consume({ type: "response.failed", sequence_number: 1, response: failed }, undefined, TEST_FAILURE_OPTIONS),
  ];
  const resource = decoded.find((chunk) => chunk.type === "response");
  const errorChunk = decoded.find((chunk) => chunk.type === "error");
  assert.ok(resource?.type === "response" && resource.failure instanceof LLMError, "the decoder attaches the classified failure to the resource");
  assert.equal(resource.failure.code, "llm_rate_limited");
  assert.ok(errorChunk?.type === "error" && errorChunk.error === resource.failure, "one classification: the error chunk carries the same object");

  // The client: the evidence observer throws AFTER the terminal event, so the
  // operation fails and the stream re-yields the accepted resource before
  // throwing — with the failure it was classified with.
  const c = client(async () => sse([
    { type: "response.created", sequence_number: 0, response: { ...failed, status: "in_progress", error: null } },
    { type: "response.failed", sequence_number: 1, response: failed },
  ]));
  const chunks: import("../../src/shared/llm/client.ts").StreamChunk[] = [];
  let thrown: unknown;
  try { for await (const chunk of c.stream(request, { onResponseEvidence() { throw new NetworkError("secondary observer fault"); } })) chunks.push(chunk); }
  catch (error) { thrown = error; }
  const fallback = chunks.find((chunk) => chunk.type === "response");
  assert.ok(fallback?.type === "response" && fallback.status === "failed", "the accepted resource is re-yielded on teardown");
  assert.ok(fallback.failure instanceof LLMError && fallback.failure.code === "llm_rate_limited", "the fallback resource carries its classified failure");
  assert.ok(thrown instanceof LLMError && thrown.code === "llm_rate_limited", "the stream ends with the provider's failure, not the observer's");
});

test("Native errors without terminal context withhold diagnostic strings and headers", async () => {
  for (const started of [false, true]) {
    const secret = "early44private", prefix = started ? responseEvents({ content: "unused" }).slice(0, 2) : [];
    const events = [...prefix, { type: "error", sequence_number: prefix.length, error: { type: "insufficient_quota", code: "credit_balance_exhausted", message: `copied ${secret}`, param: null } }];
    const c = client(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "x-api-key": secret, "x-request-id": secret } }));
    const chunks: import("../../src/shared/llm/client.ts").StreamChunk[] = [];
    await assert.rejects(async () => { for await (const chunk of c.stream(request)) chunks.push(chunk); }, error => {
      assert.ok(error instanceof LLMError); assert.equal(error.code, "llm_quota_exhausted"); assert.equal(error.retryable, false);
      assert.equal(JSON.stringify({ message: error.message, details: error.safeDetails }).includes(secret), false); return true;
    });
    assert.equal(chunks.some(chunk => ["content", "headers", "model", "finish", "tool_call_done"].includes(chunk.type)), false);
  }
});

test("Composition uses configured model for ordinary input and preserves prompt-selected omission", async () => {
  for (const configured of [undefined, "configured-model"]) {
    for (const promptOnly of [false, true]) {
      let body: Record<string, unknown> | undefined, observed: unknown, requested: string | undefined;
      serve(async (_url, init) => { body = JSON.parse(String(init.body)); return responseJsonResponse({ model: "actual-provider-model", content: "done", usage: billedUsage }); });
      const c = new SharedLLMClient({ baseUrl: address("https://a.test/v1"), allowPrivateAddress: true, providerId: "a", apiKey: "fixture-key", ...(configured === undefined ? {} : {model: configured}) });
      const result = await c.create(promptOnly ? { prompt: { id: "pmpt_fixture" } } : { input: "ordinary" }, {
        onRequest(event) { observed = event.request; assert(Object.isFrozen(event.request)); }, onResponseReceipt(receipt) { requested = receipt.requestedModel; },
      });
      const expectedModel = promptOnly ? undefined : configured;
      assert.equal(Object.hasOwn(body!, "model"), expectedModel !== undefined);
      assert.equal(body!.model, expectedModel); assert.deepEqual(body, observed); assert.equal(requested, expectedModel);
      assert.equal(result.response.model, "actual-provider-model"); assert.equal(result.observation?.display?.model, "actual-provider-model");
      assert.deepEqual(Object.keys(c.getStats().byModel), expectedModel === undefined ? [] : [expectedModel]);
      assert.equal(c.getStats().totalTokens.total, 10); assert.equal(c.getStats().byProvider.a?.totalTokens, 10);
    }
  }
});

test("Native defaults replace at top level and preserve explicit nullable and empty values", async () => {
  let sent: Record<string, unknown> | undefined, observed: unknown;
  const c = client(async (_url, init) => { sent = JSON.parse(String(init?.body)); return responseJsonResponse({ content: "done" }); }, {
    requestDefaults: { temperature: 1, max_output_tokens: 123, store: true, include: ["reasoning.encrypted_content"], text: { format: { type: "json_schema", name: "old", schema: { type: "object" } } }, metadata: { old: "value" } },
  });
  await c.create({ input: "witness", temperature: 0, store: false, include: [], metadata: {}, prompt_cache_key: null, text: { format: { type: "text" } } }, { onRequest(e) {
    observed = e.request;
    assert.throws(() => { (e.request as Record<string, unknown>).temperature = 2; }, TypeError);
    assert.throws(() => { (e.request.text as {format: {type: string}}).format.type = "changed"; }, TypeError);
  } });
  assert.deepEqual(sent, { model: "test-model", input: "witness", stream: false, temperature: 0, max_output_tokens: 123, store: false, include: [], metadata: {}, prompt_cache_key: null, text: { format: { type: "text" } } });
  assert.deepEqual(sent, observed);
});

test("Compact and count preserve null model and direct extension fields without create-only defaults", async () => {
  const bodies: Record<string, unknown>[] = [];
  const c = client(async (url, init) => { bodies.push(JSON.parse(String(init?.body))); return String(url).endsWith("/compact")
    ? json({ object: "response.compaction", id: "cmp_test", created_at: 1, output: [], usage: billedUsage })
    : json({ object: "response.input_tokens", input_tokens: 12 }); }, { requestDefaults: { temperature: 1, max_output_tokens: 123, instructions: "keep instructions" } });
  await c.compact({ model: null, input: [], extension: { keep: true } });
  await c.countInputTokens({ model: null, input: null, tools: null, extension: { keep: true } });
  assert.deepEqual(bodies, [{ model: null, input: [], instructions: "keep instructions", extension: { keep: true } }, { model: null, input: null, tools: null, instructions: "keep instructions", extension: { keep: true } }]);
});

test("Stream invocation captures provider and observers before first pull", async () => {
  let url = "", first = 0, second = 0;
  const c = client(async (target) => { url = String(target); return responseSseResponse({ content: "done" }); }, {
    providers: [{ id: "b", baseUrl: address("https://b.test/v1"), apiKey: "key-b-fixture" }],
  });
  const options = { provider: "a", onRequest() { first++; } };
  const stream = c.stream({ input: "witness" }, options);
  options.provider = "b"; options.onRequest = () => { second++; };
  for await (const value of stream) void value;
  assert.equal(new URL(url).hostname, "a.test"); assert.equal(first, 1); assert.equal(second, 0);
});

test("Conflicting native stream mode refuses before fetch", async () => {
  let calls = 0, observations = 0;
  const c = client(async () => { calls++; return responseSseResponse({ content: "done" }); });
  const options = {onRequest(){ observations++; }};
  await assert.rejects(c.create({ input: "witness", stream: true }, options), e => e instanceof InputError && e.code === "responses_stream_method_required");
  await assert.rejects(async () => { for await (const x of c.stream({ input: "witness", stream: false }, options)) void x; }, e => e instanceof InputError && e.code === "responses_stream_mode_invalid");
  assert.equal(calls, 0); assert.equal(observations, 0);
});

// The held credentials below are at the held floor
// (`privacy.heldCredentialMinimumLength`, 6): these arms are about RETENTION
// across resume, lifecycle errors and child responses, not about short values
// (those are replaced in their own slot only — llm-responses-privacy).
test("Resume and later lifecycle errors retain captured policy and intentional MCP/container credentials", async () => {
  const {createPrivacyPolicy}=await import("../../src/privacy/privacy-policy.ts");
  const {currentPrivacySettings}=await import("../../src/privacy/pii-registry.ts");
  let calls = 0;
  const state = new ResponseStreamState();
  const settings={tiers:{...currentPrivacySettings().tiers},disabledTypes:new Set(currentPrivacySettings().disabledTypes)};
  const privacy={policy:createPrivacyPolicy({redactionPrefix:"<RETAINED:",redactionSuffix:">"}),detection:{settings}};
  const full = responseEvents({ id: "resume-private-context", content: "prefix a7c9e1 middle b8d0f2 suffix contact alice@example.test", usage: billedUsage });
  const c = client(async () => { calls++; return calls<3?sse(calls === 1 ? full.slice(0, 1) : full.slice(1)):json({error:{message:"prefix a7c9e1 middle b8d0f2 suffix contact alice@example.test"}},400); });
  const stream=c.stream({ input: "work", tools: [{ type: "mcp", server_label: "fixture", server_url: "https://mcp.test", authorization: "a7c9e1" },
    {type:"code_interpreter",container:{type:"auto",network_policy:{type:"allowlist",allowed_domains:["example.test"],domain_secrets:[{domain:"example.test",name:"fixture",value:"b8d0f2"}]}}}] }, { state,privacy });
  privacy.policy=createPrivacyPolicy({redactionPrefix:"<CHANGED:",redactionSuffix:">"});settings.disabledTypes.add("email-address");
  await assert.rejects(async () => { for await (const x of stream) void x; }, e => e instanceof LLMError && e.code === "llm_streaming_error");
  let view: unknown;
  for await (const chunk of c.resume(state)) if (chunk.type === "response") view = chunk.observation;
  const observed=JSON.stringify(view);assert(view);assert.equal(observed.includes("a7c9e1"), false);assert.equal(observed.includes("b8d0f2"),false);
  assert.ok(observed.includes("prefix <RETAINED:secret> middle <RETAINED:secret> suffix"));assert.equal(observed.includes("<CHANGED:"),false);assert.equal(observed.includes("alice@example.test"),false);
  await assert.rejects(c.retrieve("resume-private-context"),e=>{assert(e instanceof LLMError);const diagnostic=JSON.stringify([e.message,e.safeDetails]);assert.equal(diagnostic.includes("a7c9e1"),false);assert.equal(diagnostic.includes("b8d0f2"),false);assert.ok(diagnostic.includes("<RETAINED:"));assert.equal(diagnostic.includes("alice@example.test"),false);return e.code==="llm_bad_request";});
  assert.equal(calls,3);
});

test("Continuation preserves origin credentials and late usage scope while selecting a new model", async () => {
  const sent: {url: string; authorization: string | null; body?: Record<string, unknown>}[] = [];
  const c = client(async (url, init) => { sent.push({url: String(url), authorization: new Headers(init?.headers).get("authorization"), ...(init?.body?{body:JSON.parse(String(init.body))}:{})});
    return responseJsonResponse({id: sent.length === 2 ? "next-model" : "origin-model", content:"done", usage: sent.length===1?null:billedUsage}); }, {
    models: [{providerId: "a", model:"next", requestDefaults:{max_output_tokens: 222}}, {providerId: "b", model:"next", requestDefaults:{max_output_tokens: 333}}],
    providers: [{id:"b",baseUrl: address("https://b.test/v1"),apiKey:"other-key"}],
  });
  await c.create({ input:"first", model:"test-model" });
  await c.create({ input:"next", previous_response_id:"origin-model", model:"next" });
  assert.equal(c.getStats().byModel["test-model"]?.totalTokens,0);assert.equal(c.getStats().byModel.next?.totalTokens,10);
  await c.retrieve("origin-model");
  for(const call of sent){assert.equal(new URL(call.url).hostname,"a.test");assert.equal(call.authorization,("Be" + "arer test-http-secret-value"));}
  assert.equal(sent[1]!.body!.model,"next"); assert.equal(sent[1]!.body!.max_output_tokens,222);
  assert.equal(c.getStats().byModel["test-model"]?.totalTokens,10);assert.equal(c.getStats().byModel.next?.totalTokens,10);
});

test("Hidden pre-transform declaration context shares the mint detector and never enters the wire or notice", async () => {
  const notices: unknown[] = [], bodies: Record<string, unknown>[] = [];
  const c = client(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return responseJsonResponse({content:"done"}); });
  await c.create({input:"prefix admin44 suffix"}, {privacy:{context:{input:[{role:"user",content:"my password may be admin44"}]}}, onRequest(e) { notices.push(e.redactions); assert.equal(JSON.stringify(e).includes("my password"),false); }});
  assert.equal(bodies[0]!.input,"prefix [REDACTED:secret] suffix");
  assert.equal(Object.hasOwn(bodies[0]!,"context"),false);
  assert.equal((notices[0] as unknown[]).length,1);
  let calls=0, observations=0;
  const bounded=client(async()=>{calls++;return responseJsonResponse({content:"done"});},{responses:{maximumRequestBytes:100}});
  const small={input:"small"}, context={input:"x".repeat(80)};
  assert.ok(JSON.stringify(small).length<100);assert.ok(JSON.stringify(context).length<100);assert.ok(JSON.stringify(small).length+JSON.stringify(context).length>100);
  await assert.rejects(bounded.create(small,{privacy:{context},onRequest(){observations++;}}), e=>e instanceof InputError && e.code==="responses_request_too_large");
  assert.equal(calls,0);assert.equal(observations,0);
});

test("Final composed defaults are bounded before request observation and fetch", async()=>{
  let calls=0, observations=0;
  const c=client(async()=>{calls++;return responseJsonResponse({content:"done"});},{responses:{maximumRequestBytes:160},requestDefaults:{instructions:"x".repeat(180)}});
  await assert.rejects(c.create({input:"small"},{onRequest(){observations++;}}), e=>e instanceof InputError && e.code==="responses_request_too_large");
  assert.equal(calls,0);assert.equal(observations,0);
});

test("Owned child responses inherit bounded intentional credentials under the child's current policy", async()=>{
  const {createPrivacyPolicy}=await import("../../src/privacy/privacy-policy.ts");
  let calls=0;const views:unknown[]=[];
  const c=client(async()=>++calls===1 ? responseJsonResponse({id:"parent-local-key",content:"done"}) : calls===2 ? responseJsonResponse({id:"child-local-key",content:"prefix a7c9e1 suffix"}) : json({error:{message:"prefix a7c9e1 suffix"}},400));
  await c.create({input:"first",tools:[{type:"mcp",server_label:"remote",server_url:"https://mcp.test",authorization:"a7c9e1"}]});
  const child=await c.create({input:"next",previous_response_id:"parent-local-key"},{privacy:{policy:createPrivacyPolicy({redactionPrefix:"<MASK:",redactionSuffix:">"})}});
  views.push(child.observation);assert.equal(child.observation?.display?.content,"prefix <MASK:secret> suffix");
  await assert.rejects(c.create({input:"next",previous_response_id:"child-local-key"}),e=> {assert(e instanceof LLMError);views.push(e.message,e.safeDetails);return e.code==="llm_bad_request";});
  assert.equal(JSON.stringify(views).includes("a7c9e1"),false);
});

test("Request-local credential collisions cannot escape through public routing labels",async()=>{
  let calls=0,observations=0;
  const c=client(async()=>{calls++;return responseJsonResponse({content:"done"});},{providerId:"route77"});
  await assert.rejects(c.create({input:"work",tools:[{type:"mcp",server_label:"remote",server_url:"https://mcp.test",authorization:"route77"}]},{onRequest(){observations++;}}), e=>e instanceof SecurityError && e.code==="responses_identity_sensitive");
  assert.equal(calls,0);assert.equal(observations,0);assert.equal(JSON.stringify(c.getStats()).includes("route77"),false);
});

test("Queued lifecycle URLs use call-time immutable query values",async()=>{
  let enter!:()=>void, release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const urls:string[]=[];
  const c=client(async(url)=>{urls.push(String(url));return String(url).includes("input_items") ? json({object:"list",data:[],first_id:null,last_id:null,has_more:false}) : responseJsonResponse({id:"owned-query",content:"done"});},{queue:{maxConcurrency:1}});
  const first=c.create({input:"hold"},{onRequest:async()=>{enter();await gate;}});
  await entered;
  const query={after:"original-cursor",include:["message.input_image.image_url"],limit:7,order:"asc" as "asc"|"desc"};
  const next=c.listInputItems("owned-query",query);
  query.after="changed";query.include[0]="changed";query.limit=99;query.order="desc";
  try { release();await first;await next;
    const url=new URL(urls[1]!);assert.equal(url.searchParams.get("after"),"original-cursor");assert.equal(url.searchParams.get("limit"),"7");assert.equal(url.searchParams.get("order"),"asc");assert.ok(url.search.includes("message.input_image.image_url"));assert.equal(url.search.includes("changed"),false);
  } finally {release();await Promise.allSettled([first,next]);}
});

test("Failover prepares fresh original input with captured target defaults, headers and model scope",async()=>{
  for(const explicit of [true,false]) {
    const bodies:Record<string,unknown>[]=[], observed:unknown[]=[], headers:string[]=[];
    const defaultsA={instructions:"my password may be admin44",max_output_tokens:111};
    const defaultsB={instructions:"ordinary instructions",max_output_tokens:222};
    const providers=[{id:"a",baseUrl: address("https://a.test/v1"),apiKey:"fixture-failover-key",headers:{"x-route":"original-route"}}];
    const models=[{providerId:"a",model:"model-a",requestDefaults:defaultsA},{providerId:"a",model:"model-b",requestDefaults:defaultsB},{providerId:"b",model:"model-b",requestDefaults:{max_output_tokens:333}}];
    const c=client(async (_url,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);headers.push(new Headers(init?.headers).get("x-route")!);
      return bodies.length===1 ? json({error:{message:"rate limited"}},429) : responseJsonResponse({content:"done"});},{model:"model-a",providers,models,
      failover:{enabled:true,models:["model-a","model-b"],providers:["a"],strategy:"priority",triggerOnError:["rate-limit"]}});
    await c.create({input:"prefix admin44 suffix",...(explicit?{model:"model-a"}:{})},{onRequest(e){observed.push(e.request);defaultsB.instructions="changed after admission";defaultsB.max_output_tokens=999;providers[0]!.headers["x-route"]="changed-route";}});
    assert.equal(bodies.length,2);assert.deepEqual(bodies,observed);assert.deepEqual(headers,["original-route","original-route"]);
    assert.equal(bodies[0]!.model,"model-a");assert.equal(bodies[0]!.input,"prefix [REDACTED:secret] suffix");assert.equal(bodies[0]!.max_output_tokens,111);
    assert.equal(bodies[1]!.model,"model-b");assert.equal(bodies[1]!.input,"prefix admin44 suffix");assert.equal(bodies[1]!.instructions,"ordinary instructions");assert.equal(bodies[1]!.max_output_tokens,222);
  }
});

test("Prompt defaults preserve omission and explicit null removes the default prompt",async()=>{
  for(const scope of ["global","provider","model"] as const){
    const bodies:Record<string,unknown>[]=[];
    const defaults={prompt:{id:"pmpt_defaults"}};
    const c=client(async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return responseJsonResponse({content:"done"});}, {
      ...(scope==="global"?{requestDefaults:defaults}:scope==="provider"?{providers:[{id:"a",baseUrl: address("https://a.test/v1"),apiKey:"prompt-fixture-key",requestDefaults:defaults}]}:{models:[{model:"test-model",requestDefaults:defaults}]}),
    });
    await c.create({input:"ordinary"});await c.create({input:"ordinary",prompt:null});await c.create({input:"ordinary",model:"test-model"});
    assert.equal(Object.hasOwn(bodies[0]!,"model"),false);assert.deepEqual(bodies[0]!.prompt,defaults.prompt);
    assert.equal(bodies[1]!.model,"test-model");assert.equal(bodies[1]!.prompt,null);assert.equal(bodies[2]!.model,"test-model");
  }
});

test("A failover target introducing a prompt has no selected-model charge bucket",async()=>{
  const bodies:Record<string,unknown>[]=[];
  const c=client(async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return bodies.length===1?json({error:{message:"rate limited"}},429):responseJsonResponse({model:"actual-from-prompt",content:"done",usage:billedUsage});},{model:"a-model",models:[{model:"b-model",requestDefaults:{prompt:{id:"pmpt_next"}}}],failover:{enabled:true,providers:["a"],models:["a-model","b-model"],strategy:"priority",triggerOnError:["rate-limit"]}});
  const result=await c.create({input:"ordinary"});assert.equal(bodies[0]!.model,"a-model");assert.equal(Object.hasOwn(bodies[1]!,"model"),false);assert.deepEqual(bodies[1]!.prompt,{id:"pmpt_next"});
  assert.equal(result.response.model,"actual-from-prompt");assert.equal(Object.hasOwn(c.getStats().byModel,"b-model"),false);assert.equal(c.getStats().byProvider.a?.totalTokens,10);
});


test("Hidden native context respects opaque slots, rejects malformed fragments, and uses configured limits",async()=>{
  const bodies:Record<string,unknown>[]=[];let observations=0;
  const c=client(async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return responseJsonResponse({content:"done"});},{responses:{maximumDepth:60}});
  await c.create({input:"prefix brief44 suffix"},{privacy:{context:{input:[{type:"reasoning",encrypted_content:"my password may be brief44",summary:[]}]}}});
  assert.equal(bodies[0]!.input,"prefix brief44 suffix");
  await c.create({input:"prefix brief44 suffix"},{privacy:{context:{input:[{role:"user",content:"my password may be brief44"}]}}});
  assert.equal(bodies[1]!.input,"prefix [REDACTED:secret] suffix");
  let deep:unknown="benign";for(let i=0;i<50;i++)deep={nested:deep};
  await c.create({input:"deep bound witness"},{privacy:{context:{extension:deep}}});
  assert.equal(bodies[2]!.input,"deep bound witness");
  await assert.rejects(c.create({input:"invalid fragment"},{privacy:{context:[{type:"reasoning",encrypted_content:"opaque"}]},onRequest(){observations++;}}),e=>e instanceof InputError&&e.code==="responses_context_invalid");
  assert.equal(observations,0);assert.equal(bodies.length,3);
});

test("Lifecycle query structural bounds reject before dispatch and honor a larger configured budget",async()=>{
  const query={include:["x".repeat(180)]};let calls=0;
  for(const maximumRequestBytes of [100,500]){
    const c=client(async()=>{calls++;return responseJsonResponse({id:"query-bound",content:"done"});},{responses:{maximumRequestBytes}});
    if(maximumRequestBytes===100)await assert.rejects(c.retrieve("query-bound",query),e=>e instanceof InputError&&e.code==="responses_query_invalid");
    else await c.retrieve("query-bound",query);
  }
  assert.equal(calls,1);
});

test("An HTTP error body that is JSON null classifies as the value null, not as the text \"null\"", async () => {
  for (const [body, detail] of [["null", "Provider response did not complete successfully"], ["plain text", "plain text"]] as const) {
    const c = client(async () => new Response(body, { status: 500 }));
    await assert.rejects(c.create({ input: "x" }), (error) => error instanceof LLMError && error.code === "llm_server_error"
      && error.message === `Provider server request failed: ${detail}`);
  }
});

test("Lifecycle query capture maps a throwing caller getter to the same fixed refusal", async () => {
  let calls = 0;
  const c = client(async () => { calls++; return responseJsonResponse({ id: "query-getter", content: "done" }); });
  const hostile = Object.defineProperty({}, "include", { enumerable: true, get() { throw new Error("private getter detail"); } });
  await assert.rejects(c.retrieve("query-getter", hostile as never), (error) => error instanceof InputError
    && error.code === "responses_query_invalid" && !error.message.includes("private getter detail"));
  assert.equal(calls, 0);
});

test("Endpoint fields refuse invalid operation-specific values before observation or fetch", async () => {
  const arms: readonly ["compact" | "count", Record<string, string | null>][] = [
    ["compact", { service_tier: "scale" }], ["compact", { service_tier: "ultrafast" }],
    ["compact", { prompt_cache_key: "a".repeat(65) }], ["compact", { prompt_cache_key: "😀".repeat(65) }],
    ["compact", { prompt_cache_key: "a".repeat(64) + "😀" }], ["compact", { prompt_cache_key: "e\u0301".repeat(33) }],
    ["count", { personality: null }], ["count", { personality: "a".repeat(65) }],
    ["count", { personality: "😀".repeat(65) }], ["count", { truncation: null }],
    ["count", { personality: "a".repeat(64) + "😀" }], ["count", { personality: "e\u0301".repeat(33) }],
  ];
  const failures: string[] = [];
  for (const [operation, fields] of arms) for (const defaults of [false, true]) {
    let calls = 0, observations = 0;
    const c = client(async () => { calls++; return operation === "compact"
      ? json({ object: "response.compaction", id: "cmp_bounds", created_at: 1, output: [], usage: zeroUsage })
      : json({ object: "response.input_tokens", input_tokens: 0 }); }, defaults ? { requestDefaults: fields } : {});
    const body = { model: null, ...(defaults ? {} : fields) }, options = { onRequest() { observations++; } };
    try {
      await assert.rejects(operation === "compact" ? c.compact(body as never, options) : c.countInputTokens(body as never, options),
        e => e instanceof InputError && e.code === "responses_request_invalid");
      assert.equal(calls, 0); assert.equal(observations, 0);
    } catch { failures.push(`${operation}/${Object.keys(fields)[0]}/${defaults ? "default" : "source"}`); }
  }
  assert.deepEqual(failures, []);
});

test("Endpoint codepoint limits preserve exact allowed wire strings and endpoint null distinctions", async () => {
  const values = ["", "a".repeat(64), "😀".repeat(64), "a".repeat(63) + "😀", "e\u0301".repeat(32), "é".repeat(64)];
  for (const operation of ["compact", "count"] as const) for (const value of values) {
    let sent: Record<string, unknown> | undefined;
    const c = client(async (_url, init) => { sent = JSON.parse(String(init?.body)); return operation === "compact"
      ? json({ object: "response.compaction", id: "cmp_positive", created_at: 1, output: [], usage: zeroUsage })
      : json({ object: "response.input_tokens", input_tokens: 0 }); });
    const field = operation === "compact" ? "prompt_cache_key" : "personality";
    if (operation === "compact") await c.compact({ model: null, [field]: value });
    else await c.countInputTokens({ model: null, [field]: value });
    assert.equal(sent?.[field], value);
  }
  for (const tier of ["auto", "default", "fast", "flex", "priority", null] as const) {
    let sent: Record<string, unknown> | undefined;
    const c = client(async (_url, init) => { sent = JSON.parse(String(init?.body)); return json({ object: "response.compaction", id: "cmp_tier", created_at: 1, output: [], usage: zeroUsage }); });
    await c.compact({ model: null, service_tier: tier, prompt_cache_key: null });
    assert.equal(sent?.service_tier, tier); assert.equal(sent?.prompt_cache_key, null);
  }
  for (const tier of ["scale", "ultrafast"] as const) {
    let sent: Record<string, unknown> | undefined;
    const c = client(async (_url, init) => { sent = JSON.parse(String(init?.body)); return responseJsonResponse({ content: "okay" }); });
    await c.create({ input: "witness", service_tier: tier, prompt_cache_key: "a".repeat(65), truncation: null });
    assert.equal(sent?.service_tier, tier); assert.equal(sent?.prompt_cache_key, "a".repeat(65)); assert.equal(sent?.truncation, null);
  }
});

test("Stream options require the composed streaming mode and preserve an explicit null override", async () => {
  for (const defaults of [false, true]) {
    let calls = 0, observations = 0;
    const c = client(async () => { calls++; return responseJsonResponse({ content: "invalid" }); }, defaults ? { requestDefaults: { stream_options: { include_obfuscation: false } } } : {});
    await assert.rejects(c.create({ input: "witness", ...(defaults ? {} : { stream_options: { include_obfuscation: false } }) }, { onRequest() { observations++; } }),
      e => e instanceof InputError && e.code === "responses_stream_options_invalid");
    assert.equal(calls, 0); assert.equal(observations, 0);
  }
  let sent: Record<string, unknown> | undefined;
  const c = client(async (_url, init) => { sent = JSON.parse(String(init?.body)); return sent!.stream ? responseSseResponse({ content: "streamed" }) : responseJsonResponse({ content: "ordinary" }); }, { requestDefaults: { stream_options: { include_obfuscation: false } } });
  for await (const value of c.stream({ input: "witness", stream_options: { include_obfuscation: false } })) void value;
  assert.equal(sent?.stream, true); assert.deepEqual(sent?.stream_options, { include_obfuscation: false });
  await c.create({ input: "witness", stream_options: null }); assert.equal(sent?.stream, false); assert.equal(sent?.stream_options, null);
});

for (const [code, expected] of [["rate_limit_exceeded", "llm_rate_limited"], ["context_length_exceeded", "llm_context_too_long"]] as const) {
  test(`Provider failures: native ${code} carries no HTTP status and needs no English count text`, async () => {
    const { classifyProviderFailure } = await import("../../src/shared/llm/provider-failure.ts");
    const error = classifyProviderFailure({ code, message: "No count text" }, TEST_FAILURE_OPTIONS);
    assert.equal(error.code, expected); assert.equal(error.status, undefined); assert.equal(Object.hasOwn(error.safeDetails, "httpStatus"), false);
  });
}

for (const status of [400, 404, 422, 429, 529]) {
  test(`Provider failures: HTTP ${status} carries only the observed status`, async () => {
    const logs: unknown[] = [];
    const c = client(async () => json({ error: { code: "ordinary", message: "safe rejection" } }, status), { logger: { log(event) { logs.push(event); } } });
    await assert.rejects(c.retrieve("existing-response"), error => {
      assert.ok(error instanceof LLMError); assert.equal(error.status, status); assert.equal(Object.hasOwn(error.safeDetails, "httpStatus"), false); return true;
    });
    assert.ok(logs.some(value => (value as {event?: string; status?: number}).event === "response_failed" && (value as {status?: number}).status === status));
  });
}

for (const kind of ["http", "flat", "nested", "terminal"] as const) {
  test(`Exact policy failure stops retry and failover for the ${kind} error envelope`, async () => {
    const error = { code: "misalignment_policy_violation", type: "invalid_request_error", message: "review test-http-secret-value", param: null };
    let calls = 0;
    const events: string[] = [];
    const c = client(async () => { calls++; return kind === "http" ? json({ error }, 403) : kind === "terminal"
      ? sse(responseEvents({ id: "policy-stop", status: "failed", toolCalls: [{ id: "never-dispatch", type: "function", function: { name: "read_file", arguments: "{}" } }] })
        .map(event => event.type === "response.failed" ? { ...event, response: { ...event.response as Record<string, unknown>, error } } : event))
      : sse([kind === "flat" ? { ...error, type: "error", sequence_number: 0 } : { type: "error", sequence_number: 0, error }]); }, {
      maxRetries: Object.fromEntries(ALL_ERROR_TYPES.map(type => [type, 3])),
      providers: [{ id: "b", baseUrl: address("https://b.test/v1"), apiKey: "alternative-key" }], failover: { enabled: true, providers: ["a", "b"], models: [], strategy: "priority", triggerOnError: [...ALL_ERROR_TYPES] },
    });
    await assert.rejects(async () => { for await (const event of c.stream(request)) events.push(event.type); }, failure => {
      assert.ok(failure instanceof LLMError); assert.equal(failure.code, "llm_misalignment_policy_violation"); assert.equal(failure.errorType, "bad-request"); assert.equal(failure.retryable, false);
      assert.equal(failure.status, kind === "http" ? 403 : undefined); assert.equal(failure.message.includes("test-http-secret-value"), false); return true;
    });
    assert.equal(calls, 1); assert.equal(events.includes("tool_call_done"), false);
  });
}

test("HTTP body read error exposes its observed status only through native status", async () => {
  const c = client(async () => new Response(failingBody("private test-http-secret-value"), { status: 422 }));
  await assert.rejects(c.retrieve("body-read"), error => {
    assert.ok(error instanceof LLMError); assert.equal(error.code, "llm_invalid_response");
    assert.equal(error.status, 422); assert.equal(Object.hasOwn(error.safeDetails, "httpStatus"), false);
    assert.equal(error.message.includes("test-http-secret-value"), false); return true;
  });
});

test("Explicit quota classification retains priority over count-bearing prose", async () => {
  const { classifyProviderFailure } = await import("../../src/shared/llm/provider-failure.ts");
  const error = classifyProviderFailure({ code: "insufficient_quota", type: "insufficient_quota", message: "maximum context length is 100 but resulted in 101 tokens" }, { ...TEST_FAILURE_OPTIONS, status: 400 });
  assert.equal(error.code, "llm_quota_exhausted"); assert.equal(error.status, 400); assert.equal(error.retryable, false);
});

test("Policy code precedence is exact and context counts are optional across native and HTTP failures", async () => {
  const { classifyProviderFailure } = await import("../../src/shared/llm/provider-failure.ts");
  const { ContextTooLongError } = await import("../../src/shared/llm/errors.ts");
  for (const status of [undefined, 400, 403, 429, 529]) for (const type of ["invalid_request_error", "insufficient_quota", "rate_limit_exceeded"]) {
    const error = classifyProviderFailure({ code: "misalignment_policy_violation", type, message: "review" }, { ...TEST_FAILURE_OPTIONS, ...(status === undefined ? {} : { status }) });
    assert.equal(error.code, "llm_misalignment_policy_violation"); assert.equal(error.retryable, false); assert.equal(error.status, status);
  }
  for (const code of [undefined, "misalignment_policy_violation_extra", "MISALIGNMENT_POLICY_VIOLATION"]) {
    assert.equal(classifyProviderFailure({ code, message: "misalignment_policy_violation" }, { ...TEST_FAILURE_OPTIONS, status: 403 }).code, "llm_auth_error");
  }
  for (const status of [undefined, 422]) for (const counted of [false, true]) {
    const error = classifyProviderFailure({ code: "context_length_exceeded", message: counted ? "maximum context length is 100 but resulted in 101 tokens" : "context unavailable" }, { ...TEST_FAILURE_OPTIONS, ...(status === undefined ? {} : { status }) });
    assert.ok(error instanceof ContextTooLongError); assert.equal(error.status, status);
    assert.equal(error.promptTokens, counted ? 101 : undefined); assert.equal(error.maxTokens, counted ? 100 : undefined);
  }
});

test("Native failed JSON stays returned while JSON and SSE failure logs retain native taxonomy", async () => {
  for (const stream of [false, true]) {
    const error = { code: "misalignment_policy_violation", message: "review" }, resource = { ...responseResource({ id: "policy-logged", status: "failed", usage: billedUsage }), error };
    const logs: { event: string; errorCode?: string | undefined; errorType?: string | undefined; status?: number | undefined }[] = []; let calls = 0;
    const c = client(async () => { calls++; return stream ? sse([
      { type: "response.created", sequence_number: 0, response: responseResource({ id: "policy-logged", status: "in_progress" }) },
      { type: "response.failed", sequence_number: 1, response: resource },
    ]) : json(resource); }, { logger: { log(event) { logs.push(event); } } });
    if (stream) await assert.rejects(async () => { for await (const _event of c.stream(request)) {} }, { code: "llm_misalignment_policy_violation" });
    else { const value = await c.create(request); assert.equal(value.status, "failed"); assert.equal(value.response.error?.code, error.code); }
    const failed = logs.filter(event => event.event === "response_failed"); assert.equal(failed.length, 1);
    assert.equal(failed[0]!.errorCode, "llm_misalignment_policy_violation"); assert.equal(failed[0]!.errorType, "bad-request"); assert.equal(failed[0]!.status, undefined);
    assert.equal(calls, 1); assert.equal(c.getStats().totalTokens.total, 10);
  }
});

test("Accepted policy failure stays primary over evidence failure and receipt cancellation", async () => {
  for (const observer of ["evidence", "receipt"] as const) {
    const controller = new AbortController(); let observed = 0, calls = 0;
    const resource = { ...responseResource({ id: "accepted-policy", status: "failed", usage: billedUsage }), error: { code: "misalignment_policy_violation", message: "review" } };
    const c = client(async () => { calls++; return json(resource); });
    await assert.rejects(c.create(request, { signal: controller.signal, ...(observer === "evidence" ? {
      onResponseEvidence() { observed++; throw new NetworkError("PRIVATE-observer-canary"); },
    } : { onResponseReceipt() { observed++; controller.abort(new Error("PRIVATE-cancellation-canary")); } }) }), failure => {
      assert.ok(failure instanceof LLMError); assert.equal(failure.code, "llm_misalignment_policy_violation"); assert.equal(failure.status, undefined);
      assert.equal(failure.message.includes("PRIVATE"), false); return true;
    });
    assert.equal(calls, 1); assert.equal(observed, 1); assert.equal(c.getQueue().active, 0);
  }
});

test("Endpoint-specific stream_options extensions remain opaque on compact and count", async () => {
  for (const operation of ["compact", "count"] as const) {
    let sent: Record<string, unknown> | undefined;
    const c = client(async (_url, init) => { sent = JSON.parse(String(init?.body)); return operation === "compact" ? json({ object: "response.compaction", id: "cmp_extensions", created_at: 1, output: [], usage: zeroUsage }) : json({ object: "response.input_tokens", input_tokens: 0 }); });
    const input = { model: null, stream_options: { future_extension: true } };
    if (operation === "compact") await c.compact(input); else await c.countInputTokens(input);
    assert.deepEqual(sent?.stream_options, input.stream_options);
  }
});
