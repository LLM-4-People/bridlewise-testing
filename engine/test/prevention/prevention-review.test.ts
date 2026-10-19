import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  parseFormalFindingFact,
  verifyPreventionReview,
  type PreventionClass,
  type PreventionIncidentExpectation,
  type PreventionReviewFacts,
  type PreventionSourceFact,
} from "../../scripts/tooling/verification/prevention-review.ts";
import { ARCHITECTURE_MANIFEST } from "../../src/architecture-manifest.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REVIEW_PATH = join(ROOT, "traceability/prevention/prevention-retrospective.json");
const REVIEW_DOC_PATH = join(ROOT, "docs/research/verification/prevention-retrospective.md");
const FINDINGS_ROOT = join(ROOT, "traceability/findings");
const AUTHORITY_AUDIT_SOURCE_ID = "source:authority-graph-independent-final-audit";
const AUTHORITY_AUDIT_INCIDENT_IDS = [
  "INC-STATIC-AUTHORITY-ANALYZER-MISSING",
  "INC-TEST-FIXTURE-SHAPE-DUPLICATION",
  "INC-FORMAL-FOUNDATION-006",
  "INC-CURRENT-SCHEMA-VERSION-LITERAL-DUPLICATION",
] as const;
const HANDOFF_CONTINUITY_OCCURRENCE_BUNDLE = {
  schemaVersion: "bridlewise-handoff-continuity-occurrence-bundle/v1",
  handoffContinuityOccurrences: [
    occurrence("/root/context_structure_governance", 1, "received-after-resume"),
    occurrence("/root/secret_mwa_final_review", 1, "received-after-resume"),
    occurrence("/root/portable_path_authority", 1, "superseded-by-another-rejected-proposal"),
    occurrence("/root/portable_path_authority", 2, "received-after-resume"),
    occurrence("/root/cascade_independent_review", 1, "received-after-resume"),
    occurrence("/root/portable_shared_independent_review", 1, "received-after-resume"),
    occurrence("/root/handoff_continuity_gate_design", 1, "superseded-by-another-rejected-proposal"),
    occurrence("/root/handoff_continuity_gate_design", 2, "received-after-resume"),
  ],
} as const;

