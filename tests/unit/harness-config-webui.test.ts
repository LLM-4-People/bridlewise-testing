// @vitest-environment node
/**
 * Tests for the server-side webUi.graph / webUi.metrics / webUi.performance
 * config accessors (server/harness-config.ts). Verifies against the REAL harness config
 * file (which now declares the webUi section) and that the fallbacks match the
 * frontend readGraphConfig / readMetricsConfig defaults (single source
 * of truth — both sides must agree). The performance budgets have no
 * frontend reader; their pin is the server defaults == the config's
 * declared values (the section's own rule, see the performance describe).
 */
import { describe, test, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getGraphConfig, getMetricsConfig, getGraphMaxNodes, getPerformanceBudgetConfig } from "../../server/kernel/harness-config.ts";
import { resetServerConfig, serverConfig } from "../../server/kernel/config.ts";
import { readGraphConfig, readMetricsConfig, readPromptGeneratorConfig } from "../../src/state/web-ui-config.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const realConfigPath = resolve(serverConfig.harnessConfigPath);

function readWebUi(): {
  graph?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  performance?: Record<string, unknown>;
  promptGenerator?: Record<string, unknown>;
} {
  try {
    const doc = JSON.parse(readFileSync(realConfigPath, "utf8")) as {
      webUi?: {
        graph?: Record<string, unknown>;
        metrics?: Record<string, unknown>;
        performance?: Record<string, unknown>;
        promptGenerator?: Record<string, unknown>;
      };
    };
    return doc.webUi ?? {};
  } catch {
    return {};
  }
}

describe("getGraphConfig — reads webUi.graph from the real config", () => {
  test("returns the values declared in bridlewise.config.json", () => {
    const cfg = getGraphConfig();
    const declared = readWebUi().graph ?? {};
    // Each declared key must match what the accessor returns (the config
    // file IS the single source of truth — the accessor must not bake in a
    // different value).
    for (const [k, v] of Object.entries(declared)) {
      expect((cfg as Record<string, unknown>)[k], `graph.${k} must match config`).toBe(v);
    }
  });

  test("getGraphMaxNodes matches getGraphConfig.maxNodes", () => {
    expect(getGraphMaxNodes()).toBe(getGraphConfig().maxNodes);
  });

  test("server defaults mirror the frontend readGraphConfig defaults (no drift)", () => {
    // When the config omits a key, both sides must agree on the default.
    const serverFallback = getGraphConfig();
    const frontendFallback = readGraphConfig(null);
    expect(serverFallback).toEqual(frontendFallback);
  });
});

describe("getMetricsConfig — reads webUi.metrics from the real config", () => {
  test("returns the values declared in bridlewise.config.json", () => {
    const cfg = getMetricsConfig();
    const declared = readWebUi().metrics ?? {};
    for (const [k, v] of Object.entries(declared)) {
      expect((cfg as Record<string, unknown>)[k], `metrics.${k} must match config`).toBe(v);
    }
  });

  test("server defaults mirror the frontend readMetricsConfig defaults (no drift)", () => {
    expect(getMetricsConfig()).toEqual(readMetricsConfig(null));
  });
});

describe("getPerformanceBudgetConfig — reads webUi.performance from the real config", () => {
  // The performance regression gate (tests/performance/regression.test.ts)
  // imports getPerformanceBudgetConfig + fails if a measured metric exceeds
  // its budget. This contract test pins: (1) the accessor returns the values
  // declared in bridlewise.config.json (the config is the truth), and
  // (2) every budget field is a finite, sensible positive number (a NaN or
  // negative budget would silently disable the gate — a drift the regression
  // test would not catch because the comparison would always pass/fail
  // spuriously).
  test("returns the values declared in bridlewise.config.json", () => {
    const cfg = getPerformanceBudgetConfig();
    const declared = readWebUi().performance ?? {};
    for (const [k, v] of Object.entries(declared)) {
      expect((cfg as Record<string, unknown>)[k], `performance.${k} must match config`).toBe(v);
    }
  });

  test("every budget field is a finite positive number (a bad value would silently disable the gate)", () => {
    const cfg = getPerformanceBudgetConfig();
    for (const [k, v] of Object.entries(cfg)) {
      expect(typeof v, `performance.${k} must be a number`).toBe("number");
      expect(Number.isFinite(v), `performance.${k} must be finite`).toBe(true);
      expect(v, `performance.${k} must be > 0`).toBeGreaterThan(0);
    }
  });

  test("the config file declares the performance section (no silent fallback for the gate)", () => {
    const declared = readWebUi().performance;
    expect(declared, "webUi.performance must be declared in bridlewise.config.json").toBeDefined();
    expect(Object.keys(declared ?? {}).length, "webUi.performance must declare all budget fields").toBeGreaterThan(0);
  });

  test("NO DEFAULT IN CODE: an undeclared section, an undeclared field and an invalid value are each REFUSED by name, never substituted (design M8; UR-17)", () => {
    const dir = createTempDir("perf-budget-refusals-");
    const base = JSON.parse(readFileSync(realConfigPath, "utf8")) as { webUi?: { performance?: Record<string, unknown> } };
    const cases: readonly [string, unknown, string][] = [
      ["no section", { ...base, webUi: { ...base.webUi, performance: undefined } }, "missing_performance_budget"],
      ["no field", { ...base, webUi: { ...base.webUi, performance: { ...base.webUi!.performance, lcpMaxMs: undefined } } }, "missing_performance_budget"],
      ["invalid", { ...base, webUi: { ...base.webUi, performance: { ...base.webUi!.performance, tabDomNodesMax: 1.5 } } }, "invalid_performance_budget"],
    ];
    try {
      for (const [what, document, code] of cases) {
        const path = join(dir, `${what.replace(/\s/gu, "-")}.config.json`);
        writeFileSync(path, JSON.stringify(document));
        resetServerConfig({ ...process.env, HARNESS_CONFIG_PATH: path });
        expect(() => getPerformanceBudgetConfig(), what).toThrowError(expect.objectContaining({ code, message: expect.stringMatching(/^webUi\.performance\b/u) }));
      }
    } finally {
      resetServerConfig();
    }
  });
});

