import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MANIFEST_SCHEMA,
  SHARD_REPORT_SCHEMA,
  assignShards,
  listTestFiles,
  manifestHash,
  measureManifest,
  planShards,
  readManifest,
  requireGreenReport,
  treeFingerprint,
  verifyManifest,
  wrapShardReport,
} from "../../scripts/test-shard-manifest.mjs";
import { mergeShardReports } from "../../scripts/test-shard-merge.mjs";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("the documented listing commands run bare, as their npm scripts say", () => {
  // The scripts were wired without arguments while the CLI required them, so
  // the documented command could not run at all. Run both as npm runs them.
  const root = process.cwd();
  const listing = join(root, "node_modules", ".cache", "bridlewise", "test-listing.json");
  rmSync(listing, { force: true });
  execFileSync("npm", ["run", "test:list"], { cwd: root, stdio: "pipe" });
  const document = JSON.parse(readFileSync(listing, "utf8"));
  assert.equal(document.schemaVersion, "bridlewise-test-listing/v1");
  assert.ok(document.files.length > 0, "the listing must select the live test population");
  const verdict = execFileSync("npm", ["run", "test:verify-shards"], { cwd: root, encoding: "utf8" });
  assert.match(verdict, /supported, \d+ excluded, \d+ live/u);
});

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

test("the testing page defers its population to the manifest, or agrees with it", () => {
  // docs/testing.md claimed "527 supported files (523 plus four)" while the
  // tracked manifest held 528 and five separately measured weights. A hand
  // count drifts; the page now names the generated `weightSource` and states
  // no count. If a count is reintroduced, it must match the manifest.
  const page = readFileSync(join(process.cwd(), "docs/testing.md"), "utf8");
  assert.match(page, /weightSource/u, "the page must name the manifest's generated population record");
  const stated = /(\d+)\s+supported files/u.exec(page)?.[1];
  if (stated !== undefined) {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "tests/test-shards.json"), "utf8"));
    assert.equal(Number(stated), manifest.files.length, "a stated supported-file count must match the manifest");
  }
  assert.doesNotMatch(page, /\b\d+\s+measured on their own\b/u, "do not hand-maintain the separately measured population");
});

test("the green rule refuses absent, fractional and string test totals and passed counts", () => {
  // `numTotalTests` was read outside the green rule: absence fell back to 0,
  // so a report that declared success and the four judged counts but no total
  // merged as a green run of zero tests; 3.7 was accepted as a test count.
  // `numPassedTests` had a SECOND derivation (total - failed - skipped - todo)
  // when absent. Both are now declared by the same rule as the four judged
  // counts, and a numeric string is a shape the report never emits.
  const base = {
    success: true,
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numPendingTests: 0,
    numTodoTests: 0,
  };
  assert.deepEqual(requireGreenReport(base, "base"), {
    failedTests: 0,
    pendingTests: 0,
    todoTests: 0,
    totalTests: 2,
    passedTests: 2,
  });
  for (const field of ["numTotalTests", "numPassedTests"]) {
    for (const [shape, value] of [["absent", undefined], ["fraction", 1.5], ["string", "2"]]) {
      const report = { ...base };
      if (value === undefined) delete report[field];
      else report[field] = value;
      const subject = `${field} ${shape}`;
      assert.throws(
        () => requireGreenReport(report, subject),
        (error) => {
          assert.match(error.message, new RegExp(field, "u"));
          assert.match(
            error.message,
            value === undefined ? /does not declare/u : /not a declared non-negative integer/u,
          );
          return true;
        },
      );
    }
  }
});

