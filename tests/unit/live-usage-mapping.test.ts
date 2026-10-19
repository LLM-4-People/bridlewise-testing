// @vitest-environment node
/**
 * THE LIVE PATH MAPS THE SAME FRAMES THE HISTORY PATH MAPS.
 *
 * The defect: a turn with tool calls streams its `usage` frame AFTER the
 * tool messages exist, so the literal last message is a tool card — and a
 * role guard inside `updateLastMessage` made the whole update a silent
 * no-op. The stream DELIVERED the usage; the footer said "tokens not
 * measured"; a refresh (the history path, which maps by row) showed the
 * same turn's real numbers. Same silent-no-op shape for `finish` metrics,
 * the `metadata` frame, reasoning after a tool call, and a TTFT stamped
 * onto a tool card.
 *
 * Driven through `openRunStream` — the real entry point — never by calling
 * the ingestion directly: a guard that drove the unit would prove the
 * walk-back exists and say nothing about whether the stream reaches it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SSE_EVENT_TYPES } from "../../shared/constants.ts";
import { hydrateChatFromHistory, openRunStream } from "../../src/client";
import { clearMessages, messages } from "../../src/state/chat-messages";
import { currentChatId } from "../../src/state/chats";
import { wholeConversationPage } from "../helpers/history-page.ts";

class MockEventSource {
  static lastInstance: MockEventSource | null = null;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  readyState = 1;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    MockEventSource.lastInstance = this;
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  close(): void {
    this.readyState = 2;
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

const originalEventSource = globalThis.EventSource;

const USAGE = {
  inputTokens: 1200,
  outputTokens: 340,
  totalTokens: 1540,
  reasoningTokens: 25,
};

beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource =
    MockEventSource as unknown as typeof EventSource;
  MockEventSource.lastInstance = null;
  clearMessages();
  currentChatId.set("chat-A");
});

afterEach(() => {
  globalThis.EventSource = originalEventSource;
  currentChatId.set(null);
  clearMessages();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Stream one whole turn that ends with a tool call, then its accounting. */
function driveToolTurn(): MockEventSource {
  openRunStream("run-1", {});
  const es = MockEventSource.lastInstance!;
  es.emit(SSE_EVENT_TYPES.connected, { runId: "run-1", harnessReady: false, chatId: "chat-A" });
  es.emit(SSE_EVENT_TYPES.model, { type: "start" });
  es.emit(SSE_EVENT_TYPES.model, { type: "text_delta", delta: "let me check" });
  es.emit(SSE_EVENT_TYPES.model, {
    type: "tool_call_start",
    callId: "call-1",
    name: "read_file",
  });
  // The provider's accounting arrives AFTER the tool card exists — the
  // exact ordering that used to drop it.
  es.emit(SSE_EVENT_TYPES.model, { type: "usage", usage: USAGE });
  es.emit(SSE_EVENT_TYPES.model, { type: "finish", reason: "tool_calls" });
  return es;
}

function lastAssistant() {
  const list = messages.get();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]!.role === "assistant") return list[i]!;
  }
  throw new Error("no assistant message in the transcript");
}

