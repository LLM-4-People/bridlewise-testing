import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

import {
  createInventoryTestAccountant,
  type InventoryTestAccountantOptions,
} from "../../scripts/tooling/inventory-test-run.ts";
import type { TestFailureDetail } from "../../scripts/tooling/test-receipt.ts";
import { buildTestInventory, type TestInventory } from "../../scripts/test-inventory.ts";
import {
  createTestSurfaceDispositionManifest,
} from "../../scripts/verification/test-surface.ts";
import {
  classifyTestConcurrency,
} from "../../src/workflow/test-result-collector.ts";
import {
  createRepositoryLocalTemporaryDirectory,
  removeRepositoryLocalTemporaryDirectory,
} from "../support/repository-local-temporary.ts";
import { allProcessIds, commandLineOf, isProcessAlive, parentOf } from "../../src/process/process-facts.ts";

const PASSING_SOURCE = `import test from "node:test";\ntest("pass", () => {});\n`;
const SERIAL_MARKER_SOURCE = `import test from "node:test";\n// runWorkerWithEvidence\ntest("serial", () => {});\n`;
const DIAGNOSTIC_SECRET = ("sk" + "_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
const FAILING_SOURCE = `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("fail", () => { try { assert.equal(1, 2); } catch (cause) { throw new TypeError("provider api_key=${DIAGNOSTIC_SECRET}", { cause }); } });\n`;
/**
 * A test that never settles. `await new Promise(() => {})` resolves never and
 * holds no timer, so nothing but the runner's own budget can end it — which is
 * the point: with no budget the run does not fail, it does not return.
 */
const HANGING_SOURCE = `import test from "node:test";\ntest("hangs", async () => { await new Promise(() => {}); });\ntest("after", () => {});\n`;
/**
 * THE MEASURED HANG: a test cancelled by its budget whose server it never
 * closed. The per-test timeout ends the TEST, but the open server keeps the
 * FILE's process alive, and the runner waits for that process to exit.
 */
const LEAKING_SOURCE = `import test from "node:test";\nimport { createServer } from "node:http";\ntest("leaks", async () => { const server = createServer(); await new Promise((r) => server.listen(0, "127.0.0.1", r)); await new Promise(() => {}); });\n`;
/** A file that keeps reporting (so it never STALLS) far past a small ceiling. */
const ENDLESS_SOURCE = `import test from "node:test";\n${Array.from({ length: 60 }, (_, index) => `test("step ${String(index + 1)}", async () => { await new Promise((r) => setTimeout(r, 100)); });`).join("\n")}\n`;
const SERIAL_FAILING_SOURCE = `import test from "node:test";\nimport assert from "node:assert/strict";\n// runWorkerWithEvidence\ntest("sfail", () => { assert.equal(1, 2); });\n`;

const EXECUTOR_ABSOLUTE = resolve(process.cwd(), "scripts/tooling/inventory-test-run.ts");
const INVENTORY_BUILDER_ABSOLUTE = resolve(process.cwd(), "scripts/test-inventory.ts");
const DISPOSITION_ABSOLUTE = resolve(process.cwd(), "scripts/verification/test-surface.ts");

const CLEAN_SUBPROCESS_ENV: NodeJS.ProcessEnv = (() => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
})();

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { removeRepositoryLocalTemporaryDirectory(root); } catch { /* already cleaned */ }
  }
});

function makeRoot(prefix: string): string {
  const root = createRepositoryLocalTemporaryDirectory(`itr-${prefix}-`);
  roots.push(root);
  return root;
}

function writeTestFile(root: string, relativePath: string, source: string): void {
  const abs = join(root, relativePath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, source, { encoding: "utf8", mode: 0o600 });
}

function buildInventory(root: string, files: readonly string[]): TestInventory {
  const manifest = createTestSurfaceDispositionManifest(files.map((path) => ({
    path,
    language: "javascript-typescript",
    disposition: "canonical-node-test",
    rationale: "Parallelism test fixture",
    evidenceLinks: [],
    blocksFullRepositoryClaim: false,
  })));
  return buildTestInventory(root, { dispositionManifest: manifest });
}

