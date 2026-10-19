import assert from "node:assert/strict";
import test from "node:test";

import {
  isMcpServerId,
  isMcpToolName,
  MCP_SERVER_ID_MAX_CHARACTERS,
  MCP_TOOL_NAME_PREFIX,
  mcpToolName,
  mcpToolNameHead,
} from "../../src/mcp/index.ts";
import { FUNCTION_NAME_PATTERN, toolsToResponses } from "../../src/shared/llm/responses.ts";

// ---------------------------------------------------------------------------
// The ONE MCP naming owner: (server id, MCP tool name) → a spec-legal
// Responses function name, minted once, deterministic, collision-free for
// distinct raw pairs. The projection only VALIDATES (fails closed).
// ---------------------------------------------------------------------------

const LONG_TOOL = "t".repeat(128);
const SERVERS = ["fs", "context7", "brave-search", "a", "x".repeat(MCP_SERVER_ID_MAX_CHARACTERS)];
const TOOLS = ["read_file", "admin.tools.list", "DATA_EXPORT_v2", LONG_TOOL, "résumé", "a:b", "a.b", "a_b", "with space", "-dash"];

test("tool-name: every minted name is a legal Responses function name, across servers x tools", () => {
  for (const serverId of SERVERS) {
    for (const toolName of TOOLS) {
      const name = mcpToolName(serverId, toolName);
      assert.match(name, FUNCTION_NAME_PATTERN, `${serverId} / ${toolName} → ${name}`);
      assert.ok(name.startsWith(mcpToolNameHead(serverId)), "the server's head is the name's prefix");
      assert.equal(isMcpToolName(name), true);
    }
  }
});

test("tool-name: a plain legal name stays readable; a sanitised one carries the raw pair's digest", () => {
  assert.equal(mcpToolName("fs", "read_file"), "mcp__fs__read_file");
  // GOLDEN: the exact digest is pinned. Persisted switches and call history
  // hold these names (migration 19 wrote them), so a change to the minted
  // output orphans every stored name unless a NEW rename migration ships.
  assert.equal(mcpToolName("srv", "admin.tools.list"), "mcp__srv__admin_tools_list_ab37440b");
  assert.equal(mcpToolName("srv", "t".repeat(200)), `mcp__srv__${"t".repeat(109)}_2c271fbc`);
  assert.equal(mcpToolName("srv", LONG_TOOL).length, 128, "an over-long name is cut to the spec maximum, digest included");
});

test("tool-name: minting is deterministic and distinct raw pairs never share a name", () => {
  const seen = new Map<string, string>();
  for (const serverId of SERVERS) {
    for (const toolName of TOOLS) {
      const name = mcpToolName(serverId, toolName);
      assert.equal(mcpToolName(serverId, toolName), name, "same pair, same name");
      const pair = `${serverId}\u0000${toolName}`;
      assert.equal(seen.get(name) ?? pair, pair, `${name} was minted for two pairs`);
      seen.set(name, pair);
    }
  }
  // The pairs that a lossy ':'/'.'→'_' swap would merge stay apart.
  assert.notEqual(mcpToolName("srv", "a.b"), mcpToolName("srv", "a:b"));
  assert.notEqual(mcpToolName("srv", "a.b"), mcpToolName("srv", "a_b"));
});

test("tool-name: a tool named like another's digest name cannot take it — the plain and digest spaces are disjoint (SECB-V-5)", () => {
  const digestName = mcpToolName("srv", "foo.bar");
  assert.equal(digestName, "mcp__srv__foo_bar_70bdbd8f", "GOLDEN: the sanitised name keeps its v19 digest");
  const lookalike = mcpToolName("srv", "foo_bar_70bdbd8f");
  assert.notEqual(lookalike, digestName, "a plain name shaped like a digest name is minted in the digest form");
  assert.match(lookalike, /^mcp__srv__foo_bar_70bdbd8f_[0-9a-f]{8}$/u);
  // Only the exact digest SHAPE is taken over; nearby plain names stay readable.
  assert.equal(mcpToolName("srv", "foo_bar_70BDBD8F"), "mcp__srv__foo_bar_70BDBD8F", "uppercase hex is not a digest tag");
  assert.equal(mcpToolName("srv", "foo_bar_70bdbd8"), "mcp__srv__foo_bar_70bdbd8", "seven hex characters are not a digest tag");
  // Exhaustively for a population: no plain name equals any digest name.
  const tools = ["a.b", "a_b", "a:b", "x.y.z", "x_y_z", ...["a.b", "x.y.z"].map((t) => mcpToolName("srv", t).slice("mcp__srv__".length))];
  const names = tools.map((t) => mcpToolName("srv", t));
  assert.equal(new Set(names).size, names.length, `distinct tools, distinct names: ${names.join(", ")}`);
});

test("tool-name: the server-id pattern refuses '_', '.', edge hyphens, and ids too long to name any tool", () => {
  for (const id of ["a_b", "a.b", "-a", "a-", "", "x".repeat(MCP_SERVER_ID_MAX_CHARACTERS + 1)]) {
    assert.equal(isMcpServerId(id), false, JSON.stringify(id));
    assert.throws(() => mcpToolName(id, "x"), (e: unknown) => (e as { code?: string }).code === "mcp_config_invalid");
  }
  for (const id of ["a", "brave-search", "context7", "A1-b2"]) assert.equal(isMcpServerId(id), true, id);
});

test("tool-name: two server heads are never prefixes of each other (the lookup by head is unambiguous)", () => {
  assert.equal(mcpToolName("ab", "x").startsWith(mcpToolNameHead("a")), false);
  assert.equal(mcpToolNameHead("a-b").startsWith(mcpToolNameHead("a")), false);
});

test("tool-name: the Responses projection refuses a name outside the spec grammar and accepts the edges", () => {
  const fn = (name: unknown) => ({ type: "function", function: { name, parameters: { type: "object" } } });
  for (const bad of ["mcp:fs:x", "a.b", "x".repeat(129), "", 7]) {
    assert.throws(() => toolsToResponses([fn(bad)]), (e: unknown) => /responses_tool_name_invalid/u.test((e as Error).message), String(bad));
  }
  for (const good of ["a", "x".repeat(128), `${MCP_TOOL_NAME_PREFIX}fs__read_file`]) {
    assert.equal(toolsToResponses([fn(good)]).length, 1, good);
  }
  assert.throws(() => toolsToResponses([{ type: "custom", name: "bad name" }]), (e: unknown) => /responses_tool_name_invalid/u.test((e as Error).message));
  assert.throws(() => toolsToResponses([{ type: "namespace", name: "n".repeat(65), tools: [] }]), (e: unknown) => /responses_tool_name_invalid/u.test((e as Error).message));
});
