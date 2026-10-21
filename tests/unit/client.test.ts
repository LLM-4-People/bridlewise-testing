// @vitest-environment node
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import {
  ClientError,
  ClientTimeoutError,
  listProjects,
  startRun,
  openRunStream,
  beginChatRun,
  cancelRun,
  diagnoseLivenessConnection,
  getGitStatus,
  getMetrics,
  steerCurrentRun,
  loadChatHistory,
  hydrateChatFromHistory,
  type ChatHistoryPageView,
  type StreamHandlers,
} from "../../src/client";
import {
  resetMetrics,
  setSystemMetrics,
  setTokenThroughput,
  systemMetrics,
  tokenThroughput,
} from "../../src/state/metrics";
import {
  API_IDENTITY_HEADER,
  API_IDENTITY_VALUE,
  LIVE_STREAM_PATH,
  LIVE_STREAM_REFUSED_RETRY_MS,
} from "../../shared/constants.ts";
import { HYDRATED_TOOL_CALL_RECONCILE_MAX_MS, HYDRATED_TOOL_CALL_RECONCILE_POLL_MS, RUN_STATUS_CLEAR_DELAY_MS } from "../../src/client-config";
import { wholeConversationPage } from "../helpers/history-page.ts";
import { currentRun, isRunActive, queuedSteers, setRun } from "../../src/state/run-state";
import { messages, clearMessages, streamingTail, commitStreamingTail, isStreaming, setStreaming, type ChatMessage } from "../../src/state/chat-messages";
import { currentChatId } from "../../src/state/chats";
import { clearErrors, errors } from "../../src/state/errors";
import { onInvalidation } from "../../src/data/broker.ts";
import { gitRefusal, gitStatus, resetGitStatus, setGitStatus } from "../../src/state/git";
import { dedupSnapshot } from "../../src/state/dedup";
import { redactionNotice } from "../../src/state/redaction";
import { formatErrorMessage } from "../../src/data/error-messages";

// ── Mock EventSource ──

type EventSourceListener = (e: { data: string }) => void;

class MockEventSource {
  static lastInstance: MockEventSource | null = null;
  // The real EventSource's static state constants — without them the
  // listener's `readyState === EventSource.CLOSED` check compared against
  // `undefined` and this harness could never exercise the stream-closed
  // branch (the mock's `emitError` set readyState 2 while the branch
  // comparing it was dead, so the closed-transport tests silently ran the
  // reconnecting branch instead).
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readyState = 0; // 0=connecting, 1=open, 2=closed
  private listeners = new Map<string, Set<EventSourceListener>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.lastInstance = this;
  }

  addEventListener(eventName: string, handler: EventSourceListener): void {
    if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Set());
    this.listeners.get(eventName)!.add(handler);
  }

  removeEventListener(eventName: string, handler: EventSourceListener): void {
    this.listeners.get(eventName)?.delete(handler);
  }

  /** Test helper: dispatch an SSE event to all registered listeners. */
  emit(eventName: string, data: unknown): void {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    const handlers = this.listeners.get(eventName);
    if (!handlers) return;
    for (const h of handlers) h({ data: payload });
  }

  /** Test helper: simulate an error event on a CLOSED transport. */
  emitError(): void {
    this.readyState = MockEventSource.CLOSED;
    const handlers = this.listeners.get("error");
    if (!handlers) return;
    for (const h of handlers) h({ data: "" });
  }

  /** Test helper: simulate an error event on a still-CONNECTING transport —
   * the real EventSource's auto-reconnect shape (readyState stays
   * CONNECTING, the event carries no frame payload). */
  emitTransientError(): void {
    this.readyState = MockEventSource.CONNECTING;
    const handlers = this.listeners.get("error");
    if (!handlers) return;
    for (const h of handlers) h({ data: "" });
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }
}

// ── Mock setup / teardown ──

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.lastInstance = null;
  clearMessages();
  clearErrors();
  currentRun.set(null);
  resetGitStatus();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  vi.restoreAllMocks();
});

function mockFetchOnce(response: {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: response.json ?? (async () => undefined),
  } as Response);
}

describe("client: replay and history share one transcript", () => {
  function history(finished = true): ChatHistoryPageView {
    return {
      chat: { id: "replay-chat", projectId: "p1", title: "replay", createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:01Z", modelId: null, pinned: false },
      messages: ["response-a", "response-b"].flatMap((id) => [
        { id, chatId: "replay-chat", role: "assistant" as const, content: finished ? "same words" : "", createdAt: "2026-09-05T00:00:00Z", modelEventType: finished ? "finish" : "start", runId: "replay-run", metadata: finished ? { finishReason: "tool_calls" } : null },
        { id: `tool-${id}`, chatId: "replay-chat", role: "tool" as const, content: "", createdAt: "2026-09-05T00:00:01Z", modelEventType: null, runId: "replay-run", metadata: null },
      ]),
      toolCalls: ["response-a", "response-b"].map((id) => ({ id: `db-call-${id}`, messageId: `tool-${id}`, callId: `provider-${id}`, toolName: "slice", input: { path: "recorded.ts" }, output: finished ? "recorded result" : null, status: finished ? "done" as const : "running" as const, durationMs: finished ? 2 : null, attemptCount: 1, createdAt: "2026-09-05T00:00:01Z" })),
      timelineRefs: [], metricsSnapshots: [], page: wholeConversationPage(4),
    };
  }

  function frames(id: string): unknown[] {
    return [
      { type: "start", responseId: `native-${id}` },
      { type: "reasoning_delta", outputIndex: 0, delta: "thinking" },
      { type: "text_delta", outputIndex: 0, delta: "same " },
      { type: "tool_call_start", outputIndex: 0, callId: `provider-${id}`, name: "slice", messageId: `tool-${id}` },
      { type: "tool_call_delta", outputIndex: 0, callId: `provider-${id}`, argumentsDelta: "{\"path\":\"raw.ts\"}" },
      { type: "text_delta", outputIndex: 0, delta: "words" },
      { type: "tool_call_done", outputIndex: 0, callId: `provider-${id}`, arguments: { path: "raw.ts" } },
      { type: "finish", reason: "tool_calls" },
      { type: "usage", usage: { inputTokens: id === "response-a" ? 11 : 29, outputTokens: 3, totalTokens: id === "response-a" ? 14 : 32 } },
    ].map((frame, sequence) => ({ ...frame, sequence, protocol: "openai-responses", assistantMessageId: id }));
  }

  function attach(onModelEvent?: StreamHandlers["onModelEvent"]): MockEventSource {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    currentChatId.set("replay-chat");
    openRunStream("replay-run", onModelEvent === undefined ? {} : { onModelEvent });
    const source = MockEventSource.lastInstance!;
    source.emit("connected", { runId: "replay-run", chatId: "replay-chat", harnessReady: true });
    return source;
  }

  test.each([-1, 0, 2, 4, 6])("history at replay boundary %i preserves canonical rows, text and dispatched tool input", (hydrateAfter) => {
    const appliedFrames: { type: string; applied: boolean | undefined }[] = [];
    const source = attach((event, applied) => appliedFrames.push({ type: event.type, applied }));
    const events = [...frames("response-a"), ...frames("response-b")];
    if (hydrateAfter === -1) hydrateChatFromHistory(history());
    events.forEach((event, index) => {
      source.emit("model", event);
      if (index === hydrateAfter) hydrateChatFromHistory(history());
      const ids = messages.get().map((message) => message.id);
      expect(new Set(ids).size, "no duplicate canonical message at any replay boundary").toBe(ids.length);
    });
    expect(appliedFrames).toHaveLength(events.length);
    if (hydrateAfter === -1) expect(appliedFrames.filter((frame) => frame.type === "tool_call_delta").every((frame) => frame.applied === false), "saved tool-argument replay cannot advance output clocks").toBe(true);
    expect(appliedFrames.filter((frame) => !frame.applied).some((frame) => frame.type === "finish"), "the clock consumer learns which actual receipts were rejected replay").toBe(true);
    expect(messages.get().map((message) => [message.id, message.content])).toEqual([
      ["response-a", "same words"], ["tool-response-a", ""], ["response-b", "same words"], ["tool-response-b", ""],
    ]);
    expect(messages.get().filter((message) => message.role === "tool").map((message) => message.toolCall)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "provider-response-a", status: "done", input: { path: "recorded.ts" } }),
      expect.objectContaining({ id: "provider-response-b", status: "done", input: { path: "recorded.ts" } }),
    ]));
    expect(messages.get().filter((message) => message.role === "assistant").map((message) => message.tokenMetrics?.inputTokens), "replayed usage addresses its own earlier assistant row").toEqual([11, 29]);
    source.close();
    const reopened = attach();
    events.forEach((event) => reopened.emit("model", event));
    expect(messages.get().filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["same words", "same words"]);
    reopened.close();
    clearMessages();
    hydrateChatFromHistory(history());
    expect(messages.get()).toHaveLength(4);
  });

  test("partial replay and interleaved stale history preserve tokens through automatic reconnect and fresh attachment", () => {
    const source = attach();
    const events = frames("response-a");
    events.slice(0, 3).forEach((event) => source.emit("model", event));
    expect(streamingTail.get()).toBe("same ");
    source.emitTransientError();
    events.slice(0, 3).forEach((event) => source.emit("model", event));
    expect(streamingTail.get(), "same source redelivery adds no partial text").toBe("same ");
    const saved = history(false);
    hydrateChatFromHistory({ ...saved, messages: saved.messages.slice(0, 1), toolCalls: [] });
    expect(messages.get()[0]?.content, "stale empty history retains received prefix").toBe("same ");
    source.close();
    const reopened = attach();
    events.forEach((event) => reopened.emit("model", event));
    expect(messages.get().map((message) => message.id)).toEqual(["response-a", "tool-response-a"]);
    expect(messages.get()[0]).toMatchObject({ content: "same words", reasoning: "thinking", finishReason: "tool_calls" });
    expect(streamingTail.get()).toBe("");
    reopened.close();
  });

  test.each([-1, 0, 3, 8])("an empty-clock replay keeps recorded timing with history at boundary %i", (hydrateAfter) => {
    let now = 50_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 100));
    const recordedTiming = { startedAt: 1_000, firstTokenAt: 1_400, finishedAt: 2_900, ttftMs: 400, totalMs: 1_900, tps: 17.3 };
    const page = history();
    const recorded = { ...page, messages: page.messages.map((message) => message.role === "assistant"
      ? { ...message, metadata: { finishReason: "tool_calls", timingMetrics: recordedTiming } }
      : message) };
    const receipts: boolean[] = [];
    const source = attach((_event, _applied, replayed) => receipts.push(replayed === true));
    // Another fresh turn leaves real local metrics in the existing client
    // clock. Replayed usage for an earlier saved row cannot borrow them.
    frames("response-later").forEach((event) => source.emit("model", event));
    expect(messages.get().find((message) => message.id === "response-later")?.timingMetrics?.tps,
      "the live comparison turn really measured output").toBeGreaterThan(0);
    receipts.length = 0;
    if (hydrateAfter === -1) hydrateChatFromHistory(recorded);
    const events = frames("response-a");
    events.forEach((event, index) => {
      source.emit("model", { ...(event as object), replayed: true });
      if (index === hydrateAfter) hydrateChatFromHistory(recorded);
      if (index < hydrateAfter) expect(messages.get().find((message) => message.id === "response-a")?.timingMetrics,
        "retained frames cannot fabricate receipt-time metrics before history arrives").toBeUndefined();
    });
    expect(receipts, "every model receipt carries its factual replay provenance to the clock consumer").toEqual(events.map(() => true));
    expect(messages.get().find((message) => message.id === "response-a")?.timingMetrics,
      "history timing remains authoritative even when later replayed usage arrives").toEqual(recordedTiming);
    source.close();
    clock.mockRestore();
  });
});

describe("client: fetchJson error handling", () => {
  test("non-2xx response throws ClientError with statusCode", async () => {
    mockFetchOnce({
      ok: false,
      status: 500,
      json: async () => ({ message: "internal boom" }),
    });
    await expect(listProjects()).rejects.toMatchObject({
      name: "ClientError",
      code: "http_500",
      statusCode: 500,
      message: "internal boom",
    });
  });

  test("non-2xx without JSON body falls back to HTTP status message", async () => {
    mockFetchOnce({
      ok: false,
      status: 503,
      json: async () => { throw new Error("no body"); },
    });
    await expect(listProjects()).rejects.toMatchObject({
      name: "ClientError",
      code: "http_503",
      statusCode: 503,
    });
  });

  test("network error (fetch rejects) throws ClientError with code 'network'", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(listProjects()).rejects.toMatchObject({
      name: "ClientError",
      code: "network",
    });
  });

  test("timeout (AbortError) throws ClientTimeoutError", async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        // Simulate abort after the signal fires.
        init?.signal?.addEventListener("abort", () => {
          const err = new DOMException("aborted", "AbortError");
          reject(err);
        });
      });
    });
    // Use a very short timeout to trigger it quickly.
    // We call a method that uses fetchJson with a tiny timeoutMs.
    // listProjects doesn't accept timeoutMs, so we test via startRun
    // which also uses fetchJson. We'll use a direct approach:
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    // fetchJson is internal; we test timeout via the abort path.
    // Use a custom fetch that rejects with AbortError directly.
    globalThis.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" }) as unknown as DOMException,
    );
    // Patch the DOMException check: the client checks `err instanceof DOMException`.
    // In node, DOMException exists. Let's make a proper one.
    const abortErr = new DOMException("aborted", "AbortError");
    globalThis.fetch = vi.fn().mockRejectedValue(abortErr);
    await expect(listProjects()).rejects.toBeInstanceOf(ClientTimeoutError);
  });
});

