import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createPrivacyPolicy } from "../../src/privacy/privacy-policy.ts";
import { createToolRegistry, type RegisteredTool, type ToolContext } from "../../src/runtime/tool-registry.ts";
import { mkOwnedTempDir, createTempDir } from "../support/temp-dir.ts";
import { makeRegisteredTool } from "../support/factories.ts";

const TEMP_ROOT = mkOwnedTempDir("tool-test-");
const context: ToolContext = { repositoryRoot: TEMP_ROOT };

function setupFile(relativePath: string, content: string): void {
  const fullPath = join(TEMP_ROOT, relativePath);
  const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
}

setupFile("hello.txt", "Hello, World!");
setupFile("src/test.ts", "export const x = 1;");
setupFile("src/nested/deep.ts", "export const y = 2;");
setupFile("foo..bar.ts", "export const dotted = true;");
mkdirSync(join(TEMP_ROOT, "empty-dir"), { recursive: true });

// ============================================================================
// Tool registry construction
// ============================================================================

test("Tool: createToolRegistry registers read_file and list_files by default", () => {
  const registry = createToolRegistry();
  // Seed tools: read_file, list_files (LLM file fallbacks) + the AST-based
  // quick_view/slice/viewport/skeleton (EXP398/334/355/365 — grep → quick-view,
  // read_file → slices). read_file remains as a FALLBACK.
  assert.equal(registry.size(), 6);
  assert.ok(registry.names().includes("read_file"));
  assert.ok(registry.names().includes("list_files"));
  assert.ok(registry.names().includes("quick_view"));
  assert.ok(registry.names().includes("slice"));
  assert.ok(registry.names().includes("viewport"));
  assert.ok(registry.names().includes("skeleton"));
});

test("Tool: definitions returns tool definitions with schema", () => {
  const registry = createToolRegistry();
  const defs = registry.definitions();
  assert.equal(defs.length, 6);
  for (const def of defs) {
    assert.equal(def.type, "function");
    assert.ok(def.function.name.length > 0);
    assert.ok(def.function.description.length > 0);
    assert.ok(def.function.parameters);
  }
});

test("Tool: get returns tool by name", () => {
  const registry = createToolRegistry();
  const tool = registry.get("read_file");
  assert.ok(tool !== undefined);
  assert.equal(tool.definition.function.name, "read_file");
});

test("Tool: get returns undefined for unknown tool", () => {
  const registry = createToolRegistry();
  assert.equal(registry.get("nonexistent"), undefined);
});

test("Tool: register adds a new tool", () => {
  const registry = createToolRegistry();
  const customTool: RegisteredTool = {
    definition: {
      type: "function",
      function: {
        name: "custom_tool",
        description: "A custom tool",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    handler: () => "custom result",
  };
  registry.register(customTool);
  assert.equal(registry.size(), 7);
  assert.ok(registry.get("custom_tool"));
});

test("Tool: register throws on duplicate", () => {
  const registry = createToolRegistry();
  assert.throws(
    () => registry.register({
      definition: { type: "function", function: { name: "read_file", description: "", parameters: {} } },
      handler: () => "",
    }),
    (e: unknown) => (e as Error).message.includes("already registered"),
  );
});

// ============================================================================
// read_file tool
// ============================================================================

test("Tool: read_file reads existing file", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_1", name: "read_file", arguments: '{"path":"hello.txt"}' },
    context,
  );
  assert.equal(result.isError, false);
  assert.equal(result.content, "Hello, World!");
  assert.equal(result.toolCallId, "call_1");
  assert.equal(result.name, "read_file");
});

test("Tool: read_file reads nested file", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_2", name: "read_file", arguments: '{"path":"src/test.ts"}' },
    context,
  );
  assert.equal(result.isError, false);
  assert.equal(result.content, "export const x = 1;");
});

test("Tool: read_file reads deeply nested file", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_3", name: "read_file", arguments: '{"path":"src/nested/deep.ts"}' },
    context,
  );
  assert.equal(result.isError, false);
  assert.equal(result.content, "export const y = 2;");
});

