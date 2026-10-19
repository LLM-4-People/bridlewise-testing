import assert from "node:assert/strict";
import test from "node:test";

import { createOrchestratorTools } from "../../src/runtime/orchestrator-tools.ts";
import { InputError } from "../../src/kernel/errors.ts";
import type { AgentsConfig, ProviderModelResolver } from "../../src/agents/agent-config.ts";
import type { Orchestrator, OrchestrationPlan, OrchestrationResult, OrchestrationEvent } from "../../src/agents/orchestrator.ts";
import type { ProviderAdapter } from "../../src/runtime/provider-adapter.ts";
import type { ToolRegistry } from "../../src/runtime/tool-registry.ts";
import type { TimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import type { EventLedgerStoragePort } from "../../src/timeline/timeline-types.ts";

// ---------------------------------------------------------------------------
// Orchestrator tools: a mock orchestrator factory exercises the tool argument
// handling, plan/execute flow, and result serialization without making real
// provider calls. The orchestrator itself is covered by
// test/agents/orchestrator.test.ts.
// ---------------------------------------------------------------------------

const AGENTS_CONFIG: AgentsConfig = {
  maximumConcurrentAgents: 3,
  profiles: [
    {
      name: "researcher", type: "call-and-return", model: "zai-org/GLM-5.2-NVFP4",
      provider: "openrouter", systemPrompt: "research", tools: ["read_file"],
      capabilities: ["read"], writeSet: [], maxTurns: 10,
    },
    {
      name: "writer", type: "call-and-return", model: "zai-org/GLM-5.2-NVFP4",
      provider: "openrouter", systemPrompt: "write", tools: ["read_file"],
      capabilities: ["read"], writeSet: [], maxTurns: 10,
    },
  ],
  orchestration: { alignmentMonitorIntervalMs: 30000, conflictDetectionEnabled: true },
};

const MOCK_ADAPTER = {} as ProviderAdapter;
const MOCK_REGISTRY = {} as ToolRegistry;
const MOCK_TIMELINE = {} as TimelineRecorder;
const MOCK_STORE = { ledgerId: "test" } as EventLedgerStoragePort;

function makeMockOrchestratorFactory(resultOverride: Partial<OrchestrationResult> = {}): typeof import("../../src/agents/orchestrator.ts").createOrchestrator {
  const runResult: OrchestrationResult = {
    runId: "orch-mock",
    agentResults: [],
    totalTurns: 2,
    totalTokens: 50,
    allSucceeded: true,
    conflicts: [],
    ...resultOverride,
  };
  return (): Orchestrator => {
    return Object.freeze({
      runId: runResult.runId,
      awareness: Object.freeze({
        publish: () => {},
        getEntries: () => [],
        getEntriesForAgent: () => [],
        getEntriesForTask: () => [],
        snapshot: () => Object.freeze({ entries: [] }),
      }),
      stateStore: Object.freeze({
        recordAgentStart: () => ({} as never),
        recordAgentTurn: () => ({} as never),
        recordAgentCompletion: () => ({} as never),
        recordAgentFailure: () => ({} as never),
        recordAgentCancellation: () => ({} as never),
        recordAgentSuspension: () => ({} as never),
        recordAgentResumption: () => ({} as never),
        recordAgentTimeout: () => ({} as never),
        recordCompaction: () => ({} as never),
        getAgentState: () => undefined,
        getAgentStatesByRunId: () => [],
        reconstructAgentState: () => undefined,
        allAgentStates: () => [],
        getActiveAgents: () => [],
      } as never),
      agentTypeRegistry: Object.freeze({ resolve: () => ({} as never), register: () => {} } as never),
      backgroundHandles: new Map(),
      plan: (tasks): OrchestrationPlan => Object.freeze({
        runId: runResult.runId,
        tasks: tasks.map((t, i) => Object.freeze({
          taskId: t.taskId ?? `task-${i}`,
          task: t.task,
          agentName: t.agentName,
          dependsOn: Object.freeze([...(t.dependsOn ?? [])]),
        })),
      }),
      execute: async function* (): AsyncGenerator<OrchestrationEvent, OrchestrationResult, unknown> {
        yield Object.freeze({ type: "orchestration_complete", result: runResult });
        return runResult;
      },
      detectConflicts: () => Object.freeze({ conflicts: [] }),
      getAgentStates: () => [],
    });
  };
}

test("orchestrator-tools: registers exactly one tool", () => {
  const tools = createOrchestratorTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: {} as ProviderModelResolver,
    store: MOCK_STORE,
    timeline: MOCK_TIMELINE,
    orchestratorFactory: makeMockOrchestratorFactory(),
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.definition.function.name, "delegate_to_orchestrator");
});

