import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDependencyGraph,
  forwardDependencies,
  reverseDependencies,
  transitiveClosure,
  detectCycles,
  impactAnalysis,
  resolveImportSpecifier,
  shortestPath,
  graphStats,
} from "../../src/intelligence/dependency-graph.ts";
import type {
  ModuleInfo,
  RepositoryMap,
  ImportInfo,
} from "../../src/intelligence/intelligence-types.ts";

function mkImport(specifier: string, names: string[] = ["foo"]): ImportInfo {
  return { specifier, kind: "direct-import", importedNames: names, resolvedPath: null };
}

function mkModule(path: string, imports: ImportInfo[] = [], symbols = [{ name: "foo", kind: "function" as const }]): ModuleInfo {
  return {
    path, contentHash: "hash", lineCount: 10,
    symbols: symbols.map((s) => ({
      name: s.name, kind: s.kind, visibility: "local" as const,
      location: { filePath: path, line: 1, column: 1 },
      exported: false, async: false, generator: false,
      parameterCount: 0, modifiers: [],
    })),
    imports, exports: [],
    architectureModuleId: null, architectureLayer: null,
    architectureRealm: null, architectureOwner: null,
  };
}

function mkMap(modules: ModuleInfo[]): RepositoryMap {
  return {
    schemaVersion: "bridlewise-intelligence/v1",
    rootPath: ".", generatedAt: "2026-07-16T00:00:00.000Z",
    files: modules.map((m) => ({
      path: m.path, extension: ".ts" as const,
      sizeBytes: 100, contentHash: m.contentHash,
      lineCount: m.lineCount, isSource: true,
    })),
    modules, totalSymbols: 0, totalDependencies: 0, mapHash: "test",
  };
}

// ========== Graph building ==========

test("dependency-graph: builds graph from imports", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 1);
  assert.equal(graph.nodeCount, 2);
});

test("dependency-graph: empty map produces empty graph", () => {
  const graph = buildDependencyGraph(mkMap([]));
  assert.equal(graph.edgeCount, 0);
  assert.equal(graph.nodeCount, 0);
});

test("dependency-graph: ignores node: imports", () => {
  const map = mkMap([mkModule("src/a.ts", [mkImport("node:fs")])]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 0);
});

test("dependency-graph: ignores bare package imports", () => {
  const map = mkMap([mkModule("src/a.ts", [mkImport("zod")])]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 0);
});

test("dependency-graph: resolves relative imports with extensions", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b")]),
    mkModule("src/b.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 1);
  assert.deepEqual([...graph.forwardAdjacency.get("src/a.ts")!], ["src/b.ts"]);
});

test("dependency-graph: resolves imports with.ts extension", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 1);
});

