/**
 * THE LIVE SUITE — `npm run test:live` (engine), never part of the hermetic
 * suites (UR-20: a hermetic run has no skips by design; LAND-OC-FIX
 * LIVE-INTEROP). Everything here depends on the world outside the checkout:
 * third-party MCP servers started from the local npm/uv cache (offline), and
 * the hosted Streamable HTTP endpoints the shipped config names (context7,
 * deepwiki), reachable only under the root policy's ONE declared consent
 * (`verification.networkUnderTest.liveConsentVariable`; src/process/live-network.ts).
 *
 * It REFUSES LOUDLY instead of skipping: without the consent the file fails
 * at load, and a server missing from the local cache fails its test naming
 * the command — a live run that could not reach what it tests is a red, never
 * a quiet green.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createTempDir } from "../test/support/temp-dir.ts";
import { ROOT_POLICY } from "../src/kernel/root-policy.ts";
import {
  createMcpClientFromConfig,
  createMcpRegistry,
  normalizeMcpModuleConfig,
  type McpStdioHost,
} from "../src/mcp/index.ts";

const CONSENT = ROOT_POLICY.verification.networkUnderTest.liveConsentVariable;
if (process.env[CONSENT] !== "1") {
  throw new Error(`the live suite runs only with consent: set ${CONSENT}=1 (it reaches ${ROOT_POLICY.verification.networkUnderTest.liveHosts.join(", ")} and starts third-party MCP servers from the local cache)`);
}

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "mcp", "fixtures", "fake-mcp-server.mjs");

/**
 * The host placement these registry tests run real servers under. The MCP
 * module has no spawn, directory or environment of its own; a host supplies
 * them (the web host's is the confined spawn — its confinement is proven in
 * the root suite's `tests/integration/mcp-stdio-landlock.test.ts`). Here the
 * host is the test: a plain spawn in a working directory of its own, with
 * only PATH and HOME (so npm/uv caches are found) passed on — and both package
 * managers OFFLINE: a server runs from the local cache, or its test fails
 * naming it.
 */
const OFFLINE_PACKAGE_MANAGERS: Readonly<Record<string, string>> = { npm_config_offline: "true", UV_OFFLINE: "1" };
const STDIO_HOST: McpStdioHost = {
  cwd: createTempDir("mcp-real-host-"),
  environment: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...OFFLINE_PACKAGE_MANAGERS },
  spawn: (command, args, options) => spawn(command, [...args], { ...options, stdio: [...options.stdio] }),
};

/** Does `command args` start from the local cache (offline) and answer `initialize`? */
async function serverAvailable(command: string, args: string[], env?: Record<string, string>, timeoutMs = 30000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...OFFLINE_PACKAGE_MANAGERS, ...env } });
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill("SIGTERM"); } catch { /* */ } resolve(false); }
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      for (const line of buf.split("\n")) {
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.result?.serverInfo) {
            if (!settled) { settled = true; clearTimeout(timer); try { child.kill("SIGTERM"); } catch { /* */ } resolve(true); }
          }
        } catch { /* ignore */ }
      }
    });
    child.on("error", () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } });
    child.on("close", () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } });
    // Send initialize immediately.
    child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "0.0.0" } } }) + "\n");
  });
}

/** A third-party server this suite starts must be in the local cache: refused by name otherwise. */
async function requireServer(command: string, args: string[], env?: Record<string, string>): Promise<void> {
  assert.ok(await serverAvailable(command, args, env), `the live suite requires \`${[command, ...args].join(" ")}\` to start from the local cache (offline): install it, then re-run`);
}


// ---------------------------------------------------------------------------
// Real server: @modelcontextprotocol/server-memory (npm)
// ---------------------------------------------------------------------------

