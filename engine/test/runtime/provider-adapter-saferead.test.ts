import assert from "node:assert/strict";
import test from "node:test";
import { createProviderAdapter } from "../../src/runtime/provider-adapter.ts";
import type { ProviderConfig } from "../../src/runtime/provider-adapter.ts";
import { LLMError } from "../../src/shared/llm/errors.ts";
import { address, serve } from "../support/loopback-upstream.ts";

/** Actual Fetch bodies exercise the shared HTTP read owner, never a structural Response cast. */
const PROVIDER: ProviderConfig = Object.freeze({ id: "mock", baseUrl: address("https://mock.example.com/v1"), timeoutMs: 60_000,
  retries: Object.freeze({ maxRetries: 0, initialBackoffMs: 1, maxBackoffMs: 1, backoffMultiplier: 1 }) });
const credential = "read-body-synthetic-credential";
async function consume(response: Response, apiKey = credential): Promise<void> {
  serve(async () => response);
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey });
  for await (const _event of adapter.streamChatCompletion({ model: "test-model", messages: [{ role: "user", content: "hi" }] })) { /* drain */ }
}
/** A 400 whose body starts (`partial`) and then fails: over a real connection the upstream drops it mid-body. */
function failedBody(partial: string): Response {
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(partial)); setTimeout(() => controller.error(new Error("upstream body failed")), 50); } }), { status: 400 });
}
test("Adapter preserves the native error code and observed HTTP status", async () => {
  await assert.rejects(consume(new Response(JSON.stringify({ error: { code: "misalignment_policy_violation", message: "review required" } }), { status: 403 })), error => {
    assert.ok(error instanceof LLMError); assert.equal(error.code, "llm_misalignment_policy_violation");
    assert.equal(error.status, 403); assert.equal(error.retryable, false); return true;
  });
});
test("HTTP error body AbortError is preserved as cancellation rather than a fabricated empty body", async () => {
  // The caller cancels while a 400's body is still arriving (the upstream
  // never ends it): cancellation, not an error with an empty body.
  const controller = new AbortController();
  serve(async () => {
    setTimeout(() => controller.abort(), 20);
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode("{\"error\":")); } }), { status: 400 });
  });
  const adapter = createProviderAdapter({ provider: PROVIDER, apiKey: credential, signal: controller.signal });
  await assert.rejects(async () => { for await (const _event of adapter.streamChatCompletion({ model: "test-model", messages: [{ role: "user", content: "hi" }] })) { /* drain */ } },
    error => error instanceof LLMError && error.code === "llm_cancelled" && !error.retryable);
});
test("HTTP error body read failures retain a typed safe diagnostic without exposing credentials", async () => {
  // A body that fails mid-read (the connection drops after part of it
  // arrived): a typed read failure with the status, never the credential the
  // partial body carried. (The upstream's own error text does not cross the
  // wire, so the message names the read failure, not the upstream's words.)
  await assert.rejects(consume(failedBody(`stream corrupted mid-read ${credential}`)), error => {
    assert.ok(error instanceof LLMError);
    assert.equal(error.code, "llm_invalid_response");
    assert.equal(error.safeDetails.readFailure, "body_read_failed");
    assert.equal(error.status, 400); assert.equal(Object.hasOwn(error.safeDetails, "httpStatus"), false);
    assert.ok(error.message.includes("read failed"));
    assert.ok(!error.message.includes(credential)); return true;
  });
  await assert.rejects(consume(failedBody("abcd"), "abcd"), error => {
    assert.ok(error instanceof LLMError); assert.equal(error.safeDetails.readFailure, "body_read_failed");
    assert.ok(!error.message.includes("abcd"), "exact intentional credential equality must survive declaration floors");
    return true;
  });
});
test("Readable HTTP error bodies retain useful safe provider detail", async () => {
  await assert.rejects(consume(new Response(`error: invalid model ${credential}`, { status: 400 })), error => {
    assert.ok(error instanceof LLMError); assert.equal(error.code, "llm_bad_request");
    assert.ok(error.message.includes("invalid model")); assert.ok(!error.message.includes(credential)); return true;
  });
});
