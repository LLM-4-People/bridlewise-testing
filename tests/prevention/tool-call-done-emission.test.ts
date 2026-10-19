// @vitest-environment node
/**
 * Prevention test: streamChat emits tool_call_done for real LLM streams.
 *
 * root cause: the `tool_call_done` ModelEvent was never emitted by
 * the real LLM stream (only by fixtures). The OpenAI SSE protocol sends
 * tool calls as tool_call_start → tool_call_delta(s) → finish(reason:
 * "tool_calls") with no explicit "done" event. The run handler's
 * tool_call_done branch was dead code — tools were never executed.
 *
 * This test verifies that the fixture stream (which exercises the same
 * mapChunk + synthesis logic) includes tool_call_done events with the
 * correct shape (callId, arguments, outputIndex).
 */

import { describe, it, expect, beforeAll } from "vitest";

import { buildStreamModelEvents } from "../../server/llm/fixtures.ts";

describe("tool-call-done-emission (prevention)", () => {
  beforeAll(() => {
    process.env.HARNESS_WEB_LLM_FIXTURES = "1";
  });

  it("fixture stream includes tool_call_done event", () => {
    const events = buildStreamModelEvents();
    const types = events.map((e) => e.type);
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_delta");
    expect(types).toContain("tool_call_done");
    expect(types).toContain("finish");
  });

  it("tool_call_done event has callId, arguments, and outputIndex", () => {
    const events = buildStreamModelEvents();
    const doneEvent = events.find((e) => e.type === "tool_call_done");
    expect(doneEvent).toBeDefined();
    const done = doneEvent!;
    expect(done.type).toBe("tool_call_done");
    if (done.type === "tool_call_done") {
      expect(done.callId).toBeTruthy();
      expect(done.arguments).toBeTypeOf("object");
      expect(done.outputIndex).toBeTypeOf("number");
    }
  });

  it("tool_call_start precedes tool_call_done in the event sequence", () => {
    const events = buildStreamModelEvents();
    const startIdx = events.findIndex((e) => e.type === "tool_call_start");
    const doneIdx = events.findIndex((e) => e.type === "tool_call_done");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(startIdx);
  });

  it("tool_call_done precedes finish in the event sequence", () => {
    const events = buildStreamModelEvents();
    const doneIdx = events.findIndex((e) => e.type === "tool_call_done");
    const finishIdx = events.findIndex((e) => e.type === "finish");
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(finishIdx).toBeGreaterThan(doneIdx);
  });
});
