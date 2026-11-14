import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { parse } from "yaml";

import { evaluateAlwaysJobCondition, evaluateJobEnvironmentValue } from "../helpers/github-workflow-expression.mjs";
import { withTempDir } from "../../engine/test/support/temp-dir.ts";
import { mergeShardReports } from "../../scripts/test-shard-merge.mjs";
import {
  WEIGHTS_SCHEMA,
  SHARD_REPORT_SCHEMA,
  assignmentHash,
  planShards,
  wrapShardReport,
} from "../../scripts/test-shard-manifest.mjs";

const HEAD = "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * A REAL PASSING ROW IS THE DEFAULT. This builder used to emit
 * `assertionResults: []`, so every merge arm exercised a report shape the
 * real JSON reporter never writes — and the empty row was exactly the
 * omission the merge failed to judge. `tests` is the number of tests per
 * file, and the assertion rows now carry them.
 */
function shardReport(files, { success = true, tests = 1 } = {}) {
  const total = files.length * tests;
  return {
    success,
    numTotalTests: total,
    numPassedTests: success ? total : 0,
    numFailedTests: success ? 0 : total,
    numFailedTestSuites: success ? 0 : files.length,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: files.map((name) => ({
      name,
      status: success ? "passed" : "failed",
      message: success ? "" : "planted suite failure",
      assertionResults: Array.from({ length: tests }, () => ({
        status: success ? "passed" : "failed",
        failureMessages: success ? [] : ["planted test failure"],
      })),
    })),
  };
}

/**
 * A plan-backed fixture: the merge now REQUIRES the plan, and only a wrapped
 * report carries provenance. Every arm below drives the real plan producer,
 * so the exact-assignment check is exercised rather than bypassed.
 */
function planFixture(work, files, { shardCount = 1, excluded = [] } = {}) {
  // The population is derived from the tree: the supported files, each excluded file declaring its own
  // exclusion in its header, and the measured weights beside them.
  for (const file of files) {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), "");
  }
  for (const { path, reason, evidence } of excluded) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), `// @shard-exclude: ${reason} (evidence: ${evidence})\n`);
  }
  const source = join(work, "weights.json");
  writeJson(source, {
    schemaVersion: WEIGHTS_SCHEMA,
    measuredHeadSha: HEAD,
    measuredAt: "2026-01-01T00:00:00.000Z",
    weightSource: "fixture",
    weights: files.map((file) => ({ path: file, weightMs: 1 })),
  });
  const planDir = join(work, "plan");
  planShards({ root: work, weightsPath: source, shardCount, headSha: HEAD, outDir: planDir });
  const plan = JSON.parse(readFileSync(join(planDir, "plan.json"), "utf8"));
  return { planDir, manifest: join(planDir, "manifest.json"), planPath: join(planDir, "plan.json"), plan, source };
}

/** The files the plan assigned to one shard, as absolute paths the report uses. */
function plannedFiles(work, fixture, index) {
  return fixture.plan.shards[index - 1].files.map((file) => join(work, file));
}

/**
 * Write a wrapped report for one planned shard. `timing: false` omits the
 * measured window; `files` overrides what the report claims to have run.
 */
function writeWrapped(work, fixture, index, {
  files = undefined,
  timing = true,
  success = true,
  tests = 1,
  counts = {},
} = {}) {
  const report = {
    ...shardReport(files ?? plannedFiles(work, fixture, index), { success, tests }),
    ...counts,
  };
  const envelope = {
    schemaVersion: SHARD_REPORT_SCHEMA,
    shard: index,
    shardCount: fixture.plan.shardCount,
    headSha: fixture.plan.headSha,
    manifestHash: fixture.plan.manifestHash,
    assignmentHash: fixture.plan.assignmentHash,
    ...(timing ? { timing: { startedAt: "1970-01-01T00:00:01.000Z", finishedAt: "1970-01-01T00:00:02.000Z", durationMs: 1000 } } : {}),
    vitest: report,
  };
  const path = join(work, `shard-${index}.json`);
  writeJson(path, envelope);
  return path;
}

