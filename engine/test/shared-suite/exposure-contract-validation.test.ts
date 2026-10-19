import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";

import { HarnessError, InputError, safeError } from "../../src/kernel/errors.ts";
import {
  clearAll,
  CONTRACT_ENUMS,
  registerSignal,
  resolveContract,
  validateContract,
} from "../../src/shared/exposure/index.ts";

/**
 * Exposure contract validation — typed rejection, and no unvalidated field.
 *
 * TWO DEFECTS THIS GUARDS
 *
 * 1. `validateContract` threw a BARE `Error` for an unknown determinism /
 *    effect / audience. `safeError()` maps anything that is not a
 *    `HarnessError` to `internal_error`, so an operator registering
 *    `audience: "operater"` was reported to the CLI as an internal harness
 *    fault with no code to act on — indistinguishable from a crash.
 *
 * 2. The check was three hand-written `if`s, one per field. The module header
 *    states the metadata vocabulary is expected to GROW, and the shape it grew
 *    in was "add the field to the type, forget the fourth `if`" — a declared
 *    field silently accepting any value, which is a deny-by-default breach.
 *
 * DYNAMIC DISCOVERY
 *
 * Every case below is derived from `CONTRACT_ENUMS`, the table the validator
 * itself rejects against. Adding a field, or a member to an existing field, is
 * covered with no edit here; removing one stops being required. There is no
 * list of field names or member names in this file.
 */

const CONTRACT_FIELDS = Object.entries(CONTRACT_ENUMS) as ReadonlyArray<
  readonly [string, readonly string[]]
>;

test("exposure contract: the validation table is non-empty and every field offers members", () => {
  assert.ok(CONTRACT_FIELDS.length > 0, "CONTRACT_ENUMS discovered no contract fields");
  for (const [field, allowed] of CONTRACT_FIELDS) {
    assert.ok(allowed.length > 0, `contract field "${field}" permits no values`);
  }
});

test("exposure contract: every permitted value of every field is accepted", () => {
  for (const [field, allowed] of CONTRACT_FIELDS) {
    for (const value of allowed) {
      assert.doesNotThrow(
        () => validateContract("demo.entry", { [field]: value }),
        `contract field "${field}" rejected its own permitted value "${value}"`,
      );
    }
  }
});

test("exposure contract: an unknown value in ANY field is rejected as a typed InputError", () => {
  for (const [field] of CONTRACT_FIELDS) {
    let thrown: unknown;
    try {
      validateContract("demo.entry", { [field]: "__not_a_member__" });
    } catch (error) {
      thrown = error;
    }
    assert.ok(
      thrown !== undefined,
      `contract field "${field}" silently accepted an unknown value — deny-by-default breach`,
    );
    assert.ok(
      thrown instanceof InputError,
      `contract field "${field}" threw ${(thrown as object)?.constructor?.name} — must be the typed InputError`,
    );
    const projected = safeError(thrown);
    assert.notEqual(
      projected.error,
      "internal_error",
      `an operator's bad "${field}" must not be reported as an internal harness fault`,
    );
    assert.equal((thrown as HarnessError).code, "exposure_contract_invalid");
    assert.equal((thrown as HarnessError).safeDetails.field, field);
    assert.equal((thrown as HarnessError).safeDetails.exposureId, "demo.entry");
    assert.ok(
      projected.message.includes(field),
      `the message must name the offending field, got: ${projected.message}`,
    );
  }
});

test("exposure contract: registration is the choke point — a bad contract cannot enter the registry", () => {
  clearAll();
  try {
    for (const [field] of CONTRACT_FIELDS) {
      assert.throws(
        () =>
          registerSignal({
            id: `demo.${field}Probe`,
            module: "demo",
            name: "Probe",
            description: "Probe.",
            type: "counter",
            value: () => 0,
            contract: { [field]: "__not_a_member__" } as never,
          }),
        InputError,
        `registerSignal accepted an invalid "${field}"`,
      );
    }
  } finally {
    clearAll();
  }
});

test("exposure contract: every table field resolves to `unspecified` when unstated", () => {
  const resolved = resolveContract() as Readonly<Record<string, unknown>>;
  for (const [field] of CONTRACT_FIELDS) {
    assert.equal(
      resolved[field],
      "unspecified",
      `unstated "${field}" must resolve to the honest "unspecified", not a guessed default`,
    );
  }
});

test("exposure contract: every enumerated field of the resolved contract is IN the validation table", () => {
  // The tests above derive their cases FROM `CONTRACT_ENUMS`, so they cannot
  // see a field that was declared on the contract and never added to the
  // table — the exact "declared but unvalidated" regression. This one crosses
  // two independent runtime structures instead: `resolveContract()` returns
  // every declared field, and an enumerated field is identifiable because its
  // unstated value is the `"unspecified"` member (a free-text field such as
  // `when` resolves to the empty string). Every such field must be validated.
  const resolved = resolveContract() as Readonly<Record<string, unknown>>;
  const tableFields = new Set(Object.keys(CONTRACT_ENUMS));
  const enumeratedFields = Object.keys(resolved).filter((field) => resolved[field] === "unspecified");
  assert.ok(enumeratedFields.length > 0, "discovery found no enumerated contract fields");
  const unvalidated = enumeratedFields.filter((field) => !tableFields.has(field)).toSorted();
  assert.deepEqual(
    unvalidated,
    [],
    "these contract fields are declared and resolved but absent from CONTRACT_ENUMS, so any " +
      "value is silently accepted for them",
  );
});

/**
 * The barrel is the SINGLE public import path for the exposure system. An
 * export that exists in a module but not in `index.ts` is unreachable by any
 * consumer — which is how `contractCoverage` came to be computed and never
 * readable. Discovered dynamically: every non-barrel module in the directory
 * is imported and its value exports compared against the barrel's.
 */
test("exposure barrel: every value export of every exposure module is reachable from index.ts", async () => {
  const directory = new URL("../../src/shared/exposure/", import.meta.url);
  const barrel = await import("../../src/shared/exposure/index.ts");
  const reachable = new Set(Object.keys(barrel));

  const modules = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "index.ts")
    .map((entry) => entry.name)
    .toSorted();
  assert.ok(modules.length > 0, "dynamic discovery found no exposure modules");

  const unreachable: string[] = [];
  for (const file of modules) {
    const loaded = await import(new URL(file, directory).href);
    for (const name of Object.keys(loaded)) {
      if (!reachable.has(name)) unreachable.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(
    unreachable,
    [],
    "these exposure exports are not re-exported from index.ts, so no consumer can import them",
  );
});
