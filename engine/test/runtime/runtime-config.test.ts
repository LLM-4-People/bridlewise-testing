import assert from "node:assert/strict";
import test from "node:test";

import { buildConfigContract } from "../../src/kernel/config-contracts.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { resolveRuntimeConfig, resolveProvider, resolveModel } from "../../src/runtime/runtime-config.ts";
import { canonicalJson, deepFreeze } from "../../src/kernel/integrity.ts";

const CONFIG_DOCUMENT_SCHEMA = buildConfigContract(ROOT_POLICY).runtimeSchema;

const VALID_CONFIG = JSON.parse(canonicalJson(CONFIG_DOCUMENT_SCHEMA.parse(JSON.parse(`{
  "schemaVersion": 3,
  "project": { "id": "bridlewise", "root": "." },
  "data": { "defaultClassification": "project-private" },
  "state": { "root": ".bridlewise/state", "receipts": { "executionEvidence": "evidence/executions" } },
  "alignmentCheckpoint": {
    "cadence": {
      "maximumEventsBetweenCheckpoints": 50,
      "maximumActionsBetweenCheckpoints": 20,
      "maximumProviderInputTokensBetweenCheckpoints": 16384,
      "maximumWallClockSecondsBetweenSafeBoundaryChecks": 900
    },
    "budgets": { "maximumProjectionBytes": 65536, "maximumObserverInputTokens": 8192 },
    "observerProfile": "deterministic-only"
  },
  "repositoryPaths": {
    "schemaVersion": "bridlewise-repository-path-settings/v1",
    "profile": "cross-platform-strict/v1",
    "limits": {
      "maximumPathUtf8Bytes": 4096,
      "maximumSegmentUtf8Bytes": 255,
      "maximumSegmentUtf16CodeUnits": 255,
      "maximumSegments": 256,
      "maximumPathsPerSet": 100000
    }
  },
  "repositoryRootCapability": {
    "schemaVersion": "bridlewise-repository-root-capability-budget/v1",
    "maximumConcurrentBorrowsPerCapability": 1,
    "maximumOperationsPerBorrow": 1,
    "maximumBorrowOperationsPerCapability": 8192,
    "maximumBorrowOperationsPerTask": 8192,
    "maximumCapabilityRotationsPerTask": 2,
    "maximumBorrowedPathBytes": 4096,
    "maximumBorrowedPathSegments": 128
  },
  "contracts": {
    "preferredModelProtocol": "openai-responses",
    "enabledProtocols": ["openai-responses", "openai-chat-completions", "mcp-2025-11-25"],
    "schemaDialect": "https://json-schema.org/draft/2020-12/schema",
    "endpoints": { "chatCompletions": "/v1/chat/completions", "responses": "/v1/responses" },
    "mcpProtocolVersion": "2025-11-25",
    "chatStreamDoneSentinel": "[DONE]",
    "responsesStore": false,
    "unknownMetadataClassification": "regulated-restricted",
    "limits": {
      "maximumIdentifierCharacters": 256,
      "maximumTextCharacters": 262144,
      "maximumTools": 64,
      "maximumMessages": 2048,
      "maximumEvents": 50000,
      "maximumToolSchemaDepth": 24,
      "maximumToolSchemaProperties": 2048,
      "maximumLosses": 128
    }
  }
}`))));

function configWithRuntime(runtime: unknown): ReturnType<typeof CONFIG_DOCUMENT_SCHEMA.parse> {
  const base = structuredClone(VALID_CONFIG);
  if (runtime !== null) {
    (base as Record<string, unknown>).runtime = runtime;
  }
  return CONFIG_DOCUMENT_SCHEMA.parse(base);
}

const VALID_RUNTIME = {
  defaultProvider: "test",
  defaultModel: "test-model",
  systemPrompt: "You are helpful.",
  providers: [
    {
      id: "test",
      baseUrl: "https://api.test.com/v1",
      apiKeyEnvVar: "TEST_API_KEY",
      timeoutMs: 30000,
      retries: { maxRetries: 3, initialBackoffMs: 500, maxBackoffMs: 10000, backoffMultiplier: 2 },
      models: [
        { id: "test-model", maxTokens: 4096, temperature: 0 },
        { id: "other-model", maxTokens: 8192, temperature: 0.7 },
      ],
    },
  ],
};

