import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nodeTest, { type TestContext } from "node:test";

import { runWorkerWithEvidence } from "../scripts/tooling/run-tests.ts";
import { CANDIDATE_MANIFEST_SCHEMA_VERSION } from "../scripts/tooling/candidate-manifest.ts";
import { createTestInventory, createTestInventoryEntry, testInventoryIdentity } from "../scripts/test-inventory.ts";
import {
  beginRecordedExecution,
  completeRecordedExecution,
  testExecutionQualification,
  TEST_EXECUTION_OPERATION,
  CHECK_EXECUTION_OPERATION,
  loadTestResultFromExecution,
  scanExecutionEvidence,
  type ExecutionAuthority,
  executionOperationSpec,
} from "../scripts/tooling/test-execution.ts";
import {
  createTestReceipt,
  testResultFailureStatements,
  testResultLedgerRows,
  testResultQualification,
  createTestResultReceipt,
  parseTestResultReceiptValue,
  type TestReceipt,
  type TestRunnerSummary,
} from "../scripts/tooling/test-receipt.ts";
import {
  allocateReceiptAttempt,
  ensureReceiptAuthority,
  inspectReceiptAuthority,
  listReceiptNamespaceEntries,
  readImmutableEvidence,
  remediateImmutableEvidenceMode,
  writeImmutableEvidence,
  type ReceiptAuthority,
  type ReceiptDirectoryFaultStage,
  type ReceiptFaultStage,
} from "../src/filesystem/immutable-receipt.ts";
import { HarnessError, InputError } from "../src/kernel/errors.ts";
import { extractTestResultError } from "../src/workflow/test-result-collector.ts";
import { withCurrentNodeRuntimeForFilesystemMechanismTest } from "../src/filesystem/durable-filesystem-internal.ts";
import { canonicalHash, canonicalJson, sha256 } from "../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../src/kernel/root-policy.ts";
import { createCanonicalNodeTestInventoryFixture } from "./support/test-inventory-fixture.ts";
import { createTempDir } from "./support/temp-dir.ts";
import { superviseCommand, type SupervisedCommand } from "../src/process/supervised-run.ts";
import { isProcessIdentityLive, parseProcessIdentityRecord } from "../src/process/process-facts.ts";
import { testProcessSupervisorBinary } from "../guardian/build.ts";
import { commandTerminalFacts, failureDigest } from "../src/shared/run-history.ts";

const TEMPORARY_PATHS = new Set<string>();
const EVIDENCE_ROOT = ".bridlewise/state/evidence/executions";

function mechanismTest(name: string, operation: (context: TestContext) => void | Promise<void>): void {
  void nodeTest(name, (context) => withCurrentNodeRuntimeForFilesystemMechanismTest(
    () => operation(context),
  ));
}

nodeTest.after(() => {
  for (const path of TEMPORARY_PATHS) rmSync(path, { recursive: true, force: true });
});

mechanismTest("configured receipt authority is repository-local private durable-unadmitted state", () => {
  const root = temporaryRepository("bridlewise-receipt-authority-");
  const authority = ensureReceiptAuthority(root, EVIDENCE_ROOT);
  assert.equal(authority.absoluteRoot, join(root, EVIDENCE_ROOT));
  for (const path of [".bridlewise", ".bridlewise/state", ".bridlewise/state/evidence", EVIDENCE_ROOT]) {
    const stats = lstatSync(join(root, path));
    assert.equal(stats.mode & 0o7777, 0o700);
    assert.equal(stats.uid, process.getuid?.());
  }
  const write = writeImmutableEvidence(authority, {
    mode: "exclusive-path",
    path: "exclusive/receipt.json",
    bytes: canonicalBytes({ result: "failed" }),
    contentKind: "canonical-json",
  });
  assert.equal(write.authorityStage, "durable-local-creation-unadmitted");
  assert.equal(lstatSync(join(authority.absoluteRoot, write.path)).mode & 0o7777, 0o600);

  const attempt = allocateReceiptAttempt(authority, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const attemptPath = join(authority.absoluteRoot, attempt.relativeDirectory);
  rmSync(attemptPath, { recursive: true });
  mkdirSync(attemptPath, { mode: 0o700 });
  assert.throws(() => writeImmutableEvidence(authority, {
    mode: "unique-attempt", attempt, ordinal: 1, label: "probe", extension: ".bin",
    bytes: Buffer.from("probe"), contentKind: "blob",
  }), receiptError("receipt_attempt_identity_changed"));
});

mechanismTest("read-only receipt authority inspection preserves absent trees exactly", () => {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const root = temporaryRepository(`bridlewise-receipt-inspect-absent-${repetition}-`);
    const before = emptyTreeIdentity(root);
    assert.throws(() => inspectReceiptAuthority(root, EVIDENCE_ROOT), receiptError("receipt_parent_missing"));
    assert.deepEqual(emptyTreeIdentity(root), before);
  }
});

mechanismTest("exclusive-path and unique-attempt modes never replace an existing result", () => {
  const authority = temporaryAuthority("bridlewise-receipt-exclusive-");
  const failed = canonicalBytes({ result: "failed" });
  const passed = canonicalBytes({ result: "passed" });
  writeImmutableEvidence(authority, {
    mode: "exclusive-path", path: "exclusive/result.json", bytes: failed, contentKind: "canonical-json",
  });
  assert.throws(() => writeImmutableEvidence(authority, {
    mode: "exclusive-path", path: "exclusive/result.json", bytes: passed, contentKind: "canonical-json",
  }), receiptError("receipt_path_exists"));
  assert.deepEqual(readImmutableEvidence(authority, "exclusive/result.json", "canonical-json"), failed);

  const attempt = allocateReceiptAttempt(authority, "11111111-1111-4111-8111-111111111111");
  const first = writeImmutableEvidence(authority, {
    mode: "unique-attempt", attempt, ordinal: 7, label: "result", extension: ".json",
    bytes: failed, contentKind: "canonical-json",
  });
  assert.throws(() => writeImmutableEvidence(authority, {
    mode: "unique-attempt", attempt, ordinal: 7, label: "result", extension: ".json",
    bytes: failed, contentKind: "canonical-json",
  }), receiptError("receipt_path_exists"));
  assert.deepEqual(readImmutableEvidence(authority, first.path, "canonical-json"), failed);
});

mechanismTest("content-addressed mode is idempotent and rejects a forced filename collision", () => {
  const authority = temporaryAuthority("bridlewise-receipt-content-");
  const bytes = Buffer.from("same exact blob\0binary", "utf8");
  const first = writeImmutableEvidence(authority, {
    mode: "content-addressed", namespace: "blobs", extension: ".bin", bytes, contentKind: "blob",
  });
  const second = writeImmutableEvidence(authority, {
    mode: "content-addressed", namespace: "blobs", extension: ".bin", bytes, contentKind: "blob",
  });
  assert.equal(first.disposition, "created");
  assert.equal(second.disposition, "existing-identical");
  assert.equal(first.path, `blobs/sha256/${sha256(bytes)}.bin`);

  const collisionAuthority = temporaryAuthority("bridlewise-receipt-collision-");
  const forcedPath = `blobs/sha256/${sha256(bytes)}.bin`;
  writeImmutableEvidence(collisionAuthority, {
    mode: "exclusive-path", path: forcedPath, bytes: Buffer.from("different"), contentKind: "blob",
  });
  assert.throws(() => writeImmutableEvidence(collisionAuthority, {
    mode: "content-addressed", namespace: "blobs", extension: ".bin", bytes, contentKind: "blob",
  }), receiptError("receipt_content_address_collision"));
});

