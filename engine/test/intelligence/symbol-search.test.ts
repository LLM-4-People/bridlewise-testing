import assert from "node:assert/strict";
import test from "node:test";

import {
  searchSymbols,
  fuzzyMatch,
  findSymbolUsage,
  searchByKind,
  searchByFile,
  searchByDirectory,
  searchExportedSymbols,
} from "../../src/intelligence/symbol-search.ts";
import {
  createSymbolSearchQuery,
  type ModuleInfo,
  type RepositoryMap,
  type SymbolInfo,
} from "../../src/intelligence/intelligence-types.ts";

function mkSymbol(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    name: overrides.name ?? "foo",
    kind: overrides.kind ?? "function",
    visibility: overrides.visibility ?? "local",
    location: overrides.location ?? { filePath: "src/test.ts", line: 1, column: 1 },
    exported: overrides.exported ?? false,
    async: overrides.async ?? false,
    generator: overrides.generator ?? false,
    parameterCount: overrides.parameterCount ?? 0,
    modifiers: overrides.modifiers ?? [],
  };
}

function mkModule(overrides: Partial<ModuleInfo> = {}): ModuleInfo {
  return {
    path: overrides.path ?? "src/test.ts",
    contentHash: overrides.contentHash ?? "abc123",
    lineCount: overrides.lineCount ?? 10,
    symbols: overrides.symbols ?? [mkSymbol()],
    imports: overrides.imports ?? [],
    exports: overrides.exports ?? [],
    architectureModuleId: overrides.architectureModuleId ?? null,
    architectureLayer: overrides.architectureLayer ?? null,
    architectureRealm: overrides.architectureRealm ?? null,
    architectureOwner: overrides.architectureOwner ?? null,
  };
}

function mkMap(modules: readonly ModuleInfo[]): RepositoryMap {
  return {
    schemaVersion: "bridlewise-intelligence/v1",
    rootPath: ".",
    generatedAt: "2026-07-16T00:00:00.000Z",
    files: modules.map((m) => ({
      path: m.path,
      extension: ".ts" as const,
      sizeBytes: 100,
      contentHash: m.contentHash,
      lineCount: m.lineCount,
      isSource: true,
    })),
    modules,
    totalSymbols: modules.reduce((sum, m) => sum + m.symbols.length, 0),
    totalDependencies: modules.reduce((sum, m) => sum + m.imports.length, 0),
    mapHash: "test-hash",
  };
}

// ========== Fuzzy match ==========

test("symbol-search: fuzzyMatch exact match returns highest score", () => {
  const score = fuzzyMatch("foo", "foo");
  assert.ok(score !== null);
  assert.ok(score! > 0.9);
});

test("symbol-search: fuzzyMatch subsequence match", () => {
  const score = fuzzyMatch("foobar", "fbr");
  assert.ok(score !== null);
  assert.ok(score! > 0);
});

test("symbol-search: fuzzyMatch no match returns null", () => {
  const score = fuzzyMatch("abc", "xyz");
  assert.equal(score, null);
});

test("symbol-search: fuzzyMatch empty query returns 0", () => {
  const score = fuzzyMatch("abc", "");
  assert.equal(score, 0);
});

test("symbol-search: fuzzyMatch query longer than target returns null", () => {
  const score = fuzzyMatch("ab", "abc");
  assert.equal(score, null);
});

test("symbol-search: fuzzyMatch consecutive match scores higher", () => {
  const consecutive = fuzzyMatch("foobar", "foo");
  const scattered = fuzzyMatch("f_o_o_b_a_r".replace(/_/g, ""), "fbr");
  assert.ok(consecutive !== null && scattered !== null);
  assert.ok(consecutive! > scattered!);
});

test("symbol-search: fuzzyMatch leading character match gets bonus", () => {
  const leading = fuzzyMatch("abc", "a");
  const nonLeading = fuzzyMatch("xab", "a");
  assert.ok(leading !== null && nonLeading !== null);
  assert.ok(leading! > nonLeading!);
});

test("symbol-search: fuzzyMatch camelCase boundary match gets bonus", () => {
  const boundary = fuzzyMatch("camelCase", "C");
  assert.ok(boundary !== null);
  assert.ok(boundary! > 0);
});

// ========== Exact search ==========

test("symbol-search: exact name match", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "foo" })] })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ name: "foo", matchMode: "exact" }));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.symbol.name, "foo");
});

test("symbol-search: exact name no match", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "foo" })] })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ name: "bar", matchMode: "exact" }));
  assert.equal(results.length, 0);
});

test("symbol-search: exact name is case-insensitive", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "FooBar" })] })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ name: "foobar", matchMode: "exact" }));
  assert.equal(results.length, 1);
});

