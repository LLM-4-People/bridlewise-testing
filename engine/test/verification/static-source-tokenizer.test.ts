/**
 * The static-source tokenizer's multi-character punctuation behavior, and the
 * two-scanner export agreement over the tree the harness scans when invoked
 * from the repository root above the engine tree.
 *
 * The tokenizer is the lexical half of a deliberately independent two-scanner
 * oracle: the architecture verifier and the module registrar compare its
 * export names against the Babel analyzer's, and fail closed on disagreement.
 * A scanner that emits punctuation one character at a time breaks that
 * oracle on real source — an arrow's `=>` reached the regex-literal heuristic
 * as `=` then `>`, so a fenced-code regex inside a web-root file let its three
 * backticks open a bogus template literal that swallowed every export below
 * it, and a repository-root `harness register` died on the disagreement.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { analyzeArchitectureSource, verifyArchitectureSources } from "../../scripts/verification/architecture.ts";
import { analyzeStaticSource, analyzeStaticModuleShape, clearStaticModuleShapeCache, tokenizeStaticSource } from "../../scripts/verification/static-source.ts";
import { analysisSemanticsId, createFilesystemCache } from "../../scripts/verification/filesystem-cache.ts";
import { ARCHITECTURE_MANIFEST, EMPTY_COMPOSITION_ROOTS, type ArchitectureManifest } from "../../src/architecture-manifest.ts";
import { ARCHITECTURE_SOURCE_EXTENSIONS } from "../../src/shared/source-extensions.ts";
import { canonicalHash, sha256 } from "../../src/kernel/integrity.ts";
import { withTempDir } from "../support/temp-dir.ts";
import { DEFAULT_STATIC_MODULE_SHAPE_FILESYSTEM_CACHE_MAX_ENTRIES } from "../../src/workflow/workflow-config.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

const tokenizeFixture = (source: string) => tokenizeStaticSource(source, "fixture.ts");

test("Static-source tokenizer emits every multi-character operator as one token", () => {
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["x=>y", ["x", "=>", "y"]],
    ["a===b;c!==d", ["a", "===", "b", ";", "c", "!==", "d"]],
    ["e<=f;g>=h", ["e", "<=", "f", ";", "g", ">=", "h"]],
    ["i&&j;k||l;m??n", ["i", "&&", "j", ";", "k", "||", "l", ";", "m", "??", "n"]],
    ["[...o]", ["[", "...", "o", "]"]],
    ["p**=q;r**2", ["p", "**=", "q", ";", "r", "**", "2"]],
    ["r++;s--", ["r", "++", ";", "s", "--"]],
    ["t?.u", ["t", "?.", "u"]],
    ["a<<=b;c>>>=d", ["a", "<<=", "b", ";", "c", ">>>=", "d"]],
    ["x+=1;y-=2;z*=3;w%=4;v&=1;u|=2;q^=3", ["x", "+=", "1", ";", "y", "-=", "2", ";", "z", "*=", "3", ";", "w", "%=", "4", ";", "v", "&=", "1", ";", "u", "|=", "2", ";", "q", "^=", "3"]],
    ["a=b/c", ["a", "=", "b", "/", "c"]],
    ["x/=2", ["x", "/=", "2"]],
  ];
  for (const [source, expected] of cases) {
    const values = tokenizeFixture(source).map((token) => token.value);
    assert.deepEqual(values, [...expected], `token values for ${source}`);
  }
});

test("Static-source tokenizer keeps the optional-chaining lookahead restriction", () => {
  // `?.` is one token only when no decimal digit follows: a ternary with a
  // `.5` branch keeps three tokens, matching the grammar's own restriction.
  const ternary = tokenizeFixture("t ? .5 : 1");
  assert.deepEqual(ternary.map((token) => token.value), ["t", "?", ".", "5", ":", "1"]);
  const adjacentTernary = tokenizeFixture("t?.5:1");
  assert.deepEqual(adjacentTernary.map((token) => token.value), ["t", "?", ".", "5", ":", "1"],
    "an optional-chaining punctuator may not swallow a ternary's `.5` branch");
});

test("Static-source tokenizer latches a regex literal after an arrow and after merged operators", () => {
  const poison = tokenizeFixture('const n = lines.filter((l) => /^\\s*(```|~~~)/.test(l)).length;');
  const poisonValues = poison.map((token) => token.value);
  assert.ok(poisonValues.includes("=>"), "the arrow is one token");
  assert.ok(poisonValues.includes("/regex/"), "the fenced-code regex is one regex token");
  assert.ok(!poison.some((token) => token.kind === "template"),
    "the backticks inside the regex must not open a template literal that swallows the file");

  const mergedLatchCases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["return /x/.test(s)", ["return", "/regex/", ".", "test", "(", "s", ")"]],
    ["p === /x/.test(z)", ["p", "===", "/regex/", ".", "test", "(", "z", ")"]],
    ["w ? /x/ : y", ["w", "?", "/regex/", ":", "y"]],
    ["x /= /re/.source.length", ["x", "/=", "/regex/", ".", "source", ".", "length"]],
  ];
  for (const [source, expected] of mergedLatchCases) {
    assert.deepEqual(tokenizeFixture(source).map((token) => token.value), [...expected],
      `token values for ${source}`);
  }
  // Division stays division after an operand.
  assert.deepEqual(
    tokenizeFixture("a = b / c").map((token) => token.value),
    ["a", "=", "b", "/", "c"],
  );
});

test("Static-source export agreement holds through an arrow-fed fenced-code regex", () => {
  const fixture = [
    'import { join } from "node:path";',
    "export const before = 1;",
    'const fenced = (lines) => lines.filter((l) => /^\\s*(```|~~~)/.test(l)).length;',
    "export function fenceCount(lines) { return fenced(lines) >= 2; }",
    'export const after = (count) => count === 0 ? "none" : `${count} fences`;',
  ].join("\n");
  const facts = analyzeArchitectureSource("src/fenced-fixture.ts", fixture);
  const lexical = analyzeStaticModuleShape(fixture, "fixture.ts");
  assert.deepEqual(lexical.exportedNames, ["after", "before", "fenceCount"],
    "the lexical oracle must see the exports below the fenced-code regex");
  assert.deepEqual([...facts.exportedNames].toSorted(), [...lexical.exportedNames],
    "the two scanners must agree on the fixture's export names");
});

test("Static-source shape cache ignores entries keyed before the scanner's current bytes", () => {
  // A shape is a function of the source AND the scanner that tokenizes it,
  // so the shape cache key carries the scanner's own bytes: an entry written
  // under a source-only key (the format a differently-behaved scanner once
  // used) must never be served. Plant exactly such an entry — a fabricated
  // stale shape under the source-content-only key, the same way a real
  // repository-root scan once wrote a poisoned entry — and require the
  // analysis to compute fresh.
  const fixture = [
    'import { basename } from "node:path";',
    "export const staleProbe = 1;",
    'const gated = (lines) => lines.filter((l) => /^\\s*(```|~~~)/.test(l)).length;',
    "export function staleProbeCount(lines) { return gated(lines); }",
  ].join("\n");
  const contentHash = sha256(Buffer.from(fixture, "utf8"));
  const cache = createFilesystemCache({
    directory: "harness-static-cache",
    maxEntries: DEFAULT_STATIC_MODULE_SHAPE_FILESYSTEM_CACHE_MAX_ENTRIES,
  });
  cache.write(contentHash, {
    exportedNames: ["staleScannerResult"],
    analysis: {
      moduleAcquisitions: [{ kind: "direct-import", specifier: "node:path" }],
      unmodeledModuleAcquisition: false,
      environmentAcquisitions: [],
      unmodeledEnvironmentAccess: false,
    },
  });
  const shape = analyzeStaticModuleShape(fixture, "fixture.ts");
  assert.deepEqual([...shape.exportedNames], ["staleProbe", "staleProbeCount"],
    "a cache entry keyed by source content alone must not be served for the current scanner bytes");
});

test("Static-source export agreement holds over the repository-root scan population", () => {
  // The registrar walks the source roots relative to the process cwd, so a
  // harness invocation from the repository root above the engine tree scans
  // that tree's sources. Every file must keep the two scanners in agreement —
  // the population is discovered from the same owners the registrar reads
  // (manifest source roots, the extension set, the experiment exclusion), so
  // a file added tomorrow is checked automatically.
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const extensions = new Set<string>(ARCHITECTURE_SOURCE_EXTENSIONS);
  const population: { abs: string; rel: string }[] = [];
  for (const sourceRoot of ARCHITECTURE_MANIFEST.sourceRoots) {
    const absoluteRoot = resolve(repositoryRoot, sourceRoot);
    if (!existsSync(absoluteRoot)) continue;
    for (const fullPath of walk(absoluteRoot, { exts: [...extensions], exclude: experimentExclusion(repositoryRoot) })) {
      population.push({ abs: fullPath, rel: relative(repositoryRoot, fullPath).replaceAll("\\", "/") });
    }
  }
  const files = population.filter(({ rel }) =>
    extensions.has(rel.slice(rel.lastIndexOf("."))) &&
    !rel.slice(rel.lastIndexOf("/") + 1).startsWith("."));
  assert.ok(files.length > 100, `the repository-root scan population must be discovered (found ${files.length})`);
  const disagreements: string[] = [];
  for (const { abs, rel } of files) {
    const source = readFileSync(abs, "utf8");
    const facts = analyzeArchitectureSource(rel, source);
    const lexical = analyzeStaticModuleShape(source, rel);
    if (JSON.stringify([...facts.exportedNames].toSorted()) !== JSON.stringify([...lexical.exportedNames])) {
      disagreements.push(
        `${rel}: babel=${JSON.stringify([...facts.exportedNames].toSorted())} lexical=${JSON.stringify([...lexical.exportedNames])}`,
      );
    }
  }
  assert.deepEqual(disagreements, [],
    "every repository-root source file must agree between the Babel and lexical scanners");
});


const referenceCases: readonly Readonly<{name: string; source: string; runtime: readonly string[]; erased: readonly string[]; names?: readonly string[]; loads?: boolean}>[] = [
  {"name": "default type import", "source": "import type T from \"./dep.mts\";", "runtime": [], "erased": ["./dep.mts"]},
  {"name": "named type import", "source": "import type { T } from \"./dep.mts\";", "runtime": [], "erased": ["./dep.mts"]},
  {"name": "namespace type import", "source": "import type * as NS from \"./dep.mts\";", "runtime": [], "erased": ["./dep.mts"]},
  {"name": "named type export", "source": "export type { T } from \"./dep.mts\";", "runtime": [], "erased": ["./dep.mts"], "names": ["T"]},
  {"name": "star type export", "source": "export type * from \"./dep.mts\";", "runtime": [], "erased": ["./dep.mts"]},
  {"name": "namespace type export", "source": "export type * as NS from \"./dep.mts\";", "runtime": [], "erased": ["./dep.mts"], "names": ["NS"]},
  {"name": "import type expression", "source": "type T = import(\"./dep.mts\").T;", "runtime": [], "erased": ["./dep.mts"]},
  {"name": "type query", "source": "type T = typeof import(\"./dep.mts\");", "runtime": [], "erased": ["./dep.mts"]},
  {"name": "annotation and runtime initializer", "source": "const x: import(\"./types.mts\").T = await import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": ["./types.mts"]},
  {"name": "nested generic annotation", "source": "let x: Promise<Array<import(\"./dep.mts\").T>>;", "runtime": [], "erased": ["./dep.mts"]},
  {"name": "optional interface query", "source": "interface Options { spawn?: typeof import(\"./dep.mts\").T }", "runtime": [], "erased": ["./dep.mts"]},
  {"name": "generic type alias", "source": "export type Box<T> = { inner: Promise<import(\"./dep.mts\").T>; value: T };", "runtime": [], "erased": ["./dep.mts"], "names": ["Box"]},
  {"name": "function annotation", "source": "function f(x: import(\"./dep.mts\").T): import(\"./types.mts\").T { return x; }", "runtime": [], "erased": ["./dep.mts", "./types.mts"]},
  {"name": "semicolonless type then runtime", "source": "type T = import(\"./types.mts\").T\nconst x = await import(\"./dep.mts\")", "runtime": ["./dep.mts"], "erased": ["./types.mts"]},
  {"name": "semicolonless type import then runtime", "source": "import type { T } from \"./types.mts\"\nconst x = await import(\"./dep.mts\")", "runtime": ["./dep.mts"], "erased": ["./types.mts"]},
  {"name": "inline type import wrapper", "source": "import { type T } from \"./dep.mts\";", "runtime": ["./dep.mts"], "erased": []},
  {"name": "inline type export wrapper", "source": "export { type T } from \"./dep.mts\";", "runtime": ["./dep.mts"], "erased": [], "names": ["T"]},
  {"name": "mixed import", "source": "import { type T, value } from \"./dep.mts\";", "runtime": ["./dep.mts"], "erased": []},
  {"name": "mixed export", "source": "export { type T, value } from \"./dep.mts\";", "runtime": ["./dep.mts"], "erased": [], "names": ["T", "value"]},
  {"name": "bare import", "source": "import \"./dep.mts\";", "runtime": ["./dep.mts"], "erased": []},
  {"name": "empty import", "source": "import {} from \"./dep.mts\";", "runtime": ["./dep.mts"], "erased": []},
  {"name": "empty export", "source": "export {} from \"./dep.mts\";", "runtime": ["./dep.mts"], "erased": []},
  {"name": "value used only as type", "source": "import { T } from \"./dep.mts\"; type U = T;", "runtime": ["./dep.mts"], "erased": []},
  {"name": "local type export", "source": "type T = string; export { type T };", "runtime": [], "erased": [], "names": ["T"]},
  {"name": "type import equals", "source": "import type Alias = require(\"./dep.mts\");", "runtime": [], "erased": ["./dep.mts"]},
  {"name": "dynamic expression", "source": "const value = await import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": []},
  {"name": "expression typeof", "source": "const value = typeof import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": []},
  {"name": "object literal expression", "source": "const obj = { value: import(\"./dep.mts\") };", "runtime": ["./dep.mts"], "erased": []},
  {"name": "conditional expression", "source": "const value = true ? 1 : import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": [], "names": [], "loads": false},
  {"name": "potential uncalled import", "source": "function later() { return import(\"./dep.mts\") }", "runtime": ["./dep.mts"], "erased": [], "names": [], "loads": false},
  {"name": "default value named type", "source": "import type from \"./dep.mts\"; if(type !== 7) throw Error(\"wrong value\");", "runtime": ["./dep.mts"], "erased": []},
  {"name": "mixed default value named type", "source": "import type, { value } from \"./dep.mts\"; if(type !== 7 || value !== 1) throw Error(\"wrong value\");", "runtime": ["./dep.mts"], "erased": []},
  {"name": "value export named type", "source": "const type = 1; export { type };", "runtime": [], "erased": [], "names": ["type"]},
  {"name": "value export type alias", "source": "const type = 1; export { type as other };", "runtime": [], "erased": [], "names": ["other"]},
  {"name": "type import attributes", "source": "type T = import(\"./dep.mts\", { with: { \"resolution-mode\": \"import\" } }).T;", "runtime": [], "erased": ["./dep.mts"]},
  {"name": "inert strings and comments", "source": "void import.meta; const text = \"import(ghost)\"; /* import(\"ghost\") */", "runtime": [], "erased": []},
  {"name": "same target both channels", "source": "type T = import(\"./dep.mts\").T; const p = import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": ["./dep.mts"]},
  {"name": "call before ternary colon", "source": "function f(){return 1} const p = false ? f() : import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": []},
  {"name": "parameter default ternary", "source": "function f(x = false ? 1 : import(\"./dep.mts\")) {}", "runtime": ["./dep.mts"], "erased": [], "loads": false},
  {"name": "arrow annotation then body", "source": "const f = (x: import(\"./types.mts\").T) => import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": ["./types.mts"], "loads": false},
  {"name": "class field and method body", "source": "class Box { value?: import(\"./types.mts\").T; method() { return import(\"./dep.mts\"); } }", "runtime": ["./dep.mts"], "erased": ["./types.mts"], "loads": false},
  {"name": "return object type and body", "source": "function f(): { value: import(\"./types.mts\").T } { return { value: import(\"./dep.mts\") }; }", "runtime": ["./dep.mts"], "erased": ["./types.mts"], "loads": false},
  {"name": "semicolonless type then void", "source": "type T = import(\"./types.mts\").T\nvoid import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": ["./types.mts"]},
  {"name": "control conditional", "source": "if (false ? 1 : import(\"./dep.mts\")) {}", "runtime": ["./dep.mts"], "erased": []},
  {"name": "parenthesized conditional", "source": "const p = false ? (1) : import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": []},
  {"name": "as conditional", "source": "const value = 0; const p = value as import(\"./types.mts\").T ? import(\"./dep.mts\") : import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": ["./types.mts"]},
  {"name": "satisfies conditional", "source": "const value = 0; const p = value satisfies import(\"./types.mts\").T ? import(\"./dep.mts\") : import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": ["./types.mts"]},
  {"name": "as equality", "source": "const value = 0; const p = value as import(\"./types.mts\").T === import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": ["./types.mts"]},
  {"name": "conditional type branches", "source": "type T = string extends number ? import(\"./dep.mts\").T : import(\"./types.mts\").T;", "runtime": [], "erased": ["./dep.mts", "./types.mts"]},
  {"name": "generic function parameters", "source": "function f<T>(x: import(\"./types.mts\").T) { return import(\"./dep.mts\"); }", "runtime": ["./dep.mts"], "erased": ["./types.mts"], "loads": false},
  {"name": "generator function parameters", "source": "function* f(x: import(\"./types.mts\").T) { return import(\"./dep.mts\"); }", "runtime": ["./dep.mts"], "erased": ["./types.mts"], "loads": false},
  {"name": "literal angle type union", "source": "type T = \"<\" | import(\"./types.mts\").T; const p = import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": ["./types.mts"], "loads": true},
  {"name": "literal brace type union", "source": "type T = \"}\" | import(\"./types.mts\").T; const p = import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": ["./types.mts"], "loads": true},
  {"name": "prototype names are identifiers", "source": "function constructor(x: import(\"./types.mts\").T) { return import(\"./dep.mts\"); }", "runtime": ["./dep.mts"], "erased": ["./types.mts"], "loads": false},
  {"name": "semicolonless type then unary expression", "source": "type T = string\n!import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": []},
  {"name": "local type export declaration boundary", "source": "type T = string; export type { T }\nimport { value } from \"./dep.mts\";", "runtime": ["./dep.mts"], "erased": [], "names": ["T"]},
  {"name": "local value export declaration boundary", "source": "const own = 1; export { own }\nimport { value } from \"./dep.mts\";", "runtime": ["./dep.mts"], "erased": [], "names": ["own"]},
  {"name": "default value named from", "source": "import from from \"./dep.mts\";", "runtime": ["./dep.mts"], "erased": [], "names": []},
  {"name": "local export named from", "source": "const from = 1; export { from };", "runtime": [], "erased": [], "names": ["from"]},
  {"name": "type property named import", "source": "type Result = { import: string }; const p = import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": []},
  {"name": "optional type property named import", "source": "type Result = { import?: string }; const p = import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": []},
  {"name": "value member named import", "source": "const result = { import: 1 }; void result.import;", "runtime": [], "erased": []},
  {"name": "optional method named import", "source": "const result = { import: () => 1 }; void result?.import(\"not-a-module\");", "runtime": [], "erased": []},
  {"name": "member and computed imports then real acquisition", "source": "const result = { import: () => 1 }; void result.import; void result?.import; void result[\"import\"]; const p = import(\"./dep.mts\");", "runtime": ["./dep.mts"], "erased": []},
 ];
