import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import test, { after } from "node:test";

import { createInventoryTestAccountant } from "../scripts/tooling/inventory-test-run.ts";
import {
  createPlannedNodeTestSourceBinding,
  createPlannedNodeTestSuiteSpec,
  plannedNodeTestReproducibilityIdentity,
} from "../scripts/tooling/planned-node-test-evidence.ts";
import { discoverTestNames } from "../scripts/test-inventory.ts";
import * as foundationCascadePublic from "../verification/core/foundation-cascade.ts";
import {
  FOUNDATION_CASCADE_TEST_CATALOG,
  FOUNDATION_CASCADE_TEST_CATALOG_IDENTITY,
  FOUNDATION_CASCADE_TEST_DECLARATION_IDENTITY,
  FOUNDATION_CASCADE_TEST_WORKER_PATH,
} from "./support/foundation-cascade-test-catalog.ts";
import {
  createPlannedNodeTestEvidenceSession,
  patchPlannedNodeTestSourceSnapshot,
  removePlannedNodeTestSourceSnapshotPatch,
  runPlannedNodeTestSuiteWithEvidence,
} from "./support/planned-node-test-evidence.ts";
import { PLANNED_NODE_TEST_SOURCE_AUTHORITY } from
  "./support/planned-node-test-source-authority.ts";
import { TEST_REPOSITORY_ROOT } from "./support/repository-local-temporary.ts";
import { relaxSafeReadFloorForThisFile } from "./support/test-env-helpers.ts";
import { ensureTestProcessSupervisor } from "../guardian/build.ts";
import { runBoundedTestProcess } from "../src/process/supervised-run.ts";
import { configuredSubprocessBounds } from "../src/workflow/workflow-config.ts";
import { redactDiagnosticText } from "../src/shared/debug/debug-system.ts";

const ROOT = TEST_REPOSITORY_ROOT;
// These tests read the real repository workspace (seeded with `cp -rl`
// hardlinks, nlink=2) in dev mode (`selfProtection.enabled: false`). The safe
// repository reader accepts hardlinked files in dev mode via the
// `HARNESS_REJECT_HARDLINKS` env var (`shouldRejectHardlinks`). Hardlink
// rejection is verified by the dedicated security tests, which leave the env
// var unset so the production floor is enforced.
// Relaxed for THIS FILE and restored when it finishes — see the helper.
relaxSafeReadFloorForThisFile();
// Dev workspaces use a `node_modules` symlink (`node_modules ->../candidate/
// node_modules`) and may contain broken workspace symlinks. The safe
// repository reader skips symlinks in dev mode (HARNESS_REJECT_SYMLINKS=0)
// and the evidence session resolves the `node_modules` symlink to its real
// path before walking. Symlink rejection is verified by the dedicated
// security tests, which leave the env var unset so the production floor
// is enforced.
const WORKER_PATH = FOUNDATION_CASCADE_TEST_WORKER_PATH;
const SOURCE_AUTHORITY = PLANNED_NODE_TEST_SOURCE_AUTHORITY.suites.foundationCascade;
const CATALOG_PATH = SOURCE_AUTHORITY.catalog.path;
const SHARED_EXECUTOR_PATH = PLANNED_NODE_TEST_SOURCE_AUTHORITY.shared.executor.path;

sweepFoundationCascadeResidue(dirname(SHARED_EXECUTOR_PATH));
sweepFoundationCascadeResidue(dirname(CATALOG_PATH));

after(() => {
  sweepFoundationCascadeResidue(dirname(SHARED_EXECUTOR_PATH));
  sweepFoundationCascadeResidue(dirname(CATALOG_PATH));
});

function sweepFoundationCascadeResidue(directory: string): void {
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".foundation-cascade-")) {
      rmSync(resolve(directory, entry), { force: true });
    }
  }
}
const EXPECTED_TEST_NAMES = FOUNDATION_CASCADE_TEST_CATALOG.map((entry) =>
  `[${entry.id}] ${entry.name}`
);
const HOSTILE_ENVIRONMENTS = [
  {
    FOUNDATION_TEST_VARIANT: "0",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    NODE_TEST_CONTEXT: "hostile-parent-context-must-not-propagate",
  },
  {
    FOUNDATION_TEST_VARIANT: "1",
    LANG: "fr_CA.UTF-8",
    LC_ALL: "fr_CA.UTF-8",
    TZ: "America/Toronto",
  },
  {
    FOUNDATION_TEST_VARIANT: "2",
    LANG: "tr_TR.UTF-8",
    LC_ALL: "tr_TR.UTF-8",
    TZ: "Asia/Tokyo",
  },
] as const;