function merge(work, fixture, shardPaths, overrides = {}) {
  return mergeShardReports({
    root: work,
    manifestPath: fixture.manifest,
    planPath: fixture.planPath,
    weightsPath: fixture.source,
    shardPaths,
    expectedShards: fixture.plan.shardCount,
    headSha: fixture.plan.headSha,
    outPath: join(work, "receipt.json"),
    now: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  });
}

test("the shard merge accepts a complete disjoint manifest", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-merge-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts", "tests/unit/b.test.ts"], { shardCount: 2 });
    const first = writeWrapped(work, fixture, 1, { tests: 2 });
    const second = writeWrapped(work, fixture, 2, { tests: 3 });

    const receipt = merge(work, fixture, [first, second]);

    assert.equal(receipt.schemaVersion, "bridlewise-test-shard-receipt/v1");
    assert.equal(receipt.fileCount, 2);
    assert.equal(receipt.testCount, 5);
    assert.equal(receipt.shardCount, 2);
    assert.match(receipt.manifestHash, /^[0-9a-f]{64}$/);
    assert.equal(receipt.assignmentHash, fixture.plan.assignmentHash);
    assert.equal(receipt.passedTests, 5);
    assert.equal(receipt.failedTests, 0);
    assert.equal(receipt.skippedTests, 0);
    assert.equal(receipt.testPhaseMs, 1_000, "the two reports share one measured window");
    assert.deepEqual(receipt.shards, [
      {
        index: 1, fileCount: 1, testCount: 2, passedTests: 2, failedTests: 0, skippedTests: 0,
        startedAt: "1970-01-01T00:00:01.000Z", finishedAt: "1970-01-01T00:00:02.000Z", durationMs: 1000,
      },
      {
        index: 2, fileCount: 1, testCount: 3, passedTests: 3, failedTests: 0, skippedTests: 0,
        startedAt: "1970-01-01T00:00:01.000Z", finishedAt: "1970-01-01T00:00:02.000Z", durationMs: 1000,
      },
    ]);
    assert.equal(JSON.stringify(receipt).includes(work), false, "receipt must not leak the absolute root");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a plan that lies about its assignment hash is refused before any report is accepted", () => {
  // The envelope copies `plan.assignmentHash`, so a plan whose hash does not
  // describe its own `shards` made every report agree with a false claim.
  // The merge recomputes the assignment from the plan it read and refuses
  // the disagreement — the receipt can no longer name an assignment nobody
  // produced.
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-merge-lie-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts", "tests/unit/b.test.ts"], { shardCount: 2 });
    const first = writeWrapped(work, fixture, 1);
    const second = writeWrapped(work, fixture, 2);
    const lying = JSON.parse(readFileSync(fixture.planPath, "utf8"));
    lying.assignmentHash = "f".repeat(64);
    writeJson(fixture.planPath, lying);
    assert.throws(
      () => merge(work, fixture, [first, second]),
      /assignmentHash does not match the plan's shard assignment/u,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the receipt names the manifest exclusions and their evidence anchors", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-exclusions-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts"], {
      excluded: [
        { path: "tests/unit/private.test.ts", reason: "not published", evidence: "docs/floor/roadmap.md#snapshot" },
      ],
    });
    const report = writeWrapped(work, fixture, 1, { tests: 4 });

    const receipt = merge(work, fixture, [report], { weightsPath: fixture.source });

    assert.equal(receipt.excludedFileCount, 1);
    assert.deepEqual(receipt.exclusions, [
      { path: "tests/unit/private.test.ts", reason: "not published", evidence: "docs/floor/roadmap.md#snapshot" },
    ]);
    assert.equal(receipt.passedTests, 4);

    // The tree moved after the plan (a test file appeared): the population re-derived here is not the plan's.
    writeFileSync(join(work, "tests/unit/other.test.ts"), "");
    assert.throws(
      () => merge(work, fixture, [report]),
      /population: hash does not match the supplied manifest/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a wrapped report whose timing contradicts itself or its own run is refused", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-timing-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts"]);
    const raw = join(work, "raw.json");
    const wrapped = join(work, "wrapped.json");
    writeJson(raw, shardReport(plannedFiles(work, fixture, 1)));
    wrapShardReport({
      root: work, planPath: fixture.planPath, shard: 1, vitestPath: raw, outPath: wrapped,
      startedAt: "1000", finishedAt: "2000",
    });
    const clean = JSON.parse(readFileSync(wrapped, "utf8"));
    const mergeWrapped = () => merge(work, fixture, [wrapped]);
    assert.equal(clean.timing.durationMs, 1000);
    assert.equal(mergeWrapped().testPhaseMs, 1000);

    // durationMs is the window's length. The merge used to trust it while
    // deriving the window from the timestamps, so the receipt could claim a
    // critical path that no pair of timestamps supported.
    writeJson(wrapped, { ...clean, timing: { ...clean.timing, durationMs: 9_999 } });
    assert.throws(mergeWrapped, /durationMs 9999 does not equal finishedAt - startedAt \(1000\)/u);

    // vitest dates its own run; that run sits inside its job's window.
    writeJson(wrapped, { ...clean, vitest: { ...clean.vitest, startTime: 9_000, endTime: 9_500 } });
    assert.throws(mergeWrapped, /outside the shard window/u);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shard merge refuses a missing file", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-missing-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts", "tests/unit/b.test.ts"], { shardCount: 2 });
    const first = writeWrapped(work, fixture, 1);
    const second = writeWrapped(work, fixture, 2, { files: [] });
    assert.throws(() => merge(work, fixture, [first, second]), /missing 1 manifest file/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shard merge refuses a duplicate file", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-duplicate-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts", "tests/unit/b.test.ts"]);
    const first = writeWrapped(work, fixture, 1, {
      files: [...plannedFiles(work, fixture, 1), join(work, "tests/unit/b.test.ts"), join(work, "tests/unit/b.test.ts")],
    });
    assert.throws(() => merge(work, fixture, [first]), /duplicate test file/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shard merge refuses a failed shard or a report outside the root", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-refuse-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts"]);
    const failed = writeWrapped(work, fixture, 1, { success: false });
    assert.throws(() => merge(work, fixture, [failed]), /success=false/);

    const outside = writeWrapped(work, fixture, 1, {
      files: [join(work, "..", "outside.test.ts")],
    });
    assert.throws(() => merge(work, fixture, [outside]), /escapes the repository root/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shard merge refuses a row that records a failed suite while the summary counts are green", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-failed-suite-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts", "tests/unit/b.test.ts"]);
    const report = writeWrapped(work, fixture, 1, { tests: 2 });
    const wrapped = JSON.parse(readFileSync(report, "utf8"));
    // The defect: every summary integer says green, and only the test-level
    // row carries the failure. The merge used to accept exactly this row.
    assert.equal(wrapped.vitest.success, true);
    assert.equal(wrapped.vitest.numFailedTests, 0);
    assert.equal(wrapped.vitest.numFailedTestSuites, 0);
    wrapped.vitest.testResults[0].status = "failed";
    writeJson(report, wrapped);
    assert.throws(() => merge(work, fixture, [report]), /records a failed test suite/u);

    // The same forgery at the test level: the suite passed, one test did not.
    const failedTest = writeWrapped(work, fixture, 1, { tests: 2 });
    const wrappedTest = JSON.parse(readFileSync(failedTest, "utf8"));
    wrappedTest.vitest.testResults[0].status = "passed";
    wrappedTest.vitest.testResults[0].assertionResults = [{ status: "failed" }];
    writeJson(failedTest, wrappedTest);
    assert.throws(() => merge(work, fixture, [failedTest]), /records a failed test/u);

    // Control: the same fixture with every suite/test passed merges.
    const clean = writeWrapped(work, fixture, 1, { tests: 2 });
    const wrappedClean = JSON.parse(readFileSync(clean, "utf8"));
    wrappedClean.vitest.testResults[0].status = "passed";
    wrappedClean.vitest.testResults[0].assertionResults = [{ status: "passed" }, { status: "passed" }];
    writeJson(clean, wrappedClean);
    assert.equal(merge(work, fixture, [clean]).failedTests, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shard merge derives its counts from the rows and refuses an omitted row", () => {
  // The defect: the summary integers were judged beside the rows, so a
  // report could declare ten green tests next to an empty `assertionResults`
  // array — or three tests next to one passing row — and merge green. The
  // rows are the only record of what ran; the integers are a claim about it.
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-row-counts-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts"]);

    // Two claimed tests, one suite row, no assertion rows.
    const omitted = writeWrapped(work, fixture, 1, { tests: 2 });
    const omittedDoc = JSON.parse(readFileSync(omitted, "utf8"));
    omittedDoc.vitest.testResults[0].assertionResults = [];
    writeJson(omitted, omittedDoc);
    assert.throws(
      () => merge(work, fixture, [omitted]),
      /records zero assertions; a supported file that ran no test is not evidence/u,
    );

    // Three claimed tests, one passing row that records one of them.
    const short = writeWrapped(work, fixture, 1, { tests: 3 });
    const shortDoc = JSON.parse(readFileSync(short, "utf8"));
    shortDoc.vitest.testResults[0].assertionResults = [{ status: "passed" }];
    writeJson(short, shortDoc);
    assert.throws(
      () => merge(work, fixture, [short]),
      /testResults record 1 assertion\(s\), but numTotalTests declares 3/u,
    );

    // The same report with every row present merges: the arm is not vacuous.
    const complete = writeWrapped(work, fixture, 1, { tests: 2 });
    assert.equal(merge(work, fixture, [complete]).testCount, 2);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shard merge refuses a passed row that carries a failure message", () => {
  // `status: "passed"` with a populated `failureMessages` (or a suite
  // `message`) is a mislabelled failure. The merge ignored both fields, so a
  // report could keep its failure text while claiming every row passed.
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-failure-text-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts"]);

    const testLied = writeWrapped(work, fixture, 1);
    const testDoc = JSON.parse(readFileSync(testLied, "utf8"));
    testDoc.vitest.testResults[0].assertionResults[0].failureMessages = [
      "AssertionError: expected 1 to be 2",
    ];
    writeJson(testLied, testDoc);
    assert.throws(
      () => merge(work, fixture, [testLied]),
      /records a passed test carrying failure messages: AssertionError: expected 1 to be 2/u,
    );

    const suiteLied = writeWrapped(work, fixture, 1);
    const suiteDoc = JSON.parse(readFileSync(suiteLied, "utf8"));
    suiteDoc.vitest.testResults[0].message = "AssertionError: hidden in the suite message";
    writeJson(suiteLied, suiteDoc);
    assert.throws(
      () => merge(work, fixture, [suiteLied]),
      /records a passed suite carrying a failure message: AssertionError/u,
    );

    // The clean row — empty failureMessages, empty message — merges.
    const clean = writeWrapped(work, fixture, 1);
    assert.equal(merge(work, fixture, [clean]).testCount, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a hand-falsified plan with a recomputed assignment hash is refused", () => {
  // The defect: `readPlan` proved only that the plan's hash described the
  // plan's own bytes. A plan that moved a file between shards and recomputed
  // the hash agreed with itself, and the merge compared the reports with the
  // plan it had just read — so the canonical assignment was never consulted.
  // Re-derive it from the measured manifest and refuse the disagreement.
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-falsified-plan-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts", "tests/unit/b.test.ts", "tests/unit/c.test.ts"], {
      shardCount: 2,
    });
    // Canonical LPT (all weights 1) is shard 1 = [a, c], shard 2 = [b].
    fixture.plan.shards = [
      { index: 1, weightMs: 2, files: ["tests/unit/a.test.ts", "tests/unit/b.test.ts"] },
      { index: 2, weightMs: 1, files: ["tests/unit/c.test.ts"] },
    ];
    fixture.plan.assignmentHash = assignmentHash(fixture.plan.shards);
    writeJson(fixture.planPath, fixture.plan);
    const first = writeWrapped(work, fixture, 1, { tests: 1 });
    const second = writeWrapped(work, fixture, 2, { tests: 1 });
    assert.throws(
      () => merge(work, fixture, [first, second]),
      /does not match the assignment re-derived from the measured manifest/u,
    );

    // The exact round-5 shape: every file in shard 1, shard 2 empty, hash
    // recomputed. The old merge wrote a receipt with `shardCount: 2` while
    // one shard had run nothing.
    const emptyShardFixture = planFixture(work, ["tests/unit/a.test.ts", "tests/unit/b.test.ts"], { shardCount: 2 });
    emptyShardFixture.plan.shards = [
      { index: 1, weightMs: 2, files: ["tests/unit/a.test.ts", "tests/unit/b.test.ts"] },
      { index: 2, weightMs: 0, files: [] },
    ];
    emptyShardFixture.plan.assignmentHash = assignmentHash(emptyShardFixture.plan.shards);
    writeJson(emptyShardFixture.planPath, emptyShardFixture.plan);
    const full = writeWrapped(work, emptyShardFixture, 1, { tests: 1 });
    const empty = writeWrapped(work, emptyShardFixture, 2, { tests: 0 });
    assert.throws(
      () => merge(work, emptyShardFixture, [full, empty]),
      /does not match the assignment re-derived from the measured manifest|has no files while the manifest/u,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a plan with a zero-file shard is refused while the manifest is non-empty", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-zero-file-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts", "tests/unit/b.test.ts"], { shardCount: 2 });
    // Keep the canonical first shard and empty the second.
    fixture.plan.shards[1] = { index: 2, weightMs: 0, files: [] };
    fixture.plan.assignmentHash = assignmentHash(fixture.plan.shards);
    writeJson(fixture.planPath, fixture.plan);
    const first = writeWrapped(work, fixture, 1, { tests: 1 });
    const empty = writeWrapped(work, fixture, 2, { tests: 0 });
    assert.throws(
      () => merge(work, fixture, [first, empty]),
      /has no files while the manifest holds 2 supported file\(s\); it ran nothing/u,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shard merge refuses a wrapped report that does not declare its failed-suite count", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-absent-count-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts"]);
    const report = writeWrapped(work, fixture, 1, { counts: { numFailedTestSuites: undefined } });
    // `writeWrapped` spreads `undefined` away in JSON, which is the wire
    // shape this arm needs: the field is absent.
    assert.equal("numFailedTestSuites" in JSON.parse(readFileSync(report, "utf8")).vitest, false);
    assert.throws(() => merge(work, fixture, [report]), /does not declare numFailedTestSuites; absent is not zero/u);

    // A genuinely green wrapped report — the same counts, declared — merges.
    const ok = writeWrapped(work, fixture, 1);
    assert.equal(merge(work, fixture, [ok]).failedTests, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shard merge refuses skipped or todo tests", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-skipped-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts"]);
    const report = writeWrapped(work, fixture, 1, { counts: { numPendingTests: 1 } });
    assert.throws(() => merge(work, fixture, [report]), /skipped and 0 todo test/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ── PROVENANCE IS NOT OPT-IN ────────────────────────────────────────────────
//
// The merge refused an unwrapped report only when a plan happened to be
// supplied, and neither the plan nor a timing window was required. A
// plan-less merge therefore accepted raw reports and wrote a receipt naming
// the caller's `--head` with nothing binding the files to that commit. These
// arms are the two refusals the finding named, plus the timing default.

test("a raw (unwrapped) shard report is refused even against a non-empty manifest", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-raw-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts", "tests/unit/b.test.ts"]);
    const rawEmpty = join(work, "raw-empty.json");
    writeJson(rawEmpty, shardReport([]));
    assert.throws(
      () => merge(work, fixture, [rawEmpty]),
      new RegExp(`report has no ${SHARD_REPORT_SCHEMA.replaceAll("/", "\\/")} provenance envelope`, "u"),
      "an empty raw report is not evidence just because the manifest covers nothing this shard claims",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a merge without --plan is refused before it can name the caller's head", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-noplan-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts"]);
    const wrapped = writeWrapped(work, fixture, 1);
    assert.throws(
      () => merge(work, fixture, [wrapped], { planPath: undefined }),
      /--plan is required/u,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a shard without a measured timing window is refused by default", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-notiming-"));
  try {
    const fixture = planFixture(work, ["tests/unit/a.test.ts"]);
    const wrapped = writeWrapped(work, fixture, 1, { timing: false });
    assert.throws(() => merge(work, fixture, [wrapped]), /no measured shard timing/u);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

const SHARD_WORKFLOW = new URL("../../.github/workflows/test-shards.yml", import.meta.url);
const TERMINAL_RESULTS = ["success", "failure", "cancelled", "skipped"];
const shardWorkflow = () => parse(readFileSync(SHARD_WORKFLOW, "utf8"));

function requireUnforgiven(node, label) {
  assert.ok(node["continue-on-error"] === undefined || node["continue-on-error"] === false, `${label} cannot forgive a terminal failure`);
}

/** Drive the actual first guard only, using the SDK for its actual job/env expressions. */
function runPrerequisiteGuard(workflow, results, work) {
  const job = workflow.jobs.merge;
  assert.deepEqual([...job.needs].sort(), ["prepare", "shard"], "this receipt consumes the plan and web shard producers");
  requireUnforgiven(job, "the required merge job");
  for (const dependency of job.needs) {
    const producer = workflow.jobs[dependency];
    requireUnforgiven(producer, `producer ${dependency}`);
    for (const step of producer.steps) requireUnforgiven(step, `producer ${dependency}'s ${step.name}`);
  }
  const context = { needs: Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result }])) };
  assert.equal(evaluateAlwaysJobCondition(job.if, context), true, "the required job must report after every producer result");
  const guard = job.steps[0];
  assert.equal(typeof guard.run, "string", "the first step must refuse bad producers before downloading or merging reports");
  requireUnforgiven(guard, "the prerequisite guard");
  if (guard.if !== undefined) assert.equal(evaluateAlwaysJobCondition(guard.if, context), true, "the prerequisite guard cannot be skipped");
  const env = Object.fromEntries(Object.entries(guard.env).map(([name, value]) => [name, evaluateJobEnvironmentValue(value, context)]));
  return spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", guard.run], { cwd: work, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
}

