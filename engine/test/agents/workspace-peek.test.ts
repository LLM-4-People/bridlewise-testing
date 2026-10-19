import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import { createAgentStateStore } from "../../src/agents/agent-state.ts";
import { createBackgroundAgentRuntime, type BackgroundAgentHandle } from "../../src/agents/agent-type-background.ts";
import { peekAgentWorkspace } from "../../src/agents/workspace-peek.ts";
import type { AgentProfile } from "../../src/agents/agent-config.ts";
import type { ChatStreamEvent, ProviderAdapter } from "../../src/runtime/provider-adapter.ts";
import { makeNativeMockAdapter as makeMockAdapter } from "../support/mock-provider.ts";
import { createTempDir } from "../support/temp-dir.ts";

function contentEvents(...texts: string[]): ChatStreamEvent[] {
  return texts.map((text) => Object.freeze({ type: "content" as const, text }));
}

function finishEvent(reason: string): ChatStreamEvent {
  return Object.freeze({ type: "finish" as const, reason });
}

const PROFILE: AgentProfile = {
  name: "peek-test",
  type: "background",
  model: "test-model",
  provider: "test-provider",
  systemPrompt: "You are a peek test agent.",
  tools: [],
  capabilities: ["read"],
  writeSet: [],
  maxTurns: 3,
};

function setup() {
  const dir = createTempDir("peek-test-");
  const store = createTimelineStore({ path: join(dir, "timeline.db") });
  const toolRegistry = createToolRegistry();
  const adapter = makeMockAdapter([...contentEvents("Hello from agent"), finishEvent("stop")]);
  return { dir, store, toolRegistry, adapter };
}

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function createBgHandle(adapter?: ProviderAdapter): { handle: BackgroundAgentHandle; dir: string; stateStore: ReturnType<typeof createAgentStateStore>; store: ReturnType<typeof createTimelineStore> } {
  const { dir, store, toolRegistry, adapter: defaultAdapter } = setup();
  const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
  const runtime = createBackgroundAgentRuntime({
    adapter: adapter ?? defaultAdapter,
    toolRegistry,
    modelConfig: { providerId: "test", modelId: "test-model", maxTokens: 100, temperature: 0 },
    profile: PROFILE,
    repositoryRoot: dir,
    stateStore,
    runId: "r1",
    taskId: "t1",
    attemptId: "a1",
  });
  const handle = runtime.start("test task");
  return { handle, dir, stateStore, store };
}

// ============================================================================
// Snapshot structure
// ============================================================================

test("Peek: snapshot has agentId", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(snapshot.agentId);
    assert.equal(snapshot.agentId, handle.agentId);
  } finally { cleanup(dir); }
});

test("Peek: snapshot has agentName", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.equal(snapshot.agentName, "peek-test");
  } finally { cleanup(dir); }
});

test("Peek: snapshot has status", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(typeof snapshot.status === "string");
  } finally { cleanup(dir); }
});

test("Peek: snapshot has currentTurn", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.equal(typeof snapshot.currentTurn, "number");
  } finally { cleanup(dir); }
});

test("Peek: snapshot has recentTurns array", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(Array.isArray(snapshot.recentTurns));
  } finally { cleanup(dir); }
});

test("Peek: snapshot has recentToolCalls array", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(Array.isArray(snapshot.recentToolCalls));
  } finally { cleanup(dir); }
});

test("Peek: snapshot has timelineEvents array", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(Array.isArray(snapshot.timelineEvents));
  } finally { cleanup(dir); }
});

test("Peek: snapshot has contextSize", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.equal(typeof snapshot.contextSize, "number");
  } finally { cleanup(dir); }
});

test("Peek: snapshot has tokenUsage", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(typeof snapshot.tokenUsage === "object");
    assert.equal(typeof snapshot.tokenUsage.promptTokens, "number");
    assert.equal(typeof snapshot.tokenUsage.completionTokens, "number");
    assert.equal(typeof snapshot.tokenUsage.totalTokens, "number");
  } finally { cleanup(dir); }
});

test("Peek: snapshot has suspensionReason", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(snapshot.suspensionReason === null || typeof snapshot.suspensionReason === "string");
  } finally { cleanup(dir); }
});

test("Peek: snapshot has lastError", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(snapshot.lastError === null || typeof snapshot.lastError === "string");
  } finally { cleanup(dir); }
});

