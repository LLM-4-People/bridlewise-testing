import { canonicalJson } from "../../../src/kernel/integrity.ts";
import { compareUtf8Bytes, sameOrderedValues } from "../../../src/kernel/ordered.ts";
import type { SnapshotJsonValue, StructuralSnapshotLimits } from "../../../src/kernel/safe-structural.ts";

import type {
  FoundationPlan,
  UntrustedFoundationGenerationLockCandidate,
} from "../foundation-cascade.ts";
import { parseCandidateObject, parseCanonicalCandidateBytes } from "./candidate.ts";
import { fail } from "./shared.ts";

export type FoundationGenerationLockProtocol = Readonly<{
  schemaVersion: UntrustedFoundationGenerationLockCandidate["schemaVersion"];
  compilerRevision: UntrustedFoundationGenerationLockCandidate["compilerRevision"];
  stageRegistryIdentity: UntrustedFoundationGenerationLockCandidate["stageRegistryIdentity"];
  structuralLimits: StructuralSnapshotLimits;
  maximumCandidateBytes: number;
  parseCandidate: (value: SnapshotJsonValue) => UntrustedFoundationGenerationLockCandidate;
  compileExpectedPlan: () => FoundationPlan;
  validateIssuedPlan: (value: unknown) => FoundationPlan;
}>;

export function buildFoundationGenerationLockInternal(
  protocol: FoundationGenerationLockProtocol,
): never {
  const expectedPlan = protocol.validateIssuedPlan(protocol.compileExpectedPlan());
  if (expectedPlan.compilationDisposition !== "blocked") {
    fail("foundation_plan_disposition_invalid", "Foundation plan disposition is invalid");
  }
  fail(
    "foundation_generation_lock_unavailable",
    "Foundation generation lock construction is unavailable until every required executor and snapshot issuer is qualified",
  );
}

export function parseUntrustedFoundationGenerationLockBytesInternal(
  protocol: FoundationGenerationLockProtocol,
  bytes: unknown,
): UntrustedFoundationGenerationLockCandidate {
  return parseCanonicalCandidateBytes({
    structuralLimits: protocol.structuralLimits,
    maximumCandidateBytes: protocol.maximumCandidateBytes,
    parse: protocol.parseCandidate,
    codePrefix: "foundation_generation_lock_candidate",
    label: "Foundation generation lock candidate",
  }, bytes);
}

export function validateFoundationGenerationLockCandidateInternal(
  protocol: FoundationGenerationLockProtocol,
  candidate: unknown,
): never {
  const parsed = parseCandidateObject({
    structuralLimits: protocol.structuralLimits,
    parse: protocol.parseCandidate,
    codePrefix: "foundation_generation_lock_candidate",
    label: "Foundation generation lock candidate",
  }, candidate);
  const expectedPlan = protocol.validateIssuedPlan(protocol.compileExpectedPlan());
  if (parsed.planIdentity !== expectedPlan.planIdentity) {
    fail(
      "foundation_generation_lock_plan_mismatch",
      "Foundation generation lock candidate does not bind the internally derived plan",
    );
  }
  const expectedExclusions = [
    {
      path: expectedPlan.artifactManifestPath,
      reason: "artifact-manifest-terminal-root-excluded" as const,
    },
    {
      path: expectedPlan.activationLockPath,
      reason: "activation-lock-self-excluded" as const,
    },
  ].toSorted((left, right) => compareUtf8Bytes(left.path, right.path));
  if (canonicalJson(parsed.exclusions) !== canonicalJson(expectedExclusions) ||
    !sameOrderedValues(
      parsed.exclusions.map((entry) => entry.path),
      expectedExclusions.map((entry) => entry.path),
    )) {
    fail("foundation_generation_lock_exclusion_invalid", "Foundation generation lock exclusions are invalid");
  }
  fail(
    "foundation_generation_lock_unavailable",
    "Foundation generation lock validation is unavailable because no activation lock can yet be internally constructed",
  );
}
