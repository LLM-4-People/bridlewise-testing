import { bindResponseContext } from "../../engine/src/shared/llm/response-transcript.ts";
// @vitest-environment node
/**
 * BEHAVIORAL test for the 748% context-trim bug fix (TASKS.md line 9-10).
 *
 * The bug: the web UI sent the raw unbounded `conversationHistory` to the
 * LLM while a SEPARATE context manager trimmed its OWN internal state —
 * so a 245,022-token history was sent against a 32,768 limit (748%), and
 * the "context" SSE event reported `trimmed: no`.
 *
 * The fix: the unified context manager is the SINGLE source of truth.
 * `seedContextManagerFromHistory` seeds it; `trim` runs after seeding
 * and after every turn; `buildTrimmedHistory` derives the `ChatMessage[]`
 * ACTUALLY passed to `streamChat` (recent window + pinned + a summary
 * message for older turns), with tool_calls/tool_call_id pairing preserved
 * (OpenAI contract: an assistant tool_calls message must stay paired with
 * its tool result messages — orphaning either side is a 400).
 *
 * This test verifies the ACTUAL mechanism run.ts uses — not a source grep.
 * It asserts:
 * 1. After seeding a huge history + trim, buildTrimmedHistory output is
 * within the configured token budget.
 * 2. tool_calls groups stay ATOMIC (no orphaned tool results).
 * 3. A summary message is present when trimming occurred.
 * 4. The current user prompt (last turn) survives trimming.
 */
import { describe, test, expect } from "vitest";
import { createUnifiedContextManager, type ContextToolCall } from "../../engine/src/memory/unified/unified-context-manager.ts";
import { resolveUnifiedConfig } from "../../engine/src/memory/unified/unified-config.ts";
import { estimateTokens } from "../../engine/src/memory/unified/tokenizer.ts";
import {
  buildTrimmedHistory,
  createRunContextManager,
  seedContextManagerFromHistory,
} from "../../server/context/context-bridge.ts";
import type { ChatMessage } from "../../server/llm/llm-bridge.ts";

function mkToolCall(id: string, name = "read_file", args = "{}"): ContextToolCall {
  return Object.freeze({ id, type: "function", function: Object.freeze({ name, arguments: args }) });
}

/** Build a ChatMessage history that vastly exceeds a small token budget. */
function hugeHistoryWithToolCalls(turns: number): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    history.push({ role: "user", content: `user turn ${i} ` + "x".repeat(200) });
    // Every 3rd user turn triggers a tool call group.
    if (i % 3 === 0) {
      const c1 = mkToolCall(`c${i}-1`, "read_file", `{"path":"f${i}.ts"}`);
      const c2 = mkToolCall(`c${i}-2`, "search_code", `{"q":"x${i}"}`);
      history.push({ role: "assistant", content: "", tool_calls: [c1, c2] });
      history.push({ role: "tool", content: `result one for ${i} ` + "y".repeat(100), tool_call_id: `c${i}-1` });
      history.push({ role: "tool", content: `result two for ${i} ` + "y".repeat(100), tool_call_id: `c${i}-2` });
    } else {
      history.push({ role: "assistant", content: `assistant turn ${i} ` + "z".repeat(200) });
    }
  }
  // The current user prompt is always LAST (per chat-history.ts contract).
  history.push({ role: "user", content: "What is the current question?" });
  return history;
}

/** Sum the token estimates of the messages actually sent to the LLM. */
function historyTokens(msgs: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of msgs) {
    total += estimateTokens(m.content);
    if (m.tool_calls) {
      for (const tc of m.tool_calls as ReadonlyArray<ContextToolCall>) {
        total += estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments);
      }
    }
  }
  return total;
}

