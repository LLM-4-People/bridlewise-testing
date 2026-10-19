import assert from "node:assert/strict";
import test from "node:test";

import { parseJsonLoose, parseJsonObjectExact } from "../../src/text/json-repair.ts";

/**
 * The transport-level tool-argument repair ladder. Two contracts, both pinned:
 *
 *   SAFETY — a payload that is already valid JSON parses to EXACTLY the same
 *     value. A false "repair" (changing the meaning of correct JSON) is far
 *     worse than a rejection, so valid inputs are asserted byte-for-byte and
 *     strings that merely LOOK like malformations (apostrophes, "True" as a
 *     value, URLs with `//`) are asserted NOT corrupted.
 *
 *   REPAIR — a payload a weak model actually breaks (fences, prose, raw
 *     control chars, unclosed braces, trailing commas, single quotes, unquoted
 *     keys, smart quotes, Python literals, NaN, comments, truncation) is
 *     recovered to the intended object.
 */

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);

// ── SAFETY: valid JSON is never mangled ──
//
// Each case is an individually-named test (the inventory binds static names).
// Every one asserts BOTH the exact round-trip AND that the payload is
// recognised as already-valid (so the caller never counts it as a repair).

function assertCleanRoundTrip(input: string, expected: unknown): void {
  assert.deepEqual(parseJsonLoose(input), expected, `repair changed a valid payload: ${input}`);
  assert.deepEqual(parseJsonObjectExact(input), expected, `a valid payload was not recognised as already-valid: ${input}`);
}

test("SAFETY: a plain number member", () => assertCleanRoundTrip('{"a":1}', { a: 1 }));
test("SAFETY: commas inside a string value", () => assertCleanRoundTrip('{"a":"1,2,3"}', { a: "1,2,3" }));
test("SAFETY: // inside a string is not a comment", () => assertCleanRoundTrip('{"url":"https://x.com//path"}', { url: "https://x.com//path" }));
test("SAFETY: escaped quotes inside a string", () => assertCleanRoundTrip('{"q":"she said \\"hi\\""}', { q: 'she said "hi"' }));
test("SAFETY: a comma in a string value", () => assertCleanRoundTrip('{"k":"value with, comma"}', { k: "value with, comma" }));
test("SAFETY: an apostrophe in a double-quoted string", () => assertCleanRoundTrip('{"name":"O\'Brien"}', { name: "O'Brien" }));
test("SAFETY: 'True' as a string value, not a literal", () => assertCleanRoundTrip('{"t":"True dat"}', { t: "True dat" }));
test("SAFETY: 'None' as a substring", () => assertCleanRoundTrip('{"t":"None of these"}', { t: "None of these" }));
test("SAFETY: real JSON literals untouched", () => assertCleanRoundTrip('{"n":null,"t":true,"f":false}', { n: null, t: true, f: false }));
test("SAFETY: a nested array", () => assertCleanRoundTrip('{"a":[1,2,3]}', { a: [1, 2, 3] }));
test("SAFETY: deep nesting", () => assertCleanRoundTrip('{"nested":{"deep":{"x":[1,{"y":2}]}}}', { nested: { deep: { x: [1, { y: 2 }] } } }));
test("SAFETY: number forms (exponent, negative, zero)", () => assertCleanRoundTrip('{"num":1.5e10,"neg":-42,"zero":0}', { num: 1.5e10, neg: -42, zero: 0 }));
test("SAFETY: keys with spaces", () => assertCleanRoundTrip('{"key with spaces":"v"}', { "key with spaces": "v" }));
test("SAFETY: unicode escapes preserved", () => assertCleanRoundTrip('{"unicode":"caf\\u00e9 \\u00e9"}', { unicode: "café é" }));
test("SAFETY: an empty string value", () => assertCleanRoundTrip('{"empty":""}', { empty: "" }));
test("SAFETY: 'true' as a string stays a string", () => assertCleanRoundTrip('{"bool_str":"true"}', { bool_str: "true" }));
test("SAFETY: escaped backslashes/newlines in a string", () => assertCleanRoundTrip('{"regex":"a\\nb\\t\\\\c"}', { regex: "a\nb\t\\c" }));

