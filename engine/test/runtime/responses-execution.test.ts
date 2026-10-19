import { createUnifiedContextManager } from "../../src/memory/unified/unified-context-manager.ts";
import { resolveUnifiedConfig } from "../../src/memory/unified/unified-config.ts";
import { messagesToResponseInput, contextTurnMessage, projectResponseContext } from "../../src/shared/llm/response-transcript.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createInteractiveSession } from "../../src/runtime/interactive-session.ts";
import { createAgentRuntime, extractFinalAgentOutput, type AgentRuntimeOptions } from "../../src/agents/agent-runtime.ts";
import { createAgentStateStore } from "../../src/agents/agent-state.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import { createProviderAdapter, type ChatStreamEvent, type ProviderAdapter, type ToolDefinition } from "../../src/runtime/provider-adapter.ts";
import { createToolCallGate } from "../../src/safety/tool-call-gate.ts";
import { inspectResponseDisposition } from "../../src/shared/llm/responses-disposition.ts";
import { parseResponseResource, type ResponseItem } from "../../src/shared/llm/responses.ts";
import { LLMError, isLLMError } from "../../src/shared/llm/errors.ts";
import { makeMockAdapter, nativeResponseEvent, responseResource, responseSseResponse } from "../support/mock-provider.ts";
import { mkOwnedTempDir } from "../support/temp-dir.ts";
import { createAttemptHistory } from "../../src/memory/attempt-history.ts";
import { createMemoryStore } from "../../src/memory/memory-store.ts";
import { createExecutionClosure } from "../../src/kernel/execution-closure.ts";
import { awaitWithSignal } from "../../src/shared/abort-signals.ts";
import { address, serve } from "../support/loopback-upstream.ts";

const root = mkOwnedTempDir("responses-execution-");
const historyUnready = (error: unknown): boolean => isLLMError(error) && error.code === "llm_invalid_response" &&
  error.safeDetails.protocolCode === "responses_history_unready";
const definition: ToolDefinition = { type: "function", function: { name: "effect", description: "Test effect", parameters: {
  type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
} } };
const call = (id = "call_a", extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "function_call", id: `fc_${id}`, call_id: id, name: "effect", arguments: '{"path":"x"}', status: "completed", ...extra,
});
const message = (text: string, phase?: string): Record<string, unknown> => ({ type: "message", id: `msg_${phase ?? "test"}`, role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }], ...(phase === undefined ? {} : { phase }) });
function events(output: readonly Record<string, unknown>[], status: "completed" | "failed" | "incomplete" | "cancelled" = "completed"): ChatStreamEvent[] {
  return [nativeResponseEvent(parseResponseResource(responseResource({ output, status })), status),
    { type: "finish", reason: status === "completed" ? "stop" : status === "incomplete" ? "length" : "error" }];
}
async function drain<T, R>(iterator: AsyncGenerator<T, R, unknown>): Promise<R> {
  let next = await iterator.next(); while (!next.done) next = await iterator.next(); return next.value;
}
function fixture(adapter: ProviderAdapter, extra: Partial<Parameters<typeof createInteractiveSession>[0]> = {}, onEffect?: () => void) {
  let effects = 0;
  const registry = createToolRegistry({ seedDefaults: false });
  registry.register({ definition, handler: () => { onEffect?.(); effects++; return ""; } });
  const context = extra.contextManager ?? createUnifiedContextManager(resolveUnifiedConfig({ contextTokenLimit: 50_000 }));
  const session = createInteractiveSession({ contextManager: context, adapter, model: "test-model", systemPrompt: "", maxTokens: 100, temperature: 0,
    repositoryRoot: root, toolRegistry: registry, ...extra });
  session.addUserMessage("Act");
  return { session, context, registry, effects: () => effects };
}
function agent(adapter: ProviderAdapter, registry: ReturnType<typeof createToolRegistry>, extra: Partial<AgentRuntimeOptions> = {}) {
  const store = createTimelineStore({ path: join(mkOwnedTempDir("native-agent-"), "timeline.db") });
  const runtime = createAgentRuntime({ adapter, toolRegistry: registry, repositoryRoot: root,
    modelConfig: { providerId: "mock", modelId: "test-model", maxTokens: 100, temperature: 0 },
    profile: { name: "native-agent", type: "call-and-return", provider: "mock", model: "test-model", systemPrompt: "", tools: ["effect"], capabilities: ["execute"], writeSet: [], maxTurns: 3 },
    stateStore: createAgentStateStore(createTimelineRecorder({ store })), runId: "run_test", taskId: "task_test", attemptId: "attempt_test", ...extra });
  return runtime;
}

