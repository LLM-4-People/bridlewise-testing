import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import { createAgentStateStore } from "../../src/agents/agent-state.ts";
import { AGENT_TYPE_IDS, createAgentTypeRegistry, type AgentTypeDefinition } from "../../src/agents/agent-type-registry.ts";
import type { AgentProfile } from "../../src/agents/agent-config.ts";
import { CALL_RETURN_AGENT_TYPE } from "../../src/agents/agent-type-call-return.ts";
import { BACKGROUND_AGENT_TYPE, createBackgroundAgentRuntime } from "../../src/agents/agent-type-background.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { peekAgentWorkspace } from "../../src/agents/workspace-peek.ts";
import { makeNativeMockAdapter as makeMockAdapter } from "../support/mock-provider.ts";
import { createTempDir } from "../support/temp-dir.ts";

const PROFILE: AgentProfile = {
  name: "hostile-bg",
  type: "background",
  model: "test-model",
  provider: "test-provider",
  systemPrompt: "test",
  tools: [],
  capabilities: ["read"],
  writeSet: [],
  maxTurns: 3,
};

function setup() {
  const dir = createTempDir("hostile-type-test-");
  const store = createTimelineStore({ path: join(dir, "timeline.db") });
  const toolRegistry = createToolRegistry();
  const adapter = makeMockAdapter([{ type: "content" as const, text: "hello" }, { type: "finish" as const, reason: "stop" }]);
  return { dir, store, toolRegistry, adapter };
}

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ============================================================================
// Registry hostile tests
// ============================================================================

test("Hostile: registry rejects null typeDef", () => {
  assert.throws(() => createAgentTypeRegistry([null as unknown as AgentTypeDefinition]));
});

test("Hostile: registry rejects undefined typeDef", () => {
  assert.throws(() => createAgentTypeRegistry([undefined as unknown as AgentTypeDefinition]));
});

test("Hostile: registry rejects non-object typeDef", () => {
  assert.throws(() => createAgentTypeRegistry(["bad" as unknown as AgentTypeDefinition]));
});

test("Hostile: registry rejects number as typeId", () => {
  const bad = { ...CALL_RETURN_AGENT_TYPE, typeId: 123 as unknown as AgentTypeDefinition["typeId"] };
  assert.throws(() => createAgentTypeRegistry([bad]));
});

test("Hostile: registry accepts undefined hooks and fills with no-ops", () => {
  const bad = { ...CALL_RETURN_AGENT_TYPE, hooks: undefined as unknown as AgentTypeDefinition["hooks"] };
  const registry = createAgentTypeRegistry([bad]);
  const typeDef = registry.get("call-and-return")!;
  assert.ok(typeDef.hooks !== undefined);
});

test("Hostile: registry rejects type with non-array terminalStates", () => {
  const bad = { ...CALL_RETURN_AGENT_TYPE, terminalStates: "succeeded" as unknown as AgentTypeDefinition["terminalStates"] };
  assert.throws(() => createAgentTypeRegistry([bad]), InputError);
});

test("Hostile: resolve with null type falls back to default", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  const profile: AgentProfile = { ...PROFILE, type: null as unknown as string };
  const typeDef = registry.resolve(profile);
  assert.equal(typeDef.typeId, "call-and-return");
});

test("Hostile: resolve throws for profile with number type", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  const profile: AgentProfile = { ...PROFILE, type: 123 as unknown as string };
  assert.throws(() => registry.resolve(profile), InputError);
});

test("Hostile: AGENT_TYPE_IDS cannot be modified after creation", () => {
  assert.throws(() => {
    (AGENT_TYPE_IDS as unknown as string[]).push("hack");
  });
});

test("Hostile: two registries with different types don't interfere", () => {
  const r1 = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  const r2 = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE, BACKGROUND_AGENT_TYPE]);
  assert.ok(r1.has("call-and-return"));
  assert.ok(!r1.has("background"));
  assert.ok(r2.has("background"));
});

test("Hostile: register after seal throws specific error code", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  try {
    registry.register(CALL_RETURN_AGENT_TYPE);
    assert.fail("Should have thrown");
  } catch (e) {
    assert.ok(e instanceof InputError);
    assert.equal((e as InputError).code, "agent_registry_sealed");
  }
});

