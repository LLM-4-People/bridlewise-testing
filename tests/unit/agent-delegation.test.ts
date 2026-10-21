// @vitest-environment node
/**
 * Agent delegation — the web-run substrate for the engine's agent runtime.
 *
 * What is being certified: the three agent tools are wired through the ONE
 * pipeline (manifest + executor), `delegate_to_agent` actually RUNS a
 * sub-agent and returns its real output, and a per-call `restrictions`
 * argument NARROWS the sub-agent's tool registry — never widens it.
 *
 * The LLM is stubbed at the LOWEST choke point the web run has: the
 * `SharedLLMClient` the llm-bridge builds. The stubbed stream yields real
 * `StreamChunk`s, so the whole rest of the path — the llm-bridge's ModelEvent
 * mapping, the sub-agent adapter's ChatStreamEvent translation, the engine
 * runtime's turn loop, and the tool registry's dispatch into the web
 * executor — is REAL code, driven end-to-end. No real provider call is made.
 *
 * Per the standing contract, every guard here was written by first searching
 * for an existing owner of the class: the manifest↔executor 1:1 match is
 * `tests/prevention/tool-manifest-executor-match.test.ts` (which these tools
 * now flow through and whose green run is evidence, not a duplicate here);
 * the dispatch-choke-point ownership is `tool-registry-owner.test.ts`. What
 * remains — the restriction NARROWING semantics and the per-run state
 * isolation — has no existing owner, which is what this file adds.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { plantSettingsDocument } from "../helpers/isolated-config.ts";
import { join } from "node:path";

// Point the config owner at a per-file temp config BEFORE server/config.ts
// resolves (vi.hoisted runs before static imports; the setup re-resolves the
// singleton from this env per file). `join` is used inside the hoisted block
// via the imported node:path — hoisted so it exists before the static import
// of the server's config chain evaluates.
await vi.hoisted(async () => {
  const { createTempDir } = await import("../helpers/temp-dir.ts");
  const nodePath = await import("node:path");
  const dir = createTempDir("ch-agent-delegation-");
  process.env.HARNESS_CONFIG_PATH = nodePath.join(dir, "harness.config.json");
  process.env.HARNESS_WEB_TIMELINE_DB_PATH = nodePath.join(dir, "timeline.db");
});

import { executeToolCall, type ToolExecutionContext } from "../../server/tools/tool-executor.ts";
import { getToolManifest } from "../../server/tools/tools-bridge.ts";
import { releaseAgentBridge } from "../../server/agent/agent-runtime-bridge.ts";
import { openRunFeed, subscribeToRunFeed, endRunFeed, type RunFrame } from "../../server/run/run-feed.ts";
import { SSE_EVENT_TYPES } from "../../shared/constants.ts";
import {
  parseDelegationRestrictions,
  resolveDelegationRestrictions,
  DELEGATION_RESTRICTION_PRESETS,
} from "../../server/agent/agent-restrictions.ts";
import type { AgentProfile, ModelEvent } from "../../server/kernel/canonical.ts";
import { SharedLLMClient } from "../../engine/src/shared/llm/client.ts";
import { completedResponse } from "../helpers/provider-stream.ts";

// ── The temp config + project root ──

const CONFIG_PATH = process.env.HARNESS_CONFIG_PATH!;
let projectRoot: string;

function writeConfig(cfg: Record<string, unknown>): void {
  plantSettingsDocument(CONFIG_PATH, JSON.stringify(cfg));
}

/** A config document derived from the REAL checked-in config (every required
 * section present) with only the `agents` + `runtime` sections replaced, so
 * the engine's `getConfigDocumentSchema()` accepts it. Deriving from the real
 * document (instead of a hand-built minimal one) means a new required
 * section added to the schema reaches this fixture automatically. */
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
      maximumConcurrentAgents: 3,
      profiles,
      orchestration: { alignmentMonitorIntervalMs: 30_000, conflictDetectionEnabled: true },
    },
  };
}

function repoRoot(): string {
  // tests/unit/ is two levels below the repo root.
  return join(import.meta.dirname, "..", "..");
}

const FULL_PROFILE: Record<string, unknown> = {
  name: "worker",
  type: "call-and-return",
  model: "test-model",
  provider: "test-provider",
  systemPrompt: "You are a sub-agent.",
  tools: "all",
  capabilities: ["read", "write", "execute"],
  writeSet: [],
  maxTurns: 4,
};

