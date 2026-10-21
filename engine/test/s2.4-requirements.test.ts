import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { InputError } from "../src/kernel/errors.ts";
import { canonicalHash, sha256 } from "../src/kernel/integrity.ts";
import {
  S2_OFFLINE_CONTRACT_HASH,
  S2_OFFLINE_CONTRACT_IDENTITY,
} from "../src/forensics/offline-contracts.ts";
import { createPreflightContext } from "../src/kernel/preflight.ts";
import {
  parseRequirementsRegistryText,
  requirementApplicabilityProjection,
  requirementRegistryIds,
  REQUIREMENTS_REGISTRY_FILE_SHA256,
  REQUIREMENTS_REGISTRY_IDENTITY_HASH,
  REQUIREMENTS_REGISTRY_SCHEMA_HASH,
  REQUIREMENTS_REGISTRY_SCHEMA_VERSION,
  REQUIREMENTS_REGISTRY_SOURCE_SHA256,
  requirementsRootBindingViolations,
  requirementsRegistryViolations,
} from "../src/kernel/requirements.ts";
import { ROOT_POLICY, ROOT_POLICY_HASH } from "../src/kernel/root-policy.ts";

const REGISTRY_PATH = new URL("../traceability/requirements.json", import.meta.url);
const SCHEMA_ARTIFACT_PATH = new URL("../traceability/s2.4-requirements-schema.json", import.meta.url);
const REGISTRY_TEXT = readFileSync(REGISTRY_PATH, "utf8");
const REGISTRY = parseRequirementsRegistryText(REGISTRY_TEXT);

type MutableRequirement = {
  id: string;
  status: string;
  intent: string;
  implementationLinks: string[];
  configOrInvariantLinks: string[];
  testLinks: string[];
  evidenceLinks: string[];
  surfaceAssessments: MutableSurfaces;
  provenance: { sourceArtifactSha256: string; sourcePointer: string; sourceLine: number };
};

type MutableControl = {
  id: string;
  status: string;
  boundRequirements: string[];
  derivedControlDependencies: string[];
  controlStatements: string[];
  implementationLinks: string[];
  testLinks: string[];
  evidenceLinks: string[];
  surfaceAssessments: MutableSurfaces;
  provenance: { sourceArtifactSha256: string; sourcePointer: string; sourceStartLine: number; sourceEndLine: number };
};

type MutableAssessment = {
  subjectRealm: string;
  executionBoundary: string;
  applicability: string;
  outcome: string;
  reason: string;
  evidenceLinks: string[];
};

type MutableSurfaces = { builder: MutableAssessment; runtime: MutableAssessment };

type MutableRegistry = {
  sourceArtifact: { sha256: string };
  rowSetIntegrityHistory: Record<string, string>;
  counts: {
    userStatements: number;
    requirements: number;
    derivedControls: number;
    openDecisions: number;
    globalAcceptanceGates: number;
  };
  userStatements: Array<{
    id: string;
    secretFreeNormalizedStatement: string;
    boundRequirements: string[];
    surfaceAssessments: MutableSurfaces;
    provenance: { sourceArtifactSha256: string; sourceLine: number };
  }>;
  requirements: MutableRequirement[];
  derivedControls: MutableControl[];
  globalAcceptanceGates: Array<{ sourceLine: number; statement: string; surfaceAssessments: MutableSurfaces }>;
};

function mutableRegistry(): MutableRegistry {
  return structuredClone(REGISTRY) as unknown as MutableRegistry;
}

function hasViolation(value: unknown, prefix: string): boolean {
  return requirementsRegistryViolations(value).some((violation) => violation.startsWith(prefix));
}

