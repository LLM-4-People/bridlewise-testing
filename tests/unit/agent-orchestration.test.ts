// @vitest-environment node
/**
 * Agent orchestration — the web-run wiring for the engine's orchestrator.
 *
 * What is being certified: `delegate_to_orchestrator` is wired through the
 * ONE pipeline (manifest + executor) as the fourth agent tool, the bridge
 * builds a valid `OrchestratorToolsOptions` from a web run (including the
 * DURABLE event-ledger store — the same persistent SQLite timeline ledger the
 * run route writes to, never a parallel store), a multi-task orchestration
 * runs end-to-end against a stubbed provider with dependency ordering
 * respected, per-task `restrictions` narrow (never widen), and orchestrated
 * agents are surfaced into the calling run's agent-state view (the run pane).
 *
 * The LLM is stubbed at the LOWEST choke point the web run has (the
 * `SharedLLMClient` the llm-bridge builds), so the whole path — the bridge's
 * adapter translation, the orchestrator's plan/execute, the per-task agent
 * runtime turn loops, and the tool registry's dispatch into the web executor
 * — is REAL code, driven end-to-end. No real provider call is made.
 *
 * Per the standing contract, the manifest↔executor 1:1 match is owned by
 * `tests/prevention/tool-manifest-executor-match.test.ts` (which the fourth
 * tool now flows through); this file adds what has no existing owner: the
 * orchestration bridge construction, the durable-store identity, the
 * dependency-ordered end-to-end run, and the run-pane surfacing.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { plantSettingsDocument } from "../helpers/isolated-config.ts";
import { join } from "node:path";

// Point the config owner at a per-file temp config BEFORE server/config.ts
// resolves (vi.hoisted runs before static imports; the setup re-resolves the
// singleton from this env per file).
await vi.hoisted(async () => {
  const { createTempDir } = await import("../helpers/temp-dir.ts");
  const nodePath = await import("node:path");
  const dir = createTempDir("ch-agent-orchestration-");
  process.env.HARNESS_CONFIG_PATH = nodePath.join(dir, "harness.config.json");
  process.env.HARNESS_WEB_TIMELINE_DB_PATH = nodePath.join(dir, "timeline.db");
});

import { executeToolCall, type ToolExecutionContext } from "../../server/tools/tool-executor.ts";
import { getToolManifest } from "../../server/tools/tools-bridge.ts";
import { releaseAgentBridge } from "../../server/agent/agent-runtime-bridge.ts";
import { getTimelineStore } from "../../server/observability/timeline-bridge.ts";
import { SharedLLMClient } from "../../engine/src/shared/llm/client.ts";
import { resolveProviderCredential, type ProviderStore } from "../../server/llm/providers.ts";
import { describeNativeAuthorityCeiling } from "../helpers/native-authority.ts";
import { PROVIDER_FIXTURE_OWNER } from "../helpers/multi-user.ts";

// ── The temp config + project root ──

const CONFIG_PATH = process.env.HARNESS_CONFIG_PATH!;
let projectRoot: string;

function writeConfig(cfg: Record<string, unknown>): void {
  // The stamp is strictly increasing across calls: the config cache keys on
  // mtimeMs, and same-millisecond rewrites must still be observed.
  plantSettingsDocument(CONFIG_PATH, JSON.stringify(cfg));
}

function repoRoot(): string {
  return join(import.meta.dirname, "..", "..");
}

/** A config document derived from the REAL checked-in config (every required
 * section present) with only the `agents` + `runtime` sections replaced, so
 * the engine's `getConfigDocumentSchema()` accepts it. Two profiles so the
 * orchestration can coordinate more than one agent. */
