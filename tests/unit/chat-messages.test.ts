// @vitest-environment node
import { describe, test, expect, beforeEach, vi } from "vitest";

import {
  messages,
  isStreaming,
  messageCount,
  lastMessage,
  appendUserMessage,
  appendAssistantMessage,
  appendToolCall,
  appendErrorMessage,
  appendEventMessage,
  appendMessage,
  updateLastMessage,
  updateToolCallById,
  setStreaming,
  clearMessages,
  streamingTail,
  isUnansweredAssistantRow,
  applyReconciledAssistantRows,
  type ChatMessage,
} from "../../src/state/chat-messages";
import { formatErrorMessage } from "../../src/data/error-messages";
import { EVENT_KINDS } from "../../shared/event-types.ts";

describe("chat-messages store", () => {
  beforeEach(() => clearMessages());

  test("missing and unchanged tool updates retain the transcript; matching legacy and run rows update together", () => {
    const base: ChatMessage[] = Array.from({ length: 10_000 }, (_, i) => ({ id: `history-${i}`, role: "assistant", content: `turn ${i}`, timestamp: i }));
    const tool = { id: "shared", name: "read", input: null, output: null, status: "running" as const, startedAt: 1 };
    base.push({ id: "legacy", role: "tool", content: "", toolCall: tool, timestamp: 1 });
    base.push({ id: "owned", role: "tool", content: "", toolCall: tool, runId: "owned", timestamp: 1 });
    base.push({ id: "other", role: "tool", content: "", toolCall: tool, runId: "other", timestamp: 1 });
    messages.set(base);
    const update = vi.fn(call => ({ ...call, output: "done" }));
    const publish = vi.fn(); const off = messages.listen(publish);
    const map = vi.spyOn(base, "map"); const slice = vi.spyOn(base, "slice");
    try {
      updateToolCallById("missing", update, "owned");
      expect(update).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
      expect(map).not.toHaveBeenCalled(); expect(slice).not.toHaveBeenCalled();
      expect(messages.get()).toBe(base);
      updateToolCallById("shared", call => call, "owned");
      expect(publish).not.toHaveBeenCalled(); expect(slice).not.toHaveBeenCalled();
      updateToolCallById("shared", update, "owned");
      expect(update).toHaveBeenCalledTimes(2); expect(publish).toHaveBeenCalledTimes(1);
      const next = messages.get();
      expect(next[0]).toBe(base[0]);
      expect(next.at(-3)?.toolCall?.output).toBe("done");
      expect(next.at(-2)?.toolCall?.output).toBe("done");
      expect(next.at(-1)).toBe(base.at(-1));
      expect(base.at(-3)?.toolCall?.output).toBeNull();
    } finally { off(); map.mockRestore(); slice.mockRestore(); }
  });

  test("appendUserMessage adds a user message and returns its id", () => {
    const id = appendUserMessage("hello");
    const list = messages.get();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(id);
    expect(list[0]!.role).toBe("user");
    expect(list[0]!.content).toBe("hello");
    expect(messageCount.get()).toBe(1);
  });

  test("appendAssistantMessage omits modelEvent when not provided", () => {
    const id = appendAssistantMessage("hi");
    const msg = messages.get()[0]!;
    expect(msg.id).toBe(id);
    expect(msg.role).toBe("assistant");
    expect("modelEvent" in msg).toBe(false);
    expect(msg.toolCall).toBeUndefined();
  });

  test("appendToolCall creates a tool message with the toolCall view", () => {
    const id = appendToolCall({
      name: "read_file",
      input: { path: "/a" },
      output: null,
      status: "running",
      startedAt: 1000,
    });
    const msg = messages.get()[0]!;
    expect(msg.id).toBe(id);
    expect(msg.role).toBe("tool");
    expect(msg.toolCall?.name).toBe("read_file");
    expect(msg.toolCall?.status).toBe("running");
    expect(msg.toolCall?.endedAt).toBeUndefined();
    appendToolCall({ name: "read_file", input: null, output: null, status: "running", startedAt: 1000 });
    expect(messages.get(), "anonymous observations cannot infer shared identity").toHaveLength(2);
    for (const callId of ["native-a", "native-b"]) {
      const identity = { messageId: `row-${callId}`, runId: "run-owned", event: { type: "tool_call_start" as const, sequence: 1, protocol: "openai-responses" as const, outputIndex: 0, callId, name: "read_file" } };
      const call = { id: callId, name: "read_file", input: null, output: null, status: "running" as const, startedAt: 1000 };
      appendToolCall(call, "same words", identity);
      appendToolCall(call, "same words", identity);
    }
    expect(messages.get().map((message) => message.id).slice(2), "same-word calls join only their own canonical IDs").toEqual(["row-native-a", "row-native-b"]);
    const repeatedCall = { id: "native-a", name: "read_file", input: null, output: null, status: "running" as const, startedAt: 1000 };
    appendToolCall(repeatedCall, "same words", { messageId: "other-run-row", runId: "other-run", event: { type: "tool_call_start", outputIndex: 0, sequence: 1, protocol: "openai-responses", callId: "native-a", name: "read_file" } });
    updateToolCallById("native-a", (call) => ({ ...call, output: "other run result", status: "done" }), "other-run");
    expect(messages.get().find((message) => message.id === "row-native-a")!.toolCall!.status).toBe("running");
    expect(messages.get().find((message) => message.id === "other-run-row")!.toolCall!.output).toBe("other run result");
  });

  test("appendErrorMessage stores the message without code prefix", () => {
    appendErrorMessage("something broke");
    const msg = messages.get()[0]!;
    expect(msg.role).toBe("error");
    expect(msg.content).toBe("something broke");
  });

  test("updateLastMessage replaces only the last message", () => {
    appendUserMessage("a");
    appendAssistantMessage("b");
    updateLastMessage((m) => ({ ...m, content: m.content + "!" }));
    const list = messages.get();
    expect(list[0]!.content).toBe("a");
    expect(list[1]!.content).toBe("b!");
    expect(lastMessage.get()?.content).toBe("b!");
  });

  test("updateLastMessage is a no-op when the list is empty", () => {
    expect(() => updateLastMessage((m) => m)).not.toThrow();
    expect(messages.get()).toHaveLength(0);
  });

  test("ids are unique across appends", () => {
    const a = appendUserMessage("a");
    const b = appendUserMessage("b");
    expect(a).not.toBe(b);
  });

  test("isStreaming toggles and clearMessages resets streaming", () => {
    setStreaming(true);
    expect(isStreaming.get()).toBe(true);
    clearMessages();
    expect(isStreaming.get()).toBe(false);
    expect(messages.get()).toHaveLength(0);
  });
});

