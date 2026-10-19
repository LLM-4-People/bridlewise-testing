import { z } from "zod";

import { InputError } from "../../src/kernel/errors.ts";
import { canonicalHash, deepFreeze, type DeepReadonly } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY, ROOT_POLICY_HASH } from "../../src/kernel/root-policy.ts";
import type { SnapshotJsonValue, StructuralSnapshotLimits } from "../../src/kernel/safe-structural.ts";
import { SLICE_PROJECTION_PATHS, VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import {
  buildFoundationGenerationLockInternal,
  parseUntrustedFoundationGenerationLockBytesInternal,
  validateFoundationGenerationLockCandidateInternal,
  type FoundationGenerationLockProtocol,
} from "./foundation-cascade/generation-lock.ts";
import {
  compileFoundationPlanInternal,
  parseUntrustedFoundationPlanBytesInternal,
  validateInternallyIssuedFoundationPlanInternal,
  validateFoundationDagInternal,
  validateFoundationPlanCandidateInternal,
  type FoundationPlanProtocol,
} from "./foundation-cascade/plan.ts";

export const FOUNDATION_CASCADE_SCHEMA_VERSION = "bridlewise-foundation-cascade/v2" as const;
export const FOUNDATION_GENERATION_LOCK_SCHEMA_VERSION =
  "bridlewise-foundation-generation/v2" as const;
export const FOUNDATION_COMPILER_REVISION = "foundation-cascade-compiler/v2" as const;
export const FOUNDATION_GENERATION_LOCK_PATH =
  "traceability/generated/foundation-generation.json" as const;
const FOUNDATION_CODE_INTELLIGENCE_POLICY_LOCK_PATH =
  "docs/research/code-intelligence/policy-bundle-lock.v2.json" as const;
export const FOUNDATION_UTF8_ORDERING_RULE = "unsigned-utf8-byte-lexicographic/v1" as const;

const FOUNDATION_STRUCTURAL_LIMITS: StructuralSnapshotLimits = deepFreeze({
  maximumDepth: ROOT_POLICY.forensics.limits.maximumDepth,
  maximumNodes: ROOT_POLICY.forensics.limits.maximumNodes,
});
const FOUNDATION_MAXIMUM_CANDIDATE_BYTES =
  ROOT_POLICY.forensics.limits.maximumProjectionBytes;

type FoundationOutputAuthoritySource = Readonly<{
  id: string;
  path: string;
  dependencies: readonly string[];
  role: "generated-artifact" | "terminal-root";
}>;

const FOUNDATION_STAGE_REGISTRY_SOURCE = [
  {
    stage: "validate-authorities",
    ownerId: "foundation-authority-validation",
    dependsOn: [],
    expectedOutputs: [],
  },
  {
    stage: "generate-schemas",
    ownerId: "foundation-schema-projections",
    dependsOn: ["validate-authorities"],
    expectedOutputs: [
      {
        id: "configuration-document-schema",
        path: ROOT_POLICY.configuration.contract.generatedSchemaPath,
        dependencies: [],
        role: "generated-artifact",
      },
      {
        id: "requirements-schema",
        path: SLICE_PROJECTION_PATHS.requirementsSchemaArtifact,
        dependencies: [],
        role: "generated-artifact",
      },
    ],
  },
  {
    stage: "generate-code-intelligence-policy-lock",
    ownerId: "code-intelligence-policy",
    dependsOn: ["generate-schemas"],
    expectedOutputs: [{
      id: "code-intelligence-policy-lock",
      path: FOUNDATION_CODE_INTELLIGENCE_POLICY_LOCK_PATH,
      dependencies: [ROOT_POLICY.configuration.contract.generatedSchemaPath],
      role: "generated-artifact",
    }],
  },
  {
    stage: "generate-test-surface",
    ownerId: "test-surface",
    dependsOn: ["generate-code-intelligence-policy-lock"],
    expectedOutputs: [{
      id: "test-surface-dispositions",
      path: ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath,
      dependencies: [FOUNDATION_CODE_INTELLIGENCE_POLICY_LOCK_PATH],
      role: "generated-artifact",
    }],
  },
  {
    stage: "generate-test-inventory",
    ownerId: "test-inventory",
    dependsOn: ["generate-test-surface"],
    expectedOutputs: [{
      id: "test-inventory",
      path: VERIFICATION_PATHS.testInventory,
      dependencies: [ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath],
      role: "generated-artifact",
    }],
  },
  {
    stage: "generate-slice-projections",
    ownerId: "slice-projections",
    dependsOn: ["generate-test-inventory"],
    expectedOutputs: [
      {
        id: "slice-s2.4",
        path: SLICE_PROJECTION_PATHS.s24Trace,
        dependencies: [VERIFICATION_PATHS.testInventory, SLICE_PROJECTION_PATHS.requirementsSchemaArtifact],
        role: "generated-artifact",
      },
      {
        id: "slice-s2",
        path: SLICE_PROJECTION_PATHS.s2Trace,
        dependencies: [VERIFICATION_PATHS.testInventory, SLICE_PROJECTION_PATHS.requirementsSchemaArtifact],
        role: "generated-artifact",
      },
      {
        id: "slice-s3.1",
        path: SLICE_PROJECTION_PATHS.s31Trace,
        dependencies: [VERIFICATION_PATHS.testInventory],
        role: "generated-artifact",
      },
    ],
  },
  {
    stage: "build-generation-lock",
    ownerId: "foundation-cascade",
    dependsOn: ["generate-slice-projections"],
    expectedOutputs: [{
      id: "foundation-generation-lock",
      path: FOUNDATION_GENERATION_LOCK_PATH,
      dependencies: [SLICE_PROJECTION_PATHS.s24Trace, SLICE_PROJECTION_PATHS.s2Trace, SLICE_PROJECTION_PATHS.s31Trace],
      role: "terminal-root",
    }],
  },
  {
    stage: "generate-artifact-manifest",
    ownerId: "artifact-governance",
    dependsOn: ["build-generation-lock"],
    expectedOutputs: [{
      id: "artifact-manifest",
      path: ROOT_POLICY.artifactGovernance.canonicalInventory,
      dependencies: [SLICE_PROJECTION_PATHS.s24Trace, SLICE_PROJECTION_PATHS.s2Trace, SLICE_PROJECTION_PATHS.s31Trace],
      role: "terminal-root",
    }],
  },
  {
    stage: "publish-and-verify",
    ownerId: "foundation-transaction",
    dependsOn: ["generate-artifact-manifest"],
    expectedOutputs: [],
  },
] as const satisfies readonly Readonly<{
  stage: string;
  ownerId: string;
  dependsOn: readonly string[];
  expectedOutputs: readonly FoundationOutputAuthoritySource[];
}>[];

export type FoundationStage = typeof FOUNDATION_STAGE_REGISTRY_SOURCE[number]["stage"];

export type FoundationOutputAuthority = DeepReadonly<FoundationOutputAuthoritySource & {
  stage: FoundationStage;
  ownerId: string;
}>;

export type FoundationStageRegistration = DeepReadonly<{
  stage: FoundationStage;
  ordinal: number;
  ownerId: string;
  dependsOn: readonly FoundationStage[];
  expectedOutputs: readonly FoundationOutputAuthority[];
}>;

export const FOUNDATION_STAGE_REGISTRY: readonly FoundationStageRegistration[] = deepFreeze(
  FOUNDATION_STAGE_REGISTRY_SOURCE.map((registration, index) => ({
    stage: registration.stage,
    ordinal: index + 1,
    ownerId: registration.ownerId,
    dependsOn: registration.dependsOn,
    expectedOutputs: registration.expectedOutputs.map((output) => ({
      ...output,
      stage: registration.stage,
      ownerId: registration.ownerId,
    })),
  })),
);
const FOUNDATION_STAGE_ORDER: readonly FoundationStage[] = deepFreeze(
  FOUNDATION_STAGE_REGISTRY.map((registration) => registration.stage),
);
export const FOUNDATION_EXPECTED_OUTPUTS: readonly FoundationOutputAuthority[] = deepFreeze(
  FOUNDATION_STAGE_REGISTRY.flatMap((registration) => registration.expectedOutputs),
);
export const FOUNDATION_STAGE_REGISTRY_IDENTITY = canonicalHash(FOUNDATION_STAGE_REGISTRY);

const HASH_SCHEMA = z.string().regex(/^[0-9a-f]{64}$/u);
const STABLE_ID_SCHEMA = z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/u);
const NONEMPTY_SCHEMA = z.string().min(1);
const FOUNDATION_STAGE_SCHEMA = z.enum(FOUNDATION_STAGE_ORDER);
const FOUNDATION_BLOCKER_CODE_SCHEMA = z.enum([
  "foundation_snapshot_issuer_unavailable",
  "foundation_stage_executor_unavailable",
  "foundation_upstream_stage_unavailable",
]);

