import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { generateRepositoryMap, createArchitectureModuleIndex } from "../../src/intelligence/repository-map.ts";
import { searchSymbols, findSymbolUsage, searchExportedSymbols } from "../../src/intelligence/symbol-search.ts";
import { buildDependencyGraph, forwardDependencies, reverseDependencies, detectCycles, impactAnalysis } from "../../src/intelligence/dependency-graph.ts";
import { findReuseCandidates, findDuplicates, suggestCanonicalOwner } from "../../src/intelligence/reuse-discovery.ts";
import { traceValueFlow, findParameterSources } from "../../src/intelligence/data-flow.ts";
import { createSymbolSearchQuery, createReuseQuery } from "../../src/intelligence/intelligence-types.ts";
import { createToolRegistry, type RegisteredTool } from "../../src/runtime/tool-registry.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { initTreeSitterBackend } from "../../src/intelligence/tree-sitter-backend.ts";

await initTreeSitterBackend(["javascript", "typescript"]);

// ========== Integration: full pipeline on a real repo ==========

function createIntegrationRepo(): string {
  const root = createTempDir("intel-int-");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "src", "utils"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"),
    "export function foo() { return 1; }\nexport class Bar { baz() {} }\n");
  writeFileSync(join(root, "src", "b.ts"),
    "import { foo } from './a.ts';\nexport const bar = foo();\n");
  writeFileSync(join(root, "src", "utils", "c.ts"),
    "import { foo } from '../a.ts';\nexport function helper(x: number) { return foo() + x; }\n");
  return root;
}

