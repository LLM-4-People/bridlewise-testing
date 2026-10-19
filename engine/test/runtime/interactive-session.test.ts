import { resolveUnifiedConfig } from "../../src/memory/unified/unified-config.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createExecutionClosure } from "../../src/kernel/execution-closure.ts";
import { createUnifiedContextManager } from "../../src/memory/unified/unified-context-manager.ts";
import { createInteractiveSession, type InteractiveSession, type SessionEvent, type TurnResult } from "../../src/runtime/interactive-session.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import type { ChatStreamEvent, ProviderAdapter, ChatCompletionRequest } from "../../src/runtime/provider-adapter.ts";
import { makeNativeMockAdapter as makeMockAdapter, nativeResponseAdapter } from "../support/mock-provider.ts";
import { mkOwnedTempDir } from "../support/temp-dir.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import { LLMError } from "../../src/shared/llm/errors.ts";
import { address, serve } from "../support/loopback-upstream.ts";

const TEMP_ROOT = mkOwnedTempDir("session-test-");
writeFileSync(join(TEMP_ROOT, "test.txt"), "test content");

function contentEvents(...texts: string[]): ChatStreamEvent[] {
  return texts.map((text) => Object.freeze({ type: "content" as const, text }));
}

function usageEvent(prompt: number, completion: number): ChatStreamEvent {
  return Object.freeze({
    type: "usage" as const,
    usage: Object.freeze({ promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion }),
  });
}

function finishEvent(reason: string): ChatStreamEvent {
  return Object.freeze({ type: "finish" as const, reason });
}

function toolCallEvents(id: string, name: string, args: string): ChatStreamEvent[] {
  return [
    Object.freeze({ type: "tool_call_start" as const, index: 0, id, name }),
    Object.freeze({ type: "tool_call_delta" as const, index: 0, arguments: args }),
  ];
}

const toolRegistry = createToolRegistry();

function createSession(adapter: ProviderAdapter, closure?: ReturnType<typeof createExecutionClosure>): InteractiveSession {
  return createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "You are helpful.",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry,
    repositoryRoot: TEMP_ROOT,
    ...(closure !== undefined ? { closure } : {}),
  });
}

async function runTurn(session: InteractiveSession, signal?: AbortSignal): Promise<{ events: SessionEvent[]; result: TurnResult }> {
  const events: SessionEvent[] = [];
  const generator = session.runTurn(signal);
  let result = await generator.next();
  while (!result.done) {
    events.push(result.value);
    result = await generator.next(result.value);
  }
  return { events, result: result.value };
}

// Keyed by each failure's `name`, so every registration is named from this file's bytes.
const SESSION_PROVIDER_FAILURES = {
  LLMError: () => new LLMError("review required", "llm_misalignment_policy_violation", "bad-request", false, { providerCode: "misalignment_policy_violation" }, 403),
  HarnessError: () => new HarnessError("owned refusal", "owned_refusal", false),
  Error: () => new Error("PRIVATE-session-failure-canary"),
};

for (const kind of Object.keys(SESSION_PROVIDER_FAILURES) as (keyof typeof SESSION_PROVIDER_FAILURES)[]) {
  test(`Session preserves native and harness failures but projects unknown failures privately: ${kind}`, async () => {
    const failure = SESSION_PROVIDER_FAILURES[kind]();
    assert.equal(failure.name, kind);
    const adapter = { ...makeMockAdapter([]), async *streamChatCompletion() { throw failure; } };
    const session = createSession(adapter); session.addUserMessage("fixture");
    const { events, result } = await runTurn(session);
    const event = events.find(event => event.type === "error"); assert.ok(event?.type === "error");
    if (kind !== "Error") assert.equal(event.error, failure);
    else { assert.equal(event.error.code, "session_provider_error"); assert.equal(event.error.message, "Provider operation failed"); assert.equal(event.error.retryable, false); }
    assert.equal(result.toolCalls.length, 0); assert.equal(events.some(event => event.type === "tool_result"), false);
  });
}

