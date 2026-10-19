/**
 * EXP467 regression test — DRY fix for `stripCommentsAndStrings` (EXP462 #5).
 *
 * Root cause: `security-hotspot.ts` carried a local `stripCommentsAndStrings`
 * that duplicated `./shared.ts`'s version, but with extra single-line block
 * comment (`/*... *\/`) handling that shared.ts lacked. EXP462 extracted the
 * shared helper but did NOT migrate security-hotspot.ts (to avoid changing
 * existing check behavior). EXP467 merges the block-comment handling into
 * shared.ts and makes security-hotspot.ts import it. This test verifies the
 * merged function is behavior-identical to the old local copy on every case
 * the security-hotspot check relies on (so the check's findings do not
 * regress).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { stripCommentsAndStrings, stripCommentsOnly } from "../../src/quality/checks/shared.ts";

test("shared-strip: string literals are removed (code kept)", () => {
  assert.equal(stripCommentsAndStrings('SHA1 = "sha1"'), "SHA1 = ");
  assert.equal(stripCommentsAndStrings("let x = 'hello'"), "let x = ");
  assert.equal(stripCommentsAndStrings("const t = `tmpl`"), "const t = ");
});

test("shared-strip: line comments // drop rest of line", () => {
  assert.equal(stripCommentsAndStrings("x = 1 // comment"), "x = 1 ");
  assert.equal(stripCommentsAndStrings("// only comment"), "");
});

test("shared-strip: python/shell # comments drop rest of line", () => {
  assert.equal(stripCommentsAndStrings("y = 2 # py comment"), "y = 2 ");
  assert.equal(stripCommentsAndStrings("# only"), "");
});

test("shared-strip: single-line block comments /*... */ are dropped (the case security-hotspot needed)", () => {
  // This is the case the old local copy handled and shared.ts did NOT.
  // The merge must preserve it so security-hotspot findings don't regress.
  assert.equal(stripCommentsAndStrings("z /* block */ w"), "z  w");
  assert.equal(stripCommentsAndStrings("a /* no close"), "a ");
  assert.equal(stripCommentsAndStrings("/* start */ code /* end */"), " code ");
});

test("shared-strip: string wins over block-comment chars (no false stripping)", () => {
  // A string literal containing `/*` must NOT be treated as a block comment.
  assert.equal(stripCommentsAndStrings('x = "/* not a block */" y'), "x =  y");
});

test("shared-strip: escapes inside strings are handled", () => {
  assert.equal(stripCommentsAndStrings("const s = 'it\\'s ok'; code"), "const s = ; code");
  assert.equal(stripCommentsAndStrings('const s = "a\\"b"; code'), "const s = ; code");
});

test("shared-strip: empty + no-comment input passthrough", () => {
  assert.equal(stripCommentsAndStrings(""), "");
  assert.equal(stripCommentsAndStrings("plain code no comments"), "plain code no comments");
});

test("shared-strip: the security-hotspot SHA1-in-comment case is correctly NOT flagged", () => {
  // Redis has `printf("SHA1=")` — that's printing a label, not using SHA1.
  // The strip must remove the string so the \bSHA1\b pattern doesn't match.
  const stripped = stripCommentsAndStrings('printf("SHA1=")');
  assert.ok(!/\bSHA1\b/.test(stripped),
    "SHA1 inside a string literal must be stripped (no false positive)");
});

test("shared-strip: stripCommentsOnly keeps strings (for no-throw-literal, no-implied-eval)", () => {
  // stripCommentsOnly is the complement: it removes comments but KEEPS strings,
  // so checks that need to see string literals (e.g. `throw "msg"`) still work.
  assert.equal(stripCommentsOnly('x = "kept" // gone'), 'x = "kept" ');
  assert.equal(stripCommentsOnly("# comment gone"), "");
  assert.ok(stripCommentsOnly('throw "literal"').includes('"literal"'),
    "stripCommentsOnly must keep string literals");
});

test("shared-strip: security-hotspot.ts now imports from shared.ts (single owner)", () => {
  // Read the security-hotspot source and assert no local definition remains.
  const src = readFileSync(
    resolve("src/quality/checks/security-hotspot.ts"),
    "utf8",
  );
  assert.ok(!/function stripCommentsAndStrings/.test(src),
    "security-hotspot.ts must NOT define its own stripCommentsAndStrings (DRY)");
  assert.ok(/from "\.\/shared\.ts"/.test(src),
    "security-hotspot.ts must import stripCommentsAndStrings from ./shared.ts");
});
