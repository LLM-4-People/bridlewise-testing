import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertTestInventorySourceSnapshot,
  buildTestInventory as buildBoundTestInventory,
  createTestInventory,
  createTestInventoryEntry,
  discoverTestNames,
  testFilesFromInventory,
  testInventoryEntryIdentity,
  testInventoryIdentity,
  testTree,
  writeTestInventoryTransaction,
} from "../../scripts/test-inventory.ts";
import { createInventoryTestAccountant, executeInventoryTestRun } from "../../scripts/tooling/inventory-test-run.ts";
import {
  inspectSafeRepositoryRootBoundary,
  listSafeRepositoryTree,
} from "../../scripts/verification/safe-repository-reader.ts";
import {
  buildTestSurfaceScope,
  createTestSurfaceDispositionManifest,
  isQualifiedCanonicalNodeTestSource,
  parseTestSurfaceDispositionManifestText,
  parseTestSurfaceScope,
  recognizableTestSourceLanguage,
  TEST_SURFACE_SCOPE_SCHEMA,
  type TestSurfaceDispositionEntry,
} from "../../scripts/verification/test-surface.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import { canonicalDomainHash, canonicalHash, canonicalJson } from "../../src/kernel/integrity.ts";
import { compareUtf8Bytes } from "../../src/kernel/ordered.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import { createRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";
import { withProductionRejectFloor, withProductionRejectFloorAsync } from "../support/test-env-helpers.ts";
import { readLinuxMountPoints } from "../../src/filesystem/linux-path.ts";

// The synthetic policy the inventory transaction rewrites lives at the
// policy's post-fold location; derive it from the authority, not a literal, so
// a fold does not desync the fixture from the writer.
const POLICY_REL = ROOT_POLICY.sourcePath;

test("recursive inventory discovers nested test files in deterministic source order", (t) => {
  const root = temporaryRoot(t);
  writeTest(root, "test/z/b.test.ts", 'test("z test", () => undefined);\n');
  writeTest(root, "test/a.test.ts", 'test("root a test", () => undefined);\n');
  writeTest(root, "test/a/deep/c.test.ts", 'test("deep c test", () => undefined);\n');
  writeTest(root, "test/a/deep/fixture.ts", "export const fixture = true;\n");

  const first = buildTestInventory(root);
  const second = buildTestInventory(root);
  assert.deepEqual(second, first);
  assert.deepEqual([...new Set(first.tests.map((entry) => entry.sourceId))], [
    "test/a.test.ts",
    "test/a/deep/c.test.ts",
    "test/z/b.test.ts",
  ]);
  assert.deepEqual(first.tests.map((entry) => entry.name), ["root a test", "deep c test", "z test"]);
  assert.deepEqual(testFilesFromInventory(root, first), [
    join(root, "test/a.test.ts"),
    join(root, "test/a/deep/c.test.ts"),
    join(root, "test/z/b.test.ts"),
  ]);
  // Global byte order differs from directory-first walking and UTF-16 order.
  for (const suffix of ["a-file.ts", "a/file.ts", "\uE000.ts", "\u{10000}.ts"]) {
    writeTest(root, `test/${suffix}`, "export {};\n");
  }
  const walked = readdirSync(join(root, "test"), { recursive: true, encoding: "utf8" })
    .map((path) => `test/${path}`);
  const expectedPaths = walked.toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const encodings = new Map(expectedPaths.map((path) => [path, 0]));
  const frozenEntries = new Map<string, object>();
  const originalFrom = Buffer.from;
  const originalFreeze = Object.freeze;
  let tree: ReturnType<typeof listSafeRepositoryTree>;
  try {
    Buffer.from = new Proxy(originalFrom, {
      apply(target, receiver, args) {
        if (args[1] === "utf8" && encodings.has(args[0])) encodings.set(args[0], encodings.get(args[0])! + 1);
        return Reflect.apply(target, receiver, args);
      },
    });
    Object.freeze = new Proxy(originalFreeze, {
      apply(target, receiver, args) {
        const value = args[0];
        if (value && typeof value === "object" && encodings.has(value.path) && "identityHash" in value && "kind" in value) frozenEntries.set(value.path, value);
        return Reflect.apply(target, receiver, args);
      },
    });
    tree = listSafeRepositoryTree(root, "test", { maximumDepth: expectedPaths.length, maximumEntries: expectedPaths.length });
  } finally { Buffer.from = originalFrom; Object.freeze = originalFreeze; }
  assert.deepEqual(tree.map((entry) => entry.path), expectedPaths);
  assert.ok(Object.isFrozen(tree));
  for (const entry of tree) {
    assert.deepEqual(Object.keys(entry).sort(), ["identityHash", "kind", "path"]);
    assert.equal(entry, frozenEntries.get(entry.path), "sorting preserves the walker's original frozen entry");
    assert.ok(Object.isFrozen(entry));
  }
  assert.deepEqual([...encodings.values()], expectedPaths.map(() => 1), "each consumed global ordering path is encoded once");
  for (const count of [0, 1]) {
    const trivial = temporaryRoot(t);
    mkdirSync(join(trivial, "test"), { recursive: true });
    if (count === 1) writeTest(trivial, "test/only.ts", "export {};\n");
    let unusedEncodings = 0;
    try {
      Buffer.from = new Proxy(originalFrom, {
        apply(target, receiver, args) {
          if (args[0] === "test/only.ts" && args[1] === "utf8") unusedEncodings += 1;
          return Reflect.apply(target, receiver, args);
        },
      });
      assert.equal(listSafeRepositoryTree(trivial, "test", { maximumDepth: 0, maximumEntries: 1 }).length, count);
    } finally { Buffer.from = originalFrom; }
    assert.equal(unusedEncodings, 0, "a trivial population has no ordering comparisons to prepare");
  }
});

test("the safe walker holds no repository policy: a directory is excluded only by the CALLER's exclusion (the docs lab's finding)", (t) => {
  const root = temporaryRoot(t);
  writeTest(root, "test/exp420/x.test.ts", 'test("an experiment-shaped name", () => undefined);\n');
  writeTest(root, "test/kept/y.test.ts", 'test("kept", () => undefined);\n');
  const limits = { maximumDepth: 8, maximumEntries: 64 };
  const paths = (excludedDirectory?: (relativePath: string) => boolean) =>
    listSafeRepositoryTree(root, "test", excludedDirectory === undefined ? limits : { ...limits, excludedDirectory }).map((entry) => entry.path);
  assert.ok(paths().includes("test/exp420/x.test.ts"), "the walker applied a policy nobody handed it");
  assert.ok(!paths((path) => path === "test/exp420").some((path) => path.startsWith("test/exp420")), "the caller's exclusion was not applied");
  assert.ok(paths((path) => path === "test/exp420").includes("test/kept/y.test.ts"));
});

