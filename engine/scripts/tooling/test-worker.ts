import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildCandidateManifestDetailed,
  candidateTestIdentityExcluding,
  refreshCandidateTestIdentityExcluding,
} from "./candidate-manifest.ts";
import { enableSharedCompileCache } from "./compile-cache.ts";
import { executeInventoryTestRun } from "./inventory-test-run.ts";
import { loadTestInventoryWithSnapshot } from "../test-inventory.ts";
import { createTestReceipt, createTestResultReceipt, type TestResultReceipt } from "./test-receipt.ts";
import { verifyS1Repository, type S1Verification } from "./s1-verification.ts";
import { canonicalHash, canonicalJson, deepFreeze } from "../../src/kernel/integrity.ts";
import { extractErrorContext, extractErrorMessage } from "../../src/kernel/errors.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import { applyDevModeSafeReadEnvVars } from "../../src/shared/dev-mode-env.ts";
import { armCheckoutUnderTest } from "../../src/filesystem/checkout-write-door.ts";
import { refuseRemoteNetworkUnderTest } from "./network-under-test.ts";
import { armTestKeyHome } from "../../test/support/test-key-home.ts";
import {
  readTestExecutionConfig,
  writeTestFileDurations,
  TEST_FILE_DURATIONS_PATH,
} from "../../src/workflow/test-result-collector.ts";
import { TEST_RUN_HISTORY_PATH } from "../../src/shared/run-history.ts";
import { isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { ARCHITECTURE_MODULES_PATH } from "../../src/workflow/architecture-module-entries.ts";

type WorkerMode = "test" | "check";

/**
 * Tracked repository paths the test runner itself writes during a test run.
 * The candidate-identity check excludes these so legitimate runner writes
 * (test inventory regeneration, hash binding repair, module registrar
 * updates) do not fire a false `candidate-identity-changed`. Only
 * external/unexpected changes to OTHER tracked files are flagged.
 */
const RUNNER_WRITTEN_PATHS = deepFreeze([
  VERIFICATION_PATHS.testInventory,
  "src/root-policy.ts",
  ARCHITECTURE_MODULES_PATH,
  "traceability/test-surface-dispositions.json",
  ".bridlewise/state/test-results/latest-collection.json",
  ".bridlewise/state/test-results/latest-summary.json",
  TEST_RUN_HISTORY_PATH,
  TEST_FILE_DURATIONS_PATH,
  ".bridlewise/state/timeline.db",
  ".bridlewise/state/timeline.db-shm",
  ".bridlewise/state/timeline.db-wal",
  // Foundation cascade tests create temporary files with UUID-based names.
  // Use prefix matching (trailing "*") to exclude them all.
  "test/support/foundation-cascade-*",
  "test/support/.foundation-cascade-*",
] as const);

export type CheckResult = Readonly<{
  schemaVersion: typeof ROOT_POLICY.receipts.testExecution.checkResultSchemaVersion;
  integrityClaim: "self-integrity-only-not-authenticity";
  testResultReceipt: TestResultReceipt;
  verification: S1Verification;
  result: Readonly<{ status: "passed" | "failed"; exitCode: 0 | 1 }>;
  integrityHash: string;
}>;

export async function executeTestWorker(mode: WorkerMode): Promise<Readonly<{
  result: TestResultReceipt | CheckResult;
  stdout: Buffer;
  stderr: Buffer;
  exitCode: 0 | 1;
}>> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  // Load and fully validate the inventory once; the captured hash-only
  // snapshot lets the pre/post-run assertions re-verify source bytes without
  // re-parsing every test file with Babel.
  const { inventory, snapshot } = loadTestInventoryWithSnapshot(root);
  const candidateBuild = buildCandidateManifestDetailed(root);
  const candidateBeforeExecution = candidateTestIdentityExcluding(candidateBuild.manifest, RUNNER_WRITTEN_PATHS);
  const testExecutionConfig = readTestExecutionConfig(root);
  const accounting = await executeInventoryTestRun(root, inventory, {
    ...testExecutionConfig,
    sourceSnapshot: snapshot,
  });
  // Derive the after-run candidate identity from the before-run build by
  // re-reading only stat-changed files instead of a second full pass.
  const candidateAfterExecution = refreshCandidateTestIdentityExcluding(
    root,
    candidateBuild,
    RUNNER_WRITTEN_PATHS,
  );
  // Persist per-file durations so the next run schedules the parallel phase
  // longest-first. Best-effort like the run summary: a write failure must
  // not fail the suite, so it is reported as a diagnostic instead.
  try {
    writeTestFileDurations(root, accounting.fileDurations);
  } catch (durationsError) {
    process.stderr.write(`${canonicalJson({
      error: "test_file_durations_write_failed",
      message: extractErrorMessage(durationsError),
    })}\n`);
  }
  const receipt = createTestReceipt(
    candidateBeforeExecution,
    inventory,
    accounting.discoveredIds,
    accounting.passedIds,
    accounting.counts,
    accounting.gatedTestIds,
    accounting.loadCrashCount,
    accounting.abortedFileCount,
  );
  const testResultReceipt = createTestResultReceipt(
    receipt,
    accounting.runnerSummary,
    candidateAfterExecution,
    accounting.failures,
    accounting.unknownTests,
    accounting.failureDetails,
    accounting.skips,
  );
  const result = mode === "check" ? createCheckResult(root, testResultReceipt) : testResultReceipt;
  // The receipt's result.status already reflects the full outcome including
  // candidate-identity checks (candidate-identity-changed). Use it for both
  // the emitted `status` field and the exit code so the JSON status and exit
  // code are consistent with the receipt. Previously mode==="test" used
  // `accounting.passed` which only reflected test pass/fail, not
  // candidate-identity checks — producing status:"passed" with exit code 1.
  const passed = result.result.status === "passed";
  const stdout = Buffer.from(`${canonicalJson({
    schemaVersion: "bridlewise-test-worker-output/v1",
    mode,
    resultSchemaVersion: result.schemaVersion,
    resultIntegrityHash: result.integrityHash,
    status: passed ? "passed" : "failed",
  })}\n`, "utf8");
  const diagnostic = testResultReceipt.result.diagnostic;
  const stderr = diagnostic === null ? Buffer.alloc(0) : Buffer.from(`${canonicalJson(diagnostic)}\n`, "utf8");
  return Object.freeze({ result, stdout, stderr, exitCode: passed ? 0 : 1 });
}