/** Reuse the real plan and wrapper before asking the real merger to accept green assertion JSON. */
function greenReportFixture(work) {
  const fixture = planFixture(work, ["tests/unit/a.test.ts", "tests/unit/b.test.ts"], { shardCount: 2 });
  const reports = fixture.plan.shards.map(({ index }) => {
    const vitestPath = join(work, `raw-${index}.json`);
    const outPath = join(work, `wrapped-${index}.json`);
    writeJson(vitestPath, shardReport(plannedFiles(work, fixture, index), { tests: 2 }));
    wrapShardReport({ root: work, planPath: fixture.planPath, shard: index, vitestPath, outPath,
      startedAt: "1970-01-01T00:00:01.000Z", finishedAt: "1970-01-01T00:00:02.000Z" });
    return outPath;
  });
  const receipt = merge(work, fixture, reports);
  assert.equal(receipt.passedTests, receipt.testCount);
  assert.equal(receipt.failedTests, 0);
  assert.equal(receipt.fileCount, 2);
  rmSync(join(work, "receipt.json"));
  return { fixture, reports };
}

function assertTerminalBoundary(workflow, work, { fixture, reports }) {
  for (const prepare of TERMINAL_RESULTS) for (const shard of TERMINAL_RESULTS) {
    rmSync(join(work, "receipt.json"), { force: true });
    const guard = runPrerequisiteGuard(workflow, { prepare, shard }, work);
    const succeeded = prepare === "success" && shard === "success";
    if (guard.status === 0) merge(work, fixture, reports);
    const label = `prepare=${prepare}, shard=${shard}`;
    assert.equal(guard.status, succeeded ? 0 : 1, `${label}: producer outcomes, not green assertion JSON, decide whether a receipt may be produced`);
    assert.equal(existsSync(join(work, "receipt.json")), succeeded, `${label}: receipt existence must follow the terminal prerequisite`);
  }
}

