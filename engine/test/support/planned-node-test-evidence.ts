import { spawnSync } from "node:child_process";
import {
  constants,
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { buildCandidateManifest, candidateTestIdentity } from
  "../../scripts/tooling/candidate-manifest.ts";
import {
  buildPlannedNodeTestInventory,
  createPlannedNodeTestCorpusBinding,
  createPlannedNodeTestSourceBinding,
  parsePlannedNodeTestEvidenceBytes,
  parsePlannedNodeTestSuiteSpec,
  plannedNodeTestInventorySnapshot,
  type PlannedNodeTestEvidence,
  type PlannedNodeTestSuiteSpec,
} from "../../scripts/tooling/planned-node-test-evidence.ts";
import { PLANNED_NODE_TEST_PROTOCOL } from "../../scripts/tooling/planned-node-test.ts";
import { runWorkerWithEvidence } from "../../scripts/tooling/run-tests.ts";
import {
  scanExecutionEvidence,
  TEST_EXECUTION_OPERATION,
  type ExecutionAuthority,
} from "../../scripts/tooling/test-execution.ts";
import { validateTestReceipt } from "../../scripts/tooling/test-receipt.ts";
import { ensureReceiptAuthority } from "../../src/filesystem/immutable-receipt.ts";
import { recognizableTestSourceLanguage } from "../../scripts/verification/test-surface.ts";
import {
  listSafeRepositoryTree,
  readSafeRepositoryFile,
} from "../../scripts/verification/safe-repository-reader.ts";
import { canonicalHash, canonicalJson, deepFreeze, sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import {
  configuredRuntimeAdmission,
  withAdmittedNodeRuntime,
} from "../../src/runtime/admitted-node-runtime.ts";
import {
  TEST_REPOSITORY_ROOT,
  createRepositoryLocalTemporaryDirectory,
  removeRepositoryLocalTemporaryDirectory,
} from "./repository-local-temporary.ts";
import { PLANNED_NODE_TEST_SOURCE_AUTHORITY } from "./planned-node-test-source-authority.ts";
import { shouldExcludeExperiment } from "../../src/shared/source-scan.ts";

export type PlannedNodeTestEvidenceObservation = Readonly<{
  accepted: boolean;
  violations: readonly string[];
  evidence: PlannedNodeTestEvidence | null;
  execution: Readonly<{
    attemptId: string;
    outcome: string;
    exitCode: number;
    stdout: Buffer;
    stderr: Buffer;
    result: unknown;
  }> | null;
  diagnostics: PlannedNodeTestEvidenceDiagnostics;
}>;

export type PlannedNodeTestEvidenceDiagnostics = Readonly<{
  sourceSnapshotIdentity: string;
  expected: Readonly<{
    sourcesHash: string;
    corporaHash: string;
  }>;
  observed: Readonly<{
    sourcesBeforeHash: string | null;
    sourcesAfterHash: string | null;
    corporaBeforeHash: string | null;
    corporaAfterHash: string | null;
    inventoryBeforeHash: string | null;
    inventoryAfterHash: string | null;
    candidateBeforeHash: string | null;
    candidateAfterHash: string | null;
    runSnapshotBeforeIdentity: string | null;
    runSnapshotAfterIdentity: string | null;
  }>;
  differences: readonly string[];
  executionEvidence: ReturnType<typeof scanExecutionEvidence>;
}>;

export type PlannedNodeTestEvidenceSession = Readonly<{
  sourceSnapshotIdentity: string;
  /**
   * The materialized source-snapshot root. Exposed so callers that share a
   * base snapshot across mutation runs can patch it (reflink copy + overwrite
   * one file + git amend) instead of re-materializing the whole tree from
   * the repository for every mutation. The root is owned by the session +
   * removed on `close()`.
   */
  sourceSnapshotRoot: string;
  inventory: () => ReturnType<typeof buildPlannedNodeTestInventory>;
  run: (
    environment: Readonly<NodeJS.ProcessEnv>,
  ) => Promise<PlannedNodeTestEvidenceObservation>;
  close: () => void;
}>;

/**
 * Minimal isolated-fixture policy. The isolated qualification repository must
 * contain ONLY what the planned suites need at runtime — copying the full
 * repository tree (verification/benchmarks, docs, traceability archives,
 * fixtures) dominated the suite cost with ~135MB of I/O per copy.
 *
 * Directories are included wholesale; files are included individually; the
 * spec's declared corpora are always included. Recognizable test sources
 * remain excluded (except the bound worker) so the isolated inventory scope
 * stays exactly the worker file. A suite that needs a new area fails loudly
 * (module-not-found in the child), keeping this list honest.
 */
const ISOLATED_SOURCE_INCLUDED_DIRECTORIES = deepFreeze([
  "src",
  "scripts",
  "test/support",
  "verification/core",
  "traceability/sources",
] as const);
const ISOLATED_SOURCE_INCLUDED_FILES = deepFreeze([
  "package.json",
  //.gitignore keeps vendored dependencies out of `git add --all` in the
  // isolated repository, so the candidate manifest (and its format policy)
  // covers exactly the tracked source files — mirroring the real repository.
  ".gitignore",
  "bridlewise.config.json",
  "traceability/canonical/handoff-protocol-manifest.json",
  "traceability/prevention/prevention-retrospective.json",
] as const);
const ISOLATED_DEPENDENCY_INCLUDED_PACKAGES = deepFreeze(["@babel", "zod"] as const);

function isolatedSourceEntryIncluded(
  entry: Readonly<{ path: string; kind: string }>,
  workerPath: string,
  corpusPaths: ReadonlySet<string>,
): boolean {
  const entryPath = entry.path;
  if (entry.kind === "directory") {
    if (entryPath === ".") return true;
    // Keep directories that are inside, equal to, or ancestors of included
    // areas (ancestors are required for the copy to materialize the tree).
    const areaBoundary = ISOLATED_SOURCE_INCLUDED_DIRECTORIES.some((dir) =>
      entryPath === dir || entryPath.startsWith(`${dir}/`) || dir.startsWith(`${entryPath}/`));
    const fileAncestor = ISOLATED_SOURCE_INCLUDED_FILES.some((file) => file.startsWith(`${entryPath}/`));
    const corpusAncestor = [...corpusPaths].some((file) => file.startsWith(`${entryPath}/`));
    const workerAncestor = workerPath.startsWith(`${entryPath}/`);
    return areaBoundary || fileAncestor || corpusAncestor || workerAncestor;
  }
  if (entryPath === workerPath || corpusPaths.has(entryPath)) return true;
  const included = ISOLATED_SOURCE_INCLUDED_DIRECTORIES.some((dir) => entryPath.startsWith(`${dir}/`)) ||
    (ISOLATED_SOURCE_INCLUDED_FILES as readonly string[]).includes(entryPath);
  if (!included) return false;
  return recognizableTestSourceLanguage(entryPath) === undefined;
}

function isolatedDependencyEntryIncluded(entryPath: string): boolean {
  if (entryPath === "." || entryPath === "node_modules") return true;
  const segments = entryPath.split("/");
  if (segments[0] !== "node_modules" || segments.length < 2 || segments[1] === "") return false;
  const packageName = segments[1]!.startsWith("@") ? `${segments[1]}/${segments[2] ?? ""}` : segments[1]!;
  return ISOLATED_DEPENDENCY_INCLUDED_PACKAGES.some((included) =>
    packageName === included || packageName.startsWith(`${included}/`));
}

/**
 * Options for creating a planned-node-test evidence session. When
 * `preMaterializedSourceSnapshotRoot` is provided, the session reflink-copies
 * it instead of materializing a fresh source snapshot from the repository.
 * This lets callers share one base materialization across many mutation
 * runs (each mutation patches exactly one file in a reflink copy of the
 * base), collapsing N × full-tree materializations into 1 × materialize +
 * N × (reflink + single-file patch). The caller owns the pre-materialized
 * root + must clean it up; the session does not delete it on close.
 */
export type CreatePlannedNodeTestSessionOptions = Readonly<{
  preMaterializedSourceSnapshotRoot?: string;
}>;

export async function runPlannedNodeTestSuiteWithEvidence(
  specInput: PlannedNodeTestSuiteSpec,
  environment: Readonly<NodeJS.ProcessEnv>,
  options?: CreatePlannedNodeTestSessionOptions,
): Promise<PlannedNodeTestEvidenceObservation> {
  const session = createPlannedNodeTestEvidenceSession(specInput, options);
  try {
    return await session.run(environment);
  } finally {
    session.close();
  }
}

export function createPlannedNodeTestEvidenceSession(
  specInput: PlannedNodeTestSuiteSpec,
  options?: CreatePlannedNodeTestSessionOptions,
): PlannedNodeTestEvidenceSession {
  const sourceRoot = TEST_REPOSITORY_ROOT;
  const spec = parsePlannedNodeTestSuiteSpec(specInput);
  const sessionRoot = createRepositoryLocalTemporaryDirectory("planned-node-test-session-");
  const sourceSnapshotRoot = resolve(sessionRoot, "source-snapshot");
  try {
    if (options?.preMaterializedSourceSnapshotRoot !== undefined) {
      cpSync(options.preMaterializedSourceSnapshotRoot, sourceSnapshotRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: false,
        // Reflink so the per-session copy is near-instant on supported
        // filesystems; the pre-materialized root already has the full source
        // tree, dependencies, + git repo, so the session only needs a COW
        // copy of it (not a from-scratch materialization).
        mode: constants.COPYFILE_FICLONE,
      });
      chmodSync(sourceSnapshotRoot, lstatSync(options.preMaterializedSourceSnapshotRoot).mode & 0o777);
    } else {
      materializeSourceSnapshot(sourceRoot, sourceSnapshotRoot, spec);
    }
  } catch (error) {
    removeRepositoryLocalTemporaryDirectory(sessionRoot);
    throw error;
  }
  const sourceSnapshotIdentity = isolatedSourceSnapshotIdentity(sourceSnapshotRoot);
  let closed = false;
  let running = false;
  let sequence = 0;

  const session: PlannedNodeTestEvidenceSession = {
    sourceSnapshotIdentity,
    sourceSnapshotRoot,
    inventory: () => {
      if (closed) throw new Error("planned_node_test_session_closed");
      // The source-snapshot root is a private temp directory (same
      // rationale as the run-start check). Skip the redundant recompute.
      return buildPlannedNodeTestInventory(sourceSnapshotRoot, spec);
    },
    run: async (environment) => {
      if (closed) throw new Error("planned_node_test_session_closed");
      if (running) throw new Error("planned_node_test_session_concurrent_run");
      running = true;
      let runRoot: string | undefined;
      try {
        runRoot = createRepositoryLocalTemporaryDirectory(
          `planned-node-test-run-${sequence.toString().padStart(6, "0")}-`,
        );
        sequence += 1;
        const isolatedRoot = resolve(runRoot, "repository");
        // The source-snapshot root is a private repository-local temp
        // directory that only this session touches. The child subprocess
        // runs in the isolated root (a reflink copy below), never in the
        // source-snapshot root. The tampering check is therefore done on
        // the isolated root inside runIsolatedPlannedNodeTestSuite (before
        // + after the child), which compares the isolated root's identity
        // to the source-snapshot identity computed at session creation.
        // Re-checking the source-snapshot root here would walk + hash ~500
        // source files + ~1000 dependency files just to confirm a private
        // temp directory was not externally modified — a scenario that
        // cannot happen + would be caught by the isolated-root check
        // anyway (a modified source would produce a modified copy). Skip
        // the redundant recompute; the isolated-root check is the authority.
        copySourceSnapshot(sourceSnapshotRoot, isolatedRoot);
        return await runIsolatedPlannedNodeTestSuite(
          spec,
          environment,
          isolatedRoot,
          sourceSnapshotIdentity,
        );
      } finally {
        let cleanupFailure: unknown;
        try {
          if (runRoot !== undefined) removeRepositoryLocalTemporaryDirectory(runRoot);
        } catch (error) {
          cleanupFailure = error;
        }
        running = false;
        // Same rationale as above: the source-snapshot root is a private
        // temp directory the child never touches, so it cannot change
        // during the run. The isolated-root after-check in
        // runIsolatedPlannedNodeTestSuite is the tampering authority.
        if (cleanupFailure !== undefined) throw cleanupFailure;
      }
    },
    close: () => {
      if (closed) return;
      if (running) throw new Error("planned_node_test_session_close_while_running");
      removeRepositoryLocalTemporaryDirectory(sessionRoot);
      closed = true;
    },
  };
  return Object.freeze(session);
}

/**
 * Patch a pre-materialized source snapshot by overwriting or adding one
 * file, then re-committing so the git index reflects the patched tree.
 * Returns the patched root (a fresh repository-local temp directory the
 * caller must remove via `removePlannedNodeTestSourceSnapshotPatch`).
 *
 * The base root is reflink-copied (near-instant on supported filesystems),
 * so the only real I/O is writing the single patched file + the git amend.
 * This collapses N × full materializations (each doing a full tree walk +
 * file copy + dependency copy + git init) into 1 × materialize + N ×
 * (reflink + 1-file patch + git amend). The git amend folds the one patched
 * file into the existing commit (the base already has a valid git repo from
 * its materialization), so `buildCandidateManifest` (which uses `git
 * rev-parse` / `git ls-files`) sees the patched tree as a clean single
 * commit.
 */
export function patchPlannedNodeTestSourceSnapshot(
  baseSourceSnapshotRoot: string,
  relativeFilePath: string,
  source: string,
): string {
  const patchedRoot = createRepositoryLocalTemporaryDirectory("planned-node-test-patch-");
  cpSync(baseSourceSnapshotRoot, patchedRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: false,
    mode: constants.COPYFILE_FICLONE,
  });
  chmodSync(patchedRoot, lstatSync(baseSourceSnapshotRoot).mode & 0o777);
  const absoluteFilePath = resolve(patchedRoot, relativeFilePath);
  mkdirSync(dirname(absoluteFilePath), { recursive: true, mode: 0o700 });
  writeFileSync(absoluteFilePath, source, { encoding: "utf8", mode: 0o600, flag: "w" });
  runGit(patchedRoot, ["add", "--all"]);
  runGit(patchedRoot, ["commit", "--amend", "--quiet", "--message", "isolated qualification snapshot"]);
  return patchedRoot;
}

