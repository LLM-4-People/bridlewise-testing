import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { mergeShardReports } from "../../scripts/test-shard-merge.mjs";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function shardReport(files, { success = true, tests = 1 } = {}) {
  return {
    success,
    numTotalTests: success ? files.length * tests : 0,
    numFailedTests: success ? 0 : 1,
    numFailedTestSuites: success ? 0 : 1,
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
