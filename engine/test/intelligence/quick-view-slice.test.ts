import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { FileSliceIndex } from "../../src/intelligence/file-slice.ts";
import { QuickViewIndex, extractNameFromQuery } from "../../src/intelligence/quick-view.ts";
import { createToolRegistry, type ToolContext } from "../../src/runtime/tool-registry.ts";
import { createTempDir } from "../support/temp-dir.ts";

/**
 * EXP441 — quick_view + slice + viewport + skeleton tests (the AST-based
 * replacements for grep + read_file).
 *
 * Covers:
 * - quick_view finds definitions, callers, type refs, test calls, docs.
 * - slice returns the function body + signature + callers.
 * - viewport returns a bounded line window.
 * - skeleton returns one-line-per-declaration structure.
 * - parse failure → typed blocker (no silent downgrade).
 * - unsupported extension → typed blocker (read_file fallback).
 * - privacy: slice/viewport redact secrets (same path as read_file).
 * - extractNameFromQuery: backticked, CamelCase, camelCase, fallback.
 * - the new tools are registered by createToolRegistry.
 */

function setupRepo(): string {
  const root = createTempDir("exp441-");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(
    join(root, "src", "math.ts"),
    [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "export function multiply(a: number, b: number): number {",
      "  return a * b;",
      "}",
      ("export const SECRET_TOKEN = \"sk" + "_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\";"),
      "export class Calculator {",
      "  add(a: number, b: number): number { return add(a, b); }",
      "  mul(a: number, b: number): number { return multiply(a, b); }",
      "}",
      "export type CalcResult = { value: number };",
      "export interface CalcOptions { verbose: boolean }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "app.ts"),
    [
      'import { add, Calculator, type CalcOptions } from "./math.ts";',
      "export function runApp(x: number): number {",
      "  const calc = new Calculator();",
      "  return calc.add(x, add(1, 2));",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "test", "math.test.ts"),
    [
      'import { add } from "../src/math.ts";',
      'import test from "node:test";',
      "test(\"add works\", () => {",
      "  if (add(1, 2) !== 3) throw new Error(\"fail\");",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "docs", "math.md"),
    [
      "# Math module",
      "The `add` function adds two numbers. The `Calculator` class wraps it.",
      "See `multiply` for the product.",
      "",
    ].join("\n"),
  );
  return root;
}

test("quick_view: finds definition + callers + type refs + tests + docs", () => {
  const root = setupRepo();
  try {
    const idx = new QuickViewIndex(root);
    const result = idx.query("add");
    assert.equal(result.name, "add");
    assert.ok(result.totals.definition >= 1, `definition: ${result.totals.definition}`);
    assert.ok(result.totals.callers >= 1, `callers: ${result.totals.callers}`);
    assert.ok(result.totals.tests >= 1, `tests: ${result.totals.tests}`);
    assert.ok(result.totals.docs >= 1, `docs: ${result.totals.docs}`);
    const defFile = result.view.definition[0]?.file ?? "";
    assert.equal(defFile, "src/math.ts");
    const caller = result.view.callers.find((c) => c.file === "src/app.ts");
    assert.ok(caller !== undefined, "must find the caller in src/app.ts");
    const testCall = result.view.tests[0];
    assert.ok(testCall !== undefined && testCall.file === "test/math.test.ts");
    const doc = result.view.docs[0];
    assert.ok(doc !== undefined && doc.file === "docs/math.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quick_view: returns the index summary with file/function counts", () => {
  const root = setupRepo();
  try {
    const idx = new QuickViewIndex(root);
    const summary = idx.getSummary();
    assert.ok(summary.srcFiles >= 2);
    assert.ok(summary.testFiles >= 1);
    assert.ok(summary.docFiles >= 1);
    assert.ok(summary.srcFunctions >= 4);
    assert.ok(summary.parseErrors === 0, `parseErrors: ${summary.parseErrors}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quick_view: missing symbol returns empty totals (not an error)", () => {
  const root = setupRepo();
  try {
    const idx = new QuickViewIndex(root);
    const result = idx.query("doesNotExist");
    assert.equal(result.totals.definition, 0);
    assert.equal(result.totals.callers, 0);
    assert.equal(result.totals.docs, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quick_view: rejects empty name", () => {
  const root = setupRepo();
  try {
    const idx = new QuickViewIndex(root);
    assert.throws(() => idx.query(""), /name must be a non-empty string/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quick_view: rejects empty root", () => {
  assert.throws(() => new QuickViewIndex(""), /root must be a non-empty string/);
});

test("slice: returns the function body + signature + callers", () => {
  const root = setupRepo();
  try {
    const idx = new FileSliceIndex(root);
    // `add` is both a top-level function and a Calculator method; hint the
    // top-level function file.
    const result = idx.slice("add", "src/math.ts");
    assert.equal(result.tool, "slice");
    assert.equal(result.name, "add");
    assert.equal(result.file, "src/math.ts");
    assert.ok(result.slice.includes("function add"));
    assert.ok(result.slice.includes("return a + b"));
    assert.ok(result.callers.length >= 1, "must list at least one caller");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("slice: returns a class method body when hinted", () => {
  const root = setupRepo();
  try {
    const idx = new FileSliceIndex(root);
    // `mul` is the Calculator.mul method — slice finds the method body
    // (which calls the top-level multiply).
    const mul = idx.slice("mul", "src/math.ts");
    assert.equal(mul.name, "mul");
    assert.ok(mul.slice.includes("return multiply(a, b)"), `got: ${mul.slice}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("slice: ambiguous name without file hint is a typed error", () => {
  const root = setupRepo();
  try {
    // Add a SECOND top-level `add` in app.ts to make the name ambiguous.
    writeFileSync(
      join(root, "src", "extra.ts"),
      ["export function add(a: number, b: number): number { return a - b; }", ""].join("\n"),
    );
    const idx = new FileSliceIndex(root);
    assert.throws(() => idx.slice("add", null), /ambiguous/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("slice: file hint disambiguates", () => {
  const root = setupRepo();
  try {
    const idx = new FileSliceIndex(root);
    const result = idx.slice("add", "src/math.ts");
    assert.equal(result.file, "src/math.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("slice: missing name is a typed error (not a silent empty slice)", () => {
  const root = setupRepo();
  try {
    const idx = new FileSliceIndex(root);
    assert.throws(() => idx.slice("doesNotExist", null), /function 'doesNotExist' not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("slice: unsupported extension is a typed blocker (read_file fallback)", () => {
  const root = setupRepo();
  try {
    writeFileSync(join(root, "data.bin"), "\x00\x01\x02\x03");
    const idx = new FileSliceIndex(root);
    assert.throws(
      () => idx.slice("add", "data.bin"),
      /unsupported extension for slice \(use read_file fallback\)/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("slice: absolute path is a security error", () => {
  const root = setupRepo();
  try {
    const idx = new FileSliceIndex(root);
    assert.throws(() => idx.slice("add", "/etc/passwd"), /absolute paths are forbidden/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("slice: traversal path is a security error", () => {
  const root = setupRepo();
  try {
    const idx = new FileSliceIndex(root);
    assert.throws(() => idx.slice("add", "../escape.ts"), /path traversal is forbidden/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("viewport: returns a bounded line window", () => {
  const root = setupRepo();
  try {
    const idx = new FileSliceIndex(root);
    const result = idx.viewport("src/math.ts", 2, 4);
    assert.equal(result.tool, "viewport");
    assert.equal(result.file, "src/math.ts");
    assert.equal(result.startLine, 2);
    assert.equal(result.endLine, 4);
    assert.ok(result.viewport.includes("return a + b"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("viewport: clamps to file bounds", () => {
  const root = setupRepo();
  try {
    const idx = new FileSliceIndex(root);
    const result = idx.viewport("src/math.ts", 1, 1000);
    assert.ok(result.endLine <= result.totalLines);
    assert.equal(result.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("viewport: rejects inverted range", () => {
  const root = setupRepo();
  try {
    const idx = new FileSliceIndex(root);
    assert.throws(() => idx.viewport("src/math.ts", 5, 2), /endLine must be >= startLine/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skeleton: returns one line per top-level declaration", () => {
  const root = setupRepo();
  try {
    const idx = new FileSliceIndex(root);
    const result = idx.skeleton("src/math.ts");
    assert.equal(result.tool, "skeleton");
    assert.ok(result.declarationCount >= 5, `decls: ${result.declarationCount}`);
    const names = result.declarations.map((d) => d.name);
    assert.ok(names.includes("add"));
    assert.ok(names.includes("multiply"));
    assert.ok(names.includes("Calculator"));
    assert.ok(names.includes("SECRET_TOKEN"));
    assert.ok(names.includes("CalcResult"));
    assert.ok(names.includes("CalcOptions"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skeleton: parse failure is a typed blocker", () => {
  const root = setupRepo();
  try {
    writeFileSync(join(root, "src", "broken.ts"), "export function broken( { return ;");
    const idx = new FileSliceIndex(root);
    assert.throws(() => idx.skeleton("src/broken.ts"), /parse failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createToolRegistry: quick_view tool redacts secrets in context/text fields", () => {
  const root = setupRepo();
  try {
    const registry = createToolRegistry();
    const ctx: ToolContext = { repositoryRoot: root };
    const result = registry.execute(
      { id: "qv-1", name: "quick_view", arguments: JSON.stringify({ name: "SECRET_TOKEN" }) },
      ctx,
    );
    assert.equal(result.isError, false, `quick_view failed: ${result.content}`);
    const parsed = JSON.parse(result.content) as { view: { definition: unknown[]; docs: unknown[] } };
    const serialized = JSON.stringify(parsed);
    assert.equal(serialized.includes(("sk" + "_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")), false, "raw sk_ token must not egress via quick_view");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createToolRegistry: slice tool redacts secrets in the slice", () => {
  const root = setupRepo();
  try {
    const registry = createToolRegistry();
    const ctx: ToolContext = { repositoryRoot: root };
    const result = registry.execute(
      { id: "sl-1", name: "slice", arguments: JSON.stringify({ name: "SECRET_TOKEN", file: "src/math.ts" }) },
      ctx,
    );
    assert.equal(result.isError, false, `slice failed: ${result.content}`);
    const parsed = JSON.parse(result.content) as { slice: string };
    assert.equal(parsed.slice.includes(("sk" + "_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")), false, "raw sk_ token must not egress via slice");
    assert.ok(parsed.slice.includes("[REDACTED"), `expected a redaction marker; got: ${parsed.slice}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createToolRegistry: viewport tool redacts secrets", () => {
  const root = setupRepo();
  try {
    const registry = createToolRegistry();
    const ctx: ToolContext = { repositoryRoot: root };
    const result = registry.execute(
      { id: "vp-1", name: "viewport", arguments: JSON.stringify({ path: "src/math.ts", startLine: 6, endLine: 8 }) },
      ctx,
    );
    assert.equal(result.isError, false, `viewport failed: ${result.content}`);
    const parsed = JSON.parse(result.content) as { viewport: string };
    assert.equal(parsed.viewport.includes(("sk" + "_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")), false, "raw sk_ token must not egress via viewport");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createToolRegistry: skeleton tool returns structure", () => {
  const root = setupRepo();
  try {
    const registry = createToolRegistry();
    const ctx: ToolContext = { repositoryRoot: root };
    const result = registry.execute(
      { id: "sk-1", name: "skeleton", arguments: JSON.stringify({ path: "src/math.ts" }) },
      ctx,
    );
    assert.equal(result.isError, false, `skeleton failed: ${result.content}`);
    const parsed = JSON.parse(result.content) as { skeleton: string; declarationCount: number };
    assert.ok(parsed.declarationCount >= 5);
    assert.ok(parsed.skeleton.includes("add"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createToolRegistry: quick_view accepts a natural-language description", () => {
  const root = setupRepo();
  try {
    const registry = createToolRegistry();
    const ctx: ToolContext = { repositoryRoot: root };
    const result = registry.execute(
      { id: "qv-nl", name: "quick_view", arguments: JSON.stringify({ name: "where is the Calculator class used" }) },
      ctx,
    );
    assert.equal(result.isError, false, `quick_view NL failed: ${result.content}`);
    const parsed = JSON.parse(result.content) as { name: string; totals: { definition: number } };
    assert.equal(parsed.name, "Calculator");
    assert.ok(parsed.totals.definition >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractNameFromQuery: backticked name wins", () => {
  assert.equal(extractNameFromQuery("find `myFunc` in the code"), "myFunc");
});

test("extractNameFromQuery: CamelCase fallback", () => {
  assert.equal(extractNameFromQuery("where is ToolRegistry defined"), "ToolRegistry");
});

test("extractNameFromQuery: camelCase fallback", () => {
  assert.equal(extractNameFromQuery("show me createToolRegistry"), "createToolRegistry");
});

test("extractNameFromQuery: returns null for empty input", () => {
  assert.equal(extractNameFromQuery(""), null);
  assert.equal(extractNameFromQuery(null as unknown as string), null);
});
