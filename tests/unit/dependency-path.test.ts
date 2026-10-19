// @vitest-environment node
/**
 * Dependency-path (`code.path` load-path analysis) — adversarial tests.
 *
 * Exercises `computeDependencyPath` (the pure core behind the bridge's
 * `getDependencyPath`) against graphs built by the REAL harness
 * `buildDependencyGraph`, plus one end-to-end pass over a real indexed
 * project directory via the REAL `generateRepositoryMap` — no mocked graph
 * shapes anywhere.
 *
 * Invariants guarded (each by a distinct test):
 * - "no path" is a first-class ANSWER: connected:false + plain-language
 *   summary, never a throw and never a blank/empty-only payload;
 * - direction is explicit and the reverse direction is genuinely searched;
 * - every hop carries the import specifier as written in the source;
 * - a file missing from the index is reported as "not indexed", NOT as a
 *   confidently-wrong "no path";
 * - the basis caveat (dynamic imports / unresolved specifiers excluded) is
 *   carried in the result shape, and the graph really does drop those.
 */
import { describe, test, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { createTempDir } from "../helpers/temp-dir.ts";
import { join } from "node:path";

import { computeDependencyPath } from "../../server/intelligence/intelligence-bridge.ts";
import { buildDependencyGraph } from "../../engine/src/intelligence/dependency-graph.ts";
import { generateRepositoryMap } from "../../engine/src/intelligence/repository-map.ts";
import type {
  ModuleInfo,
  RepositoryMap,
  ImportInfo,
} from "../../engine/src/intelligence/intelligence-types.ts";

// ── Fixture builders (same pattern as codebase-file-retrieval.test.ts) ──

function imp(specifier: string, kind: ImportInfo["kind"] = "direct-import"): ImportInfo {
  return Object.freeze({ specifier, kind, importedNames: Object.freeze(["x"]), resolvedPath: null });
}

function mod(path: string, imports: readonly ImportInfo[] = []): ModuleInfo {
  return Object.freeze({
    path,
    contentHash: "",
    lineCount: 10,
    symbols: Object.freeze([]),
    imports: Object.freeze(imports),
    exports: Object.freeze([]),
    architectureModuleId: null,
    architectureLayer: null,
    architectureRealm: null,
    architectureOwner: null,
  });
}

function buildMap(modules: readonly ModuleInfo[]): RepositoryMap {
  return Object.freeze({
    schemaVersion: "bridlewise-intelligence/v1",
    rootPath: ".",
    generatedAt: new Date(0).toISOString(),
    files: Object.freeze(
      modules.map((m) =>
        Object.freeze({
          path: m.path,
          extension: ".ts",
          sizeBytes: 0,
          contentHash: "",
          lineCount: m.lineCount,
          isSource: true,
        }),
      ),
    ),
    modules: Object.freeze(modules),
    totalSymbols: 0,
    totalDependencies: modules.reduce((n, m) => n + m.imports.length, 0),
    mapHash: "",
  });
}

function pathFor(modules: readonly ModuleInfo[], from: string, to: string) {
  const map = buildMap(modules);
  const graph = buildDependencyGraph(map);
  const known = new Set(modules.map((m) => m.path));
  return computeDependencyPath(graph, known, from, to);
}

describe("computeDependencyPath — synthetic graphs through the real builder", () => {
  test("direct forward import: one hop carrying the specifier as written", () => {
    const result = pathFor([mod("a.ts", [imp("./b")]), mod("b.ts")], "a.ts", "b.ts");
    expect(result.connected).toBe(true);
    expect(result.direction).toBe("forward");
    expect(result.hops).toEqual([{ importer: "a.ts", imported: "b.ts", specifier: "./b" }]);
    expect(result.summary).toContain("a.ts imports b.ts directly");
    expect(result.inIndex).toEqual({ from: true, to: true });
  });

  test("multi-hop: BFS returns the SHORTEST chain when a longer one also exists", () => {
    const modules = [
      mod("a.ts", [imp("./b"), imp("./d")]),
      mod("b.ts", [imp("./c")]),
      mod("c.ts"),
      // Longer alternative a → d → e → c must lose to a → b → c.
      mod("d.ts", [imp("./e")]),
      mod("e.ts", [imp("./c")]),
    ];
    const result = pathFor(modules, "a.ts", "c.ts");
    expect(result.direction).toBe("forward");
    expect(result.hops).toEqual([
      { importer: "a.ts", imported: "b.ts", specifier: "./b" },
      { importer: "b.ts", imported: "c.ts", specifier: "./c" },
    ]);
    expect(result.summary).toContain("2 import steps");
  });

  test("reverse-only connection is found and labeled, hops stay in import direction", () => {
    const modules = [mod("a.ts", [imp("./b")]), mod("b.ts", [imp("./c")]), mod("c.ts")];
    // Asked c → a, but the imports run a → b → c.
    const result = pathFor(modules, "c.ts", "a.ts");
    expect(result.connected).toBe(true);
    expect(result.direction).toBe("reverse");
    // Hops start at the IMPORTER (a.ts, the `to` argument) — import direction.
    expect(result.hops).toEqual([
      { importer: "a.ts", imported: "b.ts", specifier: "./b" },
      { importer: "b.ts", imported: "c.ts", specifier: "./c" },
    ]);
    expect(result.summary).toContain("the other way");
    expect(result.summary).toContain("a.ts depends on c.ts");
  });

  test("no path in either direction: a plain-language answer, never a throw or blank", () => {
    const modules = [mod("a.ts", [imp("./b")]), mod("b.ts"), mod("island.ts")];
    const result = pathFor(modules, "a.ts", "island.ts");
    expect(result.connected).toBe(false);
    expect(result.direction).toBeNull();
    expect(result.hops).toEqual([]);
    // The summary must be renderable prose, not empty.
    expect(result.summary).toBe(
      "Nothing connects these two files through imports, in either direction.",
    );
    // Both files ARE indexed — this is a genuine no-path, not a bad query.
    expect(result.inIndex).toEqual({ from: true, to: true });
  });

  test("file not in the index is 'not indexed', NOT a confidently-wrong 'no path'", () => {
    const result = pathFor([mod("a.ts")], "a.ts", "typo.ts");
    expect(result.connected).toBe(false);
    expect(result.direction).toBeNull();
    expect(result.inIndex).toEqual({ from: true, to: false });
    expect(result.summary).toContain("typo.ts");
    expect(result.summary).toContain("not in the code index");
    // It must NOT read as a verdict about the code's structure.
    expect(result.summary).not.toContain("Nothing connects");
  });

  test("both files unknown: both named in the answer", () => {
    const result = pathFor([mod("a.ts")], "x.ts", "y.ts");
    expect(result.inIndex).toEqual({ from: false, to: false });
    expect(result.summary).toContain("x.ts and y.ts");
    expect(result.summary).toContain("are not in the code index");
  });

  test("same file: its own labeled answer, zero hops", () => {
    const result = pathFor([mod("a.ts")], "a.ts", "a.ts");
    expect(result.connected).toBe(true);
    expect(result.direction).toBe("same-file");
    expect(result.hops).toEqual([]);
    expect(result.summary).toContain("same file");
  });

  test("a connection that exists ONLY through a dynamic import is not found — and the basis says why", () => {
    const modules = [mod("a.ts", [imp("./b", "dynamic-import")]), mod("b.ts")];
    const result = pathFor(modules, "a.ts", "b.ts");
    expect(result.connected).toBe(false);
    // The caveat travels IN the shape, so a UI cannot render "no path" as
    // certainty without also having the limitation available.
    expect(result.basis).toContain("Dynamic imports");
    expect(result.basis).toContain("could not be resolved");
  });

  test("an unresolvable specifier produces no edge — no fabricated hop", () => {
    const modules = [mod("a.ts", [imp("./deleted-file")]), mod("b.ts")];
    const result = pathFor(modules, "a.ts", "b.ts");
    expect(result.connected).toBe(false);
    expect(result.hops).toEqual([]);
  });

  test("isolated modules (zero imports anywhere) are still IN the index — the answer is no-path, not not-indexed", () => {
    const result = pathFor([mod("a.ts"), mod("b.ts")], "a.ts", "b.ts");
    expect(result.inIndex).toEqual({ from: true, to: true });
    expect(result.summary).toContain("Nothing connects");
  });

  test("two import statements resolving to the same file: the hop reports the first as written, never a merged fiction", () => {
    const modules = [mod("a.ts", [imp("./b"), imp("./b.ts")]), mod("b.ts")];
    const result = pathFor(modules, "a.ts", "b.ts");
    expect(result.hops).toHaveLength(1);
    // One representative specifier, taken from the actual import list.
    expect(["./b", "./b.ts"]).toContain(result.hops[0]!.specifier);
    expect(result.hops[0]!.specifier).toBe("./b");
  });

  test("cyclic graphs terminate and answer correctly in both directions", () => {
    const modules = [mod("a.ts", [imp("./b")]), mod("b.ts", [imp("./a")]), mod("c.ts")];
    expect(pathFor(modules, "a.ts", "b.ts").direction).toBe("forward");
    expect(pathFor(modules, "b.ts", "a.ts").direction).toBe("forward");
    expect(pathFor(modules, "a.ts", "c.ts").connected).toBe(false);
  });
});

describe("computeDependencyPath — real indexed project (generateRepositoryMap end to end)", () => {
  test("forward chain, reverse query, and honest no-path over files on disk", () => {
    const root = createTempDir("dep-path-real");
    try {
      mkdirSync(join(root, "src", "lib"), { recursive: true });
      writeFileSync(
        join(root, "src", "app.ts"),
        'import { helper } from "./lib/helper.ts";\nexport const app = helper;\n',
      );
      writeFileSync(
        join(root, "src", "lib", "helper.ts"),
        'import { core } from "../core.ts";\nexport const helper = core;\n',
      );
      writeFileSync(join(root, "src", "core.ts"), "export const core = 1;\n");
      writeFileSync(join(root, "src", "orphan.ts"), "export const alone = true;\n");

      const { map } = generateRepositoryMap(root);
      const graph = buildDependencyGraph(map);
      const known = new Set(map.modules.map((m) => m.path));

      // Forward: app → helper → core, with the specifiers as written.
      const forward = computeDependencyPath(graph, known, "src/app.ts", "src/core.ts");
      expect(forward.connected).toBe(true);
      expect(forward.direction).toBe("forward");
      expect(forward.hops).toEqual([
        { importer: "src/app.ts", imported: "src/lib/helper.ts", specifier: "./lib/helper.ts" },
        { importer: "src/lib/helper.ts", imported: "src/core.ts", specifier: "../core.ts" },
      ]);

      // Reverse query: core → app connects the other way.
      const reverse = computeDependencyPath(graph, known, "src/core.ts", "src/app.ts");
      expect(reverse.connected).toBe(true);
      expect(reverse.direction).toBe("reverse");
      expect(reverse.hops[0]).toEqual({
        importer: "src/app.ts",
        imported: "src/lib/helper.ts",
        specifier: "./lib/helper.ts",
      });

      // Honest no-path against a real orphan file.
      const none = computeDependencyPath(graph, known, "src/app.ts", "src/orphan.ts");
      expect(none.connected).toBe(false);
      expect(none.inIndex).toEqual({ from: true, to: true });
      expect(none.summary).toContain("Nothing connects");
      expect(none.basis.length).toBeGreaterThan(0);
    } finally {
    }
  });
});
