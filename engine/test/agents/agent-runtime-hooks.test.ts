import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createAgentRuntime, type AgentRunResult } from "../../src/agents/agent-runtime.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import type { AgentStateStore, AgentState } from "../../src/agents/agent-state.ts";
import type { AgentProfile } from "../../src/agents/agent-config.ts";
import type { ChatStreamEvent, ProviderAdapter } from "../../src/runtime/provider-adapter.ts";
import { makeNativeMockAdapter as makeMockAdapter } from "../support/mock-provider.ts";
import { mkOwnedTempDir, createTempDir } from "../support/temp-dir.ts";

/**
 * INVARIANT #64: agent lifecycle hooks (onStart, onTurn, onComplete,
 * onFailure, etc.) must be invoked during an agent run, and a throwing hook
 * must NOT crash the agent (hooks are observers).
 */

const TEMP_ROOT = mkOwnedTempDir("agent-hooks-");
writeFileSync(join(TEMP_ROOT, "test.txt"), "content");

const content = (text: string): ChatStreamEvent => Object.freeze({ type: "content" as const, text });
const finish = (reason: string): ChatStreamEvent => Object.freeze({ type: "finish" as const, reason });

const PROFILE: AgentProfile = Object.freeze({
  name: "test-agent",
  type: "call-and-return",
  provider: "mock",
  model: "test-model",
  systemPrompt: "You are a test agent.",
  maxTurns: 3,
  tools: Object.freeze([]),
  capabilities: Object.freeze([]),
  writeSet: Object.freeze([]),
});

const MODEL_CONFIG = Object.freeze({
  providerId: "mock",
  modelId: "test-model",
  maxTokens: 4096,
  temperature: 0,
});

/**
 * Minimal in-memory AgentStateStore stub for agent-runtime tests. The real
 * store persists to the timeline; this stub just tracks state in a Map so
 * createAgentRuntime can call recordAgentStart/recordAgentTurn/etc.
 */
function mockStateStore(): AgentStateStore {
  const states = new Map<string, AgentState>();
  function makeState(agentId: string, lifecycleState: AgentState["lifecycleState"]): AgentState {
    return Object.freeze({
      agentId,
      agentName: "test-agent",
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      lifecycleState,
      turnCount: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      turns: Object.freeze([]),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: null,
      compactionSummary: null,
      suspensionReason: null,
    });
  }
  function update(agentId: string, lifecycleState: AgentState["lifecycleState"], error: string | null = null): AgentState {
    const prev = states.get(agentId);
    const next = Object.freeze({ ...makeState(agentId, lifecycleState), ...(prev ? { createdAt: prev.createdAt } : {}), ...(error !== null ? { lastError: error } : {}) });
    states.set(agentId, next);
    return next;
  }
  return Object.freeze({
    recordAgentStart: (input: { agentId?: string; agentName: string; runId: string; taskId: string; attemptId: string }) => {
      const id = input.agentId ?? "agent-1";
      const s = makeState(id, "running");
      states.set(id, s);
      return s;
    },
    recordAgentTurn: () => update("agent-1", "running"),
    recordAgentCompletion: () => update("agent-1", "succeeded"),
    recordAgentFailure: (input: { agentId: string; error: string }) => update(input.agentId, "failed", input.error),
    recordAgentCancellation: (input: { agentId: string; reason: string }) => update(input.agentId, "cancelled", input.reason),
    recordAgentSuspension: (input: { agentId: string; reason: string }) => update(input.agentId, "suspended", input.reason),
    recordAgentResumption: (input: { agentId: string }) => update(input.agentId, "running"),
    recordAgentTimeout: (input: { agentId: string }) => update(input.agentId, "timed-out", "timeout"),
    recordCompaction: (input: { agentId: string; summary: string }) => update(input.agentId, "running"),
    getAgentState: (id: string) => states.get(id),
    getAgentStatesByRunId: () => Object.freeze([...states.values()]),
    reconstructAgentState: () => undefined,
    allAgentStates: () => Object.freeze([...states.values()]),
    getActiveAgents: () => Object.freeze([]),
  }) as AgentStateStore;
}