type MutableDocument = {
  sourceManifest: Array<Record<string, unknown>>;
  rows: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

const EXPECTED_CLASSES: Readonly<Record<string, readonly PreventionClass[]>> = {
  "INC-FORMAL-ARCH-001": ["centrally-prevented-narrowly", "prevention-missing", "capability-unavailable"],
  "INC-FORMAL-CAP-001": ["centrally-prevented-narrowly", "capability-unavailable"],
  "INC-FORMAL-COORD-001": ["capability-unavailable"],
  "INC-FORMAL-FOUNDATION-001": ["centrally-prevented-narrowly", "capability-unavailable"],
  "INC-FORMAL-FOUNDATION-002": ["centrally-prevented-narrowly", "prevention-missing", "capability-unavailable"],
  "INC-FORMAL-FOUNDATION-003": ["centrally-prevented-narrowly", "capability-unavailable"],
  "INC-FORMAL-FOUNDATION-004": ["centrally-prevented-narrowly", "capability-unavailable"],
  "INC-FORMAL-FOUNDATION-005": ["prevention-missing"],
  "INC-FORMAL-SEC-001": ["capability-unavailable"],
  "INC-REPO-001": ["centrally-prevented-narrowly"],
  "INC-REPO-002": ["prevention-missing"],
  "INC-REPO-003": ["centrally-prevented-narrowly", "prevention-missing"],
  "INC-REPO-004": ["capability-unavailable"],
  "INC-REPO-005": ["capability-unavailable"],
  "INC-REPO-006": ["centrally-prevented-narrowly", "capability-unavailable"],
  "INC-REPO-007": ["centrally-prevented-narrowly"],
  "INC-REPO-008": ["centrally-prevented-narrowly", "capability-unavailable"],
  "INC-REPO-009": ["centrally-prevented-narrowly"],
  "INC-REPO-010": ["centrally-prevented-narrowly"],
  "INC-REPO-011": ["centrally-prevented-narrowly"],
  "INC-REPO-012": ["centrally-prevented-narrowly", "capability-unavailable"],
  "INC-REPO-013": ["centrally-prevented-narrowly"],
  "INC-REPO-014": ["centrally-prevented-narrowly"],
  "INC-REPO-015": ["centrally-prevented-narrowly", "prevention-missing"],
  "INC-REPO-016": ["capability-unavailable"],
  "INC-REPO-017": ["capability-unavailable"],
  "INC-REPO-018": ["centrally-prevented-narrowly", "exact-history-unrecoverable"],
  "INC-REPO-019": ["centrally-prevented-narrowly", "capability-unavailable"],
  "INC-REPO-020": ["capability-unavailable"],
  "INC-REPO-021": ["centrally-prevented-narrowly", "prevention-missing"],
  "INC-ARCH-001": ["centrally-prevented-narrowly", "prevention-missing"],
  "INC-ARCH-002": ["prevention-missing"],
  "INC-ARCH-003": ["prevention-missing"],
  "INC-ARCH-004": ["prevention-missing"],
  "INC-ARCH-005": ["prevention-missing"],
  "INC-ARCH-006": ["prevention-missing"],
  "INC-ARCH-007": ["prevention-missing", "capability-unavailable"],
  "INC-ARCH-008": ["prevention-missing"],
  "INC-ARCH-009": ["centrally-prevented-narrowly", "prevention-missing"],
  "INC-ARCH-010": ["prevention-missing"],
  "INC-ARCH-011": ["centrally-prevented-narrowly", "prevention-missing"],
  "INC-ARCH-012": ["centrally-prevented-narrowly", "capability-unavailable"],
  "INC-ARCH-013": ["centrally-prevented-narrowly", "capability-unavailable"],
  "INC-ARCH-014": ["prevention-missing"],
  "INC-ARCH-015": ["centrally-prevented-narrowly", "capability-unavailable"],
  "INC-ARCH-016": ["exact-history-unrecoverable", "capability-unavailable"],
  "INC-ARCH-017": ["capability-unavailable"],
  "INC-ARCH-018": ["capability-unavailable"],
  "INC-ARCH-019": ["centrally-prevented-narrowly", "capability-unavailable"],
  "INC-ARCH-020": ["capability-unavailable"],
  "INC-ARCH-021": ["capability-unavailable"],
  "INC-CONFIG-JSONSCHEMA-STRICT-TYPE": ["centrally-prevented-narrowly", "prevention-missing"],
  "INC-STATIC-AUTHORITY-ANALYZER-MISSING": ["centrally-prevented-narrowly", "prevention-missing"],
  "INC-TRANSACTIONAL-EDIT-PREAPPLY-GAP": ["prevention-missing", "capability-unavailable"],
  "INC-TEST-RESULT-RUNNER-FACTS-OMITTED": ["prevention-missing"],
  "INC-TEST-SURFACE-SILENT-OMISSION": ["prevention-missing"],
  "INC-TEST-ROOT-SCOPE-OMISSION": ["prevention-missing"],
  "INC-TEST-POST-CANDIDATE-BOUND-AS-TESTED": ["prevention-missing", "capability-unavailable"],
  "INC-HISTORY-CORPUS-COMPLETENESS": ["capability-unavailable", "exact-history-unrecoverable"],
  "INC-TEST-FIXTURE-SHAPE-DUPLICATION": ["centrally-prevented-narrowly", "prevention-missing"],
  "INC-TEST-SURFACE-COMPLETENESS-CONFLATION": ["centrally-prevented-narrowly", "prevention-missing"],
  "INC-CURRENT-SCHEMA-VERSION-LITERAL-DUPLICATION": ["centrally-prevented-narrowly", "prevention-missing"],
  "INC-PREVENTION-REVIEW-NOT-AUTOMATIC": ["prevention-missing"],
  "INC-USER-DIRECTIVE-LOCAL-NARROWING": ["prevention-missing"],
  "INC-TEST-FIXTURE-OWNER-CLEANUP-RACE": ["centrally-prevented-narrowly", "capability-unavailable"],
  "INC-FOUNDATION-CASCADE-COMPILER-MISSING": ["prevention-missing", "capability-unavailable"],
  "INC-CONVERSATION-BOOTSTRAP-COMPILER-MISSING": ["prevention-missing", "capability-unavailable"],
  "INC-MODEL-FILE-INSPECTION-GATEWAY-MISSING": ["prevention-missing", "capability-unavailable"],
};

const REPORT_ONE_INCIDENTS = [
  "INC-FORMAL-ARCH-001", "INC-FORMAL-CAP-001", "INC-FORMAL-COORD-001", "INC-FORMAL-FOUNDATION-001",
  "INC-FORMAL-FOUNDATION-002", "INC-FORMAL-FOUNDATION-003", "INC-FORMAL-FOUNDATION-004",
  "INC-FORMAL-FOUNDATION-005", "INC-FORMAL-SEC-001",
];
const REPORT_TWO_INCIDENTS = [
  ...numbered("INC-REPO", 21),
  "INC-TEST-POST-CANDIDATE-BOUND-AS-TESTED", "INC-TEST-RESULT-RUNNER-FACTS-OMITTED",
  "INC-TEST-ROOT-SCOPE-OMISSION", "INC-TEST-SURFACE-COMPLETENESS-CONFLATION",
  "INC-TEST-SURFACE-SILENT-OMISSION",
];
const REPORT_THREE_INCIDENTS = [...numbered("INC-ARCH", 21), "INC-HISTORY-CORPUS-COMPLETENESS"];

const ADDITIONAL_SOURCES: readonly PreventionSourceFact[] = [
  source("source:apply-patch-live-worktree-gap", "current-builder-capability-observation", "platform-tool:apply_patch",
    "available-unadmitted-observation", "mutates-live-worktree-before-validation",
    ["INC-TRANSACTIONAL-EDIT-PREAPPLY-GAP"],
    "This observation establishes a builder gap only; it is not a qualification of a future editor."),
  source("source:mwa-author-receipt-builder-effect-gap", "reproduced-command-effect-default-incident",
    "verification/benchmarks/coordination/migration-write-authority/build-author-receipt.mjs",
    "available-unadmitted-observation", "default-write-reproduced-and-narrowly-failed-closed",
    ["INC-FORMAL-FOUNDATION-004"],
    "The shared contract and x3 regression prove only this bounded builder/default boundary; production MWA publication and all-producer migration remain unavailable."),
  source("source:config-ajv-strict-type-incident", "reproduced-generated-consumer-incident",
    "src/config-contracts.ts;test/config-contracts.test.ts;traceability/config-document-schema.json",
    "available-unadmitted-observation", "author-reproduced-ajv-8.20.0-strictTypes",
    ["INC-CONFIG-JSONSCHEMA-STRICT-TYPE"], "Author x3 evidence only; no independent candidate-host replay exists."),
  source("source:first-broad-test-receipt", "lost-execution-receipt", "/tmp/bridlewise-format-guard-receipt-1.json",
    "unavailable-exact-bytes", "unavailable-not-reconstructed", ["INC-REPO-018"],
    "The exact bytes are lost and must never be reconstructed or represented as recovered evidence."),
  source("source:historical-event-ledger", "missing-canonical-capability",
    "not-created:canonical-event-tool-attempt-ledger", "unavailable-exact-bytes", "unavailable-not-reconstructed",
    ["INC-HISTORY-CORPUS-COMPLETENESS"],
    "No historical ledger exists; never reconstruct literal completeness from reports, Git, or model context."),
  source("source:lost-plan-epoch-e04f9349", "lost-superseded-plan-epoch",
    "historical-sha256:e04f93499e5304b7647c04cd1e5b11a7fcc27cab2e6edf8bca93e703df7b4eb9",
    "unavailable-exact-bytes", "unavailable-not-reconstructed", ["INC-ARCH-016"],
    "The old plan bytes are lost and must never be reconstructed or have their digest reused."),
  source("source:mixed-live-worktree", "live-repository-epoch", "workspace:/home/example/bridlewise",
    "mixed-changing-epoch", "unfrozen-concurrent-writers-no-broker-lease",
    ["INC-ARCH-015", "INC-HISTORY-CORPUS-COMPLETENESS", "INC-TEST-POST-CANDIDATE-BOUND-AS-TESTED"],
    "Observations may drift between reads; no literal historical completeness or stable-review claim follows."),
  source("source:replay-report-part-1", "delegated-read-only-retrospective",
    "collaboration-message:/root/foundation_independent_replay:part-1-of-3",
    "available-unadmitted-agent-report", "available-current-turn-not-repository-admitted", REPORT_ONE_INCIDENTS,
    "The report is a current input to this retrospective, not independent acceptance or literal historical enumeration."),
  source("source:replay-report-part-2", "delegated-read-only-retrospective",
    "collaboration-message:/root/foundation_independent_replay:part-2-of-3-and-addenda",
    "available-unadmitted-agent-report", "available-current-turn-not-repository-admitted", REPORT_TWO_INCIDENTS,
    "The report is a current input to this retrospective, not independent acceptance or literal historical enumeration."),
  source("source:replay-report-part-3", "delegated-read-only-retrospective",
    "collaboration-message:/root/foundation_independent_replay:part-3-of-3",
    "available-unadmitted-agent-report", "available-current-turn-not-repository-admitted", REPORT_THREE_INCIDENTS,
    "The report is a current input to this retrospective, not independent acceptance or literal historical enumeration."),
  source("source:static-authority-bounded-scan", "manual-bounded-static-scan",
    "bounded-rg:module-local-behavior-literals-2026-07-12", "available-unadmitted-observation",
    "manual-scan-not-deterministic-prevention",
    ["INC-CURRENT-SCHEMA-VERSION-LITERAL-DUPLICATION", "INC-PREVENTION-REVIEW-NOT-AUTOMATIC", "INC-STATIC-AUTHORITY-ANALYZER-MISSING",
      "INC-TEST-FIXTURE-SHAPE-DUPLICATION"],
    "The scan found examples but is not exhaustive and must not be represented as an automated authority check."),
  source(AUTHORITY_AUDIT_SOURCE_ID, "delegated-read-only-independent-audit",
    "docs/research/verification/authority-graph-hardening-report.md#independent-final-audit--separate-current-byte-replay",
    "available-unadmitted-agent-report",
    "bounded-typescript-analyzer-replayed-with-open-foundation-blockers",
    AUTHORITY_AUDIT_INCIDENT_IDS,
    "The independent current-byte replay proves only the supplied TypeScript inputs and 93 diagnostic rows; it does not admit the changing worktree, qualify the adapter or broker, prove repository completeness, or establish readiness."),
  source("source:live-user-universal-prevention-steering", "current-user-steering-normalized-requirement-input",
    "conversation:2026-07-12:universal-applicability-and-automatic-prevention-review",
    "available-unadmitted-observation", "normalized-current-turn-pending-canonical-requirements-projection",
    ["INC-PREVENTION-REVIEW-NOT-AUTOMATIC", "INC-USER-DIRECTIVE-LOCAL-NARROWING"],
    "The normalized source records the directive but is not satisfied until canonical requirements, applicability expansion and deterministic gates are bound."),
  source("source:concurrent-test-fixture-cleanup-review", "delegated-concurrency-review-observation",
    "collaboration-message:/root/architecture_effects_writer:repository-local-temporary-cleanup-race",
    "available-unadmitted-agent-report", "reproduced-design-race-repaired-narrowly",
    ["INC-TEST-FIXTURE-OWNER-CLEANUP-RACE"],
    "Per-owner cleanup is repaired and hostile-tested, but coordinated crash-stale sweeping and broker leases remain unavailable."),
  source("source:s1-combined-replay-prevention-classification", "reproduced-combined-replay-prevention-classification",
    "collaboration-message:/root/architecture_effects_writer:s1-combined-current-byte-replay",
    "available-unadmitted-agent-report", "reproduced-narrow-repairs-with-open-universal-owners",
    ["INC-FORMAL-ARCH-001", "INC-ARCH-009", "INC-ARCH-015"],
    "The current S1 x3 replay proves only the narrow exact-mutation, subtree, baseline-delta and runtime-closure repairs; DER-038-wide compilers, gates and independent replay remain open."),
  source("source:tainted-history-transcript", "confidentiality-tainted-tool-transcript",
    "prohibited:SEC-001-affected-tool-transcript", "prohibited-confidentiality-tainted",
    "prohibited-no-content-use", ["INC-FORMAL-SEC-001"],
    "No content from this tainted source may be used, summarized, or reconstructed; only the governed incident disposition is retained."),
  source("source:temporary-and-author-only-evidence", "noncanonical-ephemeral-evidence-class",
    "historical:/tmp-and-author-x3-command-output", "unavailable-exact-bytes", "unavailable-not-reconstructed",
    ["INC-HISTORY-CORPUS-COMPLETENESS"],
    "Unretained temporary output must never be reconstructed or promoted to independent canonical evidence."),
  source("source:foundation-regeneration-dag-current-observation", "current-builder-capability-observation",
    "docs/architecture/foundation-regeneration-dag.md", "available-unadmitted-observation",
    "transactional-foundation-cascade-compiler-unavailable", ["INC-FOUNDATION-CASCADE-COMPILER-MISSING"],
    "The current mixed-epoch DAG observation identifies a missing transactional compiler and publication boundary; it is not implementation, qualification, or readiness evidence."),
  source("source:der-039-conversation-bootstrap-current-requirement", "current-governed-derived-control",
    "traceability/requirements.json#DER-039", "available-governed-current",
    "specified-open-blocking-runtime-unavailable", ["INC-CONVERSATION-BOOTSTRAP-COMPILER-MISSING"],
    "DER-039 establishes governed intent only; no executable compiler, live invalidation, transactional publication, hostile qualification, or readiness claim follows."),
  source("source:der-041-model-file-inspection-current-requirement", "current-governed-derived-control",
    "traceability/requirements.json#DER-041", "available-governed-current",
    "specified-open-blocking-model-file-inspection-runtime-unavailable",
    ["INC-MODEL-FILE-INSPECTION-GATEWAY-MISSING"],
    "DER-041 governs the target protocol only; no executable model-facing inspection/redaction gateway, bounded pattern engine, semantic qualification, hostile evidence, or readiness claim follows."),
  source("source:der-042-progressive-context-layout-scaffolding-current-requirement",
    "current-governed-derived-control", "traceability/requirements.json#DER-042",
    "available-governed-current",
    "specified-open-blocking-progressive-context-layout-scaffolding-and-replay-runtime-unavailable",
    ["INC-FORMAL-ARCH-001", "INC-ARCH-017", "INC-ARCH-018", "INC-ARCH-021",
      "INC-PREVENTION-REVIEW-NOT-AUTOMATIC"],
    "DER-042 strengthens existing owners and claim boundaries only; no executable progressive-pressure planner, complete layout admission, small-model parity result, automatic delegation supervisor, full prior-regression replay, promotion replay, or readiness claim follows."),
  source("source:current-subagent-steering-task-continuity-recurrence",
    "current-builder-observed-prevention-recurrence",
    "handoff-continuity-occurrences:taskPath+withinTaskAttemptOrdinal",
    "available-unadmitted-observation",
    "eight-wrong-subject-proposals-latest-two-stale-reddit-emissions-one-resumed-task-episode-bound-to-existing-continuity-incident",
    ["INC-ARCH-013"],
    "Only task path and within-task attempt ordinal were exposed as occurrence locators; runtime attempt IDs must remain unavailable-not-generated. Version 1 therefore records the latest one resumed-task episode as two proposal ordinals: a stale Reddit-summary MESSAGE rejected and explicitly resumed, followed by the same stale subject as FINAL, also rejected and explicitly resumed; the corrected task-specific result for ordinal 2 was received only after the later classifier interruption was separately resumed. The eight records demonstrate the existing steering/task-continuity failure class only; version 1 cannot encode either the episode relationship or the separate interruption lifecycle, and they are not a new requirement, an exhaustive reproduction, runtime implementation, qualification, or closure evidence.",
    HANDOFF_CONTINUITY_OCCURRENCE_BUNDLE),
];

test("current prevention retrospective covers every supplied formal, architecture and incident fact", () => {
  const document = loadDocument();
  const result = verifyPreventionReview(document, currentFacts());
  assert.deepEqual(result.violations, []);
  assert.deepEqual(combinedReplayClassificationViolations(document), []);
  assert.equal(result.valid, true);
});

test("foundation, conversation and model-file gateways remain separate unavailable prevention owners", () => {
  const document = loadDocument();
  const foundation = findRow(document, "INC-FOUNDATION-CASCADE-COMPILER-MISSING");
  const conversation = findRow(document, "INC-CONVERSATION-BOOTSTRAP-COMPILER-MISSING");
  const inspection = findRow(document, "INC-MODEL-FILE-INSPECTION-GATEWAY-MISSING");
  assert.equal(object(foundation.centralizedOwner).ownerId, "foundation-cascade-compiler");
  assert.equal(object(conversation.centralizedOwner).ownerId, "conversation-bootstrap");
  assert.equal(object(inspection.centralizedOwner).ownerId, "model-facing-repository-inspection");
  assert.equal(object(foundation.hostileRegression).id,
    "foundation-cascade-closure-publication-recovery-x3");
  assert.equal(object(conversation.hostileRegression).id,
    "conversation-bootstrap-input-invalidation-delta-recovery-x3");
  assert.equal(object(inspection.hostileRegression).id,
    "model-file-inspection-redaction-search-reconstruction-x3");
  assert.equal(object(foundation.prevention).status, "capability-unavailable");
  assert.equal(object(conversation.prevention).status, "capability-unavailable");
  assert.equal(object(inspection.prevention).status, "capability-unavailable");
  assert.match(JSON.stringify([
    inspection.boundary,
    inspection.remainingClosureEvidence,
    inspection.claimLimits,
  ]), /credential presence alone must not reject authorized supported text/iu);

  const cap = findRow(document, "INC-FORMAL-CAP-001");
  const capText = JSON.stringify([
    cap.boundary,
    cap.hostileRegression,
    cap.remainingClosureEvidence,
    cap.claimLimits,
    cap.researchQualificationPath,
  ]);
  for (const required of [
    "parent PATH/environment receipt",
    "authorized candidate probe command",
    "undeclared paths, shadows, symlinks, worker inheritance, TOCTOU and environment tamper",
    "no alternate executable is spawned",
  ]) assert.match(capText, new RegExp(required.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("DER-042 and the current steering recurrence extend existing prevention owners without claiming closure", () => {
  const document = loadDocument();
  assert.equal(document.schemaVersion, "bridlewise-prevention-review/v2");
  const der042Source = document.sourceManifest.find((entry) =>
    entry.id === "source:der-042-progressive-context-layout-scaffolding-current-requirement"
  );
  assert.ok(der042Source);
  assert.deepEqual(der042Source.incidentIds,
    ["INC-FORMAL-ARCH-001", "INC-ARCH-017", "INC-ARCH-018", "INC-ARCH-021",
      "INC-PREVENTION-REVIEW-NOT-AUTOMATIC"]);
  assert.match(String(der042Source.claimLimit), /no executable progressive-pressure planner/iu);

  const recurrenceSource = document.sourceManifest.find((entry) =>
    entry.id === "source:current-subagent-steering-task-continuity-recurrence"
  );
  assert.ok(recurrenceSource);
  assert.deepEqual(recurrenceSource.incidentIds, ["INC-ARCH-013"]);
  const bundle = object(recurrenceSource.handoffContinuityOccurrenceBundle);
  assert.equal(bundle.schemaVersion, "bridlewise-handoff-continuity-occurrence-bundle/v1");
  const bundledOccurrences = bundle.handoffContinuityOccurrences;
  assert.ok(Array.isArray(bundledOccurrences));
  assert.deepEqual(bundledOccurrences, HANDOFF_CONTINUITY_OCCURRENCE_BUNDLE.handoffContinuityOccurrences);
  assert.equal(
    bundledOccurrences.length,
    HANDOFF_CONTINUITY_OCCURRENCE_BUNDLE.handoffContinuityOccurrences.length,
  );

  const continuity = findRow(document, "INC-ARCH-013");
  assert.ok(Array.isArray(continuity.sourceRefs) &&
    continuity.sourceRefs.includes("source:current-subagent-steering-task-continuity-recurrence"));
  assert.match(JSON.stringify([
    continuity.hostileRegression,
    continuity.remainingClosureEvidence,
  ]), /context_structure_governance.*secret_mwa_final_review.*portable_path_authority.*cascade_independent_review/iu);
  assert.equal(object(continuity.prevention).status, "implemented-narrow-boundary");
});

test("prevention v2 occurrence bundle rejects conflation and fabricated runtime identities x3", () => {
  const mutations: ReadonlyArray<Readonly<{
    mutate: (document: MutableDocument) => void;
    expected: string;
  }>> = [
    {
      mutate: (document) => { document.schemaVersion = "bridlewise-prevention-review/v1"; },
      expected: "review-schema-version-invalid",
    },
    {
      mutate: (document) => {
        delete continuitySource(document).handoffContinuityOccurrenceBundle;
      },
      expected: "handoff-continuity-occurrence-bundle-must-be-object",
    },
    {
      mutate: (document) => {
        const occurrences = continuityOccurrences(document);
        occurrences[3]!.withinTaskAttemptOrdinal = 1;
      },
      expected: "handoff-continuity-occurrence-locator-duplicate:/root/portable_path_authority:1",
    },
    {
      mutate: (document) => {
        continuityOccurrences(document)[0]!.runtimeAttemptId = "fabricated-stable-attempt-id";
      },
      expected: "runtime-attempt-id-must-remain-unavailable",
    },
    {
      mutate: (document) => {
        continuityOccurrences(document)[2]!.correctedResultState = "received-after-resume";
      },
      expected: "source-fact-drift:source:current-subagent-steering-task-continuity-recurrence",
    },
    {
      mutate: (document) => {
        continuityOccurrences(document)[0]!.messageId = "not-exposed";
      },
      expected: "handoff-continuity-occurrence-0-keys-invalid",
    },
  ];
  for (let repetition = 0; repetition < 3; repetition += 1) {
    for (const [index, mutation] of mutations.entries()) {
      const document = loadDocument();
      mutation.mutate(document);
      const result = verifyPreventionReview(document, currentFacts());
      assert.equal(result.valid, false, `continuity mutation ${index} repetition ${repetition} false-greened`);
      assert.ok(result.violations.some((violation) => violation.includes(mutation.expected)),
        `continuity mutation ${index} repetition ${repetition} missed ${mutation.expected}: ${result.violations.join(",")}`);
    }
  }
});

test("authority audit reuses existing owners while preserving narrow and universal limits", () => {
  const document = loadDocument();
  const auditSource = document.sourceManifest.find((entry) => entry.id === AUTHORITY_AUDIT_SOURCE_ID);
  assert.ok(auditSource);
  assert.deepEqual(auditSource.incidentIds, AUTHORITY_AUDIT_INCIDENT_IDS);

  for (const incidentId of AUTHORITY_AUDIT_INCIDENT_IDS) {
    const row = findRow(document, incidentId);
    assert.ok(Array.isArray(row.sourceRefs) && row.sourceRefs.includes(AUTHORITY_AUDIT_SOURCE_ID));
  }

  const staticAnalyzer = findRow(document, "INC-STATIC-AUTHORITY-ANALYZER-MISSING");
  assert.deepEqual(staticAnalyzer.classifications, ["centrally-prevented-narrowly", "prevention-missing"]);
  const staticPrevention = object(staticAnalyzer.prevention);
  assert.equal(staticPrevention.status, "implemented-narrow-boundary");
  assert.match(JSON.stringify(staticPrevention.preventedScope), /exact supplied TypeScript/);

  for (const incidentId of [
    "INC-TEST-FIXTURE-SHAPE-DUPLICATION",
    "INC-CURRENT-SCHEMA-VERSION-LITERAL-DUPLICATION",
  ]) {
    assert.deepEqual(findRow(document, incidentId).classifications,
      ["centrally-prevented-narrowly", "prevention-missing"]);
  }

  const foundation = findRow(document, "INC-FORMAL-FOUNDATION-006");
  assert.deepEqual(foundation.classifications, ["prevention-missing", "capability-unavailable"]);
  assert.equal(object(foundation.prevention).status, "capability-unavailable");
  const foundationEvidence = JSON.stringify([
    foundation.remainingClosureEvidence,
    foundation.claimLimits,
  ]);
  for (const requiredLimit of [
    "authority_source_inventory_untrusted",
    "authority_universe_attestation_untrusted",
    "authority_adapter_qualification_untrusted:typescript",
    "authority_derivation_inventory_unavailable",
    "runtime-derived-literal",
    "module-resolution",
    "metadata-normalization",
    "dynamic-import",
  ]) {
    assert.match(foundationEvidence, new RegExp(requiredLimit));
  }
});

test("source and incident coverage hostile family rejects four distinct mutants x3", () => {
  const mutations = [
    (document: MutableDocument) => document.sourceManifest.splice(0, 1),
    (document: MutableDocument) => document.sourceManifest.push(structuredClone(document.sourceManifest[0]!)),
    (document: MutableDocument) => document.rows.splice(
      document.rows.findIndex((row) => row.id === "INC-FORMAL-FOUNDATION-005"), 1,
    ),
    (document: MutableDocument) => document.rows.push(structuredClone(document.rows[0]!)),
  ];
  repeatMutations(mutations, ["source-omitted", "source-duplicate", "incident-omitted", "row-duplicate"]);
});

test("preventive-disposition hostile family rejects false CP, empty research and model vigilance x3", () => {
  const mutations = [
    (document: MutableDocument) => {
      const row = findRow(document, "INC-STATIC-AUTHORITY-ANALYZER-MISSING");
      row.classifications = ["centrally-prevented-narrowly"];
    },
    (document: MutableDocument) => {
      findRow(document, "INC-TRANSACTIONAL-EDIT-PREAPPLY-GAP").researchQualificationPath = [];
    },
    (document: MutableDocument) => {
      const owner = object(findRow(document, "INC-ARCH-003").centralizedOwner);
      owner.reuseTargets = ["LLM vigilance"];
    },
  ];
  repeatMutations(mutations, ["row-classification-false-or-drifted", "research-qualification-path", "model-vigilance-only"]);
});

test("unavailable evidence, review and closure hostile family rejects four distinct mutants x3", () => {
  const mutations = [
    (document: MutableDocument) => {
      const sourceEntry = document.sourceManifest.find((entry) => entry.id === "source:first-broad-test-receipt")!;
      sourceEntry.observedStatus = "reconstructed-equivalent";
    },
    (document: MutableDocument) => {
      const review = object(findRow(document, "INC-FORMAL-SEC-001").review);
      review.state = "independently-reviewed";
      review.reviewerActorId = "prevention-retrospective-writer";
    },
    (document: MutableDocument) => {
      const prevention = object(findRow(document, "INC-REPO-001").prevention);
      prevention.preventedScope = [];
    },
    (document: MutableDocument) => {
      const review = object(findRow(document, "INC-FORMAL-FOUNDATION-005").review);
      review.state = "closed";
      review.reviewerActorId = "independent-reviewer";
    },
  ];
  repeatMutations(mutations, ["unavailable-source-disposition-invalid", "row-self-approved",
    "false-central-prevention-empty-scope", "row-closed-with-open-prevention-or-evidence"]);
});

test("combined-replay prevention owners are auto-discovered and reject missing or no-op coverage x3", () => {
  const mutations: ReadonlyArray<Readonly<{
    mutate: (document: MutableDocument) => void;
    expected: string;
  }>> = [
    {
      mutate: (document) => document.sourceManifest.splice(
        document.sourceManifest.findIndex((entry) =>
          entry.id === "source:s1-combined-replay-prevention-classification"),
        1,
      ),
      expected: "source-omitted",
    },
    {
      mutate: (document) => {
        const refs = findRow(document, "INC-ARCH-009").sourceRefs as string[];
        refs.splice(refs.indexOf("source:s1-combined-replay-prevention-classification"), 1);
      },
      expected: "combined-source-owner-link-missing:INC-ARCH-009",
    },
    {
      mutate: (document) => {
        const regression = object(findRow(document, "INC-ARCH-009").hostileRegression);
        regression.cases = ["ordinary policy mutation", "ordinary policy mutation two", "ordinary policy mutation three"];
      },
      expected: "exact-mutation-no-op-regression-missing",
    },
    {
      mutate: (document) => {
        const applicability = object(findRow(document, "INC-ARCH-015").applicability);
        applicability.surfaces = (applicability.surfaces as string[]).filter((surface) => surface !== "providers");
      },
      expected: "der-038-surface-missing:INC-ARCH-015:providers",
    },
  ];
  for (let repetition = 0; repetition < 3; repetition += 1) {
    for (const [index, mutation] of mutations.entries()) {
      const document = loadDocument();
      mutation.mutate(document);
      const violations = [
        ...verifyPreventionReview(document, currentFacts()).violations,
        ...combinedReplayClassificationViolations(document),
      ];
      assert.ok(violations.some((violation) => violation.includes(mutation.expected)),
        `combined mutation ${index} repetition ${repetition} missed ${mutation.expected}: ${violations.join(",")}`);
    }
  }
});

test("prevention Markdown defers live counts to the canonical retrospective", () => {
  const document = loadDocument();
  const markdown = readFileSync(REVIEW_DOC_PATH, "utf8");
  const count = (classification: PreventionClass) => document.rows.filter((row) =>
    Array.isArray(row.classifications) && row.classifications.includes(classification)
  ).length;
  const derivedCounts = Object.freeze({
    rows: document.rows.length,
    sources: document.sourceManifest.length,
    centrallyPreventedNarrowly: count("centrally-prevented-narrowly"),
    preventionMissing: count("prevention-missing"),
    capabilityUnavailable: count("capability-unavailable"),
    exactHistoryUnrecoverable: count("exact-history-unrecoverable"),
  });
  assert.ok(Object.values(derivedCounts).every((value) => value > 0));
  assert.ok(markdown.includes("all current incident rows and manifested source"));
  assert.ok(markdown.includes("classification totals are derived from the canonical rows"));
  for (const redundantNumericClaim of [
    /\b\d+ incident rows backed by \d+ manifested source/u,
    /\b\d+ rows have a narrowly/u,
    /\b\d+ retain missing deterministic prevention/u,
    /\b\d+ require an\s+unavailable central capability/u,
    /\b\d+ preserve unrecoverable exact history/u,
  ]) {
    assert.doesNotMatch(markdown, redundantNumericClaim);
  }
});

function currentFacts(): PreventionReviewFacts {
  const formalFindings = readdirSync(FINDINGS_ROOT, { encoding: "utf8" })
    .filter((name) => name.endsWith(".md"))
    .toSorted()
    .map((name) => {
      const relativePath = `traceability/findings/${name}`;
      return parseFormalFindingFact(relativePath, readFileSync(join(FINDINGS_ROOT, name), "utf8"));
    });
  const architectureFindings = ARCHITECTURE_MANIFEST.findings.map((finding) => ({
    id: finding.id,
    status: finding.status,
  }));
  const incidentExpectations: PreventionIncidentExpectation[] = Object.entries(EXPECTED_CLASSES)
    .map(([id, classifications]) => ({ id, classifications }));
  return { formalFindings, architectureFindings, additionalSources: ADDITIONAL_SOURCES, incidentExpectations };
}

function loadDocument(): MutableDocument {
  return JSON.parse(readFileSync(REVIEW_PATH, "utf8")) as MutableDocument;
}

function combinedReplayClassificationViolations(document: MutableDocument): string[] {
  const violations: string[] = [];
  const sourceFact = ADDITIONAL_SOURCES.find((sourceEntry) =>
    sourceEntry.id === "source:s1-combined-replay-prevention-classification"
  );
  assert.ok(sourceFact);
  for (const incidentId of sourceFact.incidentIds) {
    const refs = findRow(document, incidentId).sourceRefs;
    if (!Array.isArray(refs) || !refs.includes(sourceFact.id)) {
      violations.push(`combined-source-owner-link-missing:${incidentId}`);
    }
  }

  const universalApplicability = object(findRow(document, "INC-USER-DIRECTIVE-LOCAL-NARROWING").applicability);
  const requiredSurfaces = universalApplicability.surfaces as string[];
  for (const incidentId of sourceFact.incidentIds) {
    const applicability = object(findRow(document, incidentId).applicability);
    const surfaces = Array.isArray(applicability.surfaces) ? applicability.surfaces : [];
    for (const surface of requiredSurfaces) {
      if (!surfaces.includes(surface)) violations.push(`der-038-surface-missing:${incidentId}:${surface}`);
    }
  }

  const policyCases = object(findRow(document, "INC-ARCH-009").hostileRegression).cases;
  const policyCaseText = Array.isArray(policyCases) ? policyCases.join(" ").toLocaleLowerCase("en-US") : "";
  if (!["zero-match", "multiple-match", "identical"].every((term) => policyCaseText.includes(term))) {
    violations.push("exact-mutation-no-op-regression-missing");
  }
  if (!["steering", "runtime-language"].every((term) => policyCaseText.includes(term))) {
    violations.push("policy-subtree-owner-regression-missing");
  }

  const epochCases = object(findRow(document, "INC-ARCH-015").hostileRegression).cases;
  const epochCaseText = Array.isArray(epochCases) ? epochCases.join(" ").toLocaleLowerCase("en-US") : "";
  if (!["stale inventory", "legitimate standalone"].every((term) => epochCaseText.includes(term))) {
    violations.push("baseline-projection-delta-regression-missing");
  }

  const graphCases = object(findRow(document, "INC-FORMAL-ARCH-001").hostileRegression).cases;
  const graphCaseText = Array.isArray(graphCases) ? graphCases.join(" ").toLocaleLowerCase("en-US") : "";
  if (!["verification-only", "runtime dependency"].every((term) => graphCaseText.includes(term))) {
    violations.push("runtime-composition-closure-regression-missing");
  }
  return violations;
}

function numbered(prefix: string, maximum: number): string[] {
  return Array.from({ length: maximum }, (_, index) => `${prefix}-${String(index + 1).padStart(3, "0")}`);
}

function source(
  id: string,
  kind: string,
  locator: string,
  availability: string,
  observedStatus: string,
  incidentIds: readonly string[],
  claimLimit: string,
  handoffContinuityOccurrenceBundle?: PreventionSourceFact["handoffContinuityOccurrenceBundle"],
): PreventionSourceFact {
  return {
    id, kind, locator, availability, observedStatus, incidentIds, claimLimit,
    ...(handoffContinuityOccurrenceBundle === undefined ? {} : { handoffContinuityOccurrenceBundle }),
  };
}

function occurrence(
  taskPath: string,
  withinTaskAttemptOrdinal: number,
  correctedResultState: "pending-corrected-result" | "received-after-resume" |
    "superseded-by-another-rejected-proposal",
) {
  return {
    taskPath,
    withinTaskAttemptOrdinal,
    proposalDisposition: "rejected-wrong-subject",
    parentDecision: "reject-and-resume",
    correctedResultState,
    runtimeAttemptId: "unavailable-not-generated",
    incidentId: "INC-ARCH-013",
  } as const;
}

function continuitySource(document: MutableDocument): Record<string, unknown> {
  const sourceEntry = document.sourceManifest.find((entry) =>
    entry.id === "source:current-subagent-steering-task-continuity-recurrence"
  );
  assert.ok(sourceEntry);
  return sourceEntry;
}

function continuityOccurrences(document: MutableDocument): Array<Record<string, unknown>> {
  const bundle = object(continuitySource(document).handoffContinuityOccurrenceBundle);
  const occurrences = bundle.handoffContinuityOccurrences;
  assert.ok(Array.isArray(occurrences));
  return occurrences as Array<Record<string, unknown>>;
}

function findRow(document: MutableDocument, id: string): Record<string, unknown> {
  const row = document.rows.find((candidate) => candidate.id === id);
  assert.ok(row, `missing fixture row ${id}`);
  return row;
}

function object(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function repeatMutations(
  mutations: readonly ((document: MutableDocument) => void)[],
  expectedFragments: readonly string[],
): void {
  assert.equal(mutations.length, expectedFragments.length);
  for (let repetition = 0; repetition < 3; repetition += 1) {
    for (const [index, mutation] of mutations.entries()) {
      const document = loadDocument();
      mutation(document);
      const result = verifyPreventionReview(document, currentFacts());
      assert.equal(result.valid, false, `mutation ${index} repetition ${repetition} false-greened`);
      assert.ok(result.violations.some((violation) => violation.includes(expectedFragments[index]!)),
        `mutation ${index} repetition ${repetition} missed ${expectedFragments[index]}: ${result.violations.join(",")}`);
    }
  }
}
