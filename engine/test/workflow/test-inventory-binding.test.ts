import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HarnessError } from "../../src/kernel/errors.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import { createTempDir } from "../support/temp-dir.ts";
import {
  assertTestInventoryBindingSourceSnapshot,
  assertTestRunMatchesInventory,
  loadTestInventoryBinding,
  type TestInventoryBinding,
  type TestInventoryBindingEntry,
} from "../../src/workflow/test-inventory-binding.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PINNED_SCHEMA = ROOT_POLICY.verification.testInventorySchema;
const PINNED_HASH = ROOT_POLICY.verification.testInventoryHash;

function entry(sourceId: string, sourceHash: string, name: string): TestInventoryBindingEntry {
  return Object.freeze({ id: sha256(`${sourceId}${name}`), sourceId, sourceHash, name });
}

function binding(entries: readonly TestInventoryBindingEntry[]): TestInventoryBinding {
  const expectedIdsByKey = new Map<string, string>();
  for (const item of entries) expectedIdsByKey.set(`${item.sourceId}\0${item.name}`, item.id);
  return Object.freeze({
    inventoryPath: VERIFICATION_PATHS.testInventory,
    inventoryHash: PINNED_HASH,
    entries: Object.freeze([...entries]),
    sourceIds: Object.freeze([...new Set(entries.map((item) => item.sourceId))].sort()),
    expectedIdsByKey,
  });
}

function writeInventory(root: string, document: unknown): void {
  mkdirSync(join(root, "traceability"), { recursive: true });
  writeFileSync(join(root, VERIFICATION_PATHS.testInventory), JSON.stringify(document));
}

function validDocument(tests: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemaVersion: PINNED_SCHEMA,
    inventoryHash: PINNED_HASH,
    tests,
  };
}

function validEntry(sourceId: string, name: string): Record<string, unknown> {
  return {
    id: sha256(`id:${sourceId}:${name}`),
    sourceId,
    sourceHash: sha256(`source:${sourceId}`),
    name,
  };
}

function assertStale(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof HarnessError);
    assert.equal((error as HarnessError).code, "test_inventory_stale");
    assert.match((error as HarnessError).message, pattern);
    return true;
  });
}

test("inventory-binding: loads the repository pinned inventory", () => {
  const bound = loadTestInventoryBinding(REPO_ROOT);
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, VERIFICATION_PATHS.testInventory), "utf8")) as {
    tests: readonly { id: string; sourceId: string; name: string }[];
  };
  assert.equal(bound.inventoryHash, PINNED_HASH);
  assert.equal(bound.entries.length, raw.tests.length);
  assert.equal(bound.expectedIdsByKey.size, raw.tests.length);
  const expectedSources = [...new Set(raw.tests.map((item) => item.sourceId))].sort();
  assert.deepEqual([...bound.sourceIds], expectedSources);
  for (const item of raw.tests) {
    assert.equal(bound.expectedIdsByKey.get(`${item.sourceId}\0${item.name}`), item.id);
  }
});

