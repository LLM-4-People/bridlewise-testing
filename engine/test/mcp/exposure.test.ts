import assert from "node:assert/strict";
import test from "node:test";

import { createMcpExposure, normalizeMcpModuleConfig, type McpExposure } from "../../src/mcp/index.ts";
import { createMcpRegistry } from "../../src/mcp/registry.ts";
import type { McpClient, McpTool } from "../../src/mcp/core.ts";

const TOOLS: readonly McpTool[] = [
  { name: "search", description: "search the web", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
];

function makeMockFactory(): (entry: any, opts: any) => McpClient {
  return (entry: any, opts: any): McpClient => {
    let connected = false;
    return {
      serverId: entry.id,
      get connected() { return connected; },
      connect: async () => { connected = true; return { name: entry.id, version: "1.0.0" }; },
      listTools: async () => TOOLS,
      callTool: async (name: string) => {
        if (opts?.onTransportClose && name === "crash") { connected = false; opts.onTransportClose(); }
        return { content: [{ type: "text", text: `ok:${name}` }], isError: false };
      },
      close: async () => { connected = false; },
    };
  };
}

function makeExposure(serverConfig: any[] = [{ id: "brave", transport: "http", url: "https://x.com", auth: { type: "api-key", token: "secret", header: "X-Api-Key" }, retry: { count: 2, backoffMs: 10 } }]): { exposure: McpExposure } {
  const config = normalizeMcpModuleConfig({ servers: serverConfig, defaults: { retry: { count: 3, backoffMs: 1 }, timeoutMs: 5000, protocolVersion: "2025-11-25" } });
  const registry = createMcpRegistry({
    config, clientFactory: makeMockFactory(),
    registerTool: () => {}, unregisterTool: () => {},
    clientInfo: { name: "test-client", version: "1.0.0" },
    defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 5000,
  });
  return { exposure: createMcpExposure(registry, config) };
}

// Signals --------------------------------------------------------------------

test("exposure: signals.global returns dynamically-computed global signals", async () => {
  const { exposure } = makeExposure();
  await exposure.actions.start();
  const g = exposure.signals.global();
  assert.equal(g.serverCount, 1);
  assert.equal(g.connectedServers, 1);
  assert.equal(g.totalTools, 1);
  assert.equal(g.totalCalls, 0);
});

test("exposure: signals.server returns per-server signals", async () => {
  const { exposure } = makeExposure();
  await exposure.actions.start();
  const s = exposure.signals.server("brave")!;
  assert.equal(s.id, "brave");
  assert.equal(s.transport, "http");
  assert.equal(s.status, "connected");
  assert.equal(s.toolCount, 1);
});

test("exposure: signals.allServers returns one entry per server", async () => {
  const { exposure } = makeExposure([
    { id: "a", transport: "http", url: "https://x.com" },
    { id: "b", transport: "websocket", url: "wss://y.com" },
  ]);
  await exposure.actions.start();
  const all = exposure.signals.allServers();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((s) => s.id).toSorted(), ["a", "b"]);
});

test("exposure: signals.tool returns per-tool signals after a call", async () => {
  const { exposure } = makeExposure();
  await exposure.actions.start();
  await exposure.actions.callTool("brave", "search", { q: "hello" });
  const t = exposure.signals.tool("brave", "search")!;
  assert.equal(t.callCount, 1);
  assert.equal(t.enabled, true);
});

test("exposure: signals.config projects the config with redacted headers", async () => {
  const { exposure } = makeExposure();
  const cfg = exposure.signals.config();
  assert.equal(cfg.servers.length, 1);
  assert.equal(cfg.servers[0]!.authType, "api-key");
  // The Authorization/*key* header must be redacted.
  assert.equal(cfg.servers[0]!.headers["X-Api-Key"], "<redacted:6>");
});

// Actions --------------------------------------------------------------------

test("exposure: actions.start/stop/stopAll/restart work end-to-end", async () => {
  const { exposure } = makeExposure();
  await exposure.actions.start();
  assert.equal(exposure.signals.server("brave")!.status, "connected");
  await exposure.actions.stop("brave");
  assert.equal(exposure.signals.server("brave")!.status, "stopped");
  await exposure.actions.restart("brave");
  assert.equal(exposure.signals.server("brave")!.status, "connected");
  await exposure.actions.stopAll();
  assert.equal(exposure.signals.server("brave")!.status, "stopped");
});

test("exposure: actions.disableTool/enableTool toggle the tool", async () => {
  const { exposure } = makeExposure();
  await exposure.actions.start();
  exposure.actions.disableTool("brave", "search");
  assert.equal(exposure.signals.tool("brave", "search")!.enabled, false);
  await assert.rejects(() => exposure.actions.callTool("brave", "search", {}));
  exposure.actions.enableTool("brave", "search");
  const r = await exposure.actions.callTool("brave", "search", { q: "x" });
  assert.equal(r.content[0]!.text, "ok:search");
});

// Customization --------------------------------------------------------------

test("exposure: customization.perServer returns the server's config knobs", async () => {
  const { exposure } = makeExposure();
  const c = exposure.customization.perServer("brave")!;
  assert.equal(c.transport, "http");
  assert.equal(c.authType, "api-key");
  assert.deepEqual(c.retry, { count: 2, backoffMs: 10 });
  assert.equal(c.timeoutMs, 5000);
  assert.equal(c.enabled, true);
  // Headers redacted in customization too.
  assert.equal(c.headers["X-Api-Key"], "<redacted:6>");
});

test("exposure: customization.perTool returns enabled state", async () => {
  const { exposure } = makeExposure();
  await exposure.actions.start();
  const t = exposure.customization.perTool("brave", "search")!;
  assert.equal(t.enabled, true);
  assert.equal(t.serverId, "brave");
});

test("exposure: customization.global returns defaults + limits", async () => {
  const { exposure } = makeExposure();
  const g = exposure.customization.global();
  assert.equal(g.serverCount, 1);
  assert.equal(g.defaults.protocolVersion, "2025-11-25");
  assert.equal(g.limits.maxServers, 16);
});

test("exposure: customization.perServer returns undefined for unknown server", async () => {
  const { exposure } = makeExposure();
  assert.equal(exposure.customization.perServer("nope"), undefined);
});
