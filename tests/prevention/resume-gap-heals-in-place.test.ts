// @vitest-environment node
/**
 * THE RESUME-GAP DEAD-END, ENDED IN PLACE.
 *
 * A `replay_gap` whose reason is `resume_point_ahead_of_run` means the run is
 * COMPLETE and SAVED — only this connection's idea of its position was wrong.
 * The client used to append "Reload to see the saved conversation" and stop:
 * a manual remedy for something the client already knows how to do. Now the
 * gap invokes the SAME history read every other path uses (`loadChatHistory`,
 * which hydrates the transcript stores where they stand) and the reload
 * sentence survives only as the fallback after that read failed.
 *
 * Driven through the REAL entry point (`openRunStream` + the mock
 * EventSource), never by calling a handler directly — a guard that drove a
 * helper would prove the helper and say nothing about whether the stream
 * invokes it. The evidence asserted is evidence only the new path can
 * produce: the history request on the wire, and the healed transcript.
 *
 * The negative direction is deny-by-default: a dropped-frames gap (frames
 * genuinely gone mid-run) must NOT trigger a reload — hydrating there would
 * replace a live transcript mid-run for a loss the notice already states.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SSE_EVENT_TYPES } from "../../shared/constants.ts";
import { openRunStream } from "../../src/client";
import { WITHHELD_ERROR_MESSAGE, withheldTerminalFrame } from "../../server/router/sse.ts";
import { messages, clearMessages } from "../../src/state/chat-messages";
import { errors } from "../../src/state/errors";
import { currentChatId, setChats } from "../../src/state/chats";

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

/** An empty-but-complete saved conversation, in the history wire shape. */
const EMPTY_HISTORY = {
  chat: { id: "chat-1", title: "the saved one", modelId: null, projectId: "p1" },
  messages: [],
  toolCalls: [],
  timelineRefs: [],
  metricsSnapshots: [],
  page: { hasOlder: false, olderCursor: null, messageCount: 0 },
};

const originalEventSource = globalThis.EventSource;
const realFetch = globalThis.fetch;

function historyResponse(): Response {
  return new Response(JSON.stringify(EMPTY_HISTORY), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function emitAheadGap(): MockEventSource {
  openRunStream("run-1", {});
  const es = MockEventSource.lastInstance!;
  es.emit(SSE_EVENT_TYPES.replayGap, {
    runId: "run-1",
    reason: "resume_point_ahead_of_run",
    resumedFrom: 40,
  });
  return es;
}

beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource =
    MockEventSource as unknown as typeof EventSource;
  MockEventSource.lastInstance = null;
  clearMessages();
  currentChatId.set(null);
  setChats([]);
});

afterEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = originalEventSource;
  globalThis.fetch = realFetch;
  currentChatId.set(null);
  clearMessages();
  vi.restoreAllMocks();
});

describe("an ahead-of-run gap reloads the saved conversation in place", () => {
  test("the history read fires for the open conversation and the transcript heals, with no page navigation", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return historyResponse();
    }) as typeof fetch;
    currentChatId.set("chat-1");

    emitAheadGap();
    // The notice written at the moment of the gap states what is HAPPENING —
    // an in-place reload — never the manual remedy.
    const interim = messages.get().find((m) => m.role === "error");
    expect(interim?.content).toContain("reloaded in place");
    expect(interim?.content).not.toContain("Reload to see");

    await waitFor(() => urls.some((u) => u.includes("/chats/chat-1/history")));
    // The hydrate REPLACED the transcript with the saved conversation — the
    // healed state, which only the new path can produce.
    await waitFor(() => messages.get().length === 0);
  });

  test("a failed in-place reload falls back to the honest manual sentence", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    currentChatId.set("chat-1");

    emitAheadGap();
    await waitFor(() =>
      messages.get().some((m) => m.role === "error" && m.content.includes("could not be reloaded")),
    );
    const fallback = messages
      .get()
      .find((m) => m.role === "error" && m.content.includes("could not be reloaded"));
    expect(fallback!.content).toContain("Reload the page");
  });

  test("with no open conversation there is nothing to reload into, and the sentence says so", async () => {
    const mock = vi.fn(async () => historyResponse());
    globalThis.fetch = mock as typeof fetch;

    emitAheadGap();
    expect(messages.get().some((m) => m.content.includes("Reload to see"))).toBe(true);
    // No fabricated read for a conversation nobody has open.
    await new Promise((r) => setTimeout(r, 50));
    expect(mock).not.toHaveBeenCalled();
  });

  test("a dropped-frames gap is a stated loss, never a mid-run reload", async () => {
    const mock = vi.fn(async () => historyResponse());
    globalThis.fetch = mock as typeof fetch;
    currentChatId.set("chat-1");

    openRunStream("run-1", {});
    MockEventSource.lastInstance!.emit(SSE_EVENT_TYPES.replayGap, {
      runId: "run-1",
      droppedThroughSequence: 12,
      resumedFrom: 4,
    });
    expect(
      messages.get().some((m) => m.role === "error" && m.content.includes("8 updates were dropped")),
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(mock).not.toHaveBeenCalled();
  });

  test("a WITHHELD frame (frame_unredactable) is said as withheld, never as a loss while away, and reloads nothing (wf1b2-design S-3)", async () => {
    const mock = vi.fn(async () => historyResponse());
    globalThis.fetch = mock as typeof fetch;
    currentChatId.set("chat-1");

    openRunStream("run-1", {});
    MockEventSource.lastInstance!.emit(SSE_EVENT_TYPES.replayGap, {
      runId: "run-1",
      droppedThroughSequence: 7,
      resumedFrom: 6,
      reason: "frame_unredactable",
    });
    const errors = messages.get().filter((m) => m.role === "error").map((m) => m.content);
    expect(errors.some((content) => content.includes("could not be shown safely, so it was withheld"))).toBe(true);
    expect(errors.some((content) => content.includes("dropped while the connection was away")), "a withheld frame is not a loss while away").toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(mock).not.toHaveBeenCalled();
  });

  test("a withheld TERMINAL error frame ends the run with its own message, never as a violated error contract (WF-1b3b design M3)", async () => {
    globalThis.fetch = vi.fn(async () => historyResponse()) as typeof fetch;
    currentChatId.set("chat-1");
    openRunStream("run-1", {});
    const source = MockEventSource.lastInstance!;
    source.emit(SSE_EVENT_TYPES.error, withheldTerminalFrame(SSE_EVENT_TYPES.error, { runId: "run-1" }, { code: "run_failed" }));
    const reported = errors.get().filter((entry) => entry.kind === "stream");
    expect(reported.some((entry) => entry.code === "run_failed" && entry.message === WITHHELD_ERROR_MESSAGE), "the withheld error is reported with its code and its own message").toBe(true);
    expect(reported.some((entry) => entry.code === "malformed"), "a withheld error is not a violated error contract").toBe(false);
    expect(source.readyState, "the terminal frame closes the stream").toBe(MockEventSource.CLOSED);
  });
});