test("orchestrator-tools: sync handler throws async-only", () => {
  const tools = createOrchestratorTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: {} as ProviderModelResolver,
    store: MOCK_STORE,
    timeline: MOCK_TIMELINE,
    orchestratorFactory: makeMockOrchestratorFactory(),
  });
  assert.throws(() => tools[0]!.handler({}, { repositoryRoot: "/repo" }), /async-only/);
});

test("orchestrator-tools: delegate_to_orchestrator runs the plan and returns a summary", async () => {
  const tools = createOrchestratorTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: {} as ProviderModelResolver,
    store: MOCK_STORE,
    timeline: MOCK_TIMELINE,
    orchestratorFactory: makeMockOrchestratorFactory({
      totalTurns: 3,
      totalTokens: 100,
      allSucceeded: true,
    }),
  });
  const result = JSON.parse(await tools[0]!.asyncHandler!({
    tasks: [
      { agentName: "researcher", task: "find sources" },
      { agentName: "writer", task: "write summary", dependsOn: ["task-0"] },
    ],
  }, { repositoryRoot: "/repo" })) as {
    orchestrationId: string;
    allSucceeded: boolean;
    agentCount: number;
    totalTurns: number;
    totalTokens: number;
  };
  assert.equal(result.orchestrationId, "orch-mock");
  assert.equal(result.allSucceeded, true);
  assert.equal(result.totalTurns, 3);
  assert.equal(result.totalTokens, 100);
});

// ---------------------------------------------------------------------------
// A-1: orchestration results include each agent's actual final answer
// ---------------------------------------------------------------------------

test("orchestrator-tools: per-agent results include the agent's final answer (A-1)", async () => {
  const tools = createOrchestratorTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: {} as ProviderModelResolver,
    store: MOCK_STORE,
    timeline: MOCK_TIMELINE,
    orchestratorFactory: makeMockOrchestratorFactory({
      agentResults: [
        {
          agentId: "a1", agentName: "researcher",
          turns: [{ content: "research findings", toolCalls: [], toolResults: [], finishReason: "stop", usage: undefined, iterations: 0 }],
          totalPromptTokens: 5, totalCompletionTokens: 3, totalTokens: 8,
          finishReason: "stop", lifecycleState: "succeeded", error: null,
        },
        {
          agentId: "a2", agentName: "writer",
          turns: [{ content: "written summary", toolCalls: [], toolResults: [], finishReason: "stop", usage: undefined, iterations: 0 }],
          totalPromptTokens: 6, totalCompletionTokens: 4, totalTokens: 10,
          finishReason: "stop", lifecycleState: "succeeded", error: null,
        },
      ],
    }),
  });
  const result = JSON.parse(await tools[0]!.asyncHandler!({
    tasks: [
      { agentName: "researcher", task: "find sources" },
      { agentName: "writer", task: "write summary" },
    ],
  }, { repositoryRoot: "/repo" })) as {
    agentResults: ReadonlyArray<{ agentName: string; output: string; outputTruncated: boolean }>;
  };
  assert.equal(result.agentResults.length, 2);
  assert.equal(result.agentResults[0]!.output, "research findings");
  assert.equal(result.agentResults[0]!.outputTruncated, false);
  assert.equal(result.agentResults[1]!.output, "written summary");
});

test("orchestrator-tools: oversized per-agent answers are truncated with a marker (A-1)", async () => {
  const tools = createOrchestratorTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: {} as ProviderModelResolver,
    store: MOCK_STORE,
    timeline: MOCK_TIMELINE,
    orchestratorFactory: makeMockOrchestratorFactory({
      agentResults: [
        {
          agentId: "a1", agentName: "researcher",
          turns: [{ content: "y".repeat(5_000), toolCalls: [], toolResults: [], finishReason: "stop", usage: undefined, iterations: 0 }],
          totalPromptTokens: 5, totalCompletionTokens: 3, totalTokens: 8,
          finishReason: "stop", lifecycleState: "succeeded", error: null,
        },
      ],
    }),
  });
  const result = JSON.parse(await tools[0]!.asyncHandler!({
    tasks: [{ agentName: "researcher", task: "find sources" }],
  }, { repositoryRoot: "/repo" })) as {
    agentResults: ReadonlyArray<{ output: string; outputTruncated: boolean }>;
  };
  assert.equal(result.agentResults[0]!.outputTruncated, true);
  assert.ok(result.agentResults[0]!.output.length < 5_000);
  assert.match(result.agentResults[0]!.output, /truncated/);
});

