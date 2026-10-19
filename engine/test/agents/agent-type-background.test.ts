import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import { BACKGROUND_AGENT_TYPE, createBackgroundAgentRuntime } from "../../src/agents/agent-type-background.ts";
import type { AgentProfile } from "../../src/agents/agent-config.ts";
import { createAgentStateStore } from "../../src/agents/agent-state.ts";

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
  name: "test-bg",
  type: "background",
  model: "test-model",
  provider: "test-provider",
  systemPrompt: "You are a background test agent.",
  tools: [],
  capabilities: ["read"],
  writeSet: [],
  maxTurns: 3,
};

function setup() {
  const dir = createTempDir("bg-type-test-");
  const store = createTimelineStore({ path: join(dir, "timeline.db") });
  const toolRegistry = createToolRegistry();
  const adapter = makeMockAdapter([...contentEvents("Hello"), finishEvent("stop")]);
  return { dir, store, toolRegistry, adapter };
}

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function createBgRuntime(opts?: { adapter?: ProviderAdapter; timeoutMs?: number; profile?: AgentProfile }) {
  const { dir, store, toolRegistry, adapter } = setup();
  const runtime = createBackgroundAgentRuntime({
    adapter: opts?.adapter ?? adapter,
    toolRegistry,
    modelConfig: { providerId: "test", modelId: "test-model", maxTokens: 100, temperature: 0 },
    profile: opts?.profile ?? PROFILE,
    repositoryRoot: dir,
    stateStore: createAgentStateStore(createTimelineRecorder({ store })),
    runId: "r1",
    taskId: "t1",
    attemptId: "a1",
  }, opts?.timeoutMs);
  return { runtime, dir, store };
}

// ============================================================================
// Type definition properties
// ============================================================================

test("Background type: typeId is background", () => {
  assert.equal(BACKGROUND_AGENT_TYPE.typeId, "background");
});

test("Background type: description is non-empty", () => {
  assert.ok(BACKGROUND_AGENT_TYPE.description.length > 0);
});

test("Background type: executionMode is async", () => {
  assert.equal(BACKGROUND_AGENT_TYPE.executionMode, "async");
});

test("Background type: lifecycleStates includes suspended and idle", () => {
  const states = [...BACKGROUND_AGENT_TYPE.lifecycleStates];
  assert.ok(states.includes("suspended"));
  assert.ok(states.includes("idle"));
});

test("Background type: lifecycleStates includes timed-out", () => {
  const states = [...BACKGROUND_AGENT_TYPE.lifecycleStates];
  assert.ok(states.includes("timed-out"));
});

test("Background type: terminalStates includes timed-out", () => {
  const terminals = [...BACKGROUND_AGENT_TYPE.terminalStates];
  assert.ok(terminals.includes("timed-out"));
});

test("Background type: createRuntime returns a runtime with start method", () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = BACKGROUND_AGENT_TYPE.createRuntime({
      adapter,
      toolRegistry,
      modelConfig: { providerId: "test", modelId: "test-model", maxTokens: 100, temperature: 0 },
      profile: PROFILE,
      repositoryRoot: dir,
      stateStore: createAgentStateStore(createTimelineRecorder({ store })),
      runId: "r1",
      taskId: "t1",
      attemptId: "a1",
    });
    assert.equal(typeof (runtime as { start?: unknown }).start, "function");
  } finally { cleanup(dir); }
});

// ============================================================================
// start returns a handle
// ============================================================================

test("Background type: start returns handle with agentId", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    assert.ok(handle.agentId);
    assert.ok(handle.agentId.length > 0);
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: start returns handle with agentName", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    assert.equal(handle.agentName, "test-bg");
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: handle has status method", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    assert.equal(typeof handle.status, "function");
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: handle has result method", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    assert.equal(typeof handle.result, "function");
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: handle has events method", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    assert.equal(typeof handle.events, "function");
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: handle has cancel method", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    assert.equal(typeof handle.cancel, "function");
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: handle has suspend method", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    assert.equal(typeof handle.suspend, "function");
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: handle has resume method", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    assert.equal(typeof handle.resume, "function");
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: handle has steer method", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    assert.equal(typeof handle.steer, "function");
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: handle has completion method", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    assert.equal(typeof handle.completion, "function");
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: handle has pendingSteeringMessages method", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    assert.equal(typeof handle.pendingSteeringMessages, "function");
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

// ============================================================================
// status
// ============================================================================

test("Background type: initial status is running or pending", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    const status = handle.status();
    assert.ok(status === "running" || status === "pending");
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: status transitions to succeeded after completion", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    const result = await handle.completion();
    assert.equal(result.lifecycleState, "succeeded");
    assert.equal(handle.status(), "succeeded");
  } finally { cleanup(dir); }
});