for (const row of referenceCases) {
  test(`Module references: ${row.name}`, () => {
    const facts = analyzeArchitectureSource("src/reference.mts", row.source);
    const lexical = analyzeStaticModuleShape(row.source, "src/reference.mts");
    const resolved = (values: readonly string[]) => values.map(value => `src/${value.slice(2)}`).toSorted();
    assert.deepEqual(facts.dependencies, resolved(row.runtime), "AST runtime references");
    assert.deepEqual(facts.typeOnlyDependencies, resolved(row.erased), "AST erased references");
    assert.deepEqual([...new Set(lexical.analysis.moduleAcquisitions.map(entry => entry.specifier))].toSorted(), [...row.runtime].toSorted(), "lexical runtime references");
    assert.deepEqual([...new Set(lexical.analysis.typeOnlyModuleReferences)].toSorted(), [...row.erased].toSorted(), "lexical erased references");
    assert.equal(lexical.analysis.unmodeledModuleAcquisition, false);
    assert.deepEqual(facts.exportedNames, [...(row.names ?? [])].toSorted(), "AST source API names");
    assert.deepEqual(lexical.exportedNames, [...(row.names ?? [])].toSorted(), "lexical source API names");
  });
}

test("Module references: actual strip-only runtime effects", () => {
  withTempDir("module-reference-runtime-", (directory) => {
    writeFileSync(join(directory, "dep.mts"), 'process.stdout.write("loaded\\n"); export const T = 1; export const value = 1; export default 7;');
    for (const row of referenceCases) {
      writeFileSync(join(directory, "entry.mts"), `${row.source}\nprocess.stdout.write("done\\n");`);
      const actual = spawnSync(process.execPath, ["--experimental-strip-types", join(directory, "entry.mts")], { encoding: "utf8", timeout: 10_000 });
      assert.equal(actual.status, 0, `${row.name}: ${actual.stderr}`);
      assert.equal(actual.stdout.split("\n").filter(line => line === "loaded").length, row.runtime.length > 0 && row.loads !== false ? 1 : 0, row.name);
      if (["inline type import wrapper", "inline type export wrapper", "empty import", "empty export"].includes(row.name)) {
        writeFileSync(join(directory, "entry.mts"), row.source.replaceAll("./dep.mts", "./missing.mts"));
        const absent = spawnSync(process.execPath, ["--experimental-strip-types", join(directory, "entry.mts")], { encoding: "utf8", timeout: 10_000 });
        assert.equal(absent.status, 1, `${row.name} must request its missing target`);
        assert.match(absent.stderr, /ERR_MODULE_NOT_FOUND/u);
      }
      if (row.erased.length > 0 && row.runtime.length === 0) {
        writeFileSync(join(directory, "entry.mts"), row.source.replaceAll("./dep.mts", "./missing.mts"));
        const absent = spawnSync(process.execPath, ["--experimental-strip-types", join(directory, "entry.mts")], { encoding: "utf8", timeout: 10_000 });
        assert.equal(absent.status, 0, `${row.name} absent target: ${absent.stderr}`);
      }
    }
    for (const source of ['import Alias = require("./dep.mts");', 'import Alias = Namespace.Value;', 'export = 1;', 'const value = <import("./types.mts").T>await import("./dep.mts");', 'void <unknown>import("./dep.mts");']) {
      writeFileSync(join(directory, "entry.mts"), source);
      const actual = spawnSync(process.execPath, ["--experimental-strip-types", join(directory, "entry.mts")], { encoding: "utf8", timeout: 10_000 });
      assert.equal(actual.status, 1);
      assert.match(actual.stderr, /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/u);
      assert.equal(actual.stdout, "", "unsupported syntax refuses before target evaluation");
    }
  });
});