test("SAFETY: fenced valid JSON returns the same value", () => {
  const v = { edits: [{ oldString: "a,b", newString: "c" }] };
  assert.deepEqual(parseJsonLoose("```json\n" + JSON.stringify(v) + "\n```"), v);
});

test("SAFETY: a string value that is ITSELF JSON is not double-parsed", () => {
  const v = { payload: '{"inner":true}' };
  const r = parseJsonLoose(JSON.stringify(v));
  assert.deepEqual(r, v);
  assert.equal(typeof (r as Record<string, unknown>).payload, "string");
});

test("SAFETY: single-quote normalization does NOT corrupt an apostrophe", () => {
  const input = '{"name": "O' + String.fromCharCode(39) + 'Brien"}';
  assert.deepEqual(parseJsonLoose(input), { name: "O'Brien" });
});

test("SAFETY: trailing-comma fix never removes a MEANINGFUL comma", () => {
  assert.deepEqual(parseJsonLoose('{"a":1,"b":2}'), { a: 1, b: 2 });
});

test("SAFETY: number-like strings are not coerced", () => {
  assert.deepEqual(parseJsonLoose('{"port":"8080"}'), { port: "8080" });
});

test("SAFETY: empty object and empty array edge cases", () => {
  assert.deepEqual(parseJsonLoose('{}'), {});
  assert.deepEqual(parseJsonLoose('{"a":[]}'), { a: [] });
  assert.deepEqual(parseJsonLoose('{"a":{}}'), { a: {} });
});

test("SAFETY: True/False/None as full STRING values are preserved", () => {
  assert.deepEqual(parseJsonLoose('{"a":"True","b":"None"}'), { a: "True", b: "None" });
});

test("SAFETY: a non-object valid JSON (array) is not forced into an object", () => {
  // The transport passes objects; a bare array is not a valid tool-argument
  // payload and must not be coerced into one.
  assert.equal(parseJsonObjectExact('[1,2,3]'), null);
});

// ── REPAIR: real weak-model malformations are recovered ──

const GOOD = { edits: [{ oldString: "a", newString: "b" }] };

test("REPAIR: clean JSON", () => {
  assert.deepEqual(parseJsonLoose(JSON.stringify(GOOD)), GOOD);
});

test("REPAIR: prose-wrapped", () => {
  assert.deepEqual(parseJsonLoose(`Here you go:\n${JSON.stringify(GOOD)}\nDone.`), GOOD);
});

test("REPAIR: json fence", () => {
  assert.deepEqual(parseJsonLoose("```json\n" + JSON.stringify(GOOD) + "\n```"), GOOD);
});

test("REPAIR: unlabeled fence", () => {
  assert.deepEqual(parseJsonLoose("```\n" + JSON.stringify(GOOD) + "\n```"), GOOD);
});

test("REPAIR: code fence BEFORE json fence", () => {
  const raw = "The code:\n```javascript\nfunction f() {}\n```\nThe edit:\n```json\n" + JSON.stringify(GOOD) + "\n```";
  assert.deepEqual(parseJsonLoose(raw), GOOD);
});

test("REPAIR: trailing garbage after the object", () => {
  assert.deepEqual(parseJsonLoose(JSON.stringify(GOOD) + "]}"), GOOD);
  assert.deepEqual(parseJsonLoose(JSON.stringify(GOOD) + "]}]}"), GOOD);
  assert.deepEqual(parseJsonLoose(JSON.stringify(GOOD) + "\n\nHope this helps!"), GOOD);
});

test("REPAIR: raw newline inside a string value", () => {
  const raw = '{"edits": [{"oldString": "line1' + NL + 'line2", "newString": "x"}]}';
  const r = parseJsonLoose(raw) as { edits: Array<{ oldString: string }> };
  assert.equal(r.edits[0]!.oldString, "line1\nline2");
});

test("REPAIR: raw tab + CR inside a string value", () => {
  const raw = '{"edits": [{"oldString": "a' + TAB + 'b' + CR + 'c", "newString": "x"}]}';
  const r = parseJsonLoose(raw) as { edits: Array<{ oldString: string }> };
  assert.equal(r.edits[0]!.oldString, "a\tb\rc");
});

test("REPAIR: unclosed inner object (dropped })", () => {
  const raw = '{"edits": [{"oldString": "a", "newString": "b"]}';
  const r = parseJsonLoose(raw) as { edits: Array<{ oldString: string }> };
  assert.ok(r, "should close the unclosed inner object");
  assert.equal(r.edits[0]!.oldString, "a");
});

