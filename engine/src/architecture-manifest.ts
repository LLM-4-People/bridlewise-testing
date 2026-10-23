import { deepFreeze } from "./kernel/integrity.ts";
import { ARCHITECTURE_EXTERNAL_COMMANDS } from "./kernel/architecture-external-commands.ts";
import { ARCHITECTURE_MODULES } from "./architecture-modules.ts";

export type ArchitectureRealm = "builder" | "runtime" | "shared" | "safety";
export type ArchitectureLayer =
  | "trusted-kernel"
  | "domain"
  | "ports"
  | "application"
  | "infrastructure"
  | "interface"
  | "verification";
export type ArchitectureExecutionBoundary =
  | "pure"
  | "read-adapter"
  | "effect-adapter"
  | "interface"
  | "composition-root"
  | "verification";
export type ArchitectureEffect =
  | "child-process"
  | "cryptography"
  | "environment-access"
  | "filesystem-read"
  | "filesystem-write"
  | "git"
  | "network"
  | "process-control"
  | "process-status";
export type ArchitectureAuthorityFamily =
  | "configuration"
  | "data-classification"
  | "errors"
  | "events";

/*
 * THE EXECUTABLE SOURCE EXTENSIONS ARE NOT PART OF THIS MANIFEST, BY DESIGN.
 * They are declared in and exported from `src/shared/source-extensions.ts`,
 * and this module neither imports nor republishes them. A re-export was the
 * obvious hazard and was never written; the less obvious one was a
 * `sourceExtensions` FIELD on the manifest, which is a re-export wearing a
 * different shape — a consumer reads the field, gets the value, and drags this
 * nine-hundred-module architecture manifest in for eight strings, with no import cycle
 * to refuse it. The field is gone from the type and from the value, so that
 * read no longer compiles. Ask `src/shared/source-extensions.ts` instead.
 */

export type ArchitectureModule = Readonly<{
  id: string;
  path: string;
  realm: ArchitectureRealm;
  layer: ArchitectureLayer;
  owner: string;
  executionBoundary: ArchitectureExecutionBoundary;
  compositionRoot: boolean;
  allowedDependencyLayers: readonly ArchitectureLayer[];
  ports: Readonly<{ requires: readonly string[]; provides: readonly string[] }>;
  effects: readonly ArchitectureEffect[];
  configPaths: readonly string[];
  stateOwners: readonly string[];
  projectionOwners: readonly string[];
  authorityFamilies: readonly ArchitectureAuthorityFamily[];
  authorityIdentifiers: readonly string[];
  responsibilities: readonly string[];
}>;

export type ArchitectureExternalCommand = Readonly<{
  disposition: "blocked-unqualified";
  effects: readonly ArchitectureEffect[];
  exposure: "research-only-non-model-facing" | "verification-internal";
  id: string;
  language: "python" | "shell";
  owner: string;
  path: string;
  /**
   * Whether the public snapshot carries this command's source.
   *
   * `"not-published"` is a REFUSAL, not an exemption: the public tree
   * deliberately does not carry the private floor's historical OpenCode
   * benchmark sources, so the architecture verifier reports
   * `architecture-external-command-source-not-published:<path>` for the
   * absent source and refuses again if one appears. A `"published"` command
   * is hash-bound to its tracked bytes as before.
   */
  publication: "published" | "not-published";
  sourceSha256: string;
}>;

export type ArchitectureFinding = Readonly<{
  id: string;
  status: "open-blocking" | "verified-removed";
  owner: string;
  rationale: string;
  evidenceLinks: readonly string[];
  removalCondition: string;
  deadline: string;
  affectedSurfaces: readonly ("builder" | "runtime")[];
  blockedCapabilities: readonly string[];
  regression: string;
  removalVerification: string;
  note?: string;
}>;

export type ArchitectureManifest = Readonly<{
  schemaVersion: "bridlewise-architecture-manifest/v4";
  sourceRoots: readonly ["scripts/", "src/", "verification/"];
  graphPolicy: "derived-edges-no-cycles";
  publicApiPolicy: "derived-from-source-never-committed";
  analysisLimits: Readonly<{ maximumSourceBytes: number; maximumAstNodes: number }>;
  responsibilityPolicy: "one-registered-cohesive-owner-per-responsibility";
  physicalLayoutStatus: "open-blocking-architecture-v1-migration-required";
  compositionRoots: Readonly<Record<ArchitectureRealm, readonly string[]>>;
  externalCommands: readonly ArchitectureExternalCommand[];
  modules: readonly ArchitectureModule[];
  findings: readonly ArchitectureFinding[];
}>;

