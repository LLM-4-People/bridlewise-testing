import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import { CALL_RETURN_AGENT_TYPE } from "../../src/agents/agent-type-call-return.ts";
import { createAgentRuntime } from "../../src/agents/agent-runtime.ts";
import { createAgentStateStore } from "../../src/agents/agent-state.ts";
import { createAgentTypeRegistry } from "../../src/agents/agent-type-registry.ts";

import type { AgentProfile } from "../../src/agents/agent-config.ts";
import type { ChatStreamEvent } from "../../src/runtime/provider-adapter.ts";
import { makeNativeMockAdapter as makeMockAdapter } from "../support/mock-provider.ts";
import { createTempDir } from "../support/temp-dir.ts";

function contentEvents(...texts: string[]): ChatStreamEvent[] {
  return texts.map((text) => Object.freeze({ type: "content" as const, text }));
}

function finishEvent(reason: string): ChatStreamEvent {
  return Object.freeze({ type: "finish" as const, reason });
}

const PROFILE: AgentProfile = {
  name: "test-cr",
  type: "call-and-return",
  model: "test-model",
  provider: "test-provider",
  systemPrompt: "You are a test agent.",
  tools: [],
  capabilities: ["read"],
  writeSet: [],
  maxTurns: 5,
};

function setup() {
  const dir = createTempDir("cr-type-test-");
  const store = createTimelineStore({ path: join(dir, "timeline.db") });
  const toolRegistry = createToolRegistry();
  const adapter = makeMockAdapter([...contentEvents("Hello"), finishEvent("stop")]);
  return { dir, store, toolRegistry, adapter };
}

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ============================================================================
// Type definition properties
// ============================================================================

test("Call-return type: typeId is call-and-return", () => {
  assert.equal(CALL_RETURN_AGENT_TYPE.typeId, "call-and-return");
});

test("Call-return type: description is non-empty", () => {
  assert.ok(CALL_RETURN_AGENT_TYPE.description.length > 0);
});

test("Call-return type: executionMode is sync", () => {
  assert.equal(CALL_RETURN_AGENT_TYPE.executionMode, "sync");
});

test("Call-return type: lifecycleStates has 5 states", () => {
  assert.equal(CALL_RETURN_AGENT_TYPE.lifecycleStates.length, 5);
});

test("Call-return type: terminalStates has 3 states", () => {
  assert.equal(CALL_RETURN_AGENT_TYPE.terminalStates.length, 3);
});

test("Call-return type: terminalStates are subset of lifecycleStates", () => {
  const lifecycle = new Set(CALL_RETURN_AGENT_TYPE.lifecycleStates);
  for (const ts of CALL_RETURN_AGENT_TYPE.terminalStates) {
    assert.ok(lifecycle.has(ts), `terminal ${ts} not in lifecycle`);
  }
});

test("Call-return type: createRuntime is a function", () => {
  assert.equal(typeof CALL_RETURN_AGENT_TYPE.createRuntime, "function");
});

test("Call-return type: validateProfile is a function", () => {
  assert.equal(typeof CALL_RETURN_AGENT_TYPE.validateProfile, "function");
});

test("Call-return type: hooks is an object", () => {
  assert.equal(typeof CALL_RETURN_AGENT_TYPE.hooks, "object");
});

// ============================================================================
// createRuntime parity
// ============================================================================

test("Call-return type: createRuntime returns an object with agentId", () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = CALL_RETURN_AGENT_TYPE.createRuntime({
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
    assert.ok(runtime.agentId);
    assert.ok(runtime.agentId.length > 0);
  } finally { cleanup(dir); }
});

test("Call-return type: createRuntime returns object with agentName", () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    const runtime = CALL_RETURN_AGENT_TYPE.createRuntime({
      adapter,
      toolRegistry,
      modelConfig: { providerId: "test", modelId: "test-model", maxTokens: 100, temperature: 0 },
      profile: PROFILE,
      repositoryRoot: dir,
      stateStore,
      runId: "r1",
      taskId: "t1",
      attemptId: "a1",
    });
    assert.equal(runtime.agentName, "test-cr");
  } finally { cleanup(dir); }
});

test("Call-return type: createRuntime returns object with state method", () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = CALL_RETURN_AGENT_TYPE.createRuntime({
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
    assert.equal(typeof runtime.state, "function");
    const state = runtime.state();
    assert.ok(state.lifecycleState);
    assert.equal(typeof state.turnCount, "number");
    assert.equal(typeof state.totalTokens, "number");
  } finally { cleanup(dir); }
});

test("Call-return type: createRuntime returns object with run method", () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = CALL_RETURN_AGENT_TYPE.createRuntime({
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
    assert.equal(typeof runtime.run, "function");
  } finally { cleanup(dir); }
});

test("Call-return type: run executes and returns succeeded result", async () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = CALL_RETURN_AGENT_TYPE.createRuntime({
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
    const generator = runtime.run("test task");
    let result = await generator.next();
    const events: string[] = [];
    while (!result.done) {
      events.push(result.value.type);
      result = await generator.next(result.value);
    }
    assert.equal(result.value.lifecycleState, "succeeded");
    assert.ok(events.includes("turn_start"));
    assert.ok(events.includes("turn_end"));
    assert.ok(events.includes("agent_end"));
  } finally { cleanup(dir); }
});