type SubprocessResult = Readonly<{
  passed: boolean;
  counts: Readonly<{ discovered: number; passed: number; failed: number; skipped: number; todo: number; cancelled: number }>;
  loadCrashCount: number;
  runnerSummary: Readonly<{ eventCount: number; successful: boolean }>;
  reasons: readonly string[];
  failures: readonly string[];
  failureDetails: readonly TestFailureDetail[];
  receiptDetails: readonly TestFailureDetail[];
}>;

/** Writes `files` and the executor helper (the production entry point, driven in its own process); returns the helper's path. */
function executorHelper(
  root: string,
  files: ReadonlyArray<Readonly<{ path: string; source: string }>>,
  concurrency: boolean | number | "auto",
  parallelConcurrency?: number,
  extraOptions: Readonly<Record<string, unknown>> = {},
): string {
  for (const f of files) writeTestFile(root, f.path, f.source);
  const opts: string[] = [JSON.stringify({
    concurrency,
    ...(parallelConcurrency !== undefined ? { parallelConcurrency } : {}),
    ...extraOptions,
  })];
  const helperSource =
    `import { executeInventoryTestRun } from ${JSON.stringify(EXECUTOR_ABSOLUTE)};\n` +
    `import { buildTestInventory } from ${JSON.stringify(INVENTORY_BUILDER_ABSOLUTE)};\n` +
    `import { createTestSurfaceDispositionManifest } from ${JSON.stringify(DISPOSITION_ABSOLUTE)};\n` +
    `const root = ${JSON.stringify(root)};\n` +
    `const files = ${JSON.stringify(files.map((f) => f.path))};\n` +
    `const opts = ${opts[0]!};\n` +
    `const manifest = createTestSurfaceDispositionManifest(files.map((path) => ({ path, language: "javascript-typescript", disposition: "canonical-node-test", rationale: "fixture", evidenceLinks: [], blocksFullRepositoryClaim: false })));\n` +
    `const inventory = buildTestInventory(root, { dispositionManifest: manifest });\n` +
    `const accounting = await executeInventoryTestRun(root, inventory, opts);\n` +
    `const { createTestReceipt, createTestResultReceipt, parseTestResultReceiptValue } = await import(${JSON.stringify(resolve(process.cwd(), "scripts/tooling/test-receipt.ts"))});\n` +
    `const { CANDIDATE_MANIFEST_SCHEMA_VERSION } = await import(${JSON.stringify(resolve(process.cwd(), "scripts/tooling/candidate-manifest.ts"))});\n` +
    // Synthetic candidate identity belongs only to this receipt fixture.
    `const candidate = { manifestSchemaVersion: CANDIDATE_MANIFEST_SCHEMA_VERSION, formatPolicyRevision: "candidate-format/v1", semanticTreeHash: "0".repeat(64), formatVerificationHash: "1".repeat(64) };\n` +
    `const receipt = createTestReceipt(candidate, inventory, accounting.discoveredIds, accounting.passedIds, accounting.counts, accounting.gatedTestIds, accounting.loadCrashCount, accounting.abortedFileCount);\n` +
    `const result = createTestResultReceipt(receipt, accounting.runnerSummary, candidate, accounting.failures, accounting.unknownTests, accounting.failureDetails);\n` +
    `const parsed = parseTestResultReceiptValue(JSON.parse(JSON.stringify(result)));\n` +
    `process.stdout.write(JSON.stringify({ passed: accounting.passed, counts: accounting.counts, loadCrashCount: accounting.loadCrashCount, runnerSummary: accounting.runnerSummary, reasons: accounting.reasons, failures: accounting.failures, failureDetails: accounting.failureDetails, receiptDetails: parsed.result.diagnostic?.failureDetails ?? [] }));\n`;
  const helperPath = join(root, "helper.mts");
  writeFileSync(helperPath, helperSource, "utf8");
  return helperPath;
}

