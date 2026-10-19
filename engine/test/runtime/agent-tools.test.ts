import assert from "node:assert/strict";
import test from "node:test";

import { createAgentTools } from "../../src/runtime/agent-tools.ts";
import type { AgentsConfig, ProviderModelResolver, RuntimeProviderModel } from "../../src/agents/agent-config.ts";
import type { AgentRunResult, AgentRuntime, AgentRuntimeOptions } from "../../src/agents/agent-runtime.ts";
import type { AgentState, AgentStateStore } from "../../src/agents/agent-state.ts";
import type { MetricsCollector } from "../../src/performance/metrics-collector.ts";
import type { ProviderAdapter } from "../../src/runtime/provider-adapter.ts";
import type { ToolRegistry } from "../../src/runtime/tool-registry.ts";
import type { TimelineRecorder } from "../../src/timeline/timeline-recorder.ts";

// ---------------------------------------------------------------------------
// Agent tools: a mock runtime factory and in-memory state store exercise the
// tool argument handling, profile resolution, and result serialization without
// making real provider calls. The agent runtime itself is covered by
// test/agents/agent-runtime.test.ts.
// ---------------------------------------------------------------------------

const AGENTS_CONFIG: AgentsConfig = {
  maximumConcurrentAgents: 3,
  profiles: [
    {
      name: "researcher", type: "call-and-return", model: "zai-org/GLM-5.2-NVFP4",
      provider: "openrouter", systemPrompt: "research", tools: ["read_file"],
      capabilities: ["read"], writeSet: [], maxTurns: 10,
    },
  ],
  orchestration: { alignmentMonitorIntervalMs: 30000, conflictDetectionEnabled: true },
};

const RESOLVER: ProviderModelResolver = {
  resolve: (profile): RuntimeProviderModel => ({
    providerId: profile.provider, modelId: profile.model, maxTokens: 16384, temperature: 0,
  }),
  providerIds: () => ["openrouter"],
  modelIds: () => ["zai-org/GLM-5.2-NVFP4"],
};

const MOCK_ADAPTER = {} as ProviderAdapter;
const MOCK_REGISTRY = {} as ToolRegistry;
const MOCK_TIMELINE = { store: {} } as unknown as TimelineRecorder;

function makeMockStateStore(): AgentStateStore {
  const states: AgentState[] = [];
  const now = () => new Date().toISOString();
  const base = (agentId: string, name: string, taskId: string): AgentState => ({
    agentId, agentName: name, runId: "run", taskId, attemptId: "att",
    lifecycleState: "running", turnCount: 0, totalPromptTokens: 0, totalCompletionTokens: 0,
    totalTokens: 0, turns: [], createdAt: now(), updatedAt: now(), lastError: null,
    compactionSummary: null, suspensionReason: null,
  });
  function update(agentId: string, patch: Partial<AgentState>): AgentState {
    const idx = states.findIndex((x) => x.agentId === agentId);
    if (idx === -1) return base(agentId, "x", "");
    const next: AgentState = { ...states[idx]!, ...patch, updatedAt: now() };
    states[idx] = next;
    return next;
  }
  return {
    recordAgentStart: (input) => {
      const s = base(input.agentId ?? "a1", input.agentName, input.taskId);
      states.push(s);
      return s;
    },
    recordAgentTurn: (input) => update(input.agentId, { turnCount: (states.find((x) => x.agentId === input.agentId)?.turnCount ?? 0) + 1 }),
    recordAgentCompletion: (input) => update(input.agentId, { lifecycleState: "succeeded" }),
    recordAgentFailure: (input) => update(input.agentId, { lifecycleState: "failed", lastError: input.error }),
    recordAgentCancellation: (input) => update(input.agentId, { lifecycleState: "cancelled", suspensionReason: input.reason }),
    recordAgentSuspension: (input) => update(input.agentId, { lifecycleState: "suspended", suspensionReason: input.reason }),
    recordAgentResumption: (input) => update(input.agentId, { lifecycleState: "running", suspensionReason: null }),
    recordAgentTimeout: (input) => update(input.agentId, { lifecycleState: "timed-out" }),
    recordCompaction: (input) => update(input.agentId, { compactionSummary: input.summary }),
    getAgentState: (id) => states.find((x) => x.agentId === id),
    getAgentStatesByRunId: () => [...states],
    reconstructAgentState: () => undefined,
    allAgentStates: () => [...states],
    getActiveAgents: () => states.filter((x) => x.lifecycleState === "running"),
  };
}