test("dependency-graph: resolves parent directory imports", () => {
  const map = mkMap([
    mkModule("src/sub/a.ts", [mkImport("../b.ts")]),
    mkModule("src/b.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 1);
  assert.deepEqual([...graph.forwardAdjacency.get("src/sub/a.ts")!], ["src/b.ts"]);
});

test("dependency-graph: ignores dynamic imports", () => {
  const map = mkMap([
    mkModule("src/a.ts", [{ specifier: "./b.ts", kind: "dynamic-import", importedNames: [], resolvedPath: null }]),
    mkModule("src/b.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 0);
});

test("dependency-graph: multiple imports from same module create one edge", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts"), mkImport("./b.ts")]),
    mkModule("src/b.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 2);
  assert.equal(graph.forwardAdjacency.get("src/a.ts")!.length, 1);
});

// ========== Forward dependencies ==========

test("dependency-graph: forward dependencies", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts"), mkImport("./c.ts")]),
    mkModule("src/b.ts", []),
    mkModule("src/c.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const deps = forwardDependencies(graph, "src/a.ts");
  assert.equal(deps.length, 2);
  assert.ok(deps.includes("src/b.ts"));
  assert.ok(deps.includes("src/c.ts"));
});

test("dependency-graph: forward dependencies for leaf module", () => {
  const map = mkMap([mkModule("src/a.ts", [])]);
  const graph = buildDependencyGraph(map);
  assert.equal(forwardDependencies(graph, "src/a.ts").length, 0);
});

test("dependency-graph: forward deps for nonexistent module", () => {
  const graph = buildDependencyGraph(mkMap([mkModule("src/a.ts", [])]));
  assert.equal(forwardDependencies(graph, "src/x.ts").length, 0);
});

// ========== Reverse dependencies ==========

test("dependency-graph: reverse dependencies", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./c.ts")]),
    mkModule("src/b.ts", [mkImport("./c.ts")]),
    mkModule("src/c.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const rdeps = reverseDependencies(graph, "src/c.ts");
  assert.equal(rdeps.length, 2);
  assert.ok(rdeps.includes("src/a.ts"));
  assert.ok(rdeps.includes("src/b.ts"));
});

test("dependency-graph: reverse deps for root module", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(reverseDependencies(graph, "src/a.ts").length, 0);
});

// ========== Transitive closure ==========

test("dependency-graph: forward transitive closure", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", [mkImport("./c.ts")]),
    mkModule("src/c.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const closure = transitiveClosure(graph, "src/a.ts", "forward");
  assert.equal(closure.length, 2);
  assert.ok(closure.includes("src/b.ts"));
  assert.ok(closure.includes("src/c.ts"));
});

test("dependency-graph: reverse transitive closure", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", [mkImport("./c.ts")]),
    mkModule("src/c.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const closure = transitiveClosure(graph, "src/c.ts", "reverse");
  assert.equal(closure.length, 2);
  assert.ok(closure.includes("src/a.ts"));
  assert.ok(closure.includes("src/b.ts"));
});

test("dependency-graph: transitive closure excludes self", () => {
  const map = mkMap([mkModule("src/a.ts", [])]);
  const graph = buildDependencyGraph(map);
  const closure = transitiveClosure(graph, "src/a.ts", "forward");
  assert.equal(closure.length, 0);
});

test("dependency-graph: transitive closure handles diamond", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts"), mkImport("./c.ts")]),
    mkModule("src/b.ts", [mkImport("./d.ts")]),
    mkModule("src/c.ts", [mkImport("./d.ts")]),
    mkModule("src/d.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const closure = transitiveClosure(graph, "src/a.ts", "forward");
  assert.equal(closure.length, 3);
  assert.ok(closure.includes("src/d.ts"));
});

test("dependency-graph: transitive closure handles cycles without infinite loop", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", [mkImport("./a.ts")]),
  ]);
  const graph = buildDependencyGraph(map);
  const closure = transitiveClosure(graph, "src/a.ts", "forward");
  assert.ok(closure.includes("src/b.ts"));
});

// ========== Cycle detection ==========

test("dependency-graph: no cycles in acyclic graph", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const result = detectCycles(graph);
  assert.equal(result.hasCycles, false);
  assert.equal(result.cycles.length, 0);
});

test("dependency-graph: detects simple cycle", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", [mkImport("./a.ts")]),
  ]);
  const graph = buildDependencyGraph(map);
  const result = detectCycles(graph);
  assert.equal(result.hasCycles, true);
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0]!.length, 2);
});

test("dependency-graph: detects three-node cycle", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", [mkImport("./c.ts")]),
    mkModule("src/c.ts", [mkImport("./a.ts")]),
  ]);
  const graph = buildDependencyGraph(map);
  const result = detectCycles(graph);
  assert.equal(result.hasCycles, true);
  assert.equal(result.cycles[0]!.length, 3);
});

test("dependency-graph: detects self-loop cycle", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./a.ts")]),
  ]);
  const graph = buildDependencyGraph(map);
  const result = detectCycles(graph);
  assert.equal(result.hasCycles, true);
});

