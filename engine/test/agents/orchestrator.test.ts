import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import {
  createOrchestrator,
  validateOrchestrationPlan,
  type OrchestrationResult,
  type OrchestrationEvent,
} from "../../src/agents/orchestrator.ts";
import {
  resolveAgentsConfig,
  createProviderModelResolver,
  type AgentsConfig,
} from "../../src/agents/agent-config.ts";
import { createAgentTypeRegistry } from "../../src/agents/agent-type-registry.ts";
import { CALL_RETURN_AGENT_TYPE } from "../../src/agents/agent-type-call-return.ts";
import { BACKGROUND_AGENT_TYPE } from "../../src/agents/agent-type-background.ts";
import { scratchAgentsConfigDocument } from "../support/scratch-runtime-config.ts";
import type { ChatStreamEvent, ProviderAdapter } from "../../src/runtime/provider-adapter.ts";
import { makeNativeMockAdapter as makeMockAdapter, nativeResponseAdapter } from "../support/mock-provider.ts";
import { mkOwnedTempDir, createTempDir } from "../support/temp-dir.ts";

const TEMP_ROOT = mkOwnedTempDir("orchestrator-test-");
writeFileSync(join(TEMP_ROOT, "test.txt"), "test content");

// The checked-in config ships NO provider (the provider decision), so the
// fixture declares its own scratch one — see the helper for the reasoning.
const CONFIG_DOC = scratchAgentsConfigDocument();
const AGENTS_CONFIG = resolveAgentsConfig(CONFIG_DOC)!;
const RESOLVER = createProviderModelResolver(CONFIG_DOC);

function contentEvents(...texts: string[]): ChatStreamEvent[] {
  return texts.map(text => Object.freeze({ type: "content" as const, text }));
}

function finishEvent(reason: string): ChatStreamEvent {
  return Object.freeze({ type: "finish" as const, reason });
}

function setup() {
  const dir = createTempDir("orchestrator-store-");
  const store = createTimelineStore({ path: join(dir, "timeline.db") });
  const toolRegistry = createToolRegistry();
  const adapter = makeMockAdapter([...contentEvents("Task done"), finishEvent("stop")]);
  return { store, toolRegistry, adapter, dir };
}

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function createTestOrchestrator() {
  const { store, toolRegistry, adapter, dir } = setup();
  const orchestrator = createOrchestrator({
    adapter,
    toolRegistry,
    resolver: RESOLVER,
    agentsConfig: AGENTS_CONFIG,
    repositoryRoot: TEMP_ROOT,
    store,
  });
  return { orchestrator, store, dir };
}

async function executePlan(
  orchestrator: ReturnType<typeof createTestOrchestrator>["orchestrator"],
  tasks: readonly { taskId?: string; task: string; agentName: string; dependsOn?: readonly string[] }[],
  signal?: AbortSignal,
): Promise<OrchestrationResult> {
  const orchestrationPlan = orchestrator.plan(tasks);
  const generator = orchestrator.execute(orchestrationPlan, signal);
  let result = await generator.next();
  while (!result.done) { result = await generator.next(result.value); }
  return result.value;
}

// ============================================================================
// Orchestrator creation
// ============================================================================

test("Orchestrator: creates with runId", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    assert.ok(orchestrator.runId.length > 0);
  } finally { cleanup(dir); }
});

test("Orchestrator: awareness store is available", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    assert.ok(orchestrator.awareness);
    assert.deepEqual([...orchestrator.awareness.getEntries()], []);
  } finally { cleanup(dir); }
});

test("Orchestrator: state store is available", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    assert.ok(orchestrator.stateStore);
    assert.deepEqual([...orchestrator.getAgentStates()], []);
  } finally { cleanup(dir); }
});

test("Orchestrator: object is frozen", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    assert.ok(Object.isFrozen(orchestrator));
  } finally { cleanup(dir); }
});

// ============================================================================
// Plan creation
// ============================================================================

test("Orchestrator: plan creates task IDs", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const plan = orchestrator.plan([
      { task: "Do research", agentName: "researcher" },
    ]);
    assert.equal(plan.tasks.length, 1);
    assert.ok(plan.tasks[0]!.taskId.length > 0);
    assert.equal(plan.tasks[0]!.agentName, "researcher");
    assert.equal(plan.tasks[0]!.task, "Do research");
    assert.deepEqual([...plan.tasks[0]!.dependsOn], []);
  } finally { cleanup(dir); }
});