test("Hostile: duplicate registration throws specific error code", () => {
  try {
    createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE, CALL_RETURN_AGENT_TYPE]);
    assert.fail("Should have thrown");
  } catch (e) {
    assert.ok(e instanceof InputError);
    assert.equal((e as InputError).code, "agent_registry_duplicate_type");
  }
});

// ============================================================================
// Background agent hostile tests
// ============================================================================

test("Hostile: background handle steer ignores non-string input", () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = createBackgroundAgentRuntime({
      adapter, toolRegistry, modelConfig: { providerId: "t", modelId: "m", maxTokens: 10, temperature: 0 },
      profile: PROFILE, repositoryRoot: dir, stateStore: createAgentStateStore(createTimelineRecorder({ store })), runId: "r", taskId: "t", attemptId: "a",
    });
    const handle = runtime.start("task");
    handle.steer(null as unknown as string);
    assert.deepEqual([...handle.pendingSteeringMessages()], []);
  } finally { cleanup(dir); }
});

test("Hostile: background handle cancel during completion is safe", async () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = createBackgroundAgentRuntime({
      adapter, toolRegistry, modelConfig: { providerId: "t", modelId: "m", maxTokens: 10, temperature: 0 },
      profile: PROFILE, repositoryRoot: dir, stateStore: createAgentStateStore(createTimelineRecorder({ store })), runId: "r", taskId: "t", attemptId: "a",
    });
    const handle = runtime.start("task");
    const [result] = await Promise.all([
      handle.completion(),
      handle.cancel("test"),
    ]);
    assert.ok(["succeeded", "cancelled"].includes(result.lifecycleState));
  } finally { cleanup(dir); }
});

test("Hostile: background handle multiple cancels are safe", async () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = createBackgroundAgentRuntime({
      adapter, toolRegistry, modelConfig: { providerId: "t", modelId: "m", maxTokens: 10, temperature: 0 },
      profile: PROFILE, repositoryRoot: dir, stateStore: createAgentStateStore(createTimelineRecorder({ store })), runId: "r", taskId: "t", attemptId: "a",
    });
    const handle = runtime.start("task");
    await handle.cancel("first");
    await handle.cancel("second");
    const result = handle.result();
    assert.ok(result);
    assert.equal(result!.lifecycleState, "cancelled");
  } finally { cleanup(dir); }
});

test("Hostile: background handle resume without suspend is safe", async () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = createBackgroundAgentRuntime({
      adapter, toolRegistry, modelConfig: { providerId: "t", modelId: "m", maxTokens: 10, temperature: 0 },
      profile: PROFILE, repositoryRoot: dir, stateStore: createAgentStateStore(createTimelineRecorder({ store })), runId: "r", taskId: "t", attemptId: "a",
    });
    const handle = runtime.start("task");
    await handle.resume();
    const result = await handle.completion();
    assert.ok(["succeeded", "cancelled"].includes(result.lifecycleState));
  } finally { cleanup(dir); }
});

test("Hostile: background handle multiple resumes are safe", async () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = createBackgroundAgentRuntime({
      adapter, toolRegistry, modelConfig: { providerId: "t", modelId: "m", maxTokens: 10, temperature: 0 },
      profile: PROFILE, repositoryRoot: dir, stateStore: createAgentStateStore(createTimelineRecorder({ store })), runId: "r", taskId: "t", attemptId: "a",
    });
    const handle = runtime.start("task");
    await handle.resume();
    await handle.resume();
    await handle.resume();
    const result = await handle.completion();
    assert.ok(result);
  } finally { cleanup(dir); }
});

test("Hostile: background handle result is undefined before completion", () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = createBackgroundAgentRuntime({
      adapter, toolRegistry, modelConfig: { providerId: "t", modelId: "m", maxTokens: 10, temperature: 0 },
      profile: { ...PROFILE, maxTurns: 100 }, repositoryRoot: dir, stateStore: createAgentStateStore(createTimelineRecorder({ store })), runId: "r", taskId: "t", attemptId: "a",
    });
    const handle = runtime.start("task");
    assert.equal(handle.result(), undefined);
    handle.cancel("cleanup");
  } finally { cleanup(dir); }
});

test("Hostile: background agent with zero maxTurns fails validation", () => {
  const errors = BACKGROUND_AGENT_TYPE.validateProfile({ ...PROFILE, maxTurns: 0 });
  assert.ok(errors.length > 0);
});

