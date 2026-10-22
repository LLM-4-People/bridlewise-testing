// AN ENGINE CELL WITHHOLDS, IT NEVER SUBTRACTS — the CI shard of the engine
// suite (the gate catalogue's engine cells) on a real inventory, through the
// real node:test dispatch in a process of its own (as inventory-test-run's
// own test drives the executor):
//
//   - the cell dispatches only its sources; every other inventoried source is
//     withheld: still expected, counted skipped, recorded on the receipt;
//   - the WHOLE-SUITE rule still refuses that receipt (a cell is not the
//     suite), and only the CELL rule (`cellReceiptPassing`) accepts it — when
//     the withheld entries are its only skips and every dispatched test
//     passed;
//   - a failing or skipping dispatched test fails the cell; a receipt with
//     nothing withheld is not a cell; a cell naming a source the inventory
//     does not hold, or no source, is a typed refusal.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";

import { createRepositoryLocalTemporaryDirectory, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) removeRepositoryLocalTemporaryDirectory(root);
});

const MODULES = {
  executor: resolve(process.cwd(), "scripts/tooling/inventory-test-run.ts"),
  inventory: resolve(process.cwd(), "scripts/test-inventory.ts"),
  dispositions: resolve(process.cwd(), "scripts/verification/test-surface.ts"),
  receipt: resolve(process.cwd(), "scripts/tooling/test-receipt.ts"),
  candidate: resolve(process.cwd(), "scripts/tooling/candidate-manifest.ts"),
};

const CLEAN_ENV: NodeJS.ProcessEnv = (() => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
})();

const KEPT = ['import test from "node:test";', 'test("kept one", () => undefined);', 'test("kept two", () => undefined);', ""].join("\n");
const OTHER = ['import test from "node:test";', 'test("other one", () => undefined);', 'test("other two", () => undefined);', 'test("other three", () => undefined);', ""].join("\n");

type CellRun = Readonly<{ refused?: string; status?: string; cellPassing?: boolean; messages?: Readonly<Record<string, string>>; counts?: Readonly<Record<string, number>>; expected?: number; withheld?: number }>;

/** Writes `files`, runs the executor on `cell` in a process of its own, and answers its accounting and both rules' verdicts. */
function runCell(files: Readonly<Record<string, string>>, cell: readonly string[]): CellRun {
  const root = createRepositoryLocalTemporaryDirectory("engine-cell-");
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, { mode: 0o600 });
  }
  const helper = [
    `import { executeInventoryTestRun } from ${JSON.stringify(MODULES.executor)};`,
    `import { buildTestInventory } from ${JSON.stringify(MODULES.inventory)};`,
    `import { createTestSurfaceDispositionManifest } from ${JSON.stringify(MODULES.dispositions)};`,
    `import { cellReceiptPassing, createTestReceipt, createTestResultReceipt, testFailureMessages } from ${JSON.stringify(MODULES.receipt)};`,
    `import { CANDIDATE_MANIFEST_SCHEMA_VERSION } from ${JSON.stringify(MODULES.candidate)};`,
    `const root = ${JSON.stringify(root)};`,
    `const files = ${JSON.stringify(Object.keys(files))};`,
    `const manifest = createTestSurfaceDispositionManifest(files.map((path) => ({ path, language: "javascript-typescript", disposition: "canonical-node-test", rationale: "fixture", evidenceLinks: [], blocksFullRepositoryClaim: false })));`,
    `const inventory = buildTestInventory(root, { dispositionManifest: manifest });`,
    `let accounting;`,
    `try { accounting = await executeInventoryTestRun(root, inventory, { cellSourceIds: new Set(${JSON.stringify(cell)}), runtimeBudgetMs: 60000 }); }`,
    `catch (error) { process.stdout.write(JSON.stringify({ refused: error.code })); process.exit(0); }`,
    `const candidate = { manifestSchemaVersion: CANDIDATE_MANIFEST_SCHEMA_VERSION, formatPolicyRevision: "candidate-format/v1", semanticTreeHash: "0".repeat(64), formatVerificationHash: "1".repeat(64) };`,
    `const receipt = createTestReceipt(candidate, inventory, accounting.discoveredIds, accounting.passedIds, accounting.counts, accounting.gatedTestIds, accounting.loadCrashCount, accounting.abortedFileCount);`,
    `const result = createTestResultReceipt(receipt, accounting.runnerSummary, candidate, accounting.failures, accounting.unknownTests, accounting.failureDetails, accounting.skips);`,
    `process.stdout.write(JSON.stringify({ status: result.result.status, cellPassing: cellReceiptPassing(result), messages: testFailureMessages(result), counts: accounting.counts, expected: accounting.expectedIds.length, withheld: result.testReceipt.gatedTestIds.length }));`,
  ].join("\n");
  const helperPath = join(root, "helper.mts");
  writeFileSync(helperPath, helper, "utf8");
  const run = spawnSync(process.execPath, [helperPath], { encoding: "utf8", timeout: 120_000, env: CLEAN_ENV });
  assert.equal(run.status, 0, `the cell helper exited ${String(run.status)}: ${run.stderr}`);
  return JSON.parse(run.stdout) as CellRun;
}

test("a cell dispatches its sources, withholds the rest (expected, skipped), and passes only by the cell rule", () => {
  const run = runCell({ "test/kept.test.ts": KEPT, "test/other.test.ts": OTHER }, ["test/kept.test.ts"]);
  assert.equal(run.expected, 5, "nothing subtracted: the whole inventory is expected");
  assert.equal(run.counts!.passed, 2);
  assert.equal(run.counts!.skipped, 3, "the withheld entries are counted skipped");
  assert.equal(run.withheld, 3, "the receipt names what was withheld");
  assert.equal(run.status, "failed", "the whole-suite rule refuses a cell");
  assert.equal(run.cellPassing, true, "the cell rule accepts exactly the withholding");
});

test("a failing or skipping dispatched test fails the cell; a receipt with nothing withheld is not a cell", () => {
  const failing = runCell({ "test/kept.test.ts": KEPT.replace('test("kept two", () => undefined);', 'test("kept two", () => { throw new Error("planted"); });'), "test/other.test.ts": OTHER }, ["test/kept.test.ts"]);
  assert.equal(failing.cellPassing, false);
  assert.deepEqual(Object.values(failing.messages!), ["Error: planted"], "the receipt keeps what the failure said, for the summary (#149)");
  const skipping = runCell({ "test/kept.test.ts": KEPT.replace('test("kept two", () => undefined);', 'test("kept two", { skip: "planted" }, () => undefined);'), "test/other.test.ts": OTHER }, ["test/kept.test.ts"]);
  assert.equal(skipping.cellPassing, false, "a skip in the cell is not a withheld entry");
  const whole = runCell({ "test/kept.test.ts": KEPT, "test/other.test.ts": OTHER }, ["test/kept.test.ts", "test/other.test.ts"]);
  assert.equal(whole.status, "passed", "the whole inventory as one cell is a passing suite run");
  assert.equal(whole.cellPassing, false, "and not a cell: nothing was withheld");
});

test("a cell naming a source the inventory does not hold, or none, is a typed refusal", () => {
  assert.deepEqual(runCell({ "test/kept.test.ts": KEPT }, ["test/ghost.test.ts"]), { refused: "test_cell_invalid" });
  assert.deepEqual(runCell({ "test/kept.test.ts": KEPT }, []), { refused: "test_cell_invalid" });
});
