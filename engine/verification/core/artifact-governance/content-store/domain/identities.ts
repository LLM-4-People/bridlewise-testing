import { InputError } from "../../../../../src/kernel/errors.ts";
import {
  canonicalDomainHash,
  canonicalJson,
  deepFreeze,
} from "../../../../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../../../../src/kernel/json-integrity.ts";

import {
  CONTENT_STORE_BYTE_OWNERSHIP_REGRESSION_SCHEMA_VERSION,
  CONTENT_STORE_PRE_INGESTION_SCHEMA_VERSION,
  CONTENT_STORE_WRITE_BOUNDARY_INCIDENT_SCHEMA_VERSION,
  type ByteOwnershipRegression,
  type PreIngestionAssessment,
  type WriteBoundaryIncident,
} from "./contracts.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function assertSha256(value: string, code = "content_store_sha256_invalid"): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new InputError("Content store SHA-256 value is invalid", code);
  }
}

export function canonicalDocumentBytes(value: unknown): Uint8Array {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function parseCanonicalJsonDocument(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new InputError(`${label} is not valid UTF-8`, "content_store_json_utf8_invalid");
  }
  assertNoDuplicateJsonObjectKeys(
    text,
    `${label} contains a duplicate key`,
    "content_store_json_key_duplicate",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new InputError(`${label} is not valid JSON`, "content_store_json_invalid");
  }
  if (text !== `${canonicalJson(parsed)}\n`) {
    throw new InputError(`${label} is not canonical JSON`, "content_store_json_noncanonical");
  }
  return parsed;
}

export function createPreIngestionAssessment(
  input: Omit<PreIngestionAssessment, "schemaVersion" | "assessmentIdentity">,
): PreIngestionAssessment {
  const measurements = input.measurements;
  for (const value of [
    measurements.logicalFiles,
    measurements.logicalDirectories,
    measurements.safeSymlinks,
    measurements.logicalBytes,
    measurements.uniqueBlobs,
    measurements.uniqueBlobBytes,
    measurements.deduplicatedBytes,
    measurements.hardlinks,
    measurements.specialEntries,
    measurements.largestBlobByteLength,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new InputError("Assessment count is invalid", "content_store_assessment_count_invalid");
    }
  }
  assertSha256(measurements.largestBlobSha256, "content_store_assessment_digest_invalid");
  const blockers = [...input.blockers].toSorted((left, right) => left.type.localeCompare(right.type));
  if (new Set(blockers.map((blocker) => blocker.type)).size !== blockers.length) {
    throw new InputError(
      "Assessment blocker is duplicated",
      "content_store_assessment_blocker_duplicate",
    );
  }
  for (const blocker of blockers) {
    if (blocker.affectedUniqueBlobs !== null &&
      (!Number.isSafeInteger(blocker.affectedUniqueBlobs) || blocker.affectedUniqueBlobs < 0)) {
      throw new InputError(
        "Assessment blocker count is invalid",
        "content_store_assessment_blocker_count_invalid",
      );
    }
  }
  const payload = {
    schemaVersion: CONTENT_STORE_PRE_INGESTION_SCHEMA_VERSION,
    ...input,
    blockers,
  };
  return deepFreeze({
    ...payload,
    assessmentIdentity: canonicalDomainHash("content-store.pre-ingestion-assessment/v1", payload),
  });
}

export function createWriteBoundaryIncident(
  input: Omit<WriteBoundaryIncident, "schemaVersion" | "incidentIdentity">,
): WriteBoundaryIncident {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.recordedDate) ||
    !Number.isSafeInteger(input.createdByteLength) || input.createdByteLength < 0) {
    throw new InputError(
      "Write-boundary incident input is invalid",
      "content_store_incident_input_invalid",
    );
  }
  assertSha256(input.createdSha256, "content_store_incident_digest_invalid");
  if (!/^[0-9a-f]{40}$/u.test(input.baselineSentinels.headSha1)) {
    throw new InputError(
      "Write-boundary incident HEAD identity is invalid",
      "content_store_incident_head_invalid",
    );
  }
  for (const digest of [
    input.baselineSentinels.indexSha256,
    input.baselineSentinels.candidateStatusV1Sha256,
    input.baselineSentinels.candidateStatusV2Sha256,
  ]) assertSha256(digest, "content_store_incident_sentinel_invalid");
  const payload = { schemaVersion: CONTENT_STORE_WRITE_BOUNDARY_INCIDENT_SCHEMA_VERSION, ...input };
  return deepFreeze({
    ...payload,
    incidentIdentity: canonicalDomainHash("content-store.write-boundary-incident/v1", payload),
  });
}

export function createByteOwnershipRegression(
  input: Omit<ByteOwnershipRegression, "schemaVersion" | "regressionIdentity">,
): ByteOwnershipRegression {
  const audit = input.boundedLexicalAudit;
  for (const value of [
    audit.deepFreezeCallSites,
    audit.conservativeMutableViewCandidates,
    audit.apparentByteNamedCandidates,
    audit.observedMutableViewsOutsideFailedAttempt,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new InputError(
        "Byte-ownership regression count is invalid",
        "content_store_byte_ownership_count_invalid",
      );
    }
  }
  const payload = {
    schemaVersion: CONTENT_STORE_BYTE_OWNERSHIP_REGRESSION_SCHEMA_VERSION,
    ...input,
  };
  return deepFreeze({
    ...payload,
    regressionIdentity: canonicalDomainHash("content-store.byte-ownership-regression/v1", payload),
  });
}
