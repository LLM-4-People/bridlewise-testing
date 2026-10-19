import assert from "node:assert/strict";
import test from "node:test";

import { InputError } from "../../src/kernel/errors.ts";
import { snapshotJsonValue } from "../../src/kernel/safe-structural.ts";

const LIMITS = { maximumDepth: 8, maximumNodes: 32 } as const;
const ERROR_CODES = {
  maximumDepth: "test_maximum_depth",
  maximumNodes: "test_maximum_nodes",
  nonFiniteNumber: "test_non_finite_number",
  nonJsonValue: "test_non_json",
  proxy: "test_proxy",
  cycle: "test_cycle",
  arrayPrototype: "test_array_prototype",
  sparseArray: "test_sparse_array",
  arrayProperty: "test_array_property",
  objectPrototype: "test_object_prototype",
  symbolKey: "test_symbol_key",
  objectProperty: "test_object_property",
} as const;

function expectCode(candidate: unknown, code: string): void {
  assert.throws(
    () => snapshotJsonValue(candidate, LIMITS, "test_structural", ERROR_CODES),
    (error: unknown) => error instanceof InputError && error.code === code,
  );
}

test("safe structural snapshot rejects NaN and both infinities at every JSON position", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    for (const candidate of [value, [value], { value }, { nested: [{ value }] }]) {
      expectCode(candidate, ERROR_CODES.nonFiniteNumber);
    }
  }
});

test("safe structural snapshot rejects proxies and accessors without invoking traps", () => {
  let trapCalls = 0;
  const proxy = new Proxy({}, new Proxy({}, {
    get() {
      trapCalls += 1;
      throw new Error("proxy trap executed");
    },
  }));
  expectCode(proxy, ERROR_CODES.proxy);
  assert.equal(trapCalls, 0);

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("getter executed");
    },
  });
  expectCode(accessor, ERROR_CODES.objectProperty);
  assert.equal(getterCalls, 0);
});

test("safe structural snapshot classifies hidden inherited cyclic and non-JSON structures", () => {
  const hidden = {};
  Object.defineProperty(hidden, "hidden", { value: true, enumerable: false });
  expectCode(hidden, ERROR_CODES.objectProperty);
  expectCode(Object.create({ inherited: true }), ERROR_CODES.objectPrototype);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expectCode(cycle, ERROR_CODES.cycle);
  expectCode({ value: undefined }, ERROR_CODES.nonJsonValue);
  expectCode({ [Symbol("key")]: true }, ERROR_CODES.symbolKey);
});

test("safe structural snapshot enforces depth and node ceilings exactly", () => {
  assert.deepEqual(snapshotJsonValue([[[[[[[[0]]]]]]]], LIMITS), [[[[[[[[0]]]]]]]]);
  expectCode([[[[[[[[[0]]]]]]]]], ERROR_CODES.maximumDepth);
  assert.deepEqual(snapshotJsonValue(Array(31).fill(0), LIMITS), Array(31).fill(0));
  expectCode(Array(32).fill(0), ERROR_CODES.maximumNodes);
});