test("test-surface qualification never fabricates repository execution evidence", () => {
  const canonicalPath = "test/a.test.ts";
  const qualifiedExternalPath = "external/b.spec.ts";
  const scope = buildTestSurfaceScope(
    [canonicalPath, qualifiedExternalPath],
    createTestSurfaceDispositionManifest([
      {
        path: canonicalPath,
        language: "javascript-typescript",
        disposition: "canonical-node-test",
        rationale: "Canonical Node source for the scope semantics regression.",
        evidenceLinks: [],
        blocksFullRepositoryClaim: false,
      },
      {
        path: qualifiedExternalPath,
        language: "javascript-typescript",
        disposition: "qualified-external-oracle",
        rationale: "Qualified externally but intentionally not executed by the canonical Node runner.",
        evidenceLinks: ["evidence://independent-external-runner-qualification"],
        blocksFullRepositoryClaim: false,
      },
    ]),
  );
  assert.deepEqual(scope.canonicalNodeSourceIds, [canonicalPath]);
  assert.deepEqual(scope.qualifiedExternalSourceIds, [qualifiedExternalPath]);
  assert.equal(scope.recognizableSurfaceDispositionCoverageComplete, true);
  assert.equal(scope.canonicalNodeInventorySourceSetComplete, true);
  assert.equal(scope.fullRepositoryTestQualificationComplete, true);
  assert.deepEqual(
    Object.keys(scope).toSorted(),
    Object.keys(TEST_SURFACE_SCOPE_SCHEMA.shape).toSorted(),
  );
  assert.equal(Object.keys(scope).some((key) => /(?:execut|runner).*complete|complete.*(?:execut|runner)/iu.test(key)), false);
  assert.throws(
    () => parseTestSurfaceScope({ ...scope, fullRepositoryExecutionComplete: true }),
  );
});

test("test-surface identity uses UTF-8 byte order independent of locale x3", () => {
  const paths = [
    "test/locale/é.test.ts",
    "test/locale/ß.test.ts",
    "test/locale/中.test.ts",
    "test/locale/😀.test.ts",
  ];
  const entries: TestSurfaceDispositionEntry[] = paths.toReversed().map((path) => ({
    path,
    language: "javascript-typescript",
    disposition: "canonical-node-test",
    rationale: "Synthetic non-ASCII ordering mutant for the canonical test-surface builder.",
    evidenceLinks: [],
    blocksFullRepositoryClaim: false,
  }));
  const baseline = createTestSurfaceDispositionManifest(entries);
  assert.deepEqual(
    baseline.entries.map((entry) => entry.path),
    paths.toSorted(compareUtf8Bytes),
  );

  const originalLocaleCompare = String.prototype.localeCompare;
  try {
    String.prototype.localeCompare = () => {
      throw new Error("localeCompare must not participate in canonical test-surface identity");
    };
    for (let repetition = 0; repetition < 3; repetition += 1) {
      assert.deepEqual(createTestSurfaceDispositionManifest(entries), baseline);
    }
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }
  const generatorSource = readFileSync(
    fileURLToPath(new URL("../../scripts/verification/test-surface.ts", import.meta.url)),
    "utf8",
  );
  assert.equal(generatorSource.includes("localeCompare"), false);
});

test("structured identities are stable and separated by a registered versioned domain x3", () => {
  const payload = { same: "payload" };
  const first = canonicalDomainHash("test.first/v1", payload);
  const second = canonicalDomainHash("test.second/v1", payload);
  assert.notEqual(first, second);
  for (let repetition = 0; repetition < 3; repetition += 1) {
    assert.equal(canonicalDomainHash("test.first/v1", payload), first);
  }
  for (const invalidDomain of ["", "unversioned", "UPPER/v1", "test/v0"]) {
    assert.throws(() => canonicalDomainHash(invalidDomain, payload), /domain is invalid/u);
  }
});

test("recursive inventory fails closed for empty sources and duplicate registrations", (t) => {
  const emptyRoot = temporaryRoot(t);
  assert.throws(() => buildTestInventory(emptyRoot), /source surface is empty/u);

  const duplicateRoot = temporaryRoot(t);
  writeTest(duplicateRoot, "test/nested/duplicate.test.ts", [
    'test("duplicate nested name", () => undefined);',
    'test("duplicate nested name", () => undefined);',
    "",
  ].join("\n"));
  assert.throws(() => buildTestInventory(duplicateRoot), /duplicate test names/u);

  const repeatedNameRoot = temporaryRoot(t);
  writeTest(repeatedNameRoot, "test/a/first.test.ts", 'test("shared name", () => undefined);\n');
  writeTest(repeatedNameRoot, "test/b/second.test.ts", 'test("shared name", () => undefined);\n');
  const repeated = buildTestInventory(repeatedNameRoot);
  assert.equal(repeated.tests.length, 2);
  assert.notEqual(repeated.tests[0]!.id, repeated.tests[1]!.id);
});

test("recursive inventory rejects symlinked directories and files without following them", (t) => {
  withProductionRejectFloor(() => {
  const external = temporaryRoot(t);
  writeTest(external, "outside.test.ts", 'test("outside", () => undefined);\n');

  const directoryRoot = temporaryRoot(t);
  symlinkSync(external, join(directoryRoot, "test", "linked-directory"));
  assert.throws(
    () => buildTestInventory(directoryRoot),
    (error) => hasSafePathCode(error, "safe_path_symlink"),
  );

  const fileRoot = temporaryRoot(t);
  symlinkSync(join(external, "outside.test.ts"), join(fileRoot, "test", "linked-file.test.ts"));
  assert.throws(
    () => buildTestInventory(fileRoot),
    (error) => hasSafePathCode(error, "safe_path_symlink"),
  );
  });
});

test("recursive inventory rejects hardlinks, special files, and invalid UTF-8 names", async (t) => {
  await withProductionRejectFloorAsync(async () => {
  const hardlinkRoot = temporaryRoot(t);
  writeTest(hardlinkRoot, "test/source.test.ts", 'test("source", () => undefined);\n');
  linkSync(join(hardlinkRoot, "test/source.test.ts"), join(hardlinkRoot, "test/alias.test.ts"));
  assert.throws(
    () => buildTestInventory(hardlinkRoot),
    (error) => hasSafePathCode(error, "safe_path_hardlink"),
  );

  const specialRoot = temporaryRoot(t);
  // A Unix socket path under the repository-local test fixture root can exceed
  // Linux's 108-char socket path limit (the repo root itself is already long).
  // A FIFO (named pipe) is an equivalent "special file" that triggers the same
  // safe_path_special rejection without the path-length constraint.
  const fifoPath = join(specialRoot, "s");
  spawnSync("mkfifo", [fifoPath]);
  assert.ok(existsSync(fifoPath), "FIFO must be created");
  try {
    assert.throws(
      () => buildTestInventory(specialRoot),
      (error) => hasSafePathCode(error, "safe_path_special"),
    );
  } finally {
    rmSync(fifoPath, { force: true });
  }

  const invalidNameRoot = temporaryRoot(t);
  const invalidName = Buffer.concat([
    Buffer.from(`${join(invalidNameRoot, "test")}/invalid-`, "utf8"),
    Buffer.from([0xff]),
    Buffer.from(".test.ts", "utf8"),
  ]);
  writeFileSync(invalidName, 'test("invalid filename", () => undefined);\n');
  assert.throws(
    () => buildTestInventory(invalidNameRoot),
    (error) => hasSafePathCode(error, "safe_path_name_invalid_utf8"),
  );
  });
});

test("recursive inventory rejects invalid source paths and invalid UTF-8 source bytes", (t) => {
  const pathRoot = temporaryRoot(t);
  writeTest(pathRoot, "test/nested\nname/source.test.ts", 'test("invalid path", () => undefined);\n');
  assert.throws(
    () => buildTestInventory(pathRoot),
    (error) => hasSafePathCode(error, "safe_path_invalid"),
  );

  const directoryRoot = temporaryRoot(t);
  mkdirSync(join(directoryRoot, "test", "directory.test.ts"), { recursive: true });
  assert.throws(() => buildTestInventory(directoryRoot), /source path is invalid/u);

  const bytesRoot = temporaryRoot(t);
  writeTest(bytesRoot, "test/invalid.test.ts", Buffer.from([0xff, 0x0a]));
  assert.throws(() => buildTestInventory(bytesRoot), /not valid UTF-8/u);
});