test("orchestrator-tools: empty tasks returns cancelled with no plan", async () => {
  const tools = createOrchestratorTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: {} as ProviderModelResolver,
    store: MOCK_STORE,
    timeline: MOCK_TIMELINE,
    orchestratorFactory: makeMockOrchestratorFactory(),
  });
  const result = JSON.parse(await tools[0]!.asyncHandler!({
    tasks: [],
  }, { repositoryRoot: "/repo" })) as {
    orchestrationId: string | null;
    lifecycleState: string;
    message: string;
  };
  assert.equal(result.orchestrationId, null);
  assert.equal(result.lifecycleState, "cancelled");
  assert.ok(result.message.includes("No tasks"));
});

test("orchestrator-tools: plan failure returns failed lifecycleState", async () => {
  const failingFactory: typeof import("../../src/agents/orchestrator.ts").createOrchestrator = () => {
    return Object.freeze({
      runId: "orch-fail",
      awareness: Object.freeze({
        publish: () => {}, getEntries: () => [], getEntriesForAgent: () => [],
        getEntriesForTask: () => [], snapshot: () => Object.freeze({ entries: [] }),
      }),
      stateStore: Object.freeze({
        recordAgentStart: () => ({} as never), recordAgentTurn: () => ({} as never),
        recordAgentCompletion: () => ({} as never), recordAgentFailure: () => ({} as never),
        recordAgentCancellation: () => ({} as never), recordAgentSuspension: () => ({} as never),
        recordAgentResumption: () => ({} as never), recordAgentTimeout: () => ({} as never),
        recordCompaction: () => ({} as never), getAgentState: () => undefined,
        getAgentStatesByRunId: () => [], reconstructAgentState: () => undefined,
        allAgentStates: () => [], getActiveAgents: () => [],
      } as never),
      agentTypeRegistry: Object.freeze({ resolve: () => ({} as never), register: () => {} } as never),
      backgroundHandles: new Map(),
      plan: () => { throw new Error("plan boom"); },
      execute: async function* () { return {} as OrchestrationResult; },
      detectConflicts: () => Object.freeze({ conflicts: [] }),
      getAgentStates: () => [],
    });
  };
  const tools = createOrchestratorTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: {} as ProviderModelResolver,
    store: MOCK_STORE,
    timeline: MOCK_TIMELINE,
    orchestratorFactory: failingFactory,
  });
  const result = JSON.parse(await tools[0]!.asyncHandler!({
    tasks: [{ agentName: "researcher", task: "fail the plan" }],
  }, { repositoryRoot: "/repo" })) as {
    orchestrationId: string;
    lifecycleState: string;
    message: string;
  };
  assert.equal(result.orchestrationId, "orch-fail");
  assert.equal(result.lifecycleState, "failed");
  assert.ok(result.message.includes("plan boom"));
});

test("orchestrator-tools: rejects malformed tasks (not an array)", async () => {
  const tools = createOrchestratorTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: {} as ProviderModelResolver,
    store: MOCK_STORE,
    timeline: MOCK_TIMELINE,
    orchestratorFactory: makeMockOrchestratorFactory(),
  });
  await assert.rejects(
    () => tools[0]!.asyncHandler!({ tasks: "not-an-array" }, { repositoryRoot: "/repo" }),
    (err: unknown) => err instanceof InputError
      && err.code === "orchestrator_tasks_not_array"
      && /tasks must be an array/.test(err.message),
  );
});

test("orchestrator-tools: rejects a task missing agentName", async () => {
  const tools = createOrchestratorTools({
    repositoryRoot: "/repo",
    agentsConfig: AGENTS_CONFIG,
    adapter: MOCK_ADAPTER,
    toolRegistry: MOCK_REGISTRY,
    resolver: {} as ProviderModelResolver,
    store: MOCK_STORE,
    timeline: MOCK_TIMELINE,
    orchestratorFactory: makeMockOrchestratorFactory(),
  });
  await assert.rejects(
    () => tools[0]!.asyncHandler!({ tasks: [{ task: "no agent" }] }, { repositoryRoot: "/repo" }),
    (err: unknown) => err instanceof InputError
      && err.code === "orchestrator_task_missing_agent_name"
      && /agentName/.test(err.message),
  );
});
