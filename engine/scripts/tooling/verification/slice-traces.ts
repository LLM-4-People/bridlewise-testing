import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { z } from "zod";

import { loadTestInventory } from "../../test-inventory.ts";
import {
  CONTRACT_BUNDLE_HASH,
  CONTRACT_SCHEMA_ARTIFACT_VERSION,
  GENERATED_CONTRACT_SCHEMAS,
} from "../../../src/kernel/contracts.ts";
import {
  FORENSIC_SCHEMA_ARTIFACT_VERSION,
  FORENSIC_SCHEMA_BUNDLE_HASH,
  GENERATED_FORENSIC_SCHEMAS,
} from "../../../src/forensics/forensic-contracts.ts";
import { canonicalHash, canonicalJson, sha256 } from "../../../src/kernel/integrity.ts";
import { S2_OFFLINE_CONTRACT_HASH } from "../../../src/forensics/offline-contracts.ts";
import { S3_OFFLINE_FORENSIC_HASH, S3_OFFLINE_FORENSIC_IDENTITY } from "../../../src/forensics/offline-forensics.ts";
import {
  AUDIT_MATRIX_ANGLES,
  AUDIT_MATRIX_SCHEMA,
  AUDIT_MATRIX_STAGES,
  requirementRegistryIds,
  REQUIREMENTS_REGISTRY_FILE_SHA256,
  REQUIREMENTS_REGISTRY_IDENTITY_HASH,
  REQUIREMENTS_REGISTRY_SCHEMA_VERSION,
  REQUIREMENTS_REGISTRY_SCHEMA_HASH,
  REQUIREMENTS_REGISTRY_SOURCE_SHA256,
  type RequirementsRegistry,
} from "../../../src/kernel/requirements.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import { sameOrderedValues } from "../../../src/kernel/ordered.ts";
import {
  engineModuleSourceRelative,
  engineModuleSourceRelativeByNames,
} from "../../../src/shared/module-location.ts";
import { S2_OFFICIAL_FRAGMENT_MANIFEST_SCHEMA } from "../../verification/official-fragment-manifest.ts";
import { SLICE_PROJECTION_PATHS } from "../../verification/slice-projection-paths.ts";
import {
  parseS2ResearchManifestText,
  S2_RESEARCH_MANIFEST_PATH,
  S2_RESEARCH_SOURCE_SCHEMA,
  S31_SOURCE_MANIFEST_SCHEMA,
} from "../../verification/slice-source-contracts.ts";

const REQUIREMENTS_REGISTRY_REFERENCE_SCHEMA = z.strictObject({
  path: z.literal(SLICE_PROJECTION_PATHS.requirementsRegistry),
  schemaVersion: z.literal(REQUIREMENTS_REGISTRY_SCHEMA_VERSION),
  fileSha256: z.literal(REQUIREMENTS_REGISTRY_FILE_SHA256),
  identityHash: z.literal(REQUIREMENTS_REGISTRY_IDENTITY_HASH),
});