test("recursive descriptor walk enforces depth and entry ceilings", (t) => {
  const root = temporaryRoot(t);
  writeTest(root, "test/nested/source.test.ts", 'test("nested", () => undefined);\n');
  assert.throws(
    () => listSafeRepositoryTree(root, "test", { maximumDepth: 0, maximumEntries: 10 }),
    (error) => hasSafePathCode(error, "safe_path_depth_limit"),
  );
  assert.throws(
    () => listSafeRepositoryTree(root, "test", { maximumDepth: 10, maximumEntries: 1 }),
    (error) => hasSafePathCode(error, "safe_path_entry_limit"),
  );
  assert.throws(
    () => listSafeRepositoryTree(root, "test", { maximumDepth: -1, maximumEntries: 1 }),
    (error) => hasSafePathCode(error, "safe_path_limits_invalid"),
  );
});

test("shared repository-root qualification rejects mounted and symlinked ancestors", (t) => {
  const qualified = temporaryRoot(t);
  assert.deepEqual(inspectSafeRepositoryRootBoundary(qualified), { ok: true, code: null });

  const symlinkParent = createRepositoryLocalTemporaryDirectory("root-symlink-parent-");
  t.after(() => rmSync(symlinkParent, { recursive: true, force: true }));
  mkdirSync(join(symlinkParent, "real", "candidate"), { recursive: true });
  symlinkSync("real", join(symlinkParent, "alias"));
  assert.deepEqual(inspectSafeRepositoryRootBoundary(join(symlinkParent, "alias", "candidate")), {
    ok: false,
    code: "safe_path_ancestor_symlink",
  });

  // A place below a REAL mount point, read from the table the check itself
  // reads. This arm used the system temp root, assuming it is a mount of its
  // own (a tmpfs /tmp) — false once TMPDIR points into the root filesystem,
  // where the arm then judged whatever that folder's ancestors happen to be.
  const topLevelMount = [...readLinuxMountPoints()].filter((point) => point !== "/" && dirname(point) === "/").sort()[0];
  assert.ok(topLevelMount !== undefined, "a Linux host mounts at least one top-level filesystem (/proc)");
  assert.deepEqual(inspectSafeRepositoryRootBoundary(join(topLevelMount, "untrusted-candidate")), {
    ok: false,
    code: "safe_path_root_ancestor_mountpoint",
  });
});

test("repository-local fixture cleanup isolates retained concurrent and crashed owners x3", { timeout: 180_000 }, async (t) => {
  const worker = fileURLToPath(new URL("../support/repository-local-temporary-worker.ts", import.meta.url));
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const retainedResult = await runTemporaryOwnerWorker(worker, "retain");
    const cleanedResult = await runTemporaryOwnerWorker(worker, "cleanup");
    // Liveness first: both owners really did create a directory, observed from
    // INSIDE the owning process. Without this the two absence checks below are
    // satisfied by a worker that created nothing.
    assert.equal(retainedResult.exists, true);
    assert.equal(cleanedResult.exists, false);
    // AN OWNER THAT NEVER ASKS FOR CLEANUP STILL LEAVES NOTHING BEHIND.
    // The "retain" worker returns without calling the removal at all, and its
    // directory is gone anyway, because the owner registers the removal on the
    // PROCESS at first creation rather than trusting each caller to remember.
    // This is the regression test for the leak that produced 4,938 abandoned
    // `owner-*` directories, roughly sixteen more on every run: the obligation
    // moved to the thing that creates the mess, so forgetting is no longer
    // possible. Only a process that never runs its exit handlers can leak now,
    // which is exactly the SIGKILL case exercised below — and the reason a
    // repository-level sweep still has to exist.
    assert.equal(existsSync(retainedResult.path), false);
    assert.equal(existsSync(cleanedResult.path), false);
    // Isolation: two owner processes never share a root, so one owner's
    // removal cannot reach into another's.
    assert.notEqual(dirname(retainedResult.path), dirname(cleanedResult.path));
    t.after(() => rmSync(dirname(retainedResult.path), { recursive: true, force: true }));

    const concurrent = await Promise.all([
      runTemporaryOwnerWorker(worker, "cleanup"),
      runTemporaryOwnerWorker(worker, "cleanup"),
    ]);
    assert.notEqual(dirname(concurrent[0]!.path), dirname(concurrent[1]!.path));
    assert.deepEqual(concurrent.map((entry) => entry.exists), [false, false]);

    // A LIVE owner's root is never touched by another owner's creation; a
    // DEAD owner's root (a SIGKILLed process ran no exit handler) is swept by
    // the next creation — the owned-temporary contract that ended the leaked
    // `owner-*` roots (WF-DEL fixture leak): before, a crashed owner's root
    // stayed for ever.
    const held = spawn(process.execPath, [worker, "hold"], { stdio: ["ignore", "pipe", "pipe"] });
    // A failed arm never leaves the holding worker running.
    t.after(() => { if (held.exitCode === null && held.signalCode === null) held.kill("SIGKILL"); });
    let heldOutput = "";
    held.stdout!.setEncoding("utf8");
    held.stdout!.on("data", (chunk: string) => heldOutput += chunk);
    await once(held.stdout!, "data");
    const heldResult = JSON.parse(heldOutput.trim()) as { path: string; exists: boolean };
    t.after(() => rmSync(dirname(heldResult.path), { recursive: true, force: true }));
    assert.equal(heldResult.exists, true);
    await runTemporaryOwnerWorker(worker, "cleanup");
    assert.equal(existsSync(heldResult.path), true, "another owner's creation swept a LIVE owner's root");
    const heldClosed = once(held, "close");
    held.kill("SIGKILL");
    await heldClosed;
    assert.equal(existsSync(heldResult.path), true, "a SIGKILLed owner runs no exit handler");
    await runTemporaryOwnerWorker(worker, "cleanup");
    assert.equal(existsSync(dirname(heldResult.path)), false, "the next creation did not sweep the DEAD owner's root");
  }
});

test("inventory transaction upgrades a v2 test-only base to repository-surface v4", (t) => {
  const root = temporaryRoot(t);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "traceability"), { recursive: true });
  writeTest(root, "test/source.test.ts", 'test("base", () => undefined);\n');
  const base = buildTestInventory(root);
  const legacy = {
    schemaVersion: "bridlewise-test-inventory/v2",
    tests: base.tests,
    inventoryHash: canonicalHash(base.tests),
  } as const;
  writeFileSync(join(root, VERIFICATION_PATHS.testInventory), `${canonicalJson(legacy)}\n`);
  mkdirSync(join(root, dirname(POLICY_REL)), { recursive: true });
  writeFileSync(join(root, POLICY_REL), [
    "export const policy = {",
    "  verification: {",
    `    testInventorySchema: "${ROOT_POLICY.verification.testInventorySchema}",`,
    `    testInventoryHash: "${legacy.inventoryHash}",`,
    "  },",
    "};",
    "",
  ].join("\n"));
  writeTest(root, "test/source.test.ts", 'test("next", () => undefined);\n');
  const next = buildTestInventory(root);

  const inventoryPath = join(root, VERIFICATION_PATHS.testInventory);
  const legacyText = canonicalJson(legacy);
  writeFileSync(inventoryPath, `{"inventoryHash":"${legacy.inventoryHash}",${legacyText.slice(1)}\n`);
  assert.throws(
    () => writeTestInventoryTransaction(root, next, () => undefined, testInventoryBuildOptions(root)),
    /duplicate key/u,
  );
  writeFileSync(inventoryPath, `${legacyText}\n`);
  writeTestInventoryTransaction(root, next, () => undefined, testInventoryBuildOptions(root));

  assert.deepEqual(JSON.parse(readFileSync(inventoryPath, "utf8")), next);
  assert.match(readFileSync(join(root, POLICY_REL), "utf8"), new RegExp(next.inventoryHash, "u"));
});

