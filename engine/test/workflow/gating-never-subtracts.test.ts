// A WITHHELD TEST IS A SKIPPED TEST, NEVER A SUBTRACTED ONE.
//
// This is the regression test for the largest hole the suite has had. The
// runner used to filter slow files out of the run AND out of the inventory
// the accounting compared against, so `skipped === 0` — the strongest
// condition in the passing gate — stayed satisfied against a denominator that
// had silently shrunk. Measured before the fix: 696 of 8,555 entries across 32
// files walked out that way and the receipt still read "passed"; four of the
// tests inside them failed deterministically, two of those on a stale pinned
// digest, and nobody had seen any of it.
//
// The dispatch-side filter is deleted, so nothing is withheld today. That
// deletion cannot be the whole guard, because a deletion leaves nothing behind
// to fail if someone reintroduces the filter — which is exactly how the
// original defect would return. So the accountant keeps ACCEPTING a withheld
// set and is asserted here to account for it honestly: present in the expected
// set, counted as skipped, and refused.
//
// Each assertion below is written so that removing the corresponding line from
// the accountant changes an answer. Dropping the gated ids from `skipped`
// leaves `passed` true; putting the subtraction back shrinks `expectedIds`;
// folding them into `discovered` without `skipped` breaks the terminal-count
// identity that the receipt validator independently enforces.

import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test, { type TestContext } from "node:test";

