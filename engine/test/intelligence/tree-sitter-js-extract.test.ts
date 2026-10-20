/**
 * JS/TS extract is tree-sitter, not the tokenizer. An unready parser
 * cannot succeed as an empty map.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import { HarnessError, InputError } from "../../src/kernel/errors.ts";
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

test("a parsed file with no definitions still returns an empty extraction", async () => {
  await initTreeSitterBackend(["javascript"]);
  // The file WAS parsed and measured: zero symbols is a real zero here,
  // unlike the parse-failure refusal below.
  const result = extractSymbolsTreeSitter("comments.js", "// only a comment\n");
  assert.equal(result.symbols.length, 0);
  assert.equal(result.imports.length, 0);
  assert.equal(result.lineCount, 2, "the measured line count must survive an empty symbol list");
});

test("a failing tree-sitter parse is a typed refusal, never an empty extraction", async () => {
  // Plant: a grammar object from an incompatible runtime. The real backend's
  // setLanguage rejects it inside `parseSync` — the backend `:258` throw
  // point named in the defect, now covered by the parse guard — so
  // `parseSync` throws without any production test seam. A thrown parse must
  // NOT become `emptyResult`: "not measured" is not "measured zero".
  const web = await import("web-tree-sitter");
  const Parser = web.default as unknown as { init(): Promise<void>; Language: unknown };
  await Parser.init();
  const realLanguage = Parser.Language;
  class UnusableLanguage {
    static async load(): Promise<unknown> {
      return Object.freeze({ unusable: true });
    }
  }
  Parser.Language = UnusableLanguage;
  try {
    await initTreeSitterBackend(["go"]);
    let result: { symbols: readonly unknown[]; lineCount: number } | null = null;
    let thrown: unknown = null;
    try {
      result = extractSymbolsTreeSitter("probe.go", "package main\nfunc F() {}\n");
    } catch (error) {
      thrown = error;
    }
    assert.ok(
      thrown !== null,
      `a failed parse must refuse; the extractor returned ${result?.symbols.length ?? 0} symbols (lineCount ${result?.lineCount ?? 0})`,
    );
    assert.ok(thrown instanceof HarnessError, "the refusal must be a typed HarnessError");
    assert.equal((thrown as HarnessError).code, "tree_sitter_parse_failed");
    assert.match((thrown as Error).message, /probe\.go/u);
    assert.match((thrown as Error).message, /'go'/u);
    const cause = (thrown as { cause?: unknown }).cause;
    assert.ok(cause instanceof Error, "the backend error must be carried as `cause`");
    assert.match((cause as Error).message, /Argument must be a Language/u);

    // The refusal travels through the public door and the repository map:
    // neither may turn a failed parse into a zero-symbol module.
    assert.throws(
      () => extractSymbols("probe.go", "package main\nfunc F() {}\n"),
      (err: unknown) => err instanceof HarnessError && err.code === "tree_sitter_parse_failed",
      "extractSymbols must propagate the parse refusal",
    );
    const goFile: FileInfo = Object.freeze({
      path: "probe.go",
      extension: ".go",
      sizeBytes: 26,
      contentHash: "x",
      lineCount: 3,
      isSource: true,
    });
    const reader: RepositoryReaderPort = {
      listFiles: () => [goFile],
      readFile: () => ({ content: "package main\nfunc F() {}\n", sizeBytes: 26, contentHash: "x" }),
    };
    assert.throws(
      () => generateRepositoryMap(".", { reader }),
      (err: unknown) => err instanceof HarnessError && err.code === "tree_sitter_parse_failed",
      "generateRepositoryMap must refuse, not skip the file",
    );
  } finally {
    Parser.Language = realLanguage;
  }
});