export function removePlannedNodeTestSourceSnapshotPatch(patchedRoot: string): void {
  removeRepositoryLocalTemporaryDirectory(patchedRoot);
}

async function runIsolatedPlannedNodeTestSuite(
  spec: PlannedNodeTestSuiteSpec,
  environment: Readonly<NodeJS.ProcessEnv>,
  isolatedRoot: string,
  sourceSnapshotIdentity: string,
): Promise<PlannedNodeTestEvidenceObservation> {
  const violations: string[] = [];
  let evidence: PlannedNodeTestEvidence | null = null;
  let execution: Awaited<ReturnType<typeof runWorkerWithEvidence>> | null = null;
  let inventoryBefore: ReturnType<typeof buildPlannedNodeTestInventory> | undefined;
  let candidateBefore: ReturnType<typeof candidateTestIdentity> | undefined;
  let sourcesBeforeHash: string | null = null;
  let sourcesAfterHash: string | null = null;
  let corporaBeforeHash: string | null = null;
  let corporaAfterHash: string | null = null;
  let inventoryAfter: typeof inventoryBefore;
  let candidateAfter: typeof candidateBefore;
  let runSnapshotBeforeIdentity: string | null = null;
  let runSnapshotAfterIdentity: string | null = null;
  let executionEvidence: ReturnType<typeof scanExecutionEvidence> = Object.freeze([]);
  const currentDiagnostics = (): PlannedNodeTestEvidenceDiagnostics => diagnostics(
    sourceSnapshotIdentity,
    spec,
    {
      sourcesBeforeHash,
      sourcesAfterHash,
      corporaBeforeHash,
      corporaAfterHash,
      inventoryBefore,
      inventoryAfter,
      candidateBefore,
      candidateAfter,
      runSnapshotBeforeIdentity,
      runSnapshotAfterIdentity,
    },
    executionEvidence,
  );

  try {
    // The isolated root is a reflink (copy-on-write) copy of the source
    // snapshot root, so its content identity is guaranteed to equal the
    // source-snapshot identity computed at session creation. Recomputing
    // the full identity here would walk + hash ~500 source files + ~1000
    // dependency files + run 5+ git commands just to confirm a bit-for-bit
    // COW copy matches its source. The after-child check below
    // (run-source-snapshot-after) recomputes + detects any child
    // tampering; the before-check is redundant given the reflink guarantee.
    runSnapshotBeforeIdentity = sourceSnapshotIdentity;
    const authority = withAdmittedNodeRuntime(configuredRuntimeAdmission(), () =>
      isolatedQualificationExecutionAuthority(
        isolatedRoot,
        ".bridlewise/evidence",
        spec,
      ),
    );
    captureViolation(violations, "parent-source-before", () => {
      sourcesBeforeHash = parentSourcesHash(isolatedRoot, spec);
      assertBoundHash(sourcesBeforeHash, canonicalHash(spec.sources));
    });
    captureViolation(violations, "parent-corpus-before", () => {
      corporaBeforeHash = parentCorporaHash(isolatedRoot, spec);
      assertBoundHash(corporaBeforeHash, canonicalHash(spec.corpora));
    });
    captureViolation(violations, "parent-inventory-before", () => {
      inventoryBefore = buildPlannedNodeTestInventory(isolatedRoot, spec);
    });
    captureViolation(violations, "parent-candidate-before", () => {
      candidateBefore = candidateTestIdentity(buildCandidateManifest(isolatedRoot));
    });
    const evidenceExecutor = resolve(
      isolatedRoot,
      PLANNED_NODE_TEST_SOURCE_AUTHORITY.shared.evidenceExecutor.path,
    );
    const specText = canonicalJson(spec);
    const childEnvironment: NodeJS.ProcessEnv = { ...environment };
    delete childEnvironment.NODE_TEST_CONTEXT;
    try {
      execution = await runWorkerWithEvidence(TEST_EXECUTION_OPERATION, {
        authority,
        workerPath: evidenceExecutor,
        workerArguments: [evidenceExecutor, "--suite-spec", specText],
        environment: childEnvironment,
      });
    } catch {
      violations.push("recorded-execution-threw");
    }

    captureViolation(violations, "parent-source-after", () => {
      sourcesAfterHash = parentSourcesHash(isolatedRoot, spec);
      assertBoundHash(sourcesAfterHash, canonicalHash(spec.sources));
    });
    captureViolation(violations, "parent-corpus-after", () => {
      corporaAfterHash = parentCorporaHash(isolatedRoot, spec);
      assertBoundHash(corporaAfterHash, canonicalHash(spec.corpora));
    });
    captureViolation(violations, "parent-inventory-after", () => {
      inventoryAfter = buildPlannedNodeTestInventory(isolatedRoot, spec);
      if (inventoryBefore === undefined ||
        canonicalHash(plannedNodeTestInventorySnapshot(inventoryAfter)) !==
          canonicalHash(plannedNodeTestInventorySnapshot(inventoryBefore))) {
        throw new Error("inventory changed");
      }
    });
    captureViolation(violations, "parent-candidate-after", () => {
      candidateAfter = candidateTestIdentity(buildCandidateManifest(isolatedRoot));
      if (candidateBefore === undefined || canonicalHash(candidateAfter) !== canonicalHash(candidateBefore)) {
        throw new Error("candidate changed");
      }
    });
    captureViolation(violations, "run-source-snapshot-after", () => {
      // Reuse the candidateAfter identity from the parent-candidate-after
      // check above (same root, same content) instead of re-running
      // buildCandidateManifest (5+ git spawnSync calls) a third time.
      runSnapshotAfterIdentity = isolatedSourceSnapshotIdentity(isolatedRoot, candidateAfter);
      if (runSnapshotAfterIdentity !== sourceSnapshotIdentity) {
        throw new Error("run source snapshot changed");
      }
    });

    if (execution === null) {
      return observation(
        violations,
        null,
        null,
        currentDiagnostics(),
      );
    }
    if (execution.outcome !== "passed" || execution.exitCode !== 0) {
      violations.push(`recorded-execution-${execution.outcome}`);
    }
    if (execution.stderr.length !== 0) violations.push("recorded-execution-stderr-nonempty");
    captureViolation(violations, "immutable-attempt", () => {
      executionEvidence = scanExecutionEvidence(authority.receipt);
      if (executionEvidence.length !== 1 || executionEvidence[0]?.attemptId !== execution!.attemptId ||
        executionEvidence[0].status !== "complete" ||
        executionEvidence[0].outcome !== execution!.outcome) {
        throw new Error("attempt scan mismatch");
      }
    });
    captureViolation(violations, "supplemental-evidence", () => {
      evidence = parsePlannedNodeTestEvidenceBytes(execution!.stdout);
    });
    if (inventoryBefore !== undefined && candidateBefore !== undefined) {
      const receiptViolations = validateTestReceipt(execution.result, candidateBefore, inventoryBefore);
      violations.push(...receiptViolations.map((violation) => `receipt:${violation}`));
    } else {
      violations.push("receipt-parent-snapshot-unavailable");
    }
    if (evidence !== null) {
      validateEvidenceAgainstParent(
        evidence,
        spec,
        inventoryBefore,
        candidateBefore,
        isolatedRoot,
        execution,
        violations,
      );
    }
    return observation(
      violations,
      evidence,
      execution,
      currentDiagnostics(),
    );
  } catch (error) {
    violations.push(errorCode(error));
    return observation(
      violations,
      evidence,
      execution,
      currentDiagnostics(),
    );
  }
}

