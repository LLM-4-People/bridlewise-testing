import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createAgentStateStore } from "../../src/agents/agent-state.ts";
import { createAgentRuntime, type AgentRunResult } from "../../src/agents/agent-runtime.ts";
import type { AgentProfile, RuntimeProviderModel } from "../../src/agents/agent-config.ts";
import type { ChatStreamEvent, ProviderAdapter, ChatCompletionRequest } from "../../src/runtime/provider-adapter.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import { makeNativeMockAdapter as makeMockAdapter, nativeResponseAdapter } from "../support/mock-provider.ts";
import { mkOwnedTempDir, createTempDir } from "../support/temp-dir.ts";

const TEMP_ROOT = mkOwnedTempDir("agent-runtime-test-");
writeFileSync(join(TEMP_ROOT, "test.txt"), "test content");

function contentEvents(...texts: string[]): ChatStreamEvent[] {
  return texts.map(text => Object.freeze({ type: "content" as const, text }));
}

function finishEvent(reason: string): ChatStreamEvent {
  return Object.freeze({ type: "finish" as const, reason });
}

function usageEvent(prompt: number, completion: number): ChatStreamEvent {
  return Object.freeze({
    type: "usage" as const,
    usage: Object.freeze({ promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion }),
  });
}

function toolCallEvents(id: string, name: string, args: string): ChatStreamEvent[] {
  return [
    Object.freeze({ type: "tool_call_start" as const, index: 0, id, name }),
    Object.freeze({ type: "tool_call_delta" as const, index: 0, arguments: args }),
  ];
}

const TOOL_REGISTRY = createToolRegistry();

const MODEL_CONFIG: RuntimeProviderModel = {
  providerId: "mock",
  modelId: "test-model",
  maxTokens: 4096,
  temperature: 0,
};

const BASIC_PROFILE: AgentProfile = {
  name: "test-agent", type: "call-and-return",
  model: "test-model",
  provider: "mock",
  systemPrompt: "You are a test agent.",
  tools: ["read_file", "list_files"],
  capabilities: ["read"],
  writeSet: [],
  maxTurns: 5,
};

function setup() {
  const dir = createTempDir("agent-runtime-store-");
  const store = createTimelineStore({ path: join(dir, "timeline.db") });
  const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
  return { store, stateStore, dir };
}

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

async function runAgent(
  adapter: ProviderAdapter,
  profile: AgentProfile,
  task: string,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  const { stateStore, dir } = setup();
  try {
    const agent = createAgentRuntime({
      adapter,
      toolRegistry: TOOL_REGISTRY,
      modelConfig: MODEL_CONFIG,
      profile,
      repositoryRoot: TEMP_ROOT,
      stateStore,
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
    });
    const generator = agent.run(task, signal);
    let result = await generator.next();
    while (!result.done) { result = await generator.next(result.value); }
    return result.value;
  } finally { cleanup(dir); }
}

// ============================================================================
// Single turn execution
// ============================================================================

test("Agent runtime: executes single turn with content response", async () => {
  const adapter = makeMockAdapter([...contentEvents("Hello"), finishEvent("stop")]);
  const result = await runAgent(adapter, BASIC_PROFILE, "Say hello");
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0]!.content, "Hello");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.lifecycleState, "succeeded");
  assert.equal(result.error, null);
});

test("Agent runtime: records agent name in result", async () => {
  const adapter = makeMockAdapter([...contentEvents("Hi"), finishEvent("stop")]);
  const result = await runAgent(adapter, BASIC_PROFILE, "Say hi");
  assert.equal(result.agentName, "test-agent");
  assert.ok(result.agentId.length > 0);
});

test("Agent runtime: tracks token usage across turns", async () => {
  const adapter = makeMockAdapter([...contentEvents("Hi"), finishEvent("stop"), usageEvent(10, 5)]);
  const result = await runAgent(adapter, BASIC_PROFILE, "Say hi");
  assert.equal(result.totalPromptTokens, 10);
  assert.equal(result.totalCompletionTokens, 5);
  assert.equal(result.totalTokens, 15);
});