test("inventory authority rejects omitted or renamed tests within a covered source file", (t) => {
  const root = temporaryRoot(t);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "traceability"), { recursive: true });
  writeTest(root, "test/source.test.ts", [
    'test("one", () => undefined);',
    'test("two", () => undefined);',
    "",
  ].join("\n"));
  const full = buildTestInventory(root);
  writeFileSync(join(root, VERIFICATION_PATHS.testInventory), `${canonicalJson(full)}\n`);
  mkdirSync(join(root, dirname(POLICY_REL)), { recursive: true });
  writeFileSync(join(root, POLICY_REL), [
    "export const policy = { verification: {",
    `  testInventorySchema: "${ROOT_POLICY.verification.testInventorySchema}",`,
    `  testInventoryHash: "${full.inventoryHash}",`,
    "} };",
    "",
  ].join("\n"));

  const omittedTests = [full.tests[0]!];
  const omitted = createTestInventory(full.scope, omittedTests);
  assert.throws(() => assertTestInventorySourceSnapshot(root, omitted),
    /does not exactly match the current test-source projection/u);
  assert.throws(() => writeTestInventoryTransaction(
    root,
    omitted,
    () => undefined,
    testInventoryBuildOptions(root),
  ),
    /does not exactly match the current test-source projection/u);

  const original = full.tests[0]!;
  const renamedEntry = createTestInventoryEntry(original.sourceId, original.sourceHash, "renamed");
  const renamedTests = [renamedEntry, ...full.tests.slice(1)];
  const renamed = createTestInventory(full.scope, renamedTests);
  assert.throws(() => assertTestInventorySourceSnapshot(root, renamed),
    /does not exactly match the current test-source projection/u);
});

test("worker and coverage accounting reject skipped, cancelled, incomplete, duplicate, and forged inventory runs", async (t) => {
  const root = temporaryRoot(t);
  writeTest(root, "test/skipped.test.ts", [
    'import test from "node:test";',
    'test("skipped test", { skip: true }, () => undefined);',
    "",
  ].join("\n"));
  const inventory = buildTestInventory(root);
  const fixture = fileURLToPath(new URL("../fixtures/recursive-test-inventory/coverage-runner.ts", import.meta.url));
  const inventoryPath = join(root, "inventory.json");
  writeFileSync(inventoryPath, canonicalJson(inventory));
  const coverageRun = spawnSync(process.execPath, [fixture, root, inventoryPath], {
    encoding: "utf8",
    env: environmentWithoutParentTestContext(),
  });
  assert.equal(coverageRun.status, 1, coverageRun.stderr);
  const coverageAccounting = JSON.parse(coverageRun.stdout) as {
    runnerSummaryObserved: boolean;
    runnerSuccessful: boolean;
    counts: { skipped: number };
    reasons: string[];
    passed: boolean;
    reportByteLength: number;
  };
  assert.equal(coverageAccounting.runnerSummaryObserved, true);
  assert.equal(coverageAccounting.runnerSuccessful, true);
  assert.equal(coverageAccounting.counts.skipped, 1);
  assert.equal(coverageAccounting.passed, false);
  assert.ok(coverageAccounting.reasons.includes("test-skipped"));
  assert.ok(coverageAccounting.reportByteLength > 0);

  const sourceFile = join(root, "test/skipped.test.ts");
  const inventoryEntry = inventory.tests[0]!;
  const cancelled = createInventoryTestAccountant(root, inventory);
  cancelled.observe({ type: "test:enqueue", data: { file: sourceFile, name: inventoryEntry.name } });
  cancelled.observe({ type: "test:cancel", data: { file: sourceFile, name: inventoryEntry.name } });
  cancelled.observe({ type: "test:summary", data: { success: true, counts: { cancelled: 1 } } });
  assert.equal(cancelled.complete().passed, false);
  assert.equal(cancelled.complete().counts.cancelled, 1);
  assert.ok(cancelled.complete().reasons.includes("test-cancelled"));

  const incomplete = createInventoryTestAccountant(root, inventory);
  incomplete.observe({ type: "test:summary", data: { success: true, counts: { cancelled: 0 } } });
  assert.equal(incomplete.complete().passed, false);
  assert.ok(incomplete.complete().reasons.includes("inventory-incomplete-discovery"));

  const todo = createInventoryTestAccountant(root, inventory);
  todo.observe({ type: "test:enqueue", data: { file: sourceFile, name: inventoryEntry.name } });
  todo.observe({ type: "test:pass", data: { file: sourceFile, name: inventoryEntry.name, todo: true } });
  todo.observe({ type: "test:summary", data: { success: true, counts: { cancelled: 0 } } });
  assert.equal(todo.complete().counts.todo, 1);
  assert.equal(todo.complete().passed, false);
  assert.ok(todo.complete().reasons.includes("test-todo"));

  const duplicate = createInventoryTestAccountant(root, inventory);
  for (let index = 0; index < 2; index += 1) {
    duplicate.observe({ type: "test:enqueue", data: { file: sourceFile, name: inventoryEntry.name } });
    duplicate.observe({ type: "test:pass", data: { file: sourceFile, name: inventoryEntry.name } });
  }
  duplicate.observe({ type: "test:summary", data: { success: true, counts: { cancelled: 0 } } });
  assert.equal(duplicate.complete().passed, false);

  const unknownEnqueue = createInventoryTestAccountant(root, inventory);
  unknownEnqueue.observe({
    type: "test:enqueue",
    data: { file: join(root, "test/unknown.test.ts"), name: "unknown injected test" },
  });
  unknownEnqueue.observe({ type: "test:enqueue", data: { file: sourceFile, name: inventoryEntry.name } });
  unknownEnqueue.observe({ type: "test:pass", data: { file: sourceFile, name: inventoryEntry.name } });
  unknownEnqueue.observe({ type: "test:summary", data: { success: true, counts: { cancelled: 0 } } });
  assert.equal(unknownEnqueue.complete().passed, false);
  assert.deepEqual(unknownEnqueue.complete().unknownTests, ["test:enqueue:unknown injected test"]);
  assert.ok(unknownEnqueue.complete().reasons.includes("lifecycle-invalid"));

  const outOfOrder = createInventoryTestAccountant(root, inventory);
  outOfOrder.observe({ type: "test:pass", data: { file: sourceFile, name: inventoryEntry.name } });
  outOfOrder.observe({ type: "test:enqueue", data: { file: sourceFile, name: inventoryEntry.name } });
  outOfOrder.observe({ type: "test:summary", data: { success: true, counts: { cancelled: 0 } } });
  assert.equal(outOfOrder.complete().passed, false);
  assert.equal(outOfOrder.complete().unknownTests.some((entry) => entry.includes("before-enqueue")), true);

  const outsideWrapper = createInventoryTestAccountant(root, inventory);
  outsideWrapper.observe({ type: "test:enqueue", data: { file: sourceFile, name: inventoryEntry.name } });
  outsideWrapper.observe({ type: "test:pass", data: { file: sourceFile, name: inventoryEntry.name } });
  outsideWrapper.observe({
    type: "test:pass",
    data: { file: "/tmp/outside.test.ts", name: "/tmp/outside.test.ts" },
  });
  outsideWrapper.observe({ type: "test:summary", data: { success: true, counts: {
    tests: 1, failed: 0, passed: 1, cancelled: 0, skipped: 0, todo: 0,
  } } });
  assert.equal(outsideWrapper.complete().passed, false);
  assert.deepEqual(outsideWrapper.complete().unknownTests, ["test:pass:/tmp/outside.test.ts"]);
  assert.ok(outsideWrapper.complete().reasons.includes("lifecycle-invalid"));

  const outsideSummary = createInventoryTestAccountant(root, inventory);
  outsideSummary.observe({ type: "test:enqueue", data: { file: sourceFile, name: inventoryEntry.name } });
  outsideSummary.observe({ type: "test:pass", data: { file: sourceFile, name: inventoryEntry.name } });
  outsideSummary.observe({ type: "test:summary", data: { file: "/tmp/outside.test.ts", success: true } });
  outsideSummary.observe({ type: "test:summary", data: { success: true, counts: {
    tests: 1, failed: 0, passed: 1, cancelled: 0, skipped: 0, todo: 0,
  } } });
  assert.equal(outsideSummary.complete().passed, false);
  assert.deepEqual(outsideSummary.complete().unknownTests,
    ["test:summary:unknown-file:/tmp/outside.test.ts"]);

  const validSummaryCounts = {
    tests: 1, failed: 0, passed: 1, cancelled: 0, skipped: 0, todo: 0, topLevel: 1, suites: 0,
  };
  const summaryFirst = createInventoryTestAccountant(root, inventory);
  summaryFirst.observe({ type: "test:summary", data: { success: true, counts: validSummaryCounts } });
  summaryFirst.observe({ type: "test:enqueue", data: { file: sourceFile, name: inventoryEntry.name } });
  summaryFirst.observe({ type: "test:pass", data: { file: sourceFile, name: inventoryEntry.name } });
  assert.equal(summaryFirst.complete().passed, false);
  assert.equal(summaryFirst.complete().unknownTests.some((entry) => entry.includes("after-global-summary")), true);
  assert.ok(summaryFirst.complete().reasons.includes("lifecycle-invalid"));

  const contradictorySummary = createInventoryTestAccountant(root, inventory);
  contradictorySummary.observe({ type: "test:enqueue", data: { file: sourceFile, name: inventoryEntry.name } });
  contradictorySummary.observe({ type: "test:pass", data: { file: sourceFile, name: inventoryEntry.name } });
  contradictorySummary.observe({
    type: "test:summary",
    data: { success: true, counts: { ...validSummaryCounts, passed: 0, failed: 1 } },
  });
  assert.equal(contradictorySummary.complete().passed, false);
  assert.ok(contradictorySummary.complete().reasons.includes("runner-summary-counts-mismatch"));

  const missingSummary = createInventoryTestAccountant(root, inventory);
  missingSummary.observe({ type: "test:enqueue", data: { file: sourceFile, name: inventoryEntry.name } });
  missingSummary.observe({ type: "test:pass", data: { file: sourceFile, name: inventoryEntry.name } });
  assert.deepEqual(missingSummary.complete().reasons, ["runner-summary-missing"]);

  const forgedTests = [{ ...inventoryEntry, id: "0".repeat(64) }];
  const forged = {
    ...inventory,
    tests: forgedTests,
    inventoryHash: testInventoryIdentity(inventory.scope, forgedTests),
  } as typeof inventory;
  assert.throws(() => testFilesFromInventory(root, forged), /entry identity is invalid/u);

  for (const sourceId of ["test/../outside.test.ts", "test/../../outside.test.ts"]) {
    const escapedTests = [{
      ...inventoryEntry,
      sourceId,
      id: testInventoryEntryIdentity(sourceId, inventoryEntry.sourceHash, inventoryEntry.name),
    }];
    const escaped = {
      ...inventory,
      tests: escapedTests,
      inventoryHash: testInventoryIdentity(inventory.scope, escapedTests),
    } as typeof inventory;
    assert.throws(() => testFilesFromInventory(root, escaped), /test inventory schema is invalid/u);
  }
});

