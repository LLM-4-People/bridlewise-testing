import assert from "node:assert/strict";
import test from "node:test";

import {
  createMcpRegistry,
  normalizeMcpModuleConfig,
  type McpRegistry,
  type McpModuleConfig,
  type McpServerEntry,
  type McpToolRegistration,
} from "../../src/mcp/index.ts";
import type { McpClient, McpTool } from "../../src/mcp/core.ts";
import { McpError } from "../../src/mcp/errors.ts";
import type { RegisteredTool } from "../../src/runtime/tool-registry.ts";
import { startStreamableHttpServer } from "./fixtures/streamable-http-server.ts";

// ---------------------------------------------------------------------------
// Mock MCP client — simulates a server that exposes tools, can crash, and
// can fail transiently. Lets us exercise the registry without real processes.
// ---------------------------------------------------------------------------

type MockBehavior = {
  tools: readonly McpTool[];
  connectFailures: number;     // fail connect() this many times before success
  callFailures: Readonly<Record<string, number>>; // per-tool transient failures
  transportCloseAfterCalls: number; // drop the transport once at the Nth total call
  restartSucceeds: boolean;
};

/** Per-server behavior map. Servers not in the map use `defaultBehavior`. */
function makeMockClientFactory(perServer: Readonly<Record<string, MockBehavior>>, defaultBehavior: MockBehavior, state: { calls: number; closed: number; connectAttempts: number }) {
  return (entry: McpServerEntry, opts: any): McpClient => {
    const behavior = perServer[entry.id] ?? defaultBehavior;
    let connected = false;
    let calls = 0;
    let myConnectAttempts = 0;
    const onTransportClose = opts?.onTransportClose;
    return {
      serverId: entry.id,
      get connected() { return connected; },
      connect: async () => {
        myConnectAttempts += 1;
        state.connectAttempts += 1;
        if (myConnectAttempts <= behavior.connectFailures) {
          throw new McpError("connect failed (transient)", "mcp_connect_failed", true, {});
        }
        connected = true;
        return { name: entry.id, version: "1.0.0" };
      },
      listTools: async () => behavior.tools,
      callTool: async (name: string, _args: Readonly<Record<string, unknown>>) => {
        state.calls += 1;
        calls += 1;
        if (behavior.transportCloseAfterCalls > 0 && state.calls === behavior.transportCloseAfterCalls && connected) {
          connected = false;
          onTransportClose?.();
          throw new McpError("transport dropped", "mcp_transport_closed", true, {});
        }
        const fails = behavior.callFailures[name] ?? 0;
        if (calls <= fails) {
          throw new McpError(`transient call fail for ${name}`, "mcp_transient", true, {});
        }
        return { content: [{ type: "text", text: `result:${name}` }], isError: false };
      },
      close: async () => { connected = false; state.closed += 1; },
    };
  };
}

const TOOLS: readonly McpTool[] = [
  { name: "read_file", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "list_dir", description: "list a dir", inputSchema: { type: "object", properties: {} } },
];

function makeConfig(servers: readonly McpServerEntry[]): McpModuleConfig {
  return normalizeMcpModuleConfig({
    servers,
    defaults: { retry: { count: 3, backoffMs: 1 }, timeoutMs: 5000, protocolVersion: "2025-11-25" },
  });
}

function makeRegistry(config: McpModuleConfig, factory: any): { registry: McpRegistry; registered: RegisteredTool[]; registrations: McpToolRegistration[]; unregistered: string[] } {
  const registered: RegisteredTool[] = [];
  const registrations: McpToolRegistration[] = [];
  const unregistered: string[] = [];
  const registry = createMcpRegistry({
    config, clientFactory: factory,
    registerTool: (t, registration) => { registered.push(t); registrations.push(registration); },
    unregisterTool: (id) => { unregistered.push(id); },
    clientInfo: { name: "test-client", version: "1.0.0" },
    defaultProtocolVersion: "2025-11-25",
    defaultTimeoutMs: 5000,
  });
  return { registry, registered, registrations, unregistered };
}

// ---------------------------------------------------------------------------
// Easy tool addition: start → discover → register with zero per-tool code
// ---------------------------------------------------------------------------

