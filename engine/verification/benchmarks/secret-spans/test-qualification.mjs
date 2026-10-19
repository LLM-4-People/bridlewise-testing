#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../../src/kernel/integrity.ts";
import {
  inspectReceiptAuthority,
  readImmutableEvidence
} from "../../../src/filesystem/immutable-receipt.ts";
import { SECRET_SPAN_CANDIDATES } from "./candidate-adapters.mjs";
import {
  compileCorpus,
  SYNTHETIC_SECRET_VALUES,
  syntheticBrokerValues,
  syntheticCanaryNeedles
} from "./fixture-compiler.mjs";
import { SECRET_SPAN_PATHS, SECRET_SPAN_QUALIFICATION_VERSIONS } from "./foundation-paths.mjs";
import {
  fixtureRepetitionsDeterministic,
  inspectAtRestByteRecords,
  parseQualificationArguments,
  parseStrictJson,
  runQualification,
  SecretSpanQualificationError
} from "./run-qualification.mjs";
import { evaluateFixture, strictUtf8 } from "./span-gateway.mjs";
import {
  executeCandidate,
  executeIsolatedWorker,
  WorkerExecutionError
} from "./worker-executor.mjs";
import {
  collectQualificationFileRecords,
  createQualificationFileAuthority,
  qualificationFileRecord,
  QUALIFICATION_AUTHORITY_OWNER
} from "../shared/qualification-authority.mjs";
import {
  migrationWriteAuthorityQualificationOwner
} from "../coordination/migration-write-authority/author-trust-base.mjs";
import { compileQualificationAuthorityInventory } from "../shared/qualification-authority-inventory.mjs";
import { verifyAuthorReceipt } from "./verify-author-receipt.mjs";
import { executeSecretSpanAuthorReceiptCommand } from "./build-author-receipt.mjs";
import { executeSecretSpanEvidenceCommand } from "./publish-evidence.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const invocation = parseQualificationArguments(process.argv.slice(2));
const PACKAGE_ROOT = path.join(ROOT, SECRET_SPAN_PATHS.packageRoot);
const protocol = parseStrictJson(fs.readFileSync(path.join(ROOT, SECRET_SPAN_PATHS.protocol)), "test_protocol");
const syntaxCorpus = parseStrictJson(
  fs.readFileSync(path.join(PACKAGE_ROOT, "corpora/syntax-and-negatives.v2.json")),
  "test_corpus"
);
const fixtures = compileCorpus(syntaxCorpus, protocol.budgets);
let assertions = 0;

assert.throws(() => parseQualificationArguments([]), (error) =>
  error instanceof SecretSpanQualificationError && error.code === "argument_invalid");
assert.throws(() => verifyAuthorReceipt("0".repeat(64)), /author_receipt_external_pin_mismatch/u);
assert.equal(protocol.schemaVersion, SECRET_SPAN_QUALIFICATION_VERSIONS.protocol);
assertions += 3;

function expectCode(code, operation) {
  assertions += 1;
  assert.throws(operation, (error) => error instanceof SecretSpanQualificationError && error.code === code);
}

async function expectWorkerCode(code, operation) {
  assertions += 1;
  await assert.rejects(operation, (error) => error instanceof WorkerExecutionError && error.code === code);
}

assert.throws(() => strictUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), /utf8_bom_forbidden/u);
assert.throws(() => strictUtf8(Buffer.from([0xc3, 0x28])), TypeError);
expectCode("strict_json_invalid", () => parseStrictJson(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), "strict_json_invalid"));
assertions += 2;

const safeCall = fixtures.find((fixture) => fixture.fixtureId === "SAFE-CALL-001");
assert.ok(safeCall);
const sourceLine = strictUtf8(fs.readFileSync(path.join(ROOT, SECRET_SPAN_PATHS.exactFalsePositive.source)))
  .split("\n")[SECRET_SPAN_PATHS.exactFalsePositive.line - 1] + "\n";
assert.equal(safeCall.bytes.equals(Buffer.from(sourceLine, "utf8")), true);
assert.equal(safeCall.expectedSpans.length, 0);
assertions += 3;