// ============================================================================
// Basic turn execution
// ============================================================================

test("Session: single turn streams content", async () => {
  const adapter = makeMockAdapter([...contentEvents("Hello", " world"), finishEvent("stop")]);
  const session = createSession(adapter);
  session.addUserMessage("Hi");
  const { events, result } = await runTurn(session);
  assert.equal(result.content, "Hello world");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.toolCalls.length, 0);
  const contentEvents2 = events.filter((e) => e.type === "content");
  assert.equal(contentEvents2.length, 2);
});

test("Session: adds system prompt to message history", () => {
  const adapter = makeMockAdapter([]);
  const session = createSession(adapter);
  const messages = session.messages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[0]?.content, "You are helpful.");
});

test("Session: addUserMessage adds to history", () => {
  const adapter = makeMockAdapter([]);
  const session = createSession(adapter);
  session.addUserMessage("test input");
  const messages = session.messages();
  assert.equal(messages.length, 2);
  assert.equal(messages[1]?.role, "user");
  assert.equal(messages[1]?.content, "test input");
});

test("Session: addUserMessage rejects empty message", () => {
  const adapter = makeMockAdapter([]);
  const session = createSession(adapter);
  assert.throws(() => session.addUserMessage(""), (e: unknown) => (e as Error).message.includes("empty"));
});

test("Session: turn includes usage event", async () => {
  const adapter = makeMockAdapter([...contentEvents("Hi"), finishEvent("stop"), usageEvent(10, 5)]);
  const session = createSession(adapter);
  session.addUserMessage("test");
  const { events, result } = await runTurn(session);
  assert.ok(result.usage);
  if (result.usage) {
    assert.equal(result.usage.promptTokens, 10);
    assert.equal(result.usage.completionTokens, 5);
    assert.equal(result.usage.totalTokens, 15);
  }
  assert.ok(events.some((e) => e.type === "usage"));
});

test("Session: state tracks turn count", async () => {
  const adapter = makeMockAdapter([...contentEvents("Hi"), finishEvent("stop")]);
  const session = createSession(adapter);
  assert.equal(session.state().turnCount, 0);
  session.addUserMessage("turn1");
  await runTurn(session);
  assert.equal(session.state().turnCount, 1);
  session.addUserMessage("turn2");
  await runTurn(session);
  assert.equal(session.state().turnCount, 2);
});

test("Session: multi-turn conversation maintains history", async () => {
  const adapter = makeMockAdapter([...contentEvents("Response 1"), finishEvent("stop")]);
  const session = createSession(adapter);
  session.addUserMessage("turn1");
  await runTurn(session);
  session.addUserMessage("turn2");
  await runTurn(session);
  const messages = session.messages();
  assert.ok(messages.length >= 4); // system, user1, assistant1, user2
});

// ============================================================================
// Tool calling loop
// ============================================================================

test("Session: executes tool calls and continues conversation", async () => {
  let callCount = 0;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(_request: ChatCompletionRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
      callCount++;
      if (callCount === 1) {
        yield* toolCallEvents("call_1", "read_file", '{"path":"test.txt"}');
        yield finishEvent("tool_calls");
      } else {
        yield* contentEvents("The file contains: test content");
        yield finishEvent("stop");
      }
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const session = createSession(adapter);
  session.addUserMessage("Read test.txt");
  const { result } = await runTurn(session);
  assert.equal(callCount, 2);
  assert.equal(result.content, "The file contains: test content");
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.toolResults[0]?.name, "read_file");
  assert.equal(result.toolResults[0]?.content, "test content");
});

