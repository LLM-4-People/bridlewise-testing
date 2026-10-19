import assert from "node:assert/strict";
import test from "node:test";

import { InputError } from "../src/kernel/errors.ts";
import {
  canonicalizeLedgerJsonText,
  type LedgerCanonicalLimits,
} from "../src/kernel/ledger-canonical.ts";
import {
  defineCompleteStructuralSnapshotErrorCodes,
  STRUCTURAL_SNAPSHOT_ERROR_KINDS,
} from "../src/kernel/safe-structural.ts";

type ErrorProjection = Readonly<{
  name: string;
  message: string;
  code: string;
  retryable: boolean;
  safeDetails: Readonly<Record<string, string | number | boolean>>;
}>;

const NONFINITE_VALUES = Object.freeze([
  ["nan", Number.NaN],
  ["positive-infinity", Number.POSITIVE_INFINITY],
  ["negative-infinity", Number.NEGATIVE_INFINITY],
] as const);

const NONFINITE_PLACEMENTS = Object.freeze([
  ["root", (value: number): unknown => value],
  ["array", (value: number): unknown => [value]],
  ["object", (value: number): unknown => ({ value })],
  ["deep-nested", (value: number): unknown => ({ outer: [{ inner: value }] })],
] as const);

const EXPECTED_NONFINITE_PROJECTION: ErrorProjection = Object.freeze({
  name: "InputError",
  message: "Non-finite numbers are forbidden",
  code: "ledger_json_number_invalid",
  retryable: false,
  safeDetails: Object.freeze({}),
});

test("ledger canonicalization maps every non-finite value at every JSON placement to the number taxonomy", () => {
  for (const [valueName, value] of NONFINITE_VALUES) {
    for (const [placementName, place] of NONFINITE_PLACEMENTS) {
      const projection = captureError(() => canonicalizeLedgerJsonText(place(value)));
      assert.deepEqual(projection, EXPECTED_NONFINITE_PROJECTION, `${valueName}/${placementName}`);
      assert.equal(Object.isFrozen(projection.safeDetails), true, `${valueName}/${placementName}`);
      assert.deepEqual(Object.keys(projection).toSorted(), [
        "code",
        "message",
        "name",
        "retryable",
        "safeDetails",
      ]);
    }
  }
});

