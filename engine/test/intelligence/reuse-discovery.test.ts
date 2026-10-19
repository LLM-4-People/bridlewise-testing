import assert from "node:assert/strict";
import test from "node:test";

import {
  findReuseCandidates,
  findDuplicates,
  suggestCanonicalOwner,
  findSimilarByBehavior,
  findExportedByName,
} from "../../src/intelligence/reuse-discovery.ts";
import {
  createReuseQuery,
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
    contentHash: overrides.contentHash ?? "abc",
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
    rootPath: ".", generatedAt: "2026-07-16T00:00:00.000Z",
    files: modules.map((m) => ({
      path: m.path, extension: ".ts" as const,
      sizeBytes: 100, contentHash: m.contentHash,
      lineCount: m.lineCount, isSource: true,
    })),
    modules: [...modules], totalSymbols: 0, totalDependencies: 0, mapHash: "test",
  };
}

// ========== findReuseCandidates ==========

test("reuse-discovery: finds candidates by name", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "parseBuffer", exported: true })] })]);
  const results = findReuseCandidates(map, createReuseQuery({ name: "parseBuffer" }));
  assert.equal(results.length, 1);
  assert.ok(results[0]!.score > 0);
});

test("reuse-discovery: fuzzy name match finds candidates", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "parseBuffer", exported: true })] })]);
  const results = findReuseCandidates(map, createReuseQuery({ name: "parseBuf" }));
  assert.ok(results.length >= 1);
});

test("reuse-discovery: no match returns empty", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "foo" })] })]);
  const results = findReuseCandidates(map, createReuseQuery({ name: "xyz" }));
  assert.equal(results.length, 0);
});

test("reuse-discovery: filter by kind", () => {
  const map = mkMap([mkModule({
    symbols: [
      mkSymbol({ name: "foo", kind: "function" }),
      mkSymbol({ name: "foo", kind: "class" }),
    ],
  })]);
  const results = findReuseCandidates(map, createReuseQuery({ name: "foo", kind: "class" }));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.symbol.kind, "class");
});

test("reuse-discovery: filter by directory", () => {
  const map = mkMap([
    mkModule({ path: "src/a/x.ts", symbols: [mkSymbol({ name: "foo", location: { filePath: "src/a/x.ts", line: 1, column: 1 } })] }),
    mkModule({ path: "src/b/y.ts", symbols: [mkSymbol({ name: "foo", location: { filePath: "src/b/y.ts", line: 1, column: 1 } })] }),
  ]);
  const results = findReuseCandidates(map, createReuseQuery({ name: "foo", directory: "src/a" }));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.filePath, "src/a/x.ts");
});

test("reuse-discovery: exported symbols score higher", () => {
  const map = mkMap([mkModule({
    symbols: [
      mkSymbol({ name: "foo", exported: false }),
      mkSymbol({ name: "foo", exported: true }),
    ],
  })]);
  const results = findReuseCandidates(map, createReuseQuery({ name: "foo" }));
  assert.equal(results.length, 2);
  assert.ok(results[0]!.score >= results[1]!.score);
});

test("reuse-discovery: layer bonus applied", () => {
  const map = mkMap([
    mkModule({ path: "src/domain.ts", symbols: [mkSymbol({ name: "foo" })], architectureLayer: "domain" }),
    mkModule({ path: "src/iface.ts", symbols: [mkSymbol({ name: "foo" })], architectureLayer: "interface" }),
  ]);
  const results = findReuseCandidates(map, createReuseQuery({ name: "foo" }));
  assert.ok(results.length >= 2);
  const domainResult = results.find((r) => r.filePath === "src/domain.ts");
  const ifaceResult = results.find((r) => r.filePath === "src/iface.ts");
  assert.ok(domainResult && ifaceResult);
  assert.ok(domainResult!.score > ifaceResult!.score);
});

test("reuse-discovery: signature match with parameter count", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "foo", parameterCount: 3 })] })]);
  const results = findReuseCandidates(map, createReuseQuery({ name: "foo", signature: "3 params" }));
  assert.equal(results.length, 1);
  assert.ok(results[0]!.reasons.includes("signature-match"));
});

test("reuse-discovery: respects limit", () => {
  const modules: ModuleInfo[] = [];
  for (let i = 0; i < 10; i++) {
    modules.push(mkModule({ path: `src/mod${i}.ts`, symbols: [mkSymbol({ name: `foo${i}` })] }));
  }
  const results = findReuseCandidates(mkMap(modules), createReuseQuery({ name: "foo", limit: 3 }));
  assert.equal(results.length, 3);
});