test("Tool: read_file rejects absolute path", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_4", name: "read_file", arguments: '{"path":"/etc/passwd"}' },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("Absolute"));
});

test("Tool: read_file rejects path traversal", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_5", name: "read_file", arguments: '{"path":"../../../etc/passwd"}' },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("traversal") || result.content.includes("escape"));
});

test("Tool: read_file rejects missing file", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_6", name: "read_file", arguments: '{"path":"nonexistent.txt"}' },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("not exist"));
});

test("Tool: read_file rejects directory", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_7", name: "read_file", arguments: '{"path":"empty-dir"}' },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("not a regular file") || result.content.includes("not a file"));
});

test("Tool: read_file rejects missing path argument", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_8", name: "read_file", arguments: "{}" },
    context,
  );
  assert.equal(result.isError, true);
});

test("Tool: read_file rejects non-string path argument", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_9", name: "read_file", arguments: '{"path":123}' },
    context,
  );
  assert.equal(result.isError, true);
});

test("Tool: read_file handles empty arguments", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_10", name: "read_file", arguments: "" },
    context,
  );
  assert.equal(result.isError, true);
});

test("Tool: read_file handles malformed JSON arguments", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_11", name: "read_file", arguments: "{invalid}" },
    context,
  );
  assert.equal(result.isError, true);
});

test("Tool: read_file handles non-object JSON arguments", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_12", name: "read_file", arguments: "[1,2,3]" },
    context,
  );
  assert.equal(result.isError, true);
});

test("Tool: read_file handles null JSON arguments", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_13", name: "read_file", arguments: "null" },
    context,
  );
  assert.equal(result.isError, true);
});

// ============================================================================
// list_files tool
// ============================================================================

test("Tool: list_files lists directory contents", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_1", name: "list_files", arguments: '{"path":"src"}' },
    context,
  );
  assert.equal(result.isError, false);
  assert.ok(result.content.includes("test.ts"));
  assert.ok(result.content.includes("nested"));
});

test("Tool: list_files lists root directory when no path", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_2", name: "list_files", arguments: "{}" },
    context,
  );
  assert.equal(result.isError, false);
  assert.ok(result.content.includes("hello.txt"));
  assert.ok(result.content.includes("src"));
});

test("Tool: list_files lists root directory when path is dot", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_3", name: "list_files", arguments: '{"path":"."}' },
    context,
  );
  assert.equal(result.isError, false);
  assert.ok(result.content.includes("hello.txt"));
});

test("Tool: list_files lists empty directory", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_4", name: "list_files", arguments: '{"path":"empty-dir"}' },
    context,
  );
  assert.equal(result.isError, false);
  assert.equal(result.content, "");
});

test("Tool: list_files rejects absolute path", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_5", name: "list_files", arguments: '{"path":"/etc"}' },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("Absolute"));
});

test("Tool: list_files rejects path traversal", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_6", name: "list_files", arguments: '{"path":"../../../"}' },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("traversal") || result.content.includes("escape"));
});

test("Tool: list_files rejects non-directory", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_7", name: "list_files", arguments: '{"path":"hello.txt"}' },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("not a directory"));
});

test("Tool: list_files rejects missing directory", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_8", name: "list_files", arguments: '{"path":"nonexistent"}' },
    context,
  );
  assert.equal(result.isError, true);
});

test("Tool: list_files lists nested directory", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_9", name: "list_files", arguments: '{"path":"src/nested"}' },
    context,
  );
  assert.equal(result.isError, false);
  assert.ok(result.content.includes("deep.ts"));
});

test("Tool: list_files output includes type prefix", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_10", name: "list_files", arguments: '{"path":"src"}' },
    context,
  );
  assert.ok(result.content.includes("dir\t") || result.content.includes("file\t"));
});

// ============================================================================
// Unknown tool execution
// ============================================================================

test("Tool: execute returns error for unknown tool", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_1", name: "unknown_tool", arguments: "{}" },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("Unknown tool"));
});

// ============================================================================
// Hostile / edge cases
// ============================================================================

