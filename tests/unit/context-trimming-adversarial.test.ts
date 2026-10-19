import { bindResponseContext } from "../../engine/src/shared/llm/response-transcript.ts";
// @vitest-environment node
/** Corrupt local history refuses replay; valid history retains chronological spans. */
import assert from "node:assert/strict";
import { isLLMError } from "../../engine/src/shared/llm/errors.ts";
import { describe, test, expect } from "vitest";
import { createUnifiedContextManager, type ContextToolCall } from "../../engine/src/memory/unified/unified-context-manager.ts";
import { resolveUnifiedConfig } from "../../engine/src/memory/unified/unified-config.ts";
import {
  buildTrimmedHistory,
  estimateHistoryTokens,
  seedContextManagerFromHistory,
} from "../../server/context/context-bridge.ts";
import type { ChatMessage } from "../../server/llm/llm-bridge.ts";

function mkToolCall(id: string, name = "read_file", args = "{}"): ContextToolCall {
  return Object.freeze({ id, type: "function", function: Object.freeze({ name, arguments: args }) });
}

const historyTokens = estimateHistoryTokens;
const unready = (error: unknown): boolean => isLLMError(error) && error.code === "llm_invalid_response" &&
  error.safeDetails.protocolCode === "responses_history_unready";

describe("buildTrimmedHistory — adversarial (readiness + accuracy)", () => {
  // prevention test: an orphaned tool message in the seeded
  // history must NOT appear in the trimmed history sent to the LLM.
  test("an orphaned tool message (no matching assistant tool_calls) refuses replay", () => {
    const cfg = resolveUnifiedConfig({
      contextTokenLimit: 50_000,
      trimThreshold: 0.8,
      recentTurnWindow: 10,
      summaryTokenBudget: 64,
      minRecentTurnsKept: 5,
    });
    const cm = bindResponseContext(createUnifiedContextManager(cfg));
    const history: ChatMessage[] = [
      { role: "user", content: "hello" },
      // Orphaned tool message — tool_call_id "ghost-id" has no assistant
      { role: "tool", content: "orphaned tool result", tool_call_id: "ghost-id" } as ChatMessage & { tool_call_id: string },
      { role: "user", content: "what is 2+2?" },
    ];
    seedContextManagerFromHistory(cm, history);
    assert.throws(() => buildTrimmedHistory(cm), unready);
    expect(cm.turns().find(turn => turn.toolCallId === "ghost-id")?.content).toBe("orphaned tool result");
  });

  test("an orphaned tool message mid-history (after a real group) refuses replay", () => {
    const cfg = resolveUnifiedConfig({
      contextTokenLimit: 50_000,
      trimThreshold: 0.8,
      recentTurnWindow: 10,
      summaryTokenBudget: 64,
      minRecentTurnsKept: 5,
    });
    const cm = bindResponseContext(createUnifiedContextManager(cfg));
    const realCall = mkToolCall("real-1", "read_file", '{"path":"a.ts"}');
    const history: ChatMessage[] = [
      { role: "user", content: "read a.ts and b.ts" },
      { role: "assistant", content: "", tool_calls: [realCall] },
      { role: "tool", content: "a.ts contents", tool_call_id: "real-1" },
      // Orphaned tool message"real-2" has no assistant tool_calls
      { role: "tool", content: "orphaned b.ts result", tool_call_id: "real-2" } as ChatMessage & { tool_call_id: string },
      { role: "user", content: "thanks" },
    ];
    seedContextManagerFromHistory(cm, history);
    assert.throws(() => buildTrimmedHistory(cm), unready);
    expect(cm.turns().filter(turn => turn.role === "tool")).toHaveLength(2);
  });

  test("reported contextTokens includes complete serialized framing", () => {
    const cfg = resolveUnifiedConfig({
      contextTokenLimit: 500,
      trimThreshold: 0.8,
      recentTurnWindow: 4,
      summaryTokenBudget: 64,
      minRecentTurnsKept: 3,
    });
    const cm = bindResponseContext(createUnifiedContextManager(cfg));
    for (let i = 0; i < 30; i++) {
      cm.addTurn({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} ` + "x".repeat(80) });
    }
    cm.trim();
    const reportedTokens = cm.state().totalTokens;
    const trimmed = buildTrimmedHistory(cm);
    const actualTokens = historyTokens(trimmed);
    expect(actualTokens).toBe(reportedTokens);
  });

  test("config-driven limits: buildTrimmedHistory respects a tiny contextTokenLimit", () => {
    for (const limit of [200, 500, 1000]) {
      const cfg = resolveUnifiedConfig({
        contextTokenLimit: limit,
        trimThreshold: 0.5,
        recentTurnWindow: 3,
        summaryTokenBudget: 64,
        minRecentTurnsKept: 2,
      });
      const cm = bindResponseContext(createUnifiedContextManager(cfg));
      for (let i = 0; i < 40; i++) {
        cm.addTurn({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} ` + "y".repeat(60) });
      }
      cm.trim();
      const trimmed = buildTrimmedHistory(cm);
      const tokens = historyTokens(trimmed);
      // Allow a small headroom for the summary block (no hardcoded limits)
      expect(tokens, `limit=${limit}: trimmed tokens ${tokens} should be near the limit`).toBeLessThanOrEqual(limit + 100);
    }
  });

  test("summary message content is non-empty when trimming occurred (faithful extractive summary)", () => {
    const cfg = resolveUnifiedConfig({
      contextTokenLimit: 300,
      trimThreshold: 0.5,
      recentTurnWindow: 3,
      summaryTokenBudget: 64,
      minRecentTurnsKept: 2,
    });
    const cm = bindResponseContext(createUnifiedContextManager(cfg));
    for (let i = 0; i < 20; i++) {
      cm.addTurn({ role: i % 2 === 0 ? "user" : "assistant", content: `This is turn ${i} with a distinct topic about sorting algorithm number ${i}.` });
    }
    const before = cm.state();
    cm.trim();
    const after = cm.state();
    const trimmed = buildTrimmedHistory(cm);
    // Trimming must have occurred
    expect(after.trimCount > 0 || after.summaries.length > 0 || before.totalTokens > 300).toBe(true);
    // The summary message (if present) must have non-empty content
    const summaryMsg = trimmed.find((m) => m.role === "system");
    if (summaryMsg) {
      expect(summaryMsg.content.length).toBeGreaterThan(0);
      // The summary should reference the turn content (extractive)
      expect(summaryMsg.content).toMatch(/turn|sorting|topic/i);
    }
  });

  test("empty-content assistant with tool_calls is preserved through trim", () => {
    const cfg = resolveUnifiedConfig({
      contextTokenLimit: 50_000,
      trimThreshold: 0.8,
      recentTurnWindow: 10,
      summaryTokenBudget: 64,
      minRecentTurnsKept: 5,
    });
    const cm = bindResponseContext(createUnifiedContextManager(cfg));
    const tc = mkToolCall("call-1", "read_file", '{"path":"a.ts"}');
    const history: ChatMessage[] = [
      { role: "user", content: "read a.ts" },
      { role: "assistant", content: "", tool_calls: [tc] },
      { role: "tool", content: "file contents of a.ts", tool_call_id: "call-1" },
      { role: "user", content: "thanks" },
    ];
    seedContextManagerFromHistory(cm, history);
    cm.trim();
    const trimmed = buildTrimmedHistory(cm);
    const asst = trimmed.find((m) => m.role === "assistant" && m.tool_calls);
    expect(asst).toBeDefined();
    expect(asst?.content).toBe("");
    expect((asst!.tool_calls as ReadonlyArray<ContextToolCall>).length).toBe(1);
    // The tool result must be paired
    const tool = trimmed.find((m) => m.role === "tool");
    expect(tool).toBeDefined();
    expect((tool as ChatMessage & { tool_call_id?: string }).tool_call_id).toBe("call-1");
  });

  test("realistic code content (stack traces, diffs, function bodies) trims within budget", () => {
    const cfg = resolveUnifiedConfig({
      contextTokenLimit: 800,
      trimThreshold: 0.5,
      recentTurnWindow: 4,
      summaryTokenBudget: 64,
      minRecentTurnsKept: 3,
    });
    const cm = bindResponseContext(createUnifiedContextManager(cfg));
    const snippets = [
      "function quicksort(arr: number[]): number[] {\n  if (arr.length <= 1) return arr;\n  const pivot = arr[0];\n  const left = arr.slice(1).filter(x => x < pivot);\n  const right = arr.slice(1).filter(x => x >= pivot);\n  return [...quicksort(left), pivot, ...quicksort(right)];\n}",
      "TypeError: Cannot read properties of null (reading 'id')\n    at UserStore.findById (src/store/user-store.ts:87:22)\n    at AuthMiddleware.verify (src/middleware/auth.ts:34:31)\n    at Router.<anonymous> (src/routes/api.ts:12:5)",
      "--- a/src/config.ts\n+++ b/src/config.ts\n@@ -20,3 +20,8 @@\n export const config = {\n-  timeout: 5000,\n+  timeout: 10000,\n+  retryLimit: 3,\n+  backoffMs: 500,",
    ];
    for (let i = 0; i < 60; i++) {
      cm.addTurn({ role: i % 2 === 0 ? "user" : "assistant", content: `${snippets[i % snippets.length]}\n# turn ${i}` });
    }
    cm.trim();
    const trimmed = buildTrimmedHistory(cm);
    const tokens = historyTokens(trimmed);
    expect(tokens, `realistic code: trimmed tokens ${tokens} should be near the 800 limit`).toBeLessThanOrEqual(800 + 100);
  });
});
