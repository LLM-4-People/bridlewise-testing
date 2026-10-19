import { canonicalHash, canonicalJson, deepFreeze } from "../../../src/kernel/integrity.ts";
import { compareUtf8Bytes, sameOrderedValues } from "../../../src/kernel/ordered.ts";
import type { SnapshotJsonValue, StructuralSnapshotLimits } from "../../../src/kernel/safe-structural.ts";

import type {
  CompiledFoundationStage,
  FoundationBlocker,
  FoundationPlan,
  FoundationPlanCandidateDocument,
  FoundationStage,
  FoundationStageRegistration,
  UntrustedFoundationPlanCandidate,
} from "../foundation-cascade.ts";
import { parseCandidateObject, parseCanonicalCandidateBytes } from "./candidate.ts";
import { assertUnique, fail } from "./shared.ts";

export type FoundationPlanProtocol = Readonly<{
  schemaVersion: FoundationPlanCandidateDocument["schemaVersion"];
  compilerRevision: FoundationPlanCandidateDocument["compilerRevision"];
  stageRegistryIdentity: FoundationPlanCandidateDocument["stageRegistryIdentity"];
  rootPolicyIdentity: FoundationPlanCandidateDocument["rootPolicyIdentity"];
  activationLockPath: FoundationPlanCandidateDocument["activationLockPath"];
  artifactManifestPath: FoundationPlanCandidateDocument["artifactManifestPath"];
  stageRegistry: readonly FoundationStageRegistration[];
  structuralLimits: StructuralSnapshotLimits;
  maximumCandidateBytes: number;
  parsePlan: (value: SnapshotJsonValue) => FoundationPlanCandidateDocument;
}>;

const TRUSTED_FOUNDATION_PLAN_IDENTITIES = new WeakMap<object, string>();
const PARSED_FOUNDATION_PLAN_CANDIDATES = new WeakMap<object, FoundationPlanCandidateDocument>();

export function validateFoundationDagInternal(protocol: FoundationPlanProtocol): void {
  assertUnique(protocol.stageRegistry.map((entry) => entry.stage), "foundation_stage_duplicate");
  assertUnique(protocol.stageRegistry.map((entry) => entry.ownerId), "foundation_stage_owner_duplicate");
  const byStage = new Map(protocol.stageRegistry.map((entry) => [entry.stage, entry]));
  const visiting = new Set<FoundationStage>();
  const visited = new Set<FoundationStage>();
  const visit = (stage: FoundationStage): void => {
    if (visiting.has(stage)) fail("foundation_stage_cycle", `Foundation stage cycle includes ${stage}`);
    if (visited.has(stage)) return;
    const registration = byStage.get(stage);
    if (!registration) fail("foundation_stage_unknown", `Foundation stage is unknown: ${stage}`);
    visiting.add(stage);
    for (const dependency of registration.dependsOn) visit(dependency);
    visiting.delete(stage);
    visited.add(stage);
  };
  for (const [index, registration] of protocol.stageRegistry.entries()) {
    if (registration.ordinal !== index + 1) {
      fail("foundation_stage_order_invalid", "Foundation stage order is invalid");
    }
    assertUnique(registration.dependsOn, "foundation_stage_dependency_duplicate");
    assertCanonicalOrder(registration.dependsOn, "foundation_stage_dependency_order_invalid");
    for (const dependency of registration.dependsOn) {
      const target = byStage.get(dependency);
      if (!target) fail("foundation_stage_dependency_unknown", `Foundation stage dependency is unknown: ${dependency}`);
      if (target.ordinal >= registration.ordinal) {
        fail("foundation_stage_dependency_order_invalid", `Foundation stage dependency is not upstream: ${registration.stage}`);
      }
    }
    assertCanonicalOrder(
      registration.expectedOutputs.map((output) => output.path),
      "foundation_stage_output_order_invalid",
    );
    visit(registration.stage);
  }
  validateOutputAuthority(protocol);
}

export function compileFoundationPlanInternal(protocol: FoundationPlanProtocol): FoundationPlan {
  validateFoundationDagInternal(protocol);
  const stages = protocol.stageRegistry.map((registration, index) => compileUnavailableStage(
    registration,
    index === 0 ? "blocked" : "unavailable",
  ));
  const payload = {
    schemaVersion: protocol.schemaVersion,
    compilerRevision: protocol.compilerRevision,
    stageRegistryIdentity: protocol.stageRegistryIdentity,
    rootPolicyIdentity: protocol.rootPolicyIdentity,
    activationLockPath: protocol.activationLockPath,
    artifactManifestPath: protocol.artifactManifestPath,
    compilationDisposition: "blocked" as const,
    stages,
  };
  return issueFoundationPlan(protocol.parsePlan({ ...payload, planIdentity: canonicalHash(payload) }));
}