test("all pre-existing hostile ledger inputs retain their exact structural taxonomy", () => {
  const cases: readonly Readonly<{
    name: string;
    candidate: () => unknown;
    code: string;
    message: string;
    limits?: LedgerCanonicalLimits;
  }>[] = [
    {
      name: "undefined-root",
      candidate: () => undefined,
      code: "ledger_json_value_invalid",
      message: "Non-JSON value is forbidden",
    },
    {
      name: "undefined-nested",
      candidate: () => ({ value: undefined }),
      code: "ledger_json_value_invalid",
      message: "Non-JSON value is forbidden",
    },
    {
      name: "function-root",
      candidate: () => function candidate(): void {},
      code: "ledger_json_value_invalid",
      message: "Non-JSON value is forbidden",
    },
    {
      name: "function-nested",
      candidate: () => [() => true],
      code: "ledger_json_value_invalid",
      message: "Non-JSON value is forbidden",
    },
    {
      name: "symbol-root",
      candidate: () => Symbol("value"),
      code: "ledger_json_value_invalid",
      message: "Non-JSON value is forbidden",
    },
    {
      name: "bigint-root",
      candidate: () => 1n,
      code: "ledger_json_value_invalid",
      message: "Non-JSON value is forbidden",
    },
    {
      name: "cycle",
      candidate: () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
      code: "ledger_json_cycle",
      message: "Cyclic input is forbidden",
    },
    {
      name: "maximum-depth",
      candidate: () => ({ outer: { inner: 1 } }),
      code: "ledger_json_depth_exceeded",
      message: "Structural snapshot exceeds its depth bound",
      limits: limits({ maximumDepth: 1 }),
    },
    {
      name: "maximum-nodes",
      candidate: () => [1, 2, 3],
      code: "ledger_json_nodes_exceeded",
      message: "Structural snapshot exceeds its node bound",
      limits: limits({ maximumNodes: 3 }),
    },
    {
      name: "symbol-key",
      candidate: () => ({ [Symbol("key")]: true }),
      code: "ledger_json_key_invalid",
      message: "Symbol keys are forbidden",
    },
    {
      name: "lone-surrogate-string",
      candidate: () => "\ud800",
      code: "ledger_json_unicode_invalid",
      message: "Ledger JSON contains a lone surrogate",
    },
    {
      name: "typed-array",
      candidate: () => new Uint16Array([1]),
      code: "ledger_json_object_invalid",
      message: "Class instances are forbidden",
    },
    {
      name: "array-subclass",
      candidate: () => new (class extends Array<unknown> {})(1),
      code: "ledger_json_array_invalid",
      message: "Array subclasses are forbidden",
    },
    {
      name: "sparse-array",
      candidate: () => {
        const value: unknown[] = [];
        value.length = 2;
        value[1] = 1;
        return value;
      },
      code: "ledger_json_sparse_array",
      message: "Sparse or exotic arrays are forbidden",
    },
    {
      name: "array-accessor",
      candidate: () => Object.defineProperty([1], "0", { enumerable: true, get: () => 1 }),
      code: "ledger_json_array_invalid",
      message: "Array accessors and holes are forbidden",
    },
    {
      name: "array-extra-property",
      candidate: () => Object.assign([1], { extra: true }),
      code: "ledger_json_sparse_array",
      message: "Sparse or exotic arrays are forbidden",
    },
    {
      name: "unsupported-object-prototype",
      candidate: () => new Date(0),
      code: "ledger_json_object_invalid",
      message: "Class instances are forbidden",
    },
    {
      name: "hidden-object-property",
      candidate: () => Object.defineProperty({}, "value", { value: 1, enumerable: false }),
      code: "ledger_json_object_invalid",
      message: "Accessors and hidden properties are forbidden",
    },
    {
      name: "object-accessor",
      candidate: () => Object.defineProperty({}, "value", { enumerable: true, get: () => 1 }),
      code: "ledger_json_object_invalid",
      message: "Accessors and hidden properties are forbidden",
    },
    {
      name: "negative-zero",
      candidate: () => -0,
      code: "ledger_json_negative_zero",
      message: "Ledger JSON contains negative zero",
    },
    {
      name: "string-output-bound",
      candidate: () => "12345678",
      code: "ledger_json_output_too_large",
      message: "Canonical ledger JSON exceeds the output byte ceiling",
      limits: limits({ maximumCanonicalBytes: 4 }),
    },
  ];

  for (const fixture of cases) {
    const projection = captureError(() => canonicalizeLedgerJsonText(fixture.candidate(), fixture.limits));
    assert.deepEqual(projection, {
      name: "InputError",
      message: fixture.message,
      code: fixture.code,
      retryable: false,
      safeDetails: {},
    }, fixture.name);
    assert.notEqual(projection.code, "ledger_json_structure_invalid", fixture.name);
  }
});

test("the complete structural error-code constructor enforces the exact runtime key set", () => {
  const complete = Object.fromEntries(
    STRUCTURAL_SNAPSHOT_ERROR_KINDS.map((kind) => [kind, `test_${kind}`] as const),
  );
  const result = Reflect.apply(defineCompleteStructuralSnapshotErrorCodes, undefined, [complete]);
  assert.deepEqual(Object.keys(result), [...STRUCTURAL_SNAPSHOT_ERROR_KINDS]);
  assert.equal(Object.isFrozen(result), true);

  const invalidCandidates: unknown[] = [];
  const missing = { ...complete };
  Reflect.deleteProperty(missing, STRUCTURAL_SNAPSHOT_ERROR_KINDS[0]);
  invalidCandidates.push(missing, { ...complete, unexpected: "test_unexpected" });
  invalidCandidates.push({ ...complete, [STRUCTURAL_SNAPSHOT_ERROR_KINDS[0]]: "" });
  invalidCandidates.push(Object.create({ ...complete }));
  invalidCandidates.push(new Proxy(complete, {}));
  invalidCandidates.push(Object.defineProperty({ ...complete }, STRUCTURAL_SNAPSHOT_ERROR_KINDS[0], {
    enumerable: true,
    get: () => "test_accessor",
  }));

  for (const candidate of invalidCandidates) {
    assert.throws(
      () => Reflect.apply(defineCompleteStructuralSnapshotErrorCodes, undefined, [candidate]),
      (error: unknown) => error instanceof InputError && error.code === "unsafe_structural_error_codes",
    );
  }
});

function captureError(action: () => unknown): ErrorProjection {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof InputError);
    return Object.freeze({
      name: error.name,
      message: error.message,
      code: error.code,
      retryable: error.retryable,
      safeDetails: error.safeDetails,
    });
  }
  return assert.fail("Expected InputError");
}

function limits(overrides: Partial<LedgerCanonicalLimits>): LedgerCanonicalLimits {
  return {
    maximumInputBytes: 128,
    maximumCanonicalBytes: 128,
    maximumDepth: 8,
    maximumNodes: 32,
    ...overrides,
  };
}
