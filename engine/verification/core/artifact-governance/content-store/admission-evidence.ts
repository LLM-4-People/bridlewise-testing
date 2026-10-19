import { DATA_CLASSIFICATION, type DataClassification } from
  "../../../../src/privacy/classification-catalog.ts";
import { InputError } from "../../../../src/kernel/errors.ts";
import { canonicalDomainHash, deepFreeze } from "../../../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../../../src/kernel/root-policy.ts";

import {
  type AdmissionBlocker,
  type AdmissionBlockerCode,
  type BlobClassificationReceipt,
  type BlobLicenseReceipt,
  type ContentAdmissionDecision,
} from "./domain/contracts.ts";
import { assertSha256 } from "./domain/identities.ts";
import type { ContentBlob } from "./pack.ts";

export const CLASSIFICATION_EVIDENCE_SCHEMA_VERSION =
  "bridlewise-content-classification-evidence/v1" as const;
export const LICENSE_EVIDENCE_SCHEMA_VERSION =
  "bridlewise-content-license-evidence/v1" as const;
export const CLASSIFICATION_EVIDENCE_SCHEMA_IDENTITY = canonicalDomainHash(
  "content-store.classification-evidence-schema/v1",
  [
    "artifactExclusionId",
    "blobSha256",
    "blockReason",
    "classificationId",
    "decision",
    "receiptIdentity",
    "scannerRevision",
  ],
);
export const LICENSE_EVIDENCE_SCHEMA_IDENTITY = canonicalDomainHash(
  "content-store.license-evidence-schema/v1",
  [
    "blobSha256",
    "decision",
    "externalLeaseIdentity",
    "licenseExpression",
    "licenseTextSha256",
    "noticeTextSha256",
    "receiptIdentity",
  ],
);

const ADMISSION_POLICY = ROOT_POLICY.artifactGovernance.contentAddressedEvidence.admission;
const ARTIFACT_EXCLUSIONS = new Set<string>(ROOT_POLICY.artifactGovernance.exclude);
const CLASSIFICATIONS = new Set<DataClassification>(Object.values(DATA_CLASSIFICATION));
const SPDX_EXPRESSION = /^[A-Za-z0-9][A-Za-z0-9.+() -]*$/u;

export type ContentAdmissionAuthority = Readonly<{
  classificationProviderIdentity: string;
  classificationPolicyIdentity: string;
  classificationSchemaIdentity: typeof CLASSIFICATION_EVIDENCE_SCHEMA_IDENTITY;
  licenseProviderIdentity: string;
  licensePolicyIdentity: string;
  licenseSchemaIdentity: typeof LICENSE_EVIDENCE_SCHEMA_IDENTITY;
  authorityIdentity: string;
}>;

export type ContentEvidenceProvider<Receipt> = Readonly<{
  providerIdentity: string;
  policyIdentity: string;
  schemaIdentity: string;
  collect: (blobs: readonly ContentBlob[]) => readonly Receipt[];
}>;

export type ContentProviderEvidence<Receipt> = Readonly<{
  collectionStatus: "complete" | "provider-error" | "provider-output-invalid";
  providerIdentity: string;
  policyIdentity: string;
  schemaIdentity: string;
  receipts: readonly Receipt[];
  evidenceIdentity: string;
}>;

export type ContentAdmissionEvidence = Readonly<{
  classification: ContentProviderEvidence<BlobClassificationReceipt>;
  license: ContentProviderEvidence<BlobLicenseReceipt>;
  evidenceIdentity: string;
}>;

export type ClassificationReceiptDraft = Omit<BlobClassificationReceipt, "receiptIdentity">;
export type LicenseReceiptDraft = Omit<BlobLicenseReceipt, "receiptIdentity">;

export function createContentAdmissionAuthority(input: Readonly<{
  classificationProviderIdentity: string;
  licenseProviderIdentity: string;
}>): ContentAdmissionAuthority {
  assertSha256(input.classificationProviderIdentity, "content_store_classification_provider_invalid");
  assertSha256(input.licenseProviderIdentity, "content_store_license_provider_invalid");
  const payload = {
    classificationProviderIdentity: input.classificationProviderIdentity,
    classificationPolicyIdentity: classificationPolicyIdentity(),
    classificationSchemaIdentity: CLASSIFICATION_EVIDENCE_SCHEMA_IDENTITY,
    licenseProviderIdentity: input.licenseProviderIdentity,
    licensePolicyIdentity: licensePolicyIdentity(),
    licenseSchemaIdentity: LICENSE_EVIDENCE_SCHEMA_IDENTITY,
  };
  return deepFreeze({
    ...payload,
    authorityIdentity: canonicalDomainHash("content-store.admission-authority/v1", payload),
  });
}