export function parseUntrustedFoundationPlanBytesInternal(
  protocol: FoundationPlanProtocol,
  bytes: unknown,
): UntrustedFoundationPlanCandidate {
  const candidate = parseCanonicalCandidateBytes({
    structuralLimits: protocol.structuralLimits,
    maximumCandidateBytes: protocol.maximumCandidateBytes,
    parse: protocol.parsePlan,
    codePrefix: "foundation_plan_candidate",
    label: "Foundation plan candidate",
  }, bytes);
  const wrapper = deepFreeze({
    kind: "untrusted-foundation-plan-candidate" as const,
    candidate,
  });
  PARSED_FOUNDATION_PLAN_CANDIDATES.set(wrapper, candidate);
  return wrapper;
}

export function validateFoundationPlanCandidateInternal(
  protocol: FoundationPlanProtocol,
  candidate: unknown,
): FoundationPlan {
  const parsedCandidate = ((typeof candidate === "object" && candidate !== null)
    ? PARSED_FOUNDATION_PLAN_CANDIDATES.get(candidate)
    : undefined) ?? candidate;
  const parsed = parseCandidateObject({
    structuralLimits: protocol.structuralLimits,
    parse: protocol.parsePlan,
    codePrefix: "foundation_plan_candidate",
    label: "Foundation plan candidate",
  }, parsedCandidate);
  assertPlanSemantics(protocol, parsed);
  const expected = compileFoundationPlanInternal(protocol);
  if (canonicalJson(parsed) !== canonicalJson(expected)) {
    fail("foundation_plan_candidate_mismatch", "Foundation plan candidate does not match the internally derived plan");
  }
  return expected;
}

export function isInternallyIssuedFoundationPlanInternal(value: unknown): value is FoundationPlan {
  if (typeof value !== "object" || value === null) return false;
  const issuedIdentity = TRUSTED_FOUNDATION_PLAN_IDENTITIES.get(value);
  if (!issuedIdentity || !isRecursivelyFrozen(value)) return false;
  try {
    return canonicalHash(value) === issuedIdentity;
  } catch {
    return false;
  }
}

export function validateInternallyIssuedFoundationPlanInternal(
  protocol: FoundationPlanProtocol,
  value: unknown,
): FoundationPlan {
  if (!isInternallyIssuedFoundationPlanInternal(value)) {
    fail("foundation_plan_issuer_invalid", "Foundation plan was not issued by the private runtime issuer");
  }
  const parsed = parseCandidateObject({
    structuralLimits: protocol.structuralLimits,
    parse: protocol.parsePlan,
    codePrefix: "foundation_plan_issuer",
    label: "Internally issued foundation plan",
  }, value);
  assertPlanSemantics(protocol, parsed);
  const issuedIdentity = TRUSTED_FOUNDATION_PLAN_IDENTITIES.get(value);
  if (!issuedIdentity || canonicalHash(parsed) !== issuedIdentity || canonicalJson(parsed) !== canonicalJson(value)) {
    fail("foundation_plan_issuer_identity_invalid", "Foundation plan issuer identity is invalid");
  }
  return value;
}

function issueFoundationPlan(document: FoundationPlanCandidateDocument): FoundationPlan {
  const issued = deepFreeze(document) as FoundationPlan;
  TRUSTED_FOUNDATION_PLAN_IDENTITIES.set(issued, canonicalHash(issued));
  return issued;
}

function isRecursivelyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  for (const child of Object.values(value)) {
    if (!isRecursivelyFrozen(child, seen)) return false;
  }
  return true;
}

function compileUnavailableStage(
  registration: FoundationStageRegistration,
  disposition: "blocked" | "unavailable",
): CompiledFoundationStage {
  const blockers = stageBlockers(registration, disposition);
  const payload = {
    stage: registration.stage,
    ordinal: registration.ordinal,
    ownerId: registration.ownerId,
    dependsOn: registration.dependsOn,
    disposition,
    blockers,
    outputs: [] as const,
  };
  return deepFreeze({ ...payload, stageIdentity: canonicalHash(payload) });
}

