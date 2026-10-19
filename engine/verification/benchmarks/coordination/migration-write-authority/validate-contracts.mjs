import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

import { canonicalHash, canonicalJson, sha256 } from "../../../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../../../src/kernel/json-integrity.ts";
import { validateRepositoryFactsReport } from "./validate-repository-facts.mjs";
import {
  deriveVerifierTrustBase,
  MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT,
  migrationWriteAuthorityFileRecord,
  readMigrationWriteAuthorityFile,
  trustSha256
} from "./author-trust-base.mjs";
import { buildMigrationWriteAuthorityAuthorReceiptValue } from "./author-receipt.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const RELATIVE = "verification/benchmarks/coordination/migration-write-authority";
const PATHS = Object.freeze({
  protocolSchema: `${RELATIVE}/schemas/authority-protocol.schema.json`,
  fixtures: `${RELATIVE}/fixtures/authority-protocol-fixtures.v2.json`,
  fixtureGenerator: `${RELATIVE}/build-protocol-fixtures.mjs`,
  contract: `${RELATIVE}/qualification-contract.v2.json`,
  contractSchema: `${RELATIVE}/schemas/qualification-contract.schema.json`,
  receiptSchema: MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT.schemaRelativePath,
});
const OPERATIONS = Object.freeze([
  "acquire", "reserve", "heartbeat", "checkpoint", "fence",
  "compare-and-commit", "release", "inspect", "recover",
]);
const REQUEST_STATES = Object.freeze({
  reserve: "active", heartbeat: "active", checkpoint: "active", fence: "active",
  "compare-and-commit": "fenced", release: "active", recover: "blocked-unknown-effect",
});
const RESULT_STATES = Object.freeze({
  acquire: "active", reserve: "active", heartbeat: "active", checkpoint: "active", fence: "fenced",
  "compare-and-commit": "active", release: "released", inspect: "active", recover: "reconciling",
});

function fail(code, detail) {
  throw new Error(`${code}:${detail}`);
}

function duplicateCode(subject) {
  return `MWA_DUPLICATE_JSON_KEY_${subject.toUpperCase().replaceAll("-", "_")}`;
}

function parseJson(relativePath, subject) {
  const bytes = readMigrationWriteAuthorityFile(relativePath);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.charCodeAt(0) === 0xfeff || !Buffer.from(text, "utf8").equals(bytes)) throw new Error("utf8");
  } catch {
    fail("artifact_utf8_invalid", subject);
  }
  assertNoDuplicateJsonObjectKeys(
    text,
    `Duplicate JSON object key in migration write-authority ${subject}`,
    duplicateCode(subject),
  );
  return Object.freeze({ bytes, text, relativePath, value: JSON.parse(text) });
}

function compile(schemaRecord) {
  return new Ajv2020({ allErrors: true, strict: true }).compile(schemaRecord.value);
}

function assertSchema(validate, value, code) {
  if (!validate(value)) fail(code, canonicalJson(validate.errors ?? []));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertSortedUnique(values, label) {
  for (let index = 1; index < values.length; index += 1) {
    if (Buffer.compare(Buffer.from(values[index - 1], "utf8"), Buffer.from(values[index], "utf8")) >= 0) {
      fail("ordering_or_duplicate_invalid", label);
    }
  }
}

function assertNoSerializedGrant(value, path = "$") {
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (["grant", "bearerToken", "authorityRequirement", "liveGrant", "opaqueGrant"].includes(key)) {
      fail("serialized_live_grant_forbidden", `${path}.${key}`);
    }
    assertNoSerializedGrant(nested, `${path}.${key}`);
  }
}

function resourcesIn(message) {
  if (message.messageKind === "request" && message.operation === "acquire") return message.resources;
  if (message.messageKind === "request" && message.operation === "reserve") return message.completeResourceUnion;
  return [];
}

function assertResourceSemantics(message) {
  const resources = resourcesIn(message);
  if (resources.length === 0) return;
  assertSortedUnique(resources.map((resource) => resource.resourceId), `${message.operation}:resourceIds`);
  for (const resource of resources) {
    assertSortedUnique(resource.aliasClosure, `${message.operation}:${resource.resourceId}:aliasClosure`);
    if (!resource.aliasClosure.includes(resource.resourceId)) fail("resource_self_alias_missing", resource.resourceId);
    if (resource.access === "write" && resource.resolution !== "resolved") {
      fail("write_resource_unresolved", resource.resourceId);
    }
  }
}

