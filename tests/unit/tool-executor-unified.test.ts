// @vitest-environment node
/**
 * Unit tests for the unified tool executor — covers the editor tools
 * (preimage-hash verification, atomic write, applyPatch unified-diff
 * parsing), execute_command (runs in the project dir, not the server
 * dir), and the adapter-not-configured blockers. These are the tools
 * with real logic added in the unified pipeline.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { executeToolCall, listExecutableTools, type ToolExecutionContext } from "../../server/tools/tool-executor.ts";
import { getToolManifest, invalidateToolManifestCache } from "../../server/tools/tools-bridge.ts";
import { installCustomizationConfigStore, setCustomizationValue } from "../../engine/src/shared/exposure/index.ts";
import { serverConfig } from "../../server/kernel/config.ts";
import { registerAllExposure } from "../../engine/src/shared/exposure/registrations/index.ts";
import { editorState } from "../../engine/src/shared/exposure/registrations/editor.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

let projectRoot = "";
let ctx: ToolExecutionContext;

beforeEach(() => {
  projectRoot = createTempDir("ch-tools-");
  ctx = { projectRoot };
});

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

describe("unified executor — tool surface", () => {
  test("built-in manifest tools and executor agree on the full tool set", () => {
    // the manifest now includes MCP entries (config metadata, not
    // executable). Only built-in tools must match the executor 1:1.
    const builtInNames = new Set(
      getToolManifest().filter((e) => e.category === "built-in").map((e) => e.name),
    );
    const execNames = new Set(listExecutableTools());
    expect(builtInNames).toEqual(execNames);
    // 22 production tools across filesystem/editor/built-in/intelligence/memory/quality/git.
    expect(listExecutableTools().length).toBeGreaterThanOrEqual(20);
  });
});

describe("unified executor — the edit tool", () => {
  test("edit replaces an exact unique string (preimage is resolved, not supplied)", async () => {
    writeFileSync(join(projectRoot, "a.txt"), "hello world");
    const res = await executeToolCall("edit", { path: "a.txt", oldString: "hello", newString: "goodbye" }, ctx);
    expect(res.success).toBe(true);
    expect(readFileSync(join(projectRoot, "a.txt"), "utf8")).toBe("goodbye world");
  });

  test("edit refuses a not-found preimage and leaves the file unchanged", async () => {
    writeFileSync(join(projectRoot, "a.txt"), "hello world");
    const res = await executeToolCall("edit", { path: "a.txt", oldString: "not present at all", newString: "x" }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/not found/i);
    expect(readFileSync(join(projectRoot, "a.txt"), "utf8")).toBe("hello world");
  });

  test("edit refuses an AMBIGUOUS preimage (matches more than once) with a widen hint", async () => {
    writeFileSync(join(projectRoot, "dup.txt"), "foo\nfoo\nfoo");
    const res = await executeToolCall("edit", { path: "dup.txt", oldString: "foo", newString: "bar" }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/more than once|widen/i);
    expect(readFileSync(join(projectRoot, "dup.txt"), "utf8")).toBe("foo\nfoo\nfoo");
  });

  test("edit inserts by anchoring on an existing line", async () => {
    writeFileSync(join(projectRoot, "ins.txt"), "line1\nline3");
    const res = await executeToolCall("edit", { path: "ins.txt", oldString: "line1", newString: "line1\nline2" }, ctx);
    expect(res.success).toBe(true);
    expect(readFileSync(join(projectRoot, "ins.txt"), "utf8")).toBe("line1\nline2\nline3");
  });

  test("edit deletes by replacing with an empty newString", async () => {
    writeFileSync(join(projectRoot, "del.txt"), "keep\ngone\nkeep2");
    const res = await executeToolCall("edit", { path: "del.txt", oldString: "gone\n", newString: "" }, ctx);
    expect(res.success).toBe(true);
    expect(readFileSync(join(projectRoot, "del.txt"), "utf8")).toBe("keep\nkeep2");
  });

  test("edit replaces a whole file via the '<all>' sentinel", async () => {
    writeFileSync(join(projectRoot, "whole.txt"), "old content");
    const res = await executeToolCall("edit", { path: "whole.txt", oldString: "<all>", newString: "new content" }, ctx);
    expect(res.success).toBe(true);
    expect(readFileSync(join(projectRoot, "whole.txt"), "utf8")).toBe("new content");
  });

  test("edit creates a new file with an empty oldString", async () => {
    const res = await executeToolCall("edit", { path: "created.txt", oldString: "", newString: "fresh file" }, ctx);
    expect(res.success).toBe(true);
    expect(readFileSync(join(projectRoot, "created.txt"), "utf8")).toBe("fresh file");
  });

  test("edit refuses an empty oldString on an EXISTING file (never wipes it)", async () => {
    writeFileSync(join(projectRoot, "safe.txt"), "precious");
    const res = await executeToolCall("edit", { path: "safe.txt", oldString: "", newString: "clobber" }, ctx);
    expect(res.success).toBe(false);
    expect(readFileSync(join(projectRoot, "safe.txt"), "utf8")).toBe("precious");
  });

  test("edit refuses a syntactically invalid whole-file replace and leaves the file intact", async () => {
    writeFileSync(join(projectRoot, "code.ts"), "export const a = 1;\n");
    const res = await executeToolCall("edit", { path: "code.ts", oldString: "<all>", newString: "export const = (" }, ctx);
    expect(res.success).toBe(false);
    expect(res.output.toLowerCase()).toContain("syntax");
    expect(readFileSync(join(projectRoot, "code.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  test("edit rejects a path outside the project root", async () => {
    const res = await executeToolCall("edit", { path: "../escape.txt", oldString: "<all>", newString: "x" }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/traversal|outside|invalid/i);
  });

  test("edit lands a UTF-8 multibyte edit on the right byte range", async () => {
    writeFileSync(join(projectRoot, "uni.txt"), "const café = 1;\nconst b = 2;");
    const res = await executeToolCall("edit", { path: "uni.txt", oldString: "b = 2", newString: "b = 3" }, ctx);
    expect(res.success).toBe(true);
    expect(readFileSync(join(projectRoot, "uni.txt"), "utf8")).toBe("const café = 1;\nconst b = 3;");
  });

  test("the removed 5 edit tools no longer exist in the executor", async () => {
    for (const ghost of ["edit_replace_file", "edit_apply_patch", "edit_insert_text", "edit_delete_range", "edit_replace_range"]) {
      const res = await executeToolCall(ghost, { path: "x.txt" }, ctx);
      expect(res.success, `removed tool '${ghost}' must not dispatch`).toBe(false);
      expect(res.output).toMatch(/does not exist|not available|not exist/i);
    }
  });

  test("the unifiedEditEnabled Settings toggle genuinely gates the edit tool's manifest exposure", () => {
    // Deny-by-default: with the toggle off the model is offered no
    // file-editing surface at all; with it on, exactly one `edit` tool. A
    // deletion of the gate's condition would expose the tool permanently —
    // this arm reds on that (mutation-verified).
    registerAllExposure();
    // Config-bound knobs write through the installed store; an in-memory
    // document keeps the real config file untouched.
    let doc: Record<string, unknown> = {};
    installCustomizationConfigStore({
      configFilePath: serverConfig.harnessConfigPath,
      readDocument: () => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
      writeDocument: (next) => { doc = next; },
    });
    const prior = editorState.unifiedEditEnabled;
    try {
      setCustomizationValue("editor.unifiedEditEnabled", true);
      invalidateToolManifestCache();
      expect(
        getToolManifest().filter((e) => e.name === "edit"),
        "with the toggle on, exactly one edit tool is exposed",
      ).toHaveLength(1);

      setCustomizationValue("editor.unifiedEditEnabled", false);
      invalidateToolManifestCache();
      expect(
        getToolManifest().filter((e) => e.name === "edit" || e.name.startsWith("edit_")),
        "with the toggle off, no edit tool is exposed (deny-by-default)",
      ).toHaveLength(0);

      setCustomizationValue("editor.unifiedEditEnabled", true);
      invalidateToolManifestCache();
      expect(
        getToolManifest().filter((e) => e.name === "edit"),
        "re-enabling restores the edit tool",
      ).toHaveLength(1);
    } finally {
      setCustomizationValue("editor.unifiedEditEnabled", prior);
      invalidateToolManifestCache();
    }
  });
});

describe("unified executor — execute_command", () => {
  test("runs in the project directory, not the server dir", async () => {
    writeFileSync(join(projectRoot, "marker.txt"), "found");
    // `pwd` should resolve to projectRoot; `cat marker.txt` should find
    // the file we wrote there (it would NOT exist in the server dir).
    const res = await executeToolCall("execute_command", { command: "cat", args: ["marker.txt"] }, ctx);
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output) as { stdout: string };
    expect(parsed.stdout.trim()).toBe("found");
  });

  test("rejects a command not in the allowed list", async () => {
    // `whoami` is neither allowed, nor a file-mutation primitive, nor a program launcher, so this is the
    // allowlist's own refusal rather than the mutation gate's. `rm` used to be
    // the subject and now answers with the more specific reason below, which
    // is a stronger message, not a weaker one — so the two gates are asserted
    // apart instead of one assertion being loosened to cover both.
    const res = await executeToolCall("execute_command", { command: "whoami" }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain("not in the allowed list");
  });

  test("a command that changes files through the shell is refused BY NAME, with the tool to use instead", async () => {
    const res = await executeToolCall("execute_command", { command: "rm" }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain("write set");
    expect(res.output).toContain("edit");
  });

  test("rejects a command with arguments embedded in 'command'", async () => {
    const res = await executeToolCall("execute_command", { command: "git status" }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain("executable name only");
  });

  // the allowed list is now config-driven. Commands NOT
  // in the config's `tools.allowedCommands` are rejected with a typed error.
  // `rm`, `dd`, `sudo`, `chmod` are definitively not in the config's list; `sudo` runs any program, so the
  // reach gate (engine/src/tools/command-reach.ts) owns its refusal.
  test("rejects commands not in the config's allowed list (config-driven)", async () => {
    // Each command is checked against the gate that OWNS it, so a refusal
    // arriving for the wrong reason still fails. Asserting only `success ===
    // false` would let either gate cover for the other's absence.
    const { SHELL_FILE_MUTATION_COMMANDS } = await import("../../server/tools/tool-executor.ts");
    const { PROGRAM_LAUNCHERS } = await import("../../engine/src/kernel/command-names.ts");
    let checked = 0;
    for (const cmd of ["rm", "dd", "sudo", "chmod", "shutdown", "mkfs"]) {
      const res = await executeToolCall("execute_command", { command: cmd, args: ["x"] }, ctx);
      expect(res.success, `command '${cmd}' should be rejected (not in config allowedCommands)`).toBe(false);
      expect(res.output, `'${cmd}' was refused for the wrong reason`).toContain(
        SHELL_FILE_MUTATION_COMMANDS.has(cmd) ? "write set" : PROGRAM_LAUNCHERS.has(cmd) ? "(tool_command_launches_programs)" : "not in the allowed list",
      );
      checked += 1;
    }
    expect(checked).toBe(6);
  });

  // PROACTIVE #5: an out-of-project cwd is a typed error, not a silent
  // fallback to projectRoot.
  test("rejects a cwd outside the project root with a typed error", async () => {
    const res = await executeToolCall("execute_command", { command: "pwd", cwd: "/etc" }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/escapes the project folder/i);
  });
});

describe("unified executor — adapter-not-configured blockers", () => {
  test("search_web returns a typed blocker (honest, not silent)", async () => {
    const res = await executeToolCall("search_web", { query: "test" }, ctx);
    expect(res.success).toBe(false);
    const parsed = JSON.parse(res.output) as { error: string; adapter: string };
    expect(parsed.error).toBe("adapter_not_configured");
    expect(parsed.adapter).toBe("SearchAdapter");
  });

  test("unknown tool returns a typed error listing available tools", async () => {
    const res = await executeToolCall("nonexistent_tool", {}, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain("not available");
  });

  // PROACTIVE #4: git_commit is exposed but returns a governance blocker
  // (auto-committing from a chat tool call is unsafe).
  test("git_commit returns a typed governance blocker", async () => {
    const res = await executeToolCall("git_commit", { message: "wip" }, ctx);
    expect(res.success).toBe(false);
    const parsed = JSON.parse(res.output) as { error: string; tool: string };
    expect(parsed.error).toBe("governance_required");
    expect(parsed.tool).toBe("git_commit");
  });
});

describe("unified executor — partial-argument memory reaches dispatch", () => {
  test("a delta that completes a retained partial dispatches the MERGED arguments, not the delta", async () => {
    // A gate whose read_file schema declares TWO required fields, so the first
    // (incomplete) call retains the valid field and the second (delta) call
    // merges. The executor must dispatch the merged whole. Derived from the
    // gate's own definition — no hardcoded merge expectation beyond the
    // schema this test declares.
    const { createToolCallGate } = await import("../../server/kernel/canonical.ts");
    writeFileSync(join(projectRoot, "merged.txt"), "merged-content");
    const gate = createToolCallGate({
      getDefinitions: () => [
        Object.freeze({
          type: "function" as const,
          function: Object.freeze({
            name: "read_file",
            description: "read_file with an extra required field for the delta test",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                // A second required field the real handler ignores; it exists
                // only so the first call is incomplete and must be resumed.
                confirm: { type: "boolean" },
              },
              required: ["path", "confirm"],
            },
          }),
        }),
      ],
    });
    const gatedCtx: ToolExecutionContext = { ...ctx, gate };
    // First call: only 'path' is valid → blocked, retains {path}.
    const first = await executeToolCall("read_file", { path: "merged.txt" }, gatedCtx);
    expect(first.success).toBe(false);
    expect(first.gateBlock?.kind).toBe("schema_mismatch");
    // Second call: only the delta ('confirm') → the gate merges the retained
    // 'path' and the call passes with the merged arguments.
    const second = await executeToolCall("read_file", { confirm: true }, gatedCtx);
    expect(second.success).toBe(true);
    // The handler read the file named by the RETAINED 'path' — proof the
    // merged arguments (not the delta) were dispatched.
    expect(second.output).toBe("merged-content");
  });
});
