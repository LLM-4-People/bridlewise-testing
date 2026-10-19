import { fileURLToPath } from "node:url";

import { canonicalJson, deepFreeze } from "../../../src/kernel/integrity.ts";
import {
  canonicalDocumentBytes,
  createByteOwnershipRegression,
  createPreIngestionAssessment,
  createWriteBoundaryIncident,
} from "../../../verification/core/artifact-governance/content-store/domain.ts";
import { readSafeRepositoryFile } from "../../verification/safe-repository-reader.ts";
import { bootstrapProcess, isEntryPoint } from "../../../src/runtime/cli-debug.ts";

export const CONTENT_ADDRESSED_EVIDENCE_PATHS = deepFreeze({
  "byte-ownership-regression":
    "traceability/evidence/verification/content-addressed-evidence/byte-ownership-regression.json",
  "pre-ingestion-assessment":
    "traceability/evidence/verification/content-addressed-evidence/pre-ingestion-assessment.json",
  "write-boundary-incident":
    "traceability/evidence/verification/content-addressed-evidence/write-boundary-incident.json",
} as const);

export type ContentAddressedEvidenceName = keyof typeof CONTENT_ADDRESSED_EVIDENCE_PATHS;

export type ContentAddressedEvidenceVerification = Readonly<{
  ok: boolean;
  violations: readonly string[];
}>;

const MAXIMUM_EVIDENCE_BYTES = 131_072;

export function buildContentAddressedEvidenceDocuments(): Readonly<Record<ContentAddressedEvidenceName, unknown>> {
  return deepFreeze({
    "byte-ownership-regression": createByteOwnershipRegression({
      status: "bounded-regression-verified",
      originalDefect: "deep-freeze-rejected-nonempty-typed-array-storage",
      repair: {
        internalStorage: "module-private-weak-map",
        ingressOwnership: "exact-view-defensive-copy",
        exportedReads: "fresh-defensive-copy",
        deepFreezeClaim: "none-for-byte-storage",
      },
      boundedLexicalAudit: {
        deepFreezeCallSites: 303,
        conservativeMutableViewCandidates: 33,
        apparentByteNamedCandidates: 5,
        observedMutableViewsOutsideFailedAttempt: 0,
        scope: "bounded-lexical-not-semantic-complete",
        dynamicResidual: "unproven",
      },
      regressionCoverage: [
        "input-alias-mutation",
        "pooled-buffer-and-subarray-exact-view",
        "exported-read-alias-mutation",
        "parallel-defensive-read-stability",
      ],
      productionClaim: "none",
    }),
    "pre-ingestion-assessment": createPreIngestionAssessment({
      status: "blocked-before-ingestion",
      productionActivationAllowed: false,
      productionActiveRegistryPresent: false,
      measurements: {
        logicalFiles: 2_326,
        logicalDirectories: 444,
        safeSymlinks: 3,
        logicalBytes: 110_091_200,
        uniqueBlobs: 935,
        uniqueBlobBytes: 51_241_552,
        deduplicatedBytes: 58_849_648,
        hardlinks: 0,
        specialEntries: 0,
        largestBlobByteLength: 15_439_943,
        largestBlobSha256: "88c995239b002eb5c560c9eea6af9509d07eff367a2cf0c1041ab07e0280a468",
      },
      blockers: [{
        type: "local-identity",
        affectedUniqueBlobs: 22,
        disposition: "blocked-no-exception",
        policyReferences: [
          "ROOT_POLICY.artifactGovernance.exclude.raw-personal-conversation-data",
        ],
      }, {
        type: "policy-conflict-cache-log-dependency",
        affectedUniqueBlobs: null,
        disposition: "blocked-no-exception",
        policyReferences: [
          "ROOT_POLICY.artifactGovernance.exclude.caches",
          "ROOT_POLICY.artifactGovernance.exclude.dependency-directories",
        ],
      }, {
        type: "semantic-classification-pending",
        affectedUniqueBlobs: 2,
        disposition: "blocked-no-exception",
        policyReferences: [
          "src/classification-catalog.ts#DATA_CLASSIFICATION",
        ],
      }, {
        type: "license-notice-closure-incomplete",
        affectedUniqueBlobs: null,
        disposition: "blocked-no-exception",
        policyReferences: [
          "ROOT_POLICY.artifactGovernance.contentAddressedEvidence.admission.exactLicenseTextNoticeAndExternalLeaseClosureRequired",
        ],
      }],
      protocolDisposition: "synthetic-fixtures-only",
      publicClaim: "none",
    }),
    "write-boundary-incident": createWriteBoundaryIncident({
      incidentId: "implicit-default-root-write-effect",
      recordedDate: "2026-07-14",
      intendedRootClass: "external-temporary",
      actualRootClass: "repository-worktree",
      createdRelativePath: "cas-measure.mjs",
      createdByteLength: 11_833,
      createdSha256: "f43d98b674b7df7d3059a2c12b1dc8e75fe8abebdcd63348f56d93261d753357",
      detection: ["dual-path-existence-check", "candidate-status-check"],
      cleanup: "exact-new-file-removed-with-apply-patch",
      postCleanup: {
        headUnchanged: true,
        indexUnchanged: true,
        candidateStatusV1Unchanged: true,
        candidateStatusV2Unchanged: true,
      },
      baselineSentinels: {
        headSha1: "04b00b27e8c8b46ca98c180400df215151942d14",
        indexSha256: "ebb17d127fd57fd8eae63198d3037db00774d5cb33270f02b098dd24bf18a7ba",
        candidateStatusV1Sha256: "ca66e74118f2965069ca6f780ffd7386a415af88cd7fcb774752c48b361c881c",
        candidateStatusV2Sha256: "85299a1e5f4ad8e148c2f59534db8002da46ada196502f39fefa1c0ad88c13a7",
      },
      permanentControls: [
        "explicit-workspace-root-identity",
        "closed-logical-path-canonical-form",
        "active-exact-write-set",
        "pre-effect-rejection",
      ],
      authorityClaim: "incident-preserved-history-not-erased",
    }),
  });
}