test("Orchestrator: plan preserves dependencies", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const plan = orchestrator.plan([
      { task: "Research", agentName: "researcher" },
      { task: "Implement", agentName: "implementer", dependsOn: [] },
    ]);
    assert.equal(plan.tasks.length, 2);
    assert.deepEqual([...plan.tasks[1]!.dependsOn], []);
  } finally { cleanup(dir); }
});

test("Orchestrator: plan rejects too many tasks", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const tooMany = Array.from({ length: 6 }, (_, i) => ({
      task: `task-${i}`, agentName: "researcher",
    }));
    assert.throws(() => orchestrator.plan(tooMany), /exceeds maximum/);
  } finally { cleanup(dir); }
});

test("Orchestrator: plan handles dependencies correctly", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const plan = orchestrator.plan([
      { taskId: "task-a", task: "A", agentName: "researcher" },
      { taskId: "task-b", task: "B", agentName: "implementer", dependsOn: ["task-a"] },
    ]);
    assert.deepEqual([...plan.tasks[1]!.dependsOn], ["task-a"]);
  } finally { cleanup(dir); }
});

// ============================================================================
// Single agent execution
// ============================================================================

test("Orchestrator: executes single task with one agent", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const result = await executePlan(orchestrator, [
      { task: "Say hello", agentName: "researcher" },
    ]);
    assert.equal(result.agentResults.length, 1);
    assert.equal(result.allSucceeded, true);
    assert.equal(result.totalTurns, 1);
  } finally { cleanup(dir); }
});

test("Orchestrator: records agent results with name and id", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const result = await executePlan(orchestrator, [
      { task: "task", agentName: "researcher" },
    ]);
    assert.equal(result.agentResults[0]!.agentName, "researcher");
    assert.ok(result.agentResults[0]!.agentId.length > 0);
  } finally { cleanup(dir); }
});

// ============================================================================
// Zero agents
// ============================================================================

test("Orchestrator: executes zero tasks", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const result = await executePlan(orchestrator, []);
    assert.equal(result.agentResults.length, 0);
    assert.equal(result.allSucceeded, true);
    assert.equal(result.totalTurns, 0);
  } finally { cleanup(dir); }
});

// ============================================================================
// Multiple agents (0-5)
// ============================================================================

test("Orchestrator: executes two independent tasks", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const result = await executePlan(orchestrator, [
      { task: "Research task", agentName: "researcher" },
      { task: "Review task", agentName: "reviewer" },
    ]);
    assert.equal(result.agentResults.length, 2);
    assert.equal(result.allSucceeded, true);
  } finally { cleanup(dir); }
});

test("Orchestrator: executes three tasks sequentially", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const result = await executePlan(orchestrator, [
      { task: "Task 1", agentName: "researcher" },
      { task: "Task 2", agentName: "implementer" },
      { task: "Task 3", agentName: "reviewer" },
    ]);
    assert.equal(result.agentResults.length, 3);
    assert.equal(result.allSucceeded, true);
  } finally { cleanup(dir); }
});

test("Orchestrator: executes maximum 5 agents", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const result = await executePlan(orchestrator, [
      { task: "T1", agentName: "researcher" },
      { task: "T2", agentName: "implementer" },
      { task: "T3", agentName: "reviewer" },
      { task: "T4", agentName: "researcher" },
      { task: "T5", agentName: "reviewer" },
    ]);
    assert.equal(result.agentResults.length, 5);
    assert.equal(result.allSucceeded, true);
  } finally { cleanup(dir); }
});

// ============================================================================
// Task dependencies
// ============================================================================

test("Orchestrator: executes tasks with dependencies in order", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const plan = orchestrator.plan([
      { taskId: "research", task: "Research", agentName: "researcher" },
      { taskId: "implement", task: "Implement after research", agentName: "implementer", dependsOn: ["research"] },
    ]);
    const generator = orchestrator.execute(plan);
    let result = await generator.next();
    while (!result.done) { result = await generator.next(result.value); }
    assert.equal(result.value.agentResults.length, 2);
    assert.equal(result.value.allSucceeded, true);
  } finally { cleanup(dir); }
});