test("shared inventory execution rejects a stale source snapshot before running", async (t) => {
  const root = temporaryRoot(t);
  writeTest(root, "test/stale.test.ts", [
    'import test from "node:test";',
    'test("stale source", () => { throw new Error("old bytes"); });',
    "",
  ].join("\n"));
  const inventory = buildTestInventory(root);
  writeTest(root, "test/stale.test.ts", [
    'import test from "node:test";',
    'test("stale source", () => undefined);',
    "",
  ].join("\n"));
  await assert.rejects(() => executeInventoryTestRun(root, inventory), /source hash is invalid/u);
});

test("positive static integer-loop discovery equals real scope-guard registrations in three fresh processes", (t) => {
  const scopeGuardTestPath = fileURLToPath(
    new URL("../../verification/benchmarks/opencode-history/scope-guard.test.ts", import.meta.url),
  );
  const discovered = discoverTestNames(readFileSync(scopeGuardTestPath, "utf8"));
  const root = temporaryRoot(t);
  const reporterPath = join(root, "registration-reporter.mjs");
  writeFileSync(reporterPath, [
    "export default async function* registrationReporter(source) {",
    "  for await (const event of source) {",
    '    if (event.type === "test:enqueue") yield `${JSON.stringify(event)}\\n`;',
    "  }",
    "}",
    "",
  ].join("\n"));

  for (let processIndex = 0; processIndex < 3; processIndex += 1) {
    const run = spawnSync(process.execPath, [
      "--test",
      `--test-reporter=${reporterPath}`,
      scopeGuardTestPath,
    ], {
      encoding: "utf8",
      env: environmentWithoutParentTestContext(),
      maxBuffer: ROOT_POLICY.verification.testDiscovery.maximumInventoryBytes,
    });
    assert.equal(run.status, 0, run.stderr);
    const wrapperNames = new Set([scopeGuardTestPath, relative(process.cwd(), scopeGuardTestPath)]);
    const registered = run.stdout.trim().split("\n").filter(Boolean).map((line) => {
      const event = JSON.parse(line) as { data?: { file?: string; name?: string } };
      return event.data;
    }).filter((data): data is { name: string } =>
      typeof data?.name === "string" && !wrapperNames.has(data.name)
    ).map((data) => data.name);
    assert.deepEqual(registered, discovered, `registration mismatch in process ${processIndex + 1}`);
  }
});