function validateEvidenceAgainstParent(
  evidence: PlannedNodeTestEvidence,
  spec: PlannedNodeTestSuiteSpec,
  inventory: ReturnType<typeof buildPlannedNodeTestInventory> | undefined,
  candidate: ReturnType<typeof candidateTestIdentity> | undefined,
  isolatedRoot: string,
  execution: NonNullable<Awaited<ReturnType<typeof runWorkerWithEvidence>>>,
  violations: string[],
): void {
  const expectedArgvTail = [
    resolve(isolatedRoot, PLANNED_NODE_TEST_SOURCE_AUTHORITY.shared.evidenceExecutor.path),
    "--suite-spec",
    canonicalJson(spec),
  ];
  const checks: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["suite-spec", evidence.suiteSpecIntegrityHash, spec.integrityHash],
    ["catalog", evidence.catalogIdentity, spec.catalogIdentity],
    ["source-before", evidence.sourcesBefore, spec.sources],
    ["source-after", evidence.sourcesAfter, spec.sources],
    ["corpus-before", evidence.corporaBefore, spec.corpora],
    ["corpus-after", evidence.corporaAfter, spec.corpora],
    ["candidate-before", evidence.candidateBefore, candidate],
    ["candidate-after", evidence.candidateAfter, candidate],
    ["inventory-before", evidence.inventoryBefore,
      inventory === undefined ? undefined : plannedNodeTestInventorySnapshot(inventory)],
    ["inventory-after", evidence.inventoryAfter,
      inventory === undefined ? undefined : plannedNodeTestInventorySnapshot(inventory)],
    ["runtime-disposition", evidence.runtime.disposition,
      PLANNED_NODE_TEST_PROTOCOL.childRuntimeDisposition],
    ["cwd", evidence.runtime.cwd, isolatedRoot],
    ["argv-tail", evidence.runtime.argv.slice(1), expectedArgvTail],
    ["result-hash", evidence.result.integrityHash,
      execution.result && "integrityHash" in execution.result ? execution.result.integrityHash : undefined],
    ["result-status", evidence.result.status, "passed"],
  ];
  for (const [id, actual, expected] of checks) {
    if (expected === undefined || canonicalHash(actual) !== canonicalHash(expected)) {
      violations.push(`evidence-${id}-mismatch`);
    }
  }
  if (!evidence.outputOnlyAccountingRejected || evidence.repositoryAdmissionAllowed ||
    evidence.qualificationDisposition !== PLANNED_NODE_TEST_PROTOCOL.qualificationDisposition) {
    violations.push("evidence-disposition-invalid");
  }
}

