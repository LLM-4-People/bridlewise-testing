import assert from "node:assert/strict";
import test from "node:test";

import { extractSymbols } from "../../src/intelligence/symbol-extractor.ts";
import { tokenizeWithPositions } from "../../src/intelligence/js-tokenizer.ts";
import { DEFAULT_SOURCE_ANALYSIS_LIMIT } from "../../src/intelligence/intelligence-config.ts";
import { initTreeSitterBackend } from "../../src/intelligence/tree-sitter-backend.ts";

await initTreeSitterBackend(["javascript", "typescript"]);

// ========== Tokenizer tests ==========

test("symbol-extractor: tokenize basic identifiers", () => {
  const tokens = tokenizeWithPositions("hello world");
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0]!.kind, "identifier");
  assert.equal(tokens[0]!.value, "hello");
  assert.equal(tokens[1]!.value, "world");
});

test("symbol-extractor: tokenize tracks line numbers", () => {
  const tokens = tokenizeWithPositions("foo\nbar\nbaz");
  const identifiers = tokens.filter((t) => t.kind === "identifier");
  assert.equal(identifiers[0]!.line, 1);
  assert.equal(identifiers[0]!.value, "foo");
  assert.equal(identifiers[1]!.line, 2);
  assert.equal(identifiers[1]!.value, "bar");
  assert.equal(identifiers[2]!.line, 3);
  assert.equal(identifiers[2]!.value, "baz");
});

test("symbol-extractor: tokenize tracks column numbers", () => {
  const tokens = tokenizeWithPositions("ab cd");
  assert.equal(tokens[0]!.column, 1);
  assert.equal(tokens[1]!.column, 4);
});

test("symbol-extractor: tokenize skips line comments", () => {
  const tokens = tokenizeWithPositions("foo // comment\nbar");
  const identifiers = tokens.filter((t) => t.kind === "identifier");
  assert.deepEqual(identifiers.map((t) => t.value), ["foo", "bar"]);
});

test("symbol-extractor: tokenize skips block comments", () => {
  const tokens = tokenizeWithPositions("foo /* comment */ bar");
  const identifiers = tokens.filter((t) => t.kind === "identifier");
  assert.deepEqual(identifiers.map((t) => t.value), ["foo", "bar"]);
});

test("symbol-extractor: tokenize handles string literals", () => {
  const tokens = tokenizeWithPositions('const x = "hello world"');
  const strings = tokens.filter((t) => t.kind === "string");
  assert.equal(strings.length, 1);
  assert.equal(strings[0]!.value, "hello world");
});

test("symbol-extractor: tokenize handles template literals", () => {
  const tokens = tokenizeWithPositions("const x = `hello`");
  const templates = tokens.filter((t) => t.kind === "template");
  assert.equal(templates.length, 1);
  assert.equal(templates[0]!.value, "hello");
});

test("symbol-extractor: tokenize handles numbers", () => {
  const tokens = tokenizeWithPositions("const x = 42");
  const numbers = tokens.filter((t) => t.kind === "number");
  assert.equal(numbers.length, 1);
  assert.equal(numbers[0]!.value, "42");
});

test("symbol-extractor: tokenize handles empty source", () => {
  const tokens = tokenizeWithPositions("");
  assert.equal(tokens.length, 0);
});

test("symbol-extractor: tokenize handles whitespace-only source", () => {
  const tokens = tokenizeWithPositions("   \n  \t  \n");
  assert.equal(tokens.length, 0);
});

test("symbol-extractor: tokenize handles unicode identifiers", () => {
  const tokens = tokenizeWithPositions("café naïve");
  const identifiers = tokens.filter((t) => t.kind === "identifier");
  assert.ok(identifiers.length >= 2);
});

test("symbol-extractor: tokenize handles nested punctuation", () => {
  const tokens = tokenizeWithPositions("a[b](c)");
  const punct = tokens.filter((t) => t.kind === "punctuation");
  assert.ok(punct.some((t) => t.value === "["));
  assert.ok(punct.some((t) => t.value === "]"));
  assert.ok(punct.some((t) => t.value === "("));
  assert.ok(punct.some((t) => t.value === ")"));
});

// ========== Function extraction ==========

test("symbol-extractor: extracts function declaration", () => {
  const result = extractSymbols("test.ts", "function foo() { return 1; }");
  const fns = result.symbols.filter((s) => s.kind === "function");
  assert.equal(fns.length, 1);
  assert.equal(fns[0]!.name, "foo");
  assert.equal(fns[0]!.exported, false);
  assert.equal(fns[0]!.async, false);
  assert.equal(fns[0]!.generator, false);
});