test("numeric registration-loop discovery fails closed on unmodeled bounds, mutation, effects, and syntax", (t) => {
  const valid = [
    "for (let repetition = 1; repetition <= 3; repetition += 1) {",
    "  test(`first repetition ${repetition}`, () => undefined);",
    "  test(`second repetition ${repetition}`, () => undefined);",
    "}",
  ].join("\n");
  const validNames = discoverTestNames(valid);
  assert.equal(validNames.length, 6);
  assert.equal(new Set(validNames).size, validNames.length);

  const hostile = [
    valid.replace("repetition = 1", "repetition = 0"),
    valid.replace("repetition = 1", "repetition = -1"),
    valid.replace("repetition <= 3", "repetition <= 0"),
    valid.replace("repetition <= 3", "repetition <= -1"),
    valid.replace("repetition <= 3", "repetition < 1"),
    `const bound = 3;\n${valid.replace("repetition <= 3", "repetition <= bound")}`,
    valid.replace("repetition += 1", "repetition += 2"),
    valid.replace("repetition <= 3", `repetition <= ${ROOT_POLICY.verification.testDiscovery.maximumEntries + 1}`),
    valid.replace("second repetition ${repetition}", "second repetition ${++repetition}"),
    valid.replace("() => undefined", "registerTelemetry()"),
    valid.replace(
      "  test(`second repetition ${repetition}`, () => undefined);",
      "  repetition += 1;\n  test(`second repetition ${repetition}`, () => undefined);",
    ),
    valid.replace(
      "  test(`second repetition ${repetition}`, () => undefined);",
      "  registerTelemetry();\n  test(`second repetition ${repetition}`, () => undefined);",
    ),
    valid.replace(/`(?:first|second) repetition \$\{repetition\}`/gu, '"duplicate"'),
  ];
  for (const source of hostile) assert.throws(() => discoverTestNames(source));

  const marker = join(temporaryRoot(t), "discovery-must-not-execute");
  const effectful = [
    "for (let repetition = 1; repetition <= 3; repetition += 1) {",
    `  require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");`,
    "  test(`effect ${repetition}`, () => undefined);",
    "}",
  ].join("\n");
  assert.throws(() => discoverTestNames(effectful), /unsupported registration-time side effect/u);
  assert.equal(existsSync(marker), false);
  assert.throws(() => discoverTestNames(valid.slice(0, -1)));
});

test("test registration discovery resolves node:test aliases, wrappers, and destructured static loops", () => {
  const source = [
    'import nodeTest, { test as verify } from "node:test";',
    "function mechanismTest(name, operation) {",
    "  void nodeTest(name, (context) => operation(context));",
    "}",
    'verify("aliased direct registration", () => undefined);',
    'mechanismTest("resolved wrapper registration", () => undefined);',
    "for (const [profile, ordinal] of [",
    '  ["alpha", 1],',
    '  ["beta", 2],',
    "] as const) {",
    "  verify(`destructured ${profile} ${ordinal}`, () => undefined);",
    "}",
  ].join("\n");
  assert.deepEqual(discoverTestNames(source), [
    "aliased direct registration",
    "resolved wrapper registration",
    "destructured alpha 1",
    "destructured beta 2",
  ]);
});

test("test registration discovery rejects name-only wrappers and shadowed registrar aliases", () => {
  const hostile = [
    [
      'import nodeTest from "node:test";',
      "function nameOnlyWrapper(name, operation, nodeTest) {",
      "  nodeTest(name, () => operation());",
      "}",
      'nameOnlyWrapper("not resolved", () => undefined);',
    ].join("\n"),
    [
      "function mechanismTest(name, operation) {",
      "  fakeRegister(name, () => operation());",
      "}",
      'mechanismTest("name heuristic must not register", () => undefined);',
    ].join("\n"),
    [
      'import { test as verify } from "node:test";',
      'for (const verify of ["shadow"]) {',
      '  verify("shadowed loop registrar", () => undefined);',
      "}",
    ].join("\n"),
    [
      "const test = fakeRegister;",
      'test("shadowed legacy registrar", () => undefined);',
    ].join("\n"),
  ];
  for (const source of hostile) assert.throws(() => discoverTestNames(source));
});

test("closed static loop evaluator rejects cycles, spreads, computed keys, and dynamic values", () => {
  const hostile = [
    'const CASES = CASES; for (const value of CASES) { test("cycle", () => undefined); }',
    'const VALUES = [1]; for (const value of [...VALUES]) { test("array spread", () => undefined); }',
    'for (const value of [{ name: "ok", ...dynamic }]) { test(value.name, () => undefined); }',
    'for (const value of [{ ["name"]: "ok" }]) { test(value.name, () => undefined); }',
    'for (const value of [runtimeValue]) { test("dynamic", () => undefined); }',
  ];
  for (const source of hostile) assert.throws(() => discoverTestNames(source));
});

test("static loop discovery models nested literal loops and renders every admitted scalar", () => {
  const source = [
    'import { describe, test } from "node:test";',
    'const OWNERS = ["generic", "s1"] as const;',
    "for (const owner of OWNERS) {",
    '  for (const fault of ["stat", "rename"] as const) {',
    "    test(`cache ${owner} ${fault}`, () => undefined);",
    "  }",
    "}",
    'for (const observer of ["logger"] as const) for (const enabled of [false, true]) {',
    "  test(`observer ${observer} enabled=${enabled}`, () => undefined);",
    "}",
    "for (const value of [null]) test(`null ${value}`, () => undefined);",
    'describe("suite", () => {',
    '  for (const [kind, repeat] of [["a", 1]] as const) for (const flag of [true]) {',
    "    test(`${kind} ${repeat} ${flag}`, () => undefined);",
    "  }",
    "});",
  ].join("\n");
  assert.deepEqual(discoverTestNames(source), [
    "cache generic stat",
    "cache generic rename",
    "cache s1 stat",
    "cache s1 rename",
    "observer logger enabled=false",
    "observer logger enabled=true",
    "null null",
    "suite > a 1 true",
  ]);
});

test("static loop discovery refuses names the test file's own bytes cannot decide", () => {
  const hostile = [
    // An imported iterable or an imported spread: the name would move when another file changes.
    'import { KINDS } from "./kinds.ts"; for (const kind of KINDS) test(`kind ${kind}`, () => undefined);',
    'import { KINDS } from "./kinds.ts"; for (const kind of ["a", ...KINDS]) test(`kind ${kind}`, () => undefined);',
    // Computed or constructed loop values.
    'const LIMIT = 10; for (const total of [LIMIT + 1]) test(`total ${total}`, () => undefined);',
    'for (const failure of [new Error("x"), undefined]) test(`failure ${String(failure)}`, () => undefined);',
    'for (const kind of KINDS.filter((kind) => kind !== "event")) test(`kind ${kind}`, () => undefined);',
    // Names computed from a static value rather than interpolating it.
    'for (const flag of [false, true]) test(`mode ${flag ? "async" : "sync"}`, () => undefined);',
    'for (const text of ["a"]) test(`text ${JSON.stringify(text)}`, () => undefined);',
    'for (const text of ["a"]) test("text " + text, () => undefined);',
    // A record or array value has no stable rendered identity.
    'for (const value of [["a"]]) test(`array ${value}`, () => undefined);',
    // A subtest through the test context runs as an un-inventoried test.
    'test("outer", async (t) => { await t.test("inner", () => undefined); });',
    'for (const kind of ["a"]) test(`outer ${kind}`, async (context) => { for (const x of [1]) await context.test(`x${x}`, () => undefined); });',
    'test("destructured", async ({ test: sub }) => { await sub("inner", () => undefined); });',
    // The inner binding is under a non-loop construct the model does not follow.
    'for (const a of ["x"]) { if (a) { for (const b of ["y"]) test(`${a} ${b}`, () => undefined); } }',
    // An inner iterable that reads an OUTER loop binding: evaluating it against the file-level name the
    // loop variable shadows would name tests that never run (`v file` instead of `v a`, `v b`).
    'const values = ["file"]; for (const values of [["a", "b"]]) for (const v of values) test(`v ${v}`, () => undefined);',
  ];
  for (const source of hostile) assert.throws(() => discoverTestNames(source), Error, source);
});

