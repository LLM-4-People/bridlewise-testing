import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { getConfigDocumentSchema } from "../../src/kernel/config-contracts.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { canonicalHash, sha256 } from "../../src/kernel/integrity.ts";
import { SAFE_STRUCTURAL_REVISION } from "../../src/kernel/safe-structural.ts";
import {
  HANDOFF_PROTOCOL_AUTHORITY,
  admitHandoff,
  compileAssignmentContract,
  createHandoffProtocol,
  deriveHandoffExecutableSchemaFingerprint,
  inspectAssignmentContract,
  inspectHandoffDecision,
  parseHandoffProtocolManifest,
  snapshotHandoffCandidate,
} from "../../src/modules/tasks-agents/index.ts";
import type { PlannedNodeTestCheck } from "../../scripts/tooling/planned-node-test.ts";
import type { HandoffContinuityTestId } from "./handoff-continuity-test-catalog.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

const MANIFEST_PATH = "traceability/canonical/handoff-protocol-manifest.json";
const PREVENTION_REVIEW_PATH = "traceability/prevention/prevention-retrospective.json";
const CONFIG = CONFIG_DOCUMENT_SCHEMA.parse(JSON.parse(readFileSync("bridlewise.config.json", "utf8")));
const MANIFEST_SOURCE = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown;
const PROTOCOL = createHandoffProtocol(MANIFEST_SOURCE, CONFIG);

type GovernedContinuityOccurrence = Readonly<Record<string, unknown>>;

function loadGovernedContinuityBundle(): Readonly<{
  identity: string;
  occurrences: readonly GovernedContinuityOccurrence[];
}> {
  const document = JSON.parse(readFileSync(PREVENTION_REVIEW_PATH, "utf8")) as Record<string, unknown>;
  assert.ok(Array.isArray(document.sourceManifest));
  const source = document.sourceManifest.find((value: unknown) =>
    typeof value === "object" && value !== null &&
    (value as Record<string, unknown>).id === "source:current-subagent-steering-task-continuity-recurrence"
  ) as Record<string, unknown> | undefined;
  assert.ok(source);
  assert.deepEqual(source.incidentIds, ["INC-ARCH-013"]);
  const bundle = source.handoffContinuityOccurrenceBundle as Record<string, unknown> | undefined;
  assert.ok(bundle && Array.isArray(bundle.handoffContinuityOccurrences));
  const occurrences = bundle.handoffContinuityOccurrences as GovernedContinuityOccurrence[];
  assert.ok(occurrences.length > 0);
  assert.ok(occurrences.every((occurrence) =>
    typeof occurrence === "object" && occurrence !== null && !Array.isArray(occurrence)));
  assert.equal(new Set(occurrences.map(canonicalHash)).size, occurrences.length);
  return Object.freeze({
    identity: canonicalHash(bundle),
    occurrences: Object.freeze(structuredClone(occurrences)),
  });
}

const GOVERNED_CONTINUITY_BUNDLE = loadGovernedContinuityBundle();

function identity(label: string): string {
  return canonicalHash({ label });
}

