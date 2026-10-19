import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { getConfigDocumentSchema } from "../../src/kernel/config-contracts.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

// ---------------------------------------------------------------------------
// The SHIPPED config (bridlewise.config.json) validates against the full
// document schema, and every MCP server in it obeys the rules a shipped entry
// must: an explicit `enabled`; a stdio server is a pre-installed, pinned
// command (never a run-time fetch — `npx -y`/`uvx` cannot execute under the
// confinement's W^X — never a relative root, never a test fixture); a remote
// server speaks Streamable HTTP over https (never the retired `/sse`
// endpoint); and no server duplicates the governed native file tools.
// ---------------------------------------------------------------------------

function loadExampleConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync("bridlewise.config.json", "utf8"));
}

test("config-schema: the shipped bridlewise.config.json validates against the full schema", () => {
  const doc = loadExampleConfig();
  const result = CONFIG_DOCUMENT_SCHEMA.safeParse(doc);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error.issues, null, 2));
  const servers = (result.data as { tools?: { mcpServers?: unknown[] } }).tools?.mcpServers ?? [];
  assert.ok(servers.length >= 1, "the shipped config carries MCP servers to check");
});

test("config-schema: every shipped MCP server is explicit, pre-installed, remote-over-https and never a native-tool duplicate", () => {
  const servers = (loadExampleConfig() as { tools: { mcpServers: Array<Record<string, unknown>> } }).tools.mcpServers;
  const raw = readFileSync("bridlewise.config.json", "utf8");
  assert.doesNotMatch(raw, /@modelcontextprotocol\/server-filesystem/u, "the filesystem server duplicates the governed native file tools");
  for (const server of servers) {
    const id = String(server["id"]);
    assert.equal(typeof server["enabled"], "boolean", `${id}: enabled must be explicit`);
    if (server["transport"] === "stdio") {
      assert.ok(!["npx", "uvx", "bunx", "pnpm"].includes(String(server["command"])), `${id}: a run-time fetch cannot execute confined — pre-install and pin`);
      for (const arg of (server["args"] as string[] | undefined) ?? []) {
        assert.ok(arg !== "." && !arg.startsWith("./") && !arg.startsWith("../"), `${id}: no relative path argument (${arg})`);
        assert.doesNotMatch(arg, /(?:^|\/)(?:test|fixtures)\//u, `${id}: a test fixture is never a shipped server (${arg})`);
      }
    } else {
      const url = String(server["url"]);
      assert.match(url, /^(?:https|wss):\/\//u, `${id}: a remote server is reached over TLS`);
      assert.doesNotMatch(url, /\/sse\/?$/u, `${id}: the retired HTTP+SSE endpoint`);
    }
  }
});

// ---------------------------------------------------------------------------
// Per-server schema rejection cases — construct a minimal valid document
// by deep-cloning the example and swapping just the mcpServers field.
// ---------------------------------------------------------------------------

function parseWithServers(servers: unknown[]) {
  const doc = loadExampleConfig();
  (doc as { tools: { mcpServers: unknown[] } }).tools.mcpServers = servers;
  return CONFIG_DOCUMENT_SCHEMA.safeParse(doc);
}

test("config-schema: rejects websocket with http url", () => {
  const r = parseWithServers([{ id: "ws-bad", transport: "websocket", url: "https://example.com/ws", protocolVersion: "2025-11-25" }]);
  assert.ok(!r.success);
  assert.ok(r.error.issues.some((i) => i.message.includes("websocket url must be ws")));
});

test("config-schema: rejects the retired sse transport — no alias", () => {
  const r = parseWithServers([{ id: "sse-srv", transport: "sse", url: "https://example.com/sse", protocolVersion: "2025-11-25" }]);
  assert.ok(!r.success);
  assert.ok(r.error.issues.some((i) => i.path.includes("transport")));
});

test("config-schema: rejects readPaths on a remote server and a relative readPaths entry", () => {
  assert.ok(!parseWithServers([{ id: "r", transport: "http", url: "https://x.com", readPaths: ["/opt/x"], protocolVersion: "2025-11-25" }]).success);
  assert.ok(!parseWithServers([{ id: "l", transport: "stdio", command: "c", readPaths: ["opt/x"], protocolVersion: "2025-11-25" }]).success);
  assert.ok(parseWithServers([{ id: "l", transport: "stdio", command: "c", readPaths: ["/opt/x"], protocolVersion: "2025-11-25" }]).success);
});

test("config-schema: a server id with '_' or '.' is refused (the naming owner's pattern)", () => {
  for (const id of ["a_b", "a.b"]) {
    assert.ok(!parseWithServers([{ id, transport: "http", url: "https://x.com", protocolVersion: "2025-11-25" }]).success, id);
  }
});

test("config-schema: rejects api-key auth on stdio without envName", () => {
  const r = parseWithServers([{
    id: "bad", transport: "stdio", command: "npx",
    auth: { type: "api-key", token: "k" },
    protocolVersion: "2025-11-25",
  }]);
  assert.ok(!r.success);
  assert.ok(r.error.issues.some((i) => i.message.includes("api-key auth on stdio requires auth.envName")));
});

test("config-schema: rejects bad retry.count (0)", () => {
  const r = parseWithServers([{
    id: "bad", transport: "http", url: "https://x.com",
    retry: { count: 0, backoffMs: 100 }, protocolVersion: "2025-11-25",
  }]);
  assert.ok(!r.success);
});

test("config-schema: accepts a Streamable HTTP server with bearer auth", () => {
  const r = parseWithServers([{
    id: "http-srv", transport: "http", url: "https://example.com/mcp",
    auth: { type: "bearer", token: "secret:token" },
    protocolVersion: "2025-11-25",
  }]);
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues));
});

test("config-schema: accepts a websocket server with subprotocol", () => {
  const r = parseWithServers([{
    id: "ws-srv", transport: "websocket", url: "wss://example.com/ws",
    subprotocol: "mcp",
    protocolVersion: "2025-11-25",
  }]);
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues));
});