const SOURCE_BINDINGS = [
  SOURCE_AUTHORITY.worker,
  SOURCE_AUTHORITY.catalog,
  PLANNED_NODE_TEST_SOURCE_AUTHORITY.shared.executor,
  PLANNED_NODE_TEST_SOURCE_AUTHORITY.shared.evidenceExecutor,
] as const;
const SUITE_SPEC = createPlannedNodeTestSuiteSpec({
  suiteId: "foundation-cascade",
  declarationIdentity: FOUNDATION_CASCADE_TEST_DECLARATION_IDENTITY,
  plannedCatalogIdentity: FOUNDATION_CASCADE_TEST_CATALOG_IDENTITY,
  expectedTestNames: EXPECTED_TEST_NAMES,
  sources: SOURCE_BINDINGS,
});

test("[FC-E001] shared evidence owns exact cascade catalog across three hostile runtimes", async () => {
  assert.equal(WORKER_PATH, "test/support/foundation-cascade-hostile-worker.test.ts");
  assert.deepEqual(discoverTestNames(readFileSync(WORKER_PATH, "utf8")), EXPECTED_TEST_NAMES);
  assert.deepEqual(SOURCE_BINDINGS.map((binding) =>
    createPlannedNodeTestSourceBinding(ROOT, binding.role, binding.path)
  ), SOURCE_BINDINGS);
  assert.equal(new Set(EXPECTED_TEST_NAMES).size, EXPECTED_TEST_NAMES.length);
  assert.match(SUITE_SPEC.catalogIdentity, /^[0-9a-f]{64}$/u);
  assert.equal(SUITE_SPEC.repositoryAdmissionAllowed, false);

  const identities: string[] = [];
  const session = createPlannedNodeTestEvidenceSession(SUITE_SPEC);
  try {
    const accept = (observation: Awaited<ReturnType<typeof session.run>>): void => {
      assert.equal(observation.accepted, true, JSON.stringify({
        violations: observation.violations,
        diagnostics: observation.diagnostics,
      }));
      assert.ok(observation.evidence);
      assert.equal(observation.diagnostics.sourceSnapshotIdentity, session.sourceSnapshotIdentity);
      identities.push(plannedNodeTestReproducibilityIdentity(observation.evidence));
    };
    const firstRun = session.run({ ...process.env, ...HOSTILE_ENVIRONMENTS[0] });
    await assert.rejects(
      session.run({ ...process.env, ...HOSTILE_ENVIRONMENTS[1] }),
      /planned_node_test_session_concurrent_run/u,
    );
    accept(await firstRun);
    for (const environment of HOSTILE_ENVIRONMENTS.slice(1)) {
      accept(await session.run({ ...process.env, ...environment }));
    }
  } finally {
    session.close();
  }
  assert.deepEqual(identities.slice(1), [identities[0], identities[0]]);
  assert.deepEqual(Object.keys(foundationCascadePublic).toSorted(), [
    "FOUNDATION_CASCADE_SCHEMA_VERSION",
    "FOUNDATION_COMPILER_REVISION",
    "FOUNDATION_EXPECTED_OUTPUTS",
    "FOUNDATION_GENERATION_LOCK_PATH",
    "FOUNDATION_GENERATION_LOCK_SCHEMA_VERSION",
    "FOUNDATION_STAGE_REGISTRY",
    "FOUNDATION_STAGE_REGISTRY_IDENTITY",
    "FOUNDATION_UTF8_ORDERING_RULE",
    "buildFoundationGenerationLock",
    "compileFoundationPlan",
    "parseUntrustedFoundationGenerationLockBytes",
    "parseUntrustedFoundationPlanBytes",
    "validateFoundationDag",
    "validateFoundationGenerationLockCandidate",
    "validateFoundationPlanCandidate",
  ]);
});

