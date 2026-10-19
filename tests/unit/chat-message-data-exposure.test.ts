// @vitest-environment node
import { describe, test, expect, beforeEach } from "vitest";

import {
  messages,
  appendAssistantMessage,
  updateLastMessage,
  clearMessages,
  type ChatMessage,
  type RunContext,
} from "../../src/state/chat-messages";

// ── PREVENTION (exp505): chat must expose ALL data ──
// The user requested that the chat expose everything: headers, thinking/
// reasoning, injected context, finish reason, model, token usage, timing.
// This test guards the ChatMessage view-model fields that carry that data.
// Regression: if any field is removed, this test fails so the exposure is
// never silently lost.
describe("exp505: chat message exposes all LLM data", () => {
  beforeEach(() => clearMessages());

  test("updateLastMessage sets reasoning (thinking) on an assistant message", () => {
    appendAssistantMessage("");
    updateLastMessage((m) => ({ ...m, reasoning: "Let me think..." }));
    const msg = messages.get()[0]!;
    expect(msg.reasoning).toBe("Let me think...");
  });

  test("updateLastMessage accumulates reasoning across multiple deltas", () => {
    appendAssistantMessage("");
    updateLastMessage((m) => ({ ...m, reasoning: (m.reasoning ?? "") + "part1 " }));
    updateLastMessage((m) => ({ ...m, reasoning: (m.reasoning ?? "") + "part2" }));
    expect(messages.get()[0]!.reasoning).toBe("part1 part2");
  });

  test("updateLastMessage sets responseHeaders (LLM API headers)", () => {
    appendAssistantMessage("");
    const headers = { "x-request-id": "abc", "x-ratelimit-remaining-requests": "42" };
    updateLastMessage((m) => ({ ...m, responseHeaders: headers }));
    expect(messages.get()[0]!.responseHeaders).toEqual(headers);
  });

  test("updateLastMessage sets responseModel (actual model used)", () => {
    appendAssistantMessage("");
    updateLastMessage((m) => ({ ...m, responseModel: "qwen3.6-35b-fast" }));
    expect(messages.get()[0]!.responseModel).toBe("qwen3.6-35b-fast");
  });

  test("updateLastMessage sets finishReason", () => {
    appendAssistantMessage("");
    updateLastMessage((m) => ({ ...m, finishReason: "stop" }));
    expect(messages.get()[0]!.finishReason).toBe("stop");
  });

  test("updateLastMessage sets context (injected system prompt + tools)", () => {
    appendAssistantMessage("");
    const ctx: RunContext = {
      systemPrompt: "You are a coding assistant.",
      toolNames: ["read_file", "search_code"],
      historyLength: 3,
      modelId: "qwen3.6-35b-fast",
    };
    updateLastMessage((m) => ({ ...m, context: ctx }));
    const msg = messages.get()[0]!;
    expect(msg.context).toEqual(ctx);
    expect(msg.context?.systemPrompt).toBe("You are a coding assistant.");
    expect(msg.context?.toolNames).toEqual(["read_file", "search_code"]);
    expect(msg.context?.historyLength).toBe(3);
  });

  test("ChatMessage type carries every exposure field (compile-time guard)", () => {
    // This compiles only if every field exists on ChatMessage. If a field is
    // removed, this assignment fails to typecheck (the prevention gate).
    const m: ChatMessage = {
      id: "x",
      role: "assistant",
      content: "",
      timestamp: 0,
      reasoning: "r",
      responseHeaders: {},
      responseModel: "m",
      finishReason: "stop",
      context: { systemPrompt: "s", toolNames: [], historyLength: 0 },
    };
    expect(m.reasoning).toBe("r");
    expect(m.responseModel).toBe("m");
    expect(m.finishReason).toBe("stop");
    expect(m.context?.systemPrompt).toBe("s");
  });
});