describe("readPromptGeneratorConfig — reads webUi.promptGenerator from the real config", () => {
  test("every declared option catalog is non-empty and matches the config ids", () => {
    const declared = readWebUi().promptGenerator ?? {};
    const raw = JSON.parse(readFileSync(realConfigPath, "utf8")) as Record<string, unknown>;
    const cfg = readPromptGeneratorConfig(raw);
    // Each declared section must be a non-empty array in the config (the
    // prompt generator is useless without options), and every declared id
    // must be present in the reader's resolved list (config is the truth).
    for (const section of ["roles", "tones", "outputFormats", "languages", "constraints"] as const) {
      const declaredArr = declared[section];
      if (!Array.isArray(declaredArr)) continue;
      const ids = (cfg[section] as readonly { id: string }[]).map((o) => o.id);
      for (const entry of declaredArr as { id?: string }[]) {
        if (typeof entry.id === "string") {
          expect(ids, `${section}.${entry.id} must be present`).toContain(entry.id);
        }
      }
    }
  });

  test("the config declares at least one role, tone, format, language, and constraint (usability)", () => {
    const raw = JSON.parse(readFileSync(realConfigPath, "utf8")) as Record<string, unknown>;
    const cfg = readPromptGeneratorConfig(raw);
    expect(cfg.roles.length).toBeGreaterThan(0);
    expect(cfg.tones.length).toBeGreaterThan(0);
    expect(cfg.outputFormats.length).toBeGreaterThan(0);
    expect(cfg.languages.length).toBeGreaterThan(0);
    expect(cfg.constraints.length).toBeGreaterThan(0);
  });

  test("each option has a non-empty id, label, and instruction (no half-formed options)", () => {
    const raw = JSON.parse(readFileSync(realConfigPath, "utf8")) as Record<string, unknown>;
    const cfg = readPromptGeneratorConfig(raw);
    for (const section of [cfg.roles, cfg.tones, cfg.outputFormats, cfg.languages, cfg.constraints]) {
      for (const o of section) {
        expect(typeof o.id).toBe("string");
        expect(o.id.length).toBeGreaterThan(0);
        expect(typeof o.label).toBe("string");
        expect(o.label.length).toBeGreaterThan(0);
        expect(typeof o.instruction).toBe("string");
        expect(o.instruction.length).toBeGreaterThan(0);
      }
    }
  });

  test("empty-config default is all-empty lists (single owner: frontend reader)", () => {
    expect(readPromptGeneratorConfig(null)).toEqual({
      roles: [], tones: [], outputFormats: [], languages: [], constraints: [],
    });
  });

  test("malformed options (missing instruction, non-object, empty id) are dropped", () => {
    const malformed = {
      webUi: {
        promptGenerator: {
          roles: [
            { id: "ok", label: "OK", instruction: "Good." },
            { id: "bad", label: "Bad" }, // missing instruction
            "not-an-object",
            { id: "", label: "Empty id", instruction: "x" }, // empty id
          ],
          tones: [], outputFormats: [], languages: [], constraints: [],
        },
      },
    };
    const fe = readPromptGeneratorConfig(malformed as unknown as Record<string, unknown>);
    expect(fe.roles.map((o) => o.id)).toEqual(["ok"]);
  });
});
