import assert from "node:assert/strict";
import test from "node:test";

import {
  createBoundedToolAdapter,
  createToolEffectRecorderBridge,
  ToolAdapterError,
  isAbortError,
  type ToolAdapter,
  type ToolAdapterContext,
  type ToolAdapterInput,
  type ToolAdapterResult,
  type ToolEffectRecorder,
} from "../../src/tools/tool-adapter.ts";
import { createToolManifest, type ToolManifestEntry } from "../../src/tools/tool-manifest.ts";

function validEntry(overrides: Partial<ToolManifestEntry> = {}): ToolManifestEntry {
  return {
    id: "test-tool",
    name: "test_tool",
    description: "Test tool",
    inputSchema: { type: "object", properties: {}, required: [] },
    capabilities: ["read"],
    bounds: { timeoutMs: 1000, maxOutputBytes: 1024, maxMemoryBytes: 65536 },
    adapterId: "test-adapter",
    ...overrides,
  };
}

function makeAdapter(adapterId: string, impl: (input: ToolAdapterInput, ctx: ToolAdapterContext) => Promise<ToolAdapterResult>): ToolAdapter {
  return {
    adapterId,
    async execute(input, ctx) { return impl(input, ctx); },
  };
}

const defaultContext: ToolAdapterContext = { repositoryRoot: "." };

// ============================================================================
// createBoundedToolAdapter
// ============================================================================

test("tool-adapter: creates bounded adapter with valid entry", () => {
  const manifest = createToolManifest([validEntry()]);
  const adapter = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: "ok", isError: false, durationMs: 0, truncated: false, cancelled: false,
  }));
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  assert.equal(bounded.adapterId, "test-adapter");
  assert.equal(bounded.entry.id, "test-tool");
});

test("tool-adapter: throws on missing manifest entry", () => {
  const manifest = createToolManifest();
  const adapter = makeAdapter("test-adapter", async () => ({ toolId: "", content: "", isError: false, durationMs: 0, truncated: false, cancelled: false }));
  assert.throws(
    () => createBoundedToolAdapter(adapter, manifest, validEntry()),
    (e: unknown) => (e as Error).message.includes("not registered"),
  );
});

test("tool-adapter: throws on adapterId mismatch", () => {
  const manifest = createToolManifest([validEntry()]);
  const adapter = makeAdapter("wrong-adapter", async () => ({ toolId: "", content: "", isError: false, durationMs: 0, truncated: false, cancelled: false }));
  assert.throws(
    () => createBoundedToolAdapter(adapter, manifest, validEntry()),
    (e: unknown) => (e as Error).message.includes("does not match"),
  );
});

test("tool-adapter: execute returns result on success", async () => {
  const manifest = createToolManifest([validEntry()]);
  const adapter = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: "hello", isError: false, durationMs: 0, truncated: false, cancelled: false,
  }));
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  const result = await bounded.execute(
    { toolId: "test-tool", arguments: {} },
    defaultContext,
  );
  assert.equal(result.content, "hello");
  assert.equal(result.isError, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.truncated, false);
});

test("tool-adapter: execute records intent and terminal to recorder", async () => {
  const manifest = createToolManifest([validEntry()]);
  let beginCalls = 0, endCalls = 0;
  let lastOutcome = "";
  const recorder: ToolEffectRecorder = {
    beginEffect: () => { beginCalls++; },
    endEffect: (_id, input) => { endCalls++; lastOutcome = input.outcome; },
  };
  const adapter = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: "ok", isError: false, durationMs: 0, truncated: false, cancelled: false,
  }));
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  await bounded.execute({ toolId: "test-tool", arguments: {} }, { repositoryRoot: ".", recorder });
  assert.equal(beginCalls, 1);
  assert.equal(endCalls, 1);
  assert.equal(lastOutcome, "succeeded");
});

test("tool-adapter: execute records failed outcome on error", async () => {
  const manifest = createToolManifest([validEntry()]);
  let lastOutcome = "";
  let lastError: { code: string; message: string } | undefined;
  const recorder: ToolEffectRecorder = {
    beginEffect: () => {},
    endEffect: (_id, input) => { lastOutcome = input.outcome; lastError = input.error; },
  };
  const adapter = makeAdapter("test-adapter", async () => {
    throw new Error("boom");
  });
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  const result = await bounded.execute({ toolId: "test-tool", arguments: {} }, { repositoryRoot: ".", recorder });
  assert.equal(result.isError, true);
  assert.equal(lastOutcome, "failed");
  assert.ok(lastError);
  assert.equal(lastError!.code, "tool_adapter_execution_failed");
});

