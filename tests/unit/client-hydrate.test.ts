// @vitest-environment node
import { describe, test, expect, beforeEach } from "vitest";

import {
  hydrateChatFromHistory,
  type ChatHistoryPageView,
  type ToolCallViewRow,
} from "../../src/client";
import type { MessageView } from "../../shared/wire-types";
import { formatErrorMessage } from "../../src/data/error-messages";
import { wholeConversationPage } from "../helpers/history-page.ts";
import {
  messages,
  isStreaming,
  setStreaming,
  clearMessages,
} from "../../src/state/chat-messages";

// ── Test fixtures ──

function makeMessage(overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    chatId: "c1",
    role: "user",
    content: "hello",
    createdAt: "2026-01-01T00:00:00Z",
    modelEventType: null,
    runId: null,
    metadata: null,
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<ToolCallViewRow> = {}): ToolCallViewRow {
  return {
    id: `tc-${Math.random().toString(36).slice(2)}`,
    messageId: "m-1",
    callId: null,
    toolName: "read_file",
    input: { path: "a.ts" },
    output: { lines: 10 },
    status: "done",
    durationMs: 5,
    attemptCount: 1,
    createdAt: "2026-01-01T00:00:01Z",
    ...overrides,
  };
}

function makeHistory(overrides: Partial<ChatHistoryPageView> = {}): ChatHistoryPageView {
  return {
    chat: {
      id: "c1",
      projectId: "p1",
      title: "test",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      modelId: null,
      pinned: false,
    },
    messages: [],
    toolCalls: [],
    metricsSnapshots: [],
    timelineRefs: [],
    page: wholeConversationPage(0),
    ...overrides,
  };
}