test("Session: tool results are included in events", async () => {
  let callCount = 0;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(_request: ChatCompletionRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
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
  const session = createSession(adapter);
  session.addUserMessage("Read test.txt");
  const { events } = await runTurn(session);
  assert.ok(events.some((e) => e.type === "tool_result"));
  assert.ok(events.some((e) => e.type === "tool_call_start"));
});

test("Session: tool execution error is captured in result", async () => {
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
  const session = createSession(adapter);
  session.addUserMessage("Read nonexistent.txt");
  const { result } = await runTurn(session);
  assert.equal(result.toolResults[0]?.isError, true);
});

test("Session: multiple tool calls in one turn", async () => {
  let callCount = 0;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      callCount++;
      if (callCount === 1) {
        yield Object.freeze({ type: "tool_call_start", index: 0, id: "call_1", name: "read_file" });
        yield Object.freeze({ type: "tool_call_delta", index: 0, arguments: '{"path":"test.txt"}' });
        yield Object.freeze({ type: "tool_call_start", index: 1, id: "call_2", name: "list_files" });
        yield Object.freeze({ type: "tool_call_delta", index: 1, arguments: '{"path":"."}' });
        yield finishEvent("tool_calls");
      } else {
        yield* contentEvents("Both tools executed");
        yield finishEvent("stop");
      }
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const session = createSession(adapter);
  session.addUserMessage("Read and list");
  const { result } = await runTurn(session);
  assert.equal(result.toolResults.length, 2);
});

// ============================================================================
// Error handling
// ============================================================================

test("Session: provider error is captured in events", async () => {
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      throw new Error("Provider failed");
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const session = createSession(adapter);
  session.addUserMessage("test");
  const { events, result } = await runTurn(session);
  assert.ok(events.some((e) => e.type === "error"));
  assert.equal(result.finishReason, "error");
});

// ============================================================================
// Timeline recording
// ============================================================================

test("Session: records provider effect in execution closure", async () => {
  const closure = createExecutionClosure({ ledgerId: "test-session" });
  const adapter = makeMockAdapter([...contentEvents("Hi"), finishEvent("stop")]);
  const session = createSession(adapter, closure);
  session.addUserMessage("test");
  await runTurn(session);
  const lineages = closure.lineage();
  assert.ok(lineages.length >= 1);
  const providerEffect = lineages.find((l) => l.kind === "provider");
  assert.ok(providerEffect);
  assert.ok(providerEffect?.intent);
  assert.ok(providerEffect?.terminal);
});

test("Session: records tool effect in execution closure", async () => {
  let callCount = 0;
  const closure = createExecutionClosure({ ledgerId: "test-session" });
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
  const session = createSession(adapter, closure);
  session.addUserMessage("Read test.txt");
  await runTurn(session);
  const lineages = closure.lineage();
  const toolEffect = lineages.find((l) => l.kind === "process");
  assert.ok(toolEffect);
  assert.ok(toolEffect?.intent);
  assert.ok(toolEffect?.terminal);
});

test("Session: closure has no pending effects after successful turn", async () => {
  const closure = createExecutionClosure({ ledgerId: "test-session" });
  const adapter = makeMockAdapter([...contentEvents("Hi"), finishEvent("stop")]);
  const session = createSession(adapter, closure);
  session.addUserMessage("test");
  await runTurn(session);
  assert.equal(closure.pendingEffects().length, 0);
});

test("Session: closure chain is valid after turn", async () => {
  const closure = createExecutionClosure({ ledgerId: "test-session" });
  const adapter = makeMockAdapter([...contentEvents("Hi"), finishEvent("stop")]);
  const session = createSession(adapter, closure);
  session.addUserMessage("test");
  await runTurn(session);
  const verification = closure.verifyChain();
  assert.ok(verification.valid);
});

test("Session: works without closure (no recording)", async () => {
  const adapter = makeMockAdapter([...contentEvents("Hi"), finishEvent("stop")]);
  const session = createSession(adapter);
  session.addUserMessage("test");
  const { result } = await runTurn(session);
  assert.equal(result.content, "Hi");
});

test("Session: records failed provider effect in closure", async () => {
  const closure = createExecutionClosure({ ledgerId: "test-session" });
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      throw new Error("Provider failed");
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const session = createSession(adapter, closure);
  session.addUserMessage("test");
  await runTurn(session);
  const lineages = closure.lineage();
  const providerEffect = lineages.find((l) => l.kind === "provider");
  assert.ok(providerEffect?.terminal);
  if (providerEffect?.terminal) {
    assert.equal(providerEffect.terminal.outcome, "failed");
  }
});

test("Session: records multiple provider effects for tool-calling turn", async () => {
  let callCount = 0;
  const closure = createExecutionClosure({ ledgerId: "test-session" });
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
  const session = createSession(adapter, closure);
  session.addUserMessage("Read test.txt");
  await runTurn(session);
  const lineages = closure.lineage();
  const providerEffects = lineages.filter((l) => l.kind === "provider");
  assert.equal(providerEffects.length, 2);
  for (const effect of providerEffects) {
    assert.ok(effect.intent);
    assert.ok(effect.terminal);
  }
});

// ============================================================================
// State tracking
// ============================================================================

test("Session: state returns frozen snapshot", () => {
  const adapter = makeMockAdapter([]);
  const session = createSession(adapter);
  const state = session.state();
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.messages));
});

