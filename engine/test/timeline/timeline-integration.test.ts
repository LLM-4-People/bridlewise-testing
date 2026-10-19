import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createExecutionClosure } from "../../src/kernel/execution-closure.ts";
import { createInteractiveSession, type InteractiveSession, type SessionEvent, type TurnResult } from "../../src/runtime/interactive-session.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder, type TimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import type { ChatStreamEvent, ProviderAdapter, ChatCompletionRequest } from "../../src/runtime/provider-adapter.ts";
import { makeNativeMockAdapter as makeMockAdapter } from "../support/mock-provider.ts";
import { mkOwnedTempDir, mkTempDir } from "../support/temp-dir.ts";

const TEMP_ROOT = mkOwnedTempDir("tl-int-test-");
writeFileSync(join(TEMP_ROOT, "test.txt"), "test content");

function contentEvents(...texts: string[]): ChatStreamEvent[] {
  return texts.map((text) => Object.freeze({ type: "content" as const, text }));
}

function usageEvent(prompt: number, completion: number): ChatStreamEvent {
  return Object.freeze({ type: "usage" as const, usage: Object.freeze({ promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion }) });
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

function createSessionWithTimeline(dir: string, adapter: ProviderAdapter, correlation?: { runId: string; agentId?: string }): { session: InteractiveSession; recorder: TimelineRecorder } {
  const store = createTimelineStore({ path: join(dir, `int-${Date.now()}-${Math.random().toString(36).slice(2)}.db`), ledgerId: "session-ledger" });
  const recorder = createTimelineRecorder({ store, ...(correlation !== undefined ? { correlation } : {}) });
  const session = createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "You are helpful.",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry,
    repositoryRoot: TEMP_ROOT,
    timeline: recorder,
    ...(correlation !== undefined ? { correlation } : {}),
  });
  return { session, recorder };
}

function createSessionWithClosure(adapter: ProviderAdapter): InteractiveSession {
  return createInteractiveSession({
    adapter,
    model: "test-model",
    systemPrompt: "You are helpful.",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry,
    repositoryRoot: TEMP_ROOT,
    closure: createExecutionClosure({ ledgerId: "test-closure" }),
  });
}

async function runTurn(session: InteractiveSession, signal?: AbortSignal): Promise<{ events: SessionEvent[]; result: TurnResult }> {
  const events: SessionEvent[] = [];
  const gen = session.runTurn(signal);
  let result = await gen.next();
  while (!result.done) {
    events.push(result.value);
    result = await gen.next(result.value);
  }
  return { events, result: result.value };
}

// ========== Session with timeline: basic recording ==========

test("timeline-integration: session with timeline records turn event", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const { session, recorder } = createSessionWithTimeline(dir, makeMockAdapter([...contentEvents("hello"), finishEvent("stop")]));
    session.addUserMessage("hi");
    await runTurn(session);
    const turns = recorder.query.byEventType("turn");
    assert.ok(turns.events.length >= 1);
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: session with timeline records token usage", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const { session, recorder } = createSessionWithTimeline(dir, makeMockAdapter([...contentEvents("hello"), usageEvent(10, 5), finishEvent("stop")]));
    session.addUserMessage("hi");
    await runTurn(session);
    const tokens = recorder.query.byEventType("token");
    assert.ok(tokens.events.length >= 1);
    assert.equal(tokens.events[0]!.documents[0]!.name, "usage");
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: session with timeline records provider intent and terminal", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const { session, recorder } = createSessionWithTimeline(dir, makeMockAdapter([...contentEvents("hello"), finishEvent("stop")]));
    session.addUserMessage("hi");
    await runTurn(session);
    const intents = recorder.store.query({ recordKind: "intent" });
    const terminals = recorder.store.query({ recordKind: "terminal" });
    assert.ok(intents.length >= 1);
    assert.ok(terminals.length >= 1);
    const providerIntents = intents.filter((i) => i.effectKind === "provider");
    assert.ok(providerIntents.length >= 1);
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: session with timeline records tool execution", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const events = [...toolCallEvents("tc-1", "read_file", JSON.stringify({ path: "test.txt" })), finishEvent("tool_calls"), ...contentEvents("done"), finishEvent("stop")];
    const { session, recorder } = createSessionWithTimeline(dir, makeMockAdapter(events));
    session.addUserMessage("read the file");
    await runTurn(session);
    const toolIntents = recorder.store.query({ recordKind: "intent" }).filter((i) => i.effectKind === "process");
    assert.ok(toolIntents.length >= 1);
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: timeline chain remains valid after a full turn", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const { session, recorder } = createSessionWithTimeline(dir, makeMockAdapter([...contentEvents("hello"), usageEvent(10, 5), finishEvent("stop")]));
    session.addUserMessage("hi");
    await runTurn(session);
    const result = recorder.verifyTimelineChain();
    assert.equal(result.valid, true);
    assert.ok(result.verifiedRecords > 0);
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: recorded events are queryable by runId", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const { session, recorder } = createSessionWithTimeline(dir, makeMockAdapter([...contentEvents("hello"), finishEvent("stop")]), { runId: "run-int-1" });
    session.addUserMessage("hi");
    await runTurn(session);
    const events = recorder.query.byRun("run-int-1");
    assert.ok(events.total > 0);
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: multiple turns create multiple turn events", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const { session, recorder } = createSessionWithTimeline(dir, makeMockAdapter([...contentEvents("hello"), finishEvent("stop")]));
    session.addUserMessage("first");
    await runTurn(session);
    session.addUserMessage("second");
    await runTurn(session);
    const turns = recorder.query.byEventType("turn");
    assert.equal(turns.events.length, 2);
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: failed provider call records failed terminal", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const failingAdapter = Object.freeze({
      providerId: "failing",
      async *streamChatCompletion(_request: ChatCompletionRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
        throw new Error("provider failed");
      },
      async chatCompletion(_request: ChatCompletionRequest) {
        throw new Error("provider failed");
      },
    });
    const { session, recorder } = createSessionWithTimeline(dir, failingAdapter);
    session.addUserMessage("hi");
    await runTurn(session);
    const terminals = recorder.store.query({ recordKind: "terminal" });
    const failed = terminals.filter((t) => t.outcome === "failed");
    assert.ok(failed.length >= 1);
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: session without timeline works (backward compatible)", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const session = createSessionWithClosure(makeMockAdapter([...contentEvents("hello"), finishEvent("stop")]));
    session.addUserMessage("hi");
    const { result } = await runTurn(session);
    assert.equal(result.content, "hello");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: session without any recorder works", async () => {
  const session = createInteractiveSession({
    adapter: makeMockAdapter([...contentEvents("hello"), finishEvent("stop")]),
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    temperature: 0,
    toolRegistry,
    repositoryRoot: TEMP_ROOT,
  });
  session.addUserMessage("hi");
  const { result } = await runTurn(session);
  assert.equal(result.content, "hello");
});

