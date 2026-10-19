/**
 * JS/TS extract is tree-sitter, not the tokenizer. An unready parser
 * cannot succeed as an empty map.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import { InputError } from "../../src/kernel/errors.ts";
import { extractSymbols } from "../../src/intelligence/symbol-extractor.ts";
import { tokenizeWithPositions } from "../../src/intelligence/js-tokenizer.ts";
import { generateRepositoryMap, type RepositoryReaderPort } from "../../src/intelligence/repository-map.ts";
import { initTreeSitterBackend, initTreeSitterForExtract, isLanguageReady, TREE_SITTER_LANGUAGE_NOT_INITIALIZED } from "../../src/intelligence/tree-sitter-backend.ts";
import { extractSymbolsTreeSitter } from "../../src/intelligence/tree-sitter-extractor.ts";
import type { FileInfo } from "../../src/intelligence/intelligence-types.ts";

const FIXTURE = `
export async function foo(a: number) {
  return a;
}
export class Box {
  bar(x: string, y: string) {
    return x + y;
  }
}
`;

test("unready tree-sitter language cannot succeed as an empty map", () => {
  assert.equal(isLanguageReady("python"), false);
  assert.throws(
    () => extractSymbols("probe.py", "def f():\n  pass\n"),
    (err: unknown) =>
      err instanceof InputError && err.code === TREE_SITTER_LANGUAGE_NOT_INITIALIZED,
  );
  assert.throws(
    () => extractSymbolsTreeSitter("probe.py", "def f():\n  pass\n"),
    (err: unknown) =>
      err instanceof InputError && err.code === TREE_SITTER_LANGUAGE_NOT_INITIALIZED,
  );
});

test("generateRepositoryMap does not skip unready tree-sitter files", () => {
  const python: FileInfo = Object.freeze({
    path: "probe.py",
    extension: ".py",
    sizeBytes: 16,
    contentHash: "x",
    lineCount: 2,
    isSource: true,
  });
  let reads = 0;
  const reader: RepositoryReaderPort = {
    listFiles: () => [python],
    readFile: () => {
      reads += 1;
      return { content: "def f():\n  pass\n", sizeBytes: 16, contentHash: "x" };
    },
  };
  assert.throws(
    () => generateRepositoryMap(".", { reader }),
    (err: unknown) =>
      err instanceof InputError && err.code === TREE_SITTER_LANGUAGE_NOT_INITIALIZED,
  );
  assert.equal(reads, 0, "must fail closed before extract, not skip after a throw");
});

test("farm-child registers IPC before extract init (no top-level await)", () => {
  const src = readFileSync(new URL("../../src/intelligence/farm-child.ts", import.meta.url), "utf8");
  const listener = src.indexOf('process.on("message"');
  const initAwait = src.indexOf("await initTreeSitterForExtract");
  assert.ok(listener >= 0, "farm-child must listen for IPC");
  assert.ok(initAwait > listener, "init must run on the init message, not at import");
});

test("concurrent initTreeSitterForExtract waits for in-flight load", async () => {
  await Promise.all([
    initTreeSitterForExtract(["javascript"]),
    initTreeSitterForExtract(["javascript", "typescript"]),
  ]);
  assert.equal(isLanguageReady("javascript"), true);
  assert.equal(isLanguageReady("typescript"), true);
});

test("JS/TS tree-sitter extract yields symbols; tokenizer param over-count does not win", async () => {
  await initTreeSitterBackend(["typescript"]);
  assert.equal(isLanguageReady("typescript"), true);
  const result = extractSymbols("fixture.ts", FIXTURE);
  assert.ok(result.symbols.length > 0, "silent empty map");
  const foo = result.symbols.find((s) => s.name === "foo" && s.kind === "function");
  assert.ok(foo !== undefined, "function foo missing");
  assert.equal(foo!.parameterCount, 1, "tree-sitter must count one typed param, not tokenizer tokens");
  assert.ok(
    result.symbols.some((s) => s.name === "bar"),
    "class method bar must be recovered (tokenizer missed methods)",
  );
  // Mutation: a tokenizer-only param walk over-counts `a` and `number`.
  const tokens = tokenizeWithPositions("function foo(a: number) { return a; }");
  const identInParams = tokens.filter((t) => t.kind === "identifier").length;
  assert.ok(identInParams > 1, "tokenizer still sees extra identifiers — over-count is the defect");
  assert.ok(foo!.parameterCount < identInParams);
});

test("python extract uses tree-sitter through the same extractSymbols door", async () => {
  await initTreeSitterForExtract(["python"]);
  assert.equal(isLanguageReady("python"), true);
  const result = extractSymbols("mod.py", "def greet(name):\n    return name\n");
  assert.ok(result.symbols.some((s) => s.name === "greet" && s.kind === "function"));
});