mechanismTest("CAS directory and file modes are exact under hostile umasks and 0664 remediation preserves bytes", async () => {
  const root = temporaryRepository("bridlewise-receipt-mode-");
  const helper = writerHelper(root);
  const bytes = canonicalBytes({ probe: "permissive-umask-and-mode-remediation" });
  const publication = await runWriter(helper, root, "permissive-umask", bytes);
  assert.equal(publication.code, 0, JSON.stringify(publication));
  assert.equal(publication.stdout.trim(), "created");

  const authority = inspectReceiptAuthority(root, EVIDENCE_ROOT);
  const path = `content/sha256/${sha256(bytes)}.bin`;
  const absolute = join(authority.absoluteRoot, path);
  for (const directory of [
    authority.absoluteRoot,
    join(authority.absoluteRoot, "content"),
    join(authority.absoluteRoot, "content/sha256"),
  ]) {
    assert.equal(lstatSync(directory).mode & 0o7777, 0o700);
  }
  assert.equal(lstatSync(absolute).mode & 0o7777, 0o600);

  const restrictiveRoot = temporaryRepository("bridlewise-receipt-restrictive-umask-");
  const restrictiveBytes = canonicalBytes({ probe: "restrictive-umask" });
  const restrictivePublication = await runWriter(
    writerHelper(restrictiveRoot), restrictiveRoot, "restrictive-umask", restrictiveBytes,
  );
  assert.equal(restrictivePublication.code, 0, JSON.stringify(restrictivePublication));
  const restrictiveAuthority = inspectReceiptAuthority(restrictiveRoot, EVIDENCE_ROOT);
  for (const directory of [
    restrictiveAuthority.absoluteRoot,
    join(restrictiveAuthority.absoluteRoot, "content"),
    join(restrictiveAuthority.absoluteRoot, "content/sha256"),
  ]) {
    assert.equal(lstatSync(directory).mode & 0o7777, 0o700);
  }
  assert.equal(lstatSync(join(
    restrictiveAuthority.absoluteRoot,
    `content/sha256/${sha256(restrictiveBytes)}.bin`,
  )).mode & 0o7777, 0o600);

  const partialRoot = temporaryRepository("bridlewise-receipt-partial-parent-");
  const partialParent = join(partialRoot, ".bridlewise/state");
  mkdirSync(partialParent, { mode: 0o700, recursive: true });
  const partialBefore = lstatSync(partialParent, { bigint: true });
  const partialBytes = canonicalBytes({ probe: "restrictive-umask-partial-parent" });
  const partialPublication = await runWriter(
    writerHelper(partialRoot), partialRoot, "restrictive-umask", partialBytes,
  );
  assert.equal(partialPublication.code, 0, JSON.stringify(partialPublication));
  const partialAfter = lstatSync(partialParent, { bigint: true });
  assert.equal(partialAfter.dev, partialBefore.dev);
  assert.equal(partialAfter.ino, partialBefore.ino);
  assert.equal(partialAfter.mode & 0o7777n, 0o700n);
  const partialAuthority = inspectReceiptAuthority(partialRoot, EVIDENCE_ROOT);
  assert.equal(lstatSync(partialAuthority.absoluteRoot).mode & 0o7777, 0o700);
  assert.equal(lstatSync(join(
    partialAuthority.absoluteRoot,
    `content/sha256/${sha256(partialBytes)}.bin`,
  )).mode & 0o7777, 0o600);

  for (const mask of ["000", "777"]) {
    for (const stage of ROOT_POLICY.receipts.immutableExecution.directoryFaultStages) {
      const cleanupRoot = temporaryRepository(`bridlewise-receipt-directory-cleanup-${mask}-${stage}-`);
      const helperPath = authorityFaultHelper(cleanupRoot);
      const entriesBefore = readdirSync(cleanupRoot).toSorted();
      const fault = await runProcess(helperPath, [cleanupRoot, mask, stage]);
      assert.equal(fault.code, 0, JSON.stringify(fault));
      assert.equal(fault.stdout.trim(), "receipt_parent_create_failed");
      assert.deepEqual(readdirSync(cleanupRoot).toSorted(), entriesBefore);
    }
  }

  const replacementStages = ROOT_POLICY.receipts.immutableExecution.directoryFaultStages;
  const replacementKinds = ["same-owner-directory", "symlink"] as const;
  for (const stage of replacementStages) {
    for (const replacementKind of replacementKinds) {
      const replacementRoot = temporaryRepository(
        `bridlewise-receipt-directory-replacement-${stage}-${replacementKind}-`,
      );
      let mutationApplied = false;
      let replacementIdentity: ReturnType<typeof lstatSync> | undefined;
      let replacedPath: string | undefined;
      assert.throws(() => ensureReceiptAuthority(replacementRoot, EVIDENCE_ROOT, {
        afterStage(observedStage: ReceiptDirectoryFaultStage, lexicalPath: string) {
          if (mutationApplied || observedStage !== stage) return;
          mutationApplied = true;
          replacedPath = lexicalPath;
          const detached = `${lexicalPath}.detached`;
          renameSync(lexicalPath, detached);
          if (replacementKind === "same-owner-directory") {
            mkdirSync(lexicalPath, { mode: 0o700 });
          } else {
            symlinkSync(detached, lexicalPath, "dir");
          }
          replacementIdentity = lstatSync(lexicalPath);
        },
      }), receiptError("receipt_parent_create_ambiguous"));
      assert.equal(mutationApplied, true);
      assert.ok(replacedPath);
      assert.ok(replacementIdentity);
      const survivingReplacement = lstatSync(replacedPath);
      assert.equal(survivingReplacement.dev, replacementIdentity.dev);
      assert.equal(survivingReplacement.ino, replacementIdentity.ino);
      assert.equal(survivingReplacement.isSymbolicLink(), replacementKind === "symlink");
      assert.equal(lstatSync(`${replacedPath}.detached`).isDirectory(), true);
    }
  }

  chmodSync(absolute, 0o664);
  const before = lstatSync(absolute, { bigint: true });
  assert.throws(() => readImmutableEvidence(authority, path, "blob"),
    receiptError("receipt_file_unsafe"));
  assert.throws(() => remediateImmutableEvidenceMode(authority, {
    path,
    contentKind: "blob",
    expectedBeforeMode: 0o664,
    expectedByteLength: bytes.length,
    expectedSha256: "0".repeat(64),
    authorizedReason: "hostile-wrong-content-identity",
  }), receiptError("receipt_mode_remediation_content_mismatch"));
  assert.equal(lstatSync(absolute).mode & 0o7777, 0o664);

  const remediation = remediateImmutableEvidenceMode(authority, {
    path,
    contentKind: "blob",
    expectedBeforeMode: 0o664,
    expectedByteLength: bytes.length,
    expectedSha256: sha256(bytes),
    authorizedReason: "authorized-external-publication-mode-correction",
  });
  const after = lstatSync(absolute, { bigint: true });
  assert.equal(remediation.before.mode, "0664");
  assert.equal(remediation.after.mode, "0600");
  assert.equal(remediation.beforeSha256, sha256(bytes));
  assert.equal(remediation.afterSha256, sha256(bytes));
  assert.equal(remediation.byteHashUnchanged, true);
  assert.equal(remediation.authorityStage,
    "current-filesystem-metadata-remediation-unadmitted-not-clone-portable");
  assert.equal(before.dev, after.dev);
  assert.equal(before.ino, after.ino);
  assert.equal(after.mode & 0o7777n, 0o600n);
  assert.deepEqual(readImmutableEvidence(authority, path, "blob"), bytes);
  assert.throws(() => remediateImmutableEvidenceMode(authority, {
    path,
    contentKind: "blob",
    expectedBeforeMode: 0o664,
    expectedByteLength: bytes.length,
    expectedSha256: sha256(bytes),
    authorizedReason: "unauthorized-repeat-must-not-be-idempotent",
  }), receiptError("receipt_mode_remediation_precondition_failed"));
});

mechanismTest("concurrent exclusive and content-addressed writers have one stable authority outcome x3", async () => {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const root = temporaryRepository(`bridlewise-receipt-concurrent-${repetition}-`);
    const helper = writerHelper(root);
    const exclusive = await Promise.all([
      runWriter(helper, root, "exclusive", Buffer.from("writer-a")),
      runWriter(helper, root, "exclusive", Buffer.from("writer-b")),
    ]);
    assert.deepEqual(exclusive.map((entry) => entry.code).toSorted(), [0, 1]);
    assert.equal(exclusive.filter((entry) => entry.stderr.includes("receipt_path_exists")).length, 1);

    const content = Buffer.from(`identical-${repetition}`);
    const addressed = await Promise.all([
      runWriter(helper, root, "content", content),
      runWriter(helper, root, "content", content),
      runWriter(helper, root, "content", content),
    ]);
    assert.deepEqual(addressed.map((entry) => entry.code), [0, 0, 0], JSON.stringify(addressed));
    assert.equal(addressed.filter((entry) => entry.stdout.trim() === "created").length, 1);
    assert.equal(addressed.filter((entry) => entry.stdout.trim() === "existing-identical").length, 2);
  }
});

mechanismTest("canonical JSON admission rejects duplicate keys invalid framing encoding BOM NUL and oversize", () => {
  const authority = temporaryAuthority("bridlewise-receipt-json-");
  const invalid = [
    Buffer.from('{"b":1,"a":2}\n'),
    Buffer.from('{"a":1,"a":1}\n'),
    Buffer.from('{"a":1}'),
    Buffer.from('{"a":1}\n\n'),
    Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("{}\n")]),
    Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d, 0x0a]),
    Buffer.from("{\"a\":\"\0\"}\n"),
  ];
  for (const [index, bytes] of invalid.entries()) {
    assert.throws(() => writeImmutableEvidence(authority, {
      mode: "exclusive-path", path: `invalid/${index}.json`, bytes, contentKind: "canonical-json",
    }), receiptError("receipt_content_invalid"));
  }
  assert.throws(() => writeImmutableEvidence(authority, {
    mode: "exclusive-path", path: "invalid/oversize.bin", bytes: Buffer.alloc(16_777_217), contentKind: "blob",
  }), receiptError("receipt_content_too_large"));
});