describe("client: the refused git read feeds the standing refusal state", () => {
  const REFUSAL_BODY = {
    refusal: {
      code: "git_not_run",
      message:
        "The working tree could not be read because this server would not run git: confinement is active. Choose a different project folder.",
      status: 503,
    },
  };

  test("a 200 refusal envelope rejects with the typed error AND feeds the per-path refusal store", async () => {
    mockFetchOnce({ ok: true, status: 200, json: async () => REFUSAL_BODY });
    await expect(getGitStatus("/self/protected")).rejects.toMatchObject({
      name: "ClientError",
      code: "git_not_run",
      statusCode: 503,
    });
    expect(gitRefusal.get()).toMatchObject({
      path: "/self/protected",
      reason: REFUSAL_BODY.refusal.message,
    });
  });

  test("a measured answer for the SAME path retires the standing refusal", async () => {
    setGitStatus(null);
    gitRefusal.set({ path: "/self/protected", reason: "refused before" });
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        branch: "main",
        dirtyFiles: 1,
        stagedFiles: 0,
        untrackedFiles: 0,
        entries: [],
      }),
    });
    await getGitStatus("/self/protected");
    expect(gitRefusal.get()).toBeNull();
    expect(gitStatus.get()).toMatchObject({ path: "/self/protected", dirtyFiles: 1 });
  });

  test("a measured answer for a DIFFERENT path leaves the refusal standing", async () => {
    gitRefusal.set({ path: "/self/protected", reason: "refused before" });
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        branch: "main",
        dirtyFiles: 0,
        stagedFiles: 0,
        untrackedFiles: 0,
        entries: [],
      }),
    });
    await getGitStatus("/other/project");
    // The other project's success is not this project's answer — the
    // refusal survives a project switch and reads as what it is.
    expect(gitRefusal.get()).toMatchObject({ path: "/self/protected" });
  });

  test("the typed not-a-repository fact rides the decode — the store learns what the surface needs to say 'not under version control'", async () => {
    // The pane's honest absence keys on this field; a decode that dropped it
    // would send every non-repo back to "detached · clean". Absent on the
    // wire reads as TRUE (an older server spoke only about real
    // repositories), and `false` must survive the decode verbatim.
    setGitStatus(null);
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        repository: false,
        branch: null,
        dirtyFiles: 0,
        stagedFiles: 0,
        untrackedFiles: 0,
        entries: [],
      }),
    });
    await getGitStatus("/plain/folder");
    expect(gitStatus.get()?.repository).toBe(false);

    setGitStatus(null);
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        branch: "main",
        dirtyFiles: 0,
        stagedFiles: 0,
        untrackedFiles: 0,
        entries: [],
      }),
    });
    await getGitStatus("/real/repo");
    expect(gitStatus.get()?.repository, "absent on the wire reads as a repository").toBe(true);
  });
});

