import { test } from "node:test";
import assert from "node:assert/strict";

import { shingles, jaccard } from "../../src/shared/similarity.ts";
import {
  isPlainObject,
  isPromiseLike,
  assertNever,
  memberOf,
  requireObject,
} from "../../src/shared/type-guards.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { escapePointer } from "../../src/shared/json-pointer.ts";
import { getExtension } from "../../src/shared/path-utils.ts";
import { sameIdentity } from "../../src/shared/identity.ts";
import {
  combineSignals,
  combineSignalArray,
} from "../../src/shared/abort-signals.ts";

// --- shingles ---

test("shingles: produces k-shingles from tokens", () => {
  const s = shingles(["a", "b", "c", "d"], 2);
  assert.equal(s.size, 3);
  assert.ok(s.has("a|b"));
  assert.ok(s.has("b|c"));
  assert.ok(s.has("c|d"));
});

test("shingles: tokens shorter than k returns single joined shingle", () => {
  const s = shingles(["a", "b"], 3);
  assert.equal(s.size, 1);
  assert.ok(s.has("a|b"));
});

test("shingles: empty tokens returns one empty-string shingle (not empty set)", () => {
  const s = shingles([], 2);
  assert.equal(s.size, 1);
  assert.ok(s.has(""));
});

// --- jaccard ---

test("jaccard: identical sets → 1", () => {
  const a = new Set(["x", "y", "z"]);
  assert.equal(jaccard(a, a), 1);
});

test("jaccard: disjoint sets → 0", () => {
  const a = new Set(["x"]);
  const b = new Set(["y"]);
  assert.equal(jaccard(a, b), 0);
});

test("jaccard: either empty → 0", () => {
  const a = new Set<string>(["x"]);
  const b = new Set<string>();
  assert.equal(jaccard(a, b), 0);
  assert.equal(jaccard(b, a), 0);
});

test("jaccard: both empty → 0", () => {
  const a = new Set<string>();
  const b = new Set<string>();
  assert.equal(jaccard(a, b), 0);
});

test("jaccard: half overlap → 1/3", () => {
  const a = new Set(["x", "y"]);
  const b = new Set(["y", "z"]);
  // inter=1, union=3 → 1/3
  assert.equal(jaccard(a, b), 1 / 3);
});

// --- isPlainObject ---

test("isPlainObject: plain object → true", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
});

test("isPlainObject: null prototype → true", () => {
  assert.equal(isPlainObject(Object.create(null)), true);
});

test("isPlainObject: array, null, primitive → false", () => {
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(42), false);
  assert.equal(isPlainObject("str"), false);
});

test("isPlainObject: class instance → false", () => {
  class Foo {}
  assert.equal(isPlainObject(new Foo()), false);
});

// --- isPromiseLike ---

test("isPromiseLike: promise → true", () => {
  assert.equal(isPromiseLike(Promise.resolve(1)), true);
});

test("isPromiseLike: thenable object → true", () => {
  assert.equal(isPromiseLike({ then: () => {} }), true);
});

test("isPromiseLike: thenable function → true", () => {
  const fn = (() => {}) as unknown as { then?: unknown };
  fn.then = () => {};
  assert.equal(isPromiseLike(fn), true);
});

test("isPromiseLike: non-thenable → false", () => {
  assert.equal(isPromiseLike({}), false);
  assert.equal(isPromiseLike(null), false);
  assert.equal(isPromiseLike(42), false);
  assert.equal(isPromiseLike(undefined), false);
});

// --- assertNever ---

test("assertNever: always throws", () => {
  assert.throws(() => assertNever(undefined as never));
});

// --- requireObject ---

test("requireObject: plain object → returns it", () => {
  const obj = { a: 1 };
  assert.equal(requireObject(obj, "test_code"), obj);
});

test("requireObject: null → throws InputError", () => {
  assert.throws(() => requireObject(null, "test_code"), /Protocol object is malformed/);
});

test("requireObject: array → throws InputError", () => {
  assert.throws(() => requireObject([], "test_code"), /Protocol object is malformed/);
});

test("requireObject: class instance → throws InputError", () => {
  class Foo {}
  assert.throws(() => requireObject(new Foo(), "test_code"), /Protocol object is malformed/);
});

// --- escapePointer ---

test("escapePointer: escapes ~ and /", () => {
  assert.equal(escapePointer("a~b/c"), "a~0b~1c");
  assert.equal(escapePointer("plain"), "plain");
  assert.equal(escapePointer(""), "");
  assert.equal(escapePointer("/"), "~1");
  assert.equal(escapePointer("~"), "~0");
});

// --- getExtension ---

test("getExtension: returns lowercase extension with dot", () => {
  assert.equal(getExtension("file.ts"), ".ts");
  assert.equal(getExtension("file.TS"), ".ts");
  assert.equal(getExtension("path/to/file.mjs"), ".mjs");
});

test("getExtension: no extension → empty string", () => {
  assert.equal(getExtension("README"), "");
});

test("getExtension: trailing dot → dot (matches original implementations)", () => {
  assert.equal(getExtension("file."), ".");
});

test("getExtension: hidden file (dot at index 0) → empty string", () => {
  assert.equal(getExtension(".bashrc"), "");
});

// --- sameIdentity ---

test("sameIdentity: identical stats → true", () => {
  const a = { dev: 1n, ino: 2n, mode: 3, uid: 4, gid: 5, nlink: 6, size: 7n, mtimeNs: 8n, ctimeNs: 9n, blocks: 0n } as unknown as import("node:fs").BigIntStats;
  const b = { dev: 1n, ino: 2n, mode: 3, uid: 4, gid: 5, nlink: 6, size: 7n, mtimeNs: 8n, ctimeNs: 9n, blocks: 0n } as unknown as import("node:fs").BigIntStats;
  assert.equal(sameIdentity(a, b), true);
});