test("native host: completed response persists before effects and full output replays through real wire with empty result", async () => {
  const output = [{ type: "reasoning", id: "rs_test", summary: [], encrypted_content: "opaque reasoning ciphertext" }, call(), message("Working", "commentary")];
  const requests: Record<string, unknown>[] = [];
  let persisted = false;
  serve(async (_input, init) => { requests.push(JSON.parse(String(init?.body))); return responseSseResponse(requests.length === 1 ? { output } : { id: "resp_last", content: "Done" }); });
  const adapter = createProviderAdapter({ provider: { id: "native-test", baseUrl: address("https://native.invalid/v1"), timeoutMs: 2000,
    retries: { maxRetries: 0, initialBackoffMs: 1, maxBackoffMs: 1, backoffMultiplier: 1 } }, apiKey: "synthetic-native-test-key" });
  const f = fixture(adapter, { onResponse: async () => { await Promise.resolve(); persisted = true; } }, () => assert.equal(persisted, true));
  const result = await drain(f.session.runTurn());
  assert.equal(persisted, true); assert.equal(f.effects(), 1); assert.equal(result.content, "Done");
  assert.equal(result.toolResults[0]?.content, "");
  assert.deepEqual((requests[1]!.input as unknown[]).slice(1, 4), output);
  assert.deepEqual((requests[1]!.input as unknown[]).at(-1), { type: "function_call_output", call_id: "call_a", output: "" });
  assert.equal("messages" in requests[0]!, false);
  assert.deepEqual(f.context.turns().map(turn => contextTurnMessage(turn)), f.session.messages());
  assert.deepEqual(messagesToResponseInput(projectResponseContext(f.context)), messagesToResponseInput(f.session.messages()));
});

test("interactive-session provider wire uses current trimmed native context on every iteration", async () => {
  const context = createUnifiedContextManager(resolveUnifiedConfig({ contextTokenLimit: 1100, trimThreshold: 0.7,
    recentTurnWindow: 4, minRecentTurnsKept: 3, summaryTokenBudget: 64 }));
  const output = [{ type: "reasoning", id: "rs_trim", summary: [], encrypted_content: "opaque unchanged", extension: { future: true } },
    call(), message("Working", "commentary")];
  const requests: Record<string, unknown>[] = [];
  serve(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      assert.deepEqual(requests.at(-1)!.input, messagesToResponseInput(projectResponseContext(context)));
      if (requests.length === 1) context.addTurn({ role: "memory", content: "fresh per-iteration context" });
      return responseSseResponse(requests.length === 1 ? { output } : { id: "resp_trim_last", content: "Done" });
    });
  const adapter = createProviderAdapter({ provider: { id: "trim-native-test", baseUrl: address("https://native.invalid/v1"), timeoutMs: 2000,
    retries: { maxRetries: 0, initialBackoffMs: 1, maxBackoffMs: 1, backoffMultiplier: 1 } }, apiKey: "synthetic-native-test-key" });
  const f = fixture(adapter, { contextManager: context });
  for (let index = 0; index < 20; index++) f.session.addUserMessage(`old row ${index}: ` + "payload ".repeat(100));
  f.session.addUserMessage("Perform the current request");
  const fullBefore = f.session.messages();
  const result = await drain(f.session.runTurn());
  assert.equal(result.content, "Done"); assert.equal(requests.length, 2);
  for (const request of requests) {
    const serialized = JSON.stringify(request.input);
    assert.ok(!serialized.includes(fullBefore[2]!.content), "evicted full rows never reach the provider");
    assert.ok(serialized.includes("Prior conversation (summarized)"), "summary is actually transmitted");
  }
  const second = requests[1]!.input as ResponseItem[];
  assert.ok(second.some(item => item.content === "fresh per-iteration context"));
  assert.deepEqual(second.filter(item => output.some(expected => expected.id === item.id)), output);
  assert.deepEqual(second.at(-1), { type: "function_call_output", call_id: "call_a", output: "" });
  assert.ok(f.session.messages().includes(fullBefore[2]!), "full private evidence survives trim");
});

for (const stop of ["abort", "return"] as const) test(`native context captures the resource before first outward response and ${stop}`, async () => {
  const controller = new AbortController();
  const f = fixture(makeMockAdapter(events([call()])));
  const iterator = f.session.runTurn(controller.signal);
  let next = await iterator.next(); while (!next.done && next.value.type !== "response") next = await iterator.next();
  assert.equal(next.done, false);
  assert.deepEqual(f.context.turns().map(turn => contextTurnMessage(turn)), f.session.messages());
  assert.deepEqual(f.context.turns().at(-1)?.responseItems, [call()]);
  if (stop === "return") await iterator.return(undefined as never);
  else { controller.abort(); await drain(iterator); }
  assert.equal(f.effects(), 0);
  assert.throws(() => projectResponseContext(f.context), historyUnready);
});

