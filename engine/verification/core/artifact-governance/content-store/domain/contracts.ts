import type { DataClassification } from "../../../../../src/privacy/classification-catalog.ts";

export const CONTENT_STORE_SCHEMA_VERSION = "bridlewise-content-addressed-evidence/v1" as const;
export const CONTENT_STORE_REGISTRY_SCHEMA_VERSION =
  "bridlewise-content-addressed-evidence-registry/v1" as const;
export const CONTENT_STORE_ACTIVE_SCHEMA_VERSION =
  "bridlewise-content-addressed-evidence-active/v1" as const;
export const CONTENT_STORE_JOURNAL_SCHEMA_VERSION =
  "bridlewise-content-addressed-evidence-journal/v1" as const;
export const CONTENT_STORE_JOURNAL_PHASE_REGISTRY = Object.freeze([
  Object.freeze({ id: "prepared", ordinal: 0, fileName: "00-prepared.json" }),
  Object.freeze({ id: "objects-published", ordinal: 1, fileName: "01-objects-published.json" }),
  Object.freeze({ id: "active-published", ordinal: 2, fileName: "02-active-published.json" }),
] as const);
export const CONTENT_STORE_FIRST_ACTIVATION_STAGE_REGISTRY = Object.freeze([
  Object.freeze({ id: "journal-prepared", kind: "journal", phase: CONTENT_STORE_JOURNAL_PHASE_REGISTRY[0].id }),
  Object.freeze({ id: "pack-and-index-objects", kind: "objects", phase: null }),
  Object.freeze({ id: "tree-object", kind: "objects", phase: null }),
  Object.freeze({ id: "registry-object", kind: "objects", phase: null }),
  Object.freeze({
    id: "journal-objects-published",
    kind: "journal",
    phase: CONTENT_STORE_JOURNAL_PHASE_REGISTRY[1].id,
  }),
  Object.freeze({ id: "active-registry", kind: "active", phase: null }),
  Object.freeze({
    id: "journal-active-published",
    kind: "journal",
    phase: CONTENT_STORE_JOURNAL_PHASE_REGISTRY[2].id,
  }),
] as const);
export const CONTENT_STORE_PRE_INGESTION_SCHEMA_VERSION =
  "bridlewise-content-addressed-evidence-pre-ingestion/v1" as const;
export const CONTENT_STORE_WRITE_BOUNDARY_INCIDENT_SCHEMA_VERSION =
  "bridlewise-content-addressed-evidence-write-boundary-incident/v1" as const;
export const CONTENT_STORE_BYTE_OWNERSHIP_REGRESSION_SCHEMA_VERSION =
  "bridlewise-content-addressed-evidence-byte-ownership-regression/v1" as const;

export type BlobClassificationReceipt = Readonly<{
  blobSha256: string;
  scannerRevision: string;
  decision: "admit" | "block";
  classificationId: DataClassification;
  artifactExclusionId: string | null;
  blockReason:
    | "credential-secret"
    | "local-identity"
    | "policy-conflict"
    | "semantic-classification-pending"
    | null;
  receiptIdentity: string;
}>;

export type BlobLicenseReceipt = Readonly<{
  blobSha256: string;
  decision: "admit" | "block";
  receiptIdentity: string;
  licenseExpression: string | null;
  licenseTextSha256: string | null;
  noticeTextSha256: string | null;
  externalLeaseIdentity: string | null;
}>;

export type AdmissionBlockerCode =
  | "classification-credential-secret"
  | "classification-evidence-invalid"
  | "classification-local-identity"
  | "classification-policy-conflict"
  | "classification-provider-failed"
  | "classification-semantic-pending"
  | "classification-receipt-missing"
  | "license-evidence-invalid"
  | "license-closure-incomplete"
  | "license-provider-failed"
  | "license-receipt-missing";

export type AdmissionBlocker = Readonly<{
  code: AdmissionBlockerCode;
  affectedBlobCount: number;
  policyReferences: readonly string[];
}>;

export type ContentAdmissionDecision = Readonly<{
  status: "admitted" | "blocked";
  blockers: readonly AdmissionBlocker[];
  blobCount: number;
  decisionIdentity: string;
}>;

export type ContentRegistry = Readonly<{
  schemaVersion: typeof CONTENT_STORE_REGISTRY_SCHEMA_VERSION;
  algorithm: "sha256";
  packCeilingBytes: number;
  treeIdentity: string;
  treeByteLength: number;
  treeSha256: string;
  packs: readonly Readonly<{
    indexIdentity: string;
    indexByteLength: number;
    indexSha256: string;
    packByteLength: number;
    packSha256: string;
  }>[];
  admissionDecisionIdentity: string;
  registryIdentity: string;
}>;