// ========== Prefix search ==========

test("symbol-search: prefix match", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "fooBar" })] })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ name: "foo", matchMode: "prefix" }));
  assert.equal(results.length, 1);
});

test("symbol-search: prefix no match", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "fooBar" })] })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ name: "bar", matchMode: "prefix" }));
  assert.equal(results.length, 0);
});

// ========== Contains search ==========

test("symbol-search: contains match", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "myFooFunc" })] })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ name: "Foo", matchMode: "contains" }));
  assert.equal(results.length, 1);
});

test("symbol-search: contains no match", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "myFunc" })] })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ name: "xyz", matchMode: "contains" }));
  assert.equal(results.length, 0);
});

// ========== Fuzzy search ==========

test("symbol-search: fuzzy match", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "parseBuffer" })] })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ name: "pb", matchMode: "fuzzy" }));
  assert.equal(results.length, 1);
});

test("symbol-search: fuzzy no match", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "parseBuffer" })] })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ name: "xyz", matchMode: "fuzzy" }));
  assert.equal(results.length, 0);
});

// ========== Kind filter ==========

test("symbol-search: filter by kind", () => {
  const map = mkMap([mkModule({
    symbols: [
      mkSymbol({ name: "foo", kind: "function" }),
      mkSymbol({ name: "Bar", kind: "class" }),
    ],
  })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ kind: "class" }));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.symbol.kind, "class");
});

test("symbol-search: filter by kind returns all of that kind", () => {
  const map = mkMap([mkModule({
    symbols: [
      mkSymbol({ name: "fn1", kind: "function" }),
      mkSymbol({ name: "fn2", kind: "function" }),
      mkSymbol({ name: "Cls", kind: "class" }),
    ],
  })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ kind: "function" }));
  assert.equal(results.length, 2);
});

// ========== File filter ==========

test("symbol-search: filter by file path", () => {
  const map = mkMap([
    mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "foo", location: { filePath: "src/a.ts", line: 1, column: 1 } })] }),
    mkModule({ path: "src/b.ts", symbols: [mkSymbol({ name: "foo", location: { filePath: "src/b.ts", line: 1, column: 1 } })] }),
  ]);
  const results = searchSymbols(map, createSymbolSearchQuery({ filePath: "src/a.ts" }));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.filePath, "src/a.ts");
});

// ========== Directory filter ==========

test("symbol-search: filter by directory", () => {
  const map = mkMap([
    mkModule({ path: "src/a/foo.ts", symbols: [mkSymbol({ name: "x", location: { filePath: "src/a/foo.ts", line: 1, column: 1 } })] }),
    mkModule({ path: "src/b/bar.ts", symbols: [mkSymbol({ name: "y", location: { filePath: "src/b/bar.ts", line: 1, column: 1 } })] }),
  ]);
  const results = searchSymbols(map, createSymbolSearchQuery({ directory: "src/a" }));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.filePath, "src/a/foo.ts");
});

// ========== Exported filter ==========

test("symbol-search: filter exported only", () => {
  const map = mkMap([mkModule({
    symbols: [
      mkSymbol({ name: "pub", exported: true }),
      mkSymbol({ name: "priv", exported: false }),
    ],
  })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ exported: true }));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.symbol.name, "pub");
});

// ========== Async filter ==========

test("symbol-search: filter async only", () => {
  const map = mkMap([mkModule({
    symbols: [
      mkSymbol({ name: "asyncFn", async: true }),
      mkSymbol({ name: "syncFn", async: false }),
    ],
  })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ async: true }));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.symbol.name, "asyncFn");
});

// ========== Limit ==========

test("symbol-search: respects limit", () => {
  const map = mkMap([mkModule({
    symbols: Array.from({ length: 10 }, (_, i) => mkSymbol({ name: `fn${i}` })),
  })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ limit: 5 }));
  assert.equal(results.length, 5);
});

test("symbol-search: default limit is 50", () => {
  const map = mkMap([mkModule({
    symbols: Array.from({ length: 60 }, (_, i) => mkSymbol({ name: `fn${i}` })),
  })]);
  const results = searchSymbols(map, createSymbolSearchQuery({}));
  assert.equal(results.length, 50);
});

// ========== Combined filters ==========

test("symbol-search: combined name and kind filter", () => {
  const map = mkMap([mkModule({
    symbols: [
      mkSymbol({ name: "foo", kind: "function" }),
      mkSymbol({ name: "foo", kind: "class" }),
    ],
  })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ name: "foo", kind: "function", matchMode: "exact" }));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.symbol.kind, "function");
});