test("Peek: snapshot has pendingSteeringMessages", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(Array.isArray(snapshot.pendingSteeringMessages));
  } finally { cleanup(dir); }
});

test("Peek: snapshot has timestamp", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(typeof snapshot.timestamp === "string");
  } finally { cleanup(dir); }
});

// ============================================================================
// Snapshot is frozen (read-only)
// ============================================================================

test("Peek: snapshot is frozen", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(Object.isFrozen(snapshot));
  } finally { cleanup(dir); }
});

test("Peek: snapshot tokenUsage is frozen", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(Object.isFrozen(snapshot.tokenUsage));
  } finally { cleanup(dir); }
});

test("Peek: snapshot recentTurns is frozen", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(Object.isFrozen(snapshot.recentTurns));
  } finally { cleanup(dir); }
});

test("Peek: snapshot timelineEvents is frozen", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(Object.isFrozen(snapshot.timelineEvents));
  } finally { cleanup(dir); }
});

// ============================================================================
// Read-only — no mutation
// ============================================================================

test("Peek: does not modify agent status", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const beforeStatus = handle.status();
    peekAgentWorkspace(handle, stateStore, store);
    const afterStatus = handle.status();
    assert.equal(beforeStatus, afterStatus);
  } finally { cleanup(dir); }
});

test("Peek: does not add steering messages", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    peekAgentWorkspace(handle, stateStore, store);
    assert.deepEqual([...handle.pendingSteeringMessages()], []);
  } finally { cleanup(dir); }
});

test("Peek: does not modify pending steering messages", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    handle.steer("msg1");
    const before = [...handle.pendingSteeringMessages()];
    peekAgentWorkspace(handle, stateStore, store);
    const after = [...handle.pendingSteeringMessages()];
    assert.deepEqual(before, after);
  } finally { cleanup(dir); }
});

test("Peek: snapshot shows pending steering messages", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    handle.steer("important instruction");
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(snapshot.pendingSteeringMessages.includes("important instruction"));
  } finally { cleanup(dir); }
});

// ============================================================================
// Options
// ============================================================================

test("Peek: maxRecentTurns limits turn count", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store, { maxRecentTurns: 2 });
    assert.ok(snapshot.recentTurns.length <= 2);
  } finally { cleanup(dir); }
});

test("Peek: maxTimelineEvents limits event count", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store, { maxTimelineEvents: 5 });
    assert.ok(snapshot.timelineEvents.length <= 5);
  } finally { cleanup(dir); }
});

test("Peek: default maxRecentTurns is 10", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(snapshot.recentTurns.length <= 10);
  } finally { cleanup(dir); }
});

// ============================================================================
// After completion
// ============================================================================

test("Peek: snapshot after completion shows terminal status", async () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    await handle.completion();
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(["succeeded", "failed", "cancelled", "timed-out"].includes(snapshot.status));
  } finally { cleanup(dir); }
});

test("Peek: snapshot after completion has turns", async () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    await handle.completion();
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(snapshot.recentTurns.length > 0 || snapshot.currentTurn === 0);
  } finally { cleanup(dir); }
});

test("Peek: snapshot after cancellation shows cancelled status", async () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    await handle.cancel("test");
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(["cancelled", "succeeded"].includes(snapshot.status));
  } finally { cleanup(dir); }
});

// ============================================================================
// Timeline events
// ============================================================================

test("Peek: timeline events are filtered by agentId", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    for (const event of snapshot.timelineEvents) {
      assert.equal(event.agentId, handle.agentId);
    }
  } finally { cleanup(dir); }
});

// ============================================================================
// Steering via message (D22)
// ============================================================================

test("Peek: steering message is visible in snapshot", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    handle.steer("check this output");
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.ok(snapshot.pendingSteeringMessages.includes("check this output"));
  } finally { cleanup(dir); }
});

test("Peek: multiple steering messages are all visible", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    handle.steer("msg1");
    handle.steer("msg2");
    handle.steer("msg3");
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    assert.equal(snapshot.pendingSteeringMessages.length, 3);
  } finally { cleanup(dir); }
});

test("Peek: snapshot is a copy, not a live reference", () => {
  const { handle, dir, stateStore, store } = createBgHandle();
  try {
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    handle.steer("new message after peek");
    // The snapshot should not reflect the new message
    assert.ok(!snapshot.pendingSteeringMessages.includes("new message after peek"));
  } finally { cleanup(dir); }
});
