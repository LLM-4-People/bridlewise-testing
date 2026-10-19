import assert from "node:assert/strict";
import test from "node:test";

import {
  assertString,
  optionalString,
  resolveBoolean,
  resolvePositiveInt,
} from "../../src/runtime/tool-args.ts";
import { InputError } from "../../src/kernel/errors.ts";

// ---------------------------------------------------------------------------
// Canonical tool-argument validators (single owner for assertString /
// optionalString / resolveBoolean / resolvePositiveInt). Covers valid input,
// missing input, wrong type, and boundary conditions.
// ---------------------------------------------------------------------------

function expectInputError(fn: () => unknown, message: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof InputError, `expected InputError; got ${(e as Error)?.name}`);
    assert.match((e as Error).message, message);
    return true;
  });
}

// ============================================================================
// assertString
// ============================================================================

test("tool-args: assertString returns a valid non-empty string", () => {
  assert.equal(assertString({ name: "hello" }, "name"), "hello");
});

test("tool-args: assertString returns a valid string within maxLength", () => {
  assert.equal(assertString({ name: "hello" }, "name", { maxLength: 10 }), "hello");
});

test("tool-args: assertString throws when missing", () => {
  expectInputError(() => assertString({}, "name"), /name must be a non-empty string/);
});

test("tool-args: assertString throws when null", () => {
  expectInputError(() => assertString({ name: null }, "name"), /name must be a non-empty string/);
});

test("tool-args: assertString throws when empty string", () => {
  expectInputError(() => assertString({ name: "" }, "name"), /name must be a non-empty string/);
});

test("tool-args: assertString throws when not a string", () => {
  expectInputError(() => assertString({ name: 42 }, "name"), /name must be a non-empty string/);
});

test("tool-args: assertString throws when exceeding maxLength", () => {
  expectInputError(
    () => assertString({ name: "x".repeat(11) }, "name", { maxLength: 10 }),
    /name exceeds maximum length/,
  );
});

test("tool-args: assertString accepts a string exactly at maxLength", () => {
  assert.equal(assertString({ name: "x".repeat(10) }, "name", { maxLength: 10 }), "x".repeat(10));
});

// ============================================================================
// optionalString
// ============================================================================

test("tool-args: optionalString returns a valid string", () => {
  assert.equal(optionalString({ name: "hello" }, "name"), "hello");
});

test("tool-args: optionalString returns undefined when missing", () => {
  assert.equal(optionalString({}, "name"), undefined);
});

test("tool-args: optionalString returns undefined when null", () => {
  assert.equal(optionalString({ name: null }, "name"), undefined);
});

test("tool-args: optionalString throws when present but not a string", () => {
  expectInputError(() => optionalString({ name: 42 }, "name"), /name must be a string/);
});

test("tool-args: optionalString throws when exceeding maxLength", () => {
  expectInputError(
    () => optionalString({ name: "x".repeat(11) }, "name", { maxLength: 10 }),
    /name exceeds maximum length/,
  );
});

test("tool-args: optionalString accepts empty string (only missing/null are omitted)", () => {
  assert.equal(optionalString({ name: "" }, "name"), "");
});

test("tool-args: optionalString accepts a string exactly at maxLength", () => {
  assert.equal(optionalString({ name: "x".repeat(10) }, "name", { maxLength: 10 }), "x".repeat(10));
});

// ============================================================================
// resolveBoolean
// ============================================================================

test("tool-args: resolveBoolean returns the value when true", () => {
  assert.equal(resolveBoolean({ flag: true }, "flag", false), true);
});

test("tool-args: resolveBoolean returns the value when false", () => {
  assert.equal(resolveBoolean({ flag: false }, "flag", true), false);
});

test("tool-args: resolveBoolean returns the default when missing", () => {
  assert.equal(resolveBoolean({}, "flag", true), true);
  assert.equal(resolveBoolean({}, "flag", false), false);
});

test("tool-args: resolveBoolean returns the default when null", () => {
  assert.equal(resolveBoolean({ flag: null }, "flag", true), true);
});

test("tool-args: resolveBoolean throws when not a boolean", () => {
  expectInputError(() => resolveBoolean({ flag: "yes" }, "flag", false), /flag must be a boolean/);
  expectInputError(() => resolveBoolean({ flag: 1 }, "flag", false), /flag must be a boolean/);
});

// ============================================================================
// resolvePositiveInt
// ============================================================================

test("tool-args: resolvePositiveInt returns a valid positive integer", () => {
  assert.equal(resolvePositiveInt({ count: 5 }, "count"), 5);
});

test("tool-args: resolvePositiveInt returns the default when missing", () => {
  assert.equal(resolvePositiveInt({}, "count", { defaultValue: 7 }), 7);
});

test("tool-args: resolvePositiveInt returns the default when null", () => {
  assert.equal(resolvePositiveInt({ count: null }, "count", { defaultValue: 7 }), 7);
});

test("tool-args: resolvePositiveInt throws when missing without a default", () => {
  expectInputError(() => resolvePositiveInt({}, "count"), /count must be a positive integer/);
});

test("tool-args: resolvePositiveInt throws when not a number", () => {
  expectInputError(() => resolvePositiveInt({ count: "5" }, "count"), /count must be a positive integer/);
});

test("tool-args: resolvePositiveInt throws when not an integer", () => {
  expectInputError(() => resolvePositiveInt({ count: 1.5 }, "count"), /count must be a positive integer/);
});

test("tool-args: resolvePositiveInt throws when zero or negative", () => {
  expectInputError(() => resolvePositiveInt({ count: 0 }, "count"), /count must be a positive integer/);
  expectInputError(() => resolvePositiveInt({ count: -3 }, "count"), /count must be a positive integer/);
});

test("tool-args: resolvePositiveInt throws when exceeding max", () => {
  expectInputError(
    () => resolvePositiveInt({ count: 101 }, "count", { max: 100 }),
    /count must be a positive integer <= 100/,
  );
});

test("tool-args: resolvePositiveInt accepts a value exactly at max", () => {
  assert.equal(resolvePositiveInt({ count: 100 }, "count", { max: 100 }), 100);
});

test("tool-args: resolvePositiveInt accepts defaultValue at max boundary when missing", () => {
  assert.equal(resolvePositiveInt({}, "count", { defaultValue: 100, max: 100 }), 100);
});