for (const source of [
  'type T = import("./types.mts").T; export const view = <Widget load={() => import("./dep.mts")} />;',
  'const view: import("./types.mts").T = <Widget>{import("./dep.mts")}</Widget>;',
]) {
  test(`Module references: TSX source ${source}`, () => {
    const facts = analyzeArchitectureSource("src/view.tsx", source);
    const lexical = analyzeStaticModuleShape(source, "src/view.tsx");
    assert.deepEqual(facts.dependencies, ["src/dep.mts"]);
    assert.deepEqual(facts.typeOnlyDependencies, ["src/types.mts"]);
    assert.deepEqual(lexical.analysis.moduleAcquisitions, [{ kind: "dynamic-import", specifier: "./dep.mts" }]);
    assert.deepEqual(lexical.analysis.typeOnlyModuleReferences, ["./types.mts"]);
    assert.equal(lexical.analysis.unmodeledModuleAcquisition, false);
  });
}

test("Module references: JSX text is inert and embedded expressions remain runtime", () => {
  const source = 'const node = <div>import("./fake.mts")<b title="import(ghost)">{import("./live.mts")}</b></div>;';
  const facts = analyzeArchitectureSource("src/view.tsx", source);
  const lexical = analyzeStaticModuleShape(source, "src/view.tsx");
  assert.deepEqual(facts.dependencies, ["src/live.mts"]);
  assert.deepEqual(lexical.analysis.moduleAcquisitions, [{ kind: "dynamic-import", specifier: "./live.mts" }]);
  assert.deepEqual(lexical.analysis.typeOnlyModuleReferences, []);
});

