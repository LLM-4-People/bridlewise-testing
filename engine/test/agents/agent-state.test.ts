import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createTempDir } from "../support/temp-dir.ts";
import {
  createAgentStateStore,
  compactAgentTurns,
  AGENT_LIFECYCLE_STATES,
} from "../../src/agents/agent-state.ts";

function createTempStore() {
  const dir = createTempDir("agent-state-test-");
  const store = createTimelineStore({ path: join(dir, "timeline.db") });
  return { store, dir };
}

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ============================================================================
// createAgentStateStore — recordAgentStart
// ============================================================================

test("Agent state: recordAgentStart creates running state", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    const state = stateStore.recordAgentStart({
      agentName: "researcher",
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
    });
    assert.equal(state.lifecycleState, "running");
    assert.equal(state.agentName, "researcher");
    assert.equal(state.runId, "run-1");
    assert.equal(state.taskId, "task-1");
    assert.equal(state.turnCount, 0);
    assert.equal(state.totalTokens, 0);
    assert.equal(state.lastError, null);
    assert.equal(state.compactionSummary, null);
    assert.ok(state.agentId.length > 0);
  } finally { cleanup(dir); }
});

test("Agent state: recordAgentStart accepts custom agentId", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    const state = stateStore.recordAgentStart({
      agentId: "custom-id",
      agentName: "test",
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
    });
    assert.equal(state.agentId, "custom-id");
  } finally { cleanup(dir); }
});

test("Agent state: recordAgentStart state is frozen", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    const state = stateStore.recordAgentStart({
      agentName: "test",
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
    });
    assert.ok(Object.isFrozen(state));
  } finally { cleanup(dir); }
});

test("Agent state: recordAgentStart generates unique agentIds", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    const state1 = stateStore.recordAgentStart({ agentName: "a", runId: "r", taskId: "t", attemptId: "a1" });
    const state2 = stateStore.recordAgentStart({ agentName: "b", runId: "r", taskId: "t", attemptId: "a2" });
    assert.notEqual(state1.agentId, state2.agentId);
  } finally { cleanup(dir); }
});

// ============================================================================
// recordAgentTurn
// ============================================================================

test("Agent state: recordAgentTurn increments turn count", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const states = stateStore.allAgentStates();
    const agentId = states[0]!.agentId;
    stateStore.recordAgentTurn({
      agentId, runId: "r", taskId: "t", attemptId: "a1",
      turnId: "turn-1", turnNumber: 1, content: "Hello",
      toolCallCount: 0, promptTokens: 10, completionTokens: 5, totalTokens: 15,
      finishReason: "stop",
    });
    const state = stateStore.getAgentState(agentId)!;
    assert.equal(state.turnCount, 1);
    assert.equal(state.totalTokens, 15);
    assert.equal(state.turns.length, 1);
  } finally { cleanup(dir); }
});

test("Agent state: recordAgentTurn accumulates token totals", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const agentId = stateStore.allAgentStates()[0]!.agentId;
    stateStore.recordAgentTurn({
      agentId, runId: "r", taskId: "t", attemptId: "a1",
      turnId: "t1", turnNumber: 1, content: "a", toolCallCount: 0,
      promptTokens: 10, completionTokens: 5, totalTokens: 15, finishReason: "stop",
    });
    stateStore.recordAgentTurn({
      agentId, runId: "r", taskId: "t", attemptId: "a1",
      turnId: "t2", turnNumber: 2, content: "b", toolCallCount: 1,
      promptTokens: 20, completionTokens: 10, totalTokens: 30, finishReason: "stop",
    });
    const state = stateStore.getAgentState(agentId)!;
    assert.equal(state.turnCount, 2);
    assert.equal(state.totalPromptTokens, 30);
    assert.equal(state.totalCompletionTokens, 15);
    assert.equal(state.totalTokens, 45);
  } finally { cleanup(dir); }
});

test("Agent state: recordAgentTurn stores turn records", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const agentId = stateStore.allAgentStates()[0]!.agentId;
    stateStore.recordAgentTurn({
      agentId, runId: "r", taskId: "t", attemptId: "a1",
      turnId: "turn-1", turnNumber: 1, content: "result",
      toolCallCount: 2, promptTokens: 100, completionTokens: 50,
      totalTokens: 150, finishReason: "stop",
    });
    const state = stateStore.getAgentState(agentId)!;
    assert.equal(state.turns.length, 1);
    assert.equal(state.turns[0]!.turnId, "turn-1");
    assert.equal(state.turns[0]!.turnNumber, 1);
    assert.equal(state.turns[0]!.content, "result");
    assert.equal(state.turns[0]!.toolCallCount, 2);
    assert.equal(state.turns[0]!.totalTokens, 150);
    assert.equal(state.turns[0]!.finishReason, "stop");
  } finally { cleanup(dir); }
});