test("the green rule refuses every non-number a truthiness coercion would turn into zero", () => {
  // `declared()` rejected only undefined/null and then called `Number(value)`.
  // `false`, `""`, `"0"` and `[]` therefore all became 0 and merged green: a
  // report could declare `numFailedTestSuites: false` and the merge would
  // record a suite that never said it had no failing suite. The rule now
  // requires `typeof value === "number"` BEFORE the integer check.
  const base = {
    success: true,
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numPendingTests: 0,
    numTodoTests: 0,
  };
  const fields = ["numFailedTests", "numFailedTestSuites", "numPendingTests", "numTodoTests", "numTotalTests", "numPassedTests"];
  const coercions = [["false", false], ["empty string", ""], ["numeric string", "0"], ["empty array", []]];
  for (const field of fields) {
    for (const [shape, value] of coercions) {
      assert.throws(
        () => requireGreenReport({ ...base, [field]: value }, `${field}=${shape}`),
        (error) => {
          assert.match(error.message, new RegExp(field, "u"));
          assert.match(error.message, /is not a declared non-negative integer/u, `${field}=${shape} must name the number requirement`);
          return true;
        },
        `${field}=${shape} must not coerce to 0`,
      );
    }
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
    writeJson(live, {
      schemaVersion: "bridlewise-test-listing/v1",
      tree: "planted-tree",
      files: [
        { file: join(work, "tests/a.test.ts"), projectName: "node" },
        { file: join(work, "tests/b.test.ts"), projectName: "node" },
        { file: join(work, "tests/private.test.ts"), projectName: "node" },
      ],
    });
    // The fingerprint is injected: this fixture is not a git checkout. The
    // verifier still computes the tree itself — a caller cannot replace it.
    // The ENUMERATION is injected too, but it is the VERIFIER's own fresh
    // enumeration: the listing document below is the subject, never evidence.
    const fingerprint = () => "planted-tree";
    const enumerate = (files) => ({
      schemaVersion: "bridlewise-test-listing/v1",
      tree: "planted-tree",
      files: files.map((file) => ({ file: join(work, file), projectName: "node" })),
    });
    const listed = ["tests/a.test.ts", "tests/b.test.ts", "tests/private.test.ts"];
    const verdict = verifyManifest({
      root: work, manifestPath: manifest, livePath: live, tree: "planted-tree", fingerprint,
      list: () => enumerate(listed),
    });
    assert.equal(verdict.fileCount, 2);
    assert.equal(verdict.excludedCount, 1);
    assert.equal(verdict.liveCount, 3);
    assert.equal(verdict.tree, "planted-tree");

    // A LISTING FROM ANOTHER TREE IS REFUSED: the wrapper records the working
    // tree it selected from, and a different tree cannot be certified by it.
    assert.throws(
      () => verifyManifest({
        root: work, manifestPath: manifest, livePath: live, tree: "another-tree", fingerprint,
        list: () => enumerate(listed),
      }),
      /--tree another-tree is not the working tree being verified \(planted-tree\)/u,
    );
    // The same listing with no explicit tree is still verified against the
    // computed tree: `--tree` is a cross-check, not the source of the check.
    assert.equal(
      verifyManifest({ root: work, manifestPath: manifest, livePath: live, fingerprint, list: () => enumerate(listed) }).liveCount,
      3,
    );

    // And the UNBOUND shape — a plain `vitest list` array — is refused:
    // it carries no tree identity, so it could have come from anywhere.
    writeJson(live, [{ file: join(work, "tests/a.test.ts") }, { file: join(work, "tests/b.test.ts") }]);
    assert.throws(
      () => verifyManifest({
        root: work, manifestPath: manifest, livePath: live, tree: "planted-tree", fingerprint,
        list: () => enumerate(listed),
      }),
      /not accepted/,
    );

    writeJson(live, {
      schemaVersion: "bridlewise-test-listing/v1",
      tree: "planted-tree",
      files: [
        { file: join(work, "tests/a.test.ts") },
        { file: join(work, "tests/unclassified.test.ts") },
      ],
    });
    assert.throws(
      () => verifyManifest({
        root: work, manifestPath: manifest, livePath: live, tree: "planted-tree", fingerprint,
        list: () => enumerate(["tests/a.test.ts", "tests/unclassified.test.ts"]),
      }),
      /unclassified file/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a stale listing cannot be verified by supplying the fingerprint it was written under", () => {
  // The defect: `--tree` was the only tree the verifier compared against, so
  // a caller passed the OLD fingerprint (the one the listing recorded) and the
  // listing verified even though the tree had moved since. The verifier now
  // computes the working tree itself; `--tree` must agree with that computed
  // value instead of replacing it. (The tree moves through a non-test file so
  // the injected fresh enumeration stays the same population; the separate
  // arm below covers a listing that omits a real test file.)
  const work = mkdtempSync(join(tmpdir(), "bridlewise-stale-tree-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: work, stdio: "pipe" });
    // The listing lives in a gitignored cache in real use; keep it out of the
    // fingerprint here so rewriting it cannot move the tree it describes.
    writeFileSync(join(work, ".gitignore"), "live.json\n");
    mkdirSync(join(work, "tests"), { recursive: true });
    const manifest = join(work, "manifest.json");
    const live = join(work, "live.json");
    writeJson(manifest, manifestFor(["tests/a.test.ts", "tests/b.test.ts"]));
    writeFileSync(join(work, "tests/a.test.ts"), "");
    writeFileSync(join(work, "tests/b.test.ts"), "");
    const oldTree = treeFingerprint(work);
    writeJson(live, {
      schemaVersion: "bridlewise-test-listing/v1",
      tree: oldTree,
      files: [{ file: join(work, "tests/a.test.ts") }, { file: join(work, "tests/b.test.ts") }],
    });
    // The tree moves after the listing was written.
    writeFileSync(join(work, "README.md"), "moved after the listing\n");
    const currentTree = treeFingerprint(work);
    assert.notEqual(currentTree, oldTree);

    // The verifier's OWN enumeration of the current tree (a, b and the moved
    // tree's c), independent of the stale listing it is judging.
    const enumerateCurrent = () => ({
      schemaVersion: "bridlewise-test-listing/v1",
      tree: currentTree,
      files: [{ file: join(work, "tests/a.test.ts") }, { file: join(work, "tests/b.test.ts") }],
    });
    // The old listing with the old explicit fingerprint: refused by the
    // computed tree, even though the caller's value matches the document.
    assert.throws(
      () => verifyManifest({ root: work, manifestPath: manifest, livePath: live, tree: oldTree, list: enumerateCurrent }),
      /bound to tree [0-9a-f]{64}, not the working tree being verified/u,
    );
    // ...and without the flag, for the same reason.
    assert.throws(
      () => verifyManifest({ root: work, manifestPath: manifest, livePath: live, list: enumerateCurrent }),
      /bound to tree [0-9a-f]{64}, not the working tree being verified/u,
    );
    // A current listing verifies; `--tree` agrees with the computation.
    writeJson(live, {
      schemaVersion: "bridlewise-test-listing/v1",
      tree: currentTree,
      files: [{ file: join(work, "tests/a.test.ts") }, { file: join(work, "tests/b.test.ts") }],
    });
    assert.equal(
      verifyManifest({ root: work, manifestPath: manifest, livePath: live, tree: currentTree, list: enumerateCurrent }).fileCount,
      2,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a forged listing cannot omit a file the fresh enumeration selects", () => {
  // THE SELF-ATTESTED-LISTING DEFECT. Verification used to consume the
  // listing's own `files` array as the live population: the tree fingerprint
  // was recomputed, but nothing re-ran the enumeration, so editing the
  // document (or writing it from a stale selection) could omit a test file
  // that had joined the tree. A file the manifest does not know is invisible
  // to the classification check, and a file it does know is caught only by
  // name — the forged shape below passes every old check.
  //
  // The verifier now runs `listTestFiles` itself and compares SETS. The
  // listing is the subject under judgement, never the evidence.
  const work = mkdtempSync(join(tmpdir(), "bridlewise-forged-listing-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: work, stdio: "pipe" });
    writeFileSync(join(work, ".gitignore"), "live.json\n");
    mkdirSync(join(work, "tests"), { recursive: true });
    const manifest = join(work, "manifest.json");
    const live = join(work, "live.json");
    writeJson(manifest, manifestFor(["tests/a.test.ts", "tests/b.test.ts"]));
    writeFileSync(join(work, "tests/a.test.ts"), "");
    writeFileSync(join(work, "tests/b.test.ts"), "");
    // A real test file joins the tree, and is deliberately absent from the
    // checked-in manifest: that is exactly the population a stale listing
    // hides from the old verification.
    writeFileSync(join(work, "tests/c.test.ts"), "");
    const currentTree = treeFingerprint(work);
    // The forged document carries the CURRENT fingerprint (so the old tree
    // check passes) and a file list that stops at the manifest's two files.
    writeJson(live, {
      schemaVersion: "bridlewise-test-listing/v1",
      tree: currentTree,
      files: [{ file: join(work, "tests/a.test.ts") }, { file: join(work, "tests/b.test.ts") }],
    });
    const freshEnumeration = () => ({
      schemaVersion: "bridlewise-test-listing/v1",
      tree: currentTree,
      files: [
        { file: join(work, "tests/a.test.ts") },
        { file: join(work, "tests/b.test.ts") },
        { file: join(work, "tests/c.test.ts") },
      ],
    });
    // RED BEFORE THE FIX: the forged listing verified because nothing
    // re-derived the population.
    assert.throws(
      () => verifyManifest({ root: work, manifestPath: manifest, livePath: live, list: freshEnumeration }),
      (err) => err.message.includes("OMITS") && err.message.includes("tests/c.test.ts"),
    );
    // The same subject cannot invent a file the enumeration did not select.
    writeJson(live, {
      schemaVersion: "bridlewise-test-listing/v1",
      tree: currentTree,
      files: [
        { file: join(work, "tests/a.test.ts") },
        { file: join(work, "tests/b.test.ts") },
        { file: join(work, "tests/c.test.ts") },
        { file: join(work, "tests/invented.test.ts") },
      ],
    });
    assert.throws(
      () => verifyManifest({ root: work, manifestPath: manifest, livePath: live, list: freshEnumeration }),
      (err) => err.message.includes("names") && err.message.includes("tests/invented.test.ts"),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a listing is bound to the working tree it selected from, and a tree that moves during it is refused", () => {
  // THE GAP THIS CLOSES: `vitest list` does not run the vitest global setup,
  // so the listing process itself takes no source fingerprint (and no lock).
  // The `list` command reads one before and after; a tree that moves is not a
  // state anything can be verified against.
  const work = mkdtempSync(join(tmpdir(), "bridlewise-tree-binding-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: work, stdio: "pipe" });
    mkdirSync(join(work, "tests"), { recursive: true });
    writeFileSync(join(work, "tests/a.test.ts"), "");
    const first = treeFingerprint(work);
    assert.match(first, /^[0-9a-f]{64}$/u);

    // A new file changes the identity: the population is content, not a path
    // list someone can restate.
    writeFileSync(join(work, "tests/b.test.ts"), "");
    const second = treeFingerprint(work);
    assert.notEqual(second, first);

    // A listing over a still tree records that identity.
    const listing = listTestFiles({
      root: work,
      run: () => ({ status: 0, stdout: JSON.stringify([{ file: join(work, "tests/a.test.ts") }]), stderr: "" }),
    });
    assert.equal(listing.tree, second);
    assert.equal(listing.schemaVersion, "bridlewise-test-listing/v1");

    // A listing that writes while it runs is refused, not quietly recorded.
    assert.throws(
      () =>
        listTestFiles({
          root: work,
          run: () => {
            writeFileSync(join(work, "tests/c.test.ts"), "");
            return { status: 0, stdout: JSON.stringify([{ file: join(work, "tests/a.test.ts") }]), stderr: "" };
          },
        }),
      /working tree changed while the listing ran/,
    );

    // A subdirectory is not the tree root: its fingerprint would silently omit
    // every file above it.
    assert.throws(() => treeFingerprint(join(work, "tests")), /not the repository root/);
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
        numPassedTests: shard.files.length,
        numFailedTests: 0,
        numFailedTestSuites: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: shard.files.map((file) => ({
          name: join(work, file),
          status: "passed",
          message: "",
          assertionResults: [{ status: "passed", failureMessages: [] }],
        })),
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
        manifestSourcePath: manifest,
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
      success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numFailedTestSuites: 0,
      numPendingTests: 0, numTodoTests: 0,
      testResults: [{
        name: join(work, "tests/a.test.ts"),
        status: "passed",
        message: "",
        assertionResults: [{ status: "passed", failureMessages: [] }],
      }],
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
          root: work, manifestPath: join(planDir, "manifest.json"),
          manifestSourcePath: manifest, planPath: join(planDir, "plan.json"),
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
