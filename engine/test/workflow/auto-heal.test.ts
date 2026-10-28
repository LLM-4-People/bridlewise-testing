import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  AUTO_HEAL_FINGERPRINT_PATH,
  AUTO_HEAL_FINGERPRINT_SCHEMA_VERSION,
  autoAddMissingDispositionEntries,
  cleanupFoundationCascadeResidue,
  readAutoHealFingerprintCache,
} from "../../scripts/tooling/run-tests.ts";
import {
  createTestSurfaceDispositionManifest,
  parseTestSurfaceDispositionManifestText,
  recognizableTestSourceLanguage,
  type TestSurfaceDispositionEntry,
} from "../../scripts/verification/test-surface.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { createRepositoryLocalTemporaryDirectory, createRepositoryWorkingCopy, engineGeneratorPopulation, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { superviseCommand } from "../../src/process/supervised-run.ts";
import { supervisedCommandOutcome } from "../../src/shared/run-history.ts";
import { testProcessSupervisorBinary } from "../../guardian/build.ts";
import { checkRequiredFixtureRoots } from "../../scripts/verification/required-fixture-roots.ts";

const MANIFEST_REL_PATH = ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath;

function makeEntry(path: string): TestSurfaceDispositionEntry {
  return {
    path,
    language: "javascript-typescript",
    disposition: "canonical-node-test",
    rationale: "Fixture entry for the auto-heal regression test.",
    // Evidence makes it an exception the manifest records: a qualified source without one is canonical by default and has no entry.
    evidenceLinks: ["test/README.md"],
    blocksFullRepositoryClaim: false,
  };
}

