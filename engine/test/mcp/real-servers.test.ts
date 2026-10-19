import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createTempDir } from "../support/temp-dir.ts";

import {
  createMcpRegistry,
  normalizeMcpModuleConfig,
  type McpStdioHost,
} from "../../src/mcp/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = join(__dirname, "fixtures", "fake-mcp-server.mjs");

/**
 * The host placement these registry tests run real servers under. The MCP
 * module has no spawn, directory or environment of its own; a host supplies
 * them (the web host's is the confined spawn — its confinement is proven in
 * the root suite's `tests/integration/mcp-stdio-landlock.test.ts`). Here the
 * host is the test: a plain spawn in a working directory of its own, with
 * only PATH and HOME (so npm/uv caches are found) passed on — and both package
 * managers OFFLINE: a test never dials a remote host (step6-readiness-2
 * F-14). Every server here is the repository's own fake; third-party servers
 * and the hosted endpoints run in the live suite (live/mcp-servers.test.ts).
 */
const OFFLINE_PACKAGE_MANAGERS: Readonly<Record<string, string>> = { npm_config_offline: "true", UV_OFFLINE: "1" };
const STDIO_HOST: McpStdioHost = {
  cwd: createTempDir("mcp-real-host-"),
  environment: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...OFFLINE_PACKAGE_MANAGERS },
  spawn: (command, args, options) => spawn(command, [...args], { ...options, stdio: [...options.stdio] }),
};

// ---------------------------------------------------------------------------
// Real server: fake crasher (always available — pure Node, no npx)
// ---------------------------------------------------------------------------

test("real: fake MCP server answers initialize + tools/list via the registry", async () => {
  const config = normalizeMcpModuleConfig({
    servers: [{ id: "fake", transport: "stdio", command: process.execPath, args: [FAKE_SERVER] }],
    defaults: { retry: { count: 3, backoffMs: 10 }, timeoutMs: 10000, protocolVersion: "2025-11-25" },
  });
  const registered: any[] = [];
  const registry = createMcpRegistry({
    config, stdioHost: STDIO_HOST, registerTool: (t) => registered.push(t), unregisterTool: () => {},
    clientInfo: { name: "test-client", version: "1.0.0" },
    defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 10000,
  });
  const result = await registry.start();
  assert.deepEqual(result.started, ["fake"]);
  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.definition.function.name, "mcp__fake__ping");
  const r = await registry.callTool("fake", "ping", { text: "hi" });
  assert.equal(r.content[0]!.text, "pong:1");
  await registry.stopAll();
});

test("real: a garbage numeric flag is a typed refusal (stderr naming the flag + non-zero exit), never a silent NaN", () => {
  // `parseInt("abc")` is NaN and every comparison over NaN is false: an
  // unvalidated `--crash-after abc` would silently mean "never crash" — the
  // fixture would report a behaviour nobody asked for. The refusal must be
  // loud at the parse choke, for BOTH numeric flags the fixture accepts.
  for (const flag of ["--crash-after", "--exit-after"]) {
    const garbage = spawnSync(process.execPath, [FAKE_SERVER, flag, "abc"], { encoding: "utf8", timeout: 15000 });
    assert.notEqual(garbage.status, 0, `${flag} abc must refuse, not run as a silent NaN`);
    assert.match(
      garbage.stderr,
      new RegExp(`${flag.slice(2)} expects a non-negative integer`, "u"),
      `the refusal names the offending flag (${flag}): ${garbage.stderr}`,
    );
  }
  // Liveness witness: a VALID numeric flag runs the fixture normally (the
  // grammar arm refuses only garbage) — here self-terminating after 50ms.
  const valid = spawnSync(process.execPath, [FAKE_SERVER, "--exit-after", "50"], { encoding: "utf8", timeout: 15000 });
  assert.equal(valid.status, 0, `a valid numeric flag must still parse and run: ${valid.stderr}`);
});

test("real: server crash detected + restarted — 3rd call succeeds after crash at call 2", async () => {
  const config = normalizeMcpModuleConfig({
    servers: [{ id: "crasher", transport: "stdio", command: process.execPath, args: [FAKE_SERVER, "--crash-after", "2"], retry: { count: 5, backoffMs: 50 } }],
    defaults: { retry: { count: 5, backoffMs: 50 }, timeoutMs: 15000, protocolVersion: "2025-11-25" },
  });
  const registered: any[] = [];
  const unregistered: string[] = [];
  const registry = createMcpRegistry({
    config, stdioHost: STDIO_HOST, registerTool: (t) => registered.push(t), unregisterTool: (id) => unregistered.push(id),
    clientInfo: { name: "test-client", version: "1.0.0" },
    defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 15000,
  });
  await registry.start();
  // Call 1: succeeds (pong:1)
  const r1 = await registry.callTool("crasher", "ping", {});
  assert.equal(r1.content[0]!.text, "pong:1");
  // Call 2: server crashes (exits 1). The transport close fires → registry
  // reconnects. The retry layer then retries the call on the fresh server.
  const r2 = await registry.callTool("crasher", "ping", {});
  assert.equal(r2.content[0]!.text, "pong:1", "after crash+restart the new server's callCount resets to 1");
  // The server should be connected again (restarted).
  const signals = registry.getServerSignals("crasher")!;
  assert.equal(signals.status, "connected", "server reconnected after crash");
  await registry.stopAll();
});

// ---------------------------------------------------------------------------
// 10× HARDER: 5 servers simultaneously — the design supports 15 (maxServers=16)
// ---------------------------------------------------------------------------

test("real: 5 servers start + are managed simultaneously by one registry", async () => {
  // Use the fake crasher with different tool names to simulate 5 distinct servers
  // (avoids 5× npx download latency; the design is identical for real servers).
  const servers = [1, 2, 3, 4, 5].map((i) => ({
    id: `srv${i}`, transport: "stdio" as const,
    command: process.execPath, args: [FAKE_SERVER, "--name", `tool${i}`],
  }));
  const config = normalizeMcpModuleConfig({
    servers,
    defaults: { retry: { count: 3, backoffMs: 10 }, timeoutMs: 15000, protocolVersion: "2025-11-25" },
    limits: { maxServers: 16, maxToolsPerServer: 1024 },
  });
  const registered: any[] = [];
  const registry = createMcpRegistry({
    config, stdioHost: STDIO_HOST, registerTool: (t) => registered.push(t), unregisterTool: () => {},
    clientInfo: { name: "test-client", version: "1.0.0" },
    defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 15000,
  });
  const result = await registry.start();
  assert.equal(result.started.length, 5);
  assert.equal(result.errors.length, 0);
  // 5 servers × 1 tool each = 5 registered tools.
  assert.equal(registered.length, 5);
  // Call a tool on each server — all succeed.
  for (let i = 1; i <= 5; i++) {
    const r = await registry.callTool(`srv${i}`, `tool${i}`, {});
    assert.equal(r.content[0]!.text, "pong:1", `srv${i} call succeeded`);
  }
  const g = registry.getGlobalSignals();
  assert.equal(g.serverCount, 5);
  assert.equal(g.connectedServers, 5);
  assert.equal(g.totalCalls, 5);
  await registry.stopAll();
});

test("real: 8 simultaneous servers managed by one registry (10× harder than 5)", async () => {
  // Eight real processes of the fake server: the registry's management is
  // what is under test here. Third-party servers run in the live suite
  // (live/mcp-servers.test.ts), never conditionally here.
  const servers = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ id: `fake${i}`, transport: "stdio" as const, command: process.execPath, args: [FAKE_SERVER] }));
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