function assertLeaseEvidence(evidence, state, label) {
  if (evidence === null || evidence.state !== state || evidence.receiptAuthority !== "evidence-only-never-authority") {
    fail("lease_evidence_state_invalid", label);
  }
}

function assertRequestSemantics(message) {
  assertNoSerializedGrant(message);
  assertResourceSemantics(message);
  const operation = message.operation;
  if (operation === "acquire" || operation === "inspect") {
    if (Object.hasOwn(message, "authorityContext") || Object.hasOwn(message, "leaseEvidence")) {
      fail("unexpected_authority_context", operation);
    }
  } else {
    if (message.authorityContext !== "process-private-live-grant-required-out-of-band") {
      fail("out_of_band_authority_requirement_missing", operation);
    }
    assertLeaseEvidence(message.leaseEvidence, REQUEST_STATES[operation], `${operation}:request`);
  }
  if (operation === "fence") {
    if (message.effectKind === "filesystem-create" &&
      (message.expectedState.kind !== "absent" || message.intendedState.kind !== "file")) {
      fail("filesystem_create_state_transition_invalid", message.requestId);
    }
    if (canonicalJson(message.expectedState) === canonicalJson(message.intendedState)) {
      fail("fence_no_state_change", message.requestId);
    }
  }
  if (operation === "compare-and-commit") {
    if (message.fenceIdentity !== message.leaseEvidence.fenceIdentity ||
      canonicalJson(message.observedState) !== canonicalJson(message.intendedState) ||
      canonicalJson(message.expectedState) === canonicalJson(message.intendedState)) {
      fail("compare_commit_handoff_invalid", message.requestId);
    }
  }
  if (operation === "recover") {
    const recovery = message.recoveryFence;
    if (BigInt(recovery.generation) <= BigInt(recovery.supersedesGeneration) ||
      recovery.supersedesGeneration !== message.leaseEvidence.generation ||
      recovery.supersedesFenceIdentity !== message.leaseEvidence.fenceIdentity ||
      recovery.fenceIdentity === recovery.supersedesFenceIdentity) {
      fail("recovery_fence_not_newer", message.requestId);
    }
  }
}

function assertResultSemantics(message) {
  assertNoSerializedGrant(message);
  const expectedState = RESULT_STATES[message.operation];
  if (message.state !== expectedState) fail("accepted_result_lifecycle_invalid", message.operation);
  if (message.operation === "release") {
    if (message.leaseEvidence !== null) fail("release_retained_lease_evidence", message.requestId);
  } else assertLeaseEvidence(message.leaseEvidence, expectedState, `${message.operation}:result`);
}

function journalHash(message) {
  const withoutIdentity = clone(message);
  delete withoutIdentity.entryIdentity;
  return canonicalHash(withoutIdentity);
}

function assertJournalChain(entries) {
  const expectedTransitions = ["requested-active", "active-fenced"];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.sequence !== String(index + 1) || entry.transition !== expectedTransitions[index] ||
      entry.entryIdentity !== journalHash(entry) ||
      entry.previousEntryIdentity !== (index === 0 ? null : entries[index - 1].entryIdentity)) {
      fail("journal_chain_or_identity_invalid", String(index + 1));
    }
  }
}

