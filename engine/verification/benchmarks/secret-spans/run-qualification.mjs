#!/usr/bin/env node

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { canonicalHash, canonicalJson, sha256 } from "../../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../../src/kernel/json-integrity.ts";
import { secretTextSignalIds } from "../../../src/privacy/secret-signals.ts";
import { SECRET_SPAN_CANDIDATES } from "./candidate-adapters.mjs";
import {
  compileCorpus,
  syntheticBrokerValues,
  syntheticCanaryNeedles
} from "./fixture-compiler.mjs";
import { SECRET_SPAN_PATHS, SECRET_SPAN_QUALIFICATION_VERSIONS } from "./foundation-paths.mjs";
import { evaluateFixture, strictUtf8, validateFixtureOracle } from "./span-gateway.mjs";
import { verifyAuthorReceipt } from "./verify-author-receipt.mjs";
import { executeCandidate, WorkerExecutionError } from "./worker-executor.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;

export class SecretSpanQualificationError extends Error {
  constructor(code) {
    super(code);
    this.name = "SecretSpanQualificationError";
    this.code = code;
  }
}

function fail(code) {
  throw new SecretSpanQualificationError(code);
}

function snapshotReader(entries) {
  const files = new Map(entries.map((entry) => [entry.relativePath, Buffer.from(entry.bytes)]));
  if (files.size !== entries.length) fail("artifact_snapshot_duplicate");
  return (relativePath) => {
  if (path.isAbsolute(relativePath) || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("path_invalid");
  }
    const bytes = files.get(relativePath);
    if (bytes === undefined) fail("artifact_snapshot_unbound");
    return Buffer.from(bytes);
  };
}