test("sameIdentity: different dev → false", () => {
  const a = { dev: 1n, ino: 2n, mode: 3, uid: 4, gid: 5, nlink: 6, size: 7n, mtimeNs: 8n, ctimeNs: 9n, blocks: 0n } as unknown as import("node:fs").BigIntStats;
  const b = { dev: 99n, ino: 2n, mode: 3, uid: 4, gid: 5, nlink: 6, size: 7n, mtimeNs: 8n, ctimeNs: 9n, blocks: 0n } as unknown as import("node:fs").BigIntStats;
  assert.equal(sameIdentity(a, b), false);
});

// --- combineSignals ---

test("combineSignals: both undefined → undefined", () => {
  assert.equal(combineSignals(undefined, undefined), undefined);
});

test("combineSignals: one undefined → returns the other", () => {
  const ctrl = new AbortController();
  assert.equal(combineSignals(ctrl.signal, undefined), ctrl.signal);
  assert.equal(combineSignals(undefined, ctrl.signal), ctrl.signal);
});

test("combineSignals: both aborted → returns aborted signal", () => {
  const a = AbortSignal.abort();
  const b = new AbortController().signal;
  const result = combineSignals(a, b);
  assert.ok(result?.aborted);
});

test("combineSignals: aborts when either input aborts", () => {
  const a = new AbortController();
  const b = new AbortController();
  const result = combineSignals(a.signal, b.signal);
  assert.ok(result !== undefined);
  assert.equal(result.aborted, false);
  a.abort();
  assert.equal(result.aborted, true);
});

test("abort composition preserves input identities, exact first reasons, and independent controllers", () => {
  assert.equal(combineSignalArray([]), undefined);
  for (const initial of [true, false]) for (const source of [0, 1]) {
    const inputs = [new AbortController(), new AbortController()];
    const reason = { source, initial };
    if (initial) inputs[source]!.abort(reason);
    const result = combineSignalArray([undefined, ...inputs.map(input => input.signal)])!;
    if (!initial) inputs[source]!.abort(reason);
    assert.equal(result.aborted, true); assert.equal(result.reason, reason);
    assert.equal(inputs[1 - source]!.signal.aborted, false);
    inputs[1 - source]!.abort("later"); assert.equal(result.reason, reason);
    assert.equal(combineSignals(inputs[source]!.signal, undefined), inputs[source]!.signal);
  }
});

// --- memberOf ---
//
// The shape this replaced was `const TIER_SET = new Set<string>(MEMORY_TIERS)`
// beside a predicate that reads it: built from the owner and still able to
// disagree with it. `new Set<string>` erases the element type, and a `Set` is
// mutable — `TIER_SET.delete("long-term")` typechecked, left every tier suite
// green, and silently dropped `?tier=long-term` at the web boundary. Driven.

test("memberOf: accepts every member of the vocabulary it was given", () => {
  const isLane = memberOf(["air", "sea", "rail"] as const);
  // Derived from the vocabulary rather than restated, so a member added
  // tomorrow is covered without editing this test.
  for (const lane of ["air", "sea", "rail"] as const) {
    assert.equal(isLane(lane), true, `"${lane}" is declared and must be a member`);
  }
});

test("memberOf: refuses a value outside the vocabulary, and any non-string", () => {
  const isLane = memberOf(["air", "sea"] as const);
  assert.equal(isLane("rail"), false);
  assert.equal(isLane(""), false);
  assert.equal(isLane(undefined), false);
  assert.equal(isLane(null), false);
  assert.equal(isLane(3), false);
  // A prototype key is not a member. `Set` is used rather than a plain object
  // exactly so this cannot be true.
  assert.equal(isLane("toString"), false);
  assert.equal(isLane("__proto__"), false);
});

test("memberOf: the predicate exposes NO handle to its members", () => {
  const isLane = memberOf(["air", "sea", "rail"] as const);
  // The rung. `TIER_SET.delete("long-term")` is what escaped the previous
  // guard; here `delete` does not exist to be called, which `tsc` reports as
  // TS2339 at the call site and which is asserted at run time too so the
  // property cannot be reintroduced by a refactor that keeps the tests green.
  const asRecord = isLane as unknown as Record<string, unknown>;
  for (const mutator of ["delete", "add", "clear", "has", "values", "keys"]) {
    assert.equal(
      asRecord[mutator],
      undefined,
      `memberOf's predicate must expose no "${mutator}" — a handle to the set is a way to make ` +
        "the membership test disagree with the vocabulary it was built from",
    );
  }
  // And the vocabulary passed in must not be reachable through the closure by
  // mutating the caller's own array afterwards.
  const lanes: string[] = ["air", "sea"];
  const isMutable = memberOf(lanes);
  lanes.push("rail");
  assert.equal(isMutable("rail"), false, "the predicate must not follow later edits to the caller's array");
});

test("memberOf: an EMPTY vocabulary is refused, not silently accepted", () => {
  // A predicate over nothing answers false to everything, which is
  // indistinguishable from a correct rejection at every call site — so a
  // vocabulary that failed to load becomes a boundary that refuses everything
  // in silence.
  assert.throws(
    () => memberOf([]),
    (error: unknown) =>
      error instanceof InputError &&
      error.code === "vocabulary_empty" &&
      /EMPTY vocabulary/.test(error.message),
  );
});