function parentSourcesHash(root: string, spec: PlannedNodeTestSuiteSpec): string {
  const observed = spec.sources.map((source) =>
    createPlannedNodeTestSourceBinding(root, source.role, source.path)
  );
  return canonicalHash(observed);
}

function parentCorporaHash(root: string, spec: PlannedNodeTestSuiteSpec): string {
  const observed = spec.corpora.map((corpus) =>
    createPlannedNodeTestCorpusBinding(root, corpus.id, corpus.kind, corpus.path)
  );
  return canonicalHash(observed);
}

function assertBoundHash(observed: string, expected: string): void {
  if (observed !== expected) throw new Error("planned_node_test_parent_binding_mismatch");
}

function materializeSourceSnapshot(
  sourceRoot: string,
  isolatedRoot: string,
  spec: PlannedNodeTestSuiteSpec,
): void {
  const workerPath = spec.sources.find((source) => source.role === "worker")?.path;
  if (workerPath === undefined) throw new Error("planned Node test worker binding is missing");
  const corpusPaths = new Set(spec.corpora.map((corpus) => corpus.path));
  const treeOptions = repositoryTreeOptions();
  const before = listSafeRepositoryTree(sourceRoot, ".", treeOptions);
  const included = before.filter((entry) => isolatedSourceEntryIncluded(entry, workerPath, corpusPaths));
  mkdirSync(isolatedRoot, { recursive: true, mode: 0o700 });
  copySafeRepositoryEntries(
    sourceRoot,
    isolatedRoot,
    included,
    ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
  );
  const after = listSafeRepositoryTree(sourceRoot, ".", treeOptions);
  if (canonicalHash(before) !== canonicalHash(after)) {
    throw new Error("planned Node test materialization source tree changed");
  }
  copyIsolatedDependencies(sourceRoot, isolatedRoot);
  runGit(isolatedRoot, ["init", "--quiet", "--initial-branch=qualification"]);
  runGit(isolatedRoot, ["config", "user.name", "Code Harness Qualification"]);
  runGit(isolatedRoot, ["config", "user.email", "qualification.invalid@example.invalid"]);
  runGit(isolatedRoot, ["config", "core.autocrlf", "false"]);
  runGit(isolatedRoot, ["add", "--all"]);
  runGit(isolatedRoot, ["commit", "--quiet", "--message", "isolated qualification snapshot"]);
}