test("Call-return type: run yields content events", async () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = CALL_RETURN_AGENT_TYPE.createRuntime({
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
    const generator = runtime.run("test task");
    let result = await generator.next();
    let hasContent = false;
    while (!result.done) {
      if (result.value.type === "content") hasContent = true;
      result = await generator.next(result.value);
    }
    assert.ok(hasContent);
  } finally { cleanup(dir); }
});

test("Call-return type: parity with createAgentRuntime - same agentName", async () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const opts = {
      adapter,
      toolRegistry,
      modelConfig: { providerId: "test", modelId: "test-model", maxTokens: 100, temperature: 0 },
      profile: PROFILE,
      repositoryRoot: dir,
      stateStore: createAgentStateStore(createTimelineRecorder({ store })),
      runId: "r1",
      taskId: "t1",
      attemptId: "a1",
    };
    const directRuntime = createAgentRuntime(opts);
    const typeRuntime = CALL_RETURN_AGENT_TYPE.createRuntime(opts);
    assert.equal(directRuntime.agentName, typeRuntime.agentName);
  } finally { cleanup(dir); }
});

test("Call-return type: parity with createAgentRuntime - same lifecycle", async () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const opts = {
      adapter,
      toolRegistry,
      modelConfig: { providerId: "test", modelId: "test-model", maxTokens: 100, temperature: 0 },
      profile: PROFILE,
      repositoryRoot: dir,
      stateStore: createAgentStateStore(createTimelineRecorder({ store })),
      runId: "r1",
      taskId: "t1",
      attemptId: "a1",
    };
    const directRuntime = createAgentRuntime(opts);
    const typeRuntime = CALL_RETURN_AGENT_TYPE.createRuntime(opts);
    const gen1 = directRuntime.run("task");
    const gen2 = typeRuntime.run("task");
    let r1 = await gen1.next();
    while (!r1.done) r1 = await gen1.next(r1.value);
    let r2 = await gen2.next();
    while (!r2.done) r2 = await gen2.next(r2.value);
    assert.equal(r1.value.lifecycleState, r2.value.lifecycleState);
  } finally { cleanup(dir); }
});

test("Call-return type: parity with createAgentRuntime - same finishReason", async () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const opts = {
      adapter,
      toolRegistry,
      modelConfig: { providerId: "test", modelId: "test-model", maxTokens: 100, temperature: 0 },
      profile: PROFILE,
      repositoryRoot: dir,
      stateStore: createAgentStateStore(createTimelineRecorder({ store })),
      runId: "r1",
      taskId: "t1",
      attemptId: "a1",
    };
    const directRuntime = createAgentRuntime(opts);
    const typeRuntime = CALL_RETURN_AGENT_TYPE.createRuntime(opts);
    const gen1 = directRuntime.run("task");
    const gen2 = typeRuntime.run("task");
    let r1 = await gen1.next();
    while (!r1.done) r1 = await gen1.next(r1.value);
    let r2 = await gen2.next();
    while (!r2.done) r2 = await gen2.next(r2.value);
    assert.equal(r1.value.finishReason, r2.value.finishReason);
  } finally { cleanup(dir); }
});

// ============================================================================
// validateProfile
// ============================================================================

test("Call-return type: validateProfile returns empty for valid profile", () => {
  const errors = CALL_RETURN_AGENT_TYPE.validateProfile(PROFILE);
  assert.equal(errors.length, 0);
});

test("Call-return type: validateProfile rejects maxTurns 0", () => {
  const errors = CALL_RETURN_AGENT_TYPE.validateProfile({ ...PROFILE, maxTurns: 0 });
  assert.ok(errors.length > 0);
});

test("Call-return type: validateProfile rejects negative maxTurns", () => {
  const errors = CALL_RETURN_AGENT_TYPE.validateProfile({ ...PROFILE, maxTurns: -1 });
  assert.ok(errors.length > 0);
});

test("Call-return type: validateProfile rejects empty name", () => {
  const errors = CALL_RETURN_AGENT_TYPE.validateProfile({ ...PROFILE, name: "" });
  assert.ok(errors.length > 0);
});

test("Call-return type: validateProfile accepts maxTurns 1", () => {
  const errors = CALL_RETURN_AGENT_TYPE.validateProfile({ ...PROFILE, maxTurns: 1 });
  assert.equal(errors.length, 0);
});

test("Call-return type: validateProfile accepts maxTurns 100", () => {
  const errors = CALL_RETURN_AGENT_TYPE.validateProfile({ ...PROFILE, maxTurns: 100 });
  assert.equal(errors.length, 0);
});

test("Call-return type: type definition is frozen at registration", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  const typeDef = registry.get("call-and-return")!;
  assert.ok(Object.isFrozen(typeDef));
});

// ============================================================================
// Cancellation behavior
// ============================================================================

test("Call-return type: respects abort signal", async () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = CALL_RETURN_AGENT_TYPE.createRuntime({
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
    const controller = new AbortController();
    controller.abort();
    const generator = runtime.run("test task", controller.signal);
    let result = await generator.next();
    while (!result.done) {
      result = await generator.next(result.value);
    }
    assert.equal(result.value.lifecycleState, "cancelled");
  } finally { cleanup(dir); }
});