export function parseStrictJson(bytes, code) {
  let text;
  try {
    text = strictUtf8(bytes);
    assertNoDuplicateJsonObjectKeys(text, code, code);
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

function compileSchema(bytes, code) {
  const schema = parseStrictJson(bytes, code + "_json");
  try {
    return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  } catch {
    fail(code + "_compile");
  }
}

function assertSchema(validate, value, code) {
  if (!validate(value)) fail(code);
}

function exactRatio(numerator, denominator, code) {
  if (!Number.isSafeInteger(denominator) || denominator <= 0) fail(code);
  return numerator / denominator;
}

function precisionRatio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function emptyAggregate() {
  return {
    expectedCount: 0,
    predictedCount: 0,
    truePositiveCount: 0,
    falseRedactionCount: 0,
    publicSurfaceCanaryOccurrences: 0,
    pageBoundaryCanaryOccurrences: 0,
    safeFragmentChecks: 0,
    safeFragmentsPreserved: 0,
    safeByteChecks: 0,
    safeBytesPreserved: 0,
    parserChecks: 0,
    parsersValid: 0,
    safeNameChecks: 0,
    safeNamesPreserved: 0,
    multiplicityChecks: 0,
    multiplicityPreserved: 0,
    lineChecks: 0,
    linesPreserved: 0,
    paginationChecks: 0,
    paginationReconstructed: 0,
    invalidUtf8Checks: 0,
    invalidUtf8Blocked: 0,
    candidateExceptions: 0,
    resourceBudgetViolations: 0
  };
}

function accumulate(aggregate, fixture, outcome) {
  aggregate.expectedCount += outcome.expectedCount;
  aggregate.predictedCount += outcome.predictedCount;
  aggregate.truePositiveCount += outcome.truePositiveCount;
  aggregate.falseRedactionCount += outcome.falseRedactionCount;
  aggregate.publicSurfaceCanaryOccurrences += outcome.publicSurfaceCanaryOccurrences;
  aggregate.pageBoundaryCanaryOccurrences += outcome.pageBoundaryCanaryOccurrences;
  aggregate.safeFragmentChecks += outcome.safeFragmentChecks;
  aggregate.safeFragmentsPreserved += outcome.safeFragmentsPreserved;
  if (fixture.expectedDisposition === "blocked-invalid-utf8") {
    aggregate.invalidUtf8Checks += 1;
    if (outcome.invalidUtf8Blocked) aggregate.invalidUtf8Blocked += 1;
  } else {
    aggregate.safeByteChecks += 1;
    aggregate.safeNameChecks += outcome.safeNameCheck ? 1 : 0;
    aggregate.multiplicityChecks += 1;
    aggregate.lineChecks += 1;
    aggregate.paginationChecks += 1;
    if (outcome.safeByteSkeletonPreserved) aggregate.safeBytesPreserved += 1;
    if (outcome.safeNameMultisetPreserved) aggregate.safeNamesPreserved += 1;
    if (outcome.multiplicityPreserved) aggregate.multiplicityPreserved += 1;
    if (outcome.linePreserved) aggregate.linesPreserved += 1;
    if (outcome.paginationReconstructed) aggregate.paginationReconstructed += 1;
    if (outcome.parserCheck) {
      aggregate.parserChecks += 1;
      if (outcome.parserValid) aggregate.parsersValid += 1;
    }
  }
  if (outcome.candidateException) aggregate.candidateExceptions += 1;
  if (outcome.resourceBudgetViolation) aggregate.resourceBudgetViolations += 1;
}

function aggregateProjection(aggregate) {
  return Object.freeze({ ...aggregate });
}

function failedSyntheticFloors(metrics, floors) {
  const failed = [];
  for (const key of Object.keys(floors)) {
    if (metrics[key] !== floors[key]) failed.push(key);
  }
  return failed;
}

async function candidateResult(candidate, fixtures, knownValues, forbiddenNeedles, protocol) {
  const repetitionAggregates = [];
  const fixtureIdentities = new Map(fixtures.map((fixture) => [fixture.id, []]));
  for (let repetition = 0; repetition < protocol.repetitions; repetition += 1) {
    const aggregate = emptyAggregate();
    for (const fixture of fixtures) {
      let proposedSpans = [];
      let executionError = null;
      if (fixture.expectedDisposition !== "blocked-invalid-utf8") {
        try {
          proposedSpans = await executeCandidate({
            candidateId: candidate.id,
            bytes: fixture.bytes,
            knownValues,
            budgets: protocol.budgets,
            runtimeProfile: protocol.runtimeProfile,
            forbiddenNeedles
          });
        } catch (error) {
          executionError = error instanceof WorkerExecutionError ? error.code : "candidate_worker_error";
        }
      }
      const outcome = evaluateFixture({
        candidateId: candidate.id,
        fixture,
        proposedSpans,
        executionError,
        pageBudgets: protocol.budgets.pageMaximumBytes
      });
      fixtureIdentities.get(fixture.id).push(outcome.determinismIdentity);
      accumulate(aggregate, fixture, outcome);
    }
    repetitionAggregates.push(aggregateProjection(aggregate));
  }
  const deterministicAcrossRepetitions = fixtureRepetitionsDeterministic(fixtureIdentities, protocol.repetitions);
  const aggregate = emptyAggregate();
  for (const repetition of repetitionAggregates) {
    for (const key of Object.keys(aggregate)) aggregate[key] += repetition[key];
  }
  const metrics = Object.freeze({
    exactSpanPrecision: precisionRatio(aggregate.truePositiveCount, aggregate.predictedCount),
    exactSpanRecall: exactRatio(aggregate.truePositiveCount, aggregate.expectedCount, "expected_span_coverage_vacuous"),
    falseRedactionCount: aggregate.falseRedactionCount,
    publicSurfaceCanaryOccurrences: aggregate.publicSurfaceCanaryOccurrences,
    pageBoundaryCanaryOccurrences: aggregate.pageBoundaryCanaryOccurrences,
    safeFragmentPreservation: exactRatio(aggregate.safeFragmentsPreserved, aggregate.safeFragmentChecks, "safe_fragment_coverage_vacuous"),
    safeByteSkeletonPreservation: exactRatio(aggregate.safeBytesPreserved, aggregate.safeByteChecks, "safe_byte_coverage_vacuous"),
    parserValidity: exactRatio(aggregate.parsersValid, aggregate.parserChecks, "parser_coverage_vacuous"),
    safeNameMultisetPreservation: exactRatio(aggregate.safeNamesPreserved, aggregate.safeNameChecks, "safe_name_coverage_vacuous"),
    redactionMultiplicity: exactRatio(aggregate.multiplicityPreserved, aggregate.multiplicityChecks, "multiplicity_coverage_vacuous"),
    lineCountPreservation: exactRatio(aggregate.linesPreserved, aggregate.lineChecks, "line_coverage_vacuous"),
    paginationReconstruction: exactRatio(aggregate.paginationReconstructed, aggregate.paginationChecks, "pagination_coverage_vacuous"),
    invalidUtf8Blocks: exactRatio(aggregate.invalidUtf8Blocked, aggregate.invalidUtf8Checks, "invalid_utf8_coverage_vacuous"),
    candidateExceptions: aggregate.candidateExceptions,
    resourceBudgetViolations: aggregate.resourceBudgetViolations,
    proposedSpanDenominatorPositive: aggregate.predictedCount > 0,
    deterministicAcrossRepetitions
  });
  const failedFloors = [
    ...failedSyntheticFloors(metrics, protocol.hardFloors),
    "realProjectEvidence",
    "independentReview",
    "streamingProfile",
    "regexProfile"
  ];
  return Object.freeze({
    id: candidate.id,
    mechanismIdentity: candidate.mechanismIdentity,
    status: "not-qualified",
    ...metrics,
    failedFloors: Object.freeze([...new Set(failedFloors)])
  });
}

function assertUniqueIds(values, code) {
  if (new Set(values.map((value) => value.id)).size !== values.length) fail(code);
}

export function fixtureRepetitionsDeterministic(fixtureIdentities, repetitions) {
  return [...fixtureIdentities.values()].every((identities) =>
    identities.length === repetitions && new Set(identities).size === 1
  );
}

export function inspectAtRestByteRecords(records, needles) {
  let rawSyntheticCanaryOccurrences = 0;
  let benchmarkArtifactAdmissionSignalFiles = 0;
  let pinnedExternalUnresolvedAdmissionSignalFiles = 0;
  let admissionSignalMismatch = false;
  for (const record of records) {
    const bytes = record.bytes;
    let text;
    try {
      text = strictUtf8(bytes);
    } catch {
      continue;
    }
    const signalIds = secretTextSignalIds(text, "admission");
    const expectedSignalIds = record.expectedAdmissionSignalIds ?? [];
    if (canonicalJson(signalIds) !== canonicalJson(expectedSignalIds)) admissionSignalMismatch = true;
    if (signalIds.length > 0) {
      if (record.scope === "pinned-external-unresolved-reproduction") {
        pinnedExternalUnresolvedAdmissionSignalFiles += 1;
      } else {
        benchmarkArtifactAdmissionSignalFiles += 1;
      }
    }
    for (const needle of needles) {
      let offset = 0;
      while ((offset = text.indexOf(needle, offset)) >= 0) {
        rawSyntheticCanaryOccurrences += 1;
        offset += needle.length;
      }
    }
  }
  if (rawSyntheticCanaryOccurrences !== 0) fail("at_rest_raw_canary_detected");
  if (admissionSignalMismatch) fail("at_rest_admission_signal_mismatch");
  return Object.freeze({
    derivedFromExternallyPinnedArtifactUniverse: true,
    rawSyntheticCanaryOccurrences,
    benchmarkArtifactAdmissionSignalFiles,
    pinnedExternalUnresolvedAdmissionSignalFiles,
    unresolvedExternalSignalBlocksAdmission: pinnedExternalUnresolvedAdmissionSignalFiles > 0
  });
}

function inspectAtRest(artifacts, needles, readBytes) {
  const reproduction = SECRET_SPAN_PATHS.exactFalsePositive;
  return inspectAtRestByteRecords(artifacts.map((artifact) => {
    const isPinnedReproduction = artifact.relativePath === reproduction.source;
    return {
      id: artifact.relativePath,
      bytes: readBytes(artifact.relativePath),
      scope: isPinnedReproduction ? "pinned-external-unresolved-reproduction" : "benchmark-foundation",
      expectedAdmissionSignalIds: []
    };
  }), needles);
}

function exactFalsePositive(fixtures, readBytes) {
  const reproduction = SECRET_SPAN_PATHS.exactFalsePositive;
  const fixture = fixtures.find((entry) => entry.fixtureId === reproduction.fixtureId);
  if (!fixture) fail("false_positive_fixture_missing");
  const source = strictUtf8(readBytes(reproduction.source));
  const lines = source.split("\n");
  const exact = Buffer.from(lines[reproduction.line - 1] + "\n", "utf8");
  if (!fixture.bytes.equals(exact) || fixture.expectedSpans.length !== 0) fail("false_positive_fixture_not_exact");
  const signals = secretTextSignalIds(strictUtf8(exact), "admission");
  if (canonicalJson(signals) !== canonicalJson([])) fail("false_positive_still_reproduced");
  return Object.freeze({
    exactSourceLineBytesReproduced: true,
    oracleSecretSpanCount: 0,
    currentCatalogCredentialAssignmentPositive: false
  });
}

function coverageFor(corpusRecords, fixtures, oracleCoverage, protocol) {
  const carrierClasses = [...new Set(fixtures.map((fixture) => fixture.carrierClass))].sort();
  const positiveByCorpus = Object.fromEntries(corpusRecords.map((record) => [
    record.id,
    fixtures.filter((fixture) => fixture.corpusId === record.id && fixture.expectedSpans.length > 0).length
  ]));
  const safeNegativeFixtures = fixtures.filter((fixture) => fixture.expectedSpans.length === 0 &&
    fixture.expectedDisposition === "sanitized").length;
  const invalidUtf8Fixtures = fixtures.filter((fixture) => fixture.expectedDisposition === "blocked-invalid-utf8").length;
  const parserFixtures = oracleCoverage.reduce((total, entry) => total + entry.parserChecks, 0);
  const safeNameTokens = oracleCoverage.reduce((total, entry) => total + entry.safeNameTokens, 0);
  const minimum = protocol.minimumCoverage;
  if (corpusRecords.length < minimum.corpora || fixtures.length < minimum.fixtures ||
    Object.values(positiveByCorpus).some((count) => count < minimum.positiveSecretFixturesPerCorpus) ||
    safeNegativeFixtures < minimum.safeNegativeFixtures || invalidUtf8Fixtures < minimum.invalidUtf8Fixtures ||
    parserFixtures < minimum.parserFixtures || safeNameTokens < minimum.safeNameTokens ||
    canonicalJson(carrierClasses) !== canonicalJson(minimum.carrierClasses)) {
    fail("coverage_floor_not_met");
  }
  return Object.freeze({
    corpora: corpusRecords.length,
    fixtures: fixtures.length,
    positiveSecretFixturesByCorpus: positiveByCorpus,
    safeNegativeFixtures,
    invalidUtf8Fixtures,
    parserFixtures,
    safeNameTokens,
    carrierClasses
  });
}

function loadBoundInputs(readBytes) {
  const protocolBytes = readBytes(SECRET_SPAN_PATHS.protocol);
  if (protocolBytes.length > 65536) fail("protocol_byte_budget");
  const validateProtocol = compileSchema(readBytes(SECRET_SPAN_PATHS.protocolSchema), "protocol_schema");
  const validateCorpus = compileSchema(readBytes(SECRET_SPAN_PATHS.corpusSchema), "corpus_schema");
  const validateResult = compileSchema(readBytes(SECRET_SPAN_PATHS.resultSchema), "result_schema");
  const protocol = parseStrictJson(protocolBytes, "protocol_json");
  assertSchema(validateProtocol, protocol, "protocol_invalid");
  if (protocolBytes.length > protocol.budgets.maximumProtocolBytes) fail("protocol_byte_budget");
  assertUniqueIds(protocol.corpora, "corpus_id_duplicate");
  assertUniqueIds(protocol.candidateFamilies, "candidate_id_duplicate");
  if (canonicalJson(SECRET_SPAN_CANDIDATES.map((candidate) => candidate.id)) !==
    canonicalJson(protocol.candidateFamilies.map((candidate) => candidate.id))) fail("candidate_universe_mismatch");

  const corpusRecords = [];
  const fixtures = [];
  for (const binding of protocol.corpora) {
    const bytes = readBytes(binding.path);
    if (bytes.length > protocol.budgets.maximumCorpusBytes) fail("corpus_byte_budget");
    if (sha256(bytes) !== binding.sha256) fail("corpus_hash_mismatch");
    const corpus = parseStrictJson(bytes, "corpus_json");
    assertSchema(validateCorpus, corpus, "corpus_invalid");
    if (corpus.id !== binding.id) fail("corpus_id_mismatch");
    let compiled;
    try {
      compiled = compileCorpus(corpus, protocol.budgets);
    } catch {
      fail("corpus_compilation_invalid");
    }
    corpusRecords.push(Object.freeze({ id: corpus.id, sha256: binding.sha256, fixtureCount: compiled.length }));
    fixtures.push(...compiled);
  }
  const oracleCoverage = fixtures.map((fixture) => {
    try {
      return validateFixtureOracle(fixture);
    } catch {
      fail("fixture_oracle_invalid");
    }
  });
  return Object.freeze({
    protocolBytes,
    protocol,
    corpusRecords,
    fixtures,
    validateResult,
    coverage: coverageFor(corpusRecords, fixtures, oracleCoverage, protocol)
  });
}

export function parseQualificationArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 ||
    !argv[0].startsWith("--expected-author-receipt-sha256=")) fail("argument_invalid");
  const expectedAuthorReceiptSha256 = argv[0].slice("--expected-author-receipt-sha256=".length);
  if (!/^[0-9a-f]{64}$/u.test(expectedAuthorReceiptSha256)) fail("argument_invalid");
  return Object.freeze({ expectedAuthorReceiptSha256 });
}