function stageBlockers(
  registration: FoundationStageRegistration,
  disposition: "blocked" | "unavailable",
): readonly FoundationBlocker[] {
  const executorBlocker = {
    code: "foundation_stage_executor_unavailable" as const,
    ownerId: registration.ownerId,
    reason: `No qualified production executor is admitted for ${registration.stage}.`,
    requiredCapabilities: [`foundation-executor/${registration.stage}`],
  };
  if (disposition === "blocked") {
    return deepFreeze([{
      code: "foundation_snapshot_issuer_unavailable" as const,
      ownerId: "foundation-snapshot-issuer",
      reason: "No trusted foundation snapshot issuer is admitted.",
      requiredCapabilities: ["foundation-snapshot/trusted-issuer"],
    }, executorBlocker]);
  }
  return deepFreeze([executorBlocker, {
    code: "foundation_upstream_stage_unavailable" as const,
    ownerId: registration.ownerId,
    reason: `An upstream stage is unavailable for ${registration.stage}.`,
    requiredCapabilities: registration.dependsOn.map((stage) => `foundation-stage/${stage}`),
  }]);
}

function assertPlanSemantics(protocol: FoundationPlanProtocol, plan: FoundationPlanCandidateDocument): void {
  validateFoundationDagInternal(protocol);
  for (const [index, registration] of protocol.stageRegistry.entries()) {
    const stage = plan.stages[index];
    if (!stage || stage.stage !== registration.stage || stage.ordinal !== registration.ordinal ||
      stage.ownerId !== registration.ownerId || !sameOrderedValues(stage.dependsOn, registration.dependsOn) ||
      stage.outputs.length !== 0) {
      fail("foundation_plan_stage_invalid", `Foundation plan stage is invalid: ${registration.stage}`);
    }
    const expectedDisposition = index === 0 ? "blocked" : "unavailable";
    if (stage.disposition !== expectedDisposition ||
      canonicalJson(stage.blockers) !== canonicalJson(stageBlockers(registration, expectedDisposition))) {
      fail("foundation_plan_stage_disposition_invalid", `Foundation stage disposition is invalid: ${registration.stage}`);
    }
    const { stageIdentity: _stageIdentity, ...stagePayload } = stage;
    if (canonicalHash(stagePayload) !== stage.stageIdentity) {
      fail("foundation_plan_stage_identity_invalid", `Foundation stage identity is invalid: ${registration.stage}`);
    }
  }
  const { planIdentity: _planIdentity, ...planPayload } = plan;
  if (canonicalHash(planPayload) !== plan.planIdentity) {
    fail("foundation_plan_identity_invalid", "Foundation plan identity is invalid");
  }
}

function validateOutputAuthority(protocol: FoundationPlanProtocol): void {
  const outputs = protocol.stageRegistry.flatMap((registration) => registration.expectedOutputs);
  assertUnique(outputs.map((output) => output.id), "foundation_output_id_duplicate");
  assertUnique(outputs.map((output) => output.path), "foundation_output_path_duplicate");
  const byPath = new Map(outputs.map((output) => [output.path, output]));
  const stageOrdinal = new Map(protocol.stageRegistry.map((registration) => [
    registration.stage,
    registration.ordinal,
  ]));
  for (const output of outputs) {
    assertUnique(output.dependencies, "foundation_output_dependency_duplicate");
    assertCanonicalOrder(output.dependencies, "foundation_output_dependency_order_invalid");
    for (const dependency of output.dependencies) {
      const target = byPath.get(dependency);
      if (!target) fail("foundation_output_dependency_unknown", `Foundation output dependency is unknown: ${dependency}`);
      if (stageOrdinal.get(target.stage)! >= stageOrdinal.get(output.stage)!) {
        fail("foundation_output_dependency_order_invalid", `Foundation output dependency is not upstream: ${output.path}`);
      }
    }
  }
  const activation = outputs.filter((output) => output.path === protocol.activationLockPath);
  const artifact = outputs.filter((output) => output.path === protocol.artifactManifestPath);
  if (activation.length !== 1 || activation[0]!.role !== "terminal-root" ||
    artifact.length !== 1 || artifact[0]!.role !== "terminal-root") {
    fail("foundation_terminal_output_authority_invalid", "Foundation terminal output authority is invalid");
  }
  if (activation[0]!.dependencies.includes(protocol.artifactManifestPath) ||
    artifact[0]!.dependencies.includes(protocol.activationLockPath)) {
    fail("foundation_terminal_output_cycle", "Foundation terminal roots cannot depend on one another");
  }
}

function assertCanonicalOrder(values: readonly string[], code: string): void {
  if (!sameOrderedValues(values, [...values].toSorted(compareUtf8Bytes))) {
    fail(code, "Foundation values are not in canonical UTF-8 byte order");
  }
}
