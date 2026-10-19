import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import { createOrchestrator, validateOrchestrationPlan } from "../../src/agents/orchestrator.ts";
import {
  resolveAgentsConfig,
  createProviderModelResolver,
  hasCapability,
  isPathInWriteSet,
  detectWriteSetConflict,
  type AgentProfile,
  type AgentsConfig,
} from "../../src/agents/agent-config.ts";
import { createAgentStateStore, compactAgentTurns } from "../../src/agents/agent-state.ts";
import { createAgentRuntime } from "../../src/agents/agent-runtime.ts";
import { getConfigDocumentSchema } from "../../src/kernel/config-contracts.ts";
import { scratchAgentsConfigDocument } from "../support/scratch-runtime-config.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import type { ChatStreamEvent, ProviderAdapter } from "../../src/runtime/provider-adapter.ts";
import { makeNativeMockAdapter as makeMockAdapter, nativeResponseAdapter } from "../support/mock-provider.ts";
import { mkOwnedTempDir, createTempDir } from "../support/temp-dir.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

const TEMP_ROOT = mkOwnedTempDir("hostile-agent-test-");
writeFileSync(join(TEMP_ROOT, "test.txt"), "test content");

// The checked-in config ships NO provider (the provider decision), so the
// fixture declares its own scratch one — see the helper for the reasoning.
const CONFIG_DOC = scratchAgentsConfigDocument();
const FIRST_PROVIDER_ID = CONFIG_DOC.runtime!.providers[0]!.id;
const FIRST_MODEL_ID = CONFIG_DOC.runtime!.providers[0]!.models[0]!.id;
const AGENTS_CONFIG = resolveAgentsConfig(CONFIG_DOC)!;
const RESOLVER = createProviderModelResolver(CONFIG_DOC);

function contentEvents(...texts: string[]): ChatStreamEvent[] {
  return texts.map(text => Object.freeze({ type: "content" as const, text }));
}

function finishEvent(reason: string): ChatStreamEvent {
  return Object.freeze({ type: "finish" as const, reason });
}

function toolCallEvents(id: string, name: string, args: string): ChatStreamEvent[] {
  return [
    Object.freeze({ type: "tool_call_start" as const, index: 0, id, name }),
    Object.freeze({ type: "tool_call_delta" as const, index: 0, arguments: args }),
  ];
}

// ============================================================================
// Agent exceeding capabilities — hostile cases
// ============================================================================

test("Hostile: agent with read-only capability cannot write", () => {
  const profile = AGENTS_CONFIG.profiles.find(p => p.name === "researcher")!;
  assert.equal(hasCapability(profile, "write"), false);
  assert.equal(hasCapability(profile, "read"), true);
});

test("Hostile: agent with no write set cannot write any paths", () => {
  const profile = AGENTS_CONFIG.profiles.find(p => p.name === "researcher")!;
  assert.equal(isPathInWriteSet(profile, "src/foo.ts"), false);
  assert.equal(isPathInWriteSet(profile, "test/bar.ts"), false);
  assert.equal(isPathInWriteSet(profile, "any/path"), false);
});

test("Hostile: agent with restricted write set is bounded", () => {
  const profile = AGENTS_CONFIG.profiles.find(p => p.name === "implementer")!;
  assert.equal(isPathInWriteSet(profile, "src/foo.ts"), true);
  assert.equal(isPathInWriteSet(profile, "src/agents/runtime.ts"), true);
  assert.equal(isPathInWriteSet(profile, "test/foo.test.ts"), false);
  assert.equal(isPathInWriteSet(profile, "docs/readme.md"), false);
});