test("registry: start discovers tools and registers them — zero per-tool code", async () => {
  const state = { calls: 0, closed: 0, connectAttempts: 0 };
  const factory = makeMockClientFactory({}, { tools: TOOLS, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true }, state);
  const { registry, registered } = makeRegistry(makeConfig([{ id: "fs", transport: "stdio", command: "npx" }]), factory);
  const result = await registry.start();
  assert.deepEqual(result.started, ["fs"]);
  assert.equal(result.errors.length, 0);
  assert.equal(registered.length, 2);
  assert.deepEqual(registered.map((t) => t.definition.function.name).toSorted(), ["mcp__fs__list_dir", "mcp__fs__read_file"]);
});

test("registry: each registration carries the minted name, the (server, tool) pair it resolves to, and the annotation-derived classification", async () => {
  const state = { calls: 0, closed: 0, connectAttempts: 0 };
  const tools: readonly McpTool[] = [
    { name: "admin.tools.list", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: "write_file", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: "no_hints", inputSchema: { type: "object" } },
  ];
  const factory = makeMockClientFactory({}, { tools, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true }, state);
  const { registry, registered, registrations } = makeRegistry(makeConfig([{ id: "srv", transport: "http", url: "https://x.com/mcp" }]), factory);
  await registry.start();
  assert.deepEqual(registrations.map((r) => [r.serverId, r.tool.name]), [["srv", "admin.tools.list"], ["srv", "write_file"], ["srv", "no_hints"]]);
  assert.deepEqual(registrations.map((r) => r.name), registered.map((t) => t.definition.function.name), "the registration names what the registered tool is called");
  assert.match(registrations[0]!.name, /^mcp__srv__admin_tools_list_[0-9a-f]{8}$/u, "a name with '.' is sanitised and disambiguated by the digest");
  assert.deepEqual(registrations.map((r) => [...r.manifest.capabilities]), [["read"], ["write", "network"], ["write", "network"]], "read only when declared read-only; absent hints fail closed to write");
});

test("registry: two tools that mint one harness name make the server an error that contributes nothing", async () => {
  const state = { calls: 0, closed: 0, connectAttempts: 0 };
  const tools: readonly McpTool[] = [TOOLS[0]!, TOOLS[0]!];
  const factory = makeMockClientFactory({}, { tools, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true }, state);
  const { registry, registered } = makeRegistry(makeConfig([{ id: "fs", transport: "stdio", command: "npx" }]), factory);
  const result = await registry.start();
  assert.deepEqual(result.started, []);
  assert.equal(registered.length, 0);
  const signals = registry.getServerSignals("fs")!;
  assert.equal(signals.status, "error");
  assert.equal(signals.lastErrorCode, "mcp_tool_name_collision");
});

test("registry: a client factory that refuses the entry is the server's typed status, never an escape", async () => {
  const refusing = () => { throw new McpError("credential variable X is not set", "mcp_credential_missing", false, {}); };
  const { registry } = makeRegistry(makeConfig([{ id: "fs", transport: "stdio", command: "npx" }]), refusing);
  const result = await registry.start();
  assert.equal(result.errors.length, 1);
  const signals = registry.getServerSignals("fs")!;
  assert.equal(signals.status, "error", "never left 'connecting'");
  assert.equal(signals.lastErrorCode, "mcp_credential_missing");
});

test("registry: an older config's retired 'sse' entry and an id with '_' fail PER SERVER, typed — the valid server still connects and dispatches", async () => {
  const state = { calls: 0, closed: 0, connectAttempts: 0 };
  const factory = makeMockClientFactory({}, { tools: TOOLS, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true }, state);
  const legacy = [
    { id: "old-sse", transport: "sse", url: "https://x.com/sse" },
    { id: "my_server", transport: "stdio", command: "npx" },
    { id: "fs", transport: "stdio", command: "npx" },
  ] as unknown as McpServerEntry[];
  const { registry, registered } = makeRegistry(makeConfig(legacy), factory);
  const result = await registry.start();
  assert.deepEqual(result.started, ["fs"]);
  assert.deepEqual(result.errors.map((e) => [e.serverId, e.code]).toSorted(), [["my_server", "mcp_config_invalid"], ["old-sse", "mcp_config_invalid"]]);
  for (const id of ["old-sse", "my_server"]) {
    const signals = registry.getServerSignals(id)!;
    assert.equal(signals.status, "error");
    assert.equal(signals.lastErrorCode, "mcp_config_invalid");
    assert.match(signals.lastError ?? "", /configuration is not valid/u);
  }
  assert.equal(state.connectAttempts, 1, "an invalid entry is never handed to the factory");
  assert.equal(registered.length, 2);
  assert.deepEqual(registry.resolveToolName("mcp__fs__read_file"), { serverId: "fs", toolName: "read_file" }, "one reverse lookup of the minted names");
  assert.equal(registry.resolveToolName("mcp__my_server__read_file"), undefined);
  await registry.stop("old-sse");
  assert.equal(registry.getServerSignals("old-sse")!.status, "error", "stopping an invalid entry is not a repair");
});