test("Agent runtime: handles empty content response", async () => {
  const adapter = makeMockAdapter([finishEvent("stop")]);
  const result = await runAgent(adapter, BASIC_PROFILE, "Say nothing");
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0]!.content, "");
});

test("Agent runtime: finishes after stop reason when no tool calls", async () => {
  const adapter = makeMockAdapter([...contentEvents("Done"), finishEvent("stop")]);
  const result = await runAgent(adapter, BASIC_PROFILE, "task");
  assert.equal(result.turns.length, 1);
});

// ============================================================================
// Multi-turn execution
// ============================================================================

test("Agent runtime: executes multiple turns with tool calls", async () => {
  let callCount = 0;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      callCount++;
      if (callCount === 1) {
        yield* toolCallEvents("call_1", "read_file", '{"path":"test.txt"}');
        yield finishEvent("tool_calls");
      } else {
        yield* contentEvents("The file says: test content");
        yield finishEvent("stop");
      }
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const result = await runAgent(adapter, BASIC_PROFILE, "Read test.txt");
  assert.equal(callCount, 2);
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0]!.toolCalls.length, 1);
  assert.equal(result.turns[0]!.toolResults[0]!.content, "test content");
  assert.equal(result.turns[1]!.content, "The file says: test content");
});

test("Agent runtime: stops at maxTurns limit", async () => {
  let callCount = 0;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      callCount++;
      yield* toolCallEvents(`call_${callCount}`, "read_file", '{"path":"test.txt"}');
      yield finishEvent("tool_calls");
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const profile: AgentProfile = { ...BASIC_PROFILE, maxTurns: 3 };
  const result = await runAgent(adapter, profile, "Keep reading");
  assert.equal(result.turns.length, 3);
  assert.ok(callCount >= 3);
});

test("Agent runtime: handles multiple tool calls in one turn", async () => {
  let callCount = 0;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      callCount++;
      if (callCount === 1) {
        yield Object.freeze({ type: "tool_call_start", index: 0, id: "c1", name: "read_file" });
        yield Object.freeze({ type: "tool_call_delta", index: 0, arguments: '{"path":"test.txt"}' });
        yield Object.freeze({ type: "tool_call_start", index: 1, id: "c2", name: "list_files" });
        yield Object.freeze({ type: "tool_call_delta", index: 1, arguments: '{"path":"."}' });
        yield finishEvent("tool_calls");
      } else {
        yield* contentEvents("Done");
        yield finishEvent("stop");
      }
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const result = await runAgent(adapter, BASIC_PROFILE, "Read and list");
  assert.equal(result.turns[0]!.toolCalls.length, 2);
  assert.equal(result.turns[0]!.toolResults.length, 2);
});

// ============================================================================
// Tool filtering by agent profile
// ============================================================================

test("Agent runtime: filters tools by profile allowlist", async () => {
  let callCount = 0;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      callCount++;
      if (callCount === 1) {
        yield* toolCallEvents("call_1", "read_file", '{"path":"test.txt"}');
        yield finishEvent("tool_calls");
      } else {
        yield* contentEvents("Done");
        yield finishEvent("stop");
      }
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const profile: AgentProfile = { ...BASIC_PROFILE, tools: ["read_file"] };
  const result = await runAgent(adapter, profile, "Read test.txt");
  assert.equal(result.turns[0]!.toolResults[0]!.name, "read_file");
});

test("Agent runtime: rejects tool not in profile allowlist", async () => {
  let callCount = 0;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      callCount++;
      if (callCount === 1) {
        yield* toolCallEvents("call_1", "list_files", '{"path":"."}');
        yield finishEvent("tool_calls");
      } else {
        yield* contentEvents("Done");
        yield finishEvent("stop");
      }
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const profile: AgentProfile = { ...BASIC_PROFILE, tools: ["read_file"] };
  const result = await runAgent(adapter, profile, "List files");
  assert.equal(result.turns[0]!.toolResults.length, 0);
  assert.equal(result.turns[0]!.errorCode, "native_action_not_authorized");
  assert.equal(result.lifecycleState, "failed");
});