test("Agent state: recordAgentTurn handles zero tokens", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const agentId = stateStore.allAgentStates()[0]!.agentId;
    stateStore.recordAgentTurn({
      agentId, runId: "r", taskId: "t", attemptId: "a1",
      turnId: "t1", turnNumber: 1, content: "", toolCallCount: 0,
      promptTokens: 0, completionTokens: 0, totalTokens: 0, finishReason: "stop",
    });
    const state = stateStore.getAgentState(agentId)!;
    assert.equal(state.totalTokens, 0);
    assert.equal(state.turnCount, 1);
  } finally { cleanup(dir); }
});

// ============================================================================
// recordAgentCompletion
// ============================================================================

test("Agent state: recordAgentCompletion sets succeeded state", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const agentId = stateStore.allAgentStates()[0]!.agentId;
    const state = stateStore.recordAgentCompletion({ agentId, runId: "r", taskId: "t", attemptId: "a1" });
    assert.equal(state.lifecycleState, "succeeded");
  } finally { cleanup(dir); }
});

// ============================================================================
// recordAgentFailure
// ============================================================================

test("Agent state: recordAgentFailure sets failed state with error", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const agentId = stateStore.allAgentStates()[0]!.agentId;
    const state = stateStore.recordAgentFailure({ agentId, runId: "r", taskId: "t", attemptId: "a1", error: "Something went wrong" });
    assert.equal(state.lifecycleState, "failed");
    assert.equal(state.lastError, "Something went wrong");
  } finally { cleanup(dir); }
});

// ============================================================================
// recordAgentCancellation
// ============================================================================

test("Agent state: recordAgentCancellation sets cancelled state with reason", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const agentId = stateStore.allAgentStates()[0]!.agentId;
    const state = stateStore.recordAgentCancellation({ agentId, runId: "r", taskId: "t", attemptId: "a1", reason: "User cancelled" });
    assert.equal(state.lifecycleState, "cancelled");
    assert.equal(state.lastError, "User cancelled");
  } finally { cleanup(dir); }
});

// ============================================================================
// recordCompaction
// ============================================================================

test("Agent state: recordCompaction stores compaction summary", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const agentId = stateStore.allAgentStates()[0]!.agentId;
    const state = stateStore.recordCompaction({ agentId, runId: "r", taskId: "t", attemptId: "a1", summary: "Summarized 5 turns" });
    assert.equal(state.compactionSummary, "Summarized 5 turns");
  } finally { cleanup(dir); }
});

// ============================================================================
// getAgentState
// ============================================================================

test("Agent state: getAgentState returns undefined for unknown agent", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    assert.equal(stateStore.getAgentState("unknown"), undefined);
  } finally { cleanup(dir); }
});

test("Agent state: getAgentState returns state for known agent", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    const started = stateStore.recordAgentStart({ agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const state = stateStore.getAgentState(started.agentId);
    assert.ok(state);
    assert.equal(state!.agentName, "test");
  } finally { cleanup(dir); }
});

// ============================================================================
// getAgentStatesByRunId
// ============================================================================

test("Agent state: getAgentStatesByRunId filters by run id", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentName: "a", runId: "run-1", taskId: "t1", attemptId: "a1" });
    stateStore.recordAgentStart({ agentName: "b", runId: "run-1", taskId: "t2", attemptId: "a2" });
    stateStore.recordAgentStart({ agentName: "c", runId: "run-2", taskId: "t3", attemptId: "a3" });
    const run1States = stateStore.getAgentStatesByRunId("run-1");
    assert.equal(run1States.length, 2);
    const run2States = stateStore.getAgentStatesByRunId("run-2");
    assert.equal(run2States.length, 1);
  } finally { cleanup(dir); }
});

test("Agent state: getAgentStatesByRunId returns empty for unknown run", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    assert.equal(stateStore.getAgentStatesByRunId("unknown").length, 0);
  } finally { cleanup(dir); }
});

// ============================================================================
// allAgentStates
// ============================================================================

test("Agent state: allAgentStates returns all states", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentName: "a", runId: "r1", taskId: "t1", attemptId: "a1" });
    stateStore.recordAgentStart({ agentName: "b", runId: "r1", taskId: "t2", attemptId: "a2" });
    stateStore.recordAgentStart({ agentName: "c", runId: "r2", taskId: "t3", attemptId: "a3" });
    assert.equal(stateStore.allAgentStates().length, 3);
  } finally { cleanup(dir); }
});