test("integration: full pipeline generates map and searches", () => {
  const root = createIntegrationRepo();
  try {
    const { map } = generateRepositoryMap(root);
    assert.ok(map.modules.length >= 3);

    const results = searchSymbols(map, createSymbolSearchQuery({ name: "foo", matchMode: "exact" }));
    assert.ok(results.length >= 1);
    assert.equal(results[0]!.symbol.name, "foo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: map → dependency graph → impact analysis", () => {
  const root = createIntegrationRepo();
  try {
    const { map } = generateRepositoryMap(root);
    const graph = buildDependencyGraph(map);
    const aPath = map.modules.find((m) => m.path.includes("a.ts"))!.path;
    const impact = impactAnalysis(graph, aPath);
    assert.ok(impact.totalAffected >= 2);
    assert.ok(impact.directlyAffected.some((p) => p.includes("b.ts")));
    assert.ok(impact.directlyAffected.some((p) => p.includes("c.ts")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: map → reuse discovery → find duplicates", () => {
  const root = createIntegrationRepo();
  try {
    const { map } = generateRepositoryMap(root);
    const candidates = findReuseCandidates(map, createReuseQuery({ name: "foo" }));
    assert.ok(candidates.length >= 1);
    const dups = findDuplicates(map);
    assert.ok(Array.isArray(dups));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: map → data flow → trace value", () => {
  const root = createIntegrationRepo();
  try {
    const { map } = generateRepositoryMap(root);
    const result = traceValueFlow(map, "foo");
    assert.ok(result.rootSymbol !== null);
    assert.ok(result.consumers.length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: map → cycles → no false cycles", () => {
  const root = createIntegrationRepo();
  try {
    const { map } = generateRepositoryMap(root);
    const graph = buildDependencyGraph(map);
    const result = detectCycles(graph);
    assert.equal(result.hasCycles, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: map → architecture index → metadata attached", () => {
  const root = createIntegrationRepo();
  try {
    const archIndex = createArchitectureModuleIndex([
      { path: "src/a.ts", id: "mod-a", layer: "domain", realm: "shared", owner: "test", dependencies: [] },
    ]);
    const { map } = generateRepositoryMap(root, { architectureIndex: archIndex });
    const modA = map.modules.find((m) => m.path === "src/a.ts");
    assert.ok(modA);
    assert.equal(modA!.architectureModuleId, "mod-a");
    assert.equal(modA!.architectureLayer, "domain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: search exported symbols across modules", () => {
  const root = createIntegrationRepo();
  try {
    const { map } = generateRepositoryMap(root);
    const exported = searchExportedSymbols(map, "foo");
    assert.ok(exported.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: find usage chains through imports", () => {
  const root = createIntegrationRepo();
  try {
    const { map } = generateRepositoryMap(root);
    const usage = findSymbolUsage(map, "foo");
    assert.ok(usage.importers.length >= 2);
    assert.ok(usage.importers.some((i) => i.filePath.includes("b.ts")));
    assert.ok(usage.importers.some((i) => i.filePath.includes("c.ts")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: forward and reverse deps are consistent", () => {
  const root = createIntegrationRepo();
  try {
    const { map } = generateRepositoryMap(root);
    const graph = buildDependencyGraph(map);
    const aPath = map.modules.find((m) => m.path.includes("a.ts"))!.path;
    const bPath = map.modules.find((m) => m.path.includes("b.ts"))!.path;
    const fwd = forwardDependencies(graph, bPath);
    const rev = reverseDependencies(graph, aPath);
    assert.ok(fwd.includes(aPath));
    assert.ok(rev.includes(bPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: suggest canonical owner for concept", () => {
  const root = createIntegrationRepo();
  try {
    const archIndex = createArchitectureModuleIndex([
      { path: "src/a.ts", id: "mod-a", layer: "domain", realm: "shared", owner: "core", dependencies: [] },
    ]);
    const { map } = generateRepositoryMap(root, { architectureIndex: archIndex });
    const suggestion = suggestCanonicalOwner(map, "foo");
    assert.ok(suggestion.candidates.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ========== Tool registry integration ==========

test("integration: intelligence tools can be registered in tool registry", () => {
  const registry = createToolRegistry();
  const searchTool: RegisteredTool = {
    definition: {
      type: "function",
      function: {
        name: "search_symbols",
        description: "Search for symbols in the repository by name, kind, or location.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Symbol name to search for" },
          },
          required: ["name"],
        },
      },
    },
    handler: () => "search results",
  };
  registry.register(searchTool);
  assert.equal(registry.size(), 7);
  assert.ok(registry.names().includes("search_symbols"));
});

test("integration: intelligence tool executes via registry", () => {
  const registry = createToolRegistry();
  const searchTool: RegisteredTool = {
    definition: {
      type: "function",
      function: {
        name: "find_reuse",
        description: "Find reuse candidates.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
    },
    handler: (args) => `reuse candidates for: ${args.name}`,
  };
  registry.register(searchTool);
  const result = registry.execute({
    id: "call-1",
    name: "find_reuse",
    arguments: JSON.stringify({ name: "foo" }),
  }, { repositoryRoot: "." });
  assert.equal(result.isError, false);
  assert.ok(result.content.includes("foo"));
});

test("integration: intelligence tool with invalid arguments returns error", () => {
  const registry = createToolRegistry();
  registry.register({
    definition: {
      type: "function",
      function: {
        name: "dep_graph",
        description: "Query dependency graph.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    },
    handler: () => "ok",
  });
  const result = registry.execute({
    id: "call-1",
    name: "dep_graph",
    arguments: "invalid json",
  }, { repositoryRoot: "." });
  assert.equal(result.isError, true);
});

test("integration: multiple intelligence tools registered", () => {
  const registry = createToolRegistry();
  const tools = [
    { name: "search_symbols", desc: "Search symbols" },
    { name: "find_reuse", desc: "Find reuse" },
    { name: "dep_graph", desc: "Dependency graph" },
    { name: "data_flow", desc: "Data flow analysis" },
  ];
  for (const t of tools) {
    registry.register({
      definition: {
        type: "function",
        function: {
          name: t.name,
          description: t.desc,
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      handler: () => t.desc,
    });
  }
  assert.equal(registry.size(), tools.length + 6);
  for (const t of tools) {
    assert.ok(registry.get(t.name) !== undefined);
  }
});

// ========== End-to-end with real repo structure ==========

test("integration: end-to-end reuse discovery workflow", () => {
  const root = createIntegrationRepo();
  try {
    const { map } = generateRepositoryMap(root);
    const candidates = findReuseCandidates(map, createReuseQuery({ name: "foo", kind: "function" }));
    assert.ok(candidates.length >= 1);
    const usage = findSymbolUsage(map, "foo");
    assert.ok(usage.importers.length >= 1);
    const graph = buildDependencyGraph(map);
    const aPath = map.modules.find((m) => m.path.includes("a.ts"))!.path;
    const impact = impactAnalysis(graph, aPath);
    assert.ok(impact.totalAffected >= 1);
    const params = findParameterSources(map, "helper");
    assert.ok(params.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: deterministic across repeated runs", () => {
  const root = createIntegrationRepo();
  try {
    const a = generateRepositoryMap(root);
    const b = generateRepositoryMap(root);
    assert.equal(a.map.mapHash, b.map.mapHash);
    assert.equal(a.map.modules.length, b.map.modules.length);
    assert.equal(a.map.totalSymbols, b.map.totalSymbols);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: hostile - deeply nested import chain", () => {
  const root = createTempDir("intel-deep-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      const imp = i > 0 ? `import { mod${i - 1} } from './mod${i - 1}.ts';\n` : "";
      writeFileSync(join(root, "src", `mod${i}.ts`), `${imp}export function mod${i}() {}\n`);
    }
    const { map } = generateRepositoryMap(root);
    const graph = buildDependencyGraph(map);
    const cycles = detectCycles(graph);
    assert.equal(cycles.hasCycles, false);
    const closure = impactAnalysis(graph, "src/mod0.ts");
    assert.ok(closure.totalAffected >= 9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: hostile - circular dependency detection", () => {
  const root = createTempDir("intel-cyc-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "import { b } from './b.ts';\nexport function a() { return b(); }\n");
    writeFileSync(join(root, "src", "b.ts"), "import { a } from './a.ts';\nexport function b() { return a(); }\n");
    const { map } = generateRepositoryMap(root);
    const graph = buildDependencyGraph(map);
    const cycles = detectCycles(graph);
    assert.equal(cycles.hasCycles, true);
    assert.equal(cycles.cycles.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: hostile - empty repo", () => {
  const root = createTempDir("intel-empty-");
  try {
    const { map } = generateRepositoryMap(root);
    assert.equal(map.modules.length, 0);
    const graph = buildDependencyGraph(map);
    assert.equal(graph.edgeCount, 0);
    const cycles = detectCycles(graph);
    assert.equal(cycles.hasCycles, false);
    const results = searchSymbols(map, createSymbolSearchQuery({ name: "foo", matchMode: "exact" }));
    assert.equal(results.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: hostile - malformed source files", () => {
  const root = createTempDir("intel-mal-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "broken.ts"), "function {{{ { \nimport { } from \n");
    writeFileSync(join(root, "src", "valid.ts"), "export function foo() {}\n");
    const { map } = generateRepositoryMap(root);
    assert.ok(map.modules.some((m) => m.path === "src/valid.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: hostile - files with special characters in content", () => {
  const root = createTempDir("intel-spec-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), 'export function foo() { return "café naïve résumé"; }\n');
    const { map } = generateRepositoryMap(root);
    assert.ok(map.modules.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: three distinct scenarios - scenario 1 (simple module)", () => {
  const root = createTempDir("intel-s1-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "single.ts"), "export function single() { return 42; }\n");
    const { map } = generateRepositoryMap(root);
    assert.equal(map.modules.length, 1);
    assert.ok(map.modules[0]!.symbols.some((s) => s.name === "single"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: three distinct scenarios - scenario 2 (multi-module with deps)", () => {
  const root = createTempDir("intel-s2-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export function fa() {}\nexport class Ca {}\n");
    writeFileSync(join(root, "src", "b.ts"), "import { fa } from './a.ts';\nexport function fb() { return fa(); }\n");
    writeFileSync(join(root, "src", "c.ts"), "import { Ca } from './a.ts';\nimport { fb } from './b.ts';\nexport const fc = new Ca();\n");
    const { map } = generateRepositoryMap(root);
    assert.equal(map.modules.length, 3);
    const graph = buildDependencyGraph(map);
    const impact = impactAnalysis(graph, "src/a.ts");
    assert.equal(impact.totalAffected, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: three distinct scenarios - scenario 3 (deep nested structure)", () => {
  const root = createTempDir("intel-s3-");
  try {
    mkdirSync(join(root, "src", "a", "b", "c"), { recursive: true });
    writeFileSync(join(root, "src", "a", "b", "c", "deep.ts"), "export function deep() {}\n");
    writeFileSync(join(root, "src", "a", "b", "mid.ts"), "import { deep } from './c/deep.ts';\nexport function mid() { return deep(); }\n");
    writeFileSync(join(root, "src", "a", "top.ts"), "import { mid } from './b/mid.ts';\nexport function top() { return mid(); }\n");
    writeFileSync(join(root, "src", "root.ts"), "import { top } from './a/top.ts';\nexport function root() { return top(); }\n");
    const { map } = generateRepositoryMap(root);
    assert.equal(map.modules.length, 4);
    const graph = buildDependencyGraph(map);
    const path = impactAnalysis(graph, "src/a/b/c/deep.ts");
    assert.ok(path.transitivelyAffected.length >= 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