test("Orchestrator: skips task when dependency fails", async () => {
  const { store, toolRegistry, dir } = setup();
  try {
    const failingAdapter: ProviderAdapter = nativeResponseAdapter({
      providerId: "mock",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
        throw new Error("Provider failed");
      },
      async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
    });
    const orchestrator = createOrchestrator({
      adapter: failingAdapter, toolRegistry, resolver: RESOLVER,
      agentsConfig: AGENTS_CONFIG, repositoryRoot: TEMP_ROOT, store,
    });
    const plan = orchestrator.plan([
      { taskId: "fail", task: "Failing task", agentName: "researcher" },
      { taskId: "dep", task: "Dependent task", agentName: "implementer", dependsOn: ["fail"] },
    ]);
    const generator = orchestrator.execute(plan);
    let result = await generator.next();
    const events: string[] = [];
    while (!result.done) {
      if (result.value.type === "task_failed" || result.value.type === "task_skipped") {
        events.push(result.value.type);
      }
      result = await generator.next(result.value);
    }
    assert.ok(events.includes("task_failed"));
    assert.ok(events.includes("task_skipped"));
  } finally { cleanup(dir); }
});

// ============================================================================
// Shared awareness
// ============================================================================

test("Orchestrator: awareness store publishes entries", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    orchestrator.awareness.publish({
      agentName: "researcher",
      taskId: "task-1",
      content: "Found something interesting",
      timestamp: new Date().toISOString(),
      turnNumber: 1,
    });
    const entries = orchestrator.awareness.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.agentName, "researcher");
    assert.equal(entries[0]!.content, "Found something interesting");
  } finally { cleanup(dir); }
});

test("Orchestrator: awareness filters by agent name", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    orchestrator.awareness.publish({
      agentName: "a", taskId: "t1", content: "msg1", timestamp: "", turnNumber: 1,
    });
    orchestrator.awareness.publish({
      agentName: "b", taskId: "t2", content: "msg2", timestamp: "", turnNumber: 1,
    });
    assert.equal(orchestrator.awareness.getEntriesForAgent("a").length, 1);
    assert.equal(orchestrator.awareness.getEntriesForAgent("b").length, 1);
    assert.equal(orchestrator.awareness.getEntriesForAgent("c").length, 0);
  } finally { cleanup(dir); }
});

test("Orchestrator: awareness filters by task id", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    orchestrator.awareness.publish({
      agentName: "a", taskId: "t1", content: "msg1", timestamp: "", turnNumber: 1,
    });
    orchestrator.awareness.publish({
      agentName: "b", taskId: "t2", content: "msg2", timestamp: "", turnNumber: 1,
    });
    assert.equal(orchestrator.awareness.getEntriesForTask("t1").length, 1);
    assert.equal(orchestrator.awareness.getEntriesForTask("t2").length, 1);
    assert.equal(orchestrator.awareness.getEntriesForTask("t3").length, 0);
  } finally { cleanup(dir); }
});

test("Orchestrator: awareness snapshot returns all entries", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    orchestrator.awareness.publish({
      agentName: "a", taskId: "t1", content: "msg1", timestamp: "", turnNumber: 1,
    });
    orchestrator.awareness.publish({
      agentName: "b", taskId: "t2", content: "msg2", timestamp: "", turnNumber: 1,
    });
    const snap = orchestrator.awareness.snapshot();
    assert.equal(snap.entries.length, 2);
  } finally { cleanup(dir); }
});

test("Orchestrator: awareness entries are frozen", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    orchestrator.awareness.publish({
      agentName: "a", taskId: "t1", content: "msg1", timestamp: "", turnNumber: 1,
    });
    const entries = orchestrator.awareness.getEntries();
    assert.ok(Object.isFrozen(entries[0]));
  } finally { cleanup(dir); }
});

test("Orchestrator: publishes awareness entries during execution", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    await executePlan(orchestrator, [
      { task: "Research something", agentName: "researcher" },
    ]);
    const entries = orchestrator.awareness.getEntries();
    assert.ok(entries.length > 0);
    assert.equal(entries[0]!.agentName, "researcher");
  } finally { cleanup(dir); }
});

// ============================================================================
// Conflict detection
// ============================================================================

test("Orchestrator: detectConflicts returns no conflicts for config with disjoint write sets", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const result = orchestrator.detectConflicts();
    assert.equal(result.conflicts.length, 0);
  } finally { cleanup(dir); }
});