function setupRecorder() {
  const dir = createTempDir("agent-hooks-store-");
  const store = createTimelineStore({ path: join(dir, "timeline.db") });
  const recorder = createTimelineRecorder({ store });
  return { store, recorder, dir };
}

async function runAgent(
  hooks: Readonly<Record<string, (...args: never[]) => unknown>>,
  adapter?: ProviderAdapter,
): Promise<AgentRunResult> {
  const { store, dir } = setupRecorder();
  try {
    const runtime = createAgentRuntime({
      adapter: adapter ?? makeMockAdapter([content("Done"), finish("stop")]),
      toolRegistry: createToolRegistry(),
      modelConfig: MODEL_CONFIG,
      profile: PROFILE,
      repositoryRoot: TEMP_ROOT,
      stateStore: mockStateStore(),
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      hooks: hooks as never,
    });
    const gen = runtime.run("Do the task");
    let res = await gen.next();
    while (!res.done) { res = await gen.next(res.value); }
    return res.value;
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("AgentRuntime hooks: onStart, onTurn, onComplete are invoked on a successful run", async () => {
  const calls: string[] = [];
  const result = await runAgent({
    onStart: () => { calls.push("onStart"); },
    onTurn: () => { calls.push("onTurn"); },
    onComplete: () => { calls.push("onComplete"); },
  });
  assert.ok(calls.includes("onStart"), "onStart must be called");
  assert.ok(calls.includes("onTurn"), "onTurn must be called");
  assert.ok(calls.includes("onComplete"), "onComplete must be called");
  assert.equal(result.lifecycleState, "succeeded", "the agent must succeed");
});

test("AgentRuntime hooks: onFailure is invoked when the provider errors", async () => {
  const calls: string[] = [];
  const errorAdapter: ProviderAdapter = Object.freeze({
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      throw new Error("provider down");
    },
    async chatCompletion() { return Object.freeze({ content: "", toolCalls: [], usage: undefined, finishReason: "stop" }); },
  });
  const result = await runAgent({
    onStart: () => { calls.push("onStart"); },
    onFailure: (_ctx: unknown, error: string) => { calls.push(`onFailure:${error}`); },
  }, errorAdapter);
  assert.ok(calls.includes("onStart"), "onStart must be called even on failure");
  assert.ok(calls.some((c) => c.startsWith("onFailure:")), "onFailure must be called when the provider errors");
  assert.equal(result.lifecycleState, "failed", "the agent must report failure");
});

test("AgentRuntime hooks: a throwing hook does not crash the agent", async () => {
  const calls: string[] = [];
  const result = await runAgent({
    onStart: () => { calls.push("onStart"); throw new Error("hook boom"); },
    onTurn: () => { calls.push("onTurn"); throw new Error("hook boom"); },
    onComplete: () => { calls.push("onComplete"); throw new Error("hook boom"); },
  });
  assert.ok(calls.includes("onStart"), "onStart must be called");
  assert.ok(calls.includes("onTurn"), "onTurn must be called despite onStart throwing");
  assert.ok(calls.includes("onComplete"), "onComplete must be called despite earlier hooks throwing");
  assert.equal(result.lifecycleState, "succeeded", "the agent must succeed despite hook failures");
});

test("AgentRuntime hooks: hooks receive the hook context with agent identity", async () => {
  let capturedContext: { agentId?: string; agentName?: string; runId?: string } | undefined;
  await runAgent({
    onStart: (ctx: unknown) => {
      const c = ctx as { agentId: string; agentName: string; runId: string };
      capturedContext = { agentId: c.agentId, agentName: c.agentName, runId: c.runId };
    },
  });
  assert.ok(capturedContext, "onStart must receive a context object");
  assert.ok(capturedContext!.agentName === "test-agent", "context must carry the agent name");
  assert.ok(capturedContext!.runId === "run-1", "context must carry the run id");
});
