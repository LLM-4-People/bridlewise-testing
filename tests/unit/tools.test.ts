// @vitest-environment node
import { describe, test, expect, beforeEach } from "vitest";

import {
  toolManifest,
  toolCount,
  toolById,
  toolByName,
  toolLabel,
  fileEffectToolNames,
  setTools,
  resetTools,
} from "../../src/state/tools";
import type { WebToolEntry } from "../../shared/types";

function entry(
  id: string,
  name: string,
  extra: Partial<WebToolEntry> = {},
): WebToolEntry {
  return {
    id,
    name,
    description: `${name} tool`,
    inputSchema: {},
    capabilities: [],
    bounds: { timeoutMs: 1000, maxOutputBytes: 0, maxMemoryBytes: 0 },
    adapterId: "adapter",
    category: "built-in",
    kind: "filesystem",
    ...extra,
  };
}

describe("tools store", () => {
  beforeEach(() => resetTools());

  test("initial state is empty", () => {
    expect(toolManifest.get()).toHaveLength(0);
    expect(toolCount.get()).toBe(0);
    expect(toolById.get().size).toBe(0);
  });

  test("setTools populates manifest and lookups", () => {
    setTools([entry("t1", "read_file"), entry("t2", "edit_file")]);
    expect(toolCount.get()).toBe(2);
    expect(toolById.get().get("t1")?.name).toBe("read_file");
    expect(toolByName.get().get("edit_file")?.id).toBe("t2");
  });

  test("resetTools clears the manifest", () => {
    setTools([entry("t1", "read_file")]);
    resetTools();
    expect(toolManifest.get()).toHaveLength(0);
    expect(toolById.get().size).toBe(0);
  });

  test("a tool renamed at registration needs NO frontend edit — the label + effect derive from the manifest", () => {
    // The rename-safety proof. A tool the registry renames (`edit` →
    // `apply_edit`, with its declared label) is served under the new name;
    // the UI derives the label and the file-effect class from the served
    // entry, and the OLD name falls back to its spaced name (no bespoke
    // answer lingers for a tool nothing serves).
    setTools([entry("apply_edit", "apply_edit", { label: "apply an edit", capabilities: ["write"] })]);
    expect(toolLabel("apply_edit")).toBe("apply an edit");
    expect(fileEffectToolNames()).toEqual(new Set(["apply_edit"]));
    // The removed name is no longer served: no bespoke label survives it.
    expect(toolLabel("edit")).toBe("edit");
    expect(fileEffectToolNames().has("edit")).toBe(false);
  });

  test("the file-effect set is derived from the write capability, and a label falls back honestly", () => {
    setTools([
      entry("reader", "reader", { capabilities: ["read"] }),
      entry("writer", "writer", { capabilities: ["write"] }),
      entry("unlabeled", "unlabeled_tool"),
    ]);
    expect(fileEffectToolNames()).toEqual(new Set(["writer"]));
    // A tool with no declared label renders as its name, underscores spaced.
    expect(toolLabel("unlabeled_tool")).toBe("unlabeled tool");
  });
});