export function collectContentAdmissionEvidence(
  blobs: readonly ContentBlob[],
  providers: Readonly<{
    classification: ContentEvidenceProvider<BlobClassificationReceipt>;
    license: ContentEvidenceProvider<BlobLicenseReceipt>;
  }>,
): ContentAdmissionEvidence {
  const classification = collectProviderEvidence(
    blobs,
    providers.classification,
    validateClassificationReceiptShape,
    CLASSIFICATION_EVIDENCE_SCHEMA_VERSION,
  );
  const license = collectProviderEvidence(
    blobs,
    providers.license,
    validateLicenseReceiptShape,
    LICENSE_EVIDENCE_SCHEMA_VERSION,
  );
  const payload = { classification, license };
  return deepFreeze({
    ...payload,
    evidenceIdentity: canonicalDomainHash("content-store.admission-evidence/v1", payload),
  });
}

export function createClassificationReceipt(
  draft: ClassificationReceiptDraft,
): BlobClassificationReceipt {
  assertExactKeys(draft, [
    "artifactExclusionId",
    "blobSha256",
    "blockReason",
    "classificationId",
    "decision",
    "scannerRevision",
  ], "content_store_classification_receipt_invalid");
  assertSha256(draft.blobSha256, "content_store_classification_blob_digest_invalid");
  if (draft.scannerRevision.length === 0 || !CLASSIFICATIONS.has(draft.classificationId)) {
    throw new InputError("Classification receipt is invalid", "content_store_classification_receipt_invalid");
  }
  if (draft.artifactExclusionId !== null && !ARTIFACT_EXCLUSIONS.has(draft.artifactExclusionId)) {
    throw new InputError(
      "Classification receipt exclusion is not centrally registered",
      "content_store_classification_exclusion_unregistered",
    );
  }
  if ((draft.decision === "admit" &&
      (draft.blockReason !== null || draft.artifactExclusionId !== null ||
        !isPermittedClassification(draft.classificationId))) ||
    (draft.decision === "block" && draft.blockReason === null)) {
    throw new InputError(
      "Classification receipt disposition is invalid",
      "content_store_classification_disposition_invalid",
    );
  }
  return deepFreeze({
    ...draft,
    receiptIdentity: canonicalDomainHash("content-store.classification-receipt/v1", draft),
  });
}

export function createLicenseReceipt(draft: LicenseReceiptDraft): BlobLicenseReceipt {
  assertExactKeys(draft, [
    "blobSha256",
    "decision",
    "externalLeaseIdentity",
    "licenseExpression",
    "licenseTextSha256",
    "noticeTextSha256",
  ], "content_store_license_receipt_invalid");
  assertSha256(draft.blobSha256, "content_store_license_blob_digest_invalid");
  for (const digest of [draft.licenseTextSha256, draft.noticeTextSha256, draft.externalLeaseIdentity]) {
    if (digest !== null) assertSha256(digest, "content_store_license_closure_digest_invalid");
  }
  const complete = draft.licenseExpression !== null && SPDX_EXPRESSION.test(draft.licenseExpression) &&
    draft.licenseTextSha256 !== null && draft.noticeTextSha256 !== null &&
    draft.externalLeaseIdentity !== null;
  if ((draft.decision === "admit" && !complete) || (draft.decision === "block" && complete)) {
    throw new InputError("License receipt closure is invalid", "content_store_license_receipt_invalid");
  }
  return deepFreeze({
    ...draft,
    receiptIdentity: canonicalDomainHash("content-store.license-receipt/v1", draft),
  });
}

/** Internal seam for candidate construction; the application facade does not re-export it. */
export function evaluateContentAdmissionForCandidateInternal(
  authority: ContentAdmissionAuthority,
  evidence: ContentAdmissionEvidence,
  blobs: readonly ContentBlob[],
): ContentAdmissionDecision {
  return contentAdmissionDecision(blobs.length, admissionEvidenceBlockers(authority, evidence, blobs));
}