test("[FC-E002] worker catalog executor and output mutations cannot fabricate evidence", async () => {
  // Materialize the base source snapshot ONCE + share it across all 10
  // mutations. Each mutation patches exactly one file (the mutated worker,
  // catalog, or shared executor) in a reflink copy of the base, then runs
  // the child subprocess on the patched snapshot. This collapses 10 × full
  // materializations (each doing a full repository tree walk + file copy +
  // dependency copy + git init) into 1 × materialize + 10 × (reflink + 1
  // file patch + git amend). The invariants are unchanged: each mutation
  // still runs in an isolated snapshot with its own git commit + child
  // subprocess + full evidence validation; only the redundant
  // re-materialization of the identical base tree is shared.
  const baseSession = createPlannedNodeTestEvidenceSession(SUITE_SPEC);
  try {
    const baseSourceSnapshotRoot = baseSession.sourceSnapshotRoot;
    const inventory = baseSession.inventory();
    const outputOnly = createInventoryTestAccountant(ROOT, inventory).complete();
    assert.equal(outputOnly.passed, false);
    assert.equal(outputOnly.counts.discovered, 0);
    assert.equal(outputOnly.counts.passed, 0);

    const worker = readFileSync(WORKER_PATH, "utf8");
    const firstRegistration =
      "test(\"[FC-C001] closed registry and exact output authority\", (context) => execute(\"FC-C001\", context));";
    const secondRegistration =
      "test(\"[FC-C002] truthful blocked and unavailable production plan\", (context) => execute(\"FC-C002\", context));";
    const workerMutations = [
      ["omitted-registration", replaceExactly(worker, firstRegistration, "")],
      ["renamed-registration", replaceExactly(worker,
        "[FC-C001] closed registry and exact output authority",
        "[FC-RENAMED] closed registry and exact output authority")],
      ["duplicate-registration", replaceExactly(worker, secondRegistration, firstRegistration)],
      ["skipped-registration", replaceExactly(worker, firstRegistration,
        "test(\"[FC-C001] closed registry and exact output authority\", { skip: true }, (context) => execute(\"FC-C001\", context));")],
      ["executor-bypass", replaceExactly(worker,
        "(context) => execute(\"FC-C001\", context)", "() => {}")],
      ["fake-json-tap", replaceExactly(worker,
        "(context) => execute(\"FC-C001\", context)",
        "() => { process.stdout.write(\"ok 999 - [FC-C001]\\n{}\\n\"); }")],
    ] as const;
    // Each mutation patches a reflink copy of the shared base (unique UUID
    // relative path so there is no collision), then runs its own child
    // subprocess + evidence validation. The mutations are fully independent
    // (own patched root, own session, own isolated run root), so they run
    // concurrently: 6 sequential materialize+child phases collapse into one
    // parallel batch bounded by the slowest.
    await Promise.all(workerMutations.map(([id, source]) =>
      assertWorkerMutationRejected(id, source, baseSourceSnapshotRoot)));

    const catalog = readFileSync(CATALOG_PATH, "utf8");
    const sharedExecutor = readFileSync(SHARED_EXECUTOR_PATH, "utf8");
    const boundSourceMutations = [
      {
        id: "no-op-callback",
        role: "catalog" as const,
        path: CATALOG_PATH,
        source: replaceExactly(catalog,
          "run: (invoke) => invoke(assertionId, callback),",
          "run: (_invoke) => { void _invoke; },"),
      },
      {
        id: "no-op-domain-oracle",
        role: "catalog" as const,
        path: CATALOG_PATH,
        source: replaceExactly(catalog,
          "family(\"FC-C001\", \"closed registry and exact output authority\", \"authority-closure\", (check) => {\n    check(() => {",
          "family(\"FC-C001\", \"closed registry and exact output authority\", \"authority-closure\", (check) => {\n    check(() => { return;"),
      },
      {
        id: "assertion-omission",
        role: "shared-executor" as const,
        path: SHARED_EXECUTOR_PATH,
        source: replaceExactly(sharedExecutor, "  assertion();", "  void assertion;"),
      },
      {
        id: "plan-omission",
        role: "shared-executor" as const,
        path: SHARED_EXECUTOR_PATH,
        source: replaceExactly(sharedExecutor,
          "  context.plan(entry.assertionPlan.reduce((count, assertion) => count + assertion.checks + 2, 0));",
          "  void context;"),
      },
    ] as const;
    // Same pattern: 4 bound-source mutations patch reflink copies of the
    // shared base + run concurrently.
    await Promise.all(boundSourceMutations.map((mutation) => assertBoundSourceMutationRejected(
      mutation.id,
      mutation.role,
      mutation.path,
      mutation.source,
      baseSourceSnapshotRoot,
    )));
  } finally {
    baseSession.close();
  }
});

