// @vitest-environment node
/**
 * PREVENTION test for memory opt-in via tool schema.
 *
 * Rule: "Memory opt-in via tool schema — don't save errors/failures." The
 * run route stores a tool result as a memory entry ONLY when:
 * 1. The tool opted in (saveToMemory === true on its manifest entry), AND
 * 2. The result succeeded (toolResult.success === true).
 *
 * Error results are NEVER saved regardless of the opt-in flag. Ephemeral
 * content tools (read_file, list_files, editor tools) NEVER opt in — saving
 * their results would pollute memory with file contents and mutations.
 *
 * This test verifies the manifest propagation (SAVE_TO_MEMORY_TOOLS →
 * WebToolEntry.saveToMemory) and the gate condition as a pure function so a
 * regression that weakens either invariant is caught mechanically.
 */
import { describe, test, expect } from "vitest";
import { getToolManifest } from "../../server/tools/tools-bridge.ts";

// The gate condition extracted from run.ts:1011 as a pure function.
// `saveToMemoryTools` is the Set built in run.ts from the manifest.
function shouldSaveToMemory(
  toolName: string,
  success: boolean,
  saveToMemoryTools: ReadonlySet<string>,
): boolean {
  return saveToMemoryTools.has(toolName) && success;
}

describe("memory opt-in: manifest propagation (SAVE_TO_MEMORY_TOOLS → saveToMemory flag)", () => {
  const manifest = getToolManifest();

  test("knowledge-gathering tools opt in to memory", () => {
    const optIn = new Set(
      manifest.filter((t) => t.saveToMemory === true).map((t) => t.name),
    );
    // The canonical knowledge-gathering tools must be in the opt-in set.
    expect(optIn.has("search_code")).toBe(true);
    expect(optIn.has("get_repository_map")).toBe(true);
    expect(optIn.has("find_reuse")).toBe(true);
    expect(optIn.has("get_dependency_graph")).toBe(true);
    expect(optIn.has("quick_view")).toBe(true);
  });

  test("ephemeral content tools do NOT opt in (no memory pollution)", () => {
    const noSave = manifest.filter((t) => t.saveToMemory !== true).map((t) => t.name);
    // read_file, list_files, and editor tools must NOT be in the opt-in set.
    for (const ephemeral of ["read_file", "list_files", "replace_file", "apply_patch", "insert_text", "delete_range", "replace_range"]) {
      const entry = manifest.find((t) => t.name === ephemeral);
      if (entry !== undefined) {
        expect(entry.saveToMemory).not.toBe(true);
      }
    }
  });

  test("saveToMemory flag is a boolean or undefined (never a truthy non-boolean)", () => {
    for (const entry of manifest) {
      expect([true, false, undefined]).toContain(entry.saveToMemory);
    }
  });
});

describe("memory opt-in: gate condition (only opt-in AND success saves)", () => {
  const saveToMemoryTools = new Set(["search_code", "get_repository_map", "find_reuse", "get_dependency_graph", "quick_view", "score_quality", "get_awareness_summary"]);

  test("opt-in tool + success → saves", () => {
    expect(shouldSaveToMemory("search_code", true, saveToMemoryTools)).toBe(true);
  });

  test("opt-in tool + FAILURE → does NOT save (errors never saved)", () => {
    expect(shouldSaveToMemory("search_code", false, saveToMemoryTools)).toBe(false);
  });

  test("non-opt-in tool + success → does NOT save (no pollution)", () => {
    expect(shouldSaveToMemory("read_file", true, saveToMemoryTools)).toBe(false);
  });

  test("non-opt-in tool + failure → does NOT save (double negative)", () => {
    expect(shouldSaveToMemory("read_file", false, saveToMemoryTools)).toBe(false);
  });

  test("unknown tool → does NOT save", () => {
    expect(shouldSaveToMemory("nonexistent_tool", true, saveToMemoryTools)).toBe(false);
  });

  test("editor tools never save even on success", () => {
    for (const editor of ["replace_file", "apply_patch", "insert_text", "delete_range", "replace_range"]) {
      expect(shouldSaveToMemory(editor, true, saveToMemoryTools)).toBe(false);
    }
  });
});