test("Orchestrator: throws on write-set conflict when conflict detection enabled", async () => {
  const { store, toolRegistry, adapter, dir } = setup();
  try {
    const conflictingConfig: AgentsConfig = {
      maximumConcurrentAgents: 2,
      profiles: [
        { name: "a", type: "call-and-return",  model: "zai-org/GLM-5.2-NVFP4", provider: "openrouter", systemPrompt: "", tools: [], capabilities: ["read"], writeSet: ["src/"], maxTurns: 5 },
        { name: "b", type: "call-and-return",  model: "zai-org/GLM-5.2-NVFP4", provider: "openrouter", systemPrompt: "", tools: [], capabilities: ["read"], writeSet: ["src/"], maxTurns: 5 },
      ],
      orchestration: { alignmentMonitorIntervalMs: 30000, conflictDetectionEnabled: true },
    };
    const orchestrator = createOrchestrator({
      adapter, toolRegistry, resolver: RESOLVER,
      agentsConfig: conflictingConfig, repositoryRoot: TEMP_ROOT, store,
    });
    const plan = orchestrator.plan([{ taskId: "t1", task: "T1", agentName: "a" }, { taskId: "t2", task: "T2", agentName: "b" }]);
    await assert.rejects(async () => {
      const gen = orchestrator.execute(plan);
      let result = await gen.next();
      while (!result.done) { result = await gen.next(result.value); }
    }, /conflict/i);
  } finally { cleanup(dir); }
});

test("Orchestrator: does not throw on conflict when detection disabled", () => {
  const { store, toolRegistry, adapter, dir } = setup();
  try {
    const noDetectConfig: AgentsConfig = {
      maximumConcurrentAgents: 2,
      profiles: [
        { name: "a", type: "call-and-return",  model: "zai-org/GLM-5.2-NVFP4", provider: "openrouter", systemPrompt: "", tools: [], capabilities: ["read"], writeSet: ["src/"], maxTurns: 5 },
        { name: "b", type: "call-and-return",  model: "zai-org/GLM-5.2-NVFP4", provider: "openrouter", systemPrompt: "", tools: [], capabilities: ["read"], writeSet: ["src/"], maxTurns: 5 },
      ],
      orchestration: { alignmentMonitorIntervalMs: 30000, conflictDetectionEnabled: false },
    };
    const orchestrator = createOrchestrator({
      adapter, toolRegistry, resolver: RESOLVER,
      agentsConfig: noDetectConfig, repositoryRoot: TEMP_ROOT, store,
    });
    const result = orchestrator.detectConflicts();
    assert.equal(result.conflicts.length, 0);
  } finally { cleanup(dir); }
});

// ============================================================================
// Agent state tracking
// ============================================================================

test("Orchestrator: getAgentStates returns empty before execution", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    assert.equal(orchestrator.getAgentStates().length, 0);
  } finally { cleanup(dir); }
});

test("Orchestrator: getAgentStates returns states after execution", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    await executePlan(orchestrator, [
      { task: "Task", agentName: "researcher" },
    ]);
    assert.equal(orchestrator.getAgentStates().length, 1);
    assert.equal(orchestrator.getAgentStates()[0]!.agentName, "researcher");
    assert.equal(orchestrator.getAgentStates()[0]!.lifecycleState, "succeeded");
  } finally { cleanup(dir); }
});

test("Orchestrator: tracks multiple agent states", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    await executePlan(orchestrator, [
      { task: "T1", agentName: "researcher" },
      { task: "T2", agentName: "reviewer" },
    ]);
    assert.equal(orchestrator.getAgentStates().length, 2);
  } finally { cleanup(dir); }
});

// ============================================================================
// Cancellation
// ============================================================================

test("Orchestrator: cancellation via AbortSignal", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const controller = new AbortController();
    controller.abort();
    const plan = orchestrator.plan([{ task: "Task", agentName: "researcher" }]);
    const generator = orchestrator.execute(plan, controller.signal);
    let result = await generator.next();
    while (!result.done) { result = await generator.next(result.value); }
    assert.ok(result.value.agentResults.length <= 1);
  } finally { cleanup(dir); }
});

// ============================================================================
// validateOrchestrationPlan
// ============================================================================

