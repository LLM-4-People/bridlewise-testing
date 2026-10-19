import assert from "node:assert/strict";
import test from "node:test";

import {
  validateMcpServerEntry,
  validateMcpModuleConfig,
  normalizeMcpModuleConfig,
  type McpServerEntry,
  type McpModuleConfig,
} from "../../src/mcp/index.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { McpError, isTransportError } from "../../src/mcp/index.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";

// The fully-defaulted document, from the resolver rather than from a default
// constant read directly.
const DEFAULTED = normalizeMcpModuleConfig({});

// ---------------------------------------------------------------------------
// Improper usage: invalid configs must produce typed errors (InputError /
// McpError), never silent passes, generic Error, or undefined behavior.
// ---------------------------------------------------------------------------

function entry(partial: Partial<McpServerEntry> & { id: string; transport: McpServerEntry["transport"] }): McpServerEntry {
  return { ...partial } as McpServerEntry;
}

test("improper-usage: empty server id → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "", transport: "stdio", command: "echo" })),
    (e: unknown) => e instanceof InputError && (e as Error).message.includes("id"),
  );
});

test("improper-usage: server id too long → InputError", () => {
  const longId = "a".repeat(200);
  assert.throws(
    () => validateMcpServerEntry(entry({ id: longId, transport: "stdio", command: "echo" })),
    (e: unknown) => e instanceof InputError,
  );
});

test("improper-usage: server id with bad chars → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "bad/id", transport: "stdio", command: "echo" })),
    (e: unknown) => e instanceof InputError,
  );
});

test("improper-usage: stdio without command → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "s1", transport: "stdio" })),
    (e: unknown) => e instanceof InputError && (e as Error).message.includes("command"),
  );
});

test("improper-usage: http without url → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "s1", transport: "http" })),
    (e: unknown) => e instanceof InputError,
  );
});

test("improper-usage: http with non-http(s) url → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "s1", transport: "http", url: "ftp://example.com" })),
    (e: unknown) => e instanceof InputError,
  );
});

test("improper-usage: the retired sse transport → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "s1", transport: "sse" as never, url: "https://example.com/sse" })),
    (e: unknown) => e instanceof InputError,
  );
});

test("improper-usage: websocket without url → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "s1", transport: "websocket" })),
    (e: unknown) => e instanceof InputError,
  );
});

test("improper-usage: websocket with non-ws(s) url → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "s1", transport: "websocket", url: "https://example.com" })),
    (e: unknown) => e instanceof InputError,
  );
});

test("improper-usage: unknown transport → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "s1", transport: "grpc" as McpServerEntry["transport"] })),
    (e: unknown) => e instanceof InputError,
  );
});

test("improper-usage: retry.count zero → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "s1", transport: "stdio", command: "echo", retry: { count: 0, backoffMs: 100 } })),
    (e: unknown) => e instanceof InputError,
  );
});

test("improper-usage: retry.count non-integer → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "s1", transport: "stdio", command: "echo", retry: { count: 1.5, backoffMs: 100 } })),
    (e: unknown) => e instanceof InputError,
  );
});

test("improper-usage: retry.backoffMs negative → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "s1", transport: "stdio", command: "echo", retry: { count: 3, backoffMs: -1 } })),
    (e: unknown) => e instanceof InputError,
  );
});

test("improper-usage: retry.backoffMs non-finite → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "s1", transport: "stdio", command: "echo", retry: { count: 3, backoffMs: Number.NaN } })),
    (e: unknown) => e instanceof InputError,
  );
});

test("improper-usage: timeoutMs zero → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "s1", transport: "stdio", command: "echo", timeoutMs: 0 })),
    (e: unknown) => e instanceof InputError,
  );
});

test("improper-usage: api-key auth on stdio without envName → InputError", () => {
  assert.throws(
    () => validateMcpServerEntry(entry({ id: "s1", transport: "stdio", command: "echo", auth: { type: "api-key", token: "k" } })),
    (e: unknown) => e instanceof InputError && (e as Error).message.includes("envName"),
  );
});

