import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import { createOrchestrator, type OrchestrationEvent, type OrchestrationResult } from "../../src/agents/orchestrator.ts";
import { createAgentTypeRegistry, type AgentTypeDefinition } from "../../src/agents/agent-type-registry.ts";
import type { AgentProfile, AgentsConfig, ProviderModelResolver } from "../../src/agents/agent-config.ts";
import type { BackgroundAgentHandle, BackgroundAgentRuntime } from "../../src/agents/agent-type-background.ts";
import type { AgentRunResult, AgentRuntime, AgentRuntimeOptions } from "../../src/agents/agent-runtime.ts";
import type { ChatStreamEvent } from "../../src/runtime/provider-adapter.ts";
import { makeNativeMockAdapter as makeMockAdapter } from "../support/mock-provider.ts";
import { mkOwnedTempDir, createTempDir } from "../support/temp-dir.ts";

/**
 * INVARIANT #54 (RES-8): the orchestrator's background alignment monitor
 * must emit `alignment_check` events with `driftDetected: true` when a running
 * agent exceeds the drift threshold. The monitor runs on a configurable
 * interval and pushes events to a queue drained by the execute loop.
 *
 * This test uses a custom background agent type whose handle stays "running"
 * under the caller's control, an injectable clock that reports a time far in
 * the future (so nowMs - createdAt exceeds the drift threshold), and a short
 * alignment interval so the monitor fires quickly.
 */

const TEMP_ROOT = mkOwnedTempDir("orch-align-");
writeFileSync(join(TEMP_ROOT, "test.txt"), "content");

const DONE_EVENTS: readonly ChatStreamEvent[] = [
  Object.freeze({ type: "content" as const, text: "done" }),
  Object.freeze({ type: "finish" as const, reason: "stop" }),
];

const MODEL_CONFIG = Object.freeze({
  providerId: "mock",
  modelId: "test-model",
  maxTokens: 4096,
  temperature: 0,
});

const RESOLVER: ProviderModelResolver = Object.freeze({
  resolve: (_profile: AgentProfile) => MODEL_CONFIG,
  providerIds: () => Object.freeze(["mock"]),
  modelIds: () => Object.freeze(["test-model"]),
});

const BG_PROFILE: AgentProfile = Object.freeze({
  name: "bg-agent",
  type: "background",
  model: "test-model",
  provider: "mock",
  systemPrompt: "",
  tools: Object.freeze([]),
  capabilities: Object.freeze([]),
  writeSet: Object.freeze([]),
  maxTurns: 1,
});

const AGENTS_CONFIG: AgentsConfig = Object.freeze({
  maximumConcurrentAgents: 5,
  profiles: Object.freeze([BG_PROFILE]),
  orchestration: Object.freeze({ alignmentMonitorIntervalMs: 50, conflictDetectionEnabled: false }),
});

function makeCustomBackgroundType(): { typeDef: AgentTypeDefinition; complete: () => void } {
  let completionResolve: ((result: AgentRunResult) => void) | undefined;
  let completed = false;

  const runResult: AgentRunResult = Object.freeze({
    agentId: "bg-test-agent",
    agentName: "bg-agent",
    turns: Object.freeze([]),
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    finishReason: "stop",
    lifecycleState: "succeeded",
    error: null,
  });

  const typeDef: AgentTypeDefinition = {
    typeId: "background",
    description: "test background agent with controllable completion",
    executionMode: "async",
    lifecycleStates: Object.freeze(["pending", "running", "succeeded", "failed", "cancelled", "timed-out"]),
    terminalStates: Object.freeze(["succeeded", "failed", "cancelled", "timed-out"]),
    hooks: Object.freeze({}),
    createRuntime: (options: AgentRuntimeOptions): AgentRuntime => {
      const agentId = "bg-test-agent";
      // Record agent start so the state store has a "running" agent for the
      // alignment monitor to find.
      options.stateStore.recordAgentStart({
        agentId,
        agentName: options.profile.name,
        runId: options.runId,
        taskId: options.taskId,
        attemptId: options.attemptId,
      });
      const completionPromise = new Promise<AgentRunResult>((resolve) => {
        completionResolve = resolve;
      });
      const handle: BackgroundAgentHandle = Object.freeze({
        agentId,
        agentName: options.profile.name,
        status: () => (completed ? "succeeded" : "running"),
        result: () => (completed ? runResult : undefined),
        async *events(): AsyncGenerator<import("../../src/agents/agent-runtime.ts").AgentEvent, void, unknown> {
          // no events
        },
        async cancel() { completed = true; if (completionResolve) completionResolve(runResult); },
        async suspend() {},
        async resume() {},
        steer() {},
        pendingSteeringMessages: () => Object.freeze([]),
        completion: () => completionPromise,
      });
      const runtime: BackgroundAgentRuntime = Object.freeze({
        agentId,
        agentName: options.profile.name,
        messages: () => [],
        state: () => Object.freeze({ lifecycleState: completed ? "succeeded" : "running", turnCount: 0, totalTokens: 0 }),
        async *run(): AsyncGenerator<import("../../src/agents/agent-runtime.ts").AgentEvent, AgentRunResult, unknown> {
          return runResult;
        },
        start: () => handle,
      });
      return runtime;
    },
    validateProfile: () => Object.freeze([]),
  };

  const complete = (): void => {
    completed = true;
    if (completionResolve) completionResolve(runResult);
  };

  return { typeDef, complete };
}