import { createInventoryTestAccountant } from "../../scripts/tooling/inventory-test-run.ts";
import { createTestReceipt, createTestResultReceipt } from "../../scripts/tooling/test-receipt.ts";
import { CANDIDATE_MANIFEST_SCHEMA_VERSION } from "../../scripts/verification/candidate-manifest.ts";
import { buildTestInventory as buildBoundTestInventory } from "../../scripts/test-inventory.ts";
import {
  createTestSurfaceDispositionManifest,
  isQualifiedCanonicalNodeTestSource,
  recognizableTestSourceLanguage,
  type TestSurfaceDispositionEntry,
} from "../../scripts/verification/test-surface.ts";
import { createRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";

const CANDIDATE_IDENTITY = {
  manifestSchemaVersion: CANDIDATE_MANIFEST_SCHEMA_VERSION,
  formatPolicyRevision: "candidate-format/v1",
  semanticTreeHash: "0".repeat(64),
  formatVerificationHash: "1".repeat(64),
} as const;

function temporaryRoot(t: TestContext): string {
  const root = createRepositoryLocalTemporaryDirectory("gating-never-subtracts-");
  mkdirSync(join(root, "test"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeTest(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function buildInventory(root: string) {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split("\\").join("/");
      if (recognizableTestSourceLanguage(path) !== undefined) paths.push(path);
      if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  const entries: TestSurfaceDispositionEntry[] = paths.map((path) => {
    const language = recognizableTestSourceLanguage(path)!;
    const canonical = isQualifiedCanonicalNodeTestSource(path);
    return {
      path,
      language,
      disposition: canonical ? "canonical-node-test" : "unsupported-blocking",
      rationale: canonical
        ? "Synthetic qualified Node inventory fixture."
        : "Synthetic recognizable but unqualified test surface.",
      evidenceLinks: [],
      blocksFullRepositoryClaim: !canonical,
    } satisfies TestSurfaceDispositionEntry;
  });
  return buildBoundTestInventory(root, { dispositionManifest: createTestSurfaceDispositionManifest(entries) });
}

function twoFileRoot(t: TestContext): { root: string; inventory: ReturnType<typeof buildInventory> } {
  const root = temporaryRoot(t);
  writeTest(root, "test/kept.test.ts", [
    'import test from "node:test";',
    'test("kept one", () => undefined);',
    'test("kept two", () => undefined);',
    "",
  ].join("\n"));
  writeTest(root, "test/withheld.test.ts", [
    'import test from "node:test";',
    'test("withheld one", () => undefined);',
    'test("withheld two", () => undefined);',
    'test("withheld three", () => undefined);',
    "",
  ].join("\n"));
  return { root, inventory: buildInventory(root) };
}

test("a withheld source is still expected, is counted skipped, and refuses the run", (t) => {
  const { root, inventory } = twoFileRoot(t);
  const withheldSourceId = "test/withheld.test.ts";
  const keptEntries = inventory.tests.filter((entry) => entry.sourceId !== withheldSourceId);
  const withheldEntries = inventory.tests.filter((entry) => entry.sourceId === withheldSourceId);
  // Liveness on the fixture itself: without both halves present and non-empty
  // every assertion below is satisfied by an inventory that never had a
  // withheld file in it.
  assert.equal(keptEntries.length, 2);
  assert.equal(withheldEntries.length, 3);

  const accountant = createInventoryTestAccountant(root, inventory, {
    gatedSourceIds: new Set([withheldSourceId]),
  });
  for (const entry of keptEntries) {
    const file = join(root, entry.sourceId);
    accountant.observe({ type: "test:enqueue", data: { file, name: entry.name } });
    accountant.observe({ type: "test:pass", data: { file, name: entry.name } });
  }
  // The runner only ever saw the dispatched files, so its summary counts two.
  accountant.observe({ type: "test:summary", data: { success: true, counts: { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0 } } });
  const accounting = accountant.complete();

  // NO SUBTRACTION: the expected set is the whole inventory, withheld included.
  assert.equal(accounting.expectedIds.length, inventory.tests.length);
  for (const entry of withheldEntries) {
    assert.ok(accounting.expectedIds.includes(entry.id), `withheld entry must stay expected: ${entry.name}`);
  }
  // COUNTED, NOT VANISHED.
  assert.equal(accounting.counts.skipped, withheldEntries.length);
  assert.equal(accounting.counts.discovered, inventory.tests.length);
  assert.equal(accounting.counts.passed, keptEntries.length);
  // The terminal-count identity the receipt validator enforces independently.
  const terminal = accounting.counts.passed + accounting.counts.failed +
    accounting.counts.skipped + accounting.counts.todo + accounting.counts.cancelled;
  assert.equal(terminal, accounting.counts.discovered);
  // AND THE GATE FIRES, with no new mechanism: `skipped === 0` does it.
  assert.equal(accounting.passed, false);
  assert.ok(accounting.reasons.includes("test-skipped"),
    `expected a test-skipped reason, got ${accounting.reasons.join(", ")}`);
  assert.deepEqual([...accounting.gatedTestIds].toSorted(), withheldEntries.map((entry) => entry.id).toSorted());
});

test("the same run with nothing withheld passes — the refusal is caused by the withholding, not by the fixture", (t) => {
  // The control. Without it, an accountant that refused every run would
  // satisfy the test above while proving nothing about withholding.
  const { root, inventory } = twoFileRoot(t);
  const accountant = createInventoryTestAccountant(root, inventory);
  for (const entry of inventory.tests) {
    const file = join(root, entry.sourceId);
    accountant.observe({ type: "test:enqueue", data: { file, name: entry.name } });
    accountant.observe({ type: "test:pass", data: { file, name: entry.name } });
  }
  accountant.observe({ type: "test:summary", data: { success: true, counts: { tests: 5, passed: 5, failed: 0, cancelled: 0, skipped: 0, todo: 0 } } });
  const accounting = accountant.complete();
  assert.equal(accounting.counts.skipped, 0);
  assert.equal(accounting.counts.passed, inventory.tests.length);
  assert.deepEqual([...accounting.gatedTestIds], []);
  assert.equal(accounting.passed, true);
});

test("the runner summary is compared against what was DISPATCHED, not against the inventory", (t) => {
  // The half that is easy to get wrong in the opposite direction. The node
  // runner can only report on the files it was handed, so comparing its
  // summary against the full inventory would make every withheld run fail for
  // the wrong reason — "the runner disagreed" instead of "tests were
  // withheld" — and would hide a genuine runner/inventory mismatch behind the
  // withholding. A summary that matches the dispatched count must NOT produce
  // a runner-summary reason.
  const { root, inventory } = twoFileRoot(t);
  const withheldSourceId = "test/withheld.test.ts";
  const keptEntries = inventory.tests.filter((entry) => entry.sourceId !== withheldSourceId);
  const accountant = createInventoryTestAccountant(root, inventory, {
    gatedSourceIds: new Set([withheldSourceId]),
  });
  for (const entry of keptEntries) {
    const file = join(root, entry.sourceId);
    accountant.observe({ type: "test:enqueue", data: { file, name: entry.name } });
    accountant.observe({ type: "test:pass", data: { file, name: entry.name } });
  }
  accountant.observe({ type: "test:summary", data: { success: true, counts: { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0 } } });
  const accounting = accountant.complete();
  assert.equal(accounting.runnerSummaryObserved, true);
  assert.equal(accounting.runnerSuccessful, true);
  assert.ok(!accounting.reasons.includes("runner-summary-counts-mismatch"),
    `a dispatched-count match must not be reported as a runner mismatch: ${accounting.reasons.join(", ")}`);
  assert.ok(!accounting.reasons.includes("runner-summary-unsuccessful"),
    `a dispatched-count match must not be reported as an unsuccessful runner: ${accounting.reasons.join(", ")}`);
});

// ── THE SECOND COPY OF THE SUBTRACTION ────────────────────────────────────
//
// The accountant was not the only place that shrank the expected set: the
// RECEIPT VALIDATOR made the same subtraction, so a receipt describing a run
// that never dispatched 696 tests validated as complete. One defect, written
// twice — and the second copy lived in the instrument whose job is to catch
// the first. These two tests hold that door from both sides.

test("a receipt that reports withheld entries as discovered-and-skipped is accepted", (t) => {
  const { inventory } = twoFileRoot(t);
  const ids = inventory.tests.map((entry) => entry.id);
  const withheld = ids.slice(0, 2);
  const executed = ids.slice(2);
  // Discovered = everything, passed = only what ran, skipped = the withheld.
  const receipt = createTestReceipt(CANDIDATE_IDENTITY, inventory, ids, executed, {
    discovered: ids.length,
    passed: executed.length,
    failed: 0,
    skipped: withheld.length,
    todo: 0,
    cancelled: 0,
  }, withheld);
  assert.equal(receipt.counts.skipped, withheld.length);
  assert.equal(receipt.discoveredTestIds.length, ids.length);
  assert.deepEqual([...receipt.gatedTestIds], withheld);
});

test("a receipt that OMITS withheld entries from the expected accounting is refused", (t) => {
  const { inventory } = twoFileRoot(t);
  const ids = inventory.tests.map((entry) => entry.id);
  const withheld = ids.slice(0, 2);
  const executed = ids.slice(2);
  // This is the shape the old code produced AND accepted: the withheld
  // entries simply absent, every count self-consistent against a denominator
  // that had shrunk, and `skipped` a truthful-looking zero. It is internally
  // consistent, so it still CONSTRUCTS — what changed is that it can no
  // longer be called passing, because the expected set it is measured against
  // is the whole inventory rather than the inventory minus itself.
  const receipt = createTestReceipt(CANDIDATE_IDENTITY, inventory, executed, executed, {
    discovered: executed.length,
    passed: executed.length,
    failed: 0,
    skipped: 0,
    todo: 0,
    cancelled: 0,
  }, withheld);
  const result = createTestResultReceipt(receipt, {
    eventCount: 1,
    successful: true,
    counts: { tests: executed.length, failed: 0, passed: executed.length, cancelled: 0, skipped: 0, todo: 0 },
  }, CANDIDATE_IDENTITY, [], []);
  assert.equal(result.result.status, "failed");
  assert.equal(result.result.exitCode, 1);
  assert.ok(result.result.diagnostic !== null);
  assert.ok(result.result.diagnostic.reasons.includes("inventory-incomplete-pass"),
    `expected an inventory-incompleteness reason, got ${result.result.diagnostic.reasons.join(", ")}`);
});

test("a receipt covering the WHOLE inventory with nothing withheld still passes", (t) => {
  // The control for the pair above: the same construction path, the same
  // validator, nothing withheld — and it passes. Without this, a validator
  // that called every receipt failing would satisfy the refusal test while
  // proving nothing.
  const { inventory } = twoFileRoot(t);
  const ids = inventory.tests.map((entry) => entry.id);
  const receipt = createTestReceipt(CANDIDATE_IDENTITY, inventory, ids, ids, {
    discovered: ids.length,
    passed: ids.length,
    failed: 0,
    skipped: 0,
    todo: 0,
    cancelled: 0,
  });
  const result = createTestResultReceipt(receipt, {
    eventCount: 1,
    successful: true,
    counts: { tests: ids.length, failed: 0, passed: ids.length, cancelled: 0, skipped: 0, todo: 0 },
  }, CANDIDATE_IDENTITY, [], []);
  assert.equal(result.result.status, "passed");
  assert.equal(result.result.exitCode, 0);
  assert.equal(result.result.diagnostic, null);
});
