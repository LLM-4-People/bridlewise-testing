import assert from "node:assert/strict";
import test from "node:test";

import { InputError } from "../src/kernel/errors.ts";
import { assertNoDuplicateJsonObjectKeys, jsonNumberRanges, parseJsonExact } from "../src/kernel/json-integrity.ts";
import { canonicalHash, canonicalJson } from "../src/kernel/integrity.ts";

const MESSAGE = "duplicate key";
const CODE = "test_key_duplicate";

function assertDuplicate(text: string): void {
  assert.throws(
    () => assertNoDuplicateJsonObjectKeys(text, MESSAGE, CODE),
    (error: unknown) => {
      assert.ok(error instanceof InputError);
      assert.equal((error as InputError).message, MESSAGE);
      assert.equal((error as InputError).code, CODE);
      return true;
    },
  );
}

test("json-integrity: duplicate key at the top level throws", () => {
  assertDuplicate(`{"a":1,"a":2}`);
});

test("json-integrity: duplicate key in a nested object throws", () => {
  assertDuplicate(`{"outer":{"b":1,"b":2}}`);
});

test("json-integrity: duplicate key inside an array element throws", () => {
  assertDuplicate(`[{"a":1,"a":2}]`);
});

test("json-integrity: escaped keys are decoded before comparison", () => {
  assertDuplicate(`{"a\\u002e":1,"a.":2}`);
});

test("json-integrity: keys containing escaped quotes are compared decoded", () => {
  assertDuplicate(`{"a\\"b":1,"a\\"b":2}`);
});

test("json-integrity: whitespace between key and colon is tolerated", () => {
  assertDuplicate(`{"a" \t\n:1,"a":2}`);
});

test("json-integrity: same key in sibling objects is allowed", () => {
  assertNoDuplicateJsonObjectKeys(`[{"a":1},{"a":2}]`, MESSAGE, CODE);
});

test("json-integrity: same key at different nesting depths is allowed", () => {
  assertNoDuplicateJsonObjectKeys(`{"a":{"a":1}}`, MESSAGE, CODE);
});

test("json-integrity: string values containing braces, brackets, and colons are skipped", () => {
  assertNoDuplicateJsonObjectKeys(`{"a":"}{][\\":,","b":2}`, MESSAGE, CODE);
});

test("json-integrity: string values containing escaped quotes and backslashes are skipped", () => {
  assertNoDuplicateJsonObjectKeys(`{"a":"\\"\\\\","b":{"c":3}}`, MESSAGE, CODE);
});

test("json-integrity: numeric, boolean, and null values are not treated as keys", () => {
  assertNoDuplicateJsonObjectKeys(`{"a":1,"b":true,"c":null,"d":1.5e10}`, MESSAGE, CODE);
});

test("json-integrity: empty objects and arrays are allowed", () => {
  assertNoDuplicateJsonObjectKeys(`{"a":{},"b":[],"c":[{},{}]}`, MESSAGE, CODE);
});

test("json-integrity: deeply nested duplicates are detected at every level", () => {
  assertDuplicate(`{"a":{"b":{"c":{"d":1,"d":2}}}}`);
});

test("json-integrity: unterminated input returns without throwing", () => {
  assertNoDuplicateJsonObjectKeys(`{"a":"unterminated`, MESSAGE, CODE);
});

test("json-integrity: non-object JSON values are ignored", () => {
  assertNoDuplicateJsonObjectKeys(`"just a string"`, MESSAGE, CODE);
  assertNoDuplicateJsonObjectKeys(`42`, MESSAGE, CODE);
});

test("canonical JSON rejects sparse own indices before reading prototype values", () => {
  const one = Array(1), two = Array(2), interior = [1, , 3], trailing = [1, ,];
  const inherited = Array(1);
  let getterReads = 0;
  Object.setPrototypeOf(inherited, Object.create(Array.prototype, {
    0: { get: () => { getterReads += 1; return "inherited"; } },
  }));
  for (const value of [one, two, interior, trailing, inherited, { nested: [one] }, [undefined]]) {
    assert.throws(() => canonicalJson(value), InputError);
    assert.throws(() => canonicalHash(value), InputError);
  }
  assert.equal(getterReads, 0, "an inherited index cannot supply a missing own slot");
});

test("canonical JSON encodes dense indices without calling an overridden map method", () => {
  const dense = [0, false, ""];
  let mapCalls = 0;
  Object.defineProperty(dense, "map", { value: () => { mapCalls += 1; return ['"forged"']; } });
  assert.equal(canonicalJson(dense), '[0,false,""]');
  assert.equal(mapCalls, 0);
  assert.equal(canonicalJson([]), "[]");
  assert.equal(canonicalJson([null]), "[null]");
  assert.equal(canonicalHash(dense), canonicalHash([0, false, ""]));
});

test("canonical JSON captures array length before reading own indices", () => {
  const values = [0];
  let reads = 0;
  Object.defineProperty(values, 0, { get: () => { reads += 1; values.push(2); return 1; } });
  assert.equal(canonicalJson(values), "[1]");
  assert.equal(reads, 1);
  assert.equal(values.length, 2);
});

test("parseJsonExact boxes every JSON value and refuses non-JSON without surfacing the text", () => {
  assert.deepEqual(parseJsonExact("null"), { value: null });
  assert.deepEqual(parseJsonExact('"x"'), { value: "x" });
  assert.deepEqual(parseJsonExact("[1,{\"a\":false}]"), { value: [1, { a: false }] });
  assert.equal(parseJsonExact("secret {{{"), undefined);
  assert.equal(parseJsonExact(""), undefined);
});

test("jsonNumberRanges finds exactly the number tokens with their labels, never digits inside a string, and refuses non-JSON", () => {
  const spans = (text: string): (readonly [string, string | null])[] | undefined => jsonNumberRanges(text)?.map((range) => [text.slice(range.startUtf16, range.endUtf16), range.label] as const);
  assert.deepEqual(spans('{"metric":"process.rss","value":245748169,"unit":"bytes"}'), [["245748169", "value"]]);
  assert.deepEqual(spans('[-1.5e+3, 0, 12, "34", true, null, {"k\\"5": 6}]'), [["-1.5e+3", null], ["0", null], ["12", null], ["6", 'k"5']]);
  assert.deepEqual(spans('{"aba":[1,[2]],"x":{"y":[3]},"z":4}'), [["1", "aba"], ["2", "aba"], ["3", "y"], ["4", "z"]]);
  assert.deepEqual(spans('"routing 245748169"'), []);
  assert.deepEqual(spans('{"a":"\\"","b":7}'), [["7", "b"]]);
  assert.equal(jsonNumberRanges("rss 245748169 bytes"), undefined);
  assert.equal(jsonNumberRanges(""), undefined);
});
