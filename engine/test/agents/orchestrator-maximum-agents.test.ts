import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { createOrchestrator } from "../../src/agents/orchestrator.ts";
import { resolveAgentsConfig, createProviderModelResolver } from "../../src/agents/agent-config.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTempDir } from "../support/temp-dir.ts";

// ---------------------------------------------------------------------------
// MAXIMUM_AGENTS: the orchestrator's agent ceiling must come from
// ROOT_POLICY.runtime.limits.maximumAgents, not a hardcoded literal.
// ---------------------------------------------------------------------------

function buildMinimalConfigDocument(): unknown {
  return {
    runtime: {
      defaultProvider: "test-provider",
      defaultModel: "test-model",
      defaultToolChoice: "auto",
      systemPrompt: "",
      providers: [
        {
          id: "test-provider",
          baseUrl: "https://example.com",
          apiKeyEnvVar: "TEST_API_KEY",
          timeoutMs: 30000,
          retries: {
            maxRetries: 0,
            initialBackoffMs: 100,
            maxBackoffMs: 1000,
            backoffMultiplier: 2,
            retryableStatusCodes: [500],
          },
          models: [{ id: "test-model", maxTokens: 128, temperature: 0 }],
        },
      ],
    },
    agents: {
      maximumConcurrentAgents: ROOT_POLICY.runtime.limits.maximumAgents,
      profiles: [
        {
          name: "researcher",
          type: "call-and-return",
          model: "test-model",
          provider: "test-provider",
          systemPrompt: "",
          tools: [],
          capabilities: [],
          writeSet: [],
          maxTurns: 1,
        },
      ],
      orchestration: {
        alignmentMonitorIntervalMs: 60_000,
        conflictDetectionEnabled: false,
      },
    },
  };
}

test("MAXIMUM_AGENTS: ROOT_POLICY.runtime.limits.maximumAgents is 5", () => {
  assert.equal(ROOT_POLICY.runtime.limits.maximumAgents, 5);
});

test("MAXIMUM_AGENTS: orchestrator rejects plans exceeding the root-policy ceiling", () => {
  const dir = createTempDir("orch-max-agents-");
  try {
    const store = createTimelineStore({
      path: join(dir, "tl.db"),
      ledgerId: "test-ledger",
    });
    try {
      const doc = buildMinimalConfigDocument() as never;
      const agentsConfig = resolveAgentsConfig(doc as never);
      assert.ok(agentsConfig !== undefined);
      const resolver = createProviderModelResolver(doc as never);
      const orchestrator = createOrchestrator({
        adapter: {
          adapterId: "test",
          streamChatCompletion: async function* () { /* noop */ },
        } as never,
        toolRegistry: {
          definitions: () => [],
          names: () => [],
          get: () => undefined,
          register: () => {},
          has: () => false,
        } as never,
        resolver,
        agentsConfig: agentsConfig!,
        repositoryRoot: dir,
        store,
      });
      // A plan with exactly maximumAgents tasks must succeed.
      const atLimit = Array.from({ length: ROOT_POLICY.runtime.limits.maximumAgents }, (_, i) => ({
        task: `task-${i}`,
        agentName: "researcher",
      }));
      const planAtLimit = orchestrator.plan(atLimit);
      assert.equal(planAtLimit.tasks.length, ROOT_POLICY.runtime.limits.maximumAgents);

      // A plan with one more than maximumAgents must throw.
      const overLimit = Array.from({ length: ROOT_POLICY.runtime.limits.maximumAgents + 1 }, (_, i) => ({
        task: `task-${i}`,
        agentName: "researcher",
      }));
      assert.throws(() => orchestrator.plan(overLimit), /exceeds maximum/);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