function assertFixtureSemantics(fixtures, protocolValidate) {
  const expectedNames = [
    ...OPERATIONS.map((operation) => `request-${operation}`),
    ...OPERATIONS.map((operation) => `result-${operation}`),
    "journal-sequence-1", "journal-sequence-2",
  ];
  if (canonicalJson(fixtures.valid.map((entry) => entry.name)) !== canonicalJson(expectedNames)) {
    fail("positive_control_set_or_order_invalid", "fixtures");
  }
  const validResults = [];
  for (const fixture of fixtures.valid) {
    assertSchema(protocolValidate, fixture.message, "valid_fixture_schema_rejected");
    if (fixture.message.messageKind === "request") assertRequestSemantics(fixture.message);
    else if (fixture.message.messageKind === "result") assertResultSemantics(fixture.message);
    validResults.push({ name: fixture.name, accepted: true });
  }
  for (let index = 0; index < OPERATIONS.length; index += 1) {
    const request = fixtures.valid[index].message;
    const result = fixtures.valid[index + OPERATIONS.length].message;
    if (request.operation !== result.operation || request.requestId !== result.requestId) {
      fail("request_result_control_not_bound", request.operation);
    }
    if (request.operation === "recover" &&
      (result.leaseEvidence.generation !== request.recoveryFence.generation ||
       result.leaseEvidence.fenceIdentity !== request.recoveryFence.fenceIdentity)) {
      fail("recover_result_fence_handoff_invalid", request.requestId);
    }
  }
  const requests = Object.fromEntries(fixtures.valid.slice(0, OPERATIONS.length).map((fixture) =>
    [fixture.message.operation, fixture.message]));
  const results = Object.fromEntries(fixtures.valid.slice(OPERATIONS.length, OPERATIONS.length * 2).map((fixture) =>
    [fixture.message.operation, fixture.message]));
  const journalEntries = fixtures.valid.slice(-2).map((fixture) => fixture.message);
  assertJournalChain(journalEntries);
  if (canonicalJson(results.acquire.leaseEvidence) !== canonicalJson(requests.reserve.leaseEvidence)) {
    fail("acquire_reserve_lease_handoff_invalid", requests.reserve.requestId);
  }
  if (requests.fence.journalCursor !== journalEntries[0].entryIdentity ||
    journalEntries[0].requestIdentity !== canonicalHash(requests.acquire) ||
    results.acquire.journalCursor !== journalEntries[0].entryIdentity) {
    fail("acquire_journal_fence_handoff_invalid", requests.fence.requestId);
  }
  if (journalEntries[1].requestIdentity !== canonicalHash(requests.fence) ||
    journalEntries[1].effectIdentity !== canonicalHash({
      effectId: requests.fence.effectId,
      effectKind: requests.fence.effectKind,
    }) ||
    journalEntries[1].observedStateIdentity !== canonicalHash(requests.fence.intendedState) ||
    results.fence.journalCursor !== journalEntries[1].entryIdentity ||
    requests["compare-and-commit"].journalCursor !== journalEntries[1].entryIdentity ||
    canonicalJson(results.fence.leaseEvidence) !==
      canonicalJson(requests["compare-and-commit"].leaseEvidence) ||
    requests["compare-and-commit"].effectId !== requests.fence.effectId ||
    requests["compare-and-commit"].resourceId !== requests.fence.resourceId ||
    canonicalJson(requests["compare-and-commit"].base) !== canonicalJson(requests.fence.base) ||
    canonicalJson(requests["compare-and-commit"].expectedState) !== canonicalJson(requests.fence.expectedState) ||
    canonicalJson(requests["compare-and-commit"].intendedState) !== canonicalJson(requests.fence.intendedState)) {
    fail("fence_compare_journal_handoff_invalid", requests["compare-and-commit"].requestId);
  }

  const invalidResults = [];
  for (const fixture of fixtures.invalid) {
    let diagnosticCode = "schema_validation_failed";
    if (protocolValidate(fixture.message)) {
      try {
        if (fixture.message.messageKind === "request") assertRequestSemantics(fixture.message);
        else if (fixture.message.messageKind === "result") assertResultSemantics(fixture.message);
        else assertJournalChain([fixture.message]);
      } catch (error) {
        diagnosticCode = String(error.message).split(":", 1)[0];
        invalidResults.push({
          name: fixture.name, blocked: true, diagnosticCode,
          rawReplayEnvelope: { input: fixture.message, observedError: String(error.message) },
        });
        continue;
      }
      fail("invalid_fixture_false_green", fixture.name);
    }
    invalidResults.push({
      name: fixture.name,
      blocked: true,
      diagnosticCode,
      rawReplayEnvelope: { input: fixture.message, schemaErrors: clone(protocolValidate.errors ?? []) },
    });
  }
  return Object.freeze({ validResults, invalidResults });
}

function validateEvidenceRuns(contract) {
  const outputs = [];
  for (const run of contract.repositoryFacts.evidenceRuns) {
    const bytes = readMigrationWriteAuthorityFile(run.relativePath);
    if (sha256(bytes) !== run.sha256) fail("repository_evidence_hash_stale", run.relativePath);
    const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (report.reportIdentity !== run.reportIdentity) fail("repository_report_identity_stale", run.relativePath);
    outputs.push(validateRepositoryFactsReport(report, { expectedReportIdentity: run.reportIdentity }));
  }
  return outputs;
}