// Recorded equality is independent of wording, position and display projection.

describe("inline event twins — the ledger replay joins, a real repeat does not", () => {
  beforeEach(() => clearMessages());

  for (const kind of EVENT_KINDS) {
    for (const separated of [false, true]) {
      test(`${kind}: distinct recorded incidents survive identical words (${separated ? "separated" : "adjacent"})`, () => {
        const content = "the same observed finding";
        const first = appendEventMessage(kind, content, "incident-a");
        if (separated) appendAssistantMessage("a later turn");
        const second = appendEventMessage(kind, content, "incident-b");
        expect(second, "distinct canonical IDs must own distinct beats").not.toBe(first);
        expect(appendEventMessage(kind, content, "incident-a"), "replay must return its own older beat").toBe(first);
        expect(messages.get().filter((m) => m.timelineEventId !== undefined).map((m) => m.timelineEventId)).toEqual(["incident-a", "incident-b"]);
      });
    }
    test(`${kind}: exact recorded identity outranks anonymous and differently addressed twins`, () => {
      const first = appendEventMessage(kind, "repeated words", "incident-a");
      appendMessage({ id: "anonymous", role: "event", eventKind: kind, content: "repeated words", timestamp: Date.now() });
      appendMessage({ id: "other", role: "event", eventKind: kind, content: "repeated words", timestamp: Date.now(), timelineEventId: "incident-b" });
      expect(appendEventMessage(kind, "repeated words", "incident-a"), "the exact incident wins, regardless of newer twins").toBe(first);
      expect(messages.get().find((m) => m.id === "anonymous")!.timelineEventId).toBeUndefined();
      expect(messages.get().filter((m) => m.timelineEventId === "incident-a")).toHaveLength(1);
    });
    test(`${kind}: anonymous wording never proves a recorded incident's identity`, () => {
      const anonymous = appendEventMessage(kind, "repeated words");
      const recorded = appendEventMessage(kind, "repeated words", "incident-a");
      expect(recorded, "even one anonymous twin cannot establish incident identity").not.toBe(anonymous);
      expect(messages.get().find((m) => m.id === anonymous)!.timelineEventId).toBeUndefined();
    });
  }

  const GATE_SENTENCE =
    "Tool 'create_artifact' arguments failed schema validation: missing required field 'type'";
  const STEER_SENTENCE = "Steered — new turn starting (0 queued)";

  test("a replayed gate block joins its live beat and retains the canonical ID", () => {
    const liveId = appendEventMessage("validation", GATE_SENTENCE, "evt-ledger-1");
    appendAssistantMessage("the answer streams after the block"); // beats land between
    const replayId = appendEventMessage("validation", GATE_SENTENCE, "evt-ledger-1");
    expect(replayId, "the replay joins the live beat, never a twin").toBe(liveId);
    expect(messages.get().filter((m) => m.role === "event" && m.content === GATE_SENTENCE)).toHaveLength(1);
    const joined = messages.get().find((m) => m.id === liveId)!;
    expect(joined.timelineEventId, "the live beat retains its canonical address").toBe("evt-ledger-1");
  });

  test("a replayed steering announcement joins by canonical ID", () => {
    const liveId = appendEventMessage("steering", STEER_SENTENCE, "evt-ledger-2");
    appendAssistantMessage("the drained turn answers");
    const replayId = appendEventMessage("steering", STEER_SENTENCE, "evt-ledger-2");
    expect(replayId).toBe(liveId);
    expect(messages.get().filter((m) => m.content === STEER_SENTENCE && m.role === "event")).toHaveLength(1);
  });

  test("a ledger replay joins its error-role primary by canonical ID", () => {
    appendErrorMessage("provider refused the request", undefined, "evt-ledger-3");
    appendAssistantMessage("after");
    const replayId = appendEventMessage("error", "provider refused the request", "evt-ledger-3");
    const errBeats = messages.get().filter((m) => m.content === "provider refused the request");
    expect(errBeats).toHaveLength(1);
    expect(replayId).toBe(errBeats[0]!.id);
  });

  test("an unrecorded second announcement keeps its own beat", () => {
    const first = appendEventMessage("steering", STEER_SENTENCE);
    appendAssistantMessage("the drained turn answers between the two steers");
    const second = appendEventMessage("steering", STEER_SENTENCE);
    expect(second).not.toBe(first);
    expect(messages.get().filter((m) => m.role === "event" && m.content === STEER_SENTENCE)).toHaveLength(2);
  });

  test("an addressed announcement does not absorb an anonymous announcement with different words", () => {
    const liveId = appendEventMessage("steering", STEER_SENTENCE);
    const replayId = appendEventMessage("steering", "Steered — new turn starting (2 queued)", "evt-ledger-5");
    expect(replayId, "same kind, different content: a different incident keeps its own beat").not.toBe(liveId);
    const eventRows = messages.get().filter((m) => m.role === "event");
    expect(eventRows).toHaveLength(2);
    const live = eventRows.find((m) => m.id === liveId)!;
    expect(live.timelineEventId, "the first incident's beat gains nothing from the second's replay").toBeUndefined();
    const twin = eventRows.find((m) => m.id === replayId)!;
    expect(twin.timelineEventId).toBe("evt-ledger-5");
  });

  test("an adjacent canonical replay is idempotent", () => {
    const liveId = appendEventMessage("steering", STEER_SENTENCE, "evt-ledger-6");
    const replayId = appendEventMessage("steering", STEER_SENTENCE, "evt-ledger-6");
    expect(replayId, "the adjacent twin joins its live beat").toBe(liveId);
    expect(messages.get().filter((m) => m.role === "event")).toHaveLength(1);
    const joined = messages.get().find((m) => m.id === liveId)!;
    expect(joined.timelineEventId, "the adjacent replay retains the recorder identity").toBe("evt-ledger-6");
    const againId = appendEventMessage("steering", STEER_SENTENCE, "evt-ledger-6");
    expect(againId).toBe(liveId);
    expect(messages.get().filter((m) => m.role === "event")).toHaveLength(1);
    expect(messages.get().find((m) => m.id === liveId)!.timelineEventId).toBe("evt-ledger-6");
  });

  test("a record absent from the transcript appends with its canonical ID", () => {
    const id = appendEventMessage("bias", "bias detected in the reply", "evt-ledger-4");
    const beat = messages.get().find((m) => m.id === id)!;
    expect(beat.role).toBe("event");
    expect(beat.eventKind).toBe("bias");
    expect(beat.timelineEventId).toBe("evt-ledger-4");
  });
});