test("the receipt prerequisite requires both successful producer results even with valid green reports", () => withTempDir("shard-terminal-", (work) => {
  const reports = greenReportFixture(work);
  assertTerminalBoundary(shardWorkflow(), work, reports);
  const bracketed = shardWorkflow();
  bracketed.jobs.merge.if = "${{ (always()) }}";
  bracketed.jobs.merge.steps[0].env.SHARD_RESULT = "${{ needs['shard']['result'] }}";
  assertTerminalBoundary(bracketed, work, reports);
}));

test("the terminal guard's causal controls reject missing result checks, substitutions, skipping and forgiveness", () => withTempDir("shard-terminal-controls-", (work) => {
  const reports = greenReportFixture(work);
  const mutant = (change, expected) => {
    const workflow = shardWorkflow();
    change(workflow);
    assert.throws(() => assertTerminalBoundary(workflow, work, reports), expected);
  };
  mutant((workflow) => { workflow.jobs.merge.steps[0].run = 'test "$PREPARE_RESULT" = "success"'; }, /prepare=success, shard=failure/u);
  mutant((workflow) => { workflow.jobs.merge.steps[0].env.SHARD_RESULT = "${{ needs.prepare.result }}"; }, /prepare=success, shard=failure/u);
  mutant((workflow) => { workflow.jobs.merge.steps[0].env.SHARD_RESULT = "success"; }, /prepare=success, shard=failure/u);
  mutant((workflow) => { workflow.jobs.merge.if = "true"; }, /must call always/u);
  mutant((workflow) => { workflow.jobs.merge.if = "needs.prepare.result == 'success' && needs.shard.result == 'success'"; }, /must call always/u);
  mutant((workflow) => { workflow.jobs.merge.steps[0].if = "needs.shard.result == 'success'"; }, /must call always/u);
  mutant((workflow) => { workflow.jobs.merge["continue-on-error"] = true; }, /cannot forgive/u);
  mutant((workflow) => { workflow.jobs.merge.steps[0]["continue-on-error"] = true; }, /cannot forgive/u);
  for (const dependency of ["prepare", "shard"]) {
    mutant((workflow) => { workflow.jobs[dependency]["continue-on-error"] = true; }, /cannot forgive/u);
    mutant((workflow) => { workflow.jobs[dependency].steps[0]["continue-on-error"] = true; }, /cannot forgive/u);
  }
}));