function parseArguments(argv) {
  const values = new Map();
  for (const argument of argv) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) fail("argument_invalid", argument);
    const key = argument.slice(2, separator);
    if (values.has(key)) fail("argument_duplicate", key);
    values.set(key, argument.slice(separator + 1));
  }
  const expected = ["author-receipt", "expected-author-receipt-sha256"];
  if (canonicalJson([...values.keys()].toSorted()) !== canonicalJson(expected)) {
    fail("argument_set_invalid", canonicalJson([...values.keys()]));
  }
  return values;
}

export function assertPinnedArtifactBytes(binding, bytes) {
  if (bytes.byteLength !== binding.byteLength || trustSha256(bytes) !== binding.sha256) {
    fail("author_receipt_artifact_stale", binding.relativePath);
  }
}

export function assertPinnedVerifierTrustBase(pinned, derived) {
  if (!isDeepStrictEqual(pinned, derived)) {
    fail("verifier_trust_base_stale", derived.trustBaseIdentity);
  }
}

function validateAuthorReceipt(values, receiptValidate) {
  const relativePath = values.get("author-receipt");
  if (!relativePath || isAbsolute(relativePath)) fail("author_receipt_path_invalid", String(relativePath));
  const receipt = parseJson(relativePath, "author-receipt");
  const expectedSha = values.get("expected-author-receipt-sha256");
  if (!/^[0-9a-f]{64}$/u.test(expectedSha ?? "") || trustSha256(receipt.bytes) !== expectedSha) {
    fail("externally_pinned_author_receipt_mismatch", String(expectedSha));
  }
  assertSchema(receiptValidate, receipt.value, "author_receipt_schema_invalid");
  if (!isDeepStrictEqual(receipt.value, buildMigrationWriteAuthorityAuthorReceiptValue())) {
    fail("author_receipt_snapshot_drift", relativePath);
  }
  for (const binding of receipt.value.artifacts) {
    const actual = migrationWriteAuthorityFileRecord(binding.relativePath);
    if (!isDeepStrictEqual(binding, actual)) fail("author_receipt_artifact_stale", binding.relativePath);
  }
  const derivedTrustBase = deriveVerifierTrustBase();
  assertPinnedVerifierTrustBase(receipt.value.verifierTrustBase, derivedTrustBase);
  return Object.freeze({
    relativePath,
    externalPinVerified: true,
    verifierTrustBaseIdentity: derivedTrustBase.trustBaseIdentity,
  });
}

export function validateAuthorContracts(options) {
  const receiptSchema = parseJson(PATHS.receiptSchema, "author-receipt-schema");
  const receipt = validateAuthorReceipt(options, compile(receiptSchema));
  const protocolSchema = parseJson(PATHS.protocolSchema, "protocol-schema");
  const fixtures = parseJson(PATHS.fixtures, "protocol-fixtures");
  const contract = parseJson(PATHS.contract, "qualification-contract");
  const contractSchema = parseJson(PATHS.contractSchema, "qualification-contract-schema");
  assertSchema(compile(contractSchema), contract.value, "qualification_contract_schema_invalid");
  if (sha256(readMigrationWriteAuthorityFile(PATHS.fixtureGenerator)) !== fixtures.value.generatedBy.sha256 ||
    fixtures.value.generatedBy.relativePath !== PATHS.fixtureGenerator) {
    fail("fixture_generator_identity_stale", fixtures.value.generatedBy.relativePath);
  }
  const fixtureResults = assertFixtureSemantics(fixtures.value, compile(protocolSchema));
  const evidenceResults = validateEvidenceRuns(contract.value);
  return Object.freeze({
    schemaVersion: "migration-authority-contract-validation/v2",
    status: "author-validation-unadmitted",
    authorReceipt: receipt,
    qualificationContract: { byteLength: Buffer.byteLength(contract.bytes), sha256: sha256(contract.bytes) },
    protocolSchemaSha256: sha256(protocolSchema.bytes),
    protocolFixtureSha256: sha256(fixtures.bytes),
    fixtureResults,
    evidenceResults,
    summary: {
      validAccepted: fixtureResults.validResults.length,
      invalidBlocked: fixtureResults.invalidResults.length,
      repositoryRunsValidated: evidenceResults.length,
      selectionOrPlacementOrReadinessClaim: false,
      independentAcceptance: false,
    },
  });
}

function main() {
  process.stdout.write(`${canonicalJson(validateAuthorContracts(parseArguments(process.argv.slice(2))))}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH)) main();