describe("error-event replay twins — the record's row absorbs the replay, a real repeat does not fold", () => {
  beforeEach(() => clearMessages());

  test("identical failures in one run keep distinct IDs, and an older replay ignores newer twins", () => {
    const failure = { runId: "run-many-errors", code: "llm_timeout", rawMessage: "request timed out" };
    const first = appendErrorMessage("The request took too long", failure, "failure-a");
    const anonymous = appendErrorMessage("The request took too long", failure);
    const second = appendErrorMessage("The request took too long", failure, "failure-b");
    expect(new Set([first, anonymous, second]).size, "two recorded failures plus an unaddressed observation").toBe(3);
    expect(appendErrorMessage(failure.rawMessage, failure, "failure-a"), "raw replay returns its exact projected beat").toBe(first);
    expect(messages.get().filter((m) => m.timelineEventId === "failure-a")).toHaveLength(1);
    expect(messages.get().find((m) => m.id === anonymous)!.timelineEventId).toBeUndefined();
  });

  const RAW = "network error: fetch failed";
  const CODE = "llm_stream_error";
  const RUN = "run-parked-1";

  /** The record's own error row, as the history hydration serves it: the
   * server stamps the row with its run and (in its metadata) the failure's
   * taxonomy code, and the hydration mapper carries both onto the view. */
  function recordErrorRow(
    overrides: Partial<{ runId: string; content: string; errorCode: string }> = {},
  ): string {
    return appendMessage({
      id: `row-${Math.random().toString(36).slice(2)}`,
      role: "error",
      content: overrides.content ?? RAW,
      timestamp: Date.parse("2026-09-02T17:47:25Z"),
      runId: overrides.runId ?? RUN,
      errorCode: overrides.errorCode ?? CODE,
      timelineEventId: "incident-recorded-error",
    });
  }

  test("a REPLAYED error event joins its own persisted row — one beat for one failure, not a twin", () => {
    const rowId = recordErrorRow();
    appendAssistantMessage("");
    const joinedId = appendErrorMessage(RAW, { runId: RUN, code: CODE }, "incident-recorded-error");
    expect(joinedId, "the replay returns the record's own row id, never a twin").toBe(rowId);
    expect(messages.get().filter((m) => m.role === "error")).toHaveLength(1);
  });

  test("the join is idempotent across returns — a second replay of the same failure still joins", () => {
    const rowId = recordErrorRow();
    const first = appendErrorMessage(RAW, { runId: RUN, code: CODE }, "incident-recorded-error");
    const second = appendErrorMessage(RAW, { runId: RUN, code: CODE }, "incident-recorded-error");
    expect(first).toBe(rowId);
    expect(second, "park → return → park → return replays the same event twice; both join the one row").toBe(rowId);
    expect(messages.get().filter((m) => m.role === "error")).toHaveLength(1);
  });

  test("a NEW error in the same run keeps its own beat (different message)", () => {
    recordErrorRow();
    const newId = appendErrorMessage("auth failed (401): invalid_api_key", {
      runId: RUN,
      code: CODE,
    });
    expect(newId, "a genuinely different failure is not the record's row").not.toBe(
      messages.get().find((m) => m.content === RAW)!.id,
    );
    expect(messages.get().filter((m) => m.role === "error")).toHaveLength(2);
  });

  test("another run's recorded same-word failure keeps its own beat", () => {
    recordErrorRow();
    const newId = appendErrorMessage(RAW, { runId: "run-parked-2", code: CODE }, "another-run-error");
    expect(newId, "another run's failure never joins this run's row").not.toBe(
      messages.get().filter((m) => m.runId === RUN)![0]!.id,
    );
    expect(messages.get().filter((m) => m.role === "error" && m.content === RAW)).toHaveLength(2);
  });

  test("a separately recorded failure under a different code keeps its own beat", () => {
    recordErrorRow();
    const newId = appendErrorMessage(RAW, { runId: RUN, code: "llm_auth_error" }, "another-code-error");
    expect(messages.get().filter((m) => m.role === "error" && m.content === RAW)).toHaveLength(2);
    expect(newId).not.toBe(messages.get().filter((m) => m.errorCode === CODE)![0]!.id);
  });

  test("an append with NO identity always appends — transport observations and live repeats keep their beat", () => {
    recordErrorRow();
    const liveId = appendErrorMessage(RAW);
    expect(liveId).not.toBe(messages.get().find((m) => m.runId === RUN)!.id);
    expect(messages.get().filter((m) => m.role === "error" && m.content === RAW)).toHaveLength(2);
  });

  test("an anonymous error row never absorbs an addressed failure", () => {
    const legacyRowId = appendMessage({
      id: "row-legacy",
      role: "error",
      content: RAW,
      timestamp: Date.parse("2026-08-01T00:00:00Z"),
      runId: RUN,
    });
    const appended = appendErrorMessage(RAW, { runId: RUN, code: CODE }, "incident-recorded-error");
    expect(appended).not.toBe(legacyRowId);
    expect(messages.get().filter((m) => m.role === "error" && m.content === RAW)).toHaveLength(2);
  });

  test("a rewriting code keeps its display projection and taxonomy", () => {
    const projection = formatErrorMessage({
      code: "llm_timeout",
      message: "request timed out after 120000ms",
      statusCode: undefined,
    });
    expect(projection, "the fixture must be a rewriting code — the projection differs from the raw").not.toBe(
      "request timed out after 120000ms",
    );
    const beatId = appendErrorMessage(projection, {
      runId: "run-timeout-live",
      code: "llm_timeout",
    });
    const beat = messages.get().find((m) => m.id === beatId)!;
    expect(beat.content).toBe(projection);
    expect(beat.errorCode).toBe("llm_timeout");
  });

  test("a pass-through code retains its recorded message and canonical ID", () => {
    const beatId = appendErrorMessage(RAW, { runId: RUN, code: CODE }, "incident-recorded-error");
    const beat = messages.get().find((m) => m.id === beatId)!;
    expect(beat.content).toBe(RAW);
    expect(beat.timelineEventId).toBe("incident-recorded-error");
  });
});