describe("client: hydrateChatFromHistory", () => {
  beforeEach(() => {
    clearMessages();
  });

  test("empty history → empty messages", () => {
    hydrateChatFromHistory(makeHistory());
    expect(messages.get()).toHaveLength(0);
  });

  test("user + assistant messages hydrate into the chat-messages store", () => {
    const history = makeHistory({
      messages: [
        makeMessage({ id: "m1", role: "user", content: "hi" }),
        makeMessage({ id: "m2", role: "assistant", content: "hello back" }),
      ],
    });
    hydrateChatFromHistory(history);
    const list = messages.get();
    expect(list).toHaveLength(2);
    expect(list[0]!.role).toBe("user");
    expect(list[0]!.content).toBe("hi");
    expect(list[1]!.role).toBe("assistant");
    expect(list[1]!.content).toBe("hello back");
  });

  test("tool messages hydrate with their toolCall attached", () => {
    const history = makeHistory({
      messages: [
        makeMessage({ id: "m1", role: "user", content: "read the file" }),
        makeMessage({ id: "m2", role: "tool", content: "" }),
      ],
      toolCalls: [
        makeToolCall({ id: "tc1", messageId: "m2", callId: "native-call", toolName: "read_file", input: { path: "a.ts" }, output: { lines: 10 }, status: "done", durationMs: 5 }),
      ],
    });
    hydrateChatFromHistory(history);
    const list = messages.get();
    expect(list).toHaveLength(2);
    expect(list[1]!.role).toBe("tool");
    expect(list[1]!.toolCall).toBeDefined();
    expect(list[1]!.toolCall!.name).toBe("read_file");
    expect(list[1]!.toolCall!.id, "history retains the provider identity used by live updates").toBe("native-call");
    expect(list[1]!.toolCall!.input).toEqual({ path: "a.ts" });
    expect(list[1]!.toolCall!.output).toEqual({ lines: 10 });
    expect(list[1]!.toolCall!.status).toBe("done");
    expect(list[1]!.toolCall!.durationMs).toBe(5);
  });

  test("isStreaming is reset to false after hydration", () => {
    setStreaming(true);
    expect(isStreaming.get()).toBe(true);
    hydrateChatFromHistory(makeHistory());
    expect(isStreaming.get()).toBe(false);
  });

  test("message ids are preserved from the DB (stable Svelte keyed-each)", () => {
    const history = makeHistory({
      messages: [
        makeMessage({ id: "db-msg-1", role: "user", content: "a" }),
        makeMessage({ id: "db-msg-2", role: "assistant", content: "b" }),
      ],
    });
    hydrateChatFromHistory(history);
    expect(messages.get().map((m) => m.id)).toEqual(["db-msg-1", "db-msg-2"]);
  });

  test("tool message with no matching toolCall row still hydrates (no toolCall field)", () => {
    const history = makeHistory({
      messages: [makeMessage({ id: "m1", role: "tool", content: "" })],
      toolCalls: [],
    });
    hydrateChatFromHistory(history);
    const list = messages.get();
    expect(list).toHaveLength(1);
    expect(list[0]!.role).toBe("tool");
    expect(list[0]!.toolCall).toBeUndefined();
  });

  test("error messages hydrate with their content", () => {
    const history = makeHistory({
      messages: [makeMessage({ id: "m1", role: "error", content: "something broke" })],
    });
    hydrateChatFromHistory(history);
    const list = messages.get();
    expect(list[0]!.role).toBe("error");
    expect(list[0]!.content).toBe("something broke");
  });

  test("an error row hydrates with the failure's own identity — its run and its taxonomy code (the replay join's key)", () => {
    // The re-attach's replay dedup matches a replayed error event against
    // the record's own row by (run, code, message). The row's run rides the
    // wire on the row itself; the code rides the metadata blob the run's
    // error projection persists. If the hydration mapper dropped either,
    // the row could never recognize its own replay and every re-attach
    // within the feed's retention would double the failure's beat.
    const history = makeHistory({
      messages: [
        makeMessage({
          id: "m-err-row",
          role: "error",
          content: "network error: fetch failed",
          runId: "run-parked-9",
          metadata: { errorCode: "llm_stream_error" },
        }),
      ],
    });
    hydrateChatFromHistory(history);
    const row = messages.get()[0]!;
    expect(row.runId, "the row's own run survives the wire — the join key's run half").toBe("run-parked-9");
    expect(row.errorCode, "the failure's taxonomy code survives the blob — the join key's code half").toBe("llm_stream_error");
  });

  test("an error row without a run hydrates without the join fields (no fabricated identity)", () => {
    const history = makeHistory({
      messages: [makeMessage({ id: "m-err-legacy", role: "error", content: "old failure" })],
    });
    hydrateChatFromHistory(history);
    const row = messages.get()[0]!;
    expect(row.runId).toBeUndefined();
    expect(row.errorCode).toBeUndefined();
  });

  // ── prevention: persisted metadata survives reload ──
  test("assistant message with persisted metadata hydrates reasoning/tokens/timing/headers/model/traceId/finishReason/context", () => {
    const metadata = {
      reasoning: "let me think about this",
      tokenMetrics: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      timingMetrics: { startedAt: 1000, firstTokenAt: 1100, finishedAt: 2000, ttftMs: 100, totalMs: 1000, tps: 20 },
      responseHeaders: { "x-request-id": "req-1" },
      responseModel: "gemma-4-31b",
      traceId: "trace-12345678-1234-1234-1234-123456789012",
      finishReason: "stop",
      context: { systemPrompt: "you are helpful", toolNames: ["read_file"], historyLength: 2 },
      dedupSummary: {
        applied: true,
        originalChars: 2440,
        dedupedChars: 1845,
        charReductionPct: 24.39,
        removedBlocks: 5,
        removedLines: 31,
        messageCount: 5,
      },
      redactionNotice: {
        maskedCount: 2,
        proven: 1,
        format: 0,
        inferred: 1,
        maskedUpstream: 3,
        byTier: { selfValidating: 1, declaredValues: 1 },
        reasons: [
          { confidence: "proven", category: "credential", maskedLength: 24, explanation: "equals a credential this machine holds" },
          { confidence: "inferred", category: "password", maskedLength: 8, explanation: "the words around it introduced it and its shape agreed" },
        ],
      },
    };
    const history = makeHistory({
      messages: [makeMessage({ id: "m1", role: "assistant", content: "hello back", metadata })],
    });
    hydrateChatFromHistory(history);
    const list = messages.get();
    expect(list).toHaveLength(1);
    const m = list[0]!;
    expect(m.reasoning).toBe("let me think about this");
    expect(m.tokenMetrics).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(m.timingMetrics?.ttftMs).toBe(100);
    expect(m.timingMetrics?.tps).toBe(20);
    expect(m.responseHeaders).toEqual({ "x-request-id": "req-1" });
    expect(m.responseModel).toBe("gemma-4-31b");
    // The persisted trace id — the run pane's trace row reads it from the
    // re-read transcript, so a refresh must not lose the incident's handle.
    expect(m.traceId).toBe("trace-12345678-1234-1234-1234-123456789012");
    expect(m.finishReason).toBe("stop");
    expect(m.context?.systemPrompt).toBe("you are helpful");
    expect(m.context?.toolNames).toEqual(["read_file"]);
    expect(m.context?.historyLength).toBe(2);
    // The call's dedup savings hydrate with the wire's own numbers — the
    // reloaded footer shows the same savings face the live one did.
    expect(m.dedupSummary?.applied).toBe(true);
    expect(m.dedupSummary?.originalChars).toBe(2440);
    expect(m.dedupSummary?.dedupedChars).toBe(1845);
    expect(m.dedupSummary?.charReductionPct).toBe(24.39);
    expect(m.dedupSummary?.removedBlocks).toBe(5);
    expect(m.dedupSummary?.removedLines).toBe(31);
    expect(m.dedupSummary?.messageCount).toBe(5);
    // The call's masked-input notice hydrates with the wire's own numbers —
    // the reloaded footer shows the same masking face the live one did,
    // and the upstream count stays its own number.
    expect(m.redactionNotice?.maskedCount).toBe(2);
    expect(m.redactionNotice?.proven).toBe(1);
    expect(m.redactionNotice?.format).toBe(0);
    expect(m.redactionNotice?.inferred).toBe(1);
    expect(m.redactionNotice?.maskedUpstream).toBe(3);
    expect(m.redactionNotice?.reasons).toHaveLength(2);
    expect(m.redactionNotice?.reasons[1]!.explanation).toBe(
      "the words around it introduced it and its shape agreed",
    );
  });

  test("assistant message with null metadata hydrates without optional fields (no crash)", () => {
    const history = makeHistory({
      messages: [makeMessage({ id: "m1", role: "assistant", content: "hi", metadata: null })],
    });
    hydrateChatFromHistory(history);
    const m = messages.get()[0]!;
    expect(m.reasoning).toBeUndefined();
    expect(m.tokenMetrics).toBeUndefined();
    expect(m.context).toBeUndefined();
    expect(m.dedupSummary).toBeUndefined();
    expect(m.redactionNotice).toBeUndefined();
  });

  test("metadata with unknown keys is dropped (untrusted blob)", () => {
    const metadata = {
      reasoning: "legit",
      evil: { __proto__: "pollution" },
      extraField: "should be dropped",
    };
    const history = makeHistory({
      messages: [makeMessage({ id: "m1", role: "assistant", content: "x", metadata })],
    });
    hydrateChatFromHistory(history);
    const m = messages.get()[0] as Record<string, unknown>;
    expect(m.reasoning).toBe("legit");
    expect(m.evil).toBeUndefined();
    expect(m.extraField).toBeUndefined();
  });

  // ── the recorded event's address survives the reload (the documents
  // fold's persistence: without it, a refreshed page offers event beats
  // their body but no longer their recorded payload) ──
  test("an event message with persisted timelineEventId hydrates it back (the documents fold survives refresh)", () => {
    const history = makeHistory({
      messages: [
        makeMessage({
          id: "m1",
          role: "event",
          content: "the assistant leaned on one source",
          metadata: { eventKind: "bias", timelineEventId: "9f2c31de-6b4e-4d5f-8a1c-77e20a53b0d2" },
        }),
      ],
    });
    hydrateChatFromHistory(history);
    const m = messages.get()[0]!;
    expect(m.role).toBe("event");
    expect(m.eventKind).toBe("bias");
    // The canonical address — carried, never rendered — is back on the
    // message, so the flow's event beat re-opens its documents fold.
    expect(m.timelineEventId).toBe("9f2c31de-6b4e-4d5f-8a1c-77e20a53b0d2");
  });

  test("an event message recorded before the field existed hydrates without one (honest absence)", () => {
    const history = makeHistory({
      messages: [
        makeMessage({
          id: "m1",
          role: "event",
          content: "an older recorded event",
          metadata: { eventKind: "steering" },
        }),
      ],
    });
    hydrateChatFromHistory(history);
    const m = messages.get()[0]!;
    expect(m.eventKind).toBe("steering");
    expect(m.timelineEventId).toBeUndefined();
  });
});