test("Agent state: allAgentStates returns empty when no agents", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    assert.equal(stateStore.allAgentStates().length, 0);
  } finally { cleanup(dir); }
});

// ============================================================================
// reconstructAgentState
// ============================================================================

test("Agent state: reconstructAgentState returns undefined for unknown agent", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    assert.equal(stateStore.reconstructAgentState("unknown"), undefined);
  } finally { cleanup(dir); }
});

test("Agent state: reconstructAgentState recovers state from timeline", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "recover-test", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentTurn({
      agentId: "recover-test", runId: "r", taskId: "t", attemptId: "a1",
      turnId: "turn-1", turnNumber: 1, content: "content",
      toolCallCount: 1, promptTokens: 10, completionTokens: 5,
      totalTokens: 15, finishReason: "stop",
    });
    stateStore.recordAgentCompletion({ agentId: "recover-test", runId: "r", taskId: "t", attemptId: "a1" });
    const recovered = stateStore.reconstructAgentState("recover-test");
    assert.ok(recovered);
    assert.equal(recovered!.agentName, "test");
    assert.equal(recovered!.lifecycleState, "succeeded");
    assert.equal(recovered!.turnCount, 1);
  } finally { cleanup(dir); }
});

test("Agent state: reconstructAgentState recovers failed state", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "fail-test", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentFailure({ agentId: "fail-test", runId: "r", taskId: "t", attemptId: "a1", error: "Failed" });
    const recovered = stateStore.reconstructAgentState("fail-test");
    assert.ok(recovered);
    assert.equal(recovered!.lifecycleState, "failed");
    assert.ok(recovered!.lastError !== null);
  } finally { cleanup(dir); }
});

test("Agent state: reconstructAgentState recovers cancelled state", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "cancel-test", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentCancellation({ agentId: "cancel-test", runId: "r", taskId: "t", attemptId: "a1", reason: "Cancelled" });
    const recovered = stateStore.reconstructAgentState("cancel-test");
    assert.ok(recovered);
    assert.equal(recovered!.lifecycleState, "cancelled");
  } finally { cleanup(dir); }
});

test("Agent state: reconstructAgentState recovers compaction summary", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "compact-test", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordCompaction({ agentId: "compact-test", runId: "r", taskId: "t", attemptId: "a1", summary: "Compacted" });
    const recovered = stateStore.reconstructAgentState("compact-test");
    assert.ok(recovered);
    assert.equal(recovered!.compactionSummary, "Compacted");
  } finally { cleanup(dir); }
});

// ============================================================================
// Issue 2 regression: token totals must be reconstructed from token events
// (the structured "usage" document), not a no-op reduce that always returned 0.
// ============================================================================

test("Agent state: reconstructAgentState recovers aggregate token totals from token events (Issue 2)", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "token-recon", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentTurn({
      agentId: "token-recon", runId: "r", taskId: "t", attemptId: "a1",
      turnId: "turn-1", turnNumber: 1, content: "c1",
      toolCallCount: 0, promptTokens: 10, completionTokens: 5, totalTokens: 15, finishReason: "stop",
    });
    stateStore.recordAgentTurn({
      agentId: "token-recon", runId: "r", taskId: "t", attemptId: "a1",
      turnId: "turn-2", turnNumber: 2, content: "c2",
      toolCallCount: 0, promptTokens: 20, completionTokens: 10, totalTokens: 30, finishReason: "stop",
    });
    stateStore.recordAgentCompletion({ agentId: "token-recon", runId: "r", taskId: "t", attemptId: "a1" });
    const recovered = stateStore.reconstructAgentState("token-recon");
    assert.ok(recovered);
    assert.equal(recovered!.totalPromptTokens, 30, `totalPromptTokens must be 30 (10+20); got ${recovered!.totalPromptTokens}`);
    assert.equal(recovered!.totalCompletionTokens, 15, `totalCompletionTokens must be 15 (5+10); got ${recovered!.totalCompletionTokens}`);
    assert.equal(recovered!.totalTokens, 45, `totalTokens must be 45 (15+30); got ${recovered!.totalTokens}`);
  } finally { cleanup(dir); }
});