test("symbol-extractor: extracts async function", () => {
  const result = extractSymbols("test.ts", "async function foo() { return 1; }");
  const fns = result.symbols.filter((s) => s.kind === "function");
  assert.equal(fns.length, 1);
  assert.equal(fns[0]!.async, true);
});

test("symbol-extractor: extracts generator function", () => {
  const result = extractSymbols("test.ts", "function* foo() { yield 1; }");
  const fns = result.symbols.filter((s) => s.kind === "function");
  assert.equal(fns.length, 1);
  assert.equal(fns[0]!.generator, true);
});

test("symbol-extractor: extracts async generator function", () => {
  const result = extractSymbols("test.ts", "async function* foo() { yield 1; }");
  const fns = result.symbols.filter((s) => s.kind === "function");
  assert.equal(fns.length, 1);
  assert.equal(fns[0]!.async, true);
  assert.equal(fns[0]!.generator, true);
});

test("symbol-extractor: extracts function with parameters", () => {
  const result = extractSymbols("test.ts", "function foo(a, b, c) { return a + b + c; }");
  const fns = result.symbols.filter((s) => s.kind === "function");
  assert.equal(fns.length, 1);
  assert.ok(fns[0]!.parameterCount >= 2);
});

test("symbol-extractor: extracts exported function", () => {
  const result = extractSymbols("test.ts", "export function foo() { return 1; }");
  const fns = result.symbols.filter((s) => s.kind === "function");
  assert.equal(fns.length, 1);
  assert.equal(fns[0]!.exported, true);
  assert.equal(fns[0]!.visibility, "exported");
});

test("symbol-extractor: extracts default-exported function", () => {
  const result = extractSymbols("test.ts", "export default function foo() { return 1; }");
  assert.ok(result.exports.some((e) => e.name === "default"));
  assert.ok(result.symbols.some((s) => s.name === "foo"));
});

// ========== Class extraction ==========

test("symbol-extractor: extracts class declaration", () => {
  const result = extractSymbols("test.ts", "class Foo { bar() {} }");
  const classes = result.symbols.filter((s) => s.kind === "class");
  assert.equal(classes.length, 1);
  assert.equal(classes[0]!.name, "Foo");
});

test("symbol-extractor: extracts exported class", () => {
  const result = extractSymbols("test.ts", "export class Foo {}");
  const classes = result.symbols.filter((s) => s.kind === "class");
  assert.equal(classes.length, 1);
  assert.equal(classes[0]!.exported, true);
});

test("symbol-extractor: extracts default-exported class", () => {
  const result = extractSymbols("test.ts", "export default class Foo {}");
  assert.ok(result.exports.some((e) => e.name === "default"));
});

// ========== Interface and type extraction ==========

test("symbol-extractor: extracts interface declaration", () => {
  const result = extractSymbols("test.ts", "interface Foo { bar: string; }");
  const ifaces = result.symbols.filter((s) => s.kind === "interface");
  assert.equal(ifaces.length, 1);
  assert.equal(ifaces[0]!.name, "Foo");
});

test("symbol-extractor: extracts exported interface", () => {
  const result = extractSymbols("test.ts", "export interface Foo { bar: string; }");
  const ifaces = result.symbols.filter((s) => s.kind === "interface");
  assert.equal(ifaces.length, 1);
  assert.equal(ifaces[0]!.exported, true);
});

test("symbol-extractor: extracts type alias", () => {
  const result = extractSymbols("test.ts", "type Foo = string | number;");
  const types = result.symbols.filter((s) => s.kind === "type");
  assert.equal(types.length, 1);
  assert.equal(types[0]!.name, "Foo");
});

test("symbol-extractor: extracts exported type alias", () => {
  const result = extractSymbols("test.ts", "export type Foo = string;");
  const types = result.symbols.filter((s) => s.kind === "type");
  assert.equal(types.length, 1);
  assert.equal(types[0]!.exported, true);
});

// ========== Variable extraction ==========

test("symbol-extractor: extracts const declaration", () => {
  const result = extractSymbols("test.ts", "const foo = 42;");
  const consts = result.symbols.filter((s) => s.kind === "const");
  assert.equal(consts.length, 1);
  assert.equal(consts[0]!.name, "foo");
});

test("symbol-extractor: extracts let declaration", () => {
  const result = extractSymbols("test.ts", "let foo = 42;");
  const lets = result.symbols.filter((s) => s.kind === "let");
  assert.equal(lets.length, 1);
});