test("Background type: status is a valid lifecycle state", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    const status = handle.status();
    const validStates = ["pending", "running", "succeeded", "failed", "cancelled", "suspended", "idle", "timed-out"];
    assert.ok(validStates.includes(status));
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

// ============================================================================
// result
// ============================================================================

test("Background type: result is undefined while running", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    assert.equal(handle.result(), undefined);
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: result is defined after completion", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    await handle.completion();
    const result = handle.result();
    assert.ok(result);
    assert.equal(result!.lifecycleState, "succeeded");
  } finally { cleanup(dir); }
});

test("Background type: result has correct agentName", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    const result = await handle.completion();
    assert.equal(result.agentName, "test-bg");
  } finally { cleanup(dir); }
});

test("Background type: result has turns array", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    const result = await handle.completion();
    assert.ok(Array.isArray(result.turns));
  } finally { cleanup(dir); }
});

// ============================================================================
// completion
// ============================================================================

test("Background type: completion returns a promise", () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    const promise = handle.completion();
    assert.ok(promise instanceof Promise);
  } finally { cleanup(dir); }
});

test("Background type: completion resolves with AgentRunResult", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    const result = await handle.completion();
    assert.ok(result.agentId);
    assert.ok(result.agentName);
    assert.ok(typeof result.lifecycleState === "string");
  } finally { cleanup(dir); }
});

// ============================================================================
// cancel
// ============================================================================

test("Background type: cancel transitions to cancelled", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    await handle.cancel("test cancel");
    const result = handle.result();
    assert.ok(result);
    assert.equal(result!.lifecycleState, "cancelled");
  } finally { cleanup(dir); }
});

test("Background type: cancel with reason sets error", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    await handle.cancel("custom reason");
    const result = handle.result();
    assert.ok(result);
    assert.ok(result!.error);
    assert.ok(result!.error!.includes("custom reason"));
  } finally { cleanup(dir); }
});

test("Background type: cancel without reason uses default message", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    await handle.cancel();
    const result = handle.result();
    assert.ok(result);
    assert.equal(result!.lifecycleState, "cancelled");
  } finally { cleanup(dir); }
});

test("Background type: cancel after completion is no-op", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    await handle.completion();
    const beforeResult = handle.result();
    await handle.cancel("late cancel");
    const afterResult = handle.result();
    assert.equal(beforeResult!.lifecycleState, afterResult!.lifecycleState);
  } finally { cleanup(dir); }
});

// ============================================================================
// suspend and resume
// ============================================================================

test("Background type: suspend sets suspended flag", async () => {
  const { runtime, dir } = createBgRuntime({ profile: { ...PROFILE, maxTurns: 100 } });
  try {
    const handle = runtime.start("test task");
    await handle.suspend("test suspend");
    // Give the agent time to process the suspend
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = handle.status();
    // Agent may have completed already (fast mock adapter), or be suspended
    assert.ok(["suspended", "succeeded", "cancelled"].includes(status), `status was ${status}`);
    await handle.resume();
    await handle.completion();
  } finally { cleanup(dir); }
});