export type ContentActiveRegistry = Readonly<{
  schemaVersion: typeof CONTENT_STORE_ACTIVE_SCHEMA_VERSION;
  algorithm: "sha256";
  registryByteLength: number;
  registrySha256: string;
  registryIdentity: string;
  priorActiveIdentity: string | null;
  activeIdentity: string;
}>;

export type ContentJournal = Readonly<{
  schemaVersion: typeof CONTENT_STORE_JOURNAL_SCHEMA_VERSION;
  transactionId: string;
  planIdentity: string;
  attemptId: string;
  attemptAuthority: "caller-supplied-synthetic-unadmitted";
  attemptChronologyClaim: false;
  phase: typeof CONTENT_STORE_JOURNAL_PHASE_REGISTRY[number]["id"];
  registryIdentity: string;
  registrySha256: string;
  priorActiveIdentity: string | null;
  writeSetIdentity: string;
  journalIdentity: string;
}>;

export type PreIngestionBlocker = Readonly<{
  type:
    | "local-identity"
    | "policy-conflict-cache-log-dependency"
    | "semantic-classification-pending"
    | "license-notice-closure-incomplete";
  affectedUniqueBlobs: number | null;
  disposition: "blocked-no-exception";
  policyReferences: readonly string[];
}>;

export type PreIngestionAssessment = Readonly<{
  schemaVersion: typeof CONTENT_STORE_PRE_INGESTION_SCHEMA_VERSION;
  status: "blocked-before-ingestion";
  productionActivationAllowed: false;
  productionActiveRegistryPresent: false;
  measurements: Readonly<{
    logicalFiles: number;
    logicalDirectories: number;
    safeSymlinks: number;
    logicalBytes: number;
    uniqueBlobs: number;
    uniqueBlobBytes: number;
    deduplicatedBytes: number;
    hardlinks: number;
    specialEntries: number;
    largestBlobByteLength: number;
    largestBlobSha256: string;
  }>;
  blockers: readonly PreIngestionBlocker[];
  protocolDisposition: "synthetic-fixtures-only";
  publicClaim: "none";
  assessmentIdentity: string;
}>;

export type WriteBoundaryIncident = Readonly<{
  schemaVersion: typeof CONTENT_STORE_WRITE_BOUNDARY_INCIDENT_SCHEMA_VERSION;
  incidentId: "implicit-default-root-write-effect";
  recordedDate: string;
  intendedRootClass: "external-temporary";
  actualRootClass: "repository-worktree";
  createdRelativePath: "cas-measure.mjs";
  createdByteLength: number;
  createdSha256: string;
  detection: readonly ["dual-path-existence-check", "candidate-status-check"];
  cleanup: "exact-new-file-removed-with-apply-patch";
  postCleanup: Readonly<{
    headUnchanged: true;
    indexUnchanged: true;
    candidateStatusV1Unchanged: true;
    candidateStatusV2Unchanged: true;
  }>;
  baselineSentinels: Readonly<{
    headSha1: string;
    indexSha256: string;
    candidateStatusV1Sha256: string;
    candidateStatusV2Sha256: string;
  }>;
  permanentControls: readonly [
    "explicit-workspace-root-identity",
    "closed-logical-path-canonical-form",
    "active-exact-write-set",
    "pre-effect-rejection",
  ];
  authorityClaim: "incident-preserved-history-not-erased";
  incidentIdentity: string;
}>;

export type ByteOwnershipRegression = Readonly<{
  schemaVersion: typeof CONTENT_STORE_BYTE_OWNERSHIP_REGRESSION_SCHEMA_VERSION;
  status: "bounded-regression-verified";
  originalDefect: "deep-freeze-rejected-nonempty-typed-array-storage";
  repair: Readonly<{
    internalStorage: "module-private-weak-map";
    ingressOwnership: "exact-view-defensive-copy";
    exportedReads: "fresh-defensive-copy";
    deepFreezeClaim: "none-for-byte-storage";
  }>;
  boundedLexicalAudit: Readonly<{
    deepFreezeCallSites: number;
    conservativeMutableViewCandidates: number;
    apparentByteNamedCandidates: number;
    observedMutableViewsOutsideFailedAttempt: number;
    scope: "bounded-lexical-not-semantic-complete";
    dynamicResidual: "unproven";
  }>;
  regressionCoverage: readonly [
    "input-alias-mutation",
    "pooled-buffer-and-subarray-exact-view",
    "exported-read-alias-mutation",
    "parallel-defensive-read-stability",
  ];
  productionClaim: "none";
  regressionIdentity: string;
}>;