describe("client: startRun + SSE", () => {
  test("startRun sets a run with status 'starting'", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-123" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    const run = currentRun.get();
    expect(run).not.toBeNull();
    expect(run!.runId).toBe("run-123");
    expect(run!.status).toBe("starting");
  });

  test("a start accepted after the reader switches chat cannot replace the foreground run", async () => {
    currentChatId.set("chat-pending-A");
    let accept!: (response: Response) => void;
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => { accept = resolve; }));
    const pending = startRun({ projectId: "project-A", chatId: "chat-pending-A", prompt: "A's request" });
    currentChatId.set("chat-pending-B");
    setRun({ runId: "run-B", status: "running", startedAt: Date.now(), modelLabel: null, projectId: "project-B" });
    accept({ ok: true, status: 201, json: async () => ({ runId: "run-A" }) } as Response);
    expect((await pending).runId).toBe("run-A");
    expect(currentRun.get()?.runId).toBe("run-B");
    expect(currentRun.get()?.status).toBe("running");
  });

  test("a TURN finish inside a live run does not settle the run view; the run's own done frame does", async () => {
    // The run VIEW tracks the RUN's lifetime, never the turn's: a run with
    // tool calls (or a steered drain) has several per-turn `finish` model
    // events before the terminal `done` frame. This test pins BOTH halves —
    // the turn boundary retires nothing, the run boundary settles + retires —
    // because the old shape (finish → done + clear) retired the view
    // mid-run: the pane said done, the stop verb vanished, and a mid-run
    // send routed fresh-start into the honest 428 instead of steering.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-finish-test" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    expect(currentRun.get()!.status).toBe("starting");

    openRunStream("run-finish-test", {});
    const es = MockEventSource.lastInstance!;
    // A turn opens: the view promotes to the real "running" state.
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });
    expect(currentRun.get()!.status, "the first turn start makes running a real state").toBe("running");
    // The turn finishes. THE RUN IS STILL LIVE.
    es.emit("model", { type: "finish", reason: "stop", sequence: 99, protocol: "openai-responses" });
    expect(currentRun.get()!.status, "a per-turn finish is the turn's boundary, never the run's").toBe("running");
    expect(isRunActive.get(), "the stop/steer liveness must survive every turn boundary").toBe(true);
    // A second turn opens (the tool-call drain shape) — still live.
    es.emit("model", { type: "start", sequence: 100, protocol: "openai-responses" });
    expect(currentRun.get()!.status).toBe("running");
    // THE RUN'S OWN TERMINAL FRAME settles the view.
    es.emit("done", { runId: "run-finish-test" });
    expect(currentRun.get()!.status, "the run-level done frame is the one settle").toBe("done");
  });

  test("the natural terminal frames (done / cancelled) tell the stream's second consumer the run settled (UIE-084)", async () => {
    // The done/cancelled listeners close the socket — a transport fact. The
    // sweep's stream state must hear it (onRunSettled) or a healthy run's
    // last transport face is whatever the epilogue's final event left it
    // wearing ("live", on a stream that no longer exists). A deliberate
    // stop is the same natural close: the feed ends with the run either way.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-settled-wire" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    const settled: string[] = [];
    openRunStream("run-settled-wire", {
      onRunSettled: () => settled.push("settled"),
    });
    const es = MockEventSource.lastInstance!;
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });
    expect(settled).toEqual([]);
    // A turn's finish is NOT a settle — only the run's own terminal frames are.
    es.emit("model", { type: "finish", reason: "stop", sequence: 1, protocol: "openai-responses" });
    expect(settled).toEqual([]);
    es.emit("done", { runId: "run-settled-wire" });
    expect(settled, "the done frame closes the stream for the second consumer too").toEqual(["settled"]);

    // The cancelled frame is the same natural close.
    const settled2: string[] = [];
    openRunStream("run-settled-wire", {
      onRunSettled: () => settled2.push("settled"),
    });
    const es2 = MockEventSource.lastInstance!;
    es2.emit("cancelled", { runId: "run-settled-wire" });
    expect(settled2, "a deliberate stop ends the feed as surely as a completion").toEqual(["settled"]);
  });

  test("a steered frame counts the queue down and its copy names the delivery that actually happened (UIE-055's client half)", async () => {
    // The frame's `delivery` field says which shape consumed the
    // instruction: "drain" — the loop started a new turn FOR it — or
    // "composed" — a turn that was starting anyway (a tool-call
    // continuation) carries it. The inline announcement must not blur
    // the two: "new turn starting" said about a composed delivery
    // claims a turn the loop never scheduled for the instruction, and
    // the reader who watches for it will not see it. Both shapes count
    // the pane's queue down to what the server says is still waiting.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-steered-frame" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    openRunStream("run-steered-frame", {});
    const es = MockEventSource.lastInstance!;

    // The pane believes one instruction is queued (the steer POST's own
    // answer said so).
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });
    // A DRAIN delivery: a new turn starts for the instruction.
    es.emit("steered", { runId: "run-steered-frame", remaining: 0, delivery: "drain" });
    expect(queuedSteers.get(), "the frame's remaining count is the pane's new queue depth").toBe(0);
    const drainNote = messages.get().find((m) => m.role === "event" && m.eventKind === "steering");
    expect(drainNote?.content).toContain("new turn starting");
    expect(drainNote?.content).not.toContain("delivered in the turn");

    // A COMPOSED delivery (a later steer in the same session): the turn
    // that is starting carries it — the copy must say so, never claim a
    // turn the loop did not schedule for it.
    es.emit("steered", { runId: "run-steered-frame", remaining: 1, delivery: "composed" });
    expect(queuedSteers.get(), "a second queued instruction stays counted").toBe(1);
    const composedNote = [...messages.get()].reverse().find((m) => m.role === "event" && m.eventKind === "steering");
    expect(composedNote?.content).toContain("delivered in the turn that is starting");
    expect(composedNote?.content).toContain("(1 queued)");
    expect(composedNote?.content).not.toContain("new turn starting");
    es.emit("done", { runId: "run-steered-frame" });
  });

  test("openRunStream builds the run-stream URL exactly — no stray character can ride the template's tail", async () => {
    // The URL-shape arm. A prior round's edit to this function's opening
    // lines moved the template literal's closing backtick one brace late,
    // so every live stream opened `/api/run/<id>/stream%7D` and 404'd —
    // while every suite stayed green, because the mock EventSource never
    // looked at the URL it was handed and no live drive had run after the
    // edit. The mock records its URL; this arm asserts the EXACT string,
    // so any character that sneaks past the interpolation reds here
    // instead of in a user's "the live stream was interrupted" face.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-url-shape" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    openRunStream("run-url-shape", {});
    const es = MockEventSource.lastInstance!;
    expect(es.url).toBe(`/api/run/run-url-shape/stream`);
    // The encoded-id path too — the interpolation itself is load-bearing.
    openRunStream("run/with spaces", {});
    expect(MockEventSource.lastInstance!.url).toBe(`/api/run/run%2Fwith%20spaces/stream`);
    es.emit("done", { runId: "run-url-shape" });
  });

  test("a dedup frame lands on the assistant turn it belongs to — buffered before start, attached when the turn opens", async () => {
    // The "dedup" event fires before the request, hence before the "start"
    // frame creates the assistant message — the "context" event's own
    // arrival shape. The summary must reach BOTH the live snapshot store
    // and the turn's own record (the fact the footer renders), with the
    // wire's own numbers and no restatement.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-dedup-attach" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    openRunStream("run-dedup-attach", {});
    const es = MockEventSource.lastInstance!;

    // The frame, as drive 11 captured it over the wire.
    es.emit("dedup", {
      runId: "run-dedup-attach",
      applied: true,
      originalChars: 2440,
      dedupedChars: 1845,
      charReductionPct: 24.39,
      removedBlocks: 5,
      removedLines: 31,
      messageCount: 5,
    });
    // The turn the frame belongs to opens NOW.
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });

    const list = messages.get();
    const assistant = [...list].reverse().find((m) => m.role === "assistant");
    expect(assistant, "the turn opened its assistant message").toBeDefined();
    expect(assistant!.dedupSummary, "the summary attached to the turn it belongs to").toBeDefined();
    expect(assistant!.dedupSummary!.applied).toBe(true);
    expect(assistant!.dedupSummary!.originalChars).toBe(2440);
    expect(assistant!.dedupSummary!.dedupedChars).toBe(1845);
    expect(assistant!.dedupSummary!.charReductionPct).toBe(24.39);
    expect(assistant!.dedupSummary!.removedBlocks).toBe(5);
    expect(assistant!.dedupSummary!.removedLines).toBe(31);
    expect(assistant!.dedupSummary!.messageCount).toBe(5);
    // The live snapshot store holds the same value — one summary, two
    // consumers, no second source of truth.
    const snap = dedupSnapshot.get();
    expect(snap?.applied).toBe(true);
    expect(snap?.charReductionPct).toBe(24.39);
    expect(snap?.originalChars).toBe(2440);
    es.emit("done", { runId: "run-dedup-attach" });
  });

  test("a turn whose call removed nothing inherits the previous turn's savings never", async () => {
    // The buffer is CONSUMED by the attach. A later turn whose call fired
    // no dedup event (it removed nothing) must render no savings face —
    // stale inheritance would fabricate savings on a turn that saved
    // nothing, the exact "wired but inert" lie in the savings direction.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-dedup-stale" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    openRunStream("run-dedup-stale", {});
    const es = MockEventSource.lastInstance!;

    // Turn 1: a call that folded content.
    es.emit("dedup", {
      runId: "run-dedup-stale",
      applied: true,
      originalChars: 2928,
      dedupedChars: 2214,
      charReductionPct: 24.38,
      removedBlocks: 6,
      removedLines: 40,
      messageCount: 6,
    });
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });
    const turn1 = [...messages.get()].reverse().find((m) => m.role === "assistant");
    expect(turn1?.dedupSummary?.removedBlocks).toBe(6);

    // Turn 2: a call that removed nothing — no dedup frame fires.
    es.emit("model", { type: "finish", reason: "tool_calls", sequence: 1, protocol: "openai-responses" });
    es.emit("model", { type: "start", sequence: 2, protocol: "openai-responses" });
    const turn2 = [...messages.get()].reverse().find((m) => m.role === "assistant");
    expect(turn2, "the second turn opened its own message").toBeDefined();
    expect(turn2!.id, "the second turn is a different message").not.toBe(turn1!.id);
    expect(
      turn2!.dedupSummary,
      "a turn whose call removed nothing carries no savings — absence, never a stale inherit",
    ).toBeUndefined();
    es.emit("done", { runId: "run-dedup-stale" });
  });

  test("a run that dies before its turn opens leaves no savings for the next run — the buffer dies with its run", async () => {
    // The stale-buffer window, one run wide: a call folds content (the
    // dedup frame publishes) and its request dies BEFORE any model frame
    // — no "start" ever arrives, so the attach that consumes the buffer
    // never runs. The server cleared its own accumulation at the dead
    // run's exit, so a buffer that survived the run would make the NEXT
    // run's first turn — whose own call removed nothing — attach the
    // dead call's snapshot at its own start: a live-only savings face
    // the record does not carry, which is a live↔reload disagreement.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-dedup-orphan" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    openRunStream("run-dedup-orphan", {});
    const dying = MockEventSource.lastInstance!;

    // The dying run's call folded content — the frame publishes.
    dying.emit("dedup", {
      runId: "run-dedup-orphan",
      applied: true,
      originalChars: 1188,
      dedupedChars: 902,
      charReductionPct: 24.07,
      removedBlocks: 3,
      removedLines: 18,
      messageCount: 4,
    });
    // And the request dies before ANY model frame: the terminal error
    // frame ends the run with no "start" ever arriving.
    dying.emit("error", {
      runId: "run-dedup-orphan",
      code: "provider_refused",
      message: "The model provider refused the request.",
    });
    expect(currentRun.get()!.status, "the run is honestly dead").toBe("error");

    // The next run opens its own stream — the fresh-stream boundary.
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-dedup-next" }) });
    await startRun({ projectId: "p1", prompt: "again" });
    openRunStream("run-dedup-next", {});
    const es = MockEventSource.lastInstance!;
    // Its first turn opens with NO dedup frame of its own (its call
    // removed nothing).
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });

    const next = [...messages.get()].reverse().find((m) => m.role === "assistant");
    expect(next, "the next run's turn opened its own assistant message").toBeDefined();
    expect(
      next!.dedupSummary,
      "the dead run's savings died with it — the next run's first turn attaches no orphaned summary",
    ).toBeUndefined();
    es.emit("done", { runId: "run-dedup-next" });
  });

  test("a redaction frame lands on the assistant turn it belongs to — buffered before start, attached when the turn opens", async () => {
    // The "redaction" event fires before the request, hence before the
    // "start" frame creates the assistant message — the context/dedup
    // arrival shape. The notice must reach BOTH the live snapshot store
    // and the turn's own record (the fact the footer renders), with the
    // wire's own numbers and no restatement. THE MASKED VALUE ITSELF IS
    // NOT ON THE WIRE and must not appear anywhere in what lands.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-redaction-attach" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    openRunStream("run-redaction-attach", {});
    const es = MockEventSource.lastInstance!;

    // The frame as the server publishes it: counts, confidence split, the
    // upstream count, per-tier join, and value-free reasons only.
    es.emit("redaction", {
      runId: "run-redaction-attach",
      maskedCount: 2,
      proven: 1,
      format: 0,
      inferred: 1,
      maskedUpstream: 0,
      byTier: { selfValidating: 1, declaredValues: 1 },
      reasons: [
        { confidence: "proven", category: "credential", maskedLength: 24, explanation: "equals a credential this machine holds" },
        { confidence: "inferred", category: "password", maskedLength: 8, explanation: "the words around it introduced it and its shape agreed" },
      ],
    });
    // The turn the frame belongs to opens NOW.
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });

    const list = messages.get();
    const assistant = [...list].reverse().find((m) => m.role === "assistant");
    expect(assistant, "the turn opened its assistant message").toBeDefined();
    const notice = assistant!.redactionNotice;
    expect(notice, "the notice attached to the turn it belongs to").toBeDefined();
    expect(notice!.maskedCount).toBe(2);
    expect(notice!.proven).toBe(1);
    expect(notice!.format).toBe(0);
    expect(notice!.inferred).toBe(1);
    expect(notice!.maskedUpstream).toBe(0);
    expect(notice!.byTier).toEqual({ selfValidating: 1, declaredValues: 1 });
    expect(notice!.reasons).toHaveLength(2);
    expect(notice!.reasons[0]!.confidence).toBe("proven");
    expect(notice!.reasons[0]!.category).toBe("credential");
    expect(notice!.reasons[1]!.explanation).toBe(
      "the words around it introduced it and its shape agreed",
    );
    // The live snapshot store holds the same value — one notice, two
    // consumers, no second source of truth.
    const snap = redactionNotice.get();
    expect(snap?.maskedCount).toBe(2);
    expect(snap?.proven).toBe(1);
    expect(snap?.runId).toBe("run-redaction-attach");
    es.emit("done", { runId: "run-redaction-attach" });
  });

  test("a turn whose call masked nothing inherits the previous turn's masking never", async () => {
    // The buffer is CONSUMED by the attach. A later turn whose call fired
    // no redaction event (it masked nothing) must render no masking face —
    // stale inheritance would fabricate a warning on a turn whose input
    // was NOT rewritten, and a false "your words were masked" is the one
    // lie this channel must never tell.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-redaction-stale" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    openRunStream("run-redaction-stale", {});
    const es = MockEventSource.lastInstance!;

    // Turn 1: a call that masked a value.
    es.emit("redaction", {
      runId: "run-redaction-stale",
      maskedCount: 1,
      proven: 1,
      format: 0,
      inferred: 0,
      maskedUpstream: 0,
      byTier: { selfValidating: 1 },
      reasons: [
        { confidence: "proven", category: "credential", maskedLength: 24, explanation: "equals a credential this machine holds" },
      ],
    });
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });
    const turn1 = [...messages.get()].reverse().find((m) => m.role === "assistant");
    expect(turn1?.redactionNotice?.maskedCount).toBe(1);

    // Turn 2: a call that masked nothing — no redaction frame fires.
    es.emit("model", { type: "finish", reason: "tool_calls", sequence: 1, protocol: "openai-responses" });
    es.emit("model", { type: "start", sequence: 2, protocol: "openai-responses" });
    const turn2 = [...messages.get()].reverse().find((m) => m.role === "assistant");
    expect(turn2, "the second turn opened its own message").toBeDefined();
    expect(turn2!.id, "the second turn is a different message").not.toBe(turn1!.id);
    expect(
      turn2!.redactionNotice,
      "a turn whose call masked nothing carries no notice — absence, never a stale inherit",
    ).toBeUndefined();
    es.emit("done", { runId: "run-redaction-stale" });
  });

  test("a run that dies before its turn opens leaves no masking for the next run — the redaction buffer dies with its run", async () => {
    // The same one-run window the dedup buffer has: a call masks something
    // (the redaction frame publishes) and the request dies BEFORE any
    // model frame — no "start" ever arrives, so the attach that consumes
    // the buffer never runs. The next run's first turn — whose own call
    // may mask nothing — must never attach the dead call's notice: a
    // masking face the record does not carry is a live↔reload
    // disagreement AND a false warning at once.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-redaction-orphan" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    openRunStream("run-redaction-orphan", {});
    const dying = MockEventSource.lastInstance!;

    dying.emit("redaction", {
      runId: "run-redaction-orphan",
      maskedCount: 1,
      proven: 0,
      format: 1,
      inferred: 0,
      maskedUpstream: 0,
      byTier: { grammarDefined: 1 },
      reasons: [
        { confidence: "format", category: "api-key", maskedLength: 40, explanation: "matches the published format of a provider key" },
      ],
    });
    // And the request dies before ANY model frame.
    dying.emit("error", {
      runId: "run-redaction-orphan",
      code: "provider_refused",
      message: "The model provider refused the request.",
    });
    expect(currentRun.get()!.status, "the run is honestly dead").toBe("error");

    // The next run opens its own stream — the fresh-stream boundary.
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-redaction-next" }) });
    await startRun({ projectId: "p1", prompt: "again" });
    openRunStream("run-redaction-next", {});
    const es = MockEventSource.lastInstance!;
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });

    const next = [...messages.get()].reverse().find((m) => m.role === "assistant");
    expect(next, "the next run's turn opened its own assistant message").toBeDefined();
    expect(
      next!.redactionNotice,
      "the dead run's masking died with it — the next run's first turn attaches no orphaned notice",
    ).toBeUndefined();
    es.emit("done", { runId: "run-redaction-next" });
  });

  test("a hallucination frame that TRIPPED the breaker invalidates the panel's rows; a plain block does not (UIE-036)", async () => {
    // The trip happens SERVER-side mid-run (the row flip + permission
    // event), so no client write fires the `tools:changed` invalidation the
    // breaker panel's rows refresh under. Without the flag→invalidation
    // wire, the panel keeps its cached rows and the trip stays invisible
    // until the next unrelated refresh — the exact defect. The plain block
    // (no trip) must NOT fire it: an invalidation nobody's data changed is
    // the cry-wolf shape.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-trip" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    let fired = 0;
    const stop = onInvalidation("tools:changed", () => {
      fired += 1;
    });
    try {
      openRunStream("run-trip", {});
      const es = MockEventSource.lastInstance!;

      es.emit("hallucination", {
        runId: "run-trip",
        eventId: "evt-gate-trip",
        callId: "call-1",
        kind: "schema_mismatch",
        toolName: "create_artifact",
        suggestion: null,
        message: "create_artifact was refused",
        autoTripped: true,
      });
      expect(fired, "the trip flipped the breaker rows — the panel must re-read them").toBe(1);

      fired = 0;
      es.emit("hallucination", {
        runId: "run-trip",
        eventId: "evt-gate-plain",
        callId: "call-2",
        kind: "ghost_tool",
        toolName: "no_such_tool",
        suggestion: "read_file",
        message: "no_such_tool is not registered",
      });
      expect(fired, "a block that tripped nothing invalidated nothing").toBe(0);
      expect(messages.get().filter((m) => m.role === "event").map((m) => m.timelineEventId),
        "both live block kinds retain their own recorded identity").toEqual(["evt-gate-trip", "evt-gate-plain"]);
    } finally {
      stop();
    }
  });

  test("the run's TERMINAL frame announcing the auto-trip revert re-reads the panel; an ordinary ending does not (UIE-041)", async () => {
    // The trip's arrival rode its hallucination frame (the test above); the
    // DEPARTURE rode nothing — the revert is a server-side row write no
    // panel verb fired, so the ▲ TRIPPED face outlived the trip by
    // minutes. The server now stamps `autoTripsReverted` on the terminal
    // frame (done/cancelled/error alike), and each listener turns it into
    // the same `tools:changed` invalidation the panel's own verbs fire.
    // An ending that reverted nothing fires nothing.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-revert" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    let fired = 0;
    const stop = onInvalidation("tools:changed", () => {
      fired += 1;
    });
    try {
      openRunStream("run-revert", {});
      let es = MockEventSource.lastInstance!;

      es.emit("done", { runId: "run-revert", autoTripsReverted: true });
      expect(fired, "the done frame's revert fact must re-read the breaker rows").toBe(1);

      fired = 0;
      openRunStream("run-revert", {});
      es = MockEventSource.lastInstance!;
      es.emit("cancelled", { runId: "run-revert", autoTripsReverted: true });
      expect(fired, "a cancelled run that reverted its trips announces it too").toBe(1);

      fired = 0;
      openRunStream("run-revert", {});
      es = MockEventSource.lastInstance!;
      es.emit("error", {
        runId: "run-revert",
        code: "provider_error",
        message: "the provider failed",
        autoTripsReverted: true,
      });
      expect(fired, "a failed run that reverted its trips announces it too").toBe(1);

      fired = 0;
      openRunStream("run-revert", {});
      es = MockEventSource.lastInstance!;
      es.emit("done", { runId: "run-revert" });
      expect(fired, "an ordinary ending reverted nothing and re-reads nothing").toBe(0);
    } finally {
      stop();
    }
  });

  test("a tool_result frame carrying the DISPATCHED whole renders it on the beat — the live card's input follows the frame (UIE-040)", async () => {
    // THE LIVE HALF OF THE MERGED-ARTIFACT FIX, through the real listeners.
    // The earlier fix made the frame carry the dispatched arguments but the
    // client parsed the field and DROPPED it: the beat's input stayed
    // whatever the model-event ingest set (the raw delta), so the surface
    // rendered "the recorded arguments carry no document to render" over an
    // artifact that was rendering live. The card must render what the
    // frame gives it.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-merge" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    openRunStream("run-merge", {});
    const es = MockEventSource.lastInstance!;

    es.emit("model", { type: "tool_call_start", callId: "call-merged", name: "create_artifact", outputIndex: 0, sequence: 1, protocol: "openai-responses" });
    // The model sent the pure DELTA — the gate will merge it server-side.
    es.emit("model", { type: "tool_call_done", callId: "call-merged", outputIndex: 0, arguments: { type: "html" }, sequence: 2, protocol: "openai-responses" });
    expect(
      messages.get().find((m) => m.role === "tool")?.toolCall?.input,
      "the model-event ingest sets the delta while the call is in flight",
    ).toEqual({ type: "html" });

    // The result frame carries the DISPATCHED whole — the merged arguments
    // the tool actually ran with.
    es.emit("tool_result", {
      runId: "run-merge",
      callId: "call-merged",
      toolName: "create_artifact",
      arguments: { content: "<p>the retained half</p>", title: "the drive title", type: "html" },
      result: "{\"ok\":true,\"artifactId\":\"a1\",\"type\":\"html\"}",
      success: true,
      attemptCount: 2,
    });

    const beat = messages.get().find((m) => m.role === "tool");
    expect(beat?.toolCall?.status).toBe("done");
    expect(
      beat?.toolCall?.input,
      "the beat's input must BE the frame's dispatched whole — the artifact renders from it",
    ).toEqual({ content: "<p>the retained half</p>", title: "the drive title", type: "html" });
    expect(beat?.toolCall?.attemptCount).toBe(2);
    expect(beat?.toolCall?.refused).toBeUndefined();

    // The blocked-call shape: the frame's arguments are the delta the model
    // sent (nothing was dispatched), and the failure is a refusal record.
    es.emit("model", { type: "tool_call_start", callId: "call-blocked", name: "create_artifact", outputIndex: 0, sequence: 3, protocol: "openai-responses" });
    es.emit("tool_result", {
      runId: "run-merge",
      callId: "call-blocked",
      toolName: "create_artifact",
      arguments: { content: "<p>x</p>", title: "t" },
      result: "create_artifact was refused: missing required field 'type'",
      success: false,
      attemptCount: 1,
    });
    const blocked = messages.get().filter((m) => m.role === "tool")[1];
    expect(blocked?.toolCall?.status).toBe("error");
    expect(blocked?.toolCall?.input, "a blocked call records the delta it was refused for").toEqual({ content: "<p>x</p>", title: "t" });
    expect(blocked?.toolCall?.refused).toBe(true);
  });

  test("error model event transitions run status to 'error'", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-err" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    openRunStream("run-err", {});
    const es = MockEventSource.lastInstance!;
    es.emit("model", {
      type: "error",
      error: { code: "provider_error", message: "rate limited" },
      sequence: 5,
      protocol: "openai-responses",
    });

    expect(currentRun.get()!.status).toBe("error");
  });

  test("the model error event is a call-level beat: the net runs for the failed call, the stream stays open, and the run's own terminal frame closes it", async () => {
    // THE BOUNDARY BETWEEN A CALL'S FAILURE AND A RUN'S ENDING. The model
    // error event settles the call's own facts — the error beat, the view's
    // terminal-looking settle, the stranded cards — but the RUN survives a
    // failed call whenever a steer is queued for the drain, and the stream
    // must survive with it: closing here is what made a steered
    // continuation's answer unreachable without a reload while the run
    // honestly continued and ended `done`. The run-level acts — the stream's
    // close, the ingest report's flush — happen at whichever terminal
    // frame ends THIS run, which a live client receives because it stayed
    // open. A run whose LAST call fails (no steer queued) ends at the
    // terminal `error` frame moments later; this arm drives both halves.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    // The chat is selected BEFORE the run starts — a chat-id write fires the
    // dynamic context reset (the snapshot stores' own auto-reset), which
    // clears the run view; the reader is in the conversation first, then
    // sends.
    currentChatId.set("chat-model-err-door");
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-model-err-door" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    // The read-back and the telemetry flush both go through fetch: the URLs
    // answer which doors ran. A tool-calls read-back with no row keeps the
    // card's honest placeholder — the heal mechanics are the done-event
    // arms' subject, not this arm's.
    const seenUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seenUrls.push(String(input));
      if (String(input).includes("/tool-calls")) {
        return { ok: true, status: 200, json: async () => [] } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    openRunStream("run-model-err-door", {});
    const es = MockEventSource.lastInstance!;
    // A tool card is genuinely in flight when the call fails — the shape the
    // stranded-tool net exists for.
    es.emit("model", {
      type: "tool_call_start",
      callId: "call-model-err-1",
      name: "read_file",
      outputIndex: 0,
      sequence: 1,
      protocol: "openai-responses",
    });
    expect(
      messages.get().filter((m) => m.role === "tool")[0]?.toolCall?.status,
      "the card must be running when the failure lands, or the net has nothing to catch",
    ).toBe("running");

    es.emit("model", {
      type: "error",
      eventId: "evt-model-error",
      error: { code: "llm_stream_error", message: "the stream broke mid-call" },
      sequence: 2,
      protocol: "openai-responses",
    });

    // The settle is the ingest's own report (the arm above); the failed
    // call's beat is a CALL-level fact. The stream does NOT close here —
    // the run's own ending has not arrived, and a queued steer could still
    // drive a continuation on this same socket.
    expect(currentRun.get()!.status).toBe("error");
    expect(
      es.readyState,
      "a failed call does not end the run's stream — the run's own terminal frame does, and closing here is what hid a steered continuation's answer behind a reload",
    ).not.toBe(2);

    // THE STRANDED-TOOL NET RAN AT THE CALL: the card carries the honest
    // per-call observation, not a spin-forever face.
    const card = messages.get().filter((m) => m.role === "tool")[0]!.toolCall!;
    expect(card.status).toBe("error");
    expect(card.incompleteReason, "the observation names the failed call, never a completion").toContain(
      "the run's call failed",
    );

    // The run-level flush has NOT happened — no terminal door has ended the
    // run yet, and the report belongs to whichever one does.
    await new Promise((r) => setTimeout(r, 20));
    expect(
      seenUrls.some((u) => u.includes("/tool-calls")),
      "the net's ledger read-back ran — the client's observation is checked against the run's own record",
    ).toBe(true);
    expect(
      seenUrls.some((u) => u.includes("client.telemetry")),
      "no terminal door has ended the run yet, so its ingest report has not flushed",
    ).toBe(false);

    // THE RUN'S OWN ENDING: the terminal `error` frame (the run's exit
    // publishes it after the loop) now reaches the client that stayed
    // open — it closes the stream, joins the failed call's beat, and
    // flushes the report.
    es.emit("error", {
      eventId: "evt-model-error",
      runId: "run-model-err-door",
      code: "llm_stream_error",
      message: "the stream broke mid-call",
    });

    expect(
      es.readyState,
      "the terminal error frame ends the run — the stream closes exactly on the run's own ending",
    ).toBe(2);
    const errorBeats = messages.get().filter((m) => m.role === "error");
    expect(errorBeats, "the terminal frame's copy joins the model error's beat — one failure, one row").toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(
      seenUrls.some((u) => u.includes("client.telemetry")),
      "the run's ingest report flushed at the door that ended it — every terminal door does",
    ).toBe(true);
  });

  test("a steer that arrives before a failed call keeps the pane live through the drain: the continuation answers LIVE and the run ends by its own done frame", async () => {
    // THE STEER-CONTINUATION PREMATURE CLOSE (the drive-13 drain scenario):
    // a steer queued mid-call, the call fails, and the server drains the
    // steer into a new turn 60ms later — the run continues and finishes
    // `done`. The old door closed the stream ON the model error, so the
    // steered frame, the drain's answer, and the terminal never reached a
    // live subscriber: the pane died on the error beat and the answer
    // rendered only after a reload. The pane must instead ride the failure
    // (the error beat shows, the view settles error momentarily) and go
    // LIVE AGAIN on the steered frame — the earliest wire evidence the run
    // continues — and stay open to the run's own `done`.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    currentChatId.set("chat-drain-live");
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-drain-live" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    const seenUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seenUrls.push(String(input));
      if (String(input).includes("/tool-calls")) {
        return { ok: true, status: 200, json: async () => [] } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    openRunStream("run-drain-live", {});
    const es = MockEventSource.lastInstance!;
    // The first call opens and fails mid-run — a queued steer is the only
    // continuation, exactly the drain scenario's shape.
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });
    es.emit("model", {
      type: "error",
      error: { code: "llm_auth_error", message: "auth failed (401)" },
      sequence: 1,
      protocol: "openai-responses",
    });
    expect(currentRun.get()!.status, "the failed call's beat settles the view — the pane shows the error").toBe("error");
    expect(
      messages.get().some((m) => m.role === "error"),
      "the failure's beat rendered",
    ).toBe(true);

    // THE DRAIN ARRIVES ON THE SAME STREAM — 60ms later on the real wire.
    // The pane goes live again: the frame reports a turn opening, which
    // cancels the retirement the error's settle armed.
    es.emit("steered", { runId: "run-drain-live", remaining: 0, delivery: "drain", eventId: "evt-steer-drain-1" });
    expect(
      es.readyState,
      "the stream never closed — the steered frame reached a live subscriber, which is the whole finding",
    ).not.toBe(2);
    expect(currentRun.get()!.status, "a steered frame means a turn is opening — the run is live again").toBe("running");
    expect(isRunActive.get(), "the pane's liveness returns with the continuation: stop verb, steer routing").toBe(true);
    const steerBeats = messages.get().filter((m) => m.role === "event" && m.eventKind === "steering");
    expect(steerBeats, "the steering announcement rendered live").toHaveLength(1);
    expect(steerBeats[0]!.timelineEventId, "the beat carries the announcement's own ledger address — a replay joins it, never twins it").toBe("evt-steer-drain-1");

    // THE CONTINUATION ANSWERS LIVE — no reload, the finding's other half.
    es.emit("model", { type: "start", sequence: 2, protocol: "openai-responses" });
    es.emit("model", { type: "text_delta", delta: "Recovered after the steer.", sequence: 3, protocol: "openai-responses" });
    es.emit("model", { type: "finish", reason: "stop", sequence: 4, protocol: "openai-responses" });
    commitStreamingTail();
    expect(
      messages.get().some((m) => m.role === "assistant" && m.content.includes("Recovered after the steer.")),
      "the drain turn's answer reached the live transcript",
    ).toBe(true);

    // THE RUN ENDS BY ITS OWN TERMINAL — the stream closes exactly there.
    es.emit("done", { runId: "run-drain-live" });
    expect(currentRun.get()!.status, "a run that continued past a failure and finished ends done — the honest ending").toBe("done");
    expect(es.readyState, "the run's own done frame is the close").toBe(2);
    expect(
      messages.get().filter((m) => m.role === "error"),
      "the failed call's beat survives the continuation — the run's honesty keeps the failure's own record",
    ).toHaveLength(1);
    expect(
      messages.get().filter((m) => m.role === "event" && m.eventKind === "steering"),
      "one steering announcement, live and through the ending",
    ).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(
      seenUrls.some((u) => u.includes("client.telemetry")),
      "the run's ingest report flushed at the done door that ended it",
    ).toBe(true);
  });

  test("text_delta streams into the tail atom, then folds into the message", async () => {
    // The in-flight text deliberately lives in `streamingTail`, NOT in the
    // message array: appending to the array per token cost O(N) four times
    // over (array copy, summary recompute, render-list rebuild, keyed diff),
    // and that cost grew with conversation length. The tail is folded into the
    // message once, when the stream finishes.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-text" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    openRunStream("run-text", {});
    const es = MockEventSource.lastInstance!;

    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });
    es.emit("model", { type: "text_delta", delta: "Hello ", sequence: 1, protocol: "openai-responses" });
    es.emit("model", { type: "text_delta", delta: "world", sequence: 2, protocol: "openai-responses" });

    // MID-STREAM: one assistant message exists; the text is in the tail.
    const during = messages.get();
    expect(during.length).toBe(1);
    expect(during[during.length - 1]!.role).toBe("assistant");
    expect(streamingTail.get()).toBe("Hello world");

    // AFTER the stream ends: the tail is folded in and cleared, so every
    // consumer of `messages` sees the finished text exactly as before.
    commitStreamingTail();
    const after = messages.get();
    expect(after[after.length - 1]!.content).toBe("Hello world");
    expect(streamingTail.get()).toBe("");
  });

  test("SSE error event pushes to the errors store", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-sse-err" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    openRunStream("run-sse-err", {});
    const es = MockEventSource.lastInstance!;
    es.emitError();

    expect(errors.get().length).toBeGreaterThanOrEqual(1);
    expect(errors.get()[0]!.kind).toBe("stream");
    // A CLOSED transport is terminal for this client — EventSource will
    // not reconnect, so no later frame can settle the view in this
    // listener's place. Leaving it "running" here is the same
    // permanently-live face as an unsettled error frame (UIE-056's
    // family): the clock ticks on a run that is over.
    expect(currentRun.get()!.status, "a lost connection settles the view — no frame is coming").toBe("error");
    expect(isRunActive.get()).toBe(false);
  });

  test("the CLOSED door speaks the truth about reconnecting and flushes the run's ingest report (the parked-run return past retention)", async () => {
    // THE PARKED-RUN RETURN PAST THE FEED'S RETENTION: the server refuses
    // the re-opened stream (the feed is released), the browser fails the
    // connection permanently, and THIS branch is the run's first and only
    // ending on the page. Two defects were measured live on exactly this
    // path (drive 12, UIE-077): the chat beat promised "Reconnecting
    // automatically..." — a promise the SSE protocol itself forbids this
    // branch from ever keeping (a non-200 answer fails the connection for
    // good; the browser never retries) — and no telemetry beat ever
    // flushed for the run, where the within-retention sibling return had
    // one: this was the one stream-ending door without its siblings'
    // flush act. The beat must state the real disposition (the stream is
    // gone, it will not reconnect, the record is in the conversation) and
    // the door must run the flush every other terminal door runs.
    currentChatId.set("chat-parked");
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-parked-return" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    // The recorder is installed AFTER startRun consumed its one-shot mock —
    // the round-30 door arm's order, so the flushes (not the start) land in
    // the log.
    const seenUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seenUrls.push(String(input));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    const controller = openRunStream("run-parked-return", {});
    const es = MockEventSource.lastInstance!;
    // The run was LIVE before its stream parked: its frames were ingested
    // through this stream's listeners, so the per-run ingest-lag aggregate
    // exists and the door's flush has a real report to send (a stream
    // that never saw a frame has none — its absence is honest, not a 0).
    es.emit("connected", { runId: "run-parked-return", harnessReady: false, chatId: "chat-parked" });
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });
    controller.close();
    openRunStream("run-parked-return", {});
    const returned = MockEventSource.lastInstance!;
    expect(returned).not.toBe(es);
    returned.emitError();

    const errorBeats = messages.get().filter((m) => m.role === "error");
    expect(errorBeats).toHaveLength(1);
    expect(
      errorBeats[0]!.content,
      "the beat states the real disposition — no reconnection promise this branch can never keep",
    ).toContain("will not reconnect");
    expect(errorBeats[0]!.content).not.toContain("Reconnecting automatically");
    expect(errorBeats[0]!.content, "the beat points the reader at the record the conversation holds").toContain(
      "saved in this conversation",
    );
    // The flush is best-effort async — let the report land, then the door
    // must show in the fetch log exactly as its four sibling doors do.
    await new Promise((r) => setTimeout(r, 20));
    expect(
      seenUrls.some((u) => u.includes("client.telemetry")),
      "the run's ingest report flushed at the door that ended it — every other stream-ending door does",
    ).toBe(true);
  });

  test("a re-attach's replayed model error joins the record's own row — one beat for one failure, and the replay still settles the run", async () => {
    // THE RECONNECT DOUBLE-BUBBLE (UIE-078, drive 12's Run B): a run that
    // failed while parked, returned to WITHIN the feed's retention, replayed
    // its model error event beside the same-words error row the history
    // hydration had just served — TWO identical error beats, the second
    // client-only (a reload collapsed it). The replay join keys on the
    // recorder's canonical event ID, so the
    // replayed event returns the record's row id and the transcript keeps
    // exactly the one beat the record holds. The replay's burst now runs
    // PAST the model error to the terminal `error` frame too (the stream
    // no longer closes on the call-level event), and the terminal frame's
    // own copy joins the same row — one failure, one beat, however many
    // wire shapes carried it.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    // The chat is selected BEFORE the run starts — a chat-id write fires the
    // dynamic context reset, which clears the run view; the reader is in
    // the conversation first, then sends (the round-30 door arm's order).
    currentChatId.set("chat-reattach");
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-reattach" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    // The history hydration: the record's own error row for this run's
    // failure, stamped with the failure's identity exactly as the server
    // persists it (the canonical ID beside the failure taxonomy).
    const page: ChatHistoryPageView = {
      chat: { id: "chat-reattach", projectId: "p1", title: "t", createdAt: "2026-09-02T17:00:00Z", updatedAt: "2026-09-02T17:00:00Z", modelId: null, pinned: false },
      messages: [
        { id: "row-user-1", chatId: "chat-reattach", role: "user", content: "say ready", createdAt: "2026-09-02T17:47:20Z", modelEventType: null, runId: "run-reattach", metadata: null },
        { id: "row-err-1", chatId: "chat-reattach", role: "error", content: "network error: fetch failed", createdAt: "2026-09-02T17:47:25Z", modelEventType: "error", runId: "run-reattach", metadata: { errorCode: "llm_stream_error", timelineEventId: "evt-reattach-error" } },
      ],
      toolCalls: [],
      metricsSnapshots: [],
      timelineRefs: [],
      page: wholeConversationPage(2),
    };
    hydrateChatFromHistory(page);

    openRunStream("run-reattach", {});
    const es = MockEventSource.lastInstance!;
    // The re-attach's replay burst, in the feed's own order: connected, the
    // run's model start (the empty assistant row lands BETWEEN the record's
    // row and the replayed error — the shape the adjacent-twin arm cannot
    // see), the replayed model error event with the failure's own words,
    // and the terminal `error` frame the run's exit published behind it.
    es.emit("connected", { runId: "run-reattach", harnessReady: false, chatId: "chat-reattach" });
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });
    es.emit("model", {
      type: "error",
      eventId: "evt-reattach-error",
      error: { code: "llm_stream_error", message: "network error: fetch failed" },
      sequence: 2,
      protocol: "openai-responses",
    });
    // The replay does NOT die at the call-level event — the burst's own
    // terminal frame is next, and the stream must still be open to take it.
    expect(
      es.readyState,
      "the replayed call-level error does not close the stream — the run's own terminal frame is still ahead in the burst",
    ).not.toBe(2);
    es.emit("error", {
      eventId: "evt-reattach-error",
      runId: "run-reattach",
      code: "llm_stream_error",
      message: "network error: fetch failed",
    });

    const errorBeats = messages.get().filter((m) => m.role === "error" && m.content === "network error: fetch failed");
    expect(errorBeats, "one failure, one beat — the replayed model error AND the terminal frame both joined the record's row").toHaveLength(1);
    expect(errorBeats[0]!.id, "the standing beat IS the record's own row").toBe("row-err-1");
    // The replay's own facts settle the run like any other replay's.
    expect(currentRun.get()!.status).toBe("error");
    expect(es.readyState, "the terminal frame ended the replay — the stream closes on the run's own ending").toBe(2);
  });

  test("unaddressed same-word failures from different runs stay separate", async () => {
    // The retry case through the wire: the conversation holds run A's
    // persisted error row; run B fails with the same words and its
    // re-attach replays the event. Both failures are real and the record
    // holds both rows — a content-only join would swallow run B's beat
    // while its row renders only after a reload, the live flow lying
    // against its own record. Neither unaddressed observation proves a replay.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    currentChatId.set("chat-retry");
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-b" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    const retryPage: ChatHistoryPageView = {
      chat: { id: "chat-retry", projectId: "p1", title: "t", createdAt: "2026-09-02T17:00:00Z", updatedAt: "2026-09-02T17:00:00Z", modelId: null, pinned: false },
      messages: [
        { id: "row-run-a-err", chatId: "chat-retry", role: "error", content: "network error: fetch failed", createdAt: "2026-09-02T17:47:25Z", modelEventType: "error", runId: "run-a", metadata: { errorCode: "llm_stream_error" } },
      ],
      toolCalls: [],
      metricsSnapshots: [],
      timelineRefs: [],
      page: wholeConversationPage(1),
    };
    hydrateChatFromHistory(retryPage);

    openRunStream("run-b", {});
    const es = MockEventSource.lastInstance!;
    es.emit("connected", { runId: "run-b", harnessReady: false, chatId: "chat-retry" });
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });
    es.emit("model", {
      type: "error",
      error: { code: "llm_stream_error", message: "network error: fetch failed" },
      sequence: 2,
      protocol: "openai-responses",
    });

    const errorBeats = messages.get().filter((m) => m.role === "error" && m.content === "network error: fetch failed");
    expect(errorBeats, "two real failures, two beats — run B's replay appended beside run A's record row").toHaveLength(2);
    expect(errorBeats.some((m) => m.id === "row-run-a-err"), "the record's row stands").toBe(true);
    expect(errorBeats.some((m) => m.id !== "row-run-a-err"), "the replayed failure of the OTHER run kept its own beat").toBe(true);
  });

  test("a rewriting code keeps its projected sentence when its canonical ID replays", async () => {
    // THE TWO-FACES DEFECT, wire-shaped: for the codes the formatter
    // REWRITES (llm_timeout is the proven case), the live beat renders the
    // reader-facing projection ("The request took too long…") while the
    // record's own words are the raw ("request timed out after 120000ms").
    // The run-end ledger replay of the failure's record arrives as a
    // timeline frame carrying that raw — it must join the live beat (one
    // failure, one beat), and the beat's rendered face must be the
    // projection, the same sentence the reloaded row renders.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    currentChatId.set("chat-rewrite-join");
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-rewrite-join" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    openRunStream("run-rewrite-join", {});
    const es = MockEventSource.lastInstance!;
    es.emit("connected", { runId: "run-rewrite-join", harnessReady: false, chatId: "chat-rewrite-join" });
    // The live model error — the beat the reader watches fail.
    es.emit("model", {
      type: "error",
      eventId: "evt-timeout-1",
      error: { code: "llm_timeout", message: "request timed out after 120000ms" },
      sequence: 1,
      protocol: "openai-responses",
    });
    // The run-end ledger replay of the same failure's own record: an
    // error-type timeline event carrying the failure's full identity, its
    // description the record's raw words.
    es.emit("timeline", {
      eventId: "evt-timeout-1",
      eventType: "error",
      description: "request timed out after 120000ms",
      runId: "run-rewrite-join",
      errorCode: "llm_timeout",
      errorMessage: "request timed out after 120000ms",
    });

    const errorBeats = messages.get().filter((m) => m.role === "error");
    expect(errorBeats, "one failure, one beat — the ledger replay joined the live beat through its canonical ID").toHaveLength(1);
    expect(
      errorBeats[0]!.content,
      "the beat's rendered face is the projection the live door derives — never the record's raw words",
    ).toBe(formatErrorMessage({ code: "llm_timeout", message: "request timed out after 120000ms", statusCode: undefined }));
    expect(errorBeats[0]!.content).not.toBe("request timed out after 120000ms");
    expect(
      errorBeats[0]!.timelineEventId,
      "the live beat retains the canonical address shared by its replay",
    ).toBe("evt-timeout-1");
  });

  test("a REWRITING code's ledger record APPENDS the projection face when no beat owns the failure yet", async () => {
    // The same timeline record arriving where the live beat never rendered
    // (the failure happened while this page was parked elsewhere, the
    // record is the first copy this store sees): the appended row's face
    // must still be the projection — one failure, one sentence, on every
    // face a reader can reach. Appending the record's raw description
    // here was the second face of the two-faces defect.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    currentChatId.set("chat-rewrite-append");
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-rewrite-append" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    openRunStream("run-rewrite-append", {});
    const es = MockEventSource.lastInstance!;
    es.emit("connected", { runId: "run-rewrite-append", harnessReady: false, chatId: "chat-rewrite-append" });
    es.emit("timeline", {
      eventId: "evt-timeout-2",
      eventType: "error",
      description: "request timed out after 120000ms",
      runId: "run-rewrite-append",
      errorCode: "llm_timeout",
      errorMessage: "request timed out after 120000ms",
    });

    const errorBeats = messages.get().filter((m) => m.role === "error");
    expect(errorBeats).toHaveLength(1);
    expect(
      errorBeats[0]!.content,
      "the appended beat renders the projection, exactly the sentence the live door and the reloaded row render",
    ).toBe(formatErrorMessage({ code: "llm_timeout", message: "request timed out after 120000ms", statusCode: undefined }));
    expect(errorBeats[0]!.content).not.toBe("request timed out after 120000ms");
  });

  test("a terminal error SSE frame settles the run view — the pane stops, the chat sends again, and the failure still renders (UIE-056)", async () => {
    // The tool-iteration bound, a provider failure, any run-level error:
    // the server ends the run with an `error` frame and settles its own
    // registry; the client's view must settle with it, through the same
    // status report the done and cancelled frames use. The measured
    // defect: this listener did everything else honestly (the beat, the
    // stranded tools, the close, the telemetry) and never settled the
    // view — so the pane read "running" with the clock ticking minutes
    // past the server's settle, the stop verb was a 404 dead end, and
    // every send routed to the dead run's steer door: the chat was
    // unsendable until a page reload.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-tool-limit" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    openRunStream("run-tool-limit", {});
    const es = MockEventSource.lastInstance!;
    // A turn opened — the view is genuinely live, not merely planted.
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });
    expect(currentRun.get()!.status).toBe("running");
    expect(isRunActive.get()).toBe(true);

    es.emit("error", {
      runId: "run-tool-limit",
      code: "tool_iteration_limit",
      message: "The assistant reached its limit on tool uses for one reply and stopped.",
    });

    // THE SETTLE: the view reads the terminal status and the liveness is
    // gone — the pane's clock stops, its stop verb disappears with the
    // liveness, and the composer's send routing falls back to a NEW run
    // instead of the dead one's steer door (the fresh 201, not the 404).
    expect(currentRun.get()!.status, "an error frame is a terminal frame — the view settles on it").toBe("error");
    expect(isRunActive.get(), "a dead run must not stay stoppable or steerable").toBe(false);
    const steered = await steerCurrentRun("after the failure");
    expect(steered, "a settled run is the caller's fall-back-to-new-run signal — the chat is sendable").toBe(false);
    expect(es.readyState, "an error frame is terminal; staying open reconnects into a loop").toBe(2);
    // THE HONEST DISPLAY SURVIVES THE SETTLE — the fix must not swallow
    // the failure to close the view: the alarm beat renders with the
    // server's own sentence, and the stream's own record names the code.
    const beats = messages.get().filter((m) => m.role === "error").map((m) => m.content);
    expect(beats.length, "the failure is shown in the transcript").toBe(1);
    expect(beats[0]).toContain("reached its limit on tool uses");
    expect(errors.get().map((e) => e.code)).toEqual(["tool_iteration_limit"]);
  });

  test("a transient onerror at readyState CONNECTING does NOT settle the run — EventSource is reconnecting, the run is not over (the error listener's non-terminal branch)", async () => {
    // The error listener's THIRD shape, the one the UIE-056 fix deliberately
    // left untouched: an error event carrying NO frame, on a transport still
    // CONNECTING, is EventSource auto-reconnecting — the run's feed may come
    // back, so settling here would kill a live run's view mid-flight
    // (UIE-056's mirror: a permanently-DEAD face on a run still running).
    // The arm pins the discrimination itself: same listener, same event
    // name — only the transport's readyState and the frame's presence
    // differ, and the run's lifetime answers to exactly that.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-transient" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    openRunStream("run-transient", {});
    const es = MockEventSource.lastInstance!;
    // A turn opened — the view is genuinely live, not merely planted.
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });
    expect(currentRun.get()!.status).toBe("running");
    expect(isRunActive.get()).toBe(true);

    vi.useFakeTimers();
    try {
      es.emitTransientError();

      // THE RUN STAYS LIVE. The reconnect note is the honest report — and
      // it proves THIS branch ran (the framed door writes the server's own
      // code, the CLOSED door writes stream_closed); nothing about the
      // view moved, and the stream was left open to reconnect, which is
      // what this branch exists for.
      expect(errors.get().map((e) => e.code)).toEqual(["stream_error"]);
      expect(currentRun.get()!.status, "a reconnecting transport is not a terminal frame").toBe("running");
      expect(isRunActive.get(), "the pane's stop verb renders on this verdict — it stays").toBe(true);
      expect(es.readyState, "closing here would kill the auto-reconnect the branch names").toBe(MockEventSource.CONNECTING);

      // NO RETIREMENT WAS SCHEDULED either: advance past the whole outcome
      // delay and the live run's view still stands.
      vi.advanceTimersByTime(RUN_STATUS_CLEAR_DELAY_MS + 1);
      expect(currentRun.get()!.status, "no retirement was armed — nothing fires at the delay").toBe("running");
      expect(isRunActive.get()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("malformed SSE model event pushes a parse error to the errors store", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-bad" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    openRunStream("run-bad", {});
    const es = MockEventSource.lastInstance!;
    // Send invalid JSON as the model event data.
    es.emit("model", "{broken json");

    const errs = errors.get();
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0]!.kind).toBe("parse");
  });

  test("StreamController.close closes the EventSource", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-close" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    const onModelEvent = vi.fn();
    const controller = openRunStream("run-close", { onModelEvent });
    const es = MockEventSource.lastInstance!;
    es.emit("model", { type: "start", sequence: 0, protocol: "openai-responses" });
    expect(onModelEvent).toHaveBeenCalledTimes(1);
    controller.close();
    expect(es.readyState).toBe(2); // CLOSED
    const before = streamingTail.get();
    es.emit("model", { type: "text_delta", outputIndex: 0, delta: "queued after close" });
    expect(streamingTail.get()).toEqual(before);
    expect(onModelEvent).toHaveBeenCalledTimes(1);
  });

  test("the done event reads the tool calls back and heals a stranded card from the ledger", async () => {
    // THE STRAND, LIVE: the card is created from its start frame, its result
    // frame never arrives, the run ends. The safety net marks the card with
    // the honest observation — and the done handler must then consult the
    // LEDGER, because "the client never saw a result" is a claim about the
    // stream, not about the run. The read-back answers with the call's real
    // (gate-block-shaped) result, joined by the persisted callId.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-heal" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    currentChatId.set("chat-heal");

    openRunStream("run-heal", {});
    const es = MockEventSource.lastInstance!;
    es.emit("model", { type: "tool_call_start", callId: "call-strand-1", name: "create_artifact", outputIndex: 0, sequence: 1, protocol: "openai-responses" });
    // … and no tool_result ever arrives. The run ends.
    const toolCallsReply = [
      {
        id: "tc-row-1",
        messageId: "m-1",
        callId: "call-strand-1",
        toolName: "create_artifact",
        input: { type: "app" },
        output: "field 'type' must be one of: html, game, sheet, presentation, got \"app\"",
        status: "error",
        durationMs: 41,
        attemptCount: 1,
        createdAt: "2026-08-31T00:00:00Z",
      },
    ];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tool-calls")) {
        return { ok: true, status: 200, json: async () => toolCallsReply } as Response;
      }
      // The done handler also refreshes the timeline, auto-checks and memory.
      // Harmless generic answers keep those best-effort lanes quiet.
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    es.emit("done", { runId: "run-heal" });

    // BEFORE the read-back lands: the honest observation is on the card.
    expect(messages.get()[0]!.toolCall!.incompleteReason).toContain("run completed");
    // The heal is best-effort async — let the read-back land.
    await new Promise((r) => setTimeout(r, 20));

    const healed = messages.get()[0]!.toolCall!;
    expect(healed.status).toBe("error");
    expect(healed.output).toContain("must be one of: html, game, sheet, presentation");
    expect(healed.durationMs).toBe(41);
    expect(healed.incompleteReason, "the ledger supersedes the client observation").toBeUndefined();
  });

  test("the done event keeps the placeholder when the ledger holds no result either", async () => {
    // The placeholder may only mean what it says. A read-back row with a
    // settled status and NO output is the honest absence — healing it would
    // dress the absence up as a result.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-absent" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    currentChatId.set("chat-absent");

    openRunStream("run-absent", {});
    const es = MockEventSource.lastInstance!;
    es.emit("model", { type: "tool_call_start", callId: "call-absent-1", name: "read_file", outputIndex: 0, sequence: 1, protocol: "openai-responses" });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tool-calls")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: "tc-row-2",
              messageId: "m-2",
              callId: "call-absent-1",
              toolName: "read_file",
              input: { path: "x" },
              output: null,
              status: "error",
              durationMs: null,
              attemptCount: 1,
              createdAt: "2026-08-31T00:00:00Z",
            },
          ],
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    es.emit("done", { runId: "run-absent" });
    await new Promise((r) => setTimeout(r, 20));

    const card = messages.get()[0]!.toolCall!;
    expect(card.output, "an empty ledger row heals nothing").toBeNull();
    expect(card.incompleteReason, "the absence stays honestly labelled").toContain("run completed");
  });

  // ── cancellation settles the run view honestly ──────────────────────────
  //
  // A stop is a person's own act: settling it as `done` would report an
  // interruption as a completion, and leaving the status `running` would
  // leave a dead run looking live. The typed status is `cancelled`, and it
  // retires after the same brief delay every terminal outcome gets.

  test("cancelRun settles the run view as 'cancelled' — never as 'done'", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-stop" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    expect(currentRun.get()!.status).toBe("starting");

    mockFetchOnce({ ok: true, status: 200, json: async () => ({ cancelled: true, runId: "run-stop" }) });
    await cancelRun("run-stop");
    expect(currentRun.get()!.status, "a stop is not a completion").toBe("cancelled");
  });

  test("the terminal 'cancelled' SSE frame settles the run view from ANY door", async () => {
    // A cancel pressed in ANOTHER tab reaches this client only through the
    // stream's terminal frame — the same settle has to fire there.
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-x-tab" }) });
    await startRun({ projectId: "p1", prompt: "hi" });

    openRunStream("run-x-tab", {});
    const es = MockEventSource.lastInstance!;
    es.emit("cancelled", { runId: "run-x-tab" });

    expect(currentRun.get()!.status, "the cross-tab cancel settles here or nowhere").toBe("cancelled");
  });

  // ── steering the live run ────────────────────────────────────────────────
  //
  // steerCurrentRun is the client's half of the steer routing: the liveness
  // check is the client's OWN run state (a settled view is not steerable and
  // answers false so the composer can fall back to a new run), the message
  // lands in the transcript FIRST (marked steered, so the flow renders the
  // queued state), the composer may empty on exactly that fact, and the
  // server's queue depth feeds the run pane's queued-instruction line. A
  // REFUSED POST is a non-delivery: the steered marking and the streaming
  // raise are taken back and the failure rethrows for the composer's hint.

  test("steerCurrentRun steers a LIVE run: the steered beat lands, the queue depth is recorded", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-live" }) });
    await startRun({ projectId: "p1", prompt: "first prompt" });

    let committed = 0;
    mockFetchOnce({ ok: true, status: 200, json: async () => ({ queued: 1, steered: true }) });
    const steered = await steerCurrentRun("go the other way", {
      onCommitted: () => { committed += 1; },
    });
    expect(steered).toBe(true);
    // The steered marking travels with the message — the flow renders the
    // queued state from it.
    const last = messages.get().at(-1);
    expect(last?.content).toBe("go the other way");
    expect(last?.steered).toBe(true);
    expect(committed).toBe(1);
    expect(queuedSteers.get()).toBe(1);
  });

  test("steerCurrentRun answers false for a SETTLED run and touches nothing", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-settled" }) });
    await startRun({ projectId: "p1", prompt: "hi" });
    // Settle it the way the run really ends: the terminal `done` frame (a
    // per-turn finish no longer settles the run view).
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    openRunStream("run-settled", {});
    MockEventSource.lastInstance!.emit("done", { runId: "run-settled" });
    expect(currentRun.get()!.status).toBe("done");

    const before = messages.get().length;
    let committed = 0;
    const steered = await steerCurrentRun("too late", {
      onCommitted: () => { committed += 1; },
    });
    expect(steered, "a settled run is the caller's fall-back-to-new-run signal").toBe(false);
    expect(messages.get().length).toBe(before);
    expect(committed).toBe(0);
  });

  test("steerCurrentRun answers false with no run view at all", async () => {
    currentRun.set(null);
    await expect(steerCurrentRun("anything")).resolves.toBe(false);
    expect(messages.get().some((m) => m.content === "anything")).toBe(false);
  });

  test("a steer the route REFUSES (the 404 window) un-marks the beat, restores streaming, and rethrows for the hint", async () => {
    // The run view says live, but the run ended server-side between the
    // liveness check and the POST — the steer route's one race, answered
    // by its own 404 sentence. The two optimistic marks the happy path
    // raised BEFORE the POST are lies the moment it fails, and are taken
    // back at the door that raised them.
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-raced" }) });
    await startRun({ projectId: "p1", prompt: "first prompt" });
    // Pin the pre-call streaming flag LOW so the optimistic raise is the
    // only one in flight and its undo is observable.
    setStreaming(false);

    mockFetchOnce({
      ok: false,
      status: 404,
      json: async () => ({
        error: "not_found",
        message: "Run run-raced not found or already completed",
      }),
    });
    const caught = await steerCurrentRun("too late").then(
      () => null,
      (err: unknown) => err,
    );
    // The failure RETHROWS, never swallowed: the composer's answer path
    // renders this very sentence as the hint (composer-autocreate owns
    // that refused-steer mapping; this is the input contract it consumes).
    expect(caught).toBeInstanceOf(ClientError);
    expect((caught as ClientError).message).toContain("already completed");
    // The beat STAYS — the reader's own words are visible text — but the
    // steered marking is TAKEN BACK, because the note it renders ("the
    // model receives this after the current turn") would claim a delivery
    // the route never persisted. MUTATION: skip the un-mark in
    // steerCurrentRun and this reds.
    const last = messages.get().at(-1);
    expect(last?.content).toBe("too late");
    expect(last?.steered).toBeUndefined();
    // The streaming flag is RESTORED, not forced: pre-call false comes
    // back false — no stuck live flag with no stream left to lower it.
    expect(isStreaming.get()).toBe(false);

    // And a pre-call TRUE stays true — a refusal under a still-live run
    // must not darken the live flag the stream still owns lowering.
    setStreaming(true);
    mockFetchOnce({
      ok: false,
      status: 404,
      json: async () => ({
        error: "not_found",
        message: "Run run-raced not found or already completed",
      }),
    });
    await steerCurrentRun("and again").then(
      () => {
        throw new Error("the second refused steer must also rethrow");
      },
      () => undefined,
    );
    const tail = messages.get().at(-1);
    expect(tail?.content).toBe("and again");
    expect(tail?.steered).toBeUndefined();
    expect(isStreaming.get()).toBe(true);
  });

  test("a steer that STARVES in flight (UIE-044) reverts the note at the budget and rethrows the timeout honestly", async () => {
    // THE MEASURED SHAPE, from the UIE-044 reproduction: the per-origin
    // HTTP/1.1 pool is pinned by held streams, the steer POST never sends,
    // the server records nothing, and the broker's own 30s budget aborts
    // the request — `net::ERR_ABORTED` in the wire, `ClientTimeoutError`
    // at this door. The recovery arm of the fix: the optimistic marks come
    // back AT THE BUDGET (never later), the beat keeps the reader's words
    // without the steered note that would claim a delivery, the streaming
    // flag is restored, and the failure rethrows so the composer's hint
    // speaks it — the honest answer, not a silent retry or a stuck mark.
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ runId: "run-starved" }) });
    await startRun({ projectId: "p1", prompt: "first prompt" });
    setStreaming(false);

    // A fetch that NEVER answers and honours the door's abort signal: the
    // queued-forever shape. The broker's own controller fires the abort at
    // the budget — this mock is what a pinned socket pool looks like.
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
    ) as typeof fetch;

    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      // The rejection handler is attached AT CALL TIME: the budget's abort
      // fires during the timer advance below, and a promise that rejects
      // with no handler yet is an unhandled rejection the suite's parallel
      // load can observe before this test attaches one (measured: the test
      // was green alone and red under the full run's scheduling).
      const attempt = steerCurrentRun("steer me").then(
        () => null,
        (err: unknown) => err,
      );
      // The optimistic marks are UP before the POST — the beat and the live
      // flag are the UIE-044 surface that must come back down.
      expect(messages.get().at(-1)?.steered).toBe(true);
      expect(isStreaming.get()).toBe(true);

      await vi.advanceTimersByTimeAsync(30_001);
      const caught = await attempt;
      // The budget — 30s, not a moment longer: the steered note never
      // outlives the request it describes.
      expect(Date.now() - t0).toBeLessThanOrEqual(30_001);
      expect(caught).toBeInstanceOf(ClientTimeoutError);
      expect((caught as ClientTimeoutError).code).toBe("timeout");
      // The beat STAYS as the reader's words; the steered marking is taken
      // back — the note would claim a delivery that never reached the run
      // (the server recorded no row: nothing queued, nothing drained).
      const last = messages.get().at(-1);
      expect(last?.content).toBe("steer me");
      expect(last?.steered).toBeUndefined();
      // The streaming flag is RESTORED to its pre-call value, not forced.
      expect(isStreaming.get()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── THE RELOADED PAGE'S ORPHANED WORKING BEATS (UIE-042) ───────────────────
//
// A page reloaded mid-run never re-attaches to the live run's SSE, so the
// frames that would settle its in-flight beats never arrive, and the
// done-frame safety net covers only POST-reload frames. Measured live:
// eight beats at "◍ working Ns" with climbing clocks 5+ minutes after the
// server-side run had closed; the next reload healed. The hydrate door now
// reads the ledger back and settles what the rows say — and keeps reading
// while the run is genuinely still live, so a run that ends after the
// hydrate still heals without another reload.
//
// MUTATION: skip the reconcile at the hydrate door (or make the settle a
// no-op) → every arm below reds on a beat that never settles.
describe("client: a reloaded page settles its orphaned working beats", () => {
  /** A `/history` payload whose one tool message carries a tool row persisted
   * "running" — the exact shape a mid-run reload hydrates from. */
  const historyWithRunningToolCall = (chatId: string): unknown => ({
    chat: {
      id: chatId,
      projectId: "p1",
      title: "reloaded mid-run",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      modelId: null,
      pinned: false,
    },
    messages: [
      {
        id: "m-tool-1",
        chatId,
        role: "tool",
        content: "",
        createdAt: "2026-01-01T00:00:01.000Z",
        modelEventType: null,
        runId: "run-orphan",
        metadata: null,
      },
    ],
    toolCalls: [
      {
        id: "tc-orphan-1",
        messageId: "m-tool-1",
        callId: "call-orphan",
        toolName: "create_artifact",
        input: { type: "html" },
        output: null,
        status: "running",
        durationMs: null,
        attemptCount: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ],
    metricsSnapshots: [],
    timelineRefs: [],
    page: wholeConversationPage(1),
  });

  const jsonResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  /** The fetch stub: `/history` hydrates the orphan, `/tool-calls` serves
   * whatever `rows` currently holds (mutable — the run settling server-side
   * is simulated by reassigning it). */
  function stubOrphanWire(chatId: string, rows: () => unknown[]): { calls: () => string[] } {
    const made: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      made.push(url);
      if (url.includes("/history")) return jsonResponse(historyWithRunningToolCall(chatId));
      if (url.includes("/tool-calls")) return jsonResponse(rows());
      return jsonResponse({});
    });
    return { calls: () => made };
  }

  const orphanBeat = (): { status?: string; output?: unknown; incompleteReason?: string } | undefined =>
    messages.get().find((m) => m.role === "tool")?.toolCall;

  test("hydrate with a running row → the ledger read-back settles the beat with its recorded result", async () => {
    const chatId = "chat-orphan-settle";
    currentChatId.set(chatId);
    stubOrphanWire(chatId, () => [
      {
        id: "tc-orphan-1",
        callId: "call-orphan",
        toolName: "create_artifact",
        status: "done",
        output: "the result the stream never delivered",
        durationMs: 41,
        attemptCount: 1,
        input: { type: "html", title: "t", content: "<p>whole</p>" },
      },
    ]);

    await loadChatHistory(chatId);

    // The reconcile's first read-back races the load's own tail through the
    // mocked fetch's microtasks, so the settle may land before or after the
    // load's promise resolves — either way it must have landed by here.
    await new Promise((r) => setTimeout(r, 10));

    const beat = orphanBeat();
    expect(beat?.status, "the ledger's terminal row settles the orphan").toBe("done");
    expect(beat?.output).toBe("the result the stream never delivered");
    expect(beat?.incompleteReason).toBeUndefined();
  });

  test("a terminal row with NO output settles the honest incomplete — no fabricated tool answer", async () => {
    const chatId = "chat-orphan-absent";
    currentChatId.set(chatId);
    stubOrphanWire(chatId, () => [
      { id: "tc-orphan-1", callId: "call-orphan", status: "error", output: null, durationMs: null, attemptCount: 1 },
    ]);

    await loadChatHistory(chatId);
    await new Promise((r) => setTimeout(r, 10));

    const beat = orphanBeat();
    expect(beat?.status).toBe("error");
    expect(beat?.incompleteReason, "the reason names what is known").toContain("run ended before this tool recorded a result");
    expect(messages.get().find((m) => m.role === "tool")?.toolCall?.output ?? null).toBeNull();
  });

  test("a row still running keeps the working face, and the reconcile re-reads until the run settles — no reload needed", async () => {
    vi.useFakeTimers();
    try {
      const chatId = "chat-orphan-poll";
      currentChatId.set(chatId);
      // The run is STILL LIVE at hydrate time; it settles server-side later.
      let rows: unknown[] = [
        { id: "tc-orphan-1", callId: "call-orphan", status: "running", output: null, durationMs: null, attemptCount: 1 },
      ];
      const wire = stubOrphanWire(chatId, () => rows);

      await loadChatHistory(chatId);
      await vi.advanceTimersByTimeAsync(0);
      expect(wire.calls().filter((u) => u.includes("/tool-calls")).length).toBe(1);
      expect(orphanBeat()?.status, "a live run's working face is true and stands").toBe("running");

      // The server-side run ends between polls: the rows settle.
      rows = [
        { id: "tc-orphan-1", callId: "call-orphan", status: "done", output: "settled late", durationMs: 900, attemptCount: 1 },
      ];
      await vi.advanceTimersByTimeAsync(HYDRATED_TOOL_CALL_RECONCILE_POLL_MS);

      const beat = orphanBeat();
      expect(beat?.status, "the run settling AFTER the hydrate still heals the beat").toBe("done");
      expect(beat?.output).toBe("settled late");
      const readsAfterSettle = wire.calls().filter((u) => u.includes("/tool-calls")).length;
      // Nothing left running → the reconcile stops; the poll is not eternal.
      await vi.advanceTimersByTimeAsync(HYDRATED_TOOL_CALL_RECONCILE_POLL_MS * 3);
      expect(wire.calls().filter((u) => u.includes("/tool-calls")).length).toBe(readsAfterSettle);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rows held running forever stop the poll at the wall-clock bound — the beat keeps its honest working face", async () => {
    vi.useFakeTimers();
    try {
      const chatId = "chat-orphan-bound";
      currentChatId.set(chatId);
      // The run NEVER settles server-side — the wedge the wall-clock bound
      // exists for. Every read answers "running", forever.
      const wire = stubOrphanWire(chatId, () => [
        { id: "tc-orphan-1", callId: "call-orphan", status: "running", output: null, durationMs: null, attemptCount: 1 },
      ]);

      await loadChatHistory(chatId);
      await vi.advanceTimersByTimeAsync(0);
      expect(orphanBeat()?.status, "a live run's working face is true and stands").toBe("running");

      // Past the bound the poll must stop ON ITS OWN — never an eternal
      // reader. MUTATION: drop the HYDRATED_TOOL_CALL_RECONCILE_MAX_MS
      // check (unbounded poll) and this reds on the reads still climbing.
      await vi.advanceTimersByTimeAsync(
        HYDRATED_TOOL_CALL_RECONCILE_MAX_MS + HYDRATED_TOOL_CALL_RECONCILE_POLL_MS,
      );
      const readsAtTheBound = wire.calls().filter((u) => u.includes("/tool-calls")).length;
      expect(readsAtTheBound).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(HYDRATED_TOOL_CALL_RECONCILE_POLL_MS * 3);
      expect(
        wire.calls().filter((u) => u.includes("/tool-calls")).length,
        "past the bound the /tool-calls reads are over",
      ).toBe(readsAtTheBound);

      expect(orphanBeat()?.status, "the beat keeps its honest working face — no fabricated terminal reason").toBe("running");
      expect(orphanBeat()?.incompleteReason).toBeUndefined();
    } finally {
      vi.useRealTimers();
      currentChatId.set(null);
    }
  });

  test("leaving the conversation stops the reconcile — one chat's rows never settle another's beats", async () => {
    vi.useFakeTimers();
    try {
      const chatId = "chat-orphan-leave";
      currentChatId.set(chatId);
      const wire = stubOrphanWire(chatId, () => [
        { id: "tc-orphan-1", callId: "call-orphan", status: "running", output: null, durationMs: null, attemptCount: 1 },
      ]);

      await loadChatHistory(chatId);
      await vi.advanceTimersByTimeAsync(0);
      const readsBeforeLeaving = wire.calls().filter((u) => u.includes("/tool-calls")).length;
      expect(readsBeforeLeaving).toBe(1);

      // The reader switches conversations — the reconcile must not follow.
      currentChatId.set("chat-somewhere-else");
      await vi.advanceTimersByTimeAsync(HYDRATED_TOOL_CALL_RECONCILE_POLL_MS * 3);
      expect(
        wire.calls().filter((u) => u.includes("/tool-calls")).length,
        "the poll stops with the conversation it belongs to",
      ).toBe(readsBeforeLeaving);
    } finally {
      vi.useRealTimers();
      currentChatId.set(null);
    }
  });
});

// ── THE UNANSWERED TURN (UIE-076) — the same reconcile door, text-only ────
//
// A run whose server died mid-stream leaves the assistant row its "start"
// created EMPTY forever (text is persisted at finish, never incrementally),
// with no error row and no finish reason — and the flow hides an empty
// turn, so the conversation reads as an unanswered turn with no ending
// anywhere. The tool-card heal above has no face to heal for a text-only
// run: no stranded tool card, no ◍ working beat — just the row. The door
// now runs a second read-back for exactly that shape: the run's LIVENESS
// first (the registry is the one owner; a run leaves it only after its
// final writes, so "not executing" is a write barrier), the chat's fresh
// rows second, and the row is settled with its honest ending — or healed
// with the words that were kept after all.
//
// MUTATION: skip this reconcile at the hydrate door (or drop the settle)
// → every arm below reds on a row that never gains its ending.
describe("client: a reloaded page settles its unanswered turns", () => {
  /** A `/history` payload whose tail is the drive's measured shape: a user
   * turn, then the empty assistant row a server-killed run left behind. */
  const historyWithUnansweredTurn = (chatId: string, assistant: Record<string, unknown>): unknown => ({
    chat: {
      id: chatId,
      projectId: "p1",
      title: "the 900-word story run",
      createdAt: "2026-09-02T17:50:00.000Z",
      updatedAt: "2026-09-02T17:56:00.000Z",
      modelId: null,
      pinned: false,
    },
    messages: [
      {
        id: "m-ask",
        chatId,
        role: "user",
        content: "Write a 900-word story about a lighthouse keeper",
        createdAt: "2026-09-02T17:50:00.000Z",
        modelEventType: null,
        runId: "run-died",
        metadata: null,
      },
      {
        id: "m-dead",
        chatId,
        role: "assistant",
        content: "",
        createdAt: "2026-09-02T17:50:02.000Z",
        modelEventType: "start",
        runId: "run-died",
        metadata: null,
        ...assistant,
      },
    ],
    toolCalls: [],
    metricsSnapshots: [],
    timelineRefs: [],
    page: wholeConversationPage(2),
  });

  const jsonResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  /** The fetch stub for the turn reconcile: `/history` hydrates the dead
   * row, `/run/:id/status` answers `executing`, `/chats/:id/messages`
   * serves the fresh rows — all three mutable per test so server-side
   * time can be simulated. */
  function stubUnansweredWire(
    chatId: string,
    state: {
      history: () => unknown;
      status: () => unknown;
      messages: () => unknown;
    },
  ): { calls: () => string[] } {
    const made: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      made.push(url);
      if (url.includes("/history")) return jsonResponse(state.history());
      if (url.includes("/status")) return jsonResponse(state.status());
      if (url.includes("/messages")) return jsonResponse(state.messages());
      return jsonResponse({});
    });
    return { calls: () => made };
  }

  const deadRow = (): ChatMessage | undefined =>
    messages.get().find((m) => m.id === "m-dead");

  test("a dead run's empty row settles its honest ending — no invented cause, no invented words", async () => {
    const chatId = "chat-dead-settle";
    currentChatId.set(chatId);
    const wire = stubUnansweredWire(chatId, {
      history: () => historyWithUnansweredTurn(chatId, {}),
      status: () => ({ runId: "run-died", executing: false }),
      messages: () => [
        {
          id: "m-ask",
          chatId,
          role: "user",
          content: "Write a 900-word story about a lighthouse keeper",
          createdAt: "2026-09-02T17:50:00.000Z",
          modelEventType: null,
          runId: "run-died",
          metadata: null,
        },
        {
          id: "m-dead",
          chatId,
          role: "assistant",
          content: "",
          createdAt: "2026-09-02T17:50:02.000Z",
          modelEventType: "start",
          runId: "run-died",
          metadata: null,
        },
      ],
    });

    await loadChatHistory(chatId);
    await new Promise((r) => setTimeout(r, 10));

    expect(deadRow()?.incompleteReason, "the row speaks the shared fact the record can prove").toBe(
      "the run ended before this answer was kept",
    );
    expect(deadRow()?.content, "no words are invented into the model's mouth").toBe("");
    expect(deadRow()?.runId).toBe("run-died");
    // The write-barrier order: liveness is asked BEFORE the fresh rows are
    // read, because a run leaves the registry only after its final writes —
    // so a row read that postdates the "not executing" answer is final.
    const calls = wire.calls();
    const statusAt = calls.findIndex((u) => u.includes("/status"));
    const messagesAt = calls.findIndex((u) => u.includes("/messages"));
    expect(statusAt, "the status read happens").toBeGreaterThanOrEqual(0);
    expect(messagesAt, "the fresh rows read happens").toBeGreaterThan(statusAt);
  });

  test("a run still executing settles nothing — and when it ends having KEPT its words, the re-read heals them", async () => {
    vi.useFakeTimers();
    try {
      const chatId = "chat-live-then-kept";
      currentChatId.set(chatId);
      // The run is LIVE at hydrate; the words are still in the executor's
      // memory (nothing is persisted until finish).
      let executing = true;
      let kept = false;
      const wire = stubUnansweredWire(chatId, {
        history: () =>
          historyWithUnansweredTurn(chatId, kept ? { content: "The keeper climbed the ninety-first step." } : {}),
        status: () => ({ runId: "run-died", executing }),
        messages: () =>
          kept
            ? [
                {
                  id: "m-dead",
                  chatId,
                  role: "assistant",
                  content: "The keeper climbed the ninety-first step.",
                  createdAt: "2026-09-02T17:50:02.000Z",
                  modelEventType: "finish",
                  runId: "run-died",
                  metadata: { finishReason: "stop" },
                },
              ]
            : [
                {
                  id: "m-dead",
                  chatId,
                  role: "assistant",
                  content: "",
                  createdAt: "2026-09-02T17:50:02.000Z",
                  modelEventType: "start",
                  runId: "run-died",
                  metadata: null,
                },
              ],
      });

      await loadChatHistory(chatId);
      await vi.advanceTimersByTimeAsync(0);
      expect(deadRow()?.incompleteReason, "a live run's row is still filling — no ending invented").toBeUndefined();
      expect(wire.calls().filter((u) => u.includes("/status")).length).toBe(1);

      // The run finishes server-side between polls: it leaves the registry
      // (not executing) and its finish kept the words.
      executing = false;
      kept = true;
      await vi.advanceTimersByTimeAsync(HYDRATED_TOOL_CALL_RECONCILE_POLL_MS);

      expect(deadRow()?.content, "the kept words render — the re-read heals them").toBe(
        "The keeper climbed the ninety-first step.",
      );
      expect(
        deadRow()?.incompleteReason,
        "a settled face on a kept answer would be the lie the fresh read exists to prevent",
      ).toBeUndefined();
      // Nothing left unanswered → the poll is not eternal.
      const readsAfterHeal = wire.calls().filter((u) => u.includes("/status")).length;
      await vi.advanceTimersByTimeAsync(HYDRATED_TOOL_CALL_RECONCILE_POLL_MS * 3);
      expect(wire.calls().filter((u) => u.includes("/status")).length).toBe(readsAfterHeal);
    } finally {
      vi.useRealTimers();
      currentChatId.set(null);
    }
  });

  test("the page's OWN live run never reaches the reconcile — its stream is writing the row", async () => {
    const chatId = "chat-own-live-run";
    currentChatId.set(chatId);
    stubUnansweredWire(chatId, {
      history: () => historyWithUnansweredTurn(chatId, {}),
      status: () => ({ runId: "run-died", executing: true }),
      messages: () => [],
    });
    // The page's own run, live: the sink row belongs to the SSE stream, not
    // to the orphan reconcile.
    setRun({
      runId: "run-died",
      status: "running",
      startedAt: Date.now(),
      modelLabel: "google/gemma-4-31b-it",
      projectId: "p1",
    });

    await loadChatHistory(chatId);
    await new Promise((r) => setTimeout(r, 10));

    expect(deadRow()?.incompleteReason, "the stream owns the row — the orphan reconcile leaves it alone").toBeUndefined();
    const statusReads = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("/status"),
    ).length;
    expect(statusReads, "the own-run skip happens before any fetch fires").toBe(0);
  });

  test("leaving the conversation stops the turn reconcile — one chat's rows never settle another's", async () => {
    vi.useFakeTimers();
    try {
      const chatId = "chat-dead-leave";
      currentChatId.set(chatId);
      const wire = stubUnansweredWire(chatId, {
        history: () => historyWithUnansweredTurn(chatId, {}),
        status: () => ({ runId: "run-died", executing: true }),
        messages: () => [],
      });

      await loadChatHistory(chatId);
      await vi.advanceTimersByTimeAsync(0);
      const readsBeforeLeaving = wire.calls().filter((u) => u.includes("/status")).length;
      expect(readsBeforeLeaving).toBe(1);

      // The reader switches conversations — the reconcile must not follow.
      currentChatId.set("chat-somewhere-else");
      await vi.advanceTimersByTimeAsync(HYDRATED_TOOL_CALL_RECONCILE_POLL_MS * 3);
      expect(
        wire.calls().filter((u) => u.includes("/status")).length,
        "the poll stops with the conversation it belongs to",
      ).toBe(readsBeforeLeaving);
    } finally {
      vi.useRealTimers();
      currentChatId.set(null);
    }
  });
});