mechanismTest("test receipt constructors reject forged inventory and inconsistent accounting", () => {
  const fixture = receiptFixture();
  const entry = fixture.inventory.tests[0]!;
  const escapedEntry = {
    ...entry,
    sourceId: "test/../../outside.test.ts",
    id: canonicalHash({
      sourceId: "test/../../outside.test.ts",
      sourceHash: entry.sourceHash,
      name: entry.name,
    }),
  };
  const escapedInventory = {
    ...fixture.inventory,
    tests: [escapedEntry],
    inventoryHash: testInventoryIdentity(fixture.inventory.scope, [escapedEntry]),
  };
  const counts = { discovered: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 } as const;
  assert.throws(() => createTestReceipt(
    fixture.candidate,
    escapedInventory as unknown as typeof fixture.inventory,
    [escapedEntry.id],
    [escapedEntry.id],
    counts,
  ), /test inventory schema is invalid/u);
  assert.throws(() => createTestReceipt(
    fixture.candidate,
    fixture.inventory,
    [entry.id],
    [],
    counts,
  ), /test receipt accounting is invalid/u);
  const failedReceipt = createTestReceipt(
    fixture.candidate,
    fixture.inventory,
    [entry.id],
    [],
    { discovered: 1, passed: 0, failed: 1, skipped: 0, todo: 0, cancelled: 0 },
  );
  assert.throws(() => createTestResultReceipt(
    failedReceipt,
    passingRunnerSummary(failedReceipt),
    failedReceipt.candidate,
    [entry.name],
    [],
  ),
    /test runner summary accounting is invalid/u);
  assert.equal(createTestResultReceipt(
    failedReceipt,
    failedRunnerSummary(failedReceipt),
    failedReceipt.candidate,
    [entry.name],
    [],
  ).result.status, "failed");
  // A self-hash proves the saved bytes agree with themselves, not that
  // native diagnostics still belong to the named terminal outcomes.
  const namedFailure = createTestResultReceipt(failedReceipt, failedRunnerSummary(failedReceipt),
    failedReceipt.candidate, [entry.name], [],
    [{ identity: entry.name, file: entry.sourceId, line: null, column: null, error: null }]);
  for (const details of [[], [{ identity: "foreign failure", file: null, line: null, column: null, error: null }],
    [namedFailure.result.diagnostic!.failureDetails![0]!, namedFailure.result.diagnostic!.failureDetails![0]!]]) {
    const { integrityHash: _hash, ...unsigned } = namedFailure;
    const forged = { ...unsigned, result: { ...unsigned.result,
      diagnostic: { ...unsigned.result.diagnostic!, failureDetails: details } } };
    assert.throws(() => parseTestResultReceiptValue({ ...forged, integrityHash: canonicalHash(forged) }),
      /test failure detail accounting is invalid/u);
  }
  const cancelledReceipt = createTestReceipt(fixture.candidate, fixture.inventory, [entry.id], [],
    { discovered: 1, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 1 });
  const cancelledResult = createTestResultReceipt(cancelledReceipt, failedRunnerSummary(cancelledReceipt),
    cancelledReceipt.candidate, [entry.name], []);
  assert.equal(parseTestResultReceiptValue(cancelledResult).result.status, "failed");
  assert.throws(() => createTestResultReceipt(cancelledReceipt, failedRunnerSummary(cancelledReceipt),
    cancelledReceipt.candidate, [], []), /test result accounting is invalid/u);
  const { integrityHash: _cancelledHash, ...cancelledUnsigned } = cancelledResult;
  const unnamedCancellation = { ...cancelledUnsigned, result: { ...cancelledUnsigned.result,
    diagnostic: { ...cancelledUnsigned.result.diagnostic!, failures: [] } } };
  assert.throws(() => parseTestResultReceiptValue({ ...unnamedCancellation,
    integrityHash: canonicalHash(unnamedCancellation) }), /test result accounting is invalid/u);
  const forgedPassingUnsigned = {
    schemaVersion: ROOT_POLICY.receipts.testExecution.resultSchemaVersion,
    integrityClaim: "self-integrity-only-not-authenticity",
    testReceipt: failedReceipt,
    result: {
      status: "passed",
      exitCode: 0,
      runnerSummary: failedRunnerSummary(failedReceipt),
      candidateAfterExecution: failedReceipt.candidate,
      diagnostic: null,
    },
  } as const;
  assert.throws(() => parseTestResultReceiptValue({
    ...forgedPassingUnsigned,
    integrityHash: canonicalHash(forgedPassingUnsigned),
  }), /test result accounting is invalid/u);
  assert.throws(() => createTestResultReceipt(fixture.testReceipt, {
    eventCount: 0,
    successful: true,
    counts: null,
  }, fixture.testReceipt.candidate, [], []), /test runner summary accounting is invalid/u);
  const extraneousReasonUnsigned = {
    schemaVersion: ROOT_POLICY.receipts.testExecution.resultSchemaVersion,
    integrityClaim: "self-integrity-only-not-authenticity",
    testReceipt: fixture.testReceipt,
    result: {
      status: "failed",
      exitCode: 1,
      runnerSummary: { eventCount: 0, successful: false, counts: null },
      candidateAfterExecution: fixture.testReceipt.candidate,
      diagnostic: {
        error: "test_run_failed",
        reasons: ["runner-summary-missing", "test-skipped"],
        failures: [],
        unknownTests: [],
      },
    },
  } as const;
  assert.throws(() => parseTestResultReceiptValue({
    ...extraneousReasonUnsigned,
    integrityHash: canonicalHash(extraneousReasonUnsigned),
  }), /test result accounting is invalid/u);

  for (let repetition = 0; repetition < 3; repetition += 1) {
    const impossibleUnsigned = {
      schemaVersion: ROOT_POLICY.receipts.testExecution.resultSchemaVersion,
      integrityClaim: "self-integrity-only-not-authenticity",
      testReceipt: fixture.testReceipt,
      result: {
        status: "failed",
        exitCode: 1,
        runnerSummary: { eventCount: 0, successful: false, counts: null },
        candidateAfterExecution: fixture.testReceipt.candidate,
        diagnostic: {
          error: "test_run_failed",
          reasons: [
            "runner-summary-missing",
            "runner-summary-duplicate",
            "runner-summary-counts-invalid",
            "runner-summary-counts-mismatch",
          ],
          failures: [],
          unknownTests: [],
        },
      },
    } as const;
    assert.throws(() => parseTestResultReceiptValue({
      ...impossibleUnsigned,
      integrityHash: canonicalHash(impossibleUnsigned),
    }), /test result accounting is invalid/u);
  }
});

mechanismTest("descriptor-held traversal rejects target and ancestor symlinks plus mode and hardlink drift", () => {
  const root = temporaryRepository("bridlewise-receipt-path-");
  const authority = ensureReceiptAuthority(root, EVIDENCE_ROOT);
  const outside = join(root, "outside");
  mkdirSync(outside, { mode: 0o700 });
  const linkedParent = join(authority.absoluteRoot, "linked");
  symlinkSync(outside, linkedParent);
  assert.throws(() => writeImmutableEvidence(authority, {
    mode: "exclusive-path", path: "linked/receipt.json", bytes: canonicalBytes({ ok: true }),
    contentKind: "canonical-json",
  }), receiptError("receipt_parent_symlink"));

  const write = writeImmutableEvidence(authority, {
    mode: "exclusive-path", path: "safe/receipt.json", bytes: canonicalBytes({ ok: true }),
    contentKind: "canonical-json",
  });
  const absolute = join(authority.absoluteRoot, write.path);
  chmodSync(absolute, 0o640);
  assert.throws(() => readImmutableEvidence(authority, write.path, "canonical-json"),
    receiptError("receipt_file_unsafe"));
  chmodSync(absolute, 0o600);
  linkSync(absolute, join(authority.absoluteRoot, "safe/alias.json"));
  assert.throws(() => readImmutableEvidence(authority, write.path, "canonical-json"),
    receiptError("receipt_file_unsafe"));
});

mechanismTest("injected write fsync link and directory faults never claim ordinary success", () => {
  const faultCases = [
    ["after-write", "ENOSPC", "receipt_write_failed"],
    ["after-file-fsync", "EIO", "receipt_write_failed"],
    ["after-publish", "EDQUOT", "receipt_write_failed"],
    ["after-first-directory-fsync", "EIO", "receipt_write_ambiguous"],
  ] as const;
  for (const [stage, systemCode, expectedCode] of faultCases) {
    const authority = temporaryAuthority(`bridlewise-receipt-fault-${stage}-`);
    assert.throws(() => writeImmutableEvidence(authority, {
      mode: "exclusive-path", path: `fault/${stage}.bin`, bytes: Buffer.from("fault"), contentKind: "blob",
    }, {
      beforeStage: (observed) => {
        if (observed === stage) throw Object.assign(new Error(systemCode), { code: systemCode });
      },
    }), receiptError(expectedCode));
  }
});

mechanismTest("kill at every publication boundary leaves absence or complete bytes and explicit recovery artifacts", async () => {
  // Read from the policy that DEFINES the stages, so a stage added there is
  // killed at too, rather than left untested by a list nobody updated.
  const stages: readonly ReceiptFaultStage[] = ROOT_POLICY.receipts.immutableExecution.faultStages;
  for (const stage of stages) {
    const root = temporaryRepository(`bridlewise-receipt-kill-${stage}-`);
    const helper = crashWriterHelper(root);
    const result = await runProcess(helper, [root, stage]);
    assert.equal(result.signal, "SIGKILL");
    const authority = ensureReceiptAuthority(root, EVIDENCE_ROOT);
    const entries = listReceiptNamespaceEntries(authority, "crash");
    const target = entries.find((entry) => entry.name === "target.bin");
    if (target !== undefined) {
      assert.deepEqual(readFileSync(join(authority.absoluteRoot, "crash/target.bin")), Buffer.from("complete-bytes"));
    }
    assert.equal(entries.some((entry) => entry.name.includes(".pending-")) || target !== undefined, true);
  }
});

mechanismTest("current qualification keeps ordinary failures separate from receipt skips and independent accounting", () => {
  const fixture = receiptFixture();
  const first = fixture.inventory.tests[0]!;
  const second = createTestInventoryEntry(first.sourceId, first.sourceHash, "second case");
  const inventory = createTestInventory(fixture.inventory.scope, [first, second]);
  const discovered = inventory.tests.map((entry) => entry.id);
  for (const state of ["passed", "skipped", "todo", "cancelled", "withheld", "unknown", "summary", "candidate"] as const) {
    const passed = ["passed", "unknown", "summary", "candidate"].includes(state);
    const receipt = createTestReceipt(fixture.candidate, inventory, discovered, passed ? [second.id] : [], {
      discovered: 2, passed: passed ? 1 : 0, failed: 1,
      skipped: state === "skipped" || state === "withheld" ? 1 : 0,
      todo: state === "todo" ? 1 : 0, cancelled: state === "cancelled" ? 1 : 0,
    }, state === "withheld" ? [second.id] : []);
    const summary = state === "summary" ? { eventCount: 0, successful: false, counts: null }
      : state === "withheld" ? { ...failedRunnerSummary(receipt), counts: { tests: 1, failed: 1, passed: 0, cancelled: 0, skipped: 0, todo: 0 } }
      : failedRunnerSummary(receipt);
    const result = createTestResultReceipt(receipt, summary,
      state === "candidate" ? { ...fixture.candidate, semanticTreeHash: "4".repeat(64) } : fixture.candidate,
      state === "cancelled" ? [first.name, second.name] : [first.name], state === "unknown" ? ["unregistered case"] : []);
    const qualification = testResultQualification(parseTestResultReceiptValue(result));
    const failures = qualification.outcomes.filter((outcome) => outcome.kind === "fail");
    if (state === "passed") {
      assert.equal(qualification.complete, true);
      assert.deepEqual(failures, [], "complete ordinary failures may reach the separate historical comparison");
    } else {
      assert.ok(failures.length > 0, `${state} must survive beside the owned failing case`);
      if (state === "skipped" || state === "withheld") assert.ok(failures.some((outcome) => outcome.gate === "engine-test-skipped"));
      if (state === "cancelled") assert.ok(failures.some((outcome) => outcome.gate === "engine-test-cancelled"));
      if (state === "todo") assert.ok(failures.some((outcome) => outcome.gate === "engine-test-todo"));
      if (state === "summary" || state === "unknown") assert.equal(qualification.complete, false);
    }
  }
});