for (const stop of ["return", "eof", "throw"] as const) test(`partial output survives preterminal ${stop} without a fabricated resource`, async () => {
  const adapter: ProviderAdapter = { ...makeMockAdapter([]), async *streamChatCompletion() {
    yield { type: "content", text: "partial answer" };
    if (stop === "throw") throw new Error("stream interrupted");
  } };
  const f = fixture(adapter); const iterator = f.session.runTurn();
  if (stop === "return") { await iterator.next(); await iterator.return(undefined as never); }
  else await drain(iterator);
  const partial = f.session.messages().at(-1)!;
  assert.equal(partial.content, "partial answer"); assert.equal(partial.responseItems, undefined);
  assert.equal(partial.responseReplayBlocked, true);
  assert.deepEqual(f.context.turns().map(turn => contextTurnMessage(turn)), f.session.messages());
  await assert.rejects(drain(f.session.runTurn()), historyUnready);
});

for (const stop of ["return", "eof"] as const) test(`standalone agent preserves preterminal ${stop} evidence without a fabricated resource`, async () => {
  const adapter: ProviderAdapter = { ...makeMockAdapter([]), async *streamChatCompletion() { yield { type: "content", text: "partial agent answer" }; } };
  const f = fixture(adapter); const runtime = agent(adapter, f.registry);
  const iterator = runtime.run("task");
  if (stop === "return") {
    let next = await iterator.next(); while (!next.done && next.value.type !== "content") next = await iterator.next();
    assert.equal(next.done, false); await iterator.return(undefined as never);
  } else await drain(iterator);
  const partial = runtime.messages().at(-1)!;
  assert.equal(partial.content, "partial agent answer"); assert.equal(partial.responseItems, undefined);
  assert.equal(partial.responseReplayBlocked, true); assert.equal(f.effects(), 0);
  assert.throws(() => messagesToResponseInput(runtime.messages()), historyUnready);
});

for (const rejection of ["throw", "native_error"] as const) test(`provider ${rejection} before output does not poison conversation context`, async () => {
  let rejected = true;
  const adapter: ProviderAdapter = { ...makeMockAdapter([]), async *streamChatCompletion() {
    if (rejected) {
      if (rejection === "native_error") {
        yield { type: "response_event", event: { type: "error", code: "insufficient_quota", message: "No generation started", sequence_number: 0 } };
        yield { type: "error", error: new LLMError("Provider refused admission", "test_admission", "invalid-response", false) };
      }
      throw new Error("provider unavailable before generation");
    }
    yield* events([message("recovered")]);
  } };
  const f = fixture(adapter); await drain(f.session.runTurn());
  assert.deepEqual(f.session.messages(), [{ role: "user", content: "Act" }]);
  const runtime = agent(adapter, f.registry); await drain(runtime.run("task"));
  assert.deepEqual(runtime.messages(), [{ role: "user", content: "task" }]);
  rejected = false; const result = await drain(f.session.runTurn()); assert.equal(result.content, "recovered");
});

for (const operation of ["addTurn", "updateTurn", "trim", "project"] as const) test(`native context ${operation} failure closes subsequent provider requests until successful clear`, async () => {
  let requests = 0;
  const adapter: ProviderAdapter = { ...makeMockAdapter([]), async *streamChatCompletion() { requests++; yield* events([message("done")]); } };
  const f = fixture(adapter); const original = f.context[operation];
  Object.defineProperty(f.context, operation, { value: () => { throw new Error("capture/projection failed"); }, configurable: true, writable: true });
  if (operation === "addTurn") assert.throws(() => f.session.addUserMessage("capture this"), { code: "session_context_failed" });
  const before = requests;
  if (operation === "updateTurn") await drain(f.session.runTurn());
  else await assert.rejects(drain(f.session.runTurn()), { code: "session_context_failed" });
  const after = requests;
  assert.equal(after - before, operation === "updateTurn" ? 1 : 0);
  await assert.rejects(drain(f.session.runTurn()), { code: "session_context_failed" });
  assert.equal(requests, after);
  Object.defineProperty(f.context, operation, { value: original, configurable: true, writable: true });
  const clear = f.context.clear; f.context.clear = () => { throw new Error("clear failed"); };
  assert.throws(() => f.session.clearHistory(), { code: "session_context_failed" });
  await assert.rejects(drain(f.session.runTurn()), { code: "session_context_failed" });
  f.context.clear = clear; f.session.clearHistory(); f.session.addUserMessage("fresh");
  const result = await drain(f.session.runTurn()); assert.equal(result.content, "done");
});

