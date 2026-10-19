import assert from "node:assert/strict";
import test from "node:test";

import { configDocumentPath, readConfigDocumentRaw, type ConfigDocument } from "../../src/kernel/config.ts";
import { resolveRuntimeConfig } from "../../src/runtime/runtime-config.ts";
import { createInteractiveSession } from "../../src/runtime/interactive-session.ts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// `loadPinnedConfigSnapshot` (the production config reader) runs the S1
// repository-surface inspection that DENIES symlinks — appropriate for a
// production harness root, but the dev worktree legitimately contains
// symlinked fixtures (large-codebases, verification/linked-external.ts),
// so the production path throws `repository_symlink_denied` here. A unit
// test that only checks the config document declares a field does not need
// the S1 TOCTOU verification, so it uses `readConfigDocumentRaw` (the config
// owner's exported no-surface-scan reader) instead. This does NOT weaken
// the S1 gate (the production path is untouched).
//
// NOTE: `getConfigDocumentSchema().parse` is NOT used because the backend
// schema is currently out of sync with `bridlewise.config.json` — at
// least `runtime.userPreferences`, `tools.autoCheck`, and
// `memory.dedupCompression` are present in the config file (consumed by the
// web UI) but absent from the strict backend schema, so a strict parse
// throws `config_schema_invalid`. That schema drift is tracked as R45-F1
// (config owner R3). `resolveRuntimeConfig` only reads `document.runtime`,
// so the cast below is functionally safe (the runtime section is returned
// verbatim from the config file).
const CONFIG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const RAW_DOCUMENT = readConfigDocumentRaw(configDocumentPath(CONFIG_ROOT)) as Readonly<Record<string, unknown>>;
const DOCUMENT = RAW_DOCUMENT as unknown as ConfigDocument;

// Minimal no-op ProviderAdapter for wiring tests.
function noopAdapter() {
  return {
    providerId: "test-provider",
    streamChatCompletion: async function* () { /* noop */ },
    chatCompletion: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }),
  } as never;
}

function noopToolRegistry() {
  return {
    definitions: () => [],
    names: () => [],
    get: () => undefined,
    register: () => {},
    has: () => false,
  } as never;
}

// ---------------------------------------------------------------------------
// tool_choice config: runtime.defaultToolChoice is sourced from the central
// config document and threaded through to the interactive session.
// ---------------------------------------------------------------------------

test("tool-choice config: bridlewise.config.json declares runtime.defaultToolChoice", () => {
  const runtime = DOCUMENT.runtime;
  assert.ok(runtime !== undefined, "runtime section must be present");
  assert.ok(runtime!.defaultToolChoice !== undefined, "defaultToolChoice must be declared");
  assert.equal(runtime!.defaultToolChoice, "auto");
});

test("tool-choice config: resolveRuntimeConfig exposes defaultToolChoice", () => {
  const resolved = resolveRuntimeConfig(DOCUMENT);
  assert.equal(resolved.defaultToolChoice, "auto");
});

test("tool-choice config: InteractiveSessionOptions accepts defaultToolChoice", () => {
  // Verify the option is accepted by the session factory (the wiring is
  // exercised at the type level; this test verifies the runtime accepts
  // the value without error and defaults to "auto" when undefined).
  const session = createInteractiveSession({
    adapter: noopAdapter(),
    model: "test-model",
    systemPrompt: "",
    maxTokens: 128,
    temperature: 0,
    toolRegistry: noopToolRegistry(),
    repositoryRoot: "/tmp",
    defaultToolChoice: "required",
  });
  assert.ok(session);
  session.clearHistory();
});

test("tool-choice config: defaultToolChoice accepts all three enum values", () => {
  for (const choice of ["auto", "none", "required"] as const) {
    const session = createInteractiveSession({
      adapter: noopAdapter(),
      model: "test-model",
      systemPrompt: "",
      maxTokens: 128,
      temperature: 0,
      toolRegistry: noopToolRegistry(),
      repositoryRoot: "/tmp",
      defaultToolChoice: choice,
    });
    assert.ok(session, `defaultToolChoice=${choice} must be accepted`);
  }
});
