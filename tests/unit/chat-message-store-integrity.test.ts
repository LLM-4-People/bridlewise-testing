// @vitest-environment node
/**
 * Store-level invariants for the chat transcript owners in
 * src/state/chat-messages.ts.
 *
 * 1. `commitStreamingTail` must fold the in-flight text into the last
 *    ASSISTANT message — not blindly into `list[len-1]`. A turn that streams
 *    text and then calls a tool ends with tool messages appended AFTER the
 *    assistant message, so a "last message" commit found a tool row and gave
 *    up — after having already emptied the tail atom. The model's text was
 *    destroyed at the exact moment the turn finished.
 *
 * 2. `toolCallDurationMs` is the single owner of "how long did this tool
 *    call take" and must return null rather than synthesize a duration for a
 *    finished call that carries no measurement (the no-fake-data rule).
 */
import { describe, test, expect, beforeEach } from "vitest";
import {
  messages,
  streamingTail,
  appendStreamingTail,
  commitStreamingTail,
  setMessages,
  clearMessages,
  toolCallDurationMs,
  type ChatMessage,
  type ToolCallView,
} from "../../src/state/chat-messages";

beforeEach(() => {
  clearMessages();
});

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return { content: "", timestamp: 1, ...partial } as ChatMessage;
}

function tool(id: string, tc: Partial<ToolCallView>): ChatMessage {
  return msg({
    id,
    role: "tool",
    toolCall: { name: "read_file", input: null, output: null, status: "done", startedAt: 0, ...tc },
  });
}

describe("commitStreamingTail folds into the last ASSISTANT message", () => {
  test("text is preserved when tool messages were appended after the assistant", () => {
    // The exact live sequence: "start" → assistant message, text deltas →
    // tail, tool_call_start → tool message appended, "finish" → commit.
    setMessages([
      msg({ id: "u1", role: "user", content: "read the file" }),
      msg({ id: "a1", role: "assistant", content: "" }),
      tool("t1", { id: "call-1", status: "running" }),
    ]);
    appendStreamingTail("I'll read that file.");

    commitStreamingTail();

    const list = messages.get();
    expect(list.map((m) => m.id), "no message added or dropped").toEqual(["u1", "a1", "t1"]);
    expect(list[1]!.content, "streamed text landed on the assistant").toBe("I'll read that file.");
    expect(streamingTail.get(), "tail cleared after a successful fold").toBe("");
  });

  test("existing assistant content is appended to, not replaced", () => {
    setMessages([msg({ id: "a1", role: "assistant", content: "Part one. " })]);
    appendStreamingTail("Part two.");
    commitStreamingTail();
    expect(messages.get()[0]!.content).toBe("Part one. Part two.");
  });

  test("a second commit does not duplicate the text (idempotent)", () => {
    setMessages([
      msg({ id: "a1", role: "assistant", content: "" }),
      tool("t1", { id: "call-1" }),
    ]);
    appendStreamingTail("once");

    commitStreamingTail();
    commitStreamingTail();
    commitStreamingTail();

    expect(messages.get()[0]!.content, "folded exactly once").toBe("once");
    expect(messages.get()).toHaveLength(2);
  });

  test("the LAST assistant is the target when several assistants exist", () => {
    setMessages([
      msg({ id: "a1", role: "assistant", content: "old turn" }),
      msg({ id: "u1", role: "user", content: "again" }),
      msg({ id: "a2", role: "assistant", content: "" }),
      tool("t1", { id: "call-1" }),
      tool("t2", { id: "call-2" }),
    ]);
    appendStreamingTail("new turn");
    commitStreamingTail();

    const list = messages.get();
    expect(list[0]!.content, "the earlier turn is untouched").toBe("old turn");
    expect(list[2]!.content).toBe("new turn");
  });

  test("with no assistant message at all the text is KEPT, not silently dropped", () => {
    // An invariant violation (ingestTextDelta always creates the assistant
    // first). Keeping the tail is the honest failure mode — clearing it
    // would destroy model output.
    setMessages([msg({ id: "u1", role: "user", content: "hi" })]);
    appendStreamingTail("orphaned text");
    commitStreamingTail();
    expect(streamingTail.get()).toBe("orphaned text");
    expect(messages.get()).toHaveLength(1);
  });

  test("an empty tail is a no-op (no array rewrite)", () => {
    const list = [msg({ id: "a1", role: "assistant", content: "done" })];
    setMessages(list);
    const before = messages.get();
    commitStreamingTail();
    expect(messages.get(), "referentially identical — nothing re-derives").toBe(before);
  });
});

describe("the in-flight tail is reset with the transcript it belongs to", () => {
  // Otherwise a chat switch mid-stream carries the previous chat's words
  // into the next chat's first assistant message.
  test("clearMessages drops a pending tail", () => {
    setMessages([msg({ id: "a1", role: "assistant", content: "" })]);
    appendStreamingTail("half a sentence");
    clearMessages();
    expect(streamingTail.get()).toBe("");
  });

  test("setMessages (chat hydrate) drops a pending tail", () => {
    setMessages([msg({ id: "a1", role: "assistant", content: "" })]);
    appendStreamingTail("half a sentence");
    setMessages([msg({ id: "b1", role: "assistant", content: "other chat" })]);
    expect(streamingTail.get()).toBe("");
    commitStreamingTail();
    expect(messages.get()[0]!.content, "no cross-chat contamination").toBe("other chat");
  });
});

describe("toolCallDurationMs reports only MEASURED durations", () => {
  const NOW = 1_000_000;

  test("prefers the server-measured durationMs (survives a refresh)", () => {
    const tc: ToolCallView = {
      name: "read_file", input: null, output: null, status: "done",
      startedAt: NOW - 9_999_999, durationMs: 1234,
    };
    expect(toolCallDurationMs(tc, NOW)).toBe(1234);
  });

  test("falls back to the client-measured endedAt - startedAt", () => {
    const tc: ToolCallView = {
      name: "read_file", input: null, output: null, status: "done",
      startedAt: 1000, endedAt: 3500,
    };
    expect(toolCallDurationMs(tc, NOW)).toBe(2500);
  });

  test("a RUNNING call reports live elapsed time", () => {
    const tc: ToolCallView = {
      name: "read_file", input: null, output: null, status: "running",
      startedAt: NOW - 4000,
    };
    expect(toolCallDurationMs(tc, NOW)).toBe(4000);
  });

  test("a RUNNING call whose stamp is in the future of the reader's clock clamps to zero", () => {
    // The one-tick skew: the reader's clock sampled mid-call-start can sit
    // BEFORE the call's own startedAt stamp, and the unclamped subtraction
    // rendered a negative elapsed (observed live: "edit file RUNNING -149ms").
    // Zero is the honest floor — the call has earned no elapsed time yet,
    // and no measurement is negative.
    const tc: ToolCallView = {
      name: "read_file", input: null, output: null, status: "running",
      startedAt: NOW + 149,
    };
    expect(toolCallDurationMs(tc, NOW)).toBe(0);
  });

  test("a FINISHED call with no measurement returns null (never now - startedAt)", () => {
    // The rehydrated shape: hydrateChatFromHistory sets startedAt to the
    // message's creation time and leaves endedAt undefined. Counting from
    // there reports the age of the transcript as the tool's duration.
    for (const status of ["done", "error"] as const) {
      const tc: ToolCallView = {
        name: "read_file", input: null, output: null, status,
        startedAt: NOW - 68_400_000, // ~19h ago
      };
      expect(toolCallDurationMs(tc, NOW), `status=${status}`).toBeNull();
    }
  });
});