test("Module references: literal delimiter specifiers are data", () => {
  for (const specifier of ["(", ")", "{", "}", "[", "]", "<", ">", "type", "from"]) {
    const source = `type T = import(${JSON.stringify(specifier)}).T; void import("./live.mts");`;
    const facts = analyzeArchitectureSource("src/reference.ts", source);
    const lexical = analyzeStaticModuleShape(source, "src/reference.ts");
    assert.deepEqual(facts.typeOnlyDependencies, [specifier]);
    assert.deepEqual(lexical.analysis.typeOnlyModuleReferences, [specifier]);
    assert.deepEqual(lexical.analysis.moduleAcquisitions, [{ kind: "dynamic-import", specifier: "./live.mts" }]);
  }
  assert.deepEqual(analyzeStaticSource('import ":";', "src/literal.ts").moduleAcquisitions, [{ kind: "direct-import", specifier: ":" }]);
});

test("Module references: explicit unsupported profile and unknown targets refuse", () => {
  for (const [source, construct] of [['import Alias = require("./target.mts");', "import-equals"], ['import Alias = Namespace.Value;', "import-equals"], ['export = 1;', "export assignment"], ['const value = <import("./types.mts").T>await import("./target.mts");', "angle-bracket assertion"]] as const) {
    assert.throws(() => analyzeArchitectureSource("src/unsupported.ts", source), { message: `unsupported TypeScript ${construct} in strip-only profile` });
    assert.equal(analyzeStaticSource(source, "src/unsupported.ts").unmodeledModuleAcquisition, true);
  }
  assert.deepEqual(analyzeStaticSource('const target = "x"; void import(target)', "src/unknown.ts").moduleAcquisitions, [{ kind: "dynamic-import", specifier: null }]);
});