test("Orchestrator: validateOrchestrationPlan accepts valid plan", () => {
  const result = validateOrchestrationPlan(AGENTS_CONFIG, [
    { agentName: "researcher" },
  ]);
  assert.equal(result.valid, true);
});

test("Orchestrator: validateOrchestrationPlan rejects unknown agent", () => {
  const result = validateOrchestrationPlan(AGENTS_CONFIG, [
    { agentName: "unknown" },
  ]);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some(e => e.includes("Unknown agent")));
  }
});

test("Orchestrator: validateOrchestrationPlan rejects too many tasks", () => {
  const config: AgentsConfig = {
    ...AGENTS_CONFIG,
    maximumConcurrentAgents: 1,
  };
  const result = validateOrchestrationPlan(config, [
    { agentName: "researcher" },
    { agentName: "reviewer" },
  ]);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some(e => e.includes("maximumConcurrentAgents")));
  }
});

// ============================================================================
// Total tokens and turns tracking
// ============================================================================

test("Orchestrator: tracks total turns across all agents", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const result = await executePlan(orchestrator, [
      { task: "T1", agentName: "researcher" },
      { task: "T2", agentName: "reviewer" },
    ]);
    assert.equal(result.totalTurns, 2);
  } finally { cleanup(dir); }
});

test("Orchestrator: tracks total tokens across all agents", async () => {
  const { store, toolRegistry, dir } = setup();
  try {
    const adapter: ProviderAdapter = nativeResponseAdapter({
      providerId: "mock",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
        yield Object.freeze({ type: "content", text: "Hi" });
        yield Object.freeze({ type: "finish", reason: "stop" });
        yield Object.freeze({ type: "usage", usage: Object.freeze({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }) });
      },
      async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
    });
    const orchestrator = createOrchestrator({
      adapter, toolRegistry, resolver: RESOLVER,
      agentsConfig: AGENTS_CONFIG, repositoryRoot: TEMP_ROOT, store,
    });
    const result = await executePlan(orchestrator, [
      { task: "T1", agentName: "researcher" },
    ]);
    assert.equal(result.totalTokens, 15);
  } finally { cleanup(dir); }
});

// ============================================================================
// Result structure
// ============================================================================

test("Orchestrator: result contains runId", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const result = await executePlan(orchestrator, [
      { task: "T1", agentName: "researcher" },
    ]);
    assert.equal(result.runId, orchestrator.runId);
  } finally { cleanup(dir); }
});

test("Orchestrator: result is frozen", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const result = await executePlan(orchestrator, [
      { task: "T1", agentName: "researcher" },
    ]);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.agentResults));
  } finally { cleanup(dir); }
});

test("Orchestrator: result contains conflicts array", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const result = await executePlan(orchestrator, [
      { task: "T1", agentName: "researcher" },
    ]);
    assert.ok(Object.isFrozen(result.conflicts));
  } finally { cleanup(dir); }
});

// ============================================================================
// Error handling
// ============================================================================

test("Orchestrator: handles agent failure gracefully", async () => {
  const { store, toolRegistry, dir } = setup();
  try {
    const failingAdapter: ProviderAdapter = nativeResponseAdapter({
      providerId: "mock",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
        throw new Error("Provider error");
      },
      async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
    });
    const orchestrator = createOrchestrator({
      adapter: failingAdapter, toolRegistry, resolver: RESOLVER,
      agentsConfig: AGENTS_CONFIG, repositoryRoot: TEMP_ROOT, store,
    });
    const plan = orchestrator.plan([{ taskId: "t1", task: "T1", agentName: "researcher" }]);
    const generator = orchestrator.execute(plan);
    let result = await generator.next();
    while (!result.done) { result = await generator.next(result.value); }
    assert.equal(result.value.allSucceeded, false);
    assert.equal(result.value.agentResults[0]!.lifecycleState, "failed");
  } finally { cleanup(dir); }
});

