/** Deterministic integration of native provider, exposure, and privacy boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { responseJsonResponse, responseSseResponse } from "../support/mock-provider.ts";
import { SharedLLMClient, isLLMError, registerLLMExposure, LLM_EXPOSURE_COUNTS } from "../../src/shared/llm/index.ts";
// Deterministic HTTP fixture drives the same native client preparation as production.
import { validateLLMConfig } from "../../src/shared/llm/config.ts";
import { snapshotExposure } from "../../src/shared/exposure/index.ts";
import { address, serve, type UpstreamHandler } from "../support/loopback-upstream.ts";

const MODEL = "native-test-model";
// A real loopback upstream answers as the fixture provider (loopback is a private address).
const cfg = { baseUrl: address("https://fixture.test/v1"), apiKey: "fixture-credential", allowPrivateAddress: true } as const;
const fixtureFetch: UpstreamHandler = async (_url, init) => {
  const body = JSON.parse(String(init.body)) as { stream?: boolean };
  const options = { model: MODEL, content: "fixture-response", usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } };
  return body.stream ? responseSseResponse(options) : responseJsonResponse(options);
};

/**
 * The refusal every door must produce when no provider credential is
 * available. Asserted per door rather than once, because "the client refuses"
 * and "this particular entry point refuses" are different claims, and it is
 * the second one that keeps a future entry point from quietly succeeding
 * against a half-built config.
 */
function assertUnconfiguredRefusal(construct: () => unknown): void {
  const reason = validateLLMConfig({ baseUrl: "", apiKey: "", allowPrivateAddress: true, model: MODEL });
  assert.equal(reason, "baseUrl must be a non-empty string");
  assert.throws(construct, (error: unknown) => {
    assert.ok(isLLMError(error), `expected an LLMError, got ${String(error)}`);
    assert.equal(error.code, "llm_config_invalid");
    assert.equal(error.errorType, "bad-request");
    assert.equal(error.retryable, false);
    assert.match(error.message, /^Invalid LLM configuration/u);
    return true;
  });
}

test("native deterministic integration: 10 distinct requests, >= 8 succeed", async () => {
  serve(fixtureFetch);
  const client = new SharedLLMClient({
    ...cfg, model: MODEL,
    timeout: 60_000, concurrency: 2, circuitBreaker: { threshold: 20, resetMs: 10_000 },
    backoff: { baseMs: 1000, factor: 2, maxMs: 30_000, jitter: 0.1 },
    maxRetries: { "rate-limit": 2, server: 1, network: 1, overloaded: 1 },
  });
  const prompts: readonly string[] = [
    "Reply with exactly: one",
    "Reply with exactly: two",
    "Reply with exactly: three",
    "Reply with exactly: four",
    "Reply with exactly: five",
    "Reply with exactly: six",
    "Reply with exactly: seven",
    "Reply with exactly: eight",
    "Reply with exactly: nine",
    "Reply with exactly: ten",
  ];
  let successes = 0;
  const failures: string[] = [];
  for (let i = 0; i < prompts.length; i++) {
    try {
      const r = await client.create(({ input: prompts[i]!, temperature: 0, max_output_tokens: 16 }));
      if (r.content.length > 0 && r.model.length > 0) {
        successes++;
      } else {
        failures.push(`#${i + 1}: empty content`);
      }
    } catch (error) {
      const code = isLLMError(error) ? error.code : "non-llm";
      failures.push(`#${i + 1}: ${code}`);
    }
  }
  assert.ok(
    successes === 10,
    `expected 10/10 successes, got ${successes}/10. Failures: ${failures.join("; ")}`,
  );
});

test("native deterministic integration: streaming yields content + finish + model", async () => {
  serve(fixtureFetch);
  const client = new SharedLLMClient({
    ...cfg, model: MODEL,
    timeout: 60_000, concurrency: 1,
  });
  let content = "";
  let model = "";
  let finished = false;
  let sawHeaders = false;
  try {
    for await (const chunk of client.stream(({ input: "Reply with exactly: streamed-ok", temperature: 0, max_output_tokens: 16 }))) {
      if (chunk.type === "content") content += chunk.text;
      else if (chunk.type === "model") model = chunk.model;
      else if (chunk.type === "finish") finished = true;
      else if (chunk.type === "headers") sawHeaders = true;
    }
  } catch (error) {
    assert.fail(`stream threw: ${isLLMError(error) ? error.code : String(error)}`);
  }
  assert.ok(content.length > 0, "stream must yield content");
  assert.ok(model.length > 0, "stream must yield the served model id");
  assert.ok(finished, "stream must yield a finish event");
  assert.ok(sawHeaders, "stream must yield a headers event");
});

test("native deterministic integration: stats + exposure reflect the live calls", async () => {
  // The exposure catalogue needs no endpoint at all: it is a projection of
  // what this module PUBLISHES, and it was dark on every machine without a
  // credential purely because it shared a file with three network tests.
  // It is asserted first, unconditionally, so it is checked everywhere.
  //
  // Registration is called explicitly. It used to arrive as a side effect of
  // constructing a client, which is why this assertion could not survive the
  // unconfigured branch — and which is worth knowing on its own: the
  // catalogue's liveness depended on somebody having built a client first.
  //
  // The floors come from the module's own declared counts rather than three
  // literals copied into this file, so adding a signal cannot leave a stale
  // number here. The declaration and the registrations are written
  // separately, so comparing them is still two instruments, not one.
  registerLLMExposure();
  const snap = snapshotExposure("llm");
  assert.ok(snap.signals.length >= LLM_EXPOSURE_COUNTS.signals,
    `exposure must publish the LLM signal catalog (declared ${LLM_EXPOSURE_COUNTS.signals}, registered ${snap.signals.length})`);
  assert.ok(snap.actions.length >= LLM_EXPOSURE_COUNTS.actions,
    `exposure must publish the LLM action catalog (declared ${LLM_EXPOSURE_COUNTS.actions}, registered ${snap.actions.length})`);
  assert.ok(snap.customizations.length >= LLM_EXPOSURE_COUNTS.customizations,
    `exposure must publish the LLM customization catalog (declared ${LLM_EXPOSURE_COUNTS.customizations}, registered ${snap.customizations.length})`);
  serve(fixtureFetch);
  const client = new SharedLLMClient({
    ...cfg, model: MODEL,
    timeout: 60_000, concurrency: 1,
  });
  await client.create(({ input: "Reply with exactly: stats-probe", temperature: 0, max_output_tokens: 16 }));
  const stats = client.getStats();
  assert.ok(stats.totalRequests >= 1, "stats must record the request");
  assert.ok(stats.byModel[MODEL] !== undefined || Object.keys(stats.byModel).length > 0, "stats must record per-model");
});

test("native deterministic integration: missing configuration fails before transport", () => {
  assertUnconfiguredRefusal(() => new SharedLLMClient({ baseUrl: "", apiKey: "", allowPrivateAddress: true, model: MODEL }));
});