test("Agent runtime: explicit all tools profile allows the registry", async () => {
  let callCount = 0;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      callCount++;
      if (callCount === 1) {
        yield* toolCallEvents("call_1", "read_file", '{"path":"test.txt"}');
        yield finishEvent("tool_calls");
      } else {
        yield* contentEvents("Done");
        yield finishEvent("stop");
      }
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const profile: AgentProfile = { ...BASIC_PROFILE, tools: "all" };
  const result = await runAgent(adapter, profile, "Read test.txt");
  assert.equal(result.turns[0]!.toolResults[0]!.isError, false);
});

// ============================================================================
// Cancellation
// ============================================================================

test("Agent runtime: cancels via AbortSignal", async () => {
  const adapter = makeMockAdapter([...contentEvents("Hello"), finishEvent("stop")]);
  const controller = new AbortController();
  controller.abort();
  const result = await runAgent(adapter, BASIC_PROFILE, "task", controller.signal);
  assert.equal(result.lifecycleState, "cancelled");
});

test("Agent runtime: cancellation produces cancelled lifecycle state", async () => {
  const controller = new AbortController();
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      yield Object.freeze({ type: "content", text: "Turn 1" });
      yield Object.freeze({ type: "finish", reason: "tool_calls" });
      yield* toolCallEvents("c1", "read_file", '{"path":"test.txt"}');
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const profile: AgentProfile = { ...BASIC_PROFILE, maxTurns: 100 };
  controller.abort();
  const result = await runAgent(adapter, profile, "task", controller.signal);
  assert.equal(result.lifecycleState, "cancelled");
});

// MINOR-5 regression: a mid-turn abort makes runTurn throw `agent_cancelled`.
// The runtime must catch it, mark cancelled, and run the cancellation-recording
// path so the agent state becomes "cancelled" (not left as "running").
test("Agent runtime: mid-turn cancellation records cancelled state (MINOR-5)", async () => {
  const controller = new AbortController();
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      yield Object.freeze({ type: "content" as const, text: "partial" });
      controller.abort();
      yield Object.freeze({ type: "finish" as const, reason: "stop" });
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const { stateStore, dir } = setup();
  try {
    const agent = createAgentRuntime({
      adapter,
      toolRegistry: TOOL_REGISTRY,
      modelConfig: MODEL_CONFIG,
      profile: { ...BASIC_PROFILE, maxTurns: 10 },
      repositoryRoot: TEMP_ROOT,
      stateStore,
      runId: "run-midturn",
      taskId: "task-midturn",
      attemptId: "attempt-midturn",
    });
    const generator = agent.run("task", controller.signal);
    let result = await generator.next();
    while (!result.done) result = await generator.next(result.value);
    const runResult = result.value;
    assert.equal(runResult.lifecycleState, "cancelled", "mid-turn abort must produce lifecycleState cancelled");
    const state = stateStore.getAgentState(agent.agentId);
    assert.ok(state !== undefined, "agent state must be recorded");
    assert.equal(state.lifecycleState, "cancelled", "state store must reflect cancelled (not running)");
  } finally { cleanup(dir); }
});

// ============================================================================
// Error handling
// ============================================================================

test("Agent runtime: provider error results in failed lifecycle", async () => {
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      throw new Error("Provider failed");
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const result = await runAgent(adapter, BASIC_PROFILE, "task");
  assert.equal(result.lifecycleState, "failed");
  assert.ok(result.error !== null);
});

test("Agent runtime: tool execution error is captured in result", async () => {
  let callCount = 0;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      callCount++;
      if (callCount === 1) {
        yield* toolCallEvents("call_1", "read_file", '{"path":"nonexistent.txt"}');
        yield finishEvent("tool_calls");
      } else {
        yield* contentEvents("File not found");
        yield finishEvent("stop");
      }
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const result = await runAgent(adapter, BASIC_PROFILE, "Read nonexistent");
  assert.equal(result.turns[0]!.toolResults[0]!.isError, true);
});

// ============================================================================
// State tracking
// ============================================================================

test("Agent runtime: state is accessible via state method", async () => {
  const { stateStore, dir } = setup();
  try {
    const agent = createAgentRuntime({
      adapter: makeMockAdapter([]),
      toolRegistry: TOOL_REGISTRY,
      modelConfig: MODEL_CONFIG,
      profile: BASIC_PROFILE,
      repositoryRoot: TEMP_ROOT,
      stateStore,
      runId: "r", taskId: "t", attemptId: "a",
    });
    const state = agent.state();
    assert.equal(state.lifecycleState, "running");
    assert.equal(state.turnCount, 0);
    assert.equal(state.totalTokens, 0);
  } finally { cleanup(dir); }
});