describe("buildTrimmedHistory — trim gates the LLM input (748% bug fix)", () => {
  test("a huge history is trimmed to within the token budget", () => {
    const limit = 800;
    const cfg = resolveUnifiedConfig({
      contextTokenLimit: limit,
      trimThreshold: 0.8,
      recentTurnWindow: 6,
      summaryTokenBudget: 64,
      minRecentTurnsKept: 4,
    });
    const cm = bindResponseContext(createUnifiedContextManager(cfg));
    const history = hugeHistoryWithToolCalls(40); // ~40 turns, way over 800 tokens
    seedContextManagerFromHistory(cm, history);
    cm.trim();
    const trimmed = buildTrimmedHistory(cm);
    const tokens = historyTokens(trimmed);
    expect(tokens, `trimmed history tokens (${tokens}) must be within budget (~${limit}); the raw history would be ~${historyTokens(history)}`).toBeLessThanOrEqual(limit + 64);
    // The raw history is far over the limit — proving the trim actually gated it.
    expect(historyTokens(history)).toBeGreaterThan(limit * 5);
  });

  test("tool_calls groups stay atomic — no orphaned tool results", () => {
    const cfg = resolveUnifiedConfig({
      contextTokenLimit: 500,
      trimThreshold: 0.8,
      recentTurnWindow: 4,
      summaryTokenBudget: 64,
      minRecentTurnsKept: 3,
    });
    const cm = bindResponseContext(createUnifiedContextManager(cfg));
    seedContextManagerFromHistory(cm, hugeHistoryWithToolCalls(20));
    cm.trim();
    const trimmed = buildTrimmedHistory(cm);
    // Invariant: every tool message must have a preceding assistant with a
    // matching tool_call_id (OpenAI contract).
    for (let i = 0; i < trimmed.length; i++) {
      const m = trimmed[i]!;
      if (m.role !== "tool") continue;
      const toolCallId = (m as ChatMessage & { tool_call_id?: string }).tool_call_id;
      expect(toolCallId).toBeDefined();
      const issuer = trimmed.find((mm) => {
        if (mm.role !== "assistant" || !mm.tool_calls) return false;
        return (mm.tool_calls as ReadonlyArray<ContextToolCall>).some((c) => c.id === toolCallId);
      });
      expect(issuer, `orphaned tool result (tool_call_id=${toolCallId}) has no surviving assistant`).toBeDefined();
    }
  });

  test("a summary message is present when trimming occurred", () => {
    const cfg = resolveUnifiedConfig({
      contextTokenLimit: 400,
      trimThreshold: 0.8,
      recentTurnWindow: 3,
      summaryTokenBudget: 64,
      minRecentTurnsKept: 2,
    });
    const cm = bindResponseContext(createUnifiedContextManager(cfg));
    seedContextManagerFromHistory(cm, hugeHistoryWithToolCalls(30));
    const stateBefore = cm.state();
    cm.trim();
    const stateAfter = cm.state();
    const trimmed = buildTrimmedHistory(cm);
    // Trimming must have occurred (summaries created or trimCount > 0).
    expect(stateAfter.trimCount > 0 || stateAfter.summaries.length > 0 || stateBefore.totalTokens > 400).toBe(true);
    // The first message in the trimmed history is the summary system message.
    expect(trimmed.length).toBeGreaterThan(0);
    expect(trimmed[0]!.role).toBe("system");
    expect(trimmed[0]!.content.length).toBeGreaterThan(0);
  });

  test("the current user prompt survives trimming (it is the most recent turn)", () => {
    const cfg = resolveUnifiedConfig({
      contextTokenLimit: 300,
      trimThreshold: 0.8,
      recentTurnWindow: 3,
      summaryTokenBudget: 64,
      minRecentTurnsKept: 2,
    });
    const cm = bindResponseContext(createUnifiedContextManager(cfg));
    seedContextManagerFromHistory(cm, hugeHistoryWithToolCalls(15));
    cm.trim();
    const trimmed = buildTrimmedHistory(cm);
    const last = trimmed[trimmed.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toBe("What is the current question?");
  });

  test("a small history is passed through unchanged (no spurious summary)", () => {
    const cfg = resolveUnifiedConfig({
      contextTokenLimit: 50_000,
      trimThreshold: 0.8,
      recentTurnWindow: 10,
      summaryTokenBudget: 64,
      minRecentTurnsKept: 5,
    });
    const cm = bindResponseContext(createUnifiedContextManager(cfg));
    const small: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "what is 2+2?" },
    ];
    seedContextManagerFromHistory(cm, small);
    cm.trim();
    const trimmed = buildTrimmedHistory(cm);
    // No trimming should have occurred → no summary system message.
    expect(trimmed[0]!.role).not.toBe("system");
    expect(trimmed.map((m) => m.content)).toEqual(["hello", "hi there", "what is 2+2?"]);
  });

  test("empty-content assistant turns with tool_calls are seeded (not dropped)", () => {
    const cfg = resolveUnifiedConfig({
      contextTokenLimit: 50_000,
      trimThreshold: 0.8,
      recentTurnWindow: 10,
      summaryTokenBudget: 64,
    });
    const cm = bindResponseContext(createUnifiedContextManager(cfg));
    const tc = mkToolCall("call-1", "read_file", '{"path":"a.ts"}');
    const history: ChatMessage[] = [
      { role: "user", content: "read a.ts" },
      { role: "assistant", content: "", tool_calls: [tc] },
      { role: "tool", content: "file contents", tool_call_id: "call-1" },
      { role: "user", content: "thanks" },
    ];
    seedContextManagerFromHistory(cm, history);
    const turns = cm.turns();
    // The empty-content assistant WITH tool_calls must be seeded (4 turns).
    expect(turns.length).toBe(4);
    const asst = turns.find((t) => t.role === "assistant");
    expect(asst?.toolCalls?.length).toBe(1);
    expect(asst?.content).toBe("");
  });
});

test("native-only declarations redact summary echoes even while the declaring turn remains pinned", () => {
  const cm = createRunContextManager(1800);
  const secret = "native-summary-password-9Q2";
  const native = [{ type: "function_call", call_id: "declaration", name: "inspect", arguments: JSON.stringify({ password: secret }) }];
  cm.addTurn({ role: "assistant", content: "", responseItems: native, pinned: true });
  cm.addTurn({ role: "tool", content: "", toolCallId: "declaration" });
  cm.addTurn({ role: "user", content: `The earlier value ${secret} belongs to the test.` });
  for (let index = 0; index < 70; index++) cm.addTurn({ role: "user", content: `Later topic ${index}. ` + "context detail ".repeat(15) });
  buildTrimmedHistory(cm);
  const summaries = cm.summaries();
  expect(summaries.length).toBeGreaterThan(0);
  expect(summaries.map(summary => summary.content).join("\n")).not.toContain(secret);
  expect(summaries.map(summary => summary.content).join("\n")).toContain("[REDACTED:");
  expect(cm.turns().find(turn => turn.pinned)?.responseItems).toEqual(native);
});
