import assert from "node:assert/strict";
import test from "node:test";

import { resolveMcpServerConfigs } from "../../src/mcp/index.ts";
import type { McpServerConfig } from "../../src/kernel/config-contracts.ts";

// ---------------------------------------------------------------------------
// Config resolution: the config document's `tools.mcpServers` entries become
// the MCP module's runtime entries (the config owner, `src/mcp/config.ts`).
// ---------------------------------------------------------------------------

test("config: resolveMcpServerConfigs passes through all new fields", () => {
  const config: McpServerConfig = {
    id: "test",
    transport: "http",
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    headers: { "X-Custom": "value" },
    subprotocol: "mcp",
    enabled: true,
    retry: { count: 5, backoffMs: 2000 },
    auth: { type: "bearer", token: "secret-token" },
    timeoutMs: 10000,
  };
  const entries = resolveMcpServerConfigs([config]);
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.equal(entry.id, "test");
  assert.equal(entry.transport, "http");
  assert.equal(entry.url, "https://example.com/mcp");
  assert.deepEqual(entry.headers, { "X-Custom": "value" });
  assert.equal(entry.subprotocol, "mcp");
  assert.equal(entry.enabled, true);
  assert.deepEqual(entry.retry, { count: 5, backoffMs: 2000 });
  assert.equal(entry.auth?.type, "bearer");
  assert.equal(entry.timeoutMs, 10000);
});

test("config: resolveMcpServerConfigs applies defaultTimeoutMs when server has none", () => {
  const config: McpServerConfig = {
    id: "test", transport: "stdio", command: "echo", protocolVersion: "2025-11-25",
  };
  const entries = resolveMcpServerConfigs([config], { defaultTimeoutMs: 45000 });
  assert.equal(entries[0]!.timeoutMs, 45000);
});

test("config: resolveMcpServerConfigs uses server timeoutMs when declared", () => {
  const config: McpServerConfig = {
    id: "test", transport: "stdio", command: "echo", protocolVersion: "2025-11-25", timeoutMs: 5000,
  };
  const entries = resolveMcpServerConfigs([config], { defaultTimeoutMs: 45000 });
  assert.equal(entries[0]!.timeoutMs, 5000);
});

test("config: resolveMcpServerConfigs resolves api-key auth with custom header", () => {
  const config: McpServerConfig = {
    id: "test", transport: "http", url: "https://example.com", protocolVersion: "2025-11-25",
    auth: { type: "api-key", token: "key123", header: "X-Api-Key" },
  };
  const entries = resolveMcpServerConfigs([config]);
  assert.equal(entries[0]!.auth?.type, "api-key");
});

test("config: resolveMcpServerConfigs resolves api-key auth with envName", () => {
  const config: McpServerConfig = {
    id: "test", transport: "stdio", command: "echo", protocolVersion: "2025-11-25",
    auth: { type: "api-key", token: "key123", envName: "API_KEY" },
  };
  const entries = resolveMcpServerConfigs([config]);
  assert.equal(entries[0]!.auth?.type, "api-key");
});

test("config: resolveMcpServerConfigs resolves bearer auth", () => {
  const config: McpServerConfig = {
    id: "test", transport: "http", url: "https://example.com", protocolVersion: "2025-11-25",
    auth: { type: "bearer", token: "bearer-token" },
  };
  const entries = resolveMcpServerConfigs([config]);
  assert.equal(entries[0]!.auth?.type, "bearer");
});

test("config: resolveMcpServerConfigs resolves oauth auth", () => {
  const config: McpServerConfig = {
    id: "test", transport: "http", url: "https://example.com", protocolVersion: "2025-11-25",
    auth: { type: "oauth", token: "oauth-token" },
  };
  const entries = resolveMcpServerConfigs([config]);
  assert.equal(entries[0]!.auth?.type, "oauth");
});

test("config: resolveMcpServerConfigs handles all 3 transports and carries a stdio entry's readPaths", () => {
  const configs: readonly McpServerConfig[] = [
    { id: "s1", transport: "stdio", command: "echo", readPaths: ["/opt/server"], protocolVersion: "2025-11-25" },
    { id: "s2", transport: "http", url: "https://example.com", protocolVersion: "2025-11-25" },
    { id: "s4", transport: "websocket", url: "wss://example.com/ws", protocolVersion: "2025-11-25" },
  ];
  const entries = resolveMcpServerConfigs(configs);
  assert.deepEqual(entries.map((e) => e.transport), ["stdio", "http", "websocket"]);
  assert.deepEqual(entries[0]!.readPaths, ["/opt/server"]);
});