function runExecutorSubprocess(
  root: string,
  files: ReadonlyArray<Readonly<{ path: string; source: string }>>,
  concurrency: boolean | number | "auto",
  parallelConcurrency?: number,
  extraOptions: Readonly<Record<string, unknown>> = {},
): SubprocessResult {
  const helperPath = executorHelper(root, files, concurrency, parallelConcurrency, extraOptions);
  const result = spawnSync(process.execPath, [helperPath], {
    encoding: "utf8",
    timeout: 60_000,
    env: CLEAN_SUBPROCESS_ENV,
  });
  assert.equal(result.status, 0, `subprocess exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("executeInventoryTestRun: concurrency false runs serially and is backwards-compatible", () => {
  const root = makeRoot("serial-compat");
  const out = runExecutorSubprocess(root, [{ path: "test/a.test.ts", source: PASSING_SOURCE }], false);
  assert.equal(out.passed, true);
  assert.equal(out.counts.discovered, 1);
  assert.equal(out.counts.passed, 1);
  assert.equal(out.runnerSummary.eventCount, 1);
  assert.equal(out.runnerSummary.successful, true);
});

test("executeInventoryTestRun: default concurrency (omitted) is serial (backwards-compatible)", () => {
  const root = makeRoot("default-serial");
  const out = runExecutorSubprocess(root, [{ path: "test/a.test.ts", source: PASSING_SOURCE }], false);
  assert.equal(out.passed, true);
  assert.equal(out.runnerSummary.eventCount, 1);
});

test("executeInventoryTestRun: auto concurrency classifies files and runs both phases", () => {
  const root = makeRoot("auto-split");
  const out = runExecutorSubprocess(root, [
    { path: "test/indep.test.ts", source: PASSING_SOURCE },
    { path: "test/serial.test.ts", source: SERIAL_MARKER_SOURCE },
  ], "auto", 1);
  assert.equal(out.passed, true);
  assert.equal(out.counts.discovered, 2);
  assert.equal(out.counts.passed, 2);
  assert.equal(out.runnerSummary.eventCount, 1);
  assert.equal(out.runnerSummary.successful, true);
});

test("executeInventoryTestRun: auto with only parallel files runs single phase", () => {
  const root = makeRoot("auto-par-only");
  const out = runExecutorSubprocess(root, [
    { path: "test/a.test.ts", source: PASSING_SOURCE },
    { path: "test/b.test.ts", source: PASSING_SOURCE },
  ], "auto", 2);
  assert.equal(out.passed, true);
  assert.equal(out.counts.discovered, 2);
  assert.equal(out.runnerSummary.eventCount, 1);
  assert.equal(out.runnerSummary.successful, true);
});

test("executeInventoryTestRun: auto with only serial files runs single serial phase", () => {
  const root = makeRoot("auto-ser-only");
  const out = runExecutorSubprocess(root, [
    { path: "test/a.test.ts", source: SERIAL_MARKER_SOURCE },
    { path: "test/b.test.ts", source: SERIAL_MARKER_SOURCE },
  ], "auto", 2);
  assert.equal(out.passed, true);
  assert.equal(out.counts.discovered, 2);
  assert.equal(out.runnerSummary.eventCount, 1);
});

test("executeInventoryTestRun: auto detects failures in parallel phase", () => {
  const root = makeRoot("auto-fail-par");
  const out = runExecutorSubprocess(root, [{ path: "test/fail.test.ts", source: FAILING_SOURCE }], "auto", 1);
  assert.equal(out.passed, false);
  assert.equal(out.counts.failed, 1);
  assert.equal(out.runnerSummary.successful, false);
  assert.ok(out.reasons.includes("test-failure"));
  assert.deepEqual(out.failures, ["test/fail.test.ts::fail"], "historical failure identity stays unchanged");
  assert.deepEqual(out.receiptDetails, out.failureDetails, "serialized receipt retains the native failure projection");
  const detail = out.receiptDetails[0]!;
  assert.equal(detail.identity, out.failures[0]);
  assert.equal(detail.file, "test/fail.test.ts");
  assert.equal(detail.line, 3);
  assert.equal(detail.column, 1);
  assert.equal(detail.error?.code, "ERR_TEST_FAILURE");
  assert.equal(detail.error?.failureType, "testCodeFailure");
  assert.equal(detail.error?.causes[0]?.name, "TypeError");
  assert.equal(detail.error?.causes[1]?.code, "ERR_ASSERTION");
  assert.equal(detail.error?.causes[1]?.failureLine, 3);
  assert.match(detail.error?.causes[1]?.stack ?? "", /test\/fail\.test\.ts:3:/u);
  assert.match(detail.error?.assertion ?? "", /expected 2, got 1|1 !== 2/u);
  assert.equal(JSON.stringify(detail).includes(DIAGNOSTIC_SECRET), false, "every message, stack and nested cause is redacted");
});

test("executeInventoryTestRun: a test that never settles FAILS the run instead of removing it", () => {
  // THE HANG IS DRIVEN, NOT ASSERTED FROM SOURCE. A structural claim that the
  // dispatch passes a `timeout` is satisfied by a timeout of zero, by one that
  // never reaches the child, and by one the runner ignores. This runs a test
  // that resolves never, through the production entry point, and requires the
  // run to come back with a verdict.
  //
  // Before the budget existed, this same fixture did not fail — it did not
  // return. The subprocess wrapper's own `spawnSync` timeout is what would
  // catch that, and it would report `status: null` rather than a failing run.
  const root = makeRoot("hang-budget");
  const started = Date.now();
  const out = runExecutorSubprocess(
    root,
    [{ path: "test/hang.test.ts", source: HANGING_SOURCE }],
    "auto",
    1,
    // A small budget so the test costs a second rather than two minutes. The
    // production default is `testExecution.runtimeBudgetMs`; what is under
    // test here is that the budget is honoured at all.
    { runtimeBudgetMs: 1_000 },
  );
  const elapsed = Date.now() - started;
  assert.equal(out.passed, false);
  assert.equal(out.counts.failed, 0, "Node reports a timeout as cancellation, not an assertion failure");
  assert.equal(out.counts.cancelled, 1, "the timeout is one terminal outcome, never both failed and cancelled");
  assert.deepEqual(out.receiptDetails, out.failureDetails);
  assert.equal(out.receiptDetails[0]?.error?.code, "ERR_TEST_FAILURE");
  assert.equal(out.receiptDetails[0]?.error?.failureType, "testTimeoutFailure");
  assert.match(out.receiptDetails[0]?.error?.message ?? "", /timed out after 1000ms/u);
  assert.ok(out.reasons.includes("test-cancelled"));
  // LIVENESS ON THE FIXTURE — the sibling test in the same file still ran, so
  // the budget ended one TEST rather than the file or the run. A budget that
  // killed the file would leave `discovered` at 1.
  assert.equal(out.counts.discovered, 2);
  assert.equal(out.counts.passed, 1, "the test after the hang must still have run");
  // AND THE BUDGET IS WHAT ENDED IT. Without this the assertions above are
  // also satisfied by a run that failed instantly for some other reason.
  assert.ok(elapsed >= 1_000, `the run returned in ${elapsed} ms, before the 1000 ms budget could have fired`);
});

test("executeInventoryTestRun: a file that never EXITS after its cancelled test is killed at the stall bound, and the run FAILS", () => {
  // Measured before the watchdog: a file whose cancelled test left a server
  // listening held the engine run for two hours — the per-test budget fired,
  // and then nothing did. The fixture is driven through the production entry
  // point; the subprocess wrapper's own 60 s `spawnSync` timeout is what
  // catches a run that does not return.
  const root = makeRoot("stall-watchdog");
  const started = Date.now();
  const out = runExecutorSubprocess(root, [{ path: "test/leak.test.ts", source: LEAKING_SOURCE }], "auto", 1,
    { runtimeBudgetMs: 1_000, engineSuiteWatchdog: { stallTimeoutMs: 4_000, hardCeilingMs: 50_000, killGraceMs: 1_000 } });
  const elapsed = Date.now() - started;
  assert.equal(out.passed, false, "a killed run is a failed run");
  assert.ok(out.failureDetails.some((detail) => detail.error?.failureType === "testAborted"), `the killed file is reported: ${JSON.stringify(out.failureDetails.map((detail) => detail.error?.failureType))}`);
  assert.ok(elapsed >= 4_000, `the run returned in ${elapsed} ms, before the stall bound could have fired`);
});

test("executeInventoryTestRun: a run still reporting at its hard ceiling is killed, and the run FAILS", () => {
  const root = makeRoot("ceiling-watchdog");
  const started = Date.now();
  const out = runExecutorSubprocess(root, [{ path: "test/endless.test.ts", source: ENDLESS_SOURCE }], "auto", 1,
    { engineSuiteWatchdog: { stallTimeoutMs: 30_000, hardCeilingMs: 3_000, killGraceMs: 1_000 } });
  const elapsed = Date.now() - started;
  assert.equal(out.passed, false);
  assert.ok(out.counts.passed < 60, "the file was ended before its last step");
  assert.ok(out.failureDetails.some((detail) => detail.error?.failureType === "testAborted"));
  assert.ok(elapsed >= 3_000 && elapsed < 20_000, `ended by the 3 s ceiling (and not by the stall bound): ${elapsed} ms`);
});

test("executeInventoryTestRun: a SIGTERM ends the run — the running file is killed and reported aborted, long before any watchdog", async () => {
  // The runner stops its worker this way when its launcher exits
  // (step6-readiness-2 F-11): the worker's node:test run must end through
  // the same abort as the watchdogs, never leave its files running.
  const root = makeRoot("terminate");
  const helperPath = executorHelper(root, [{ path: "test/leak.test.ts", source: LEAKING_SOURCE }], "auto", 1,
    { runtimeBudgetMs: 60_000, engineSuiteWatchdog: { stallTimeoutMs: 60_000, hardCeilingMs: 120_000, killGraceMs: 1_000 } });
  const started = Date.now();
  const child = spawn(process.execPath, [helperPath], { env: CLEAN_SUBPROCESS_ENV, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const leakPid = (): number | undefined => allProcessIds().find((pid) => parentOf(pid) === child.pid && (commandLineOf(pid) ?? []).some((argument) => argument.endsWith("leak.test.ts")));
  let fileProcess: number | undefined;
  for (let waited = 0; waited < 30_000 && fileProcess === undefined; waited += 100) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    fileProcess = leakPid();
  }
  assert.ok(fileProcess !== undefined, `the fixture's test file never started: ${stderr}`);
  child.kill("SIGTERM");
  const status = await new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
  const elapsed = Date.now() - started;
  assert.equal(status, 0, `the stopped run did not finish its accounting: ${stderr}`);
  const out = JSON.parse(stdout) as SubprocessResult;
  assert.equal(out.passed, false, "a stopped run is a failed run");
  assert.ok(out.failureDetails.some((detail) => detail.error?.failureType === "testAborted"), `the killed file is reported: ${JSON.stringify(out.failureDetails.map((detail) => detail.error?.failureType))}`);
  assert.match(stderr, /TERMINATED/u);
  assert.ok(elapsed < 30_000, `ended by the SIGTERM, not a watchdog: ${String(elapsed)} ms`);
  assert.equal(isProcessAlive(fileProcess), false, "the stopped run left its test file running");
});