test("tool-adapter: execute records cancelled outcome on abort", async () => {
  const manifest = createToolManifest([validEntry()]);
  let lastOutcome = "";
  const recorder: ToolEffectRecorder = {
    beginEffect: () => {},
    endEffect: (_id, input) => { lastOutcome = input.outcome; },
  };
  const adapter = makeAdapter("test-adapter", async () => {
    throw new Error("AbortError");
  });
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  const controller = new AbortController();
  controller.abort();
  const result = await bounded.execute(
    { toolId: "test-tool", arguments: {} },
    { repositoryRoot: ".", recorder, signal: controller.signal },
  );
  assert.equal(result.isError, true);
  assert.equal(result.cancelled, true);
  assert.equal(lastOutcome, "cancelled");
});

test("tool-adapter: recorder failure does not crash execution", async () => {
  const manifest = createToolManifest([validEntry()]);
  const recorder: ToolEffectRecorder = {
    beginEffect: () => { throw new Error("recorder broken"); },
    endEffect: () => { throw new Error("recorder broken"); },
  };
  const adapter = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: "ok", isError: false, durationMs: 0, truncated: false, cancelled: false,
  }));
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  const result = await bounded.execute({ toolId: "test-tool", arguments: {} }, { repositoryRoot: ".", recorder });
  assert.equal(result.isError, false);
  assert.equal(result.content, "ok");
});

test("tool-adapter: truncates output exceeding maxOutputBytes", async () => {
  const manifest = createToolManifest([validEntry({ bounds: { timeoutMs: 5000, maxOutputBytes: 10, maxMemoryBytes: 65536 } })]);
  const bigContent = "x".repeat(100);
  const adapter = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: bigContent, isError: false, durationMs: 0, truncated: false, cancelled: false,
  }));
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry({ bounds: { timeoutMs: 5000, maxOutputBytes: 10, maxMemoryBytes: 65536 } }));
  const result = await bounded.execute({ toolId: "test-tool", arguments: {} }, defaultContext);
  assert.equal(result.truncated, true);
  assert.ok(result.content.length <= 20);
});

test("tool-adapter: does not truncate output within maxOutputBytes", async () => {
  const manifest = createToolManifest([validEntry({ bounds: { timeoutMs: 5000, maxOutputBytes: 1000, maxMemoryBytes: 65536 } })]);
  const adapter = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: "small", isError: false, durationMs: 0, truncated: false, cancelled: false,
  }));
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry({ bounds: { timeoutMs: 5000, maxOutputBytes: 1000, maxMemoryBytes: 65536 } }));
  const result = await bounded.execute({ toolId: "test-tool", arguments: {} }, defaultContext);
  assert.equal(result.truncated, false);
  assert.equal(result.content, "small");
});

test("tool-adapter: throws on toolId mismatch", async () => {
  const manifest = createToolManifest([validEntry()]);
  const adapter = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: "ok", isError: false, durationMs: 0, truncated: false, cancelled: false,
  }));
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  await assert.rejects(
    bounded.execute({ toolId: "wrong-tool", arguments: {} }, defaultContext),
    (e: unknown) => (e as Error).message.includes("mismatch"),
  );
});

test("tool-adapter: preserves structured output", async () => {
  const manifest = createToolManifest([validEntry()]);
  const adapter = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: "result", isError: false, structured: { key: "value" }, durationMs: 0, truncated: false, cancelled: false,
  }));
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  const result = await bounded.execute({ toolId: "test-tool", arguments: {} }, defaultContext);
  assert.ok(result.structured);
  assert.equal(result.structured!.key, "value");
});

test("tool-adapter: preserves metadata", async () => {
  const manifest = createToolManifest([validEntry()]);
  const adapter = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: "result", isError: false, metadata: { source: "kagi" }, durationMs: 0, truncated: false, cancelled: false,
  }));
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  const result = await bounded.execute({ toolId: "test-tool", arguments: {} }, defaultContext);
  assert.ok(result.metadata);
  assert.equal(result.metadata!.source, "kagi");
});

test("tool-adapter: duration is positive after execution", async () => {
  const manifest = createToolManifest([validEntry()]);
  const adapter = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: "ok", isError: false, durationMs: 0, truncated: false, cancelled: false,
  }));
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  const result = await bounded.execute({ toolId: "test-tool", arguments: {} }, defaultContext);
  assert.ok(result.durationMs >= 0);
});

