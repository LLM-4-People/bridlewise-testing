// @vitest-environment node
/**
 * Adversarial tests for EXP474 codebase-file retrieval (phrase n-gram +
 * slot allocation + package/directory co-occurrence). Exercises the
 * production module directly with synthetic RepositoryMap + DependencyGraph
 * fixtures so every ranking stage is verified in isolation.
 *
 * tests are adversarial (improper usage, unknown results,
 * hard/realistic scenarios), never weakened/faked, and each guards a distinct
 * invariant. typed InputError, never `throw new Error`.
 */
import { describe, test, expect } from "vitest";
import {
  retrieveRelevantFiles,
  importClassCount,
  type Exp474RetrievalOptions,
} from "../../engine/src/intelligence/retrieval.ts";
import { buildDependencyGraph } from "../../engine/src/intelligence/dependency-graph.ts";
import type {
  ModuleInfo,
  RepositoryMap,
  SymbolInfo,
  ImportInfo,
  ExportInfo,
} from "../../engine/src/intelligence/intelligence-types.ts";
import { InputError } from "../../engine/src/kernel/errors.ts";

// The canonical option set (mirrors the config floors in harness-config.ts
// `getExp474RetrievalConfig` — the single owner of these defaults).
const OPTS: Exp474RetrievalOptions = {
  classBoost: 0.15, basenameBoost: 0.1, pathSegBoost: 0.1, phraseBoost: 0.25,
  stage1K: 8, finalK: 15, importSlots: 4, reverseSlots: 1, packageSlots: 2,
  stage1CoreK: 4, phraseMaxFiles: 5, basenameMaxFiles: 3, pathSegMaxFiles: 10,
  minBasenameLength: 4, minPathSegLength: 5, minQueryWordLength: 3,
  packageMinDirHits: 2, importSemanticFloor: 0.3, importClassMultiplier: 0.5,
};

function sym(name: string, kind: SymbolInfo["kind"], line = 1): SymbolInfo {
  return Object.freeze({
    name, kind, visibility: "exported", location: Object.freeze({ filePath: "", line, column: 0 }),
    exported: true, async: false, generator: false, parameterCount: 0, modifiers: Object.freeze([]),
  });
}

function imp(specifier: string, names: readonly string[]): ImportInfo {
  return Object.freeze({ specifier, kind: "direct-import", importedNames: names, resolvedPath: null });
}

function mod(
  path: string,
  symbols: readonly SymbolInfo[],
  imports: readonly ImportInfo[] = [],
): ModuleInfo {
  const exports: ExportInfo[] = symbols
    .filter((s) => s.exported)
    .map((s) => Object.freeze({ name: s.name, kind: "declared" as const, localName: s.name, sourceSpecifier: null }));
  return Object.freeze({
    path, contentHash: "", lineCount: 10, symbols: Object.freeze(symbols),
    imports: Object.freeze(imports), exports: Object.freeze(exports),
    architectureModuleId: null, architectureLayer: null, architectureRealm: null, architectureOwner: null,
  });
}

function buildMap(modules: readonly ModuleInfo[]): RepositoryMap {
  return Object.freeze({
    schemaVersion: "bridlewise-intelligence/v1", rootPath: ".",
    generatedAt: new Date(0).toISOString(),
    files: Object.freeze(modules.map((m) => Object.freeze({
      path: m.path, extension: ".ts", sizeBytes: 0, contentHash: "", lineCount: m.lineCount, isSource: true,
    }))),
    modules: Object.freeze(modules),
    totalSymbols: modules.reduce((n, m) => n + m.symbols.length, 0),
    totalDependencies: modules.reduce((n, m) => n + m.imports.length, 0),
    mapHash: "",
  });
}