// The saved message is primary; canonical ID joins its timeline projection.
describe("hydrate: failed-run error refs merge with their primary error rows", () => {
  const SENTENCE_A = "Insufficient credit balance. Please add credits to continue.";
  const SENTENCE_B = "The model provider refused the request (429).";

  function errorRef(id: string, eventId: string, description: string) {
    return {
      id,
      chatId: "c1",
      eventId,
      eventType: "error",
      timestamp: "2026-01-01T00:00:02Z",
      metadata: { outcome: "failed", runId: "run-1", description },
    };
  }

  beforeEach(() => {
    clearMessages();
  });

  test("canonical IDs preserve same-word incidents, duplicate refs and anonymous twins", () => {
    const primary = makeMessage({ id: "primary-a", role: "event", content: "Safety finding: repeated", metadata: { eventKind: "safety-finding", timelineEventId: "incident-a" } });
    const anonymous = makeMessage({ id: "anonymous", role: "event", content: primary.content, metadata: { eventKind: "safety-finding" } });
    const ref = (id: string, eventId: string) => ({ ...errorRef(id, eventId, primary.content), eventType: "quality" });
    for (const initial of [[], [primary], [primary, anonymous]]) {
      hydrateChatFromHistory(makeHistory({
        messages: initial,
        timelineRefs: [ref("projection-a", "incident-a"), ref("projection-b", "incident-b"), ref("duplicate-a", "incident-a")],
      }));
      const recorded = messages.get().filter((m) => m.timelineEventId !== undefined);
      expect(recorded.map((m) => m.timelineEventId), "both distinct incidents remain, each once").toEqual(["incident-a", "incident-b"]);
      if (initial.includes(primary)) expect(recorded[0]!.id, "the primary message owns its replay").toBe(primary.id);
      if (initial.includes(anonymous)) expect(messages.get().find((m) => m.id === anonymous.id)!.timelineEventId, "anonymous wording does not establish an association").toBeUndefined();
    }
  });

  test("a failed run's timeline ref merges with its primary error row (ONE row, the primary)", () => {
    const history = makeHistory({
      messages: [makeMessage({ id: "m-err", role: "error", content: SENTENCE_A, metadata: { timelineEventId: "evt-err-1" } })],
      timelineRefs: [errorRef("ref-1", "evt-err-1", SENTENCE_A)],
    });
    hydrateChatFromHistory(history);
    const list = messages.get();
    expect(list.filter((m) => m.content === SENTENCE_A)).toHaveLength(1);
    expect(list).toHaveLength(1);
    expect(list[0]!.role).toBe("error");
    expect(list[0]!.id).toBe("m-err");
    expect(list.filter((m) => m.role === "event"), "no event-kind twin renders").toHaveLength(0);
  });

  test("two DIFFERENT errors in one run both render (each sentence once, no twin)", () => {
    const history = makeHistory({
      messages: [
        makeMessage({ id: "m-err-1", role: "error", content: SENTENCE_A, metadata: { timelineEventId: "evt-err-1" }, createdAt: "2026-01-01T00:00:01Z" }),
        makeMessage({ id: "m-err-2", role: "error", content: SENTENCE_B, metadata: { timelineEventId: "evt-err-2" }, createdAt: "2026-01-01T00:00:03Z" }),
      ],
      timelineRefs: [errorRef("ref-1", "evt-err-1", SENTENCE_A), errorRef("ref-2", "evt-err-2", SENTENCE_B)],
    });
    hydrateChatFromHistory(history);
    const list = messages.get();
    expect(list.filter((m) => m.content === SENTENCE_A)).toHaveLength(1);
    expect(list.filter((m) => m.content === SENTENCE_B)).toHaveLength(1);
    expect(list).toHaveLength(2);
    expect(list.filter((m) => m.role === "event")).toHaveLength(0);
  });

  test("a distinct recorded error renders beside the primary", () => {
    const history = makeHistory({
      messages: [makeMessage({ id: "m-err", role: "error", content: SENTENCE_A, metadata: { timelineEventId: "evt-err-1" } })],
      timelineRefs: [errorRef("ref-2", "evt-err-2", SENTENCE_B)],
    });
    hydrateChatFromHistory(history);
    const list = messages.get();
    expect(list).toHaveLength(2);
    expect(list[0]!.role).toBe("error");
    expect(list[0]!.content).toBe(SENTENCE_A);
    const twin = list[1]!;
    expect(twin.role).toBe("event");
    expect(twin.eventKind).toBe("error");
    expect(twin.content).toBe(SENTENCE_B);
  });

  test("a projected primary joins its raw-worded ref by canonical ID", () => {
    const RAW = "request timed out after 120000ms";
    const history = makeHistory({
      messages: [
        makeMessage({
          id: "m-err-timeout",
          role: "error",
          content: RAW,
          runId: "run-timeout-1",
          metadata: { errorCode: "llm_timeout", timelineEventId: "evt-timeout-1" },
        }),
      ],
      timelineRefs: [errorRef("ref-timeout", "evt-timeout-1", RAW)],
    });
    hydrateChatFromHistory(history);
    const list = messages.get();
    expect(list, "one failure, one row — the ref collapsed into its projected primary").toHaveLength(1);
    expect(list[0]!.id).toBe("m-err-timeout");
    expect(list[0]!.content).not.toBe(RAW);
    expect(list.filter((m) => m.role === "event"), "no event-kind twin renders beside the primary").toHaveLength(0);
  });
});