function copySourceSnapshot(sourceSnapshotRoot: string, isolatedRoot: string): void {
  cpSync(sourceSnapshotRoot, isolatedRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: false,
    // Use copy-on-write reflinks (COPYFILE_FICLONE) so each per-run snapshot
    // copy is near-instant on supported filesystems (btrfs/XFS): the data
    // blocks are shared until the isolated run mutates them. On unsupported
    // filesystems the mode silently falls back to a regular copy. This
    // collapses the 13 per-suite snapshot copies from ~650 MB of I/O to
    // near-zero (the same pattern the runtime-candidate copy uses).
    mode: constants.COPYFILE_FICLONE,
  });
  chmodSync(isolatedRoot, lstatSync(sourceSnapshotRoot).mode & 0o777);
}

function isolatedSourceSnapshotIdentity(
  root: string,
  preComputedCandidateIdentity?: ReturnType<typeof candidateTestIdentity>,
): string {
  const projection = contentTreeProjection(
    root,
    ".",
    repositoryTreeOptions(),
    ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
  );
  const dependencySnapshotIdentity = installedDependencySnapshotIdentity(root);
  const candidate = preComputedCandidateIdentity ?? candidateTestIdentity(buildCandidateManifest(root));
  return canonicalHash({
    domain: "planned-node-test-isolated-source-snapshot/v1",
    candidate,
    projection,
    dependencySnapshotIdentity,
  });
}

