import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { mergeShardReports } from "../../scripts/test-shard-merge.mjs";
import { MANIFEST_SCHEMA, planShards, wrapShardReport } from "../../scripts/test-shard-manifest.mjs";

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

test("the shard merge accepts a complete disjoint manifest", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-merge-"));
  try {
    const a = join(work, "tests/a.test.ts");
    const b = join(work, "tests/b.test.ts");
    const manifest = join(work, "manifest.json");
    const first = join(work, "shard-1.json");
    const second = join(work, "shard-2.json");
    const out = join(work, "receipt.json");
    writeJson(manifest, [
      { file: a, projectName: "node" },
      { file: b, projectName: "node" },
    ]);
    writeJson(first, shardReport([a], { tests: 2 }));
    writeJson(second, shardReport([b], { tests: 3 }));

    const receipt = mergeShardReports({
      root: work,
      manifestPath: manifest,
      shardPaths: [first, second],
      expectedShards: 2,
      headSha: "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718",
      outPath: out,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    assert.equal(receipt.schemaVersion, "bridlewise-test-shard-receipt/v1");
    assert.equal(receipt.fileCount, 2);
    assert.equal(receipt.testCount, 5);
    assert.equal(receipt.shardCount, 2);
    assert.match(receipt.manifestHash, /^[0-9a-f]{64}$/);
    assert.equal(receipt.passedTests, 5);
    assert.equal(receipt.failedTests, 0);
    assert.equal(receipt.skippedTests, 0);
    assert.deepEqual(receipt.shards, [
      { index: 1, fileCount: 1, testCount: 2, passedTests: 2, failedTests: 0, skippedTests: 0 },
      { index: 2, fileCount: 1, testCount: 3, passedTests: 3, failedTests: 0, skippedTests: 0 },
    ]);
    assert.equal(JSON.stringify(receipt).includes(work), false, "receipt must not leak the absolute root");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the receipt names the manifest exclusions and their evidence anchors", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-exclusions-"));
  try {
    const a = join(work, "tests/a.test.ts");
    const manifest = join(work, "manifest.json");
    const source = join(work, "source.json");
    const report = join(work, "shard-1.json");
    const out = join(work, "receipt.json");
    writeJson(manifest, [{ file: a }]);
    writeJson(source, {
      schemaVersion: "bridlewise-test-shard-manifest/v1",
      measuredHeadSha: "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718",
      measuredAt: "2026-01-01T00:00:00.000Z",
      files: [{ path: "tests/a.test.ts", weightMs: 1 }],
      excluded: [
        { path: "tests/private.test.ts", reason: "not published", evidence: "docs/floor/roadmap.md#snapshot" },
      ],
    });
    writeJson(report, shardReport([a], { tests: 4 }));

    const receipt = mergeShardReports({
      root: work,
      manifestPath: manifest,
      manifestSourcePath: source,
      shardPaths: [report],
      expectedShards: 1,
      headSha: "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718",
      outPath: out,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    assert.equal(receipt.excludedFileCount, 1);
    assert.deepEqual(receipt.exclusions, [
      { path: "tests/private.test.ts", reason: "not published", evidence: "docs/floor/roadmap.md#snapshot" },
    ]);
    assert.equal(receipt.passedTests, 4);

    const mismatched = join(work, "mismatched.json");
    writeJson(mismatched, {
      schemaVersion: "bridlewise-test-shard-manifest/v1",
      measuredHeadSha: "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718",
      measuredAt: "2026-01-01T00:00:00.000Z",
      files: [{ path: "tests/other.test.ts", weightMs: 1 }],
      excluded: [],
    });
    assert.throws(
      () => mergeShardReports({
        root: work,
        manifestPath: manifest,
        manifestSourcePath: mismatched,
        shardPaths: [report],
        expectedShards: 1,
        headSha: "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718",
        outPath: join(work, "refused.json"),
      }),
      /manifest source: hash does not match/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a wrapped report whose timing contradicts itself or its own run is refused", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-timing-"));
  try {
    const file = join(work, "tests/a.test.ts");
    const manifest = join(work, "manifest.json");
    const planDir = join(work, "plan");
    const raw = join(work, "raw.json");
    const wrapped = join(work, "wrapped.json");
    const head = "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718";
    mkdirSync(join(work, "tests"), { recursive: true });
    writeFileSync(file, "");
    writeJson(manifest, {
      schemaVersion: MANIFEST_SCHEMA,
      measuredHeadSha: head,
      measuredAt: "2026-01-01T00:00:00.000Z",
      files: [{ path: "tests/a.test.ts", weightMs: 1 }],
      excluded: [],
    });
    planShards({ root: work, manifestPath: manifest, shardCount: 1, headSha: head, outDir: planDir });
    writeJson(raw, shardReport([file]));
    wrapShardReport({
      root: work, planPath: join(planDir, "plan.json"), shard: 1, vitestPath: raw, outPath: wrapped,
      startedAt: "1000", finishedAt: "2000",
    });
    const clean = JSON.parse(readFileSync(wrapped, "utf8"));
    const merge = () => mergeShardReports({
      root: work, manifestPath: join(planDir, "manifest.json"), planPath: join(planDir, "plan.json"),
      shardPaths: [wrapped], expectedShards: 1, headSha: head, outPath: join(work, "receipt.json"),
    });
    assert.equal(clean.timing.durationMs, 1000);
    assert.equal(merge().testPhaseMs, 1000);

    // durationMs is the window's length. The merge used to trust it while
    // deriving the window from the timestamps, so the receipt could claim a
    // critical path that no pair of timestamps supported.
    writeJson(wrapped, { ...clean, timing: { ...clean.timing, durationMs: 9_999 } });
    assert.throws(merge, /durationMs 9999 does not equal finishedAt - startedAt \(1000\)/u);

    // vitest dates its own run; that run sits inside its job's window.
    writeJson(wrapped, { ...clean, vitest: { ...clean.vitest, startTime: 9_000, endTime: 9_500 } });
    assert.throws(merge, /outside the shard window/u);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shard merge refuses a missing file", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-missing-"));
  try {
    const a = join(work, "tests/a.test.ts");
    const b = join(work, "tests/b.test.ts");
    const manifest = join(work, "manifest.json");
    const first = join(work, "shard-1.json");
    const second = join(work, "shard-2.json");
    writeJson(manifest, [{ file: a }, { file: b }]);
    writeJson(first, shardReport([a]));
    writeJson(second, shardReport([]));
    assert.throws(
      () =>
        mergeShardReports({
          root: work,
          manifestPath: manifest,
          shardPaths: [first, second],
          expectedShards: 2,
          headSha: "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718",
          outPath: join(work, "receipt.json"),
        }),
      /missing 1 manifest file/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shard merge refuses a duplicate file", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-duplicate-"));
  try {
    const a = join(work, "tests/a.test.ts");
    const b = join(work, "tests/b.test.ts");
    const manifest = join(work, "manifest.json");
    const first = join(work, "shard-1.json");
    const second = join(work, "shard-2.json");
    writeJson(manifest, [{ file: a }, { file: b }]);
    writeJson(first, shardReport([a, b]));
    writeJson(second, shardReport([b]));
    assert.throws(
      () =>
        mergeShardReports({
          root: work,
          manifestPath: manifest,
          shardPaths: [first, second],
          expectedShards: 2,
          headSha: "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718",
          outPath: join(work, "receipt.json"),
        }),
      /also ran in shard 1/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shard merge refuses a failed shard or a file outside the root", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-refuse-"));
  try {
    const a = join(work, "tests/a.test.ts");
    const manifest = join(work, "manifest.json");
    const failed = join(work, "shard-1.json");
    writeJson(manifest, [{ file: a }]);
    writeJson(failed, shardReport([a], { success: false }));
    assert.throws(
      () =>
        mergeShardReports({
          root: work,
          manifestPath: manifest,
          shardPaths: [failed],
          expectedShards: 1,
          headSha: "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718",
          outPath: join(work, "receipt.json"),
        }),
      /success=false/,
    );

    writeJson(manifest, [{ file: join(work, "..", "outside.test.ts") }]);
    writeJson(failed, shardReport([a]));
    assert.throws(
      () =>
        mergeShardReports({
          root: work,
          manifestPath: manifest,
          shardPaths: [failed],
          expectedShards: 1,
          headSha: "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718",
          outPath: join(work, "receipt.json"),
        }),
      /escapes the repository root/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shard merge refuses a report that does not declare its failed-suite count", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-absent-count-"));
  try {
    const a = join(work, "tests/a.test.ts");
    const manifest = join(work, "manifest.json");
    const report = join(work, "shard-1.json");
    const out = join(work, "receipt.json");
    writeJson(manifest, [{ file: a }]);
    const green = shardReport([a]);
    delete green.numFailedTestSuites;
    writeJson(report, green);
    const merge = () => mergeShardReports({
      root: work,
      manifestPath: manifest,
      shardPaths: [report],
      expectedShards: 1,
      headSha: "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718",
      outPath: out,
    });
    // Absent is not zero: a report that never said it had no failing suite
    // used to merge as if it had declared one.
    assert.throws(merge, /does not declare numFailedTestSuites; absent is not zero/u);
    // A genuinely green report — the same counts, declared — still merges.
    writeJson(report, shardReport([a]));
    assert.equal(merge().failedTests, 0);

    // The CI path is a WRAPPED report; the finding's reproduction. The
    // envelope carries provenance, not counts, so the same absence rule must
    // refuse it there too, and the genuine wrapped report must still merge.
    const head = "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718";
    const planDir = join(work, "plan");
    const planManifest = join(work, "plan-manifest.json");
    const raw = join(work, "raw.json");
    const wrapped = join(work, "wrapped.json");
    mkdirSync(join(work, "tests"), { recursive: true });
    writeFileSync(a, "");
    writeJson(planManifest, {
      schemaVersion: MANIFEST_SCHEMA,
      measuredHeadSha: head,
      measuredAt: "2026-01-01T00:00:00.000Z",
      files: [{ path: "tests/a.test.ts", weightMs: 1 }],
      excluded: [],
    });
    planShards({ root: work, manifestPath: planManifest, shardCount: 1, headSha: head, outDir: planDir });
    const wrappedMerge = () => mergeShardReports({
      root: work,
      manifestPath: join(planDir, "manifest.json"),
      planPath: join(planDir, "plan.json"),
      shardPaths: [wrapped],
      expectedShards: 1,
      headSha: head,
      outPath: join(work, "wrapped-receipt.json"),
    });
    writeJson(raw, green);
    wrapShardReport({
      root: work, planPath: join(planDir, "plan.json"), shard: 1, vitestPath: raw, outPath: wrapped,
      startedAt: "1000", finishedAt: "2000",
    });
    assert.throws(wrappedMerge, /does not declare numFailedTestSuites; absent is not zero/u);
    writeJson(raw, shardReport([a]));
    wrapShardReport({
      root: work, planPath: join(planDir, "plan.json"), shard: 1, vitestPath: raw, outPath: wrapped,
      startedAt: "1000", finishedAt: "2000",
    });
    assert.equal(wrappedMerge().failedTests, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shard merge refuses skipped or todo tests", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-skipped-"));
  try {
    const a = join(work, "tests/a.test.ts");
    const manifest = join(work, "manifest.json");
    const report = join(work, "shard-1.json");
    writeJson(manifest, [{ file: a }]);
    writeJson(report, {
      ...shardReport([a]),
      numPendingTests: 1,
    });
    assert.throws(
      () => mergeShardReports({
        root: work,
        manifestPath: manifest,
        shardPaths: [report],
        expectedShards: 1,
        headSha: "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718",
        outPath: join(work, "receipt.json"),
      }),
      /skipped and 0 todo test/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
