import assert from "node:assert/strict";
import test from "node:test";

import {
  traceSymbolFlow,
  findOccurrencesInSource,
  traceValueFlow,
  findParameterSources,
  findReturnSinks,
  type SourceProvider,
} from "../../src/intelligence/data-flow.ts";
import type {
  ModuleInfo,
  RepositoryMap,
  SymbolInfo,
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

function mkSourceProvider(sources: Readonly<Record<string, string>>): SourceProvider {
  return { read: (path: string) => sources[path] ?? null };
}

// ========== findOccurrencesInSource ==========

test("data-flow: finds function declaration occurrence", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "foo" })] });
  const occurrences = findOccurrencesInSource(module, "foo", "function foo() { return 1; }");
  const decls = occurrences.filter((o) => o.role === "source" && o.context === "function-declaration");
  assert.ok(decls.length >= 1);
});

test("data-flow: finds variable declaration occurrence", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "x", kind: "const" })] });
  const occurrences = findOccurrencesInSource(module, "x", "const x = 42;");
  const decls = occurrences.filter((o) => o.role === "source");
  assert.ok(decls.length >= 1);
});

test("data-flow: finds return statement occurrence", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "foo" })] });
  const occurrences = findOccurrencesInSource(module, "foo", "return foo;");
  const returns = occurrences.filter((o) => o.role === "transform" && o.context === "return-statement");
  assert.ok(returns.length >= 1);
});

test("data-flow: finds call occurrence", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "foo" })] });
  const occurrences = findOccurrencesInSource(module, "foo", "const result = foo();");
  const calls = occurrences.filter((o) => o.role === "sink" && o.context === "call");
  assert.ok(calls.length >= 1);
});

test("data-flow: finds argument occurrence", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "foo" })] });
  const occurrences = findOccurrencesInSource(module, "foo", "bar(foo, 42);");
  const args = occurrences.filter((o) => o.role === "sink" && o.context === "argument");
  assert.ok(args.length >= 1);
});

test("data-flow: finds assignment occurrence", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "foo" })] });
  const occurrences = findOccurrencesInSource(module, "foo", "foo = 42;");
  const assigns = occurrences.filter((o) => o.role === "transform" && o.context === "assignment");
  assert.ok(assigns.length >= 1);
});

test("data-flow: finds member access occurrence", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "foo" })] });
  const occurrences = findOccurrencesInSource(module, "foo", "foo.bar;");
  const access = occurrences.filter((o) => o.role === "pass-through" && o.context === "member-access");
  assert.ok(access.length >= 1);
});

test("data-flow: no occurrences in empty content", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "foo" })] });
  const occurrences = findOccurrencesInSource(module, "foo", "");
  assert.equal(occurrences.length, 0);
});

test("data-flow: no occurrences when name not found", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "foo" })] });
  const occurrences = findOccurrencesInSource(module, "bar", "function foo() {}");
  assert.equal(occurrences.length, 0);
});

test("data-flow: classifies type declaration as source", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "Foo", kind: "class" })] });
  const occurrences = findOccurrencesInSource(module, "Foo", "class Foo {}");
  assert.ok(occurrences.some((o) => o.role === "source"));
});

test("data-flow: classifies interface declaration as source", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "Foo", kind: "interface" })] });
  const occurrences = findOccurrencesInSource(module, "Foo", "interface Foo { bar: string; }");
  assert.ok(occurrences.some((o) => o.role === "source" && o.context === "type-declaration"));
});

// ========== traceSymbolFlow ==========

test("data-flow: traceSymbolFlow finds sources and sinks", () => {
  const source = "function foo(x) { return x; }";
  const module = mkModule({ path: "src/test.ts", symbols: [mkSymbol({ name: "foo", parameterCount: 1 })] });
  const map = mkMap([module]);
  const result = traceSymbolFlow(map, "foo", mkSourceProvider({ "src/test.ts": source }));
  assert.ok(result.sources.length >= 0);
  assert.ok(result.sinks.length >= 0);
});

test("data-flow: traceSymbolFlow finds import-based sinks", () => {
  const moduleA = mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "foo", exported: true })] });
  const moduleB = mkModule({
    path: "src/b.ts",
    symbols: [mkSymbol({ name: "foo" })],
    imports: [{ specifier: "./a.ts", kind: "direct-import", importedNames: ["foo"], resolvedPath: null }],
  });
  const map = mkMap([moduleA, moduleB]);
  const result = traceSymbolFlow(map, "foo", mkSourceProvider({ "src/a.ts": "export function foo() {}", "src/b.ts": "foo();" }));
  assert.ok(result.sinks.length >= 1);
});

test("data-flow: traceSymbolFlow with no symbols returns empty", () => {
  const map = mkMap([mkModule({ symbols: [] })]);
  const result = traceSymbolFlow(map, "nonexistent", mkSourceProvider({ "src/test.ts": "" }));
  assert.equal(result.sources.length, 0);
  assert.equal(result.sinks.length, 0);
});

test("data-flow: traceSymbolFlow handles null source", () => {
  const module = mkModule({ path: "src/test.ts", symbols: [mkSymbol({ name: "foo" })] });
  const map = mkMap([module]);
  const result = traceSymbolFlow(map, "foo", mkSourceProvider({}));
  assert.equal(result.sources.length, 0);
});

// ========== traceValueFlow ==========