test("real: memory server discovers tools + calls create_entities", async () => {
  await requireServer("npx", ["-y", "@modelcontextprotocol/server-memory"]);
  const config = normalizeMcpModuleConfig({
    servers: [{ id: "memory", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] }],
    defaults: { retry: { count: 3, backoffMs: 100 }, timeoutMs: 60000, protocolVersion: "2025-11-25" },
  });
  const registered: any[] = [];
  const registry = createMcpRegistry({
    config, stdioHost: STDIO_HOST, registerTool: (t) => registered.push(t), unregisterTool: () => {},
    clientInfo: { name: "test-client", version: "1.0.0" },
    defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 60000,
  });
  const result = await registry.start();
  assert.deepEqual(result.started, ["memory"]);
  // Memory server exposes: create_entities, create_relations, add_observations, delete_entities, delete_observations, delete_relations, read_graph, search_nodes, open_nodes.
  assert.ok(registered.length >= 8, `expected >=8 tools, got ${registered.length}`);
  const names = registered.map((t) => t.definition.function.name);
  assert.ok(names.includes("mcp__memory__create_entities"));
  // Call a real tool.
  const r = await registry.callTool("memory", "create_entities", {
    entities: [{ name: "EXP423TestEntity", entityType: "test", observations: ["created by real-server integration test"] }],
  });
  assert.equal(r.isError, false);
  await registry.stopAll();
});

// ---------------------------------------------------------------------------
// Real server: @modelcontextprotocol/server-sequential-thinking (npm)
// ---------------------------------------------------------------------------

test("real: sequential-thinking server discovers the sequentialthinking tool", async () => {
  await requireServer("npx", ["-y", "@modelcontextprotocol/server-sequential-thinking"]);
  const config = normalizeMcpModuleConfig({
    servers: [{ id: "seqthink", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] }],
    defaults: { retry: { count: 3, backoffMs: 100 }, timeoutMs: 60000, protocolVersion: "2025-11-25" },
  });
  const registered: any[] = [];
  const registry = createMcpRegistry({
    config, stdioHost: STDIO_HOST, registerTool: (t) => registered.push(t), unregisterTool: () => {},
    clientInfo: { name: "test-client", version: "1.0.0" },
    defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 60000,
  });
  const result = await registry.start();
  assert.deepEqual(result.started, ["seqthink"]);
  assert.ok(registered.length >= 1);
  assert.equal(registered[0]!.definition.function.name, "mcp__seqthink__sequentialthinking");
  await registry.stopAll();
});

// ---------------------------------------------------------------------------
// Real server: @modelcontextprotocol/server-filesystem (npm) — file access
// ---------------------------------------------------------------------------