const S2_FIXTURE_SCHEMA = z.strictObject({
  path: z.string().regex(/^test\/fixtures\/s2\/[a-z0-9-]+\/[a-z0-9-]+\.json$/u),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

const S2_TRACE_SCHEMA = z.strictObject({
  schemaVersion: z.literal(1),
  slice: z.literal("S2.3"),
  name: z.literal("offline provider-neutral protocol contracts S2.3"),
  auditMatrix: AUDIT_MATRIX_SCHEMA,
  requirementsRegistry: REQUIREMENTS_REGISTRY_REFERENCE_SCHEMA,
  requirements: z.array(z.string().regex(/^REQ-[0-9]{3}$/u)).min(1),
  derivedControls: z.array(z.string().regex(/^DER-[0-9]{3}$/u)).min(1),
  supersedes: z.strictObject({
    commit: z.literal("61e4ef2066af7159224770b47014c67cc5089990"),
    reason: z.literal("S1.3 established the preflight-only trust boundary required before offline protocol contracts"),
  }),
  scope: z.strictObject({
    network: z.literal("disabled"),
    modelInvocation: z.literal("disabled"),
    toolExecution: z.literal("disabled"),
    transportExecution: z.literal("disabled"),
    cli: z.literal("exact-preflight-only"),
    harnessReady: z.literal(false),
  }),
  research: z.strictObject({
    accessedOn: z.literal("2026-07-11"),
    sources: z.array(S2_RESEARCH_SOURCE_SCHEMA).length(5),
    officialFragments: z.strictObject({
      path: z.literal(SLICE_PROJECTION_PATHS.s2OfficialManifest),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    }),
  }),
  contracts: z.strictObject({
    schemaDialect: z.literal("https://json-schema.org/draft/2020-12/schema"),
    contractBundleHash: z.string().regex(/^[0-9a-f]{64}$/u),
    offlineContractHash: z.string().regex(/^[0-9a-f]{64}$/u),
    artifact: z.strictObject({
      path: z.literal(SLICE_PROJECTION_PATHS.contractSchemaArtifact),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    }),
    protocols: z.tuple([
      z.literal("openai-responses"),
      z.literal("openai-chat-completions"),
      z.literal("mcp-2025-11-25"),
    ]),
  }),
  behaviors: z.array(z.strictObject({
    id: z.string().regex(/^S2-B0[1-7]$/u),
    name: z.string().min(1),
    testName: z.string().min(1),
    fixtures: z.array(S2_FIXTURE_SCHEMA).min(3),
  })).length(7),
  acceptance: z.strictObject({
    minimumDistinctFixturesPerBehavior: z.literal(3),
    serializedFixtureFormat: z.literal("json-containing-real-wire-shapes"),
    unknownRawMetadataForwarding: z.literal("forbidden"),
    responsesSequencePolicy: z.literal("strictly-increasing-unique-gaps-allowed"),
    responsesIndexPolicy: z.literal("nonnegative-identity-bound-unique-per-scope-gaps-allowed"),
    gapPolicyEvidence: z.literal("official event fields define sequence and index identity but do not require contiguity"),
    modelMayNotScoreItself: z.literal(true),
    candidateMustBeFrozenBeforeFinalHashAudit: z.literal(true),
  }),
});

type S2Trace = z.infer<typeof S2_TRACE_SCHEMA>;

const S24_TRACE_SCHEMA = z.strictObject({
  schemaVersion: z.literal(1),
  slice: z.literal("S2.4"),
  name: z.literal("canonical requirements registry and traceability enforcement"),
  auditMatrix: AUDIT_MATRIX_SCHEMA,
  supersedes: z.strictObject({
    commit: z.literal("d39eea91276cd5eb4f54968ded373ea9702ded9f"),
    reason: z.literal(
      "S2.3 established the offline contracts whose requirement links now resolve through one canonical registry",
    ),
  }),
  scope: z.strictObject({
    network: z.literal("disabled"),
    modelInvocation: z.literal("disabled"),
    toolExecution: z.literal("disabled"),
    transportExecution: z.literal("disabled"),
    mutableState: z.literal("disabled"),
    durableAudit: z.literal("disabled"),
    cli: z.literal("exact-preflight-only"),
    harnessReady: z.literal(false),
  }),
  requirementsRegistry: z.strictObject({
    path: z.literal(SLICE_PROJECTION_PATHS.requirementsRegistry),
    schemaVersion: z.literal(REQUIREMENTS_REGISTRY_SCHEMA_VERSION),
    fileSha256: z.literal(REQUIREMENTS_REGISTRY_FILE_SHA256),
    sourceArtifactSha256: z.literal(REQUIREMENTS_REGISTRY_SOURCE_SHA256),
    schemaHash: z.literal(REQUIREMENTS_REGISTRY_SCHEMA_HASH),
    identityHash: z.literal(REQUIREMENTS_REGISTRY_IDENTITY_HASH),
    schemaArtifact: z.strictObject({
      path: z.literal(SLICE_PROJECTION_PATHS.requirementsSchemaArtifact),
      sha256: z.literal("7af5c35d52bafeac122e977bb613447b411a0c1c5234c44163b9c68988122d68"),
    }),
  }),
  requirements: z.array(z.string().regex(/^REQ-[0-9]{3}$/u)).min(1),
  derivedControls: z.array(z.string().regex(/^DER-[0-9]{3}$/u)).min(1),
  behaviors: z.array(z.strictObject({
    id: z.string().regex(/^S2\.4-B0[1-5]$/u),
    name: z.string().min(1),
    testName: z.string().min(1),
    scenarios: z.array(z.string().regex(/^S2\.4-B0[1-5]-[A-Z0-9-]+$/u)).min(3),
  })).length(5),
  acceptance: z.strictObject({
    minimumDistinctScenariosPerBehavior: z.literal(3),
    futureRequirementPolicy: z.literal("explicitly-unassessed-may-remain-unlinked-to-implementation"),
    satisfiedClaimPolicy: z.literal(
      "implemented-requirements-require-authority-implementation-test-and-evidence-links",
    ),
    secretPolicy: z.literal("literal-secret-like-values-forbidden"),
    modelMayNotScoreItself: z.literal(true),
    candidateMustBeFrozenBeforeFinalHashAudit: z.literal(true),
  }),
});

type S24Trace = z.infer<typeof S24_TRACE_SCHEMA>;

const S31_TRACE_SCHEMA = z.strictObject({
  schemaVersion: z.literal(1),
  slice: z.literal("S3.1"),
  name: z.literal("pure offline forensic contracts and cryptographic primitives"),
  auditMatrix: AUDIT_MATRIX_SCHEMA,
  requirementsRegistry: REQUIREMENTS_REGISTRY_REFERENCE_SCHEMA,
  supersedes: z.strictObject({
    commit: z.literal("04b00b27e8c8b46ca98c180400df215151942d14"),
    reason: z.string().min(1),
  }),
  scope: z.strictObject({
    network: z.literal("disabled"),
    modelInvocation: z.literal("disabled"),
    toolExecution: z.literal("disabled"),
    processExecution: z.literal("disabled"),
    repositoryMutation: z.literal("disabled"),
    storage: z.literal("disabled"),
    durableAudit: z.literal("disabled"),
    forwarding: z.literal("disabled"),
    cli: z.literal("exact-preflight-only"),
    harnessReady: z.literal(false),
  }),
  requirements: z.tuple([
    z.literal("REQ-001"), z.literal("REQ-006"), z.literal("REQ-010"), z.literal("REQ-013"),
    z.literal("REQ-016"), z.literal("REQ-020"), z.literal("REQ-021"), z.literal("REQ-025"),
    z.literal("REQ-028"), z.literal("REQ-029"), z.literal("REQ-032"), z.literal("REQ-033"),
    z.literal("REQ-034"),
  ]),
  derivedControls: z.tuple([
    z.literal("DER-001"), z.literal("DER-003"), z.literal("DER-006"), z.literal("DER-007"),
    z.literal("DER-008"), z.literal("DER-010"), z.literal("DER-011"), z.literal("DER-018"),
    z.literal("DER-021"), z.literal("DER-022"), z.literal("DER-023"), z.literal("DER-025"),
  ]),
  research: z.strictObject({
    accessedOn: z.literal("2026-07-12"),
    manifest: z.strictObject({
      path: z.literal(SLICE_PROJECTION_PATHS.s31SourceManifest),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    }),
    primarySources: z.literal(10),
    licensedReferenceFragments: z.literal(4),
  }),
  contracts: z.strictObject({
    schemaDialect: z.literal("https://json-schema.org/draft/2020-12/schema"),
    canonicalization: z.literal("RFC8785-with-verified-erratum-7920"),
    schemaBundleHash: z.string().regex(/^[0-9a-f]{64}$/u),
    offlineForensicHash: z.string().regex(/^[0-9a-f]{64}$/u),
    artifact: z.strictObject({
      path: z.literal(SLICE_PROJECTION_PATHS.forensicSchemaArtifact),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    }),
  }),
  behaviors: z.array(z.strictObject({
    id: z.string().regex(/^S3\.1-B0[1-7]$/u),
    name: z.string().min(1),
    testName: z.string().min(1),
    scenarios: z.array(z.string().regex(/^S3\.1-B0[1-7]-[A-Z0-9-]+$/u)).min(3),
  })).length(7),
  acceptance: z.strictObject({
    minimumIndependentCausalScenariosPerBehavior: z.literal(3),
    syntheticCanariesOnly: z.literal(true),
    constantTimeMacAndDigestComparison: z.literal(true),
    rawKeysInSchemasProjectionsReceipts: z.literal("forbidden"),
    hostileBoundaryPolicy: z.literal("proxy-accessor-subclass-rejected-before-observation"),
    proxyTrapInvocationCount: z.literal(0),
    runtimeFaultMatrixDisposition: z.literal("deferred-until-storage-anchor-and-dispatch-authority-exist"),
    modelMayNotScoreItself: z.literal(true),
    candidateMustBeFrozenBeforeFinalHashAudit: z.literal(true),
  }),
});

type S31Trace = z.infer<typeof S31_TRACE_SCHEMA>;

export type SliceVerificationInput = Readonly<{
  root: string;
  paths: readonly string[];
  registry: RequirementsRegistry | undefined;
  violations: string[];
}>;

export function verifySliceTraces(input: SliceVerificationInput): readonly string[] {
  const references: string[] = [];
  verifyS2(input.root, input.paths, input.registry, input.violations, references);
  verifyS24(input.root, input.registry, input.violations, references);
  verifyS31(input.root, input.paths, input.registry, input.violations, references);
  return Object.freeze(references);
}

function verifyS2(
  root: string,
  paths: readonly string[],
  registry: RequirementsRegistry | undefined,
  violations: string[],
  references: string[],
): void {
  const value = parseJson(join(root, "traceability", "s2.json"), violations);
  const parsed = S2_TRACE_SCHEMA.safeParse(value);
  if (!parsed.success) {
    violations.push("s2-traceability-schema-or-value-invalid");
    return;
  }
  const trace = parsed.data;
  references.push(...trace.requirements, ...trace.derivedControls);
  verifyAuditMatrix(trace.auditMatrix, "s2", violations);
  if (registry) {
    verifyRequirementReferences(
      [...trace.requirements, ...trace.derivedControls],
      registry,
      "s2-trace",
      violations,
    );
  }
  verifyS2ResearchManifest(root, trace, violations);
  if (trace.contracts.contractBundleHash !== CONTRACT_BUNDLE_HASH ||
    trace.contracts.offlineContractHash !== S2_OFFLINE_CONTRACT_HASH ||
    trace.contracts.schemaDialect !== ROOT_POLICY.contracts.schemaDialect ||
    !sameOrderedValues(trace.contracts.protocols, ROOT_POLICY.contracts.protocolIds)) {
    violations.push("s2-contract-identity-mismatch");
  }
  verifyS2Artifact(root, trace, violations);
  verifyS2OfficialFragments(root, paths, trace, violations);
  verifyS2Fixtures(root, paths, trace, violations);
  const s2Sources = [
    "capability-negotiation.ts", "kernel/contracts.ts", "event-state.ts", "json-integrity.ts",
    "offline-contracts.ts", "protocol-projections.ts", "schema-subset.ts",
  ];
  // The slice's source set is a list of module NAMES; their LOCATIONS moved
  // in the fold, so each name is resolved to its current `src/`-relative path
  // by the module-location owner before joining against the root.
  for (const relativePath of engineModuleSourceRelativeByNames(s2Sources)) {
    const source = readFileSync(join(root, relativePath), "utf8");
    if (/\bcodex\b/iu.test(source)) violations.push(`s2-product-specific-source:${relativePath}`);
  }
}

function verifyS24(
  root: string,
  registry: RequirementsRegistry | undefined,
  violations: string[],
  references: string[],
): void {
  const value = parseJson(join(root, "traceability", "s2.4.json"), violations);
  const parsed = S24_TRACE_SCHEMA.safeParse(value);
  if (!parsed.success) {
    violations.push("s2.4-traceability-schema-or-value-invalid");
    return;
  }
  const trace: S24Trace = parsed.data;
  references.push(...trace.requirements, ...trace.derivedControls);
  verifyAuditMatrix(trace.auditMatrix, "s2.4", violations);
  if (registry) {
    verifyRequirementReferences(
      [...trace.requirements, ...trace.derivedControls],
      registry,
      "s2.4-trace",
      violations,
    );
  }
  const behaviorIds = trace.behaviors.map((behavior) => behavior.id);
  if (!sameOrderedValues(behaviorIds, ["S2.4-B01", "S2.4-B02", "S2.4-B03", "S2.4-B04", "S2.4-B05"])) {
    violations.push("s2.4-behavior-order-or-identity");
  }
  const scenarios = trace.behaviors.flatMap((behavior) => behavior.scenarios);
  if (new Set(scenarios).size !== scenarios.length ||
    trace.behaviors.some((behavior) => new Set(behavior.scenarios).size < 3)) {
    violations.push("s2.4-scenario-coverage-invalid");
  }
  try {
    const inventoryNames = new Set(loadTestInventory(root).tests.map((entry) => entry.name));
    if (trace.behaviors.some((behavior) => !inventoryNames.has(behavior.testName))) {
      violations.push("s2.4-test-inventory-link-missing");
    }
  } catch {
    violations.push("s2.4-test-inventory-unavailable");
  }
  if (trace.requirementsRegistry.fileSha256 !== REQUIREMENTS_REGISTRY_FILE_SHA256 ||
    trace.requirementsRegistry.sourceArtifactSha256 !== REQUIREMENTS_REGISTRY_SOURCE_SHA256 ||
    trace.requirementsRegistry.schemaHash !== REQUIREMENTS_REGISTRY_SCHEMA_HASH ||
    trace.requirementsRegistry.identityHash !== REQUIREMENTS_REGISTRY_IDENTITY_HASH) {
    violations.push("s2.4-registry-identity-mismatch");
  }
  if (ROOT_POLICY.configuration.documentSchemaVersion !== 3 ||
    ROOT_POLICY.receipts.preflightSchemaVersion !== 1 ||
    Object.values(ROOT_POLICY.capabilities).filter(Boolean).length !== 1 ||
    ROOT_POLICY.capabilities.preflight !== true) {
    violations.push("s2.4-authority-or-capability-regression");
  }
}

function verifyS31(
  root: string,
  paths: readonly string[],
  registry: RequirementsRegistry | undefined,
  violations: string[],
  references: string[],
): void {
  const parsedTrace = S31_TRACE_SCHEMA.safeParse(parseJson(join(root, "traceability", "s3.1.json"), violations));
  if (!parsedTrace.success) {
    violations.push("s3.1-traceability-schema-or-value-invalid");
    return;
  }
  const trace: S31Trace = parsedTrace.data;
  references.push(...trace.requirements, ...trace.derivedControls);
  verifyAuditMatrix(trace.auditMatrix, "s3.1", violations);
  if (registry) {
    verifyRequirementReferences(
      [...trace.requirements, ...trace.derivedControls],
      registry,
      "s3.1-trace",
      violations,
    );
  }
  const expectedBehaviorIds = ["S3.1-B01", "S3.1-B02", "S3.1-B03", "S3.1-B04", "S3.1-B05", "S3.1-B06", "S3.1-B07"];
  if (!sameOrderedValues(trace.behaviors.map((behavior) => behavior.id), expectedBehaviorIds) ||
    trace.behaviors.some((behavior) => new Set(behavior.scenarios).size !== behavior.scenarios.length)) {
    violations.push("s3.1-behavior-order-or-scenario-identity");
  }
  try {
    const inventoryNames = new Set(loadTestInventory(root).tests.map((entry) => entry.name));
    if (trace.behaviors.some((behavior) => !inventoryNames.has(behavior.testName))) {
      violations.push("s3.1-test-inventory-link-missing");
    }
  } catch {
    violations.push("s3.1-test-inventory-unavailable");
  }
  if (trace.contracts.schemaDialect !== ROOT_POLICY.forensics.schemaDialect ||
    trace.contracts.canonicalization !== ROOT_POLICY.forensics.canonicalization ||
    trace.contracts.schemaBundleHash !== FORENSIC_SCHEMA_BUNDLE_HASH ||
    trace.contracts.offlineForensicHash !== S3_OFFLINE_FORENSIC_HASH) {
    violations.push("s3.1-contract-identity-mismatch");
  }
  verifyS31Artifact(root, trace, violations);
  verifyS31Sources(root, paths, trace, violations);
  const propertyNames = declaredSchemaPropertyNames(GENERATED_FORENSIC_SCHEMAS);
  if (propertyNames.some((name) =>
    /(?:^|[-_])(key|secret)(?:$|[-_])/iu.test(name) || /(?:key|secret)(?:id|ref|handle|material)$/iu.test(name)
  )) {
    violations.push("s3.1-forbidden-key-property");
  }
  if (Object.values(ROOT_POLICY.capabilities).filter(Boolean).length !== 1 ||
    ROOT_POLICY.capabilities.preflight !== true ||
    S3_OFFLINE_FORENSIC_IDENTITY.effectsAuthorized ||
    S3_OFFLINE_FORENSIC_IDENTITY.durableAuditAvailable ||
    S3_OFFLINE_FORENSIC_IDENTITY.storageAvailable ||
    S3_OFFLINE_FORENSIC_IDENTITY.transportAvailable ||
    S3_OFFLINE_FORENSIC_IDENTITY.modelInvocationAvailable ||
    S3_OFFLINE_FORENSIC_IDENTITY.toolExecutionAvailable) {
    violations.push("s3.1-authority-or-capability-regression");
  }
  const configSource = readFileSync(join(root, engineModuleSourceRelative("kernel/config.ts")), "utf8");
  if (/forensic|ledger|encryption|hmac/iu.test(configSource)) violations.push("s3.1-config-surface-expanded");
  const s31Sources = [
    "forensic-contracts.ts", "forensic-crypto.ts", "forensic-normalization.ts", "forensic-projection.ts",
    "forensic-state.ts", "ledger-canonical.ts", "offline-forensics.ts", "safe-structural.ts",
  ];
  for (const relativePath of engineModuleSourceRelativeByNames(s31Sources)) {
    if (/\bcodex\b/iu.test(readFileSync(join(root, relativePath), "utf8"))) {
      violations.push(`s3.1-product-specific-source:${relativePath}`);
    }
  }
}

export function verifyAuditMatrix(
  matrix: z.infer<typeof AUDIT_MATRIX_SCHEMA>,
  slice: string,
  violations: string[],
): void {
  if (!sameOrderedValues(matrix.angles.map((entry) => entry.id), AUDIT_MATRIX_ANGLES) ||
    !sameOrderedValues(matrix.stages.map((entry) => entry.id), AUDIT_MATRIX_STAGES)) {
    violations.push(`audit-matrix-order-or-coverage:${slice}`);
  }
  for (const cell of [...matrix.angles, ...matrix.stages]) {
    const builderEvidence = new Set(cell.surfaceAssessments.builder.evidenceLinks);
    for (const [surface, assessment] of Object.entries(cell.surfaceAssessments)) {
      if ((assessment.applicability === "not-applicable") !== (assessment.outcome === "n/a")) {
        violations.push(`audit-matrix-applicability:${slice}:${cell.id}:${surface}`);
      }
      if (!ROOT_POLICY.universalPolicyArchitecture.auditMatrix.evidenceAdmission.available &&
        !ROOT_POLICY.universalPolicyArchitecture.auditMatrix.evidenceAdmission.draftSatisfactionAllowed &&
        assessment.outcome !== "unassessed") {
        violations.push(`audit-matrix-outcome-before-evidence-admission:${slice}:${cell.id}:${surface}`);
      }
      if (assessment.outcome !== "unassessed" && assessment.evidenceLinks.length === 0) {
        violations.push(`audit-matrix-evidence-missing:${slice}:${cell.id}:${surface}`);
      }
    }
    if (cell.surfaceAssessments.runtime.evidenceLinks.some((link) => builderEvidence.has(link))) {
      violations.push(`audit-matrix-cross-surface-evidence:${slice}:${cell.id}`);
    }
  }
  if (matrix.independentAudit.outcome !== "unassessed" && matrix.independentAudit.evidenceLinks.length === 0) {
    violations.push(`audit-matrix-independent-evidence-missing:${slice}`);
  }
  if (!ROOT_POLICY.universalPolicyArchitecture.auditMatrix.evidenceAdmission.available &&
    !ROOT_POLICY.universalPolicyArchitecture.auditMatrix.evidenceAdmission.draftSatisfactionAllowed &&
    matrix.independentAudit.outcome !== "unassessed") {
    violations.push(`audit-matrix-independent-outcome-before-evidence-admission:${slice}`);
  }
}

function verifyS31Artifact(root: string, trace: S31Trace, violations: string[]): void {
  const expected = {
    schemaVersion: FORENSIC_SCHEMA_ARTIFACT_VERSION,
    schemaBundleHash: FORENSIC_SCHEMA_BUNDLE_HASH,
    schemas: GENERATED_FORENSIC_SCHEMAS,
  };
  try {
    const bytes = readFileSync(join(root, trace.contracts.artifact.path));
    const artifact = JSON.parse(bytes.toString("utf8")) as unknown;
    if (bytes.toString("utf8") !== `${canonicalJson(expected)}\n` ||
      sha256(bytes) !== trace.contracts.artifact.sha256 ||
      canonicalHash(artifact) !== canonicalHash(expected)) {
      violations.push("s3.1-forensic-schema-artifact-drift");
    }
    if (Object.values(GENERATED_FORENSIC_SCHEMAS).some((schema) =>
      !isPlainObject(schema) || schema.$schema !== ROOT_POLICY.forensics.schemaDialect
    )) {
      violations.push("s3.1-forensic-schema-dialect");
    }
  } catch {
    violations.push("s3.1-forensic-schema-artifact-missing-or-invalid");
  }
}

/**
 * The on-disk files under an evidence folder that count as EVIDENCE — every
 * file except the folder's `README.md`. The verifier is deny-by-default: the
 * declared evidence set must equal the on-disk evidence set, so a vendored
 * file nobody declared (or a declared file that vanished) is drift. A
 * `README.md` is documentation of the set, never a member of it — excluding
 * it by name keeps the surface strict without forcing a prose file into a
 * digest manifest.
 */
function evidenceSurface(paths: readonly string[], folder: string): readonly string[] {
  return paths
    .filter((path) => path.startsWith(folder) && !path.endsWith("/README.md"))
    .toSorted();
}

function verifyS31Sources(
  root: string,
  paths: readonly string[],
  trace: S31Trace,
  violations: string[],
): void {
  let bytes: Buffer;
  let parsed;
  try {
    bytes = readFileSync(join(root, trace.research.manifest.path));
    parsed = S31_SOURCE_MANIFEST_SCHEMA.safeParse(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    violations.push("s3.1-source-manifest-missing-or-invalid");
    return;
  }
  if (!parsed.success || sha256(bytes) !== trace.research.manifest.sha256) {
    violations.push("s3.1-source-manifest-drift");
    return;
  }
  const reference = parsed.data.sources[9];
  const declared = new Set<string>([trace.research.manifest.path, reference.license.localPath]);
  verifyBoundedEvidenceFile(root, reference.license.localPath, reference.license.localSha256, undefined, violations);
  const fragmentIdentities = new Set<string>();
  for (const fragment of reference.fragments) {
    declared.add(fragment.localPath);
    fragmentIdentities.add(`${fragment.sourcePath}\0${fragment.fullSourceSha256}`);
    verifyBoundedEvidenceFile(root, fragment.localPath, fragment.localSha256, undefined, violations);
  }
  if (fragmentIdentities.size !== 4) violations.push("s3.1-reference-fragment-identity");
  const actual = evidenceSurface(paths, "traceability/sources/s3.1/");
  if (!sameOrderedValues([...declared].toSorted(), actual)) violations.push("s3.1-source-evidence-surface-drift");
}

function declaredSchemaPropertyNames(value: unknown, result: string[] = []): readonly string[] {
  if (value === null || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    for (const child of value) declaredSchemaPropertyNames(child, result);
    return result;
  }
  for (const [name, child] of Object.entries(value)) {
    if (name === "properties" && isPlainObject(child)) result.push(...Object.keys(child));
    declaredSchemaPropertyNames(child, result);
  }
  return result;
}

function verifyS2OfficialFragments(
  root: string,
  paths: readonly string[],
  trace: S2Trace,
  violations: string[],
): void {
  const manifestPath = join(root, trace.research.officialFragments.path);
  let bytes: Buffer;
  let value: unknown;
  try {
    bytes = readFileSync(manifestPath);
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    violations.push("s2-official-fragment-manifest-missing-or-invalid");
    return;
  }
  const parsed = S2_OFFICIAL_FRAGMENT_MANIFEST_SCHEMA.safeParse(value);
  if (!parsed.success || sha256(bytes) !== trace.research.officialFragments.sha256) {
    violations.push("s2-official-fragment-manifest-drift");
    return;
  }
  const declared = new Set<string>([trace.research.officialFragments.path, S2_RESEARCH_MANIFEST_PATH]);
  const researchById = new Map(trace.research.sources.map((source) => [source.id, source]));
  for (const source of parsed.data.sources) {
    const research = researchById.get(source.id);
    if (!research || research.url !== source.url || research.sha256 !== source.fullSourceSha256 ||
      !research.ref.includes(source.commit) || !source.license.url.includes(source.commit)) {
      violations.push(`s2-official-fragment-source-mismatch:${source.id}`);
    }
    declared.add(source.license.path);
    verifyBoundedEvidenceFile(root, source.license.path, source.license.sha256, undefined, violations);
    for (const fragment of source.fragments) {
      declared.add(fragment.path);
      verifyBoundedEvidenceFile(root, fragment.path, fragment.sha256, {
        start: fragment.startLine,
        end: fragment.endLine,
      }, violations);
    }
  }
  const actual = evidenceSurface(paths, "traceability/sources/s2/");
  if (!sameOrderedValues([...declared].toSorted(), actual)) violations.push("s2-official-fragment-surface-drift");
}

function verifyS2ResearchManifest(root: string, trace: S2Trace, violations: string[]): void {
  try {
    const manifest = parseS2ResearchManifestText(readFileSync(join(root, S2_RESEARCH_MANIFEST_PATH), "utf8"));
    if (canonicalHash(manifest.sources) !== canonicalHash(trace.research.sources) ||
      manifest.accessedOn !== trace.research.accessedOn) {
      violations.push("s2-research-source-evidence-mismatch");
    }
  } catch {
    violations.push("s2-research-source-manifest-missing-or-invalid");
  }
}

function verifyBoundedEvidenceFile(
  root: string,
  path: string,
  expectedHash: string,
  lines: Readonly<{ start: number; end: number }> | undefined,
  violations: string[],
): void {
  try {
    const bytes = readFileSync(join(root, path));
    if (bytes.length === 0 || bytes.length > 16_384 || sha256(bytes) !== expectedHash || /\bcodex\b/iu.test(bytes.toString("utf8"))) {
      violations.push(`s2-official-fragment-invalid:${path}`);
      return;
    }
    if (lines && (lines.end < lines.start ||
      bytes.toString("utf8").split("\n").length - 1 !== lines.end - lines.start + 1)) {
      violations.push(`s2-official-fragment-line-boundary:${path}`);
    }
  } catch {
    violations.push(`s2-official-fragment-missing:${path}`);
  }
}

function verifyS2Artifact(root: string, trace: S2Trace, violations: string[]): void {
  const path = join(root, trace.contracts.artifact.path);
  let bytes: Buffer;
  let artifact: unknown;
  try {
    bytes = readFileSync(path);
    artifact = JSON.parse(bytes.toString("utf8"));
  } catch {
    violations.push("s2-contract-artifact-missing-or-invalid");
    return;
  }
  const expected = {
    contractBundleHash: CONTRACT_BUNDLE_HASH,
    schemaVersion: CONTRACT_SCHEMA_ARTIFACT_VERSION,
    schemas: GENERATED_CONTRACT_SCHEMAS,
  };
  if (sha256(bytes) !== trace.contracts.artifact.sha256 ||
    canonicalHash(artifact) !== canonicalHash(expected)) {
    violations.push("s2-contract-artifact-drift");
  }
  if (!isPlainObject(artifact) || !isPlainObject(artifact.schemas) ||
    Object.values(artifact.schemas).some((schema) =>
      !isPlainObject(schema) || schema.$schema !== ROOT_POLICY.contracts.schemaDialect
    )) {
    violations.push("s2-contract-artifact-dialect");
  }
}

function verifyS2Fixtures(root: string, paths: readonly string[], trace: S2Trace, violations: string[]): void {
  const linkedPaths: string[] = [];
  const linkedHashes = new Set<string>();
  let inventoryNames: ReadonlySet<string> = new Set();
  try {
    inventoryNames = new Set(loadTestInventory(root).tests.map((entry) => entry.name));
  } catch {
    violations.push("s2-test-inventory-unavailable");
  }
  for (const [index, behavior] of trace.behaviors.entries()) {
    const expectedId = `S2-B${String(index + 1).padStart(2, "0")}`;
    if (behavior.id !== expectedId || !behavior.testName.startsWith(`${expectedId} `)) {
      violations.push(`s2-behavior-identity:${expectedId}`);
    }
    if (!inventoryNames.has(behavior.testName)) violations.push(`s2-behavior-test-missing:${expectedId}`);
    const behaviorHashes = new Set<string>();
    for (const fixture of behavior.fixtures) {
      linkedPaths.push(fixture.path);
      behaviorHashes.add(fixture.sha256);
      linkedHashes.add(fixture.sha256);
      const absolute = resolve(root, fixture.path);
      if (!absolute.startsWith(`${join(root, "test", "fixtures", "s2")}${sep}`)) {
        violations.push(`s2-fixture-path-invalid:${fixture.path}`);
        continue;
      }
      try {
        const bytes = readFileSync(absolute);
        if (sha256(bytes) !== fixture.sha256) violations.push(`s2-fixture-hash-mismatch:${fixture.path}`);
        const document: unknown = JSON.parse(bytes.toString("utf8"));
        if (!isPlainObject(document) || Object.keys(document).length === 0) {
          violations.push(`s2-fixture-empty-or-invalid:${fixture.path}`);
        }
      } catch {
        violations.push(`s2-fixture-missing-or-invalid:${fixture.path}`);
      }
    }
    if (behaviorHashes.size !== behavior.fixtures.length || behaviorHashes.size < 3) {
      violations.push(`s2-fixture-not-distinct:${expectedId}`);
    }
  }
  const actualPaths = paths.filter((path) => path.startsWith("test/fixtures/s2/") && path.endsWith(".json")).toSorted();
  if (!sameOrderedValues(linkedPaths.toSorted(), actualPaths) || linkedPaths.length !== linkedHashes.size) {
    violations.push("s2-fixture-surface-incomplete-or-duplicate");
  }
}

function verifyRequirementReferences(
  references: readonly string[],
  registry: RequirementsRegistry,
  source: string,
  violations: string[],
): void {
  const known = requirementRegistryIds(registry);
  if (new Set(references).size !== references.length) {
    violations.push(`requirements-registry-duplicate-trace-link:${source}`);
  }
  for (const reference of references) {
    if (!known.has(reference as never)) {
      violations.push(`requirements-registry-unknown-trace-link:${source}:${reference}`);
    }
  }
}

function parseJson(path: string, violations: string[]): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    violations.push(`json-missing-or-invalid:${path.split(sep).at(-1) ?? "unknown"}`);
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