/**
 * Empty composition roots for every realm — the typed "no composition roots"
 * fixture. Typed as `Readonly<Record<ArchitectureRealm, readonly string[]>>`
 * so adding a new realm to {@link ArchitectureRealm} FORCES this constant to
 * be updated (a typecheck error, not a silent miss). Test fixtures that need
 * a manifest with no composition roots reuse this instead of hand-writing
 * `{ builder: [], runtime: [], shared: [] }` (which silently dropped the
 * `safety` realm — R45). Single owner.
 */
export const EMPTY_COMPOSITION_ROOTS: Readonly<Record<ArchitectureRealm, readonly string[]>> = deepFreeze({
  builder: [],
  runtime: [],
  shared: [],
  safety: [],
});

const LAYERS: Readonly<Record<ArchitectureLayer, readonly ArchitectureLayer[]>> = deepFreeze({
  "trusted-kernel": ["trusted-kernel"],
  domain: ["trusted-kernel", "domain", "ports"],
  ports: ["trusted-kernel", "domain", "ports"],
  application: ["trusted-kernel", "domain", "ports", "infrastructure", "application"],
  infrastructure: ["trusted-kernel", "domain", "ports", "infrastructure"],
  interface: ["trusted-kernel", "domain", "ports", "application", "infrastructure", "interface"],
  verification: [
    "trusted-kernel", "domain", "ports", "application", "infrastructure", "interface", "verification",
  ],
});

/**
 * What is AUTHORED about a module: one line of `src/architecture-modules.ts`
 * (its one form: src/workflow/architecture-module-entries.ts). The optional
 * fields take their {@link moduleContract} default when left out. What the
 * source says (exports, imports) is not here: the architecture check derives
 * it every time, so it is never committed (#221).
 */
export type ArchitectureModuleEntry = Omit<ArchitectureModule, "allowedDependencyLayers" | "compositionRoot" | "configPaths" |
  "effects" | "executionBoundary" | "ports" | "projectionOwners" | "stateOwners" |
  "authorityFamilies" | "authorityIdentifiers" | "responsibilities"> &
  Partial<Pick<ArchitectureModule, "compositionRoot" | "configPaths" | "effects" | "executionBoundary" |
  "ports" | "projectionOwners" | "stateOwners" | "authorityFamilies" | "authorityIdentifiers" |
  "responsibilities">>;

function moduleContract(input: ArchitectureModuleEntry): ArchitectureModule {
  return {
    ...input,
    allowedDependencyLayers: LAYERS[input.layer],
    compositionRoot: input.compositionRoot ?? false,
    executionBoundary: input.executionBoundary ?? "pure",
    ports: input.ports ?? { requires: [], provides: [] },
    effects: input.effects ?? [],
    configPaths: input.configPaths ?? [],
    stateOwners: input.stateOwners ?? [],
    projectionOwners: input.projectionOwners ?? [],
    authorityFamilies: input.authorityFamilies ?? [],
    authorityIdentifiers: input.authorityIdentifiers ?? [],
    responsibilities: input.responsibilities ?? [input.id],
  };
}

const MODULES: readonly ArchitectureModule[] = ARCHITECTURE_MODULES.map(moduleContract);

/** Each realm's composition roots: the modules whose entry declares the role, sorted — derived, never a second list. */
function compositionRootsOf(modules: readonly ArchitectureModule[]): Readonly<Record<ArchitectureRealm, readonly string[]>> {
  const roots = (realm: ArchitectureRealm): readonly string[] =>
    modules.filter((module) => module.compositionRoot && module.realm === realm).map((module) => module.path).toSorted();
  return { builder: roots("builder"), runtime: roots("runtime"), shared: roots("shared"), safety: roots("safety") };
}