test("Module references: explicit profiles refuse TS assertions, preserve TSX generic arrows and separate caches", () => {
  const assertion = 'const value = <unknown>import("./live.mts");';
  assert.throws(() => analyzeArchitectureSource("src/assertion.ts", assertion), /unsupported TypeScript angle-bracket assertion/u);
  assert.equal(analyzeStaticSource(assertion, "src/assertion.ts").unmodeledModuleAcquisition, true);
  const arrow = 'const f = <T,>(x: import("./types.mts").T) => import("./live.mts");';
  for (const profile of ["src/arrow.ts", "src/arrow.tsx"]) {
    const ast = analyzeArchitectureSource(profile, arrow);
    const lexical = analyzeStaticModuleShape(arrow, profile);
    assert.deepEqual(ast.dependencies, ["src/live.mts"]);
    assert.deepEqual(ast.typeOnlyDependencies, ["src/types.mts"]);
    assert.deepEqual(lexical.analysis.moduleAcquisitions, [{ kind: "dynamic-import", specifier: "./live.mts" }]);
    assert.deepEqual(lexical.analysis.typeOnlyModuleReferences, ["./types.mts"]);
  }
  const jsx = 'const node = <div>import("./text.mts")</div>;';
  assert.deepEqual(analyzeStaticModuleShape(jsx, "src/view.tsx").analysis.moduleAcquisitions, []);
  // A TS lexical fragment interprets the same tokens differently; Babel still
  // rejects this as a complete TS module. No TS grammar admission is inferred.
  assert.throws(() => analyzeArchitectureSource("src/view.ts", jsx));
  assert.deepEqual(analyzeStaticModuleShape(jsx, "src/view.ts").analysis.moduleAcquisitions, [{ kind: "dynamic-import", specifier: "./text.mts" }]);
  clearStaticModuleShapeCache();
  assert.deepEqual(analyzeStaticModuleShape(jsx, "src/view.tsx").analysis.moduleAcquisitions, []);
});