function fixture(protocol = PROTOCOL) {
  const subjectIdentity = identity("subject:handoff-continuity");
  const compilation = compileAssignmentContract({
    taskIdentity: "task:parent-runtime-foundation",
    subtaskIdentity: "subtask:handoff-continuity",
    attemptIdentity: "attempt:bounded-foundation-2",
    assigneeAgentIdentity: "agent:handoff-author",
    parent: {
      parentTaskIdentity: "task:parent-runtime-foundation",
      parentAgentIdentity: "agent:root",
      resultRecipientIdentity: "recipient:root-task",
    },
    subjectIdentity,
    expectedOutputSchemaIdentity: identity("schema:handoff-report"),
    snapshot: {
      requirementsIdentity: identity("requirements"),
      repositoryIdentity: identity("repository"),
      worktreeIdentity: identity("worktree"),
      configurationIdentity: identity("configuration"),
      policyIdentity: identity("policy"),
      sourceSetIdentity: identity("source-set"),
    },
    focus: {
      foregroundFocusIdentity: "focus:handoff-continuity",
      unresolvedPredecessorIdentities: ["focus:secret-review", "focus:cascade-review"],
    },
    checklist: [{
      itemIdentity: "check:subject-and-parent",
      requiredEvidenceRequirementIdentities: ["evidence-requirement:subject"],
    }, {
      itemIdentity: "check:verification",
      requiredEvidenceRequirementIdentities: ["evidence-requirement:tests"],
    }],
    evidenceRequirements: [{
      requirementIdentity: "evidence-requirement:subject",
      kindIdentity: "evidence-kind:task-report",
      subjectIdentity,
    }, {
      requirementIdentity: "evidence-requirement:tests",
      kindIdentity: "evidence-kind:test-receipt",
      subjectIdentity,
    }],
  }, protocol);
  assert.equal(compilation.outcome, "compiled");
  assert.ok(compilation.assignment);
  const assignment = compilation.assignment;
  const proposal = {
    assignmentIdentity: assignment.assignmentIdentity,
    taskIdentity: assignment.taskIdentity,
    subtaskIdentity: assignment.subtaskIdentity,
    attemptIdentity: assignment.attemptIdentity,
    assigneeAgentIdentity: assignment.assigneeAgentIdentity,
    parent: assignment.parent,
    recipientIdentity: assignment.parent.resultRecipientIdentity,
    subjectIdentity: assignment.subjectIdentity,
    outputSchemaIdentity: assignment.expectedOutputSchemaIdentity,
    outputIdentity: identity("output:handoff-report"),
    snapshot: assignment.snapshot,
    focus: assignment.focus,
    disposition: "completed" as const,
    checklistResults: assignment.checklist.map((item) => ({
      itemIdentity: item.itemIdentity,
      status: "satisfied" as const,
      evidenceRequirementIdentities: [...item.requiredEvidenceRequirementIdentities],
    })),
    evidence: assignment.evidenceRequirements.map((requirement) => ({
      ...requirement,
      evidenceIdentity: identity(`evidence:${requirement.requirementIdentity}`),
    })),
    predecessorDispositions: assignment.focus.unresolvedPredecessorIdentities.map(
      (predecessorIdentity) => ({ predecessorIdentity, disposition: "suspended" as const }),
    ),
  };
  const context = {
    schemaVersion: protocol.authority.contractSchemaVersions.admissionContext,
    evaluatorKind: "deterministic-parent-gate" as const,
    activeAssignmentIdentity: assignment.assignmentIdentity,
    taskIdentity: assignment.taskIdentity,
    subtaskIdentity: assignment.subtaskIdentity,
    attemptIdentity: assignment.attemptIdentity,
    assigneeAgentIdentity: assignment.assigneeAgentIdentity,
    parent: assignment.parent,
    snapshot: assignment.snapshot,
    focus: assignment.focus,
  };
  return { assignment, context, proposal };
}

function expectInputCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof InputError && error.code === code);
}