describe("exp474 retrieval — adversarial invariants", () => {
  test("empty query throws a typed InputError, not a generic Error", () => {
    const map = buildMap([mod("a.ts", [sym("foo", "function")])]);
    const graph = buildDependencyGraph(map);
    expect(() => retrieveRelevantFiles(map, graph, "", OPTS)).toThrow(InputError);
    expect(() => retrieveRelevantFiles(map, graph, "   ", OPTS)).toThrow(InputError);
    // Non-InputError message check: the thrown error must carry the typed code.
    try {
      retrieveRelevantFiles(map, graph, "", OPTS);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InputError);
      expect((err as InputError).code).toBe("intelligence_exp474_query_missing");
    }
  });

  test("empty map returns an empty result, never throws", () => {
    const map = buildMap([]);
    const graph = buildDependencyGraph(map);
    const result = retrieveRelevantFiles(map, graph, "anything", OPTS);
    expect(result.files).toHaveLength(0);
    expect(result.debug).toContain("empty map");
  });

  test("query matching no symbols returns empty (no stage1 hits)", () => {
    const map = buildMap([mod("a.ts", [sym("parseConfig", "function")])]);
    const graph = buildDependencyGraph(map);
    const result = retrieveRelevantFiles(map, graph, "zzzzznomatch", OPTS);
    expect(result.files).toHaveLength(0);
    expect(result.debug).toContain("no stage1 hits");
  });

  test("phrase n-gram matching: a multi-word query matches symbol n-grams", () => {
    const map = buildMap([
      mod("parse-config.ts", [sym("parseConfig", "function")]),
      mod("unrelated.ts", [sym("computeHash", "function")]),
    ]);
    const graph = buildDependencyGraph(map);
    const result = retrieveRelevantFiles(map, graph, "parse config", OPTS);
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("parse-config.ts");
    expect(paths).not.toContain("unrelated.ts");
  });

  test("language-agnostic: works on snake_case (Python-style) symbol names", () => {
    const map = buildMap([
      mod("basic.py", [sym("evaluate_derivative", "function")]),
      mod("other.py", [sym("print_matrix", "function")]),
    ]);
    const graph = buildDependencyGraph(map);
    const result = retrieveRelevantFiles(map, graph, "evaluate derivative", OPTS);
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("basic.py");
    expect(paths).not.toContain("other.py");
  });

  test("class-name match boosts the defining file", () => {
    const map = buildMap([
      mod("printer.py", [sym("Printer", "class")]),
      mod("other.py", [sym("print_thing", "function")]),
    ]);
    const graph = buildDependencyGraph(map);
    const result = retrieveRelevantFiles(map, graph, "Printer", OPTS);
    const printerHit = result.files.find((f) => f.path === "printer.py");
    expect(printerHit).toBeDefined();
    expect(printerHit!.reasons).toContain("class-name");
  });
});