test("Module references: cached erased-reference shape is required and validated", () => {
  const cache = createFilesystemCache({ directory: "harness-static-cache", maxEntries: DEFAULT_STATIC_MODULE_SHAPE_FILESYSTEM_CACHE_MAX_ENTRIES });
  const semantics = analysisSemanticsId(new URL("../../scripts/verification/static-source.ts", import.meta.url), new URL("../../src/shared/source-extensions.ts", import.meta.url));
  for (const [index, malformed] of [undefined, null, 1, [1]].entries()) {
    const source = `import type { T } from "./types.mts"; export const probe${index} = 1;`;
    const profile = "src/cache.ts";
    const key = `${profile}\0${sha256(Buffer.from(source, "utf8"))}\0${semantics}`;
    const analysis = { moduleAcquisitions: [], unmodeledModuleAcquisition: false, environmentAcquisitions: [], unmodeledEnvironmentAccess: false, ...(malformed === undefined ? {} : { typeOnlyModuleReferences: malformed }) };
    cache.write(key, { exportedNames: ["poisoned"], analysis });
    clearStaticModuleShapeCache();
    const fresh = analyzeStaticModuleShape(source, profile);
    assert.deepEqual(fresh.analysis.typeOnlyModuleReferences, ["./types.mts"]);
    assert.deepEqual(fresh.exportedNames, [`probe${index}`]);
    clearStaticModuleShapeCache();
    assert.deepEqual(analyzeStaticModuleShape(source, profile), fresh, "fresh valid filesystem entry survives a memory-cache clear");
  }
});

test("Module references: JSX attributes cannot masquerade as generic parameters", () => {
  for (const attribute of ['title=","', 'title="extends"', 'extends="value"']) {
    const source = `const n = <div ${attribute}>(import("./fake.mts")){import("./live.mts")}</div>;`;
    const lexical = analyzeStaticModuleShape(source, "src/view.tsx");
    assert.deepEqual(analyzeArchitectureSource("src/view.tsx", source).dependencies, ["src/live.mts"]);
    assert.deepEqual(lexical.analysis.moduleAcquisitions, [{ kind: "dynamic-import", specifier: "./live.mts" }]);
  }
  const source = 'const f = <T extends import("./types.mts").T>(x: T) => import("./live.mts");';
  const lexical = analyzeStaticModuleShape(source, "src/view.tsx");
  assert.deepEqual(lexical.analysis.typeOnlyModuleReferences, ["./types.mts"]);
  assert.deepEqual(lexical.analysis.moduleAcquisitions, [{ kind: "dynamic-import", specifier: "./live.mts" }]);
});

test("Module references: active TypeScript verbatim emission retains inline wrappers", () => {
  const compiler = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
  withTempDir("module-reference-emission-", (directory) => {
    writeFileSync(join(directory, "dep.mts"), 'process.stdout.write("loaded\\n"); export interface T {}');
    const forms = [
      ['import type { T } from "./dep.mts";', false],
      ['export type { T } from "./dep.mts";', false],
      ['import { type T } from "./dep.mts";', true],
      ['export { type T } from "./dep.mts";', true],
    ] as const;
    for (const [index, [source]] of forms.entries()) writeFileSync(join(directory, `entry${index}.mts`), source);
    const genericParameters = ["T extends Array<unknown>", "T = unknown,", "const T,"];
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    for (const [index, parameters] of genericParameters.entries()) writeFileSync(join(directory, `generic${index}.tsx`), `const f = <${parameters}>(x: T) => import("./dep.mts"); await f([]);`);
    const output = join(directory, "out");
    const compilation = spawnSync(process.execPath, [compiler, "--noCheck", "--verbatimModuleSyntax", "--jsx", "preserve", "--module", "nodenext", "--target", "esnext", "--rewriteRelativeImportExtensions", "--outDir", output, ...forms.map((_, index) => join(directory, `entry${index}.mts`)), ...genericParameters.map((_, index) => join(directory, `generic${index}.tsx`)), join(directory, "dep.mts")], { cwd: directory, encoding: "utf8", timeout: 30_000 });
    assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);
    for (const [index, [, loads]] of forms.entries()) {
      const execution = spawnSync(process.execPath, [join(output, `entry${index}.mjs`)], { encoding: "utf8", timeout: 10_000 });
      assert.equal(execution.status, 0, execution.stderr);
      assert.equal(execution.stdout, loads ? "loaded\n" : "");
    }
    for (const [index] of genericParameters.entries()) {
      const emitted = readFileSync(join(output, `generic${index}.jsx`), "utf8");
      const execution = spawnSync(process.execPath, ["--input-type=module", "--eval", emitted], { cwd: output, encoding: "utf8", timeout: 10_000 });
      assert.equal(execution.status, 0, execution.stderr);
      assert.equal(execution.stdout, "loaded\n", "the erased generic header must preserve its executable body");
    }
  });
});