test("REPAIR: unclosed edits object", () => {
  const raw = '{"edits": [{"oldString": "a", "newString": "b"}]';
  const r = parseJsonLoose(raw) as { edits: Array<{ newString: string }> };
  assert.equal(r.edits[0]!.newString, "b");
});

test("REPAIR: truncated mid-second-edit salvages the complete first", () => {
  const raw = '{"edits": [{"oldString": "a", "newString": "b"}, {"oldString": "c", "newStr';
  const r = parseJsonLoose(raw) as { edits: Array<{ oldString: string }> };
  assert.equal(r.edits.length, 1);
  assert.equal(r.edits[0]!.oldString, "a");
});

test("REPAIR: truncated mid-string of first edit yields null (nothing complete, no throw)", () => {
  const raw = '{"edits": [{"oldString": "ret';
  assert.equal(parseJsonLoose(raw), null);
});

test("REPAIR: braces inside string values don't break extraction", () => {
  const raw = '{"edits": [{"oldString": "if (x) { return; }", "newString": "if (y) { return; }"}]}';
  const r = parseJsonLoose(raw) as { edits: Array<{ oldString: string }> };
  assert.equal(r.edits[0]!.oldString, "if (x) { return; }");
});

test("REPAIR: deeply nested + escaping together", () => {
  const raw = '{"edits": [{"oldString": "return input\\n  .replace(/\\\\n/g, \\"\\\\n\\")' + NL + '  .trim();", "newString": "return input"}]}';
  const r = parseJsonLoose(raw) as { edits: Array<{ oldString: string }> };
  assert.ok(r.edits[0]!.oldString.includes("replace"));
});

test("REPAIR: empty + whitespace + null + non-JSON", () => {
  assert.equal(parseJsonLoose(""), null);
  assert.equal(parseJsonLoose("   \n  "), null);
  assert.equal(parseJsonLoose(null as unknown as string), null);
  assert.equal(parseJsonLoose("no json here"), null);
});

test("REPAIR: trailing comma", () => {
  assert.deepEqual(parseJsonLoose('{"a":1,}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('{"edits":[{"oldString":"a","newString":"b",}],}'), { edits: [{ oldString: "a", newString: "b" }] });
});

test("REPAIR: missing comma between members", () => {
  assert.deepEqual(parseJsonLoose('{"a":1 "b":2}'), { a: 1, b: 2 });
});

test("REPAIR: single quotes", () => {
  assert.deepEqual(parseJsonLoose("{'oldString':'a','newString':'b'}"), { oldString: "a", newString: "b" });
});

test("REPAIR: unquoted keys", () => {
  assert.deepEqual(parseJsonLoose('{oldString:"a", newString:"b"}'), { oldString: "a", newString: "b" });
});

test("REPAIR: smart quotes", () => {
  assert.deepEqual(parseJsonLoose('{“a”:“b”}'), { a: "b" });
});

test("REPAIR: Python literals True/False/None", () => {
  assert.deepEqual(parseJsonLoose('{"ok":True,"bad":False,"err":None}'), { ok: true, bad: false, err: null });
});

test("REPAIR: NaN / Infinity / undefined → null", () => {
  assert.deepEqual(parseJsonLoose('{"x":NaN,"y":Infinity,"z":undefined}'), { x: null, y: null, z: null });
});

test("REPAIR: comments stripped", () => {
  assert.deepEqual(parseJsonLoose('{"a":1 /* note */, "b":2}'), { a: 1, b: 2 });
  assert.deepEqual(parseJsonLoose('{"a":1} // done'), { a: 1 });
});

test("REPAIR: real-world combo — fence + prose + trailing comma + unquoted key", () => {
  const raw = 'Sure!\n```json\n{edits: [{oldString: "a", newString: "b",}],}\n```\nDone.';
  assert.deepEqual(parseJsonLoose(raw), { edits: [{ oldString: "a", newString: "b" }] });
});

test("REPAIR: an unparseable payload yields null (never throws)", () => {
  assert.equal(parseJsonLoose("{{{ totally broken"), null);
  assert.equal(parseJsonLoose('{"a": "unterminated'), null);
});