export function contentAddressedEvidenceBytes(name: ContentAddressedEvidenceName): Uint8Array {
  return canonicalDocumentBytes(buildContentAddressedEvidenceDocuments()[name]);
}

export function verifyContentAddressedEvidence(root: string): ContentAddressedEvidenceVerification {
  const violations: string[] = [];
  for (const name of Object.keys(CONTENT_ADDRESSED_EVIDENCE_PATHS) as ContentAddressedEvidenceName[]) {
    try {
      const actual = readSafeRepositoryFile(
        root,
        CONTENT_ADDRESSED_EVIDENCE_PATHS[name],
        MAXIMUM_EVIDENCE_BYTES,
      ).bytes;
      if (!Buffer.from(actual).equals(Buffer.from(contentAddressedEvidenceBytes(name)))) {
        violations.push(`content-addressed-evidence-byte-drift:${name}`);
      }
    } catch {
      violations.push(`content-addressed-evidence-missing-or-invalid:${name}`);
    }
  }
  return deepFreeze({ ok: violations.length === 0, violations: [...violations].toSorted() });
}

function parseName(value: string | undefined): ContentAddressedEvidenceName {
  if (value !== undefined && Object.hasOwn(CONTENT_ADDRESSED_EVIDENCE_PATHS, value)) {
    return value as ContentAddressedEvidenceName;
  }
  throw new Error("content-addressed-evidence-name-invalid");
}

function main(args: readonly string[]): number {
  if (args.length === 2 && args[0] === "--print") {
    process.stdout.write(contentAddressedEvidenceBytes(parseName(args[1])));
    return 0;
  }
  if (args.length === 1 && args[0] === "--verify") {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const verification = verifyContentAddressedEvidence(root);
    process.stdout.write(`${canonicalJson(verification)}\n`);
    return verification.ok ? 0 : 1;
  }
  throw new Error("usage: content-addressed-evidence.ts --print <name> | --verify");
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "content-addressed-evidence-command-failed"}\n`);
    process.exitCode = 1;
  }
}