test("tool-adapter: harness error is normalized to ToolAdapterError", async () => {
  const manifest = createToolManifest([validEntry()]);
  const adapter = makeAdapter("test-adapter", async () => {
    throw new ToolAdapterError("custom error", "custom_code");
  });
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  const result = await bounded.execute({ toolId: "test-tool", arguments: {} }, defaultContext);
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("custom error"));
});

test("tool-adapter: non-Error throw is handled", async () => {
  const manifest = createToolManifest([validEntry()]);
  const adapter = makeAdapter("test-adapter", async () => {
    throw "string error";
  });
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  const result = await bounded.execute({ toolId: "test-tool", arguments: {} }, defaultContext);
  assert.equal(result.isError, true);
});

test("tool-adapter: bounds override from context applies", async () => {
  const manifest = createToolManifest([validEntry({ bounds: { timeoutMs: 10000, maxOutputBytes: 1000, maxMemoryBytes: 65536 } })]);
  const bigContent = "x".repeat(100);
  const adapter = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: bigContent, isError: false, durationMs: 0, truncated: false, cancelled: false,
  }));
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry({ bounds: { timeoutMs: 10000, maxOutputBytes: 1000, maxMemoryBytes: 65536 } }));
  const result = await bounded.execute(
    { toolId: "test-tool", arguments: {} },
    { repositoryRoot: ".", boundsOverride: { maxOutputBytes: 10 } },
  );
  assert.equal(result.truncated, true);
});

// ============================================================================
// isAbortError
// ============================================================================

test("tool-adapter: isAbortError returns true for AbortError", () => {
  const err = new Error("aborted");
  err.name = "AbortError";
  assert.ok(isAbortError(err));
});

test("tool-adapter: isAbortError returns true for ABORT_ERR code", () => {
  const err = new Error("aborted") as Error & { code?: string };
  err.code = "ABORT_ERR";
  assert.ok(isAbortError(err));
});

test("tool-adapter: isAbortError returns false for generic error", () => {
  assert.ok(!isAbortError(new Error("generic")));
});

test("tool-adapter: isAbortError returns false for non-Error", () => {
  assert.ok(!isAbortError("string"));
  assert.ok(!isAbortError(null));
  assert.ok(!isAbortError(undefined));
});

// ============================================================================
// createToolEffectRecorderBridge
// ============================================================================

test("tool-adapter: bridge delegates beginEffect with actor", () => {
  let captured: { actor: { kind: string; id: string } } | undefined;
  const recorder = {
    beginEffect: (input: { actor: { kind: string; id: string } }) => { captured = input; },
    endEffect: () => {},
  };
  const bridge = createToolEffectRecorderBridge(recorder);
  bridge.beginEffect({ effectId: "e1", kind: "process", description: "test", intentHash: "hash" });
  assert.ok(captured);
  assert.equal(captured!.actor.kind, "harness");
  assert.equal(captured!.actor.id, "tool-adapter");
});

test("tool-adapter: bridge delegates endEffect", () => {
  let captured: { outcome: string } | undefined;
  const recorder = {
    beginEffect: () => {},
    endEffect: (_id: string, input: { outcome: string }) => { captured = input; },
  };
  const bridge = createToolEffectRecorderBridge(recorder);
  bridge.endEffect("e1", { outcome: "succeeded", resultHash: "hash" });
  assert.ok(captured);
  assert.equal(captured!.outcome, "succeeded");
});

test("tool-adapter: bridge passes error in endEffect", () => {
  let captured: { error?: { code: string } } | undefined;
  const recorder = {
    beginEffect: () => {},
    endEffect: (_id: string, input: { error?: { code: string } }) => { captured = input; },
  };
  const bridge = createToolEffectRecorderBridge(recorder);
  bridge.endEffect("e1", { outcome: "failed", resultHash: "hash", error: { category: "tool", code: "test_code", message: "msg", retryable: false } });
  assert.ok(captured);
  assert.equal(captured!.error!.code, "test_code");
});

test("tool-adapter: bridge passes correlation in beginEffect", () => {
  let captured: { correlation?: Record<string, string | undefined> } | undefined;
  const recorder = {
    beginEffect: (input: { correlation?: Record<string, string | undefined> }) => { captured = input; },
    endEffect: () => {},
  };
  const bridge = createToolEffectRecorderBridge(recorder);
  bridge.beginEffect({ effectId: "e1", kind: "process", description: "test", intentHash: "hash", correlation: { runId: "r1" } });
  assert.ok(captured);
  assert.equal(captured!.correlation!.runId, "r1");
});