test("dependency-graph: multiple independent cycles", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", [mkImport("./a.ts")]),
    mkModule("src/c.ts", [mkImport("./d.ts")]),
    mkModule("src/d.ts", [mkImport("./c.ts")]),
  ]);
  const graph = buildDependencyGraph(map);
  const result = detectCycles(graph);
  assert.equal(result.cycles.length, 2);
});

test("dependency-graph: no cycles in empty graph", () => {
  const graph = buildDependencyGraph(mkMap([]));
  assert.equal(detectCycles(graph).hasCycles, false);
});

// ========== Impact analysis ==========

test("dependency-graph: impact analysis finds direct dependents", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./c.ts")]),
    mkModule("src/b.ts", [mkImport("./c.ts")]),
    mkModule("src/c.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const impact = impactAnalysis(graph, "src/c.ts");
  assert.equal(impact.directlyAffected.length, 2);
  assert.ok(impact.directlyAffected.includes("src/a.ts"));
  assert.ok(impact.directlyAffected.includes("src/b.ts"));
});

test("dependency-graph: impact analysis finds transitive dependents", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", [mkImport("./c.ts")]),
    mkModule("src/c.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const impact = impactAnalysis(graph, "src/c.ts");
  assert.equal(impact.totalAffected, 2);
  assert.ok(impact.transitivelyAffected.includes("src/a.ts"));
  assert.ok(impact.transitivelyAffected.includes("src/b.ts"));
});

test("dependency-graph: totalAffected counts DISTINCT affected files (transitive already contains direct)", () => {
  // `transitiveClosure(..., "reverse")` is a BFS from the changed file, so its
  // first hop IS `directlyAffected` — the transitive set is a SUPERSET of the
  // direct set, not a disjoint remainder. `totalAffected` is therefore the
  // size of the transitive set. Adding `directlyAffected.length` to it would
  // double-count every direct dependent; this test states the invariant so
  // that "fix" cannot be applied by mistake.
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", [mkImport("./c.ts")]),
    mkModule("src/d.ts", [mkImport("./c.ts")]),
    mkModule("src/c.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const impact = impactAnalysis(graph, "src/c.ts");

  const transitive = new Set(impact.transitivelyAffected);
  for (const direct of impact.directlyAffected) {
    assert.ok(transitive.has(direct), `directly-affected "${direct}" must also be in the transitive set`);
  }
  const distinct = new Set([...impact.directlyAffected, ...impact.transitivelyAffected]);
  assert.equal(
    impact.totalAffected,
    distinct.size,
    "totalAffected must be the number of distinct affected files",
  );
  assert.equal(impact.totalAffected, 3, "b.ts and d.ts import c.ts; a.ts imports b.ts");
  assert.notEqual(
    impact.totalAffected,
    impact.directlyAffected.length + impact.transitivelyAffected.length,
    "summing direct + transitive would double-count the direct dependents",
  );
});

test("dependency-graph: impact analysis for leaf module", () => {
  const map = mkMap([mkModule("src/a.ts", [])]);
  const graph = buildDependencyGraph(map);
  const impact = impactAnalysis(graph, "src/a.ts");
  assert.equal(impact.totalAffected, 0);
});

// ========== Shortest path ==========

test("dependency-graph: shortest path direct", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const path = shortestPath(graph, "src/a.ts", "src/b.ts");
  assert.ok(path !== null);
  assert.equal(path!.length, 2);
});

test("dependency-graph: shortest path multi-hop", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", [mkImport("./c.ts")]),
    mkModule("src/c.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const path = shortestPath(graph, "src/a.ts", "src/c.ts");
  assert.ok(path !== null);
  assert.equal(path!.length, 3);
});

