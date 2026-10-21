import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MANIFEST_SCHEMA,
  SHARD_REPORT_SCHEMA,
  assignShards,
  manifestHash,
  measureManifest,
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

function shardReportFor(work, { head, manifestHashValue, shard, shardCount, entries, finishedAt, success = true, timing = true }) {
  const path = join(work, `shard-${shard}.json`);
  const startedAt = "2026-10-20T00:00:00.000Z";
  writeJson(path, {
    schemaVersion: SHARD_REPORT_SCHEMA,
    headSha: head,
    manifestHash: manifestHashValue,
    assignmentHash: "0".repeat(64),
    shard,
    shardCount,
    ...(timing ? { timing: { startedAt, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt) } } : {}),
    vitest: {
      success,
      numTotalTests: entries.length,
      numPassedTests: success ? entries.length : 0,
      numFailedTests: success ? 0 : 1,
      numFailedTestSuites: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: entries.map(([file, startTime, endTime]) => ({
        name: file,
        status: success ? "passed" : "failed",
        startTime,
        endTime,
        assertionResults: [],
      })),
    },
  });
  return path;
}

test("the checked-in shard manifest is complete, well-formed and self-describing", () => {
  // The tracked manifest is data the shard plan trusts. This was the only
  // test that imported readManifest without ever calling it: the file could
  // gain a malformed entry, a negative weight, or a weightSource claiming a
  // population the file list does not have, and the suite stayed green. The
  // prose count is part of the provenance, so it is checked like the data.
  const manifestPath = join(process.cwd(), "tests/test-shards.json");
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifest = readManifest(process.cwd(), manifestPath);
  assert.ok(manifest.files.length > 500, `expected the supported suite, found ${manifest.files.length} files`);
  assert.equal(manifest.excluded.length, 4);
  assert.match(raw.measuredHeadSha, /^[0-9a-f]{40}$/u);
  assert.ok(Number.isFinite(Date.parse(raw.measuredAt)), "measuredAt must be a timestamp");
  assert.equal(typeof raw.weightSource, "string");
  const declared = /(\d+) supported files/u.exec(raw.weightSource)?.[1];
  assert.equal(Number(declared), manifest.files.length, "weightSource must name the manifest's population");
  for (const file of manifest.files) {
    // The producer floors a weight at 1 (`Math.max(1, Math.round(...))`) and
    // `readManifest` refuses a non-positive entry. This self-check asserted
    // `>= 0`, so a zero-weight fixture read as measured here while the owner
    // refused it — the check was weaker than the thing it audits.
    assert.ok(Number.isSafeInteger(file.weightMs) && file.weightMs >= 1, `${file.path} has no measured weight`);
    assert.match(file.path, /\.test\.(?:ts|mjs)$/u, `${file.path} is not a test file`);
  }
});

