import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MANIFEST_SCHEMA,
  assignShards,
  manifestHash,
  planShards,
  readManifest,
  verifyManifest,
  wrapShardReport,
} from "../../scripts/test-shard-manifest.mjs";
import { mergeShardReports } from "../../scripts/test-shard-merge.mjs";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function manifestFor(files, excluded = []) {
  return {
    schemaVersion: MANIFEST_SCHEMA,
    measuredHeadSha: "480bfe3",
    measuredAt: "2026-10-20T00:00:00.000Z",
    files: files.map((file) => ({ path: file, weightMs: 1 })),
    excluded,
  };
}

test("the shard manifest hash is the canonical sorted-path hash", () => {
  assert.equal(manifestHash(["b.test.ts", "a.test.ts"]), manifestHash([{ path: "a.test.ts" }, { path: "b.test.ts" }]));
  assert.notEqual(manifestHash(["a.test.ts"]), manifestHash(["b.test.ts"]));
});

test("the manifest verifier accounts for every live file exactly once", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-manifest-"));
  try {
    const manifest = join(work, "manifest.json");
    const live = join(work, "live.json");
    mkdirSync(join(work, "tests"), { recursive: true });
    writeJson(manifest, manifestFor(["tests/a.test.ts", "tests/b.test.ts"], [
      { path: "tests/private.test.ts", reason: "not published", evidence: "roadmap" },
    ]));
    writeFileSync(join(work, "tests/a.test.ts"), "");
    writeFileSync(join(work, "tests/b.test.ts"), "");
    writeJson(live, [
      { file: join(work, "tests/a.test.ts"), projectName: "node" },
      { file: join(work, "tests/b.test.ts"), projectName: "node" },
      { file: join(work, "tests/private.test.ts"), projectName: "node" },
    ]);
    const verdict = verifyManifest({ root: work, manifestPath: manifest, livePath: live });
    assert.equal(verdict.fileCount, 2);
    assert.equal(verdict.excludedCount, 1);
    assert.equal(verdict.liveCount, 3);

    writeJson(live, [{ file: join(work, "tests/a.test.ts") }, { file: join(work, "tests/unclassified.test.ts") }]);
    assert.throws(
      () => verifyManifest({ root: work, manifestPath: manifest, livePath: live }),
      /unclassified file/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("shard assignment is deterministic, complete, disjoint, and weight-balanced", () => {
  const files = [
    { path: "tests/a.test.ts", weightMs: 10 },
    { path: "tests/b.test.ts", weightMs: 9 },
    { path: "tests/c.test.ts", weightMs: 8 },
    { path: "tests/d.test.ts", weightMs: 1 },
  ];
  const first = assignShards(files, 2);
  const second = assignShards([...files].reverse(), 2);
  assert.deepEqual(first, second);
  assert.equal(first.flatMap((shard) => shard.files).length, files.length);
  assert.equal(new Set(first.flatMap((shard) => shard.files)).size, files.length);
  assert.deepEqual(first.map((shard) => shard.weightMs), [11, 17]);
  assert.throws(() => assignShards(files, 0), /between 1 and the supported file count/);
  assert.throws(() => assignShards(files, 5), /between 1 and the supported file count/);
});

test("a plan and wrapped shard reports merge into a receipt bound to one commit", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-provenance-"));
  try {
    const manifest = join(work, "manifest.json");
    const planDir = join(work, "plan");
    const head = "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718";
    mkdirSync(join(work, "tests"), { recursive: true });
    writeJson(manifest, manifestFor(["tests/a.test.ts", "tests/b.test.ts"]));
    writeFileSync(join(work, "tests/a.test.ts"), "");
    writeFileSync(join(work, "tests/b.test.ts"), "");
    const plan = planShards({ root: work, manifestPath: manifest, shardCount: 2, headSha: head, outDir: planDir });
    const reports = [];
    for (const shard of plan.shards) {
      const raw = join(work, `raw-${shard.index}.json`);
      const wrapped = join(work, `wrapped-${shard.index}.json`);
      writeJson(raw, {
        success: true,
        numTotalTests: shard.files.length,
        numFailedTests: 0,
        numFailedTestSuites: 0,
        testResults: shard.files.map((file) => ({ name: join(work, file), status: "passed", assertionResults: [] })),
      });
      wrapShardReport({
        root: work,
        planPath: join(planDir, "plan.json"),
        shard: shard.index,
        vitestPath: raw,
        outPath: wrapped,
      });
      reports.push(wrapped);
    }
    const receipt = mergeShardReports({
      root: work,
      manifestPath: join(planDir, "manifest.json"),
      planPath: join(planDir, "plan.json"),
      shardPaths: reports,
      expectedShards: 2,
      headSha: head,
      outPath: join(work, "receipt.json"),
    });
    assert.equal(receipt.headSha, head);
    assert.equal(receipt.manifestHash, plan.manifestHash);
    assert.equal(receipt.assignmentHash, plan.assignmentHash);
    assert.equal(receipt.fileCount, 2);

    assert.throws(
      () => mergeShardReports({
        root: work,
        manifestPath: join(planDir, "manifest.json"),
        planPath: join(planDir, "plan.json"),
        shardPaths: reports,
        expectedShards: 2,
        headSha: "b1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718",
        outPath: join(work, "wrong.json"),
      }),
      /plan: head/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a wrapped report with the wrong commit or manifest hash is refused", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-wrong-provenance-"));
  try {
    const manifest = join(work, "manifest.json");
    const planDir = join(work, "plan");
    const head = "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718";
    mkdirSync(join(work, "tests"), { recursive: true });
    writeJson(manifest, manifestFor(["tests/a.test.ts"]));
    writeFileSync(join(work, "tests/a.test.ts"), "");
    const plan = planShards({ root: work, manifestPath: manifest, shardCount: 1, headSha: head, outDir: planDir });
    const raw = join(work, "raw.json");
    const wrapped = join(work, "wrapped.json");
    writeJson(raw, {
      success: true, numTotalTests: 1, numFailedTests: 0, numFailedTestSuites: 0,
      testResults: [{ name: join(work, "tests/a.test.ts"), status: "passed", assertionResults: [] }],
    });
    wrapShardReport({ root: work, planPath: join(planDir, "plan.json"), shard: 1, vitestPath: raw, outPath: wrapped });
    const envelope = JSON.parse(readFileSync(wrapped, "utf8"));
    envelope.headSha = "b1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718";
    writeJson(wrapped, envelope);
    assert.throws(
      () => mergeShardReports({
        root: work, manifestPath: join(planDir, "manifest.json"), planPath: join(planDir, "plan.json"),
        shardPaths: [wrapped], expectedShards: 1, headSha: head, outPath: join(work, "receipt.json"),
      }),
      (error) => error instanceof Error && error.message.includes("head") && error.message.includes("is not"),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