test("the context-subtest refusal follows shadowing: a regex named like the context is not a subtest", () => {
  assert.deepEqual(discoverTestNames(
    'test("lines", (t) => { const patterns = [/a/u]; assert.ok(["a"].some((line) => patterns.some((t) => t.test(line)))); void t; });',
  ), ["lines"]);
});

test("every canonical node test source in the dispositions manifest is statically modeled", () => {
  // The inventory rejects the WHOLE suite when one canonical file registers a
  // test it cannot name, and that refusal used to surface only inside the
  // full-suite auto-heal (`npm test` ran zero tests). This asks the same
  // question file by file, so the offending file and its reason are named by
  // an ordinary targeted run.
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const manifest = parseTestSurfaceDispositionManifestText(readFileSync(
    join(repositoryRoot, ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath),
    "utf8",
  ));
  const canonical = manifest.entries
    .filter((entry) => entry.disposition === "canonical-node-test" && existsSync(join(repositoryRoot, entry.path)))
    .map((entry) => entry.path);
  assert.ok(canonical.length > 100, `canonical node test sources scanned: ${canonical.length}`);
  const unmodeled = canonical.flatMap((path) => {
    try {
      discoverTestNames(readFileSync(join(repositoryRoot, path), "utf8"));
      return [];
    } catch (error) {
      return [`${path}: ${error instanceof Error ? error.message : String(error)}`];
    }
  });
  assert.deepEqual(
    unmodeled,
    [],
    "every registration name must be decidable from the test file's own bytes: iterate literal arrays or an " +
      "`Object.keys(<local catalog>)`, and derive runtime values (errors, imported constants, computed sizes) " +
      "inside the test body. See engine/scripts/README.md (test-inventory.ts).",
  );
});

test("provisional discovery resource ceilings reject exact above-boundary mutants", () => {
  const limits = ROOT_POLICY.verification.testDiscovery;
  const staticDepthSource = (depth: number): string =>
    `for (const value of [${"[".repeat(depth)}1${"]".repeat(depth)}]) { ` +
    'test("static depth boundary", () => undefined); }';
  assert.deepEqual(discoverTestNames(staticDepthSource(limits.maximumStaticEvaluationDepth - 1)), [
    "static depth boundary",
  ]);
  assert.deepEqual(discoverTestNames(staticDepthSource(limits.maximumStaticEvaluationDepth)), [
    "static depth boundary",
  ]);
  assert.throws(
    () => discoverTestNames(staticDepthSource(limits.maximumStaticEvaluationDepth + 1)),
    /static evaluation depth ceiling/u,
  );

  const astDepthSource = (depth: number): string =>
    `test("AST depth boundary", () => ${"!".repeat(depth - 3)}true);`;
  assert.deepEqual(discoverTestNames(astDepthSource(limits.maximumAstDepth - 1)), ["AST depth boundary"]);
  assert.deepEqual(discoverTestNames(astDepthSource(limits.maximumAstDepth)), ["AST depth boundary"]);
  assert.throws(
    () => discoverTestNames(astDepthSource(limits.maximumAstDepth + 1)),
    /AST depth ceiling/u,
  );

  const baseNodeCount = 6;
  const astNodeSource = (nodeCount: number): string =>
    `test("AST node boundary", () => undefined);${";".repeat(nodeCount - baseNodeCount)}`;
  assert.deepEqual(discoverTestNames(astNodeSource(limits.maximumAstNodes - 1)), ["AST node boundary"]);
  assert.deepEqual(discoverTestNames(astNodeSource(limits.maximumAstNodes)), ["AST node boundary"]);
  assert.throws(
    () => discoverTestNames(astNodeSource(limits.maximumAstNodes + 1)),
    /AST node ceiling/u,
  );
});

test("test discovery policy centrally binds recursive traversal and explicit execution inputs", () => {
  assert.deepEqual(ROOT_POLICY.verification.testDiscovery, {
    inventoryScope: {
      recognizableSurfaceDispositionCoverageComplete: true,
      canonicalNodeInventorySourceSetComplete: true,
      fullRepositoryTestQualificationComplete: false,
      historicalSchemaDisposition: "v1-v2-and-v3-parse-only-never-reinterpret-as-v4",
    },
    qualifiedSourcePatterns: [
      "test/**/*.test.ts",
      "verification/benchmarks/opencode-history/review/independent-scope-review.test.ts",
      "verification/benchmarks/opencode-history/scope-guard.test.ts",
    ],
    recognizableSourcePatterns: {
      javaScriptTypeScript: "^.+\\.(?:test|spec)\\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$",
      python: "^(?:.*/)?(?:test(?:_[^/]*)?|[^/]+_test(?:_[^/]*)?)\\.py$",
    },
    dispositionRegistry: {
      manifestPath: "traceability/test-surface-dispositions.json",
      schemaVersion: "bridlewise-test-surface-dispositions/v1",
      allowedDispositions: [
        "canonical-node-test",
        "qualified-external-oracle",
        "pending-external-qualification",
        "non-test-fixture",
        "unsupported-blocking",
      ],
      everyRecognizableSourceRequiresExactEntry: true,
      benchmarkLocationImpliesDisposition: false,
      pythonImplicitExecutionAllowed: false,
      unqualifiedDisposition: "block-and-report-exact-source-and-disposition",
      qualificationGuidance:
        "install-or-qualify-exact-loader-compiler-and-runner-before-central-pattern-or-external-oracle-admission",
    },
    surfaceConservation: {
      // Pinned by hand and NEVER auto-repaired: a pin a generator can rewrite
      // refuses nothing. Restating them here as well is deliberate — this test
      // is the second place the numbers have to be written down, so a
      // convenience re-pin cannot happen in one file and go unnoticed.
      excludedSourceSet: {
        // RESTATED HERE TOO FOR THE test/exp473 RECLASSIFICATION AND THE
        // RETIRED EXPERIMENT TESTS (2026-08-03), 21 -> 9: the four retired
        // experiment test files (exp420/exp438/exp450/exp464) left the
        // tracked surface and the three under test/exp473 moved into the
        // covered canonical set as test/regression/. `root-policy.ts`
        // carries the authored restatement; this second copy is the
        // mechanism working — the two places the number is written down
        // drifted, and the suite said so. The set itself is checked against
        // the real repository by `test-surface-conservation.test.ts`.
        // RESTATED AGAIN WITH THE SCENARIO-BOUND TEST RENAME (2026-08-24),
        // still 9: the membership did not change, but two members were
        // renamed to semantic names (the auto-learning and llm-beyond-max
        // benchmarks), which moves the set hash.
        count: 9,
        sha256: "6bf74a72fd94587c0fcb69d6a6f1813f1cb3608aea2d05ddc4a9ecb92372463d",
      },
      nonCanonicalSourceSet: {
        // RESTATED HERE TOO AT THE MONOREPO ASSEMBLY (2026-07-30), 15 -> 14,
        // and this second restatement is the mechanism working rather than a
        // chore: the pin moved in `root-policy.ts` and this file kept the old
        // number, so the suite said so. `scripts/merge-round.test.mjs` left
        // the surface with the file it tested — both were dead copies
        // importing `../integration/...`, a path this repository does not
        // have, while the live pair lives at `scripts/harness-root/`. The
        // coverage did not move; the duplicate did. The set the numbers below
        // describe is itself checked against the real repository by
        // `test-surface-conservation.test.ts`, so neither copy can be made
        // agreeable by editing it. RESTATED HERE TOO FOR LIVE-SUITE
        // (2026-10-07), 14 -> 15: the live suite `live/mcp-servers.test.ts`.
        // RESTATED HERE TOO FOR THE HERMETIC GUARD BY SHAPE (2026-10-09), 15 ->
        // 16: the live provider smoke `live/provider-smoke.test.ts`.
        // RESTATED HERE TOO FOR THE PUBLIC DEVELOPMENT FLOOR (2026-10-19),
        // 16 -> 8: the public snapshot does not publish the eight historical
        // OpenCode benchmark Python manifests/tests registered by the private
        // floor; they were pruned deliberately with `harness sync --prune`,
        // and the remaining non-canonical set is the public tree's actual set.
        // This second copy is the mechanism working: `root-policy.ts` had
        // already moved to 8 while this file kept 16, and the suite said so.
        count: 8,
        sha256: "8dcad5535d0b50a0f849d5dcc0e472afc8d8cb2f9d297e4cc749f28fa17f51d0",
      },
    },
    maximumDepth: 32,
    maximumEntries: 100_000,
    maximumAstNodes: 100_000,
    maximumAstDepth: 512,
    maximumStaticEvaluationDepth: 32,
    maximumSourceBytes: 16_777_216,
    maximumInventoryBytes: 16_777_216,
    traversal: "deterministic-recursive-descriptor-held-no-follow-snapshot",
    executionInput: "inventory-derived-explicit-file-list-only",
  });
});

