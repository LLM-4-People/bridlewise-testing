/** Public presentation metadata, derived from canonical registrations, never execution authority. */
import type { ToolManifestEntry } from "../engine/src/tools/tool-manifest.ts";

export type ToolPresentation = Readonly<{
  name: ToolManifestEntry["name"];
  label?: ToolManifestEntry["label"];
  outputShape?: ToolManifestEntry["outputShape"];
  fileEffect: boolean;
}>;
export type ToolPresentationContext = ReadonlyMap<string, ToolPresentation>;

/** The one classification consumed by live and recorded file-effect projection. */
export function toolChangesFile(entry: Pick<ToolManifestEntry, "capabilities">): boolean {
  return entry.capabilities.includes("write");
}

export function projectToolPresentation(entry: ToolManifestEntry): ToolPresentation {
  return Object.freeze({
    name: entry.name,
    ...(entry.label === undefined ? {} : { label: entry.label }),
    ...(entry.outputShape === undefined ? {} : { outputShape: entry.outputShape }),
    fileEffect: toolChangesFile(entry),
  });
}

export function toolPresentationByName(entries: readonly ToolPresentation[]): ToolPresentationContext {
  const byName = new Map<string, ToolPresentation>();
  for (const entry of entries) {
    if (byName.has(entry.name)) throw new TypeError("Recorded tool presentation names must be unique");
    byName.set(entry.name, entry);
  }
  return byName;
}

/** Svelte providers scope this same immutable lookup to the recorded surface. */
export const TOOL_PRESENTATION_CONTEXT = Symbol("bridlewise-recorded-tool-presentation");