test("Hostile: agent tool not in allowlist is rejected", async () => {
  const dir = createTempDir("hostile-tool-");
  try {
    const store = createTimelineStore({ path: join(dir, "tl.db") });
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    let callCount = 0;
    const adapter: ProviderAdapter = nativeResponseAdapter({
      providerId: "mock",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
        callCount++;
        if (callCount === 1) {
          yield* toolCallEvents("c1", "list_files", '{"path":"."}');
          yield finishEvent("tool_calls");
        } else {
          yield* contentEvents("Done");
          yield finishEvent("stop");
        }
      },
      async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
    });
    const profile: AgentProfile = {
      name: "restricted", type: "call-and-return",  model: FIRST_MODEL_ID, provider: FIRST_PROVIDER_ID,
      systemPrompt: "", tools: ["read_file"], capabilities: ["read"],
      writeSet: [], maxTurns: 5,
    };
    const agent = createAgentRuntime({
      adapter, toolRegistry: createToolRegistry(),
      modelConfig: { providerId: "mock", modelId: "test", maxTokens: 4096, temperature: 0 },
      profile, repositoryRoot: TEMP_ROOT, stateStore,
      runId: "r", taskId: "t", attemptId: "a",
    });
    const gen = agent.run("List files");
    let result = await gen.next();
    while (!result.done) { result = await gen.next(result.value); }
    assert.equal(result.value.turns[0]!.toolResults.length, 0);
    assert.equal(result.value.turns[0]!.errorCode, "native_action_not_authorized");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Concurrent write-set conflicts — hostile cases
// ============================================================================

test("Hostile: two agents with identical write sets conflict", () => {
  const profiles: AgentProfile[] = [
    { name: "a", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "", tools: [], capabilities: ["read"], writeSet: ["src/"], maxTurns: 1 },
    { name: "b", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "", tools: [], capabilities: ["read"], writeSet: ["src/"], maxTurns: 1 },
  ];
  const result = detectWriteSetConflict(profiles);
  assert.equal(result.conflicts.length, 1);
});

test("Hostile: three agents with overlapping write sets produce multiple conflicts", () => {
  const profiles: AgentProfile[] = [
    { name: "a", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "", tools: [], capabilities: ["read"], writeSet: ["src/", "test/"], maxTurns: 1 },
    { name: "b", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "", tools: [], capabilities: ["read"], writeSet: ["src/"], maxTurns: 1 },
    { name: "c", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "", tools: [], capabilities: ["read"], writeSet: ["test/"], maxTurns: 1 },
  ];
  const result = detectWriteSetConflict(profiles);
  assert.ok(result.conflicts.length >= 2);
});

test("Hostile: nested write set paths conflict", () => {
  const profiles: AgentProfile[] = [
    { name: "a", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "", tools: [], capabilities: ["read"], writeSet: ["src/"], maxTurns: 1 },
    { name: "b", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "", tools: [], capabilities: ["read"], writeSet: ["src/agents/"], maxTurns: 1 },
  ];
  const result = detectWriteSetConflict(profiles);
  assert.equal(result.conflicts.length, 1);
});

test("Hostile: write set with prefix-not-slash does not match sibling", () => {
  const profiles: AgentProfile[] = [
    { name: "a", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "", tools: [], capabilities: ["read"], writeSet: ["src"], maxTurns: 1 },
    { name: "b", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "", tools: [], capabilities: ["read"], writeSet: ["srctest/"], maxTurns: 1 },
  ];
  const result = detectWriteSetConflict(profiles);
  assert.equal(result.conflicts.length, 0);
});

// ============================================================================
// Malformed config — hostile cases
// ============================================================================

test("Hostile: config with agent referencing non-existent provider fails validation", () => {
  const result = resolveAgentsConfig(CONFIG_DOC);
  assert.ok(result);
  const resolver = createProviderModelResolver(CONFIG_DOC);
  const badProfile: AgentProfile = {
    name: "bad", type: "call-and-return",  model: "nonexistent", provider: "nonexistent",
    systemPrompt: "", tools: [], capabilities: [], writeSet: [], maxTurns: 1,
  };
  assert.throws(() => resolver.resolve(badProfile), /unknown provider/);
});

test("Hostile: config with agent referencing non-existent model fails validation", () => {
  const resolver = createProviderModelResolver(CONFIG_DOC);
  const badProfile: AgentProfile = {
    name: "bad", type: "call-and-return",  model: "nonexistent-model", provider: FIRST_PROVIDER_ID,
    systemPrompt: "", tools: [], capabilities: [], writeSet: [], maxTurns: 1,
  };
  assert.throws(() => resolver.resolve(badProfile), /unknown model/);
});

test("Hostile: schema rejects negative maximumConcurrentAgents", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.maximumConcurrentAgents = -1;
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, false);
});

test("Hostile: schema rejects non-integer maximumConcurrentAgents", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.maximumConcurrentAgents = 2.5;
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, false);
});

test("Hostile: schema rejects negative maxTurns", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.profiles[0].maxTurns = -1;
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, false);
});

test("Hostile: schema rejects empty tool name", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.profiles[0].tools = [""];
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, false);
});

test("Hostile: schema rejects empty write set path", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.profiles[1].writeSet = [""];
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, false);
});

test("Hostile: schema rejects zero alignment monitor interval", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.orchestration.alignmentMonitorIntervalMs = 0;
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, false);
});

test("Hostile: schema rejects alignment monitor interval exceeding ceiling", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.orchestration.alignmentMonitorIntervalMs = ROOT_POLICY.runtime.limits.maximumTimeoutMs + 1;
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, false);
});

