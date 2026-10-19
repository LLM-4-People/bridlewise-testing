import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionTools } from "../../src/runtime/extension-tools.ts";
import { createExtensionManifest } from "../../src/extensions/extension-manifest.ts";
import type { ExtensionManifestEntry } from "../../src/extensions/extension-manifest.ts";

// ---------------------------------------------------------------------------
// Extension tools: the read-only list_extensions surface. install/remove are
// governed by the approval workflow (root-policy selfEvolutionArchitecture)
// and are intentionally not exposed as model-callable tools.
// ---------------------------------------------------------------------------

function callTool(tools: ReturnType<typeof createExtensionTools>, name: string, args: Record<string, unknown> = {}): unknown {
  const tool = tools.find((t) => t.definition.function.name === name);
  assert.ok(tool, `tool ${name} must be registered`);
  return JSON.parse(tool!.handler(args, { repositoryRoot: "/repo" }));
}

test("extension-tools: registers exactly one read-only tool", () => {
  const tools = createExtensionTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.definition.function.name, "list_extensions");
});

test("extension-tools: list_extensions returns an empty manifest by default", () => {
  const tools = createExtensionTools();
  const result = callTool(tools, "list_extensions") as { extensions: readonly unknown[]; total: number };
  assert.equal(result.total, 0);
  assert.deepEqual(result.extensions, []);
});

test("extension-tools: list_extensions returns manifest entries", () => {
  const entry: ExtensionManifestEntry = {
    id: "demo-pack", version: "1.0.0", type: "quality-pack", status: "active",
    description: "a demo quality pack", capabilities: ["quality-check"],
    dependencies: [], entryPoint: "src/demo.ts", apiVersion: "1.0.0", compatibilityRange: ">=1.0.0",
    provenance: { publisher: "bridlewise", sourceUri: "file:///local/demo", contentDigest: "0".repeat(64) },
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
  const manifest = createExtensionManifest([entry]);
  const tools = createExtensionTools({ manifest });
  const result = callTool(tools, "list_extensions") as {
    extensions: ReadonlyArray<{ id: string; type: string; status: string; version: string }>;
    total: number;
  };
  assert.equal(result.total, 1);
  assert.equal(result.extensions[0]!.id, "demo-pack");
  assert.equal(result.extensions[0]!.type, "quality-pack");
  assert.equal(result.extensions[0]!.status, "active");
  assert.equal(result.extensions[0]!.version, "1.0.0");
});

test("extension-tools: list_extensions filters by type", () => {
  const entries: ExtensionManifestEntry[] = [
    {
      id: "a", version: "1.0.0", type: "quality-pack", status: "active",
      description: "a", capabilities: [], dependencies: [], entryPoint: "x", apiVersion: "1.0.0",
      compatibilityRange: ">=1.0.0",
      provenance: { publisher: "bridlewise", sourceUri: "file:///local/a", contentDigest: "0".repeat(64) },
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "b", version: "2.0.0", type: "mcp-tool-or-adapter", status: "staged",
      description: "b", capabilities: [], dependencies: [], entryPoint: "y", apiVersion: "1.0.0",
      compatibilityRange: ">=1.0.0",
      provenance: { publisher: "bridlewise", sourceUri: "file:///local/b", contentDigest: "0".repeat(64) },
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    },
  ];
  const manifest = createExtensionManifest(entries);
  const tools = createExtensionTools({ manifest });
  const result = callTool(tools, "list_extensions", { type: "quality-pack" }) as {
    extensions: ReadonlyArray<{ id: string }>; total: number;
  };
  assert.equal(result.total, 1);
  assert.equal(result.extensions[0]!.id, "a");
});

test("extension-tools: install/remove are not exposed (governance)", () => {
  const tools = createExtensionTools();
  const names = tools.map((t) => t.definition.function.name);
  assert.ok(!names.includes("install_extension"), "install_extension must not be a model-callable tool");
  assert.ok(!names.includes("remove_extension"), "remove_extension must not be a model-callable tool");
});