const FOUNDATION_BLOCKER_SCHEMA = z.strictObject({
  code: FOUNDATION_BLOCKER_CODE_SCHEMA,
  ownerId: STABLE_ID_SCHEMA,
  reason: NONEMPTY_SCHEMA,
  requiredCapabilities: z.array(STABLE_ID_SCHEMA).min(1),
});

const COMPILED_FOUNDATION_STAGE_SCHEMA = z.strictObject({
  stage: FOUNDATION_STAGE_SCHEMA,
  ordinal: z.number().int().positive(),
  ownerId: STABLE_ID_SCHEMA,
  dependsOn: z.array(FOUNDATION_STAGE_SCHEMA),
  disposition: z.enum(["blocked", "unavailable"]),
  blockers: z.array(FOUNDATION_BLOCKER_SCHEMA).min(1),
  outputs: z.tuple([]),
  stageIdentity: HASH_SCHEMA,
});

const FOUNDATION_PLAN_SCHEMA = z.strictObject({
  schemaVersion: z.literal(FOUNDATION_CASCADE_SCHEMA_VERSION),
  compilerRevision: z.literal(FOUNDATION_COMPILER_REVISION),
  stageRegistryIdentity: z.literal(FOUNDATION_STAGE_REGISTRY_IDENTITY),
  rootPolicyIdentity: z.literal(ROOT_POLICY_HASH),
  activationLockPath: z.literal(FOUNDATION_GENERATION_LOCK_PATH),
  artifactManifestPath: z.literal(ROOT_POLICY.artifactGovernance.canonicalInventory),
  compilationDisposition: z.literal("blocked"),
  stages: z.array(COMPILED_FOUNDATION_STAGE_SCHEMA).length(FOUNDATION_STAGE_REGISTRY.length),
  planIdentity: HASH_SCHEMA,
});