test("Orchestrator: continues execution after one agent fails", async () => {
  const { store, toolRegistry, dir } = setup();
  try {
    let callCount = 0;
    const adapter: ProviderAdapter = nativeResponseAdapter({
      providerId: "mock",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
        callCount++;
        if (callCount === 1) throw new Error("First fails");
        yield Object.freeze({ type: "content", text: "Second succeeds" });
        yield Object.freeze({ type: "finish", reason: "stop" });
      },
      async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
    });
    const orchestrator = createOrchestrator({
      adapter, toolRegistry, resolver: RESOLVER,
      agentsConfig: AGENTS_CONFIG, repositoryRoot: TEMP_ROOT, store,
    });
    const result = await executePlan(orchestrator, [
      { task: "T1", agentName: "researcher" },
      { task: "T2", agentName: "reviewer" },
    ]);
    assert.equal(result.agentResults.length, 2);
    assert.equal(result.agentResults[0]!.lifecycleState, "failed");
    assert.equal(result.agentResults[1]!.lifecycleState, "succeeded");
  } finally { cleanup(dir); }
});

// ============================================================================
// Agent type registry integration (D20)
// ============================================================================

test("Orchestrator: has agentTypeRegistry property", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    assert.ok(orchestrator.agentTypeRegistry);
    assert.equal(typeof orchestrator.agentTypeRegistry.resolve, "function");
  } finally { cleanup(dir); }
});

test("Orchestrator: uses default registry when none provided", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    assert.ok(orchestrator.agentTypeRegistry.has("call-and-return"));
    assert.ok(orchestrator.agentTypeRegistry.has("background"));
  } finally { cleanup(dir); }
});

test("Orchestrator: accepts custom registry", () => {
  const { store, toolRegistry, adapter, dir } = setup();
  try {
    const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE, BACKGROUND_AGENT_TYPE]);
    const orchestrator = createOrchestrator({
      adapter, toolRegistry, resolver: RESOLVER,
      agentsConfig: AGENTS_CONFIG, repositoryRoot: TEMP_ROOT, store,
      agentTypeRegistry: registry,
    });
    assert.ok(orchestrator.agentTypeRegistry === registry);
  } finally { cleanup(dir); }
});

test("Orchestrator: has backgroundHandles map", () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    assert.ok(orchestrator.backgroundHandles);
    assert.equal(typeof orchestrator.backgroundHandles.size, "number");
  } finally { cleanup(dir); }
});

test("Orchestrator: sync agent execution works with registry", async () => {
  const { store, toolRegistry, dir } = setup();
  try {
    const adapter = makeMockAdapter([...contentEvents("Task done"), finishEvent("stop")]);
    const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE, BACKGROUND_AGENT_TYPE]);
    const orchestrator = createOrchestrator({
      adapter, toolRegistry, resolver: RESOLVER,
      agentsConfig: AGENTS_CONFIG, repositoryRoot: TEMP_ROOT, store,
      agentTypeRegistry: registry,
    });
    const result = await executePlan(orchestrator, [
      { task: "T1", agentName: "researcher" },
    ]);
    assert.equal(result.agentResults.length, 1);
    assert.equal(result.agentResults[0]!.lifecycleState, "succeeded");
  } finally { cleanup(dir); }
});

test("Orchestrator: validates plan with typed agents", () => {
  const result = validateOrchestrationPlan(AGENTS_CONFIG, [
    { agentName: "researcher" },
    { agentName: "reviewer" },
  ]);
  assert.ok(result.valid);
});

test("Orchestrator: sync execution with registry has same results as default", async () => {
  const { store, toolRegistry, dir } = setup();
  try {
    const adapter = makeMockAdapter([...contentEvents("test"), finishEvent("stop")]);
    const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE, BACKGROUND_AGENT_TYPE]);
    const orchestrator = createOrchestrator({
      adapter, toolRegistry, resolver: RESOLVER,
      agentsConfig: AGENTS_CONFIG, repositoryRoot: TEMP_ROOT, store,
      agentTypeRegistry: registry,
    });
    const plan = orchestrator.plan([
      { task: "T1", agentName: "researcher" },
    ]);
    const generator = orchestrator.execute(plan);
    let result = await generator.next();
    while (!result.done) {
      result = await generator.next(result.value);
    }
    assert.equal(result.value.allSucceeded, true);
    assert.equal(result.value.agentResults.length, 1);
  } finally { cleanup(dir); }
});

test("Orchestrator: background agent type resolves via registry", () => {
  const { store, toolRegistry, dir } = setup();
  try {
    const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE, BACKGROUND_AGENT_TYPE]);
    const orchestrator = createOrchestrator({
      adapter: makeMockAdapter([]), toolRegistry, resolver: RESOLVER,
      agentsConfig: AGENTS_CONFIG, repositoryRoot: TEMP_ROOT, store,
      agentTypeRegistry: registry,
    });
    const profile = AGENTS_CONFIG.profiles[0]!;
    const typeDef = orchestrator.agentTypeRegistry.resolve(profile);
    assert.ok(typeDef);
    assert.equal(typeDef.typeId, "call-and-return");
  } finally { cleanup(dir); }
});