test("Module references: nested and defaulted TSX generic arrows retain executable bodies", () => {
  for (const parameters of ["T extends Array<unknown>", "T = unknown,", "const T,"]) {
    const source = `const f = <${parameters}>(x: T) => import("./live.mts");`;
    assert.deepEqual(analyzeArchitectureSource("src/generic.tsx", source).dependencies, ["src/live.mts"]);
    assert.deepEqual(analyzeStaticModuleShape(source, "src/generic.tsx").analysis.moduleAcquisitions, [{ kind: "dynamic-import", specifier: "./live.mts" }]);
  }
});

test("Module references: independent erased-channel disagreement refuses a valid cached shape", () => {
  const host = ARCHITECTURE_MANIFEST.modules.find(module => module.path === "src/kernel/errors.ts")!;
  assert.ok(host);
  const source = 'import type { T } from "./independent-erased-target.ts";';
  const semantics = analysisSemanticsId(new URL("../../scripts/verification/static-source.ts", import.meta.url), new URL("../../src/shared/source-extensions.ts", import.meta.url));
  const key = `${host.path}\0${sha256(Buffer.from(source, "utf8"))}\0${semantics}`;
  const cache = createFilesystemCache({ directory: "harness-static-cache", maxEntries: DEFAULT_STATIC_MODULE_SHAPE_FILESYSTEM_CACHE_MAX_ENTRIES });
  const analysis = analyzeStaticSource(source, host.path);
  try {
    cache.write(key, { exportedNames: [], analysis: { ...analysis, typeOnlyModuleReferences: [] } });
    clearStaticModuleShapeCache();
    const violations = verifyArchitectureSources([{ path: host.path, source }], { ...ARCHITECTURE_MANIFEST, modules: [host] }).violations;
    assert.ok(violations.includes(`architecture-independent-type-reference-disagreement:${host.path}`));
    assert.ok(violations.includes(`architecture-unregistered-dependency:${host.path}->src/kernel/independent-erased-target.ts`));
  } finally {
    cache.write(key, { exportedNames: [], analysis });
    clearStaticModuleShapeCache();
  }
});

test("Module references: ambient ancestors erase runtime guards but retain reference census", () => {
  const forms = [
    'declare module "pkg" { import Alias = require("./absent.mts"); export = Alias; }',
    'declare namespace Ambient { export import Alias = require("./absent.mts"); export enum E { A } }',
    'declare module "pkg" { import { readFileSync } from "node:fs"; export type T = import("./absent.mts").T; }',
    'declare class Ambient { value: import("./absent.mts").T; }',
    'declare function ambient(): import("./absent.mts").T;',
    'declare const ambient: import("./absent.mts").T;',
    'module "pkg" { import Alias = require("./absent.mts"); export = Alias; }',
    'declare class Ambient<T extends { value: import("./absent.mts").T }> { value: T; }',
  ];
  withTempDir("module-reference-ambient-", (directory) => {
    writeFileSync(join(directory, "live.mts"), 'process.stdout.write("live\\n");');
    for (const [index, declaration] of forms.entries()) {
      const source = `${declaration}\nawait import("./live.mts");`;
      writeFileSync(join(directory, "entry.mts"), source);
      const execution = spawnSync(process.execPath, [join(directory, "entry.mts")], { encoding: "utf8", timeout: 10_000 });
      assert.equal(execution.status, 0, execution.stderr);
      assert.equal(execution.stdout, "live\n", `native ambient form ${index}`);
      const ast = analyzeArchitectureSource("src/ambient.mts", source);
      const lexical = analyzeStaticModuleShape(source, "src/ambient.mts");
      const erased = index === 2 ? ["node:fs", "src/absent.mts"] : ["src/absent.mts"];
      assert.deepEqual(ast.dependencies, ["src/live.mts"]);
      assert.deepEqual(ast.typeOnlyDependencies, erased);
      assert.deepEqual(ast.directEffectFacts, []);
      assert.deepEqual(lexical.analysis.moduleAcquisitions, [{ kind: "dynamic-import", specifier: "./live.mts" }]);
      assert.deepEqual([...new Set(lexical.analysis.typeOnlyModuleReferences)].sort(), erased.map(target => target.replace("src/", "./")).sort());
      assert.equal(lexical.analysis.unmodeledModuleAcquisition, false);
      assert.deepEqual(lexical.exportedNames, ast.exportedNames);
      const host = ARCHITECTURE_MANIFEST.modules.find(module => module.path === "src/kernel/errors.ts")!;
      const violations = verifyArchitectureSources([{ path: host.path, source }], { ...ARCHITECTURE_MANIFEST, modules: [host] }).violations;
      assert.ok(violations.includes(`architecture-unregistered-dependency:${host.path}->src/kernel/absent.mts`));
      assert.ok(!violations.some(violation => violation.startsWith("architecture-independent-")), JSON.stringify(violations));
    }
  });
});

