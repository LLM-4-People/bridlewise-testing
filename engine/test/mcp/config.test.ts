import assert from "node:assert/strict";
import test from "node:test";

import {
  validateMcpServerEntry,
  validateMcpModuleConfig,
  normalizeMcpModuleConfig,
  unresolvedCredentialPlaceholders,
  type McpServerEntry,
} from "../../src/mcp/index.ts";
import { McpError } from "../../src/mcp/errors.ts";

// The fully-defaulted document comes from the resolver, not from a default
// constant read directly: the resolver is the only thing a caller ever runs.
const DEFAULTED = normalizeMcpModuleConfig({});

const VALID_STDIO: McpServerEntry = { id: "local-server", transport: "stdio", command: "server-bin", readPaths: ["/opt/server"] };
const VALID_HTTP: McpServerEntry = { id: "remote", transport: "http", url: "https://example.com/mcp" };
const VALID_WS: McpServerEntry = { id: "ws-server", transport: "websocket", url: "wss://example.com/ws" };

test("config: validateMcpServerEntry accepts all three transports", () => {
  validateMcpServerEntry(VALID_STDIO);
  validateMcpServerEntry(VALID_HTTP);
  validateMcpServerEntry(VALID_WS);
});

test("config: the retired HTTP+SSE transport is refused, naming the Streamable HTTP replacement", () => {
  assert.throws(
    () => validateMcpServerEntry({ id: "old", transport: "sse", url: "https://example.com/sse" } as unknown as McpServerEntry),
    (e: unknown) => /Streamable HTTP/u.test((e as Error).message) && (e as { code?: string }).code === "mcp_config_invalid",
  );
});

test("config: readPaths belongs to a stdio server only", () => {
  assert.throws(() => validateMcpServerEntry({ ...VALID_HTTP, readPaths: ["/opt/x"] }), (e: unknown) => (e as { code?: string }).code === "mcp_config_invalid");
});

test("config: a server id may only be letters, digits and inner hyphens (the tool-name delimiter stays unambiguous)", () => {
  for (const id of ["a_b", "a.b", "-a", "a-", "a b"]) {
    assert.throws(() => validateMcpServerEntry({ ...VALID_HTTP, id }), (e: unknown) => (e as { code?: string }).code === "mcp_config_invalid", id);
  }
  validateMcpServerEntry({ ...VALID_HTTP, id: "brave-search2" });
});

test("config: rejects stdio without command", () => {
  assert.throws(() => validateMcpServerEntry({ id: "x", transport: "stdio" }));
});

test("config: rejects http/websocket without url", () => {
  assert.throws(() => validateMcpServerEntry({ id: "x", transport: "http" } as McpServerEntry));
  assert.throws(() => validateMcpServerEntry({ id: "x", transport: "websocket" } as McpServerEntry));
});

test("config: rejects invalid url", () => {
  assert.throws(() => validateMcpServerEntry({ id: "x", transport: "http", url: "not-a-url" }));
});

test("config: rejects empty server id", () => {
  assert.throws(() => validateMcpServerEntry({ id: "", transport: "http", url: "https://x.com" } as McpServerEntry));
});

test("config: rejects invalid server id characters", () => {
  assert.throws(() => validateMcpServerEntry({ id: "bad server", transport: "http", url: "https://x.com" }));
});

test("config: rejects api-key auth on stdio without envName", () => {
  assert.throws(() => validateMcpServerEntry({
    id: "x", transport: "stdio", command: "npx",
    auth: { type: "api-key", token: "k" },
  }));
});

test("config: accepts api-key auth on stdio with envName", () => {
  validateMcpServerEntry({
    id: "x", transport: "stdio", command: "npx",
    auth: { type: "api-key", token: "k", envName: "API_KEY" },
  });
});

test("config: rejects bad retry.count", () => {
  assert.throws(() => validateMcpServerEntry({
    id: "x", transport: "http", url: "https://x.com",
    retry: { count: 0, backoffMs: 10 },
  }));
});

test("config: rejects bad retry.backoffMs", () => {
  assert.throws(() => validateMcpServerEntry({
    id: "x", transport: "http", url: "https://x.com",
    retry: { count: 3, backoffMs: -1 },
  }));
});

test("config: validateMcpModuleConfig rejects duplicate ids", () => {
  assert.throws(() => validateMcpModuleConfig({
    ...DEFAULTED,
    servers: [VALID_HTTP, { ...VALID_HTTP, id: "remote" }],
  }));
});

test("config: validateMcpModuleConfig rejects too many servers", () => {
  const tooMany: McpServerEntry[] = [];
  for (let i = 0; i < 20; i++) tooMany.push({ id: `s${i}`, transport: "http", url: "https://x.com" });
  assert.throws(() => validateMcpModuleConfig({
    ...DEFAULTED,
    servers: tooMany,
  }), McpError);
});

test("config: normalizeMcpModuleConfig fills defaults", () => {
  const norm = normalizeMcpModuleConfig({ servers: [VALID_HTTP] });
  assert.equal(norm.servers.length, 1);
  assert.equal(norm.defaults.protocolVersion, "2025-11-25");
  assert.equal(norm.defaults.timeoutMs, 30000);
  assert.deepEqual(norm.defaults.retry, { count: 3, backoffMs: 1000 });
  assert.equal(norm.limits.maxServers, 16);
});

test("config: normalizeMcpModuleConfig accepts stdio + websocket transports", () => {
  const norm = normalizeMcpModuleConfig({ servers: [VALID_STDIO, VALID_WS] });
  assert.equal(norm.servers[0]!.transport, "stdio");
  assert.equal(norm.servers[1]!.transport, "websocket");
});

test("config: unresolvedCredentialPlaceholders names every variable still spelled in env, headers and the auth token", () => {
  assert.deepEqual(unresolvedCredentialPlaceholders({
    id: "x", transport: "http", url: "https://x.com",
    headers: { "X-Key": "${B_KEY}", Plain: "value" },
    auth: { type: "bearer", token: "${A_TOKEN}" },
  }), ["A_TOKEN", "B_KEY"]);
  assert.deepEqual(unresolvedCredentialPlaceholders({ id: "x", transport: "stdio", command: "c", env: { K: "resolved-value" } }), []);
});
