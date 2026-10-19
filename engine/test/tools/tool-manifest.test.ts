import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import {
  createToolManifest,
  validateToolManifestEntry,
  mergeBounds,
  DEFAULT_TOOL_RESOURCE_BOUNDS,
  TOOL_CAPABILITIES,
  ToolManifestError,
  type ToolManifestEntry,
} from "../../src/tools/tool-manifest.ts";

function validEntry(overrides: Partial<ToolManifestEntry> = {}): ToolManifestEntry {
  return {
    id: "test-tool",
    name: "test_tool",
    description: "A test tool for validation",
    inputSchema: { type: "object", properties: {}, required: [] },
    capabilities: ["read"],
    bounds: { timeoutMs: 5000, maxOutputBytes: 1024, maxMemoryBytes: 65536 },
    adapterId: "test-adapter",
    ...overrides,
  };
}

// ============================================================================
// Construction and registration
// ============================================================================

test("tool-manifest: empty manifest has size 0", () => {
  const manifest = createToolManifest();
  assert.equal(manifest.size(), 0);
  assert.deepEqual(manifest.entries(), []);
  assert.deepEqual(manifest.ids(), []);
  assert.deepEqual(manifest.names(), []);
});

test("tool-manifest: registers initial entries", () => {
  const entry = validEntry();
  const manifest = createToolManifest([entry]);
  assert.equal(manifest.size(), 1);
  assert.deepEqual(manifest.ids(), ["test-tool"]);
  assert.deepEqual(manifest.names(), ["test_tool"]);
});

test("tool-manifest: register adds entry", () => {
  const manifest = createToolManifest();
  manifest.register(validEntry());
  assert.equal(manifest.size(), 1);
});

test("tool-manifest: register duplicate id throws", () => {
  const manifest = createToolManifest([validEntry()]);
  assert.throws(
    () => manifest.register(validEntry()),
    (e: unknown) => (e as Error).message.includes("already registered"),
  );
});

test("tool-manifest: register duplicate name throws", () => {
  const manifest = createToolManifest([validEntry()]);
  assert.throws(
    () => manifest.register(validEntry({ id: "other-tool", name: "test_tool" })),
    (e: unknown) => (e as Error).message.includes("already registered"),
  );
});

test("tool-manifest: get by id returns entry", () => {
  const manifest = createToolManifest([validEntry()]);
  const entry = manifest.get("test-tool");
  assert.ok(entry);
  assert.equal(entry!.id, "test-tool");
});

test("tool-manifest: get by id returns undefined for unknown", () => {
  const manifest = createToolManifest();
  assert.equal(manifest.get("nonexistent"), undefined);
});

test("tool-manifest: getByName returns entry", () => {
  const manifest = createToolManifest([validEntry()]);
  const entry = manifest.getByName("test_tool");
  assert.ok(entry);
  assert.equal(entry!.name, "test_tool");
});

test("tool-manifest: getByName returns undefined for unknown", () => {
  const manifest = createToolManifest();
  assert.equal(manifest.getByName("nonexistent"), undefined);
});

test("tool-manifest: entries returns all entries", () => {
  const manifest = createToolManifest([
    validEntry({ id: "a", name: "a" }),
    validEntry({ id: "b", name: "b" }),
  ]);
  assert.equal(manifest.entries().length, 2);
});

test("tool-manifest: identityHash is deterministic", () => {
  const e1 = validEntry({ id: "a", name: "a" });
  const e2 = validEntry({ id: "a", name: "a" });
  const m1 = createToolManifest([e1]);
  const m2 = createToolManifest([e2]);
  assert.equal(m1.identityHash(), m2.identityHash());
});

test("tool-manifest: identityHash changes with different entries", () => {
  const m1 = createToolManifest([validEntry({ id: "a", name: "a" })]);
  const m2 = createToolManifest([validEntry({ id: "b", name: "b" })]);
  assert.notEqual(m1.identityHash(), m2.identityHash());
});

test("tool-manifest: identityHash is order-independent", () => {
  const a = validEntry({ id: "a", name: "a" });
  const b = validEntry({ id: "b", name: "b" });
  const m1 = createToolManifest([a, b]);
  const m2 = createToolManifest([b, a]);
  assert.equal(m1.identityHash(), m2.identityHash());
});

test("tool-manifest: validate on empty manifest passes", () => {
  const manifest = createToolManifest();
  assert.equal(manifest.validate().length, 0);
});

