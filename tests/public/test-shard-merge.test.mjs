import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { mergeShardReports } from "../../scripts/test-shard-merge.mjs";
import {
  MANIFEST_SCHEMA,
  SHARD_REPORT_SCHEMA,
  planShards,
  wrapShardReport,
} from "../../scripts/test-shard-manifest.mjs";

const HEAD = "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function shardReport(files, { success = true, tests = 1 } = {}) {
  return {
    success,
    numTotalTests: success ? files.length * tests : 0,
    numPassedTests: success ? files.length * tests : 0,
    numFailedTests: success ? 0 : 1,
    numFailedTestSuites: success ? 0 : 1,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: files.map((name) => ({ name, status: "passed", assertionResults: [] })),
  };
}

/**
 * A plan-backed fixture: the merge now REQUIRES the plan, and only a wrapped
 * report carries provenance. Every arm below drives the real plan producer,
 * so the exact-assignment check is exercised rather than bypassed.
 */
function planFixture(work, files, { shardCount = 1, excluded = [] } = {}) {
  mkdirSync(join(work, "tests"), { recursive: true });
  for (const file of files) writeFileSync(join(work, file), "");
  const source = join(work, "source-manifest.json");
  writeJson(source, {
    schemaVersion: MANIFEST_SCHEMA,
    measuredHeadSha: HEAD,
    measuredAt: "2026-01-01T00:00:00.000Z",
    files: files.map((file) => ({ path: file, weightMs: 1 })),
    excluded,
  });
  const planDir = join(work, "plan");
  planShards({ root: work, manifestPath: source, shardCount, headSha: HEAD, outDir: planDir });
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
    const fixture = planFixture(work, ["tests/a.test.ts", "tests/b.test.ts"], { shardCount: 2 });
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

test("the receipt names the manifest exclusions and their evidence anchors", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-exclusions-"));
  try {
    const fixture = planFixture(work, ["tests/a.test.ts"], {
      excluded: [
        { path: "tests/private.test.ts", reason: "not published", evidence: "docs/floor/roadmap.md#snapshot" },
      ],
    });
    const report = writeWrapped(work, fixture, 1, { tests: 4 });

    const receipt = merge(work, fixture, [report], { manifestSourcePath: fixture.source });

    assert.equal(receipt.excludedFileCount, 1);
    assert.deepEqual(receipt.exclusions, [
      { path: "tests/private.test.ts", reason: "not published", evidence: "docs/floor/roadmap.md#snapshot" },
    ]);
    assert.equal(receipt.passedTests, 4);

    const mismatched = join(work, "mismatched.json");
    writeJson(mismatched, {
      schemaVersion: MANIFEST_SCHEMA,
      measuredHeadSha: HEAD,
      measuredAt: "2026-01-01T00:00:00.000Z",
      files: [{ path: "tests/other.test.ts", weightMs: 1 }],
      excluded: [],
    });
    assert.throws(
      () => merge(work, fixture, [report], { manifestSourcePath: mismatched }),
      /manifest source: hash does not match/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a wrapped report whose timing contradicts itself or its own run is refused", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-timing-"));
  try {
    const fixture = planFixture(work, ["tests/a.test.ts"]);
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
    const fixture = planFixture(work, ["tests/a.test.ts", "tests/b.test.ts"], { shardCount: 2 });
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
    const fixture = planFixture(work, ["tests/a.test.ts", "tests/b.test.ts"]);
    const first = writeWrapped(work, fixture, 1, {
      files: [...plannedFiles(work, fixture, 1), join(work, "tests/b.test.ts"), join(work, "tests/b.test.ts")],
    });
    assert.throws(() => merge(work, fixture, [first]), /duplicate test file/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shard merge refuses a failed shard or a report outside the root", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-refuse-"));
  try {
    const fixture = planFixture(work, ["tests/a.test.ts"]);
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

test("the shard merge refuses a wrapped report that does not declare its failed-suite count", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-absent-count-"));
  try {
    const fixture = planFixture(work, ["tests/a.test.ts"]);
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
    const fixture = planFixture(work, ["tests/a.test.ts"]);
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
    const fixture = planFixture(work, ["tests/a.test.ts", "tests/b.test.ts"]);
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
    const fixture = planFixture(work, ["tests/a.test.ts"]);
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
    const fixture = planFixture(work, ["tests/a.test.ts"]);
    const wrapped = writeWrapped(work, fixture, 1, { timing: false });
    assert.throws(() => merge(work, fixture, [wrapped]), /no measured shard timing/u);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