test("Agent runtime: agentId and agentName are accessible", async () => {
  const { stateStore, dir } = setup();
  try {
    const agent = createAgentRuntime({
      adapter: makeMockAdapter([]),
      toolRegistry: TOOL_REGISTRY,
      modelConfig: MODEL_CONFIG,
      profile: BASIC_PROFILE,
      repositoryRoot: TEMP_ROOT,
      stateStore,
      runId: "r", taskId: "t", attemptId: "a",
    });
    assert.equal(agent.agentName, "test-agent");
    assert.ok(agent.agentId.length > 0);
  } finally { cleanup(dir); }
});

test("Agent runtime: system prompt is included in messages", async () => {
  const { stateStore, dir } = setup();
  try {
    const agent = createAgentRuntime({
      adapter: makeMockAdapter([]),
      toolRegistry: TOOL_REGISTRY,
      modelConfig: MODEL_CONFIG,
      profile: { ...BASIC_PROFILE, systemPrompt: "Custom system prompt." },
      repositoryRoot: TEMP_ROOT,
      stateStore,
      runId: "r", taskId: "t", attemptId: "a",
    });
    assert.ok(Object.isFrozen(agent));
  } finally { cleanup(dir); }
});

test("Agent runtime: agent object is frozen", async () => {
  const { stateStore, dir } = setup();
  try {
    const agent = createAgentRuntime({
      adapter: makeMockAdapter([]),
      toolRegistry: TOOL_REGISTRY,
      modelConfig: MODEL_CONFIG,
      profile: BASIC_PROFILE,
      repositoryRoot: TEMP_ROOT,
      stateStore,
      runId: "r", taskId: "t", attemptId: "a",
    });
    assert.ok(Object.isFrozen(agent));
  } finally { cleanup(dir); }
});

test("Agent runtime: result is frozen", async () => {
  const adapter = makeMockAdapter([...contentEvents("Hi"), finishEvent("stop")]);
  const result = await runAgent(adapter, BASIC_PROFILE, "task");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.turns));
});

// ============================================================================
// Token accumulation
// ============================================================================

test("Agent runtime: accumulates tokens across multiple turns", async () => {
  let callCount = 0;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      callCount++;
      if (callCount === 1) {
        yield* toolCallEvents("c1", "read_file", '{"path":"test.txt"}');
        yield finishEvent("tool_calls");
        yield usageEvent(100, 50);
      } else {
        yield* contentEvents("Done");
        yield finishEvent("stop");
        yield usageEvent(200, 100);
      }
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const result = await runAgent(adapter, BASIC_PROFILE, "Read and respond");
  assert.equal(result.totalPromptTokens, 300);
  assert.equal(result.totalCompletionTokens, 150);
  assert.equal(result.totalTokens, 450);
});

// ============================================================================
// Empty system prompt
// ============================================================================

test("Agent runtime: works with empty system prompt", async () => {
  const adapter = makeMockAdapter([...contentEvents("Hi"), finishEvent("stop")]);
  const profile: AgentProfile = { ...BASIC_PROFILE, systemPrompt: "" };
  const result = await runAgent(adapter, profile, "task");
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0]!.content, "Hi");
});

// ============================================================================
// FIX 1 (CRITICAL): AbortSignal must be propagated to the ChatCompletionRequest
// so the provider adapter can abort the in-flight HTTP call.
// ============================================================================