function makeMockRuntimeFactory(result: Partial<AgentRunResult> = {}): typeof import("../../src/agents/agent-runtime.ts").createAgentRuntime {
  const runResult: AgentRunResult = {
    agentId: "mock-agent", agentName: "researcher", turns: [],
    totalPromptTokens: 5, totalCompletionTokens: 3, totalTokens: 8,
    finishReason: "stop", lifecycleState: "succeeded", error: null,
    ...result,
  };
  return (options): AgentRuntime => {
    // Simulate the real runtime's lifecycle recording so the state store is
    // populated (the real createAgentRuntime records in its constructor).
    const agentId = "mock-agent";
    try {
      options.stateStore.recordAgentStart({
        agentId, agentName: options.profile.name, runId: options.runId, taskId: options.taskId, attemptId: options.attemptId,
      });
      options.stateStore.recordAgentCompletion({ agentId, runId: options.runId, taskId: options.taskId, attemptId: options.attemptId });
    } catch {
      // mock store may be partial; ignore
    }
    return {
      agentId,
      agentName: options.profile.name,
      messages: () => [],
      state: () => ({ lifecycleState: "succeeded", turnCount: 1, totalTokens: 8 }),
      run: async function* () {
        return runResult;
      },
    };
  };
}

test("agent-tools: registers exactly three tools", () => {
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    runtimeFactory: makeMockRuntimeFactory(),
    stateStore: makeMockStateStore(),
  });
  const names = tools.map((t) => t.definition.function.name);
  assert.deepEqual(names.toSorted(), ["delegate_to_agent", "get_agent_state", "list_agents"]);
});

test("agent-tools: list_agents returns configured profiles", () => {
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    runtimeFactory: makeMockRuntimeFactory(),
    stateStore: makeMockStateStore(),
  });
  const tool = tools.find((t) => t.definition.function.name === "list_agents")!;
  const result = JSON.parse(tool.handler({}, { repositoryRoot: "/repo" })) as {
    maximumConcurrentAgents: number;
    profiles: ReadonlyArray<{ name: string; type: string }>;
  };
  assert.equal(result.maximumConcurrentAgents, 3);
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0]!.name, "researcher");
  assert.equal(result.profiles[0]!.type, "call-and-return");
});

test("agent-tools: delegate_to_agent returns the agent run result", async () => {
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    runtimeFactory: makeMockRuntimeFactory(),
    stateStore: makeMockStateStore(),
  });
  const tool = tools.find((t) => t.definition.function.name === "delegate_to_agent")!;
  assert.ok(tool.asyncHandler, "delegate_to_agent must have an async handler");
  const result = JSON.parse(await tool.asyncHandler!({ agentName: "researcher", task: "read files" }, { repositoryRoot: "/repo" })) as {
    agentName: string; lifecycleState: string; turns: number; totalTokens: number;
  };
  assert.equal(result.agentName, "researcher");
  assert.equal(result.lifecycleState, "succeeded");
  assert.equal(result.turns, 0);
  assert.equal(result.totalTokens, 8);
});

test("agent-tools: delegate_to_agent rejects an unknown agent name", async () => {
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    runtimeFactory: makeMockRuntimeFactory(),
    stateStore: makeMockStateStore(),
  });
  const tool = tools.find((t) => t.definition.function.name === "delegate_to_agent")!;
  await assert.rejects(
    () => tool.asyncHandler!({ agentName: "no-such-agent", task: "x" }, { repositoryRoot: "/repo" }),
    /Agent profile/,
  );
});

test("agent-tools: delegate_to_agent requires agentName and task", async () => {
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    runtimeFactory: makeMockRuntimeFactory(),
    stateStore: makeMockStateStore(),
  });
  const tool = tools.find((t) => t.definition.function.name === "delegate_to_agent")!;
  await assert.rejects(() => tool.asyncHandler!({ agentName: "researcher" }, { repositoryRoot: "/repo" }), /task must be/);
});

test("agent-tools: delegate_to_agent sync handler throws async-only", () => {
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    runtimeFactory: makeMockRuntimeFactory(),
    stateStore: makeMockStateStore(),
  });
  const tool = tools.find((t) => t.definition.function.name === "delegate_to_agent")!;
  assert.throws(() => tool.handler({}, { repositoryRoot: "/repo" }), /async-only/);
});

test("agent-tools: get_agent_state returns agents from the session store", async () => {
  const stateStore = makeMockStateStore();
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    runtimeFactory: makeMockRuntimeFactory(),
    stateStore,
  });
  // Run a delegate first so the store has an agent.
  const delegate = tools.find((t) => t.definition.function.name === "delegate_to_agent")!;
  await delegate.asyncHandler!({ agentName: "researcher", task: "do something" }, { repositoryRoot: "/repo" });
  const stateTool = tools.find((t) => t.definition.function.name === "get_agent_state")!;
  const result = JSON.parse(stateTool.handler({}, { repositoryRoot: "/repo" })) as {
    agents: ReadonlyArray<{ agentName: string; lifecycleState: string }>; total: number;
  };
  assert.ok(result.total >= 1, "expected at least one agent in the state store");
  assert.ok(result.agents.some((a) => a.agentName === "researcher"), "researcher must appear in agent states");
});