for (const status of ["failed", "incomplete", "cancelled"] as const) test(`native host: ${status} resource has zero execution and blocked replay`, async () => {
  const f = fixture(makeMockAdapter(events([call()], status)));
  const result = await drain(f.session.runTurn());
  assert.equal(f.effects(), 0); assert.equal(result.toolResults.length, 0);
  assert.deepEqual(result.response?.output, [call()]);
  assert.throws(() => messagesToResponseInput(f.session.messages()), historyUnready);
});

for (const tail of ["eof", "error", "throw"] as const) test(`native host: ${tail} defeats contradictory completed action authority`, async () => {
  const raw = makeMockAdapter(events([call()]));
  const adapter: ProviderAdapter = { ...raw, async *streamChatCompletion() {
    if (tail === "error") yield { type: "error", error: new LLMError("prior native error", "native_error", "invalid-response", false) } as const;
    yield events([call()])[0]!;
    if (tail !== "eof") yield events([call()])[1]!;
    if (tail === "throw") throw new Error("cleanup failed");
  } };
  const f = fixture(adapter); const result = await drain(f.session.runTurn());
  assert.equal(f.effects(), 0); assert.equal(result.finishReason, "error"); assert.deepEqual(result.response?.output, [call()]);
});

// Keyed by `type/name` of each hostile item, so the test name is static.
const HOSTILE_BATCH_ITEMS: Readonly<Record<string, Record<string, unknown>>> = {
  "function_call/unadvertised": call("call_b", { name: "unadvertised" }),
  "computer_call/": { type: "computer_call", call_id: "computer_test", action: { type: "click", x: 1, y: 1 } },
  "future_action/": { type: "future_action" },
};

for (const label of Object.keys(HOSTILE_BATCH_ITEMS)) {
  test(`native host: whole batch rejects ${label} before first effect`, async () => {
    const hostile = HOSTILE_BATCH_ITEMS[label]!;
    assert.equal(`${String(hostile.type)}/${String(hostile.name ?? "")}`, label);
    const f = fixture(makeMockAdapter(events([call(), hostile]))); const result = await drain(f.session.runTurn());
    assert.equal(f.effects(), 0); assert.equal(result.finishReason, "error"); assert.equal(result.toolResults.length, 0);
    assert.equal(result.response?.output.length, 2);
  });
}

test("native host: pending persistence observer is cancellation aware and closes provider iterator", async () => {
  const controller = new AbortController(); let closed = false;
  let observed!: () => void; const started = new Promise<void>(resolve => { observed = resolve; });
  const adapter: ProviderAdapter = { ...makeMockAdapter([]), async *streamChatCompletion() {
    try { yield* events([call()]); } finally { closed = true; }
  } };
  const f = fixture(adapter, { onResponse: (_metadata, signal) => { assert.equal(signal, controller.signal); observed(); return new Promise(() => {}); } });
  const pending = drain(f.session.runTurn(controller.signal)); await started;
  assert.deepEqual(f.context.turns().map(turn => contextTurnMessage(turn)), f.session.messages());
  assert.deepEqual(f.context.turns().at(-1)?.responseItems, [call()]);
  controller.abort();
  const result = await pending; assert.equal(f.effects(), 0); assert.equal(result.finishReason, "error"); assert.equal(closed, true);
});

for (const stop of ["abort", "return", "throw"] as const) test(`native host: settled first result survives ${stop} before the second action`, async () => {
  const controller = new AbortController(); const f = fixture(makeMockAdapter(events([call(), call("call_b", { arguments: '{"path":"y"}' })])));
  const gate = createToolCallGate({ getDefinitions: () => f.registry.definitions() });
  let executed = 0;
  const subject = stop === "throw" ? fixture(makeMockAdapter(events([call(), call("call_b", { arguments: '{"path":"y"}' })])), {
    governedExecution: { preflight: (calls, definitions) => gate.check(calls, definitions), execute: async call => {
      if (++executed === 2) throw new Error("second dispatch failed");
      return { toolCallId: call.id, name: call.function.name, content: "first settled", isError: false };
    } },
  }) : f;
  const session = subject.session;
  const iterator = session.runTurn(controller.signal);
  let next = await iterator.next(); while (!next.done && next.value.type !== "tool_result") next = await iterator.next();
  assert.equal(next.done, false);
  assert.deepEqual(subject.context.turns().map(turn => contextTurnMessage(turn)), session.messages());
  assert.equal(subject.context.turns().at(-1)?.content, stop === "throw" ? "first settled" : "");
  if (stop === "return") await iterator.return(undefined as never);
  else { if (stop === "abort") controller.abort(); const result = await drain(iterator); assert.equal(result.toolResults.length, 1); }
  const history = session.messages(); assert.equal(history.filter(m => m.role === "tool").length, 1);
  assert.equal(history.find(m => m.role === "assistant")?.responseItems?.length, 2);
  assert.throws(() => messagesToResponseInput(history), historyUnready);
  if (stop !== "throw") assert.equal(f.effects(), 1);
});