async function collectEventsWithTimeout(
  gen: AsyncGenerator<OrchestrationEvent, OrchestrationResult, unknown>,
  complete: () => void,
  completeDelayMs: number,
  overallTimeoutMs: number,
): Promise<OrchestrationEvent[]> {
  const events: OrchestrationEvent[] = [];
  const timer = setTimeout(complete, completeDelayMs);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`orchestrator execute timed out after ${overallTimeoutMs}ms`)), overallTimeoutMs),
  );
  try {
    let res = await gen.next();
    while (!res.done) {
      events.push(res.value);
      // Start the completion timer once the task has started (so the
      // background handle exists). We schedule it on the first event.
      res = await Promise.race([gen.next(res.value), timeout]);
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

test("Orchestrator alignment: emits alignment_check with driftDetected:true for a drifted agent", async () => {
  const dir = createTempDir("orch-align-drift-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline.db") });
    const { typeDef, complete } = makeCustomBackgroundType();
    const registry = createAgentTypeRegistry([typeDef]);
    const orchestrator = createOrchestrator({
      adapter: makeMockAdapter(DONE_EVENTS),
      toolRegistry: createToolRegistry(),
      resolver: RESOLVER,
      agentsConfig: AGENTS_CONFIG,
      repositoryRoot: TEMP_ROOT,
      store,
      agentTypeRegistry: registry,
      alignmentDriftThresholdMs: 1000,
      // Clock reports 60s in the future so nowMs - createdAt >> threshold.
      clock: () => new Date(Date.now() + 60_000).toISOString(),
    });
    const plan = orchestrator.plan([{ task: "background work", agentName: "bg-agent" }]);
    const gen = orchestrator.execute(plan);

    const events = await collectEventsWithTimeout(gen, complete, 200, 5000);
    const driftEvents = events.filter(
      (e): e is Extract<OrchestrationEvent, { type: "alignment_check" }> =>
        e.type === "alignment_check" && e.driftDetected === true,
    );
    assert.ok(
      driftEvents.length > 0,
      `at least one alignment_check with driftDetected:true must be emitted (events: ${events.map((e) => e.type).join(", ")})`,
    );
    assert.ok(
      /drift/i.test(driftEvents[0]!.message),
      "the drift event message must mention drift",
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Orchestrator alignment: emits alignment_check with driftDetected:false when no agent drifts", async () => {
  const dir = createTempDir("orch-align-nodrift-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline.db") });
    const { typeDef, complete } = makeCustomBackgroundType();
    const registry = createAgentTypeRegistry([typeDef]);
    const orchestrator = createOrchestrator({
      adapter: makeMockAdapter(DONE_EVENTS),
      toolRegistry: createToolRegistry(),
      resolver: RESOLVER,
      agentsConfig: AGENTS_CONFIG,
      repositoryRoot: TEMP_ROOT,
      store,
      agentTypeRegistry: registry,
      alignmentDriftThresholdMs: 1_000_000, // huge threshold → no drift
      clock: () => new Date().toISOString(), // real time, well within threshold
    });
    const plan = orchestrator.plan([{ task: "background work", agentName: "bg-agent" }]);
    const gen = orchestrator.execute(plan);
    const events = await collectEventsWithTimeout(gen, complete, 200, 5000);
    const noDriftEvents = events.filter(
      (e): e is Extract<OrchestrationEvent, { type: "alignment_check" }> =>
        e.type === "alignment_check" && e.driftDetected === false,
    );
    assert.ok(
      noDriftEvents.length > 0,
      `at least one alignment_check with driftDetected:false must be emitted when no agent drifts`,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
