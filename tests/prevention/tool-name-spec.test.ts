// @vitest-environment node
/**
 * Prevention test: every name the harness advertises to the model is a legal
 * Responses function name, and the `mcp__` namespace belongs to MCP tools
 * only — so the naming owner's `isMcpToolName` predicate can never be true of
 * a built-in, and a model call can never be dispatched to the wrong family.
 *
 * The class (sec-design T-1b): the owner (`engine/src/mcp/tool-name.ts`)
 * claimed "a built-in can never start with the prefix — a prevention test
 * holds that" while no such test existed, and the MCP names it replaced
 * (`mcp:<server>:<tool>`) had violated the function-name grammar on 105 of
 * 110 test-drive requests without a single failing check.
 *
 * The population is the server's REAL built-in manifest (no MCP runtime is
 * started here), plus names minted by the one naming owner for adversarial
 * raw MCP pairs (a dot, a space, non-ASCII, an over-long name, the longest
 * server id); the whole set is pushed through the Responses projection
 * (`toolsToResponses`), which refuses an illegal name.
 */
import { describe, expect, it } from "vitest";

import { getToolManifest } from "../../server/tools/tools-bridge.ts";
import { FUNCTION_NAME_PATTERN, toolsToResponses } from "../../engine/src/shared/llm/responses.ts";
import { isMcpToolName, MCP_SERVER_ID_MAX_CHARACTERS, MCP_TOOL_NAME_PREFIX, mcpToolName } from "../../engine/src/mcp/tool-name.ts";

const ADVERSARIAL_PAIRS: readonly (readonly [string, string])[] = [
  ["srv", "admin.tools.list"],
  ["srv", "has space"],
  ["srv", "ünïcødé-tool"],
  ["srv", "x".repeat(300)],
  ["a".repeat(MCP_SERVER_ID_MAX_CHARACTERS), "t"],
  ["a-b", "c__d"],
];

describe("tool names are spec-legal and the MCP namespace is MCP's alone", () => {
  it("no built-in wears the MCP prefix, and every built-in name is a legal function name", () => {
    const builtIns = getToolManifest().filter((entry) => entry.category === "built-in");
    expect(builtIns.length, "the built-in manifest must be the real, non-empty one").toBeGreaterThan(5);
    expect(builtIns.filter((entry) => isMcpToolName(entry.name) || entry.name.startsWith(MCP_TOOL_NAME_PREFIX)).map((entry) => entry.name)).toEqual([]);
    expect(builtIns.filter((entry) => !FUNCTION_NAME_PATTERN.test(entry.name)).map((entry) => entry.name)).toEqual([]);
  });

  it("the Responses projection accepts the built-ins plus minted adversarial MCP names — and refuses an illegal one", () => {
    const minted = ADVERSARIAL_PAIRS.map(([server, tool]) => mcpToolName(server, tool));
    for (const name of minted) {
      expect(name, name).toMatch(FUNCTION_NAME_PATTERN);
      expect(isMcpToolName(name)).toBe(true);
    }
    expect(new Set(minted).size, "distinct raw pairs never share a name").toBe(minted.length);
    const names = [...getToolManifest().filter((entry) => entry.category === "built-in").map((entry) => entry.name), ...minted];
    const tools = names.map((name) => ({ type: "function", function: { name, description: name, parameters: { type: "object" } } }));
    expect(toolsToResponses(tools)).toHaveLength(names.length);
    // The projection is a real check, not a pass-through: the retired spelling is refused.
    expect(() => toolsToResponses([{ type: "function", function: { name: "mcp:srv:admin.tools.list", description: "x", parameters: { type: "object" } } }])).toThrow(/responses_tool_name_invalid/u);
  });
});