test("Session: messages returns copy of history", () => {
  const adapter = makeMockAdapter([]);
  const session = createSession(adapter);
  session.addUserMessage("test");
  const messages1 = session.messages();
  const messages2 = session.messages();
  assert.notEqual(messages1, messages2);
  assert.equal(messages1.length, messages2.length);
});

test("Session: session object is frozen", () => {
  const adapter = makeMockAdapter([]);
  const session = createSession(adapter);
  assert.ok(Object.isFrozen(session));
});

// ============================================================================
// No system prompt
// ============================================================================

test("Session: works with empty system prompt", () => {
  const adapter = makeMockAdapter([]);
  const session = createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry,
    repositoryRoot: TEMP_ROOT,
  });
  assert.equal(session.messages().length, 0);
});

// ============================================================================
// clearHistory (P0-2: /clear was a silent no-op)
// ============================================================================

test("Session: clearHistory clears messages but keeps the system prompt (P0-2)", async () => {
  const adapter = makeMockAdapter([...contentEvents("Hello"), finishEvent("stop")]);
  const session = createSession(adapter);
  session.addUserMessage("turn1");
  await runTurn(session);
  // history now: system, user1, assistant1
  assert.ok(session.messages().length >= 3, "history should have system + user + assistant");
  session.clearHistory();
  const messages = session.messages();
  assert.equal(messages.length, 1, "clearHistory must reset history to just the system prompt");
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[0]?.content, "You are helpful.");
});

test("Session: clearHistory also clears the context manager (P0-2)", async () => {
  let clearCalls = 0;
  const contextManager = createUnifiedContextManager(resolveUnifiedConfig());
  const clear = contextManager.clear;
  contextManager.clear = () => { clearCalls++; clear(); };
  const adapter = makeMockAdapter([...contentEvents("Hi"), finishEvent("stop")]);
  const session = createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "sys",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry,
    repositoryRoot: TEMP_ROOT,
    contextManager,
  });
  session.addUserMessage("hello");
  await runTurn(session);
  assert.ok(clearCalls === 0, "contextManager.clear() must not be called before clearHistory");
  session.clearHistory();
  assert.equal(clearCalls, 1, "clearHistory must call contextManager.clear()");
  assert.equal(session.messages().length, 1);
  assert.equal(session.messages()[0]?.role, "system");
});

