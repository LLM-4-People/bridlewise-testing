import { canonicalHash } from "../../../src/kernel/integrity.ts";
import { relativePathViolationKinds } from "../../../src/filesystem/path-boundary.ts";

export const QUALIFICATION_AUTHORITY_OWNER =
  "verification/benchmarks/shared/qualification-authority.mjs";
export const QUALIFICATION_AUTHORITY_CONTRACT_SCHEMA_VERSION =
  "bridlewise-qualification-authority-contract/v5";
export const QUALIFICATION_AUTHORITY_INVENTORY_SCHEMA_VERSION =
  "bridlewise-qualification-authority-inventory/v5";

const SOURCE_ORIGIN_RULES = Object.freeze([
  Object.freeze({ prefix: "node_modules/", originClass: "installed-third-party" }),
  Object.freeze({ prefix: "traceability/evidence/", originClass: "evidence-snapshot" }),
  Object.freeze({ prefix: "traceability/sources/", originClass: "vendored-source" }),
  Object.freeze({ prefix: "test/", originClass: "first-party-nonproduction" }),
  Object.freeze({ prefix: "verification/benchmarks/", originClass: "first-party-nonproduction" }),
  Object.freeze({ prefix: "src/", originClass: "first-party-production" }),
  Object.freeze({ prefix: "scripts/", originClass: "first-party-production" }),
  Object.freeze({ prefix: "verification/core/", originClass: "first-party-production" }),
  Object.freeze({ prefix: "verification/oracles/", originClass: "first-party-production" })
]);

const SOURCE_DISPOSITIONS = Object.freeze({
  "first-party-production": Object.freeze({
    moduleDisposition: "executable-first-party-module",
    dispositionReason: "origin-policy-qualified-first-party-production"
  }),
  "first-party-nonproduction": Object.freeze({
    moduleDisposition: "executable-first-party-module",
    dispositionReason: "origin-policy-qualified-first-party-nonproduction"
  }),
  "installed-third-party": Object.freeze({
    moduleDisposition: "non-executable-carrier",
    dispositionReason: "installed-dependency-outside-first-party-module-graph"
  }),
  "evidence-snapshot": Object.freeze({
    moduleDisposition: "non-executable-carrier",
    dispositionReason: "immutable-evidence-carrier-not-a-repository-module"
  }),
  "vendored-source": Object.freeze({
    moduleDisposition: "non-executable-carrier",
    dispositionReason: "vendored-source-carrier-not-a-standalone-repository-module"
  }),
  "repository-auxiliary": Object.freeze({
    moduleDisposition: "non-executable-carrier",
    dispositionReason: "repository-auxiliary-outside-qualified-source-roots"
  })
});

const LEASE_KEYS = Object.freeze([
  "environmentPolicy",
  "fieldInfluence",
  "includeAuthorityOwner",
  "leaseId",
  "nodeDetail",
  "packageDetail",
  "packageRootsDerivedInternally",
  "preserveRootMetadataOrder",
  "receiptSchemaRelativePath",
  "receiptTrustBaseJsonPointer",
  "requiredUseCardinality",
  "rootMetadataPaths",
  "rootPackages",
  "schemaVersion"
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...keys].toSorted());
}

function portablePath(value) {
  return typeof value === "string" && value.normalize("NFC") === value &&
    relativePathViolationKinds(value).length === 0;
}

function uniqueStrings(value) {
  return Array.isArray(value) && new Set(value).size === value.length &&
    value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.normalize("NFC") === entry);
}

function nonemptyUniqueStrings(value) {
  return uniqueStrings(value) && value.length > 0;
}

function fieldInfluence(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length === 0) return false;
  const fields = [];
  for (const [category, members] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(category) || !nonemptyUniqueStrings(members)) return false;
    fields.push(...members);
  }
  return new Set(fields).size === fields.length;
}