test("registry: a name is minted once per registration and resolved by lookup — stop, disable and enable use the stored name", async () => {
  const state = { calls: 0, closed: 0, connectAttempts: 0 };
  const tools: readonly McpTool[] = [{ name: "admin.tools.list", inputSchema: { type: "object" } }];
  const factory = makeMockClientFactory({}, { tools, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true }, state);
  const { registry, registrations, unregistered } = makeRegistry(makeConfig([{ id: "srv", transport: "http", url: "https://x.com/mcp" }]), factory);
  await registry.start();
  const minted = registrations[0]!.name;
  assert.deepEqual(registry.resolveToolName(minted), { serverId: "srv", toolName: "admin.tools.list" });
  assert.equal(registry.getToolSignals("srv", "admin.tools.list")!.id, minted);
  registry.disableTool("srv", "admin.tools.list");
  assert.deepEqual(registry.resolveToolName(minted), { serverId: "srv", toolName: "admin.tools.list" }, "a disabled tool still resolves (its call is refused with its own cause)");
  await assert.rejects(() => registry.callTool("srv", "admin.tools.list", {}), (e: unknown) => e instanceof McpError && e.code === "mcp_tool_disabled");
  registry.enableTool("srv", "admin.tools.list");
  assert.deepEqual(registry.resolveToolName(minted), { serverId: "srv", toolName: "admin.tools.list" });
  await registry.stop("srv");
  assert.equal(registry.resolveToolName(minted), undefined);
  assert.deepEqual(unregistered, [minted, minted]);
});

test("registry: start skips disabled servers (enabled:false)", async () => {
  const state = { calls: 0, closed: 0, connectAttempts: 0 };
  const factory = makeMockClientFactory({}, { tools: TOOLS, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true }, state);
  const { registry, registered } = makeRegistry(makeConfig([{ id: "fs", transport: "stdio", command: "npx", enabled: false }]), factory);
  const result = await registry.start();
  assert.equal(result.started.length, 0);
  assert.equal(registered.length, 0);
});

test("registry: start collects errors for failing servers but continues others", async () => {
  const state = { calls: 0, closed: 0, connectAttempts: 0 };
  // fs connects fine; broken fails connect 3 times (retry budget) then gives up.
  const factory = makeMockClientFactory({ broken: { tools: TOOLS, connectFailures: 5, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true } }, { tools: TOOLS, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true }, state);
  const { registry, registered } = makeRegistry(makeConfig([
    { id: "fs", transport: "stdio", command: "npx" },
    { id: "broken", transport: "stdio", command: "npx", retry: { count: 2, backoffMs: 1 } },
  ]), factory);
  const result = await registry.start();
  assert.deepEqual(result.started, ["fs"]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.serverId, "broken");
  assert.equal(registered.length, 2); // only fs's tools
});

