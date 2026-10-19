import assert from "node:assert/strict";
import test from "node:test";

import { createMcpClientFromConfig, mcpToolCapabilities, type McpTool } from "../../src/mcp/index.ts";
import { startStreamableHttpServer } from "./fixtures/streamable-http-server.ts";

// ---------------------------------------------------------------------------
// The ONE MCP effect classifier: a server's annotations decide how a tool is
// CLASSIFIED (never what it can touch — confinement decides that), failing
// closed: `read` only when declared read-only.
// ---------------------------------------------------------------------------

const tool = (annotations?: McpTool["annotations"]): McpTool => ({ name: "t", inputSchema: { type: "object" }, ...(annotations !== undefined ? { annotations } : {}) });

// The reference filesystem server's own annotations (@modelcontextprotocol/
// server-filesystem, recorded by the MCP test-drive verification): the write
// tools say readOnlyHint:false, the read tools readOnlyHint:true.
const FILESYSTEM_ANNOTATIONS: Readonly<Record<string, McpTool["annotations"]>> = {
  read_file: { readOnlyHint: true }, read_text_file: { readOnlyHint: true }, read_media_file: { readOnlyHint: true },
  read_multiple_files: { readOnlyHint: true }, list_directory: { readOnlyHint: true }, list_directory_with_sizes: { readOnlyHint: true },
  directory_tree: { readOnlyHint: true }, search_files: { readOnlyHint: true }, get_file_info: { readOnlyHint: true },
  list_allowed_directories: { readOnlyHint: true },
  write_file: { readOnlyHint: false, destructiveHint: true }, edit_file: { readOnlyHint: false, destructiveHint: true },
  create_directory: { readOnlyHint: false }, move_file: { readOnlyHint: false, destructiveHint: true },
};

test("tool-adapter: annotations classify read vs write — the reference filesystem server's write tools are writes", () => {
  const writes = Object.entries(FILESYSTEM_ANNOTATIONS)
    .filter(([, annotations]) => mcpToolCapabilities(tool(annotations)).includes("write"))
    .map(([name]) => name).sort();
  assert.deepEqual(writes, ["create_directory", "edit_file", "move_file", "write_file"]);
});

test("tool-adapter: absent or partial hints fail CLOSED to write + network", () => {
  assert.deepEqual([...mcpToolCapabilities(tool())], ["write", "network"]);
  assert.deepEqual([...mcpToolCapabilities(tool({ destructiveHint: false }))], ["write", "network"]);
  assert.deepEqual([...mcpToolCapabilities(tool({ readOnlyHint: true }))], ["read", "network"]);
  assert.deepEqual([...mcpToolCapabilities(tool({ readOnlyHint: true, openWorldHint: false }))], ["read"]);
});

test("tool-adapter: tools/list keeps the server's annotations (only the spec hints), where they used to be dropped", async () => {
  const server = await startStreamableHttpServer({
    tools: [{ name: "echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, openWorldHint: false, title: "Echo", injected: "dropped" } }],
  });
  try {
    const client = createMcpClientFromConfig(
      { id: "fixture", transport: "http", url: server.url },
      { clientInfo: { name: "t", version: "1" }, defaultProtocolVersion: "2025-11-25", defaultTimeoutMs: 5000 },
    );
    await client.connect();
    const [echo] = await client.listTools();
    assert.deepEqual(echo!.annotations, { readOnlyHint: true, openWorldHint: false, title: "Echo" });
    assert.deepEqual([...mcpToolCapabilities(echo!)], ["read"]);
    await client.close();
  } finally {
    await server.close();
  }
});
