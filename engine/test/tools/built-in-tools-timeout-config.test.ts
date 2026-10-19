import assert from "node:assert/strict";
import test from "node:test";

import { createExecuteCommandTool } from "../../src/tools/built-in-tools.ts";
import { createBuiltInToolManifestEntries } from "../../src/tools/built-in-tool-manifest.ts";
import type { ToolAdapterContext } from "../../src/tools/tool-adapter.ts";
import { mkOwnedTempDir } from "../support/temp-dir.ts";

const REPO_ROOT = mkOwnedTempDir("exec-timeout-config-");
const CONTEXT: ToolAdapterContext = { repositoryRoot: REPO_ROOT };

test("exec-cmd timeout: timeoutMs option is used by the tool (not hardcoded 60000)", async () => {
  // Pass a custom timeoutMs via the options (the same way the chat runtime
  // threads config.document.tools.defaultBounds.timeoutMs through). The tool
  // must use THIS value, not the prior hardcoded 60000.
  const tool = createExecuteCommandTool({ allowedCommands: ["node", "echo"], timeoutMs: 5_000 });
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "echo", args: ["x"] } },
    CONTEXT,
  );
  const parsed = JSON.parse(result.content) as { timeoutMs: number };
  assert.equal(parsed.timeoutMs, 5_000, "the tool must report the configured timeoutMs, not 60000");
});

test("exec-cmd timeout: manifest entry uses the configured timeoutMs", () => {
  const entries = createBuiltInToolManifestEntries({ executeCommandTimeoutMs: 12_345 });
  const cmd = entries.find((e) => e.id === "execute_command")!;
  assert.equal(cmd.bounds.timeoutMs, 12_345, "the manifest entry's bounds.timeoutMs must reflect the configured value");
});

test("exec-cmd timeout: default fallback is DEFAULT_TOOL_RESOURCE_BOUNDS.timeoutMs (30000), not 60000", async () => {
  // When no timeoutMs is provided, the tool falls back to the canonical
  // DEFAULT_TOOL_RESOURCE_BOUNDS.timeoutMs (30_000), NOT the prior
  // hardcoded 60_000. This makes the tool consistent with the config's
  // defaultBounds.timeoutMs (30000 in bridlewise.config.json).
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "echo", args: ["x"] } },
    CONTEXT,
  );
  const parsed = JSON.parse(result.content) as { timeoutMs: number };
  assert.equal(parsed.timeoutMs, 30_000, "default fallback must be 30000, not 60000");
});

test("exec-cmd timeout: default manifest entry uses 30000 (not 60000)", () => {
  const entries = createBuiltInToolManifestEntries();
  const cmd = entries.find((e) => e.id === "execute_command")!;
  assert.equal(cmd.bounds.timeoutMs, 30_000, "default manifest entry must use 30000, not 60000");
});

test("exec-cmd timeout: rejects non-positive timeoutMs", () => {
  assert.throws(
    () => createExecuteCommandTool({ timeoutMs: 0 }),
    /positive finite/,
  );
  assert.throws(
    () => createExecuteCommandTool({ timeoutMs: -1 }),
    /positive finite/,
  );
  assert.throws(
    () => createExecuteCommandTool({ timeoutMs: Number.NaN }),
    /positive finite/,
  );
});

test("exec-cmd timeout: rejects timeoutMs exceeding root policy maximum", () => {
  // ROOT_POLICY.tools.limits.maximumToolTimeoutMs is 600_000.
  assert.throws(
    () => createExecuteCommandTool({ timeoutMs: 600_001 }),
    /exceeds root policy maximum/,
  );
});

test("exec-cmd timeout: a fast command is NOT killed by the configured timeout", async () => {
  const tool = createExecuteCommandTool({ timeoutMs: 30_000 });
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "echo", args: ["fast"] } },
    CONTEXT,
  );
  assert.equal(result.isError, false);
  const parsed = JSON.parse(result.content) as { timedOut: boolean };
  assert.equal(parsed.timedOut, false);
});