mechanismTest("a NAMED skip is judged by its identity like a failure: it leaves no independent refusal; an unnamed skip, a withheld test or a skip census that does not account every dispatched skip still refuses", () => {
  const fixture = receiptFixture();
  const first = fixture.inventory.tests[0]!;
  const second = createTestInventoryEntry(first.sourceId, first.sourceHash, "second case");
  const inventory = createTestInventory(fixture.inventory.scope, [first, second]);
  const discovered = inventory.tests.map((entry) => entry.id);
  const skipped = { identity: `${second.sourceId}::${second.name}`, reason: "live interop is opt-in" };
  const failuresOf = (failed: 0 | 1, skips: readonly { identity: string; reason: string }[] | undefined) => {
    const receipt = createTestReceipt(fixture.candidate, inventory, discovered, failed === 1 ? [] : [first.id],
      { discovered: 2, passed: failed === 1 ? 0 : 1, failed, skipped: 1, todo: 0, cancelled: 0 }, []);
    const result = createTestResultReceipt(receipt, failedRunnerSummary(receipt), fixture.candidate, failed === 1 ? [first.name] : [], [], undefined, skips);
    return testResultQualification(parseTestResultReceiptValue(result)).outcomes.filter((outcome) => outcome.kind === "fail");
  };
  assert.deepEqual(failuresOf(1, [skipped]), [], "a named skip beside an ordinary failure: both are judged by identity");
  const receipt = createTestReceipt(fixture.candidate, inventory, discovered, [],
    { discovered: 2, passed: 0, failed: 1, skipped: 1, todo: 0, cancelled: 0 }, []);
  const rows = testResultLedgerRows(parseTestResultReceiptValue(createTestResultReceipt(receipt, failedRunnerSummary(receipt), fixture.candidate, [first.name], [], undefined, [skipped])), "/");
  assert.deepEqual(rows.failures, [first.name, `${skipped.identity} (skipped)`].toSorted(), "the ledger row names the failure and the skip, each its own identity");
  assert.equal(rows.failureDigests[`${skipped.identity} (skipped)`], failureDigest({ name: "TestSkipped", message: skipped.reason }, "/"), "a skip's digest is its reason");
  assert.deepEqual(failuresOf(0, [skipped]), [], "a named skip alone: judged by identity");
  assert.ok(failuresOf(0, undefined).some((outcome) => outcome.gate === "engine-test-skipped"), "an unnamed skip stays an independent refusal");
  assert.throws(() => failuresOf(0, []), /test result accounting is invalid/u, "a census that names fewer skips than ran is refused");
  assert.throws(() => failuresOf(0, [skipped, { ...skipped, identity: `${skipped.identity}-2` }]), /test result accounting is invalid/u, "a census that names more skips than ran is refused");
});

mechanismTest("a run's failure statements say what each failure said: its error and every cause, outermost first; a failure without one says so", () => {
  const fixture = receiptFixture();
  const first = fixture.inventory.tests[0]!;
  const second = createTestInventoryEntry(first.sourceId, first.sourceHash, "second case");
  const inventory = createTestInventory(fixture.inventory.scope, [first, second]);
  const receipt = createTestReceipt(fixture.candidate, inventory, inventory.tests.map((entry) => entry.id), [],
    { discovered: 2, passed: 0, failed: 2, skipped: 0, todo: 0, cancelled: 0 }, []);
  const envelope = Object.assign(new Error("test failed", { cause: new TypeError("the worker answered violations: [\"recorded-execution-stderr-nonempty\"]") }), { name: "ERR_TEST_FAILURE" });
  const result = parseTestResultReceiptValue(createTestResultReceipt(receipt, failedRunnerSummary(receipt), fixture.candidate, [first.name, second.name], [], [
    { identity: first.name, file: first.sourceId, line: null, column: null, error: extractTestResultError(envelope) },
    { identity: second.name, file: second.sourceId, line: null, column: null, error: null },
  ]));
  const repeated = parseTestResultReceiptValue(createTestResultReceipt(receipt, failedRunnerSummary(receipt), fixture.candidate, [first.name, second.name], [], [
    { identity: first.name, file: first.sourceId, line: null, column: null, error: extractTestResultError(new Error("the same words", { cause: new TypeError("the same words") })) },
    { identity: second.name, file: second.sourceId, line: null, column: null, error: null },
  ]));
  assert.equal(testResultFailureStatements(repeated)[first.name], "Error: the same words", "a cause that only repeats its message is said once");
  assert.deepEqual(testResultFailureStatements(result), {
    [first.name]: 'ERR_TEST_FAILURE: test failed\n  caused by TypeError: the worker answered violations: ["recorded-execution-stderr-nonempty"]',
    [second.name]: "no error was recorded",
  });
});

mechanismTest("current qualification preserves execution overflow beside a valid owned-failure receipt", async () => {
  const root = temporaryRepository("bridlewise-current-result-overflow-");
  const authority = executionAuthority(root);
  const fixture = receiptFixture();
  const entry = fixture.inventory.tests[0]!;
  const receipt = createTestReceipt(fixture.candidate, fixture.inventory, [entry.id], [],
    { discovered: 1, passed: 0, failed: 1, skipped: 0, todo: 0, cancelled: 0 });
  const result = createTestResultReceipt(receipt, failedRunnerSummary(receipt), fixture.candidate, [entry.name], []);
  const worker = observationWorker(root, Buffer.from("bounded fixture"), Buffer.alloc(0), canonicalBytes(result), 1, false);
  const actual = await runWorkerWithEvidence(TEST_EXECUTION_OPERATION, { authority, workerPath: worker });
  assert.equal(actual.outcome, "failed");
  assert.ok(actual.terminal !== undefined);
  for (const overflow of [false, true]) {
    const context = beginRecordedExecution(authority, TEST_EXECUTION_OPERATION, ["fixture", "owned failure"]);
    // Explicit synthetic overflow perturbation of actual native transport;
    // the typed receipt does not claim an executed test body.
    const completed = completeRecordedExecution(context, {
      spawned: true, closeObserved: true, exitCode: 1, signal: null, spawnErrorCode: null,
      stdout: { bytes: Buffer.from("bounded fixture"), complete: !overflow, overflow },
      stderr: { bytes: Buffer.alloc(0), complete: true, overflow: false },
      resultPipe: { bytes: canonicalBytes(result), complete: true, overflow: false },
      terminal: actual.terminal,
    });
    assert.equal(completed.outcome, overflow ? "stream-overflow" : "failed");
    const qualification = testExecutionQualification(completed);
    assert.equal(qualification.complete, !overflow);
    assert.equal(qualification.outcomes.some((outcome) => outcome.gate === "engine-execution" && outcome.kind === "fail"), overflow);
  }
});