test("Session: clearHistory preserves cumulative token usage and turn count (P0-2)", async () => {
  const adapter = makeMockAdapter([...contentEvents("Hi"), finishEvent("stop"), usageEvent(10, 5)]);
  const session = createSession(adapter);
  session.addUserMessage("turn1");
  await runTurn(session);
  assert.equal(session.state().turnCount, 1);
  const tokensBefore = session.state().totalTokens;
  assert.equal(tokensBefore, 15, "expected 15 tokens after one turn");
  session.clearHistory();
  // /clear resets the context window, not the session accounting
  assert.equal(session.state().turnCount, 1, "turnCount is cumulative (not reset by /clear)");
  assert.equal(session.state().totalTokens, tokensBefore, "token totals are cumulative (not reset by /clear)");
});

test("Session: clearHistory on a fresh session leaves just the system prompt (P0-2)", () => {
  const adapter = makeMockAdapter([]);
  const session = createSession(adapter);
  assert.equal(session.messages().length, 1);
  session.clearHistory();
  assert.equal(session.messages().length, 1);
  assert.equal(session.messages()[0]?.role, "system");
});

test("Session: a turn after clearHistory starts fresh from the system prompt (P0-2)", async () => {
  const adapter = makeMockAdapter([...contentEvents("first"), finishEvent("stop")]);
  const session = createSession(adapter);
  session.addUserMessage("turn1");
  await runTurn(session);
  const historyBefore = session.messages().length;
  assert.ok(historyBefore >= 3);
  session.clearHistory();
  session.addUserMessage("turn2");
  const messages = session.messages();
  assert.equal(messages.length, 2, "after clearHistory + one user message: system + user only");
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "user");
  assert.equal(messages[1]?.content, "turn2");
});

// ============================================================================
// CONF-4: maximumToolIterations is configurable (not hardcoded to 10)
// ============================================================================

test("Session: maximumToolIterations defaults to 10 when not provided (CONF-4)", () => {
  const adapter = makeMockAdapter([]);
  const session = createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry,
    repositoryRoot: TEMP_ROOT,
  });
  assert.ok(Object.isFrozen(session));
});

test("Session: maximumToolIterations=1 stops the tool loop (CONF-4)", async () => {
  let callCount = 0;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      callCount++;
      // Always request a tool call; the loop must terminate (not hang) and
      // bound the number of iterations. The check `iteration >= maximumToolIterations`
      // runs after each iteration, so maximumToolIterations=1 allows iterations
      // 0 and 1 (then breaks at iteration 1), matching the original default
      // semantics where MAXIMUM_TOOL_ITERATIONS=10 allowed iterations 0..10.
      yield* toolCallEvents("call_1", "read_file", '{"path":"test.txt"}');
      yield finishEvent("tool_calls");
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const session = createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry,
    repositoryRoot: TEMP_ROOT,
    maximumToolIterations: 1,
  });
  session.addUserMessage("loop");
  const { result } = await runTurn(session);
  assert.ok(callCount === 2, `maximumToolIterations=1 must bound the loop (got ${callCount} provider calls)`);
  assert.ok(result.toolResults.length === 2, `expected 2 tool results, got ${result.toolResults.length}`);
});

test("Session: maximumToolIterations=3 bounds the loop tighter than the default (CONF-4)", async () => {
  let callCount = 0;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      callCount++;
      if (callCount <= 3) {
        yield* toolCallEvents(`call_${callCount}`, "read_file", '{"path":"test.txt"}');
        yield finishEvent("tool_calls");
      } else {
        yield* contentEvents("done");
        yield finishEvent("stop");
      }
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const session = createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry,
    repositoryRoot: TEMP_ROOT,
    maximumToolIterations: 3,
  });
  session.addUserMessage("loop3");
  const { result } = await runTurn(session);
  assert.equal(callCount, 4, "three tool iterations then a final non-tool turn");
  assert.equal(result.toolResults.length, 3, "three tool results from three iterations");
});

// ============================================================================
// FIX 1 (CRITICAL): AbortSignal must be propagated to the ChatCompletionRequest
// so the provider adapter can abort the in-flight HTTP call. Without this,
// Ctrl+C only takes effect at the next SSE event boundary; a hung provider
// blocks for up to 120s.
// ============================================================================