test("Tool: read_file rejects very long path", () => {
  const registry = createToolRegistry();
  const longPath = "x".repeat(5000);
  const result = registry.execute(
    { id: "call_1", name: "read_file", arguments: JSON.stringify({ path: longPath }) },
    context,
  );
  assert.equal(result.isError, true);
});

test("Tool: read_file handles path with null byte in JSON", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_1", name: "read_file", arguments: '{"path":"file\\u0000.txt"}' },
    context,
  );
  assert.equal(result.isError, true);
});

test("Tool: execute with empty tool call id", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "", name: "read_file", arguments: '{"path":"hello.txt"}' },
    context,
  );
  assert.equal(result.toolCallId, "");
  assert.equal(result.isError, false);
});

test("Tool: multiple executions are independent", () => {
  const registry = createToolRegistry();
  const result1 = registry.execute(
    { id: "call_1", name: "read_file", arguments: '{"path":"hello.txt"}' },
    context,
  );
  const result2 = registry.execute(
    { id: "call_2", name: "read_file", arguments: '{"path":"src/test.ts"}' },
    context,
  );
  assert.equal(result1.content, "Hello, World!");
  assert.equal(result2.content, "export const x = 1;");
  assert.notEqual(result1.toolCallId, result2.toolCallId);
});

test("Tool: tool result is frozen", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_1", name: "read_file", arguments: '{"path":"hello.txt"}' },
    context,
  );
  assert.ok(Object.isFrozen(result));
});

test("Tool: list_files sorts entries alphabetically", () => {
  writeFileSync(join(TEMP_ROOT, "zfile.txt"), "");
  writeFileSync(join(TEMP_ROOT, "afile.txt"), "");
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call_1", name: "list_files", arguments: '{"path":"."}' },
    context,
  );
  const lines = result.content.split("\n").filter((l) => l.length > 0);
  const names = lines.map((l) => l.split("\t")[1] ?? "");
  const sorted = [...names].sort();
  assert.deepEqual(names, sorted);
});

test("Tool: registry names returns array", () => {
  const registry = createToolRegistry();
  const names = registry.names();
  assert.ok(Array.isArray(names));
  assert.equal(names.length, 6);
});

test("Tool: registry size returns count", () => {
  const registry = createToolRegistry();
  assert.equal(registry.size(), 6);
  const customTool: RegisteredTool = {
    definition: { type: "function", function: { name: "custom", description: "", parameters: {} } },
    handler: () => "",
  };
  registry.register(customTool);
  assert.equal(registry.size(), 7);
});

// ============================================================================
// Issue 4 regression: canonical relativePathViolationKinds replaces substring
// ".." check. foo..bar.ts must pass; real traversal, backslash, control chars,
// and absolute paths must be rejected through the canonical authority.
// ============================================================================

test("Tool: read_file accepts filename with double-dot (foo..bar.ts) — regression for substring bug", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "dotdot", name: "read_file", arguments: JSON.stringify({ path: "foo..bar.ts" }) },
    context,
  );
  assert.equal(result.isError, false, `foo..bar.ts must be readable; got: ${result.content}`);
  assert.equal(result.content, "export const dotted = true;");
});

test("Tool: read_file accepts nested filename with double-dot (src/a..b.ts)", () => {
  setupFile("src/a..b.ts", "export const nested = 1;");
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "dotdot2", name: "read_file", arguments: JSON.stringify({ path: "src/a..b.ts" }) },
    context,
  );
  assert.equal(result.isError, false, `src/a..b.ts must be readable; got: ${result.content}`);
  assert.equal(result.content, "export const nested = 1;");
});

test("Tool: list_files accepts directory name with double-dot (pkg..dir)", () => {
  mkdirSync(join(TEMP_ROOT, "pkg..dir"), { recursive: true });
  writeFileSync(join(TEMP_ROOT, "pkg..dir", "inside.ts"), "export const inside = 1;");
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "dotdot3", name: "list_files", arguments: JSON.stringify({ path: "pkg..dir" }) },
    context,
  );
  assert.equal(result.isError, false, `pkg..dir must be listable; got: ${result.content}`);
  assert.ok(result.content.includes("inside.ts"));
});