describe("exp474 retrieval — slot allocation (replaces RRF)", () => {
  // core.ts is the lexical hit; util.ts is imported by core.ts but has a low
  // lexical score. Without slot allocation a pure semantic rank would bury it.
  // Uses.ts because the production dependency-graph resolver
  // (`resolveImportSpecifier`) resolves TS/JS specifiers (the import graph is
  // the dependency graph's responsibility; EXP474's ranking works on any graph).
  const fixture = () => {
    const modules = [
      mod("core.ts", [sym("Parser", "class"), sym("parse_thing", "function")], [imp("./util", ["Helper"])]),
      mod("util.ts", [sym("Helper", "class")]),
      mod("noise.ts", [sym("unrelated_thing", "function")]),
    ];
    const map = buildMap(modules);
    return { map, graph: buildDependencyGraph(map) };
  };

  test("import expansion: a file imported by a stage1-core file appears even with low lexical score", () => {
    const { map, graph } = fixture();
    const result = retrieveRelevantFiles(map, graph, "Parser", OPTS);
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("core.ts");
    expect(paths).toContain("util.ts"); // imported by core.ts
    const utilHit = result.files.find((f) => f.path === "util.ts");
    expect(utilHit?.stage).toBe("import");
    expect(utilHit?.reasons).toContain("import-expansion");
  });

  test("reverse import expansion: a file that imports a stage1-core file appears", () => {
    // caller.ts imports core.ts; core.ts is the lexical hit. caller.ts should
    // surface via reverse-import expansion.
    const modules = [
      mod("core.ts", [sym("doWork", "function")]),
      mod("caller.ts", [sym("main", "function")], [imp("./core", ["doWork"])]),
    ];
    const map = buildMap(modules);
    const graph = buildDependencyGraph(map);
    const result = retrieveRelevantFiles(map, graph, "doWork", OPTS);
    const callerHit = result.files.find((f) => f.path === "caller.ts");
    expect(callerHit).toBeDefined();
    expect(callerHit?.stage).toBe("reverse-import");
  });

  test("package/directory co-occurrence: a dir with 2+ stage1 files qualifies", () => {
    const modules = [
      mod("pkg/alpha.ts", [sym("alphaThing", "function")]),
      mod("pkg/beta.ts", [sym("betaThing", "function")]),
      mod("pkg/gamma.ts", [sym("gammaOther", "function")]), // same dir, no lexical match
      mod("other/iso.ts", [sym("isoThing", "function")]),
    ];
    const map = buildMap(modules);
    const graph = buildDependencyGraph(map);
    // Query matches alpha + beta (2 files in pkg/ → package dir qualifies).
    const result = retrieveRelevantFiles(map, graph, "thing", OPTS);
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("pkg/alpha.ts");
    expect(paths).toContain("pkg/beta.ts");
    // gamma is in pkg/ (co-occurring dir) but has no lexical match (score 0)
    // → package candidates filter on score > 0, so gamma does NOT appear.
    expect(paths).not.toContain("pkg/gamma.ts");
  });

  test("package co-occurrence surfaces a weak-lexical sibling pushed out of stage1", () => {
    // Both strong files index the phrase n-gram "compute hash" (from
    // computeHash / computeHashFast) → phrase boost puts them in stage1.
    // The sibling (hashStore) only shares the word "hash" (word-overlap
    // bonus, NO phrase match, NO fuzzy consecutive match for the spaced
    // query "compute hash") → low score → pushed below stage1K=2, but
    // score > 0 and in pkg/ (2+ stage1 files) → package-cooccurrence slot.
    const modules = [
      mod("pkg/a.ts", [sym("computeHash", "function")]),
      mod("pkg/b.ts", [sym("computeHashFast", "function")]),
      mod("pkg/sibling.ts", [sym("hashStore", "function")]),
      mod("other/iso.ts", [sym("hashIso", "function")]),
    ];
    const map = buildMap(modules);
    const graph = buildDependencyGraph(map);
    const result = retrieveRelevantFiles(map, graph, "compute hash", { ...OPTS, stage1K: 2 });
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("pkg/a.ts");
    expect(paths).toContain("pkg/b.ts");
    const siblingHit = result.files.find((f) => f.path === "pkg/sibling.ts");
    expect(siblingHit).toBeDefined();
    expect(siblingHit?.stage).toBe("package-cooccurrence");
    // iso is in other/ (only 1 stage1 file there) → no package slot.
    expect(paths).not.toContain("other/iso.ts");
  });
});

describe("exp474 retrieval — output invariants", () => {
  test("no file appears twice (dedup across stages)", () => {
    const modules = [
      mod("core.ts", [sym("Parser", "class")], [imp("./util", ["Helper"])]),
      mod("util.ts", [sym("Helper", "class")]),
      mod("caller.ts", [sym("main", "function")], [imp("./core", ["Parser"])]),
    ];
    const map = buildMap(modules);
    const graph = buildDependencyGraph(map);
    const result = retrieveRelevantFiles(map, graph, "Parser", OPTS);
    const paths = result.files.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("finalK cap is respected", () => {
    const modules = [];
    for (let i = 0; i < 40; i++) modules.push(mod(`f${i}.ts`, [sym(`thing${i}`, "function")]));
    const map = buildMap(modules);
    const graph = buildDependencyGraph(map);
    const capped = { ...OPTS, stage1K: 8, finalK: 5 };
    const result = retrieveRelevantFiles(map, graph, "thing", capped);
    expect(result.files.length).toBeLessThanOrEqual(5);
  });

  test("every returned hit has a path, a finite score, and a known stage", () => {
    const modules = [
      mod("core.ts", [sym("Parser", "class")], [imp("./util", ["Helper"])]),
      mod("util.ts", [sym("Helper", "class")]),
    ];
    const map = buildMap(modules);
    const graph = buildDependencyGraph(map);
    const result = retrieveRelevantFiles(map, graph, "Parser", OPTS);
    for (const hit of result.files) {
      expect(typeof hit.path).toBe("string");
      expect(hit.path.length).toBeGreaterThan(0);
      expect(Number.isFinite(hit.score)).toBe(true);
      expect(["stage1", "import", "reverse-import", "package-cooccurrence", "stage1-fill"]).toContain(hit.stage);
      expect(Array.isArray(hit.reasons)).toBe(true);
    }
  });

  test("the result is frozen (immutable) — discovery evidence not mutable", () => {
    const map = buildMap([mod("a.ts", [sym("parseConfig", "function")])]);
    const graph = buildDependencyGraph(map);
    const result = retrieveRelevantFiles(map, graph, "parse config", OPTS);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.files)).toBe(true);
  });

  test("improper usage: non-string query is rejected by the type system + throws at runtime", () => {
    const map = buildMap([mod("a.ts", [sym("foo", "function")])]);
    const graph = buildDependencyGraph(map);
    // Tightened (EHC-7): assert the SPECIFIC typed error (InputError — the
    // module's contract for a missing/invalid query), not "any throw". A
    // loose `.toThrow` would pass on a TypeError from an unrelated
    // refactor, masking the typed-error contract.
    expect(() => retrieveRelevantFiles(map, graph, 42 as unknown as string, OPTS)).toThrow(InputError);
  });
});