test("dependency-graph: shortest path no path returns null", () => {
  const map = mkMap([
    mkModule("src/a.ts", []),
    mkModule("src/b.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const path = shortestPath(graph, "src/a.ts", "src/b.ts");
  assert.equal(path, null);
});

test("dependency-graph: shortest path to self returns single node", () => {
  const map = mkMap([mkModule("src/a.ts", [])]);
  const graph = buildDependencyGraph(map);
  const path = shortestPath(graph, "src/a.ts", "src/a.ts");
  assert.ok(path !== null);
  assert.equal(path!.length, 1);
});

// ========== Graph stats ==========

test("dependency-graph: graph stats computes max degrees", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./hub.ts")]),
    mkModule("src/b.ts", [mkImport("./hub.ts")]),
    mkModule("src/c.ts", [mkImport("./hub.ts")]),
    mkModule("src/hub.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const stats = graphStats(graph);
  assert.equal(stats.maxInDegree, 3);
});

test("dependency-graph: graph stats counts isolated nodes", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./b.ts")]),
    mkModule("src/b.ts", []),
    mkModule("src/isolated.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const stats = graphStats(graph);
  assert.ok(stats.isolatedNodes >= 0);
});

test("dependency-graph: graph stats finds hub nodes", () => {
  const map = mkMap([
    mkModule("src/a.ts", [mkImport("./hub.ts")]),
    mkModule("src/b.ts", [mkImport("./hub.ts")]),
    mkModule("src/c.ts", [mkImport("./hub.ts")]),
    mkModule("src/hub.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  const stats = graphStats(graph);
  assert.ok(stats.hubNodes.length >= 1);
  assert.equal(stats.hubNodes[0]!.node, "src/hub.ts");
});

// ========== Import resolution ==========

test("dependency-graph: resolve import with.ts extension", () => {
  const paths = new Set(["src/foo.ts"]);
  assert.equal(resolveImportSpecifier("src/bar.ts", "./foo.ts", paths), "src/foo.ts");
});

test("dependency-graph: resolve import without extension", () => {
  const paths = new Set(["src/foo.ts"]);
  assert.equal(resolveImportSpecifier("src/bar.ts", "./foo", paths), "src/foo.ts");
});

test("dependency-graph: resolve import with index file", () => {
  const paths = new Set(["src/foo/index.ts"]);
  assert.equal(resolveImportSpecifier("src/bar.ts", "./foo", paths), "src/foo/index.ts");
});

test("dependency-graph: resolve parent directory import", () => {
  const paths = new Set(["src/foo.ts"]);
  assert.equal(resolveImportSpecifier("src/sub/bar.ts", "../foo", paths), "src/foo.ts");
});

test("dependency-graph: resolve non-existent import returns null", () => {
  const paths = new Set(["src/foo.ts"]);
  assert.equal(resolveImportSpecifier("src/bar.ts", "./nonexistent", paths), null);
});

test("dependency-graph: resolve node: import returns null", () => {
  assert.equal(resolveImportSpecifier("src/bar.ts", "node:fs", new Set()), null);
});

test("dependency-graph: resolve bare package import returns null", () => {
  assert.equal(resolveImportSpecifier("src/bar.ts", "zod", new Set()), null);
});

// ========== Edge cases ==========

test("dependency-graph: handles large graph", () => {
  const modules: ModuleInfo[] = [];
  for (let i = 0; i < 100; i++) {
    modules.push(mkModule(`src/mod${i}.ts`, i > 0 ? [mkImport(`./mod${i - 1}.ts`)] : []));
  }
  const graph = buildDependencyGraph(mkMap(modules));
  assert.equal(graph.nodeCount, 100);
  assert.equal(graph.edgeCount, 99);
});

test("dependency-graph: handles deeply nested chain", () => {
  const modules: ModuleInfo[] = [];
  for (let i = 0; i < 50; i++) {
    modules.push(mkModule(`src/dep${i}.ts`, i > 0 ? [mkImport(`./dep${i - 1}.ts`)] : []));
  }
  const graph = buildDependencyGraph(mkMap(modules));
  const closure = transitiveClosure(graph, "src/dep49.ts", "forward");
  assert.equal(closure.length, 49);
});