test("reuse-discovery: empty query returns all", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "a" }), mkSymbol({ name: "b" })] })]);
  const results = findReuseCandidates(map, createReuseQuery({}));
  assert.equal(results.length, 2);
});

// ========== findDuplicates ==========

test("reuse-discovery: finds duplicate exported symbols", () => {
  const map = mkMap([
    mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "foo", kind: "function", exported: true, location: { filePath: "src/a.ts", line: 1, column: 1 } })] }),
    mkModule({ path: "src/b.ts", symbols: [mkSymbol({ name: "foo", kind: "function", exported: true, location: { filePath: "src/b.ts", line: 1, column: 1 } })] }),
  ]);
  const dups = findDuplicates(map);
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.count, 2);
});

test("reuse-discovery: ignores non-exported duplicates", () => {
  const map = mkMap([
    mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "foo", exported: false })] }),
    mkModule({ path: "src/b.ts", symbols: [mkSymbol({ name: "foo", exported: false })] }),
  ]);
  const dups = findDuplicates(map);
  assert.equal(dups.length, 0);
});

test("reuse-discovery: distinguishes by kind", () => {
  const map = mkMap([
    mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "foo", kind: "function", exported: true })] }),
    mkModule({ path: "src/b.ts", symbols: [mkSymbol({ name: "foo", kind: "class", exported: true })] }),
  ]);
  const dups = findDuplicates(map);
  assert.equal(dups.length, 0);
});

test("reuse-discovery: minCount filter", () => {
  const map = mkMap([
    mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "foo", exported: true })] }),
    mkModule({ path: "src/b.ts", symbols: [mkSymbol({ name: "foo", exported: true })] }),
    mkModule({ path: "src/c.ts", symbols: [mkSymbol({ name: "bar", exported: true })] }),
  ]);
  const dups = findDuplicates(map, { minCount: 2 });
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.name, "foo");
});

test("reuse-discovery: kind filter for duplicates", () => {
  const map = mkMap([
    mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "foo", kind: "function", exported: true })] }),
    mkModule({ path: "src/b.ts", symbols: [mkSymbol({ name: "foo", kind: "function", exported: true })] }),
    mkModule({ path: "src/c.ts", symbols: [mkSymbol({ name: "bar", kind: "class", exported: true })] }),
    mkModule({ path: "src/d.ts", symbols: [mkSymbol({ name: "bar", kind: "class", exported: true })] }),
  ]);
  const dups = findDuplicates(map, { kinds: ["function"] });
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.name, "foo");
});

test("reuse-discovery: no duplicates returns empty", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "foo", exported: true })] })]);
  const dups = findDuplicates(map);
  assert.equal(dups.length, 0);
});

test("reuse-discovery: duplicates sorted by count", () => {
  const map = mkMap([
    mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "rare", exported: true, location: { filePath: "src/a.ts", line: 1, column: 1 } }), mkSymbol({ name: "rare", exported: true, location: { filePath: "src/a.ts", line: 2, column: 1 } })] }),
    mkModule({ path: "src/b.ts", symbols: [mkSymbol({ name: "common", exported: true, location: { filePath: "src/b.ts", line: 1, column: 1 } })] }),
    mkModule({ path: "src/c.ts", symbols: [mkSymbol({ name: "common", exported: true, location: { filePath: "src/c.ts", line: 1, column: 1 } })] }),
    mkModule({ path: "src/d.ts", symbols: [mkSymbol({ name: "common", exported: true, location: { filePath: "src/d.ts", line: 1, column: 1 } })] }),
  ]);
  const dups = findDuplicates(map);
  assert.ok(dups.length >= 1);
  assert.equal(dups[0]!.name, "common");
});

// ========== suggestCanonicalOwner ==========

test("reuse-discovery: suggests owner based on layer", () => {
  const map = mkMap([
    mkModule({ path: "src/domain.ts", symbols: [mkSymbol({ name: "parseInput" })], architectureLayer: "domain", architectureOwner: "parser" }),
    mkModule({ path: "src/iface.ts", symbols: [mkSymbol({ name: "parseInput" })], architectureLayer: "interface", architectureOwner: "ui" }),
  ]);
  const suggestion = suggestCanonicalOwner(map, "parseInput");
  assert.ok(suggestion.suggestedPath !== null);
  assert.equal(suggestion.suggestedOwner, "parser");
});

test("reuse-discovery: suggestion with no matches", () => {
  const map = mkMap([mkModule({ symbols: [mkSymbol({ name: "foo" })] })]);
  const suggestion = suggestCanonicalOwner(map, "nonexistent");
  assert.equal(suggestion.suggestedPath, null);
  assert.equal(suggestion.suggestedOwner, null);
});