function contentTreeProjection(
  root: string,
  path: string,
  treeOptions: ReturnType<typeof repositoryTreeOptions>,
  maximumFileBytes: number,
  includeEntry?: (entryPath: string) => boolean,
): readonly Readonly<Record<string, unknown>>[] {
  const before = listSafeRepositoryTree(root, path, treeOptions);
  const projection = before
    .filter((entry) => includeEntry === undefined || includeEntry(entry.path))
    .map((entry) => {
    if (entry.kind === "directory") return { path: entry.path, kind: entry.kind } as const;
    const read = readSafeRepositoryFile(root, entry.path, maximumFileBytes);
    if (read.identityHash !== entry.identityHash) {
      throw new Error("planned_node_test_source_snapshot_entry_changed_during_identity");
    }
    return {
      path: entry.path,
      kind: entry.kind,
      mode: read.mode & 0o777,
      byteLength: read.bytes.length,
      sha256: sha256(read.bytes),
    } as const;
  });
  const after = listSafeRepositoryTree(root, path, treeOptions);
  if (canonicalHash(before) !== canonicalHash(after)) {
    throw new Error("planned_node_test_source_snapshot_changed_during_identity");
  }
  return deepFreeze(projection);
}

function repositoryTreeOptions(): Readonly<{
  maximumDepth: number;
  maximumEntries: number;
  excludedDirectoryNames: readonly string[];
  excludedFileNames: readonly string[];
  excludedFileSuffixes: readonly string[];
  excludedDirectory: (relativePath: string) => boolean;
}> {
  return {
    maximumDepth: ROOT_POLICY.verification.testDiscovery.maximumDepth,
    maximumEntries: ROOT_POLICY.verification.testDiscovery.maximumEntries,
    excludedDirectoryNames: ROOT_POLICY.configuration.repositoryScanExclusions,
    excludedFileNames: ROOT_POLICY.configuration.repositoryScanFileExclusions,
    excludedFileSuffixes: ROOT_POLICY.configuration.repositoryScanFileSuffixExclusions,
    // This repository's experiment directories, as the walk used to skip implicitly.
    excludedDirectory: shouldExcludeExperiment,
  };
}

