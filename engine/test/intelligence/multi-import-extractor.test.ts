import assert from "node:assert/strict";
import test from "node:test";

import {
  extractMultiLanguageImports,
  extractForLanguage,
} from "../../src/intelligence/multi-import-extractor.ts";
import {
  buildDependencyGraph,
} from "../../src/intelligence/dependency-graph.ts";
import type {
  ModuleInfo,
  RepositoryMap,
  ImportInfo,
} from "../../src/intelligence/intelligence-types.ts";

// ── Test helpers ──

function mkImport(specifier: string): ImportInfo {
  return { specifier, kind: "direct-import" as const, importedNames: [], resolvedPath: null };
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
    rootPath: ".", generatedAt: "2026-07-23T00:00:00.000Z",
    files: modules.map((m) => ({
      path: m.path, extension: ".ts" as const,
      sizeBytes: 100, contentHash: m.contentHash,
      lineCount: m.lineCount, isSource: true,
    })),
    modules, totalSymbols: 0, totalDependencies: 0, mapHash: "test",
  };
}

// ========== Multi-language import extraction ==========

test("multi-import: python from-relative import", () => {
  const src = "from .foo import bar\nfrom ..pkg import x\n";
  const imports = extractMultiLanguageImports("src/mod.py", src);
  assert.equal(imports.length, 2);
  assert.equal(imports[0]!.specifier, "./foo");
  assert.equal(imports[1]!.specifier, "../pkg");
});

test("multi-import: python bare import is skipped", () => {
  const src = "import os\nimport sys\nfrom os import path\n";
  const imports = extractMultiLanguageImports("src/mod.py", src);
  assert.equal(imports.length, 0, "bare imports should be skipped");
});

test("multi-import: rust use crate:: and mod", () => {
  const src = "use crate::foo::bar;\nuse super::baz;\npub mod qux;\nuse std::collections::HashMap;\n";
  const imports = extractMultiLanguageImports("src/lib.rs", src);
  const specs = imports.map((i) => i.specifier);
  assert.ok(specs.includes("crate::foo::bar"));
  assert.ok(specs.includes("super::baz"));
  assert.ok(specs.includes("qux"));
  assert.ok(!specs.includes("std::collections::HashMap"), "external crates should be skipped");
});

test("multi-import: go relative imports only", () => {
  const src = [
    'import "./internal/pkg"',
    'import (',
    '  "fmt"',
    '  "./foo"',
    '  "../bar"',
    ')',
  ].join("\n");
  const imports = extractMultiLanguageImports("src/main.go", src);
  const specs = imports.map((i) => i.specifier);
  assert.ok(specs.includes("./internal/pkg"));
  assert.ok(specs.includes("./foo"));
  assert.ok(specs.includes("../bar"));
  assert.ok(!specs.includes("fmt"), "bare Go imports should be skipped");
});

test("multi-import: java package imports", () => {
  const src = "import com.foo.Bar;\nimport java.util.List;\nimport com.baz.*;\n";
  const imports = extractMultiLanguageImports("src/Main.java", src);
  const specs = imports.map((i) => i.specifier);
  assert.ok(specs.includes("com/foo/Bar"));
  assert.ok(!specs.some((s) => s.includes("java/util")), "java.* stdlib should be skipped");
});

test("multi-import: c include with quotes only", () => {
  const src = '#include "foo.h"\n#include <stdio.h>\n#include "../bar.h"\n';
  const imports = extractMultiLanguageImports("src/main.c", src);
  const specs = imports.map((i) => i.specifier);
  assert.ok(specs.includes("foo.h"));
  assert.ok(specs.includes("../bar.h"));
  assert.ok(!specs.includes("stdio.h"), "<stdio.h> system include should be skipped");
});

test("multi-import: ruby require_relative only", () => {
  const src = 'require "json"\nrequire_relative "helper"\n';
  const imports = extractMultiLanguageImports("src/app.rb", src);
  const specs = imports.map((i) => i.specifier);
  assert.ok(specs.includes("helper"));
  assert.ok(!specs.includes("json"), "gem require should be skipped");
});

test("multi-import: empty source returns empty", () => {
  assert.equal(extractMultiLanguageImports("src/foo.py", "").length, 0);
});

test("multi-import: unknown extension returns empty", () => {
  assert.equal(extractMultiLanguageImports("src/foo.xyz", "import foo").length, 0);
});

test("multi-import: never throws on malformed input", () => {
  // Should not throw — degrades to empty
  assert.doesNotThrow(() => extractMultiLanguageImports("src/foo.py", "\x00\x01\x02"));
  assert.doesNotThrow(() => extractMultiLanguageImports("src/foo.rs", "use crate::"));
});

test("multi-import: deduplication", () => {
  const src = "from .foo import a\nfrom .foo import b\n";
  const imports = extractMultiLanguageImports("src/mod.py", src);
  assert.equal(imports.length, 1, "same specifier should be deduped");
});

// ========== Multi-language import resolution ==========