test("native host: exact sent schema cannot be widened during the provider turn", async () => {
  const f = fixture(makeMockAdapter([])); let current: readonly ToolDefinition[] = [definition];
  const gate = createToolCallGate({ getDefinitions: () => current });
  const widened: ToolDefinition = { ...definition, function: { ...definition.function, parameters: { type: "object" } } };
  current = [widened];
  const checked = gate.check([{ id: "a", type: "function", function: { name: "effect", arguments: '{"command":"bad"}' } }], [definition]);
  assert.equal(checked.clean.length, 0); assert.equal(checked.blocked.length, 1); assert.equal(f.effects(), 0);
});

test("native disposition: selectors, namespaces, caller modes and hosted progress preserve exact authority", () => {
  const tools: ResponseItem[] = [{ type: "function", name: "effect" }, { type: "function", name: "other" }];
  const inspect = (output: Record<string, unknown>[], extra = {}) => inspectResponseDisposition(parseResponseResource(responseResource({ output })), "completed", { tools, admit: () => true, ...extra });
  for (const toolChoice of ["none", { type: "function", name: "other" }, { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "other" }] }])
    assert.equal(inspect([call()], { toolChoice }).kind, "unavailable");
  assert.equal(inspect([call()], { toolChoice: { type: "function", name: "effect" } }).kind, "actions");
  assert.equal(inspect([call("a", { namespace: "scoped" })]).kind, "unavailable");
  assert.equal(inspect([call("a", { caller: { type: "program", caller_id: "program_a" } })]).kind, "unavailable");
  assert.equal(inspect([{ type: "program_output", id: "po_a", call_id: "program_a", result: "done", status: "completed" }]).kind, "continue");
  assert.equal(inspect([message("progress", "commentary")]).kind, "continue");
  assert.equal(inspect([message("progress", "commentary"), message("done", "final_answer")]).kind, "final");
  assert.equal(inspect([{ type: "tool_search_call", execution: "client", call_id: "search_a" }]).kind, "unavailable");
  assert.equal(inspect([{ type: "tool_search_call", execution: "server" }]).kind, "final");
  for (const type of ["computer", "computer_use", "computer_use_preview"])
    assert.equal(inspect([{ type: "computer_call", call_id: "computer_a" }], { tools: [{ type }], toolChoice: { type } }).kind, "actions");
});

test("native agent: empty inventory denies tools; explicit all admits the configured registry", async () => {
  for (const tools of [[], "all"] as const) {
    let observed: unknown; let request = 0;
    const adapter: ProviderAdapter = { ...makeMockAdapter([]), async *streamChatCompletion(input) { observed ??= input.tools ?? []; yield* events(++request === 1 ? [call()] : [message("Done")]); } };
    const f = fixture(adapter);
    const runtime = agent(adapter, f.registry, { profile: { name: "empty-agent", type: "call-and-return", provider: "mock", model: "test-model", systemPrompt: "", tools, capabilities: [], writeSet: [], maxTurns: 2 } });
    const result = await drain(runtime.run("Act"));
    assert.equal(f.effects(), tools === "all" ? 1 : 0);
    assert.equal((observed as unknown[]).length, tools === "all" ? 1 : 0);
    assert.equal(result.lifecycleState, tools === "all" ? "succeeded" : "failed");
  }
});

test("native agent: refusal-only final answer wins over earlier commentary", async () => {
  let request = 0;
  const adapter: ProviderAdapter = { ...makeMockAdapter([]), async *streamChatCompletion() { yield* events(++request === 1 ? [message("Considering", "commentary")]
    : [{ type: "message", id: "msg_refusal", role: "assistant", content: [{ type: "refusal", refusal: "I cannot complete this request." }] }]); } };
  const f = fixture(adapter); const result = await drain(agent(adapter, f.registry).run("Act"));
  assert.equal(result.turns.length, 2); assert.equal(result.turns[1]?.refusal, "I cannot complete this request.");
  assert.equal(extractFinalAgentOutput(result.turns).output, "I cannot complete this request.");
});