// ============================================================================
// resolveRuntimeConfig
// ============================================================================

test("RuntimeConfig: resolveRuntimeConfig extracts valid runtime", () => {
  const doc = configWithRuntime(VALID_RUNTIME);
  const runtime = resolveRuntimeConfig(doc);
  assert.equal(runtime.defaultProvider, "test");
  assert.equal(runtime.defaultModel, "test-model");
  assert.equal(runtime.systemPrompt, "You are helpful.");
  assert.equal(runtime.providers.length, 1);
  assert.equal(runtime.providers[0]?.id, "test");
  assert.equal(runtime.providers[0]?.baseUrl, "https://api.test.com/v1");
  assert.equal(runtime.providers[0]?.timeoutMs, 30000);
  assert.equal(runtime.apiKeyEnvVars["test"], "TEST_API_KEY");
});

test("RuntimeConfig: resolveRuntimeConfig throws on missing runtime section", () => {
  const doc = configWithRuntime(null);
  assert.throws(
    () => resolveRuntimeConfig(doc),
    (e: unknown) => (e as Error).message.includes("runtime"),
  );
});

test("RuntimeConfig: resolveRuntimeConfig returns frozen object", () => {
  const doc = configWithRuntime(VALID_RUNTIME);
  const runtime = resolveRuntimeConfig(doc);
  assert.ok(Object.isFrozen(runtime));
  assert.ok(Object.isFrozen(runtime.providers));
  assert.ok(Object.isFrozen(runtime.providers[0]));
});

test("RuntimeConfig: resolveRuntimeConfig includes all model configs", () => {
  const doc = configWithRuntime(VALID_RUNTIME);
  const runtime = resolveRuntimeConfig(doc);
  assert.ok(runtime.models["test"]);
  assert.equal(runtime.models["test"]?.["test-model"]?.maxTokens, 4096);
  assert.equal(runtime.models["test"]?.["test-model"]?.temperature, 0);
  assert.equal(runtime.models["test"]?.["other-model"]?.maxTokens, 8192);
  assert.equal(runtime.models["test"]?.["other-model"]?.temperature, 0.7);
});

// ============================================================================
// resolveProvider
// ============================================================================

test("RuntimeConfig: resolveProvider returns default provider", () => {
  const doc = configWithRuntime(VALID_RUNTIME);
  const runtime = resolveRuntimeConfig(doc);
  const provider = resolveProvider(runtime);
  assert.equal(provider.id, "test");
});

test("RuntimeConfig: resolveProvider returns named provider", () => {
  const doc = configWithRuntime(VALID_RUNTIME);
  const runtime = resolveRuntimeConfig(doc);
  const provider = resolveProvider(runtime, "test");
  assert.equal(provider.id, "test");
});

test("RuntimeConfig: resolveProvider throws on unknown provider", () => {
  const doc = configWithRuntime(VALID_RUNTIME);
  const runtime = resolveRuntimeConfig(doc);
  assert.throws(
    () => resolveProvider(runtime, "nonexistent"),
    (e: unknown) => (e as Error).message.includes("not configured"),
  );
});

test("RuntimeConfig: resolveProvider returns provider with retries", () => {
  const doc = configWithRuntime(VALID_RUNTIME);
  const runtime = resolveRuntimeConfig(doc);
  const provider = resolveProvider(runtime);
  assert.equal(provider.retries.maxRetries, 3);
  assert.equal(provider.retries.initialBackoffMs, 500);
  assert.equal(provider.retries.maxBackoffMs, 10000);
  assert.equal(provider.retries.backoffMultiplier, 2);
});

// ============================================================================
// resolveModel
// ============================================================================

test("RuntimeConfig: resolveModel returns default model", () => {
  const doc = configWithRuntime(VALID_RUNTIME);
  const runtime = resolveRuntimeConfig(doc);
  const model = resolveModel(runtime);
  assert.equal(model.modelId, "test-model");
  assert.equal(model.maxTokens, 4096);
  assert.equal(model.temperature, 0);
});