test("Tool: read_file rejects leading parent traversal../escape", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "esc", name: "read_file", arguments: JSON.stringify({ path: "../escape" }) },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(
    result.content.includes("traversal") || result.content.includes("escape"),
    `expected traversal/escape message; got: ${result.content}`,
  );
});

test("Tool: read_file rejects deep parent traversal../../../etc/passwd", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "esc2", name: "read_file", arguments: JSON.stringify({ path: "../../../etc/passwd" }) },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(
    result.content.includes("traversal") || result.content.includes("escape"),
    `expected traversal/escape message; got: ${result.content}`,
  );
});

test("Tool: list_files rejects leading parent traversal../../../", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "esc3", name: "list_files", arguments: JSON.stringify({ path: "../../../" }) },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(
    result.content.includes("traversal") || result.content.includes("escape"),
    `expected traversal/escape message; got: ${result.content}`,
  );
});

test("Tool: read_file rejects a single dot-dot segment.. ", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "dd", name: "read_file", arguments: JSON.stringify({ path: ".." }) },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(
    result.content.includes("traversal") || result.content.includes("escape"),
    `expected traversal/escape message; got: ${result.content}`,
  );
});

test("Tool: read_file rejects backslash in path", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "bs", name: "read_file", arguments: JSON.stringify({ path: "foo\\bar.ts" }) },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.toLowerCase().includes("backslash"), `expected backslash message; got: ${result.content}`);
});

test("Tool: list_files rejects backslash in path", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "bs2", name: "list_files", arguments: JSON.stringify({ path: "src\\nested" }) },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.toLowerCase().includes("backslash"), `expected backslash message; got: ${result.content}`);
});

test("Tool: read_file rejects control character in path", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "ctrl", name: "read_file", arguments: '{"path":"foo\\u0007bar.ts"}' },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(
    result.content.toLowerCase().includes("control") || result.content.includes("traversal") || result.content.includes("escape"),
    `expected control/traversal message; got: ${result.content}`,
  );
});

test("Tool: read_file rejects absolute path /etc", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "abs", name: "read_file", arguments: JSON.stringify({ path: "/etc" }) },
    context,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("Absolute"), `expected Absolute message; got: ${result.content}`);
});

test("Tool: read_file accepts dot reference as root (list_files default)", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "dot", name: "list_files", arguments: JSON.stringify({ path: "." }) },
    context,
  );
  assert.equal(result.isError, false, `dot must be allowed as root; got: ${result.content}`);
  assert.ok(result.content.includes("hello.txt"));
});

test("Tool: read_file rejects empty path string", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "empty", name: "read_file", arguments: JSON.stringify({ path: "" }) },
    context,
  );
  assert.equal(result.isError, true);
});

test("Tool: read_file accepts path with internal dot segment that normalizes away (foo/./bar)", () => {
  setupFile("norm-target.ts", "export const norm = 1;");
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "norm", name: "read_file", arguments: JSON.stringify({ path: "./norm-target.ts" }) },
    context,
  );
  assert.equal(result.isError, false, `./norm-target.ts must be allowed; got: ${result.content}`);
  assert.equal(result.content, "export const norm = 1;");
});

test("Tool: read_file accepts path with redundant double slash that normalizes away", () => {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "slash", name: "read_file", arguments: JSON.stringify({ path: "src//test.ts" }) },
    context,
  );
  assert.equal(result.isError, false, `src//test.ts must normalize and be allowed; got: ${result.content}`);
  assert.equal(result.content, "export const x = 1;");
});

// ============================================================================
// MAJOR-4: enabledTools allowlist + maxTools ceiling enforcement
// ============================================================================

import { SecurityError } from "../../src/kernel/errors.ts";

test("Tool: enabledTools allowlist registers tools that are in the list", () => {
  const registry = createToolRegistry({ enabledTools: ["read_file", "alpha"] });
  registry.register(makeRegisteredTool("alpha"));
  assert.ok(registry.get("alpha") !== undefined);
  assert.ok(registry.get("read_file") !== undefined);
});