// ---------------------------------------------------------------------------
// MINOR-9: agent run failure and mid-turn cancellation
// ---------------------------------------------------------------------------

test("agent-tools: delegate_to_agent returns a failed result with non-null error", async () => {
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    runtimeFactory: makeMockRuntimeFactory({ lifecycleState: "failed", error: "provider error during turn" }),
    stateStore: makeMockStateStore(),
  });
  const tool = tools.find((t) => t.definition.function.name === "delegate_to_agent")!;
  const result = JSON.parse(await tool.asyncHandler!({ agentName: "researcher", task: "fail" }, { repositoryRoot: "/repo" })) as {
    lifecycleState: string; error: string | null;
  };
  assert.equal(result.lifecycleState, "failed");
  assert.ok(result.error !== null && result.error.length > 0, "error must be non-null and non-empty");
  assert.match(result.error!, /provider error/);
});

test("agent-tools: mid-turn cancellation yields lifecycleState cancelled and finalizes the generator", async () => {
  let generatorFinalized = false;
  // A runtime whose generator never completes on its own; the delegate handler
  // must finalize it via generator.return so its finally block runs promptly
  // (MINOR-5). The finally sets generatorFinalized=true.
  const cancellingFactory: typeof import("../../src/agents/agent-runtime.ts").createAgentRuntime = (options): AgentRuntime => {
    const agentId = "cancelling-agent";
    try {
      options.stateStore.recordAgentStart({
        agentId, agentName: options.profile.name, runId: options.runId, taskId: options.taskId, attemptId: options.attemptId,
      });
    } catch { /* mock store may be partial */ }
    return {
      agentId,
      agentName: options.profile.name,
      messages: () => [],
      state: () => ({ lifecycleState: "running", turnCount: 0, totalTokens: 0 }),
      run: async function* () {
        try {
          while (true) {
            yield { type: "turn_start", turnNumber: 1 };
            yield { type: "content", text: "partial" };
          }
        } finally {
          generatorFinalized = true;
        }
      },
    };
  };
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    runtimeFactory: cancellingFactory,
    stateStore: makeMockStateStore(),
  });
  const tool = tools.find((t) => t.definition.function.name === "delegate_to_agent")!;
  const controller = new AbortController();
  controller.abort();
  const result = JSON.parse(await tool.asyncHandler!({ agentName: "researcher", task: "long" }, { repositoryRoot: "/repo" }, controller.signal)) as {
    lifecycleState: string;
  };
  assert.equal(result.lifecycleState, "cancelled", "mid-turn cancellation must report lifecycleState cancelled");
  assert.ok(generatorFinalized, "the generator must be finalized (its finally block ran) so the turn timeout is cleared promptly");
});

test("agent-tools: timeoutMs reaches the agent runtime from createAgentTools options (FIX 2)", async () => {
  let capturedOptions: AgentRuntimeOptions | undefined;
  const capturingFactory: typeof import("../../src/agents/agent-runtime.ts").createAgentRuntime = (options): AgentRuntime => {
    capturedOptions = options;
    return makeMockRuntimeFactory()(options);
  };
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    timeoutMs: 42_000,
    runtimeFactory: capturingFactory,
    stateStore: makeMockStateStore(),
  });
  const tool = tools.find((t) => t.definition.function.name === "delegate_to_agent")!;
  await tool.asyncHandler!({ agentName: "researcher", task: "do work" }, { repositoryRoot: "/repo" });
  assert.ok(capturedOptions, "the runtime factory must have been invoked");
  assert.equal(capturedOptions!.timeoutMs, 42_000, "timeoutMs must be forwarded to the agent runtime");
});

test("agent-tools: timeoutMs is omitted when not provided (FIX 2)", async () => {
  let capturedOptions: AgentRuntimeOptions | undefined;
  const capturingFactory: typeof import("../../src/agents/agent-runtime.ts").createAgentRuntime = (options): AgentRuntime => {
    capturedOptions = options;
    return makeMockRuntimeFactory()(options);
  };
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    runtimeFactory: capturingFactory,
    stateStore: makeMockStateStore(),
  });
  const tool = tools.find((t) => t.definition.function.name === "delegate_to_agent")!;
  await tool.asyncHandler!({ agentName: "researcher", task: "do work" }, { repositoryRoot: "/repo" });
  assert.ok(capturedOptions, "the runtime factory must have been invoked");
  assert.equal(capturedOptions!.timeoutMs, undefined, "timeoutMs must be absent when not configured");
});

// ---------------------------------------------------------------------------
// A-1: delegation returns the agent's actual final answer
// ---------------------------------------------------------------------------