for (const stop of ["abort", "return"] as const) test(`native agent: settled output survives iterator ${stop}`, async () => {
  const controller = new AbortController();
  const adapter = makeMockAdapter(events([call(), call("call_b", { arguments: '{"path":"y"}' })]));
  const f = fixture(adapter); const runtime = agent(adapter, f.registry); const iterator = runtime.run("Act", controller.signal);
  let next = await iterator.next(); while (!next.done && next.value.type !== "tool_result") next = await iterator.next();
  if (stop === "return") await iterator.return(undefined as never);
  else { controller.abort(); const result = await drain(iterator); assert.equal(result.turns[0]?.toolResults.length, 1); }
  assert.equal(f.effects(), 1); assert.equal(runtime.messages().filter(m => m.role === "tool").length, 1);
  assert.throws(() => messagesToResponseInput(runtime.messages()), historyUnready);
  assert.equal(runtime.state().lifecycleState, "cancelled");
});

test("native host: incomplete and continuation cap are failed attempts and final empty results stay replayable", async () => {
  for (const incomplete of [true, false]) {
    const store = createTimelineStore({ path: join(mkOwnedTempDir("native-attempt-"), "timeline.db") });
    const history = createAttemptHistory({ memoryStore: createMemoryStore({ store }) });
    let request = 0;
    const adapter: ProviderAdapter = { ...makeMockAdapter([]), async *streamChatCompletion() {
      yield* events([call(`call_${++request}`, { arguments: JSON.stringify({ path: String(request) }) })], incomplete ? "incomplete" : "completed");
    } };
    const f = fixture(adapter, { attemptHistory: history, maximumToolIterations: 1 });
    const result = await drain(f.session.runTurn());
    assert.equal(history.countByOutcome("failed"), 1); assert.equal(history.countByOutcome("succeeded"), 0);
    if (!incomplete) {
      assert.equal(result.errorCode, "session_iteration_limit"); assert.equal(result.toolResults.length, 2);
      const input = messagesToResponseInput(f.session.messages());
      assert.equal(input.filter(item => item.type === "function_call_output").length, 2);
      assert.equal(input.at(-1)?.output, "");
    }
  }
});

test("native host: iterator abandonment settles provider recording without creating unexecuted tool results", async () => {
  const closure = createExecutionClosure();
  const f = fixture(makeMockAdapter(events([call(), call("call_b")])), { closure });
  const iterator = f.session.runTurn(); let next = await iterator.next();
  while (!next.done && next.value.type !== "tool_result") next = await iterator.next();
  await iterator.return(undefined as never);
  assert.equal(closure.pendingEffects().length, 0); assert.equal(f.effects(), 1);
  assert.equal(f.session.messages().filter(m => m.role === "tool").length, 1);
});

test("native observer: abort plus rejection never leaves an unobserved rejected operation", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(awaitWithSignal(Promise.reject(new Error("already pending rejection")), controller.signal), error => error === controller.signal.reason);
  await assert.rejects(awaitWithSignal(Promise.resolve("ready"), controller.signal), error => error === controller.signal.reason);
  const duringObserver = new AbortController();
  const f = fixture(makeMockAdapter(events([call()])), { onResponse: () => {
    duringObserver.abort(); return Promise.reject(new Error("observer rejected after abort"));
  } });
  const result = await drain(f.session.runTurn(duringObserver.signal));
  assert.equal(result.finishReason, "error"); assert.equal(f.effects(), 0);
  // node:test also fails on any unhandled rejection after the owning test settles.
  await new Promise<void>(resolve => setImmediate(resolve));
});