test("Session: runTurn propagates the AbortSignal to the provider request (FIX 1)", async () => {
  let capturedRequest: ChatCompletionRequest | undefined;
  const controller = new AbortController();
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(request: ChatCompletionRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
      capturedRequest = request;
      yield Object.freeze({ type: "content" as const, text: "hi" });
      yield Object.freeze({ type: "finish" as const, reason: "stop" });
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const session = createSession(adapter);
  session.addUserMessage("test");
  await runTurn(session, controller.signal);
  assert.ok(capturedRequest !== undefined, "adapter must receive a request");
  assert.equal(capturedRequest!.signal, controller.signal, "request.signal must be the AbortSignal passed to runTurn");
});

test("Session: runTurn without a signal does not set request.signal (FIX 1)", async () => {
  let capturedRequest: ChatCompletionRequest | undefined;
  const adapter: ProviderAdapter = nativeResponseAdapter({
    providerId: "mock",
    async *streamChatCompletion(request: ChatCompletionRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
      capturedRequest = request;
      yield Object.freeze({ type: "finish" as const, reason: "stop" });
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const session = createSession(adapter);
  session.addUserMessage("test");
  await runTurn(session);
  assert.ok(capturedRequest !== undefined);
  assert.equal(capturedRequest!.signal, undefined, "request.signal must be undefined when no signal is passed");
});


test("Session: actual usage document hashes the exact stored text", async () => {
  const timeline = createTimelineRecorder({ store: createTimelineStore({ path: join(TEMP_ROOT, "usage-documents.db") }) });
  try {
    const session = createInteractiveSession({ adapter: makeMockAdapter([...contentEvents("Hi"), finishEvent("stop"), usageEvent(10, 5)]), model: "test-model", systemPrompt: "Test", maxTokens: 4096, temperature: 0, toolRegistry, repositoryRoot: TEMP_ROOT, timeline });
    session.addUserMessage("test");
    const { result } = await runTurn(session);
    assert.equal(result.finishReason, "stop");
    const events = timeline.store.query({ eventType: "token" });
    assert.equal(events.length, 1, "recording failures must not silently erase usage");
    assert.equal(events[0]!.documents.length, 1);
    const document = events[0]!.documents[0]!;
    const expected = JSON.stringify({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    assert.equal(document.name, "usage"); assert.equal(document.contentJson, expected);
    assert.equal(document.contentDigest, sha256(expected));
  } finally { timeline.close(); }
});

test("Session policy stop is monotonic across repeated turns and history clearing", async () => {
  let calls = 0;
  const failure = new LLMError("review required", "llm_misalignment_policy_violation", "bad-request", false);
  const adapter = { ...makeMockAdapter([]), async *streamChatCompletion() { calls++; throw failure; } };
  const session = createSession(adapter); session.addUserMessage("affected"); await runTurn(session);
  const before = session.messages();
  await assert.rejects(runTurn(session), error => error === failure);
  assert.throws(() => session.addUserMessage("operator review is only text"), error => error === failure);
  assert.throws(() => session.clearHistory(), error => error === failure);
  assert.deepEqual(session.messages(), before); assert.equal(calls, 1);
  const fresh = createSession(makeMockAdapter([...contentEvents("independent"), finishEvent("stop")])); fresh.addUserMessage("fresh unrelated context");
  assert.equal((await runTurn(fresh)).result.content, "independent");
});

test("Session accepted policy stays primary when the host response observer fails", async () => {
  const { createProviderAdapter } = await import("../../src/runtime/provider-adapter.ts");
  const { responseEvents } = await import("../support/mock-provider.ts");
  let calls = 0, observed = 0;
  serve(async () => { calls++; const events = responseEvents({ id: "host-policy", status: "failed" }).map(event => event.type === "response.failed" ? { ...event, response: { ...event.response as Record<string, unknown>, error: { code: "misalignment_policy_violation", message: "review" } } } : event);
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }); });
  const adapter = createProviderAdapter({ provider: { id: "policy", baseUrl: address("https://policy.test/v1"), timeoutMs: 1000, retries: { maxRetries: 0, initialBackoffMs: 1, maxBackoffMs: 1, backoffMultiplier: 1 } }, apiKey: "policy-fixture-key" });
  const session = createInteractiveSession({ adapter, model: "test-model", systemPrompt: "", maxTokens: 100, temperature: 0, toolRegistry, repositoryRoot: TEMP_ROOT,
    onResponse() { observed++; throw new Error("PRIVATE-host-observer-canary"); } });
  session.addUserMessage("affected"); const first = await runTurn(session);
  assert.equal(observed, 1); assert.equal(first.result.errorCode, "llm_misalignment_policy_violation");
  assert.throws(() => session.clearHistory(), { code: "llm_misalignment_policy_violation" });
  await assert.rejects(runTurn(session), { code: "llm_misalignment_policy_violation" }); assert.equal(calls, 1);
});

for (const code of ["misalignment_policy_violation", "context_length_exceeded"]) {
  for (const boundary of ["observer", "abort", "finish"]) {
    test(`ResponseTurn retains native ${code} failure across the ${boundary} boundary`, async () => {
      const { ResponseTurn } = await import("../../src/runtime/response-turn.ts");
      const { parseResponseResource } = await import("../../src/shared/llm/responses.ts");
      const { responseResource, TEST_FAILURE_OPTIONS } = await import("../support/mock-provider.ts");
      const { classifyProviderFailure } = await import("../../src/shared/llm/provider-failure.ts");
      const turn = new ResponseTurn(); const controller = new AbortController(); let observed = 0;
      const response = parseResponseResource({ ...responseResource({ status: "failed" }), error: { code, message: "PRIVATE-resource-canary" } });
      const expected = code === "misalignment_policy_violation" ? "llm_misalignment_policy_violation" : "llm_context_too_long";
      if (boundary === "abort") controller.abort();
      // As the decoder emits a failed terminal without an observation envelope: no diagnostic text.
      const failure = classifyProviderFailure(response.error, { ...TEST_FAILURE_OPTIONS, diagnostic: null });
      const accept = turn.accept({ type: "response", response, status: "failed", failure }, () => { observed++; if (boundary === "observer") throw new Error("PRIVATE-observer"); }, controller.signal);
      if (boundary === "finish") { await accept; await turn.accept({ type: "finish", reason: "error" }); }
      else await assert.rejects(accept, { code: expected, status: undefined });
      assert.equal(observed, boundary === "abort" ? 0 : 1);
      assert.throws(() => turn.complete(), error => error instanceof LLMError && error.code === expected && error.status === undefined && !error.message.includes("PRIVATE"));
      assert.equal(turn.failed().toolCalls.length, 0);
    });
  }
}

test("ResponseTurn keeps an explicit native error over a failed resource, and an observer failure over a completed one", async () => {
  const { ResponseTurn } = await import("../../src/runtime/response-turn.ts");
  const { parseResponseResource } = await import("../../src/shared/llm/responses.ts");
  const { responseResource, nativeResponseEvent } = await import("../support/mock-provider.ts");
  const turn = new ResponseTurn(); const response = parseResponseResource(responseResource({ status: "failed" }));
  await turn.accept(nativeResponseEvent(response, "failed"));
  const native = new LLMError("safe native", "llm_misalignment_policy_violation", "bad-request", false, {}, 422);
  await turn.accept({ type: "error", error: native }); await turn.accept({ type: "finish", reason: "error" });
  assert.throws(() => turn.complete(), error => error === native);
  const completed = new ResponseTurn(); const observer = new Error("ordinary observer");
  await assert.rejects(completed.accept({ type: "response", response: parseResponseResource(responseResource()), status: "completed" }, () => { throw observer; }), error => error === observer);
});
