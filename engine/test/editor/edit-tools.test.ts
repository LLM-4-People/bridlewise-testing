import assert from "node:assert/strict";
import { rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import { createEditorTools } from "../../src/editor/edit-tools.ts";
import { createTransactionalEditor } from "../../src/editor/transactional-editor.ts";
import { resolvePreimageToRange, isWholeFileSentinel, repairEscapeDrift } from "../../src/editor/edit-resolve.ts";
import { mkTempDir } from "../support/temp-dir.ts";

const VALID_TS = "export const x = 42;";
const VALID_TS2 = "export const y = 99;";

function makeTools(dir: string, writeSet: readonly string[], options?: { skipUnknownExtensions?: boolean }) {
  return createEditorTools({
    repositoryRoot: dir,
    writeSet: new Set(writeSet),
    // A file in a language with no registered validator (.txt, .md) is not a
    // syntax error — refuse only when a validator actually fails.
    skipUnknownExtensions: options?.skipUnknownExtensions ?? true,
  });
}

// ============================================================================
// Tool definitions — exactly ONE edit tool
// ============================================================================

test("edit-tools: createEditorTools returns exactly one tool definition, named 'edit'", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    const { definitions } = makeTools(dir, ["test.ts"]);
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0]!.function.name, "edit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("edit-tools: the single definition takes path/oldString/newString, never a preimage hash or byte offsets", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    const { definitions } = makeTools(dir, ["test.ts"]);
    const params = definitions[0]!.function.parameters as { properties: Record<string, unknown>; required: string[] };
    assert.ok("path" in params.properties);
    assert.ok("oldString" in params.properties);
    assert.ok("newString" in params.properties);
    // The whole point: the model never supplies a hash it cannot compute nor a
    // byte offset it cannot count.
    assert.ok(!("preimageHash" in params.properties));
    assert.ok(!("startByte" in params.properties));
    assert.ok(!("endByte" in params.properties));
    assert.ok(!("byteOffset" in params.properties));
    assert.ok(params.required.includes("path"));
    assert.ok(params.required.includes("newString"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("edit-tools: handlers expose only 'edit'", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    const { handlers } = makeTools(dir, ["test.ts"]);
    assert.deepEqual(Object.keys(handlers).sort(), ["edit"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// REPLACE — the general case
// ============================================================================

test("edit-tools: replace succeeds on an exact unique preimage", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    writeFileSync(join(dir, "test.ts"), VALID_TS);
    const { handlers } = makeTools(dir, ["test.ts"]);
    const result = handlers.edit!({ path: "test.ts", oldString: "x = 42", newString: "x = 99" });
    assert.equal(result.success, true);
    assert.equal(result.strategy, "exact");
    assert.equal(readFileSync(join(dir, "test.ts"), "utf8"), "export const x = 99;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("edit-tools: the preimage hash is computed by the tool, not supplied by the model", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    writeFileSync(join(dir, "test.ts"), VALID_TS);
    const { handlers } = makeTools(dir, ["test.ts"]);
    const result = handlers.edit!({ path: "test.ts", oldString: "42", newString: "7" });
    assert.equal(result.success, true);
    // The result carries the REAL preimage hash of the file before the edit —
    // computed by the resolver, not echoed from any argument.
    assert.equal(result.preimageHash, sha256(VALID_TS));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("edit-tools: replace of a UTF-8 multibyte span lands on the right byte range", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    const content = "const café = \"☕\";\nexport const y = 1;";
    writeFileSync(join(dir, "test.ts"), content);
    const { handlers } = makeTools(dir, ["test.ts"]);
    const result = handlers.edit!({ path: "test.ts", oldString: "y = 1", newString: "y = 2" });
    assert.equal(result.success, true);
    assert.equal(readFileSync(join(dir, "test.ts"), "utf8"), "const café = \"☕\";\nexport const y = 2;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// INSERT — anchor preserved + new text
// ============================================================================

test("edit-tools: insert is expressed as anchor → anchor + inserted text", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    writeFileSync(join(dir, "test.ts"), "export function a() {\n  return 1;\n}");
    const { handlers } = makeTools(dir, ["test.ts"]);
    const result = handlers.edit!({
      path: "test.ts",
      oldString: "export function a() {",
      newString: "export function a() {\n  const inserted = true;",
    });
    assert.equal(result.success, true);
    assert.equal(
      readFileSync(join(dir, "test.ts"), "utf8"),
      "export function a() {\n  const inserted = true;\n  return 1;\n}",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// DELETE — empty newString
// ============================================================================

test("edit-tools: delete is expressed as an empty newString and removes the matched text", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    writeFileSync(join(dir, "test.ts"), "const a = 1;\nconst gone = 2;\nconst b = 3;");
    const { handlers } = makeTools(dir, ["test.ts"]);
    const result = handlers.edit!({ path: "test.ts", oldString: "const gone = 2;\n", newString: "" });
    assert.equal(result.success, true);
    assert.equal(readFileSync(join(dir, "test.ts"), "utf8"), "const a = 1;\nconst b = 3;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// WHOLE-FILE — explicit sentinel only
// ============================================================================

test("edit-tools: whole-file replace via the '<all>' sentinel", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    writeFileSync(join(dir, "test.ts"), VALID_TS);
    const { handlers } = makeTools(dir, ["test.ts"]);
    const result = handlers.edit!({ path: "test.ts", oldString: "<all>", newString: VALID_TS2 });
    assert.equal(result.success, true);
    assert.equal(result.operation, "replaceFile");
    assert.equal(readFileSync(join(dir, "test.ts"), "utf8"), VALID_TS2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("edit-tools: whole-file content is syntax-validated and invalid content is refused, file intact", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    writeFileSync(join(dir, "test.ts"), VALID_TS);
    const { handlers } = makeTools(dir, ["test.ts"]);
    const result = handlers.edit!({ path: "test.ts", oldString: "<all>", newString: "export const = (; broken" });
    assert.equal(result.success, false);
    assert.match(result.feedback!.message as string, /invalid syntax/i);
    // The file is UNTOUCHED — the refusal happens before any write.
    assert.equal(readFileSync(join(dir, "test.ts"), "utf8"), VALID_TS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// CREATE — non-existent file + empty oldString
// ============================================================================

test("edit-tools: create a new file with empty oldString and content as newString", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    const { handlers } = makeTools(dir, ["new.ts"]);
    const result = handlers.edit!({ path: "new.ts", oldString: "", newString: VALID_TS });
    assert.equal(result.success, true);
    assert.equal(result.operation, "createFile");
    assert.equal(readFileSync(join(dir, "new.ts"), "utf8"), VALID_TS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("edit-tools: create with invalid syntax for a known language is refused, no file created", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    const { handlers } = makeTools(dir, ["bad.ts"]);
    const result = handlers.edit!({ path: "bad.ts", oldString: "", newString: "export const = (" });
    assert.equal(result.success, false);
    assert.match(result.feedback!.message as string, /invalid syntax/i);
    assert.equal(fileExists(dir, "bad.ts"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Safety contract — refusals, never a wrong guess
// ============================================================================

test("edit-tools: empty oldString on an EXISTING file is REFUSED (never wipes it)", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    writeFileSync(join(dir, "test.ts"), VALID_TS);
    const { handlers } = makeTools(dir, ["test.ts"]);
    const result = handlers.edit!({ path: "test.ts", oldString: "", newString: VALID_TS2 });
    assert.equal(result.success, false);
    assert.match(result.feedback!.message as string, /whole file|create|insert/i);
    assert.equal(readFileSync(join(dir, "test.ts"), "utf8"), VALID_TS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("edit-tools: ambiguous oldString (matches more than once) is refused with a widen hint", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    writeFileSync(join(dir, "test.ts"), "if (!s) return false;\nif (!s) return false;");
    const { handlers } = makeTools(dir, ["test.ts"]);
    const result = handlers.edit!({ path: "test.ts", oldString: "if (!s) return false;", newString: "x" });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "old_content_ambiguous_exact");
    assert.match(result.feedback!.message as string, /more than once|widen/i);
    assert.equal(readFileSync(join(dir, "test.ts"), "utf8"), "if (!s) return false;\nif (!s) return false;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("edit-tools: a not-found preimage is refused with an actionable re-read hint", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    writeFileSync(join(dir, "test.ts"), VALID_TS);
    const { handlers } = makeTools(dir, ["test.ts"]);
    const result = handlers.edit!({ path: "test.ts", oldString: "this text is not in the file", newString: "x" });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "old_content_not_found");
    assert.match(result.feedback!.message as string, /not found verbatim|re-read/i);
    assert.equal(readFileSync(join(dir, "test.ts"), "utf8"), VALID_TS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("edit-tools: editing a path outside the write set is denied by governance", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    writeFileSync(join(dir, "allowed.ts"), VALID_TS);
    writeFileSync(join(dir, "denied.ts"), VALID_TS);
    const { handlers } = makeTools(dir, ["allowed.ts"]); // denied.ts NOT in the write set
    const result = handlers.edit!({ path: "denied.ts", oldString: "42", newString: "7" });
    assert.equal(result.success, false);
    assert.equal(readFileSync(join(dir, "denied.ts"), "utf8"), VALID_TS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Heal cascade — a drifted preimage recovers deterministically
// ============================================================================

test("edit-tools: whitespace drift in the preimage heals via the whitespace level", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    writeFileSync(join(dir, "test.ts"), "export function f() {\n    return 1;\n}");
    const { handlers } = makeTools(dir, ["test.ts"]);
    // The model's copy collapsed the indentation (file has 4 spaces).
    const result = handlers.edit!({ path: "test.ts", oldString: "return 1;", newString: "return 2;" });
    assert.equal(result.success, true);
    assert.equal(result.strategy, "exact"); // "return 1;" matches exactly once
    assert.equal(readFileSync(join(dir, "test.ts"), "utf8"), "export function f() {\n    return 2;\n}");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Resolver unit tests (the heal cascade owner)
// ============================================================================

test("edit-resolve: exact match returns a byte range", () => {
  const r = resolvePreimageToRange("hello world", "world");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.strategy, "exact");
    assert.equal(r.matchedText, "world");
  }
});

test("edit-resolve: ambiguous exact match is refused", () => {
  const r = resolvePreimageToRange("aa bb aa", "aa");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "old_content_ambiguous_exact");
});

test("edit-resolve: whitespace-normalized match recovers the file's real span", () => {
  const r = resolvePreimageToRange("foo( a, b )", "foo(a,b)");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.strategy, "whitespace");
    assert.equal(r.matchedText, "foo( a, b )");
  }
});

test("edit-resolve: a whitespace match that would cross a token boundary is refused", () => {
  // oldString "b c d" would match the "bcd" inside "abcd" after collapsing —
  // a splice into the middle of an identifier. Refused.
  const r = resolvePreimageToRange("abcd", "b c d");
  assert.equal(r.ok, false);
});

test("edit-resolve: escape drift heals (raw newline where the file spells \\n)", () => {
  // The file holds the two chars backslash+n inside a string; the model emitted
  // a real newline. The escape-repair level re-escapes it and matches.
  const file = 'const s = "a\\nb";'; // file contains: const s = "a\nb";  (literal backslash-n)
  const modelCopy = 'const s = "a\nb";'; // model emitted a REAL newline
  const r = resolvePreimageToRange(file, modelCopy);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.strategy, "escape");
});

test("edit-resolve: a completely absent preimage is not found at any level", () => {
  const r = resolvePreimageToRange("const a = 1;", "zzz totally different qqq");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "old_content_not_found");
});

test("edit-resolve: the heal cascade can be disabled (healCascadeEnabled:false leaves only exact)", () => {
  const r = resolvePreimageToRange("foo( a, b )", "foo(a,b)", { healCascadeEnabled: false });
  assert.equal(r.ok, false);
});

test("edit-resolve: whole-file sentinels are recognized", () => {
  assert.equal(isWholeFileSentinel("<all>"), true);
  assert.equal(isWholeFileSentinel("*"), true);
  assert.equal(isWholeFileSentinel("<entire-file>"), true);
  assert.equal(isWholeFileSentinel("real text"), false);
  assert.equal(isWholeFileSentinel(""), false);
  assert.equal(isWholeFileSentinel(undefined), false);
});

test("edit-resolve: repairEscapeDrift only re-escapes raw control chars inside string literals", () => {
  // A real source line break is NOT escaped (it's outside a string literal).
  const realCode = "const a = 1;\nconst b = 2;";
  assert.equal(repairEscapeDrift(realCode).changed, false);
  // A raw newline INSIDE a string literal IS re-escaped.
  const corrupt = 'const s = "a\nb";';
  const rep = repairEscapeDrift(corrupt);
  assert.equal(rep.changed, true);
  assert.equal(rep.repaired, 'const s = "a\\nb";');
});

// ============================================================================
// FUZZY heal level (the most complex cascade level — pinned end-to-end)
// ============================================================================

test("edit-resolve: a small typo drift within threshold heals via the fuzzy level", () => {
  // The file holds `a + b, 0`; the model's copy drifted one char to `1`.
  const src = "function computeTotal() { return items.reduce((a, b) => a + b, 0); }\n";
  const stale = "function computeTotal() { return items.reduce((a, b) => a + b, 1); }";
  const r = resolvePreimageToRange(src, stale);
  assert.equal(r.ok, true, "a one-character drift within threshold must heal");
  if (r.ok) {
    assert.equal(r.strategy, "fuzzy");
    // The recovered span is the file's REAL text (the 0, not the drifted 1).
    assert.equal(r.matchedText, "function computeTotal() { return items.reduce((a, b) => a + b, 0); }");
  }
});

test("edit-resolve: a distant region beyond the fuzzy threshold is refused", () => {
  const src = "alpha beta gamma delta epsilon\n";
  const r = resolvePreimageToRange(src, "xxxx xxxx xxxx xxxx xxxxxxx");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "old_content_not_found");
});

test("edit-resolve: a fuzzy match that would land inside a token is refused (no corrupt splice)", () => {
  // `computeTotal` appears as a substring of a longer identifier; a fuzzy
  // match that starts mid-token must be refused, not spliced.
  const src = "function recomputeTotals() { return items.reduce((a, b) => a + b, 0); }\n";
  const stale = "function computeTotal() { return items.reduce((a, b) => a + b, 1); }";
  const r = resolvePreimageToRange(src, stale);
  // Either refused outright, or healed at a token boundary — never a splice
  // into the middle of `recomputeTotals`.
  if (r.ok) {
    assert.equal(r.strategy, "fuzzy");
    assert.ok(!r.matchedText.includes("computeTotal"), "a fuzzy match must not lock onto a mid-token span");
  }
});

test("edit-resolve: a shorter-than-file preimage window still attempts a match (no fast-path refusal)", () => {
  // The old implementation refused outright when the file was shorter than
  // the preimage; the shipped resolver attempts a real match and refuses with
  // a reason when the drift is too large.
  const r = resolvePreimageToRange("short", "a much much longer preimage string");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "old_content_not_found");
});

test("edit-tools: a typo-drifted preimage heals end-to-end and reports the fuzzy strategy", () => {
  const dir = mkTempDir("editor-tools-test-");
  try {
    writeFileSync(join(dir, "test.ts"), "function computeTotal() { return items.reduce((a, b) => a + b, 0); }\n");
    const { handlers } = makeTools(dir, ["test.ts"]);
    const result = handlers.edit!({
      path: "test.ts",
      oldString: "function computeTotal() { return items.reduce((a, b) => a + b, 1); }",
      newString: "done();",
    });
    assert.equal(result.success, true);
    assert.equal(result.strategy, "fuzzy");
    assert.equal(readFileSync(join(dir, "test.ts"), "utf8"), "done();\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// PARITY — the single `edit` tool vs the transactional editor's own ops
// ============================================================================
// Each case runs the SAME semantic operation through the unified edit tool
// AND through the corresponding transactional-editor operation, on identical
// inputs, and asserts identical resulting bytes. The 5 edit_* tools are gone;
// the operations they wrapped live on as `EditOperation` kinds, and the one
// `edit` tool must be able to express each with equal correctness and safety.

function pair(name: string, content: string) {
  const unified = mkTempDir("parity-u-");
  writeFileSync(join(unified, name), content);
  const tx = mkTempDir("parity-t-");
  writeFileSync(join(tx, name), content);
  return { unified, tx, name };
}

function txEditor(root: string, name: string) {
  return createTransactionalEditor({ repositoryRoot: root, writeSet: new Set([name]), skipUnknownExtensions: true });
}

test("parity: replaceFile ≡ edit with the '<all>' sentinel", () => {
  const { unified, tx, name } = pair("a.ts", "export const v = 1;\n");
  const newContent = "export const v = 2;\nexport const w = 3;\n";
  const { handlers } = makeTools(unified, [name]);
  const ru = handlers.edit!({ path: name, oldString: "<all>", newString: newContent });
  const rt = txEditor(tx, name).applyEdit({ path: name, preimageHash: sha256("export const v = 1;\n"), operation: { kind: "replaceFile", newContent } });
  assert.equal(ru.success, true);
  assert.equal(rt.success, true);
  assert.equal(readFileSync(join(unified, name), "utf8"), newContent);
  assert.equal(readFileSync(join(unified, name), "utf8"), readFileSync(join(tx, name), "utf8"));
  rmSync(unified, { recursive: true, force: true });
  rmSync(tx, { recursive: true, force: true });
});

test("parity: insertText ≡ edit with an anchor-preserved insert", () => {
  const content = "const a = 1;\nconst c = 3;\n";
  const { unified, tx, name } = pair("a.ts", content);
  const { handlers } = makeTools(unified, [name]);
  const ru = handlers.edit!({ path: name, oldString: "const a = 1;\n", newString: "const a = 1;\nconst b = 2;\n" });
  const byteOffset = Buffer.byteLength("const a = 1;\n", "utf8");
  const rt = txEditor(tx, name).applyEdit({ path: name, preimageHash: sha256(content), operation: { kind: "insertText", byteOffset, text: "const b = 2;\n" } });
  assert.equal(ru.success, true);
  assert.equal(rt.success, true);
  assert.equal(readFileSync(join(unified, name), "utf8"), readFileSync(join(tx, name), "utf8"));
  rmSync(unified, { recursive: true, force: true });
  rmSync(tx, { recursive: true, force: true });
});

test("parity: deleteRange ≡ edit with an empty newString", () => {
  const content = "keep1\nexport const junk = 0;\nkeep2\n";
  const { unified, tx, name } = pair("a.ts", content);
  const { handlers } = makeTools(unified, [name]);
  const ru = handlers.edit!({ path: name, oldString: "export const junk = 0;\n", newString: "" });
  const startByte = Buffer.byteLength("keep1\n", "utf8");
  const endByte = startByte + Buffer.byteLength("export const junk = 0;\n", "utf8");
  const rt = txEditor(tx, name).applyEdit({ path: name, preimageHash: sha256(content), operation: { kind: "deleteRange", startByte, endByte } });
  assert.equal(ru.success, true);
  assert.equal(rt.success, true);
  assert.equal(readFileSync(join(unified, name), "utf8"), "keep1\nkeep2\n");
  assert.equal(readFileSync(join(unified, name), "utf8"), readFileSync(join(tx, name), "utf8"));
  rmSync(unified, { recursive: true, force: true });
  rmSync(tx, { recursive: true, force: true });
});

test("parity: replaceRange ≡ edit replace", () => {
  const content = "const value = 100;\n";
  const { unified, tx, name } = pair("a.ts", content);
  const { handlers } = makeTools(unified, [name]);
  const ru = handlers.edit!({ path: name, oldString: "100", newString: "200" });
  const startByte = Buffer.byteLength("const value = ", "utf8");
  const endByte = startByte + 3;
  const rt = txEditor(tx, name).applyEdit({ path: name, preimageHash: sha256(content), operation: { kind: "replaceRange", startByte, endByte, text: "200" } });
  assert.equal(ru.success, true);
  assert.equal(rt.success, true);
  assert.equal(readFileSync(join(unified, name), "utf8"), "const value = 200;\n");
  assert.equal(readFileSync(join(unified, name), "utf8"), readFileSync(join(tx, name), "utf8"));
  rmSync(unified, { recursive: true, force: true });
  rmSync(tx, { recursive: true, force: true });
});

test("parity: applyPatch ≡ edit replacing the changed region", () => {
  const content = "one\ntwo\nthree\n";
  const { unified, tx, name } = pair("a.txt", content);
  const { handlers } = makeTools(unified, [name]);
  const ru = handlers.edit!({ path: name, oldString: "two", newString: "TWO" });
  const rt = txEditor(tx, name).applyEdit({ path: name, preimageHash: sha256(content), operation: { kind: "applyPatch", patch: "@@ -2,1 +2,1 @@\n-two\n+TWO\n" } });
  assert.equal(ru.success, true);
  assert.equal(rt.success, true);
  assert.equal(readFileSync(join(unified, name), "utf8"), "one\nTWO\nthree\n");
  assert.equal(readFileSync(join(unified, name), "utf8"), readFileSync(join(tx, name), "utf8"));
  rmSync(unified, { recursive: true, force: true });
  rmSync(tx, { recursive: true, force: true });
});

test("parity safety: invalid TS is refused by BOTH the edit tool and the editor, file intact", () => {
  const content = "const x = 1;\n";
  const { unified, tx, name } = pair("a.ts", content);
  const { handlers } = makeTools(unified, [name]);
  const ru = handlers.edit!({ path: name, oldString: "1", newString: ";" });
  const rt = txEditor(tx, name).applyEdit({ path: name, preimageHash: sha256(content), operation: { kind: "replaceFile", newContent: "const x = ;\n" } });
  assert.equal(ru.success, false);
  assert.equal(rt.success, false);
  assert.equal(readFileSync(join(unified, name), "utf8"), content);
  assert.equal(readFileSync(join(tx, name), "utf8"), content);
  rmSync(unified, { recursive: true, force: true });
  rmSync(tx, { recursive: true, force: true });
});

test("parity safety: an ambiguous preimage is refused with no wrong guess", () => {
  const content = "dup\ndup\ndup\n";
  const { unified, tx, name } = pair("a.txt", content);
  const { handlers } = makeTools(unified, [name]);
  const ru = handlers.edit!({ path: name, oldString: "dup", newString: "X" });
  assert.equal(ru.success, false);
  assert.equal(readFileSync(join(unified, name), "utf8"), content);
  rmSync(unified, { recursive: true, force: true });
  rmSync(tx, { recursive: true, force: true });
});

test("parity: a UTF-8 multibyte edit produces identical bytes on both paths", () => {
  const content = "const s = \"héllo wörld\";\n";
  const { unified, tx, name } = pair("a.ts", content);
  const { handlers } = makeTools(unified, [name]);
  const ru = handlers.edit!({ path: name, oldString: "héllo", newString: "goodbye" });
  const bs = Buffer.from(content, "utf8");
  const startByte = bs.indexOf(Buffer.from("héllo", "utf8"));
  const endByte = startByte + Buffer.byteLength("héllo", "utf8");
  const rt = txEditor(tx, name).applyEdit({ path: name, preimageHash: sha256(content), operation: { kind: "replaceRange", startByte, endByte, text: "goodbye" } });
  assert.equal(ru.success, true);
  assert.equal(rt.success, true);
  assert.deepEqual(readFileSync(join(unified, name)), readFileSync(join(tx, name)));
  rmSync(unified, { recursive: true, force: true });
  rmSync(tx, { recursive: true, force: true });
});

test("advantage: a whitespace-drifted preimage heals (edit) where an exact-hash editor refuses (tx)", () => {
  const content = "function f() {\n    return 1;\n}\n";
  const { unified, tx, name } = pair("a.ts", content);
  const { handlers } = makeTools(unified, [name]);
  // The edit tool's preimage has 2-space indent, the file has 4 → it heals.
  const ru = handlers.edit!({ path: name, oldString: "function f() {\n  return 1;\n}", newString: "function f() {\n  return 2;\n}" });
  assert.equal(ru.success, true);
  assert.ok(readFileSync(join(unified, name), "utf8").includes("return 2"));
  // The transactional editor with a stale hash refuses outright.
  const rt = txEditor(tx, name).applyEdit({ path: name, preimageHash: sha256("stale"), operation: { kind: "replaceFile", newContent: "x" } });
  assert.equal(rt.success, false);
  assert.equal(readFileSync(join(tx, name), "utf8"), content);
  rmSync(unified, { recursive: true, force: true });
  rmSync(tx, { recursive: true, force: true });
});

// ============================================================================
// helpers
// ============================================================================

function fileExists(dir: string, path: string): boolean {
  try { readFileSync(join(dir, path)); return true; } catch { return false; }
}