function configWithAgents(profiles: Record<string, unknown>[]): Record<string, unknown> {
  const real = JSON.parse(
    readFileSync(join(repoRoot(), "engine", "bridlewise.config.json"), "utf8"),
  ) as Record<string, unknown>;
  return {
    ...real,
    runtime: {
      ...(real.runtime as Record<string, unknown>),
      providers: [
        {
          id: "test-provider",
          baseUrl: "http://127.0.0.1:1",
          apiKeyEnvVar: "HARNESS_AGENT_TEST_KEY",
          timeoutMs: 30_000,
          retries: { maxRetries: 0, initialBackoffMs: 100, maxBackoffMs: 1000, backoffMultiplier: 2 },
          models: [{ id: "test-model", maxTokens: 4096, temperature: 0 }],
        },
      ],
    },
    agents: {
      maximumConcurrentAgents: 5,
      profiles,
      // The schema bounds alignmentMonitorIntervalMs to (0, 600000]; the max
      // (10 min) means the monitor never fires during a test's short run.
      orchestration: { alignmentMonitorIntervalMs: 600_000, conflictDetectionEnabled: false },
    },
  };
}

const RESEARCHER_PROFILE: Record<string, unknown> = {
  name: "researcher",
  type: "call-and-return",
  model: "test-model",
  provider: "test-provider",
  systemPrompt: "You research.",
  tools: [],
  capabilities: ["read", "write", "execute"],
  writeSet: [],
  maxTurns: 4,
};

const WRITER_PROFILE: Record<string, unknown> = {
  name: "writer",
  type: "call-and-return",
  model: "test-model",
  provider: "test-provider",
  systemPrompt: "You write.",
  tools: [],
  capabilities: ["read", "write"],
  writeSet: [],
  maxTurns: 4,
};

// ── The LLM stub at the choke point ──

/**
 * Stub `SharedLLMClient.prototype.stream` so no provider call leaves the
 * process. `script` maps a task-substring to the answer that sub-agent
 * returns, so each orchestrated agent produces a DISTINCT, observable answer
 * (a shared canned answer could not prove two real agents ran). The stub
 * records the order it served each task so dependency ordering is provable.
 */
function stubOrchestratedLlm(
  answersByTaskMarker: Readonly<Record<string, string>>,
  servedOrder: string[],
) {
  return vi.spyOn(SharedLLMClient.prototype, "stream").mockImplementation(async function* (
    this: unknown,
    messages: unknown,
  ) {
    // Identify which sub-agent this is by the task text in its user message.
    // The branded wrapper carries `.messages`.
    const list = (messages as { messages?: { role: string; content: string }[] }).messages ?? [];
    const userText = list.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    const marker = Object.keys(answersByTaskMarker).find((k) => userText.includes(k));
    const answer = marker !== undefined ? answersByTaskMarker[marker]! : "unmarked-task";
    servedOrder.push(marker ?? "unmarked");
    yield { type: "content", text: answer } as const;
    yield { type: "usage", usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 } } as const;
    yield { type: "finish", reason: "stop", truncated: false } as const;
  });
}

// A REAL credential, minted through the providers.ts owner (the bridge's
// `admitMintedCredential` gate consults the mint's WeakSet). The key is a
// fake that never leaves the process because the stream is stubbed.
function stubCredential() {
  const store: ProviderStore = {
    providers: [{
      id: "test-provider",
      baseUrl: "http://127.0.0.1:1",
      models: [{ id: "test-model", maxTokens: 4096, temperature: 0 }],
      apiKey: () => "test-key-not-real",
    }],
    defaultProvider: "test-provider",
    defaultModel: "test-model",
  };
  return resolveProviderCredential(store, "test-model", PROVIDER_FIXTURE_OWNER);
}

// Track every run id handed out so afterEach can release each bridge (the
// bridge map is per-run and the shared store is global, so an unreleased
// bridge would leak into the next test).
const usedRunIds = new Set<string>();

function agentCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  const runId = (overrides.runId as string | undefined) ?? "run-orch";
  usedRunIds.add(runId);
  return {
    projectRoot,
    runId,
    runSignal: new AbortController().signal,
    credential: stubCredential(),
    parentManifest: getToolManifest().filter((t) => t.category === "built-in"),
    ...overrides,
  } as ToolExecutionContext;
}