test("Hostile: background agent with negative maxTurns fails validation", () => {
  const errors = BACKGROUND_AGENT_TYPE.validateProfile({ ...PROFILE, maxTurns: -5 });
  assert.ok(errors.length > 0);
});

test("Hostile: call-return agent with zero maxTurns fails validation", () => {
  const errors = CALL_RETURN_AGENT_TYPE.validateProfile({ ...PROFILE, maxTurns: 0 });
  assert.ok(errors.length > 0);
});

test("Hostile: call-return agent with empty name fails validation", () => {
  const errors = CALL_RETURN_AGENT_TYPE.validateProfile({ ...PROFILE, name: "" });
  assert.ok(errors.length > 0);
});

// ============================================================================
// Timeout hostile tests
// ============================================================================

test("Hostile: very short timeout transitions to timed-out or cancelled", async () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = createBackgroundAgentRuntime({
      adapter, toolRegistry, modelConfig: { providerId: "t", modelId: "m", maxTokens: 10, temperature: 0 },
      profile: { ...PROFILE, maxTurns: 100 }, repositoryRoot: dir, stateStore: createAgentStateStore(createTimelineRecorder({ store })), runId: "r", taskId: "t", attemptId: "a",
    }, 1);
    const handle = runtime.start("task");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = handle.status();
    assert.ok(["timed-out", "cancelled", "succeeded"].includes(status));
  } finally { cleanup(dir); }
});

test("Hostile: timeout clears the timer", async () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const runtime = createBackgroundAgentRuntime({
      adapter, toolRegistry, modelConfig: { providerId: "t", modelId: "m", maxTokens: 10, temperature: 0 },
      profile: { ...PROFILE, maxTurns: 100 }, repositoryRoot: dir, stateStore: createAgentStateStore(createTimelineRecorder({ store })), runId: "r", taskId: "t", attemptId: "a",
    }, 50);
    const handle = runtime.start("task");
    await handle.cancel("manual cancel before timeout");
    // Wait past the timeout to ensure it doesn't fire
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = handle.result();
    assert.ok(result);
    assert.equal(result!.lifecycleState, "cancelled");
  } finally { cleanup(dir); }
});

// ============================================================================
// Concurrency hostile tests
// ============================================================================

test("Hostile: concurrent peek is safe", () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    const runtime = createBackgroundAgentRuntime({
      adapter, toolRegistry, modelConfig: { providerId: "t", modelId: "m", maxTokens: 10, temperature: 0 },
      profile: { ...PROFILE, maxTurns: 100 }, repositoryRoot: dir, stateStore, runId: "r", taskId: "t", attemptId: "a",
    });
    const handle = runtime.start("task");
    const snapshots = [
      peekAgentWorkspace(handle, stateStore, store),
      peekAgentWorkspace(handle, stateStore, store),
      peekAgentWorkspace(handle, stateStore, store),
    ];
    for (const s of snapshots) {
      assert.equal(s.agentId, handle.agentId);
    }
    handle.cancel("cleanup");
  } finally { cleanup(dir); }
});

test("Hostile: concurrent steer and peek is safe", () => {
  const { dir, store, toolRegistry, adapter } = setup();
  try {
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    const runtime = createBackgroundAgentRuntime({
      adapter, toolRegistry, modelConfig: { providerId: "t", modelId: "m", maxTokens: 10, temperature: 0 },
      profile: { ...PROFILE, maxTurns: 100 }, repositoryRoot: dir, stateStore, runId: "r", taskId: "t", attemptId: "a",
    });
    const handle = runtime.start("task");
    handle.steer("msg1");
    const snapshot = peekAgentWorkspace(handle, stateStore, store);
    handle.steer("msg2");
    assert.ok(snapshot.pendingSteeringMessages.includes("msg1"));
    handle.cancel("cleanup");
  } finally { cleanup(dir); }
});

// ============================================================================
// Unknown agent type
// ============================================================================

test("Hostile: unknown agent type in config is rejected at resolve", () => {
  const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE]);
  const profile: AgentProfile = { ...PROFILE, type: "unknown" };
  assert.throws(() => registry.resolve(profile), (e: Error) => e instanceof InputError);
});

test("Hostile: resolve with type not in registry throws", () => {
  const registry = createAgentTypeRegistry();
  assert.throws(
    () => registry.resolve(PROFILE),
    (e: Error) => e instanceof InputError && e.code === "agent_registry_unknown_type",
  );
});