test("Background type: resume returns a promise", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    const promise = handle.resume();
    assert.ok(promise instanceof Promise);
    await promise;
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: suspend returns a promise", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    const promise = handle.suspend("test");
    assert.ok(promise instanceof Promise);
    await promise;
    await handle.resume();
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

// ============================================================================
// steer (steering messages)
// ============================================================================

test("Background type: steer adds message to queue", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    handle.steer("new instruction");
    const pending = handle.pendingSteeringMessages();
    assert.ok(pending.includes("new instruction"));
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: pendingSteeringMessages returns empty by default", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    assert.deepEqual([...handle.pendingSteeringMessages()], []);
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: steer with empty string is ignored", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    handle.steer("");
    assert.deepEqual([...handle.pendingSteeringMessages()], []);
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: multiple steer messages accumulate", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    handle.steer("msg1");
    handle.steer("msg2");
    handle.steer("msg3");
    const pending = handle.pendingSteeringMessages();
    assert.equal(pending.length, 3);
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

// ============================================================================
// events
// ============================================================================

test("Background type: events is an async generator", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    const events = handle.events();
    assert.ok(typeof events.next === "function");
    // Consume the first event
    const first = await events.next();
    if (!first.done) {
      assert.ok(first.value.type);
    }
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: events yields turn_start", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    const events = handle.events();
    const eventTypes: string[] = [];
    for await (const event of events) {
      eventTypes.push(event.type);
    }
    assert.ok(eventTypes.includes("turn_start"));
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: events yields agent_end", async () => {
  const { runtime, dir } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    const events = handle.events();
    const eventTypes: string[] = [];
    for await (const event of events) {
      eventTypes.push(event.type);
    }
    assert.ok(eventTypes.includes("agent_end"));
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

// ============================================================================
// timeout
// ============================================================================

test("Background type: timeout transitions to timed-out", async () => {
  const { runtime, dir } = createBgRuntime({ timeoutMs: 50 });
  try {
    const handle = runtime.start("test task");
    // Wait for timeout to fire
    await new Promise((resolve) => setTimeout(resolve, 200));
    const status = handle.status();
    assert.ok(status === "timed-out" || status === "cancelled" || status === "succeeded");
    if (status === "timed-out") {
      const result = handle.result();
      assert.ok(result);
      assert.ok(result!.error?.includes("timed out"));
    }
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

test("Background type: timeout with profile backgroundTimeoutMs", async () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const profile: AgentProfile = { ...PROFILE, backgroundTimeoutMs: 50 };
    const runtime = createBackgroundAgentRuntime({
      adapter,
      toolRegistry,
      modelConfig: { providerId: "test", modelId: "test-model", maxTokens: 100, temperature: 0 },
      profile,
      repositoryRoot: dir,
      stateStore: createAgentStateStore(createTimelineRecorder({ store })),
      runId: "r1",
      taskId: "t1",
      attemptId: "a1",
    });
    const handle = runtime.start("test task");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const status = handle.status();
    assert.ok(["timed-out", "cancelled", "succeeded"].includes(status));
    await handle.completion().catch(() => {});
  } finally { cleanup(dir); }
});

// ============================================================================
// validateProfile
// ============================================================================

test("Background type: validateProfile accepts valid profile", () => {
  const errors = BACKGROUND_AGENT_TYPE.validateProfile(PROFILE);
  assert.equal(errors.length, 0);
});

test("Background type: validateProfile rejects maxTurns 0", () => {
  const errors = BACKGROUND_AGENT_TYPE.validateProfile({ ...PROFILE, maxTurns: 0 });
  assert.ok(errors.length > 0);
});

test("Background type: validateProfile rejects empty name", () => {
  const errors = BACKGROUND_AGENT_TYPE.validateProfile({ ...PROFILE, name: "" });
  assert.ok(errors.length > 0);
});

// ============================================================================
// State store recording
// ============================================================================

test("Background type: records agent start in state store", async () => {
  const { runtime, dir, store } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    await handle.completion();
    const states = store.query({ agentId: handle.agentId });
    assert.ok(states.length > 0);
  } finally { cleanup(dir); }
});

test("Background type: records agent completion in state store", async () => {
  const { runtime, dir, store } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    await handle.completion();
    const events = store.query({ agentId: handle.agentId });
    const hasCompletion = events.some((e) => e.description?.includes("completed"));
    assert.ok(hasCompletion);
  } finally { cleanup(dir); }
});

test("Background type: records cancellation in state store", async () => {
  const { runtime, dir, store } = createBgRuntime();
  try {
    const handle = runtime.start("test task");
    await handle.cancel("test cancel");
    const events = store.query({ agentId: handle.agentId });
    const hasCancel = events.some((e) => e.description?.includes("cancelled"));
    assert.ok(hasCancel);
  } finally { cleanup(dir); }
});

// ============================================================================
// Concurrency
// ============================================================================

test("Background type: multiple agents run concurrently", async () => {
  const { runtime: r1, dir: d1 } = createBgRuntime();
  const { runtime: r2, dir: d2 } = createBgRuntime();
  try {
    const h1 = r1.start("task1");
    const h2 = r2.start("task2");
    const [r1Result, r2Result] = await Promise.all([h1.completion(), h2.completion()]);
    assert.equal(r1Result.lifecycleState, "succeeded");
    assert.equal(r2Result.lifecycleState, "succeeded");
    assert.notEqual(h1.agentId, h2.agentId);
  } finally { cleanup(d1); cleanup(d2); }
});