test("executeInventoryTestRun: auto detects failures in serial phase", () => {
  const root = makeRoot("auto-fail-ser");
  const out = runExecutorSubprocess(root, [{ path: "test/serial-fail.test.ts", source: SERIAL_FAILING_SOURCE }], "auto", 1);
  assert.equal(out.passed, false);
  assert.equal(out.counts.failed, 1);
  assert.ok(out.reasons.includes("test-failure"));
});

test("executeInventoryTestRun: numeric concurrency runs all files with that concurrency", () => {
  const root = makeRoot("num-conc");
  const out = runExecutorSubprocess(root, [
    { path: "test/a.test.ts", source: PASSING_SOURCE },
    { path: "test/b.test.ts", source: PASSING_SOURCE },
  ], 2);
  assert.equal(out.passed, true);
  assert.equal(out.counts.discovered, 2);
  assert.equal(out.runnerSummary.eventCount, 1);
});

test("executeInventoryTestRun: auto with mixed parallel+serial and failing serial fails correctly", () => {
  const root = makeRoot("auto-mixed-fail");
  const out = runExecutorSubprocess(root, [
    { path: "test/indep.test.ts", source: PASSING_SOURCE },
    { path: "test/serialfail.test.ts", source: SERIAL_FAILING_SOURCE },
  ], "auto", 1);
  assert.equal(out.passed, false);
  assert.equal(out.counts.passed, 1);
  assert.equal(out.counts.failed, 1);
  assert.ok(out.reasons.includes("test-failure"));
});

