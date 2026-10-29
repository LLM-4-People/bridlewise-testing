import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { universalPolicyExtensionConformanceViolations, verifyS1Structure } from "../../scripts/tooling/s1-verification.ts";
import { EXECUTION_OPERATION_IDS, EXECUTION_OPERATION_SPECS, ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { makeRuntimeCandidate, removeOwnedTemporaryDirectories, appendCandidateSource, mutateCandidateTextExact, mutateTextExact, universalExtensionControl, REPOSITORY_ROOT, candidateModulePath } from "../support/s1-scenario-shared.ts";

// The forensic modules moved under src/forensics/ in the fold; resolve their
// current locations so the appended source and the expected violation strings
// (which embed the path) track the move rather than pinning a pre-fold path.
const FORENSIC_STATE_REL = candidateModulePath("forensic-state.ts");
const FORENSIC_PROJECTION_REL = candidateModulePath("forensic-projection.ts");

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B12-CONTROL": () => {
    assert.deepEqual(ROOT_POLICY.universalPolicyArchitecture.layerOrder, ["root", "harness", "project", "task"]);
    assert.equal(ROOT_POLICY.universalPolicyArchitecture.layerRule, "lower-layers-may-only-tighten");
    assert.deepEqual(ROOT_POLICY.universalPolicyArchitecture.generatedPlanes, [
      "static", "runtime", "storage", "conformance",
    ]);
    assert.equal(ROOT_POLICY.universalPolicyArchitecture.effectGatewayAvailable, false);
    assert.equal(ROOT_POLICY.universalPolicyArchitecture.extensions.inheritance,
      "automatic-compiled-policy-chain-no-copied-guards");
    assert.ok(ROOT_POLICY.universalPolicyArchitecture.policyFamilies.includes(
      "steering-continuity-and-observer-proposals",
    ));
    assert.ok(ROOT_POLICY.universalPolicyArchitecture.policyFamilies.includes(
      "runtime-language-and-independent-oracle-boundary",
    ));
    assert.ok(ROOT_POLICY.universalPolicyArchitecture.policyFamilies.includes(
      "recurring-alignment-checkpoint-and-agent-acknowledgement",
    ));
    const alignment = ROOT_POLICY.universalPolicyArchitecture.auditMatrix.alignmentCheckpoint;
    assert.equal(alignment.competingGoalTaskAuditFindingOrMonitorStoreAllowed, false);
    assert.equal(alignment.mandatoryTriggerFloorConfigurable, false);
    assert.equal(alignment.agentAcknowledgement.requiredBeforeNextEffect, true);
    assert.equal(alignment.agentAcknowledgement.mayRewriteSharedGoalOrPlan, false);
    const evidenceAdmission = ROOT_POLICY.universalPolicyArchitecture.auditMatrix.evidenceAdmission;
    assert.equal(evidenceAdmission.available, false);
    assert.equal(evidenceAdmission.draftSatisfactionAllowed, false);
    const defectGateway = ROOT_POLICY.universalPolicyArchitecture.preventableDefectGateway;
    assert.deepEqual(defectGateway.operationEnvelopeBoundaries, ["pre-apply", "pre-completion"]);
    assert.equal(defectGateway.findingSelfClosureAllowed, false);
    assert.equal(defectGateway.available, false);
    const authorityGraph = ROOT_POLICY.universalPolicyArchitecture.authorityOwnershipGraph;
    assert.equal(authorityGraph.duplicateSemanticAuthorityAllowed, false);
    assert.equal(authorityGraph.unclassifiedSemanticRepetitionAllowed, false);
    const operationSpecs = ROOT_POLICY.receipts.testExecution.operationSpecs;
    assert.deepEqual(EXECUTION_OPERATION_SPECS, operationSpecs);
    assert.deepEqual(EXECUTION_OPERATION_IDS, operationSpecs.map((spec) => spec.id));
    assert.equal(new Set(operationSpecs.map((spec) => spec.id)).size, operationSpecs.length);
    assert.equal(new Set(operationSpecs.map((spec) => spec.workerMode)).size, operationSpecs.length);
    assert.equal(new Set(operationSpecs.map((spec) => spec.resultKind)).size, operationSpecs.length);
    assert.deepEqual(universalPolicyExtensionConformanceViolations(universalExtensionControl()), []);

    const incompleteInheritance = universalExtensionControl({
      inheritedPolicyFamilies: ROOT_POLICY.universalPolicyArchitecture.policyFamilies.slice(0, -1),
    });
    assert.ok(universalPolicyExtensionConformanceViolations(incompleteInheritance).includes(
      "extension-policy-inheritance-incomplete",
    ));
    assert.ok(universalPolicyExtensionConformanceViolations(universalExtensionControl({
      policyHash: "0".repeat(64),
    })).includes("extension-policy-hash-mismatch"));
    assert.equal(verifyS1Structure(REPOSITORY_ROOT).violations.some(
      (entry) => entry.startsWith("universal-policy-"),
    ), false);

    const policyReadRoot = makeRuntimeCandidate();
    appendCandidateSource(policyReadRoot, FORENSIC_STATE_REL, [
      "const inheritedEnvelopeName = ROOT_POLICY.universalPolicyArchitecture.operationEnvelope;",
      "JSON.stringify(inheritedEnvelopeName);",
    ].join("\n"));
    assert.equal(verifyS1Structure(policyReadRoot).violations.includes(
      `universal-policy-parallel-authority:${FORENSIC_STATE_REL}`,
    ), false);
  },
  "S1-B12-FAILURE": () => {
    assert.throws(
      () => mutateTextExact("governed", "missing", "changed", "zero-match mutant"),
      /expected exactly one governed-byte match/u,
    );
    assert.throws(
      () => mutateTextExact("governed governed", "governed", "changed", "multi-match mutant"),
      /expected exactly one governed-byte match/u,
    );
    assert.throws(
      () => mutateTextExact("governed", "governed", "governed", "no-change mutant"),
      /mutation did not change governed bytes/u,
    );
    const packageRoot = makeRuntimeCandidate();
    const packagePath = join(packageRoot, "package.json");
    const packageDocument = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    packageDocument.exports = { ".": "./src/cli.ts", "./raw-effect": "./src/cli.ts" };
    writeFileSync(packagePath, `${JSON.stringify(packageDocument)}\n`);
    assert.ok(verifyS1Structure(packageRoot).violations.includes(
      "universal-policy-unregistered-entrypoint:package.json",
    ));

    const entrypointRoot = makeRuntimeCandidate();
    writeFileSync(join(entrypointRoot, "src", "unregistered-entrypoint.ts"),
      "export const registered = false;\n");
    assert.ok(verifyS1Structure(entrypointRoot).violations.includes(
      "universal-policy-unregistered-entrypoint:src/unregistered-entrypoint.ts",
    ));

    const weakenedRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(weakenedRoot, ROOT_POLICY.sourcePath,
      "localBypassesAllowed: false",
      "localBypassesAllowed: true",
      "B12 local-bypass mutant",
    );
    assert.ok(verifyS1Structure(weakenedRoot).violations.includes("universal-policy-root-source"));

    const alignmentRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(alignmentRoot, ROOT_POLICY.sourcePath,
      "mandatoryTriggerFloorConfigurable: false",
      "mandatoryTriggerFloorConfigurable: true",
      "B12 alignment-floor mutant",
    );
    assert.ok(verifyS1Structure(alignmentRoot).violations.includes("universal-policy-root-source"));

    const rootPolicySource = readFileSync(join(REPOSITORY_ROOT, ROOT_POLICY.sourcePath), "utf8");
    const staleAcknowledgement =
      'missingStaleOrContradictory: "block-agent-effect-and-route-through-shared-finding-and-continuity-reconciliation"';
    const distinctQualification =
      "x3-repeated-plus-x3-materially-distinct-long-multiturn-multiagent-hostile-alignment-functionality-methodology-continuity-privacy-overhead-and-recovery";
    const injectBeforeRootPolicyFreeze = (source: string, statement: string): string => mutateTextExact(source,
      "\n\nexport type RootPolicy = typeof ROOT_POLICY_VALUE;",
      `\n${statement}\n\nexport type RootPolicy = typeof ROOT_POLICY_VALUE;`,
    );
    const alignmentMutations = [
      (source: string) => mutateTextExact(source, '          "before-edit",\n', "") +
        '\n// decoy only: "before-edit"\n',
      (source: string) => mutateTextExact(source,
        staleAcknowledgement,
        'missingStaleOrContradictory: "allow-agent-effect"',
      ) + `\n// decoy only: ${staleAcknowledgement}\n`,
      (source: string) => mutateTextExact(source,
        distinctQualification,
        "x3-repeated-only",
      ) + `\n// decoy only: qualification: "${distinctQualification}"\n`,
      (source: string) => mutateTextExact(source, '          "replan",\n', ""),
      (source: string) => mutateTextExact(source,
        '          "replan",\n',
        '          "replan",\n          "attacker-added-trigger",\n',
      ),
      (source: string) => mutateTextExact(source,
        '          "task-start-or-resume",\n          "steering-reconciliation-complete",\n',
        '          "steering-reconciliation-complete",\n          "task-start-or-resume",\n',
      ),
      (source: string) => mutateTextExact(source,
        "        mandatoryTriggerFloorConfigurable: false,",
        '        ["mandatoryTriggerFloorConfigurable"]: false,',
      ),
      (source: string) => mutateTextExact(source,
        "      alignmentCheckpoint: {\n",
        "      alignmentCheckpoint: {\n        ...{},\n",
      ),
      (source: string) => mutateTextExact(source,
        "        mandatoryTriggerFloorConfigurable: false,",
        "        mandatoryTriggerFloorConfigurable: Boolean(false),",
      ),
      (source: string) => mutateTextExact(source,
        "        mandatoryTriggerFloorConfigurable: false,",
        "        mandatoryTriggerFloorConfigurable: false,\n        mandatoryTriggerFloorConfigurable: false,",
      ),
      (source: string) => mutateTextExact(source,
        "        requiredPreEffectOrCompletionCoalescingAllowed: false,",
        "        requiredPreEffectOrCompletionCoalescingAllowed: true,",
      ),
      (source: string) => mutateTextExact(source,
        "        requiredPreEffectOrCompletionCoalescingAllowed: false,\n",
        "",
      ),
      (source: string) => mutateTextExact(source,
        "        recursiveSelfTriggerAllowed: false,",
        "        recursiveSelfTriggerAllowed: true,",
      ),
      (source: string) => mutateTextExact(source, "        recursiveSelfTriggerAllowed: false,\n", ""),
      (source: string) => mutateTextExact(source,
        "        draftSatisfactionAllowed: false,",
        "        draftSatisfactionAllowed: true,",
      ),
      (source: string) => mutateTextExact(source,
        "      evidenceAdmission: {\n        available: false,",
        "      evidenceAdmission: {\n        available: true,",
      ),
      (source: string) => mutateTextExact(source,
        '        futureAuthority: "dedicated-evidence-admission-authority-not-yet-implemented",',
        '        futureAuthority: "local-draft-authority",',
      ),
      (source: string) => mutateTextExact(source,
        '        validatedIndexOwnership: "same-dedicated-evidence-admission-authority-only",',
        '        validatedIndexOwnership: "implementing-agent",',
      ),
      (source: string) => mutateTextExact(source,
        "      findingSelfClosureAllowed: false,",
        "      findingSelfClosureAllowed: true,",
      ),
      (source: string) => mutateTextExact(source,
        '      deterministicAnalyzerRole: "primary-authoritative-machine-check-and-rejection",',
        '      deterministicAnalyzerRole: "optional-advisory-check",',
      ),
      (source: string) => mutateTextExact(source,
        '      requiredToolPolicy: "use-exact-required-tool-or-provide-verified-install-guidance-and-block",',
        '      requiredToolPolicy: "silently-use-fallback",',
      ),
      (source: string) => mutateTextExact(source,
        "      duplicateSemanticAuthorityAllowed: false,",
        "      duplicateSemanticAuthorityAllowed: true,",
      ),
      (source: string) => mutateTextExact(source, "  AUDIT_MATRIX_ANGLES,\n", ""),
      (source: string) => mutateTextExact(source,
        "const ROOT_POLICY_VALUE = {",
        'AUDIT_MATRIX_ANGLES.push("attacker-added-angle" as never);\n\nconst ROOT_POLICY_VALUE = {',
      ),
      (source: string) => mutateTextExact(source,
        "      findingSelfClosureAllowed: false,\n      available: false,\n    },\n    authorityOwnershipGraph:",
        "      findingSelfClosureAllowed: false,\n      available: true,\n    },\n    authorityOwnershipGraph:",
      ),
      (source: string) => injectBeforeRootPolicyFreeze(
        source,
        "ROOT_POLICY_VALUE.universalPolicyArchitecture.auditMatrix.alignmentCheckpoint.available = true;",
      ),
      (source: string) => injectBeforeRootPolicyFreeze(
        source,
        "(ROOT_POLICY_VALUE as any).universalPolicyArchitecture.auditMatrix.alignmentCheckpoint.available = true;",
      ),
      (source: string) => injectBeforeRootPolicyFreeze(
        source,
        "const escapedRootPolicy = ROOT_POLICY_VALUE;",
      ),
      (source: string) => injectBeforeRootPolicyFreeze(
        source,
        "Object.assign(ROOT_POLICY_VALUE.universalPolicyArchitecture.auditMatrix.alignmentCheckpoint, { available: true });",
      ),
      (source: string) => injectBeforeRootPolicyFreeze(
        source,
        "ROOT_POLICY_VALUE.universalPolicyArchitecture.auditMatrix.alignmentCheckpoint.mandatoryTriggers.splice(0, 1);",
      ),
    ] as const;
    for (const [mutationIndex, mutate] of alignmentMutations.entries()) {
      const mutantRoot = makeRuntimeCandidate();
      const mutantPath = join(mutantRoot, ROOT_POLICY.sourcePath);
      const mutated = mutate(rootPolicySource);
      assert.notEqual(
        mutated,
        rootPolicySource,
        `alignment mutant ${mutationIndex} did not change root policy source`,
      );
      writeFileSync(mutantPath, mutated);
      assert.ok(verifyS1Structure(mutantRoot).violations.includes("universal-policy-root-source"));
    }

    const operationAuthorityRoot = makeRuntimeCandidate();
    const operationAuthorityPath = join(operationAuthorityRoot, ROOT_POLICY.sourcePath);
    const operationAuthoritySource = mutateTextExact(
      rootPolicySource,
      '          workerMode: "check",',
      '          workerMode: "test",',
      "B12 operation-authority mutant",
    );
    writeFileSync(operationAuthorityPath, operationAuthoritySource);
    assert.ok(verifyS1Structure(operationAuthorityRoot).violations.includes(
      "test-execution-operation-root-source",
    ));

    const unrelatedInventoryRoot = makeRuntimeCandidate();
    const unrelatedInventoryPath = join(unrelatedInventoryRoot, ROOT_POLICY.sourcePath);
    const unrelatedInventorySource = mutateTextExact(
      rootPolicySource,
      `specSchemaArtifactSha256: ${JSON.stringify(ROOT_POLICY.selfProtection.specSchemaArtifactSha256)}`,
      `specSchemaArtifactSha256: "${"0".repeat(64)}"`,
      "B12 unrelated pin mutant",
    );
    writeFileSync(unrelatedInventoryPath, unrelatedInventorySource);
    assert.equal(verifyS1Structure(unrelatedInventoryRoot).violations.some((violation) =>
      violation === "universal-policy-root-source" || violation === "universal-policy-root-invariant"), false);
  },
  "S1-B12-HOSTILE-REAL": () => {
    const parallelAuthorityVariants = [
      [FORENSIC_STATE_REL, "const localPolicyRegistry = Object.freeze({ enabled: true });"],
      [
        FORENSIC_PROJECTION_REL,
        'export const localAuthority = { ["policy" + "Compiler"]: true };',
      ],
      ["scripts/verification/candidate-manifest.ts", "const undocumentedException = true;"],
      [
        FORENSIC_STATE_REL,
        'const joinedAuthority = { [["policy", "Compiler"].join("")]: true };',
      ],
      [
        FORENSIC_PROJECTION_REL,
        'const markerKey = ["operation", "Envelope"].join(""); const aliasedAuthority = { [markerKey]: true };',
      ],
      [
        "scripts/verification/candidate-manifest.ts",
        'const policyPart = "Policy"; const templatedAuthority = { [`${policyPart}Registry`]: true };',
      ],
      [FORENSIC_STATE_REL, "type OperationEnvelope = { enabled: true };"],
      [FORENSIC_PROJECTION_REL, "interface PolicyRegistry { enabled: true }"],
      [FORENSIC_STATE_REL, "const alignmentMonitorStore = Object.freeze({});"],
      [FORENSIC_PROJECTION_REL, "const alignmentCheckpointStore = Object.freeze({});"],
      ["scripts/verification/candidate-manifest.ts", "const goalAlignmentStore = Object.freeze({});"],
    ] as const;
    for (const [path, source] of parallelAuthorityVariants) {
      const root = makeRuntimeCandidate();
      appendCandidateSource(root, path, source);
      assert.ok(verifyS1Structure(root).violations.includes(`universal-policy-parallel-authority:${path}`));
    }

    const alignmentAuthorityRoot = makeRuntimeCandidate();
    appendCandidateSource(alignmentAuthorityRoot, FORENSIC_STATE_REL, [
      "const alignmentMonitorStore = new Map<string, unknown>();",
      "void alignmentMonitorStore;",
    ].join("\n"));
    assert.ok(verifyS1Structure(alignmentAuthorityRoot).violations.includes(
      `universal-policy-parallel-authority:${FORENSIC_STATE_REL}`,
    ));

    assert.ok(universalPolicyExtensionConformanceViolations(universalExtensionControl({
      directLowLevelEntrypoints: true,
    })).includes("extension-direct-entrypoint-denied"));
    assert.ok(universalPolicyExtensionConformanceViolations(universalExtensionControl({
      copiedPolicyDefinitions: true,
    })).includes("extension-copied-policy-denied"));
    assert.ok(universalPolicyExtensionConformanceViolations(universalExtensionControl({
      waiverIds: ["local-never-authorized"],
    })).includes("extension-waiver-unavailable"));
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
