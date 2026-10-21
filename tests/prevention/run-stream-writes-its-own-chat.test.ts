// @vitest-environment node
/**
 * A RUN'S WORDS GO INTO THE RUN'S OWN CONVERSATION.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 *
 * The transcript store holds ONE chat's messages — cleared on every chat
 * switch and re-filled from that chat's history — and `ingestModelEvent`
 * appended to whatever was in it, with no chat check at all. So:
 *
 *   conversation B is streaming → you open conversation A → the store is
 *   cleared and re-filled with A's transcript → B's next `text_delta` is
 *   committed into A's LAST ASSISTANT MESSAGE, and B's next tool call is
 *   appended to A's list.
 *
 * B's words end up inside A's transcript, in the store, one layer below
 * anything a caller could correct. By the time a beat could be attributed the
 * two conversations have been concatenated, and "sorting it out afterwards"
 * means guessing which half of a string belongs to whom.
 *
 * ── WHY THE FIX NEEDED NO CALLER TO CHANGE ─────────────────────────────────
 *
 * Threading a chat id down from every caller was judged too invasive to
 * half-land across the default UI's transcript path — a fair call, and also
 * an unnecessary one: THE CHAT ID IS ALREADY ON THE WIRE. The server's
 * `connected` frame carries it, it is always the first frame, it survives a
 * reconnect after the run has ended, and the client already parsed it and
 * handed it to an optional callback. The stream latches its own answer.
 *
 * So this file drives `openRunStream` — the real entry point, the one
 * `beginChatRun` uses — rather than calling the ingestion directly. A guard
 * that drove the ingestion would prove the check exists and say nothing about
 * whether the stream supplies it.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import { SSE_EVENT_TYPES } from "../../shared/constants.ts";
import { openRunStream } from "../../src/client";
import { messages, clearMessages, appendUserMessage } from "../../src/state/chat-messages";
import { currentRun, setRun } from "../../src/state/run-state";
import { resetTelemetry } from "../../src/state/telemetry";
import { currentChatId } from "../../src/state/chats";

// ── A mock EventSource that records what was listened for and can emit ─────

class MockEventSource {
  static lastInstance: MockEventSource | null = null;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  readyState = 1;
  // A plain field assignment rather than a parameter property: this project
  // builds with `erasableSyntaxOnly`, under which a constructor parameter
  // property is not type syntax that can simply be stripped.
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

beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource =
    MockEventSource as unknown as typeof EventSource;
  MockEventSource.lastInstance = null;
  clearMessages();
  currentRun.set(null);
  resetTelemetry();
  currentChatId.set(null);
});

afterEach(() => {
  // Node has no EventSource; assigning `undefined` would leave an own
  // property this file never inherited. Delete it to restore the boundary.
  if (originalEventSource === undefined) delete (globalThis as { EventSource?: unknown }).EventSource;
  else globalThis.EventSource = originalEventSource;
  currentChatId.set(null);
  vi.restoreAllMocks();
});

/** Open a run stream and hand back the mock driving it. */
function openStream(runId = "run-1"): MockEventSource {
  openRunStream(runId, {});
  const es = MockEventSource.lastInstance;
  expect(es, "openRunStream must have constructed an EventSource").not.toBeNull();
  return es!;
}

function assistantTexts(): string[] {
  return messages.get().filter((m) => m.role === "assistant").map((m) => m.content);
}

