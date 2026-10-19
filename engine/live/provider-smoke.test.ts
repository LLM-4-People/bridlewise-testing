/**
 * THE LIVE SUITE — the provider smoke (`npm run test:live`), never part of the
 * hermetic suites (UR-20; LIVE-SUITE). A real chat completion over SSE against
 * an ENVIRONMENT-DECLARED provider: `HARNESS_SMOKE_BASE_URL`,
 * `HARNESS_SMOKE_MODEL` and `HARNESS_API_KEY` name it (the checked-in config
 * ships no provider; test/runtime/makora-smoke.test.ts pins that and the
 * typed refusals). It REFUSES LOUDLY instead of skipping: without the live
 * consent, or without the three variables, the file fails at load naming what
 * is missing — a live run that could not reach what it tests is a red.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ROOT_POLICY } from "../src/kernel/root-policy.ts";
import {
  createProviderAdapter,
  buildProviderConfig,
  type ChatMessage,
  type ChatStreamEvent,
} from "../src/runtime/provider-adapter.ts";

const CONSENT = ROOT_POLICY.verification.networkUnderTest.liveConsentVariable;
if (process.env[CONSENT] !== "1") {
  throw new Error(`the live suite runs only with consent: set ${CONSENT}=1 (it reaches ${ROOT_POLICY.verification.networkUnderTest.liveHosts.join(", ")})`);
}
const SMOKE_VARIABLES = ["HARNESS_SMOKE_BASE_URL", "HARNESS_SMOKE_MODEL", "HARNESS_API_KEY"] as const;
const missing = SMOKE_VARIABLES.filter((name) => (process.env[name] ?? "").length === 0);
if (missing.length > 0) {
  throw new Error(`the provider smoke needs an environment-declared provider: set ${missing.join(", ")}`);
}
const SMOKE_BASE_URL = process.env["HARNESS_SMOKE_BASE_URL"] as string;
const SMOKE_MODEL = process.env["HARNESS_SMOKE_MODEL"] as string;
const SMOKE_KEY = process.env["HARNESS_API_KEY"] as string;

const PONG_PROMPT = "Reply with exactly the word PONG and nothing else.";

const SMOKE_TIMEOUT_MS = 90_000;

function buildRequest(
  modelId: string,
  maxTokens: number,
  temperature: number,
): Readonly<{ model: string; messages: readonly ChatMessage[]; max_tokens: number; temperature: number }> {
  return Object.freeze({
    model: modelId,
    messages: Object.freeze([Object.freeze({ role: "user" as const, content: PONG_PROMPT })]),
    max_tokens: maxTokens,
    temperature,
  });
}

async function collectContent(
  stream: AsyncGenerator<ChatStreamEvent, void, unknown>,
): Promise<string> {
  let content = "";
  for await (const event of stream) {
    if (event.type === "content") content += event.text;
  }
  return content;
}

test("provider-smoke: an environment-declared provider completes a real chat completion via SSE streaming", { timeout: SMOKE_TIMEOUT_MS }, async () => {
  const provider = buildProviderConfig({
    id: "env-smoke",
    baseUrl: SMOKE_BASE_URL,
    timeoutMs: 120_000,
    retries: { maxRetries: 3, initialBackoffMs: 500, maxBackoffMs: 10_000, backoffMultiplier: 2 },
  });
  const adapter = createProviderAdapter({ provider, apiKey: SMOKE_KEY });
  const content = await collectContent(adapter.streamChatCompletion(buildRequest(SMOKE_MODEL, 64, 0)));
  assert.ok(content.length > 0, `expected non-empty content from ${SMOKE_MODEL}`);
  assert.ok(/PONG/iu.test(content), `expected PONG in response; got: ${content.slice(0, 200)}`);
});