test("Tool: enabledTools allowlist skips tools NOT in the list (no error)", () => {
  const registry = createToolRegistry({ enabledTools: ["read_file"] });
  // list_files is NOT in the allowlist and was seeded in the constructor; it
  // should have been skipped. A subsequently-registered tool not in the list
  // is also skipped silently.
  assert.equal(registry.get("list_files"), undefined, "list_files must be skipped (not in allowlist)");
  registry.register(makeRegisteredTool("beta"));
  assert.equal(registry.get("beta"), undefined, "beta must be skipped (not in allowlist)");
  assert.equal(registry.size(), 1, "only the allowlisted read_file remains");
});

test("Tool: registering more than maxTools throws SecurityError", () => {
  // maxTools=6; the constructor seeds 6 tools (read_file, list_files,
  // quick_view, slice, viewport, skeleton), so the very first register
  // call must throw.
  const registry = createToolRegistry({ maxTools: 6 });
  assert.equal(registry.size(), 6);
  assert.throws(
    () => registry.register(makeRegisteredTool("overflow")),
    (e: unknown) => e instanceof SecurityError && /tool_limit_exceeded/.test((e as Error).message),
  );
});

test("Tool: maxTools message includes the limit and the attempted name", () => {
  const registry = createToolRegistry({ maxTools: 6 });
  try {
    registry.register(makeRegisteredTool("overflow-name"));
    assert.fail("expected SecurityError");
  } catch (e) {
    assert.ok(e instanceof SecurityError, `expected SecurityError; got ${(e as Error)?.name}`);
    assert.match((e as Error).message, /maximum 6 tools allowed/);
    assert.match((e as Error).message, /overflow-name/);
  }
});

test("Tool: empty enabledTools array registers all tools (backwards compatible)", () => {
  const registry = createToolRegistry({ enabledTools: [] });
  assert.ok(registry.get("read_file") !== undefined);
  assert.ok(registry.get("list_files") !== undefined);
  registry.register(makeRegisteredTool("gamma"));
  assert.ok(registry.get("gamma") !== undefined);
});

test("Tool: undefined enabledTools registers all tools (backwards compatible)", () => {
  const registry = createToolRegistry();
  assert.ok(registry.get("read_file") !== undefined);
  assert.ok(registry.get("list_files") !== undefined);
  registry.register(makeRegisteredTool("delta"));
  assert.ok(registry.get("delta") !== undefined);
});

test("Tool: default maxTools is the root-policy ceiling (64)", () => {
  // Registering 58 extra tools (6 seed tools + 58 = 64) must succeed; the
  // 65th must throw. This proves the default ceiling applies.
  const registry = createToolRegistry();
  for (let i = 0; i < 58; i++) registry.register(makeRegisteredTool(`t${i}`));
  assert.equal(registry.size(), 64);
  assert.throws(
    () => registry.register(makeRegisteredTool("over-the-ceiling")),
    (e: unknown) => e instanceof SecurityError,
  );
});

// ============================================================================
// Round-3 MAJOR fix: read_file tool sources maxReadBytes from the privacy
// policy's maxFileBytes (set from central config), NOT a hardcoded
// MAX_READ_BYTES = 262_144. Previously the tool passed its own maxReadBytes to
// viewFile as `maxBytes`, bypassing the configured privacy limit entirely.
// ============================================================================