describe("exp474 retrieval — class-weighted import expansion (regression guard)", () => {
  // Regression: importClassCount must actually resolve the importer→target
  // edge and count classes. The symbol extractor leaves resolvedPath null,
  // so an earlier version that matched on resolvedPath ALWAYS returned 0 —
  // making the importClassMultiplier config knob inert. This test asserts the
  // count is correct directly (deterministic, no score-ordering fragility).
  test("importClassCount resolves the edge + counts class names (uppercase) vs functions", () => {
    const modules = [
      mod("core.ts", [sym("Parser", "class")], [
        imp("./a", ["MyClass", "OtherClass", "helperFn"]),
        imp("./b", ["helperOne", "helperTwo"]),
      ]),
      mod("a.ts", [sym("MyClass", "class")]),
      mod("b.ts", [sym("helperOne", "function")]),
    ];
    const map = buildMap(modules);
    const knownPaths = new Set(modules.map((m) => m.path));
    const core = modules[0]!;
    //./a imports 2 classes (MyClass, OtherClass) + 1 function → count 2.
    expect(importClassCount(core, "a.ts", knownPaths)).toBe(2);
    //./b imports 2 functions (lowercase) → count 0.
    expect(importClassCount(core, "b.ts", knownPaths)).toBe(0);
    // A path the importer does NOT import → count 0.
    expect(importClassCount(core, "nonexistent.ts", knownPaths)).toBe(0);
  });

  test("importClassCount skips dynamic-import edges", () => {
    const dynamic = Object.freeze({
      specifier: "./a", kind: "dynamic-import" as const,
      importedNames: Object.freeze(["MyClass"]), resolvedPath: null,
    });
    const coreMod = mod("core.ts", [sym("Parser", "class")], [dynamic]);
    const knownPaths = new Set(["core.ts", "a.ts"]);
    expect(importClassCount(coreMod, "a.ts", knownPaths)).toBe(0);
  });

  test("importClassMultiplier amplifies class-heavy import edges in the ranking", () => {
    // coreA imports a (a Class); coreB imports b (a function). Both coreA/coreB
    // match "Parser" equally; a.ts/b.ts have no "Parser" overlap (sem 0). So the
    // ONLY differentiator is the class multiplier. With multiplier 0.5, a.ts's
    // import candidate score (1.5×) outranks b.ts (1.0×) → a.ts ranks FIRST.
    const modules = [
      mod("coreA.ts", [sym("Parser", "class")], [imp("./a", ["MyClass"])]),
      mod("coreB.ts", [sym("Parser", "class")], [imp("./b", ["helperFn"])]),
      mod("a.ts", [sym("MyClass", "class")]),
      mod("b.ts", [sym("helperFn", "function")]),
    ];
    const map = buildMap(modules);
    const graph = buildDependencyGraph(map);
    const result = retrieveRelevantFiles(map, graph, "Parser", OPTS);
    const order = result.files.map((f) => f.path);
    const aIdx = order.indexOf("a.ts");
    const bIdx = order.indexOf("b.ts");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeLessThan(bIdx); // class-heavy edge ranks first
  });
});
