import assert from "node:assert/strict";
import test from "node:test";
import { verifyS1Structure } from "../../scripts/tooling/s1-verification.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { makeRuntimeCandidate, removeOwnedTemporaryDirectories, mutateCandidateTextExact } from "../support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B15-CONTROL": () => {
    const policy = ROOT_POLICY.universalPolicyArchitecture.adaptiveContextManagement;
    assert.equal(policy.sourceHistory, "immutable-complete-and-addressable");
    assert.equal(policy.vectorStatus, "hypothesis-never-assumed-best");
    assert.deepEqual(policy.retrievalMcpQualification.mandatoryAdapters,
      ["kagi", "deepwiki", "scrapling", "context7"]);
    assert.equal(policy.pressurePlan.fiftyPercentUsedContextRole,
      "unqualified-preregistered-candidate-cell-only-never-operational-default");
    assert.equal(policy.pressurePlan.exactCrossModelPressureConstantAllowed, false);
    assert.ok(policy.pressurePlan.reservedHeadroom.includes("model-output-and-reasoning"));
    assert.equal(policy.pressurePlan.destructiveSourceHistoryTrimmingAllowed, false);
    assert.equal(policy.pressurePlan.summaryAsSourceAuthorityAllowed, false);
    assert.equal(policy.pressurePlan.fullCompaction,
      "observable-critical-fail-safe-only-after-no-qualified-lower-loss-plan-fits");
    assert.equal(policy.available, false);
    const layout = ROOT_POLICY.projectLayoutArchitecture;
    assert.equal(layout.documentation.canonicalRoot, "docs/");
    assert.equal(layout.documentation.configurableRootAllowed, false);
    assert.equal(layout.documentation.executableOrOperationalSourceAllowed, false);
    assert.equal(layout.arbitraryLineFileCountOrDepthThresholdAsDesignOracleAllowed, false);
    assert.equal(layout.competingRootRoleOwnerOrLayoutAuthorityAllowed, false);
    assert.equal(layout.runtimeEnforcementAvailable, false);
    const scaffold = ROOT_POLICY.universalPolicyArchitecture.deterministicModelScaffolding;
    assert.equal(scaffold.smallModelParityStatus,
      "falsifiable-preregistered-benchmark-hypothesis-only-never-promise");
    assert.equal(scaffold.modelTierSpecificHiddenPolicyOrOracleAllowed, false);
    assert.equal(scaffold.passRateModelSizeOrScaffoldSelfReportSufficient, false);
    assert.equal(scaffold.available, false);
    const orchestrator = ROOT_POLICY.universalPolicyArchitecture.orchestratorContextDiscipline;
    assert.equal(orchestrator.accessOrder,
      "scoped-agent-through-qualified-mcp-capability-before-root-direct-access");
    assert.equal(orchestrator.taskScopedAgentAlignmentBeforeHandoff, true);
    assert.equal(orchestrator.rootContextConvenienceMayReduceEvidenceTestingOrIsolation, false);
    const replay = ROOT_POLICY.universalPolicyArchitecture.preventableDefectGateway
      .acceptanceInvalidationAndReplay;
    assert.equal(replay.affectedPriorAcceptanceRemainsValidWithoutReplay, false);
    assert.equal(replay.priorGreenResultCarryForwardAllowed, false);
    assert.equal(replay.unavailableOrStaleCompleteReplay,
      "explicit-blocker-and-builder-runtime-unassessed");
    assert.ok(replay.exactCandidateReplay.includes("complete-previously-governed-test-surface"));
    assert.ok(replay.exactCandidateReplay.includes("full-promotion-gate"));
    const bootstrap = ROOT_POLICY.conversationBootstrapArchitecture;
    assert.equal(bootstrap.authority,
      "derived-projection-over-existing-canonical-authorities-not-a-fact-store");
    assert.equal(bootstrap.authoredBasicIntentOverlay.generatedFactOverrideAllowed, false);
    assert.equal(bootstrap.authoredBasicIntentOverlay.conflictResolution,
      "generated-canonical-facts-remain-authoritative-and-publication-blocks-until-overlay-correction");
    assert.equal(bootstrap.configurableMandatoryIdentityProvenanceSanitationOrInvalidationFloor, false);
    assert.equal(bootstrap.delivery,
      "same-authorized-base-snapshot-identity-plus-gap-free-ordered-deltas-for-every-agent-and-prompt");
    assert.equal(bootstrap.runtimeEnforcementAvailable, false);
    const interaction = ROOT_POLICY.governedInteractionArchitecture;
    assert.deepEqual(interaction.clientProjection.sharedPorts,
      ["typed-event", "presentation", "control"]);
    assert.equal(interaction.clientProjection.clientOwnedPolicyOrchestrationStorageJobStateOrCommandConstructionAllowed,
      false);
    assert.equal(interaction.jobs.conversationLoopBlockingAllowed, false);
    assert.equal(interaction.retrievalProposalBoundary.similarityOrRetrievedContentGrantsAuthority, false);
    assert.equal(interaction.retrievalProposalBoundary.ambientShellConstructionOrEvaluationAllowed, false);
    assert.equal(interaction.deterministicDispatch.modelRetrievalOrClientMaySelfAuthorize, false);
    assert.equal(interaction.qualification.minimumRepetitions, 3);
    assert.equal(interaction.qualification.minimumMateriallyDistinctScenarios, 3);
    assert.equal(interaction.runtimeEnforcementAvailable, false);
    const inspection = ROOT_POLICY.modelRepositoryInspectionArchitecture;
    assert.equal(inspection.rawByteIsolation.unredactedModelToolLogCacheIndexMemoryErrorTelemetryOrEmbeddingExposureAllowed,
      false);
    assert.equal(inspection.authorizedTextRedaction.credentialPresenceAloneRejectsWholeAuthorizedText, false);
    assert.equal(inspection.authorizedTextRedaction.ordinaryCredentialVariableIdentifierVisible, true);
    assert.equal(inspection.patternSearch.stableOrderedSnapshotSpansRequired, true);
    assert.equal(inspection.semanticDiscovery.enabledBeforeQualification, false);
    assert.equal(inspection.semanticDiscovery.recommendationBeforeMeasurementsAllowed, false);
    assert.equal(inspection.semanticDiscovery.scoreMayWidenScopeSuppressExactResultsSelectStalePageOrCertifySafety,
      false);
    assert.equal(inspection.configurableSafetyFloor, false);
    assert.equal(inspection.qualification.minimumRepetitions, 3);
    assert.equal(inspection.qualification.minimumMateriallyDistinctScenarios, 3);
    assert.equal(inspection.runtimeEnforcementAvailable, false);
    assert.equal(ROOT_POLICY.steeringContinuityArchitecture.newestMessageReplacesUnfinishedWorkByDefault, false);
    assert.equal(ROOT_POLICY.steeringContinuityArchitecture.handoffResultBinding,
      "bind-assigned-task-subtask-attempt-and-explicit-disposition-intervening-prompts-may-augment-suspend-or-reprioritize-but-never-substitute-the-handoff");
    assert.equal(ROOT_POLICY.steeringContinuityArchitecture.observers.chainOfThoughtAccessAllowed, false);
    assert.equal(ROOT_POLICY.runtimeLanguageArchitecture.productionAndCanonicalRunner, "node-only");
    assert.deepEqual(ROOT_POLICY.runtimeLanguageArchitecture.capabilityDetection.states,
      ["absent", "incompatible", "installed-not-activated", "qualified"]);
    assert.equal(ROOT_POLICY.runtimeLanguageArchitecture.capabilityDetection.ambientPathOnlyAbsenceAllowed, false);
    assert.equal(ROOT_POLICY.runtimeLanguageArchitecture.capabilityDetection.unqualifiedFallbackAllowed, false);
    assert.equal(ROOT_POLICY.runtimeLanguageArchitecture.capabilityDetection.currentFinding,
      "CAP-001-runtime-capability-false-absence");
    assert.equal(ROOT_POLICY.runtimeLanguageArchitecture.pythonProductCoreDependencyAllowed, false);
    assert.equal(ROOT_POLICY.runtimeLanguageArchitecture.pythonIndependentOracle.mayImportCallOrShareProductionPredicate,
      false);
    assert.equal(ROOT_POLICY.runtimeLanguageArchitecture.pythonIndependentOracle.disagreement, "fail-closed");
  },
  "S1-B15-FAILURE": () => {
    const root = makeRuntimeCandidate();
    mutateCandidateTextExact(root, ROOT_POLICY.sourcePath,
      "immutable-complete-and-addressable",
      "destructive-rolling-summary",
      "B15 destructive-summary mutant",
    );
    assert.ok(verifyS1Structure(root).violations.includes("universal-policy-root-source"));

    const thresholdRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(thresholdRoot, ROOT_POLICY.sourcePath,
      "unqualified-preregistered-candidate-cell-only-never-operational-default",
      "fixed-operational-default-for-every-model",
      "B15 fixed fifty-percent threshold mutant",
    );
    assert.ok(verifyS1Structure(thresholdRoot).violations.includes("universal-policy-root-source"));

    const docsRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(docsRoot, ROOT_POLICY.sourcePath,
      "executableOrOperationalSourceAllowed: false",
      "executableOrOperationalSourceAllowed: true",
      "B15 executable-under-docs mutant",
    );
    assert.ok(verifyS1Structure(docsRoot).violations.includes("project-layout-root-source"));

    const authoredOverrideRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(authoredOverrideRoot, ROOT_POLICY.sourcePath,
      "generatedFactOverrideAllowed: false",
      "generatedFactOverrideAllowed: true",
      "B15 bootstrap authored-override mutant",
    );
    assert.ok(verifyS1Structure(authoredOverrideRoot).violations.includes(
      "conversation-bootstrap-root-source",
    ));

    const clientAuthorityRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(clientAuthorityRoot, ROOT_POLICY.sourcePath,
      "clientOwnedPolicyOrchestrationStorageJobStateOrCommandConstructionAllowed: false",
      "clientOwnedPolicyOrchestrationStorageJobStateOrCommandConstructionAllowed: true",
      "B15 client-owned authority mutant",
    );
    assert.ok(verifyS1Structure(clientAuthorityRoot).violations.includes(
      "governed-interaction-root-source",
    ));

    const credentialFileRejectionRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(credentialFileRejectionRoot, ROOT_POLICY.sourcePath,
      "credentialPresenceAloneRejectsWholeAuthorizedText: false",
      "credentialPresenceAloneRejectsWholeAuthorizedText: true",
      "B15 whole credential-bearing text rejection mutant",
    );
    assert.ok(verifyS1Structure(credentialFileRejectionRoot).violations.includes(
      "model-repository-inspection-root-source",
    ));
  },
  "S1-B15-HOSTILE-REAL": () => {
    const vectorRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(vectorRoot, ROOT_POLICY.sourcePath,
      "hypothesis-never-assumed-best",
      "default-always-best",
      "B15 vector-default mutant",
    );
    assert.ok(verifyS1Structure(vectorRoot).violations.includes("universal-policy-root-source"));

    const mcpRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(mcpRoot, ROOT_POLICY.sourcePath,
      '["kagi", "deepwiki", "scrapling", "context7"]',
      '["kagi", "deepwiki", "context7"]',
      "B15 mandatory-MCP mutant",
    );
    assert.ok(verifyS1Structure(mcpRoot).violations.includes("universal-policy-root-source"));

    const historyRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(historyRoot, ROOT_POLICY.sourcePath,
      "destructiveSourceHistoryTrimmingAllowed: false",
      "destructiveSourceHistoryTrimmingAllowed: true",
      "B15 destructive pressure-trimming mutant",
    );
    assert.ok(verifyS1Structure(historyRoot).violations.includes("universal-policy-root-source"));

    const sizeOracleRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(sizeOracleRoot, ROOT_POLICY.sourcePath,
      "arbitraryLineFileCountOrDepthThresholdAsDesignOracleAllowed: false",
      "arbitraryLineFileCountOrDepthThresholdAsDesignOracleAllowed: true",
      "B15 arbitrary layout-size oracle mutant",
    );
    assert.ok(verifyS1Structure(sizeOracleRoot).violations.includes("project-layout-root-source"));

    const parityRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(parityRoot, ROOT_POLICY.sourcePath,
      "falsifiable-preregistered-benchmark-hypothesis-only-never-promise",
      "guaranteed-small-model-parity",
      "B15 small-model parity claim mutant",
    );
    assert.ok(verifyS1Structure(parityRoot).violations.includes("universal-policy-root-source"));

    const replayRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(replayRoot, ROOT_POLICY.sourcePath,
      "priorGreenResultCarryForwardAllowed: false",
      "priorGreenResultCarryForwardAllowed: true",
      "B15 stale green acceptance mutant",
    );
    assert.ok(verifyS1Structure(replayRoot).violations.includes("universal-policy-root-source"));

    const resumeRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(resumeRoot, ROOT_POLICY.sourcePath,
      "newestMessageReplacesUnfinishedWorkByDefault: false",
      "newestMessageReplacesUnfinishedWorkByDefault: true",
      "B15 steering-resume mutant",
    );
    assert.ok(verifyS1Structure(resumeRoot).violations.includes("steering-continuity-root-source"));

    const handoffIdentityRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(handoffIdentityRoot, ROOT_POLICY.sourcePath,
      "bind-assigned-task-subtask-attempt-and-explicit-disposition-intervening-prompts-may-augment-suspend-or-reprioritize-but-never-substitute-the-handoff",
      "latest-prompt-response-may-substitute-for-the-assigned-task-handoff",
      "B15 subagent handoff task-identity mutant",
    );
    assert.ok(verifyS1Structure(handoffIdentityRoot).violations.includes(
      "steering-continuity-root-source",
    ));

    const languageRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(languageRoot, ROOT_POLICY.sourcePath,
      "pythonProductCoreDependencyAllowed: false",
      "pythonProductCoreDependencyAllowed: true",
      "B15 Python-core mutant",
    );
    assert.ok(verifyS1Structure(languageRoot).violations.includes("runtime-language-root-source"));

    const falseAbsenceRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(falseAbsenceRoot, ROOT_POLICY.sourcePath,
      "ambientPathOnlyAbsenceAllowed: false",
      "ambientPathOnlyAbsenceAllowed: true",
      "B15 ambient-PATH absence mutant",
    );
    assert.ok(verifyS1Structure(falseAbsenceRoot).violations.includes("runtime-language-root-source"));

    const fallbackRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(fallbackRoot, ROOT_POLICY.sourcePath,
      "unqualifiedFallbackAllowed: false",
      "unqualifiedFallbackAllowed: true",
      "B15 unqualified-fallback mutant",
    );
    assert.ok(verifyS1Structure(fallbackRoot).violations.includes("runtime-language-root-source"));

    for (const [name, before, after] of [
      [
        "conversation-loop-blocking",
        "conversationLoopBlockingAllowed: false",
        "conversationLoopBlockingAllowed: true",
      ],
      [
        "semantic-authority",
        "similarityOrRetrievedContentGrantsAuthority: false",
        "similarityOrRetrievedContentGrantsAuthority: true",
      ],
      [
        "ambient-shell",
        "ambientShellConstructionOrEvaluationAllowed: false",
        "ambientShellConstructionOrEvaluationAllowed: true",
      ],
      [
        "client-self-authorization",
        "modelRetrievalOrClientMaySelfAuthorize: false",
        "modelRetrievalOrClientMaySelfAuthorize: true",
      ],
    ] as const) {
      const interactionRoot = makeRuntimeCandidate();
      mutateCandidateTextExact(interactionRoot, ROOT_POLICY.sourcePath, before, after,
        `B15 governed interaction ${name} mutant`);
      assert.ok(verifyS1Structure(interactionRoot).violations.includes(
        "governed-interaction-root-source",
      ), name);
    }

    for (const [name, before, after] of [
      [
        "unredacted-egress",
        "unredactedModelToolLogCacheIndexMemoryErrorTelemetryOrEmbeddingExposureAllowed: false",
        "unredactedModelToolLogCacheIndexMemoryErrorTelemetryOrEmbeddingExposureAllowed: true",
      ],
      [
        "semantic-before-qualification",
        "enabledBeforeQualification: false",
        "enabledBeforeQualification: true",
      ],
      [
        "semantic-recommendation-before-measurement",
        "recommendationBeforeMeasurementsAllowed: false",
        "recommendationBeforeMeasurementsAllowed: true",
      ],
      [
        "semantic-score-authority",
        "scoreMayWidenScopeSuppressExactResultsSelectStalePageOrCertifySafety: false",
        "scoreMayWidenScopeSuppressExactResultsSelectStalePageOrCertifySafety: true",
      ],
      [
        "config-weakenable-safety-floor",
        "configurableSafetyFloor: false",
        "configurableSafetyFloor: true",
      ],
    ] as const) {
      const inspectionRoot = makeRuntimeCandidate();
      mutateCandidateTextExact(inspectionRoot, ROOT_POLICY.sourcePath, before, after,
        `B15 model repository inspection ${name} mutant`);
      assert.ok(verifyS1Structure(inspectionRoot).violations.includes(
        "model-repository-inspection-root-source",
      ), name);
    }

    for (const [name, before, after] of [
      [
        "wrong-candidate-staleness",
        "any-bound-authority-identity-change-before-next-prompt-or-effect",
        "identity-change-may-remain-stale-until-convenient",
      ],
      [
        "forked-agent-view",
        "same-authorized-base-snapshot-identity-plus-gap-free-ordered-deltas-for-every-agent-and-prompt",
        "agent-local-summary-with-unordered-best-effort-updates",
      ],
      [
        "missing-code-map-authority",
        '      "repository-inventory-code-map-index-and-qualified-code-intelligence",\n',
        "",
      ],
      [
        "tool-schema-health-drift",
        '      "tool-mcp-capability-and-health-registry",\n',
        "",
      ],
      [
        "wrong-repository-or-partial-inventory-accepted",
        "stale-missing-wrong-repository-partial-concurrent-contradictory-delta-gap-or-recovery-uncertain-fails-closed",
        "stale-only-fails-closed-other-invalid-states-continue",
      ],
    ] as const) {
      const bootstrapRoot = makeRuntimeCandidate();
      mutateCandidateTextExact(bootstrapRoot, ROOT_POLICY.sourcePath, before, after,
        `B15 bootstrap ${name} mutant`);
      assert.ok(verifyS1Structure(bootstrapRoot).violations.includes(
        "conversation-bootstrap-root-source",
      ), name);
    }
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
