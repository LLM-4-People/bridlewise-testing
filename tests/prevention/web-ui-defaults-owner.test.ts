// @vitest-environment node
/**
 * ONE DECLARATION OF THE WEB-UI DEFAULTS, TWO IMPORTERS.
 *
 * The `webUi.graph` / `webUi.metrics` / `artifacts.iframeSandbox` fallbacks
 * are needed on BOTH sides: the server reads the config file, the client
 * reads the redacted snapshot from `GET /api/config`. Each side used to carry
 * its own copy — a 30-key `DEFAULT_GRAPH_CONFIG` table byte-identical in
 * `server/harness-config.ts` and `src/state/web-ui-config.ts`, plus a second
 * `DEFAULT_METRICS_CONFIG`, a second `"allow-scripts"` literal, a second pair
 * of `asPositiveInt`/`asPositiveNumber` coercers, and a second copy of the
 * whole key-by-key coercion body.
 *
 * A drift test can only report divergence AFTER it happens. `shared/` is
 * the seam both `tsconfig.json` and `tsconfig.server.json` compile, so the
 * declaration lives there and divergence is not expressible.
 *
 * DYNAMIC DISCOVERY: this test does not know the names it protects. It reads
 * the OWNER's exports and asserts no other file re-declares any of them — an
 * export added to the owner is protected automatically.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as owner from "../../shared/web-ui-defaults.ts";
import { sourceFiles } from "../helpers/source-scan.ts";
import { serverConfig } from "../../server/kernel/config.ts";

import { modulePath } from "../helpers/module-resolver.ts";
const OWNER_PATH = "shared/web-ui-defaults.ts";
const OWNER_SRC = readFileSync(OWNER_PATH, "utf8");
const SCAN_ROOTS = ["src", "server", "shared"] as const;

const FILES = SCAN_ROOTS.flatMap(sourceFiles).filter((f) => f !== OWNER_PATH);

/** Every value the owner exports — discovered from the module, not listed. */
const OWNED = Object.keys(owner);

describe("web-ui defaults — a single declaration", () => {
  test("the owner exports something (the discovery source is real)", () => {
    expect(OWNED.length).toBeGreaterThan(0);
    expect(OWNED, "the graph default table is the thing this guards").toContain(
      "DEFAULT_GRAPH_CONFIG",
    );
  });

  test("NO other file re-declares anything the owner declares", () => {
    const duplicates: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const name of OWNED) {
        // A DECLARATION, not an import or a re-export: `const NAME =`,
        // `function NAME(`, `let NAME =`.
        const declRe = new RegExp(
          `^\\s*(?:export\\s+)?(?:const|let|function)\\s+${name}\\b`,
          "m",
        );
        if (declRe.test(src)) duplicates.push(`${file}: re-declares ${name}`);
      }
    }
    expect(
      duplicates,
      "these are second copies of a declaration owned by " + OWNER_PATH + ":\n" + duplicates.join("\n"),
    ).toEqual([]);
  });

  test("both sides IMPORT the owner (neither has quietly forked)", () => {
    for (const consumer of [modulePath("harness-config.ts"), modulePath("web-ui-config.ts")]) {
      const src = readFileSync(consumer, "utf8");
      expect(src, `${consumer} must import the shared declaration`).toMatch(
        /from\s+"(?:\.\.\/)+shared\/web-ui-defaults(?:\.ts)?"/,
      );
    }
  });

  test("the server accessors project the SHARED reader (no parallel implementation)", async () => {
    const harnessSrc = readFileSync(modulePath("harness-config.ts"), "utf8");
    expect(harnessSrc).toMatch(/getGraphConfig\(\)[^{]*\{\s*return readGraphConfig\(/);
    expect(harnessSrc).toMatch(/getMetricsConfig\(\)[^{]*\{\s*return readMetricsConfig\(/);
  });

  test("server and client agree by CONSTRUCTION, not by coincidence", async () => {
    const { getGraphConfig, getMetricsConfig } = await import("../../server/kernel/harness-config.ts");
    const { readGraphConfig, readMetricsConfig } = await import("../../src/state/web-ui-config.ts");
    // Same defaults for an absent section…
    expect(readGraphConfig(null)).toEqual(owner.DEFAULT_GRAPH_CONFIG);
    expect(readMetricsConfig(null)).toEqual(owner.DEFAULT_METRICS_CONFIG);
    // …and the server's accessor is the same function applied to the file.
    const raw = JSON.parse(readFileSync(serverConfig.harnessConfigPath, "utf8")) as Record<string, unknown>;
    expect(getGraphConfig()).toEqual(readGraphConfig(raw));
    expect(getMetricsConfig()).toEqual(readMetricsConfig(raw));
  });

  test("the artifact sandbox default is declared once and is safe", () => {
    expect(owner.DEFAULT_ARTIFACT_SANDBOX).not.toContain("allow-same-origin");
    // The literal must not be re-spelled by either consumer.
    for (const consumer of [modulePath("harness-config.ts"), modulePath("web-ui-config.ts")]) {
      const src = readFileSync(consumer, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const literal = new RegExp(`["']${owner.DEFAULT_ARTIFACT_SANDBOX}["']`);
      expect(literal.test(src), `${consumer} must use DEFAULT_ARTIFACT_SANDBOX, not the literal`).toBe(
        false,
      );
    }
  });

  test("the owner itself declares the table only once", () => {
    const declarations = [...OWNER_SRC.matchAll(/^export const DEFAULT_GRAPH_CONFIG\b/gm)];
    expect(declarations).toHaveLength(1);
  });
});