test("Module references: TSX generic regex defaults retain the executable body", () => {
  withTempDir("module-reference-regex-", (directory) => {
    writeFileSync(join(directory, "live.mts"), 'process.stdout.write("live\\n");');
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    const compiler = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
    const output = join(directory, "out");
    for (const declaration of ['<T,>(x = /\\)/)', '<T,> /* gap */ (x?: T)', '<T,>(x?: T) /* gap */']) {
      const source = `const f = ${declaration} => import("./live.mts"); await f();`;
      writeFileSync(join(directory, "entry.tsx"), source);
      const compilation = spawnSync(process.execPath, [compiler, "--noCheck", "--verbatimModuleSyntax", "--jsx", "preserve", "--module", "nodenext", "--target", "esnext", "--rewriteRelativeImportExtensions", "--outDir", output, join(directory, "entry.tsx"), join(directory, "live.mts")], { cwd: directory, encoding: "utf8", timeout: 30_000 });
      assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);
      const execution = spawnSync(process.execPath, ["--input-type=module", "--eval", readFileSync(join(output, "entry.jsx"), "utf8")], { cwd: output, encoding: "utf8", timeout: 10_000 });
      assert.equal(execution.status, 0, execution.stderr);
      assert.equal(execution.stdout, "live\n");
      assert.deepEqual(analyzeArchitectureSource("src/regex.tsx", source).dependencies, ["src/live.mts"]);
      assert.deepEqual(analyzeStaticModuleShape(source, "src/regex.tsx").analysis.moduleAcquisitions, [{ kind: "dynamic-import", specifier: "./live.mts" }]);
    }
  });
});

test("Module references: actual symbol extractor member names preserve scanner admission", () => {
  const path = "src/intelligence/symbol-extractor.ts";
  const source = readFileSync(new URL("../../src/intelligence/symbol-extractor.ts", import.meta.url), "utf8");
  const module = ARCHITECTURE_MANIFEST.modules.find(entry => entry.path === path)!;
  const analysis = analyzeStaticModuleShape(source, path).analysis;
  assert.equal(analysis.unmodeledModuleAcquisition, false);
  const violations = verifyArchitectureSources([{ path, source }], { ...ARCHITECTURE_MANIFEST, modules: [module] }).violations;
  assert.ok(!violations.some(violation => violation.startsWith("architecture-independent-") || violation.startsWith("architecture-lexical-module-unmodeled:")), JSON.stringify(violations));
});

test("Architecture references: runtime wrappers preserve cycles, layers and effects", () => {
  const kernel = ARCHITECTURE_MANIFEST.modules.find(module => module.path === "src/kernel/errors.ts")!;
  const cli = ARCHITECTURE_MANIFEST.modules.find(module => module.path === "src/cli.ts")!;
  assert.ok(kernel); assert.ok(cli);
  const target = 'import { type T } from "./kernel/errors.ts"; export type U = string;';
  for (const erased of [true, false]) {
    const source = `${erased ? 'import type { U }' : 'import { type U }'} from "../cli.ts"; export type T = string;`;
    const sources = [{ path: kernel.path, source }, { path: cli.path, source: target }];
    const manifest: ArchitectureManifest = { ...ARCHITECTURE_MANIFEST, compositionRoots: EMPTY_COMPOSITION_ROOTS, modules: [
      { ...kernel, dependencies: erased ? [] : [cli.path], publicApi: { exportCount: 1, namesSha256: canonicalHash(["T"]) } },
      { ...cli, dependencies: [kernel.path], publicApi: { exportCount: 1, namesSha256: canonicalHash(["U"]) } },
    ] };
    const violations = verifyArchitectureSources(sources, manifest).violations;
    assert.equal(violations.some(value => value.startsWith("architecture-import-cycle:")), !erased);
    assert.equal(violations.includes(`architecture-reverse-layer:${kernel.path}->${cli.path}`), !erased);
    assert.equal(violations.some(value => value.startsWith("architecture-independent-")), false);
    assert.equal(violations.some(value => value.startsWith("architecture-dependency-drift:")), false);
  }
  for (const erased of [true, false]) {
    const source = erased ? 'import type { Stats } from "node:fs";' : 'import { type Stats, readFileSync } from "node:fs"; void readFileSync;';
    const violations = verifyArchitectureSources([{ path: kernel.path, source }], { ...ARCHITECTURE_MANIFEST, modules: [kernel] }).violations;
    assert.equal(violations.some(value => value.startsWith(`architecture-effect-owner:${kernel.path}:node:fs:`)), !erased);
  }
});

test("Architecture references: strip-only unsupported source refuses before registration", () => {
  const module = ARCHITECTURE_MANIFEST.modules.find(entry => entry.path === "src/kernel/errors.ts")!;
  for (const source of ['import Alias = require("../../_experiments/target.ts");', 'import Alias = Namespace.Value;', 'export = 1;', 'const value = <unknown>import("../../_experiments/target.ts");']) {
    const violations = verifyArchitectureSources([{ path: module.path, source }], { ...ARCHITECTURE_MANIFEST, modules: [module] }).violations;
    assert.ok(violations.includes(`architecture-source-parse:${module.path}`));
  }
});