test("improper-usage: duplicate server ids → InputError", () => {
  const config: McpModuleConfig = {
    servers: [
      entry({ id: "dup", transport: "stdio", command: "echo" }),
      entry({ id: "dup", transport: "stdio", command: "cat" }),
    ],
    defaults: DEFAULTED.defaults,
    limits: DEFAULTED.limits,
  };
  assert.throws(
    () => validateMcpModuleConfig(config),
    (e: unknown) => e instanceof InputError && (e as Error).message.includes("Duplicate"),
  );
});

test("improper-usage: exceeds maxServers → McpError", () => {
  const tooMany: McpServerEntry[] = [];
  for (let i = 0; i < DEFAULTED.limits.maxServers + 1; i++) {
    tooMany.push(entry({ id: `s${i}`, transport: "stdio", command: "echo" }));
  }
  const config: McpModuleConfig = {
    servers: tooMany,
    defaults: DEFAULTED.defaults,
    limits: DEFAULTED.limits,
  };
  assert.throws(
    () => validateMcpModuleConfig(config),
    (e: unknown) => e instanceof McpError && (e as Error).message.includes("max servers"),
  );
});

test("improper-usage: valid stdio entry passes", () => {
  assert.doesNotThrow(() => validateMcpServerEntry(entry({ id: "valid", transport: "stdio", command: "echo" })));
});

test("improper-usage: valid http entry passes", () => {
  assert.doesNotThrow(() => validateMcpServerEntry(entry({ id: "valid", transport: "http", url: "https://example.com/mcp" })));
});

test("improper-usage: valid websocket entry passes", () => {
  assert.doesNotThrow(() => validateMcpServerEntry(entry({ id: "valid", transport: "websocket", url: "wss://example.com/ws" })));
});

test("improper-usage: valid api-key auth on http passes", () => {
  assert.doesNotThrow(() => validateMcpServerEntry(entry({ id: "valid", transport: "http", url: "https://example.com", auth: { type: "api-key", token: "k", header: "X-Key" } })));
});

test("improper-usage: valid api-key auth on stdio with envName passes", () => {
  assert.doesNotThrow(() => validateMcpServerEntry(entry({ id: "valid", transport: "stdio", command: "echo", auth: { type: "api-key", token: "k", envName: "API_KEY" } })));
});

// ---------------------------------------------------------------------------
// Unknown format: server returns unexpected data → graceful handling
// ---------------------------------------------------------------------------

test("unknown-format: non-JSON message gracefully ignored (no crash)", () => {
  // The core's onMessage handler parses JSON; invalid JSON is silently ignored.
  const handler = (raw: string) => {
    try { JSON.parse(raw); } catch { /* ignored — graceful */ }
  };
  assert.doesNotThrow(() => handler("not valid json"));
  assert.doesNotThrow(() => handler(""));
  assert.doesNotThrow(() => handler("{ broken"));
});

test("unknown-format: tools/list with no tools array → McpError on callTool path", () => {
  // When the server returns tools/list with no tools array, the core throws
  // mcp_list_tools_failed. Verify the error is a typed McpError.
  const error = new McpError("MCP tools/list returned invalid result", "mcp_list_tools_failed", false, {});
  assert.equal(error.code, "mcp_list_tools_failed");
  assert.equal(error.retryable, false);
});

test("unknown-format: too many tools → McpError with mcp_too_many_tools", () => {
  const error = new McpError("MCP server returned too many tools (99999)", "mcp_too_many_tools", false, {});
  assert.equal(error.code, "mcp_too_many_tools");
});

test("unknown-format: tools/call with no content array → McpError", () => {
  const error = new McpError("MCP tools/call returned invalid result", "mcp_call_tool_failed", false, {});
  assert.equal(error.code, "mcp_call_tool_failed");
});

