import assert from "node:assert/strict";
import test from "node:test";

import { createExecuteCommandTool } from "../../src/tools/built-in-tools.ts";
import type { ToolAdapterContext } from "../../src/tools/tool-adapter.ts";
import { mkOwnedTempDir } from "../support/temp-dir.ts";

/**
 * INVARIANT #51: execute_command must kill the child process when its
 * internal timeout fires and report `timedOut: true` in the result.
 *
 * The tool's timeout (EXECUTE_COMMAND_TIMEOUT_MS = 60s) is not configurable,
 * so this test temporarily overrides globalThis.setTimeout to fire the
 * timeout callback after a SHORT delay (500ms) regardless of the requested
 * delay. This makes the test fast and deterministic while exercising the
 * real kill path: the override is scoped to the synchronous window where
 * execute calls runCommand which calls setTimeout, then the original
 * is restored immediately.
 */

const REPO_ROOT = mkOwnedTempDir("exec-timeout-");
const CONTEXT: ToolAdapterContext = { repositoryRoot: REPO_ROOT };

test("exec-cmd timeout: child is killed and timedOut is true on timeout", async () => {
  const tool = createExecuteCommandTool({ allowedCommands: ["node"] });
  const originalSetTimeout = globalThis.setTimeout;
  // Override setTimeout to fire the callback after 500ms no matter what delay
  // is requested. The tool calls setTimeout(cb, 60000); our override schedules
  // the real timer at 500ms instead. This triggers the timeout path that sets
  // timedOut=true and kills the child.
  globalThis.setTimeout = ((cb: TimerHandler, _delay?: number) => {
    return originalSetTimeout(cb, 500);
  }) as typeof globalThis.setTimeout;

  let result;
  try {
    // Call execute synchronously — runCommand calls setTimeout during
    // the synchronous Promise executor, before execute returns its promise.
    const resultPromise = tool.execute(
      { toolId: "execute_command", arguments: { command: "node", args: ["-e", "setTimeout(()=>{},10000)"] } },
      CONTEXT,
    );
    // Restore immediately: the override was only needed for that one call.
    globalThis.setTimeout = originalSetTimeout;
    result = await resultPromise;
  } finally {
    // Ensure restoration even if something above throws.
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(result.isError, true, "a timed-out command must report isError");
  const parsed = JSON.parse(result.content) as {
    timedOut: boolean;
    cancelled: boolean;
    exitCode: number | null;
    signal: string | null;
  };
  assert.equal(parsed.timedOut, true, "timedOut must be true when the internal timeout fires");
  assert.equal(parsed.cancelled, true, "cancelled must be true on timeout");
  assert.ok(
    parsed.exitCode === null || parsed.exitCode !== 0,
    "the child must be killed (non-zero or null exit code)",
  );
});

test("exec-cmd timeout: a fast command is NOT killed by the timeout", async () => {
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "echo", args: ["fast"] } },
    CONTEXT,
  );
  assert.equal(result.isError, false);
  const parsed = JSON.parse(result.content) as { timedOut: boolean };
  assert.equal(parsed.timedOut, false, "a fast command must not report timedOut");
});

test("exec-cmd timeout: result includes the timeoutMs field", async () => {
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "echo", args: ["x"] } },
    CONTEXT,
  );
  const parsed = JSON.parse(result.content) as { timeoutMs: number };
  assert.ok(parsed.timeoutMs > 0, "the result must include the configured timeoutMs");
  assert.equal(typeof parsed.timeoutMs, "number");
});