test("foreground native hosts capture partial evidence before local retirement on EOF and iterator return", async t => {
  const { ResponsesTracker } = await import("../../src/shared/llm/responses-tracking.ts");
  const { nativeResponseAdapter, responseEvents } = await import("../support/mock-provider.ts");
  const retire = ResponsesTracker.prototype.retire;
  let history: () => readonly import("../../src/runtime/provider-adapter.ts").ChatMessage[] = () => [];
  let retirements = 0;
  t.mock.method(ResponsesTracker.prototype, "retire", function(this: InstanceType<typeof ResponsesTracker>, id: string, provider?: string) {
    assert.equal(history().some(message => message.role === "assistant" && message.content === "partial evidence"), true);
    const result = retire.call(this, id, provider); if (result) retirements++; return result;
  });
  for (const host of ["session", "agent"] as const) for (const exit of ["eof", "return"] as const) {
    let receipts = 0, held: import("../../src/shared/llm/client.ts").ResponseReceipt | undefined;
    const wire = responseEvents({ id: `partial-${host}-${exit}`, content: "partial evidence" });
    const end = wire.findIndex(event => event.type === "response.output_text.delta") + 1;
    serve(async () => new Response(wire.slice(0, end).map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
    const adapter = nativeResponseAdapter(createProviderAdapter({ provider: { id: "receipt-host", baseUrl: address("https://native.invalid/v1"), timeoutMs: 2000,
      retries: { maxRetries: 0, initialBackoffMs: 1, maxBackoffMs: 1, backoffMultiplier: 1 } }, apiKey: "synthetic-receipt-host-key" }));
    const onResponseReceipt = (receipt: import("../../src/shared/llm/client.ts").ResponseReceipt) => { receipts++; held = receipt; };
    const f = fixture(adapter, { onResponseReceipt });
    const runtime = agent(adapter, f.registry, { onResponseReceipt });
    history = host === "session" ? () => f.session.messages() : () => runtime.messages();
    const iterator = host === "session" ? f.session.runTurn() : runtime.run("Act");
    let sawPrivateProgress = false, sawContent = false;
    for (;;) {
      const event = await iterator.next(); if (event.done) break;
      if (event.value.type === "content") sawContent = true;
      if (event.value.type === "response_event" && event.value.progress?.some(part => part.type === "content" && part.text === "partial evidence")) {
        assert.equal(receipts, 1); sawPrivateProgress = true;
        if (exit === "return") { await iterator.return(undefined as never); break; }
      }
      if (event.value.type === "error") {
        assert.equal(held!.retire(), false, "retirement must occur before yielding the error to a paused consumer");
      }
    }
    assert.equal(sawContent, false); assert.equal(sawPrivateProgress, true); assert.equal(receipts, 1); assert.equal(held!.retire(), false);
  }
  assert.equal(retirements, 4);
});

test("foreground hosts retain private receipt before a rejecting external observer", async () => {
  for (const host of ["session", "agent"] as const) {
    let held: import("../../src/shared/llm/client.ts").ResponseReceipt | undefined;
    serve(async () => responseSseResponse({ id: "observer-rejected", content: "not delivered" }));
    const adapter = createProviderAdapter({ provider: { id: "receipt-observer-host", baseUrl: address("https://native.invalid/v1"), timeoutMs: 2000,
      retries: { maxRetries: 2, initialBackoffMs: 1, maxBackoffMs: 1, backoffMultiplier: 1 } }, apiKey: "synthetic-observer-host-key" });
    const onResponseReceipt = (receipt: import("../../src/shared/llm/client.ts").ResponseReceipt) => { held = receipt; throw new LLMError("observer rejected", "llm_network_error", "network", true); };
    const f = fixture(adapter, { onResponseReceipt });
    if (host === "session") await drain(f.session.runTurn());
    else await drain(agent(adapter, f.registry, { onResponseReceipt }).run("Act"));
    assert.ok(held); assert.equal(held.retire(), false, "host must retain and retire the handle despite external observer failure");
  }
});

test("Real adapter and ResponseTurn preserve one immutable envelope under configured bounds", async () => {
  const { ResponseTurn } = await import("../../src/runtime/response-turn.ts");
  const { responseEvents } = await import("../support/mock-provider.ts");
  // The operation's key is at the held floor (a2b-design H1: a shorter one is replaced where it was given, never searched for in text).
  const key = "a7held";
  const events = responseEvents({ content: `copied ${key} value` });
  let deep: Record<string, unknown> = {}; for (let i = 0; i < 52; i++) deep = { nested: deep };
  (events.at(-1) as { response: Record<string, unknown> }).response.extension = deep;
  serve(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "x-request-id": `copied-${key}-value` } }));
  const adapter = createProviderAdapter({ provider: { id: "safe-envelope", baseUrl: address("https://native.invalid/v1"), timeoutMs: 2000,
    responses: { maximumDepth: 64 }, retries: { maxRetries: 0, initialBackoffMs: 1, maxBackoffMs: 1, backoffMultiplier: 1 } }, apiKey: key });
  const turn = new ResponseTurn(); let accepted: unknown, chunkView: unknown, terminal: unknown;
  for await (const event of adapter.streamChatCompletion({ model: "test-model", messages: [{ role: "user", content: "witness" }] }, { onResponseEvidence(evidence) { accepted = evidence.observation; } })) {
    if (event.type === "response") chunkView = event.observation;
    await turn.accept(event, metadata => { terminal = metadata.observation; });
  }
  const result = turn.complete(); assert.ok(accepted); assert.equal(accepted, chunkView); assert.equal(chunkView, terminal); assert.equal(terminal, result.observation);
  assert.equal(Object.isFrozen(result.observation), true); assert.equal(JSON.stringify(result.observation).includes(key), false);
  // The private projection stays exact EXCEPT for the operation's own held key: no path of a run carries it (SECC-V-A3).
  assert.equal(result.content, "copied [REDACTED:secret] value", "private recovery projection is exact but for the held key");
});