function nested(depth: number): unknown {
  let value: unknown = 0;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

function rehashManifest(candidate: Record<string, unknown>): Record<string, unknown> {
  const { integrityHash: _discarded, ...unsigned } = candidate;
  return { ...unsigned, integrityHash: canonicalHash(unsigned) };
}

function mutableManifest(): Record<string, any> {
  return structuredClone(MANIFEST_SOURCE) as Record<string, any>;
}

function refreshManifestProjection(projection: Record<string, any>): void {
  projection.identity = {
    count: projection.values.length,
    sha256: canonicalHash(projection.values),
  };
}

function refreshCurrentLineageIdentities(candidate: Record<string, any>): void {
  for (const key of ["invariantOrder", "reasonOrder", "configKeyReferences", "semanticOwners"] as const) {
    refreshManifestProjection(candidate[key]);
  }
  const current = candidate.lineage.at(-1);
  current.invariantOrderIdentity = candidate.invariantOrder.identity;
  current.reasonOrderIdentity = candidate.reasonOrder.identity;
  current.configKeyReferenceIdentity = candidate.configKeyReferences.identity;
  current.semanticOwnerSetIdentity = candidate.semanticOwners.identity;
}

function candidateSelfOracleFingerprint(candidate: Record<string, any>): string {
  const options = {
    target: "draft-2020-12" as const,
    unrepresentable: "throw" as const,
    cycles: "ref" as const,
    reused: "ref" as const,
  };
  return canonicalHash({
    protocolVersion: candidate.currentProtocolVersion,
    contractSchemaVersions: candidate.contractSchemaVersions,
    identityDomains: candidate.identityDomains,
    invariantOrderIdentity: candidate.invariantOrder.identity,
    reasonOrderIdentity: candidate.reasonOrder.identity,
    configKeyReferenceIdentity: candidate.configKeyReferences.identity,
    semanticOwnerSetIdentity: candidate.semanticOwners.identity,
    featurePolicyDisposition: candidate.featurePolicyDisposition,
    safeStructuralRevision: SAFE_STRUCTURAL_REVISION,
    schemas: {
      assignment: z.toJSONSchema(PROTOCOL.schemas.assignment, options),
      proposal: z.toJSONSchema(PROTOCOL.schemas.proposal, options),
      admissionContext: z.toJSONSchema(PROTOCOL.schemas.admissionContext, options),
      decision: z.toJSONSchema(PROTOCOL.schemas.decision, options),
    },
  });
}

function fullyRewrittenManifest(
  mutate: (candidate: Record<string, any>) => void,
): Record<string, unknown> {
  const candidate = mutableManifest();
  mutate(candidate);
  refreshCurrentLineageIdentities(candidate);
  candidate.lineage.at(-1).executableSchemaFingerprint = candidateSelfOracleFingerprint(candidate);
  return rehashManifest(candidate);
}

export function runHandoffContinuityTestOracle(
  id: HandoffContinuityTestId,
  check: PlannedNodeTestCheck,
): void {
  switch (id) {
    case "HCF-S001":
      check(() => {
        for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
          for (const candidate of [value, [value], { nested: { value } }]) {
            const result = snapshotHandoffCandidate(candidate, "proposal",
              PROTOCOL.authority.identityDomains.proposalCandidate, PROTOCOL);
            assert.equal(result.candidateIdentity, null);
            assert.equal(result.structuralRejection?.classification, "non-finite-number");
          }
        }
        const base = fixture();
        const decision = admitHandoff(base.assignment, { ...base.proposal, rogue: Number.NaN },
          base.context, PROTOCOL);
        assert.equal(decision.outcome, "rejected");
        assert.equal(decision.proposalCandidateIdentity, null);
        assert.ok(decision.reasonCodes.includes("proposal-structure-rejected"));
      });
      return;
    case "HCF-S002":
      check(() => {
        let trapCalls = 0;
        const proxy = new Proxy({}, new Proxy({}, {
          get() {
            trapCalls += 1;
            throw new Error("CANARY_PROXY_TRAP");
          },
        }));
        const decision = admitHandoff(proxy, proxy, proxy, PROTOCOL);
        assert.equal(trapCalls, 0);
        assert.deepEqual(decision.structuralRejections.map((entry) => entry.classification),
          ["proxy", "proxy", "proxy"]);
        assert.equal(decision.assignmentCandidateIdentity, null);
        assert.equal(decision.proposalCandidateIdentity, null);
        assert.equal(decision.contextIdentity, null);

        let getterCalls = 0;
        const accessor = {};
        Object.defineProperty(accessor, "canary", {
          enumerable: true,
          get() {
            getterCalls += 1;
            throw new Error("CANARY_GETTER");
          },
        });
        const result = snapshotHandoffCandidate(accessor, "assignment",
          PROTOCOL.authority.identityDomains.assignmentCandidate, PROTOCOL);
        assert.equal(getterCalls, 0);
        assert.equal(result.structuralRejection?.classification, "accessor-or-hidden-property");
      });
      return;
    case "HCF-S003":
      check(() => {
        const hidden = {};
        Object.defineProperty(hidden, "secret", { value: "CANARY_HIDDEN", enumerable: false });
        const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
        inherited.own = true;
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const cases = [
          [hidden, "accessor-or-hidden-property"],
          [inherited, "unsupported-prototype"],
          [cyclic, "cycle"],
          [{ value: undefined }, "non-json"],
          [{ value: Symbol("CANARY_SYMBOL") }, "non-json"],
          [{ value: () => "CANARY_FUNCTION" }, "non-json"],
        ] as const;
        for (const [candidate, classification] of cases) {
          const result = snapshotHandoffCandidate(candidate, "context",
            PROTOCOL.authority.identityDomains.admissionContext, PROTOCOL);
          assert.equal(result.structuralRejection?.classification, classification);
          assert.equal(result.candidateIdentity, null);
        }
        const nullDecision = admitHandoff(null, null, null, PROTOCOL);
        assert.equal(nullDecision.outcome, "rejected");
        assert.ok(nullDecision.reasonCodes.includes("assignment-contract-invalid"));
        assert.ok(nullDecision.reasonCodes.includes("proposal-contract-invalid"));
        assert.ok(nullDecision.reasonCodes.includes("admission-context-invalid"));
      });
      return;
    case "HCF-L001":
      check(() => {
        const maxId = PROTOCOL.maximumIdentifierCharacters;
        assert.equal(maxId, CONFIG.contracts.limits.maximumIdentifierCharacters);
        assert.equal(snapshotHandoffCandidate("a".repeat(maxId), "assignment",
          PROTOCOL.authority.identityDomains.assignmentCandidate, PROTOCOL).structuralRejection, null);
        assert.equal(snapshotHandoffCandidate("a".repeat(maxId + 1), "assignment",
          PROTOCOL.authority.identityDomains.assignmentCandidate, PROTOCOL)
          .structuralRejection?.classification, "maximum-identifier-characters");
        assert.equal(snapshotHandoffCandidate(nested(PROTOCOL.structuralLimits.maximumDepth), "context",
          PROTOCOL.authority.identityDomains.admissionContext, PROTOCOL).structuralRejection, null);
        assert.equal(snapshotHandoffCandidate(nested(PROTOCOL.structuralLimits.maximumDepth + 1), "context",
          PROTOCOL.authority.identityDomains.admissionContext, PROTOCOL)
          .structuralRejection?.classification, "maximum-depth");
        assert.equal(snapshotHandoffCandidate(Array(PROTOCOL.structuralLimits.maximumNodes - 1).fill(0),
          "proposal", PROTOCOL.authority.identityDomains.proposalCandidate, PROTOCOL).structuralRejection, null);
        assert.equal(snapshotHandoffCandidate(Array(PROTOCOL.structuralLimits.maximumNodes).fill(0),
          "proposal", PROTOCOL.authority.identityDomains.proposalCandidate, PROTOCOL)
          .structuralRejection?.classification, "maximum-nodes");
        assert.equal(snapshotHandoffCandidate("a".repeat(PROTOCOL.structuralLimits.maximumCanonicalBytes),
          "proposal", PROTOCOL.authority.identityDomains.proposalCandidate, PROTOCOL)
          .structuralRejection?.classification, "maximum-bytes");
      });
      return;
    case "HCF-C001":
      check(() => {
        const { assignment } = fixture();
        assert.equal(assignment.schemaVersion, PROTOCOL.authority.contractSchemaVersions.assignment);
        assert.deepEqual(inspectAssignmentContract(assignment, PROTOCOL), assignment);
        assert.equal(inspectAssignmentContract({ ...assignment, assignmentIdentity: identity("forged") },
          PROTOCOL), null);
        assert.ok(Object.isFrozen(assignment));
        assert.ok(Object.isFrozen(assignment.parent));
        assert.ok(Object.isFrozen(assignment.checklist));
        assert.equal(compileAssignmentContract({ invalid: true }, PROTOCOL).outcome, "rejected");
      });
      return;
    case "HCF-D001":
      check(() => {
        const base = fixture();
        const decision = admitHandoff(base.assignment, base.proposal, base.context, PROTOCOL);
        assert.equal(decision.outcome, "held");
        assert.equal(decision.admissionCapability, "unavailable");
        assert.equal(decision.effectAuthorization, "unavailable");
        assert.equal(decision.deliveryAuthorization, "unavailable");
        assert.deepEqual(decision.invariantResults.map((entry) => entry.invariantId),
          PROTOCOL.authority.invariantOrder);
        assert.equal(decision.invariantResults.find((entry) => entry.invariantId === "snapshot")
          ?.disposition, "unassessed");
        assert.equal(decision.invariantResults.find((entry) => entry.invariantId === "evidence")
          ?.disposition, "unassessed");
        assert.equal(decision.invariantResults.find((entry) => entry.invariantId === "nominal-authority")
          ?.disposition, "unassessed");
        assert.deepEqual(inspectHandoffDecision(decision, PROTOCOL), decision);
      });
      return;
    case "HCF-D002":
      check(() => {
        const base = fixture();
        const proposal = {
          ...base.proposal,
          recipientIdentity: "recipient:stale",
          subjectIdentity: identity("subject:stale"),
          focus: { ...base.proposal.focus, foregroundFocusIdentity: "focus:stale" },
          checklistResults: base.proposal.checklistResults.map((entry, index) =>
            index === 0 ? { ...entry, status: "failed" as const } : entry),
        };
        const decision = admitHandoff(base.assignment, proposal, base.context, PROTOCOL);
        assert.equal(decision.outcome, "rejected");
        for (const reason of ["recipient-mismatch", "subject-mismatch", "focus-mismatch",
          "checklist-unsatisfied"] as const) assert.ok(decision.reasonCodes.includes(reason));
        assert.deepEqual(decision.reasonCodes,
          PROTOCOL.authority.reasonOrder.filter((reason) => decision.reasonCodes.includes(reason)));
        assert.equal(decision.invariantResults.find((entry) => entry.invariantId === "recipient")
          ?.disposition, "failed");
      });
      return;
    case "HCF-D003":
      check(() => {
        const base = fixture();
        for (const evaluatorKind of ["embedding-observer", "llm-observer"] as const) {
          const decision = admitHandoff(base.assignment, { ...base.proposal, unexpected: true },
            { ...base.context, evaluatorKind }, PROTOCOL);
          assert.equal(decision.outcome, "held");
          assert.ok(decision.reasonCodes.includes("observer-advisory-only"));
          assert.ok(decision.reasonCodes.includes("proposal-contract-invalid"));
          assert.equal(decision.admissionCapability, "unavailable");
        }
        const malformedContext = { ...base.context, evaluatorKind: "invented-authority" };
        const rejected = admitHandoff(base.assignment, base.proposal, malformedContext, PROTOCOL);
        assert.equal(rejected.outcome, "rejected");
        assert.ok(rejected.reasonCodes.includes("admission-context-invalid"));
      });
      return;
    case "HCF-D004":
      check(() => {
        let calls = 0;
        const hostile = {};
        Object.defineProperty(hostile, "CANARY_CREDENTIAL_VALUE", {
          enumerable: true,
          get() {
            calls += 1;
            return "sk-live-CANARY-SECRET";
          },
        });
        const base = fixture();
        const decision = admitHandoff(hostile, hostile, hostile, PROTOCOL);
        assert.equal(calls, 0);
        assert.equal(decision.assignmentCandidateIdentity, null);
        assert.equal(decision.proposalCandidateIdentity, null);
        assert.equal(decision.contextIdentity, null);
        assert.equal(JSON.stringify(decision).includes("CANARY"), false);
        assert.equal(decision.outcome, "rejected");
        assert.equal(base.assignment.assignmentIdentity.length, 64);
      });
      return;
    case "HCF-R013":
      check(() => {
        const base = fixture();
        const evaluatedOccurrenceIdentities: string[] = [];
        for (const occurrence of GOVERNED_CONTINUITY_BUNDLE.occurrences) {
          const occurrenceIdentity = canonicalHash(occurrence);
          evaluatedOccurrenceIdentities.push(occurrenceIdentity);
          const decision = admitHandoff(base.assignment, {
            ...base.proposal,
            subjectIdentity: identity(`wrong-subject:${GOVERNED_CONTINUITY_BUNDLE.identity}:${occurrenceIdentity}`),
            checklistResults: base.proposal.checklistResults.map((entry) => ({
              ...entry,
              status: "unassessed" as const,
            })),
            evidence: base.proposal.evidence.map((entry) => ({
              ...entry,
              kindIdentity: "evidence-kind:wrong-subject-output",
            })),
          }, base.context, PROTOCOL);
          assert.equal(decision.outcome, "rejected", occurrenceIdentity);
          assert.ok(decision.reasonCodes.includes("subject-mismatch"), occurrenceIdentity);
          assert.ok(decision.reasonCodes.includes("checklist-unsatisfied"), occurrenceIdentity);
          assert.ok(decision.reasonCodes.includes("evidence-mismatch"), occurrenceIdentity);
        }
        const governedOccurrenceIdentities = GOVERNED_CONTINUITY_BUNDLE.occurrences.map(canonicalHash);
        assert.equal(evaluatedOccurrenceIdentities.length, GOVERNED_CONTINUITY_BUNDLE.occurrences.length);
        assert.equal(canonicalHash(evaluatedOccurrenceIdentities), canonicalHash(governedOccurrenceIdentities));
      });
      return;
    case "HCF-M001":
      check(() => {
        const manifest = parseHandoffProtocolManifest(MANIFEST_SOURCE);
        assert.equal(deriveHandoffExecutableSchemaFingerprint(manifest),
          manifest.lineage.at(-1)?.executableSchemaFingerprint);
        const badIntegrity = { ...manifest, integrityHash: "0".repeat(64) };
        expectInputCode(() => parseHandoffProtocolManifest(badIntegrity), "handoff_manifest_integrity_invalid");

        const fingerprintDrift = mutableManifest();
        fingerprintDrift.lineage.at(-1).executableSchemaFingerprint = "0".repeat(64);
        expectInputCode(() => createHandoffProtocol(rehashManifest(fingerprintDrift), CONFIG),
          "handoff_protocol_fingerprint_drift");

        const schemaDrift = mutableManifest();
        schemaDrift.contractSchemaVersions.decision =
          `bridlewise-forged-handoff-decision/v${HANDOFF_PROTOCOL_AUTHORITY.currentProtocolVersion}`;
        expectInputCode(() => createHandoffProtocol(rehashManifest(schemaDrift), CONFIG),
          "handoff_manifest_authority_mismatch");
      });
      return;
    case "HCF-M002":
      check(() => {
        const manifest = parseHandoffProtocolManifest(MANIFEST_SOURCE);
        assert.equal(manifest.invariantOrder.identity.sha256, canonicalHash(manifest.invariantOrder.values));
        assert.equal(manifest.reasonOrder.identity.sha256, canonicalHash(manifest.reasonOrder.values));
        assert.equal(manifest.configKeyReferences.identity.sha256,
          canonicalHash(manifest.configKeyReferences.values));
        assert.equal(manifest.semanticOwners.identity.sha256, canonicalHash(manifest.semanticOwners.values));
        assert.deepEqual(manifest.contractSchemaVersions, HANDOFF_PROTOCOL_AUTHORITY.contractSchemaVersions);
        assert.deepEqual(manifest.identityDomains, HANDOFF_PROTOCOL_AUTHORITY.identityDomains);
        assert.deepEqual(manifest.invariantOrder.values, HANDOFF_PROTOCOL_AUTHORITY.invariantOrder);
        assert.deepEqual(manifest.reasonOrder.values, HANDOFF_PROTOCOL_AUTHORITY.reasonOrder);
        assert.deepEqual(manifest.configKeyReferences.values, HANDOFF_PROTOCOL_AUTHORITY.configKeyReferences);
        assert.deepEqual(manifest.semanticOwners.values, HANDOFF_PROTOCOL_AUTHORITY.semanticOwners);
        for (const owner of manifest.semanticOwners.values) {
          const bytes = readFileSync(owner.path);
          assert.equal(bytes.length, owner.byteLength, owner.path);
          assert.equal(sha256(bytes), owner.sha256, owner.path);
        }
        const drift = mutableManifest();
        drift.reasonOrder.values = [...drift.reasonOrder.values, "invented-reason"];
        drift.reasonOrder.identity = {
          count: drift.reasonOrder.values.length,
          sha256: canonicalHash(drift.reasonOrder.values),
        };
        drift.lineage.at(-1).reasonOrderIdentity = drift.reasonOrder.identity;
        expectInputCode(() => createHandoffProtocol(rehashManifest(drift), CONFIG),
          "handoff_manifest_authority_mismatch");
      });
      return;
    case "HCF-A001":
      check(() => {
        const alteredSchema = mutableManifest();
        alteredSchema.contractSchemaVersions.assignment =
          `bridlewise-forged-assignment/v${HANDOFF_PROTOCOL_AUTHORITY.currentProtocolVersion}`;
        expectInputCode(() => createHandoffProtocol(rehashManifest(alteredSchema), CONFIG),
          "handoff_manifest_authority_mismatch");

        const missingField = mutableManifest();
        delete missingField.contractSchemaVersions.decision;
        assert.throws(() => createHandoffProtocol(rehashManifest(missingField), CONFIG));

        const extraField = mutableManifest();
        extraField.unregisteredAuthority = true;
        assert.throws(() => createHandoffProtocol(rehashManifest(extraField), CONFIG));

        const coercedField = mutableManifest();
        coercedField.currentProtocolVersion = String(coercedField.currentProtocolVersion);
        assert.throws(() => createHandoffProtocol(rehashManifest(coercedField), CONFIG));
      });
      return;
    case "HCF-A002":
      check(() => {
        const mutations = [
          (candidate: Record<string, any>) => {
            candidate.invariantOrder.values = candidate.invariantOrder.values.filter(
              (value: string) => value !== "subject",
            );
          },
          (candidate: Record<string, any>) => {
            candidate.reasonOrder.values = candidate.reasonOrder.values.filter(
              (value: string) => value !== "subject-mismatch",
            );
          },
          (candidate: Record<string, any>) => {
            candidate.invariantOrder.values = [...candidate.invariantOrder.values, "invented-invariant"];
          },
          (candidate: Record<string, any>) => {
            [candidate.invariantOrder.values[0], candidate.invariantOrder.values[1]] =
              [candidate.invariantOrder.values[1], candidate.invariantOrder.values[0]];
          },
          (candidate: Record<string, any>) => {
            [candidate.reasonOrder.values[0], candidate.reasonOrder.values[1]] =
              [candidate.reasonOrder.values[1], candidate.reasonOrder.values[0]];
          },
        ] as const;
        for (const mutate of mutations) {
          expectInputCode(() => createHandoffProtocol(fullyRewrittenManifest(mutate), CONFIG),
            "handoff_manifest_authority_mismatch");
        }
      });
      return;
    case "HCF-A003":
      check(() => {
        const rebound = fullyRewrittenManifest((candidate) => {
          candidate.configKeyReferences.values[0] = {
            purpose: "identifier-maximum",
            owner: "root-policy",
            path: "verification.testDiscovery.maximumEntries",
            availability: "required",
          };
        });
        expectInputCode(() => createHandoffProtocol(rebound, CONFIG),
          "handoff_manifest_authority_mismatch");

        const missing = fullyRewrittenManifest((candidate) => {
          candidate.configKeyReferences.values = candidate.configKeyReferences.values.filter(
            (entry: Record<string, unknown>) => entry.purpose !== "identifier-maximum",
          );
        });
        expectInputCode(() => createHandoffProtocol(missing, CONFIG),
          "handoff_manifest_authority_mismatch");

        const reordered = fullyRewrittenManifest((candidate) => {
          [candidate.configKeyReferences.values[0], candidate.configKeyReferences.values[1]] =
            [candidate.configKeyReferences.values[1], candidate.configKeyReferences.values[0]];
        });
        expectInputCode(() => createHandoffProtocol(reordered, CONFIG),
          "handoff_manifest_authority_mismatch");

        assert.equal(PROTOCOL.maximumIdentifierCharacters,
          CONFIG.contracts.limits.maximumIdentifierCharacters);

        const unexpectedFeaturePolicy = {
          ...CONFIG,
          handoffValidation: { enabled: true },
        };
        expectInputCode(() => createHandoffProtocol(MANIFEST_SOURCE, unexpectedFeaturePolicy),
          "handoff_feature_policy_invalid");
      });
      return;
    case "HCF-A004":
      check(() => {
        const replaced = fullyRewrittenManifest((candidate) => {
          candidate.semanticOwners.values[0] = {
            role: "safe-structural-boundary",
            path: "src/nonexistent-handoff-owner.ts",
            byteLength: 0,
            sha256: "0".repeat(64),
          };
        });
        expectInputCode(() => createHandoffProtocol(replaced, CONFIG),
          "handoff_manifest_authority_mismatch");

        const reordered = fullyRewrittenManifest((candidate) => {
          [candidate.semanticOwners.values[0], candidate.semanticOwners.values[1]] =
            [candidate.semanticOwners.values[1], candidate.semanticOwners.values[0]];
        });
        expectInputCode(() => createHandoffProtocol(reordered, CONFIG),
          "handoff_manifest_authority_mismatch");
      });
      return;
    case "HCF-A005":
      check(() => {
        const base = fixture();
        const wrongSubject = {
          ...base.proposal,
          subjectIdentity: identity("subject:wrong-candidate"),
        };
        const canonicalDecision = admitHandoff(base.assignment, wrongSubject, base.context, PROTOCOL);
        assert.equal(canonicalDecision.outcome, "rejected");
        assert.ok(canonicalDecision.reasonCodes.includes("subject-mismatch"));

        const combined = fullyRewrittenManifest((candidate) => {
          candidate.invariantOrder.values = candidate.invariantOrder.values.filter(
            (value: string) => value !== "subject",
          );
          candidate.reasonOrder.values = candidate.reasonOrder.values.filter(
            (value: string) => value !== "subject-mismatch",
          );
          candidate.configKeyReferences.values[0] = {
            purpose: "identifier-maximum",
            owner: "root-policy",
            path: "verification.testDiscovery.maximumEntries",
            availability: "required",
          };
          candidate.semanticOwners.values[0] = {
            role: "safe-structural-boundary",
            path: "src/nonexistent-handoff-owner.ts",
            byteLength: 0,
            sha256: "0".repeat(64),
          };
        });
        const parsedCombined = parseHandoffProtocolManifest(combined);
        assert.equal(
          parsedCombined.lineage.at(-1)?.executableSchemaFingerprint,
          candidateSelfOracleFingerprint(parsedCombined as unknown as Record<string, any>),
        );
        expectInputCode(() => createHandoffProtocol(combined, CONFIG),
          "handoff_manifest_authority_mismatch");
      });
      return;
    case "HCF-I001":
      check(() => {
        const base = fixture();
        const decision = admitHandoff(base.assignment, base.proposal, base.context, PROTOCOL);
        assert.ok(inspectHandoffDecision(decision, PROTOCOL));
        assert.equal(inspectHandoffDecision({ ...decision, outcome: "rejected" }, PROTOCOL), null);
        assert.equal(inspectHandoffDecision({ ...decision, reasonCodes: ["observer-advisory-only"] },
          PROTOCOL), null);
        assert.equal(inspectHandoffDecision({ ...decision, admissionCapability: "available" }, PROTOCOL), null);
        assert.equal(inspectHandoffDecision({ ...decision, protocolIdentity: "0".repeat(64) }, PROTOCOL), null);
      });
      return;
  }
}