test("inventory-binding: missing inventory file is stale", () => {
  const root = createTempDir("inventory-binding-missing-");
  try {
    assertStale(() => loadTestInventoryBinding(root), /unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory-binding: non-JSON inventory is stale", () => {
  const root = createTempDir("inventory-binding-json-");
  try {
    mkdirSync(join(root, "traceability"), { recursive: true });
    writeFileSync(join(root, VERIFICATION_PATHS.testInventory), "not json");
    assertStale(() => loadTestInventoryBinding(root), /not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory-binding: schema drift is stale", () => {
  const root = createTempDir("inventory-binding-schema-");
  try {
    const document = validDocument([validEntry("test/a.test.ts", "alpha")]);
    document.schemaVersion = "bridlewise-test-inventory/v0";
    writeInventory(root, document);
    assertStale(() => loadTestInventoryBinding(root), /does not match the pinned schema/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory-binding: hash not matching the root-policy pin is stale", () => {
  const root = createTempDir("inventory-binding-pin-");
  try {
    const document = validDocument([validEntry("test/a.test.ts", "alpha")]);
    document.inventoryHash = "0".repeat(64);
    writeInventory(root, document);
    assertStale(() => loadTestInventoryBinding(root), /does not match the root-policy pin/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory-binding: empty tests array is stale", () => {
  const root = createTempDir("inventory-binding-empty-");
  try {
    writeInventory(root, validDocument([]));
    assertStale(() => loadTestInventoryBinding(root), /contains no tests/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory-binding: malformed entry is stale", () => {
  const root = createTempDir("inventory-binding-entry-");
  try {
    writeInventory(root, validDocument([{ id: "nope", sourceId: "test/a.test.ts", sourceHash: "0".repeat(64), name: "alpha" }]));
    assertStale(() => loadTestInventoryBinding(root), /entry is invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory-binding: duplicate source-name pair is stale", () => {
  const root = createTempDir("inventory-binding-duplicate-");
  try {
    writeInventory(root, validDocument([
      validEntry("test/a.test.ts", "alpha"),
      validEntry("test/a.test.ts", "alpha"),
    ]));
    assertStale(() => loadTestInventoryBinding(root), /duplicate entry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory-binding: conflicting source hashes for one source are stale", () => {
  const root = createTempDir("inventory-binding-conflict-");
  try {
    const first = validEntry("test/a.test.ts", "alpha");
    const second = { ...validEntry("test/a.test.ts", "beta"), sourceHash: "f".repeat(64) };
    writeInventory(root, validDocument([first, second]));
    assertStale(() => loadTestInventoryBinding(root), /conflicting source hashes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory-binding: scope not covering the entry sources is stale", () => {
  const root = createTempDir("inventory-binding-scope-");
  try {
    const document = validDocument([validEntry("test/a.test.ts", "alpha")]);
    document.scope = { canonicalNodeSourceIds: ["test/other.test.ts"] };
    writeInventory(root, document);
    assertStale(() => loadTestInventoryBinding(root), /scope does not match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory-binding: source snapshot passes when bytes match", () => {
  const root = createTempDir("inventory-binding-snapshot-");
  try {
    mkdirSync(join(root, "test"), { recursive: true });
    const bytes = Buffer.from("content", "utf8");
    writeFileSync(join(root, "test/a.test.ts"), bytes);
    const bound = binding([entry("test/a.test.ts", sha256(bytes), "alpha")]);
    assertTestInventoryBindingSourceSnapshot(root, bound);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory-binding: source snapshot fails when the file is missing", () => {
  const root = createTempDir("inventory-binding-snapshot-missing-");
  try {
    const bound = binding([entry("test/a.test.ts", "0".repeat(64), "alpha")]);
    assertStale(() => assertTestInventoryBindingSourceSnapshot(root, bound), /source is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory-binding: source snapshot fails when bytes changed", () => {
  const root = createTempDir("inventory-binding-snapshot-drift-");
  try {
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test/a.test.ts"), "changed");
    const bound = binding([entry("test/a.test.ts", sha256("original"), "alpha")]);
    assertStale(() => assertTestInventoryBindingSourceSnapshot(root, bound), /snapshot is stale/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory-binding: run matching succeeds when every inventoried test is discovered once", () => {
  const bound = binding([
    entry("test/a.test.ts", "0".repeat(64), "alpha"),
    entry("test/a.test.ts", "0".repeat(64), "beta"),
    entry("test/b.test.ts", "1".repeat(64), "gamma"),
  ]);
  const accounting = assertTestRunMatchesInventory("/root", bound, {
    tests: [
      { name: "alpha", file: "test/a.test.ts", status: "pass" },
      { name: "beta", file: "test/a.test.ts", status: "pass" },
      { name: "gamma", file: "test/b.test.ts", status: "fail" },
    ],
  });
  assert.equal(accounting.expectedCount, 3);
  assert.equal(accounting.discoveredCount, 3);
});

test("inventory-binding: run matching fails when an inventoried test is missing", () => {
  const bound = binding([
    entry("test/a.test.ts", "0".repeat(64), "alpha"),
    entry("test/a.test.ts", "0".repeat(64), "beta"),
  ]);
  assertMismatch(bound, [{ name: "alpha", file: "test/a.test.ts", status: "pass" }], /1 missing/);
});

test("inventory-binding: run matching fails on an un-inventoried test", () => {
  const bound = binding([entry("test/a.test.ts", "0".repeat(64), "alpha")]);
  assertMismatch(bound, [
    { name: "alpha", file: "test/a.test.ts", status: "pass" },
    { name: "surprise", file: "test/a.test.ts", status: "pass" },
  ], /1 unknown/);
});

test("inventory-binding: run matching fails on a duplicated test", () => {
  const bound = binding([entry("test/a.test.ts", "0".repeat(64), "alpha")]);
  assertMismatch(bound, [
    { name: "alpha", file: "test/a.test.ts", status: "pass" },
    { name: "alpha", file: "test/a.test.ts", status: "pass" },
  ], /1 duplicate/);
});

test("inventory-binding: file wrapper entries are ignored", () => {
  const bound = binding([entry("test/a.test.ts", "0".repeat(64), "alpha")]);
  const accounting = assertTestRunMatchesInventory("/root", bound, {
    tests: [
      { name: "test/a.test.ts", file: "test/a.test.ts", status: "pass" },
      { name: resolve("/root", "test/a.test.ts"), file: "test/a.test.ts", status: "pass" },
      { name: "alpha", file: "test/a.test.ts", status: "pass" },
    ],
  });
  assert.equal(accounting.discoveredCount, 1);
});

function assertMismatch(
  bound: TestInventoryBinding,
  tests: readonly { name: string; file: string; status: string }[],
  pattern: RegExp,
): void {
  assert.throws(
    () => assertTestRunMatchesInventory("/root", bound, { tests }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessError);
      assert.equal((error as HarnessError).code, "test_inventory_run_mismatch");
      assert.match((error as HarnessError).message, pattern);
      return true;
    },
  );
}