test("multi-resolve: python relative resolves to.py", () => {
  const map = mkMap([
    mkModule("src/mod.py", [mkImport("./foo")]),
    mkModule("src/foo.py", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 1);
  assert.equal(graph.edges[0]!.from, "src/mod.py");
  assert.equal(graph.edges[0]!.to, "src/foo.py");
});

test("multi-resolve: python resolves to __init__.py for package", () => {
  const map = mkMap([
    mkModule("src/mod.py", [mkImport("./pkg")]),
    mkModule("src/pkg/__init__.py", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 1);
  assert.equal(graph.edges[0]!.to, "src/pkg/__init__.py");
});

test("multi-resolve: rust crate:: resolves to.rs", () => {
  const map = mkMap([
    mkModule("src/lib.rs", [mkImport("crate::foo::bar")]),
    mkModule("src/foo/bar.rs", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 1);
  assert.equal(graph.edges[0]!.to, "src/foo/bar.rs");
});

test("multi-resolve: rust mod resolves to mod.rs", () => {
  const map = mkMap([
    mkModule("src/lib.rs", [mkImport("foo")]),
    mkModule("src/foo/mod.rs", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 1);
  assert.equal(graph.edges[0]!.to, "src/foo/mod.rs");
});

test("multi-resolve: java package resolves via ends-with match", () => {
  const map = mkMap([
    mkModule("src/main/java/com/example/Main.java", [mkImport("com/foo/Bar")]),
    mkModule("src/main/java/com/foo/Bar.java", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 1);
  assert.equal(graph.edges[0]!.to, "src/main/java/com/foo/Bar.java");
});

test("multi-resolve: c include resolves relative to file dir", () => {
  const map = mkMap([
    mkModule("src/main.c", [mkImport("foo.h")]),
    mkModule("src/foo.h", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 1);
  assert.equal(graph.edges[0]!.to, "src/foo.h");
});

test("multi-resolve: c include resolves parent directory", () => {
  const map = mkMap([
    mkModule("src/sub/main.c", [mkImport("../foo.h")]),
    mkModule("src/foo.h", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 1);
  assert.equal(graph.edges[0]!.to, "src/foo.h");
});

test("multi-resolve: ruby require_relative resolves to.rb", () => {
  const map = mkMap([
    mkModule("src/app.rb", [mkImport("helper")]),
    mkModule("src/helper.rb", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 1);
  assert.equal(graph.edges[0]!.to, "src/helper.rb");
});

test("multi-resolve: ts/js still uses the original resolver", () => {
  const map = mkMap([
    mkModule("src/bar.ts", [mkImport("./foo")]),
    mkModule("src/foo.ts", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 1);
  assert.equal(graph.edges[0]!.to, "src/foo.ts");
});

test("multi-resolve: mixed-language repo (ts + py)", () => {
  const map = mkMap([
    mkModule("src/index.ts", [mkImport("./app")]),
    mkModule("src/app.ts", []),
    mkModule("src/mod.py", [mkImport("./foo")]),
    mkModule("src/foo.py", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 2);
});

test("multi-resolve: unresolved import produces no edge (no throw)", () => {
  const map = mkMap([
    mkModule("src/mod.py", [mkImport("./nonexistent")]),
    mkModule("src/other.py", []),
  ]);
  const graph = buildDependencyGraph(map);
  assert.equal(graph.edgeCount, 0, "unresolved import = no edge, no throw");
});

test("multi-resolve: go directory import matches a file in the dir", () => {
  const map = mkMap([
    mkModule("src/main.go", [mkImport("./pkg")]),
    mkModule("src/pkg/handler.go", []),
  ]);
  const graph = buildDependencyGraph(map);
  // Go imports are directories; the ends-with fallback matches a file in
  // the directory (src/pkg/handler.go starts with./pkg → src/pkg/).
  assert.ok(graph.edgeCount >= 1, "go directory import should resolve to a file in the dir");
});

// ========== Adversarial: improper usage ==========

test("multi-resolve: huge specifier does not hang", () => {
  const big = "a/".repeat(1000) + "b";
  const map = mkMap([
    mkModule("src/mod.py", [mkImport(big)]),
    mkModule("src/other.py", []),
  ]);
  assert.doesNotThrow(() => buildDependencyGraph(map));
});

test("multi-resolve: specifier with null bytes is handled", () => {
  const map = mkMap([
    mkModule("src/mod.py", [mkImport("./foo\x00bar")]),
    mkModule("src/foo.py", []),
  ]);
  assert.doesNotThrow(() => buildDependencyGraph(map));
});

test("multi-import: extractForLanguage covers all language ids", () => {
  // Every registered LanguageId must have a case in the switch (TS
  // exhaustiveness check at compile time catches this, but test the
  // runtime too — unknown languages return empty, not throw).
  const langs = [
    "python", "rust", "go", "java", "c", "cpp", "c_sharp", "ruby",
    "php", "swift", "kotlin", "scala", "lua", "dart", "bash", "elixir",
    "zig", "ocaml", "elm", "rescript", "javascript", "typescript",
  ] as const;
  for (const lang of langs) {
    assert.doesNotThrow(() => extractForLanguage(lang, ""));
  }
});
