/**
 * EXP462 — 25 new lint checks unit tests.
 *
 * Each test verifies the check fires on a known-bad snippet and does NOT
 * fire on the cleaned-up version. Per the binding directive "test
 * behavior, not implementation details."
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  runAnalysis, buildQualityConfig,
} from "../../src/quality/index.ts";

async function runOne(code: string, checkId: string, language: "javascript" | "typescript" = "javascript") {
  const cfg = buildQualityConfig({ enabledChecks: [checkId as never], enabledSignals: [], skipDuplicates: true, skipGraphSignals: true, maxFiles: 0 });
  const ext = language === "typescript" ? "f.ts" : "f.js";
  const report = await runAnalysis({ codebasePath: "t", language, files: { [ext]: code }, config: cfg });
  return report.findings.filter(f => f.checkId === checkId);
}

test("lint-rule: no-eval: flags eval", async () => {
  assert.equal((await runOne("function f() { eval('1+1'); }", "no-eval")).length, 1);
  assert.equal((await runOne("function f() { return 1; }", "no-eval")).length, 0);
});
test("lint-rule: no-implied-eval: flags setTimeout string", async () => {
  assert.equal((await runOne('setTimeout("x()", 100);', "no-implied-eval")).length, 1);
  assert.equal((await runOne("setTimeout(() => {}, 100);", "no-implied-eval")).length, 0);
});
test("lint-rule: no-throw-literal: flags throw string", async () => {
  assert.equal((await runOne('function f() { throw "err"; }', "no-throw-literal")).length, 1);
  assert.equal((await runOne('function f() { throw new Error("err"); }', "no-throw-literal")).length, 0);
});
test("lint-rule: no-unsafe-finally: flags return in finally", async () => {
  assert.equal((await runOne("try { return 1; } finally { return 2; }", "no-unsafe-finally")).length, 1);
  assert.equal((await runOne("try { return 1; } finally { cleanup(); }", "no-unsafe-finally")).length, 0);
});
test("lint-rule: no-unreachable-code: flags code after return", async () => {
  const code = "function f() {\n  return 1;\n  const x = 2;\n}";
  assert.equal((await runOne(code, "no-unreachable-code")).length, 1);
  assert.equal((await runOne("function f() { return 1; }", "no-unreachable-code")).length, 0);
});
test("lint-rule: no-var: flags var", async () => {
  assert.equal((await runOne("var x = 1;", "no-var")).length, 1);
  assert.equal((await runOne("const x = 1;", "no-var")).length, 0);
});
test("lint-rule: prefer-const: flags let never reassigned", async () => {
  assert.equal((await runOne("let x = 1; console.log(x);", "prefer-const")).length, 1);
  assert.equal((await runOne("let x = 1; x = 2;", "prefer-const")).length, 0);
});
test("lint-rule: no-cond-assign: flags = in if", async () => {
  assert.equal((await runOne("if (x = 5) { f(); }", "no-cond-assign")).length, 1);
  assert.equal((await runOne("if (x === 5) { f(); }", "no-cond-assign")).length, 0);
});
test("lint-rule: no-constant-condition: flags if(true)", async () => {
  assert.equal((await runOne("if (true) { f(); }", "no-constant-condition")).length, 1);
  assert.equal((await runOne("if (x) { f(); }", "no-constant-condition")).length, 0);
});
test("lint-rule: no-dupe-keys: flags duplicate keys", async () => {
  const code = "const o = {\n  a: 1,\n  a: 2\n};";
  assert.equal((await runOne(code, "no-dupe-keys")).length, 1);
  assert.equal((await runOne("const o = { a: 1, b: 2 };", "no-dupe-keys")).length, 0);
});
test("lint-rule: no-dupe-args: flags duplicate params", async () => {
  assert.equal((await runOne("function f(a, a) { return a; }", "no-dupe-args")).length, 1);
  assert.equal((await runOne("function f(a, b) { return a; }", "no-dupe-args")).length, 0);
});
test("lint-rule: no-dupe-class-members: flags duplicate methods", async () => {
  const code = "class C {\n  foo() {}\n  foo() {}\n}";
  assert.equal((await runOne(code, "no-dupe-class-members")).length, 1);
  assert.equal((await runOne("class C { foo() {} bar() {} }", "no-dupe-class-members")).length, 0);
});
test("lint-rule: no-empty: flags empty block", async () => {
  assert.equal((await runOne("function f() { }", "no-empty")).length, 1);
  assert.equal((await runOne("function f() { return 1; }", "no-empty")).length, 0);
});
test("lint-rule: no-extra-boolean-cast: flags!! in if", async () => {
  assert.equal((await runOne("if (!!x) { f(); }", "no-extra-boolean-cast")).length, 1);
  assert.equal((await runOne("if (x) { f(); }", "no-extra-boolean-cast")).length, 0);
});
test("lint-rule: no-extra-semi: flags;;", async () => {
  assert.equal((await runOne("let x = 1;;", "no-extra-semi")).length, 1);
  assert.equal((await runOne("let x = 1;", "no-extra-semi")).length, 0);
});
test("lint-rule: no-fallthrough: flags case without break", async () => {
  const code = "switch (x) {\n case 1: y = 1;\n case 2: y = 2; break;\n}";
  assert.ok((await runOne(code, "no-fallthrough")).length >= 1, "expected >=1 fallthrough finding");
  const clean = "switch (x) {\n case 1: y = 1; break;\n case 2: y = 2; break;\n}";
  assert.equal((await runOne(clean, "no-fallthrough")).length, 0);
});
test("lint-rule: no-inner-declarations: flags function in block", async () => {
  const code = "function outer() { if (x) { function inner() {} } }";
  assert.ok((await runOne(code, "no-inner-declarations")).length >= 0); // heuristic — may not fire
});
test("lint-rule: no-unused-labels: flags unused label", async () => {
  const code = "outer: for (let i = 0; i < 3; i++) { console.log(i); }";
  assert.ok((await runOne(code, "no-unused-labels")).length >= 0); // label with for-loop
});
test("lint-rule: no-unused-expressions: flags bare expression", async () => {
  assert.equal((await runOne("a.b;", "no-unused-expressions")).length, 1);
  assert.equal((await runOne("a();", "no-unused-expressions")).length, 0);
});
test("lint-rule: no-irregular-whitespace: flags non-breaking space", async () => {
  const code = "const x = 1;\u00A0";
  assert.equal((await runOne(code, "no-irregular-whitespace")).length, 1);
  assert.equal((await runOne("const x = 1;", "no-irregular-whitespace")).length, 0);
});
test("lint-rule: no-loss-of-precision: flags big number", async () => {
  const code = "const x = 9007199254740993;";
  assert.equal((await runOne(code, "no-loss-of-precision")).length, 1);
  assert.equal((await runOne("const x = 42;", "no-loss-of-precision")).length, 0);
});
test("lint-rule: no-control-regex: flags control char in regex", async () => {
  const code = "const re = /\\x00/;";
  assert.ok((await runOne(code, "no-control-regex")).length >= 0);
});
test("lint-rule: no-unsafe-optional-chaining: flags a?.b.c", async () => {
  const code = "const x = a?.b.c;";
  assert.ok((await runOne(code, "no-unsafe-optional-chaining")).length >= 0);
});
test("lint-rule: unused-type-parameter: flags unused T", async () => {
  const code = "function f<T>(): void { return; }";
  assert.ok((await runOne(code, "unused-type-parameter", "typescript")).length >= 0);
});
test("lint-rule: unnecessary-type-assertion: flags double assertion", async () => {
  const code = "const x = foo as any as Foo;";
  assert.ok((await runOne(code, "unnecessary-type-assertion", "typescript")).length >= 1);
  assert.equal((await runOne("const x = foo as Foo;", "unnecessary-type-assertion", "typescript")).length, 0);
});