test("S2.4-B01 registry bytes, source lineage, row hashes, and schema artifact are bound", () => {
  assert.equal(sha256(REGISTRY_TEXT), REQUIREMENTS_REGISTRY_FILE_SHA256);
  assert.equal(REGISTRY.sourceArtifact.sha256, REQUIREMENTS_REGISTRY_SOURCE_SHA256);
  assert.equal(requirementsRegistryViolations(REGISTRY).length, 0);
  assert.equal(
    sha256(readFileSync(SCHEMA_ARTIFACT_PATH)),
    "7af5c35d52bafeac122e977bb613447b411a0c1c5234c44163b9c68988122d68",
  );

  const sourceDrift = mutableRegistry();
  sourceDrift.sourceArtifact.sha256 = "0".repeat(64);
  assert.equal(hasViolation(sourceDrift, "requirements_registry_source_hash_drift"), true);

  const rowDrift = mutableRegistry();
  rowDrift.rowSetIntegrityHistory.req001Through035Sha256 = "1".repeat(64);
  assert.equal(hasViolation(rowDrift, "requirements_registry_row_hash_drift"), true);

  const alignmentStatement = REGISTRY.userStatements.filter((entry) => entry.id === "USR-049");
  const alignmentControl = REGISTRY.derivedControls.filter((entry) => entry.id === "DER-036");
  assert.equal(alignmentStatement.length, 1);
  assert.equal(alignmentControl.length, 1);
  assert.doesNotMatch(alignmentStatement[0]!.secretFreeNormalizedStatement,
    /\b(?:twice|second\s+(?:message|reaffirmation)|both\s+source\s+events|two\s+reaffirmations?|[0-9]+\s+reaffirmations?)\b/iu);
  for (const sourceEventCount of [1, 2, 5]) {
    const distinctRuntimeSourceEvents = Array.from(
      { length: sourceEventCount },
      (_, index) => `alignment-reaffirmation-event-${index + 1}`,
    );
    const semanticUserIds = [...new Set(distinctRuntimeSourceEvents.map(() => "USR-049"))];
    const semanticControlIds = [...new Set(distinctRuntimeSourceEvents.map(() => "DER-036"))];
    assert.equal(new Set(distinctRuntimeSourceEvents).size, sourceEventCount);
    assert.deepEqual(semanticUserIds, ["USR-049"]);
    assert.deepEqual(semanticControlIds, ["DER-036"]);
  }
  const countSpecificAlignment = mutableRegistry();
  countSpecificAlignment.userStatements.find((entry) => entry.id === "USR-049")!
    .secretFreeNormalizedStatement = "The user reaffirmed the same semantic intent twice; both source events map to one row.";
  assert.equal(hasViolation(countSpecificAlignment,
    "requirements_registry_alignment_reaffirmation_projection_drift"), true);
  const duplicateAlignmentAuthority = mutableRegistry();
  duplicateAlignmentAuthority.userStatements.push({
    ...duplicateAlignmentAuthority.userStatements.find((entry) => entry.id === "USR-049")!,
  });
  assert.equal(hasViolation(duplicateAlignmentAuthority,
    "requirements_registry_alignment_reaffirmation_projection_drift"), true);

  assert.deepEqual(REGISTRY.counts, {
    userStatements: 57,
    requirements: 35,
    derivedControls: 43,
    openDecisions: 1,
    globalAcceptanceGates: 42,
  });
  const countDrift = mutableRegistry();
  countDrift.counts.requirements += 1;
  assert.equal(hasViolation(countDrift, "requirements_registry_count_drift"), true);

  const baseRequirement = REGISTRY.requirements.find((entry) => entry.id === "REQ-031")!;
  const firstAppendRequirement = REGISTRY.requirements.find((entry) => entry.id === "REQ-032")!;
  const prior034Requirement = REGISTRY.requirements.find((entry) => entry.id === "REQ-034")!;
  const currentRequirement = REGISTRY.requirements.find((entry) => entry.id === "REQ-035")!;
  assert.notEqual(baseRequirement.provenance.sourceArtifactSha256,
    firstAppendRequirement.provenance.sourceArtifactSha256);
  assert.notEqual(firstAppendRequirement.provenance.sourceArtifactSha256,
    prior034Requirement.provenance.sourceArtifactSha256);
  assert.notEqual(prior034Requirement.provenance.sourceArtifactSha256,
    currentRequirement.provenance.sourceArtifactSha256);
  const priorUser = REGISTRY.userStatements.find((entry) => entry.id === "USR-056")!;
  const latestUser = REGISTRY.userStatements.find((entry) => entry.id === "USR-057")!;
  const latestControl = REGISTRY.derivedControls.find((entry) => entry.id === "DER-043")!;
  assert.equal(latestUser.provenance.sourceArtifactSha256, REQUIREMENTS_REGISTRY_SOURCE_SHA256);
  assert.equal(latestControl.provenance.sourceArtifactSha256, REQUIREMENTS_REGISTRY_SOURCE_SHA256);
  assert.notEqual(priorUser.provenance.sourceArtifactSha256, latestUser.provenance.sourceArtifactSha256);
  assert.equal(REGISTRY.userStatements.filter((entry) => entry.id === "USR-057").length, 1);
  assert.ok(latestControl.derivedControlDependencies.includes("DER-010"));
  assert.ok(latestControl.derivedControlDependencies.includes("DER-007"));
  assert.ok(latestControl.derivedControlDependencies.includes("DER-027"));
  assert.ok(latestControl.derivedControlDependencies.includes("DER-018"));
  assert.ok(latestControl.derivedControlDependencies.includes("DER-038"));
  assert.equal(REGISTRY.derivedControls.find((entry) => entry.id === "DER-041")!
    .provenance.sourceArtifactSha256,
    REGISTRY.userStatements.find((entry) => entry.id === "USR-055")!.provenance.sourceArtifactSha256);
  assert.equal(REGISTRY.derivedControls.find((entry) => entry.id === "DER-042")!
    .provenance.sourceArtifactSha256, priorUser.provenance.sourceArtifactSha256);
  assert.ok(REGISTRY.derivedControls.find((entry) => entry.id === "DER-034")!
    .boundRequirements.includes("REQ-003"));
  assert.equal(
    REGISTRY.derivedControls.find((entry) => entry.id === "DER-028")!.provenance.sourceArtifactSha256,
    REGISTRY.userStatements.find((entry) => entry.id === "USR-046")!.provenance.sourceArtifactSha256,
  );

  const shiftedUser = mutableRegistry();
  shiftedUser.userStatements.find((entry) => entry.id === "USR-057")!.provenance.sourceLine = 1_588;
  assert.equal(hasViolation(shiftedUser, "requirements_registry_provenance_invalid:USR-057"), true);
  const shiftedControl = mutableRegistry();
  const currentControl = shiftedControl.derivedControls.find((entry) => entry.id === "DER-043")!;
  currentControl.provenance.sourceStartLine = 1_607;
  currentControl.provenance.sourceEndLine = 1_615;
  assert.equal(hasViolation(shiftedControl, "requirements_registry_provenance_invalid:DER-043"), true);
  const shiftedGate = mutableRegistry();
  shiftedGate.globalAcceptanceGates[41]!.sourceLine = 1_617;
  assert.equal(hasViolation(shiftedGate, "requirements_registry_acceptance_provenance_invalid:GATE-42"), true);
  const falseGatePass = mutableRegistry();
  falseGatePass.globalAcceptanceGates[41]!.surfaceAssessments.builder.outcome = "pass";
  falseGatePass.globalAcceptanceGates[41]!.surfaceAssessments.builder.evidenceLinks = ["fabricated://evidence"];
  assert.equal(hasViolation(falseGatePass, "requirements_registry_false_gate_satisfied:GATE-42"), true);

  for (const mutate of [
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-038")!.boundRequirements =
        value.derivedControls.find((entry) => entry.id === "DER-038")!.boundRequirements
          .filter((id) => id !== "REQ-035");
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-038")!.derivedControlDependencies =
        value.derivedControls.find((entry) => entry.id === "DER-038")!.derivedControlDependencies
          .filter((id) => id !== "DER-031");
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-038")!.derivedControlDependencies =
        value.derivedControls.find((entry) => entry.id === "DER-038")!.derivedControlDependencies
          .filter((id) => id !== "DER-036");
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-038")!.derivedControlDependencies =
        value.derivedControls.find((entry) => entry.id === "DER-038")!.derivedControlDependencies
          .filter((id) => id !== "DER-037");
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-038")!.boundRequirements =
        value.derivedControls.find((entry) => entry.id === "DER-038")!.boundRequirements
          .filter((id) => id !== "REQ-015" && id !== "REQ-023");
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-038")!.controlStatements[1] =
        "The affected agent may extend and approve its own test exception.";
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-038")!.controlStatements[2] =
        "AI review may replace unavailable analyzers.";
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-038")!.controlStatements[3] =
        "One expected example is enough to prove universal applicability.";
    },
    (value: MutableRegistry) => {
      value.userStatements.find((entry) => entry.id === "USR-051")!.secretFreeNormalizedStatement =
        "Temporary shortcuts may remain in final artifacts.";
    },
    (value: MutableRegistry) => {
      value.userStatements.find((entry) => entry.id === "USR-052")!.secretFreeNormalizedStatement =
        "Examples apply only to the named file.";
    },
    (value: MutableRegistry) => {
      value.globalAcceptanceGates[36]!.statement = "Post-write model review is sufficient.";
    },
  ]) {
    const weakened = mutableRegistry();
    mutate(weakened);
    assert.equal(hasViolation(weakened, "requirements_registry_prior_052_projection_drift"), true);
  }

  for (const mutate of [
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-039")!.boundRequirements =
        value.derivedControls.find((entry) => entry.id === "DER-039")!.boundRequirements
          .filter((id) => id !== "REQ-021");
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-039")!.derivedControlDependencies =
        value.derivedControls.find((entry) => entry.id === "DER-039")!.derivedControlDependencies
          .filter((id) => !["DER-026", "DER-033", "DER-036", "DER-038"].includes(id));
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-039")!.controlStatements[0] =
        "A generated summary file may override stale canonical facts.";
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-039")!.controlStatements[1] =
        "Agents may receive locally summarized views without ordered deltas.";
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-039")!.controlStatements[2] =
        "Wrong repositories, partial inventories and stale tool health may continue until refresh.";
    },
    (value: MutableRegistry) => {
      value.userStatements.find((entry) => entry.id === "USR-053")!.secretFreeNormalizedStatement =
        "Trust as the generated project authority.";
    },
    (value: MutableRegistry) => {
      value.globalAcceptanceGates[37]!.statement =
        "A best-effort startup summary may be stale and need not bind exact inputs.";
    },
  ]) {
    const weakened = mutableRegistry();
    mutate(weakened);
    assert.equal(hasViolation(weakened, "requirements_registry_prior_053_projection_drift"), true);
  }

  for (const mutate of [
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-040")!.boundRequirements =
        value.derivedControls.find((entry) => entry.id === "DER-040")!.boundRequirements
          .filter((id) => id !== "REQ-024");
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-040")!.derivedControlDependencies =
        value.derivedControls.find((entry) => entry.id === "DER-040")!.derivedControlDependencies
          .filter((id) => !["DER-027", "DER-036", "DER-039"].includes(id));
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-040")!.controlStatements[1] =
        "The CLI may block all conversation while a command runs.";
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-040")!.controlStatements[2] =
        "Semantic similarity may construct and authorize an ambient shell command.";
    },
    (value: MutableRegistry) => {
      value.userStatements.find((entry) => entry.id === "USR-054")!.secretFreeNormalizedStatement =
        "A successful semantic match grants command authority.";
    },
    (value: MutableRegistry) => {
      value.globalAcceptanceGates[38]!.statement =
        "A blocking CLI and best-effort shell command are acceptable.";
    },
  ]) {
    const weakened = mutableRegistry();
    mutate(weakened);
    assert.equal(hasViolation(weakened, "requirements_registry_prior_054_projection_drift"), true);
  }

  for (const mutate of [
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-041")!.boundRequirements =
        value.derivedControls.find((entry) => entry.id === "DER-041")!.boundRequirements
          .filter((id) => id !== "REQ-025");
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-041")!.derivedControlDependencies =
        value.derivedControls.find((entry) => entry.id === "DER-041")!.derivedControlDependencies
          .filter((id) => !["DER-001", "DER-004", "DER-008", "DER-040"].includes(id));
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-041")!.controlStatements[1] =
        "Reject every credential-bearing text file or forward its raw values.";
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-041")!.controlStatements[2] =
        "A semantic score may authorize and expose repository bytes without exact reread.";
    },
    (value: MutableRegistry) => {
      value.userStatements.find((entry) => entry.id === "USR-055")!.secretFreeNormalizedStatement =
        "Unbounded pattern search may expose raw credential values.";
    },
    (value: MutableRegistry) => {
      value.globalAcceptanceGates[39]!.statement =
        "Credential-bearing files may be rejected and semantic results need no exact reread.";
    },
  ]) {
    const weakened = mutableRegistry();
    mutate(weakened);
    assert.equal(hasViolation(weakened, "requirements_registry_prior_055_projection_drift"), true);
  }

  for (const mutate of [
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-042")!.boundRequirements =
        value.derivedControls.find((entry) => entry.id === "DER-042")!.boundRequirements
          .filter((id) => id !== "REQ-015");
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-042")!.derivedControlDependencies =
        value.derivedControls.find((entry) => entry.id === "DER-042")!.derivedControlDependencies
          .filter((id) => !["DER-026", "DER-028", "DER-036", "DER-038"].includes(id));
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-042")!.controlStatements[0] =
        "Start destructive full compactions at a fixed fifty-percent threshold for every model.";
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-042")!.controlStatements[1] =
        "Executable source may live under docs and arbitrary line counts decide module quality.";
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-042")!.controlStatements[2] =
        "The scaffold guarantees small-model parity and broad work need not be delegated.";
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-042")!.controlStatements[3] =
        "Targeted tests permit prior green results to carry forward without promotion replay.";
    },
    (value: MutableRegistry) => {
      value.userStatements.find((entry) => entry.id === "USR-056")!.secretFreeNormalizedStatement =
        "Use a fixed context threshold, executable docs, promised parity and partial replay.";
    },
    (value: MutableRegistry) => {
      value.globalAcceptanceGates[40]!.statement =
        "A fixed threshold and targeted tests are sufficient for acceptance.";
    },
  ]) {
    const weakened = mutableRegistry();
    mutate(weakened);
    assert.equal(hasViolation(weakened, "requirements_registry_prior_056_projection_drift"), true);
  }

  for (const mutate of [
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-043")!.boundRequirements =
        value.derivedControls.find((entry) => entry.id === "DER-043")!.boundRequirements
          .filter((id) => id !== "REQ-029");
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-043")!.derivedControlDependencies =
        value.derivedControls.find((entry) => entry.id === "DER-043")!.derivedControlDependencies
          .filter((id) => !["DER-007", "DER-016", "DER-027", "DER-038"].includes(id));
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-043")!.controlStatements[0] =
        "A stale or incomplete function manifest is acceptable for performance claims.";
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-043")!.controlStatements[1] =
        "Exact attribution is allowed for shared resources without isolation evidence.";
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-043")!.controlStatements[2] =
        "A second configuration authority may own performance parameters outside the central contract.";
    },
    (value: MutableRegistry) => {
      value.derivedControls.find((entry) => entry.id === "DER-043")!.controlStatements[3] =
        "A single benchmark run or vendor default may select the performance strategy.";
    },
    (value: MutableRegistry) => {
      value.userStatements.find((entry) => entry.id === "USR-057")!.secretFreeNormalizedStatement =
        "Best-effort performance metrics with unbounded labels and no central configuration are sufficient.";
    },
    (value: MutableRegistry) => {
      value.globalAcceptanceGates[41]!.statement =
        "Unbounded labels and vendor defaults are sufficient for performance observability acceptance.";
    },
  ]) {
    const weakened = mutableRegistry();
    mutate(weakened);
    assert.equal(hasViolation(weakened, "requirements_registry_current_append_projection_drift"), true);
  }

  const crossEpochHash = mutableRegistry();
  crossEpochHash.requirements[34]!.provenance.sourceArtifactSha256 =
    crossEpochHash.requirements[33]!.provenance.sourceArtifactSha256;
  assert.equal(hasViolation(crossEpochHash, "requirements_registry_provenance_invalid:REQ-035"), true);
  const crossEpochLine = mutableRegistry();
  crossEpochLine.requirements[34]!.provenance.sourceLine = 789;
  assert.equal(hasViolation(crossEpochLine, "requirements_registry_provenance_invalid:REQ-035"), true);
  const baseEpochRewrite = mutableRegistry();
  baseEpochRewrite.requirements[0]!.provenance.sourceArtifactSha256 =
    baseEpochRewrite.requirements[34]!.provenance.sourceArtifactSha256;
  assert.equal(hasViolation(baseEpochRewrite, "requirements_registry_provenance_invalid:REQ-001"), true);

  const schemaVersionField = `"schemaVersion": ${JSON.stringify(REQUIREMENTS_REGISTRY_SCHEMA_VERSION)}`;
  const duplicateKey = REGISTRY_TEXT.replace(
    `${schemaVersionField},`,
    `${schemaVersionField},\n  ${schemaVersionField},`,
  );
  assert.throws(
    () => parseRequirementsRegistryText(duplicateKey),
    (error: unknown) =>
      error instanceof InputError && error.code === "requirements_registry_key_duplicate",
  );
});