test("tool-manifest: validate on valid manifest passes", () => {
  const manifest = createToolManifest([validEntry()]);
  assert.equal(manifest.validate().length, 0);
});

test("tool-manifest: registered entry is frozen", () => {
  const manifest = createToolManifest([validEntry()]);
  const entry = manifest.get("test-tool")!;
  assert.ok(Object.isFrozen(entry));
  assert.ok(Object.isFrozen(entry.bounds));
  assert.ok(Object.isFrozen(entry.capabilities));
  assert.ok(Object.isFrozen(entry.inputSchema));
});

// ============================================================================
// validateToolManifestEntry
// ============================================================================

test("tool-manifest: valid entry passes validation", () => {
  const violations = validateToolManifestEntry(validEntry());
  assert.equal(violations.length, 0);
});

test("tool-manifest: entry with output schema passes", () => {
  const violations = validateToolManifestEntry(validEntry({
    outputSchema: { type: "object", properties: {} },
  }));
  assert.equal(violations.length, 0);
});

test("tool-manifest: entry with multiple capabilities passes", () => {
  const violations = validateToolManifestEntry(validEntry({
    capabilities: ["read", "write", "execute", "network"],
  }));
  assert.equal(violations.length, 0);
});

test("tool-manifest: empty id fails validation", () => {
  const violations = validateToolManifestEntry(validEntry({ id: "" }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: id with invalid characters fails", () => {
  const violations = validateToolManifestEntry(validEntry({ id: "tool with spaces" }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: empty name fails validation", () => {
  const violations = validateToolManifestEntry(validEntry({ name: "" }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: name with invalid characters fails", () => {
  const violations = validateToolManifestEntry(validEntry({ name: "tool.name" }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: empty description fails validation", () => {
  const violations = validateToolManifestEntry(validEntry({ description: "" }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: inputSchema not object fails", () => {
  const violations = validateToolManifestEntry(validEntry({
    inputSchema: "not-object" as unknown as Record<string, unknown>,
  }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: inputSchema without type object fails", () => {
  const violations = validateToolManifestEntry(validEntry({
    inputSchema: { type: "string" },
  }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: empty capabilities fails", () => {
  const violations = validateToolManifestEntry(validEntry({ capabilities: [] }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: unknown capability fails", () => {
  const violations = validateToolManifestEntry(validEntry({
    capabilities: ["read", "fly"] as unknown as readonly ("read" | "write" | "execute" | "network")[],
  }));
  assert.ok(violations.some((v) => v.includes("unknown")));
});

test("tool-manifest: duplicate capabilities fails", () => {
  const violations = validateToolManifestEntry(validEntry({
    capabilities: ["read", "read"],
  }));
  assert.ok(violations.some((v) => v.includes("duplicate")));
});

test("tool-manifest: timeout zero fails", () => {
  const violations = validateToolManifestEntry(validEntry({
    bounds: { timeoutMs: 0, maxOutputBytes: 1024, maxMemoryBytes: 65536 },
  }));
  assert.ok(violations.some((v) => v.includes("timeoutMs")));
});

test("tool-manifest: timeout negative fails", () => {
  const violations = validateToolManifestEntry(validEntry({
    bounds: { timeoutMs: -1, maxOutputBytes: 1024, maxMemoryBytes: 65536 },
  }));
  assert.ok(violations.some((v) => v.includes("timeoutMs")));
});

test("tool-manifest: timeout non-integer fails", () => {
  const violations = validateToolManifestEntry(validEntry({
    bounds: { timeoutMs: 1.5, maxOutputBytes: 1024, maxMemoryBytes: 65536 },
  }));
  assert.ok(violations.some((v) => v.includes("timeoutMs")));
});

test("tool-manifest: maxOutputBytes zero fails", () => {
  const violations = validateToolManifestEntry(validEntry({
    bounds: { timeoutMs: 5000, maxOutputBytes: 0, maxMemoryBytes: 65536 },
  }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: maxMemoryBytes zero fails", () => {
  const violations = validateToolManifestEntry(validEntry({
    bounds: { timeoutMs: 5000, maxOutputBytes: 1024, maxMemoryBytes: 0 },
  }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: empty adapterId fails", () => {
  const violations = validateToolManifestEntry(validEntry({ adapterId: "" }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: adapterId with invalid chars fails", () => {
  const violations = validateToolManifestEntry(validEntry({ adapterId: "bad adapter" }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: outputSchema not object fails", () => {
  const violations = validateToolManifestEntry(validEntry({
    outputSchema: "not-object" as unknown as Record<string, unknown>,
  }));
  assert.ok(violations.length > 0);
});

// ============================================================================
// mergeBounds
// ============================================================================

test("tool-manifest: mergeBounds returns defaults when no overrides", () => {
  const result = mergeBounds(DEFAULT_TOOL_RESOURCE_BOUNDS);
  assert.equal(result.timeoutMs, DEFAULT_TOOL_RESOURCE_BOUNDS.timeoutMs);
  assert.equal(result.maxOutputBytes, DEFAULT_TOOL_RESOURCE_BOUNDS.maxOutputBytes);
  assert.equal(result.maxMemoryBytes, DEFAULT_TOOL_RESOURCE_BOUNDS.maxMemoryBytes);
});

test("tool-manifest: mergeBounds applies full overrides", () => {
  const result = mergeBounds(DEFAULT_TOOL_RESOURCE_BOUNDS, {
    timeoutMs: 60000,
    maxOutputBytes: 2048,
    maxMemoryBytes: 131072,
  });
  assert.equal(result.timeoutMs, 60000);
  assert.equal(result.maxOutputBytes, 2048);
  assert.equal(result.maxMemoryBytes, 131072);
});

test("tool-manifest: mergeBounds applies partial overrides", () => {
  const result = mergeBounds(DEFAULT_TOOL_RESOURCE_BOUNDS, { timeoutMs: 9999 });
  assert.equal(result.timeoutMs, 9999);
  assert.equal(result.maxOutputBytes, DEFAULT_TOOL_RESOURCE_BOUNDS.maxOutputBytes);
  assert.equal(result.maxMemoryBytes, DEFAULT_TOOL_RESOURCE_BOUNDS.maxMemoryBytes);
});

test("tool-manifest: mergeBounds with undefined overrides", () => {
  const result = mergeBounds(DEFAULT_TOOL_RESOURCE_BOUNDS, undefined);
  assert.equal(result.timeoutMs, DEFAULT_TOOL_RESOURCE_BOUNDS.timeoutMs);
});

test("tool-manifest: mergeBounds result is frozen", () => {
  const result = mergeBounds(DEFAULT_TOOL_RESOURCE_BOUNDS);
  assert.ok(Object.isFrozen(result));
});

// ============================================================================
// TOOL_CAPABILITIES constant
// ============================================================================

test("tool-manifest: TOOL_CAPABILITIES contains expected values", () => {
  assert.ok(TOOL_CAPABILITIES.includes("read"));
  assert.ok(TOOL_CAPABILITIES.includes("write"));
  assert.ok(TOOL_CAPABILITIES.includes("execute"));
  assert.ok(TOOL_CAPABILITIES.includes("network"));
  assert.equal(TOOL_CAPABILITIES.length, 4);
});

test("tool-manifest: TOOL_CAPABILITIES is frozen", () => {
  assert.ok(Object.isFrozen(TOOL_CAPABILITIES));
});

// ============================================================================
// Hostile / edge cases
// ============================================================================

test("tool-manifest: oversized id fails", () => {
  const violations = validateToolManifestEntry(validEntry({ id: "x".repeat(300) }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: oversized name fails", () => {
  const violations = validateToolManifestEntry(validEntry({ name: "x".repeat(200) }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: oversized description fails", () => {
  const violations = validateToolManifestEntry(validEntry({ description: "x".repeat(5000) }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: too many capabilities fails", () => {
  const violations = validateToolManifestEntry(validEntry({
    capabilities: ["read", "write", "execute", "network", "read"] as never as never[],
  }));
  assert.ok(violations.some((v) => v.includes("duplicate") || v.includes("exceed")));
});

test("tool-manifest: timeout exceeding max fails", () => {
  const violations = validateToolManifestEntry(validEntry({
    bounds: { timeoutMs: 700000, maxOutputBytes: 1024, maxMemoryBytes: 65536 },
  }));
  assert.ok(violations.some((v) => v.includes("timeoutMs")));
});

test("tool-manifest: maxOutputBytes exceeding max fails", () => {
  const violations = validateToolManifestEntry(validEntry({
    bounds: { timeoutMs: 5000, maxOutputBytes: 20000000, maxMemoryBytes: 65536 },
  }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: maxMemoryBytes exceeding max fails", () => {
  const violations = validateToolManifestEntry(validEntry({
    bounds: { timeoutMs: 5000, maxOutputBytes: 1024, maxMemoryBytes: 5000000000 },
  }));
  assert.ok(violations.length > 0);
});

test("tool-manifest: ToolManifestError is instanceof Error", () => {
  const err = new ToolManifestError("test");
  assert.ok(err instanceof Error);
  assert.equal(err.code, "tool_manifest_invalid");
});

test("tool-manifest: manifest is frozen after construction", () => {
  const manifest = createToolManifest([validEntry()]);
  assert.ok(Object.isFrozen(manifest));
});

test("tool-manifest: can register entry with all 4 capabilities", () => {
  const manifest = createToolManifest();
  manifest.register(validEntry({ capabilities: ["read", "write", "execute", "network"] }));
  assert.equal(manifest.size(), 1);
});

test("tool-manifest: multiple entries have distinct identity hashes", () => {
  const e1 = validEntry({ id: "a", name: "a", adapterId: "adapter-a" });
  const e2 = validEntry({ id: "b", name: "b", adapterId: "adapter-b" });
  const m1 = createToolManifest([e1]);
  const m2 = createToolManifest([e2]);
  const m3 = createToolManifest([e1, e2]);
  assert.notEqual(m1.identityHash(), m2.identityHash());
  assert.notEqual(m1.identityHash(), m3.identityHash());
  assert.notEqual(m2.identityHash(), m3.identityHash());
});

// ============================================================================
// Round-3 MINOR fix: DEFAULT_TOOL_RESOURCE_BOUNDS.timeoutMs must be sourced
// from ROOT_POLICY.tools.limits.defaultToolTimeoutMs (not a hardcoded 30_000
// literal). The other two bounds fields already use ROOT_POLICY; timeoutMs
// was the lone holdout, which was inconsistent.
// ============================================================================

test("Round-3: DEFAULT_TOOL_RESOURCE_BOUNDS.timeoutMs equals ROOT_POLICY.tools.limits.defaultToolTimeoutMs", () => {
  assert.equal(
    DEFAULT_TOOL_RESOURCE_BOUNDS.timeoutMs,
    ROOT_POLICY.tools.limits.defaultToolTimeoutMs,
    "timeoutMs must be sourced from ROOT_POLICY.tools.limits.defaultToolTimeoutMs",
  );
  assert.equal(
    DEFAULT_TOOL_RESOURCE_BOUNDS.maxOutputBytes,
    ROOT_POLICY.tools.limits.maximumToolOutputBytes,
    "maxOutputBytes must be sourced from ROOT_POLICY.tools.limits.maximumToolOutputBytes (existing)",
  );
  assert.equal(
    DEFAULT_TOOL_RESOURCE_BOUNDS.maxMemoryBytes,
    ROOT_POLICY.tools.limits.maximumToolMemoryBytes,
    "maxMemoryBytes must be sourced from ROOT_POLICY.tools.limits.maximumToolMemoryBytes (existing)",
  );
});

test("Round-3: ROOT_POLICY.tools.limits.defaultToolTimeoutMs is 30000", () => {
  assert.equal(ROOT_POLICY.tools.limits.defaultToolTimeoutMs, 30_000);
  assert.equal(DEFAULT_TOOL_RESOURCE_BOUNDS.timeoutMs, 30_000);
});

test("Round-3: tool-manifest.ts does not hardcode the 30_000 timeout literal", () => {
  // Mechanical prevention: the 30_000 literal must not appear as a fresh
  // assignment to timeoutMs in tool-manifest.ts. It must be derived from
  // ROOT_POLICY.tools.limits.defaultToolTimeoutMs.
  const src = readFileSync(join(process.cwd(), "src/tools/tool-manifest.ts"), "utf8");
  assert.ok(
    /DEFAULT_BOUNDS_TIMEOUT_MS\s*=\s*ROOT_POLICY\.tools\.limits\.defaultToolTimeoutMs/u.test(src),
    "tool-manifest.ts must derive DEFAULT_BOUNDS_TIMEOUT_MS from ROOT_POLICY.tools.limits.defaultToolTimeoutMs",
  );
  // A literal `timeoutMs: 30_000` assignment in DEFAULT_TOOL_RESOURCE_BOUNDS is forbidden.
  assert.ok(
    !/timeoutMs:\s*30_000\b/u.test(src),
    "tool-manifest.ts must not hardcode timeoutMs: 30_000 in DEFAULT_TOOL_RESOURCE_BOUNDS",
  );
});