// ── THE UNANSWERED TURN'S VERDICTS — the hydrate reconcile's store half ────
//
// The finding (UIE-076): a run whose server died mid-stream leaves the
// assistant row its "start" created EMPTY forever — text is persisted at
// finish, never incrementally, so the words died with the process — and an
// empty turn renders as NOTHING (the flow hides it), erasing the turn. The
// reconcile settles the row's honest ending through two store owners: the
// SUBJECT predicate below (what counts as "started, never ended", each
// clause a fact the record states) and the by-id APPLY (the surgical
// replace that must not reset streaming state a live page depends on).
// The client door that drives them is pinned in tests/unit/client.test.ts.

describe("unanswered assistant rows — the subject predicate and the verdict apply", () => {
  beforeEach(() => clearMessages());

  /** The exact shape a hydrate rebuilds from a server-killed run's row:
   * created at the model's start, empty, carrying the run, no marks. */
  function deadRow(overrides: Partial<ChatMessage> = {}): string {
    return appendMessage({
      id: `row-dead-${Math.random().toString(36).slice(2)}`,
      role: "assistant",
      content: "",
      timestamp: Date.parse("2026-09-02T18:40:00Z"),
      runId: "run-died",
      ...overrides,
    });
  }

  test("the shape the drive measured IS a subject: empty assistant row with a run and no ending mark", () => {
    const id = deadRow();
    const msg = messages.get().find((m) => m.id === id)!;
    expect(isUnansweredAssistantRow(msg), "started, streamed, died — nothing kept, nothing marked").toBe(true);
  });

  test("an ANSWERED row is never a subject — the verdicts must not touch real turns", () => {
    const id = deadRow({ content: "the story, kept at finish" });
    expect(isUnansweredAssistantRow(messages.get().find((m) => m.id === id)!), "content means the finish landed").toBe(false);
    const marked = deadRow({ finishReason: "error" });
    expect(
      isUnansweredAssistantRow(messages.get().find((m) => m.id === marked)!),
      "a failed call's error event stamps finishReason — that row has its ending",
    ).toBe(false);
    const reasoned = deadRow({ reasoning: "thinking that survived the error flush" });
    expect(
      isUnansweredAssistantRow(messages.get().find((m) => m.id === reasoned)!),
    ).toBe(false);
  });

  test("a row with NO run cannot be verified against anything — never a subject", () => {
    const id = appendMessage({
      id: "row-no-run",
      role: "assistant",
      content: "",
      timestamp: Date.parse("2026-09-02T18:40:00Z"),
    });
    expect(isUnansweredAssistantRow(messages.get().find((m) => m.id === id)!)).toBe(false);
  });

  test("an ALREADY-SETTLED row is never a subject — the reconcile is idempotent", () => {
    const id = deadRow();
    const settled = applyReconciledAssistantRows([
      { ...messages.get().find((m) => m.id === id)!, incompleteReason: "the run ended before this answer was kept" },
    ]);
    expect(settled).toBe(1);
    expect(isUnansweredAssistantRow(messages.get().find((m) => m.id === id)!)).toBe(false);
  });

  test("the apply replaces BY ID, touches only assistant rows, and ignores unknown ids", () => {
    const dead = deadRow();
    const otherDead = deadRow({ runId: "run-died-2" });
    const userId = appendUserMessage("the question that never got its answer");
    const changed = applyReconciledAssistantRows([
      { ...messages.get().find((m) => m.id === dead)!, incompleteReason: "the run ended before this answer was kept" },
      { ...messages.get().find((m) => m.id === otherDead)!, incompleteReason: "the run ended before this answer was kept" },
      { id: "row-not-in-the-store", role: "assistant", content: "", timestamp: 0, incompleteReason: "x" },
    ]);
    expect(changed, "two real rows changed; the unknown id changed nothing").toBe(2);
    expect(messages.get().find((m) => m.id === dead)!.incompleteReason).toBeDefined();
    expect(messages.get().find((m) => m.id === otherDead)!.incompleteReason).toBeDefined();
    expect(messages.get().find((m) => m.id === userId)!.role).toBe("user");
    expect(
      messages.get().filter((m) => m.incompleteReason !== undefined),
    ).toHaveLength(2);
  });

  test("the apply is surgical — it never resets the streaming state a live page depends on", () => {
    const dead = deadRow();
    setStreaming(true);
    streamingTail.set("words another run is streaming right now");
    applyReconciledAssistantRows([
      { ...messages.get().find((m) => m.id === dead)!, incompleteReason: "the run ended before this answer was kept" },
    ]);
    expect(isStreaming.get(), "a bulk replace would have reset this — the verdict must not").toBe(true);
    expect(streamingTail.get()).toBe("words another run is streaming right now");
  });
});