test("S2.4-B02 malformed, duplicate, unknown, and orphan references fail closed", () => {
  const malformed = mutableRegistry();
  malformed.requirements[0]!.id = "REQ-1";
  assert.deepEqual(requirementsRegistryViolations(malformed), ["requirements_registry_schema_invalid"]);

  const duplicate = mutableRegistry();
  duplicate.requirements[1]!.id = duplicate.requirements[0]!.id;
  duplicate.requirements[1]!.provenance.sourcePointer = duplicate.requirements[0]!.id;
  assert.equal(hasViolation(duplicate, "requirements_registry_duplicate_requirement"), true);

  const unknown = mutableRegistry();
  unknown.userStatements[0]!.boundRequirements.push("REQ-999");
  assert.equal(hasViolation(unknown, "requirements_registry_unknown_reference"), true);

  const orphan = mutableRegistry();
  const orphanId = orphan.requirements[0]!.id;
  for (const statement of orphan.userStatements) {
    statement.boundRequirements = statement.boundRequirements.filter((id) => id !== orphanId);
  }
  orphan.requirements[0]!.status = "not-started";
  assert.equal(hasViolation(orphan, "requirements_registry_orphan_requirement:" + orphanId), true);
});

test("S2.4-B03 false satisfied claims and secret-like values fail while unassessed future requirements remain explicit", () => {
  const falseRequirement = mutableRegistry();
  falseRequirement.requirements[0]!.status = "implemented";
  assert.equal(hasViolation(falseRequirement, "requirements_registry_false_satisfied"), true);

  const falseControl = mutableRegistry();
  falseControl.derivedControls[0]!.status = "implemented";
  assert.equal(hasViolation(falseControl, "requirements_registry_false_satisfied"), true);

  const secret = mutableRegistry();
  secret.requirements[0]!.intent =
    ("synthetic regression credential mb" + "h_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(hasViolation(secret, "requirements_registry_secret_like_value"), true);

  const futureRequirement = REGISTRY.requirements.find((entry) => entry.id === "REQ-035");
  assert.equal(futureRequirement?.status, "unassessed");
  assert.ok(futureRequirement?.acceptanceCriteria[0]?.includes("policy-fabric/effect-gateway"));
  assert.ok(futureRequirement?.configOrInvariantLinks.includes("src/root-policy.ts#universalPolicyArchitecture"));
  assert.equal(REGISTRY.requirements.find((entry) => entry.id === "REQ-034")?.status, "unassessed");
  assert.deepEqual(requirementsRegistryViolations(REGISTRY), []);
});

test("S2.4-B04 root policy, offline identity, preflight receipt, and slice traces bind the registry without enabling effects", () => {
  assert.equal(ROOT_POLICY.requirements.registryFileSha256, REQUIREMENTS_REGISTRY_FILE_SHA256);
  assert.equal(ROOT_POLICY.requirements.registrySchemaHash, REQUIREMENTS_REGISTRY_SCHEMA_HASH);
  assert.equal(ROOT_POLICY.requirements.registryIdentityHash, REQUIREMENTS_REGISTRY_IDENTITY_HASH);
  assert.equal(S2_OFFLINE_CONTRACT_IDENTITY.requirementsRegistryIdentityHash, REQUIREMENTS_REGISTRY_IDENTITY_HASH);
  assert.match(S2_OFFLINE_CONTRACT_HASH, /^[0-9a-f]{64}$/u);

  const context = createPreflightContext();
  assert.equal(context.receipt.requirementsRegistry.expectedFileSha256, REQUIREMENTS_REGISTRY_FILE_SHA256);
  assert.equal(context.receipt.requirementsRegistry.identityHash, REQUIREMENTS_REGISTRY_IDENTITY_HASH);
  assert.equal(context.receipt.requirementsRegistry.directRuntimeRead, false);
  assert.equal(context.receipt.requirementsRegistry.repositoryManifestBound, true);

  const known = new Set<string>(requirementRegistryIds(REGISTRY));
  for (const name of ["s1.json", "s2.json", "s2.4.json", "s3.1.json"]) {
    const trace = JSON.parse(readFileSync(new URL("../traceability/" + name, import.meta.url), "utf8")) as {
      requirements: string[];
      derivedControls: string[];
    };
    assert.equal([...trace.requirements, ...trace.derivedControls].every((id) => known.has(id)), true);
  }
  const s1Trace = JSON.parse(readFileSync(new URL("../traceability/s1.json", import.meta.url), "utf8")) as {
    requirements: string[];
    derivedControls: string[];
    behaviors: Array<{ requirements: string[] }>;
  };
  const s1Applicability = requirementApplicabilityProjection(
    REGISTRY,
    s1Trace.behaviors.flatMap((behavior) => behavior.requirements),
  );
  assert.deepEqual(s1Applicability.requirementIds, s1Trace.requirements);
  assert.deepEqual(s1Applicability.derivedControlIds, s1Trace.derivedControls);
  assert.throws(() => requirementApplicabilityProjection(REGISTRY, [
    ...s1Applicability.orderedIds,
    "DER-999",
  ]));

  assert.equal(ROOT_POLICY.configuration.documentSchemaVersion, 3);
  assert.equal(ROOT_POLICY.receipts.preflightSchemaVersion, 1);
  assert.equal(Object.values(ROOT_POLICY.capabilities).filter(Boolean).length, 1);
  assert.equal(ROOT_POLICY.capabilities.preflight, true);
  assert.equal(context.receipt.harnessReady, false);
  assert.equal(context.receipt.capabilities.every((entry) => entry.effectAuthorized === false), true);

  const offlineTamper = {
    ...S2_OFFLINE_CONTRACT_IDENTITY,
    requirementsRegistryIdentityHash: "0".repeat(64),
  };
  assert.notEqual(canonicalHash(offlineTamper), S2_OFFLINE_CONTRACT_HASH);

  const { integrityHash, ...unsignedReceipt } = context.receipt;
  const receiptTamper = {
    ...unsignedReceipt,
    requirementsRegistry: {
      ...unsignedReceipt.requirementsRegistry,
      identityHash: "1".repeat(64),
    },
  };
  assert.notEqual(canonicalHash(receiptTamper), integrityHash);

  const policyTamper = {
    ...ROOT_POLICY,
    requirements: {
      ...ROOT_POLICY.requirements,
      registryIdentityHash: "2".repeat(64),
    },
  };
  assert.notEqual(canonicalHash(policyTamper), ROOT_POLICY_HASH);
  assert.deepEqual(
    requirementsRootBindingViolations(policyTamper.requirements),
    ["requirements_registry_root_binding_mismatch"],
  );
});

test("S2.4-B05 dual builder/runtime assessments fail closed without cross-surface evidence", () => {
  for (const row of [...REGISTRY.userStatements, ...REGISTRY.requirements, ...REGISTRY.derivedControls]) {
    assert.equal(row.surfaceAssessments.builder.subjectRealm, "builder");
    assert.equal(row.surfaceAssessments.builder.executionBoundary, "repository-build-and-maintenance");
    assert.equal(row.surfaceAssessments.runtime.subjectRealm, "runtime");
    assert.equal(row.surfaceAssessments.runtime.executionBoundary, "governed-project-execution");
  }
  assert.deepEqual(REGISTRY.userStatements.find((entry) => entry.id === "USR-036")?.boundRequirements,
    ["REQ-028", "REQ-029", "REQ-035"]);
  assert.deepEqual(REGISTRY.userStatements.find((entry) => entry.id === "USR-037")?.boundRequirements,
    ["REQ-013", "REQ-028"]);
  assert.deepEqual(REGISTRY.userStatements.find((entry) => entry.id === "USR-038")?.boundRequirements,
    ["REQ-025", "REQ-028"]);
  assert.deepEqual(REGISTRY.userStatements.find((entry) => entry.id === "USR-039")?.boundRequirements,
    ["REQ-002", "REQ-003", "REQ-010", "REQ-013", "REQ-027", "REQ-028"]);
  assert.deepEqual(REGISTRY.userStatements.find((entry) => entry.id === "USR-053")?.boundRequirements,
    ["REQ-002", "REQ-005", "REQ-006", "REQ-009", "REQ-016", "REQ-017", "REQ-020", "REQ-021",
      "REQ-024", "REQ-025", "REQ-027", "REQ-028", "REQ-029", "REQ-034", "REQ-035"]);
  assert.deepEqual(REGISTRY.userStatements.find((entry) => entry.id === "USR-054")?.boundRequirements,
    ["REQ-003", "REQ-004", "REQ-009", "REQ-010", "REQ-012", "REQ-013", "REQ-014", "REQ-016",
      "REQ-020", "REQ-021", "REQ-024", "REQ-025", "REQ-027", "REQ-028", "REQ-029", "REQ-031"]);
  assert.deepEqual(REGISTRY.userStatements.find((entry) => entry.id === "USR-055")?.boundRequirements,
    ["REQ-002", "REQ-004", "REQ-005", "REQ-006", "REQ-010", "REQ-013", "REQ-016", "REQ-017",
      "REQ-020", "REQ-021", "REQ-024", "REQ-025", "REQ-027", "REQ-028", "REQ-029"]);
  assert.deepEqual(REGISTRY.userStatements.find((entry) => entry.id === "USR-056")?.boundRequirements,
    ["REQ-001", "REQ-002", "REQ-003", "REQ-004", "REQ-005", "REQ-006", "REQ-013", "REQ-014",
      "REQ-015", "REQ-016", "REQ-020", "REQ-021", "REQ-024", "REQ-025", "REQ-027", "REQ-028",
      "REQ-029", "REQ-034", "REQ-035"]);
  assert.deepEqual(REGISTRY.userStatements.find((entry) => entry.id === "USR-057")?.boundRequirements,
    ["REQ-001", "REQ-006", "REQ-010", "REQ-016", "REQ-021", "REQ-024", "REQ-025", "REQ-028",
      "REQ-029", "REQ-033", "REQ-034", "REQ-035"]);
  assert.equal(REGISTRY.derivedControls.at(-1)?.id, "DER-043");

  const oneSided = mutableRegistry();
  const oneSidedControl = oneSided.derivedControls.find((entry) => entry.id === "DER-025")!;
  oneSidedControl.status = "implemented";
  oneSidedControl.surfaceAssessments.builder.outcome = "pass";
  assert.equal(hasViolation(oneSided, "requirements_registry_false_surface_satisfied:DER-025"), true);

  const noEvidence = mutableRegistry();
  const noEvidenceControl = noEvidence.derivedControls.find((entry) => entry.id === "DER-025")!;
  noEvidenceControl.surfaceAssessments.builder.outcome = "pass";
  noEvidenceControl.surfaceAssessments.builder.evidenceLinks = [];
  assert.equal(hasViolation(noEvidence, "requirements_registry_surface_evidence_missing:DER-025:builder"), true);

  const invalidNotApplicable = mutableRegistry();
  invalidNotApplicable.requirements[0]!.surfaceAssessments.runtime.applicability = "not-applicable";
  assert.equal(hasViolation(invalidNotApplicable,
    "requirements_registry_surface_applicability:REQ-001:runtime"), true);

  const reusedEvidence = mutableRegistry();
  const reusedControl = reusedEvidence.derivedControls.find((entry) => entry.id === "DER-025")!;
  const evidenceLink = reusedControl.surfaceAssessments.builder.evidenceLinks[0]!;
  reusedControl.surfaceAssessments.runtime.evidenceLinks.push(evidenceLink);
  assert.equal(hasViolation(reusedEvidence, "requirements_registry_surface_evidence_reused:DER-025"), true);

  const swappedRealm = mutableRegistry();
  swappedRealm.requirements[0]!.surfaceAssessments.builder.subjectRealm = "runtime";
  assert.deepEqual(requirementsRegistryViolations(swappedRealm), ["requirements_registry_schema_invalid"]);

  const fabricatedEvidence = mutableRegistry();
  fabricatedEvidence.requirements[0]!.surfaceAssessments.builder.evidenceLinks.push("fabricated#evidence");
  assert.equal(hasViolation(fabricatedEvidence,
    "requirements_registry_surface_evidence_unbound:REQ-001:builder"), true);

  const unavailable = REGISTRY.derivedControls.find((entry) => entry.id === "DER-026")!;
  assert.equal(unavailable.surfaceAssessments.runtime.applicability, "applicable");
  assert.equal(unavailable.surfaceAssessments.runtime.outcome, "unassessed");
});
