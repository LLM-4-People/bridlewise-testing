// @vitest-environment node
/**
 * Intelligence exposure is config-bound and map-cache signals/actions
 * read the live bridge, not a stub counter.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  registerAllExposure,
  resetAllRegistrations,
  listCustomizations,
  listSignals,
  executeAction,
  readSignal,
  installCustomizationConfigStore,
  installIntelligenceMapCacheSource,
  installIntelligenceMapCacheInvalidate,
  clearIntelligenceMapCacheSource,
} from "../../server/kernel/canonical.ts";
import { serverConfig } from "../../server/kernel/config.ts";

beforeEach(() => {
  let doc: Record<string, unknown> = {};
  installCustomizationConfigStore({
    configFilePath: serverConfig.harnessConfigPath,
    readDocument: () => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
    writeDocument: (next) => {
      doc = next;
    },
  });
  resetAllRegistrations();
  registerAllExposure();
});

afterEach(() => {
  clearIntelligenceMapCacheSource();
  resetAllRegistrations();
});

describe("intelligence exposure — live knobs and map cache", () => {
  test("publishes config-bound customizations under codeIntelligence", () => {
    const intel = listCustomizations().filter((c) => c.module === "intelligence");
    expect(intel.length).toBeGreaterThan(20);
    for (const c of intel) {
      expect(c.configPath, `${c.id} must be config-bound`).toBeDefined();
      expect(c.configPath!.startsWith("codeIntelligence.")).toBe(true);
    }
    expect(intel.some((c) => c.id === "intelligence.farmPerFileTimeoutMs")).toBe(true);
    expect(intel.some((c) => c.id === "intelligence.phraseBoost")).toBe(true);
    expect(intel.some((c) => c.id === "intelligence.staleSampleFloor")).toBe(true);
  });

  test("without a map-cache source the signals are honest zeros and drop is unavailable", async () => {
    expect(readSignal("intelligence.cachedProjects")).toBe(0);
    expect(readSignal("intelligence.lastMapFiles")).toBe(0);
    expect(readSignal("intelligence.lastMapSymbols")).toBe(0);
    const result = await executeAction("intelligence.dropCachedMaps") as {
      dropped: number;
      available: boolean;
    };
    expect(result.available).toBe(false);
    expect(result.dropped).toBe(0);
  });

  test("an installed source is what the signals and drop action read", async () => {
    let cached = 2;
    installIntelligenceMapCacheSource(() => ({
      cachedProjects: cached,
      lastFileCount: 11,
      lastSymbolCount: 29,
    }));
    installIntelligenceMapCacheInvalidate(() => {
      cached = 0;
      return 2;
    });
    expect(readSignal("intelligence.cachedProjects")).toBe(2);
    expect(readSignal("intelligence.lastMapFiles")).toBe(11);
    expect(readSignal("intelligence.lastMapSymbols")).toBe(29);
    const result = await executeAction("intelligence.dropCachedMaps") as {
      dropped: number;
      available: boolean;
    };
    expect(result.available).toBe(true);
    expect(result.dropped).toBe(2);
    expect(readSignal("intelligence.cachedProjects")).toBe(0);
  });

  test("graph and artifacts modules are on the settings surface", () => {
    const graph = listCustomizations().filter((c) => c.module === "graph");
    const artifacts = listCustomizations().filter((c) => c.module === "artifacts");
    expect(graph.length).toBeGreaterThan(20);
    expect(artifacts.map((c) => c.id).sort()).toEqual([
      "artifacts.idLength",
      "artifacts.iframeSandbox",
      "artifacts.maxBytes",
    ]);
    expect(listSignals().some((s) => s.module === "intelligence")).toBe(true);
    expect(listSignals().some((s) => s.id === "intelligence.treeSitterLanguages")).toBe(true);
  });
});