const literal = SECRET_SPAN_CANDIDATES.find((candidate) => candidate.id === "known-value-literal");
const overlap = literal.detect({ bytes: Buffer.from("abcdef"), text: "abcdef", knownValues: ["abc", "bcdef"] });
assert.deepEqual(overlap.map(({ startByte, endByte }) => ({ startByte, endByte })), [{ startByte: 1, endByte: 6 }]);
assertions += 1;

const tsFixture = fixtures.find((fixture) => fixture.fixtureId === "TS-ASSIGN-001");
assert.ok(tsFixture);
const exactOutcome = evaluateFixture({
  candidateId: "oracle-probe",
  fixture: tsFixture,
  proposedSpans: tsFixture.expectedSpans.map((span, index) => ({ ...span, ruleId: "oracle-" + index })),
  executionError: null,
  pageBudgets: protocol.budgets.pageMaximumBytes
});
assert.equal(exactOutcome.parserValid, true);
assert.equal(exactOutcome.safeNameMultisetPreserved, true);
assert.equal(exactOutcome.safeByteSkeletonPreserved, true);
assert.equal(exactOutcome.multiplicityPreserved, true);
assertions += 5;

const nameStart = tsFixture.bytes.indexOf(Buffer.from("API_KEY"));
const corruptOutcome = evaluateFixture({
  candidateId: "oracle-probe",
  fixture: tsFixture,
  proposedSpans: [{ startByte: nameStart, endByte: tsFixture.expectedSpans[0].endByte, ruleId: "corrupt-name" }],
  executionError: null,
  pageBudgets: protocol.budgets.pageMaximumBytes
});
assert.equal(corruptOutcome.parserValid, false);
assert.equal(corruptOutcome.safeNameMultisetPreserved, false);
assert.equal(corruptOutcome.safeByteSkeletonPreserved, false);
assertions += 3;

for (const proposedSpans of [
  [
    { ...tsFixture.expectedSpans[0], ruleId: "one" },
    { ...tsFixture.expectedSpans[0], ruleId: "one" }
  ],
  [
    { ...tsFixture.expectedSpans[0], ruleId: "one" },
    { ...tsFixture.expectedSpans[0], ruleId: "alias" }
  ],
  [
    { ...tsFixture.expectedSpans[0], ruleId: "one" },
    {
      startByte: tsFixture.expectedSpans[0].startByte + 1,
      endByte: tsFixture.expectedSpans[0].endByte,
      ruleId: "overlap"
    }
  ]
]) {
  const outcome = evaluateFixture({
    candidateId: "hostile-span-probe",
    fixture: tsFixture,
    proposedSpans,
    executionError: null,
    pageBudgets: protocol.budgets.pageMaximumBytes
  });
  assert.equal(outcome.candidateException, true);
  assertions += 1;
}

const makoraFixture = fixtures.find((fixture) => fixture.fixtureId === "MARKDOWN-MAKORA-001");
const missedPageOutcome = evaluateFixture({
  candidateId: "page-leak-probe",
  fixture: makoraFixture,
  proposedSpans: [],
  executionError: null,
  pageBudgets: [17]
});
assert.ok(missedPageOutcome.pageBoundaryCanaryOccurrences > 0);
assertions += 1;

assert.equal(fixtureRepetitionsDeterministic(new Map([["fixture", ["a", "a", "a"]]]), 3), true);
assert.equal(fixtureRepetitionsDeterministic(new Map([["fixture", ["a", "b", "a"]]]), 3), false);
assertions += 2;

expectCode("at_rest_raw_canary_detected", () => inspectAtRestByteRecords([
  { id: "mutant", bytes: Buffer.from(SYNTHETIC_SECRET_VALUES.makora, "utf8") }
], syntheticCanaryNeedles()));
expectCode("at_rest_admission_signal_mismatch", () => inspectAtRestByteRecords([
  { id: "mutant", bytes: Buffer.from(sourceLine, "utf8") }
], syntheticCanaryNeedles()));