export async function runQualification({ expectedAuthorReceiptSha256 }) {
  const verifiedAuthor = verifyAuthorReceipt(expectedAuthorReceiptSha256);
  const readBytes = snapshotReader(verifiedAuthor.artifactSnapshot);
  const { protocolBytes, protocol, corpusRecords, fixtures, validateResult, coverage } = loadBoundInputs(readBytes);
  if (canonicalJson(verifiedAuthor.receipt.trustBase.node.execArgv) !==
    canonicalJson(protocol.runtimeProfile.mainExecArgv)) fail("runtime_profile_receipt_mismatch");
  const knownValues = syntheticBrokerValues();
  const forbiddenNeedles = syntheticCanaryNeedles();
  const atRestInspection = inspectAtRest(verifiedAuthor.receipt.artifacts, forbiddenNeedles, readBytes);
  const candidateResults = [];
  for (const candidate of SECRET_SPAN_CANDIDATES) {
    candidateResults.push(await candidateResult(candidate, fixtures, knownValues, forbiddenNeedles, protocol));
  }
  const result = Object.freeze({
    schemaVersion: SECRET_SPAN_QUALIFICATION_VERSIONS.result,
    status: "measured-synthetic-foundation-not-production-qualification",
    authorReceiptSha256: verifiedAuthor.receiptSha256,
    authorReceiptPinVerified: true,
    protocolSha256: sha256(protocolBytes),
    corpusSetSha256: canonicalHash(corpusRecords),
    repetitions: protocol.repetitions,
    corpora: Object.freeze(corpusRecords),
    fixtureCount: fixtures.length,
    coverage,
    atRestInspection,
    exactFalsePositive: exactFalsePositive(fixtures, readBytes),
    resourceEnforcement: {
      isolatedWorkerPerDetection: true,
      maximumFixtureBytes: protocol.budgets.maximumFixtureBytes,
      maximumProposedSpansPerFixture: protocol.budgets.maximumProposedSpansPerFixture,
      maximumDetectionMilliseconds: protocol.budgets.maximumDetectionMilliseconds,
      maximumWorkerStdoutBytes: protocol.budgets.maximumWorkerStdoutBytes,
      maximumWorkerStderrBytes: protocol.budgets.maximumWorkerStderrBytes,
      workerHeapMegabytes: protocol.budgets.workerHeapMegabytes,
      workerStackMegabytes: protocol.budgets.workerStackMegabytes,
      cancellationSignalSupported: true,
      mainExecArgvBound: true,
      workerExecArgvBound: true,
      workerStdoutCapturedBoundedAndScanned: true,
      workerStderrCapturedBoundedAndScanned: true,
      candidateExecutionTrust: protocol.scope.candidateExecutionTrust,
      ambientEgressBoundaryQualified: false,
      newCandidateExecutionReady: false
    },
    candidateResults: Object.freeze(candidateResults),
    regexProfile: {
      status: "unqualified-disabled",
      reason: "no bounded regex engine and approved feature profile has admitted hostile evidence",
      denialCasesRecorded: protocol.regexDenialCases.length
    },
    productionDisposition: "unchanged-blocked-no-candidate-qualified-for-shared-production-span-api",
    repositoryAdmission: false,
    independentReviewAccepted: false,
    rawCanariesPersisted: false
  });
  assertSchema(validateResult, result, "result_invalid");
  const serialized = canonicalJson(result) + "\n";
  for (const value of syntheticCanaryNeedles()) if (serialized.includes(value)) fail("result_raw_canary_leak");
  return Object.freeze({ result, serialized });
}

async function main() {
  process.stdout.write((await runQualification(parseQualificationArguments(process.argv.slice(2)))).serialized);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof SecretSpanQualificationError ? error.code : "qualification_internal_error";
    process.stderr.write(code + "\n");
    process.exitCode = 1;
  }
}