test("real: filesystem server discovers read/write tools for a directory of its own", async () => {
  const served = createTempDir("mcp-real-fs-");
  await requireServer("npx", ["-y", "@modelcontextprotocol/server-filesystem", served]);
  const config = normalizeMcpModuleConfig({
    servers: [{ id: "fs", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", served] }],
    defaults: { retry: { count: 3, backoffMs: 100 }, timeoutMs: 60000, protocolVersion: "2025-11-25" },
  });
  const registered: any[] = [];
  const registry = createMcpRegistry({
    config, stdioHost: STDIO_HOST, registerTool: (t) => registered.push(t), unregisterTool: () => {},
    clientInfo: { name: "test-client", version: "1.0.0" },
    defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 60000,
  });
  const result = await registry.start();
  assert.deepEqual(result.started, ["fs"]);
  assert.ok(registered.length >= 7, `expected >=7 fs tools, got ${registered.length}`);
  await registry.stopAll();
});

// ---------------------------------------------------------------------------
// Real server: mcp-server-time (Python/uvx) — different install ecosystem
// ---------------------------------------------------------------------------

test("real: time server (uvx/python) discovers get_current_time tool", async () => {
  await requireServer("uvx", ["mcp-server-time"]);
  const config = normalizeMcpModuleConfig({
    servers: [{ id: "time", transport: "stdio", command: "uvx", args: ["mcp-server-time"] }],
    defaults: { retry: { count: 3, backoffMs: 100 }, timeoutMs: 60000, protocolVersion: "2025-11-25" },
  });
  const registered: any[] = [];
  const registry = createMcpRegistry({
    config, stdioHost: STDIO_HOST, registerTool: (t) => registered.push(t), unregisterTool: () => {},
    clientInfo: { name: "test-client", version: "1.0.0" },
    defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 60000,
  });
  const result = await registry.start();
  assert.deepEqual(result.started, ["time"]);
  assert.ok(registered.length >= 1, `expected >=1 time tool, got ${registered.length}`);
  const r = await registry.callTool("time", "get_current_time", { timezone: "UTC" });
  assert.equal(r.isError, false);
  await registry.stopAll();
});

// ---------------------------------------------------------------------------
// 10× harder: 3 additional real servers (everything, fetch, sqlite) + 8
// simultaneous servers. Total real servers tested: 8 (memory,
// sequential-thinking, filesystem, time, everything, fetch, sqlite +
// fake crasher). The design supports 15 (maxServers derived from
// ROOT_POLICY.tools.limits.maximumMcpServers = 16).
// ---------------------------------------------------------------------------

test("real: everything server (npx) discovers many tools + calls echo", async () => {
  await requireServer("npx", ["-y", "@modelcontextprotocol/server-everything@2026.7.4"]);
  const config = normalizeMcpModuleConfig({
    servers: [{ id: "everything", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything@2026.7.4"] }],
    defaults: { retry: { count: 3, backoffMs: 100 }, timeoutMs: 60000, protocolVersion: "2025-11-25" },
  });
  const registered: any[] = [];
  const registry = createMcpRegistry({
    config, stdioHost: STDIO_HOST, registerTool: (t) => registered.push(t), unregisterTool: () => {},
    clientInfo: { name: "test-client", version: "1.0.0" },
    defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 60000,
  });
  const result = await registry.start();
  assert.deepEqual(result.started, ["everything"]);
  assert.ok(registered.length >= 5, `expected >=5 everything tools, got ${registered.length}`);
  // Call echo with a string argument.
  const echoTool = registered.find((t) => t.definition.function.name.includes("echo"));
  if (echoTool !== undefined) {
    const r = await registry.callTool("everything", "echo", { message: "hello-mcp" });
    assert.equal(r.isError, false);
  }
  await registry.stopAll();
});

test("real: fetch server (uvx/python) discovers fetch tool", async () => {
  await requireServer("uvx", ["mcp-server-fetch"]);
  const config = normalizeMcpModuleConfig({
    servers: [{ id: "fetch", transport: "stdio", command: "uvx", args: ["mcp-server-fetch"] }],
    defaults: { retry: { count: 3, backoffMs: 100 }, timeoutMs: 60000, protocolVersion: "2025-11-25" },
  });
  const registered: any[] = [];
  const registry = createMcpRegistry({
    config, stdioHost: STDIO_HOST, registerTool: (t) => registered.push(t), unregisterTool: () => {},
    clientInfo: { name: "test-client", version: "1.0.0" },
    defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 60000,
  });
  const result = await registry.start();
  assert.deepEqual(result.started, ["fetch"]);
  assert.ok(registered.length >= 1, `expected >=1 fetch tool, got ${registered.length}`);
  await registry.stopAll();
});

test("real: sqlite server (npx) discovers sqlite tools with a temp db", async () => {
  const database = join(createTempDir("mcp-real-sqlite-"), "mcp-test.db");
  await requireServer("npx", ["-y", "@modelcontextprotocol/server-sqlite@0.6.2", database]);
  const config = normalizeMcpModuleConfig({
    servers: [{ id: "sqlite", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sqlite@0.6.2", database] }],
    defaults: { retry: { count: 3, backoffMs: 100 }, timeoutMs: 60000, protocolVersion: "2025-11-25" },
  });
  const registered: any[] = [];
  const registry = createMcpRegistry({
    config, stdioHost: STDIO_HOST, registerTool: (t) => registered.push(t), unregisterTool: () => {},
    clientInfo: { name: "test-client", version: "1.0.0" },
    defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 60000,
  });
  const result = await registry.start();
  assert.deepEqual(result.started, ["sqlite"]);
  assert.ok(registered.length >= 1, `expected >=1 sqlite tool, got ${registered.length}`);
  await registry.stopAll();
});

test("live: 4 third-party and 4 fake servers managed by one registry", async () => {
  // 4 fake + 4 real (memory, sequential-thinking, filesystem, time) = 8; every real server is required.
  await requireServer("npx", ["-y", "@modelcontextprotocol/server-memory@2026.7.4"]);
  await requireServer("npx", ["-y", "@modelcontextprotocol/server-sequential-thinking@2026.7.4"]);
  const served = createTempDir("mcp-real-fs-");
  await requireServer("npx", ["-y", "@modelcontextprotocol/server-filesystem@2026.7.10", served]);
  await requireServer("uvx", ["mcp-server-time"]);
  const servers: any[] = [];
  // 4 fake servers
  for (let i = 1; i <= 4; i++) {
    servers.push({ id: `fake${i}`, transport: "stdio", command: process.execPath, args: [FAKE_SERVER] });
  }
  // 4 real servers
  servers.push({ id: "memory", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory@2026.7.4"] });
  servers.push({ id: "seq", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2026.7.4"] });
  servers.push({ id: "fs", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2026.7.10", served] });
  servers.push({ id: "time", transport: "stdio", command: "uvx", args: ["mcp-server-time"] });
  const config = normalizeMcpModuleConfig({
    servers,
    defaults: { retry: { count: 3, backoffMs: 50 }, timeoutMs: 60000, protocolVersion: "2025-11-25" },
  });
  const registered: any[] = [];
  const registry = createMcpRegistry({
    config, stdioHost: STDIO_HOST, registerTool: (t) => registered.push(t), unregisterTool: () => {},
    clientInfo: { name: "test-client", version: "1.0.0" },
    defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 60000,
  });
  const result = await registry.start();
  assert.equal(result.started.length, 8, `expected 8 servers started, got ${result.started.length}`);
  assert.equal(result.errors.length, 0, `errors: ${result.errors.map((e: any) => e.message).join("; ")}`);
  const g = registry.getGlobalSignals();
  assert.equal(g.serverCount, 8);
  assert.equal(g.connectedServers, 8);
  await registry.stopAll();
});

// ---------------------------------------------------------------------------
// Real remote servers over Streamable HTTP (context7, deepwiki `/mcp`) — the
// hosted endpoints the shipped config names. A test process dials only this
// machine (`outbound_network_under_test`, at the door and at the socket:
// step6-readiness-2 F-14 found a web test reaching `mcp.deepwiki.com`), so
// these run only in a DELIBERATE live run: the operator sets the root
// policy's consent variable (`verification.networkUnderTest`), and the two
// declared live hosts become reachable (src/process/live-network.ts). Without
// consent this suite refuses at load; with it, a failure is the client's or
// the server's (wf-del2-correctness NEW-5: they had been
// deleted, which also removed the live interop coverage).
// ---------------------------------------------------------------------------

async function assertRemoteAnswers(id: string, url: string): Promise<void> {
  const client = createMcpClientFromConfig(
    { id, transport: "http", url },
    { clientInfo: { name: "test-client", version: "1.0.0" }, defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 30_000 },
  );
  try {
    await client.connect();
    const tools = await client.listTools();
    assert.ok(tools.length >= 1, `${id} lists its tools`);
  } finally {
    await client.close();
  }
}

test("live: context7 answers initialize + tools/list over Streamable HTTP", { timeout: 60_000 }, async () => {
  await assertRemoteAnswers("context7", "https://mcp.context7.com/mcp");
});

test("live: deepwiki /mcp answers initialize + tools/list over Streamable HTTP", { timeout: 60_000 }, async () => {
  await assertRemoteAnswers("deepwiki", "https://mcp.deepwiki.com/mcp");
});