test("createInventoryTestAccountant: default expectedSummaryCount is 1", () => {
  const root = makeRoot("acct-default");
  writeTestFile(root, "test/a.test.ts", PASSING_SOURCE);
  const inventory = buildInventory(root, ["test/a.test.ts"]);
  const accountant = createInventoryTestAccountant(root, inventory);
  const result = accountant.complete();
  assert.equal(result.runnerSummary.eventCount, 0);
  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("runner-summary-missing"));
});

test("createInventoryTestAccountant: expectedSummaryCount=2 accepts two valid summaries", () => {
  const root = makeRoot("acct-two");
  writeTestFile(root, "test/a.test.ts", PASSING_SOURCE);
  writeTestFile(root, "test/b.test.ts", PASSING_SOURCE);
  const inventory = buildInventory(root, ["test/a.test.ts", "test/b.test.ts"]);
  const options: InventoryTestAccountantOptions = { expectedSummaryCount: 2 };
  const accountant = createInventoryTestAccountant(root, inventory, options);
  accountant.observe({ type: "test:enqueue", data: { file: join(root, "test/a.test.ts"), name: "pass" } });
  accountant.observe({ type: "test:pass", data: { file: join(root, "test/a.test.ts"), name: "pass" } });
  accountant.observe({ type: "test:summary", data: { success: true, counts: { tests: 1, failed: 0, passed: 1, cancelled: 0, skipped: 0, todo: 0 } } });
  accountant.observe({ type: "test:enqueue", data: { file: join(root, "test/b.test.ts"), name: "pass" } });
  accountant.observe({ type: "test:pass", data: { file: join(root, "test/b.test.ts"), name: "pass" } });
  accountant.observe({ type: "test:summary", data: { success: true, counts: { tests: 1, failed: 0, passed: 1, cancelled: 0, skipped: 0, todo: 0 } } });
  const result = accountant.complete();
  assert.equal(result.passed, true);
  assert.equal(result.runnerSummary.eventCount, 1);
  assert.equal(result.runnerSummary.successful, true);
  assert.ok(result.runnerSummary.counts !== null);
  assert.equal(result.runnerSummary.counts.tests, 2);
  assert.equal(result.runnerSummary.counts.passed, 2);
});