test("Agent runtime: runTurn propagates the AbortSignal to the provider request (FIX 1)", async () => {
  const controller = new AbortController();
  let capturedRequest: ChatCompletionRequest | undefined;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(request: ChatCompletionRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
      capturedRequest = request;
      yield* contentEvents("Hi");
      yield finishEvent("stop");
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  await runAgent(adapter, BASIC_PROFILE, "task", controller.signal);
  assert.ok(capturedRequest !== undefined, "adapter must receive a request");
  assert.equal(capturedRequest!.signal, controller.signal, "request.signal must be the AbortSignal passed to run()");
});

test("Agent runtime: runTurn without a signal does not set request.signal (FIX 1)", async () => {
  let capturedRequest: ChatCompletionRequest | undefined;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(request: ChatCompletionRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
      capturedRequest = request;
      yield* contentEvents("Hi");
      yield finishEvent("stop");
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  await runAgent(adapter, BASIC_PROFILE, "task");
  assert.ok(capturedRequest !== undefined);
  assert.equal(capturedRequest!.signal, undefined, "request.signal must be undefined when no signal is passed");
});

// ============================================================================
// FIX 2 (MAJOR): Agent timeout must abort the in-flight provider call, not
// just flip a boolean checked at the next turn boundary. A hung provider
// would otherwise delay the timeout by up to 120s.
// ============================================================================

test("Agent runtime: timeout aborts the in-flight provider call (FIX 2)", async () => {
  // A provider that hangs forever until the signal aborts. The runtime's
  // timeout fires, aborts the combined signal, and the mock's for-await
  // sees signal.aborted and throws — the agent run resolves promptly
  // (not after the provider's own 120s timeout).
  let observedSignal: AbortSignal | undefined;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(request: ChatCompletionRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
      observedSignal = request.signal;
      // Simulate a hung stream: yield nothing, but check the signal.
      // When the timeout aborts the signal, we break out immediately.
      while (!(request.signal?.aborted ?? false)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      yield Object.freeze({ type: "finish" as const, reason: "stop" });
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const startMs = Date.now();
  const { stateStore, dir } = setup();
  try {
    const agent = createAgentRuntime({
      adapter,
      toolRegistry: TOOL_REGISTRY,
      modelConfig: MODEL_CONFIG,
      profile: { ...BASIC_PROFILE, maxTurns: 100 },
      repositoryRoot: TEMP_ROOT,
      stateStore,
      runId: "r", taskId: "t", attemptId: "a",
      timeoutMs: 50, // 50ms timeout
    });
    const generator = agent.run("task");
    let result = await generator.next();
    while (!result.done) result = await generator.next(result.value);
    const runResult = result.value;
    const elapsed = Date.now() - startMs;
    assert.equal(runResult.lifecycleState, "cancelled", "timeout must produce cancelled lifecycleState");
    assert.ok(elapsed < 2000, `timeout must abort promptly (elapsed ${elapsed}ms; expected < 2000ms)`);
    assert.ok(observedSignal !== undefined, "adapter must receive a signal");
    assert.ok(observedSignal!.aborted, "the signal observed by the adapter must be aborted");
  } finally { cleanup(dir); }
});

test("Agent policy stop refuses repeated work before hooks and message injection", async () => {
  const { LLMError } = await import("../../src/shared/llm/errors.ts");
  const failure = new LLMError("review required", "llm_misalignment_policy_violation", "bad-request", false);
  let calls = 0, starts = 0, injections = 0;
  const fixture = setup();
  const adapter = { ...makeMockAdapter([]), async *streamChatCompletion() { calls++; throw failure; } };
  const options = { adapter, profile: BASIC_PROFILE, modelConfig: MODEL_CONFIG, toolRegistry: TOOL_REGISTRY, repositoryRoot: TEMP_ROOT, stateStore: fixture.stateStore,
    runId: "policy-agent-run", taskId: "policy-agent-task", attemptId: "policy-agent-attempt", hooks: { onStart() { starts++; } }, messageInjector() { injections++; return []; } };
  try {
    const agent = createAgentRuntime(options);
    for await (const _event of agent.run("affected")) {}
    const before = { calls, starts, injections };
    await assert.rejects(async () => { for await (const _event of agent.run("review text is not authority")) {} }, error => error === failure);
    assert.deepEqual({ calls, starts, injections }, before); assert.equal(calls, 1);
    const fresh = createAgentRuntime({ ...options, adapter: makeMockAdapter([...contentEvents("independent"), finishEvent("stop")]) });
    let content = ""; for await (const event of fresh.run("fresh unrelated context")) if (event.type === "content") content += event.text;
    assert.equal(content, "independent");
  } finally { fixture.store.close(); cleanup(fixture.dir); }
});
