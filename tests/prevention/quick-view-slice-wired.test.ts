// @vitest-environment node
/**
 * Prevention test (exp510): quick_view, slice, viewport, skeleton tools
 * are wired in the manifest AND executor (all tools
 * must be exposed; all tools wired the same way).
 *
 * Also verifies that the tool-executor dispatch table and the tools-bridge
 * manifest stay in sync.
 */

import { describe, it, expect } from "vitest";

import { isToolExecutable, listExecutableTools } from "../../server/tools/tool-executor.ts";
import { getToolManifest } from "../../server/tools/tools-bridge.ts";

// DYNAMIC discovery: the intelligence tools are the manifest entries whose
// `adapterId === "web-ui-intelligence"`. A new intelligence tool added to
// the manifest is auto-covered (deny-by-default: it must be executable +
// present in the manifest); no hardcoded tool-name list that silently rots.
const EXPECTED_NEW_TOOLS = getToolManifest()
  .filter((t) => t.adapterId === "web-ui-intelligence")
  .map((t) => t.name);
expect(EXPECTED_NEW_TOOLS.length, "must discover web-ui-intelligence tools").toBeGreaterThan(0);

describe("quick_view + slice tools wired", () => {
  it("quick_view, slice, viewport, skeleton are executable", () => {
    for (const name of EXPECTED_NEW_TOOLS) {
      expect(isToolExecutable(name)).toBe(true);
    }
  });

  it("quick_view, slice, viewport, skeleton appear in the tool manifest", () => {
    const manifest = getToolManifest();
    const names = manifest.map((t) => t.name);
    for (const name of EXPECTED_NEW_TOOLS) {
      expect(names).toContain(name);
    }
  });

  it("the manifest entries have correct adapterId (web-ui-intelligence)", () => {
    const manifest = getToolManifest();
    for (const name of EXPECTED_NEW_TOOLS) {
      const entry = manifest.find((t) => t.name === name);
      expect(entry).toBeDefined();
      expect(entry!.adapterId).toBe("web-ui-intelligence");
    }
  });

  it("slice manifest has name + optional file args", () => {
    const manifest = getToolManifest();
    const slice = manifest.find((t) => t.name === "slice");
    expect(slice).toBeDefined();
    expect(slice!.inputSchema.required).toContain("name");
    expect(slice!.inputSchema.properties).toHaveProperty("file");
  });

  it("viewport manifest has file + startLine + endLine required", () => {
    const manifest = getToolManifest();
    const vp = manifest.find((t) => t.name === "viewport");
    expect(vp).toBeDefined();
    const required = vp!.inputSchema.required as readonly string[];
    expect(required).toContain("file");
    expect(required).toContain("startLine");
    expect(required).toContain("endLine");
  });

  it("every manifest entry has a matching executor (no drift)", () => {
    const manifest = getToolManifest();
    const executable = new Set(listExecutableTools());
    for (const entry of manifest) {
      if (entry.category === "built-in") {
        expect(executable.has(entry.name), `manifest entry "${entry.name}" has no executor`).toBe(true);
      }
    }
  });
});
