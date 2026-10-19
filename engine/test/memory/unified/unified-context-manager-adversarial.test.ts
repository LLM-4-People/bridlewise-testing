/**
 * ADVERSARIAL tests for the unified context manager's trim mechanism.
 *
 * These tests ESCALATE difficulty 10×: improper usage,
 * unknown results, edge cases that should NOT work, realistic codebase-
 * style content, many turns, config-driven limits, multiple trim cycles.
 *
 * KEY FINDINGS (verified by independent reproduction):
 * BUG 1 (CRITICAL): summaryList accumulates unboundedly across trim
 * cycles. The eviction loop only evicts from activeTurns, never from
 * summaryList. After enough cycles, the accumulated summaries exceed
 * the token limit and NOTHING can reduce them — the same class of bug
 * as the 748% decorative-trimming bug, just slow-acting.
 * The current-prompt-lost edge case: a single turn > limit is dropped
 * entirely, losing the user's question.
 * Idempotency: trim called twice (no new turns) spuriously increments
 * trimCount even when nothing is evicted/summarized.
 *
 * These tests assert the CORRECT behavior. BUG 1's test FAILS until the
 * fix agent prunes summaryList when the total exceeds the limit.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createUnifiedContextManager, type ContextToolCall } from "../../../src/memory/unified/unified-context-manager.ts";
import { resolveUnifiedConfig } from "../../../src/memory/unified/unified-config.ts";

function mkToolCall(id: string, name = "read_file", args = "{}"): ContextToolCall {
  return Object.freeze({ id, type: "function", function: Object.freeze({ name, arguments: args }) });
}

function smallCtx(overrides: { contextTokenLimit?: number; recentTurnWindow?: number; summaryTokenBudget?: number; trimThreshold?: number; minRecentTurnsKept?: number } = {}) {
  return resolveUnifiedConfig({
    contextTokenLimit: overrides.contextTokenLimit ?? 120,
    trimThreshold: overrides.trimThreshold ?? 0.5,
    recentTurnWindow: overrides.recentTurnWindow ?? 2,
    summaryTokenBudget: overrides.summaryTokenBudget ?? 64,
    minRecentTurnsKept: overrides.minRecentTurnsKept ?? 2,
  });
}

// ========== BUG 1: summaryList accumulation (CRITICAL) ==========

test("ADV: summaryList does NOT accumulate past the token limit over many trim cycles", () => {
  // Reproduction: 8 trim cycles, limit=150, recentWindow=3, summaryBudget=64.
  // BEFORE the fix: after cycle 2, totalTokens=221 > 150; by cycle 7, 591.
  // The eviction loop only evicts from activeTurns, never from summaryList.
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 150, recentTurnWindow: 3, summaryTokenBudget: 64, minRecentTurnsKept: 2 }));
  for (let cycle = 0; cycle < 8; cycle++) {
    for (let i = 0; i < 8; i++) {
      ctx.addTurn({ role: i % 2 === 0 ? "user" : "assistant", content: `c${cycle}t${i} ` + "w".repeat(40) });
    }
    ctx.trim();
  }
  const tokens = ctx.tokenCount();
  const limit = 150;
  assert.ok(tokens <= limit, `BUG: summaryList accumulated — totalTokens=${tokens} exceeds limit=${limit}. The eviction loop must also prune old summaries when they alone exceed the budget.`);
});

test("ADV: after trim, buildTrimmedHistory-equivalent token count stays under the limit", () => {
  // The invariant "LLM never receives > contextTokenLimit tokens" must hold
  // even after many trim cycles. The manager's tokenCount includes the
  // summaries; if that exceeds the limit, the derived history exceeds it.
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 200, recentTurnWindow: 4, summaryTokenBudget: 80, minRecentTurnsKept: 3 }));
  for (let cycle = 0; cycle < 10; cycle++) {
    for (let i = 0; i < 10; i++) {
      ctx.addTurn({ role: i % 2 === 0 ? "user" : "assistant", content: `cycle${cycle}turn${i} ` + "z".repeat(50) });
    }
    ctx.trim();
  }
  assert.ok(ctx.tokenCount() <= 200, `tokenCount=${ctx.tokenCount()} must be <= 200 after 10 trim cycles (summaryList must be bounded)`);
});

// ========== Adjacent tool_calls groups with 5+ calls each ==========

test("ADV: adjacent tool_calls groups (5+ calls each) stay atomic at the trim boundary", () => {
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 4000, recentTurnWindow: 3, summaryTokenBudget: 64 }));
  ctx.addTurn({ role: "user", content: "user one with enough text here to be meaningful" });
  const a1 = ctx.addTurn({ role: "assistant", content: "", toolCalls: [mkToolCall("g1c1"), mkToolCall("g1c2"), mkToolCall("g1c3"), mkToolCall("g1c4"), mkToolCall("g1c5")] });
  const t1 = [0,1,2,3,4].map((k) => ctx.addTurn({ role: "tool", content: `g1 result ${k} content here`, toolCallId: `g1c${k+1}` }));
  // Adjacent group 2 (immediately after group 1's last tool result)
  const a2 = ctx.addTurn({ role: "assistant", content: "", toolCalls: [mkToolCall("g2c1"), mkToolCall("g2c2"), mkToolCall("g2c3")] });
  const t2 = [0,1,2].map((k) => ctx.addTurn({ role: "tool", content: `g2 result ${k} content here`, toolCallId: `g2c${k+1}` }));
  ctx.addTurn({ role: "user", content: "latest user message with enough text here" });
  ctx.addTurn({ role: "assistant", content: "latest assistant response with enough text" });
  ctx.trim();
  const turns = ctx.turns();
  const ids = new Set(turns.map((t) => t.turnId));
  // Group 1: all kept or all dropped
  const g1 = [a1, ...t1];
  const g1Atomic = g1.every((t) => ids.has(t.turnId)) || g1.every((t) => !ids.has(t.turnId));
  assert.ok(g1Atomic, "group1 (5 tool_calls) must be atomic — all kept or all dropped");
  // Group 2: all kept or all dropped
  const g2 = [a2, ...t2];
  const g2Atomic = g2.every((t) => ids.has(t.turnId)) || g2.every((t) => !ids.has(t.turnId));
  assert.ok(g2Atomic, "group2 (3 tool_calls) must be atomic — all kept or all dropped");
  // No orphaned tool in surviving turns
  for (const t of turns) {
    if (t.role !== "tool") continue;
    const issuer = turns.find((tt) => tt.role === "assistant" && tt.toolCalls?.some((c) => c.id === t.toolCallId));
    assert.ok(issuer, `orphaned tool result ${t.toolCallId} — no issuing assistant survives`);
  }
});

// ========== Pinned turn inside a tool_calls group ==========

test("ADV: pinning a tool result inside a group keeps the whole group", () => {
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 4000, recentTurnWindow: 1, summaryTokenBudget: 64 }));
  ctx.addTurn({ role: "user", content: "old user message with enough text" });
  const a = ctx.addTurn({ role: "assistant", content: "", toolCalls: [mkToolCall("pc1"), mkToolCall("pc2")] });
  const t1 = ctx.addTurn({ role: "tool", content: "pinned result content here", toolCallId: "pc1" });
  const t2 = ctx.addTurn({ role: "tool", content: "other result content here", toolCallId: "pc2" });
  ctx.addTurn({ role: "user", content: "new user message with enough text here" });
  ctx.addTurn({ role: "assistant", content: "new assistant response with enough text" });
  // Pin the SECOND tool result (not the head assistant)
  ctx.pinTurn(t2.turnId);
  ctx.trim();
  const ids = new Set(ctx.turns().map((t) => t.turnId));
  // Pinning t2 must keep the whole group (a + t1 + t2) via expandKeepSetForToolCallGroups
  assert.ok(ids.has(a.turnId), "pinned tool result must keep its assistant tool_calls (group expansion)");
  assert.ok(ids.has(t1.turnId), "pinned tool result must keep its sibling tool result (group expansion)");
  assert.ok(ids.has(t2.turnId), "pinned tool result survives");
});

// ========== Very large single turn (> tokenLimit) ==========

test("ADV: a single turn exceeding the limit does not infinite-loop or crash", () => {
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 100, recentTurnWindow: 2, summaryTokenBudget: 32 }));
  ctx.addTurn({ role: "user", content: "x".repeat(10000) });
  const t0 = Date.now();
  ctx.trim();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `trim must terminate in < 5s (got ${elapsed}ms)`);
  // Note: the current-prompt-lost edge case — the huge turn is dropped
  // entirely. This is a known limitation; a single message > limit has no
  // valid representation. The manager does not crash (good) but the user's
  // question is lost (tracked as a finding, not asserted here).
});

// ========== 1000 small turns — termination + performance ==========

test("ADV: 1000 small turns trim terminates quickly and stays under the limit", () => {
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 200, recentTurnWindow: 4, summaryTokenBudget: 64 }));
  for (let i = 0; i < 1000; i++) {
    ctx.addTurn({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} small content here for testing` });
  }
  const t0 = Date.now();
  ctx.trim();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `trim of 1000 turns must be fast (got ${elapsed}ms)`);
  assert.ok(ctx.tokenCount() <= 200, `after trim tokens=${ctx.tokenCount()} must be <= 200`);
});

// ========== All-pinned over-limit — no infinite loop ==========

test("ADV: all-pinned turns over the limit do not cause an infinite loop", () => {
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 50, recentTurnWindow: 1, summaryTokenBudget: 32 }));
  for (let i = 0; i < 10; i++) {
    ctx.addTurn({ role: "user", content: `pinned turn ${i} ` + "z".repeat(20), pinned: true });
  }
  const t0 = Date.now();
  ctx.trim();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `all-pinned trim must not infinite-loop (got ${elapsed}ms)`);
  // All pinned turns survive (can't evict pinned) — stays over limit.
  // This is a degenerate case; the user pinned everything.
  assert.equal(ctx.turns().length, 10, "all pinned turns survive");
});

// ========== Config-driven limits ==========

test("ADV: trim respects the configured contextTokenLimit (no hardcoded limit)", () => {
  for (const limit of [50, 100, 300, 1000]) {
    const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: limit, recentTurnWindow: 2, summaryTokenBudget: 32 }));
    for (let i = 0; i < 60; i++) {
      ctx.addTurn({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} ` + "y".repeat(40) });
    }
    ctx.trim();
    assert.ok(ctx.tokenCount() <= limit, `with limit=${limit}, tokens=${ctx.tokenCount()} must be <= ${limit}`);
  }
});

test("ADV: trim respects the configured trimThreshold (triggers at the right point)", () => {
  for (const threshold of [0.5, 0.7, 0.9]) {
    const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 1000, recentTurnWindow: 2, summaryTokenBudget: 64, trimThreshold: threshold }));
    // Add turns to just below the threshold
    const targetTokens = Math.floor(1000 * threshold) - 10;
    let added = 0;
    while (added < targetTokens) {
      const turn = ctx.addTurn({ role: "user", content: "x".repeat(40) });
      added = ctx.tokenCount();
      if (added > targetTokens) { ctx.removeTurn(turn.turnId); break; }
    }
    // shouldTrim must be false (below threshold)
    assert.equal(ctx.shouldTrim(), false, `threshold=${threshold}: below threshold should not trim`);
    // Add one more turn to cross the threshold
    ctx.addTurn({ role: "user", content: "x".repeat(200) });
    assert.equal(ctx.shouldTrim(), true, `threshold=${threshold}: above threshold should trim`);
  }
});

// ========== Multiple trim cycles — turn number uniqueness ==========

test("ADV: turn numbers stay unique after many interleaved add+trim cycles", () => {
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 80, recentTurnWindow: 1, summaryTokenBudget: 32 }));
  for (let i = 0; i < 30; i++) {
    ctx.addTurn({ role: "user", content: `turn ${i} with enough text to count tokens` });
    ctx.trim();
  }
  const turns = ctx.turns();
  const nums = new Set(turns.map((t) => t.turnNumber));
  assert.equal(nums.size, turns.length, "auto-assigned turn numbers must be unique after 30 add+trim cycles");
});

// ========== Realistic codebase-style content ==========

test("ADV: realistic code content (function bodies, stack traces) trims correctly", () => {
  const ctx = createUnifiedContextManager(smallCtx({ contextTokenLimit: 500, recentTurnWindow: 4, summaryTokenBudget: 64 }));
  const codeTurns = [
    "function mergeSort(arr) {\n  if (arr.length <= 1) return arr;\n  const mid = Math.floor(arr.length / 2);\n  const left = mergeSort(arr.slice(0, mid));\n  const right = mergeSort(arr.slice(mid));\n  return merge(left, right);\n}",
    "Error: Cannot read property 'map' of undefined\n    at processArray (src/utils.ts:42:18)\n    at handleRequest (server.ts:128:9)\n    at Server.<anonymous> (index.ts:15:5)",
    "diff --git a/src/main.ts b/src/main.ts\nindex 1234567..abcdefg 100644\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -10,7 +10,7 @@\n-const old = true;\n+const updated = false;",
    "import { Router } from 'express';\nconst router = Router();\nrouter.get('/api/users', async (req, res) => {\n  const users = await db.query('SELECT * FROM users');\n  res.json(users);\n});\nexport default router;",
  ];
  for (let i = 0; i < 40; i++) {
    const content = codeTurns[i % codeTurns.length]!;
    ctx.addTurn({ role: i % 2 === 0 ? "user" : "assistant", content: `${content}\n-- turn ${i}` });
  }
  ctx.trim();
  assert.ok(ctx.tokenCount() <= 500, `realistic code content: tokens=${ctx.tokenCount()} must be <= 500`);
});