test("a zero weight is refused by the owner, not read as a measured weight", () => {
  // The self-check above audits the tracked manifest; this arm drives the
  // owner's own floor so the two cannot drift apart again.
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-weight-floor-"));
  try {
    const path = join(work, "manifest.json");
    const manifest = manifestFor(["tests/a.test.ts"]);
    manifest.files[0].weightMs = 0;
    writeJson(path, manifest);
    assert.throws(() => readManifest(work, path), /must carry a positive integer weightMs/u);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

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
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: shard.files.map((file) => ({ name: join(work, file), status: "passed", assertionResults: [] })),
      });
      wrapShardReport({
        root: work,
        planPath: join(planDir, "plan.json"),
        shard: shard.index,
        vitestPath: raw,
        outPath: wrapped,
        startedAt: shard.index === 1 ? "1000" : "1500",
        finishedAt: shard.index === 1 ? "2000" : "2500",
      });
      reports.push(wrapped);
    }
    const receipt = mergeShardReports({
      root: work,
      manifestPath: join(planDir, "manifest.json"),
      manifestSourcePath: manifest,
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
    assert.equal(receipt.excludedFileCount, 0);
    assert.deepEqual(receipt.exclusions, []);
    assert.equal(receipt.passedTests, 2);
    assert.equal(receipt.testPhaseMs, 1_500);
    assert.equal(receipt.testPhaseCpuMs, 2_000);

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

test("a wrapped report with the wrong commit, manifest hash or assignment hash is refused", () => {
  // The title used to promise three provenance mutants and the body planted
  // one (headSha); manifestHash and assignmentHash were only ever checked
  // against the value the plan had just written, so a test that stopped
  // refusing either would keep the suite green. Each mutant below changes the
  // envelope AFTER the plan's own hash is correct, so only the guard under
  // test can refuse it.
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
      numPendingTests: 0, numTodoTests: 0,
      testResults: [{ name: join(work, "tests/a.test.ts"), status: "passed", assertionResults: [] }],
    });
    wrapShardReport({ root: work, planPath: join(planDir, "plan.json"), shard: 1, vitestPath: raw, outPath: wrapped });
    const clean = JSON.parse(readFileSync(wrapped, "utf8"));
    assert.equal(clean.headSha, head);
    assert.equal(clean.manifestHash, plan.manifestHash);
    assert.equal(clean.assignmentHash, plan.assignmentHash);

    const mutants = [
      { field: "headSha", value: "b1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718", pattern: /head [0-9a-f]{40} is not/u },
      { field: "manifestHash", value: "c".repeat(64), pattern: /manifest hash does not match the plan/u },
      { field: "assignmentHash", value: "d".repeat(64), pattern: /assignment hash does not match the plan/u },
    ];
    for (const mutant of mutants) {
      writeJson(wrapped, { ...clean, [mutant.field]: mutant.value });
      assert.throws(
        () => mergeShardReports({
          root: work, manifestPath: join(planDir, "manifest.json"), planPath: join(planDir, "plan.json"),
          shardPaths: [wrapped], expectedShards: 1, headSha: head, outPath: join(work, "receipt.json"),
        }),
        mutant.pattern,
        `a wrong ${mutant.field} must be refused`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the owner measures weights from green shard reports, including runner-root paths", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-measure-"));
  try {
    const manifest = join(work, "manifest.json");
    const head = "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718";
    writeJson(manifest, manifestFor(["tests/a.test.ts", "tests/b.test.ts"]));
    const hash = manifestHash(["tests/a.test.ts", "tests/b.test.ts"]);
    const runnerFile = (file) => `/home/runner/work/bridlewise-testing/bridlewise-testing/${file}`;
    const first = shardReportFor(work, {
      head, manifestHashValue: hash, shard: 1, shardCount: 2,
      entries: [[runnerFile("tests/a.test.ts"), 1000, 1234.6]],
      finishedAt: "2026-10-20T00:00:02.000Z",
    });
    const second = shardReportFor(work, {
      head, manifestHashValue: hash, shard: 2, shardCount: 2,
      entries: [[runnerFile("tests/b.test.ts"), 2000, 2000.2]],
      finishedAt: "2026-10-20T00:00:03.000Z",
    });
    const out = join(work, "measured.json");
    const measured = measureManifest({
      root: work, manifestPath: manifest, reportPaths: [first, second], outPath: out, runner: "ubuntu-24.04",
    });
    const written = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(written.files.map((file) => file.weightMs), [235, 1]);
    assert.equal(written.measuredHeadSha, head);
    assert.equal(written.measuredAt, "2026-10-20T00:00:03.000Z");
    assert.match(written.weightSource, /endTime-startTime/);
    assert.match(written.weightSource, /ubuntu-24\.04/);
    assert.equal(measured.fileCount, 2);
    assert.equal(measured.totalWeightMs, 236);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the weight measurement refuses a partial, duplicated, non-green, or different-manifest run", () => {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-shard-measure-refusal-"));
  try {
    const manifest = join(work, "manifest.json");
    const head = "a1cce5b3f96dec7db1a2a1f1d4aa08bf35ea8718";
    writeJson(manifest, manifestFor(["tests/a.test.ts", "tests/b.test.ts"]));
    const hash = manifestHash(["tests/a.test.ts", "tests/b.test.ts"]);
    const measure = (reportPaths) => measureManifest({ root: work, manifestPath: manifest, reportPaths });

    const partial = shardReportFor(work, {
      head, manifestHashValue: hash, shard: 1, shardCount: 1,
      entries: [["tests/a.test.ts", 0, 10]], finishedAt: "2026-10-20T00:00:02.000Z",
    });
    assert.throws(() => measure([partial]), /were not measured/);

    const duplicateOne = shardReportFor(work, {
      head, manifestHashValue: hash, shard: 1, shardCount: 2,
      entries: [["tests/a.test.ts", 0, 10]], finishedAt: "2026-10-20T00:00:02.000Z",
    });
    const duplicateTwo = shardReportFor(work, {
      head, manifestHashValue: hash, shard: 2, shardCount: 2,
      entries: [["tests/a.test.ts", 0, 10]], finishedAt: "2026-10-20T00:00:02.000Z",
    });
    assert.throws(() => measure([duplicateOne, duplicateTwo]), /measured more than once/);

    const nonGreen = shardReportFor(work, {
      head, manifestHashValue: hash, shard: 1, shardCount: 1,
      entries: [["tests/a.test.ts", 0, 10]], finishedAt: "2026-10-20T00:00:02.000Z", success: false,
    });
    assert.throws(() => measure([nonGreen]), /success=false/);

    const wrongManifest = shardReportFor(work, {
      head, manifestHashValue: "0".repeat(64), shard: 1, shardCount: 1,
      entries: [["tests/a.test.ts", 0, 10]], finishedAt: "2026-10-20T00:00:02.000Z",
    });
    assert.throws(() => measure([wrongManifest]), /manifest hash/);

    const backwards = shardReportFor(work, {
      head, manifestHashValue: hash, shard: 1, shardCount: 1,
      entries: [["tests/a.test.ts", 10, 5]], finishedAt: "2026-10-20T00:00:02.000Z",
    });
    assert.throws(() => measure([backwards]), /endTime is before startTime/);

    // The measurement's measuredAt is the run's finish, so a report without
    // a timing window cannot supply one. It used to fall back to the
    // invocation clock: an unmeasured run looked as fresh as the machine that
    // read it.
    const timingless = shardReportFor(work, {
      head, manifestHashValue: hash, shard: 1, shardCount: 1,
      entries: [["tests/a.test.ts", 0, 10]], finishedAt: "2026-10-20T00:00:02.000Z", timing: false,
    });
    assert.throws(() => measure([timingless]), /no timing window/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