// ── The LLM stub at the choke point ──

type StubScript = Readonly<{ answer: string }>;

/**
 * Stub `SharedLLMClient.prototype.stream` so the sub-agent's provider calls
 * never leave the process. The stub yields REAL StreamChunks in the real
 * order (content; usage; finish), so every downstream mapping runs its real
 * code. The stub is applied to the class the SAME way the production path
 * loads it — through the ESM graph — so the executor's dynamic import of
 * the bridge and the test's static import share ONE module instance (the
 * dual-instance trap: a `createRequire`-loaded bridge would see a second,
 * unstubbed class).
 */
function stubLlmStream(script: StubScript) {
  return vi.spyOn(SharedLLMClient.prototype, "stream").mockImplementation(async function* () {
    yield { type: "content", text: script.answer } as const;
    yield { type: "usage", usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 } } as const;
    yield completedResponse({ content: script.answer });
    yield { type: "finish", reason: "stop", truncated: false } as const;
  });
}

// A REAL credential, minted through the providers.ts owner (the bridge's
// `admitMintedCredential` gate consults the mint's WeakSet — a hand-shaped
// object is refused there before the stubbed client is ever reached). The
// store is a test-local provider document; the key is a fake that never
// leaves the process because the SharedLLMClient's stream is stubbed.
import { resolveProviderCredential, type ProviderStore } from "../../server/llm/providers.ts";
import { describeNativeAuthorityCeiling } from "../helpers/native-authority.ts";
import { PROVIDER_FIXTURE_OWNER } from "../helpers/multi-user.ts";
import { address, received, serve } from "../../engine/test/support/loopback-upstream.ts";

function stubCredential(baseUrl = "http://127.0.0.1:1") {
  const store: ProviderStore = {
    providers: [{
      id: "test-provider",
      baseUrl,
      models: [{ id: "test-model", maxTokens: 4096, temperature: 0 }],
      apiKey: () => "test-key-not-real",
    }],
    defaultProvider: "test-provider",
    defaultModel: "test-model",
  };
  return resolveProviderCredential(store, "test-model", PROVIDER_FIXTURE_OWNER);
}

function agentCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    projectRoot,
    runId: "run-test",
    runSignal: new AbortController().signal,
    credential: stubCredential(),
    parentManifest: getToolManifest().filter((t) => t.category === "built-in"),
    ...overrides,
  } as ToolExecutionContext;
}

beforeEach(() => {
  projectRoot = mkdtempForTest();
  writeConfig(configWithAgents([FULL_PROFILE]));
});

afterEach(() => {
  vi.restoreAllMocks();
  releaseAgentBridge("run-test");
});

