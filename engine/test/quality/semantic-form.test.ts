/**
 * THE SEMANTIC FORM OF A SOURCE FILE (src/quality/languages/semantic-form.ts):
 * each kind is read by the parser that owns it, and two versions differ in
 * form exactly when they differ in meaning — comments, whitespace, line
 * breaks and quoting are layout; an operator, a name or a value is not. A
 * kind no reader judges is said, never compared as text; a file of a judged
 * kind that does not parse is refused by name.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { semanticForm, type SemanticForm } from "../../src/quality/languages/semantic-form.ts";

const formOf = async (path: string, text: string): Promise<string> => {
  const read: SemanticForm = await semanticForm(path, text);
  assert.ok("form" in read, `${path} is a judged kind`);
  return read.form;
};

const same = async (path: string, before: string, after: string): Promise<boolean> => (await formOf(path, before)) === (await formOf(path, after));

test("TypeScript and JavaScript: comments, whitespace, line breaks, quotes and semicolons are layout; an operator, a name or a value is meaning", async () => {
  assert.equal(await same("a.ts", "const wait = 1;\nawait tick(wait);\n", "// one tick\nconst wait  =  1\n\nawait tick( wait ) /* here */\n"), true);
  assert.equal(await same("a.ts", "const name = 'x';", "const name = \"x\";"), true);
  assert.equal(await same("a.mjs", "export const a = [1, 2];", "export const a = [\n  1,\n  2,\n];"), true);
  assert.equal(await same("a.ts", "a + b;", "a - b;"), false, "an operator");
  assert.equal(await same("a.ts", "await tick(wait);", "await next(wait);"), false, "a name");
  assert.equal(await same("a.ts", "const wait = 1;", "const wait = 2;"), false, "a value");
  assert.equal(await same("a.ts", "f(a, b);", "f(b, a);"), false, "an order");
  assert.equal(await same("a.ts", "const big = 10n; // ten", "const big =  10n;"), true, "a BigInt literal has a form: layout around it is layout");
  assert.equal(await same("a.ts", "const big = 10n;", "const big = 11n;"), false, "a BigInt literal's value is meaning");
});

test("C: comments and layout are not in the form; a changed statement is", async () => {
  assert.equal(await same("guard.c", "int f(void){ return 1; }\n", "/* the one */\nint f(void)\n{\n  return 1; // one\n}\n"), true);
  assert.equal(await same("guard.c", "int f(void){ return 1; }", "int f(void){ return 2; }"), false);
  assert.equal(await same("guard.h", "#define RETRIES 3\n", "#define RETRIES 4\n"), false);
});

test("JSON is its canonical value; Markdown is NEVER a semantic change — prose runs nothing (design NH-C)", async () => {
  assert.equal(await same("a.json", "{\"b\": 1, \"a\": [1, 2]}", "{\n  \"a\": [1,2],\n  \"b\": 1\n}\n"), true);
  assert.equal(await same("a.json", "{\"a\": 1}", "{\"a\": 2}"), false);
  assert.deepEqual(await semanticForm("README.md", "names `a.ts`"), { unjudged: "Markdown runs nothing: no edit of it is a semantic change" });
});

test("TypeScript's TYPES are not meaning: an annotation, a type argument, an interface, a type alias, a type-only import or export, and an as/satisfies/! wrapper are erased before the program runs (design NH-C, correctness F-L2); what runs still is", async () => {
  assert.equal(await same("a.ts", "function f(a: number): number { return a; }", "function f(a: any): unknown { return a; }"), true, "annotations");
  assert.equal(await same("a.ts", "const m = new Map<string, number>();", "const m = new Map<number, string>();"), true, "type arguments");
  assert.equal(await same("a.ts", "interface A { x: number }\nconst a = 1;", "interface A { x: string; y: boolean }\nconst a = 1;"), true, "an interface");
  assert.equal(await same("a.ts", "type T = number;\nexport type U = T;\nconst a = 1;", "const a = 1;"), true, "type aliases");
  assert.equal(await same("a.ts", "import type { A } from './a';\nconst a = 1;", "import type { B } from './b';\nconst a = 1;"), true, "a type-only import");
  assert.equal(await same("a.ts", "const a = b as number;", "const a = b satisfies unknown;"), true, "as and satisfies");
  assert.equal(await same("a.ts", "const a = b!;", "const a = b;"), true, "a non-null assertion");
  assert.equal(await same("a.ts", "function f(a: number) { return a + 1; }", "function f(a: number) { return a + 2; }"), false, "a value that runs");
  assert.equal(await same("a.ts", "import { A } from './a';", "import { B } from './a';"), false, "a value import");
  assert.equal(await same("a.ts", "enum E { A = 1 }", "enum E { A = 2 }"), false, "an enum runs");
  assert.equal(await same("a.ts", "const a = b?.c;", "const a = b.c;"), false, "optional chaining runs");
});

test("a kind no reader judges is SAID, never compared as text; a judged kind that does not parse is REFUSED by name", async () => {
  assert.deepEqual(await semanticForm("run.sh", "echo hi\n"), { unjudged: "no reader of this repository judges a .sh file's meaning" });
  assert.deepEqual(await semanticForm("Makefile", "all:\n"), { unjudged: "no reader of this repository judges a file without an extension's meaning" });
  for (const [path, text] of [["a.ts", "const = ;"], ["a.c", "int f( { return"], ["a.json", "{"]] as const) {
    await assert.rejects(semanticForm(path, text), (error: unknown) => (error as { code?: string }).code === "semantic_form_unparsed" && (error as Error).message.startsWith(path), path);
  }
});

test("TypeScript's TYPE-ONLY MODIFIERS are not meaning: an optional `?`, an accessibility, readonly, override and a definite `!` are erased; an optional CHAIN `?.` and a parameter property's creation still run (round 13, F-L1)", async () => {
  assert.equal(await same("a.ts", "function f(x: number) { return x; }", "function f(x?: number) { return x; }"), true, "an optional parameter");
  assert.equal(await same("a.ts", "class A extends B { x = 1; m() {} }", "class A extends B { private readonly x = 1; protected override m() {} }"), true, "accessibility, readonly, override");
  assert.equal(await same("a.ts", "class A { y?: number; }", "class A { y: number; }"), true, "an optional member");
  assert.equal(await same("a.ts", "let z: number;", "let z!: number;"), true, "a definite assignment");
  assert.equal(await same("a.ts", "class A { constructor(private x: number) {} }", "class A { constructor(public x: number) {} }"), true, "a parameter property's accessibility");
  assert.equal(await same("a.ts", "const v = a.b;", "const v = a?.b;"), false, "an optional chain runs");
  assert.equal(await same("a.ts", "const v = f();", "const v = f?.();"), false, "an optional call runs");
  assert.equal(await same("a.ts", "class A { constructor(x: number) {} }", "class A { constructor(private x: number) {} }"), false, "a parameter property creates a field");
});