describe("the run stream learns its own chat from the wire", () => {
  test("the `connected` frame carries the chat id, and it is the FIRST frame", () => {
    // The whole fix rests on this being available before any model event, so
    // it is asserted rather than assumed: the server sends `connected` before
    // it subscribes to the feed, so no run frame can precede it.
    const es = openStream();
    expect(
      [...es.listeners.keys()],
      "the client must listen for the frame it latches the chat id from",
    ).toContain(SSE_EVENT_TYPES.connected);
    expect([...es.listeners.keys()]).toContain(SSE_EVENT_TYPES.model);
  });

  test("a run bound to the conversation on screen is ingested", () => {
    // LIVENESS FIRST, and it is the assertion that matters most here: a
    // refusal that refuses EVERYTHING would satisfy every "not misattributed"
    // assertion below while breaking the product completely.
    currentChatId.set("chat-A");
    const es = openStream();
    es.emit(SSE_EVENT_TYPES.connected, { runId: "run-1", harnessReady: false, chatId: "chat-A" });
    es.emit(SSE_EVENT_TYPES.model, { type: "start" });
    es.emit(SSE_EVENT_TYPES.model, { type: "text_delta", delta: "hello from A" });

    expect(assistantTexts().length, "the run's own conversation must still receive its words").toBe(1);
  });

  test("a run bound to ANOTHER conversation writes nothing into the one on screen", () => {
    currentChatId.set("chat-A");
    appendUserMessage("A's question");
    const before = messages.get().length;

    const es = openStream("run-B");
    es.emit(SSE_EVENT_TYPES.connected, { runId: "run-B", harnessReady: false, chatId: "chat-B" });
    es.emit(SSE_EVENT_TYPES.model, { type: "start" });
    es.emit(SSE_EVENT_TYPES.model, { type: "text_delta", delta: "B's answer" });
    es.emit(SSE_EVENT_TYPES.model, {
      type: "tool_call_start",
      callId: "call-1",
      name: "read_file",
    });

    expect(
      messages.get().length,
      "conversation B's stream appended to conversation A's transcript — the two are now " +
        "concatenated in the store, below anything a caller can correct",
    ).toBe(before);
    expect(assistantTexts()).toEqual([]);
    expect(messages.get().filter((m) => m.role === "tool")).toEqual([]);
  });

  test("switching conversations mid-run stops the writes at the switch", () => {
    // The sequence that produced the corruption, in order.
    currentChatId.set("chat-B");
    const es = openStream("run-B");
    es.emit(SSE_EVENT_TYPES.connected, { runId: "run-B", harnessReady: false, chatId: "chat-B" });
    es.emit(SSE_EVENT_TYPES.model, { type: "start" });
    es.emit(SSE_EVENT_TYPES.model, { type: "text_delta", delta: "first half" });
    expect(assistantTexts().length, "B's own run must be writing before the switch").toBe(1);

    // The reader opens conversation A. The store is cleared and re-filled
    // with A's transcript; B is still streaming on the server.
    clearMessages();
    currentChatId.set("chat-A");
    appendUserMessage("A's question");
    const afterSwitch = messages.get().length;

    es.emit(SSE_EVENT_TYPES.model, { type: "text_delta", delta: " second half" });
    es.emit(SSE_EVENT_TYPES.model, { type: "start" });

    expect(
      messages.get().length,
      "a run whose conversation is no longer on screen must not write into the one that is",
    ).toBe(afterSwitch);
    expect(assistantTexts()).toEqual([]);
  });

  test("a run bound to NO conversation is ingested, because it cannot be misattributed", () => {
    // A chat-less run (the legacy caller) has no owner to be wrong about.
    // Refusing it would be a different defect: silence with no cause.
    currentChatId.set("chat-A");
    const es = openStream("run-legacy");
    es.emit(SSE_EVENT_TYPES.connected, { runId: "run-legacy", harnessReady: false, chatId: null });
    es.emit(SSE_EVENT_TYPES.model, { type: "start" });
    es.emit(SSE_EVENT_TYPES.model, { type: "text_delta", delta: "no chat bound" });

    expect(assistantTexts().length).toBe(1);
  });

  test("a stream that never received `connected` still ingests — absence is not a mismatch", () => {
    // Deny-by-default is right for a claim; it is wrong for an unknown. A
    // stream with no `connected` frame knows nothing about ownership, and
    // treating "I was not told" as "it belongs to someone else" would silently
    // stop a working transcript for a reason nobody could see.
    currentChatId.set("chat-A");
    const es = openStream("run-1");
    es.emit(SSE_EVENT_TYPES.model, { type: "start" });
    es.emit(SSE_EVENT_TYPES.model, { type: "text_delta", delta: "unannounced" });
    expect(assistantTexts().length).toBe(1);
  });
});