test("every recognizable test file in the repository is present in the dispositions manifest", () => {
  // This test reads the real repository workspace, which is seeded with
  // `cp -rl` hardlinks (nlink=2) and runs in dev mode. The hardlink-rejection
  // security test above (line 205, "recursive inventory rejects hardlinks")
  // exercises a temp fixture and relies on the production floor being
  // enforced, so the dev-mode relaxation is scoped to this test only and
  // restored after. `node --test` runs tests within a file sequentially, so the
  // restore is observed by later tests.
  const savedHardlinkPolicy = process.env.HARNESS_REJECT_HARDLINKS;
  process.env.HARNESS_REJECT_HARDLINKS = "0";
  try {
    const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
    const manifestPath = join(
      repositoryRoot,
      ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath,
    );
    const manifestText = readFileSync(manifestPath, "utf8");
    const manifest = parseTestSurfaceDispositionManifestText(manifestText);
    const manifestPaths = new Set(manifest.entries.map((entry) => entry.path));

    // The inventory's own walk: its limits and exclusions (the experiment
    // directories included) are spelled once, in scripts/test-inventory.ts.
    const tree = testTree(repositoryRoot);

    const recognizableFiles = tree
      .filter((entry) => entry.kind === "file" && recognizableTestSourceLanguage(entry.path) !== undefined)
      .map((entry) => entry.path);
    assert.ok(recognizableFiles.length > 0, "repository must contain recognizable test files");

    const missing = recognizableFiles.filter((path) => !manifestPaths.has(path));
    const extra = [...manifestPaths].filter((path) => !recognizableFiles.includes(path));
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      "dispositions manifest must exactly cover every recognizable test file; " +
        "add missing files to traceability/test-surface-dispositions.json and run " +
        "`node scripts/test-inventory.ts --write` then `npx tsx src/cli.ts harness regenerate`",
    );
  } finally {
    if (savedHardlinkPolicy === undefined) {
      delete process.env.HARNESS_REJECT_HARDLINKS;
    } else {
      process.env.HARNESS_REJECT_HARDLINKS = savedHardlinkPolicy;
    }
  }
});

test("test-inventory transaction journal and staged files are written through a fsync-ing path (FIX 6)", () => {
  // The transaction is the ONE journaled multi-file commit's
  // (src/filesystem/journaled-commit.ts; its crash recovery is driven with a
  // real SIGKILL in test/filesystem/journaled-commit.test.ts). The recovery
  // anchor (journal) and the staged previous/next files must be durable: a
  // crash after the write but before the rename must not leave a zero-length
  // or partially-flushed file — so the owner's exclusive writer fsyncs, and
  // neither file writes through an fsync-less writeFileSync.
  const inventory = readFileSync(fileURLToPath(new URL("../../scripts/test-inventory.ts", import.meta.url)), "utf8");
  const owner = readFileSync(fileURLToPath(new URL("../../src/filesystem/journaled-commit.ts", import.meta.url)), "utf8");
  assert.ok(inventory.includes("commitJournaled("), "test-inventory.ts must commit through the journaled owner");
  // The exclusive writer publishes through the one atomic writer, durable
  // (every fsync fatal) and exclusive (complete before its name exists).
  assert.match(owner, /atomicWriteFile\(path, bytes, \{[^}]*exclusive: true[^}]*durable: true/u, "the journaled owner's exclusive writer must be the durable, exclusive atomic write");
  for (const [name, source] of [["test-inventory.ts", inventory], ["journaled-commit.ts", owner]] as const) {
    const importBlock = source.slice(0, source.indexOf("} from \"node:fs\""));
    assert.ok(!/\bwriteFileSync\b/u.test(importBlock), `${name} must not import writeFileSync (an fsync-less write)`);
  }
});


function temporaryRoot(t: TestContext): string {
  const root = createRepositoryLocalTemporaryDirectory("recursive-inventory-");
  mkdirSync(join(root, "test"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function buildTestInventory(root: string) {
  return buildBoundTestInventory(root, testInventoryBuildOptions(root));
}

function testInventoryBuildOptions(root: string) {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split("\\").join("/");
      if (recognizableTestSourceLanguage(path) !== undefined) paths.push(path);
      if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  const entries: TestSurfaceDispositionEntry[] = paths.map((path) => {
    const language = recognizableTestSourceLanguage(path)!;
    const canonical = isQualifiedCanonicalNodeTestSource(path);
    return {
      path,
      language,
      disposition: canonical ? "canonical-node-test" : "unsupported-blocking",
      rationale: canonical
        ? "Synthetic qualified Node inventory fixture."
        : "Synthetic recognizable but unqualified test surface.",
      evidenceLinks: [],
      blocksFullRepositoryClaim: !canonical,
    };
  });
  return {
    dispositionManifest: createTestSurfaceDispositionManifest(entries),
  };
}

function writeTest(root: string, path: string, content: string | Buffer): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function hasSafePathCode(error: unknown, code: string): boolean {
  return error instanceof HarnessError && error.code === code;
}

function environmentWithoutParentTestContext(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
}

async function runTemporaryOwnerWorker(
  worker: string,
  mode: "cleanup" | "retain",
): Promise<{ path: string; exists: boolean }> {
  const child = spawn(process.execPath, [worker, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => stdout += chunk);
  child.stderr!.on("data", (chunk: string) => stderr += chunk);
  const [code] = await once(child, "close") as [number | null];
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as { path: string; exists: boolean };
}