const LOCK_EXCLUSION_SCHEMA = z.discriminatedUnion("reason", [
  z.strictObject({
    path: z.literal(FOUNDATION_GENERATION_LOCK_PATH),
    reason: z.literal("activation-lock-self-excluded"),
  }),
  z.strictObject({
    path: z.literal(ROOT_POLICY.artifactGovernance.canonicalInventory),
    reason: z.literal("artifact-manifest-terminal-root-excluded"),
  }),
]);

const FOUNDATION_GENERATION_LOCK_CANDIDATE_SCHEMA = z.strictObject({
  schemaVersion: z.literal(FOUNDATION_GENERATION_LOCK_SCHEMA_VERSION),
  compilerRevision: z.literal(FOUNDATION_COMPILER_REVISION),
  planIdentity: HASH_SCHEMA,
  stageRegistryIdentity: z.literal(FOUNDATION_STAGE_REGISTRY_IDENTITY),
  completedStages: z.tuple([]),
  outputs: z.tuple([]),
  exclusions: z.array(LOCK_EXCLUSION_SCHEMA).length(2),
  orderingRule: z.literal(FOUNDATION_UTF8_ORDERING_RULE),
});

declare const TRUSTED_FOUNDATION_PLAN: unique symbol;

export type FoundationBlocker = DeepReadonly<z.infer<typeof FOUNDATION_BLOCKER_SCHEMA>>;
export type CompiledFoundationStage = DeepReadonly<z.infer<typeof COMPILED_FOUNDATION_STAGE_SCHEMA>>;
export type FoundationPlanCandidateDocument = DeepReadonly<z.infer<typeof FOUNDATION_PLAN_SCHEMA>>;
/** Nominally and runtime-issued by the private foundation plan issuer. */
export type FoundationPlan = FoundationPlanCandidateDocument & Readonly<{
  [TRUSTED_FOUNDATION_PLAN]: true;
}>;
/** Parsed bytes remain explicitly untrusted and cannot inhabit FoundationPlan. */
export type UntrustedFoundationPlanCandidate = DeepReadonly<{
  kind: "untrusted-foundation-plan-candidate";
  candidate: FoundationPlanCandidateDocument;
}>;
export type UntrustedFoundationGenerationLockCandidate = DeepReadonly<
  z.infer<typeof FOUNDATION_GENERATION_LOCK_CANDIDATE_SCHEMA>