for (const control of ["clean-pass", "clean-failed", "straggler"] as const) {
  mechanismTest(`execution completion: native worker ${control} preserves transport and applies completion policy`, async (context) => {
    const root = temporaryRepository(`bridlewise-native-completion-${control}-`);
    const authority = executionAuthority(root);
    const fixture = receiptFixture();
    const failed = control === "clean-failed";
    const entry = fixture.inventory.tests[0]!;
    // These candidate/config/count values are synthetic parser inputs. Only
    // the worker, bytes, raw exit and descendant lifetime are real execution.
    const receipt = failed ? createTestReceipt(fixture.candidate, fixture.inventory, [entry.id], [],
      { discovered: 1, passed: 0, failed: 1, skipped: 0, todo: 0, cancelled: 0 }) : fixture.testReceipt;
    const result = createTestResultReceipt(receipt, failed ? failedRunnerSummary(receipt) : passingRunnerSummary(receipt),
      fixture.candidate, failed ? [entry.name] : [], []);
    const stdout = Buffer.from("native fixture stdout\n");
    const stderr = Buffer.from("native fixture stderr\n");
    const identityPath = join(root, "descendant-identity.json");
    const worker = observationWorker(root, stdout, stderr, canonicalBytes(result), failed ? 1 : 0, false,
      control === "straggler" ? identityPath : undefined);
    const observedPath = join(root, "adapter-observed.json");
    const launcher = join(root, "adapter-launcher.mjs");
    writeFileSync(launcher, [
      'import { writeFileSync } from "node:fs";',
      `import { runTestsWithEvidence } from ${JSON.stringify(new URL("../scripts/tooling/run-tests.ts", import.meta.url).href)};`,
      `import { ensureReceiptAuthority } from ${JSON.stringify(new URL("../src/filesystem/immutable-receipt.ts", import.meta.url).href)};`,
      `import { loadTestResultFromExecution, testExecutionQualification } from ${JSON.stringify(new URL("../scripts/tooling/test-execution.ts", import.meta.url).href)};`,
      `import { HarnessError } from ${JSON.stringify(new URL("../src/kernel/errors.ts", import.meta.url).href)};`,
      `import { withCurrentNodeRuntimeForFilesystemMechanismTest } from ${JSON.stringify(new URL("../src/filesystem/durable-filesystem-internal.ts", import.meta.url).href)};`,
      'await withCurrentNodeRuntimeForFilesystemMechanismTest(async () => {',
      `  const authority = { receipt: ensureReceiptAuthority(${JSON.stringify(root)}, ${JSON.stringify(EVIDENCE_ROOT)}), config: ${JSON.stringify(authority.config)} };`,
      `  const execution = await runTestsWithEvidence({ authority, workerPath: ${JSON.stringify(worker)} });`,
      '  let loadedIntegrityHash = null; let loadError = null; let loadErrorCode = null; let loadErrorIsHarness = false;',
      '  try { loadedIntegrityHash = loadTestResultFromExecution(authority.receipt, execution.attemptId).integrityHash; }',
      '  catch (error) { loadError = error instanceof Error ? error.message : String(error); loadErrorIsHarness = error instanceof HarnessError; loadErrorCode = loadErrorIsHarness ? error.code : null; }',
      `  writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({`,
      '    attemptId: execution.attemptId, outcome: execution.outcome, exitCode: execution.exitCode,',
      '    result: execution.result, stdout: execution.stdout.toString("base64"), stderr: execution.stderr.toString("base64"),',
      '    terminal: execution.terminal, qualification: testExecutionQualification(execution), loadedIntegrityHash, loadError, loadErrorCode, loadErrorIsHarness,',
      '  }));',
      // No copied finality policy: forward the actual adapter's policy exit.
      '  process.exitCode = execution.exitCode;',
      '});',
    ].join("\n"), { mode: 0o600 });
    const output: string[] = [];
    const environment = { ...process.env };
    delete environment.HARNESS_MUTATION_RUN;
    delete environment.HARNESS_RUN_INVOCATION;
    const outer = await superviseCommand({
      supervisor: testProcessSupervisorBinary(), command: process.execPath, args: [launcher],
      env: environment, hardCeilingMs: 60_000, killGraceMs: 1_000,
      onStdout: (chunk) => { output.push(chunk.toString()); }, onStderr: (chunk) => { output.push(chunk.toString()); },
    });
    context.diagnostic(JSON.stringify({ scope: "actual native adapter launcher", control, outer, launcherOutput: output.join("") }));
    const observed = JSON.parse(readFileSync(observedPath, "utf8")) as {
      attemptId: string; outcome: string; exitCode: number; result: unknown; stdout: string; stderr: string;
      terminal: SupervisedCommand; qualification: ReturnType<typeof testExecutionQualification>;
      loadedIntegrityHash: string | null; loadError: string | null;
      loadErrorCode: string | null; loadErrorIsHarness: boolean;
    };
    const identity = control === "straggler" ? parseProcessIdentityRecord(readFileSync(identityPath, "utf8")) : undefined;
    context.diagnostic(JSON.stringify({ scope: "synthetic receipt transport; no executed test body claim", control,
      resultIntegrityHash: result.integrityHash, observed, descendant: identity ?? null }));
    for (const terminal of [outer, observed.terminal]) {
      assert.ok(terminal.supervision !== undefined, "actual native supervision receipt is required");
      assert.equal(terminal.ending, "exited", output.join(""));
      assert.equal(terminal.outputComplete, true);
      assert.equal(terminal.signal, null);
      assert.equal(terminal.orphanedGroupKilled, false);
      assert.equal(terminal.supervision.noOwnedChildren, true);
      assert.equal(terminal.supervision.timedOut, false);
      assert.equal(terminal.supervision.interrupted, false);
      assert.equal(terminal.supervision.commandKilled, false);
    }
    assert.deepEqual(outer.supervision!.killed, [], "outer cleanup must already be unnecessary");
    assert.equal(observed.terminal.status, failed ? 1 : 0);
    assert.equal(observed.terminal.exitCode, failed ? 1 : 0);
    assert.equal(observed.stdout, stdout.toString("base64"));
    assert.equal(observed.stderr, stderr.toString("base64"));
    assert.deepEqual(observed.result, result, "the same typed result survived the actual fd-3 transport");
    if (control === "straggler") {
      assert.ok(identity !== undefined && identity.startTime !== null, "recorded PID and birth identity must be readable");
      assert.deepEqual(observed.terminal.supervision!.killed, [identity.pid]);
      assert.deepEqual(observed.terminal.supervision!.reaped.filter((child) => child.killed).map((child) => child.pid), [identity.pid]);
      assert.equal(isProcessIdentityLive(identity), false, "the observed descendant must no longer be alive");
    } else {
      assert.deepEqual(observed.terminal.supervision!.killed, []);
      assert.equal(observed.qualification.complete, true);
      assert.equal(observed.qualification.outcomes.some((outcome) => outcome.gate === "engine-execution" && outcome.kind === "fail"), false);
      if (!failed) assert.equal(observed.loadedIntegrityHash, result.integrityHash);
    }
    assert.deepEqual({ outcome: observed.outcome, exitCode: observed.exitCode, outerExitCode: outer.exitCode }, {
      outcome: control === "straggler" ? "runner-error" : failed ? "failed" : "passed",
      exitCode: control === "straggler" || failed ? 1 : 0, outerExitCode: control === "straggler" || failed ? 1 : 0,
    }, "actual native cleanup must veto an otherwise passed typed result and propagate its policy exit");
    assert.deepEqual(scanExecutionEvidence(authority.receipt), [{
      attemptId: observed.attemptId, status: "complete", outcome: observed.outcome,
    }]);
    if (control === "straggler") {
      assert.equal(observed.qualification.complete, false);
      assert.deepEqual(observed.qualification.outcomes.filter((outcome) => outcome.gate === "engine-execution"), [{
        gate: "engine-execution", kind: "fail", message: "independent execution outcome runner-error",
      }]);
      assert.equal(observed.loadedIntegrityHash, null);
      assert.equal(observed.loadError, "test execution is not a passing complete test result");
      assert.deepEqual({ status: result.result.status, exitCode: result.result.exitCode }, { status: "passed", exitCode: 0 });
    }
    if (control !== "clean-pass") {
      assert.equal(observed.loadErrorIsHarness, true, "the successful-result loader must expose a typed refusal");
      assert.equal(observed.loadErrorCode, "execution_result_not_passing");
      assert.equal(observed.loadError, "test execution is not a passing complete test result");
      assert.equal(observed.loadedIntegrityHash, null);
    } else {
      assert.deepEqual({ error: observed.loadError, code: observed.loadErrorCode }, { error: null, code: null });
    }
  });
}

for (const variant of ["valid", "absent", "null", "killed", "receipt", "output", "status", "v2", "error-code", "extra-raw-hash", "extra-stripped-hash"] as const) {
  mechanismTest(`execution completion: persisted native facts ${variant} are replayed before admission`, async () => {
    const root = temporaryRepository(`bridlewise-native-replay-${variant}-`);
    const { authority, result, actual, observed } = await nativeReplayFixture(root);
    const context = beginRecordedExecution(authority, TEST_EXECUTION_OPERATION, ["persisted-parser-fixture", variant]);
    // These are deliberately republished parser inputs in a NEW private attempt.
    // Native facts in the matched control originate from the actual worker above;
    // altered records claim no new native execution or authenticity.
    const native = commandTerminalFacts(actual.terminal);
    const unsigned: Record<string, unknown> = { ...observed, attemptId: context.attempt.attemptId,
      start: { path: context.startPath, sha256: context.startSha256 }, native };
    if (variant === "absent") delete unsigned.native;
    if (variant === "null") unsigned.native = null;
    if (variant === "killed") unsigned.native = { ...native, killedDescendants: 1 };
    if (variant === "receipt") unsigned.native = { ...native, receiptPresent: false };
    if (variant === "output") unsigned.native = { ...native, outputComplete: false };
    // Internally normal native exit1 must still disagree with the stored raw0.
    if (variant === "status") unsigned.native = { ...native, status: 1, exitCode: 1 };
    if (variant === "v2") unsigned.schemaVersion = ROOT_POLICY.receipts.testExecution.terminalSchemaVersion.replace(/v3$/u, "v2");
    if (variant === "error-code") unsigned.errorCode = "unearned_pass_code";
    if (variant === "extra-raw-hash" || variant === "extra-stripped-hash") unsigned.native = { ...native, unobservedClaim: true };
    const hashed = variant === "extra-stripped-hash" ? { ...unsigned, native } : unsigned;
    writeImmutableEvidence(authority.receipt, {
      mode: "unique-attempt", attempt: context.attempt, ordinal: 999_999, label: "terminal", extension: ".json",
      bytes: canonicalBytes({ ...unsigned, integrityHash: canonicalHash(hashed) }), contentKind: "canonical-json",
    });
    const entry = scanExecutionEvidence(authority.receipt).find((candidate) => candidate.attemptId === context.attempt.attemptId);
    if (variant === "valid") {
      assert.deepEqual(loadTestResultFromExecution(authority.receipt, context.attempt.attemptId), result);
      assert.deepEqual(entry, { attemptId: context.attempt.attemptId, status: "complete", outcome: "passed" });
    } else {
      const malformed = variant === "absent" || variant === "v2" || variant === "extra-raw-hash" || variant === "extra-stripped-hash";
      assert.throws(() => loadTestResultFromExecution(authority.receipt, context.attempt.attemptId), (error: unknown) => {
        if (malformed) {
          assert.ok(error instanceof InputError, "invalid persisted native facts must expose the typed parser boundary");
          assert.equal(error.code, "execution_evidence_invalid");
          assert.deepEqual(error.safeDetails, {
            reason: "schema-invalid", issues: variant === "v2" ? "schemaVersion: invalid_value" : "native: custom",
          });
        } else {
          assert.ok(error instanceof HarnessError);
          assert.equal(error.code, "execution_terminal_outcome_invalid");
          assert.equal(error.message, "terminal outcome does not match observed execution facts");
        }
        return true;
      });
      assert.deepEqual(entry, { attemptId: context.attempt.attemptId, status: "unsafe",
        reasonCode: malformed ? "attempt-schema-or-reference-invalid" : "terminal-outcome-invalid" });
    }
    assert.deepEqual(loadTestResultFromExecution(authority.receipt, actual.attemptId), result,
      "the original observed evidence stays intact beside its private parser variant");
  });
}