export const ARCHITECTURE_MANIFEST: ArchitectureManifest = deepFreeze({
  schemaVersion: "bridlewise-architecture-manifest/v4",
  sourceRoots: ["scripts/", "src/", "verification/"],
  graphPolicy: "derived-edges-no-cycles",
  publicApiPolicy: "derived-from-source-never-committed",
  analysisLimits: { maximumSourceBytes: 1_048_576, maximumAstNodes: 100_000 },
  responsibilityPolicy: "one-registered-cohesive-owner-per-responsibility",
  physicalLayoutStatus: "open-blocking-architecture-v1-migration-required",
  compositionRoots: compositionRootsOf(MODULES),
  // THE PUBLIC SNAPSHOT PUBLISHES A SUBSET OF THE PRIVATE FLOOR'S EXTERNAL
  // RESEARCH COMMANDS. `publication: "not-published"` declares a source this
  // tree deliberately does not carry: the verifier still refuses it, by name,
  // and refuses it again if the source appears (an accidental publication is
  // a boundary breach, not a pass). The historical OpenCode benchmark sources
  // were pruned deliberately at the public import; the code-intelligence and
  // runtime sources below are published, and their three re-measured pins
  // describe the public bytes after local home paths were sanitized to
  // /home/example.
  externalCommands: ARCHITECTURE_EXTERNAL_COMMANDS,
  findings: [{
    id: "ARCH-001-flat-physical-layout",
    status: "open-blocking",
    owner: "architecture",
    rationale: "Flat product and test paths do not enforce the bounded-context architecture required before effectful growth.",
    evidenceLinks: ["docs/architecture/architecture-v1.md#physical-target-tree"],
    removalCondition: "Complete the behavior-preserving manifest-enforced physical migration and independent rollback rehearsal.",
    deadline: "before-s3.2-storage-agents-mcp-editing-or-interactive-interface-integration",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: ["storage", "agents", "mcp", "editing", "interactive-cli", "web"],
    regression: "architecture-layout-manifest-and-import-fitness-mutation-suite",
    removalVerification: "independent-graph-layout-public-api-test-and-rollback-recheck",
    note: "The blocked capabilities (storage, agents, mcp, editing, interactive-cli, web) are implemented in the development branch but not admitted through the governance gate. They exist as unadmitted development code; this finding remains open-blocking until the physical migration and independent rollback rehearsal pass, at which point harnessReady may become true.",
  }, {
    id: "SEC-001-runbook-search-scope-exposure",
    status: "open-blocking",
    owner: "historical-research-safety",
    rationale: "A broad read-only subagent search escaped its authorized scope and emitted excluded packet content into a tool transcript; the affected run is confidentiality-tainted.",
    evidenceLinks: ["traceability/findings/SEC-001-runbook-search-scope-exposure.md"],
    removalCondition: "Install a manifest-bound deny-by-default launcher/search boundary and pass synthetic scope/transcript negative tests independently before any fresh real-history run.",
    deadline: "before-any-real-history-access-or-conversation-study-readiness-claim",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: ["real-history-access", "conversation-study-readiness", "no-access-or-clean-room-claims"],
    regression: "historical-research-path-scope-and-transcript-containment-x3",
    removalVerification: "independent-synthetic-launcher-search-negative-suite-and-fresh-clean-run",
  }, {
    id: "COORD-001-concurrent-research-layout-move",
    status: "open-blocking",
    owner: "multi-agent-coordination",
    rationale: "A bulk research-layout move crossed an active Git-qualification owner because the safe signal was not protected by a descendant write-set lease.",
    evidenceLinks: ["traceability/findings/COORD-001-concurrent-research-layout-move.md"],
    removalCondition: "The owning agent must reconcile exact bytes and final paths, close its lease, and an independent inventory/link/lease replay must pass.",
    deadline: "before-artifact-inventory-freeze-or-research-layout-acceptance",
    affectedSurfaces: ["builder"],
    blockedCapabilities: ["artifact-inventory-freeze", "research-layout-acceptance"],
    regression: "agent-write-set-descendant-lease-and-stale-signal-mutation-x3",
    removalVerification: "independent-byte-inventory-link-and-lease-replay",
  }, {
    id: "CAP-001-runtime-capability-false-absence",
    status: "open-blocking",
    owner: "runtime-capability-qualification",
    rationale: "Two ambient-PATH-only probes falsely reported Node absent even though the exact required Node and npm were installed under an allowed runtime manager but not activated; exact Unicode/ICU metadata reads are now centralized, but the four-state resolver and launch authority remain unavailable.",
    evidenceLinks: ["traceability/findings/CAP-001-runtime-capability-false-absence.md"],
    removalCondition: "Implement the central typed bounded resolver and scoped activation boundary, pass the hostile state matrix x3, and obtain independent acceptance.",
    deadline: "before-runtime-absence-clean-machine-external-process-or-final-candidate-qualification",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: ["runtime-absence-reporting", "clean-machine-runtime-qualification", "external-process-qualification", "final-candidate-freeze"],
    regression: "runtime-capability-state-and-bounded-activation-matrix-x3",
    removalVerification: "independent-frozen-state-discovery-activation-engine-and-toc-tou-mutation-recheck",
  }, {
    id: "FOUNDATION-001-missing-test-inventory-generator",
    status: "verified-removed",
    owner: "verification-foundation",
    rationale: "The former missing rebuild path is removed by one architecture-bound deterministic generator with transactional recovery, hostile tests, and independent x3 replay.",
    evidenceLinks: ["traceability/findings/FOUNDATION-001-missing-test-inventory-generator.md"],
    removalCondition: "Land one canonical generator, prove byte-identical double generation and hostile drift rejection, regenerate every dependent inventory, and complete independent recheck.",
    deadline: "before-next-semantic-checkpoint-or-candidate-receipt",
    affectedSurfaces: ["builder"],
    blockedCapabilities: ["test-inventory-freeze", "candidate-receipt", "artifact-inventory-freeze"],
    regression: "test-inventory-generator-round-trip-and-hostile-drift-x3",
    removalVerification: "independent-double-generation-loader-and-no-second-generator-recheck",
  }, {
    id: "FOUNDATION-002-candidate-format-verifier-blind-spot",
    status: "verified-removed",
    owner: "verification-foundation",
    rationale: "The blind spot is removed on frozen subject 9cd2bc38391b by the single fail-closed candidate inventory and format boundary, hostile x3 replay, and independent removal verification; residual platform and publication limits remain explicit.",
    evidenceLinks: [
      "traceability/findings/FOUNDATION-002-candidate-format-verifier-blind-spot.md",
      "traceability/evidence/verification/candidate-format/frozen-subject-9cd2bc38391b.json",
      "traceability/evidence/verification/candidate-format/post-subject-evidence.json",
      "traceability/evidence/verification/candidate-format/independent-review.json",
    ],
    removalCondition: "Land the single candidate-inventory format rule, normalize authored violations through their governed cascades, pass hostile tests x3, and complete independent replay.",
    deadline: "before-next-candidate-receipt-or-semantic-checkpoint",
    affectedSurfaces: ["builder"],
    blockedCapabilities: ["candidate-receipt", "artifact-inventory-freeze", "semantic-checkpoint", "release-readiness"],
    regression: "candidate-wide-format-path-and-source-preservation-matrix-x3",
    removalVerification: "independent-clean-and-mutated-candidate-replay-plus-canonical-cascade-audit",
  }, {
    id: "FOUNDATION-003-candidate-identity-conflated-content-and-git-state",
    status: "open-blocking",
    owner: "verification-foundation",
    rationale: "The v1 candidateSetHash changed when identical untracked bytes were staged and could not separately represent semantic content, workspace provenance, and final publication.",
    evidenceLinks: ["traceability/findings/FOUNDATION-003-candidate-identity-conflated-content-and-git-state.md"],
    removalCondition: "Qualify the separated semantic, format, workspace, and external publication identities, then implement and independently replay the authorized index-tree-to-commit-to-tag-or-ledger checkpoint.",
    deadline: "before-git-checkpoint-publication-or-candidate-receipt-readiness",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: ["git-checkpoint-publication", "candidate-receipt-readiness", "semantic-checkpoint", "release-readiness"],
    regression: "candidate-semantic-workspace-publication-identity-matrix-x3",
    removalVerification: "independent-stage-unstage-split-commit-and-non-self-reference-replay",
  }, {
    id: "FOUNDATION-004-execution-receipt-overwrite-and-race-gap",
    status: "open-blocking",
    owner: "verification-foundation",
    rationale: "The core test/S1 path now has durable local three-mode publication, parent-observed pipes and recovery scanning; command effects are centrally inventoried and qualified secret/MWA commands are read-only by default, but blocked producer qualification, repository-artifact admission and canonical-ledger admission remain unavailable.",
    evidenceLinks: [
      "traceability/findings/FOUNDATION-004-execution-receipt-overwrite-and-race-gap.md",
      "docs/research/verification/receipt-producer-inventory.md",
    ],
    removalCondition: "Qualify the immutable start/result/stream/terminal protocol and recovery scanner under crash and concurrency schedules, capture parent-observed streams, qualify or remediate blocked effects, admit through the canonical ledger, migrate in-scope producers, and complete independent replay.",
    deadline: "before-canonical-test-execution-receipts-or-readiness-evidence",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: ["canonical-test-execution-receipt", "test-evidence-ledger-admission", "receipt-based-finding-removal", "receipt-based-release-readiness"],
    regression: "immutable-start-result-stream-terminal-and-recovery-matrix-x3",
    removalVerification: "independent-crash-concurrency-parent-capture-and-ledger-admission-replay",
  }, {
    id: "FOUNDATION-005-configuration-contract-duplicate-authority",
    status: "open-blocking",
    owner: "configuration-architecture",
    rationale: "Configuration shape, version, ceilings, runtime validation, generated projections, fixtures and downstream consumers are not yet all compiled from one declarative ConfigContractSpec.",
    evidenceLinks: ["traceability/findings/FOUNDATION-005-configuration-contract-duplicate-authority.md"],
    removalCondition: "Compile every configuration consumer and migration decision from one versioned ConfigContractSpec and pass hostile differential and independent replay.",
    deadline: "before-final-configuration-or-release-readiness-claim",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: ["final-configuration-contract", "configuration-migration-readiness", "release-readiness"],
    regression: "configuration-spec-generated-consumer-and-version-transition-matrix-x3",
    removalVerification: "independent-generated-runtime-schema-cli-web-extension-fixture-and-migration-differential-replay",
  }, {
    id: "FOUNDATION-006-universal-authority-graph-unavailable",
    status: "open-blocking",
    owner: "authority-and-policy",
    rationale: "The TypeScript-first authority analyzer is narrow and the universal cross-language registry, applicability lock, compiler, read port and transactional pre-apply gate remain unavailable.",
    evidenceLinks: ["traceability/findings/FOUNDATION-006-universal-authority-graph-unavailable.md"],
    removalCondition: "Implement and qualify the cross-language authority registry/compiler, complete applicability matrix, domain-separated lock, read port and transactional pre-apply/pre-completion enforcement without unclassified repetition.",
    deadline: "before-universal-authority-enforcement-or-release-readiness-claim",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: ["universal-authority-enforcement", "cross-language-authority-coverage", "authority-gated-release-readiness"],
    regression: "cross-language-authority-registry-applicability-lock-and-transaction-gate-hostile-matrix-x3",
    removalVerification: "independent-cross-language-owner-consumer-mutation-role-and-unclassified-repetition-replay",
  }, {
    id: "FOUNDATION-008-content-addressed-evidence-production-admission-unavailable",
    status: "open-blocking",
    owner: "artifact-governance",
    rationale: "The deterministic pack/tree/registry, closed provider-evidence seam and append-only first-activation transaction are qualified only on synthetic fixtures; classification, license, provider, root, runtime, security and independent production activation authority remain unavailable.",
    evidenceLinks: [
      "traceability/findings/FOUNDATION-008-content-addressed-evidence-production-admission-unavailable.md",
      "docs/research/verification/content-addressed-evidence-store.md",
      "traceability/evidence/verification/content-addressed-evidence/pre-ingestion-assessment.json",
    ],
    removalCondition: "Admit one exact provider bundle, close classification/license/notice/external-lease evidence, qualify protected root/runtime/security authority, replay real-candidate recovery, and obtain independent exact first-activation authorization.",
    deadline: "before-any-production-content-store-active-registry-or-evidence-readiness-claim",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: [
      "production-content-store-activation", "provider-readiness", "content-store-security-readiness",
      "content-store-product-readiness",
    ],
    regression: "content-store-provider-admission-root-authority-and-activation-hostile-matrix-x3",
    removalVerification: "independent-real-candidate-provider-runtime-security-and-first-activation-replay",
  }, {
    id: "COORD-002-implicit-default-root-write-effect",
    status: "open-blocking",
    owner: "multi-agent-coordination",
    rationale: "A bare apply-patch target intended for an external temporary root created a new repository worktree file before exact detection and cleanup because the tool call lacked explicit root identity and a pre-effect exact write set.",
    evidenceLinks: [
      "traceability/findings/COORD-002-implicit-default-root-write-effect.md",
      "traceability/evidence/verification/content-addressed-evidence/write-boundary-incident.json",
    ],
    removalCondition: "Install and independently replay one universal tool boundary binding explicit root identity, canonical logical paths, active hierarchical write-set leases and fencing before every repository mutation.",
    deadline: "before-universal-safe-write-effect-or-coordination-readiness-claim",
    affectedSurfaces: ["builder"],
    blockedCapabilities: ["universal-safe-write-effect", "write-coordination-readiness"],
    regression: "explicit-root-exact-write-set-and-default-cwd-confusion-matrix-x3",
    removalVerification: "independent-universal-tool-root-fencing-and-incident-replay",
  }],
  modules: MODULES,
});