test("Agent state: reconstructAgentState token totals are zero when no token events recorded", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "zero-token", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentTurn({
      agentId: "zero-token", runId: "r", taskId: "t", attemptId: "a1",
      turnId: "turn-1", turnNumber: 1, content: "c1",
      toolCallCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, finishReason: "stop",
    });
    stateStore.recordAgentCompletion({ agentId: "zero-token", runId: "r", taskId: "t", attemptId: "a1" });
    const recovered = stateStore.reconstructAgentState("zero-token");
    assert.ok(recovered);
    assert.equal(recovered!.totalPromptTokens, 0);
    assert.equal(recovered!.totalCompletionTokens, 0);
    assert.equal(recovered!.totalTokens, 0);
  } finally { cleanup(dir); }
});

test("Agent state: reconstructAgentState token totals match live state across many turns", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "many-token", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    let expectedPrompt = 0;
    let expectedCompletion = 0;
    let expectedTotal = 0;
    for (let i = 1; i <= 12; i += 1) {
      const p = i * 7;
      const c = i * 3;
      const tot = p + c;
      expectedPrompt += p;
      expectedCompletion += c;
      expectedTotal += tot;
      stateStore.recordAgentTurn({
        agentId: "many-token", runId: "r", taskId: "t", attemptId: "a1",
        turnId: `turn-${i}`, turnNumber: i, content: `c${i}`,
        toolCallCount: 0, promptTokens: p, completionTokens: c, totalTokens: tot, finishReason: "stop",
      });
    }
    const live = stateStore.getAgentState("many-token");
    assert.equal(live!.totalPromptTokens, expectedPrompt);
    assert.equal(live!.totalTokens, expectedTotal);
    const recovered = stateStore.reconstructAgentState("many-token");
    assert.equal(recovered!.totalPromptTokens, expectedPrompt);
    assert.equal(recovered!.totalCompletionTokens, expectedCompletion);
    assert.equal(recovered!.totalTokens, expectedTotal);
  } finally { cleanup(dir); }
});

test("Agent state: token events carry a structured usage document (Issue 2 root cause)", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "doc-check", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentTurn({
      agentId: "doc-check", runId: "r", taskId: "t", attemptId: "a1",
      turnId: "turn-1", turnNumber: 1, content: "c1",
      toolCallCount: 0, promptTokens: 11, completionTokens: 22, totalTokens: 33, finishReason: "stop",
    });
    const tokenEvents = store.query({ agentId: "doc-check", eventType: "token", limit: 100 });
    assert.equal(tokenEvents.length, 1, "exactly one token event must be recorded for a token-bearing turn");
    const usageDoc = tokenEvents[0]!.documents.find((d) => d.name === "usage");
    assert.ok(usageDoc, "token event must carry a 'usage' document");
    const usage = JSON.parse(usageDoc!.contentJson!) as { promptTokens: number; completionTokens: number; totalTokens: number };
    assert.equal(usage.promptTokens, 11);
    assert.equal(usage.completionTokens, 22);
    assert.equal(usage.totalTokens, 33);
  } finally { cleanup(dir); }
});

test("Agent state: turns with zero tokens record no token event (preserves skip behavior)", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "skip-zero", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentTurn({
      agentId: "skip-zero", runId: "r", taskId: "t", attemptId: "a1",
      turnId: "turn-1", turnNumber: 1, content: "c1",
      toolCallCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, finishReason: "stop",
    });
    const tokenEvents = store.query({ agentId: "skip-zero", eventType: "token", limit: 100 });
    assert.equal(tokenEvents.length, 0, "a zero-token turn must not record a token event");
  } finally { cleanup(dir); }
});

// ============================================================================
// compactAgentTurns
// ============================================================================

test("Agent state: compactAgentTurns returns unchanged when under limit", () => {
  const turns = Array.from({ length: 5 }, (_, i) => ({
    turnId: `t${i}`, turnNumber: i + 1, content: `c${i}`,
    toolCallCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    finishReason: "stop", timestamp: new Date().toISOString(),
  }));
  const result = compactAgentTurns(turns, 10);
  assert.equal(result.compactedTurns.length, 5);
  assert.equal(result.summary, "");
});

test("Agent state: compactAgentTurns trims old turns when over limit", () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({
    turnId: `t${i}`, turnNumber: i + 1, content: `c${i}`,
    toolCallCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    finishReason: "stop", timestamp: new Date().toISOString(),
  }));
  const result = compactAgentTurns(turns, 5);
  assert.equal(result.compactedTurns.length, 5);
  assert.equal(result.compactedTurns[0]!.turnNumber, 6);
  assert.ok(result.summary.length > 0);
  assert.ok(result.summary.includes("Compacted 5"));
});

test("Agent state: compactAgentTurns handles empty turns", () => {
  const result = compactAgentTurns([], 10);
  assert.equal(result.compactedTurns.length, 0);
  assert.equal(result.summary, "");
});

