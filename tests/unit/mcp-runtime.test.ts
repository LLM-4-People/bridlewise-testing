// @vitest-environment node
/**
 * MCP runtime owner (server/mcp-runtime-bridge.ts) — the live wiring proof.
 *
 * Drives a REAL stdio MCP server (the engine's `fake-mcp-server.mjs` fixture
 * — a pure-Node JSON-RPC stdio server: initialize → tools/list → tools/call)
 * through the full web path:
 *
 *   config (`tools.mcpServers`) → runtime owner (connect + discover) →
 *   manifest merge (real `mcp__*` entries with the server's real schema) →
 *   executor dynamic dispatch (a real `tools/call` round-trip) →
 *   live status route projection (connected, tool count) → shutdown.
 *
 * And the deny-by-default halves: a server that fails to connect contributes
 * NO tools and surfaces its failure; an MCP (`mcp__*`) call to an unconnected server
 * is refused, never a phantom.
 *
 * Self-protection is OFF for these tests (`selfProtection.enabled: false` in
 * a test-scoped config copy) so the stdio spawn proceeds unconfined — the
 * confined path is exercised separately (the confinement owner's own suite
 * proves `prepareConfinedSpawn` decides; here we prove the MCP spawn goes
 * THROUGH that owner).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, linkSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempDir } from "../helpers/temp-dir.ts";
import { readMtimeMs, writeFileWithFreshMtime } from "../helpers/fresh-mtime.ts";
import { plantSettingsDocument } from "../helpers/isolated-config.ts";
import { enclosingFunctionOf } from "../helpers/function-scope.ts";
import { readSourceView } from "../../engine/scripts/verification/source-view.ts";
import { allProcessIds, commandLineOf, isProcessAlive, parentOf, procfsAvailable } from "../../engine/src/process/process-facts.ts";

// Point the harness config at a test-scoped copy BEFORE any server module
// resolves it (the config path is read from env at module scope). The real
// config is the source of truth for every other section; only the MCP server
// list and self-protection are swapped.
const FAKE_SERVER = fileURLToPath(
  new URL("../../engine/test/mcp/fixtures/fake-mcp-server.mjs", import.meta.url),
);
const REAL_CONFIG = fileURLToPath(
  new URL("../../engine/bridlewise.config.json", import.meta.url),
);

const scratch = createTempDir("mcp-runtime-test-");
// The config's folder IS the harness root (`server/safety/host-facts.ts`
// derives it from the config path), and a project root that contains the
// harness is refused by the filesystem gate. Keeping the config in the
// project scratch would therefore make every file tool read refuse the
// scratch for the wrong reason; the fixture keeps the two places separate so
// the scratch really is an unregistered project root.
const configDir = createTempDir("mcp-runtime-config-");
const configPath = join(configDir, "bridlewise.config.json");

function writeConfig(mcpServers: readonly unknown[], mcpDefaults?: Record<string, unknown>, toolBounds?: Record<string, unknown>, selfProtectionEnabled = false): void {
  const base = JSON.parse(readFileSync(REAL_CONFIG, "utf8")) as Record<string, unknown>;
  (base["tools"] as Record<string, unknown>)["mcpServers"] = mcpServers;
  if (mcpDefaults !== undefined) {
    (base["tools"] as Record<string, unknown>)["mcp"] = mcpDefaults;
  }
  // The variables this suite's ${VAR} placeholders name are permitted
  // (tools.mcp.credentialEnv) unless an arm sets its own list.
  const mcp = (base["tools"] as Record<string, Record<string, unknown> | undefined>)["mcp"] ?? {};
  (base["tools"] as Record<string, unknown>)["mcp"] = { ...mcp, credentialEnv: mcpDefaults?.["credentialEnv"] ?? ["MCP_*", "BRIDLEWISE_*"] };
  if (toolBounds !== undefined) {
    (base["tools"] as Record<string, unknown>)["defaultBounds"] = toolBounds;
  }
  // Confinement OFF for the in-process round-trip: the guardian refuses a
  // project root that is the harness's own tree, and this test's job is the
  // MCP wiring, not the sandbox decision (covered by the confinement owner).
  base["selfProtection"] = { schemaVersion: "bridlewise-self-protection-config/v1", enabled: selfProtectionEnabled };
  plantSettingsDocument(configPath, JSON.stringify(base));
}

const GOOD_SERVER = {
  id: "fake",
  transport: "stdio",
  command: process.execPath,
  args: [FAKE_SERVER],
  protocolVersion: "2025-11-25",
};

const markerPath = join(scratch, "mark-listed.txt");

/**
 * The shared fixture with `--mark`: it speaks the full lifecycle, then writes
 * the marker file once its tools/list RESPONSE has been flushed to the pipe —
 * the flush callback fires after the bytes left the process, so the marker
 * proves its discovery was SENT (not merely computed internally).
 */
const MARK_SERVER = {
  id: "mark",
  transport: "stdio",
  command: process.execPath,
  args: [FAKE_SERVER, "--mark", markerPath, "--name", "pingx"],
  protocolVersion: "2025-11-25",
};

/**
 * Build one self-terminating stall server: spawns but never speaks (`--silent`
 * — no protocol replies), then exits on its own after `exitAfterMs`. It holds
 * a registry build genuinely in flight for its whole lifetime without any
 * sleep in the test, and it can never hang the worker even if every stop path
 * fails.
 */
function stallServer(id: string, exitAfterMs: number): typeof MARK_SERVER {
  return {
    id,
    transport: "stdio",
    command: process.execPath,
    args: [FAKE_SERVER, "--silent", "--exit-after", String(exitAfterMs)],
    protocolVersion: "2025-11-25",
  };
}

const STALL_SERVER = stallServer("stall", 4000);

/** The authority probe (`fs-probe-mcp-server.mjs`): its tools report what the
 * server process can actually reach, from inside it. */
const FS_PROBE = fileURLToPath(
  new URL("../../engine/test/mcp/fixtures/fs-probe-mcp-server.mjs", import.meta.url),
);
const PROBE_SERVER = {
  id: "probe",
  transport: "stdio",
  command: process.execPath,
  args: [FS_PROBE],
  env: { CONFIGURED_FOR_PROBE: "configured" },
  enabled: true,
  protocolVersion: "2025-11-25",
};

process.env["HARNESS_CONFIG_PATH"] = configPath;
// The vitest setup file resets `serverConfig` per file from `process.env`,
// so the env must be in place before the first server module import. Dynamic
// imports below (after env is set) keep that ordering honest.

// One teardown for the whole file: fence + drain the MCP runtime owner and
// drop the manifest cache after EVERY test, whatever describe the test lives
// in — a new describe can never forget the drain (it is not opted into, it
// simply runs).
afterEach(async () => {
  const { stopAllMcpConnections, resetMcpRuntimeForTests } = await import("../../server/integrations/mcp-runtime-bridge.ts");
  await stopAllMcpConnections();
  resetMcpRuntimeForTests();
  const { invalidateToolManifestCache } = await import("../../server/tools/tools-bridge.ts");
  invalidateToolManifestCache();
});