test("timeline-integration: every intent of a turn has its terminal in the ledger", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const { session, recorder } = createSessionWithTimeline(dir, makeMockAdapter([...contentEvents("hello"), finishEvent("stop")]));
    session.addUserMessage("hi");
    await runTurn(session);
    assert.deepEqual(recorder.pendingEffects(), []);
    assert.ok(recorder.store.query({ recordKind: "intent" }).length > 0, "the turn recorded paired effects");
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: durable timeline survives close and reopen", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const dbPath = join(dir, "session.db");
    const store = createTimelineStore({ path: dbPath, ledgerId: "session-ledger" });
    const recorder = createTimelineRecorder({ store, correlation: { runId: "run-1" } });
    const session = createInteractiveSession({
      adapter: makeMockAdapter([...contentEvents("hello"), usageEvent(10, 5), finishEvent("stop")]),
      model: "test-model", systemPrompt: "", maxTokens: 4096, temperature: 0,
      toolRegistry, repositoryRoot: TEMP_ROOT, timeline: recorder,
    });
    session.addUserMessage("hi");
    await runTurn(session);
    const eventCount = store.count();
    recorder.close();
    // Reopen
    const store2 = createTimelineStore({ path: dbPath, ledgerId: "session-ledger" });
    assert.equal(store2.count(), eventCount);
    const result = store2.verifyChain();
    assert.equal(result.valid, true);
    store2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: token usage accumulates across turns", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const { session, recorder } = createSessionWithTimeline(dir, makeMockAdapter([...contentEvents("hello"), usageEvent(10, 5), finishEvent("stop")]));
    session.addUserMessage("first");
    await runTurn(session);
    session.addUserMessage("second");
    await runTurn(session);
    const tokenEvents = recorder.query.byEventType("token");
    assert.equal(tokenEvents.events.length, 2);
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: cancellation records cancelled terminal", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const slowAdapter = Object.freeze({
      providerId: "slow",
      async *streamChatCompletion(_request: ChatCompletionRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
        yield { type: "content", text: "partial" };
        throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      },
      async chatCompletion(_request: ChatCompletionRequest) {
        return Object.freeze({ content: "partial", toolCalls: [], usage: undefined, finishReason: "stop" });
      },
    });
    const { session, recorder } = createSessionWithTimeline(dir, slowAdapter);
    session.addUserMessage("hi");
    const controller = new AbortController();
    controller.abort();
    try { await runTurn(session, controller.signal); } catch { /* expected */ }
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: summary shows all event types", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const { session, recorder } = createSessionWithTimeline(dir, makeMockAdapter([...contentEvents("hello"), usageEvent(10, 5), finishEvent("stop")]), { runId: "run-summary" });
    session.addUserMessage("hi");
    await runTurn(session);
    const summary = recorder.query.summary({ runId: "run-summary" });
    assert.ok(summary.totalEvents > 0);
    assert.ok(summary.byType["turn"] !== undefined);
    assert.ok(summary.byType["token"] !== undefined);
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: tool results are recorded as terminal", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const events = [...toolCallEvents("tc-1", "read_file", JSON.stringify({ path: "test.txt" })), finishEvent("tool_calls"), ...contentEvents("done"), finishEvent("stop")];
    const { session, recorder } = createSessionWithTimeline(dir, makeMockAdapter(events));
    session.addUserMessage("read");
    await runTurn(session);
    const terminals = recorder.store.query({ recordKind: "terminal" });
    const toolTerminals = terminals.filter((t) => t.effectId?.startsWith("tool-"));
    assert.ok(toolTerminals.length >= 1);
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: provider terminal has correct event type", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const { session, recorder } = createSessionWithTimeline(dir, makeMockAdapter([...contentEvents("hello"), finishEvent("stop")]));
    session.addUserMessage("hi");
    await runTurn(session);
    const terminals = recorder.store.query({ recordKind: "terminal" });
    const providerTerminals = terminals.filter((t) => t.eventType === "provider");
    assert.ok(providerTerminals.length >= 1);
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-integration: no operation occurs without recording", async () => {
  const dir = mkTempDir("tl-int-");
  try {
    const { session, recorder } = createSessionWithTimeline(dir, makeMockAdapter([...contentEvents("hello"), finishEvent("stop")]));
    session.addUserMessage("hi");
    await runTurn(session);
    // Every event in the timeline should be part of a valid chain
    const chainResult = recorder.verifyTimelineChain();
    assert.equal(chainResult.valid, true);
    // Every intent has a terminal in the ledger.
    assert.deepEqual(recorder.pendingEffects(), []);
    recorder.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