test("agent-tools: delegate_to_agent includes the agent's final answer (A-1)", async () => {
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    runtimeFactory: makeMockRuntimeFactory({
      turns: [
        { content: "intermediate reasoning", toolCalls: [], toolResults: [], finishReason: "tool_calls", usage: undefined, iterations: 0 },
        { content: "The answer is 42", toolCalls: [], toolResults: [], finishReason: "stop", usage: undefined, iterations: 0 },
      ],
    }),
    stateStore: makeMockStateStore(),
  });
  const tool = tools.find((t) => t.definition.function.name === "delegate_to_agent")!;
  const result = JSON.parse(await tool.asyncHandler!({ agentName: "researcher", task: "read files" }, { repositoryRoot: "/repo" })) as {
    output: string; outputTruncated: boolean;
  };
  assert.equal(result.output, "The answer is 42", "the final turn's content must be returned");
  assert.equal(result.outputTruncated, false);
});

test("agent-tools: delegate_to_agent truncates an oversized final answer with a marker (A-1)", async () => {
  const longContent = "x".repeat(3_000);
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    runtimeFactory: makeMockRuntimeFactory({
      turns: [{ content: longContent, toolCalls: [], toolResults: [], finishReason: "stop", usage: undefined, iterations: 0 }],
    }),
    stateStore: makeMockStateStore(),
  });
  const tool = tools.find((t) => t.definition.function.name === "delegate_to_agent")!;
  const result = JSON.parse(await tool.asyncHandler!({ agentName: "researcher", task: "read files" }, { repositoryRoot: "/repo" })) as {
    output: string; outputTruncated: boolean;
  };
  assert.equal(result.outputTruncated, true);
  assert.ok(result.output.length < longContent.length, "the returned output must be bounded");
  assert.match(result.output, /truncated/);
  assert.ok(result.output.startsWith("x".repeat(100)), "the truncated prefix of the real answer must be preserved");
});

test("agent-tools: delegate_to_agent returns empty output when no turn produced content (A-1)", async () => {
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    runtimeFactory: makeMockRuntimeFactory(),
    stateStore: makeMockStateStore(),
  });
  const tool = tools.find((t) => t.definition.function.name === "delegate_to_agent")!;
  const result = JSON.parse(await tool.asyncHandler!({ agentName: "researcher", task: "read files" }, { repositoryRoot: "/repo" })) as {
    output: string; outputTruncated: boolean;
  };
  assert.equal(result.output, "");
  assert.equal(result.outputTruncated, false);
});

test("agent-tools: delegate_to_agent output comes from the LAST non-empty turn, not an earlier one (A-1)", async () => {
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    runtimeFactory: makeMockRuntimeFactory({
      turns: [
        { content: "first draft", toolCalls: [], toolResults: [], finishReason: "tool_calls", usage: undefined, iterations: 0 },
        { content: "", toolCalls: [], toolResults: [], finishReason: "tool_calls", usage: undefined, iterations: 0 },
        { content: "final answer", toolCalls: [], toolResults: [], finishReason: "stop", usage: undefined, iterations: 0 },
      ],
    }),
    stateStore: makeMockStateStore(),
  });
  const tool = tools.find((t) => t.definition.function.name === "delegate_to_agent")!;
  const result = JSON.parse(await tool.asyncHandler!({ agentName: "researcher", task: "read files" }, { repositoryRoot: "/repo" })) as {
    output: string;
  };
  assert.equal(result.output, "final answer");
});

test("agent-tools: metricsCollector reaches the agent runtime (FIX 3)", async () => {
  let capturedOptions: AgentRuntimeOptions | undefined;
  const capturingFactory: typeof import("../../src/agents/agent-runtime.ts").createAgentRuntime = (options): AgentRuntime => {
    capturedOptions = options;
    return makeMockRuntimeFactory()(options);
  };
  const mockMetrics = {
    recordCallStart: () => () => undefined,
    recordCall: () => undefined,
    recordError: () => undefined,
    recordCancellation: () => undefined,
    flush: () => undefined,
    sampledTraces: () => [],
    entryCount: () => 0,
    reset: () => undefined,
    close: () => undefined,
    snapshot: () => ({} as never),
  } as unknown as MetricsCollector;
  const tools = createAgentTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: RESOLVER,
    timeline: MOCK_TIMELINE,
    runId: "run",
    metricsCollector: mockMetrics,
    runtimeFactory: capturingFactory,
    stateStore: makeMockStateStore(),
  });
  const tool = tools.find((t) => t.definition.function.name === "delegate_to_agent")!;
  await tool.asyncHandler!({ agentName: "researcher", task: "do work" }, { repositoryRoot: "/repo" });
  assert.ok(capturedOptions, "the runtime factory must have been invoked");
  assert.equal(capturedOptions!.metricsCollector, mockMetrics, "metricsCollector must be forwarded to the agent runtime");
});
