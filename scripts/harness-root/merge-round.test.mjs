// merge-round.test.mjs — Unit tests for the top-level integration merge (v4, EXP471).
//
// Tests the mechanical merge in isolation: exp-number parsing, sort order,
// conflict resolution (owner-aware + highest exp number wins), staging-then-
// promote, the "e2e fails -> don't merge" guarantee, the "missing issues ->
// REJECT" guarantee (Fix 3), owner-aware skipping (Fix 1), and the concurrent
// lock (Fix 4). Uses tmp dirs for isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync, writeFileSync, rmSync, existsSync, readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { expNumber, sortByExpNumber, findManifests, mergeRound, acquireMergeLock } from "./merge-round.mjs";
import { FILE_LOCK_SCHEMA_VERSION } from "../../engine/src/filesystem/file-lock.ts";
import { loadModuleOwners, ownerForPath, isExcludedPath, EXCLUDE_OWNER } from "../../engine/src/shared/workflow/module-owners.mjs";
import { collectTestFiles, runE2e, supportsStripTypes } from "../../engine/src/shared/workflow/e2e-runner.mjs";

function setupTmpWorkspace() {
  const root = join(tmpdir(), `merge-round-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const experimentsRoot = join(root, "experiments");
  const integrationDir = join(root, "integration");
  mkdirSync(experimentsRoot, { recursive: true });
  mkdirSync(integrationDir, { recursive: true });
  return { root, experimentsRoot, integrationDir };
}

function writeManifest(dir, obj) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "merge-manifest.json"), JSON.stringify(obj, null, 2));
}

function writeFile(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(resolve(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

// Write an issues-and-inefficiencies.md so the experiment is not rejected.
function writeIssues(dir) {
  writeFileSync(join(dir, "issues-and-inefficiencies.md"), "# Issues\nnone found.\n");
}

const SCHEMA = "exp417-merge-manifest/v1";

function manifest(expName, files, { improves = null, dependencies = [], breaking = false, description = "test" } = {}) {
  return {
    schema: SCHEMA, experiment: expName, description, improves,
    authorCommit: null, files, tests: [], config: [],
    dependencies, breaking,
  };
}

// Write a minimal module-owners.json in an integration dir.
function writeOwners(integrationDir, owners, excludePaths = []) {
  const p = join(integrationDir, "src/shared/workflow/module-owners.json");
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify({
    schema: "exp471-module-owners/v1",
    description: "test owners",
    excludePaths,
    owners,
  }));
}

test("an unconfigured experiments root is REFUSED, not reported as an empty round", async () => {
  // THE DEFECT, DRIVEN. The script defaulted its experiments root to
  // `<workspace>/experiments`, a directory that no longer exists, and answered
  // with `fileCount: 0`, `passed: false` and a WARNING — a round that never
  // happened, described in the same field a rejected round uses. The
  // configuration is required now, and its absence names what to supply.
  await assert.rejects(
    () => mergeRound({ runE2e: false }),
    (e) => {
      assert.equal(e.name, "MergeRoundInputError");
      assert.equal(e.code, "merge_round_experiments_root_required");
      assert.match(e.message, /--experiments-root <path>/u);
      return true;
    },
  );
  // An empty string is the same absence wearing a value's shape.
  await assert.rejects(
    () => mergeRound({ experimentsRoot: "   ", runE2e: false }),
    (e) => e.code === "merge_round_experiments_root_required",
  );
});

test("an experiments root holding no manifest REJECTS the round, and says which kind of nothing", async () => {
  const { experimentsRoot, integrationDir } = setupTmpWorkspace();

  // Exists, and empty: the round is rejected rather than warned about, and
  // `rejected` is what separates "this never happened" from "it happened and
  // the e2e suite failed" — both of which used to be `passed: false` alone.
  const empty = await mergeRound({ experimentsRoot, integrationDir, runE2e: false });
  assert.equal(empty.rejected, true);
  assert.equal(empty.passed, false);
  assert.match(empty.rejectReason, /exists but holds no experiment directory/u);

  // Does not exist: same refusal, different reason, because "the path is
  // wrong" and "the path is right and empty" want different repairs.
  const missing = await mergeRound({
    experimentsRoot: join(experimentsRoot, "no-such-directory"),
    integrationDir,
    runE2e: false,
  });
  assert.equal(missing.rejected, true);
  assert.match(missing.rejectReason, /DOES NOT EXIST/u);

  // …and the control: a root that DOES hold a manifest is not rejected, so
  // the two refusals above are about emptiness and not about a rule that
  // rejects everything.
  const dir = join(experimentsRoot, "exp100-a");
  writeManifest(dir, manifest("exp100-a", [{ path: "src/a.ts", source: "src/a.ts", action: "new" }]));
  writeFile(dir, "src/a.ts", "export const a = 1;\n");
  writeIssues(dir);
  const real = await mergeRound({ experimentsRoot, integrationDir, runE2e: false });
  assert.equal(real.rejected, false);
  assert.equal(real.fileCount, 1);
});

test("expNumber parses the leading number from exp dir names", () => {
  assert.equal(expNumber("exp455-benchmark-novel"), 455);
  assert.equal(expNumber("exp1-foo"), 1);
  assert.equal(expNumber("EXP470-bar"), 470);
  assert.equal(expNumber("adaptation"), 0);
  assert.equal(expNumber("exp"), 0);
  assert.equal(expNumber("candidate"), 0);
});

test("sortByExpNumber sorts ascending so the highest number is last (wins conflicts)", () => {
  const names = ["exp470-bar", "exp455-foo", "adaptation", "exp455-zzz", "exp1-x"];
  const sorted = sortByExpNumber(names);
  assert.deepEqual(sorted, ["adaptation", "exp1-x", "exp455-foo", "exp455-zzz", "exp470-bar"]);
});

test("findManifests only returns dirs that have a merge-manifest.json", () => {
  const { root, experimentsRoot } = setupTmpWorkspace();
  mkdirSync(join(experimentsRoot, "exp100-has"), { recursive: true });
  writeFileSync(join(experimentsRoot, "exp100-has", "merge-manifest.json"), "{}");
  mkdirSync(join(experimentsRoot, "exp200-no"), { recursive: true });
  const map = findManifests(experimentsRoot);
  assert.ok(map.has("exp100-has"));
  assert.ok(!map.has("exp200-no"));
  rmSync(root, { recursive: true, force: true });
});

test("merge: new files are copied into integration in exp-number order", async () => {
  const { root, experimentsRoot, integrationDir } = setupTmpWorkspace();
  const e100 = join(experimentsRoot, "exp100-a");
  const e200 = join(experimentsRoot, "exp200-b");
  writeFile(e100, "src/a.ts", "export const a = 1;");
  writeFile(e200, "src/b.ts", "export const b = 2;");
  writeIssues(e100); writeIssues(e200);
  writeManifest(e100, manifest("exp100-a", [{ path: "src/a.ts", action: "new", source: "src/a.ts", description: "a" }]));
  writeManifest(e200, manifest("exp200-b", [{ path: "src/b.ts", action: "new", source: "src/b.ts", description: "b" }]));
  const report = await mergeRound({ experimentsRoot, integrationDir, runE2e: false, requireIssues: false });
  assert.equal(report.order.join(","), "exp100-a,exp200-b");
  assert.equal(report.fileCount, 2);
  assert.equal(report.conflicts.length, 0);
  assert.ok(existsSync(join(integrationDir, ".staging", "src", "a.ts")));
  assert.ok(existsSync(join(integrationDir, ".staging", "src", "b.ts")));
  rmSync(root, { recursive: true, force: true });
});

test("conflict (ownerless): highest experiment number wins", async () => {
  const { root, experimentsRoot, integrationDir } = setupTmpWorkspace();
  const e100 = join(experimentsRoot, "exp100-low");
  const e300 = join(experimentsRoot, "exp300-high");
  writeFile(e100, "src/shared.ts", "export const v = 100;");
  writeFile(e300, "src/shared.ts", "export const v = 300;");
  writeIssues(e100); writeIssues(e300);
  writeManifest(e100, manifest("exp100-low", [{ path: "src/shared.ts", action: "new", source: "src/shared.ts", description: "v100" }]));
  writeManifest(e300, manifest("exp300-high", [{ path: "src/shared.ts", action: "replace", source: "src/shared.ts", description: "v300" }]));
  const report = await mergeRound({ experimentsRoot, integrationDir, runE2e: false, requireIssues: false });
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].priorWriter, "exp100-low");
  assert.equal(report.conflicts[0].newWriter, "exp300-high");
  assert.equal(report.conflicts[0].resolved, "highest-exp-number-wins");
  const merged = readFileSync(join(integrationDir, ".staging", "src", "shared.ts"), "utf8");
  assert.match(merged, /v = 300/);
  rmSync(root, { recursive: true, force: true });
});

test("Fix 1: owner-aware — non-owner write under owned prefix is skipped", async () => {
  const { root, experimentsRoot, integrationDir } = setupTmpWorkspace();
  // exp457 owns src/shared/llm/. exp100 (non-owner) declares a file there.
  writeOwners(integrationDir, [
    { path: "src/shared/llm/", owner: "exp457-owner", kind: "prefix" },
  ]);
  // Seed baseline so the owner's version exists.
  writeFile(integrationDir, "src/shared/llm/client.ts", "export const owner = 457;");
  const owner = join(experimentsRoot, "exp457-owner");
  const other = join(experimentsRoot, "exp100-other");
  writeFile(owner, "src/shared/llm/client.ts", "export const owner = 457; // updated");
  writeFile(other, "src/shared/llm/client.ts", "export const stale = 100;"); // baseline carry
  writeIssues(owner); writeIssues(other);
  writeManifest(owner, manifest("exp457-owner", [{ path: "src/shared/llm/client.ts", action: "replace", source: "src/shared/llm/client.ts", description: "owner update" }]));
  writeManifest(other, manifest("exp100-other", [{ path: "src/shared/llm/client.ts", action: "new", source: "src/shared/llm/client.ts", description: "baseline carry" }]));
  const report = await mergeRound({ experimentsRoot, integrationDir, runE2e: false, requireIssues: false });
  // The non-owner is skipped (baseline-carry guard).
  assert.ok(report.skipped.some((s) => s.experiment === "exp100-other" && s.reason === "non-owner"));
  // The owner's version is in staging.
  const merged = readFileSync(join(integrationDir, ".staging", "src", "shared", "llm", "client.ts"), "utf8");
  assert.match(merged, /updated/);
  rmSync(root, { recursive: true, force: true });
});

test("Fix 1: excluded paths are skipped", async () => {
  const { root, experimentsRoot, integrationDir } = setupTmpWorkspace();
  writeOwners(integrationDir, [], ["scripts/exp460/local_modules/"]);
  const e100 = join(experimentsRoot, "exp100-x");
  writeFile(e100, "scripts/exp460/local_modules/wasm.js", "module.exports = 1;");
  writeIssues(e100);
  writeManifest(e100, manifest("exp100-x", [{ path: "scripts/exp460/local_modules/wasm.js", action: "new", source: "scripts/exp460/local_modules/wasm.js", description: "vendored" }]));
  const report = await mergeRound({ experimentsRoot, integrationDir, runE2e: false, requireIssues: false });
  assert.ok(report.skipped.some((s) => s.reason === "excluded-path"));
  assert.equal(report.fileCount, 0);
  rmSync(root, { recursive: true, force: true });
});

test("Fix 3: missing issues-and-inefficiencies.md REJECTS the merge", async () => {
  const { root, experimentsRoot, integrationDir } = setupTmpWorkspace();
  const e100 = join(experimentsRoot, "exp100-noissues");
  writeFile(e100, "src/x.ts", "export const x = 1;");
  writeManifest(e100, manifest("exp100-noissues", [{ path: "src/x.ts", action: "new", source: "src/x.ts", description: "x" }]));
  // No issues-and-inefficiencies.md written.
  const report = await mergeRound({ experimentsRoot, integrationDir, runE2e: false, requireIssues: true });
  assert.equal(report.rejected, true);
  assert.equal(report.passed, false);
  assert.equal(report.promoted, false);
  assert.ok(report.missingIssuesReport.includes("exp100-noissues"));
  assert.match(report.rejectReason, /exp100-noissues/);
  rmSync(root, { recursive: true, force: true });
});

test("Fix 3: --no-require-issues allows the merge (warns instead)", async () => {
  const { root, experimentsRoot, integrationDir } = setupTmpWorkspace();
  const e100 = join(experimentsRoot, "exp100-noissues");
  writeFile(e100, "src/x.ts", "export const x = 1;");
  writeManifest(e100, manifest("exp100-noissues", [{ path: "src/x.ts", action: "new", source: "src/x.ts", description: "x" }]));
  const report = await mergeRound({ experimentsRoot, integrationDir, runE2e: false, requireIssues: false });
  assert.equal(report.rejected, false);
  assert.ok(report.missingIssuesReport.includes("exp100-noissues"));
  rmSync(root, { recursive: true, force: true });
});

test("e2e failure does NOT promote: integration/ is left untouched", async () => {
  const { root, experimentsRoot, integrationDir } = setupTmpWorkspace();
  writeFile(integrationDir, "src/baseline.ts", "export const baseline = true;");
  const e100 = join(experimentsRoot, "exp100-fail");
  writeFile(e100, "src/baseline.ts", "export const baseline = false;");
  writeFile(e100, "test/fail.test.mjs", `import { test } from "node:test"; import assert from "node:assert/strict"; test("boom", () => { assert.fail("intentional failure"); });`);
  writeIssues(e100);
  writeManifest(e100, manifest("exp100-fail", [
    { path: "src/baseline.ts", action: "replace", source: "src/baseline.ts", description: "bad" },
    { path: "test/fail.test.mjs", action: "new", source: "test/fail.test.mjs", description: "failing test" },
  ]));
  const report = await mergeRound({ experimentsRoot, integrationDir, runE2e: true, e2eTimeoutMs: 30_000, requireIssues: false });
  assert.equal(report.e2e.passed, false);
  assert.equal(report.promoted, false);
  assert.equal(report.passed, false);
  const baseline = readFileSync(join(integrationDir, "src", "baseline.ts"), "utf8");
  assert.match(baseline, /baseline = true/);
  assert.ok(!existsSync(join(integrationDir, ".staging")));
  rmSync(root, { recursive: true, force: true });
});

test("e2e success promotes staging to integration (new baseline)", async () => {
  const { root, experimentsRoot, integrationDir } = setupTmpWorkspace();
  const e100 = join(experimentsRoot, "exp100-ok");
  writeFile(e100, "src/ok.ts", "export const ok = 1;");
  writeFile(e100, "test/ok.test.mjs", `import { test } from "node:test"; import assert from "node:assert/strict"; test("ok", () => { assert.equal(1, 1); });`);
  writeIssues(e100);
  writeManifest(e100, manifest("exp100-ok", [
    { path: "src/ok.ts", action: "new", source: "src/ok.ts", description: "ok" },
    { path: "test/ok.test.mjs", action: "new", source: "test/ok.test.mjs", description: "ok test" },
  ]));
  const report = await mergeRound({ experimentsRoot, integrationDir, runE2e: true, e2eTimeoutMs: 30_000, requireIssues: false });
  assert.equal(report.e2e.passed, true);
  assert.equal(report.promoted, true);
  assert.equal(report.passed, true);
  assert.ok(existsSync(join(integrationDir, "src", "ok.ts")));
  assert.ok(existsSync(join(integrationDir, "test", "ok.test.mjs")));
  assert.ok(!existsSync(join(integrationDir, ".staging")));
  rmSync(root, { recursive: true, force: true });
});

test("Fix 4: concurrent lock serializes merges (second acquirer waits/fails)", async () => {
  const { root } = setupTmpWorkspace();
  const lockPath = join(root, ".merge.lock");
  const release = await acquireMergeLock({ lockPath, lockTimeoutMs: 1000, owner: "first" });
  assert.ok(existsSync(lockPath));
  // A second acquire on the same lock must fail (we hold a live PID).
  await assert.rejects(
    acquireMergeLock({ lockPath, lockTimeoutMs: 300, owner: "second" }),
    /merge lock busy/,
  );
  release();
  assert.ok(!existsSync(lockPath));
  // After release, a new acquire succeeds.
  const release2 = await acquireMergeLock({ lockPath, lockTimeoutMs: 1000, owner: "third" });
  release2();
  rmSync(root, { recursive: true, force: true });
});

test("Fix 4: stale lock (dead PID) is stolen", async () => {
  const { root } = setupTmpWorkspace();
  const lockPath = join(root, ".merge.lock");
  // A lock record as the one file lock writes it, held by a PID that is certainly dead (99999999).
  writeFileSync(lockPath, JSON.stringify({ schemaVersion: FILE_LOCK_SCHEMA_VERSION, pid: 99999999, startTime: 1, acquiredAt: new Date().toISOString(), nonce: "planted-dead", holder: "dead" }));
  const release = await acquireMergeLock({ lockPath, lockTimeoutMs: 1000, owner: "new" });
  assert.ok(existsSync(lockPath));
  release();
  rmSync(root, { recursive: true, force: true });
});

// --- module-owners resolver tests ---

test("module-owners: loadModuleOwners returns null for missing/invalid file", () => {
  const { root, integrationDir } = setupTmpWorkspace();
  assert.equal(loadModuleOwners(join(root, "nope.json")), null);
  writeFileSync(join(root, "bad.json"), "{}");
  assert.equal(loadModuleOwners(join(root, "bad.json")), null); // wrong schema
  rmSync(root, { recursive: true, force: true });
});

test("module-owners: ownerForPath resolves exact > prefix (longest wins)", () => {
  const cfg = {
    excludePaths: ["scripts/exp460/local_modules/"],
    owners: [
      { path: "src/shared/llm/exposure.ts", owner: "exp433", kind: "exact" },
      { path: "src/shared/llm/", owner: "exp457", kind: "prefix" },
      { path: "src/shared/", owner: "exp436", kind: "prefix" },
    ],
  };
  assert.equal(ownerForPath("src/shared/llm/exposure.ts", cfg), "exp433"); // exact
  assert.equal(ownerForPath("src/shared/llm/client.ts", cfg), "exp457"); // llm prefix
  assert.equal(ownerForPath("src/shared/memory/store.ts", cfg), "exp436"); // shared prefix
  assert.equal(ownerForPath("src/editor/edit.ts", cfg), null); // no owner
  assert.equal(ownerForPath("scripts/exp460/local_modules/x.js", cfg), EXCLUDE_OWNER); // excluded
  assert.ok(isExcludedPath("scripts/exp460/local_modules/x.js", cfg));
});

// --- e2e-runner TS test collection tests ---

test("Fix 2: collectTestFiles includes .test.ts (and .mjs/.js)", () => {
  const { root, integrationDir } = setupTmpWorkspace();
  writeFile(integrationDir, "test/a.test.mjs", `import {test} from "node:test"; test("a",()=>{})`);
  writeFile(integrationDir, "test/b.test.ts", `import {test} from "node:test"; test("b",()=>{})`);
  writeFile(integrationDir, "test/c.test.js", `import {test} from "node:test"; test("c",()=>{})`);
  writeFile(integrationDir, "test/d.test.mts", `import {test} from "node:test"; test("d",()=>{})`);
  writeFile(integrationDir, "src/not-a-test.ts", "export const x=1;");
  const files = collectTestFiles(integrationDir);
  assert.equal(files.length, 4);
  assert.ok(files.some((f) => f.endsWith("a.test.mjs")));
  assert.ok(files.some((f) => f.endsWith("b.test.ts")));
  assert.ok(files.some((f) => f.endsWith("c.test.js")));
  assert.ok(files.some((f) => f.endsWith("d.test.mts")));
  rmSync(root, { recursive: true, force: true });
});

test("Fix 2: supportsStripTypes is true on Node >=22.6", () => {
  // This environment is Node v24 — strip-types must be supported.
  assert.equal(supportsStripTypes(), true);
});

test("runE2e never runs an unbounded suite: a missing or invalid timeoutMs is a failed gate, said so", async () => {
  // The bound's one owner is workflow-config.ts (DEFAULT_E2E_SUITE_TIMEOUT_MS,
  // passed by mergeRound); the runner holds no default of its own.
  const { root, integrationDir } = setupTmpWorkspace();
  writeFile(integrationDir, "test/a.test.mjs", `import {test} from "node:test"; test("a",()=>{})`);
  for (const timeoutMs of [undefined, 0, -1, 1.5, "600000"]) {
    const report = await runE2e({ integrationDir, timeoutMs });
    assert.equal(report.passed, false);
    assert.equal(report.testCount, 0, "nothing ran");
    assert.match(report.summary, /no suite bound/);
  }
  rmSync(root, { recursive: true, force: true });
});

test("runE2e starts no process of its own: without the caller's test-execution door it is a failed gate, said so", async () => {
  const { root, integrationDir } = setupTmpWorkspace();
  writeFile(integrationDir, "test/a.test.mjs", `import {test} from "node:test"; test("a",()=>{})`);
  const report = await runE2e({ integrationDir, timeoutMs: 60_000 });
  assert.equal(report.passed, false);
  assert.equal(report.testCount, 0, "nothing ran");
  assert.match(report.summary, /no test-execution door/);
  rmSync(root, { recursive: true, force: true });
});

test("onlyExperiments restricts the merge to the named subset", async () => {
  const { root, experimentsRoot, integrationDir } = setupTmpWorkspace();
  for (const n of ["exp100-a", "exp200-b", "exp300-c"]) {
    const d = join(experimentsRoot, n);
    writeFile(d, `src/${n}.ts`, `export const ${n} = 1;`);
    writeIssues(d);
    writeManifest(d, manifest(n, [{ path: `src/${n}.ts`, action: "new", source: `src/${n}.ts`, description: n }]));
  }
  const report = await mergeRound({
    experimentsRoot, integrationDir, onlyExperiments: ["exp100-a", "exp300-c"], runE2e: false, requireIssues: false,
  });
  assert.deepEqual(report.order, ["exp100-a", "exp300-c"]);
  assert.equal(report.fileCount, 2);
  rmSync(root, { recursive: true, force: true });
});

test("invalid manifest (wrong schema) is rejected with a warning and not merged", async () => {
  const { root, experimentsRoot, integrationDir } = setupTmpWorkspace();
  const e100 = join(experimentsRoot, "exp100-bad");
  writeFile(e100, "src/bad.ts", "export const bad = 1;");
  writeIssues(e100);
  writeManifest(e100, {
    schema: "wrong-schema/v9", experiment: "exp100-bad", description: "bad",
    improves: null, authorCommit: null, files: [
      { path: "src/bad.ts", action: "new", source: "src/bad.ts", description: "bad" },
    ], tests: [], config: [], dependencies: [], breaking: false,
  });
  const report = await mergeRound({ experimentsRoot, integrationDir, runE2e: false, requireIssues: false });
  assert.ok(report.warnings.some((w) => w.includes("schema: expected")));
  const skipped = report.experiments.find((e) => e.experiment === "exp100-bad");
  assert.ok(skipped, "bad-schema experiment should be recorded as skipped");
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.files.length, 0);
  rmSync(root, { recursive: true, force: true });
});