test("reuse-discovery: suggestion returns candidates", () => {
  const map = mkMap([
    mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "foo" })] }),
    mkModule({ path: "src/b.ts", symbols: [mkSymbol({ name: "foobar" })] }),
  ]);
  const suggestion = suggestCanonicalOwner(map, "foo");
  assert.ok(suggestion.candidates.length >= 1);
});

// ========== findSimilarByBehavior ==========

test("reuse-discovery: finds similar by same kind", () => {
  const ref = mkSymbol({ name: "parseBuffer", kind: "function", parameterCount: 2 });
  const map = mkMap([mkModule({
    symbols: [
      mkSymbol({ name: "parseString", kind: "function", parameterCount: 2 }),
      mkSymbol({ name: "writeBuffer", kind: "function", parameterCount: 1 }),
    ],
  })]);
  const results = findSimilarByBehavior(mkMap(map.modules), ref);
  assert.ok(results.length >= 1);
  const parseString = results.find((r) => r.symbol.name === "parseString");
  assert.ok(parseString);
  assert.ok(parseString!.reasons.includes("same-kind"));
  assert.ok(parseString!.reasons.includes("same-arity"));
});

test("reuse-discovery: finds similar by name similarity", () => {
  const ref = mkSymbol({ name: "parseBuf" });
  const map = mkMap([mkModule({
    symbols: [mkSymbol({ name: "parseBuffer" })],
  })]);
  const results = findSimilarByBehavior(mkMap(map.modules), ref);
  assert.ok(results.length >= 1);
  assert.ok(results[0]!.reasons.includes("name-similar"));
});

test("reuse-discovery: findSimilarByBehavior excludes identical symbol", () => {
  const ref = mkSymbol({ name: "foo", kind: "function" });
  const map = mkMap([mkModule({
    symbols: [ref, mkSymbol({ name: "bar", kind: "function" })],
  })]);
  const results = findSimilarByBehavior(mkMap(map.modules), ref);
  assert.ok(!results.some((r) => r.symbol.name === "foo"));
});

test("reuse-discovery: findSimilarByBehavior respects limit", () => {
  const ref = mkSymbol({ name: "fn", kind: "function" });
  const modules: ModuleInfo[] = [];
  for (let i = 0; i < 10; i++) {
    modules.push(mkModule({ path: `src/m${i}.ts`, symbols: [mkSymbol({ name: `fn${i}`, kind: "function" })] }));
  }
  const results = findSimilarByBehavior(mkMap(modules), ref, 3);
  assert.equal(results.length, 3);
});

// ========== findExportedByName ==========

test("reuse-discovery: findExportedByName finds exported symbol", () => {
  const map = mkMap([mkModule({
    path: "src/a.ts",
    symbols: [mkSymbol({ name: "foo", exported: true })],
    exports: [{ name: "foo", kind: "declared", localName: "foo", sourceSpecifier: null }],
  })]);
  const results = findExportedByName(map, "foo");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.filePath, "src/a.ts");
});

test("reuse-discovery: findExportedByName case insensitive", () => {
  const map = mkMap([mkModule({
    symbols: [mkSymbol({ name: "Foo", exported: true })],
    exports: [{ name: "Foo", kind: "declared", localName: "Foo", sourceSpecifier: null }],
  })]);
  const results = findExportedByName(map, "foo");
  assert.equal(results.length, 1);
});

test("reuse-discovery: findExportedByName no match", () => {
  const map = mkMap([mkModule({
    symbols: [mkSymbol({ name: "foo", exported: true })],
    exports: [{ name: "foo", kind: "declared", localName: "foo", sourceSpecifier: null }],
  })]);
  const results = findExportedByName(map, "bar");
  assert.equal(results.length, 0);
});

// ========== Edge cases ==========

test("reuse-discovery: empty map returns empty results", () => {
  const map = mkMap([]);
  assert.equal(findReuseCandidates(map, createReuseQuery({ name: "foo" })).length, 0);
  assert.equal(findDuplicates(map).length, 0);
  assert.equal(suggestCanonicalOwner(map, "foo").suggestedPath, null);
});

test("reuse-discovery: invalid limit throws", () => {
  assert.throws(() => createReuseQuery({ limit: 0 }));
  assert.throws(() => createReuseQuery({ limit: -1 }));
});

test("reuse-discovery: NaN limit throws", () => {
  assert.throws(() => createReuseQuery({ limit: NaN }));
});