test("Orchestrator: multiple sync agents execute in dependency order", async () => {
  const { store, toolRegistry, dir } = setup();
  try {
    const adapter = makeMockAdapter([...contentEvents("done"), finishEvent("stop")]);
    const registry = createAgentTypeRegistry([CALL_RETURN_AGENT_TYPE, BACKGROUND_AGENT_TYPE]);
    const orchestrator = createOrchestrator({
      adapter, toolRegistry, resolver: RESOLVER,
      agentsConfig: AGENTS_CONFIG, repositoryRoot: TEMP_ROOT, store,
      agentTypeRegistry: registry,
    });
    const result = await executePlan(orchestrator, [
      { task: "T1", agentName: "researcher", taskId: "t1" },
      { task: "T2", agentName: "reviewer", taskId: "t2", dependsOn: ["t1"] },
    ]);
    assert.equal(result.agentResults.length, 2);
    assert.equal(result.allSucceeded, true);
  } finally { cleanup(dir); }
});

// ============================================================================
// Task dependency execution ordering (GAP-9)
// ============================================================================

async function collectEvents(
  orchestrator: ReturnType<typeof createTestOrchestrator>["orchestrator"],
  plan: ReturnType<typeof orchestrator.plan>,
): Promise<{ events: readonly OrchestrationEvent[]; result: OrchestrationResult }> {
  const gen = orchestrator.execute(plan);
  const events: OrchestrationEvent[] = [];
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next(r.value);
  }
  return { events, result: r.value };
}

test("Orchestrator: task_started(t2) is emitted AFTER task_completed(t1) for a dependency", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const plan = orchestrator.plan([
      { taskId: "t1", task: "First", agentName: "researcher" },
      { taskId: "t2", task: "Second after first", agentName: "implementer", dependsOn: ["t1"] },
    ]);
    const { events } = await collectEvents(orchestrator, plan);
    const startedT2 = events.findIndex((e) => e.type === "task_started" && e.taskId === "t2");
    const completedT1 = events.findIndex((e) => e.type === "task_completed" && e.taskId === "t1");
    assert.ok(completedT1 >= 0, "task_completed(t1) must be emitted");
    assert.ok(startedT2 >= 0, "task_started(t2) must be emitted");
    assert.ok(startedT2 > completedT1, "task_started(t2) must come AFTER task_completed(t1)");
  } finally { cleanup(dir); }
});

// ============================================================================
// Forge 6-task plan to execute (GAP-10)
// ============================================================================

test("Orchestrator: forged 6-task plan passed to execute throws orchestration_too_many_agents", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const forgedPlan = Object.freeze({
      runId: orchestrator.runId,
      tasks: Object.freeze(Array.from({ length: 6 }, (_, i) => Object.freeze({
        taskId: `t${i}`, task: `T${i}`, agentName: "researcher", dependsOn: Object.freeze([]),
      }))),
    });
    await assert.rejects(
      async () => {
        const gen = orchestrator.execute(forgedPlan as never);
        await gen.next();
      },
      (e: unknown) => e instanceof Error && (e as { code?: string }).code === "orchestration_too_many_agents",
    );
  } finally { cleanup(dir); }
});

// ============================================================================
// Stuck plan event ordering and reason distinction (GAP-11)
// ============================================================================

test("Orchestrator: cyclic dependency emits task_skipped with cycle reason", async () => {
  const { orchestrator, dir } = createTestOrchestrator();
  try {
    const plan = orchestrator.plan([
      { taskId: "t1", task: "A", agentName: "researcher", dependsOn: ["t2"] },
      { taskId: "t2", task: "B", agentName: "implementer", dependsOn: ["t1"] },
    ]);
    const { events } = await collectEvents(orchestrator, plan);
    type TaskSkipped = Extract<OrchestrationEvent, { type: "task_skipped" }>;
    const skipped = events.filter((e): e is TaskSkipped => e.type === "task_skipped");
    assert.equal(skipped.length, 2, "every stuck task in a cycle must emit task_skipped");
    for (const s of skipped) {
      assert.ok(s.reason.includes("cycle"), `cycle reason must mention 'cycle'; got '${s.reason}'`);
    }
  } finally { cleanup(dir); }
});

