// @vitest-environment node
/**
 * THE FILE-READ CAP IS ITS OWN DECLARED LEAF (specs/cfg-final.md §17 B3).
 *
 * `getToolBounds().maxFileBytes` caps `read_file` and content search. It was
 * derived from `tools.defaultBounds.maxOutputBytes` (the OUTPUT cap), so
 * raising how much output a tool may print silently raised how large a file a
 * read may load. It now reads `tools.limits.maxReadBytes`, the leaf the
 * engine's own `read_file` reads, and falls back to its own default.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import { getToolBounds } from "../../server/kernel/harness-config.ts";
import { isolateHarnessConfig, plantSettingsDocument } from "../helpers/isolated-config.ts";

const path = isolateHarnessConfig("tool-bounds-");
const original = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

function plant(tools: Record<string, unknown>): void {
  plantSettingsDocument(path, `${JSON.stringify({ ...original, tools: { ...original.tools, ...tools } }, null, 2)}\n`);
}

describe("tool bounds", () => {
  test("the file-read cap follows tools.limits.maxReadBytes, never the output cap", () => {
    plant({ defaultBounds: { ...original.tools.defaultBounds, maxOutputBytes: 2_097_152 }, limits: { ...original.tools.limits, maxReadBytes: 4096 } });
    const bounds = getToolBounds();
    expect(bounds.maxOutputBytes).toBe(2_097_152);
    expect(bounds.maxFileBytes, "the read cap is its own leaf").toBe(4096);
  });

  test("raising the output cap alone does not move the file-read cap", () => {
    plant({ defaultBounds: { ...original.tools.defaultBounds, maxOutputBytes: 8_388_608 } });
    expect(getToolBounds().maxFileBytes).toBe(original.tools.limits.maxReadBytes);
    expect(getToolBounds().maxOutputBytes).toBe(8_388_608);
  });
});