test("symbol-search: combined name and file filter", () => {
  const map = mkMap([
    mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "foo", location: { filePath: "src/a.ts", line: 1, column: 1 } })] }),
    mkModule({ path: "src/b.ts", symbols: [mkSymbol({ name: "foo", location: { filePath: "src/b.ts", line: 1, column: 1 } })] }),
  ]);
  const results = searchSymbols(map, createSymbolSearchQuery({ name: "foo", filePath: "src/b.ts", matchMode: "exact" }));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.filePath, "src/b.ts");
});

// ========== Sorting ==========

test("symbol-search: results sorted by score descending", () => {
  const map = mkMap([mkModule({
    symbols: [
      mkSymbol({ name: "foobar" }),
      mkSymbol({ name: "foo" }),
    ],
  })]);
  const results = searchSymbols(map, createSymbolSearchQuery({ name: "foo", matchMode: "prefix" }));
  assert.equal(results.length, 2);
  assert.ok(results[0]!.score >= results[1]!.score);
});

// ========== Usage search ==========

test("symbol-search: find usage by import", () => {
  const map = mkMap([
    mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "foo", exported: true })] }),
    mkModule({ path: "src/b.ts", imports: [{ specifier: "./a.ts", kind: "direct-import", importedNames: ["foo"], resolvedPath: null }] }),
  ]);
  const usage = findSymbolUsage(map, "foo");
  assert.equal(usage.importers.length, 1);
  assert.equal(usage.importers[0]!.filePath, "src/b.ts");
});

test("symbol-search: find usage with no importers", () => {
  const map = mkMap([mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "foo" })] })]);
  const usage = findSymbolUsage(map, "foo");
  assert.equal(usage.importers.length, 0);
});

test("symbol-search: find usage is case-insensitive", () => {
  const map = mkMap([
    mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "Foo", exported: true })] }),
    mkModule({ path: "src/b.ts", imports: [{ specifier: "./a.ts", kind: "direct-import", importedNames: ["Foo"], resolvedPath: null }] }),
  ]);
  const usage = findSymbolUsage(map, "foo");
  assert.equal(usage.importers.length, 1);
});

// ========== Helper functions ==========

test("symbol-search: searchByKind helper", () => {
  const map = mkMap([mkModule({
    symbols: [
      mkSymbol({ name: "fn1", kind: "function" }),
      mkSymbol({ name: "Cls", kind: "class" }),
    ],
  })]);
  const results = searchByKind(map, "class");
  assert.equal(results.length, 1);
});

test("symbol-search: searchByFile helper", () => {
  const map = mkMap([
    mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "x" })] }),
    mkModule({ path: "src/b.ts", symbols: [mkSymbol({ name: "y" })] }),
  ]);
  const results = searchByFile(map, "src/a.ts");
  assert.equal(results.length, 1);
});

test("symbol-search: searchByDirectory helper", () => {
  const map = mkMap([
    mkModule({ path: "src/a/foo.ts", symbols: [mkSymbol({ name: "x" })] }),
    mkModule({ path: "src/b/bar.ts", symbols: [mkSymbol({ name: "y" })] }),
  ]);
  const results = searchByDirectory(map, "src/a");
  assert.equal(results.length, 1);
});

test("symbol-search: searchExportedSymbols helper", () => {
  const map = mkMap([mkModule({
    symbols: [
      mkSymbol({ name: "pub", exported: true }),
      mkSymbol({ name: "priv", exported: false }),
    ],
  })]);
  const results = searchExportedSymbols(map);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.symbol.name, "pub");
});

// ========== Edge cases ==========

test("symbol-search: empty query returns all symbols", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "a" }), mkSymbol({ name: "b" })] })]);
  const results = searchSymbols(map, createSymbolSearchQuery({}));
  assert.equal(results.length, 2);
});

test("symbol-search: empty map returns no results", () => {
  const map = mkMap([]);
  const results = searchSymbols(map, createSymbolSearchQuery({ name: "foo", matchMode: "exact" }));
  assert.equal(results.length, 0);
});

test("symbol-search: invalid matchMode throws", () => {
  assert.throws(() => createSymbolSearchQuery({ matchMode: "invalid" as "exact" }));
});

test("symbol-search: limit 0 throws", () => {
  assert.throws(() => createSymbolSearchQuery({ limit: 0 }));
});

test("symbol-search: negative limit throws", () => {
  assert.throws(() => createSymbolSearchQuery({ limit: -1 }));
});

test("symbol-search: NaN limit throws", () => {
  assert.throws(() => createSymbolSearchQuery({ limit: NaN }));
});

test("symbol-search: Infinity limit throws", () => {
  assert.throws(() => createSymbolSearchQuery({ limit: Infinity }));
});