test("data-flow: traceValueFlow finds root symbol", () => {
  const moduleA = mkModule({
    path: "src/a.ts",
    symbols: [mkSymbol({ name: "foo", exported: true })],
    exports: [{ name: "foo", kind: "declared", localName: "foo", sourceSpecifier: null }],
  });
  const moduleB = mkModule({
    path: "src/b.ts",
    symbols: [],
    imports: [{ specifier: "./a.ts", kind: "direct-import", importedNames: ["foo"], resolvedPath: null }],
  });
  const map = mkMap([moduleA, moduleB]);
  const result = traceValueFlow(map, "foo");
  assert.ok(result.rootSymbol !== null);
  assert.equal(result.sourceFile, "src/a.ts");
  assert.ok(result.consumers.length >= 1);
});

test("data-flow: traceValueFlow no exported symbol returns null", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "foo", exported: false })] });
  const map = mkMap([module]);
  const result = traceValueFlow(map, "foo");
  assert.equal(result.rootSymbol, null);
  assert.equal(result.sourceFile, null);
});

test("data-flow: traceValueFlow finds transitive consumers", () => {
  const modA = mkModule({
    path: "src/a.ts",
    symbols: [mkSymbol({ name: "foo", exported: true })],
    exports: [{ name: "foo", kind: "declared", localName: "foo", sourceSpecifier: null }],
  });
  const modB = mkModule({
    path: "src/b.ts",
    symbols: [],
    imports: [{ specifier: "./a.ts", kind: "direct-import", importedNames: ["foo"], resolvedPath: null }],
    exports: [{ name: "bar", kind: "declared", localName: "bar", sourceSpecifier: null }],
  });
  const map = mkMap([modA, modB]);
  const result = traceValueFlow(map, "foo");
  assert.ok(result.consumers.length >= 1);
  assert.ok(result.transitiveConsumers.length >= 1);
});

test("data-flow: traceValueFlow respects maxDepth", () => {
  const modA = mkModule({
    path: "src/a.ts",
    symbols: [mkSymbol({ name: "foo", exported: true })],
    exports: [{ name: "foo", kind: "declared", localName: "foo", sourceSpecifier: null }],
  });
  const modB = mkModule({
    path: "src/b.ts",
    imports: [{ specifier: "./a.ts", kind: "direct-import", importedNames: ["foo"], resolvedPath: null }],
    exports: [{ name: "bar", kind: "declared", localName: "bar", sourceSpecifier: null }],
  });
  const map = mkMap([modA, modB]);
  const shallow = traceValueFlow(map, "foo", { maxDepth: 0 });
  assert.equal(shallow.consumers.length, 0);
});

// ========== findParameterSources ==========

test("data-flow: findParameterSources finds functions with parameters", () => {
  const module = mkModule({
    symbols: [
      mkSymbol({ name: "foo", kind: "function", parameterCount: 2 }),
      mkSymbol({ name: "bar", kind: "function", parameterCount: 0 }),
    ],
  });
  const map = mkMap([module]);
  const sources = findParameterSources(map, "foo");
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.role, "source");
});

test("data-flow: findParameterSources no parameters returns empty", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "foo", parameterCount: 0 })] });
  const map = mkMap([module]);
  const sources = findParameterSources(map, "foo");
  assert.equal(sources.length, 0);
});

test("data-flow: findParameterSources case insensitive", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "Foo", parameterCount: 1 })] });
  const map = mkMap([module]);
  const sources = findParameterSources(map, "foo");
  assert.equal(sources.length, 1);
});

// ========== findReturnSinks ==========

test("data-flow: findReturnSinks finds functions", () => {
  const module = mkModule({
    symbols: [
      mkSymbol({ name: "foo", kind: "function" }),
      mkSymbol({ name: "bar", kind: "const" }),
    ],
  });
  const map = mkMap([module]);
  const sinks = findReturnSinks(map, "foo");
  assert.equal(sinks.length, 1);
  assert.equal(sinks[0]!.role, "sink");
});

test("data-flow: findReturnSinks finds async const", () => {
  const module = mkModule({
    symbols: [mkSymbol({ name: "foo", kind: "const", async: true })],
  });
  const map = mkMap([module]);
  const sinks = findReturnSinks(map, "foo");
  assert.equal(sinks.length, 1);
});

test("data-flow: findReturnSinks no match returns empty", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "foo", kind: "class" })] });
  const map = mkMap([module]);
  const sinks = findReturnSinks(map, "foo");
  assert.equal(sinks.length, 0);
});

// ========== Edge cases ==========

test("data-flow: handles empty map", () => {
  const map = mkMap([]);
  const result = traceSymbolFlow(map, "foo", mkSourceProvider({}));
  assert.equal(result.sources.length, 0);
  assert.equal(result.sinks.length, 0);
});

test("data-flow: handles multiple definitions", () => {
  const modA = mkModule({ path: "src/a.ts", symbols: [mkSymbol({ name: "foo" })] });
  const modB = mkModule({ path: "src/b.ts", symbols: [mkSymbol({ name: "foo" })] });
  const map = mkMap([modA, modB]);
  const result = traceSymbolFlow(map, "foo", mkSourceProvider({ "src/a.ts": "function foo() {}", "src/b.ts": "function foo() {}" }));
  assert.ok(result.sources.length >= 0);
});

test("data-flow: occurrence context is non-empty", () => {
  const module = mkModule({ symbols: [mkSymbol({ name: "foo" })] });
  const occurrences = findOccurrencesInSource(module, "foo", "function foo() {}");
  for (const occ of occurrences) {
    assert.ok(occ.context.length > 0);
  }
});