test("RuntimeConfig: resolveModel returns named model", () => {
  const doc = configWithRuntime(VALID_RUNTIME);
  const runtime = resolveRuntimeConfig(doc);
  const model = resolveModel(runtime, undefined, "other-model");
  assert.equal(model.modelId, "other-model");
  assert.equal(model.maxTokens, 8192);
  assert.equal(model.temperature, 0.7);
});

test("RuntimeConfig: resolveModel throws on unknown model", () => {
  const doc = configWithRuntime(VALID_RUNTIME);
  const runtime = resolveRuntimeConfig(doc);
  assert.throws(
    () => resolveModel(runtime, undefined, "nonexistent"),
    (e: unknown) => (e as Error).message.includes("not configured"),
  );
});

test("RuntimeConfig: resolveModel throws on unknown provider", () => {
  const doc = configWithRuntime(VALID_RUNTIME);
  const runtime = resolveRuntimeConfig(doc);
  assert.throws(
    () => resolveModel(runtime, "nonexistent", "any"),
    (e: unknown) => (e as Error).message.includes("not configured"),
  );
});

// ============================================================================
// Config schema validation — runtime section
// ============================================================================

test("RuntimeConfig: config schema accepts valid runtime", () => {
  const doc = configWithRuntime(VALID_RUNTIME);
  assert.ok(doc.runtime);
  assert.equal(doc.runtime?.defaultProvider, "test");
});

test("RuntimeConfig: config schema accepts config without runtime (optional)", () => {
  const doc = configWithRuntime(null);
  assert.equal(doc.runtime, undefined);
});

test("RuntimeConfig: config schema rejects duplicate provider ids", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [
      ...VALID_RUNTIME.providers,
      { ...VALID_RUNTIME.providers[0] },
    ],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => (e as Error).message.includes("schema") || (e as Error).message.includes("unique"),
  );
});

test("RuntimeConfig: config schema rejects defaultProvider not matching any provider", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    defaultProvider: "wrong",
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects defaultModel not matching any model", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    defaultModel: "wrong",
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects duplicate model ids within provider", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0]!,
      models: [
        ...VALID_RUNTIME.providers[0]!.models,
        { id: "test-model", maxTokens: 100, temperature: 0 },
      ],
    }],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects http baseUrl (must be http or https)", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      baseUrl: "ftp://api.test.com",
    }],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema accepts http baseUrl (for local models)", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      baseUrl: "http://localhost:11434/v1",
    }],
  });
  const doc = configWithRuntime(runtime);
  assert.equal(doc.runtime?.providers[0]?.baseUrl, "http://localhost:11434/v1");
});

test("RuntimeConfig: config schema rejects invalid apiKeyEnvVar (lowercase)", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      apiKeyEnvVar: "lowercase_key",
    }],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects invalid apiKeyEnvVar (starts with digit)", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      apiKeyEnvVar: "9API_KEY",
    }],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects temperature above 2", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      models: [{ id: "test-model", maxTokens: 4096, temperature: 3 }],
    }],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects negative temperature", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      models: [{ id: "test-model", maxTokens: 4096, temperature: -1 }],
    }],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects temperature of exactly 2 boundary... wait, 2 is allowed", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      models: [{ id: "test-model", maxTokens: 4096, temperature: 2 }],
    }],
  });
  const doc = configWithRuntime(runtime);
  assert.equal(doc.runtime?.providers[0]?.models[0]?.temperature, 2);
});