function mkdtempForTest(): string {
  const dir = join(CONFIG_PATH, "..", `proj-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  projectRoot = mkdtempForTest();
  writeConfig(configWithAgents([RESEARCHER_PROFILE, WRITER_PROFILE]));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const runId of usedRunIds) releaseAgentBridge(runId);
  usedRunIds.clear();
});

// ── 1. The bridge constructs a valid OrchestratorToolsOptions from a run ──

describe("agent orchestration: the bridge + durable store", () => {
  test("delegate_to_orchestrator is registered in the manifest AND the executor (the 1:1 contract)", async () => {
    const manifestNames = new Set(getToolManifest().map((t) => t.name));
    expect(manifestNames.has("delegate_to_orchestrator")).toBe(true);
    const { isToolExecutable } = await import("../../server/tools/tool-executor.ts");
    expect(isToolExecutable("delegate_to_orchestrator")).toBe(true);
  });

  test("the orchestrator's store IS the shared durable timeline ledger (no parallel store)", async () => {
    // The bridge hands the orchestrator `getTimelineStore()` — the same
    // persistent ledger the run route writes to. Prove the identity by
    // driving a real orchestration and observing its events land in THAT
    // store (a parallel or no-op store would leave the shared ledger empty
    // of the orchestration's run).
    const servedOrder: string[] = [];
    stubOrchestratedLlm({ "gather sources": "sources-found" }, servedOrder);
    const result = await executeToolCall(
      "delegate_to_orchestrator",
      { tasks: [{ agentName: "researcher", task: "gather sources" }] },
      agentCtx(),
    );
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as { orchestrationId: string; allSucceeded: boolean };
    expect(parsed.allSucceeded).toBe(true);
    expect(typeof parsed.orchestrationId).toBe("string");
    // The durable ledger (a real SQLite store, not a no-op) now holds events
    // correlated to the orchestration's run id. A no-op store would leave
    // the count at zero.
    const store = getTimelineStore();
    const events = store.query({ runId: parsed.orchestrationId });
    expect(
      events.length,
      "the durable ledger must persist orchestration events for the orchestration run id",
    ).toBeGreaterThan(0);
    // DURABILITY witness (not a no-op): the durable store has a real ledger
    // id and its chain tip is a real hash — a no-op stub store (the shape a
    // parallel test double would take) has neither, so its absence is caught.
    expect(store.ledgerId.startsWith("ledger-"), "the durable store must have a real ledger id").toBe(true);
    expect(store.chainTipHash().length, "the durable store must have a real chain tip").toBeGreaterThan(0);
  });

  test("a run whose config declares no agents section gets a guided refusal", async () => {
    const real = JSON.parse(readFileSync(join(repoRoot(), "engine", "bridlewise.config.json"), "utf8")) as Record<string, unknown>;
    delete real.agents;
    writeConfig(real);
    const result = await executeToolCall(
      "delegate_to_orchestrator",
      { tasks: [{ agentName: "researcher", task: "x" }] },
      agentCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/agents|configured/i);
  });

  test("an orchestration with no run context is a guided refusal (deny-by-default)", async () => {
    const result = await executeToolCall(
      "delegate_to_orchestrator",
      { tasks: [{ agentName: "researcher", task: "x" }] },
      { projectRoot },
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/run context/i);
  });
});

// ── 2. delegate_to_orchestrator runs a multi-task orchestration end-to-end ──

describe("agent orchestration: multi-task orchestration with dependency ordering", () => {
  test("two tasks with a dependency run in order and return real per-agent results", async () => {
    const servedOrder: string[] = [];
    const streamSpy = stubOrchestratedLlm(
      { "gather sources": "the research output", "write the report": "the written report" },
      servedOrder,
    );
    const result = await executeToolCall(
      "delegate_to_orchestrator",
      {
        tasks: [
          { agentName: "researcher", task: "gather sources", taskId: "research" },
          { agentName: "writer", task: "write the report", taskId: "report", dependsOn: ["research"] },
        ],
      },
      agentCtx(),
    );
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as {
      orchestrationId: string;
      allSucceeded: boolean;
      agentCount: number;
      totalTurns: number;
      totalTokens: number;
      agentResults: { agentName: string; lifecycleState: string; output: string }[];
    };
    // Both agents ran and succeeded.
    expect(parsed.allSucceeded).toBe(true);
    expect(parsed.agentCount).toBe(2);
    expect(parsed.agentResults).toHaveLength(2);
    // Real per-agent results: each agent's DISTINCT answer is present, proving
    // two real turn loops ran (not a shared canned value).
    const byName = new Map(parsed.agentResults.map((r) => [r.agentName, r]));
    expect(byName.get("researcher")?.lifecycleState).toBe("succeeded");
    expect(byName.get("researcher")?.output).toBe("the research output");
    expect(byName.get("writer")?.lifecycleState).toBe("succeeded");
    expect(byName.get("writer")?.output).toBe("the written report");
    expect(parsed.totalTokens).toBeGreaterThan(0);
    // Liveness: the provider stream was ACTUALLY driven once per agent.
    expect(streamSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Dependency ordering: the writer (depends on research) is served AFTER
    // the researcher. The stub records the order it served each task marker.
    const researchIdx = servedOrder.indexOf("gather sources");
    const reportIdx = servedOrder.indexOf("write the report");
    expect(researchIdx, "the researcher task must have been served").toBeGreaterThanOrEqual(0);
    expect(reportIdx, "the writer task must have been served").toBeGreaterThanOrEqual(0);
    expect(reportIdx).toBeGreaterThan(researchIdx);
  });

  test("a task naming an unknown agent is an honest typed failure, not a fabricated success", async () => {
    // The researcher names an unknown agent; the orchestrator surfaces the
    // engine's typed "profile not configured" error rather than fabricating
    // a per-agent success. The writer (which depends on it) must never run.
    const servedOrder: string[] = [];
    stubOrchestratedLlm({ "gather sources": "x", "write the report": "x" }, servedOrder);
    const result = await executeToolCall(
      "delegate_to_orchestrator",
      {
        tasks: [
          { agentName: "no-such-agent", task: "gather sources", taskId: "research" },
          { agentName: "writer", task: "write the report", taskId: "report", dependsOn: ["research"] },
        ],
      },
      agentCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/no-such-agent|not configured/i);
    // The dependent task never reached the provider.
    expect(servedOrder).not.toContain("write the report");
  });

  test("an empty tasks array returns a no-op result, not a crash", async () => {
    const result = await executeToolCall(
      "delegate_to_orchestrator",
      { tasks: [] },
      agentCtx(),
    );
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as { orchestrationId: null; lifecycleState: string };
    expect(parsed.orchestrationId).toBeNull();
    expect(parsed.lifecycleState).toBe("cancelled");
  });
});

// ── 3. Per-task restrictions narrow (never widen) ──

describe("agent orchestration: per-task restrictions narrow, never widen", () => {
  test("a task restriction removes write/execute tools from that sub-agent's provider request", async () => {
    // The witness: the tool set the sub-agent's provider request carries. A
    // read-only task restriction must produce a request whose tools declare
    // ONLY read — a write/execute tool in that request is the restriction
    // having been discarded (the inert shape).
    const offeredByMarker: Record<string, string[]> = {};
    vi.spyOn(SharedLLMClient.prototype, "stream").mockImplementation(async function* (
      this: unknown,
      messages: unknown,
      opts: unknown,
    ) {
      const list = (messages as { messages?: { role: string; content: string }[] }).messages ?? [];
      const userText = list.filter((m) => m.role === "user").map((m) => m.content).join("\n");
      const marker = userText.includes("locked-down") ? "locked-down" : "unmarked";
      const tools = (opts as { tools?: { function: { name: string } }[] }).tools;
      offeredByMarker[marker] = (tools ?? []).map((t) => t.function.name);
      yield { type: "content", text: "done" } as never;
      yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } as never;
      yield { type: "finish", reason: "stop", truncated: false } as never;
    });
    const result = await executeToolCall(
      "delegate_to_orchestrator",
      {
        tasks: [
          { agentName: "researcher", task: "locked-down research", restrictions: { preset: "read-only" } },
        ],
      },
      agentCtx(),
    );
    expect(result.success).toBe(true);
    const offered = offeredByMarker["locked-down"];
    expect(offered, "the restricted sub-agent's provider request must carry a tool set").toBeDefined();
    // Every manifest tool that declares a non-read capability must be ABSENT.
    const nonRead = getToolManifest()
      .filter((t) => t.category === "built-in" && t.capabilities.some((c) => c !== "read"))
      .map((t) => t.name);
    expect(nonRead.length, "the manifest must have non-read tools for this test to mean anything").toBeGreaterThan(0);
    for (const name of nonRead) {
      expect(offered, `write/execute tool '${name}' must not be offered to a read-only orchestrated task`).not.toContain(name);
    }
  });

  test("a restricted task does NOT narrow an UNRESTRICTED sibling sharing its profile", async () => {
    // The narrowing is PER-TASK, not per-profile: the engine resolves a
    // task's sub-agent by its `agentName`, so a restriction that REPLACED the
    // shared profile would narrow every task using it — including the
    // unrestricted sibling. The witness: the unrestricted task's provider
    // request must still carry the write/execute tools its profile holds,
    // even though a same-named restricted task narrowed itself to read-only.
    const offeredByMarker: Record<string, string[]> = {};
    vi.spyOn(SharedLLMClient.prototype, "stream").mockImplementation(async function* (
      this: unknown,
      messages: unknown,
      opts: unknown,
    ) {
      const list = (messages as { messages?: { role: string; content: string }[] }).messages ?? [];
      const userText = list.filter((m) => m.role === "user").map((m) => m.content).join("\n");
      const marker = userText.includes("locked-task") ? "locked" : userText.includes("free-task") ? "free" : "unmarked";
      const tools = (opts as { tools?: { function: { name: string } }[] }).tools;
      offeredByMarker[marker] = (tools ?? []).map((t) => t.function.name);
      yield { type: "content", text: "done" } as never;
      yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } as never;
      yield { type: "finish", reason: "stop", truncated: false } as never;
    });
    const result = await executeToolCall(
      "delegate_to_orchestrator",
      {
        tasks: [
          { agentName: "researcher", task: "locked-task", taskId: "a", restrictions: { preset: "read-only" } },
          // SAME profile (researcher), NO restriction: must keep its full grant.
          { agentName: "researcher", task: "free-task", taskId: "b", dependsOn: ["a"] },
        ],
      },
      agentCtx(),
    );
    expect(result.success).toBe(true);
    const nonRead = getToolManifest()
      .filter((t) => t.category === "built-in" && t.capabilities.some((c) => c !== "read"))
      .map((t) => t.name);
    expect(nonRead.length, "the manifest must have non-read tools for this test to mean anything").toBeGreaterThan(0);
    // The restricted task is narrowed to read-only.
    const locked = offeredByMarker["locked"] ?? [];
    for (const name of nonRead) {
      expect(locked, `restricted task must not be offered write/execute tool '${name}'`).not.toContain(name);
    }
    // The UNRESTRICTED sibling is NOT narrowed by the restricted one: it must
    // still be offered the write/execute tools its profile holds.
    const free = offeredByMarker["free"] ?? [];
    const freeHasNonRead = nonRead.filter((name) => free.includes(name));
    expect(
      freeHasNonRead.length,
      `the unrestricted sibling must keep its full ceiling (a restricted sibling must not narrow it); expected some non-read tools, got: ${JSON.stringify(free)}`,
    ).toBeGreaterThan(0);
  });

  test("a malformed per-task restriction is a typed refusal naming the restriction rule", async () => {
    const result = await executeToolCall(
      "delegate_to_orchestrator",
      {
        tasks: [
          { agentName: "researcher", task: "x", restrictions: { preset: "everything-plus-root" } },
        ],
      },
      agentCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/restrictions\.preset must be one of/);
  });

  test("the per-task restriction schema in the manifest derives from the vocabulary owner", async () => {
    // The orchestrator's per-task restrictions enum must equal the owner's
    // vocabulary — a literal copy would drift when a preset is added.
    const { DELEGATION_RESTRICTION_PRESETS } = await import("../../server/agent/agent-restrictions.ts");
    const entry = getToolManifest().find((t) => t.name === "delegate_to_orchestrator")!;
    const props = (entry.inputSchema as { properties: Record<string, unknown> }).properties;
    const tasks = props.tasks as { items: { properties: Record<string, unknown> } };
    const restrictions = tasks.items.properties.restrictions as { properties: Record<string, { enum?: readonly string[] }> };
    expect([...restrictions.properties.preset!.enum!].sort()).toEqual(
      [...DELEGATION_RESTRICTION_PRESETS].sort(),
    );
  });
});

// ── 4. Run-pane surfacing: orchestrated agents visible in the calling run ──

describe("agent orchestration: orchestrated agents surface in the calling run's view", () => {
  test("orchestrated agents appear in get_agent_state for the CALLING run", async () => {
    const servedOrder: string[] = [];
    stubOrchestratedLlm(
      { "gather sources": "the research output", "write the report": "the written report" },
      servedOrder,
    );
    // A unique run id per test: the shared agent-state store is global (keyed
    // by runId), so reusing one id across tests would leak mirrored agents
    // between them.
    const runId = `run-orch-surface-${Math.random().toString(36).slice(2)}`;
    const orchResult = await executeToolCall(
      "delegate_to_orchestrator",
      {
        tasks: [
          { agentName: "researcher", task: "gather sources", taskId: "research" },
          { agentName: "writer", task: "write the report", taskId: "report", dependsOn: ["research"] },
        ],
      },
      agentCtx({ runId }),
    );
    expect(orchResult.success).toBe(true);
    // The scoped get_agent_state for the CALLING run must show the
    // orchestrated agents (researcher + writer). Without the surfacing
    // mirror, they would be scoped under the orchestration's own run id and
    // invisible here (the wired-but-inert class: the pane stays empty for
    // the run that started the orchestration).
    const state = await executeToolCall("get_agent_state", {}, agentCtx({ runId }));
    expect(state.success).toBe(true);
    const parsed = JSON.parse(state.output) as { total: number; agents: { agentName: string; lifecycleState: string }[] };
    const names = parsed.agents.map((a) => a.agentName);
    expect(names, "the calling run's view must include the orchestrated researcher").toContain("researcher");
    expect(names, "the calling run's view must include the orchestrated writer").toContain("writer");
    // Honest terminal states, not a fabricated "running".
    for (const a of parsed.agents) {
      expect(["succeeded", "failed"]).toContain(a.lifecycleState);
    }
  });

  // Owed by a live-drive catch: an orchestration that reuses ONE profile
  // across several tasks (researcher runs task A then task B) must surface
  // BOTH tasks in the calling run's view — a mirror keyed by agent name alone
  // collapses them into one entry, and the pane shows one agent where two ran.
  test("an orchestration reusing one profile across two tasks surfaces BOTH tasks (not collapsed by name)", async () => {
    stubOrchestratedLlm({ "first task": "answer-one", "second task": "answer-two" }, []);
    const runId = `run-orch-reuse-${Math.random().toString(36).slice(2)}`;
    const orchResult = await executeToolCall(
      "delegate_to_orchestrator",
      {
        tasks: [
          // SAME profile (researcher) for both tasks — the common case.
          { agentName: "researcher", task: "first task", taskId: "task-a" },
          { agentName: "researcher", task: "second task", taskId: "task-b", dependsOn: ["task-a"] },
        ],
      },
      agentCtx({ runId }),
    );
    expect(orchResult.success).toBe(true);
    const parsed = JSON.parse(orchResult.output) as { agentCount: number; agentResults: unknown[] };
    expect(parsed.agentCount).toBe(2);
    // The calling run's view must hold TWO entries — one per task — even
    // though both share the agent name "researcher". A name-keyed mirror
    // would report total:1 here (the collapse bug).
    const state = await executeToolCall("get_agent_state", {}, agentCtx({ runId }));
    const view = JSON.parse(state.output) as { total: number; agents: { agentName: string; taskId: string; totalTokens: number }[] };
    expect(
      view.agents.filter((a) => a.agentName === "researcher").length,
      "two same-named orchestrated tasks must surface as two entries, not one collapsed entry",
    ).toBe(2);
    // The two tasks have distinct task ids (they are different units of work).
    const taskIds = new Set(view.agents.map((a) => a.taskId));
    expect(taskIds.size, "each orchestrated task must carry a distinct task id").toBe(2);
  });

  // Owed by a live-drive catch: the mirrored agent's turn/token counts must
  // be the REAL measured figures from the orchestration result, not a
  // hardcoded zero (the pane showed "0 turns · 0 tokens" for a run that
  // consumed real tokens — §5's fabricated-zero shape).
  test("a mirrored orchestrated agent carries the real token usage, not a fabricated zero", async () => {
    stubOrchestratedLlm({ "gather sources": "the research output" }, []);
    const runId = `run-orch-tokens-${Math.random().toString(36).slice(2)}`;
    const orchResult = await executeToolCall(
      "delegate_to_orchestrator",
      { tasks: [{ agentName: "researcher", task: "gather sources", taskId: "research" }] },
      agentCtx({ runId }),
    );
    expect(orchResult.success).toBe(true);
    // The orchestration consumed real tokens (the stub reports usage).
    const orchParsed = JSON.parse(orchResult.output) as { totalTokens: number };
    expect(orchParsed.totalTokens).toBeGreaterThan(0);
    // The calling run's view must carry a real token figure for the
    // orchestrated agent — never a zero standing in for a measured quantity.
    const state = await executeToolCall("get_agent_state", {}, agentCtx({ runId }));
    const view = JSON.parse(state.output) as { agents: { agentName: string; totalTokens: number }[] };
    const researcher = view.agents.find((a) => a.agentName === "researcher");
    expect(researcher, "the orchestrated agent must be surfaced").toBeDefined();
    expect(
      researcher!.totalTokens,
      "the mirrored agent must carry the real token usage, not a fabricated zero",
    ).toBeGreaterThan(0);
  });
});

describe("the agent summary derives its absent-section defaults from the engine's one owner", () => {
  // The census found the bridge restating maximumConcurrentAgents's
  // absent-section default as a literal 5 while the engine's own owner
  // answers 0 — the designed "no cap" spelling (the orchestrator skips
  // the plan-size check when it reads 0) — so a reader of the summary
  // could believe five concurrent agents were the limit while the engine
  // enforced none. The bridge now derives every absent-section answer from
  // the engine's exported owner; this arm pins both doors to it, so a
  // restated literal cannot come back silently.
  test("with no agents section the summary serves the engine's absent-section answers; with one, the section's own values", async () => {
    const { getAgentsConfigSummary, listAgentProfiles } = await import("../../server/agent/agent-types-bridge.ts");
    const { ABSENT_SECTION_AGENTS_CONFIG } = await import("../../engine/src/agents/agent-config.ts");
    const real = JSON.parse(
      readFileSync(join(repoRoot(), "engine", "bridlewise.config.json"), "utf8"),
    ) as Record<string, unknown>;
    const withoutAgents = { ...real };
    delete withoutAgents.agents;
    writeConfig(withoutAgents);
    const absent = getAgentsConfigSummary();
    expect(
      absent.maximumConcurrentAgents,
      "the absent-section cap must be the engine's own answer (0 = no cap), never a bridge-invented literal",
    ).toBe(ABSENT_SECTION_AGENTS_CONFIG.maximumConcurrentAgents);
    expect(absent.maximumConcurrentAgents).toBe(0);
    expect(absent.orchestration.alignmentMonitorIntervalMs).toBe(ABSENT_SECTION_AGENTS_CONFIG.orchestration.alignmentMonitorIntervalMs);
    expect(absent.orchestration.conflictDetectionEnabled).toBe(ABSENT_SECTION_AGENTS_CONFIG.orchestration.conflictDetectionEnabled);
    expect(absent.profileCount).toBe(0);
    expect(listAgentProfiles()).toEqual([]);

    // With a section present, the summary serves exactly what it declares —
    // the live-read proof (distinctive values, never the defaults).
    writeConfig(configWithAgents([RESEARCHER_PROFILE]));
    const present = getAgentsConfigSummary();
    expect(present.maximumConcurrentAgents).toBe(5);
    expect(present.orchestration.alignmentMonitorIntervalMs).toBe(600_000);
    expect(present.orchestration.conflictDetectionEnabled).toBe(false);
    expect(present.profileCount).toBe(1);
    expect(listAgentProfiles().map((p) => p.name)).toEqual(["researcher"]);
  });
});


describeNativeAuthorityCeiling("delegate_to_orchestrator", tools => writeConfig(configWithAgents([{ ...RESEARCHER_PROFILE, tools }])),
  () => executeToolCall("delegate_to_orchestrator", { tasks: [{ agentName: "researcher", task: "inspect", restrictions: { preset: "read-only" } }] }, agentCtx()));