for (const variant of ["valid", "missing-start", "duplicate-start", "duplicate-terminal", "special-entry", "unexpected-event",
  "start-id", "start-authority", "start-root", "start-path", "start-hash", "operation", "config", "policy",
  "terminal-filename", "terminal-attempt", "terminal-reference", "result-reference", "result-schema", "result-missing",
  "evidence-integrity", "evidence-schema"] as const) {
  mechanismTest(`execution completion: persisted attempt ${variant} has one shared scanner and loader boundary`, async () => {
    const root = temporaryRepository(`bridlewise-attempt-replay-${variant}-`);
    const { authority, result, actual, observed, start } = await nativeReplayFixture(root);
    const attempt = allocateReceiptAttempt(authority.receipt, randomUUID());
    const startRecord: Record<string, unknown> = { ...start, attemptId: attempt.attemptId };
    if (variant === "start-id") startRecord.attemptId = randomUUID();
    if (variant === "start-authority") startRecord.authority = { ...start.authority as Record<string, unknown>, authorityHash: "f".repeat(64) };
    if (variant === "start-root") startRecord.authority = { ...start.authority as Record<string, unknown>, relativeRoot: ".other/evidence" };
    const publishStart = (record: Record<string, unknown>) => writeImmutableEvidence(authority.receipt, {
      mode: "unique-attempt", attempt, ordinal: 0, label: "start", extension: ".json",
      bytes: canonicalBytes({ ...record, integrityHash: canonicalHash(record) }), contentKind: "canonical-json",
    });
    const startReference = variant === "missing-start" ? undefined : publishStart(startRecord);
    if (variant === "duplicate-start") publishStart({ ...startRecord, command: ["duplicate private parser start"] });
    const unsigned: Record<string, unknown> = { ...observed, attemptId: attempt.attemptId,
      start: startReference === undefined ? observed.start : { path: startReference.path, sha256: startReference.sha256 } };
    if (variant === "start-path") unsigned.start = observed.start;
    if (variant === "start-hash") unsigned.start = { path: startReference!.path, sha256: "f".repeat(64) };
    if (variant === "operation") unsigned.operation = CHECK_EXECUTION_OPERATION;
    if (variant === "config") unsigned.config = { ...authority.config, canonicalHash: "f".repeat(64) };
    if (variant === "policy") unsigned.policy = { rootPolicyHash: "f".repeat(64) };
    if (variant === "terminal-attempt") unsigned.attemptId = randomUUID();
    if (variant === "terminal-reference") {
      const reference = observed.stdout as Record<string, unknown> & { byteLength: number };
      unsigned.stdout = { ...reference, byteLength: reference.byteLength + 1 };
    }
    if (variant === "result-reference") {
      const reference = observed.result as Record<string, unknown> & { byteLength: number };
      unsigned.result = { ...reference, byteLength: reference.byteLength + 1 };
    }
    if (variant === "result-schema") unsigned.result = { ...observed.result as Record<string, unknown>, integrityHash: "f".repeat(64) };
    if (variant === "result-missing") unsigned.result = null;
    if (variant === "evidence-schema") unsigned.outcome = "unregistered-outcome";
    const publishTerminal = (record: Record<string, unknown>) => {
      const bytes = canonicalBytes({ ...record, integrityHash: variant === "evidence-integrity" ? "f".repeat(64) : canonicalHash(record) });
      if (variant === "terminal-filename") {
        assert.notEqual(sha256(bytes), "f".repeat(64));
        return writeImmutableEvidence(authority.receipt, {
          mode: "exclusive-path", path: `${attempt.relativeDirectory}/999999-terminal-${"f".repeat(64)}.json`,
          bytes, contentKind: "canonical-json",
        });
      }
      return writeImmutableEvidence(authority.receipt, {
        mode: "unique-attempt", attempt, ordinal: 999_999, label: "terminal", extension: ".json",
        bytes, contentKind: "canonical-json",
      });
    };
    publishTerminal(unsigned);
    if (variant === "duplicate-terminal") publishTerminal({ ...unsigned, durationNanoseconds: `${String(unsigned.durationNanoseconds)}0` });
    if (variant === "special-entry") mkdirSync(join(authority.receipt.absoluteRoot, attempt.relativeDirectory, "unexpected-directory"), { mode: 0o700 });
    if (variant === "unexpected-event") writeImmutableEvidence(authority.receipt, {
      mode: "unique-attempt", attempt, ordinal: 1, label: "unexpected", extension: ".bin", bytes: Buffer.from("unexpected"), contentKind: "blob",
    });
    const entry = scanExecutionEvidence(authority.receipt).find((candidate) => candidate.attemptId === attempt.attemptId);
    if (variant === "valid") {
      assert.deepEqual(loadTestResultFromExecution(authority.receipt, attempt.attemptId), result);
      assert.deepEqual(entry, { attemptId: attempt.attemptId, status: "complete", outcome: "passed" });
    } else if (variant === "evidence-integrity" || variant === "evidence-schema") {
      assert.throws(() => loadTestResultFromExecution(authority.receipt, attempt.attemptId), (error: unknown) => {
        assert.ok(error instanceof InputError, "malformed persisted evidence must expose the typed parser boundary");
        assert.equal(error.code, "execution_evidence_invalid");
        assert.deepEqual(error.safeDetails, variant === "evidence-integrity"
          ? { reason: "integrity-invalid" }
          : { reason: "schema-invalid", issues: "outcome: invalid_value" });
        return true;
      });
      assert.deepEqual(entry, { attemptId: attempt.attemptId, status: "unsafe", reasonCode: "attempt-schema-or-reference-invalid" });
    } else {
      const reasonCode = variant === "special-entry" ? "attempt-special-entry"
        : ["missing-start", "duplicate-start", "duplicate-terminal", "unexpected-event"].includes(variant) ? "attempt-event-set-invalid"
        : variant === "start-id" ? "start-binding-invalid"
        : variant === "start-authority" || variant === "start-root" ? "start-authority-binding-invalid"
        : variant === "terminal-filename" ? "terminal-filename-binding-invalid"
        : variant === "terminal-attempt" ? "terminal-attempt-binding-invalid"
        : variant === "terminal-reference" ? "terminal-reference-binding-invalid"
        : variant === "result-reference" ? "terminal-result-binding-invalid"
        : variant === "result-schema" ? "terminal-result-schema-binding-invalid"
        : variant === "result-missing" ? "terminal-result-reference-missing" : "terminal-start-binding-invalid";
      assert.throws(() => loadTestResultFromExecution(authority.receipt, attempt.attemptId), (error: unknown) => {
        assert.ok(error instanceof HarnessError);
        assert.equal(error.code, "execution_attempt_invalid");
        assert.equal(error.message, `execution attempt refused: ${reasonCode}`);
        assert.deepEqual(error.safeDetails, { status: "unsafe", reasonCode });
        return true;
      });
      assert.deepEqual(entry, { attemptId: attempt.attemptId, status: "unsafe", reasonCode });
    }
    assert.deepEqual(loadTestResultFromExecution(authority.receipt, actual.attemptId), result);
  });
}

for (const operation of ["test", "check", "unknown"] as const) {
  mechanismTest(`execution errors: operation registration ${operation} has an exact typed contract`, () => {
    if (operation === "unknown") {
      assert.throws(() => executionOperationSpec("unregistered-fixture-operation" as Parameters<typeof executionOperationSpec>[0]), (error: unknown) => {
        assert.ok(error instanceof HarnessError, "operation registration must expose a typed invariant refusal");
        assert.equal(error.code, "execution_operation_invalid");
        assert.equal(error.message, "execution operation is not registered");
        return true;
      });
    } else {
      const id = operation === "test" ? TEST_EXECUTION_OPERATION : CHECK_EXECUTION_OPERATION;
      assert.equal(executionOperationSpec(id).id, id);
      assert.equal(executionOperationSpec(id).workerMode, operation);
    }
  });
}

for (const variant of ["valid", "utf8", "json", "framing", "bom", "noncanonical"] as const) {
  mechanismTest(`execution errors: raw CHECK worker ${variant} preserves the public parser outcome`, async (context) => {
    const root = temporaryRepository(`bridlewise-check-parser-${variant}-`);
    const authority = executionAuthority(root);
    const fixture = receiptFixture();
    const testResultReceipt = createTestResultReceipt(fixture.testReceipt, passingRunnerSummary(fixture.testReceipt), fixture.candidate, [], []);
    // A synthetic typed CHECK payload, not a claim that verification or its
    // example test body ran. The worker, pipes and native completion are real.
    const unsigned = { schemaVersion: ROOT_POLICY.receipts.testExecution.checkResultSchemaVersion,
      integrityClaim: "self-integrity-only-not-authenticity", testResultReceipt,
      verification: { scope: "synthetic parser fixture" }, result: { status: "passed", exitCode: 0 } };
    const check = { ...unsigned, integrityHash: canonicalHash(unsigned) };
    const canonical = canonicalBytes(check);
    const bytes = variant === "utf8" ? Buffer.from([0xff, 0x0a])
      : variant === "json" ? Buffer.from("{broken-json\n")
      : variant === "framing" ? canonical.subarray(0, canonical.length - 1)
      : variant === "bom" ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical])
      : variant === "noncanonical" ? Buffer.from(`${JSON.stringify(check, null, 2)}\n`) : canonical;
    const stdout = Buffer.from("raw CHECK parser stdout\n");
    const stderr = Buffer.from("raw CHECK parser stderr\n");
    const worker = observationWorker(root, stdout, stderr, bytes, 0, false);
    const actual = await runWorkerWithEvidence(CHECK_EXECUTION_OPERATION, { authority, workerPath: worker });
    context.diagnostic(JSON.stringify({ scope: "synthetic CHECK payload; actual native transport", variant,
      resultBytesSha256: sha256(bytes), outcome: actual.outcome, exitCode: actual.exitCode, terminal: actual.terminal }));
    assert.ok(actual.terminal !== undefined);
    assert.equal(actual.terminal.ending, "exited");
    assert.equal(actual.terminal.status, 0);
    assert.equal(actual.terminal.exitCode, 0);
    assert.equal(actual.terminal.signal, null);
    assert.equal(actual.terminal.outputComplete, true);
    assert.equal(actual.terminal.orphanedGroupKilled, false);
    assert.ok(actual.terminal.supervision !== undefined);
    assert.equal(actual.terminal.supervision.noOwnedChildren, true);
    assert.equal(actual.terminal.supervision.timedOut, false);
    assert.equal(actual.terminal.supervision.interrupted, false);
    assert.equal(actual.terminal.supervision.commandKilled, false);
    assert.deepEqual(actual.terminal.supervision.killed, []);
    assert.deepEqual(actual.stdout, stdout);
    assert.deepEqual(actual.stderr, stderr);
    const directory = `attempts/${actual.attemptId}`;
    const terminalName = readdirSync(join(authority.receipt.absoluteRoot, directory)).find((name) => name.startsWith("999999-terminal-"));
    assert.ok(terminalName !== undefined);
    const terminal = JSON.parse(readImmutableEvidence(authority.receipt, `${directory}/${terminalName}`, "canonical-json").toString()) as {
      errorCode: string | null; resultPipe: { path: string; encoding: "utf8" | "binary" };
    };
    assert.deepEqual(readImmutableEvidence(authority.receipt, terminal.resultPipe.path,
      terminal.resultPipe.encoding === "utf8" ? "canonical-json" : "blob"), bytes);
    assert.deepEqual({ outcome: actual.outcome, exitCode: actual.exitCode, errorCode: terminal.errorCode }, variant === "valid"
      ? { outcome: "passed", exitCode: 0, errorCode: null }
      : { outcome: "runner-error", exitCode: 1, errorCode: "incomplete_or_invalid_worker_result" });
    assert.deepEqual(actual.result, variant === "valid" ? check : null);
    assert.deepEqual(scanExecutionEvidence(authority.receipt), [{
      attemptId: actual.attemptId, status: "complete", outcome: actual.outcome,
    }]);
  });
}

