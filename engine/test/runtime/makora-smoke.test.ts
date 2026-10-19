import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getConfigDocumentSchema } from "../../src/kernel/config-contracts.ts";
import { InputError } from "../../src/kernel/errors.ts";
import {
  createProviderAdapter,
  buildProviderConfig,
} from "../../src/runtime/provider-adapter.ts";
import { resolveModel, resolveProvider, resolveRuntimeConfig } from "../../src/runtime/runtime-config.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

/**
 * Live provider smoke test — now against an ENVIRONMENT-DECLARED provider,
 * never a repository-declared one.
 *
 * THE CHECKED-IN CONFIG SHIPS NO PROVIDER. It used to: a vendor id, a vendor
 * base URL and a default model sat in `bridlewise.config.json`, answering
 * a question the user never answered, and this file consumed them — which
 * made the repository itself the fallback source the provider decision
 * forbids. The runtime section's providers are now declared by the USER (in
 * their own config edit) or not at all, and an unconfigured runtime is a
 * typed, guided refusal.
 *
 * So this file pins the unconfigured state:
 *   - UNCONFIGURED (the checked-in state, and CI's): `resolveProvider` and
 *     `resolveModel` refuse with `runtime_provider_not_found`, naming what
 *     to declare and where. The refusal path is the product behaving
 *     correctly, not a degraded fallback.
 *   - The real completion against an ENVIRONMENT-DECLARED endpoint is the
 *     live suite's (live/provider-smoke.test.ts): it depends on the world
 *     outside the checkout, so no hermetic test branches on it (LIVE-SUITE).
 *
 * The test never skips and never branches on the host or the environment.
 */

const CONFIG_PATH = new URL("../../bridlewise.config.json", import.meta.url);
const DOCUMENT = CONFIG_DOCUMENT_SCHEMA.parse(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
const RUNTIME = resolveRuntimeConfig(DOCUMENT);

test("provider decision: the checked-in runtime declares no provider, no default provider and no default model", () => {
  // Parsed from the RAW file, not through the schema's defaults, so a value
  // cannot hide behind a parser. The class this pins: a vendor endpoint or
  // model id shipped in the repository answers a question the user never
  // answered. A vendor value under a NEW key is refused upstream by the
  // strictObject runtime schema (unknown keys do not parse).
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
    runtime?: Record<string, unknown> & { providers?: unknown[] };
  };
  assert.ok(raw.runtime !== undefined, "the runtime section exists");
  assert.ok(!("defaultProvider" in raw.runtime), "no defaultProvider may ship in the repository config");
  assert.ok(!("defaultModel" in raw.runtime), "no defaultModel may ship in the repository config");
  assert.deepEqual(raw.runtime.providers, [], "no provider entry may ship in the repository config");
  // No URL of any kind may sit anywhere in the runtime section — a vendor
  // endpoint under a different EXISTING key would still have to look like
  // one. (Detector liveness: a planted copy with an URL under a permitted
  // key must fire.)
  const urlsIn = (value: unknown): number => {
    if (typeof value === "string") return /https?:\/\//u.test(value) ? 1 : 0;
    if (Array.isArray(value)) return value.reduce((n: number, v) => n + urlsIn(v), 0);
    if (typeof value === "object" && value !== null) {
      return Object.values(value).reduce((n: number, v) => n + urlsIn(v), 0);
    }
    return 0;
  };
  assert.equal(urlsIn(raw.runtime), 0, "no URL may ship anywhere in the runtime section");
  const planted = { ...raw.runtime, systemPrompt: "see https://api.some-vendor.example/v1" };
  assert.equal(urlsIn(planted), 1, "detector liveness: a planted vendor URL must be counted");
});

test("provider refusal: an unconfigured runtime refuses typed and names the remedy", () => {
  // The checked-in runtime declares no provider (pinned above); a config that
  // declares one is a red here, never a branch the test leaves unchecked.
  assert.deepEqual(RUNTIME.providers, [], "the checked-in runtime declares no provider");
  assert.throws(
    () => resolveProvider(RUNTIME),
    (e: unknown) =>
      e instanceof InputError &&
      e.code === "runtime_provider_not_found" &&
      /runtime\.providers/u.test(e.message),
    "resolveProvider must refuse with the typed code and name where to declare a provider",
  );
  assert.throws(
    () => resolveModel(RUNTIME),
    (e: unknown) => e instanceof InputError && e.code === "runtime_provider_not_found",
    "resolveModel must refuse the same way when nothing is configured",
  );
  assert.throws(
    () => resolveModel(RUNTIME, undefined, "gemma-4-31b"),
    (e: unknown) => e instanceof InputError && e.code === "runtime_provider_not_found",
    "naming a model without any provider still refuses on the provider",
  );
});

test("provider-smoke: an adapter refuses an empty API key with its typed code (the real completion is the live suite's)", () => {
  // The real SSE completion against an environment-declared endpoint depends
  // on the world outside the checkout, so it lives in the LIVE suite
  // (live/provider-smoke.test.ts, LIVE-SUITE); this hermetic arm pins the
  // adapter's deterministic refusal on every run, never a branch on the host.
  assert.throws(
    () => createProviderAdapter({
      provider: buildProviderConfig({
        id: "smoke",
        baseUrl: "https://smoke.invalid/v1",
        timeoutMs: 1000,
        retries: { maxRetries: 0, initialBackoffMs: 1, maxBackoffMs: 10, backoffMultiplier: 2 },
      }),
      apiKey: "",
    }),
    (e: unknown) => (e as { code?: string } | null)?.code === "llm_config_invalid",
    "an empty API key must refuse with llm_config_invalid",
  );
});
