import type { ExtensionManifestEntry } from "../../src/extensions/extension-manifest.ts";

/**
 * Shared test fixtures for the extensions test suite.
 * These produce valid extension manifest entries with sensible defaults.
 */

export function makeEntry(overrides?: Partial<ExtensionManifestEntry>): ExtensionManifestEntry {
  const base: ExtensionManifestEntry = {
    id: "ext-provider-one",
    version: "1.0.0",
    type: "provider-adapter",
    status: "proposed",
    description: "A test provider adapter extension.",
    capabilities: ["chat.completions"],
    dependencies: [],
    entryPoint: "src/providers/one.ts",
    apiVersion: "1.0.0",
    compatibilityRange: "^1.0.0",
    provenance: {
      publisher: "harness-core",
      sourceUri: "local://src/providers/one.ts",
      contentDigest: "0000000000000000000000000000000000000000000000000000000000000000",
    },
    createdAt: "2026-07-15T00:00:00Z",
    updatedAt: "2026-07-15T00:00:00Z",
  };
  return { ...base, ...overrides };
}

export function makeProviderEntry(id: string, version = "1.0.0"): ExtensionManifestEntry {
  return makeEntry({ id, version, type: "provider-adapter", entryPoint: `src/providers/${id}.ts` });
}

export function makeModelEntry(id: string, version = "1.0.0"): ExtensionManifestEntry {
  return makeEntry({
    id,
    version,
    type: "model-profile",
    entryPoint: `src/models/${id}.ts`,
    capabilities: ["chat.completions", "tool-calling"],
  });
}

export function makeToolEntry(id: string, version = "1.0.0"): ExtensionManifestEntry {
  return makeEntry({
    id,
    version,
    type: "mcp-tool-or-adapter",
    entryPoint: `src/tools/${id}.ts`,
    capabilities: ["read", "execute"],
  });
}

export function makeAgentTypeEntry(id: string, version = "1.0.0"): ExtensionManifestEntry {
  return makeEntry({
    id,
    version,
    type: "agent-profile",
    entryPoint: `src/agents/${id}.ts`,
    capabilities: ["read", "write"],
  });
}

export function makeQualityPackEntry(id: string, version = "1.0.0"): ExtensionManifestEntry {
  return makeEntry({
    id,
    version,
    type: "quality-pack",
    entryPoint: `src/quality/${id}.ts`,
    capabilities: ["lint"],
  });
}

export function makeModuleEntry(id: string, version = "1.0.0"): ExtensionManifestEntry {
  return makeEntry({
    id,
    version,
    type: "cohesive-product-module",
    entryPoint: `src/modules/${id}/index.ts`,
    capabilities: ["service"],
  });
}

export const VALID_TIMESTAMP = "2026-07-15T12:00:00Z";
export const LATER_TIMESTAMP = "2026-07-16T12:00:00Z";
export const ZERO_DIGEST = "0".repeat(64);