const tightBudgets = { ...protocol.budgets, maximumDetectionMilliseconds: 40 };
await expectWorkerCode("candidate_timeout", () => executeIsolatedWorker({
  workerUrl: new URL("./resource-probe-worker.mjs", import.meta.url),
  workerData: { mode: "hang" },
  budgets: tightBudgets,
  runtimeProfile: protocol.runtimeProfile
}));
const controller = new AbortController();
const cancelled = executeIsolatedWorker({
  workerUrl: new URL("./resource-probe-worker.mjs", import.meta.url),
  workerData: { mode: "hang" },
  budgets: protocol.budgets,
  runtimeProfile: protocol.runtimeProfile,
  signal: controller.signal
});
setTimeout(() => controller.abort(), 10);
await expectWorkerCode("candidate_cancelled", () => cancelled);
const limitReport = await executeIsolatedWorker({
  workerUrl: new URL("./resource-probe-worker.mjs", import.meta.url),
  workerData: { mode: "report-limits" },
  budgets: protocol.budgets,
  runtimeProfile: protocol.runtimeProfile
});
assert.equal(limitReport.status, "ok");
assert.deepEqual(limitReport.execArgv, protocol.runtimeProfile.workerExecArgv);
assert.ok(limitReport.heapSizeLimit > 0 && limitReport.heapSizeLimit <= 160 * 1024 * 1024);
assertions += 3;

await expectWorkerCode("candidate_main_exec_argv_mismatch", () => executeIsolatedWorker({
  workerUrl: new URL("./resource-probe-worker.mjs", import.meta.url),
  workerData: { mode: "report-limits" },
  budgets: protocol.budgets,
  runtimeProfile: { ...protocol.runtimeProfile, mainExecArgv: ["--ambient-mutant"] }
}));
await expectWorkerCode("candidate_forbidden_surface", () => executeIsolatedWorker({
  workerUrl: SYNTHETIC_SECRET_VALUES.makora,
  workerData: { mode: "report-limits" },
  budgets: protocol.budgets,
  runtimeProfile: protocol.runtimeProfile,
  forbiddenNeedles: syntheticCanaryNeedles()
}));
for (const mode of ["stdout", "stdout-split", "stderr", "message", "throw"]) {
  await expectWorkerCode("candidate_forbidden_surface", () => executeIsolatedWorker({
    workerUrl: new URL("./resource-probe-worker.mjs", import.meta.url),
    workerData: { mode, value: SYNTHETIC_SECRET_VALUES.makora },
    budgets: protocol.budgets,
    runtimeProfile: protocol.runtimeProfile,
    forbiddenNeedles: syntheticCanaryNeedles()
  }));
}
await expectWorkerCode("candidate_stream_byte_limit", () => executeIsolatedWorker({
  workerUrl: new URL("./resource-probe-worker.mjs", import.meta.url),
  workerData: { mode: "stdout", value: "x".repeat(protocol.budgets.maximumWorkerStdoutBytes + 1) },
  budgets: protocol.budgets,
  runtimeProfile: protocol.runtimeProfile
}));
await expectWorkerCode("candidate_worker_exit", () => executeIsolatedWorker({
  workerUrl: new URL("./resource-probe-worker.mjs", import.meta.url),
  workerData: { mode: "exit" },
  budgets: protocol.budgets,
  runtimeProfile: protocol.runtimeProfile
}));

await expectWorkerCode("candidate_input_byte_limit", () => executeCandidate({
  candidateId: literal.id,
  bytes: Buffer.alloc(protocol.budgets.maximumFixtureBytes + 1, 0x61),
  knownValues: syntheticBrokerValues(),
  budgets: protocol.budgets,
  runtimeProfile: protocol.runtimeProfile,
  forbiddenNeedles: syntheticCanaryNeedles()
}));
await expectWorkerCode("candidate_match_limit", () => executeCandidate({
  candidateId: literal.id,
  bytes: Buffer.from(SYNTHETIC_SECRET_VALUES.makora + " " + SYNTHETIC_SECRET_VALUES.makora),
  knownValues: syntheticBrokerValues(),
  budgets: { ...protocol.budgets, maximumProposedSpansPerFixture: 1 },
  runtimeProfile: protocol.runtimeProfile,
  forbiddenNeedles: syntheticCanaryNeedles()
}));