test("Round-3: read_file respects privacy policy maxFileBytes (not hardcoded 262144)", () => {
  // Create a workspace + file that fits within the old hardcoded MAX_READ_BYTES
  // (262_144) but exceeds a configured privacy maxFileBytes (100). The tool
  // must reject the file because the privacy policy limit is authoritative.
  const dir = createTempDir("round3-priv-");
  try {
    const content = "a".repeat(500);
    writeFileSync(join(dir, "big.txt"), content);
    const policy = createPrivacyPolicy({ maxFileBytes: 100 });
    const registry = createToolRegistry({ privacyPolicy: policy });
    const result = registry.execute(
      { id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "big.txt" }) },
      { repositoryRoot: dir },
    );
    assert.equal(result.isError, true, "read_file must reject files exceeding privacy maxFileBytes");
    assert.ok(
      result.content.includes("exceeds maximum read size"),
      `expected oversize message; got: ${result.content}`,
    );
    assert.ok(
      result.content.includes("100"),
      `error message must report the policy limit (100); got: ${result.content}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Round-3: read_file default maxReadBytes is privacy.maxFileBytes (1MB, not 262144)", () => {
  // Without an explicit toolsLimits override, the read ceiling equals the
  // privacy policy's maxFileBytes default (1_048_576), not the old hardcoded
  // 262_144. A file of 300_000 bytes (between 262_144 and 1_048_576) must be
  // readable under the default policy.
  const dir = createTempDir("round3-default-");
  try {
    const content = "a".repeat(300_000);
    writeFileSync(join(dir, "mid.txt"), content);
    const registry = createToolRegistry();
    const result = registry.execute(
      { id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "mid.txt" }) },
      { repositoryRoot: dir },
    );
    assert.equal(result.isError, false, `300_000-byte file must be readable under default 1MB policy; got: ${result.content}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Round-3: read_file view limit is privacy.maxFileBytes even when toolsLimits.maxReadBytes is larger", () => {
  // If toolsLimits.maxReadBytes is configured above privacy.maxFileBytes, the
  // disk-read check passes but the VIEW limit (policy.maxFileBytes) still
  // governs what the viewer emits. The file is read from disk but the viewer
  // blocks/truncates it according to the privacy limit.
  const dir = createTempDir("round3-override-");
  try {
    const content = "a".repeat(2000);
    writeFileSync(join(dir, "wide.txt"), content);
    const policy = createPrivacyPolicy({ maxFileBytes: 500 });
    // toolsLimits.maxReadBytes (10000) > policy.maxFileBytes (500). The disk
    // read succeeds (file < 10000 bytes), but the viewer blocks it (file >
    // 500 bytes).
    const registry = createToolRegistry({
      privacyPolicy: policy,
      toolsLimits: { maxReadBytes: 10000, maxListEntries: 1000 },
    });
    const result = registry.execute(
      { id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "wide.txt" }) },
      { repositoryRoot: dir },
    );
    // The viewer REFUSES because the file exceeds the privacy view limit
    // (policy.maxFileBytes = 500), and the refusal is raised rather than
    // handed back as empty content. This assertion used to read
    // `result.content === ""`, which is the defect written down as the
    // expectation: an empty string is what a successful read of an empty file
    // also produces, so the model was being told the file was empty rather
    // than that it would not be shown.
    assert.equal(result.isError, true, "a view refused by the privacy limit must be an error, not an empty file");
    assert.notEqual(result.content, "", "a refusal must never be delivered as empty content");
    assert.ok(
      result.content.includes("file_viewer_oversize"),
      `the refusal must name the privacy view limit that governed it; got: ${result.content}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Round-3: read_file uses toolsLimits.maxReadBytes when smaller than privacy.maxFileBytes", () => {
  // When toolsLimits.maxReadBytes < privacy.maxFileBytes, the disk-read
  // check is the binding constraint (early rejection, efficient).
  const dir = createTempDir("round3-small-");
  try {
    const content = "a".repeat(500);
    writeFileSync(join(dir, "tiny.txt"), content);
    const policy = createPrivacyPolicy({ maxFileBytes: 1_000_000 });
    const registry = createToolRegistry({
      privacyPolicy: policy,
      toolsLimits: { maxReadBytes: 100, maxListEntries: 1000 },
    });
    const result = registry.execute(
      { id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "tiny.txt" }) },
      { repositoryRoot: dir },
    );
    assert.equal(result.isError, true, "disk-read check must reject files > toolsLimits.maxReadBytes");
    assert.ok(result.content.includes("100"), `error must report the toolsLimits ceiling; got: ${result.content}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