function collectProviderEvidence<Receipt>(
  blobs: readonly ContentBlob[],
  provider: ContentEvidenceProvider<Receipt>,
  validateReceipt: (receipt: Receipt) => Receipt,
  schemaVersion: string,
): ContentProviderEvidence<Receipt> {
  let collectionStatus: ContentProviderEvidence<Receipt>["collectionStatus"] = "complete";
  let receipts: readonly Receipt[] = [];
  let output: readonly Receipt[];
  try {
    output = provider.collect(blobs);
  } catch {
    collectionStatus = "provider-error";
    output = [];
  }
  if (collectionStatus === "complete") {
    try {
      if (!Array.isArray(output)) throw new Error("provider-output-not-array");
      receipts = Object.freeze(output.map(validateReceipt));
    } catch {
      collectionStatus = "provider-output-invalid";
      receipts = [];
    }
  }
  const payload = {
    schemaVersion,
    collectionStatus,
    providerIdentity: provider.providerIdentity,
    policyIdentity: provider.policyIdentity,
    schemaIdentity: provider.schemaIdentity,
    receipts,
  };
  return deepFreeze({
    collectionStatus,
    providerIdentity: provider.providerIdentity,
    policyIdentity: provider.policyIdentity,
    schemaIdentity: provider.schemaIdentity,
    receipts,
    evidenceIdentity: canonicalDomainHash("content-store.provider-evidence/v1", payload),
  });
}

function admissionEvidenceBlockers(
  authority: ContentAdmissionAuthority,
  evidence: ContentAdmissionEvidence,
  blobs: readonly ContentBlob[],
): readonly AdmissionBlocker[] {
  const counts = new Map<AdmissionBlockerCode, Readonly<{ count: number; policyReferences: readonly string[] }>>();
  if (canonicalDomainHash("content-store.admission-evidence/v1", {
    classification: evidence.classification,
    license: evidence.license,
  }) !== evidence.evidenceIdentity) {
    incrementBlocker(counts, evidenceInvalid("classification-evidence-invalid", blobs.length));
    incrementBlocker(counts, evidenceInvalid("license-evidence-invalid", blobs.length));
    return blockerRows(counts);
  }
  validateProviderBatch(evidence.classification, authority.classificationProviderIdentity,
    authority.classificationPolicyIdentity, authority.classificationSchemaIdentity, blobs, "classification", counts);
  validateProviderBatch(evidence.license, authority.licenseProviderIdentity,
    authority.licensePolicyIdentity, authority.licenseSchemaIdentity, blobs, "license", counts);
  if (counts.size > 0) return blockerRows(counts);
  for (const receipt of evidence.classification.receipts) {
    const blocker = classificationBlockerFor(receipt);
    if (blocker !== null) incrementBlocker(counts, { ...blocker, count: 1 });
  }
  for (const receipt of evidence.license.receipts) {
    if (receipt.decision === "block") incrementBlocker(counts, {
      code: "license-closure-incomplete",
      count: 1,
      policyReferences: [
        "ROOT_POLICY.artifactGovernance.contentAddressedEvidence.admission.exactLicenseTextNoticeAndExternalLeaseClosureRequired",
      ],
    });
  }
  return blockerRows(counts);
}

function validateProviderBatch<Receipt extends Readonly<{ blobSha256: string }>>(
  evidence: ContentProviderEvidence<Receipt>,
  providerIdentity: string,
  policyIdentity: string,
  schemaIdentity: string,
  blobs: readonly ContentBlob[],
  kind: "classification" | "license",
  counts: Map<AdmissionBlockerCode, Readonly<{ count: number; policyReferences: readonly string[] }>>,
): void {
  if (evidence.collectionStatus === "provider-error") {
    incrementBlocker(counts, { code: `${kind}-provider-failed`, count: blobs.length,
      policyReferences: [`content-store.${kind}-provider-identity`] });
    return;
  }
  if (evidence.collectionStatus !== "complete" || evidence.providerIdentity !== providerIdentity ||
    evidence.policyIdentity !== policyIdentity || evidence.schemaIdentity !== schemaIdentity) {
    incrementBlocker(counts, evidenceInvalid(`${kind}-evidence-invalid`, blobs.length));
    return;
  }
  const expected = blobs.map((blob) => blob.sha256);
  const actual = evidence.receipts.map((receipt) => receipt.blobSha256);
  if (actual.length < expected.length) incrementBlocker(counts, {
    code: `${kind}-receipt-missing`, count: expected.length - actual.length,
    policyReferences: [`content-store.${kind}-exact-blob-coverage`],
  });
  if (actual.length !== expected.length || actual.some((digest, index) => digest !== expected[index]) ||
    new Set(actual).size !== actual.length) {
    incrementBlocker(counts, evidenceInvalid(`${kind}-evidence-invalid`, blobs.length));
  }
}

