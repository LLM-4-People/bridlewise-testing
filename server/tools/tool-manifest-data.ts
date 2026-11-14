/**
 * Data-only editor registration and schema normalization, shared by the live
 * registry and public build projection. No server configuration, discovery or
 * execution is invoked here. Engine editor implementation dependencies remain
 * reachable at build time; this module is never imported into the browser.
 */
import { createEditorToolDefinitions, EDIT_TOOL_LABEL } from "../../engine/src/editor/edit-tools.ts";
import { DEFAULT_TOOL_RESOURCE_BOUNDS, type ToolManifestEntry } from "../../engine/src/tools/tool-manifest.ts";

/** The existing editor definition-to-manifest conversion, with no UI-only tags. */
export function editorToolEntries(): readonly ToolManifestEntry[] {
  return createEditorToolDefinitions().map((def) => Object.freeze({
    id: def.function.name,
    name: def.function.name,
    description: def.function.description,
    inputSchema: def.function.parameters as Readonly<Record<string, unknown>>,
    capabilities: Object.freeze(["write"] as const),
    bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
    adapterId: "web-ui-editor",
    label: EDIT_TOOL_LABEL,
  }));
}

/** Preserve all registration fields while tightening the one canonical input schema. */
export function normalizeToolInputSchema<T extends ToolManifestEntry>(entry: T): T {
  const schema = entry.inputSchema;
  if (schema["type"] === "object" && Array.isArray(schema["required"]) && schema["additionalProperties"] === false) return entry;
  return Object.freeze({
    ...entry,
    inputSchema: Object.freeze({
      ...schema,
      type: "object",
      required: Array.isArray(schema["required"]) ? schema["required"] : [],
      additionalProperties: false,
    }),
  });
}