test("registry: a registered server whose connect failed is refused as not-connected — never misreported as not-registered", async () => {
  // The connect-failure path clears the client but keeps the server state, so
  // a conflated guard reports "not registered" for a server that IS
  // configured — the pause text then asks the user to configure what already
  // exists. The two unknowns are different refusals: an id the registry has
  // never heard of is not-registered; a known id without a client is
  // not-connected (connectivity, retryable — a reconnect attempt may fix it).
  const state = { calls: 0, closed: 0, connectAttempts: 0 };
  const factory = makeMockClientFactory(
    { dead: { tools: TOOLS, connectFailures: 5, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: false } },
    { tools: TOOLS, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true },
    state,
  );
  const { registry } = makeRegistry(makeConfig([
    { id: "dead", transport: "stdio", command: "npx", retry: { count: 1, backoffMs: 1 } },
  ]), factory);
  const result = await registry.start();
  assert.deepEqual(result.started, [], "witness: the connect really failed — the server is stuck without a client");
  assert.equal(result.errors[0]!.serverId, "dead");
  const refusal = await registry.callTool("dead", "read_file", { path: "x" }).then(
    () => { throw new Error("a call on a connect-failed server must not succeed"); },
    (err: unknown) => err,
  );
  assert.ok(refusal instanceof McpError);
  assert.equal(
    refusal.code,
    "mcp_not_connected",
    "a configured-but-dead server is a connectivity refusal — 'not registered' would send the user to configure a server that exists",
  );
  assert.equal(refusal.retryable, false, "this door throws before the retry wrapper — nothing self-heals a clientless state here; the way back is a start()");
  // The other half of the guard keeps its own name.
  const unknown = await registry.callTool("ghost", "read_file", { path: "x" }).then(
    () => { throw new Error("a call on an unregistered server must not succeed"); },
    (err: unknown) => err,
  );
  assert.ok(unknown instanceof McpError);
  assert.equal(unknown.code, "mcp_server_not_registered", "an id the registry has never heard of IS not-registered");
  assert.equal(unknown.retryable, false);
});

// ---------------------------------------------------------------------------
// Seamless retry: a transiently failing tool call succeeds via retry
// ---------------------------------------------------------------------------

test("registry: callTool retries transient failures and succeeds", async () => {
  const state = { calls: 0, closed: 0, connectAttempts: 0 };
  const factory = makeMockClientFactory({ fs: { tools: TOOLS, connectFailures: 0, callFailures: { read_file: 2 }, transportCloseAfterCalls: 0, restartSucceeds: true } }, { tools: TOOLS, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true }, state);
  const { registry } = makeRegistry(makeConfig([{ id: "fs", transport: "stdio", command: "npx", retry: { count: 5, backoffMs: 1 } }]), factory);
  await registry.start();
  const result = await registry.callTool("fs", "read_file", { path: "/x" });
  assert.equal(result.isError, false);
  assert.equal(result.content[0]!.text, "result:read_file");
  // Should have retried — retryCount tracks attempts beyond the first.
  const signals = registry.getServerSignals("fs")!;
  assert.ok(signals.retryCount >= 2, `expected retryCount>=2, got ${signals.retryCount}`);
});

// ---------------------------------------------------------------------------
// Server crash: transport drops → registry restarts → next call succeeds
// ---------------------------------------------------------------------------

test("registry: transport drop triggers restart and next call succeeds", async () => {
  const state = { calls: 0, closed: 0, connectAttempts: 0 };
  // Drop the transport on the 2nd call. After restart, the factory makes a
  // fresh client (state.calls keeps incrementing but the new client's local
  // `calls` resets, so it won't re-drop).
  const factory = makeMockClientFactory({ fs: { tools: TOOLS, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 2, restartSucceeds: true } }, { tools: TOOLS, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true }, state);
  const { registry } = makeRegistry(makeConfig([{ id: "fs", transport: "stdio", command: "npx", retry: { count: 5, backoffMs: 1 } }]), factory);
  await registry.start();
  // 1st call: succeeds (state.calls=1)
  const r1 = await registry.callTool("fs", "read_file", {});
  assert.equal(r1.content[0]!.text, "result:read_file");
  // 2nd call: transport drops (state.calls=2 → onTransportClose fires), retry reconnects, call succeeds
  const r2 = await registry.callTool("fs", "read_file", {});
  assert.equal(r2.content[0]!.text, "result:read_file");
  // The server should be connected again after restart.
  const signals = registry.getServerSignals("fs")!;
  assert.equal(signals.status, "connected");
});

// ---------------------------------------------------------------------------
// Disable / enable a tool
// ---------------------------------------------------------------------------

test("registry: disableTool unregisters and enableTool re-registers", async () => {
  const state = { calls: 0, closed: 0, connectAttempts: 0 };
  const factory = makeMockClientFactory({}, { tools: TOOLS, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true }, state);
  const { registry, registered, unregistered } = makeRegistry(makeConfig([{ id: "fs", transport: "stdio", command: "npx" }]), factory);
  await registry.start();
  assert.equal(registered.length, 2);
  registry.disableTool("fs", "read_file");
  assert.ok(unregistered.includes("mcp__fs__read_file"));
  // Calling a disabled tool throws.
  await assert.rejects(() => registry.callTool("fs", "read_file", {}));
  registry.enableTool("fs", "read_file");
  const r = await registry.callTool("fs", "read_file", {});
  assert.equal(r.content[0]!.text, "result:read_file");
});