assert.throws(() => qualificationFileRecord("/etc/hosts"), /qualification_path_invalid/u);
assert.throws(() => qualificationFileRecord("..\/..\/..\/etc\/hosts"), /qualification_path_invalid/u);
assert.throws(() => collectQualificationFileRecords(["package.json", "./package.json"]), /qualification_path_invalid/u);
assert.throws(() => collectQualificationFileRecords(["package.json", "package.json"]), /qualification_file_universe_duplicate/u);
assert.throws(() => qualificationFileRecord("decomposed-e\u0301"), /qualification_path_invalid/u);
assert.throws(() => qualificationFileRecord("back\\slash"), /qualification_path_invalid/u);
assert.throws(() => qualificationFileRecord("double//segment"), /qualification_path_invalid/u);
assertions += 7;
const authorityMutantRoot = fs.mkdtempSync(path.join(tmpdir(), "qualification-authority-mutant-"));
const mutantAuthority = createQualificationFileAuthority(authorityMutantRoot);
try {
  const original = path.join(authorityMutantRoot, "original.txt");
  const alias = path.join(authorityMutantRoot, "alias.txt");
  fs.writeFileSync(original, "safe\n", { mode: 0o600 });
  fs.linkSync(original, alias);
  assert.throws(() => mutantAuthority.qualificationFileRecord("original.txt"),
    (error) => error?.code === "safe_path_hardlink");
  fs.unlinkSync(alias);
  fs.unlinkSync(original);
  fs.symlinkSync("/etc/hosts", original);
  assert.throws(() => mutantAuthority.qualificationFileRecord("original.txt"),
    (error) => error?.code === "safe_path_symlink");
  assertions += 2;
} finally {
  fs.rmSync(authorityMutantRoot, { force: true, recursive: true });
}

const qualificationInventory = compileQualificationAuthorityInventory(ROOT);
assert.equal(qualificationInventory.status, "compiled-current");
assert.deepEqual(qualificationInventory.violations, []);
assert.equal(qualificationInventory.authorityOwner, QUALIFICATION_AUTHORITY_OWNER);
assert.equal(migrationWriteAuthorityQualificationOwner, QUALIFICATION_AUTHORITY_OWNER);
assert.equal(qualificationInventory.sourceSurface.sourceCount,
  qualificationInventory.sourceSurface.executableSourceCount +
    qualificationInventory.sourceSurface.nonExecutableCarrierCount);
assert.equal(qualificationInventory.sourceSurface.sources.every((source) =>
  typeof source.sha256 === "string" && typeof source.originClass === "string" &&
  typeof source.moduleDisposition === "string" && typeof source.dispositionReason === "string"
), true);
assert.equal(qualificationInventory.sourceSurface.sources.filter((source) =>
  source.originClass === "vendored-source"
).every((source) => source.moduleDisposition === "non-executable-carrier"), true);
assert.equal(qualificationInventory.moduleGraph.unresolvedDynamicEdges.length, 0);
assert.equal(qualificationInventory.moduleGraph.edges.filter((edge) =>
  edge.resolution === "internal-pattern"
).every((edge) => edge.resolutionEvidence.matchCount === 1), true);
assert.equal(qualificationInventory.leaseInventory.length, 2);
assert.equal(qualificationInventory.leaseInventory.every((lease) =>
  lease.uses.length === lease.requiredUseCardinality && lease.environmentBindings.names.length === 0
), true);
assertions += 11;