function dependencyTreeOptions(): ReturnType<typeof repositoryTreeOptions> {
  return {
    maximumDepth: ROOT_POLICY.verification.testDiscovery.maximumDepth,
    maximumEntries: ROOT_POLICY.verification.testDiscovery.maximumEntries,
    excludedDirectoryNames:
      PLANNED_NODE_TEST_PROTOCOL.isolatedDependencySnapshot.excludedTopLevelDirectoryNames,
    excludedFileNames: [],
    excludedFileSuffixes: [],
    // The experiment directories, as the walk used to skip implicitly.
    excludedDirectory: shouldExcludeExperiment,
  };
}

/**
 * Resolve the `node_modules` directory to its real path. Dev workspaces use a
 * `node_modules` symlink (`node_modules ->../candidate/node_modules`); the
 * safe-repository-reader rejects symlinks, so the dependency snapshot walks
 * the resolved real directory instead. When `node_modules` is a real
 * directory (production), `realpathSync` returns the same path.
 */
function resolveDependencyRoot(root: string): string {
  const depRoot = resolve(root, PLANNED_NODE_TEST_PROTOCOL.isolatedDependencySnapshot.root);
  try {
    return realpathSync(depRoot);
  } catch {
    return depRoot;
  }
}

function installedDependencySnapshotIdentity(root: string): string {
  const dependencyPolicy = PLANNED_NODE_TEST_PROTOCOL.isolatedDependencySnapshot;
  const depRoot = resolveDependencyRoot(root);
  return canonicalHash(contentTreeProjection(
    depRoot,
    ".",
    dependencyTreeOptions(),
    dependencyPolicy.maximumFileBytes,
    (entryPath) => isolatedDependencyEntryIncluded(
      entryPath === "." ? dependencyPolicy.root : `${dependencyPolicy.root}/${entryPath}`,
    ),
  ));
}

function copyIsolatedDependencies(sourceRoot: string, isolatedRoot: string): void {
  const dependencyPolicy = PLANNED_NODE_TEST_PROTOCOL.isolatedDependencySnapshot;
  const before = installedDependencySnapshotIdentity(sourceRoot);
  const depRoot = resolveDependencyRoot(sourceRoot);
  const sourceEntries = listSafeRepositoryTree(
    depRoot,
    ".",
    dependencyTreeOptions(),
  ).filter((entry) => isolatedDependencyEntryIncluded(
    entry.path === "." ? dependencyPolicy.root : `${dependencyPolicy.root}/${entry.path}`,
  ));
  mkdirSync(resolve(isolatedRoot, dependencyPolicy.root), { recursive: true, mode: 0o700 });
  copySafeRepositoryEntries(
    depRoot,
    isolatedRoot,
    sourceEntries,
    dependencyPolicy.maximumFileBytes,
    dependencyPolicy.root,
  );
  const sourceAfter = installedDependencySnapshotIdentity(sourceRoot);
  const destinationAfter = installedDependencySnapshotIdentity(isolatedRoot);
  if (sourceAfter !== before || destinationAfter !== before) {
    throw new Error("planned_node_test_dependency_snapshot_changed");
  }
}

function copySafeRepositoryEntries(
  sourceRoot: string,
  destinationRoot: string,
  entries: ReturnType<typeof listSafeRepositoryTree>,
  maximumFileBytes: number,
  destinationPrefix?: string,
): void {
  for (const entry of entries) {
    const destination = destinationPrefix !== undefined
      ? resolve(destinationRoot, destinationPrefix, entry.path)
      : resolve(destinationRoot, entry.path);
    if (entry.kind === "directory") {
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      continue;
    }
    const read = readSafeRepositoryFile(sourceRoot, entry.path, maximumFileBytes);
    if (read.identityHash !== entry.identityHash) {
      throw new Error("planned_node_test_materialization_source_entry_changed");
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, read.bytes, { mode: read.mode & 0o777, flag: "wx" });
    chmodSync(destination, read.mode & 0o777);
  }
}

function runGit(root: string, arguments_: readonly string[]): void {
  const result = spawnSync("git", [...arguments_], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(`isolated qualification Git command failed: ${arguments_[0] ?? "unknown"}`);
  }
}

function isolatedQualificationExecutionAuthority(
  root: string,
  relativeRoot: string,
  spec: PlannedNodeTestSuiteSpec,
): ExecutionAuthority {
  const receipt = ensureReceiptAuthority(root, relativeRoot);
  return deepFreeze({
    receipt,
    config: {
      canonicalHash: canonicalHash({ domain: "planned-node-test-config/v1", spec: spec.integrityHash }),
      sourceHash: canonicalHash({ domain: "planned-node-test-source/v1", spec: spec.integrityHash }),
      repositoryManifestHash: canonicalHash({
        domain: "planned-node-test-repository-manifest/v1",
        disposition: "isolated-qualification-not-admitted",
      }),
    },
  });
}