test("createInventoryTestAccountant: a dispatched skip is NAMED with its reason, beside the count (LAND-OC-FIX R4)", () => {
  const root = makeRoot("acct-skip");
  writeTestFile(root, "test/a.test.ts", PASSING_SOURCE);
  const inventory = buildInventory(root, ["test/a.test.ts"]);
  const accountant = createInventoryTestAccountant(root, inventory, {});
  accountant.observe({ type: "test:enqueue", data: { file: join(root, "test/a.test.ts"), name: "pass" } });
  accountant.observe({ type: "test:pass", data: { file: join(root, "test/a.test.ts"), name: "pass", skip: "live interop is opt-in" } });
  accountant.observe({ type: "test:summary", data: { success: true, counts: { tests: 1, failed: 0, passed: 0, cancelled: 0, skipped: 1, todo: 0 } } });
  const result = accountant.complete();
  assert.equal(result.passed, false);
  assert.equal(result.counts.skipped, 1);
  assert.deepEqual(result.skips, [{ identity: "test/a.test.ts::pass", reason: "live interop is opt-in" }]);
});

test("createInventoryTestAccountant: expectedSummaryCount=2 does not flag after-global-summary before all summaries", () => {
  const root = makeRoot("acct-after");
  writeTestFile(root, "test/a.test.ts", PASSING_SOURCE);
  const inventory = buildInventory(root, ["test/a.test.ts"]);
  const options: InventoryTestAccountantOptions = { expectedSummaryCount: 2 };
  const accountant = createInventoryTestAccountant(root, inventory, options);
  accountant.observe({ type: "test:summary", data: { success: true, counts: { tests: 0, failed: 0, passed: 0, cancelled: 0, skipped: 0, todo: 0 } } });
  accountant.observe({ type: "test:enqueue", data: { file: join(root, "test/a.test.ts"), name: "pass" } });
  accountant.observe({ type: "test:pass", data: { file: join(root, "test/a.test.ts"), name: "pass" } });
  accountant.observe({ type: "test:summary", data: { success: true, counts: { tests: 1, failed: 0, passed: 1, cancelled: 0, skipped: 0, todo: 0 } } });
  const result = accountant.complete();
  assert.equal(result.unknownTests.some((e) => e.includes("after-global-summary")), false);
});