test("a failed command retaining green JSON is refused while a prepare-only mutant can still write a green receipt", () => withTempDir("shard-failed-command-", (work) => {
  const { fixture, reports } = greenReportFixture(work);
  const command = spawnSync(process.execPath, ["-e", "process.exitCode = 1;"], { cwd: work, env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(command.status, 1, "the local fixture command really exits nonzero after the green files exist");
  const results = { prepare: "success", shard: command.status === 0 ? "success" : "failure" };
  const fixed = runPrerequisiteGuard(shardWorkflow(), results, work);
  assert.equal(fixed.status, 1, fixed.stderr);
  assert.equal(existsSync(join(work, "receipt.json")), false);
  const prepareOnly = shardWorkflow();
  prepareOnly.jobs.merge.steps[0].run = 'test "$PREPARE_RESULT" = "success"';
  assert.equal(runPrerequisiteGuard(prepareOnly, results, work).status, 0);
  const unsafe = merge(work, fixture, reports);
  assert.equal(unsafe.failedTests, 0);
  assert.equal(unsafe.passedTests, unsafe.testCount, "valid JSON remains green despite the actual failed command");
}));

test("the shared SDK evaluator keeps literals literal and refuses unsupported scheduler or template semantics", () => {
  const context = { needs: { prepare: { result: "success" }, shard: { result: "failure" } } };
  assert.equal(evaluateAlwaysJobCondition("always()", context), true);
  assert.equal(evaluateAlwaysJobCondition("${{ (always()) }}", context), true);
  assert.equal(evaluateJobEnvironmentValue("${{ needs['shard']['result'] }}", context), "failure");
  assert.equal(evaluateJobEnvironmentValue("${{ format('{0}', needs.shard.result) }}", context), "failure");
  assert.equal(evaluateJobEnvironmentValue("success", context), "success");
  assert.equal(evaluateJobEnvironmentValue(" needs.shard.result ", context), " needs.shard.result ");
  for (const condition of ["true", "'always()'", "success()", "cancelled()", "always() || true"]) assert.throws(() => evaluateAlwaysJobCondition(condition, context));
  for (const value of ["prefix ${{ needs.shard.result }}", " ${{ needs.shard.result }} ", "${{ needs.shard.result", "${{ cancelled() }}"])
    assert.throws(() => evaluateJobEnvironmentValue(value, context));
});