test("symbol-extractor: extracts var declaration", () => {
  const result = extractSymbols("test.ts", "var foo = 42;");
  const vars = result.symbols.filter((s) => s.kind === "var");
  assert.equal(vars.length, 1);
});

test("symbol-extractor: extracts exported const", () => {
  const result = extractSymbols("test.ts", "export const foo = 42;");
  const consts = result.symbols.filter((s) => s.kind === "const");
  assert.equal(consts.length, 1);
  assert.equal(consts[0]!.exported, true);
});

test("symbol-extractor: extracts arrow function const", () => {
  const result = extractSymbols("test.ts", "const foo = () => 42;");
  const consts = result.symbols.filter((s) => s.kind === "const");
  assert.equal(consts.length, 1);
  assert.equal(consts[0]!.name, "foo");
});

test("symbol-extractor: extracts async arrow function const", () => {
  const result = extractSymbols("test.ts", "const foo = async () => 42;");
  const consts = result.symbols.filter((s) => s.kind === "const");
  assert.equal(consts.length, 1);
  assert.equal(consts[0]!.async, true);
});

// ========== Enum and namespace ==========

test("symbol-extractor: extracts enum declaration", () => {
  const result = extractSymbols("test.ts", "enum Color { Red, Green, Blue }");
  const enums = result.symbols.filter((s) => s.kind === "enum");
  assert.equal(enums.length, 1);
  assert.equal(enums[0]!.name, "Color");
});

test("symbol-extractor: extracts exported enum", () => {
  const result = extractSymbols("test.ts", "export enum Color { Red }");
  const enums = result.symbols.filter((s) => s.kind === "enum");
  assert.equal(enums.length, 1);
  assert.equal(enums[0]!.exported, true);
});

test("symbol-extractor: extracts namespace declaration", () => {
  const result = extractSymbols("test.ts", "namespace Foo { export const bar = 1; }");
  const namespaces = result.symbols.filter((s) => s.kind === "namespace");
  assert.equal(namespaces.length, 1);
  assert.equal(namespaces[0]!.name, "Foo");
});

// ========== Import extraction ==========

test("symbol-extractor: extracts named import", () => {
  const result = extractSymbols("test.ts", 'import { foo } from "./bar.ts";');
  assert.equal(result.imports.length, 1);
  assert.equal(result.imports[0]!.specifier, "./bar.ts");
  assert.equal(result.imports[0]!.kind, "direct-import");
  assert.ok(result.imports[0]!.importedNames.includes("foo"));
});

test("symbol-extractor: extracts multiple named imports", () => {
  const result = extractSymbols("test.ts", 'import { foo, bar, baz } from "./mod.ts";');
  assert.equal(result.imports.length, 1);
  assert.ok(result.imports[0]!.importedNames.includes("foo"));
  assert.ok(result.imports[0]!.importedNames.includes("bar"));
  assert.ok(result.imports[0]!.importedNames.includes("baz"));
});

test("symbol-extractor: extracts default import", () => {
  const result = extractSymbols("test.ts", 'import foo from "./bar.ts";');
  assert.equal(result.imports.length, 1);
  assert.ok(result.imports[0]!.importedNames.includes("foo"));
});

test("symbol-extractor: extracts namespace import", () => {
  const result = extractSymbols("test.ts", 'import * as foo from "./bar.ts";');
  assert.equal(result.imports.length, 1);
  assert.equal(result.imports[0]!.specifier, "./bar.ts");
});

test("symbol-extractor: extracts side-effect import", () => {
  const result = extractSymbols("test.ts", 'import "./polyfill.ts";');
  assert.equal(result.imports.length, 1);
  assert.equal(result.imports[0]!.importedNames.length, 0);
});

test("symbol-extractor: extracts type import", () => {
  const result = extractSymbols("test.ts", 'import type { Foo } from "./types.ts";');
  assert.equal(result.imports.length, 1);
  assert.ok(result.imports[0]!.importedNames.includes("Foo"));
});

test("symbol-extractor: extracts re-export", () => {
  const result = extractSymbols("test.ts", 'export { foo } from "./bar.ts";');
  assert.equal(result.imports.length, 1);
  assert.equal(result.imports[0]!.kind, "re-export");
});

test("symbol-extractor: extracts star re-export", () => {
  const result = extractSymbols("test.ts", 'export * from "./bar.ts";');
  assert.ok(result.exports.some((e) => e.name === "*"));
});

// ========== Export extraction ==========

test("symbol-extractor: extracts named export with local name", () => {
  const result = extractSymbols("test.ts", "export const foo = 42;");
  assert.ok(result.exports.some((e) => e.name === "foo" && e.kind === "declared"));
});