function createCheckResult(root: string, testResultReceipt: TestResultReceipt): CheckResult {
  const verification = verifyS1Repository(root, testResultReceipt);
  const passed = testResultReceipt.result.status === "passed" && verification.ok;
  const unsigned = {
    schemaVersion: ROOT_POLICY.receipts.testExecution.checkResultSchemaVersion,
    integrityClaim: "self-integrity-only-not-authenticity",
    testResultReceipt,
    verification,
    result: { status: passed ? "passed" : "failed", exitCode: passed ? 0 : 1 },
  } as const;
  return deepFreeze({ ...unsigned, integrityHash: canonicalHash(unsigned) });
}

function parseMode(argv: readonly string[]): WorkerMode {
  if (argv.length !== 2 || argv[0] !== "--mode" || (argv[1] !== "test" && argv[1] !== "check")) {
    throw new Error("Usage: test-worker --mode test|check");
  }
  return argv[1];
}

if (isEntryPoint(import.meta.url)) {
  // The runner enabled (and bounded) the cache for this tree; this worker inherits it.
  enableSharedCompileCache(undefined);
  // Dev-mode safe-read env vars: propagate the hardlink/symlink bypass
  // automatically so the worker's child test processes (which inherit
  // `process.env`) never reject the dev workspace tree. See
  // `src/shared/dev-mode-env.ts` for the canonical owner.
  applyDevModeSafeReadEnvVars(fileURLToPath(new URL("../../", import.meta.url)));
  // This worker is a TEST RUNNER: it arms the checkout write door for the
  // checkout it tests before any test runs, so neither it nor any descendant
  // (a test file's process, a generator CLI a test spawns) can write that
  // checkout. The runner that spawned it stays unarmed: its auto-heal writes.
  armCheckoutUnderTest(fileURLToPath(new URL("../../", import.meta.url)));
  // …and holds the run to this machine at the socket: this worker (its
  // in-process phases); every test file's process gets the guard preloaded by
  // inventory-test-run.ts (network-under-test.ts).
  refuseRemoteNetworkUnderTest();
  armTestKeyHome();
  try {
    const execution = await executeTestWorker(parseMode(process.argv.slice(2)));
    writeSync(3, Buffer.from(`${canonicalJson(execution.result)}\n`, "utf8"));
    process.stdout.write(execution.stdout);
    process.stderr.write(execution.stderr);
    process.exitCode = execution.exitCode;
  } catch (error) {
    // Surface actionable context (function/file/line/stack) extracted from
    // the error's own stack trace so a setup failure does not require
    // manually tracing the runner code.
    process.stderr.write(`${canonicalJson({
      error: "test_worker_setup_failed",
      ...extractErrorContext(error),
    })}\n`);
    process.exitCode = 1;
  }
}