describe("client: beginChatRun error path", () => {
  test("beginChatRun failure pushes error to errors store and rethrows", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    // startRun's fetch fails
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ message: "server down" }),
    } as Response);

    await expect(beginChatRun("p1", "hello")).rejects.toMatchObject({
      name: "ClientError",
    });
    expect(errors.get().length).toBeGreaterThanOrEqual(1);
    expect(errors.get()[0]!.kind).toBe("run_start");
  });
});

/**
 * ── THE LIVENESS DIAGNOSIS ─────────────────────────────────────────────────
 *
 * `es.onerror` fires with no status, no headers and no body, and two
 * completely different situations arrive at it identically:
 *
 *   the API is DOWN     → retry fast; that is what makes recovery instant.
 *   the API REFUSED us  → 429 from its own connection cap. Retrying fast
 *                         cannot succeed, and the retries are what made the
 *                         condition permanent — observed in the browser as
 *                         four `GET /api/live` 429s a second, forever, with
 *                         the cockpit blocked behind "The harness API is not
 *                         answering" over a server that answered everything.
 *
 * This is the function that tells them apart, so the cadence is chosen from
 * MEASURED evidence rather than from a guess. The classification rule is the
 * connection owner's own: a response carrying the identity header means the
 * API answered, whatever its status.
 */