function writeManifest(root: string, entries: readonly TestSurfaceDispositionEntry[]): void {
  const manifest = createTestSurfaceDispositionManifest(entries);
  const manifestPath = join(root, MANIFEST_REL_PATH);
  mkdirSync(join(root, "traceability"), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

function readManifestEntries(root: string): readonly TestSurfaceDispositionEntry[] {
  const manifestPath = join(root, MANIFEST_REL_PATH);
  const text = readFileSync(manifestPath, "utf8");
  return parseTestSurfaceDispositionManifestText(text).entries;
}

test("auto-heal: actual maintenance CLI preserves a no-op success without a test worker and a real refusal", async () => {
  const copy = createRepositoryWorkingCopy("auto-heal-cli-", { include: engineGeneratorPopulation });
  try {
    const manifestPath = join(copy.engineRoot, MANIFEST_REL_PATH);
    const manifestBefore = readFileSync(manifestPath, "utf8");
    const untracked = join(copy.engineRoot, "test", "workflow", "maintenance-untracked-fixture.test.ts");
    // A real maintenance refusal first, then exactly the covered copied tree.
    // Those two commands need no worker; the final suite refusal still does.
    for (const operation of ["refusal", "maintenance", "suite"] as const) {
      const refuse = operation === "refusal";
      if (refuse) writeFileSync(untracked, 'import test from "node:test"; test("fixture", () => {});\n');
      else if (operation === "maintenance") rmSync(untracked);
      if (operation === "suite") {
        // The owned-file copy intentionally excludes external, ignored full
        // suite corpora. Prove that precondition before launching this real
        // pre-worker refusal; never launch a full suite inside its owner test.
        assert.equal(checkRequiredFixtureRoots(copy.engineRoot).ok, false);
      }
      const stdout: string[] = [];
      const stderr: string[] = [];
      const environment = { ...process.env };
      delete environment.HARNESS_MUTATION_RUN;
      delete environment.HARNESS_RUN_INVOCATION;
      const command = await superviseCommand({
        supervisor: testProcessSupervisorBinary(), command: process.execPath,
        args: ["scripts/tooling/run-tests.ts", ...(operation === "suite" ? [] : ["--auto-add-dispositions"])],
        cwd: copy.engineRoot, env: environment, hardCeilingMs: 60_000, killGraceMs: 500,
        onStdout: (chunk) => { stdout.push(chunk.toString()); },
        onStderr: (chunk) => { stderr.push(chunk.toString()); },
      });
      const output = stdout.join("") + stderr.join("");
      assert.equal(supervisedCommandOutcome(command, "actual maintenance CLI").kind, "pass", output);
      assert.equal(readFileSync(manifestPath, "utf8"), manifestBefore, "refusal and no-op preserve disposition bytes");
      if (refuse) {
        assert.equal(command.exitCode, 1, output);
        assert.match(output, /test_surface_source_untracked/u);
      } else if (operation === "maintenance") {
        assert.deepEqual(JSON.parse(stdout.join("")), {
          status: "current", addedCount: 0, addedPaths: [], prunedCount: 0, prunedPaths: [],
        }, "actual maintenance result is complete without a test execution");
        assert.equal(command.exitCode, 0, `successful maintenance must retain exit 0:\n${output}`);
      } else {
        assert.equal(command.exitCode, 1, output);
        assert.match(output, /required_fixture_root_absent/u);
        assert.match(output, /engine test command has no terminal proof/u,
          "suite intent still requires proof when no worker executed");
      }
    }
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("auto-heal: a new qualified Node test file needs no entry — the manifest is left as it was (#221)", async () => {
  const root = createRepositoryLocalTemporaryDirectory("auto-heal-disposition-");
  try {
    const existing = "test/workflow/existing-fixture.test.ts";
    mkdirSync(join(root, "test", "workflow"), { recursive: true });
    writeFileSync(join(root, existing), `import test from "node:test"; test("pass", () => {});\n`);
    writeManifest(root, [makeEntry(existing)]);
    const before = readFileSync(join(root, MANIFEST_REL_PATH), "utf8");

    // A new recognizable test file under a qualified pattern: canonical by default.
    const newFile = "test/workflow/new-fixture.test.ts";
    writeFileSync(join(root, newFile), `import test from "node:test"; test("pass", () => {});\n`);
    assert.equal(recognizableTestSourceLanguage(newFile), "javascript-typescript");

    const { addedPaths } = await autoAddMissingDispositionEntries(root);
    assert.deepEqual([...addedPaths], [], "nothing to add: adding a test rewrites no committed aggregate");
    assert.equal(readFileSync(join(root, MANIFEST_REL_PATH), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-heal: autoAddMissingDispositionEntries is a no-op when the manifest already covers every recognizable file", async () => {
  const root = createRepositoryLocalTemporaryDirectory("auto-heal-noop-");
  try {
    const file = "test/workflow/covered-fixture.test.ts";
    mkdirSync(join(root, "test", "workflow"), { recursive: true });
    writeFileSync(join(root, file), `import test from "node:test"; test("pass", () => {});\n`);
    writeManifest(root, [makeEntry(file)]);

    const before = readManifestEntries(root).map((e) => e.path);
    const { addedPaths } = await autoAddMissingDispositionEntries(root);
    const after = readManifestEntries(root).map((e) => e.path);
    assert.deepEqual(addedPaths, [], "no-op run returns zero added paths");
    assert.deepEqual(after, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-heal: autoAddMissingDispositionEntries is idempotent across repeated runs", async () => {
  const root = createRepositoryLocalTemporaryDirectory("auto-heal-idempotent-");
  try {
    // Outside the qualified patterns: an exception the auto-heal records (pending).
    const file = "scripts/idempotent-fixture.test.ts";
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, file), `import test from "node:test"; test("pass", () => {});\n`);
    writeManifest(root, []);

    await autoAddMissingDispositionEntries(root);
    const firstRun = readManifestEntries(root);
    assert.equal(firstRun.length, 1);
    assert.equal(firstRun[0]!.path, file);

    // Second run must not duplicate the entry.
    await autoAddMissingDispositionEntries(root);
    const secondRun = readManifestEntries(root);
    assert.equal(secondRun.length, 1);
    assert.equal(secondRun[0]!.path, file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-heal: autoAddMissingDispositionEntries registers python sources as pending-external-qualification", async () => {
  const root = createRepositoryLocalTemporaryDirectory("auto-heal-python-");
  try {
    mkdirSync(join(root, "test", "workflow"), { recursive: true });
    writeManifest(root, []);

    const pythonFile = "test/workflow/test_fixture.py";
    writeFileSync(join(root, pythonFile), "def test_pass():\n    pass\n");
    assert.equal(recognizableTestSourceLanguage(pythonFile), "python");

    await autoAddMissingDispositionEntries(root);

    const entries = readManifestEntries(root);
    assert.equal(entries.length, 1);
    const added = entries[0]!;
    assert.equal(added.path, pythonFile);
    assert.equal(added.language, "python");
    assert.equal(added.disposition, "pending-external-qualification");
    assert.equal(added.blocksFullRepositoryClaim, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-heal: autoAddMissingDispositionEntries registers recognizable test files under scripts/ as pending-external-qualification", async () => {
  const root = createRepositoryLocalTemporaryDirectory("auto-heal-scripts-");
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeManifest(root, []);

    const scriptTest = "scripts/sample-fixture.test.ts";
    writeFileSync(join(root, scriptTest), `import test from "node:test"; test("pass", () => {});\n`);
    assert.equal(recognizableTestSourceLanguage(scriptTest), "javascript-typescript");

    await autoAddMissingDispositionEntries(root);

    const entries = readManifestEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.path, scriptTest);
    assert.equal(entries[0]!.language, "javascript-typescript");
    assert.equal(entries[0]!.disposition, "pending-external-qualification");
    assert.equal(entries[0]!.blocksFullRepositoryClaim, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-heal: cleanupFoundationCascadeResidue removes UUID-based residue files from test/support", () => {
  const root = createTempDir("auto-heal-cleanup-");
  try {
    const supportDir = join(root, "test", "support");
    mkdirSync(supportDir, { recursive: true });
    const residueTestFile = "foundation-cascade-scenario-12345678-1234-1234-1234-123456789abc.test.ts";
    const residueHiddenFile = ".foundation-cascade-scenario-12345678-1234-1234-1234-123456789abc.ts";
    const keepFile = "real-helper.ts";
    writeFileSync(join(supportDir, residueTestFile), "// residue\n");
    writeFileSync(join(supportDir, residueHiddenFile), "// residue\n");
    writeFileSync(join(supportDir, keepFile), "// keep\n");

    cleanupFoundationCascadeResidue(root);

    assert.equal(existsSync(join(supportDir, residueTestFile)), false, "UUID-based residue .test.ts removed");
    assert.equal(existsSync(join(supportDir, residueHiddenFile)), false, "UUID-based hidden residue file removed");
    assert.equal(existsSync(join(supportDir, keepFile)), true, "non-residue file preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-heal: cleanupFoundationCascadeResidue does not remove non-UUID test files", () => {
  const root = createTempDir("auto-heal-cleanup-keep-");
  try {
    const supportDir = join(root, "test", "support");
    mkdirSync(supportDir, { recursive: true });
    const normalTest = "helper.test.ts";
    const normalDir = "fixtures";
    writeFileSync(join(supportDir, normalTest), "// keep\n");
    mkdirSync(join(supportDir, normalDir));

    cleanupFoundationCascadeResidue(root);

    assert.equal(existsSync(join(supportDir, normalTest)), true, "normal .test.ts preserved");
    assert.equal(existsSync(join(supportDir, normalDir)), true, "normal dir preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-heal: cleanupFoundationCascadeResidue is a no-op when test/support is absent", () => {
  const root = createTempDir("auto-heal-cleanup-empty-");
  try {
    // No test/support dir at all — must not throw.
    cleanupFoundationCascadeResidue(root);
    assert.equal(existsSync(join(root, "test", "support")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Contract pin: `autoAddMissingDispositionEntries` (the test-surface auto-heal
 * in `scripts/run-tests.ts`) must source the recognizable test-surface file
 * set from the SINGLE owner `listRecognizableTestPaths` exported by
 * `scripts/test-inventory.ts`. The previous implementation computed its own
 * surface with a different walk (hardcoded `test/`, `verification/`,
 * `scripts/` dirs + `readdirSync`) than the inventory builder, so the two
 * drifted: the auto-add missed files outside its hardcoded dirs and could
 * not prune stale entries, blocking `npm test` on "coverage incomplete".
 * Pinning the import contract prevents that drift class from recurring —
 * the auto-add and the coverage check agree by construction because they
 * share the one owner.
 */
test("auto-heal: autoAddMissingDispositionEntries imports listRecognizableTestPaths from the single owner (scripts/test-inventory.ts)", () => {
  const runTestsPath = join(process.cwd(), "scripts", "tooling", "run-tests.ts");
  const runTestsSource = readFileSync(runTestsPath, "utf8");
  // The auto-add must import `listRecognizableTestPaths` from the
  // test-inventory owner (a static or dynamic import that binds the name). The
  // specifier is RELATIVE to run-tests.ts wherever run-tests.ts lives — it moved
  // under engine/scripts/tooling/, so the owner one directory up is reached as
  // `../test-inventory.ts`. Match the owner by basename at any relative depth so
  // a future move does not stale the assertion.
  assert.ok(
    /import\s*\{[^}]*\blistRecognizableTestPaths\b[^}]*\}\s*from\s*["']\.{1,2}\/(?:[^"']*\/)?test-inventory\.ts["']/.test(runTestsSource) ||
      /\blistRecognizableTestPaths\b\s*\}\s*=\s*await\s+import\s*\(\s*["']\.{1,2}\/(?:[^"']*\/)?test-inventory\.ts["']\s*\)/.test(runTestsSource),
    "autoAddMissingDispositionEntries must import listRecognizableTestPaths from the test-inventory.ts owner (any relative depth — the file moves)",
  );
  // The owner must actually export it.
  const inventoryPath = join(process.cwd(), "scripts", "test-inventory.ts");
  const inventorySource = readFileSync(inventoryPath, "utf8");
  assert.ok(
    /export\s+function\s+listRecognizableTestPaths\b/.test(inventorySource),
    "scripts/test-inventory.ts must export listRecognizableTestPaths (the single recognizable-surface owner)",
  );
  // The auto-add must NOT re-implement its own recognizable-surface walk
  // (the regression was a direct `readdirSync` over hardcoded dirs). Deny-
  // by-default: any direct readdirSync call inside the auto-add function
  // body is a re-implementation smell. Extract the full function body via
  // brace matching. The function has a `Promise<{...}>` return type whose
  // braces must be skipped so the match starts at the BODY opening brace:
  // close the return-type braces first, then the next `{` is the body, then
  // match the body to its closing `}`.
  const fnName = "autoAddMissingDispositionEntries";
  // Find the DEFINITION (`function autoAddMissingDispositionEntries`), not a
  // call site (the function is also called earlier in the file).
  const fnDef = runTestsSource.indexOf(`function ${fnName}`);
  assert.ok(fnDef !== -1, `${fnName} must be defined in scripts/run-tests.ts`);
  let cursor = runTestsSource.indexOf("{", fnDef);
  assert.ok(cursor !== -1, `${fnName} must have a body`);
  // Skip any return-type braces (e.g. `: Promise<{ ... }>`) by closing every
  // `{` group until depth returns to 0; the next `{` after that is the body.
  let depth = 0;
  let i = cursor;
  for (; i < runTestsSource.length; i++) {
    const ch = runTestsSource[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { cursor = i + 1; break; }
    }
  }
  const bodyOpen = runTestsSource.indexOf("{", cursor);
  assert.ok(bodyOpen !== -1, `${fnName} must have a function body after its signature`);
  depth = 0;
  let bodyEnd = bodyOpen;
  for (i = bodyOpen; i < runTestsSource.length; i++) {
    const ch = runTestsSource[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { bodyEnd = i; break; }
    }
  }
  const autoAddBody = runTestsSource.slice(bodyOpen, bodyEnd + 1);
  assert.ok(
    !/\breaddirSync\b/.test(autoAddBody),
    "autoAddMissingDispositionEntries must not call readdirSync directly (it must use listRecognizableTestPaths, the single owner)",
  );
});

/**
 * ── R-b: PRUNING A DISPOSITION ENTRY IS A REFUSAL, NOT A REPAIR ───────────
 *
 * Adding an entry and removing one are not symmetric. Adding registers a new
 * test file and the suite grows. Removing is how the suite disappears:
 * renaming `test/` to `tests/` made every registered path stale, the auto-heal
 * pruned 399 entries and re-added them as `pending-external-qualification`,
 * and the resulting manifest was internally consistent and described a suite
 * of two files. `npm test` then reported `status: "passed"` at exit 0 with 78
 * of 8,562 tests.
 *
 * The heal ran BEFORE any gate could fire — a repair that outruns its check —
 * so the fix is not another gate. It is that this direction refuses, and says
 * what to do instead.
 */
test("auto-heal: pruning a stale entry REFUSES instead of healing", async () => {
  const root = createRepositoryLocalTemporaryDirectory("auto-heal-prune-refusal-");
  try {
    const live = "test/workflow/still-here.test.ts";
    const removed = "test/workflow/deleted-by-a-rename.test.ts";
    mkdirSync(join(root, "test", "workflow"), { recursive: true });
    writeFileSync(join(root, live), `import test from "node:test"; test("pass", () => {});\n`);
    // The manifest names a file that is NOT on disk — exactly the state a
    // directory rename produces for every registered path at once.
    writeManifest(root, [makeEntry(live), makeEntry(removed)]);

    const before = readManifestEntries(root);
    assert.equal(before.length, 2, "fixture: the manifest must start with the stale entry present");

    await assert.rejects(
      () => autoAddMissingDispositionEntries(root),
      (error: unknown) => {
        assert.ok(error instanceof HarnessError);
        assert.equal(error.code, "test_surface_prune_refused");
        assert.match(error.message, /deleted-by-a-rename\.test\.ts/u);
        // The way out is NAMED, so absence of permission is a state with a
        // path rather than a wall.
        assert.match(error.message, /--prune test\/workflow\/deleted-by-a-rename\.test\.ts/u);
        return true;
      },
    );

    // AND THE MANIFEST WAS NOT WRITTEN. A refusal that has already performed
    // the write is a report, not a refusal.
    assert.deepEqual(
      readManifestEntries(root).map((entry) => entry.path),
      before.map((entry) => entry.path),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ── R-c: AN UNTRACKED TEST SOURCE IS A REFUSAL BEFORE ANY WRITE ──────────
 *
 * A recognizable test file git does not hold can be neither registered (the
 * conservation identity refuses a registry naming a file a clone lacks) nor
 * left out (the coverage gate refuses an unregistered recognizable file). The
 * auto-heal used to register it, write the manifest, and leave the refusal to
 * the inventory step, so `npm test` wrote tracked files and ran zero tests.
 */
test("auto-heal: an untracked recognizable test source refuses before the manifest is written", async () => {
  const root = createRepositoryLocalTemporaryDirectory("auto-heal-untracked-");
  try {
    const tracked = "test/workflow/tracked.test.ts";
    const untracked = "test/workflow/untracked.test.ts";
    mkdirSync(join(root, "test", "workflow"), { recursive: true });
    writeFileSync(join(root, tracked), `import test from "node:test"; test("pass", () => {});\n`);
    writeFileSync(join(root, untracked), `import test from "node:test"; test("pass", () => {});\n`);
    writeManifest(root, [makeEntry(tracked)]);
    // A real index of its own, so git is an instrument here (the copies
    // without one are exempt by design).
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    git("add", "--", tracked, MANIFEST_REL_PATH);
    const before = readFileSync(join(root, MANIFEST_REL_PATH), "utf8");

    await assert.rejects(
      () => autoAddMissingDispositionEntries(root),
      (error: unknown) => {
        assert.ok(error instanceof HarnessError);
        assert.equal(error.code, "test_surface_source_untracked");
        assert.match(error.message, /untracked\.test\.ts/u);
        assert.match(error.message, /git add -N/u);
        return true;
      },
    );
    assert.equal(readFileSync(join(root, MANIFEST_REL_PATH), "utf8"), before, "a refusal must not have written");

    // The named way out works: intent-to-add puts the file in the index (a qualified source: nothing to add).
    git("add", "-N", "--", untracked);
    const { addedPaths } = await autoAddMissingDispositionEntries(root);
    assert.deepEqual([...addedPaths], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-heal: a prune names each deletion — an unnamed stale path or a present file is refused", async () => {
  const root = createRepositoryLocalTemporaryDirectory("auto-heal-prune-named-");
  try {
    const live = "test/workflow/still-here.test.ts";
    mkdirSync(join(root, "test", "workflow"), { recursive: true });
    writeFileSync(join(root, live), `import test from "node:test"; test("pass", () => {});\n`);
    writeManifest(root, [makeEntry(live), makeEntry("test/workflow/gone-a.test.ts"), makeEntry("test/workflow/gone-b.test.ts")]);
    await assert.rejects(() => autoAddMissingDispositionEntries(root, ["test/workflow/gone-a.test.ts"]),
      (error: unknown) => error instanceof HarnessError && error.code === "test_surface_prune_refused" && /gone-b/u.test(error.message) && !/--prune test\/workflow\/gone-a/u.test(error.message));
    await assert.rejects(() => autoAddMissingDispositionEntries(root, [live]),
      (error: unknown) => error instanceof HarnessError && error.code === "test_surface_prune_not_deleted");
    assert.equal(readManifestEntries(root).length, 3, "a refused prune writes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-heal: an explicitly requested prune is allowed and removes exactly the stale entry", async () => {
  // The complement, so the refusal above is a REFUSAL rather than an
  // impossibility: a deletion somebody actually meant still works, through a
  // door they had to open.
  const root = createRepositoryLocalTemporaryDirectory("auto-heal-prune-allowed-");
  try {
    const live = "test/workflow/still-here.test.ts";
    const removed = "test/workflow/really-deleted.test.ts";
    mkdirSync(join(root, "test", "workflow"), { recursive: true });
    writeFileSync(join(root, live), `import test from "node:test"; test("pass", () => {});\n`);
    writeManifest(root, [makeEntry(live), makeEntry(removed)]);

    // Only a NAMED deletion is pruned: a second stale path left unnamed would
    // still refuse (a directory rename cannot hide behind one flag).
    const { prunedPaths, addedPaths } = await autoAddMissingDispositionEntries(root, [removed]);
    assert.deepEqual([...prunedPaths], [removed]);
    assert.deepEqual([...addedPaths], []);
    assert.deepEqual(readManifestEntries(root).map((entry) => entry.path), [live]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-heal: the runner re-throws an auto-heal failure instead of writing it to stderr", () => {
  // §22-adjacent: a broad catch that does not re-throw converts a crash into a
  // verdict. This catch wrote `auto_heal_failed` to stderr and returned, so
  // every refusal raised by `harness regenerate` — a dead qualified pattern, a
  // refused prune, a broken conservation identity — became a line in front of
  // a green run. Asserted from bytes because the failure mode is the ABSENCE
  // of a statement, which no green run can show.
  const source = readFileSync(join(process.cwd(), "scripts/tooling/run-tests.ts"), "utf8");
  const start = source.indexOf("async function autoHealTestInventory");
  assert.ok(start > 0, "autoHealTestInventory must exist");
  const body = source.slice(start, source.indexOf("\nfunction readAutoHealFingerprintCache", start));
  assert.ok(body.length > 0);
  assert.match(body, /auto_heal_failed/u, "the diagnostic must still be produced");
  assert.match(body, /throw new HarnessError\(/u, "the auto-heal failure must be re-thrown, not logged");
  assert.equal(
    /process\.stderr\.write\([^)]*auto_heal_failed/u.test(body),
    false,
    "auto_heal_failed must not be reported as a stderr line the run continues past",
  );
});

test("auto-heal: a missing or unparseable fingerprint cache is a silent miss; only a failed read reports", async () => {
  const { getDebugSignals, resetDebugSystem } = await import("../../src/shared/debug/debug-system.ts");
  const root = createRepositoryLocalTemporaryDirectory("auto-heal-fingerprint-");
  const cache = join(root, AUTO_HEAL_FINGERPRINT_PATH);
  resetDebugSystem();
  try {
    assert.equal(readAutoHealFingerprintCache(root), undefined, "no cache yet is a miss");
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, "{not json");
    assert.equal(readAutoHealFingerprintCache(root), undefined, "a corrupt cache is a miss");
    writeFileSync(cache, JSON.stringify({ schemaVersion: AUTO_HEAL_FINGERPRINT_SCHEMA_VERSION, fingerprint: "abc" }));
    assert.equal(readAutoHealFingerprintCache(root), "abc");
    assert.equal(getDebugSignals().bestEffortFailures, 0, "ordinary misses never reach the failure report");
    rmSync(cache); mkdirSync(cache);
    assert.equal(readAutoHealFingerprintCache(root), undefined);
    assert.equal(getDebugSignals().bestEffortFailures, 1, "a cache that exists but cannot be read is a reported failure");
  } finally {
    resetDebugSystem();
    removeRepositoryLocalTemporaryDirectory(root);
  }
});