const commandWorkingTree = fs.mkdtempSync(path.join(tmpdir(), "secret-command-absent-tree-"));
const originalWorkingDirectory = process.cwd();
try {
  const treeBefore = emptyTreeIdentity(commandWorkingTree);
  process.chdir(commandWorkingTree);
  const receiptBytes = fs.readFileSync(path.join(ROOT, SECRET_SPAN_PATHS.authorReceipt));
  assert.equal(executeSecretSpanAuthorReceiptCommand([]).equals(receiptBytes), true);
  assert.equal(executeSecretSpanAuthorReceiptCommand(["--effect-mode=derive"]).equals(receiptBytes), true);
  const receiptCheck = JSON.parse(executeSecretSpanAuthorReceiptCommand([
    "--effect-mode=check"
  ]).toString("utf8"));
  assert.equal(receiptCheck.status, "current-read-only");
  assert.equal(receiptCheck.effectMode, "check");
  assert.throws(() => executeSecretSpanAuthorReceiptCommand(["--effect-mode=write"]),
    (error) => error?.code === "production_migration_write_authority_unavailable");

  const qualificationArgument = `--expected-author-receipt-sha256=${invocation.expectedAuthorReceiptSha256}`;
  const derivedEvidence = await executeSecretSpanEvidenceCommand([qualificationArgument]);
  const explicitEvidence = await executeSecretSpanEvidenceCommand([
    "--effect-mode=derive", qualificationArgument
  ]);
  assert.equal(explicitEvidence.equals(derivedEvidence), true);
  const evidenceCheck = JSON.parse((await executeSecretSpanEvidenceCommand([
    "--effect-mode=check", qualificationArgument
  ])).toString("utf8"));
  assert.equal(evidenceCheck.status, "current-read-only");
  assert.equal(evidenceCheck.effectMode, "check");
  await assert.rejects(executeSecretSpanEvidenceCommand(["--effect-mode=write"]),
    (error) => error?.code === "production_migration_write_authority_unavailable");
  assert.deepEqual(emptyTreeIdentity(commandWorkingTree), treeBefore);
  assertions += 12;
} finally {
  process.chdir(originalWorkingDirectory);
  fs.rmSync(commandWorkingTree, { force: true, recursive: true });
  assert.equal(fs.existsSync(commandWorkingTree), false);
  assertions += 1;
}

const qualification = await runQualification(invocation);
assert.equal(qualification.result.schemaVersion, SECRET_SPAN_QUALIFICATION_VERSIONS.result);
assert.equal(qualification.result.repositoryAdmission, false);
assert.equal(qualification.result.independentReviewAccepted, false);
assert.equal(qualification.result.rawCanariesPersisted, false);
assert.equal(qualification.result.atRestInspection.rawSyntheticCanaryOccurrences, 0);
assert.equal(qualification.result.atRestInspection.benchmarkArtifactAdmissionSignalFiles, 0);
assert.equal(qualification.result.atRestInspection.pinnedExternalUnresolvedAdmissionSignalFiles, 1);
assert.equal(qualification.result.atRestInspection.unresolvedExternalSignalBlocksAdmission, true);
assert.equal(qualification.result.exactFalsePositive.exactSourceLineBytesReproduced, true);
assert.equal(qualification.result.resourceEnforcement.ambientEgressBoundaryQualified, false);
assert.equal(qualification.result.resourceEnforcement.newCandidateExecutionReady, false);
assert.equal(qualification.result.resourceEnforcement.workerStdoutCapturedBoundedAndScanned, true);
assert.equal(qualification.result.resourceEnforcement.workerStderrCapturedBoundedAndScanned, true);
assert.ok(qualification.result.candidateResults.every((candidate) => candidate.status === "not-qualified"));
assert.ok(qualification.result.candidateResults.every((candidate) => candidate.deterministicAcrossRepetitions));
assertions += 13;

for (const needle of syntheticCanaryNeedles()) {
  assert.equal(qualification.serialized.includes(needle), false);
  assertions += 1;
}

const authorityRoot = path.join(ROOT, SECRET_SPAN_PATHS.evidenceAuthorityRoot);
const authority = inspectReceiptAuthority(authorityRoot, SECRET_SPAN_PATHS.evidenceRelativeRoot);
const evidencePath = "objects/sha256/" + sha256(Buffer.from(qualification.serialized, "utf8")) + ".json";
assert.equal(readImmutableEvidence(authority, evidencePath, "canonical-json").toString("utf8"), qualification.serialized);
assertions += 1;

process.stdout.write(JSON.stringify({ assertions, status: "pass" }) + "\n");

function emptyTreeIdentity(root) {
  const stats = fs.lstatSync(root, { bigint: true });
  return Object.freeze({
    entries: Object.freeze(fs.readdirSync(root).toSorted()),
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    links: stats.nlink.toString(10),
    mode: stats.mode.toString(8),
    size: stats.size.toString(10),
  });
}