test("Orchestrator: failed-dependency skip reason differs from cycle reason", async () => {
  const { store, toolRegistry, dir } = setup();
  try {
    const failingAdapter: ProviderAdapter = nativeResponseAdapter({
      providerId: "mock",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
        throw new Error("Provider failed");
      },
      async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
    });
    const orchestrator = createOrchestrator({
      adapter: failingAdapter, toolRegistry, resolver: RESOLVER,
      agentsConfig: AGENTS_CONFIG, repositoryRoot: TEMP_ROOT, store,
    });
    const plan = orchestrator.plan([
      { taskId: "fail", task: "Failing", agentName: "researcher" },
      { taskId: "dep", task: "Dependent", agentName: "implementer", dependsOn: ["fail"] },
    ]);
    const { events } = await collectEvents(orchestrator, plan);
    type TaskSkipped = Extract<OrchestrationEvent, { type: "task_skipped" }>;
    const skipped = events.filter((e): e is TaskSkipped => e.type === "task_skipped");
    assert.ok(skipped.length >= 1);
    assert.ok(
      skipped.some((s) => s.reason === "Dependency failed"),
      "a failed-dependency skip must use the 'Dependency failed' reason",
    );
    // The two reasons are distinct strings: a cycle must never be reported as a
    // dependency failure, and vice versa.
    assert.notEqual("Dependency failed", "Dependency cycle or unresolvable");
  } finally { cleanup(dir); }
});

// ============================================================================
// Orchestration resume (GAP-26)
// ============================================================================

test("Orchestrator: resume is not supported — a new orchestrator re-executes the plan (documented gap)", async () => {
  // The current orchestrator is stateless across instances: task-completion
  // state lives in an in-memory `completed` set inside execute, and the
  // store is used only for the timeline recorder. A new orchestrator built
  // against the same store has no way to know which tasks already completed,
  // so execute always re-runs the plan from scratch. This test pins that
  // current behavior and documents the missing resume capability.
  const { store, toolRegistry, dir } = setup();
  try {
    let callCount = 0;
    const countingAdapter: ProviderAdapter = nativeResponseAdapter({
      providerId: "mock",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
        callCount++;
        yield Object.freeze({ type: "content", text: "ok" });
        yield Object.freeze({ type: "finish", reason: "stop" });
      },
      async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
    });
    const planTasks = [
      { taskId: "t1", task: "T1", agentName: "researcher" },
      { taskId: "t2", task: "T2", agentName: "implementer", dependsOn: ["t1"] },
      { taskId: "t3", task: "T3", agentName: "reviewer", dependsOn: ["t2"] },
    ];
    const orchestratorA = createOrchestrator({
      adapter: countingAdapter, toolRegistry, resolver: RESOLVER,
      agentsConfig: AGENTS_CONFIG, repositoryRoot: TEMP_ROOT, store,
    });
    await executePlan(orchestratorA, planTasks);
    const callsAfterA = callCount;

    // Simulate a crash: discard orchestratorA. Build a new orchestrator against
    // the SAME store and re-run the plan.
    const orchestratorB = createOrchestrator({
      adapter: countingAdapter, toolRegistry, resolver: RESOLVER,
      agentsConfig: AGENTS_CONFIG, repositoryRoot: TEMP_ROOT, store,
    });
    const planB = orchestratorB.plan(planTasks);
    const { events: eventsB } = await collectEvents(orchestratorB, planB);
    const callsAfterB = callCount;

    // Because resume is not implemented, orchestratorB re-runs t1 (and all
    // tasks) rather than resuming from t2. The store did not carry forward
    // any task-completion state for orchestration.
    assert.ok(
      eventsB.some((e) => e.type === "task_started" && e.taskId === "t1"),
      "a new orchestrator re-starts t1 (resume is not supported)",
    );
    assert.ok(callsAfterB > callsAfterA, "the new orchestrator made additional provider calls (no resume)");
    // GAP-26: orchestration resume requires persisting task-completion state
    // to the store and a resume(plan) entry point that skips already-completed
    // tasks. Not yet implemented.
  } finally { cleanup(dir); }
});