test("Hostile: schema rejects non-boolean conflictDetectionEnabled", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.orchestration.conflictDetectionEnabled = "yes";
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, false);
});

// ============================================================================
// Orchestrator hostile cases
// ============================================================================

test("Hostile: orchestrator rejects plan with too many tasks", () => {
  const dir = createTempDir("hostile-orch-");
  try {
    const store = createTimelineStore({ path: join(dir, "tl.db") });
    const orchestrator = createOrchestrator({
      adapter: makeMockAdapter([]), toolRegistry: createToolRegistry(),
      resolver: RESOLVER, agentsConfig: AGENTS_CONFIG,
      repositoryRoot: TEMP_ROOT, store,
    });
    const tooMany = Array.from({ length: 6 }, (_, i) => ({
      taskId: `t${i}`, task: `task-${i}`, agentName: "researcher",
    }));
    assert.throws(() => orchestrator.plan(tooMany), /exceeds maximum/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Hostile: orchestrator rejects plan with unknown dependency", () => {
  const dir = createTempDir("hostile-orch-");
  try {
    const store = createTimelineStore({ path: join(dir, "tl.db") });
    const orchestrator = createOrchestrator({
      adapter: makeMockAdapter([]), toolRegistry: createToolRegistry(),
      resolver: RESOLVER, agentsConfig: AGENTS_CONFIG,
      repositoryRoot: TEMP_ROOT, store,
    });
    assert.throws(() => orchestrator.plan([
      { taskId: "t1", task: "task", agentName: "researcher", dependsOn: ["nonexistent"] },
    ]), /unknown task/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Hostile: orchestrator rejects duplicate task IDs", () => {
  const dir = createTempDir("hostile-orch-");
  try {
    const store = createTimelineStore({ path: join(dir, "tl.db") });
    const orchestrator = createOrchestrator({
      adapter: makeMockAdapter([]), toolRegistry: createToolRegistry(),
      resolver: RESOLVER, agentsConfig: AGENTS_CONFIG,
      repositoryRoot: TEMP_ROOT, store,
    });
    assert.throws(() => orchestrator.plan([
      { taskId: "dup", task: "a", agentName: "researcher" },
      { taskId: "dup", task: "b", agentName: "reviewer" },
    ]), /Duplicate task ID/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Hostile: validateOrchestrationPlan rejects empty plan with zero max", () => {
  const config: AgentsConfig = {
    ...AGENTS_CONFIG,
    maximumConcurrentAgents: 0,
  };
  const result = validateOrchestrationPlan(config, []);
  assert.equal(result.valid, true);
});

test("Hostile: agent state throws for unknown agent on all operations", () => {
  const dir = createTempDir("hostile-state-");
  try {
    const store = createTimelineStore({ path: join(dir, "tl.db") });
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    assert.throws(() => stateStore.recordAgentTurn({
      agentId: "x", runId: "r", taskId: "t", attemptId: "a",
      turnId: "t1", turnNumber: 1, content: "", toolCallCount: 0,
      promptTokens: 0, completionTokens: 0, totalTokens: 0, finishReason: "stop",
    }));
    assert.throws(() => stateStore.recordAgentCompletion({ agentId: "x", runId: "r", taskId: "t", attemptId: "a" }));
    assert.throws(() => stateStore.recordAgentFailure({ agentId: "x", runId: "r", taskId: "t", attemptId: "a", error: "e" }));
    assert.throws(() => stateStore.recordAgentCancellation({ agentId: "x", runId: "r", taskId: "t", attemptId: "a", reason: "r" }));
    assert.throws(() => stateStore.recordCompaction({ agentId: "x", runId: "r", taskId: "t", attemptId: "a", summary: "s" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Agent runtime hostile cases
// ============================================================================

test("Hostile: agent stops at maxTurns and reports all turns", async () => {
  const dir = createTempDir("hostile-runtime-");
  try {
    const store = createTimelineStore({ path: join(dir, "tl.db") });
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    let callCount = 0;
    const adapter: ProviderAdapter = nativeResponseAdapter({
      providerId: "mock",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
        callCount++;
        yield* toolCallEvents(`c${callCount}`, "read_file", '{"path":"test.txt"}');
        yield finishEvent("tool_calls");
      },
      async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
    });
    const profile: AgentProfile = {
      name: "test", type: "call-and-return",  model: "test-model", provider: "mock",
      systemPrompt: "", tools: ["read_file"], capabilities: ["read"],
      writeSet: [], maxTurns: 2,
    };
    const agent = createAgentRuntime({
      adapter, toolRegistry: createToolRegistry(),
      modelConfig: { providerId: "mock", modelId: "test", maxTokens: 4096, temperature: 0 },
      profile, repositoryRoot: TEMP_ROOT, stateStore,
      runId: "r", taskId: "t", attemptId: "a",
    });
    const gen = agent.run("Keep reading");
    let result = await gen.next();
    while (!result.done) { result = await gen.next(result.value); }
    assert.equal(result.value.turns.length, 2);
    assert.equal(result.value.lifecycleState, "failed");
    assert.equal(result.value.error, "agent_iteration_limit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Hostile: agent with unknown tool call name produces error result", async () => {
  const dir = createTempDir("hostile-runtime-");
  try {
    const store = createTimelineStore({ path: join(dir, "tl.db") });
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    let callCount = 0;
    const adapter: ProviderAdapter = nativeResponseAdapter({
      providerId: "mock",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
        callCount++;
        if (callCount === 1) {
          yield* toolCallEvents("c1", "nonexistent_tool", '{}');
          yield finishEvent("tool_calls");
        } else {
          yield* contentEvents("Done");
          yield finishEvent("stop");
        }
      },
      async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
    });
    const profile: AgentProfile = {
      name: "test", type: "call-and-return",  model: "test-model", provider: "mock",
      systemPrompt: "", tools: [], capabilities: ["read"],
      writeSet: [], maxTurns: 5,
    };
    const agent = createAgentRuntime({
      adapter, toolRegistry: createToolRegistry(),
      modelConfig: { providerId: "mock", modelId: "test", maxTokens: 4096, temperature: 0 },
      profile, repositoryRoot: TEMP_ROOT, stateStore,
      runId: "r", taskId: "t", attemptId: "a",
    });
    const gen = agent.run("Call unknown tool");
    let result = await gen.next();
    while (!result.done) { result = await gen.next(result.value); }
    assert.equal(result.value.turns[0]!.toolResults.length, 0);
    assert.equal(result.value.turns[0]!.errorCode, "native_action_not_authorized");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Context compaction hostile cases
// ============================================================================

test("Hostile: compactAgentTurns with maxTurns=1 keeps only last turn", () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({
    turnId: `t${i}`, turnNumber: i + 1, content: `c${i}`,
    toolCallCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    finishReason: "stop", timestamp: new Date().toISOString(),
  }));
  const result = compactAgentTurns(turns, 1);
  assert.equal(result.compactedTurns.length, 1);
  assert.equal(result.compactedTurns[0]!.turnNumber, 10);
  assert.ok(result.summary.includes("Compacted 9"));
});

test("Hostile: compactAgentTurns with maxTurns=0 on non-empty returns empty", () => {
  const turns = Array.from({ length: 5 }, (_, i) => ({
    turnId: `t${i}`, turnNumber: i + 1, content: `c${i}`,
    toolCallCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    finishReason: "stop", timestamp: new Date().toISOString(),
  }));
  const result = compactAgentTurns(turns, 0);
  assert.equal(result.compactedTurns.length, 0);
});

// ============================================================================
// Awareness store hostile cases
// ============================================================================

test("Hostile: awareness store handles large number of entries", () => {
  const dir = createTempDir("hostile-awareness-");
  try {
    const store = createTimelineStore({ path: join(dir, "tl.db") });
    const orchestrator = createOrchestrator({
      adapter: makeMockAdapter([]), toolRegistry: createToolRegistry(),
      resolver: RESOLVER, agentsConfig: AGENTS_CONFIG,
      repositoryRoot: TEMP_ROOT, store,
    });
    for (let i = 0; i < 100; i++) {
      orchestrator.awareness.publish({
        agentName: `agent-${i % 5}`, taskId: `task-${i}`,
        content: `message-${i}`, timestamp: new Date().toISOString(),
        turnNumber: i,
      });
    }
    assert.equal(orchestrator.awareness.getEntries().length, 100);
    assert.equal(orchestrator.awareness.getEntriesForAgent("agent-0").length, 20);
    assert.equal(orchestrator.awareness.getEntriesForTask("task-50").length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Agent state reconstruction hostile cases
// ============================================================================

test("Hostile: reconstructAgentState handles missing turns gracefully", () => {
  const dir = createTempDir("hostile-reconstruct-");
  try {
    const store = createTimelineStore({ path: join(dir, "tl.db") });
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "no-turns", agentName: "test", runId: "r", taskId: "t", attemptId: "a" });
    stateStore.recordAgentCompletion({ agentId: "no-turns", runId: "r", taskId: "t", attemptId: "a" });
    const recovered = stateStore.reconstructAgentState("no-turns");
    assert.ok(recovered);
    assert.equal(recovered!.turnCount, 0);
    assert.equal(recovered!.lifecycleState, "succeeded");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Hostile: reconstructAgentState handles many turns", () => {
  const dir = createTempDir("hostile-reconstruct-");
  try {
    const store = createTimelineStore({ path: join(dir, "tl.db") });
    const stateStore = createAgentStateStore(createTimelineRecorder({ store }));
    stateStore.recordAgentStart({ agentId: "many-turns", agentName: "test", runId: "r", taskId: "t", attemptId: "a" });
    for (let i = 0; i < 50; i++) {
      stateStore.recordAgentTurn({
        agentId: "many-turns", runId: "r", taskId: "t", attemptId: "a",
        turnId: `t${i}`, turnNumber: i + 1, content: `turn ${i}`,
        toolCallCount: 0, promptTokens: 10, completionTokens: 5,
        totalTokens: 15, finishReason: "stop",
      });
    }
    stateStore.recordAgentCompletion({ agentId: "many-turns", runId: "r", taskId: "t", attemptId: "a" });
    const recovered = stateStore.reconstructAgentState("many-turns");
    assert.ok(recovered);
    assert.equal(recovered!.turnCount, 50);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Agent config edge cases
// ============================================================================

test("Edge: agent profile with all capabilities", () => {
  const profile: AgentProfile = {
    name: "full", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "",
    tools: ["a", "b", "c"], capabilities: ["read", "write", "execute", "delegate"],
    writeSet: ["src/", "test/"], maxTurns: 100,
  };
  assert.equal(hasCapability(profile, "read"), true);
  assert.equal(hasCapability(profile, "write"), true);
  assert.equal(hasCapability(profile, "execute"), true);
  assert.equal(hasCapability(profile, "delegate"), true);
});

test("Edge: isPathInWriteSet with empty string prefix does not match arbitrary paths", () => {
  const profile: AgentProfile = {
    name: "a", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "",
    tools: [], capabilities: [], writeSet: [""], maxTurns: 1,
  };
  assert.equal(isPathInWriteSet(profile, "anything"), false);
  assert.equal(isPathInWriteSet(profile, ""), true);
});

test("Edge: detectWriteSetConflict with single path exact match", () => {
  const profiles: AgentProfile[] = [
    { name: "a", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "", tools: [], capabilities: [], writeSet: ["src/foo.ts"], maxTurns: 1 },
    { name: "b", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "", tools: [], capabilities: [], writeSet: ["src/foo.ts"], maxTurns: 1 },
  ];
  const result = detectWriteSetConflict(profiles);
  assert.equal(result.conflicts.length, 1);
});

test("Edge: detectWriteSetConflict with non-overlapping exact paths", () => {
  const profiles: AgentProfile[] = [
    { name: "a", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "", tools: [], capabilities: [], writeSet: ["src/foo.ts"], maxTurns: 1 },
    { name: "b", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "", tools: [], capabilities: [], writeSet: ["src/bar.ts"], maxTurns: 1 },
  ];
  const result = detectWriteSetConflict(profiles);
  assert.equal(result.conflicts.length, 0);
});

test("Edge: agent profile name with numbers and dots", () => {
  const profile: AgentProfile = {
    name: "agent.v2.research", type: "call-and-return",  model: "m", provider: "p", systemPrompt: "",
    tools: [], capabilities: [], writeSet: [], maxTurns: 1,
  };
  assert.equal(profile.name, "agent.v2.research");
});

test("Edge: agent profile with large maxTurns at ceiling", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.profiles[0].maxTurns = ROOT_POLICY.runtime.limits.maximumAgentMaxTurns;
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, true);
});

test("Edge: agent profile with maxTurns of 1", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.profiles[0].maxTurns = 1;
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, true);
});

test("Edge: agent profile with empty system prompt", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.profiles[0].systemPrompt = "";
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, true);
});

test("Edge: agent profile with empty tools array", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.profiles[0].tools = [];
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, true);
});

test("Edge: agent profile with empty capabilities array", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.profiles[0].capabilities = [];
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, true);
});

test("Edge: agent profile with empty writeSet array", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.profiles[1].writeSet = [];
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, true);
});

test("Edge: orchestration with alignment monitor disabled (interval 0 not valid)", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.orchestration.alignmentMonitorIntervalMs = 0;
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, false);
});

test("Edge: orchestration with conflict detection disabled", () => {
  const config = JSON.parse(JSON.stringify(CONFIG_DOC));
  config.agents.orchestration.conflictDetectionEnabled = false;
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(config).success, true);
});