mechanismTest("parent-observed stdout stderr and result pipe are independently complete and loadable", async () => {
  const root = temporaryRepository("bridlewise-receipt-parent-");
  const authority = executionAuthority(root);
  const fixture = receiptFixture();
  const result = createTestResultReceipt(
    fixture.testReceipt,
    passingRunnerSummary(fixture.testReceipt),
    fixture.testReceipt.candidate,
    [],
    [],
  );
  const stdout = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x0a]);
  const stderr = Buffer.from("observed stderr\n");
  const worker = observationWorker(root, stdout, stderr, canonicalBytes(result), 0, false);
  const completed = await runWorkerWithEvidence(TEST_EXECUTION_OPERATION, { authority, workerPath: worker });
  assert.equal(completed.outcome, "passed");
  assert.equal(completed.terminal?.ending, "exited");
  assert.equal(completed.terminal?.exitCode, 0);
  assert.equal(completed.terminal?.outputComplete, true);
  assert.equal(completed.terminal?.supervision?.noOwnedChildren, true);
  assert.equal(testExecutionQualification(completed).complete, true);
  assert.deepEqual(completed.stdout, stdout);
  assert.deepEqual(completed.stderr, stderr);
  assert.deepEqual(loadTestResultFromExecution(authority.receipt, completed.attemptId), result);
  assert.deepEqual(scanExecutionEvidence(authority.receipt), [{
    attemptId: completed.attemptId, status: "complete", outcome: "passed",
  }]);
});

mechanismTest("unspawned setup failure and abrupt child death both receive immutable terminal events", async () => {
  const root = temporaryRepository("bridlewise-receipt-process-failure-");
  const authority = executionAuthority(root);
  const setup = await runWorkerWithEvidence(TEST_EXECUTION_OPERATION, {
    authority,
    workerArguments: [],
    setupFailureCode: "simulated_setup_failure",
  });
  assert.equal(setup.outcome, "setup-failed");
  assert.equal(setup.terminal, undefined);
  assert.equal(testExecutionQualification(setup).complete, false);

  const crashWorker = observationWorker(root, Buffer.from("before crash\n"), Buffer.from("fatal\n"), null, 1, true);
  const crashed = await runWorkerWithEvidence(TEST_EXECUTION_OPERATION, { authority, workerPath: crashWorker });
  assert.equal(crashed.outcome, "runner-crash");
  assert.notEqual(crashed.terminal, undefined);
  assert.equal(testExecutionQualification(crashed).complete, false);
  assert.deepEqual(scanExecutionEvidence(authority.receipt).map((entry) => entry.status), ["complete", "complete"]);
});

mechanismTest("oversized child output is bounded, marked incomplete, and terminates without a false result", async () => {
  const root = temporaryRepository("bridlewise-receipt-overflow-");
  const authority = executionAuthority(root);
  const worker = join(root, "overflow-worker.mjs");
  writeFileSync(worker, [
    "import { writeSync } from 'node:fs';",
    "try { writeSync(1, Buffer.alloc(16_777_217, 0x58)); } catch {}",
    "try { writeSync(3, Buffer.from('{}\\n')); } catch {}",
    "",
  ].join("\n"), { mode: 0o600 });
  const completed = await runWorkerWithEvidence(TEST_EXECUTION_OPERATION, { authority, workerPath: worker });
  assert.equal(completed.outcome, "stream-overflow");
  assert.equal(testExecutionQualification(completed).complete, false);
  assert.equal(completed.stdout.length, 16_777_216);
  assert.deepEqual(scanExecutionEvidence(authority.receipt), [{
    attemptId: completed.attemptId,
    status: "complete",
    outcome: "stream-overflow",
  }]);
});

mechanismTest("scanner distinguishes incomplete ambiguous unsafe and complete evidence without cleanup", async () => {
  const root = temporaryRepository("bridlewise-receipt-scanner-");
  const authority = executionAuthority(root);
  const incomplete = beginRecordedExecution(authority, TEST_EXECUTION_OPERATION, ["node", "not-started"],
    "22222222-2222-4222-8222-222222222222");

  const ambiguous = beginRecordedExecution(authority, TEST_EXECUTION_OPERATION, ["node", "ambiguous"],
    "33333333-3333-4333-8333-333333333333");
  assert.throws(() => writeImmutableEvidence(authority.receipt, {
    mode: "unique-attempt", attempt: ambiguous.attempt, ordinal: 5, label: "probe", extension: ".bin",
    bytes: Buffer.from("probe"), contentKind: "blob",
  }, {
    afterStage: (stage) => {
      if (stage === "after-publish") throw new Error("simulated crash boundary");
    },
  }), receiptError("receipt_write_ambiguous"));

  const unsafe = beginRecordedExecution(authority, TEST_EXECUTION_OPERATION, ["node", "unsafe"],
    "44444444-4444-4444-8444-444444444444");
  writeImmutableEvidence(authority.receipt, {
    mode: "exclusive-path", path: `${unsafe.attempt.relativeDirectory}/unexpected.bin`,
    bytes: Buffer.from("unexpected"), contentKind: "blob",
  });

  const fixture = receiptFixture();
  const worker = observationWorker(root, Buffer.from("ok\n"), Buffer.alloc(0),
    canonicalBytes(createTestResultReceipt(
      fixture.testReceipt,
      passingRunnerSummary(fixture.testReceipt),
      fixture.testReceipt.candidate,
      [],
      [],
    )), 0, false);
  const complete = await runWorkerWithEvidence(TEST_EXECUTION_OPERATION, { authority, workerPath: worker });
  const byId = new Map(scanExecutionEvidence(authority.receipt).map((entry) => [entry.attemptId, entry]));
  assert.equal(byId.get(incomplete.attempt.attemptId)?.status, "incomplete");
  assert.equal(byId.get(ambiguous.attempt.attemptId)?.status, "ambiguous");
  assert.equal(byId.get(unsafe.attempt.attemptId)?.status, "unsafe");
  assert.equal(byId.get(complete.attemptId)?.status, "complete");
  assert.ok(readdirSync(join(authority.receipt.absoluteRoot, ambiguous.attempt.relativeDirectory))
    .some((entry) => entry.includes(".pending-")));
});

mechanismTest("repeated parent executions create distinct attempts while reusing deterministic result bytes", async () => {
  const root = temporaryRepository("bridlewise-receipt-repeat-");
  const authority = executionAuthority(root);
  const fixture = receiptFixture();
  const resultBytes = canonicalBytes(createTestResultReceipt(
    fixture.testReceipt,
    passingRunnerSummary(fixture.testReceipt),
    fixture.testReceipt.candidate,
    [],
    [],
  ));
  const worker = observationWorker(root, Buffer.from("stable\n"), Buffer.alloc(0), resultBytes, 0, false);
  const executions = [];
  for (let repetition = 0; repetition < 3; repetition += 1) {
    executions.push(await runWorkerWithEvidence(TEST_EXECUTION_OPERATION, { authority, workerPath: worker }));
  }
  assert.equal(new Set(executions.map((entry) => entry.attemptId)).size, 3);
  assert.equal(listReceiptNamespaceEntries(authority.receipt, "results/sha256").length, 1);
  assert.deepEqual(scanExecutionEvidence(authority.receipt).map((entry) => entry.status), [
    "complete", "complete", "complete",
  ]);
});

mechanismTest("reader racing a large writer observes absence or one complete immutable value", async () => {
  const root = temporaryRepository("bridlewise-receipt-reader-race-");
  const authority = ensureReceiptAuthority(root, EVIDENCE_ROOT);
  const helper = writerHelper(root);
  const bytes = Buffer.alloc(1_048_576, 0x5a);
  const payload = join(root, "large-payload.bin");
  writeFileSync(payload, bytes);
  const child = runProcess(helper, [root, "large-file", payload]);
  let completeReads = 0;
  while (true) {
    try {
      const observed = readImmutableEvidence(authority, "atomic/value.bin", "blob");
      assert.deepEqual(observed, bytes);
      completeReads += 1;
    } catch (error) {
      assert.ok(error instanceof HarnessError);
    }
    const settled = await Promise.race([child.then(() => true), new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))]);
    if (settled) break;
  }
  assert.deepEqual(readImmutableEvidence(authority, "atomic/value.bin", "blob"), bytes);
  assert.ok(completeReads >= 0);
});

/** Native transport supplies the matched facts; typed receipt inputs remain synthetic. */
async function nativeReplayFixture(root: string) {
  const authority = executionAuthority(root);
  const fixture = receiptFixture();
  const result = createTestResultReceipt(fixture.testReceipt, passingRunnerSummary(fixture.testReceipt), fixture.candidate, [], []);
  const worker = observationWorker(root, Buffer.from("persisted native fixture\n"), Buffer.alloc(0), canonicalBytes(result), 0, false);
  const actual = await runWorkerWithEvidence(TEST_EXECUTION_OPERATION, { authority, workerPath: worker });
  assert.equal(actual.outcome, "passed");
  assert.ok(actual.terminal !== undefined);
  assert.deepEqual(loadTestResultFromExecution(authority.receipt, actual.attemptId), result);
  const directory = `attempts/${actual.attemptId}`;
  const names = readdirSync(join(authority.receipt.absoluteRoot, directory));
  const terminalName = names.find((name) => name.startsWith("999999-terminal-"));
  const startName = names.find((name) => name.startsWith("000000-start-"));
  assert.ok(terminalName !== undefined && startName !== undefined);
  const { integrityHash: _terminalHash, ...observed } = JSON.parse(readImmutableEvidence(authority.receipt,
    `${directory}/${terminalName}`, "canonical-json").toString()) as Record<string, unknown>;
  const { integrityHash: _startHash, ...start } = JSON.parse(readImmutableEvidence(authority.receipt,
    `${directory}/${startName}`, "canonical-json").toString()) as Record<string, unknown>;
  return { authority, result, actual: { ...actual, terminal: actual.terminal }, observed, start };
}