test("Agent state: compactAgentTurns handles exact limit", () => {
  const turns = Array.from({ length: 5 }, (_, i) => ({
    turnId: `t${i}`, turnNumber: i + 1, content: `c${i}`,
    toolCallCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    finishReason: "stop", timestamp: new Date().toISOString(),
  }));
  const result = compactAgentTurns(turns, 5);
  assert.equal(result.compactedTurns.length, 5);
  assert.equal(result.summary, "");
});

test("Agent state: compactAgentTurns preserves most recent turns", () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({
    turnId: `t${i}`, turnNumber: i + 1, content: `content-${i}`,
    toolCallCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    finishReason: i === 19 ? "stop" : "tool_calls", timestamp: new Date().toISOString(),
  }));
  const result = compactAgentTurns(turns, 3);
  assert.equal(result.compactedTurns.length, 3);
  assert.equal(result.compactedTurns[0]!.turnNumber, 18);
  assert.equal(result.compactedTurns[1]!.turnNumber, 19);
  assert.equal(result.compactedTurns[2]!.turnNumber, 20);
});

// ============================================================================
// AGENT_LIFECYCLE_STATES
// ============================================================================

test("Agent state: lifecycle states contain all expected values", () => {
  assert.deepEqual([...AGENT_LIFECYCLE_STATES], ["pending", "running", "succeeded", "failed", "cancelled", "suspended", "idle", "timed-out"]);
});

test("Agent state: lifecycle states is frozen", () => {
  assert.ok(Object.isFrozen(AGENT_LIFECYCLE_STATES));
});

// ============================================================================
// State store throws for unknown agent
// ============================================================================

test("Agent state: recordAgentTurn throws for unknown agent", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    assert.throws(() => stateStore.recordAgentTurn({
      agentId: "unknown", runId: "r", taskId: "t", attemptId: "a",
      turnId: "t1", turnNumber: 1, content: "", toolCallCount: 0,
      promptTokens: 0, completionTokens: 0, totalTokens: 0, finishReason: "stop",
    }), /not found/);
  } finally { cleanup(dir); }
});

test("Agent state: recordAgentCompletion throws for unknown agent", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    assert.throws(() => stateStore.recordAgentCompletion({ agentId: "unknown", runId: "r", taskId: "t", attemptId: "a" }), /not found/);
  } finally { cleanup(dir); }
});

test("Agent state: recordAgentFailure throws for unknown agent", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    assert.throws(() => stateStore.recordAgentFailure({ agentId: "unknown", runId: "r", taskId: "t", attemptId: "a", error: "e" }), /not found/);
  } finally { cleanup(dir); }
});

test("Agent state: recordAgentCancellation throws for unknown agent", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    assert.throws(() => stateStore.recordAgentCancellation({ agentId: "unknown", runId: "r", taskId: "t", attemptId: "a", reason: "r" }), /not found/);
  } finally { cleanup(dir); }
});

test("Agent state: recordCompaction throws for unknown agent", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    assert.throws(() => stateStore.recordCompaction({ agentId: "unknown", runId: "r", taskId: "t", attemptId: "a", summary: "s" }), /not found/);
  } finally { cleanup(dir); }
});

// ============================================================================
// Multiple agents and state isolation
// ============================================================================

test("Agent state: multiple agents maintain independent state", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    const s1 = stateStore.recordAgentStart({ agentName: "a", runId: "r", taskId: "t1", attemptId: "a1" });
    const s2 = stateStore.recordAgentStart({ agentName: "b", runId: "r", taskId: "t2", attemptId: "a2" });
    stateStore.recordAgentTurn({
      agentId: s1.agentId, runId: "r", taskId: "t1", attemptId: "a1",
      turnId: "t1", turnNumber: 1, content: "a", toolCallCount: 0,
      promptTokens: 10, completionTokens: 5, totalTokens: 15, finishReason: "stop",
    });
    stateStore.recordAgentTurn({
      agentId: s2.agentId, runId: "r", taskId: "t2", attemptId: "a2",
      turnId: "t1", turnNumber: 1, content: "b", toolCallCount: 0,
      promptTokens: 20, completionTokens: 10, totalTokens: 30, finishReason: "stop",
    });
    const state1 = stateStore.getAgentState(s1.agentId)!;
    const state2 = stateStore.getAgentState(s2.agentId)!;
    assert.equal(state1.totalTokens, 15);
    assert.equal(state2.totalTokens, 30);
    assert.equal(state1.turns[0]!.content, "a");
    assert.equal(state2.turns[0]!.content, "b");
  } finally { cleanup(dir); }
});

