// @vitest-environment node
/**
 * Tests for the frontend web-ui config accessor (src/state/web-ui-config.ts).
 *
 * Verifies the pure readGraphConfig / readMetricsConfig helpers return the
 * config values when present and the documented defaults for any missing /
 * invalid key (single source of truth: webUi.graph / webUi.metrics in
 * bridlewise.config.json; these fallbacks mirror the server's
 * getGraphConfig / getMetricsConfig so both sides agree).
 *
 * IMPORTANT: the expected config keys are DYNAMICALLY PARSED from
 * the source `DEFAULT_GRAPH_CONFIG` object in `shared/web-ui-defaults.ts`,
 * NOT hardcoded in this test. If someone adds a new config key to the
 * `GraphConfig` type + `DEFAULT_GRAPH_CONFIG`, the test automatically
 * covers it — no manual list update needed. A hardcoded list would silently
 * miss new keys.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readGraphConfig, readMetricsConfig } from "../../src/state/web-ui-config";

// ── Dynamic key discovery ──
// SPO: the `GraphConfig` + `MetricsConfig` TYPES are owned by
// `shared/wire-types.ts` (single wire-shape owner). The type KEYS are
// parsed from the contracts owner; the DEFAULT_* fallback VALUES are parsed
// from `shared/web-ui-defaults.ts` — the single declaration BOTH the
// server (`server/harness-config.ts`) and the client
// (`src/state/web-ui-config.ts`, which re-exports the readers) compile
// against. The tables previously lived duplicated in the two consumers.
// This ensures the test covers EVERY key in the type — if a new key is
// added to the contracts type, the test automatically checks it.
const WEB_UI_CONFIG_SRC = readFileSync(
  join(process.cwd(), "shared/web-ui-defaults.ts"),
  "utf8",
);
const WIRE_TYPES_SRC = readFileSync(
  join(process.cwd(), "shared/wire-types.ts"),
  "utf8",
);

// Extract the GraphConfig type fields from the contracts owner (lines like
// ` maxNodes: number;`).
const GRAPH_CONFIG_KEYS = Array.from(
  WIRE_TYPES_SRC.matchAll(/GraphConfig\s*=\s*Readonly<\{([\s\S]*?)\}\s*>/g),
).flatMap((m) =>
  Array.from(m[1]!.matchAll(/^\s+(\w+):\s+number;\s*$/gm)).map((mm) => mm[1]),
).filter((k) => k !== undefined) as string[];

// Extract the MetricsConfig type fields from the contracts owner.
const METRICS_CONFIG_KEYS = Array.from(
  WIRE_TYPES_SRC.matchAll(/MetricsConfig\s*=\s*Readonly<\{([^}]+)\}/gs),
).flatMap((m) =>
  Array.from(m[1]!.matchAll(/(\w+):\s*number;/g)).map((mm) => mm[1]),
).filter((k) => k !== undefined);

// Parse the DEFAULT_GRAPH_CONFIG object values from the source (so the
// expected defaults come from the SAME file as the implementation — no
// drift possible).
const DEFAULT_GRAPH_VALUES: Record<string, unknown> = {};
const graphConfigBlock = WEB_UI_CONFIG_SRC.match(
  /DEFAULT_GRAPH_CONFIG:\s*GraphConfig\s*=\s*\{([^}]+)\}/s,
);
if (graphConfigBlock !== null) {
  for (const line of graphConfigBlock[1]!.split("\n")) {
    const m = line.match(/^\s*(\w+):\s*(.+?),?\s*$/);
    if (m !== null) {
      const val = m[2]!.trim();
      // Parse the value as a JS literal (number, string, etc.)
      DEFAULT_GRAPH_VALUES[m[1]!] = Number(val);
    }
  }
}

const DEFAULT_METRICS_VALUES: Record<string, unknown> = {};
const metricsConfigBlock = WEB_UI_CONFIG_SRC.match(
  /DEFAULT_METRICS_CONFIG:\s*MetricsConfig\s*=\s*\{([^}]+)\}/s,
);
if (metricsConfigBlock !== null) {
  // The metrics config is on one line: { pollMs: 8000, historyMax: 60 }
  const pairs = metricsConfigBlock[1]!.matchAll(/(\w+):\s*([\d.]+)/g);
  for (const m of pairs) {
    DEFAULT_METRICS_VALUES[m[1]!] = Number(m[2]);
  }
}

describe("readGraphConfig — defaults + overrides", () => {
  test("null/undefined/empty config returns the documented defaults", () => {
    const defaults = readGraphConfig(null);
    // dynamically verify EVERY key in the GraphConfig type is
    // present in the defaults (not a hardcoded list).
    expect(GRAPH_CONFIG_KEYS.length, "GraphConfig type must have keys").toBeGreaterThan(0);
    for (const key of GRAPH_CONFIG_KEYS) {
      expect(defaults, `defaults must include key: ${key}`).toHaveProperty(key);
      expect(typeof defaults[key as keyof typeof defaults]).toBe("number");
    }
    // Verify the defaults match the source DEFAULT_GRAPH_CONFIG values
    for (const [key, expectedVal] of Object.entries(DEFAULT_GRAPH_VALUES)) {
      expect(defaults[key as keyof typeof defaults], `default for ${key}`).toBe(expectedVal);
    }
    expect(readGraphConfig(undefined)).toEqual(defaults);
    expect(readGraphConfig({})).toEqual(defaults);
  });

  test("present values override the defaults", () => {
    const cfg = readGraphConfig({ webUi: { graph: { repulsion: 50000, iterations: 50, minZoom: 0.5, maxZoom: 8, minCanvasPx: 320, maxFitScale: 3, fitMarginPx: 24 } } });
    expect(cfg.repulsion).toBe(50000);
    expect(cfg.iterations).toBe(50);
    expect(cfg.minZoom).toBe(0.5);
    expect(cfg.maxZoom).toBe(8);
    expect(cfg.minCanvasPx).toBe(320);
    expect(cfg.maxFitScale).toBe(3);
    expect(cfg.fitMarginPx).toBe(24);
    // Untouched keys keep their defaults.
    expect(cfg.springLength).toBe(DEFAULT_GRAPH_VALUES.springLength);
    expect(cfg.maxNodes).toBe(DEFAULT_GRAPH_VALUES.maxNodes);
  });

  test("invalid (non-positive / non-finite) values fall back to defaults", () => {
    const cfg = readGraphConfig({
      webUi: { graph: { repulsion: -1, iterations: 0, maxNodes: NaN, damping: "0.85", minZoom: 0, maxZoom: -2, minCanvasPx: 0, maxFitScale: 0, fitMarginPx: -5 } },
    });
    expect(cfg.repulsion).toBe(DEFAULT_GRAPH_VALUES.repulsion);
    expect(cfg.iterations).toBe(DEFAULT_GRAPH_VALUES.iterations);
    expect(cfg.maxNodes).toBe(DEFAULT_GRAPH_VALUES.maxNodes);
    expect(cfg.damping).toBe(DEFAULT_GRAPH_VALUES.damping);
    expect(cfg.minZoom).toBe(DEFAULT_GRAPH_VALUES.minZoom);
    expect(cfg.maxZoom).toBe(DEFAULT_GRAPH_VALUES.maxZoom);
    expect(cfg.minCanvasPx).toBe(DEFAULT_GRAPH_VALUES.minCanvasPx);
    expect(cfg.maxFitScale).toBe(DEFAULT_GRAPH_VALUES.maxFitScale);
    expect(cfg.fitMarginPx).toBe(DEFAULT_GRAPH_VALUES.fitMarginPx);
  });

  test("fractional maxNodes is floored to an integer", () => {
    expect(readGraphConfig({ webUi: { graph: { maxNodes: 123.9 } } }).maxNodes).toBe(123);
  });
});

describe("readMetricsConfig — defaults + overrides", () => {
  test("null/undefined/empty config returns the documented defaults", () => {
    const defaults = readMetricsConfig(null);
    // dynamically verify EVERY key in the MetricsConfig type
    expect(METRICS_CONFIG_KEYS.length).toBeGreaterThan(0);
    for (const key of METRICS_CONFIG_KEYS) {
      expect(defaults, `defaults must include key: ${key}`).toHaveProperty(key);
      expect(typeof defaults[key as keyof typeof defaults]).toBe("number");
    }
    for (const [key, expectedVal] of Object.entries(DEFAULT_METRICS_VALUES)) {
      expect(defaults[key as keyof typeof defaults], `default for ${key}`).toBe(expectedVal);
    }
    expect(readMetricsConfig({})).toEqual(defaults);
  });

  test("present values override the defaults", () => {
    expect(readMetricsConfig({ webUi: { metrics: { pollMs: 4000, historyMax: 120 } } })).toEqual({
      pollMs: 4000,
      historyMax: 120,
    });
  });

  test("invalid values fall back to defaults", () => {
    expect(readMetricsConfig({ webUi: { metrics: { pollMs: 0, historyMax: -5 } } })).toEqual({
      pollMs: DEFAULT_METRICS_VALUES.pollMs,
      historyMax: DEFAULT_METRICS_VALUES.historyMax,
    });
  });
});