test("createInventoryTestAccountant: expectedSummaryCount=2 flags excess summaries", () => {
  const root = makeRoot("acct-excess");
  writeTestFile(root, "test/a.test.ts", PASSING_SOURCE);
  const inventory = buildInventory(root, ["test/a.test.ts"]);
  const options: InventoryTestAccountantOptions = { expectedSummaryCount: 2 };
  const accountant = createInventoryTestAccountant(root, inventory, options);
  accountant.observe({ type: "test:summary", data: { success: true, counts: { tests: 0, failed: 0, passed: 0, cancelled: 0, skipped: 0, todo: 0 } } });
  accountant.observe({ type: "test:summary", data: { success: true, counts: { tests: 0, failed: 0, passed: 0, cancelled: 0, skipped: 0, todo: 0 } } });
  accountant.observe({ type: "test:summary", data: { success: true, counts: { tests: 0, failed: 0, passed: 0, cancelled: 0, skipped: 0, todo: 0 } } });
  const result = accountant.complete();
  assert.ok(result.unknownTests.some((e) => e.includes("excess-global-summary")));
});

test("classifyTestConcurrency integration: inventory-test-run uses classifier not hardcoded false", () => {
  const root = makeRoot("classify-integ");
  writeTestFile(root, "test/indep.test.ts", PASSING_SOURCE);
  writeTestFile(root, "test/serial.test.ts", SERIAL_MARKER_SOURCE);
  const classification = classifyTestConcurrency(["test/indep.test.ts", "test/serial.test.ts"], root);
  assert.equal(classification.parallel.length, 1);
  assert.equal(classification.serial.length, 1);
  assert.deepEqual([...classification.parallel], ["test/indep.test.ts"]);
  assert.deepEqual([...classification.serial], ["test/serial.test.ts"]);
  assert.deepEqual(classification.serialReasons["test/serial.test.ts"], ["evidence-worker"]);
});

/**
 * A module that throws during import never enqueues a test, so nothing in
 * the per-test accounting can name it: node reports the crash as one failed
 * test whose NAME IS THE FILE, `isFileWrapper` keeps that synthetic test out
 * of per-test bookkeeping, and until this test the failure list stayed EMPTY
 * while 74 real tests vanished — the count gate redded on the shrink and
 * named nothing. The file path is the crash's name, so the failure row
 * carries it; the run must still red (the vanished tests are still
 * undiscovered), but now the summary says WHERE.
 */
const CRASHING_SOURCE = `import test from "node:test";\nthrow new Error("boom at module load");\ntest("never runs", () => {});\n`;

test("executeInventoryTestRun: a module-load crash is a NAMED failure row, and the run still fails", () => {
  const root = makeRoot("load-crash");
  const out = runExecutorSubprocess(root, [
    { path: "test/ok.test.ts", source: PASSING_SOURCE },
    { path: "test/crash.test.ts", source: CRASHING_SOURCE },
  ], 2);
  assert.equal(out.passed, false, "a run that lost a whole file's tests must red");
  // THE NAME. The row is the file path — the one fact a reader needs.
  assert.equal(out.failures.length, 1, `expected exactly one failure row, got: ${JSON.stringify(out.failures)}`);
  assert.equal(out.receiptDetails[0]?.identity, out.failures[0]);
  assert.equal(out.receiptDetails[0]?.error?.failureType, "testCodeFailure");
  assert.match(out.failures[0]!, /^test\/crash\.test\.ts /u,
    "the failure row must LEAD with the crashed file's path — the path is the name");
  assert.match(out.failures[0]!, /module load/u,
    "and say the failure mode, so the reader does not hunt for a test by this name");
  // The named row rides the failed count (the receipt requires
  // failures.length === counts.failed), and the healthy file still passed.
  assert.equal(out.counts.failed, 1);
  assert.equal(out.counts.passed, 1);
  // The count gates still see the shrink: naming the crash must not make
  // the vanished tests look accounted for.
  assert.ok(out.reasons.includes("inventory-incomplete-discovery"),
    `the vanished tests must still red the discovery gate; reasons: ${JSON.stringify(out.reasons)}`);
});

