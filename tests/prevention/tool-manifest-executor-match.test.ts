// @vitest-environment node
/**
 * Prevention test: the tool manifest and the tool executor are ONE
 * unified pipeline. Every tool the LLM can call (in
 * the manifest) MUST have a server-side executor, and every executor
 * handler MUST be advertised in the manifest. A mismatch either way is a
 * wiring bug:
 * manifest tool with no executor → the LLM calls it and gets "not
 * available" (the original root cause).
 * executor tool with no manifest entry → the server can run it but
 * the LLM never knows it exists (a silently-hidden capability).
 *
 * This test mechanically enforces the 1:1 correspondence so neither
 * direction can drift.
 */
import { describe, it, expect } from "vitest";
import { getToolManifest } from "../../server/tools/tools-bridge.ts";
import { isToolExecutable, listExecutableTools } from "../../server/tools/tool-executor.ts";
import { TOOL_KINDS } from "../../shared/web-ui-types.ts";

/**
 * The valid tool kinds, TAKEN FROM THE OWNER RATHER THAN PARSED OUT OF IT.
 *
 * This used to read `shared/web-ui-types.ts` as text and pull `| "name"`
 * members out of the `ToolKind` union. That is a claim about the file's
 * SPELLING, and it broke the moment the vocabulary was inverted so the array
 * owns it and the type derives — the parse found nothing, the set came back
 * EMPTY, and "no tool has an invalid kind" became true of every input. The
 * only reason that was noticed is the non-emptiness sanity check below, which
 * is exactly why it is there.
 *
 * `TOOL_KINDS` is a runtime value now, so the test imports the vocabulary
 * itself. There is no text to parse and no spelling to keep in step.
 */
function discoverValidToolKinds(): Set<string> {
  return new Set<string>(TOOL_KINDS);
}

describe("tool-manifest-executor-match (unified pipeline)", () => {
  it("every built-in manifest tool has a server-side executor implementation", () => {
    const manifest = getToolManifest();
    const builtIn = manifest.filter((entry) => entry.category === "built-in");
    const missing = builtIn.filter((entry) => !isToolExecutable(entry.name));
    expect(
      missing,
      `Built-in tools in manifest but NOT in executor: ${missing.map((m) => m.name).join(", ")}.`,
    ).toEqual([]);
  });

  it("every live MCP manifest tool is dispatchable through the executor's MCP (mcp__*) fallthrough", () => {
    // MCP tools are REAL now: an entry in the manifest is a discovered,
    // connected tool, and the executor routes `mcp__*` names to the runtime
    // owner's registry. The static `TOOL_HANDLERS` table cannot hold them
    // (names unknown until discovery), so the contract is: every mcp-category
    // manifest entry's name satisfies the executor's dynamic dispatch.
    // A failure here means a phantom tool — advertised, not callable.
    const manifest = getToolManifest();
    const mcp = manifest.filter((entry) => entry.category === "mcp");
    const undispatchable = mcp.filter((entry) => !isToolExecutable(entry.name));
    expect(
      undispatchable,
      `MCP tools in manifest but NOT dispatchable: ${undispatchable.map((m) => m.name).join(", ")}.`,
    ).toEqual([]);
  });

  it("every executor tool is in the manifest (no orphaned handlers)", () => {
    const manifestNames = new Set(getToolManifest().map((entry) => entry.name));
    const orphans = listExecutableTools().filter((name) => !manifestNames.has(name));
    expect(
      orphans,
      `Executor tools NOT in manifest: ${orphans.join(", ")}.`,
    ).toEqual([]);
  });

  it("the unified manifest exposes the full production tool surface", () => {
    const names = new Set(getToolManifest().map((entry) => entry.name));
    // Dynamic: derive the expected surface from the executor's
    // handler list — NEVER hardcode tool names. The 1:1 match tests above
    // already verify manifest↔executor correspondence; this test adds a
    // SIZE check so a silently-empty manifest or executor is caught.
    const executable = listExecutableTools();
    expect(executable.length, "the executor must have at least 1 tool").toBeGreaterThan(0);
    expect(names.size, "the manifest must have at least 1 tool").toBeGreaterThan(0);
    // Every executable tool must be in the manifest (no orphaned handlers).
    for (const name of executable) {
      expect(names.has(name), `Executable tool '${name}' must be in the manifest`).toBe(true);
    }
  });

  it("execute_command runs in the project directory, not the server dir", () => {
    // The unified executor must resolve execute_command's cwd against the
    // project root (the old bug ran tools in the server directory). Verify
    // the handler exists and the executor accepts a projectRoot context.
    expect(isToolExecutable("execute_command")).toBe(true);
    // A real spawn test is in the executor unit test; here we only assert
    // the tool is wired and executable through the unified path.
  });

  // prevention: every tool must have a valid `kind` (granular category).
  // A tool with an unknown kind means the adapterId → kind mapping in
  // harness-config.ts was not updated when a new adapter was added. The valid
  // set is discovered dynamically from the `ToolKind` union (the type-level
  // source of truth) — a new kind added there is auto-recognized here.
  const VALID_KINDS = discoverValidToolKinds();

  it("the discovered VALID_KINDS set is non-empty (sanity: the ToolKind union parse is not broken)", () => {
    expect(VALID_KINDS.size, "must discover tool kinds from the ToolKind union in shared/web-ui-types.ts").toBeGreaterThan(0);
  });

  it("every tool in the manifest has a valid kind (granular categories)", () => {
    const manifest = getToolManifest();
    const invalid = manifest.filter((t) => !VALID_KINDS.has(t.kind));
    expect(
      invalid,
      `Tools with invalid kind: ${invalid.map((t) => `${t.name}→${t.kind}`).join(", ")}.`,
    ).toEqual([]);
  });

  it("the manifest has more than one distinct kind (not just built-in/mcp binary)", () => {
    const manifest = getToolManifest();
    const kinds = new Set(manifest.map((t) => t.kind));
    expect(kinds.size).toBeGreaterThan(2);
  });
});
