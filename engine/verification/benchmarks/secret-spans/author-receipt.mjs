import { canonicalHash } from "../../../src/kernel/integrity.ts";
import {
  collectQualificationFileSnapshot,
  deriveQualificationTrustBase
} from "../shared/qualification-authority.mjs";
import { defineQualificationTrustBaseLease } from "../shared/qualification-authority-contract.mjs";
import {
  SECRET_SPAN_FOUNDATION_ARTIFACTS,
  SECRET_SPAN_QUALIFICATION_VERSIONS
} from "./foundation-paths.mjs";

export const SECRET_SPAN_TRUST_BASE_LEASE = defineQualificationTrustBaseLease({
  leaseId: "secret-spans/foundation-trust-base",
  schemaVersion: SECRET_SPAN_QUALIFICATION_VERSIONS.trustBase,
  rootPackages: ["@babel/parser", "ajv"],
  packageDetail: "summary",
  nodeDetail: "complete",
  rootMetadataPaths: [],
  preserveRootMetadataOrder: false,
  includeAuthorityOwner: true,
  packageRootsDerivedInternally: false,
  receiptSchemaRelativePath: "verification/benchmarks/secret-spans/schemas/author-receipt.v3.schema.json",
  receiptTrustBaseJsonPointer: "/properties/trustBase",
  requiredUseCardinality: 1,
  environmentPolicy: {
    mode: "compiled-source-accesses",
    names: []
  },
  fieldInfluence: {
    "authority-contract": ["schemaVersion", "originClass", "authorityOwner", "lease"],
    "environment-compiler": ["environmentBindings"],
    "node-observation": ["node"],
    "package-closure": ["packages"],
    "portability-audit": ["portability"],
    "canonical-identity": ["trustBaseIdentity"]
  }
});

export function buildAuthorReceiptSnapshot() {
  const files = collectQualificationFileSnapshot(SECRET_SPAN_FOUNDATION_ARTIFACTS);
  const artifacts = Object.freeze(files.map(({ bytes: _bytes, ...record }) => Object.freeze(record)));
  const withoutIdentity = Object.freeze({
    schemaVersion: SECRET_SPAN_QUALIFICATION_VERSIONS.authorReceipt,
    status: "author-snapshot-unadmitted-external-pin-required",
    artifacts,
    trustBase: deriveQualificationTrustBase(SECRET_SPAN_TRUST_BASE_LEASE),
    claims: {
      resultSelfBindingUsed: false,
      serializedReceiptConfersAuthority: false,
      independentAcceptance: false,
      repositoryAdmission: false,
      runtimeQualification: false
    }
  });
  return Object.freeze({
    receipt: Object.freeze({ ...withoutIdentity, receiptIdentity: canonicalHash(withoutIdentity) }),
    files
  });
}

export function buildAuthorReceiptValue() {
  return buildAuthorReceiptSnapshot().receipt;
}