test("executeInventoryTestRun: an ordinary failing test is named ONCE — the file wrapper adds no second row", () => {
  const root = makeRoot("ordinary-fail");
  const out = runExecutorSubprocess(root, [
    { path: "test/fails.test.ts", source: FAILING_SOURCE },
  ], 2);
  assert.equal(out.passed, false);
  // One failing test, one row, named by FILE AND TEST — the file wrapper that
  // fails because its child failed must not double-report, and the file rides
  // the row because two files may share a test name (the flaky-memory guard
  // compares these identities across runs).
  assert.equal(out.counts.failed, 1);
  assert.deepEqual(out.failures, ["test/fails.test.ts::fail"]);
});

test("executeInventoryTestRun: MANY load-crashed files keep the counts identity, so the receipt reports failures instead of crashing", () => {
  // The 95-fold-failure shape: MANY files whose modules crash at load (each
  // reading a moved pre-fold path), mixed with healthy and ordinarily-failing
  // files. The single-crash test above proves the row is NAMED; this proves
  // the ACCOUNTING stays consistent at scale so `createTestReceipt` does not
  // throw "test receipt accounting is invalid" — which is what hid the 95
  // failure names behind a bare setup crash. The receipt's terminal-count
  // identity is `passed+failed+skipped+todo+cancelled === discovered`; a
  // load-crashed file contributes its synthetic wrapper to BOTH `failed` AND
  // (as one discovered entry) `discovered`, so the identity holds.
  const root = makeRoot("load-crash-scale");
  const files = [
    { path: "test/ok1.test.ts", source: PASSING_SOURCE },
    { path: "test/ok2.test.ts", source: PASSING_SOURCE },
    { path: "test/crash1.test.ts", source: CRASHING_SOURCE },
    { path: "test/crash2.test.ts", source: CRASHING_SOURCE },
    { path: "test/crash3.test.ts", source: CRASHING_SOURCE },
    { path: "test/fails.test.ts", source: FAILING_SOURCE },
  ];
  const out = runExecutorSubprocess(root, files, 2);
  assert.equal(out.passed, false, "a run with load-crashed files must red");
  // The named rows: 3 crashed files + 1 ordinary failing test.
  assert.equal(out.failures.filter((f) => f.includes("module load")).length, 3,
    `each crashed file names one module-load row: ${JSON.stringify(out.failures)}`);
  assert.ok(out.failures.includes("test/fails.test.ts::fail"));
  assert.equal(out.counts.failed, 4, "3 crashed files + 1 failing test");
  // The crash count is exposed for the receipt's terminal-count
  // reconciliation: a crashed file counts in `failed` but contributes no
  // inventory id to `discovered`, so it is the EXACT overhang the receipt
  // subtracts (never a blanket tolerance).
  assert.equal(out.loadCrashCount, 3, "each load-crashed file is counted once");
  // THE IDENTITY THE RECEIPT ASSERTS. The live run crashed here: the wrapper
  // rode `failed` but NOT `discovered`, so terminalCount (passed+failed+…)
  // exceeded discovered by the crash count and createTestReceipt threw, hiding
  // the failures. Asserting the reconciled identity here proves the accountant
  // now exposes exactly what the receipt needs.
  const c = out.counts;
  assert.equal(
    c.passed + c.failed + c.skipped + c.todo + c.cancelled - out.loadCrashCount,
    c.discovered,
    `the reconciled terminal-count identity the receipt asserts: ${JSON.stringify(c)} loadCrash=${out.loadCrashCount}`,
  );
});