describe("mcp-runtime-bridge: live stdio connect → manifest → dispatch → status → shutdown", () => {
  beforeEach(() => {
    writeConfig([GOOD_SERVER]);
  });

  it("connects to a real stdio MCP server, discovers its tool, and a call returns a real result", async () => {
    const { ensureMcpRuntimeStarted, getDiscoveredMcpTools, callMcpTool } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const registry = await ensureMcpRuntimeStarted();
    // The registry reports the server connected with its discovered tool.
    const signals = registry.getServerSignals("fake");
    expect(signals?.status).toBe("connected");
    expect(signals?.toolCount).toBe(1);

    // The discovered tool is real: id namespaced, schema the server's own.
    const tools = getDiscoveredMcpTools();
    expect(tools.map((t) => t.id)).toEqual(["mcp__fake__ping"]);
    expect(tools[0]!.manifest.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } } });

    // A real tools/call round-trip — the fake server answers "pong:1".
    const out = await callMcpTool("mcp__fake__ping", { text: "hello" });
    expect(out).toBe("pong:1");
  }, 20_000);

  it("the status read triggers the start WITHOUT paying it — the first snapshot is the honest pre-start state", async () => {
    // The settings surface's first status paint must not carry the connect
    // cost: `getLiveMcpServerSignals` triggers the lazy start in the
    // background and answers with the signals that exist at this instant.
    // The structure (not wall clock) is the assertion: the read resolves
    // while the registry still does not exist, because the start's completion
    // needs an IPC round trip the read never waits on — so the snapshot is
    // the pre-start state, and the start is verifiably in flight.
    const { getLiveMcpServerSignals, mcpRuntimeStarted, ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const first = await getLiveMcpServerSignals();
    expect(first, "the first snapshot is the honest pre-start state (no signals yet)").toEqual([]);
    expect(mcpRuntimeStarted(), "the read must not await the start — the registry is still absent right after it").toBe(false);
    // The trigger is real, not a dropped call: the start completes in the
    // background and the next read carries the live state.
    const registry = await ensureMcpRuntimeStarted();
    expect(registry.getServerSignals("fake")?.status).toBe("connected");
    const second = await getLiveMcpServerSignals();
    expect(second.map((signal) => signal.status)).toContain("connected");
  }, 20_000);

  it("merges the discovered tool into the unified manifest with the real schema", async () => {
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    await ensureMcpRuntimeStarted();
    const { invalidateToolManifestCache, getToolManifest, getEnabledToolManifestForSession } = await import("../../server/tools/tools-bridge.ts");
    invalidateToolManifestCache();
    const manifest = getToolManifest();
    const entry = manifest.find((t) => t.name === "mcp__fake__ping");
    expect(entry, "the discovered MCP tool must be in the manifest").toBeDefined();
    expect(entry!.category).toBe("mcp");
    expect(entry!.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
    // And it is in the ENABLED manifest (it reaches the LLM), not filtered out.
    const enabled = getEnabledToolManifestForSession(new Map());
    expect(enabled.some((t) => t.name === "mcp__fake__ping")).toBe(true);
  }, 20_000);

  it("the per-account tool states include MCP tools — the breaker panel's row source lists the gated surface, every category", async () => {
    // The gate auto-trips MCP tools exactly as it trips built-ins, and its
    // refusal promises "the user can re-enable it from the breaker panel" —
    // a row source that stops at the built-in boundary makes that promised
    // exit a dead door for the whole MCP family. The account states are the
    // row source's vocabulary gate (computeBreakerRows maps them to rows),
    // so the MCP entry must be THERE, with the same merge rule the enabled
    // manifest applies.
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    await ensureMcpRuntimeStarted();
    const { invalidateToolManifestCache, getToolAccountStates } = await import("../../server/tools/tools-bridge.ts");
    invalidateToolManifestCache();

    const noOverrides = getToolAccountStates(new Map());
    const mcpEntry = noOverrides.find((t) => t.name === "mcp__fake__ping");
    expect(mcpEntry, "a live MCP tool must be a switchable per-account row, never invisible to the panel").toBeDefined();
    expect(mcpEntry!.enabled, "a connected server's tool defaults to on — the operator's opt-in").toBe(true);
    expect(mcpEntry!.source).toBe("default");

    // The per-user override wins for the MCP tool too — the same merge rule
    // the run's tool decisions apply per category.
    const switched = getToolAccountStates(new Map([["mcp__fake__ping", false]]));
    expect(switched.find((t) => t.name === "mcp__fake__ping")!.enabled).toBe(false);
    expect(switched.find((t) => t.name === "mcp__fake__ping")!.source).toBe("you");
  }, 20_000);

  it("the executor dispatches an MCP (mcp__*) call to the registry and returns the real result", async () => {
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    await ensureMcpRuntimeStarted();
    const { executeToolCall, isToolExecutable } = await import("../../server/tools/tool-executor.ts");
    expect(isToolExecutable("mcp__fake__ping")).toBe(true);
    const result = await executeToolCall(
      "mcp__fake__ping",
      { text: "hi" },
      { projectRoot: scratch } as Parameters<typeof executeToolCall>[2],
    );
    expect(result.success).toBe(true);
    expect(result.output).toBe("pong:1");
  }, 20_000);

  it("an MCP tool that reports isError is a failed call, not a successful string", async () => {
    writeConfig([{
      ...GOOD_SERVER,
      args: [FAKE_SERVER, "--error"],
    }]);
    const { ensureMcpRuntimeStarted, callMcpTool } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    await ensureMcpRuntimeStarted();
    await expect(callMcpTool("mcp__fake__ping", { text: "hi" })).rejects.toMatchObject({
      name: "McpError",
      code: "mcp_call_tool_failed",
    });
    const { executeToolCall } = await import("../../server/tools/tool-executor.ts");
    const result = await executeToolCall(
      "mcp__fake__ping",
      { text: "hi" },
      { projectRoot: scratch } as Parameters<typeof executeToolCall>[2],
    );
    expect(result.success, "the executor must not record an MCP isError as success").toBe(false);
    expect(result.unavailable, "a completed MCP error is a failure, not an unavailable server").toBeUndefined();
    expect(result.unavailableReason, "a completed error carries no unavailable cause — nothing to install").toBeUndefined();
    expect(result.output).toMatch(/error:\d+/);
  }, 20_000);

  it("stopAll closes every client (the server reports stopped after)", async () => {
    const { ensureMcpRuntimeStarted, stopAllMcpConnections, mcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const registry = await ensureMcpRuntimeStarted();
    expect(registry.getServerSignals("fake")?.status).toBe("connected");
    await stopAllMcpConnections();
    expect(mcpRuntimeStarted()).toBe(false);
    // After stopAll the owner is reset: the tools are gone (deny-by-default
    // — a stopped server's tools do not linger in the manifest).
    const { getDiscoveredMcpTools } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    expect(getDiscoveredMcpTools()).toEqual([]);
  }, 20_000);

  it("a tools.mcp defaults-only edit rebuilds the registry (the fingerprint covers them)", async () => {
    // A config-bound `mcp.*` customization's contract is `immediate`: the
    // operator tunes `tools.mcp.retryCount` in the settings UI, the write gate
    // persists it, and the running registry must pick it up. That only happens
    // if the config fingerprint — the memoisation key that decides rebuild —
    // includes the module-wide defaults. A fingerprint covering only
    // `mcpServers` returns the STALE registry and the override never lands.
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const first = await ensureMcpRuntimeStarted();
    expect(first.getServerSignals("fake")?.status).toBe("connected");

    // Change ONLY the module-wide default; the server list is identical.
    writeConfig([GOOD_SERVER], { retryCount: 9, retryBackoffMs: 250, timeoutMs: 45000 });
    const second = await ensureMcpRuntimeStarted();

    // A rebuild produces a NEW registry object; a stale-fingerprint cache hit
    // would return the SAME one. Identity is the observable proof.
    expect(second).not.toBe(first);
    expect(second.getServerSignals("fake")?.status).toBe("connected");
  }, 20_000);

  it("a server args-only edit rebuilds the registry (the fingerprint covers the whole entry)", async () => {
    // An args/env/header/auth edit never touches id/transport/command/url —
    // under a picked-field fingerprint the memoised registry would keep
    // running the OLD entry and the operator's change would never land.
    // Observable proof: identity changes on an args-only edit, and the new
    // registry's observed behavior carries the new args (the --error flag
    // makes the server's tools/call return isError payloads).
    const { ensureMcpRuntimeStarted, callMcpTool } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const first = await ensureMcpRuntimeStarted();
    expect(first.getServerSignals("fake")?.status).toBe("connected");
    expect(await callMcpTool("mcp__fake__ping", { text: "hi" })).toBe("pong:1");

    writeConfig([{ ...GOOD_SERVER, args: [FAKE_SERVER, "--error"] }]);
    const second = await ensureMcpRuntimeStarted();

    expect(second, "an args-only edit must rebuild — the picked-field fingerprint would return the stale registry").not.toBe(first);
    await expect(callMcpTool("mcp__fake__ping", { text: "hi" })).rejects.toMatchObject({
      name: "McpError",
      code: "mcp_call_tool_failed",
    });
  }, 20_000);

  it("a tools.defaultBounds timeout-only edit rebuilds the registry (the fingerprint covers the bound the build resolves)", async () => {
    // The registry's per-call default timeout resolves from `tools.defaultBounds.timeoutMs`
    // when `tools.mcp.timeoutMs` is unset (and every per-server default comes
    // from it outright). Built-in tools read that same override live per
    // call — so an MCP fingerprint that did not cover it would land the
    // operator's edit on built-ins immediately and on MCP calls only after
    // an unrelated rebuild. Observable proof: identity changes on the edit.
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    writeConfig([GOOD_SERVER]);
    const first = await ensureMcpRuntimeStarted();
    expect(first.getServerSignals("fake")?.status).toBe("connected");

    // Change ONLY the module-level tool-bound timeout; the server list and
    // the mcp defaults are identical.
    writeConfig([GOOD_SERVER], undefined, { timeoutMs: 31_337, maxOutputBytes: 1048576, maxMemoryBytes: 268435456 });
    const second = await ensureMcpRuntimeStarted();

    expect(second, "a tool-bounds timeout edit must rebuild — the registry resolved that timeout at build time").not.toBe(first);
    expect(second.getServerSignals("fake")?.status).toBe("connected");
  }, 20_000);

  it("a reordered-but-identical env map does NOT rebuild the registry (the fingerprint is canonical)", async () => {
    // Object key ORDER is not config content: an operator (or a migration)
    // that rewrites the same pairs in a different order changed nothing. A
    // serialization-order-sensitive fingerprint would rebuild the registry —
    // tearing down live connections for zero effect.
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    writeConfig([{ ...GOOD_SERVER, env: { FIRST: "1", SECOND: "2" } }]);
    const first = await ensureMcpRuntimeStarted();
    expect(first.getServerSignals("fake")?.status).toBe("connected");

    writeConfig([{ ...GOOD_SERVER, env: { SECOND: "2", FIRST: "1" } }]);
    const again = await ensureMcpRuntimeStarted();

    expect(again, "identical content in a different key order is the same config — no rebuild").toBe(first);
  }, 20_000);

  it("the config fingerprint is a digest — retained state never carries a serialized copy of a secret-bearing entry", () => {
    // A server entry may carry a LITERAL credential (a non-${VAR} value). The
    // owner's retained fingerprint must be the canonical hash of the entries:
    // the literal then lives in the config file and the redaction owner's
    // registry only — never duplicated into a third retained string that
    // outlives the registry build it describes.
    const source = readFileSync(fileURLToPath(new URL("../../server/integrations/mcp-runtime-bridge.ts", import.meta.url)), "utf8");
    const start = source.indexOf("function configFingerprint");
    const end = source.indexOf("async function buildAndStartRegistry");
    expect(end, "configFingerprint must precede buildAndStartRegistry so the slice is the fingerprint").toBeGreaterThan(start);
    const slice = source.slice(start, end);
    expect(slice, "the fingerprint hashes the full server list").toMatch(/servers:\s*getMcpServers\(\)/);
    expect(slice, "the fingerprint hashes the module-wide defaults").toMatch(/defaults:\s*getMcpDefaults\(\)/);
    expect(slice, "the retained fingerprint is the canonical hash of the entries, not the entries").toMatch(/return canonicalHash\(/);
    expect(slice, "retaining the serialization itself would copy a literal credential into owner state").not.toMatch(/JSON\.stringify/);
  });

  it("a hand-edited tools.mcp bound is refused loudly at the read path — the write-gate schema owns floors AND ceilings", async () => {
    // A document that never passed the write gate (this helper writes raw
    // JSON — exactly the bypass shape) is invalid input. Floor breach: 0 is
    // not a positive integer. Ceiling breach: MAX_SAFE_INTEGER exceeds the
    // schema's own 60_000 bound (it is finite — the ceiling is what refuses
    // it). Both are refused by the schema's OWN verdict, both name the
    // offending key, and neither pins a magic number (the schema remains
    // the single bounds owner). The honest bit: an in-range value must
    // survive the same read path. The helper always rebuilds from the real
    // config file, so the 1 ms in-range write cannot leak into later tests.
    const { getMcpDefaults } = await import("../../server/kernel/harness-config.ts");
    const { ValidationError } = await import("../../server/kernel/errors.ts");
    for (const bound of [0, Number.MAX_SAFE_INTEGER] as const) {
      writeConfig([GOOD_SERVER], { closeGraceMs: bound });
      let thrown: unknown;
      try { getMcpDefaults(); } catch (err) { thrown = err; }
      expect(thrown, `bound ${String(bound)} must be refused, not silently dropped`).toBeInstanceOf(ValidationError);
      expect((thrown as { code?: string }).code, "the refusal is the invalid-config-document verdict").toBe("invalid_config_document");
      expect((thrown as Error).message, "the refusal names the offending key, not a generic complaint").toContain("tools.mcp.closeGraceMs");
      writeConfig([GOOD_SERVER], { closeGraceMs: 1 });
      expect(getMcpDefaults().closeGraceMs, "an in-range value survives the same read path").toBe(1);
    }
  });
});
describe("mcp-runtime-bridge: deny-by-default (failure + phantom refusal)", () => {
  it("a server that fails to connect contributes no tools and surfaces the failure", async () => {
    // The fake server's `--crash-after 1` makes it exit(1) on the FIRST
    // tools/call. But we never call a tool — instead, point `initialize` at
    // it and have it die on the FIRST message by crashing immediately: the
    // fixture's crash is call-counted, so a server that never answers
    // `initialize` is produced by a command that IS present but exits before
    // speaking (node -e 'process.exit(1)'). The spawn itself succeeds, the
    // connect handshake fails (transport closes before initialize completes)
    // — a real, honest connect failure with no unhandled 'error' event.
    writeConfig([{
      id: "ghost",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      protocolVersion: "2025-11-25",
    }]);
    const { ensureMcpRuntimeStarted, getDiscoveredMcpTools } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const registry = await ensureMcpRuntimeStarted();
    const signals = registry.getServerSignals("ghost");
    expect(signals?.status).toBe("error");
    expect(signals?.lastError).toBeTruthy();
    expect(signals?.toolCount).toBe(0);
    // No tools discovered → none advertised.
    expect(getDiscoveredMcpTools()).toEqual([]);
    const { invalidateToolManifestCache, getToolManifest } = await import("../../server/tools/tools-bridge.ts");
    invalidateToolManifestCache();
    expect(getToolManifest().some((t) => t.category === "mcp")).toBe(false);
  }, 20_000);

  it("an MCP (mcp__*) call to an unconnected server is refused, not a phantom", async () => {
    writeConfig([GOOD_SERVER]);
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    await ensureMcpRuntimeStarted();
    const { executeToolCall } = await import("../../server/tools/tool-executor.ts");
    const result = await executeToolCall(
      "mcp__nosuchserver__ping",
      {},
      { projectRoot: scratch } as Parameters<typeof executeToolCall>[2],
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not registered|failed/i);
  }, 20_000);

  it("a disabled MCP tool refuses typed — the executor records the failure WITH its reason key", async () => {
    // A tool the user deliberately disabled is unavailable for a different
    // cause than a missing server — the typed refusal carries the cause and
    // the executor forwards it, so the investigation's pause text can ask to
    // re-enable instead of claiming something is missing.
    writeConfig([GOOD_SERVER]);
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const registry = await ensureMcpRuntimeStarted();
    registry.disableTool("fake", "ping");
    const { executeToolCall } = await import("../../server/tools/tool-executor.ts");
    const result = await executeToolCall(
      "mcp__fake__ping",
      { text: "hi" },
      { projectRoot: scratch } as Parameters<typeof executeToolCall>[2],
    );
    expect(result.success).toBe(false);
    expect(result.unavailable).toBe(true);
    expect(result.unavailableReason, "the typed cause must reach the tool result — the pause text can name it").toBe("disabled");
  }, 20_000);

  it("the reason rides the PRODUCTION feeding seam: executor → safety runtime → pause text asks to re-enable, never to install", async () => {
    // The full wired channel against the REAL executor: `executeToolCall`
    // records every completed call into the run's safety runtime itself.
    // A result carrying the reason but a recording seam that drops it would
    // leave the pause text at the generic "install/configure" sentence —
    // exactly the misattribution the reason channel exists to fix.
    writeConfig([GOOD_SERVER]);
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const registry = await ensureMcpRuntimeStarted();
    registry.disableTool("fake", "ping");
    const { executeToolCall } = await import("../../server/tools/tool-executor.ts");
    const { createRunSafetyRuntime } = await import("../../server/safety/safety-runtime-bridge.ts");
    const { resolveBandaidConfig } = await import("../../engine/src/safety/bandaid-config.ts");
    const rt = createRunSafetyRuntime({ config: resolveBandaidConfig() });
    try {
      const failed = await executeToolCall(
        "mcp__fake__ping",
        { text: "hi" },
        { projectRoot: scratch, safetyRuntime: rt, safetyTurn: 1 } as Parameters<typeof executeToolCall>[2],
      );
      expect(failed.success).toBe(false);
      expect(failed.unavailableReason).toBe("disabled");
      // The workaround shape: the next attempt switches to a different tool
      // that succeeds — the detector's switch window closes on that success.
      writeFileSync(join(scratch, "probe.txt"), "probe body", "utf8");
      const switched = await executeToolCall(
        "read_file",
        { path: "probe.txt" },
        { projectRoot: scratch, safetyRuntime: rt, safetyTurn: 2 } as Parameters<typeof executeToolCall>[2],
      );
      expect(switched.success, "the switch target must succeed or no workaround finding exists to investigate").toBe(true);
      const intervention = rt.takePendingIntervention();
      expect(intervention.pause, "the workaround on a disabled tool must pause").not.toBeNull();
      expect(intervention.pause!.message, "the pause names the deliberate disable").toMatch(/turn it back on/i);
      expect(intervention.pause!.message, "a deliberate disable never reads as missing or unconfigured").not.toMatch(/missing|not configured|install/i);
      expect(intervention.pause!.message).toContain("mcp__fake__ping");
    } finally {
      rt.dispose();
    }
  }, 20_000);

  it("a disabled server is never connected", async () => {
    writeConfig([{ ...GOOD_SERVER, id: "off", enabled: false }]);
    const { ensureMcpRuntimeStarted, getDiscoveredMcpTools } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const registry = await ensureMcpRuntimeStarted();
    // The registry knows the server (stopped), but never connected it.
    const signals = registry.getServerSignals("off");
    expect(signals?.status).toBe("stopped");
    expect(getDiscoveredMcpTools()).toEqual([]);
  }, 20_000);
});
describe("mcp-runtime-bridge: ${VAR} placeholder resolution", () => {
  it("resolves ${VAR} in env values from process.env at connect time", async () => {
    process.env["MCP_TEST_SECRET"] = "secret-value-12345";
    writeConfig([{
      ...GOOD_SERVER,
      args: [FAKE_SERVER, "--say", "the server echoed secret-value-12345"],
      env: { MCP_TEST_SECRET: "${MCP_TEST_SECRET}" },
    }]);
    const { ensureMcpRuntimeStarted, getDiscoveredMcpTools } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const registry = await ensureMcpRuntimeStarted();
    // The server connected (the env was resolved, not left as a literal that
    // might confuse the server).
    expect(registry.getServerSignals("fake")?.status).toBe("connected");
    // The resolved value is HELD for this server (secd-security SECD-C3):
    // masked in what the server authors (its tool description, at the client
    // door), and NOT registered process-wide (where equality on any
    // user-observable surface would confirm a guess).
    const described = JSON.stringify(getDiscoveredMcpTools().map((tool) => tool.manifest));
    expect(described).toContain("the server echoed");
    expect(described).not.toContain("secret-value-12345");
    const { knownSecretLabels } = await import("../../engine/src/privacy/secret-intelligence.ts");
    expect(knownSecretLabels().some((label) => label.startsWith("mcp-server/"))).toBe(false);
    delete process.env["MCP_TEST_SECRET"];
  }, 20_000);

  it("an unresolved ${VAR} is a MISSING credential: the server is not connected, never started with the placeholder as its secret", async () => {
    delete process.env["MCP_NONEXISTENT_VAR"];
    writeConfig([{
      ...GOOD_SERVER,
      env: { MCP_NONEXISTENT_VAR: "${MCP_NONEXISTENT_VAR}" },
    }]);
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const registry = await ensureMcpRuntimeStarted();
    // Honest, not invented — and not sent either: the literal `${...}`
    // spelling used to reach the server as the credential.
    expect(registry.getServerSignals("fake")?.status).toBe("error");
    expect(registry.getServerSignals("fake")?.lastErrorCode).toBe("mcp_credential_missing");
  }, 20_000);
});

describe("mcp-runtime-bridge: LITERAL credentials are HELD for the server's output (no ${VAR} intent)", () => {
  it("a literal env token AND a literal header token are masked in the server's output; a short innocuous value is not; nothing is registered process-wide", async () => {
    const literalEnvToken = "mcp-literal-env-token-f6b41d9a2c";
    const literalHeaderToken = "mcp-literal-header-token-8e3c05d7b1";
    const sentence = `env token ${literalEnvToken} header token ${literalHeaderToken} role stdio`;
    writeConfig([{
      ...GOOD_SERVER,
      args: [FAKE_SERVER, "--say", sentence],
      env: { LITERAL_TOKEN: literalEnvToken, ROLE: "stdio" },
      headers: { "X-Probe-Key": literalHeaderToken },
    }]);
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const registry = await ensureMcpRuntimeStarted();
    // Liveness: the build ran the credential resolution (the server really connected).
    expect(registry.getServerSignals("fake")?.status).toBe("connected");

    const { knownSecretLabels } = await import("../../engine/src/privacy/secret-intelligence.ts");
    expect(knownSecretLabels().some((label) => label.startsWith("mcp-server/")), "nothing registered process-wide (no equality oracle)").toBe(false);
    // The client door: the held literals are masked in what the server
    // authors (its tool description); the innocuous short value and the
    // plain remainder pass through untouched (the inert-witness pair).
    const { getDiscoveredMcpTools } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const masked = JSON.stringify(getDiscoveredMcpTools().map((tool) => tool.manifest));
    expect(masked, "the literal env token is masked in the server's output").not.toContain(literalEnvToken);
    expect(masked, "the literal header token is masked in the server's output").not.toContain(literalHeaderToken);
    expect(masked, "witness: the non-secret remainder survives (no over-mask)").toContain("role stdio");
  }, 20_000);

  it("an unresolved ${VAR} spelling is NOT registered as a literal — the spelling is not credential material", async () => {
    delete process.env["MCP_TRULY_MISSING"];
    writeConfig([{
      ...GOOD_SERVER,
      env: { MAYBE: "${MCP_TRULY_MISSING}" },
    }]);
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const registry = await ensureMcpRuntimeStarted();
    // Liveness: the resolution ran (the connect refused on its result).
    expect(registry.getServerSignals("fake")?.lastErrorCode).toBe("mcp_credential_missing");
    const { knownSecretLabels } = await import("../../engine/src/privacy/secret-intelligence.ts");
    expect(
      knownSecretLabels(),
      "a leftover placeholder spelling must not be registered as a literal secret (it masks nothing an attacker could observe)",
    ).not.toContain("mcp-server/fake/env/MAYBE");
  }, 20_000);
});

describe("mcp-runtime-bridge: the warn payload carries the typed shape (never a flattened message string)", () => {
  it("mcpWarnErrorPayload carries code + retryable for a typed error, and only the message (honestly) for an untyped one", async () => {
    const { mcpWarnErrorPayload } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const { McpError } = await import("../../engine/src/mcp/errors.ts");
    const typed = mcpWarnErrorPayload(new McpError("the drain refused", "mcp_start_superseded", false));
    expect(typed, "a typed error's message is carried").toMatchObject({ error: "the drain refused" });
    expect(typed, "a typed error's code is carried — never flattened away").toMatchObject({ code: "mcp_start_superseded" });
    expect(typed, "a typed error's retryable flag is carried").toMatchObject({ retryable: false });
    expect(
      mcpWarnErrorPayload(new McpError("try again", "mcp_retry", true)),
      "a retryable typed error reports retryable: true",
    ).toMatchObject({ code: "mcp_retry", retryable: true });
    const untyped = mcpWarnErrorPayload(new Error("boom"));
    expect(untyped).toMatchObject({ error: "boom" });
    expect(untyped, "an untyped error invents no code — the message-only shape is the honest one").not.toHaveProperty("code");
    expect(untyped, "an untyped error invents no retryable").not.toHaveProperty("retryable");
    expect(mcpWarnErrorPayload("a plain string failure"), "non-Error rejects still carry their message").toMatchObject({ error: "a plain string failure" });
  });

  it("every error-carrying webWarn seam in the bridge routes through mcpWarnErrorPayload — no inline flattening returns", () => {
    // The seam pin: a catch that rebuilds `{ error: extractErrorMessage(…) }`
    // inline at a warn site drops code/retryable exactly where a drained
    // teardown's typed rejection would be reported. All inline
    // `extractErrorMessage(` calls must live INSIDE the payload helper.
    const source = readFileSync(fileURLToPath(new URL("../../server/integrations/mcp-runtime-bridge.ts", import.meta.url)), "utf8");
    const helperStart = source.indexOf("export function mcpWarnErrorPayload");
    expect(helperStart, "witness: the warn payload helper exists").toBeGreaterThan(-1);
    const helperBodyEnd = source.indexOf("\n}", helperStart);
    expect(helperBodyEnd, "witness: the helper body was located").toBeGreaterThan(helperStart);
    const outside = source.slice(0, helperStart) + source.slice(helperBodyEnd + 2);
    expect(
      outside.includes("extractErrorMessage("),
      "an inline extractErrorMessage outside the payload helper is a flattened warn payload — route the seam through mcpWarnErrorPayload",
    ).toBe(false);

    // The other consumer that warns about THIS runtime: the manifest kick in
    // tools-bridge reports the same start failure and must ride the same
    // payload helper, or the typed refusal flattens one file over. The seam
    // text is a quoted string — the view that keeps it is codeWithStrings.
    const tools = readSourceView(fileURLToPath(new URL("../../server/tools/tools-bridge.ts", import.meta.url))).codeWithStrings();
    const seamAt = tools.indexOf("background MCP runtime start failed");
    expect(seamAt, "witness: the manifest-kick warn seam exists").toBeGreaterThan(-1);
    const kickCallback = enclosingFunctionOf(tools, seamAt, "the manifest-kick catch callback");
    expect(kickCallback, "the manifest-kick warn callback must exist so the claim about it is real").toBeDefined();
    expect(kickCallback!.body, "the manifest-kick warn must route through the bridge payload helper").toContain("mcpWarnErrorPayload(err)");
    expect(kickCallback!.body, "the seam must never rebuild an inline message-only payload").not.toContain("err.message");
  });
});

describe("mcp-runtime-bridge: the start lifecycle fence (a superseded start can never publish)", () => {
  beforeEach(() => {
    writeConfig([GOOD_SERVER]);
  });

  it("teardown DRAINS an in-flight start — its build is stopped + discarded, never published", async () => {
    // The start is fired and NOT awaited; teardown runs while the build is
    // genuinely in flight (a real stdio spawn + JSON-RPC handshake takes
    // real event-loop turns, so teardown can never beat the first settlement
    // — no sleep is needed to force the interleaving). The drained start
    // must reject with the typed supersession — never resolve a registry
    // born from a pre-teardown world — and the owner reports stopped.
    const { ensureMcpRuntimeStarted, stopAllMcpConnections, mcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const start = ensureMcpRuntimeStarted();
    let settled = false;
    void start.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await stopAllMcpConnections();
    expect(
      settled,
      "teardown is not complete until the in-flight start has SETTLED — the drain must await it, not just fence it",
    ).toBe(true);
    await expect(
      start,
      "a start superseded by teardown refuses with the typed supersession — it never delivers a stale registry",
    ).rejects.toMatchObject({ name: "McpError", code: "mcp_start_superseded" });
    expect(
      mcpRuntimeStarted(),
      "after a drained teardown the owner has no registry — the superseded build was discarded",
    ).toBe(false);
    expect(
      await getDiscoveredIds(),
      "a discarded generation registers no tools — the map mirrors the current generation only",
    ).toEqual([]);
    await expectNoOwnedFakeServers(
      "a superseded build stops its own stdio child before teardown completes — nothing leaks past the drain",
    );
  }, 20_000);

  it("a teardown racing a config rebuild still drains the whole transition — no registry materialises after teardown returns", async () => {
    // The rebuild path stops the PUBLISHED registry before building the
    // replacement, and that stop is a real awaited close. A teardown fired
    // inside the stop window must still fence + drain the transition: if the
    // start's generation were stamped only AFTER the old registry's stop,
    // the teardown would drain nothing and the transition would publish a
    // registry into the torn-down world once the stop resolved.
    const { ensureMcpRuntimeStarted, stopAllMcpConnections, mcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const first = await ensureMcpRuntimeStarted();
    expect(first.getServerSignals("fake")?.status).toBe("connected");
    writeConfig([{ ...GOOD_SERVER, id: "fake2" }]);
    const transition = ensureMcpRuntimeStarted();
    await stopAllMcpConnections();
    await expect(
      transition,
      "a rebuild superseded by teardown refuses with the typed supersession — it never delivers a registry born after teardown",
    ).rejects.toMatchObject({ name: "McpError", code: "mcp_start_superseded" });
    expect(
      mcpRuntimeStarted(),
      "teardown drained the whole transition — nothing publishes into the torn-down state",
    ).toBe(false);
    await expectNoOwnedFakeServers(
      "the stopped rebuild and its replacement build both leave no stdio child behind",
    );
  }, 20_000);

  it("teardown drains EVERY in-flight generation — a superseded build's own stop is settled before teardown returns", async () => {
    // Three overlapping generations: config A starts (stall — never
    // connects), config B supersedes it with its own stall, then teardown
    // lands mid-B. The `starting` slot holds ONLY B: a drain keyed on the
    // slot leaves A's own stop (it stops itself when it loses the fence,
    // inside its chain) unsettled when teardown returns — A's stdio children
    // leak for a window. A's stall outlives B's by ~1s so the defect is
    // observable by construction, never by a sleep.
    writeConfig([stallServer("stallA", 1200)]);
    const { ensureMcpRuntimeStarted, stopAllMcpConnections, mcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const first = ensureMcpRuntimeStarted();
    let firstSettled = false;
    void first.catch(() => undefined).then(() => { firstSettled = true; });
    writeConfig([stallServer("stallB", 250)]);
    const second = ensureMcpRuntimeStarted();
    let secondSettled = false;
    void second.catch(() => undefined).then(() => { secondSettled = true; });

    await stopAllMcpConnections();

    expect(
      firstSettled,
      "teardown is not complete until EVERY pre-fence start has SETTLED — the superseded first generation carries its own stop inside its chain",
    ).toBe(true);
    expect(secondSettled, "the newest generation's chain settles in the same drain").toBe(true);
    await expect(first, "the superseded generation refuses with the typed supersession").rejects.toMatchObject({ name: "McpError", code: "mcp_start_superseded" });
    await expect(second, "the fenced newest generation refuses with the typed supersession").rejects.toMatchObject({ name: "McpError", code: "mcp_start_superseded" });
    expect(mcpRuntimeStarted(), "after a drained teardown the owner has no registry").toBe(false);
    await expectNoOwnedFakeServers(
      "both superseded builds stopped their own stdio children before teardown returned — nothing leaks past the drain",
    );
  }, 20_000);

  it("teardown never fences AND never waits on a start stamped after its fence — the post-teardown world owns its runtime", async () => {
    // The drain is a SNAPSHOT of the chains in flight at the fence. A start
    // stamped afterwards belongs to the post-teardown world: it must publish
    // legally (the fence is not a kill switch on the future) and the drain
    // must not wait on it (shutdown latency). The pre-fence stall exits at
    // ~250ms, the post-fence stall at ~1500ms, so the witness discriminates
    // by construction: had the drain adopted the newer chain, teardown would
    // return only after the newer chain settled.
    writeConfig([stallServer("stallA", 250)]);
    const { ensureMcpRuntimeStarted, stopAllMcpConnections, mcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const first = ensureMcpRuntimeStarted();
    let firstSettled = false;
    void first.catch(() => undefined).then(() => { firstSettled = true; });
    const teardown = stopAllMcpConnections();
    // Stamped AFTER the fence: a NEW world with a slow, silent server.
    writeConfig([stallServer("stallB", 1500)]);
    const resurrected = ensureMcpRuntimeStarted();
    let resurrectedSettled = false;
    void resurrected.catch(() => undefined).then(() => { resurrectedSettled = true; });

    await teardown;

    expect(firstSettled, "the pre-fence start settles inside the drain").toBe(true);
    await expect(first, "the fenced start refuses with the typed supersession").rejects.toMatchObject({ name: "McpError", code: "mcp_start_superseded" });
    expect(
      resurrectedSettled,
      "the drain awaited only the pre-fence snapshot — a start stamped after the fence was never adopted into the drain's wait",
    ).toBe(false);
    // The post-fence start publishes legally: awaiting it afterwards yields
    // its registry — the fence broke no future lifecycle.
    const registry = await resurrected;
    expect(mcpRuntimeStarted(), "a start stamped after the fence publishes into the new world").toBe(true);
    expect(registry.getServerSignals("stallB"), "the resurrected registry knows its configured server").toBeDefined();
  }, 20_000);

  it("a start superseded by teardown refuses adoption of a LATER lifecycle — pre-fence awaiters get the typed supersession", async () => {
    // Even when a post-fence lifecycle exists (a fast good server publishing
    // while the pre-fence start is still in flight), a pre-fence awaiter must
    // NOT be handed it: it asked for a runtime that was torn down; the honest
    // answer is the typed supersession. Riding the new world would also make
    // the drain's snapshot a lie (the superseded arm would pull the new
    // chain into the pre-fence waiters' settlement).
    writeConfig([stallServer("stallA", 1200)]);
    const { ensureMcpRuntimeStarted, stopAllMcpConnections } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const pending = ensureMcpRuntimeStarted();
    const teardown = stopAllMcpConnections();
    writeConfig([GOOD_SERVER]);
    const resurrected = ensureMcpRuntimeStarted();
    await teardown;
    await expect(
      pending,
      "a start fenced before a resurrection refuses with the typed supersession — it never rides the new world's lifecycle",
    ).rejects.toMatchObject({ name: "McpError", code: "mcp_start_superseded" });
    const registry = await resurrected;
    expect(registry.getServerSignals("fake")?.status, "the post-fence world is healthy").toBe("connected");
  }, 20_000);

  it("a start superseded by a newer config build hands its awaiter the CURRENT registry — never the stale one", async () => {
    // The production shape: a status-read start (superseded config) racing a
    // config-change rebuild. Both awaiters must end up with the SAME registry
    // object — the one built from the CURRENT config — and the discarded
    // generation's discovery must never linger in the tools map.
    const { ensureMcpRuntimeStarted, getDiscoveredMcpTools } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const first = ensureMcpRuntimeStarted();
    // Edit the config mid-flight: the second start is a NEW generation and
    // supersedes the first (the fingerprint covers the server list).
    writeConfig([{ ...GOOD_SERVER, id: "fake2" }]);
    const second = await ensureMcpRuntimeStarted();
    expect(second.getServerSignals("fake2")?.status).toBe("connected");
    const stale = await first;
    expect(
      stale,
      "the superseded awaiter receives the CURRENT registry (its own build was stopped + discarded)",
    ).toBe(second);
    expect(
      getDiscoveredMcpTools().map((t) => t.id),
      "only the current generation's discovery survives — the discarded build's tools never linger",
    ).toEqual(["mcp__fake2__ping"]);
  }, 20_000);

  it("an in-flight build exposes NO partial discovery, and a superseded build's discovery never lingers", async () => {
    // Two servers: "mark" answers the full handshake and writes a marker
    // file only AFTER its tools/list response bytes are flushed to the pipe
    // (so the marker is proof its discovery has been SENT); "stall" never
    // speaks and exits on its own shortly after — the build stays genuinely
    // in flight long after "mark" is discovered. Writing registrations into
    // the shared map as they arrive would expose the partial set mid-flight
    // AND orphan it on supersession (the fenced unregister of a discarded
    // build deliberately skips the delete). Discovery must publish wholesale
    // per generation — so mid-flight the map is EMPTY, and after the
    // superseding build lands, the map is EXACTLY the current discovery.
    writeConfig([MARK_SERVER, STALL_SERVER]);
    const { ensureMcpRuntimeStarted, mcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const first = ensureMcpRuntimeStarted();
    await waitForMarkerFile(markerPath, "the marker server's discovery was sent");
    // The response bytes were in the kernel pipe before the marker existed;
    // give the loop a bounded margin to deliver them + run the registration
    // before judging the map (delivery is certain within these turns — the
    // data preceded the marker).
    for (let turn = 0; turn < 25; turn += 1) {
      await new Promise((resolve) => { setImmediate(resolve); });
    }
    expect(
      mcpRuntimeStarted(),
      "the build is still in flight — the stall server never connects",
    ).toBe(false);
    expect(
      await getDiscoveredIds(),
      "an in-flight build publishes NOTHING — discovery lands wholesale, not piecemeal",
    ).toEqual([]);
    // Supersede the in-flight build with a newer config.
    writeConfig([{ ...GOOD_SERVER, id: "fake2" }]);
    const second = await ensureMcpRuntimeStarted();
    expect(second.getServerSignals("fake2")?.status).toBe("connected");
    expect(await first, "the superseded awaiter receives the current registry").toBe(second);
    expect(
      await getDiscoveredIds(),
      "the superseded build's discovery died with it — no discarded entry lingers beside the current one",
    ).toEqual(["mcp__fake2__ping"]);
  }, 20_000);

  it("a dispatch racing teardown fails TYPED on the stopped registry — never a hang, never a phantom", async () => {
    // `callMcpTool` awaits the start, then dispatches on the registry it was
    // handed. When teardown lands between the two awaits, the dispatch hits
    // a stopped registry: the honest outcome is the typed refusal, and the
    // failure classifies as unavailable — the runtime the tool needed is
    // deliberately down, the tool itself was never broken.
    const { ensureMcpRuntimeStarted, stopAllMcpConnections, isMcpUnavailableError } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const registry = await ensureMcpRuntimeStarted();
    expect(registry.getServerSignals("fake")?.status).toBe("connected");
    await stopAllMcpConnections();
    const refusal = await registry.callTool("fake", "ping", { text: "hi" }).then(
      () => { throw new Error("a dispatch on a torn-down registry must not succeed"); },
      (err: unknown) => err,
    );
    expect(refusal).toMatchObject({
      name: "McpError",
      // A known server whose client is gone is a CONNECTIVITY refusal — the
      // runtime the tool needed is deliberately down, not "not registered"
      // (a server that exists must never be told to register).
      code: "mcp_not_connected",
      retryable: false,
    });
    expect(
      isMcpUnavailableError(refusal),
      "a tool racing teardown finds the runtime deliberately down — unavailable, never an installed-tool failure",
    ).toBe(true);
  }, 20_000);

  it("a FINAL teardown seals the lazy-start door — a consumer racing shutdown is refused typed, never a resurrection", async () => {
    // The defect: any consumer (status poll, manifest build, tool call) after
    // the process-exit teardown used to rebuild the registry lazily — a fresh
    // registry + stdio children outliving the shutdown sequence that just
    // drained them. The seal makes the single door refuse instead.
    writeConfig([GOOD_SERVER]);
    const {
      ensureMcpRuntimeStarted, stopAllMcpConnections, callMcpTool,
      getLiveMcpServerSignals, mcpRuntimeStarted, isMcpRuntimeShutDownError,
      resetMcpRuntimeForTests,
    } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const registry = await ensureMcpRuntimeStarted();
    expect(registry.getServerSignals("fake")?.status).toBe("connected");

    // The seal lands at ENTRY, not at the end of the drain: a consumer fired
    // while the drain is still running must already be refused (a seal that
    // waits for the drain to finish lets a mid-drain start resurrect).
    const teardown = stopAllMcpConnections({ final: true });
    await expect(
      ensureMcpRuntimeStarted(),
      "a start fired mid-drain must refuse — the seal precedes the drain",
    ).rejects.toMatchObject({ name: "McpError", code: "mcp_runtime_shut_down" });
    await teardown;

    // Every lazy-start path refuses typed — the runtime is deliberately down.
    await expect(ensureMcpRuntimeStarted()).rejects.toMatchObject({ name: "McpError", code: "mcp_runtime_shut_down", retryable: false });
    await expect(callMcpTool("mcp__fake__ping", { text: "hi" })).rejects.toMatchObject({ name: "McpError", code: "mcp_runtime_shut_down" });
    expect(isMcpRuntimeShutDownError(await ensureMcpRuntimeStarted().then(
      () => { throw new Error("a shut-down runtime must never start"); },
      (err: unknown) => err,
    ))).toBe(true);
    // The status surface answers honestly empty and does NOT resurrect: no
    // registry materialises, no stdio child is spawned behind the seal.
    expect(await getLiveMcpServerSignals()).toEqual([]);
    expect(mcpRuntimeStarted(), "a status read behind the seal must not resurrect the runtime").toBe(false);
    // The manifest kick refuses behind the seal too (its catch treats the
    // refusal as the fence working, exactly like supersession).
    const { invalidateToolManifestCache, getToolManifest } = await import("../../server/tools/tools-bridge.ts");
    const { isMcpToolName } = await import("../../engine/src/mcp/tool-name.ts");
    invalidateToolManifestCache();
    // Asked by the naming owner's own predicate and the category, never by a
    // spelling: the old `startsWith("mcp:")` could no longer be true at all.
    expect(getToolManifest().filter((t) => isMcpToolName(t.name) || t.category === "mcp"), "no MCP entries exist behind the seal").toEqual([]);
    expect(mcpRuntimeStarted(), "a manifest build behind the seal must not resurrect the runtime").toBe(false);
    await expectNoOwnedFakeServers("nothing respawned behind the final seal");

    // The seal is per-world, not permanent: the test-reset door lifts it and
    // a fresh world starts + calls again. Without this half, "the seal
    // persists forever" would only be caught by suite-order accidents.
    resetMcpRuntimeForTests();
    const reopen = await ensureMcpRuntimeStarted().then(() => null, (err: unknown) => err);
    expect(
      reopen,
      "a test reset reopens the world — the seal guards the dying process, never the next world",
    ).toBeNull();
    const reopened = await ensureMcpRuntimeStarted();
    expect(reopened.getServerSignals("fake")?.status).toBe("connected");
    await stopAllMcpConnections();
  }, 20_000);

  it("the fence arms drive the SHARED fixture — no divergent inline -e protocol server lives in this file", () => {
    // The engine owns the fake MCP server's JSON-RPC replies
    // (fake-mcp-server.mjs): initialize/tools/list/tools/call. An inline
    // `-e` copy of those handlers is a second source of truth that drifts
    // (the marker + stall arms already drift once, they are retired onto
    // `--mark` / `--silent`). Any future arm swims through the fixture.
    const source = readFileSync(fileURLToPath(new URL("./mcp-runtime.test.ts", import.meta.url)), "utf8");
    expect(source, "witness: this file does drive the shared fixture").toContain("fake-mcp-server.mjs");
    expect(source, "the fixture owns the protocol replies — never an inline copy").not.toMatch(/method\s*===\s*["']initialize["']/);
    expect(source, "the fixture owns the protocol replies — never an inline copy").not.toMatch(/method\s*===\s*["']tools\/list["']/);
  });

  it("writeFileWithFreshMtime enforces the mode option on REWRITE, not only on creation", () => {
    // Node's `writeFileSync` mode applies only when CREATING the file: a
    // rewrite passing mode would leave the old mode in place while the
    // caller believes they set it — exactly how a 0600-required config can
    // stay looser after a rewrite that landed looser by umask. The helper's
    // contract is the stronger one: the file ENDS at the asked mode.
    const probe = join(scratch, "mode-probe.txt");
    writeFileSync(probe, "seed", { encoding: "utf8", mode: 0o644 });
    writeFileWithFreshMtime(probe, "tightened", { mode: 0o600 });
    expect(readFileSync(probe, "utf8"), "witness: the helper's write happened").toBe("tightened");
    expect(
      statSync(probe).mode & 0o777,
      "a rewrite through the helper must END at the asked mode — never keep the stale one silently",
    ).toBe(0o600);
  });

  it("writeFileWithFreshMtime publishes by atomic replace — a hardlink keeps the OLD inode + OLD bytes, the target a NEW inode (never truncated in place)", () => {
    // The window this closes: a write-then-chmod/write-then-stamp ON the
    // target exposes an observable state where the target has new content
    // with its pre-write mode/mtime. Temp-prepare + one rename has no such
    // state. The inode-identity proof drives it: hardlinking the target
    // before the rewrite pins the old inode; after a correct publish the
    // link still holds the OLD bytes on the OLD inode while the target name
    // points at a NEW inode carrying the new content, mode and stamp
    // together. An in-place rewrite would show the NEW bytes AND the NEW
    // stamp through the link (same inode), and would leave the target's mode
    // behind the content.
    const target = join(scratch, "atomic-probe.txt");
    const link = join(scratch, "atomic-probe-link.txt");
    writeFileWithFreshMtime(target, "first", { mode: 0o600 });
    linkSync(target, link);
    const beforeInode = statSync(target).ino;
    const stamped = writeFileWithFreshMtime(target, "second", { mode: 0o400 });

    const afterTarget = statSync(target);
    expect(afterTarget.ino, "the publish is a replace, not an in-place truncate").not.toBe(beforeInode);
    expect(statSync(link).ino, "the hardlink keeps the OLD inode").toBe(beforeInode);
    expect(readFileSync(link, "utf8"), "the old inode still holds the OLD bytes — an in-place rewrite would corrupt the link").toBe("first");
    expect(readFileSync(target, "utf8"), "witness: the new content published").toBe("second");
    expect(afterTarget.mode & 0o777, "mode and content publish TOGETHER through the rename").toBe(0o400);
    expect(readMtimeMs(target), "the stamp prepared on the temp travels through the rename").toBe(stamped);
  });

  it("consecutive writeConfig calls always produce STRICTLY INCREASING mtimes (the cache can never serve a stale write)", () => {
    // The flake this guards: two writes landing in the same wall-clock
    // millisecond used to compute the SAME forced mtime, so the mtime-keyed
    // config cache served the FIRST write's content for the second (a
    // registry was then built from the previous test's server list). Under a
    // FROZEN clock — the worst case — the helper's stamps must still
    // increase; the clock leg of the stamp is a floor, never the guarantee.
    const realNow = Date.now;
    let first: number;
    let second: number;
    try {
      Date.now = () => 1_800_000_000_000;
      writeConfig([GOOD_SERVER]);
      first = readMtimeMs(configPath);
      writeConfig([{ ...GOOD_SERVER, env: { X: "1" } }]);
      second = readMtimeMs(configPath);
    } finally {
      Date.now = realNow;
    }
    expect(second, "a frozen clock must never collide two forced mtimes").toBeGreaterThan(first);
    // With the clock restored (now BEHIND the stamps just written, because
    // they were placed in the future) the next write must STILL outbid its
    // predecessor — monotonicity comes from the previous stamp, not the clock.
    writeConfig([GOOD_SERVER]);
    expect(readMtimeMs(configPath), "a stamp always outbids the previous stamp, even with the clock behind it").toBeGreaterThan(second);
  });
});

async function getDiscoveredIds(): Promise<readonly string[]> {
  const { getDiscoveredMcpTools } = await import("../../server/integrations/mcp-runtime-bridge.ts");
  return getDiscoveredMcpTools().map((t) => t.id);
}

/**
 * The count of THIS worker's live fake-mcp-server stdio children, read from
 * procfs through its owner (ppid + cmdline) — no subprocess spawned, and scoped to
 * this process so parallel files and workers cannot disturb the count. The
 * fixture exits on stdin end, so a properly stopped client's child always
 * disappears; a child that outlives its registry's stop is a leak.
 */
function ownedFakeServerCount(): number {
  if (!procfsAvailable()) throw new Error("the leaked-child witness cannot read procfs on this platform");
  return allProcessIds().filter((pid) =>
    parentOf(pid) === process.pid && isProcessAlive(pid) && (commandLineOf(pid) ?? []).join(" ").includes("fake-mcp-server.mjs")).length;
}

/**
 * Assert that every fake-mcp-server child this worker ever spawned is gone.
 * Polls a real condition with a hard deadline — a child stopped correctly
 * exits within milliseconds (stdin end → exit(0)); a leaked child idles
 * forever, so the deadline only ever bites the defect it watches for.
 */
async function expectNoOwnedFakeServers(why: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const count = ownedFakeServerCount();
    if (count === 0) return;
    if (Date.now() > deadline) {
      expect.fail(`${why} — ${count} fake-mcp-server child process(es) still alive under this worker: a discarded registry's stdio child was never stopped`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

/**
 * Wait for the marker server's discovery-sent proof. A bound exists so the
 * arm can never pass vacuously: without the marker, nothing below has been
 * exercised, and the arm says so rather than judging an un-driven fixture.
 */
async function waitForMarkerFile(path: string, why: string): Promise<void> {
  const deadline = Date.now() + 3_500;
  for (;;) {
    if (existsSync(path)) return;
    if (Date.now() > deadline) {
      expect.fail(`${why} — the marker never appeared: the fixture never completed discovery, so this arm proved nothing (liveness)`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

describe("mcp-runtime-bridge: a stdio server's host placement — its own home, an allowlisted environment, the confinement owner's door", () => {
  it("runs in a harness-owned home (cwd = HOME, 0700) with ONLY the subprocess allowlist and its own configured env — no secret inherited", async () => {
    process.env["BRIDLEWISE_MCP_TEST_SECRET"] = "sk-must-not-reach-an-mcp-server";
    try {
      writeConfig([PROBE_SERVER]);
      const { ensureMcpRuntimeStarted, callMcpTool } = await import("../../server/integrations/mcp-runtime-bridge.ts");
      const { mcpServerHomeDir } = await import("../../server/safety/landlock-runner.ts");
      const { mcpModuleDefaults } = await import("../../server/integrations/mcp-runtime-bridge.ts");
      await ensureMcpRuntimeStarted();
      const home = mcpServerHomeDir("probe");
      expect(await callMcpTool("mcp__probe__cwd", {})).toBe(home);
      expect(await callMcpTool("mcp__probe__home", {})).toBe(home);
      expect(statSync(home).mode & 0o777, "the home is private to this account").toBe(0o700);
      const names = JSON.parse(await callMcpTool("mcp__probe__env", {})) as string[];
      expect(names).not.toContain("BRIDLEWISE_MCP_TEST_SECRET");
      expect(names).toContain("CONFIGURED_FOR_PROBE");
      // The MCP list (`tools.mcp.stdioInheritedEnv`), not execute_command's allowlist.
      const allowed = new Set([...mcpModuleDefaults().stdioInheritedEnv, "HOME", "TMPDIR", "TMP", "TEMP", "CONFIGURED_FOR_PROBE"]);
      expect(names.filter((n) => !allowed.has(n)), "every variable is the MCP list's, HOME, the temp-folder variables (the spawn door's), or the entry's own").toEqual([]);
      expect(names, "TMPDIR points inside the home").toContain("TMPDIR");
    } finally {
      delete process.env["BRIDLEWISE_MCP_TEST_SECRET"];
    }
  }, 20_000);

  it("the census says how the child runs: unconfined only because the operator turned confinement off, with the reason", async () => {
    writeConfig([PROBE_SERVER]);
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const { componentSnapshot } = await import("../../server/observability/component-registry.ts");
    await ensureMcpRuntimeStarted();
    const child = componentSnapshot().find((c) => c.kind === "mcp-child" && (c.facts as Record<string, unknown> | undefined)?.["serverId"] === "probe");
    expect(child, "the probe child is a census component").toBeDefined();
    expect((child!.facts as Record<string, unknown>)["confinement"]).toBe("unconfined");
    expect(String((child!.facts as Record<string, unknown>)["reason"]).length).toBeGreaterThan(0);
  }, 20_000);

  it("with confinement asked for and not available the server is REFUSED — typed status, nothing started, never an unconfined fallback", async () => {
    // This test world's harness root (the config's own folder) has no
    // guardian, so the confinement owner answers "unavailable".
    writeConfig([PROBE_SERVER], undefined, undefined, true);
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const { componentSnapshot } = await import("../../server/observability/component-registry.ts");
    const registry = await ensureMcpRuntimeStarted();
    const signals = registry.getServerSignals("probe")!;
    expect(signals.status).toBe("error");
    expect(signals.lastErrorCode).toBe("mcp_spawn_refused");
    expect(componentSnapshot().some((c) => c.kind === "mcp-child"), "no MCP child was started").toBe(false);
  }, 20_000);

  it("a ${VAR} naming a variable tools.mcp.credentialEnv does not permit — the database passphrase — is refused typed, and nothing is read or started", async () => {
    process.env["HARNESS_WEB_DB_KEY_PROBE"] = "must-never-reach-a-tool-server";
    try {
      writeConfig([{ ...PROBE_SERVER, env: { TOKEN: "${HARNESS_WEB_DB_KEY_PROBE}" } }]);
      const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
      const { componentSnapshot } = await import("../../server/observability/component-registry.ts");
      const { knownSecretLabels } = await import("../../engine/src/privacy/secret-intelligence.ts");
      const registry = await ensureMcpRuntimeStarted();
      const signals = registry.getServerSignals("probe")!;
      expect(signals.status).toBe("error");
      expect(signals.lastErrorCode).toBe("mcp_credential_env_refused");
      expect(signals.lastError).toContain("HARNESS_WEB_DB_KEY_PROBE");
      expect(signals.lastError).toContain("tools.mcp.credentialEnv");
      expect(knownSecretLabels().some((label) => label.includes("HARNESS_WEB_DB_KEY_PROBE")), "the value was never even read").toBe(false);
      expect(componentSnapshot().some((c) => c.kind === "mcp-child"), "no process carries it").toBe(false);
    } finally {
      delete process.env["HARNESS_WEB_DB_KEY_PROBE"];
    }
  }, 20_000);

  it("an unset ${VAR} credential is 'not connected' (mcp_credential_missing, naming the variable) and nothing is started", async () => {
    delete process.env["BRIDLEWISE_UNSET_MCP_TOKEN"];
    writeConfig([{ ...PROBE_SERVER, env: { TOKEN: "${BRIDLEWISE_UNSET_MCP_TOKEN}" } }]);
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const { componentSnapshot } = await import("../../server/observability/component-registry.ts");
    const registry = await ensureMcpRuntimeStarted();
    const signals = registry.getServerSignals("probe")!;
    expect(signals.status).toBe("error");
    expect(signals.lastErrorCode).toBe("mcp_credential_missing");
    expect(signals.lastError).toContain("BRIDLEWISE_UNSET_MCP_TOKEN");
    expect(componentSnapshot().some((c) => c.kind === "mcp-child"), "no request and no process carries the placeholder").toBe(false);
  }, 20_000);

  it("annotations reach the manifest: the probe's write tool is classified write, its readers read", async () => {
    writeConfig([PROBE_SERVER]);
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const { invalidateToolManifestCache, getToolManifest } = await import("../../server/tools/tools-bridge.ts");
    await ensureMcpRuntimeStarted();
    invalidateToolManifestCache();
    const byName = new Map(getToolManifest().filter((t) => t.category === "mcp").map((t) => [t.name, [...t.capabilities]] as const));
    expect(byName.get("mcp__probe__write")).toContain("write");
    expect(byName.get("mcp__probe__read")).not.toContain("write");
  }, 20_000);
});

describe("the live tool manifest is spec-legal — built-ins plus a real MCP discovery", () => {
  it("every advertised name is a legal Responses function name, no built-in wears the MCP prefix, and the projection accepts the whole set", async () => {
    writeConfig([PROBE_SERVER]);
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const { invalidateToolManifestCache, getToolManifest } = await import("../../server/tools/tools-bridge.ts");
    const { FUNCTION_NAME_PATTERN, toolsToResponses } = await import("../../engine/src/shared/llm/responses.ts");
    const { isMcpToolName } = await import("../../engine/src/mcp/tool-name.ts");
    await ensureMcpRuntimeStarted();
    invalidateToolManifestCache();
    const manifest = getToolManifest();
    // LIVENESS: both halves are really present.
    expect(manifest.some((t) => t.category === "mcp")).toBe(true);
    expect(manifest.some((t) => t.category === "built-in")).toBe(true);
    expect(manifest.filter((t) => !FUNCTION_NAME_PATTERN.test(t.name)).map((t) => t.name)).toEqual([]);
    expect(manifest.filter((t) => t.category !== "mcp" && isMcpToolName(t.name)).map((t) => t.name), "the MCP namespace belongs to MCP tools only").toEqual([]);
    expect(manifest.filter((t) => t.category === "mcp" && !isMcpToolName(t.name)).map((t) => t.name)).toEqual([]);
    const projected = toolsToResponses(manifest.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })));
    expect(projected.length).toBe(manifest.length);
  }, 20_000);
});