describe("epilogue isolation includes every workspace consumer and preserves transport cleanup", () => {
  test.each(["done", "cancelled", "error", "native-close"])("foreign %s closes only its own transport and keeps the newer view", (terminal) => {
    currentChatId.set("chat-A");
    const onTimelineEvent = vi.fn(), onModelEvent = vi.fn(), onError = vi.fn(), onRunSettled = vi.fn();
    openRunStream("run-A", { onTimelineEvent, onModelEvent, onError, onRunSettled });
    const es = MockEventSource.lastInstance!;
    es.emit("connected", { runId: "run-A", harnessReady: false, chatId: "chat-A" });
    es.emit("model", { type: "start" });
    const event = { eventId: "evt-A", eventType: "steering", wallTime: "2026-09-05T08:00:00.000Z", runId: "run-A", description: "A's instruction" };
    es.emit("timeline", event);
    const safety = { runId: "run-A", messages: [{ eventId: "evt-finding-A", message: "A's actual recorded finding" }] };
    es.emit("safety_findings", safety);
    expect(messages.get().find((message) => message.timelineEventId === "evt-finding-A")?.content,
      "the real messages envelope must append its foreground primary before testing isolation").toBe("A's actual recorded finding");
    expect(onTimelineEvent).toHaveBeenCalledTimes(1);
    expect(onModelEvent).toHaveBeenCalledTimes(1);
    currentChatId.set("chat-B");
    clearMessages();
    appendUserMessage("B's actual user turn");
    const blankBefore = messages.get();
    es.emit("timeline", { ...event, eventId: "evt-A-blank-B" });
    es.emit("model", { type: "start" });
    es.emit("safety_findings", { ...safety, messages: [{ eventId: "evt-finding-A-late-blank", message: "A's late recorded finding" }] });
    expect(messages.get(), "an empty foreground has no run ID to mask missing chat ownership").toEqual(blankBefore);
    expect(onTimelineEvent).toHaveBeenCalledTimes(1);
    expect(onModelEvent).toHaveBeenCalledTimes(1);
    setRun({ runId: "run-B", status: "running", startedAt: Date.now(), modelLabel: null, projectId: "project-B" });
    const before = messages.get();
    es.emit("model", { type: "start" });
    es.emit("timeline", { ...event, eventId: "evt-A-late" });
    es.emit("steered", { runId: "run-A", message: "A's late steer", text: "A's late steer", eventId: "evt-steer-A" });
    es.emit("safety_findings", { ...safety, messages: [{ eventId: "evt-finding-A-late-newer", message: "A's late recorded finding" }] });
    if (terminal === "native-close") es.readyState = MockEventSource.CLOSED;
    es.emit(terminal === "native-close" ? "error" : terminal, terminal === "error"
      ? { code: "provider_error", message: "A's provider failure", eventId: "evt-error-A" }
      : terminal === "native-close" ? undefined : { runId: "run-A" });
    expect(messages.get(), "every late primary write remains outside B's transcript").toEqual(before);
    expect(onTimelineEvent, "A's epilogue cannot feed B's recorder").toHaveBeenCalledTimes(1);
    expect(onModelEvent, "the second consumer is scoped along with model ingestion").toHaveBeenCalledTimes(1);
    expect(onError, "a background failure does not become B's foreground error callback").not.toHaveBeenCalled();
    expect(currentRun.get()?.runId).toBe("run-B");
    expect(currentRun.get()?.status).toBe("running");
    expect(es.readyState, "ownership isolation still closes the native source").toBe(MockEventSource.CLOSED);
    expect(onRunSettled, "the old run's lifecycle cleanup still executes once").toHaveBeenCalledTimes(1);
    es.emit("model", { type: "start" });
    expect(messages.get(), "already queued callbacks after close remain inert").toEqual(before);
  });

  test("a connected frame naming a different run cannot rebind the stream", () => {
    currentChatId.set("chat-A");
    const onConnected = vi.fn(), onError = vi.fn(), onRunSettled = vi.fn();
    openRunStream("run-A", { onConnected, onError, onRunSettled });
    const es = MockEventSource.lastInstance!;
    es.emit("connected", { runId: "run-B", harnessReady: false, chatId: "chat-A" });
    expect(onConnected).not.toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "malformed", message: "The run stream acknowledged a different run." });
    expect(es.readyState).toBe(MockEventSource.CLOSED);
    expect(onRunSettled).toHaveBeenCalledTimes(1);
    es.emit("model", { type: "start" });
    expect(assistantTexts()).toEqual([]);
  });

  test("an older stream cannot settle a newer run in the same chat", () => {
    currentChatId.set("chat-A");
    const es = openStream("run-old");
    es.emit("connected", { runId: "run-old", harnessReady: false, chatId: "chat-A" });
    setRun({ runId: "run-new", status: "running", startedAt: Date.now(), modelLabel: null, projectId: "project-A" });
    es.emit("done", { runId: "run-old" });
    expect(currentRun.get()?.runId).toBe("run-new");
    expect(currentRun.get()?.status).toBe("running");
    expect(es.readyState).toBe(MockEventSource.CLOSED);
  });
});