test("Failed native terminal preserves omitted partial history before observation and retirement", async t => {
  const { responseEvents } = await import("../support/mock-provider.ts");
  const { ResponsesTracker } = await import("../../src/shared/llm/responses-tracking.ts");
  const originalRetire = ResponsesTracker.prototype.retire;
  let history: () => readonly import("../../src/runtime/provider-adapter.ts").ChatMessage[] = () => [];
  const assertPrivateHistory = () => {
    const assistant = history().findLast(message => message.role === "assistant");
    assert.equal(assistant?.content, "partial evidence"); assert.equal(assistant?.responseReplayBlocked, true);
    assert.equal(assistant?.responseItems?.length, 1); assert.equal(assistant?.responseItems?.[0]?.type, "function_call");
  };
  t.mock.method(ResponsesTracker.prototype, "retire", function(this: InstanceType<typeof ResponsesTracker>, id: string, provider?: string) { assertPrivateHistory(); return originalRetire.call(this, id, provider); });
  for (const host of ["session", "agent"] as const) {
    const output = [call(), { type: "message", id: "partial-message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "partial evidence", annotations: [] }] }];
    const all = responseEvents({ output }), partial = all.slice(0, all.findIndex(event => event.type === "response.output_text.delta") + 1);
    const failed = responseResource({ status: "failed", output: [output[0]!] }); failed.error = { code: "server_error", message: "failed" };
    const wire = [...partial, { type: "response.failed", sequence_number: partial.length, response: failed }];
    let requests = 0, observations = 0;
    serve(async () => { requests++; return new Response(wire.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }); });
    const adapter = createProviderAdapter({ provider: { id: "failed-private", baseUrl: address("https://native.invalid/v1"), timeoutMs: 2000,
      retries: { maxRetries: 0, initialBackoffMs: 1, maxBackoffMs: 1, backoffMultiplier: 1 } }, apiKey: "synthetic-private-history-key" });
    const onResponse = () => { observations++; assertPrivateHistory(); };
    const f = fixture(adapter, { onResponse }), runtime = agent(adapter, f.registry, { onResponse });
    history = host === "session" ? () => f.session.messages() : () => runtime.messages();
    const events: { type: string }[] = []; for await (const event of host === "session" ? f.session.runTurn() : runtime.run("Act")) events.push(event);
    assertPrivateHistory(); assert.equal(observations, 1); assert.equal(requests, 1); assert.equal(f.effects(), 0);
    assert.equal(events.some(event => event.type === "tool_result" || event.type === "tool_call_done"), false);
  }
});

test("ResponseTurn.stream records failure evidence before a throwing observer and retires its receipt through one owner", async () => {
  const { ResponseTurn } = await import("../../src/runtime/response-turn.ts");
  const order: string[] = [];
  let retirements = 0;
  const receipt = { responseId: "resp_turn", providerId: "stub", requestedModel: undefined, retire: () => { retirements++; return true; } };
  const adapter: Pick<ProviderAdapter, "streamChatCompletion"> = {
    async *streamChatCompletion(_request, invocation) {
      await invocation?.onResponseReceipt?.(receipt, new AbortController().signal);
      yield nativeResponseEvent(parseResponseResource(responseResource({ content: "partial" })), "completed");
    },
  };
  const turn = new ResponseTurn();
  const observer = new Error("observer refused");
  const received: unknown[] = [];
  await assert.rejects(async () => {
    for await (const _event of turn.stream(adapter, { model: "m", messages: [] }, {
      onResponseReceipt: (value) => { received.push(value); },
      onFailureEvidence: () => { order.push("evidence"); },
      onResponse: () => { order.push("observer"); throw observer; },
    })) { /* drain */ }
  }, (error) => error === observer);
  assert.deepEqual(order, ["evidence", "observer"], "failure evidence is captured before the native observer runs");
  assert.deepEqual(received, [receipt]);
  turn.retireReceipt();
  assert.equal(retirements, 1);
  assert.equal(turn.hasEvidence, true);
});