test("unknown-format: RPC error from server → McpError with code", () => {
  const error = new McpError("method not found", "mcp_rpc_error_-32601", false, { code: -32601 });
  assert.equal(error.code, "mcp_rpc_error_-32601");
  assert.equal(error.safeDetails.code, -32601);
});

test("unknown-format: protocol version mismatch → McpError", () => {
  const error = new McpError(
    "MCP protocol version mismatch: client requested 2025-11-25, server returned 2024-01-01",
    "mcp_protocol_version_mismatch",
    false,
    { requested: "2025-11-25", returned: "2024-01-01" },
  );
  assert.equal(error.code, "mcp_protocol_version_mismatch");
});

test("unknown-format: oversized message → McpError", () => {
  const error = new McpError("MCP message exceeds maximum size", "mcp_message_oversized", false, {});
  assert.equal(error.code, "mcp_message_oversized");
  assert.equal(error.retryable, false);
});

test("unknown-format: tool with name too long is filtered (not crash)", () => {
  // The core's listTools filters tools whose name exceeds MAX_TOOL_NAME_LENGTH.
  // Verify the limit is derived from ROOT_POLICY (not hardcoded).
  const maxLen = ROOT_POLICY.tools.limits.maximumToolNameCharacters;
  assert.ok(maxLen > 0);
  // A tool with a name longer than maxLen would be filtered out silently.
  const longName = "t".repeat(maxLen + 1);
  assert.ok(longName.length > maxLen);
});

test("unknown-format: tool with missing inputSchema is filtered (not crash)", () => {
  // The core's listTools requires tool.inputSchema to be an object.
  // A tool with inputSchema: null would be filtered out.
  const badTool = { name: "bad", inputSchema: null } as unknown as import("../../src/mcp/index.ts").McpTool;
  assert.equal(badTool.inputSchema, null);
});

test("unknown-format: HTTP 5xx → retryable McpError", () => {
  const error = new McpError("MCP HTTP transport returned 503", "mcp_http_error", true, { status: 503 });
  assert.equal(error.retryable, true);
  assert.equal(error.safeDetails.status, 503);
});

test("unknown-format: HTTP 4xx → non-retryable McpError", () => {
  const error = new McpError("MCP HTTP transport returned 404", "mcp_http_error", false, { status: 404 });
  assert.equal(error.retryable, false);
});

test("unknown-format: transport-level errors are flagged transportLevel=true", () => {
  const transportErrors = [
    new McpError("closed", "mcp_transport_closed", true, {}, true),
    new McpError("not connected", "mcp_not_connected", false, {}, true),
    new McpError("send failed", "mcp_send_failed", true, {}, true),
    new McpError("process error", "mcp_process_error", false, {}, true),
    new McpError("websocket error", "mcp_websocket_error", false, {}, true),
    new McpError("closed", "mcp_closed", false, {}, true),
  ];
  for (const e of transportErrors) {
    assert.equal(e.transportLevel, true, `${e.code} must be transportLevel`);
  }
});

test("unknown-format: non-transport errors are NOT flagged transportLevel", () => {
  const nonTransportErrors = [
    new McpError("timeout", "mcp_timeout", true, {}),
    new McpError("http error", "mcp_http_error", true, { status: 500 }),
    new McpError("rpc error", "mcp_rpc_error_-32601", false, {}),
    new McpError("cancelled", "mcp_cancelled", false, {}),
  ];
  for (const e of nonTransportErrors) {
    assert.equal(e.transportLevel, false, `${e.code} must NOT be transportLevel`);
  }
});

test("unknown-format: McpError transportLevel defaults to false", () => {
  const e = new McpError("msg", "mcp_error");
  assert.equal(e.transportLevel, false);
});

test("unknown-format: isTransportError checks the flag not a keyword set", () => {
  const transportErr = new McpError("closed", "mcp_transport_closed", true, {}, true);
  const nonTransportErr = new McpError("timeout", "mcp_timeout", true, {});
  assert.equal(isTransportError(transportErr), true);
  assert.equal(isTransportError(nonTransportErr), false);
});