test("[FC-E003] trusted plan type boundary retains compile-time hostile probes", () => {
  const source = readFileSync(resolve("test/types/foundation-cascade-trust-boundary.ts"), "utf8");
  assert.match(source, /@ts-expect-error parsed candidates are not trusted plans/u);
  assert.match(source, /@ts-expect-error structural clones are not trusted plans/u);
  assert.match(source, /@ts-expect-error serialized values are unknown and not trusted plans/u);
});


test("[FC-E004] source snapshot copy failures retain their original error and bounded diagnostics", () => {
  // Existing builtin fault adapter and canonical sinks live in one native-supervised child;
  // no fs patch or logger configuration can escape into another test file.
  const script = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
const [root, specText] = process.argv.slice(1);
const load = (path) => import(pathToFileURL(join(root, path)).href);
(await load("src/runtime/cli-debug.ts")).bootstrapProcess({ role: "cli" });
const { createPlannedNodeTestEvidenceSession } = await load("test/support/planned-node-test-evidence.ts");
const { configureDebugSystem, resetDebugSystem, createCollectingSink, createConsoleSink, getDebugSignals } = await load("src/shared/debug/debug-system.ts");
const { DEBUG_CONFIG_DEFAULTS } = await load("src/shared/debug/debug-config.ts");
const { currentAdmittedNodeRuntimeRecord, admittedNodeRuntimeAdmissionRecordIdentity } = await load("src/runtime/admitted-node-runtime.ts");
const { sha256 } = await load("src/kernel/integrity.ts");
const spec = JSON.parse(specText);
const base = createPlannedNodeTestEvidenceSession(spec);
const native = { cpSync: fs.cpSync, lstatSync: fs.lstatSync, stderrWrite: process.stderr.write };
const secret = "SYNTHETIC_COPY_DIAGNOSTIC_SECRET";
const outcomes = [];
try {
  const positive = createPlannedNodeTestEvidenceSession(spec, { preMaterializedSourceSnapshotRoot: base.sourceSnapshotRoot });
  try {
    assert.equal(positive.sourceSnapshotIdentity, base.sourceSnapshotIdentity);
    for (const file of ["HEAD", "index"]) assert.deepEqual(fs.readFileSync(join(positive.sourceSnapshotRoot, ".git", file)), fs.readFileSync(join(base.sourceSnapshotRoot, ".git", file)));
  } finally { positive.close(); }
  for (const mode of ["missing-destination", "observation-unavailable", "reporter-failure"]) {
    const sink = createCollectingSink();
    configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { ...DEBUG_CONFIG_DEFAULTS.sinks, enabledSinks: ["console", "collecting"] } }, mode === "reporter-failure" ? [createConsoleSink(), sink] : [sink]);
    const cause = Object.freeze({ marker: secret });
    const sentinel = Object.assign(new Error(secret), { code: "ENOENT", errno: -2, syscall: "cp", cause });
    let selectedDestination, faults = 0, getters = 0, inNativeCopy = false, caught;
    Object.defineProperty(sentinel, "src", { get() { getters++; throw new Error(secret); } });
    Object.defineProperty(sentinel, "arbitrarySecret", { get() { getters++; throw new Error(secret); } });
    fs.cpSync = function (source, destination, ...options) {
      if (source !== base.sourceSnapshotRoot) return Reflect.apply(native.cpSync, this, [source, destination, ...options]);
      inNativeCopy = true;
      try { Reflect.apply(native.cpSync, this, [source, destination, ...options]); }
      finally { inNativeCopy = false; }
      selectedDestination = destination;
      const objects = join(destination, ".git/objects");
      assert.equal(native.lstatSync(objects).isDirectory(), true, "the real copy must have populated Git objects before the diagnostic fault");
      fs.renameSync(objects, objects + ".retained-by-control");
      Object.assign(sentinel, { path: objects, dest: objects });
      faults++;
      throw sentinel;
    };
    fs.lstatSync = function (path, ...options) {
      if (mode === "observation-unavailable" && !inNativeCopy && path === join(base.sourceSnapshotRoot, ".git/objects")) throw Object.assign(new Error(secret), { code: "EACCES" });
      return Reflect.apply(native.lstatSync, this, [path, ...options]);
    };
    if (mode === "reporter-failure") process.stderr.write = function () { throw Object.assign(new Error(secret), { code: "EIO" }); };
    syncBuiltinESMExports();
    try {
      try { createPlannedNodeTestEvidenceSession(spec, { preMaterializedSourceSnapshotRoot: base.sourceSnapshotRoot }); }
      catch (error) { caught = error; }
      assert.equal(faults, 1);
      assert.equal(caught, sentinel, "the exact copy error, not a diagnostic/cleanup replacement, reaches the caller");
      assert.equal(caught.cause, cause);
      assert.equal(caught.code, "ENOENT");
      assert.equal(caught.path, join(selectedDestination, ".git/objects"));
      assert.equal(getters, 0, "diagnostics cannot invoke arbitrary or native-field accessors");
      assert.equal(native.lstatSync(join(selectedDestination, ".."), { throwIfNoEntry: false }), undefined, "the failed session still performs its owned cleanup");
      // On the old helper the same copy failure occurs, then the diagnostic assertion below fails.
      process.stdout.write(JSON.stringify({ mode, faultReached: true, originalErrorPreserved: true, originalCausePreserved: true, copyAccepted: false }) + "\n");
      if (mode === "reporter-failure") {
        assert.ok(getDebugSignals().sinkWriteFailures > 0, "canonical reporting records the failed sink without replacing the copy error");
      } else {
        const events = sink.events.filter((event) => event.message === "planned Node source snapshot copy failed");
        assert.equal(events.length, 1, "one canonical diagnostic must accompany the still-failing copy");
        const detail = events[0].context;
        assert.equal(detail.phase, "session");
        assert.equal(detail.operation, "copy");
        assert.equal(detail.before.destination.objects.kind, "absent");
        assert.equal(detail.after.destination.objects.kind, "absent");
        assert.equal(detail.after.destination.root.kind, "directory");
        assert.equal(detail.after.destination.git.kind, "directory");
        assert.equal(detail.after.source.objects.kind, mode === "observation-unavailable" ? "unavailable" : "directory");
        assert.equal(detail.after.source.relativeObjectsPath, ".git/objects");
        assert.equal(detail.after.source.parsedOwner.pid, process.pid);
        assert.equal(detail.after.source.retainedByCanonicalLivenessRule, true);
        assert.equal(detail.after.currentOwner.pid, process.pid);
        const runtime = currentAdmittedNodeRuntimeRecord();
        assert.equal(detail.after.admittedRuntimeRecordIdentity, runtime === undefined ? null : admittedNodeRuntimeAdmissionRecordIdentity(runtime));
        assert.equal(detail.after.admittedRuntimeExecutableIdentity, runtime?.executableIdentityHash ?? null);
        assert.equal(detail.failure.code, "ENOENT");
        assert.equal(detail.failure.errno, -2);
        assert.equal(detail.failure.syscallSha256, sha256("cp"));
        assert.equal(detail.failure.pathRole, "destination-objects");
        assert.equal(detail.failure.destinationRole, "destination-objects");
        assert.equal(detail.failure.sourceRole, null);
        const text = JSON.stringify(detail);
        assert.equal(text.includes(secret), false);
        assert.equal(text.includes(root), false, "only fixed relative roles, never arbitrary root paths, are reported");
      }
      outcomes.push({ mode, originalErrorPreserved: true, copyAccepted: false });
    } finally {
      fs.cpSync = native.cpSync;
      fs.lstatSync = native.lstatSync;
      process.stderr.write = native.stderrWrite;
      syncBuiltinESMExports();
      resetDebugSystem();
    }
  }
} finally {
  fs.cpSync = native.cpSync;
  fs.lstatSync = native.lstatSync;
  process.stderr.write = native.stderrWrite;
  syncBuiltinESMExports();
  resetDebugSystem();
  base.close();
}
process.stdout.write(JSON.stringify({ outcomes, realSnapshotIdentityPreserved: true }) + "\n");
`;
  const bounds = configuredSubprocessBounds();
  const ran = runBoundedTestProcess(ensureTestProcessSupervisor(), process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script, ROOT, JSON.stringify(SUITE_SPEC)],
    { cwd: ROOT, env: process.env, timeoutMs: bounds.hangBackstopMs, killGraceMs: bounds.killGraceMs });
  assert.equal(ran.status, 0, JSON.stringify({ status: ran.status, signal: ran.signal, stdout: ran.stdout, stderr: redactDiagnosticText(ran.stderr) }));
  assert.equal(ran.signal, null);
  assert.equal(ran.error, undefined);
  assert.equal(ran.supervision.timedOut, false);
  assert.equal(ran.supervision.interrupted, false);
  assert.equal(ran.supervision.noOwnedChildren, true);
  assert.deepEqual(JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "null"), {
    outcomes: ["missing-destination", "observation-unavailable", "reporter-failure"].map((mode) => ({ mode, originalErrorPreserved: true, copyAccepted: false })),
    realSnapshotIdentityPreserved: true,
  });
});

async function assertWorkerMutationRejected(
  id: string,
  source: string,
  baseSourceSnapshotRoot: string,
): Promise<void> {
  const relativePath = `test/support/foundation-cascade-${id}-${randomUUID()}.test.ts`;
  const patchedRoot = patchPlannedNodeTestSourceSnapshot(baseSourceSnapshotRoot, relativePath, source);
  try {
    const mutantSpec = createPlannedNodeTestSuiteSpec({
      suiteId: SUITE_SPEC.suiteId,
      declarationIdentity: SUITE_SPEC.declarationIdentity,
      plannedCatalogIdentity: SUITE_SPEC.plannedCatalogIdentity,
      expectedTestNames: SUITE_SPEC.expectedTestNames,
      sources: SUITE_SPEC.sources.map((binding) => binding.role === "worker"
        ? { ...binding, path: relativePath }
        : binding),
    });
    const observation = await runPlannedNodeTestSuiteWithEvidence(
      mutantSpec,
      { ...process.env, ...HOSTILE_ENVIRONMENTS[0] },
      { preMaterializedSourceSnapshotRoot: patchedRoot },
    );
    assert.equal(observation.accepted, false, `${id} fabricated acceptance`);
    assert.ok(observation.execution, `${id} did not create an immutable recorded attempt`);
  } finally {
    removePlannedNodeTestSourceSnapshotPatch(patchedRoot);
  }
}

async function assertBoundSourceMutationRejected(
  id: string,
  role: "catalog" | "shared-executor",
  canonicalPath: string,
  source: string,
  baseSourceSnapshotRoot: string,
): Promise<void> {
  const extension = canonicalPath.endsWith(".ts") ? ".ts" : "";
  const relativePath = relative(ROOT, resolve(
    dirname(canonicalPath),
    `.foundation-cascade-${id}-${randomUUID()}${extension}`,
  )).replaceAll("\\", "/");
  const patchedRoot = patchPlannedNodeTestSourceSnapshot(baseSourceSnapshotRoot, relativePath, source);
  try {
    const mutantSpec = createPlannedNodeTestSuiteSpec({
      suiteId: SUITE_SPEC.suiteId,
      declarationIdentity: SUITE_SPEC.declarationIdentity,
      plannedCatalogIdentity: SUITE_SPEC.plannedCatalogIdentity,
      expectedTestNames: SUITE_SPEC.expectedTestNames,
      sources: SUITE_SPEC.sources.map((binding) => binding.role === role
        ? { ...binding, path: relativePath }
        : binding),
    });
    const observation = await runPlannedNodeTestSuiteWithEvidence(
      mutantSpec,
      { ...process.env, ...HOSTILE_ENVIRONMENTS[0] },
      { preMaterializedSourceSnapshotRoot: patchedRoot },
    );
    assert.equal(observation.accepted, false, `${id} fabricated acceptance`);
    assert.ok(observation.execution, `${id} did not create an immutable recorded attempt`);
  } finally {
    removePlannedNodeTestSourceSnapshotPatch(patchedRoot);
  }
}

function replaceExactly(source: string, target: string, replacement: string): string {
  assert.equal(source.split(target).length - 1, 1, `mutation target is not unique: ${target}`);
  return source.replace(target, replacement);
}
