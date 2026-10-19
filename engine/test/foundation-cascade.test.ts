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
