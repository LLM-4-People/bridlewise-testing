/**
 * Behavioral tests for the unified context manager's tool_calls grouping
 * (the core of the 748% context-trim bug fix).
 *
 * The OpenAI Chat Completions contract requires an assistant `tool_calls`
 * message to stay paired with its `tool` result messages (matching
 * `tool_call_id`). Orphaning either side is a 400. The unified manager's
 * `trim` therefore keeps a tool_calls GROUP atomic: an assistant with
 * tool_calls + ALL its tool result turns are kept or summarized TOGETHER.
 *
 * These tests verify that invariant holds under trim pressure.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createUnifiedContextManager, type ContextToolCall } from "../../../src/memory/unified/unified-context-manager.ts";
import { resolveUnifiedConfig } from "../../../src/memory/unified/unified-config.ts";
import { messagesToResponseInput, bindResponseContext, projectResponseContext } from "../../../src/shared/llm/response-transcript.ts";
import { estimateTokens } from "../../../src/memory/unified/tokenizer.ts";
import { isLLMError } from "../../../src/shared/llm/errors.ts";

function mkToolCall(id: string, name = "read_file", args = "{}"): ContextToolCall {
  return Object.freeze({ id, type: "function", function: Object.freeze({ name, arguments: args }) });
}

function smallCtx(overrides: { contextTokenLimit?: number; recentTurnWindow?: number; summaryTokenBudget?: number; trimThreshold?: number } = {}) {
  return resolveUnifiedConfig({
    contextTokenLimit: overrides.contextTokenLimit ?? 120,
    trimThreshold: overrides.trimThreshold ?? 0.5,
    recentTurnWindow: overrides.recentTurnWindow ?? 2,
    summaryTokenBudget: overrides.summaryTokenBudget ?? 64,
    minRecentTurnsKept: 2,
  });
}

test("native context prices the serialized input once and retains empty results and opaque output", () => {
  const ctx = bindResponseContext(createUnifiedContextManager(smallCtx({ contextTokenLimit: 50_000 })));
  const output = [
    { type: "reasoning", id: "rs", summary: [], encrypted_content: "opaque unchanged" },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "refusal", refusal: "declined" }], extension: [1, 2] },
    { type: "function_call", call_id: "native", name: "edit", arguments: JSON.stringify({ body: "x".repeat(8000) }), caller: { type: "direct" } },
  ];
  ctx.addTurn({ role: "assistant", content: "display duplicate".repeat(2000), responseItems: output,
    toolCalls: [mkToolCall("wrong", "wrong", "y".repeat(8000))] });
  ctx.addTurn({ role: "tool", content: "", toolCallId: "native" });
  const expected = [...output, { type: "function_call_output", call_id: "native", output: "", caller: { type: "direct" } }];
  assert.deepEqual(messagesToResponseInput(projectResponseContext(ctx)), expected);
  assert.equal(ctx.tokenCount(), estimateTokens(JSON.stringify(expected)));
  assert.ok(ctx.tokenCount() > 2000, "native arguments contribute their full size");
  ctx.trim();
  assert.deepEqual(messagesToResponseInput(projectResponseContext(ctx)), expected);
});

test("blocked native empty output cannot disappear through trim, replacement or removal", () => {
  for (const operation of ["trim", "remove", "replace"] as const) {
    const ctx = bindResponseContext(createUnifiedContextManager(smallCtx()));
    const blocked = ctx.addTurn({ role: "assistant", content: "", responseItems: [], responseReplayBlocked: true });
    for (let index = 0; index < 20; index++) ctx.addTurn({ role: "user", content: `later ${index} ` + "x".repeat(100) });
    if (operation === "remove") ctx.removeTurn(blocked.turnId);
    if (operation === "replace") ctx.replaceTurns(ctx.turns().filter(turn => turn.turnId !== blocked.turnId));
    assert.throws(() => ctx.trim(), error => isLLMError(error) && error.code === "llm_invalid_response" &&
      error.safeDetails.protocolCode === "responses_history_unready");
    ctx.clear(); ctx.addTurn({ role: "user", content: "new conversation" }); ctx.trim();
  }
});

test("native policy binds before capture and settles readiness only through the same captured turn", () => {
  const unbound = createUnifiedContextManager(smallCtx());
  assert.throws(() => unbound.addTurn({ role: "assistant", content: "", responseItems: [] }), { code: "context_projection_missing" });
  unbound.addTurn({ role: "user", content: "already charged domain history" });
  assert.throws(() => bindResponseContext(unbound), { code: "context_projection_late" });
  const ctx = bindResponseContext(createUnifiedContextManager(smallCtx({ contextTokenLimit: 500 })));
  const partial = ctx.addTurn({ role: "assistant", content: "", responseItems: [], responseReplayBlocked: true });
  assert.throws(() => projectResponseContext(ctx), error => isLLMError(error) && error.safeDetails.protocolCode === "responses_history_unready");
  const completed = ctx.updateTurn(partial.turnId, { role: "assistant", content: "", responseItems: [] });
  assert.equal(completed.turnNumber, partial.turnNumber);
  assert.equal(completed.timestamp, partial.timestamp);
  assert.deepEqual(messagesToResponseInput(projectResponseContext(ctx)), []);
  assert.equal(ctx.addTurn({ role: "user", content: "next" }).turnNumber, partial.turnNumber + 1);
});

test("native projection validates delivered local pairs independently from private evidence", () => {
  for (const removed of ["call", "result"] as const) {
    const ctx = bindResponseContext(createUnifiedContextManager(smallCtx({ contextTokenLimit: 500 })));
    const call = ctx.addTurn({ role: "assistant", content: "", toolCalls: [mkToolCall("paired")] });
    const result = ctx.addTurn({ role: "tool", content: "", toolCallId: "paired" });
    ctx.removeTurn(removed === "call" ? call.turnId : result.turnId);
    assert.throws(() => projectResponseContext(ctx), error => isLLMError(error) && error.safeDetails.protocolCode === "responses_history_unready");
    assert.throws(() => ctx.trim(), error => isLLMError(error) && error.safeDetails.protocolCode === "responses_history_unready");
  }
  const remote = bindResponseContext(createUnifiedContextManager(smallCtx({ contextTokenLimit: 500 })));
  const items = [{ type: "item_reference", id: "provider-held" }];
  remote.addTurn({ role: "tool", content: "", responseItems: items });
  assert.deepEqual(messagesToResponseInput(projectResponseContext(remote)), items);
  const externalOutput = { type: "function_call_output", call_id: "provider-held-call", output: "" };
  assert.deepEqual(messagesToResponseInput([{ role: "tool", content: "", responseItems: [externalOutput] }]), [externalOutput]);
  remote.addTurn({ role: "tool", content: "", responseItems: [externalOutput] });
  assert.throws(() => projectResponseContext(remote), error => isLLMError(error) && error.safeDetails.protocolCode === "responses_history_unready");
});

test("hard-limit eviction respects any pinned member of overlapping chronological spans", () => {
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 120, recentTurnWindow: 1 }));
  const a = ctx.addTurn({ role: "assistant", content: "", toolCalls: [mkToolCall("a", "read", "x".repeat(500))] });
  const between = ctx.addTurn({ role: "user", content: "intervening steering" });
  const b = ctx.addTurn({ role: "assistant", content: "", toolCalls: [mkToolCall("b")] });
  const ar = ctx.addTurn({ role: "tool", content: "", toolCallId: "a", pinned: true });
  const br = ctx.addTurn({ role: "tool", content: "", toolCallId: "b" });
  ctx.addTurn({ role: "user", content: "evictable after".repeat(50) });
  ctx.trim();
  assert.deepEqual(ctx.turns().map(turn => turn.turnId), [a, between, b, ar, br].map(turn => turn.turnId));
  assert.ok(ctx.tokenCount() > ctx.tokenLimit(), "pinned evidence honestly exceeds the limit");
});

// ========== Tool calls on turns ==========

test("unified-ctx: addTurn carries toolCalls on an assistant turn", () => {
  const ctx = createUnifiedContextManager(smallCtx());
  const tc = mkToolCall("call-1", "read_file", '{"path":"a.ts"}');
  const turn = ctx.addTurn({ role: "assistant", content: "", toolCalls: [tc] });
  assert.equal(turn.toolCalls?.length, 1);
  assert.equal(turn.toolCalls![0]!.id, "call-1");
  assert.ok(turn.tokenEstimate > 0, "empty content with toolCalls must still count tokens");
});

test("unified-ctx: addTurn carries toolCallId on a tool result turn", () => {
  const ctx = createUnifiedContextManager(smallCtx());
  const turn = ctx.addTurn({ role: "tool", content: "file contents here", toolCallId: "call-1" });
  assert.equal(turn.toolCallId, "call-1");
  assert.equal(turn.role, "tool");
});

test("unified-ctx: empty content is allowed when toolCalls present", () => {
  const ctx = createUnifiedContextManager(smallCtx());
  const tc = mkToolCall("c");
  // Must NOT throw — an assistant that only requested tools has empty content.
  const turn = ctx.addTurn({ role: "assistant", content: "", toolCalls: [tc] });
  assert.equal(turn.content, "");
});

test("unified-ctx: empty content with no toolCalls is rejected", () => {
  const ctx = createUnifiedContextManager(smallCtx());
  assert.throws(() => ctx.addTurn({ role: "user", content: "" }), /empty/);
});

test("unified-ctx: token estimate includes tool_calls arguments", () => {
  const ctx = createUnifiedContextManager(smallCtx());
  const longArgs = '{"path":"' + "x".repeat(200) + '"}';
  const tc = mkToolCall("c", "edit", longArgs);
  const turn = ctx.addTurn({ role: "assistant", content: "", toolCalls: [tc] });
  // estimateTokens(chars/4) over the arguments should make this non-trivial.
  assert.ok(turn.tokenEstimate > 50, `tool_calls args must count toward tokens; got ${turn.tokenEstimate}`);
});

// ========== Atomic tool_calls grouping during trim ==========

test("unified-ctx: trim keeps a tool_calls group ATOMIC (assistant + tool results together)", () => {
  // recentTurnWindow=2 would keep only the last 2 turns, but a tool_calls
  // group straddling the boundary must be kept WHOLE (no orphaned tool
  // results). Build: [u, a(tool_calls), tool, tool, u, a(tool_calls), tool].
  // The first group is older; its assistant might fall outside the recent
  // window while some of its tool results could be kept — the group must
  // stay together (all kept or all summarized).
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 4000, recentTurnWindow: 2, summaryTokenBudget: 64 }));
  ctx.addTurn({ role: "user", content: "user message one with enough text here" });
  const a1 = ctx.addTurn({ role: "assistant", content: "", toolCalls: [mkToolCall("c1"), mkToolCall("c2")] });
  const t1 = ctx.addTurn({ role: "tool", content: "result one content here", toolCallId: "c1" });
  const t2 = ctx.addTurn({ role: "tool", content: "result two content here", toolCallId: "c2" });
  ctx.addTurn({ role: "user", content: "user message two with enough text here" });
  ctx.addTurn({ role: "assistant", content: "final assistant response that is long enough" });

  // Force a trim by exceeding the threshold.
  const state = ctx.trim();
  // Either the whole first group survived, or none of it did — but never
  // an orphaned tool result without its assistant (or vice versa).
  const survivingIds = new Set(state.turns.map((t) => t.turnId));
  const a1Survives = survivingIds.has(a1.turnId);
  const t1Survives = survivingIds.has(t1.turnId);
  const t2Survives = survivingIds.has(t2.turnId);
  assert.equal(a1Survives, t1Survives, "assistant tool_calls and tool result c1 must survive together");
  assert.equal(a1Survives, t2Survives, "assistant tool_calls and tool result c2 must survive together");
});

test("unified-ctx: trim never orphans a tool result (no tool without its assistant)", () => {
  // Heap of turns well over the limit; after trim, every surviving tool
  // turn must be preceded (in the surviving sequence) by its assistant
  // tool_calls turn. This is the OpenAI API contract invariant.
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 200, recentTurnWindow: 4, summaryTokenBudget: 64 }));
  for (let g = 0; g < 8; g++) {
    ctx.addTurn({ role: "user", content: `group ${g} user prompt with enough text to be meaningful` });
    ctx.addTurn({ role: "assistant", content: "", toolCalls: [mkToolCall(`g${g}-c1`), mkToolCall(`g${g}-c2`)] });
    ctx.addTurn({ role: "tool", content: `group ${g} result one`, toolCallId: `g${g}-c1` });
    ctx.addTurn({ role: "tool", content: `group ${g} result two`, toolCallId: `g${g}-c2` });
  }
  ctx.trim();
  const turns = ctx.turns();
  // Invariant: every tool turn must have a preceding assistant with a
  // matching tool_call_id, OR be the start of a surviving group.
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.role !== "tool") continue;
    // Find the assistant that issued this tool_call_id (must be present).
    const issuer = turns.find((tt) => tt.role === "assistant" && tt.toolCalls?.some((c) => c.id === t.toolCallId));
    assert.ok(issuer !== undefined, `orphaned tool result for ${t.toolCallId} — no issuing assistant survives`);
    const issuerIdx = turns.indexOf(issuer);
    assert.ok(issuerIdx <= i, `tool result for ${t.toolCallId} appears before its assistant`);
  }
});

test("unified-ctx: trim reduces token count below the limit", () => {
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 100, recentTurnWindow: 2, summaryTokenBudget: 32 }));
  for (let i = 0; i < 50; i++) {
    ctx.addTurn({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} ` + "x".repeat(40) });
  }
  ctx.trim();
  assert.ok(ctx.tokenCount() <= 100, `after trim, tokens ${ctx.tokenCount()} must be <= 100`);
});

test("unified-ctx: trimming a tool_calls group evicts it ATOMICALLY", () => {
  // Tiny limit forces eviction of whole groups. After trim, NO partial
  // group survives: a surviving tool result implies its assistant survives.
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 60, recentTurnWindow: 1, summaryTokenBudget: 32 }));
  ctx.addTurn({ role: "user", content: "old user prompt here with enough text" });
  ctx.addTurn({ role: "assistant", content: "", toolCalls: [mkToolCall("old-c")] });
  ctx.addTurn({ role: "tool", content: "old tool result content here", toolCallId: "old-c" });
  // Newer turns that will be the recent window.
  ctx.addTurn({ role: "user", content: "new user prompt here with enough text" });
  ctx.addTurn({ role: "assistant", content: "new assistant response with enough text" });
  ctx.trim();
  const turns = ctx.turns();
  // If the old tool result survived, its assistant must also survive.
  const oldToolSurvives = turns.some((t) => t.toolCallId === "old-c");
  const oldAssistantSurvives = turns.some((t) => t.toolCalls?.some((c) => c.id === "old-c"));
  assert.equal(oldToolSurvives, oldAssistantSurvives, "old tool result and its assistant must both survive or both be evicted");
});

test("unified-ctx: turn numbers stay unique after trim (auto-assignment)", () => {
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 40, recentTurnWindow: 1, summaryTokenBudget: 32 }));
  for (let i = 0; i < 10; i++) {
    ctx.addTurn({ role: "user", content: `turn ${i} with enough text to count` });
    ctx.trim();
  }
  const turns = ctx.turns();
  const nums = new Set(turns.map((t) => t.turnNumber));
  assert.equal(nums.size, turns.length, "auto-assigned turn numbers must be unique after trims");
});