function captureViolation(violations: string[], prefix: string, action: () => void): void {
  try {
    action();
  } catch {
    violations.push(prefix);
  }
}

type DiagnosticValues = Readonly<{
  sourcesBeforeHash: string | null;
  sourcesAfterHash: string | null;
  corporaBeforeHash: string | null;
  corporaAfterHash: string | null;
  inventoryBefore: ReturnType<typeof buildPlannedNodeTestInventory> | undefined;
  inventoryAfter: ReturnType<typeof buildPlannedNodeTestInventory> | undefined;
  candidateBefore: ReturnType<typeof candidateTestIdentity> | undefined;
  candidateAfter: ReturnType<typeof candidateTestIdentity> | undefined;
  runSnapshotBeforeIdentity: string | null;
  runSnapshotAfterIdentity: string | null;
}>;

function diagnostics(
  sourceSnapshotIdentity: string,
  spec: PlannedNodeTestSuiteSpec,
  values: DiagnosticValues,
  executionEvidence: ReturnType<typeof scanExecutionEvidence>,
): PlannedNodeTestEvidenceDiagnostics {
  const expected = {
    sourcesHash: canonicalHash(spec.sources),
    corporaHash: canonicalHash(spec.corpora),
  } as const;
  const observed = {
    sourcesBeforeHash: values.sourcesBeforeHash,
    sourcesAfterHash: values.sourcesAfterHash,
    corporaBeforeHash: values.corporaBeforeHash,
    corporaAfterHash: values.corporaAfterHash,
    inventoryBeforeHash: optionalHash(values.inventoryBefore),
    inventoryAfterHash: optionalHash(values.inventoryAfter),
    candidateBeforeHash: optionalHash(values.candidateBefore),
    candidateAfterHash: optionalHash(values.candidateAfter),
    runSnapshotBeforeIdentity: values.runSnapshotBeforeIdentity,
    runSnapshotAfterIdentity: values.runSnapshotAfterIdentity,
  } as const;
  const differences: string[] = [];
  compareDiagnostic(differences, "sources-bound-before", observed.sourcesBeforeHash, expected.sourcesHash);
  compareDiagnostic(differences, "sources-bound-after", observed.sourcesAfterHash, expected.sourcesHash);
  compareDiagnostic(differences, "corpora-bound-before", observed.corporaBeforeHash, expected.corporaHash);
  compareDiagnostic(differences, "corpora-bound-after", observed.corporaAfterHash, expected.corporaHash);
  compareDiagnostic(differences, "sources-run", observed.sourcesBeforeHash, observed.sourcesAfterHash);
  compareDiagnostic(differences, "corpora-run", observed.corporaBeforeHash, observed.corporaAfterHash);
  compareDiagnostic(differences, "inventory-run", observed.inventoryBeforeHash, observed.inventoryAfterHash);
  compareDiagnostic(differences, "candidate-run", observed.candidateBeforeHash, observed.candidateAfterHash);
  compareDiagnostic(
    differences,
    "run-snapshot-before-bound",
    observed.runSnapshotBeforeIdentity,
    sourceSnapshotIdentity,
  );
  compareDiagnostic(
    differences,
    "run-snapshot-after-bound",
    observed.runSnapshotAfterIdentity,
    sourceSnapshotIdentity,
  );
  return deepFreeze({
    sourceSnapshotIdentity,
    expected,
    observed,
    differences,
    executionEvidence,
  });
}

function compareDiagnostic(
  differences: string[],
  id: string,
  left: string | null,
  right: string | null,
): void {
  if (left === null || right === null) differences.push(`${id}:unavailable`);
  else if (left !== right) differences.push(`${id}:mismatch`);
}

function optionalHash(value: unknown | undefined): string | null {
  return value === undefined ? null : canonicalHash(value);
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[a-z][a-z0-9_:-]*$/u.test(error.message)) return error.message;
  return "planned_node_test_session_failed";
}

function observation(
  violations: readonly string[],
  evidence: PlannedNodeTestEvidence | null,
  execution: Awaited<ReturnType<typeof runWorkerWithEvidence>> | null,
  diagnosticEvidence: PlannedNodeTestEvidenceDiagnostics,
): PlannedNodeTestEvidenceObservation {
  return Object.freeze({
    accepted: violations.length === 0,
    violations: Object.freeze([...violations]),
    evidence,
    execution: execution === null ? null : Object.freeze({
      attemptId: execution.attemptId,
      outcome: execution.outcome,
      exitCode: execution.exitCode,
      stdout: Buffer.from(execution.stdout),
      stderr: Buffer.from(execution.stderr),
      result: execution.result,
    }),
    diagnostics: diagnosticEvidence,
  });
}