// ── both faces of a failure render the projection ─────────────────────────
//
// THE TWO-FACES DEFECT: for the codes the formatter REWRITES (llm_timeout is
// the proven case — its raw message "request timed out after 120000ms" hits
// the formatter's timeout branch), the LIVE beat the reader watched rendered
// the reader-facing projection ("The request took too long…") while the
// reloaded row rendered the record's own raw words — one failure, two
// sentences, depending on whether the reader watched it happen or opened the
// chat later. The hydration now derives the display face through the SAME
// projection owner the live doors use, so both faces render one sentence;
// the raw stays the persisted record (the diagnostics face) and rides the
// view model unrendered.
describe("hydrate: a failure's reloaded row renders the same sentence its live beat did", () => {
  const RAW = "request timed out after 120000ms";
  const CODE = "llm_timeout";
  /** The sentence the LIVE door renders for this failure — the same
   * derivation src/client.ts applies at the model-error door. */
  const LIVE_FACE = formatErrorMessage({ code: CODE, message: RAW, statusCode: undefined });

  beforeEach(() => {
    clearMessages();
  });

  test("a REWRITING code's row hydrates as the projection — the live beat's own sentence, never the record's raw", () => {
    const history = makeHistory({
      messages: [
        makeMessage({
          id: "m-err-timeout",
          role: "error",
          content: RAW,
          runId: "run-timeout-2",
          metadata: { errorCode: CODE },
        }),
      ],
    });
    hydrateChatFromHistory(history);
    const row = messages.get()[0]!;
    expect(
      row.content,
      "the reloaded face IS the live face — both derive through the one projection owner",
    ).toBe(LIVE_FACE);
    expect(
      row.content,
      "the defect's own face: the record's raw words must not render as the beat",
    ).not.toBe(RAW);
    expect(history.messages[0]!.content, "hydration preserves the raw source record").toBe(RAW);
    expect(row.errorCode).toBe(CODE);
    expect(row.runId).toBe("run-timeout-2");
  });

  test("a NON-rewriting code's row hydrates unchanged — both faces already agree, and still derive through the owner", () => {
    // llm_stream_error is the seam's proof: the formatter passes its raw
    // message through untouched (no bespoke sentence, no content markers),
    // so the live face and the reloaded face are the same words. The
    // hydration still derives through the projection owner — the equality
    // is the owner's own output, not a bypass.
    const raw = "network error: fetch failed";
    const history = makeHistory({
      messages: [
        makeMessage({
          id: "m-err-stream",
          role: "error",
          content: raw,
          runId: "run-stream-1",
          metadata: { errorCode: "llm_stream_error" },
        }),
      ],
    });
    hydrateChatFromHistory(history);
    const row = messages.get()[0]!;
    expect(row.content).toBe(
      formatErrorMessage({ code: "llm_stream_error", message: raw, statusCode: undefined }),
    );
    expect(row.content, "the pass-through code renders its own words on both faces").toBe(raw);
  });
});