test("tool-adapter: bridge is frozen", () => {
  const recorder = { beginEffect: () => {}, endEffect: () => {} };
  const bridge = createToolEffectRecorderBridge(recorder);
  assert.ok(Object.isFrozen(bridge));
});

// ============================================================================
// ToolAdapterError
// ============================================================================

test("tool-adapter: ToolAdapterError has default code", () => {
  const err = new ToolAdapterError("test");
  assert.equal(err.code, "tool_adapter_error");
  assert.equal(err.retryable, false);
});

test("tool-adapter: ToolAdapterError accepts custom code and retryable", () => {
  const err = new ToolAdapterError("test", "custom_code", true, { tool: "x" });
  assert.equal(err.code, "custom_code");
  assert.equal(err.retryable, true);
  assert.equal(err.safeDetails.tool, "x");
});

test("tool-adapter: ToolAdapterError is instanceof Error", () => {
  const err = new ToolAdapterError("test");
  assert.ok(err instanceof Error);
});

// ============================================================================
// Hostile / edge cases
// ============================================================================

test("tool-adapter: execute with empty arguments succeeds", async () => {
  const manifest = createToolManifest([validEntry()]);
  const adapter = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: "ok", isError: false, durationMs: 0, truncated: false, cancelled: false,
  }));
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  const result = await bounded.execute({ toolId: "test-tool", arguments: {} }, defaultContext);
  assert.equal(result.isError, false);
});

test("tool-adapter: result is frozen", async () => {
  const manifest = createToolManifest([validEntry()]);
  const adapter = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: "ok", isError: false, durationMs: 0, truncated: false, cancelled: false,
  }));
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  const result = await bounded.execute({ toolId: "test-tool", arguments: {} }, defaultContext);
  assert.ok(Object.isFrozen(result));
});

test("tool-adapter: bounded adapter is frozen", () => {
  const manifest = createToolManifest([validEntry()]);
  const adapter = makeAdapter("test-adapter", async () => ({ toolId: "", content: "", isError: false, durationMs: 0, truncated: false, cancelled: false }));
  const bounded = createBoundedToolAdapter(adapter, manifest, validEntry());
  assert.ok(Object.isFrozen(bounded));
});

test("tool-adapter: adapter with same id but different impl works", async () => {
  const manifest = createToolManifest([validEntry()]);
  const adapter1 = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: "impl1", isError: false, durationMs: 0, truncated: false, cancelled: false,
  }));
  const adapter2 = makeAdapter("test-adapter", async (input) => ({
    toolId: input.toolId, content: "impl2", isError: false, durationMs: 0, truncated: false, cancelled: false,
  }));
  const bounded1 = createBoundedToolAdapter(adapter1, manifest, validEntry());
  const bounded2 = createBoundedToolAdapter(adapter2, manifest, validEntry());
  const r1 = await bounded1.execute({ toolId: "test-tool", arguments: {} }, defaultContext);
  const r2 = await bounded2.execute({ toolId: "test-tool", arguments: {} }, defaultContext);
  assert.equal(r1.content, "impl1");
  assert.equal(r2.content, "impl2");
});

test("tool-adapter: pure cancellation keeps signals mutable and preserves external reasons", async () => {
  for (const preAborted of [true, false]) for (const reason of [new Error("private caller reason"), "private caller reason", new ToolAdapterError("private typed reason", "caller_private_code", false)]) {
    const controller = new AbortController();
    let terminal: Parameters<ToolEffectRecorder["endEffect"]>[1] | undefined;
    if (preAborted) controller.abort(reason);
    const entered = Promise.withResolvers<AbortSignal>();
    const bounded = createBoundedToolAdapter(makeAdapter("test-adapter", async (_input, context) => {
      const signal = context.signal!; entered.resolve(signal);
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      assert.equal(signal.reason, reason); throw signal.reason;
    }), createToolManifest([validEntry()]), validEntry());
    const operation = bounded.execute({ toolId: "test-tool", arguments: {} }, { repositoryRoot: ".", signal: controller.signal, recorder: { beginEffect() {}, endEffect(_id, result) { terminal = result; } } });
    const actual = await entered.promise;
    if (!preAborted) controller.abort(reason);
    assert.equal(actual.reason, reason); const result = await operation;
    assert.equal(result.cancelled, true); assert.equal(result.content, "");
    assert.equal(terminal?.error?.code, "tool_adapter_cancelled");
    assert.equal(terminal?.error?.message, "Tool execution cancelled");
  }
});