function mkdtempForTest(): string {
  const dir = join(CONFIG_PATH, "..", `proj-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── 1. The bridge constructs a valid AgentToolsOptions from a run context ──

describe("agent delegation: the substrate bridge", () => {
  test("list_agents runs end-to-end through the executor and returns the configured profiles", async () => {
    const result = await executeToolCall("list_agents", {}, agentCtx());
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as { maximumConcurrentAgents: number; profiles: { name: string }[] };
    expect(parsed.maximumConcurrentAgents).toBe(3);
    expect(parsed.profiles.map((p) => p.name)).toContain("worker");
  });

  test("the three agent tools are registered in the manifest AND the executor (the 1:1 contract)", () => {
    const manifestNames = new Set(getToolManifest().map((t) => t.name));
    for (const name of ["list_agents", "delegate_to_agent", "get_agent_state"]) {
      expect(manifestNames.has(name), `${name} must be in the manifest`).toBe(true);
    }
    // The match test (tool-manifest-executor-match) drives the executor side
    // of the 1:1; here we assert the agent tools specifically survive it.
  });

  test("a run whose config declares no agents section gets a guided refusal, not a crash", async () => {
    // A real document (every required section) with NO `agents` section —
    // the guided refusal names what is missing, and never fabricates an
    // empty agent list.
    const real = JSON.parse(readFileSync(join(repoRoot(), "engine", "bridlewise.config.json"), "utf8")) as Record<string, unknown>;
    delete real.agents;
    writeConfig(real);
    const result = await executeToolCall("list_agents", {}, agentCtx());
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/agents|configured/i);
  });
});

// ── 2. delegate_to_agent runs a sub-agent end-to-end ──

describe("agent delegation: delegate_to_agent runs a real sub-agent", () => {
  test("a delegated sub-agent runs its turn loop and returns its final answer", async () => {
    const streamSpy = stubLlmStream({ answer: "the sub-agent answer" });
    const result = await executeToolCall(
      "delegate_to_agent",
      { agentName: "worker", task: "do the thing" },
      agentCtx(),
    );
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as {
      agentName: string; lifecycleState: string; output: string; totalTokens: number;
    };
    expect(parsed.agentName).toBe("worker");
    expect(parsed.lifecycleState).toBe("succeeded");
    expect(parsed.output).toBe("the sub-agent answer");
    expect(parsed.totalTokens).toBeGreaterThan(0);
    // Liveness: the provider stream was ACTUALLY driven (the answer is not a
    // canned value from an inert adapter — the wired-but-inert class). The
    // stub is the choke point every LLM call crosses, so a delegation that
    // never reached it is a delegation that never ran.
    expect(streamSpy.mock.calls.length).toBeGreaterThan(0);
  });

  test("an unknown agent name is a typed failure, not a crash", async () => {
    stubLlmStream({ answer: "unreached" });
    const result = await executeToolCall(
      "delegate_to_agent",
      { agentName: "no-such-agent", task: "x" },
      agentCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("no-such-agent");
  });

  test("a delegation with no run context is a guided refusal (deny-by-default)", async () => {
    const result = await executeToolCall(
      "delegate_to_agent",
      { agentName: "worker", task: "x" },
      { projectRoot },
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/run context/i);
  });

  test("agent lifecycle transitions publish SSE `agent` frames DURING the run, not only at its end", async () => {
    // The Agents pane reads the client registry, which is fed by these
    // frames. Published only at run end (the prior shape), the pane stayed
    // empty for the whole run it existed to narrate. The publish happens at
    // the state store's choke point (agents-bridge), so every record path
    // is live — this drives the DELEGATION path (the real caller) and
    // observes the feed the SSE stream serves.
    stubLlmStream({ answer: "done" });
    const runId = "run-test";
    openRunFeed(runId, { userId: "user-test", chatId: "chat-test" });
    const seen: RunFrame[] = [];
    const sub = subscribeToRunFeed(runId, 0, (f) => void seen.push(f), () => undefined);
    expect(sub, "the run feed must exist for this test to observe it").not.toBeUndefined();
    try {
      const result = await executeToolCall(
        "delegate_to_agent",
        { agentName: "worker", task: "do the thing" },
        agentCtx({ runId }),
      );
      expect(result.success).toBe(true);
      const agentFrames = seen.filter((f) => f.event === SSE_EVENT_TYPES.agent);
      // At minimum the start and the completion transitions — and the start
      // frame must arrive BEFORE the tool call returns (it is not the
      // end-of-run batch: this assertion runs against frames already
      // published while the delegation was in flight).
      expect(agentFrames.length).toBeGreaterThanOrEqual(2);
      const states = agentFrames.map((f) => (f.data as { lifecycleState: string }).lifecycleState);
      expect(states[0]).toBe("running");
      expect(states).toContain("succeeded");
    } finally {
      sub?.unsubscribe();
      endRunFeed(runId, { event: SSE_EVENT_TYPES.done, data: { runId } });
    }
  });
});

// ── 3. Restriction sets narrow the sub-agent's registry ──

describe("agent delegation: restriction sets narrow, never widen", () => {
  test("parseDelegationRestrictions rejects an unknown preset (deny-by-default)", () => {
    expect(() => parseDelegationRestrictions({ preset: "everything-plus-root" }))
      .toThrowError(/restrictions\.preset must be one of/);
  });

  test("parseDelegationRestrictions rejects an out-of-catalog capability", () => {
    expect(() => parseDelegationRestrictions({ capabilities: ["read", "fly-to-moon"] }))
      .toThrowError(/restrictions\.capabilities must be an array drawn from/);
  });

  test("the preset vocabulary is derived from the owner, not a literal", () => {
    // The schema enum the model sees must equal the owner's vocabulary — a
    // literal copy here would drift when a preset is added.
    const entry = getToolManifest().find((t) => t.name === "delegate_to_agent")!;
    const props = (entry.inputSchema as { properties: Record<string, { enum?: readonly string[] }> }).properties;
    const restrictions = props.restrictions as { properties: Record<string, { enum?: readonly string[] }> };
    expect([...restrictions.properties.preset!.enum!].sort()).toEqual([...DELEGATION_RESTRICTION_PRESETS].sort());
  });

  test("a read-only restriction intersects capabilities (write/execute removed)", () => {
    const profile = FULL_PROFILE as unknown as AgentProfile;
    const resolved = resolveDelegationRestrictions(
      profile,
      parseDelegationRestrictions({ preset: "read-only" }),
      projectRoot,
    );
    expect(resolved.capabilities).toEqual(["read"]);
    expect(resolved.capabilities).not.toContain("write");
    expect(resolved.capabilities).not.toContain("execute");
  });

  test("a restriction can NEVER widen beyond the profile's capabilities", () => {
    // A read-only profile asked to gain write: the intersection drops it.
    const readOnlyProfile = { ...FULL_PROFILE, capabilities: ["read"] } as unknown as AgentProfile;
    const resolved = resolveDelegationRestrictions(
      readOnlyProfile,
      parseDelegationRestrictions({ capabilities: ["read", "write", "execute"] }),
      projectRoot,
    );
    expect(resolved.capabilities).toEqual(["read"]);
  });

  test("a writeSet inside the profile's grant is kept; one outside is refused", () => {
    const confinedProfile = { ...FULL_PROFILE, writeSet: ["src/"] } as unknown as AgentProfile;
    const kept = resolveDelegationRestrictions(
      confinedProfile,
      parseDelegationRestrictions({ writeSet: ["src/nested"] }),
      projectRoot,
    );
    expect(kept.writeSet).toEqual(["src/nested"]);
    expect(() =>
      resolveDelegationRestrictions(
        confinedProfile,
        parseDelegationRestrictions({ writeSet: ["etc/passwd-target"] }),
        projectRoot,
      ),
    ).toThrowError(/write set/);
  });

  test("a writeSet restriction can NEVER grant a path to a profile whose configured write set is empty (writes nowhere)", () => {
    // The empty write set is the profile's configured "writes nowhere" (the
    // engine's isPathInWriteSet returns false for every path on it). A
    // requested path is therefore OUTSIDE the grant — not merely outside a
    // non-empty grant's prefixes. Granting it would be a widening wearing a
    // restriction's clothes: the sub-agent comes out holding write paths its
    // profile never had.
    const writesNowhereProfile = { ...FULL_PROFILE, writeSet: [] } as unknown as AgentProfile;
    expect(() =>
      resolveDelegationRestrictions(
        writesNowhereProfile,
        parseDelegationRestrictions({ writeSet: ["src/"] }),
        projectRoot,
      ),
    ).toThrowError(/write set/);
    // The narrowing direction still holds: an EMPTY requested set on the same
    // profile is allowed (it widens nothing), and a capability-only narrowing
    // leaves the write set untouched.
    const still = resolveDelegationRestrictions(
      writesNowhereProfile,
      parseDelegationRestrictions({ writeSet: [] }),
      projectRoot,
    );
    expect(still.writeSet).toEqual([]);
    const capsOnly = resolveDelegationRestrictions(
      writesNowhereProfile,
      parseDelegationRestrictions({ preset: "read-only" }),
      projectRoot,
    );
    expect(capsOnly.writeSet).toBeNull();
  });

  test("a restricted delegation's tool registry drops write/execute tools", async () => {
    // The registry is derived from the parent manifest by capability: a
    // read-only delegation must have NO write- or execute-capable tool.
    const { createDelegationToolRegistry } = await import("../../server/agent/agent-runtime-bridge.ts");
    const parent = getToolManifest().filter((t) => t.category === "built-in");
    const registry = createDelegationToolRegistry(agentCtx(), parent, ["read"]);
    const names = registry.names();
    // Assert the CLASS: no surviving tool may declare a capability outside
    // the effective set. Derived from the manifest (dynamic), so a tool
    // added tomorrow is classified by its own declaration.
    const byName = new Map(parent.map((t) => [t.name, t]));
    for (const name of names) {
      const caps = byName.get(name)!.capabilities;
      for (const cap of caps) {
        expect(cap, `tool '${name}' survived a read-only restriction yet declares '${cap}'`).toBe("read");
      }
    }
    // And the read-only surface is genuinely present (the narrowing did not
    // collapse to empty): a read tool survives.
    const readTools = parent.filter((t) => t.capabilities.every((c) => c === "read"));
    expect(readTools.length).toBeGreaterThan(0);
    for (const t of readTools) {
      expect(names).toContain(t.name);
    }
  });

  test("a restricted delegation's sub-agent is OFFERED a narrowed tool set (witnessed at the provider request)", async () => {
    // The restriction's effect must be OBSERVABLE in what the sub-agent is
    // actually given, not inferred from a side effect that could pass for
    // another reason. The witness: the tool definitions the sub-agent's
    // provider request carries. A read-only restriction must produce a
    // request whose tools declare ONLY read — a write/execute tool in that
    // request is the restriction having been discarded (the inert shape).
    let offeredToolNames: string[] | undefined;
    vi.spyOn(SharedLLMClient.prototype, "stream").mockImplementation(async function* (this: unknown, source: unknown) {
      const tools = (source as { tools?: { type: string; name?: string }[] }).tools;
      offeredToolNames = (tools ?? []).filter((t) => t.type === "function").map((t) => t.name!);
      yield { type: "content", text: "done" } as never;
      yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } as never;
      yield completedResponse({ content: "done" }) as never;
      yield { type: "finish", reason: "stop", truncated: false } as never;
    });
    const result = await executeToolCall(
      "delegate_to_agent",
      { agentName: "worker", task: "look around", restrictions: { preset: "read-only" } },
      agentCtx(),
    );
    expect(result.success).toBe(true);
    expect(offeredToolNames, "the sub-agent's provider request must carry a tool set").toBeDefined();
    expect(offeredToolNames!.length).toBeGreaterThan(0);
    // The manifest tells us which tools declare a non-read capability; every
    // one of those must be ABSENT from the read-only sub-agent's request.
    const nonRead = getToolManifest()
      .filter((t) => t.category === "built-in" && t.capabilities.some((c) => c !== "read"))
      .map((t) => t.name);
    expect(nonRead.length, "the manifest must have non-read tools for this test to mean anything").toBeGreaterThan(0);
    for (const name of nonRead) {
      expect(offeredToolNames, `write/execute tool '${name}' must not be offered to a read-only sub-agent`).not.toContain(name);
    }
  });

  test("a sub-agent's execute_command runs through the SAME confined spawn choke point as the parent's", async () => {
    // The confinement claim is structural: the sub-agent's tool registry
    // re-enters the web executor (`executeToolCall`), whose execute_command
    // handler is `spawnAsyncSafe` — the single confinement choke point. The
    // witness that proves the sub-agent crossed THAT path (and not a parallel
    // spawn): the result JSON carries the `confinement` field, which only
    // `spawnAsyncSafe` produces. A sub-agent whose command ran unconfined (or
    // through a second executor) would not carry it.
    writeFileSync(join(projectRoot, "sub-marker.txt"), "sub-found");
    // The witness: the tool result the engine feeds back into the sub-agent's
    // SECOND provider call. That history carries the confined spawn's result
    // JSON — including the `confinement` field only `spawnAsyncSafe` writes.
    // Capturing it proves the sub-agent's command crossed the ONE confined
    // choke point (a parallel or unconfined path would not produce it).
    const seenToolResults: string[] = [];
    let callCount = 0;
    vi.spyOn(SharedLLMClient.prototype, "stream").mockImplementation(async function* (this: unknown, source: unknown) {
      callCount += 1;
      const input = (source as { input?: { type?: string; output?: unknown }[] }).input ?? [];
      if (callCount === 1) {
        const args = JSON.stringify({ command: "cat", args: ["sub-marker.txt"] });
        yield { type: "tool_call_start", index: 0, id: "call-1", name: "execute_command" } as never;
        yield { type: "tool_call_delta", index: 0, arguments: args } as never;
        yield completedResponse({ toolCalls: [{ id: "call-1", type: "function", function: { name: "execute_command", arguments: args } }] }) as never;
        yield { type: "finish", reason: "tool_calls", truncated: false } as never;
        return;
      }
      // Second call: the Responses input now carries the tool result as a
      // function_call_output item. Read that canonical shape, not the old
      // branded messages wrapper.
      for (const item of input) {
        if (item.type === "function_call_output") seenToolResults.push(String(item.output));
      }
      yield { type: "content", text: "read it" } as never;
      yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } as never;
      yield completedResponse({ content: "read it" }) as never;
      yield { type: "finish", reason: "stop", truncated: false } as never;
    });
    const result = await executeToolCall(
      "delegate_to_agent",
      { agentName: "worker", task: "read the marker file with cat" },
      agentCtx(),
    );
    expect(result.success).toBe(true);
    // The sub-agent completed (its turn loop executed the tool then answered).
    const parsed = JSON.parse(result.output) as { lifecycleState: string; output: string; error: string | null };
    expect(parsed.lifecycleState).toBe("succeeded");
    expect(parsed.output).toBe("read it");
    // The confinement witness: the tool result fed back to the sub-agent
    // carries the `confinement` field that ONLY `spawnAsyncSafe` (the web
    // executor's single confined-spawn choke point) writes. Its presence
    // proves the sub-agent's command crossed that path. The value is one of
    // the contract's own vocabulary ("confined" | "refused" — the refusal
    // carries a `confinementCode`); either way the field is present, which a
    // parallel or unconfined executor path would never produce.
    expect(seenToolResults.length).toBeGreaterThan(0);
    const toolResult = seenToolResults[0]!;
    expect(toolResult, "the sub-agent's command must carry the confined-spawn contract").toContain('"confinement"');
    // When the command actually ran (guardian available), the marker content
    // is returned; when confinement refused it (guardian binary not built in
    // this environment), the honest `ran:false` + a refusal code is. Both are
    // the choke point's real answers — what must NOT appear is a bare exit
    // code with no confinement field (the unconfined shape).
    const parsedResult = JSON.parse(toolResult) as { ran: boolean; confinement: string; stdout?: string };
    if (parsedResult.ran) {
      expect(parsedResult.stdout ?? "").toContain("sub-found");
    } else {
      expect(parsedResult.confinement).toBe("refused");
    }
  });

  test("an UNRESTRICTED delegation offers the full capability surface (the narrowing is what removed them)", async () => {
    // The control arm: with no restriction, a write/execute tool IS offered —
    // so the read-only arm's absence is the restriction's doing, not a
    // registry that never had them (the witness must differ between arms).
    let offeredToolNames: string[] | undefined;
    vi.spyOn(SharedLLMClient.prototype, "stream").mockImplementation(async function* (this: unknown, source: unknown) {
      const tools = (source as { tools?: { type: string; name?: string }[] }).tools;
      offeredToolNames = (tools ?? []).filter((t) => t.type === "function").map((t) => t.name!);
      yield { type: "content", text: "done" } as never;
      yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } as never;
      yield completedResponse({ content: "done" }) as never;
      yield { type: "finish", reason: "stop", truncated: false } as never;
    });
    const result = await executeToolCall(
      "delegate_to_agent",
      { agentName: "worker", task: "look around" },
      agentCtx(),
    );
    expect(result.success).toBe(true);
    const nonRead = getToolManifest()
      .filter((t) => t.category === "built-in" && t.capabilities.some((c) => c !== "read"))
      .map((t) => t.name);
    // The profile holds write+execute, so a non-read tool survives here.
    expect(offeredToolNames!.some((n) => nonRead.includes(n))).toBe(true);
  });
});

// ── 4. Per-run state isolation ──

describe("agent delegation: per-run state isolation", () => {
  test("two runs' get_agent_state do not leak into each other", async () => {
    stubLlmStream({ answer: "run A's answer" });
    await executeToolCall("delegate_to_agent", { agentName: "worker", task: "task A" }, agentCtx({ runId: "run-A" }));
    const stateA = await executeToolCall("get_agent_state", {}, agentCtx({ runId: "run-A" }));
    const stateB = await executeToolCall("get_agent_state", {}, agentCtx({ runId: "run-B" }));
    expect(stateA.success).toBe(true);
    expect(stateB.success).toBe(true);
    const a = JSON.parse(stateA.output) as { total: number; agents: { agentName: string }[] };
    const b = JSON.parse(stateB.output) as { total: number; agents: { agentName: string }[] };
    expect(a.total).toBeGreaterThanOrEqual(1);
    expect(a.agents.some((x) => x.agentName === "worker")).toBe(true);
    // run-B never delegated: its own store answers empty (NOT run-A's agents).
    expect(b.total).toBe(0);
    expect(b.agents).toEqual([]);
    releaseAgentBridge("run-A");
    releaseAgentBridge("run-B");
  });
});


describeNativeAuthorityCeiling("delegate_to_agent", tools => writeConfig(configWithAgents([{ ...FULL_PROFILE, tools }])),
  () => executeToolCall("delegate_to_agent", { agentName: "worker", task: "inspect", restrictions: { preset: "read-only" } }, agentCtx()));

test("sub-agent private receipts and both abort lifetimes reach the real shared HTTP client", async () => {
  const { createSubAgentAdapter } = await import("../../server/agent/agent-runtime-bridge.ts");
  const { responseSseResponse } = await import("../../engine/test/support/mock-provider.ts");
  const { resetProviderClients } = await import("../../server/llm/llm-bridge.ts");
  // This qualifies invocation controls only. Native resource/status persistence in
  // this web ModelEvent bridge has its separate migration owner.
  for (const method of ["stream", "collect"] as const) for (const source of ["parent", "request"] as const) {
    const parent = new AbortController(), request = new AbortController();
    const entered = Promise.withResolvers<void>(); let receiptCount = 0;
    // A REAL upstream answers (the door owns its transport); the receipt's
    // lifetime is the signal the door's request runs under.
    let actualSignal: AbortSignal | undefined;
    serve(async () => responseSseResponse({ id: `web-receipt-${method}-${source}`, content: "hello" }));
    resetProviderClients();
    const adapter = createSubAgentAdapter(stubCredential(address("http://test-provider.test")), parent.signal);
    const invocation = { onResponseReceipt: (receipt: import("../../engine/src/shared/llm/client.ts").ResponseReceipt, lifetime: AbortSignal) => {
      actualSignal = lifetime;
      receiptCount++; expect(receipt.providerId).toBe("test-provider"); entered.resolve(); return new Promise<void>(() => {});
    } };
    const data = { model: "test-model", messages: [{ role: "user" as const, content: "hello" }], signal: request.signal };
    const operation = method === "collect" ? adapter.chatCompletion(data, invocation)
      : (async () => { for await (const _ of adapter.streamChatCompletion(data, invocation)) {} })();
    await Promise.race([entered.promise, operation.then(() => { throw new Error("Operation ended before receipt delivery"); })]);
    const reason = new Error(`${source} ended`); (source === "parent" ? parent : request).abort(reason);
    await operation;
    expect(actualSignal?.aborted).toBe(true); expect(actualSignal?.reason).toBe(reason);
    expect(receiptCount).toBe(1); expect(received).toHaveLength(1); resetProviderClients();
  }
});

// ── F13: unparseable tool arguments are REFUSED, never dispatched with {} ──
//
// The bridge's JSON-repair choke point fell back to an EMPTY OBJECT when the
// arguments could not be parsed (even after the repair ladder). That is a
// coerced value: a tool the model called with arguments runs with defaults it
// never named. The repair ladder is also the owner of the numeric-leaf
// contract — a value it cannot preserve is refused, never rounded. This arm
// drives the real `streamChat` against a stubbed client and requires the
// refusal to reach the caller as an error event with NO tool_call_done.
test("a tool call whose arguments are not JSON is refused, never dispatched with {}", async () => {
  const { streamChat } = await import("../../server/llm/llm-bridge.ts");
  const stub = vi.spyOn(SharedLLMClient.prototype, "stream").mockImplementation(async function* () {
    yield { type: "tool_call_start", index: 0, id: "call-unparseable", name: "edit" } as const;
    // The classic truncated emission: no closing brace and no recoverable
    // balanced object inside any candidate.
    yield { type: "tool_call_delta", index: 0, arguments: '{"oldString": "a", "newString":' } as const;
    yield completedResponse({});
    yield { type: "finish", reason: "tool_calls", truncated: false } as const;
  });
  try {
    const events: ModelEvent[] = [];
    for await (const event of streamChat("hello", {
      credential: stubCredential(),
      systemPrompt: "p",
      messages: [{ role: "user", content: "hello" }],
    } as never)) events.push(event);
    expect(events.some((event) => event.type === "tool_call_done"), "no tool may be dispatched with {}").toBe(false);
    const error = events.find((event) => event.type === "error");
    expect(error, "the refusal must reach the caller as an error event").toBeDefined();
    if (error?.type === "error") {
      expect(error.error.message).toMatch(/argument|JSON|cannot be repaired|refus/iu);
    }
  } finally {
    stub.mockRestore();
  }
});