export function defineQualificationTrustBaseLease(input) {
  if (!hasExactKeys(input, LEASE_KEYS) ||
    typeof input.leaseId !== "string" || !/^[a-z0-9][a-z0-9./-]*$/u.test(input.leaseId) ||
    typeof input.schemaVersion !== "string" ||
    !/^[a-z0-9][a-z0-9-]+-trust-base\/v[1-9][0-9]*$/u.test(input.schemaVersion) ||
    !nonemptyUniqueStrings(input.rootPackages) ||
    !["summary", "full"].includes(input.packageDetail) ||
    !["complete", "legacy"].includes(input.nodeDetail) ||
    !Array.isArray(input.rootMetadataPaths) || new Set(input.rootMetadataPaths).size !== input.rootMetadataPaths.length ||
    input.rootMetadataPaths.some((path) => !portablePath(path)) ||
    typeof input.preserveRootMetadataOrder !== "boolean" ||
    typeof input.includeAuthorityOwner !== "boolean" ||
    typeof input.packageRootsDerivedInternally !== "boolean" ||
    !portablePath(input.receiptSchemaRelativePath) ||
    typeof input.receiptTrustBaseJsonPointer !== "string" ||
    !/^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])+)*$/u.test(input.receiptTrustBaseJsonPointer) ||
    !Number.isSafeInteger(input.requiredUseCardinality) || input.requiredUseCardinality < 1 ||
    !hasExactKeys(input.environmentPolicy, ["mode", "names"]) ||
    input.environmentPolicy.mode !== "compiled-source-accesses" ||
    !uniqueStrings(input.environmentPolicy.names) ||
    !fieldInfluence(input.fieldInfluence)) {
    fail("qualification_trust_base_lease_invalid");
  }
  const withoutIdentity = Object.freeze({
    schemaVersion: QUALIFICATION_AUTHORITY_CONTRACT_SCHEMA_VERSION,
    leaseId: input.leaseId,
    trustBaseSchemaVersion: input.schemaVersion,
    rootPackages: Object.freeze([...input.rootPackages]),
    packageDetail: input.packageDetail,
    nodeDetail: input.nodeDetail,
    rootMetadataPaths: Object.freeze([...input.rootMetadataPaths]),
    preserveRootMetadataOrder: input.preserveRootMetadataOrder,
    includeAuthorityOwner: input.includeAuthorityOwner,
    packageRootsDerivedInternally: input.packageRootsDerivedInternally,
    receiptSchemaRelativePath: input.receiptSchemaRelativePath,
    receiptTrustBaseJsonPointer: input.receiptTrustBaseJsonPointer,
    requiredUseCardinality: input.requiredUseCardinality,
    environmentPolicy: Object.freeze({
      mode: input.environmentPolicy.mode,
      names: Object.freeze([...input.environmentPolicy.names])
    }),
    fieldInfluence: Object.freeze(Object.fromEntries(Object.entries(input.fieldInfluence).map(
      ([category, fields]) => [category, Object.freeze([...fields])]
    )))
  });
  return Object.freeze({
    ...withoutIdentity,
    leaseIdentity: canonicalHash(withoutIdentity)
  });
}

export function trustBaseDerivationOptions(lease) {
  if (lease?.schemaVersion !== QUALIFICATION_AUTHORITY_CONTRACT_SCHEMA_VERSION ||
    lease.leaseIdentity !== canonicalHash(Object.fromEntries(
      Object.entries(lease).filter(([key]) => key !== "leaseIdentity")
    ))) {
    fail("qualification_trust_base_lease_identity_invalid");
  }
  return Object.freeze({
    schemaVersion: lease.trustBaseSchemaVersion,
    rootPackages: lease.rootPackages,
    packageDetail: lease.packageDetail,
    nodeDetail: lease.nodeDetail,
    rootMetadataPaths: lease.rootMetadataPaths,
    preserveRootMetadataOrder: lease.preserveRootMetadataOrder,
    includeAuthorityOwner: lease.includeAuthorityOwner,
    packageRootsDerivedInternally: lease.packageRootsDerivedInternally,
    lease: Object.freeze({
      leaseId: lease.leaseId,
      leaseIdentity: lease.leaseIdentity,
      requiredUseCardinality: lease.requiredUseCardinality,
      environmentPolicy: lease.environmentPolicy
    })
  });
}

export function classifyQualificationSourceOrigin(relativePath) {
  if (!portablePath(relativePath)) fail("qualification_source_origin_path_invalid");
  return SOURCE_ORIGIN_RULES.find((rule) => relativePath.startsWith(rule.prefix))?.originClass ??
    "repository-auxiliary";
}

export function qualifyQualificationSourceCarrier(relativePath) {
  const originClass = classifyQualificationSourceOrigin(relativePath);
  const disposition = SOURCE_DISPOSITIONS[originClass];
  if (disposition === undefined) fail("qualification_source_origin_unclassified");
  return Object.freeze({ originClass, ...disposition });
}