test("Agent state: full lifecycle records all transitions", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    const started = stateStore.recordAgentStart({ agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentTurn({
      agentId: started.agentId, runId: "r", taskId: "t", attemptId: "a1",
      turnId: "t1", turnNumber: 1, content: "hello", toolCallCount: 0,
      promptTokens: 10, completionTokens: 5, totalTokens: 15, finishReason: "stop",
    });
    stateStore.recordAgentTurn({
      agentId: started.agentId, runId: "r", taskId: "t", attemptId: "a1",
      turnId: "t2", turnNumber: 2, content: "world", toolCallCount: 1,
      promptTokens: 20, completionTokens: 10, totalTokens: 30, finishReason: "stop",
    });
    stateStore.recordCompaction({ agentId: started.agentId, runId: "r", taskId: "t", attemptId: "a1", summary: "Summarized" });
    const completed = stateStore.recordAgentCompletion({ agentId: started.agentId, runId: "r", taskId: "t", attemptId: "a1" });
    assert.equal(completed.lifecycleState, "succeeded");
    assert.equal(completed.turnCount, 2);
    assert.equal(completed.totalTokens, 45);
    assert.equal(completed.compactionSummary, "Summarized");
  } finally { cleanup(dir); }
});

test("Agent state: timeline events recorded for start", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "timeline-test", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const events = store.query({ agentId: "timeline-test", limit: 100 });
    assert.ok(events.length > 0);
    assert.ok(events.some(e => e.description?.includes("started")));
  } finally { cleanup(dir); }
});

test("Agent state: timeline events recorded for turns", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "turn-timeline-test", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentTurn({
      agentId: "turn-timeline-test", runId: "r", taskId: "t", attemptId: "a1",
      turnId: "t1", turnNumber: 1, content: "hello", toolCallCount: 0,
      promptTokens: 10, completionTokens: 5, totalTokens: 15, finishReason: "stop",
    });
    const events = store.query({ agentId: "turn-timeline-test", limit: 100 });
    assert.ok(events.some(e => e.description?.includes("Agent turn")));
  } finally { cleanup(dir); }
});

test("Agent state: timeline events recorded for completion", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "complete-timeline", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentCompletion({ agentId: "complete-timeline", runId: "r", taskId: "t", attemptId: "a1" });
    const events = store.query({ agentId: "complete-timeline", limit: 100 });
    assert.ok(events.some(e => e.description?.includes("completed")));
  } finally { cleanup(dir); }
});

test("Agent state: timeline events recorded for failure", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "fail-timeline", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentFailure({ agentId: "fail-timeline", runId: "r", taskId: "t", attemptId: "a1", error: "Failed" });
    const events = store.query({ agentId: "fail-timeline", limit: 100 });
    assert.ok(events.some(e => e.description?.includes("failed")));
  } finally { cleanup(dir); }
});

test("Agent state: timeline events recorded for cancellation", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "cancel-timeline", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentCancellation({ agentId: "cancel-timeline", runId: "r", taskId: "t", attemptId: "a1", reason: "Cancelled" });
    const events = store.query({ agentId: "cancel-timeline", limit: 100 });
    assert.ok(events.some(e => e.description?.includes("cancelled")));
  } finally { cleanup(dir); }
});

// ============================================================================
// recordAgentSuspension
// ============================================================================

test("Agent state: recordAgentSuspension transitions to suspended", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "susp-1", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const state = stateStore.recordAgentSuspension({ agentId: "susp-1", runId: "r", taskId: "t", attemptId: "a1", reason: "paused" });
    assert.equal(state.lifecycleState, "suspended");
    assert.equal(state.suspensionReason, "paused");
  } finally { cleanup(dir); }
});

test("Agent state: recordAgentSuspension records event in timeline", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "susp-2", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentSuspension({ agentId: "susp-2", runId: "r", taskId: "t", attemptId: "a1", reason: "paused" });
    const events = store.query({ agentId: "susp-2", limit: 100 });
    assert.ok(events.some(e => e.description?.includes("suspended")));
  } finally { cleanup(dir); }
});

test("Agent state: recordAgentSuspension state is frozen", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "susp-3", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const state = stateStore.recordAgentSuspension({ agentId: "susp-3", runId: "r", taskId: "t", attemptId: "a1", reason: "paused" });
    assert.ok(Object.isFrozen(state));
  } finally { cleanup(dir); }
});

// ============================================================================
// recordAgentResumption
// ============================================================================