function validateClassificationReceiptShape(receipt: BlobClassificationReceipt): BlobClassificationReceipt {
  const { receiptIdentity, ...draft } = receipt;
  const expected = createClassificationReceipt(draft);
  if (expected.receiptIdentity !== receiptIdentity) {
    throw new InputError("Classification receipt identity is invalid", "content_store_classification_receipt_invalid");
  }
  return expected;
}

function validateLicenseReceiptShape(receipt: BlobLicenseReceipt): BlobLicenseReceipt {
  const { receiptIdentity, ...draft } = receipt;
  const expected = createLicenseReceipt(draft);
  if (expected.receiptIdentity !== receiptIdentity) {
    throw new InputError("License receipt identity is invalid", "content_store_license_receipt_invalid");
  }
  return expected;
}

function contentAdmissionDecision(blobCount: number, blockers: readonly AdmissionBlocker[]): ContentAdmissionDecision {
  const payload = { status: blockers.length === 0 ? "admitted" as const : "blocked" as const, blockers, blobCount };
  return deepFreeze({
    ...payload,
    decisionIdentity: canonicalDomainHash("content-store.admission-decision/v1", payload),
  });
}

function classificationBlockerFor(
  receipt: BlobClassificationReceipt,
): Readonly<{ code: AdmissionBlockerCode; policyReferences: readonly string[] }> | null {
  if (receipt.decision === "admit") return null;
  if (receipt.blockReason === "credential-secret") return {
    code: "classification-credential-secret",
    policyReferences: ["src/classification-catalog.ts#DATA_CLASSIFICATION.credentialSecret"],
  };
  if (receipt.blockReason === "local-identity") return {
    code: "classification-local-identity",
    policyReferences: ["ROOT_POLICY.artifactGovernance.exclude.raw-personal-conversation-data"],
  };
  if (receipt.blockReason === "policy-conflict") return {
    code: "classification-policy-conflict",
    policyReferences: [`ROOT_POLICY.artifactGovernance.exclude.${receipt.artifactExclusionId ?? "unresolved"}`],
  };
  return { code: "classification-semantic-pending",
    policyReferences: ["src/classification-catalog.ts#DATA_CLASSIFICATION.regulatedRestricted"] };
}

function classificationPolicyIdentity(): string {
  return canonicalDomainHash("content-store.classification-policy/v1", {
    classificationCatalog: DATA_CLASSIFICATION,
    permittedClassifications: ADMISSION_POLICY.permittedClassifications,
    artifactExclusions: ROOT_POLICY.artifactGovernance.exclude,
    scannerExceptionOrAdHocAllowlistAllowed: ADMISSION_POLICY.scannerExceptionOrAdHocAllowlistAllowed,
  });
}

function licensePolicyIdentity(): string {
  return canonicalDomainHash("content-store.license-policy/v1", {
    exactClosureRequired: ADMISSION_POLICY.exactLicenseTextNoticeAndExternalLeaseClosureRequired,
    exactBlobReceiptCoverageRequired: ADMISSION_POLICY.exactBlobReceiptCoverageRequired,
  });
}

function blockerRows(
  counts: ReadonlyMap<AdmissionBlockerCode, Readonly<{ count: number; policyReferences: readonly string[] }>>,
): readonly AdmissionBlocker[] {
  return deepFreeze([...counts.entries()].map(([code, value]) => ({
    code, affectedBlobCount: value.count, policyReferences: value.policyReferences,
  })).toSorted((left, right) => left.code.localeCompare(right.code)));
}

function incrementBlocker(
  counts: Map<AdmissionBlockerCode, Readonly<{ count: number; policyReferences: readonly string[] }>>,
  blocker: Readonly<{ code: AdmissionBlockerCode; count: number; policyReferences: readonly string[] }>,
): void {
  const current = counts.get(blocker.code);
  counts.set(blocker.code, { count: (current?.count ?? 0) + blocker.count,
    policyReferences: blocker.policyReferences });
}

function evidenceInvalid(
  code: "classification-evidence-invalid" | "license-evidence-invalid",
  count: number,
): Readonly<{ code: typeof code; count: number; policyReferences: readonly string[] }> {
  return { code, count, policyReferences: [`content-store.${code}`] };
}

function isPermittedClassification(classification: DataClassification): boolean {
  return ADMISSION_POLICY.permittedClassifications.some((candidate) => candidate === classification);
}

function assertExactKeys(value: object, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new InputError("Evidence receipt fields are invalid", code);
  }
}