>;

const PLAN_PROTOCOL: FoundationPlanProtocol = deepFreeze({
  schemaVersion: FOUNDATION_CASCADE_SCHEMA_VERSION,
  compilerRevision: FOUNDATION_COMPILER_REVISION,
  stageRegistryIdentity: FOUNDATION_STAGE_REGISTRY_IDENTITY,
  rootPolicyIdentity: ROOT_POLICY_HASH,
  activationLockPath: FOUNDATION_GENERATION_LOCK_PATH,
  artifactManifestPath: ROOT_POLICY.artifactGovernance.canonicalInventory,
  stageRegistry: FOUNDATION_STAGE_REGISTRY,
  structuralLimits: FOUNDATION_STRUCTURAL_LIMITS,
  maximumCandidateBytes: FOUNDATION_MAXIMUM_CANDIDATE_BYTES,
  parsePlan: (value: SnapshotJsonValue) => FOUNDATION_PLAN_SCHEMA.parse(value),
});

const GENERATION_LOCK_PROTOCOL: FoundationGenerationLockProtocol = deepFreeze({
  schemaVersion: FOUNDATION_GENERATION_LOCK_SCHEMA_VERSION,
  compilerRevision: FOUNDATION_COMPILER_REVISION,
  stageRegistryIdentity: FOUNDATION_STAGE_REGISTRY_IDENTITY,
  structuralLimits: FOUNDATION_STRUCTURAL_LIMITS,
  maximumCandidateBytes: FOUNDATION_MAXIMUM_CANDIDATE_BYTES,
  parseCandidate: (value: SnapshotJsonValue) => FOUNDATION_GENERATION_LOCK_CANDIDATE_SCHEMA.parse(value),
  compileExpectedPlan: () => compileFoundationPlanInternal(PLAN_PROTOCOL),
  validateIssuedPlan: (value: unknown) => validateInternallyIssuedFoundationPlanInternal(PLAN_PROTOCOL, value),
});

export function validateFoundationDag(...unexpectedArguments: never[]): void {
  assertNoArguments(unexpectedArguments, "foundation_dag_arguments_forbidden");
  validateFoundationDagInternal(PLAN_PROTOCOL);
}

export function compileFoundationPlan(...unexpectedArguments: never[]): FoundationPlan {
  assertNoArguments(unexpectedArguments, "foundation_compile_arguments_forbidden");
  return compileFoundationPlanInternal(PLAN_PROTOCOL);
}

export function parseUntrustedFoundationPlanBytes(
  bytes: Uint8Array,
): UntrustedFoundationPlanCandidate {
  return parseUntrustedFoundationPlanBytesInternal(PLAN_PROTOCOL, bytes);
}

export function validateFoundationPlanCandidate(candidate: unknown): FoundationPlan {
  return validateFoundationPlanCandidateInternal(PLAN_PROTOCOL, candidate);
}

export function buildFoundationGenerationLock(...unexpectedArguments: never[]): never {
  assertNoArguments(unexpectedArguments, "foundation_generation_lock_arguments_forbidden");
  return buildFoundationGenerationLockInternal(GENERATION_LOCK_PROTOCOL);
}

export function parseUntrustedFoundationGenerationLockBytes(
  bytes: Uint8Array,
): UntrustedFoundationGenerationLockCandidate {
  return parseUntrustedFoundationGenerationLockBytesInternal(GENERATION_LOCK_PROTOCOL, bytes);
}

export function validateFoundationGenerationLockCandidate(candidate: unknown): never {
  return validateFoundationGenerationLockCandidateInternal(GENERATION_LOCK_PROTOCOL, candidate);
}

function assertNoArguments(arguments_: readonly unknown[], code: string): void {
  if (arguments_.length !== 0) throw new InputError("This operation accepts no caller claims", code);
}