test("Agent state: recordAgentResumption transitions back to running", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "resume-1", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentSuspension({ agentId: "resume-1", runId: "r", taskId: "t", attemptId: "a1", reason: "paused" });
    const state = stateStore.recordAgentResumption({ agentId: "resume-1", runId: "r", taskId: "t", attemptId: "a1" });
    assert.equal(state.lifecycleState, "running");
    assert.equal(state.suspensionReason, null);
  } finally { cleanup(dir); }
});

test("Agent state: recordAgentResumption records event in timeline", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "resume-2", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentSuspension({ agentId: "resume-2", runId: "r", taskId: "t", attemptId: "a1", reason: "paused" });
    stateStore.recordAgentResumption({ agentId: "resume-2", runId: "r", taskId: "t", attemptId: "a1" });
    const events = store.query({ agentId: "resume-2", limit: 100 });
    assert.ok(events.some(e => e.description?.includes("resumed")));
  } finally { cleanup(dir); }
});

// ============================================================================
// recordAgentTimeout
// ============================================================================

test("Agent state: recordAgentTimeout transitions to timed-out", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "timeout-1", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const state = stateStore.recordAgentTimeout({ agentId: "timeout-1", runId: "r", taskId: "t", attemptId: "a1", timeoutMs: 5000 });
    assert.equal(state.lifecycleState, "timed-out");
    assert.ok(state.lastError?.includes("timed out"));
  } finally { cleanup(dir); }
});

test("Agent state: recordAgentTimeout records event in timeline", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "timeout-2", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentTimeout({ agentId: "timeout-2", runId: "r", taskId: "t", attemptId: "a1", timeoutMs: 5000 });
    const events = store.query({ agentId: "timeout-2", limit: 100 });
    assert.ok(events.some(e => e.description?.includes("timed out")));
  } finally { cleanup(dir); }
});

test("Agent state: recordAgentTimeout state is frozen", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "timeout-3", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const state = stateStore.recordAgentTimeout({ agentId: "timeout-3", runId: "r", taskId: "t", attemptId: "a1", timeoutMs: 5000 });
    assert.ok(Object.isFrozen(state));
  } finally { cleanup(dir); }
});

// ============================================================================
// getActiveAgents
// ============================================================================

test("Agent state: getActiveAgents returns running agents", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "active-1", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const active = stateStore.getActiveAgents();
    assert.ok(active.some(s => s.agentId === "active-1"));
  } finally { cleanup(dir); }
});

test("Agent state: getActiveAgents returns suspended agents", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "active-2", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentSuspension({ agentId: "active-2", runId: "r", taskId: "t", attemptId: "a1", reason: "paused" });
    const active = stateStore.getActiveAgents();
    assert.ok(active.some(s => s.agentId === "active-2"));
  } finally { cleanup(dir); }
});

test("Agent state: getActiveAgents excludes terminal states", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "done-1", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentCompletion({ agentId: "done-1", runId: "r", taskId: "t", attemptId: "a1" });
    const active = stateStore.getActiveAgents();
    assert.ok(!active.some(s => s.agentId === "done-1"));
  } finally { cleanup(dir); }
});

test("Agent state: getActiveAgents excludes timed-out agents", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "done-2", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentTimeout({ agentId: "done-2", runId: "r", taskId: "t", attemptId: "a1", timeoutMs: 1000 });
    const active = stateStore.getActiveAgents();
    assert.ok(!active.some(s => s.agentId === "done-2"));
  } finally { cleanup(dir); }
});

// ============================================================================
// Structured state reconstruction
// ============================================================================

test("Agent state: reconstructAgentState uses structured event for succeeded", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "recon-1", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentCompletion({ agentId: "recon-1", runId: "r", taskId: "t", attemptId: "a1" });
    const reconstructed = stateStore.reconstructAgentState("recon-1");
    assert.ok(reconstructed);
    assert.equal(reconstructed!.lifecycleState, "succeeded");
  } finally { cleanup(dir); }
});

test("Agent state: reconstructAgentState uses structured event for failed", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "recon-2", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentFailure({ agentId: "recon-2", runId: "r", taskId: "t", attemptId: "a1", error: "test error" });
    const reconstructed = stateStore.reconstructAgentState("recon-2");
    assert.ok(reconstructed);
    assert.equal(reconstructed!.lifecycleState, "failed");
    assert.ok(reconstructed!.lastError?.includes("test error"));
  } finally { cleanup(dir); }
});