function receiptFixture() {
  const { entry, inventory } = createCanonicalNodeTestInventoryFixture({
    sourceId: "test/example.test.ts",
    sourceHash: "1".repeat(64),
    name: "example",
  });
  const candidate = {
    manifestSchemaVersion: CANDIDATE_MANIFEST_SCHEMA_VERSION,
    formatPolicyRevision: ROOT_POLICY.verification.candidateFormat.revision,
    semanticTreeHash: "2".repeat(64),
    formatVerificationHash: "3".repeat(64),
  } as const;
  const counts = { discovered: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 } as const;
  return { candidate, inventory, testReceipt: createTestReceipt(candidate, inventory, [entry.id], [entry.id], counts) };
}

function passingRunnerSummary(receipt: TestReceipt): TestRunnerSummary {
  return {
    eventCount: 1,
    successful: true,
    counts: {
      tests: receipt.inventory.length,
      failed: receipt.counts.failed,
      passed: receipt.counts.passed,
      cancelled: receipt.counts.cancelled,
      skipped: receipt.counts.skipped,
      todo: receipt.counts.todo,
    },
  };
}

function failedRunnerSummary(receipt: TestReceipt): TestRunnerSummary {
  return {
    ...passingRunnerSummary(receipt),
    successful: false,
  };
}

function temporaryRepository(prefix: string): string {
  const path = createTempDir(prefix);
  TEMPORARY_PATHS.add(path);
  return path;
}

function emptyTreeIdentity(root: string): Readonly<Record<string, string | readonly string[]>> {
  const stats = lstatSync(root, { bigint: true });
  return Object.freeze({
    entries: Object.freeze(readdirSync(root).toSorted()),
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    links: stats.nlink.toString(10),
    mode: stats.mode.toString(8),
    size: stats.size.toString(10),
    modifiedNanoseconds: stats.mtimeNs.toString(10),
    changedNanoseconds: stats.ctimeNs.toString(10),
  });
}

function temporaryAuthority(prefix: string): ReceiptAuthority {
  return ensureReceiptAuthority(temporaryRepository(prefix), EVIDENCE_ROOT);
}

function executionAuthority(root: string): ExecutionAuthority {
  return {
    receipt: ensureReceiptAuthority(root, EVIDENCE_ROOT),
    config: {
      canonicalHash: "1".repeat(64),
      sourceHash: "2".repeat(64),
      repositoryManifestHash: "3".repeat(64),
    },
  };
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function receiptError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof HarnessError && error.code === code;
}

function observationWorker(
  root: string,
  stdout: Buffer,
  stderr: Buffer,
  result: Buffer | null,
  exitCode: number,
  crash: boolean,
  stragglerIdentityPath?: string,
): string {
  const variant = canonicalBytes({ exitCode, crash, stragglerIdentityPath: stragglerIdentityPath ?? null });
  const path = join(root, `worker-${sha256(Buffer.concat([stdout, stderr, result ?? Buffer.alloc(0), variant]))}.mjs`);
  const factsOwner = new URL("../src/process/process-facts.ts", import.meta.url).href;
  writeFileSync(path, [
    "import { writeSync } from 'node:fs';",
    ...(stragglerIdentityPath === undefined ? [] : [
      'import assert from "node:assert/strict"; import { spawn } from "node:child_process"; import { once } from "node:events"; import { writeFileSync } from "node:fs";',
      `import { processIdentity, processIdentityRecord, parseProcessIdentityRecord, isProcessIdentityLive } from ${JSON.stringify(factsOwner)};`,
      `const childCode = ${JSON.stringify(`import { processIdentityRecord } from ${JSON.stringify(factsOwner)}; process.send(processIdentityRecord()); setInterval(() => {}, 1000);`)};`,
      'const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });',
      'const [ready] = await once(child, "message"); const identity = parseProcessIdentityRecord(ready);',
      'assert.ok(identity !== undefined && identity.startTime !== null); assert.equal(identity.pid, child.pid);',
      'assert.deepEqual(processIdentity(child.pid), identity); assert.equal(isProcessIdentityLive(identity), true);',
      `writeFileSync(${JSON.stringify(stragglerIdentityPath)}, processIdentityRecord(identity));`,
      'child.disconnect(); child.unref();',
    ]),
    `writeSync(1, Buffer.from(${JSON.stringify(stdout.toString("base64"))}, 'base64'));`,
    `writeSync(2, Buffer.from(${JSON.stringify(stderr.toString("base64"))}, 'base64'));`,
    ...(result === null ? [] : [`writeSync(3, Buffer.from(${JSON.stringify(result.toString("base64"))}, 'base64'));`]),
    crash ? "process.kill(process.pid, 'SIGKILL');" : `process.exitCode = ${exitCode};`,
    "",
  ].join("\n"), { mode: 0o600 });
  return path;
}

function writerHelper(root: string): string {
  const path = join(root, "writer-helper.mjs");
  const moduleUrl = new URL("../src/filesystem/immutable-receipt.ts", import.meta.url).href;
  const filesystemInternalUrl = new URL("../src/filesystem/durable-filesystem-internal.ts", import.meta.url).href;
  writeFileSync(path, [
    `import { ensureReceiptAuthority, writeImmutableEvidence } from ${JSON.stringify(moduleUrl)};`,
    `import { withCurrentNodeRuntimeForFilesystemMechanismTest } from ${JSON.stringify(filesystemInternalUrl)};`,
    "import { readFileSync } from 'node:fs';",
    "const [root, mode, encoded] = process.argv.slice(2);",
    "if (mode === 'permissive-umask') process.umask(0o000);",
    "if (mode === 'restrictive-umask') process.umask(0o777);",
    "withCurrentNodeRuntimeForFilesystemMechanismTest(() => {",
    `const authority = ensureReceiptAuthority(root, ${JSON.stringify(EVIDENCE_ROOT)});`,
    "const bytes = mode === 'large-file' ? readFileSync(encoded) : Buffer.from(encoded, 'base64');",
    "try {",
    "  const request = mode === 'exclusive'",
    "    ? { mode: 'exclusive-path', path: 'race/value.bin', bytes, contentKind: 'blob' }",
    "    : mode === 'large-file'",
    "    ? { mode: 'exclusive-path', path: 'atomic/value.bin', bytes, contentKind: 'blob' }",
    "    : { mode: 'content-addressed', namespace: 'content', extension: '.bin', bytes, contentKind: 'blob' };",
    "  const result = writeImmutableEvidence(authority, request);",
    "  process.stdout.write(`${result.disposition}\\n`);",
    "} catch (error) { process.stderr.write(`${error.code ?? 'unknown'}\\n`); process.exitCode = 1; }",
    "});",
    "",
  ].join("\n"), { mode: 0o600 });
  return path;
}

function crashWriterHelper(root: string): string {
  const path = join(root, "crash-writer.mjs");
  const moduleUrl = new URL("../src/filesystem/immutable-receipt.ts", import.meta.url).href;
  const filesystemInternalUrl = new URL("../src/filesystem/durable-filesystem-internal.ts", import.meta.url).href;
  writeFileSync(path, [
    `import { ensureReceiptAuthority, writeImmutableEvidence } from ${JSON.stringify(moduleUrl)};`,
    `import { withCurrentNodeRuntimeForFilesystemMechanismTest } from ${JSON.stringify(filesystemInternalUrl)};`,
    "const [root, stage] = process.argv.slice(2);",
    "withCurrentNodeRuntimeForFilesystemMechanismTest(() => {",
    `const authority = ensureReceiptAuthority(root, ${JSON.stringify(EVIDENCE_ROOT)});`,
    "writeImmutableEvidence(authority, { mode: 'exclusive-path', path: 'crash/target.bin', bytes: Buffer.from('complete-bytes'), contentKind: 'blob' }, {",
    "  afterStage(observed) { if (observed === stage) process.kill(process.pid, 'SIGKILL'); },",
    "});",
    "});",
    "",
  ].join("\n"), { mode: 0o600 });
  return path;
}

function authorityFaultHelper(root: string): string {
  const path = join(root, "authority-fault-helper.mjs");
  const moduleUrl = new URL("../src/filesystem/immutable-receipt.ts", import.meta.url).href;
  const filesystemInternalUrl = new URL("../src/filesystem/durable-filesystem-internal.ts", import.meta.url).href;
  writeFileSync(path, [
    `import { ensureReceiptAuthority } from ${JSON.stringify(moduleUrl)};`,
    `import { withCurrentNodeRuntimeForFilesystemMechanismTest } from ${JSON.stringify(filesystemInternalUrl)};`,
    "const [root, mask, faultStage] = process.argv.slice(2);",
    "process.umask(Number.parseInt(mask, 8));",
    "try {",
    `  withCurrentNodeRuntimeForFilesystemMechanismTest(() => ensureReceiptAuthority(root, ${JSON.stringify(EVIDENCE_ROOT)}, {`,
    "    afterStage(stage) { if (stage === faultStage) throw Object.assign(new Error('injected'), { code: 'EIO' }); },",
    "  }));",
    "  process.stdout.write('unexpected-success\\n');",
    "  process.exitCode = 1;",
    "} catch (error) { process.stdout.write(`${error.code ?? 'unknown'}\\n`); }",
    "",
  ].join("\n"), { mode: 0o600 });
  return path;
}

function runWriter(script: string, root: string, mode: string, bytes: Buffer) {
  return runProcess(script, [root, mode, bytes.toString("base64")]);
}

function runProcess(script: string, arguments_: readonly string[]): Promise<Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...arguments_], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}
