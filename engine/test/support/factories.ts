import {
  DEFAULT_PERFORMANCE_CONFIG,
  parsePerformanceConfig,
  type PerformanceConfig,
} from "../../src/performance/performance-config.ts";
import type { QualityContext } from "../../src/quality-packs/quality-pack.ts";
import type { RegisteredTool } from "../../src/runtime/tool-registry.ts";

/**
 * Shared test factories. Single owner of small object builders previously
 * copied across suites: `makePerfConfig` (5 copies in test/performance/),
 * `makeQualityContext` (3 copies in test/quality-packs/),
 * `makeRegisteredTool` (2 drifted copies in test/runtime/), and
 * `thrownFailure` (the thrown-primary-failure matrix of the timeline suites).
 */

/**
 * The thrown value named by a static failure label. A test that proves a
 * behavior for both an `Error` and a thrown `undefined` iterates the literal
 * labels `["Error", "undefined"]`, so the test inventory can name every
 * registration from the file's own bytes, and derives the thrown value here
 * inside the test body.
 */
export function thrownFailure(kind: "Error" | "undefined", message: string): Error | undefined {
  return kind === "Error" ? new Error(message) : undefined;
}

export function makePerfConfig(overrides: Partial<PerformanceConfig> = {}): PerformanceConfig {
  return parsePerformanceConfig({ ...DEFAULT_PERFORMANCE_CONFIG, ...overrides });
}

export function makeQualityContext(files: Readonly<Record<string, string>>): QualityContext {
  return { filePath: null, source: null, rootPath: null, files, config: {} };
}

export function makeRegisteredTool(name: string): RegisteredTool {
  return {
    definition: {
      type: "function",
      function: { name, description: `tool ${name}`, parameters: { type: "object", properties: {}, required: [] } },
    },
    handler: () => "ok",
  };
}