test("Agent state: reconstructAgentState uses structured event for cancelled", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "recon-3", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentCancellation({ agentId: "recon-3", runId: "r", taskId: "t", attemptId: "a1", reason: "manual" });
    const reconstructed = stateStore.reconstructAgentState("recon-3");
    assert.ok(reconstructed);
    assert.equal(reconstructed!.lifecycleState, "cancelled");
  } finally { cleanup(dir); }
});

test("Agent state: reconstructAgentState uses structured event for suspended", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "recon-4", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentSuspension({ agentId: "recon-4", runId: "r", taskId: "t", attemptId: "a1", reason: "paused" });
    const reconstructed = stateStore.reconstructAgentState("recon-4");
    assert.ok(reconstructed);
    assert.equal(reconstructed!.lifecycleState, "suspended");
    assert.equal(reconstructed!.suspensionReason, "paused");
  } finally { cleanup(dir); }
});

test("Agent state: reconstructAgentState uses structured event for timed-out", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "recon-5", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentTimeout({ agentId: "recon-5", runId: "r", taskId: "t", attemptId: "a1", timeoutMs: 5000 });
    const reconstructed = stateStore.reconstructAgentState("recon-5");
    assert.ok(reconstructed);
    assert.equal(reconstructed!.lifecycleState, "timed-out");
  } finally { cleanup(dir); }
});

test("Agent state: reconstructAgentState handles suspend then resume", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "recon-6", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentSuspension({ agentId: "recon-6", runId: "r", taskId: "t", attemptId: "a1", reason: "paused" });
    stateStore.recordAgentResumption({ agentId: "recon-6", runId: "r", taskId: "t", attemptId: "a1" });
    const reconstructed = stateStore.reconstructAgentState("recon-6");
    assert.ok(reconstructed);
    assert.equal(reconstructed!.lifecycleState, "running");
  } finally { cleanup(dir); }
});

test("Agent state: reconstructAgentState includes suspensionReason field", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "recon-7", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentSuspension({ agentId: "recon-7", runId: "r", taskId: "t", attemptId: "a1", reason: "testing" });
    const reconstructed = stateStore.reconstructAgentState("recon-7");
    assert.ok(reconstructed);
    assert.equal(reconstructed!.suspensionReason, "testing");
  } finally { cleanup(dir); }
});

test("Agent state: reconstructAgentState returns undefined for non-existent agent", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    const reconstructed = stateStore.reconstructAgentState("non-existent");
    assert.equal(reconstructed, undefined);
  } finally { cleanup(dir); }
});

// ============================================================================
// AgentState suspensionReason field
// ============================================================================

test("Agent state: recordAgentStart initializes suspensionReason to null", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    const state = stateStore.recordAgentStart({ agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    assert.equal(state.suspensionReason, null);
  } finally { cleanup(dir); }
});

test("Agent state: suspensionReason is set after suspension", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "sr-1", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    const state = stateStore.recordAgentSuspension({ agentId: "sr-1", runId: "r", taskId: "t", attemptId: "a1", reason: "test" });
    assert.equal(state.suspensionReason, "test");
  } finally { cleanup(dir); }
});

test("Agent state: suspensionReason is cleared after resumption", () => {
  const { store, dir } = createTempStore();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "sr-2", agentName: "test", runId: "r", taskId: "t", attemptId: "a1" });
    stateStore.recordAgentSuspension({ agentId: "sr-2", runId: "r", taskId: "t", attemptId: "a1", reason: "test" });
    const state = stateStore.recordAgentResumption({ agentId: "sr-2", runId: "r", taskId: "t", attemptId: "a1" });
    assert.equal(state.suspensionReason, null);
  } finally { cleanup(dir); }
});


test("Agent state: actual transition, turn and usage documents hash their stored text", () => {
  const { store, dir } = createTempStore();
  const recorder = createTimelineRecorder({ store });
  try {
    const states = createAgentStateStore(recorder);
    const state = states.recordAgentStart({ agentId: "document-agent", agentName: "researcher", runId: "run", taskId: "task", attemptId: "attempt" });
    states.recordAgentTurn({ agentId: state.agentId, runId: "run", taskId: "task", attemptId: "attempt", turnId: "turn", turnNumber: 1, content: "answer", toolCallCount: 2, promptTokens: 10, completionTokens: 5, totalTokens: 15, finishReason: "stop" });
    const documents = store.query().flatMap((event) => event.documents);
    assert.deepEqual(documents.map((doc) => doc.name).sort(), ["state-transition", "turn", "usage"]);
    for (const document of documents) {
      assert.equal(typeof document.contentJson, "string");
      assert.equal(document.contentDigest, sha256(document.contentJson!), document.name);
    }
  } finally { recorder.close(); cleanup(dir); }
});