test("symbol-extractor: extracts export with alias", () => {
  const result = extractSymbols("test.ts", 'export { foo as bar } from "./mod.ts";');
  assert.ok(result.exports.some((e) => e.name === "bar"));
});

// ========== Line count ==========

test("symbol-extractor: counts lines correctly", () => {
  const result = extractSymbols("test.ts", "line1\nline2\nline3");
  assert.equal(result.lineCount, 3);
});

test("symbol-extractor: single line source has 1 line", () => {
  const result = extractSymbols("test.ts", "single line");
  assert.equal(result.lineCount, 1);
});

test("symbol-extractor: empty source has 0 lines", () => {
  const result = extractSymbols("test.ts", "");
  assert.equal(result.lineCount, 0);
});

// ========== Edge cases and hostile input ==========

test("symbol-extractor: handles malformed syntax gracefully", () => {
  const result = extractSymbols("test.ts", "function {{{ { ");
  assert.ok(result.symbols.length <= 1);
});

test("symbol-extractor: handles unclosed string", () => {
  const result = extractSymbols("test.ts", 'const foo = "unclosed');
  assert.ok(result.symbols.length >= 0);
});

test("symbol-extractor: handles unclosed template", () => {
  const result = extractSymbols("test.ts", "const foo = `unclosed");
  assert.ok(result.symbols.length >= 0);
});

test("symbol-extractor: handles deeply nested code", () => {
  let source = "function foo() { ";
  for (let i = 0; i < 100; i++) source += "{ ";
  source += "return 1; ";
  for (let i = 0; i < 100; i++) source += "} ";
  source += "}";
  const result = extractSymbols("test.ts", source);
  assert.ok(result.symbols.some((s) => s.name === "foo"));
});

test("symbol-extractor: rejects non-string source", () => {
  assert.throws(() => extractSymbols("test.ts", 123 as unknown as string), /Source must be a string/);
});

test("symbol-extractor: rejects oversized source", () => {
  // Derive the boundary from the config owner; one byte over the configured limit must throw the typed
  // error with the stable code.
  const huge = "x".repeat(DEFAULT_SOURCE_ANALYSIS_LIMIT + 1);
  assert.throws(
    () => extractSymbols("test.ts", huge),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "intelligence_source_oversized",
  );
});

test("symbol-extractor: deduplicates symbols at same location", () => {
  const result = extractSymbols("test.ts", "function foo() {}\nfunction foo() {}");
  const fns = result.symbols.filter((s) => s.name === "foo" && s.kind === "function");
  assert.equal(fns.length, 2);
  assert.notEqual(fns[0]!.location.line, fns[1]!.location.line);
});

test("symbol-extractor: handles code with decorators", () => {
  const result = extractSymbols("test.ts", "@Component() class Foo {}");
  assert.ok(result.symbols.some((s) => s.name === "Foo"));
});

test("symbol-extractor: handles generic type parameters", () => {
  const result = extractSymbols("test.ts", "function foo<T>(x: T): T { return x; }");
  assert.ok(result.symbols.some((s) => s.name === "foo"));
});

test("symbol-extractor: handles multiple declarations", () => {
  const source = `
    function foo() {}
    class Bar {}
    interface Baz {}
    type Qux = string;
    const quux = 42;
    export function exported() {}
  `;
  const result = extractSymbols("test.ts", source);
  assert.ok(result.symbols.length >= 6);
  assert.ok(result.symbols.some((s) => s.name === "foo"));
  assert.ok(result.symbols.some((s) => s.name === "Bar"));
  assert.ok(result.symbols.some((s) => s.name === "Baz"));
  assert.ok(result.symbols.some((s) => s.name === "Qux"));
  assert.ok(result.symbols.some((s) => s.name === "quux"));
  assert.ok(result.symbols.some((s) => s.name === "exported" && s.exported));
});

test("symbol-extractor: tracks symbol location line", () => {
  const source = "line1\nline2\nfunction foo() {}";
  const result = extractSymbols("test.ts", source);
  const foo = result.symbols.find((s) => s.name === "foo");
  assert.ok(foo);
  assert.equal(foo!.location.line, 3);
});

test("symbol-extractor: handles import.meta correctly", () => {
  const result = extractSymbols("test.ts", "const url = import.meta.url;");
  assert.equal(result.imports.length, 0);
});

test("symbol-extractor: handles type-only export", () => {
  const result = extractSymbols("test.ts", "export type { Foo } from \"./types.ts\";");
  assert.ok(result.imports.length >= 0);
});