describe("live frames land on the assistant turn, wherever it sits", () => {
  test("usage after a tool call reaches the assistant message — the footer has real tokens during the run", () => {
    driveToolTurn();
    const list = messages.get();
    // The fixture must keep the condition possible: the literal last
    // message IS a tool card, or this proves nothing.
    expect(list[list.length - 1]!.role).toBe("tool");
    const turn = lastAssistant();
    expect(turn.tokenMetrics).toMatchObject({
      inputTokens: USAGE.inputTokens,
      outputTokens: USAGE.outputTokens,
      totalTokens: USAGE.totalTokens,
      reasoningTokens: USAGE.reasoningTokens,
    });
    // …and nothing was misfiled onto the tool card.
    expect(list[list.length - 1]!.tokenMetrics).toBeUndefined();
  });

  test("finish metrics and reason land on the assistant turn, not the tool card", () => {
    driveToolTurn();
    const turn = lastAssistant();
    expect(turn.finishReason).toBe("tool_calls");
    expect(turn.timingMetrics?.totalMs).toBeGreaterThanOrEqual(0);
    const list = messages.get();
    expect(list[list.length - 1]!.finishReason).toBeUndefined();
  });

  test("the metadata frame (model, headers, trace id) lands on the assistant turn after a tool call", () => {
    openRunStream("run-1", {});
    const es = MockEventSource.lastInstance!;
    es.emit(SSE_EVENT_TYPES.connected, { runId: "run-1", harnessReady: false, chatId: "chat-A" });
    es.emit(SSE_EVENT_TYPES.model, { type: "start" });
    es.emit(SSE_EVENT_TYPES.model, { type: "tool_call_start", callId: "c1", name: "read_file" });
    es.emit(SSE_EVENT_TYPES.metadata, {
      runId: "run-1",
      model: "qwen3.6-35b-fast",
      headers: { "x-request-id": "abc" },
      traceId: "trace-7777aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    const turn = lastAssistant();
    expect(turn.responseModel).toBe("qwen3.6-35b-fast");
    expect(turn.responseHeaders).toEqual({ "x-request-id": "abc" });
    // The request's trace id rides the same frame — the address every
    // ledger event of the request is reachable by. Dropped here, the run
    // pane would never show it and the incident would have no handle.
    expect(turn.traceId).toBe("trace-7777aaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const list = messages.get();
    expect(list[list.length - 1]!.responseModel).toBeUndefined();
    expect(list[list.length - 1]!.traceId).toBeUndefined();
  });

  test("a metadata frame without a trace id leaves the field untouched, never blanked", () => {
    openRunStream("run-1", {});
    const es = MockEventSource.lastInstance!;
    es.emit(SSE_EVENT_TYPES.connected, { runId: "run-1", harnessReady: false, chatId: "chat-A" });
    es.emit(SSE_EVENT_TYPES.model, { type: "start" });
    es.emit(SSE_EVENT_TYPES.metadata, {
      runId: "run-1",
      model: "qwen3.6-35b-fast",
      traceId: "trace-7777aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    es.emit(SSE_EVENT_TYPES.metadata, {
      runId: "run-1",
      model: "qwen3.6-35b-fast",
    });
    // Absence is preserved — a frame without the id must not erase the
    // one an earlier frame of the same run delivered.
    expect(lastAssistant().traceId).toBe("trace-7777aaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  test("reasoning streamed after a tool call accumulates on the assistant turn", () => {
    openRunStream("run-1", {});
    const es = MockEventSource.lastInstance!;
    es.emit(SSE_EVENT_TYPES.connected, { runId: "run-1", harnessReady: false, chatId: "chat-A" });
    es.emit(SSE_EVENT_TYPES.model, { type: "start" });
    es.emit(SSE_EVENT_TYPES.model, { type: "tool_call_start", callId: "c1", name: "read_file" });
    es.emit(SSE_EVENT_TYPES.model, { type: "reasoning_delta", delta: "thinking " });
    es.emit(SSE_EVENT_TYPES.model, { type: "reasoning_delta", delta: "more" });
    expect(lastAssistant().reasoning).toBe("thinking more");
    const list = messages.get();
    expect(list[list.length - 1]!.reasoning).toBeUndefined();
  });
});

describe("the two paths agree", () => {
  test("the history path maps the same usage the live path now keeps", () => {
    driveToolTurn();
    const live = lastAssistant();

    clearMessages();
    const hydrated = hydrateChatFromHistory({
      chat: {
        id: "chat-A",
        projectId: "p1",
        title: "t",
        createdAt: "2026-07-30T10:00:00Z",
        updatedAt: "2026-07-30T10:00:00Z",
        modelId: null,
        pinned: false,
      },
      messages: [
        {
          id: "m1",
          chatId: "chat-A",
          runId: "run-1",
          role: "assistant",
          content: "let me check",
          createdAt: "2026-07-30T10:00:01Z",
          metadata: { tokenMetrics: USAGE, finishReason: "tool_calls" },
        },
      ],
      toolCalls: [],
      metricsSnapshots: [],
      timelineRefs: [],
      page: wholeConversationPage(1),
    } as never);
    const fromHistory = hydrated.find((m) => m.role === "assistant")!;
    // One turn, two doors, one answer.
    expect(fromHistory.tokenMetrics).toEqual(live.tokenMetrics);
    expect(fromHistory.finishReason).toBe(live.finishReason);
  });
});

describe("tok/s is stamped when usage lands, even after finish", () => {
  test("usage after finish writes tps onto the assistant turn", () => {
    // THIS PROVIDER SENDS usage AFTER finish. The finish handler has no
    // token counts yet; the rate must be written on the usage frame so a
    // refresh still has the number the live footer showed.
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    openRunStream("run-1", {});
    const es = MockEventSource.lastInstance!;
    es.emit(SSE_EVENT_TYPES.connected, { runId: "run-1", harnessReady: false, chatId: "chat-A" });
    es.emit(SSE_EVENT_TYPES.model, { type: "start" });
    vi.setSystemTime(1_200);
    es.emit(SSE_EVENT_TYPES.model, { type: "text_delta", delta: "hello" });
    vi.setSystemTime(2_200);
    es.emit(SSE_EVENT_TYPES.model, { type: "finish", reason: "stop" });
    expect(lastAssistant().timingMetrics?.tps).toBeUndefined();
    es.emit(SSE_EVENT_TYPES.model, { type: "usage", usage: USAGE });
    // 340 tokens over 1000ms from the first answer token.
    expect(lastAssistant().timingMetrics?.tps).toBe(340);
  });

  test("thinking starts the producing window, not the first answer word", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    openRunStream("run-1", {});
    const es = MockEventSource.lastInstance!;
    es.emit(SSE_EVENT_TYPES.connected, { runId: "run-1", harnessReady: false, chatId: "chat-A" });
    es.emit(SSE_EVENT_TYPES.model, { type: "start" });
    vi.setSystemTime(1_100);
    es.emit(SSE_EVENT_TYPES.model, { type: "reasoning_delta", delta: "hmm" });
    vi.setSystemTime(2_100);
    es.emit(SSE_EVENT_TYPES.model, { type: "text_delta", delta: "hi" });
    vi.setSystemTime(3_100);
    es.emit(SSE_EVENT_TYPES.model, { type: "finish", reason: "stop" });
    es.emit(SSE_EVENT_TYPES.model, { type: "usage", usage: USAGE });
    // 340 tokens over 2000ms from the first thinking token, not 1000ms
    // from the first answer word (which would print 340 tok/s).
    expect(lastAssistant().timingMetrics?.tps).toBe(170);
  });
});