describe("client: diagnoseLivenessConnection — why the stream would not open", () => {
  function respondWith(
    status: number,
    headers: Record<string, string>,
  ): { calls: { url: unknown; init: { signal?: AbortSignal } }[] } {
    const calls: { url: unknown; init: { signal?: AbortSignal } }[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: unknown, init: { signal?: AbortSignal }) => {
      calls.push({ url, init });
      return Promise.resolve({
        status,
        headers: new Headers(headers),
      } as Response);
    });
    return { calls };
  }

  test("a 429 from the API is a REFUSAL, with the server's own Retry-After", async () => {
    respondWith(429, { [API_IDENTITY_HEADER]: API_IDENTITY_VALUE, "Retry-After": "5" });
    const d = await diagnoseLivenessConnection();
    expect(d.outcome).toBe("refused");
    if (d.outcome === "refused") expect(d.retryAfterMs).toBe(5_000);
  });

  test("a refusal that names no interval falls back to the STATED default, never to zero", async () => {
    respondWith(429, { [API_IDENTITY_HEADER]: API_IDENTITY_VALUE });
    const d = await diagnoseLivenessConnection();
    expect(d.outcome).toBe("refused");
    if (d.outcome === "refused") {
      expect(d.retryAfterMs).toBe(LIVE_STREAM_REFUSED_RETRY_MS);
      expect(d.retryAfterMs).toBeGreaterThan(0);
    }
  });

  test("a garbage Retry-After does not become an instant retry", async () => {
    // The loop this whole change removes is "retry a refusal immediately".
    // A header that does not parse must not produce one.
    for (const raw of ["", "0", "-3", "Wed, 21 Oct 2026 07:28:00 GMT", "soon"]) {
      respondWith(429, { [API_IDENTITY_HEADER]: API_IDENTITY_VALUE, "Retry-After": raw });
      const d = await diagnoseLivenessConnection();
      if (d.outcome === "refused") {
        expect(d.retryAfterMs, `Retry-After: ${raw}`).toBe(LIVE_STREAM_REFUSED_RETRY_MS);
      }
    }
  });

  test("an UNSIGNED 502 is an outage — something in front of the API answered", async () => {
    // Exactly what the Vite dev proxy sends while the API is stopped.
    respondWith(502, { "Content-Type": "text/plain" });
    const d = await diagnoseLivenessConnection();
    expect(d.outcome).toBe("unreached");
  });

  test("a SIGNED 502 is NOT an outage — the API said it (a model provider failed)", async () => {
    respondWith(502, { [API_IDENTITY_HEADER]: API_IDENTITY_VALUE });
    const d = await diagnoseLivenessConnection();
    expect(d.outcome).toBe("answered");
  });

  test("a rejected fetch is an outage, with a MEASURED elapsed", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const d = await diagnoseLivenessConnection();
    expect(d.outcome).toBe("unreached");
    if (d.outcome === "unreached") expect(d.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("a 200 answers — and the probe does NOT hold the slot it is asking about", async () => {
    // A 200 here is a real event stream. Holding it would consume one of the
    // very slots the diagnosis exists to get back.
    const { calls } = respondWith(200, { [API_IDENTITY_HEADER]: API_IDENTITY_VALUE });
    const d = await diagnoseLivenessConnection();
    expect(d.outcome).toBe("answered");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(LIVE_STREAM_PATH);
    expect(
      calls[0]!.init.signal?.aborted,
      "the probe response must be released the moment its headers arrive",
    ).toBe(true);
  });
});

describe("client: one metrics poll, one complete record", () => {
  test("a response that omits the system/token halves records them absent, never the previous poll", async () => {
    resetMetrics();
    // A real previous poll left both halves in the stores. The next response
    // carries neither field; the old caller passed `undefined` through and
    // the record either kept these values or crashed reading `.capturedAt`.
    setSystemMetrics({
      capturedAt: "previous", processUptimeMs: 1, osUptimeMs: 1, cpuCount: 1, loadAverage1m: 0.1,
      memory: { rss: 1, heapUsed: 2, heapTotal: 3, external: 0, arrayBuffers: 0, systemFree: 0, systemTotal: 0 },
      eventLoop: { utilization: 0.1, delayMin: 0, delayMax: 0, delayMean: 0, delayStddev: 0 },
    });
    setTokenThroughput({ inputTokens: 1, outputTokens: 2, totalTokens: 3, tokensPerSecond: 4 });
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        snapshot: {
          snapshotId: "after-absent", entryCount: 0, totalCallCount: 1,
          totalErrorCount: 0, totalCancellationCount: 0, entries: [],
        },
      }),
    });

    await getMetrics();

    expect(systemMetrics.get()).toBeNull();
    expect(tokenThroughput.get()).toBeNull();
  });
});