// ---------------------------------------------------------------------------
// Stop / stopAll
// ---------------------------------------------------------------------------

test("registry: stop unregisters tools and marks server stopped", async () => {
  const state = { calls: 0, closed: 0, connectAttempts: 0 };
  const factory = makeMockClientFactory({}, { tools: TOOLS, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true }, state);
  const { registry, unregistered } = makeRegistry(makeConfig([{ id: "fs", transport: "stdio", command: "npx" }]), factory);
  await registry.start();
  await registry.stop("fs");
  assert.ok(unregistered.includes("mcp__fs__read_file"));
  assert.ok(unregistered.includes("mcp__fs__list_dir"));
  assert.equal(registry.getServerSignals("fs")!.status, "stopped");
});

// ---------------------------------------------------------------------------
// Signals: per-server, per-tool, global — dynamically computed
// ---------------------------------------------------------------------------

test("registry: signals reflect live state after calls", async () => {
  const state = { calls: 0, closed: 0, connectAttempts: 0 };
  const factory = makeMockClientFactory({}, { tools: TOOLS, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true }, state);
  const { registry } = makeRegistry(makeConfig([{ id: "fs", transport: "stdio", command: "npx" }]), factory);
  await registry.start();
  await registry.callTool("fs", "read_file", {});
  await registry.callTool("fs", "read_file", {});
  const s = registry.getServerSignals("fs")!;
  assert.equal(s.callCount, 2);
  assert.equal(s.errorCount, 0);
  assert.equal(s.toolCount, 2);
  assert.equal(s.status, "connected");
  assert.ok(s.avgLatencyMs >= 0);
  assert.ok(s.startedAt !== null);
  const t = registry.getToolSignals("fs", "read_file")!;
  assert.equal(t.callCount, 2);
  assert.equal(t.enabled, true);
  const g = registry.getGlobalSignals();
  assert.equal(g.serverCount, 1);
  assert.equal(g.connectedServers, 1);
  assert.equal(g.totalTools, 2);
  assert.equal(g.totalCalls, 2);
});

test("registry: getServerIds and getTools return live data", async () => {
  const state = { calls: 0, closed: 0, connectAttempts: 0 };
  const factory = makeMockClientFactory({}, { tools: TOOLS, connectFailures: 0, callFailures: {}, transportCloseAfterCalls: 0, restartSucceeds: true }, state);
  const { registry } = makeRegistry(makeConfig([{ id: "fs", transport: "stdio", command: "npx" }]), factory);
  await registry.start();
  assert.deepEqual(registry.getServerIds(), ["fs"]);
  assert.equal(registry.getTools("fs").length, 2);
  assert.equal(registry.getTools("nonexistent").length, 0);
});

test("registry: an expired Streamable HTTP session (404) reconnects into a NEW session and the call succeeds", async () => {
  const server = await startStreamableHttpServer({ mode: "sse", session: true });
  try {
    const registry = createMcpRegistry({
      config: makeConfig([{ id: "remote", transport: "http", url: server.url }]),
      registerTool: () => {}, unregisterTool: () => {},
      clientInfo: { name: "test-client", version: "1.0.0" },
      defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 5000,
    });
    await registry.start();
    assert.equal((await registry.callTool("remote", "echo", { n: 1 })).content[0]!.text, JSON.stringify({ n: 1 }));
    server.expireSession();
    assert.equal((await registry.callTool("remote", "echo", { n: 2 })).content[0]!.text, JSON.stringify({ n: 2 }), "the call after expiry succeeds");
    const initializes = server.requests.filter((r) => r.method === "POST" && JSON.parse(r.body).method === "initialize");
    assert.equal(initializes.length, 2, "the reconnect initialized a new session");
    assert.equal(server.requests.at(-1)!.headers["mcp-session-id"], "session-2", "later requests carry the new session");
    await registry.stopAll();
  } finally {
    await server.close();
  }
});