test("RuntimeConfig: config schema rejects maxRetries above ceiling", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      retries: { maxRetries: 100, initialBackoffMs: 500, maxBackoffMs: 10000, backoffMultiplier: 2 },
    }],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects maxBackoffMs < initialBackoffMs", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      retries: { maxRetries: 3, initialBackoffMs: 5000, maxBackoffMs: 100, backoffMultiplier: 2 },
    }],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects empty providers array", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects empty models array in provider", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      models: [],
    }],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects unknown key in runtime", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    unknownKey: "bad",
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects unknown key in provider", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      unknownKey: "bad",
    }],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects maxTokens of 0", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      models: [{ id: "test-model", maxTokens: 0, temperature: 0 }],
    }],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects timeoutMs of 0", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      timeoutMs: 0,
    }],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects negative backoffMultiplier", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      retries: { maxRetries: 3, initialBackoffMs: 500, maxBackoffMs: 10000, backoffMultiplier: -1 },
    }],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema accepts multiple providers", () => {
  const runtime = deepFreeze({
    defaultProvider: "test",
    defaultModel: "test-model",
    systemPrompt: "You are helpful.",
    providers: [
      VALID_RUNTIME.providers[0],
      {
        id: "other",
        baseUrl: "https://api.other.com/v1",
        apiKeyEnvVar: "OTHER_API_KEY",
        timeoutMs: 60000,
        retries: { maxRetries: 2, initialBackoffMs: 100, maxBackoffMs: 5000, backoffMultiplier: 1.5 },
        models: [{ id: "other-model", maxTokens: 2048, temperature: 1 }],
      },
    ],
  });
  const doc = configWithRuntime(runtime);
  assert.equal(doc.runtime?.providers.length, 2);
});

test("RuntimeConfig: config schema accepts temperature of exactly 0", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      models: [{ id: "test-model", maxTokens: 4096, temperature: 0 }],
    }],
  });
  const doc = configWithRuntime(runtime);
  assert.equal(doc.runtime?.providers[0]?.models[0]?.temperature, 0);
});

test("RuntimeConfig: config schema rejects maxTokens exceeding ceiling", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    providers: [{
      ...VALID_RUNTIME.providers[0],
      models: [{ id: "test-model", maxTokens: 10_000_000, temperature: 0 }],
    }],
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema rejects systemPrompt exceeding max bytes", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    systemPrompt: "x".repeat(10_000),
  });
  assert.throws(
    () => configWithRuntime(runtime),
    (e: unknown) => e instanceof Error,
  );
});

test("RuntimeConfig: config schema accepts empty systemPrompt", () => {
  const runtime = deepFreeze({
    ...VALID_RUNTIME,
    systemPrompt: "",
  });
  const doc = configWithRuntime(runtime);
  assert.equal(doc.runtime?.systemPrompt, "");
});

test("RuntimeConfig: resolveProvider returns frozen provider config", () => {
  const doc = configWithRuntime(VALID_RUNTIME);
  const runtime = resolveRuntimeConfig(doc);
  const provider = resolveProvider(runtime);
  assert.ok(Object.isFrozen(provider));
});

test("RuntimeConfig: resolveModel returns frozen model config", () => {
  const doc = configWithRuntime(VALID_RUNTIME);
  const runtime = resolveRuntimeConfig(doc);
  const model = resolveModel(runtime);
  assert.ok(Object.isFrozen(model));
});

test("Runtime provider/model dictionaries preserve prototype-like configured IDs with own-key lookup",()=>{
  for(const id of ["constructor","toString"]){
    const document=configWithRuntime({...VALID_RUNTIME,defaultProvider:id,defaultModel:id,providers:[{...VALID_RUNTIME.providers[0],id,models:[{id,maxTokens:16,temperature:0}]}]});
    const runtime=resolveRuntimeConfig(document);
    assert.deepEqual(resolveModel(runtime,id,id),{modelId:id,maxTokens:16,temperature:0});assert.equal(runtime.apiKeyEnvVars[id],"TEST_API_KEY");
    assert.throws(()=>resolveModel(runtime,id,"valueOf"),{code:"runtime_model_not_found"});
  }
});

test("Persisted generation knobs consume the native numeric leaf domains",()=>{
  for(const maxTokens of [0,1,15,16.5])assert.throws(()=>configWithRuntime({...VALID_RUNTIME,providers:[{...VALID_RUNTIME.providers[0],models:[{id:"test-model",maxTokens,temperature:0}]}]}));
  assert.equal(resolveRuntimeConfig(configWithRuntime({...VALID_RUNTIME,providers:[{...VALID_RUNTIME.providers[0],models:[{id:"test-model",maxTokens:16,temperature:2}]}]})).models.test?.["test-model"]?.maxTokens,16);
});
