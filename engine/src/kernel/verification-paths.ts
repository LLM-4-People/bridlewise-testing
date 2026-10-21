import { deepFreeze } from "./integrity.ts";
import { ROOT_POLICY } from "./root-policy.ts";

/** Neutral path authority shared by runtime-neutral verification cores and scripts. */
export const VERIFICATION_PATHS = deepFreeze({
  testInventory: "traceability/s1-test-inventory.json",
} as const);

/**
 * THE GENERATED README CONSUMER BLOCKS: every README.md carrying `begin`
 * holds one block, up to `end`, that `generator` (repository-relative)
 * projects from the import graph. `harness sync` writes them, `harness check`
 * reports their drift, and every such README is a generated output
 * (`generatedOutputPaths`, src/workflow/hash-binding-registry.ts).
 */
export const README_CONSUMER_BLOCK = deepFreeze({
  generator: "tests/helpers/readme-consumers.ts",
  begin: "<!-- consumers:generated -->",
  end: "<!-- /consumers:generated -->",
} as const);

/**
 * THE SOURCE-AUTHORITY PIN TARGETS (engine-relative): the files whose byte
 * pins `scripts/pin-authority-regeneration.ts` re-derives in a sync pass, and
 * the projection it rewrites beside one. Named here, below the scripts layer,
 * so the generated-output set (`generatedOutputPaths`,
 * src/workflow/hash-binding-registry.ts) lists them: a candidate's
 * regenerated copy is its own and copies back, like every other pin.
 */
export const PIN_AUTHORITY_PATHS = deepFreeze({
  handoffProtocolAuthority: "src/modules/tasks-agents/domain/handoff-protocol-authority.ts",
  handoffProtocolManifest: "traceability/canonical/handoff-protocol-manifest.json",
  plannedNodeTestSourceAuthority: "test/support/planned-node-test-source-authority.ts",
} as const);

/**
 * The decision index (`docs/decisions/README.md`, repository-relative): its
 * index block, between `begin` and `end`, is generated from the decision
 * files by `generator` (relative to the engine), a generated output like the
 * README consumer blocks; the prose around it is hand-written.
 */
export const DECISION_INDEX = deepFreeze({
  path: "docs/decisions/README.md",
  generator: "scripts/verification/decision-index.ts",
  begin: "<!-- BEGIN GENERATED: the decision index, from each file's front matter (harness sync; engine/scripts/verification/decision-index.ts) -->",
  end: "<!-- END GENERATED: the decision index -->",
} as const);

/**
 * THE SHIPPED HOOKS (`<directory>/<name>`, repository-relative): the tracked
 * hooks whose text is canonical — the `guarded` ones, which hand over to the
 * commit guard, and the promotion `trigger`. Each file's WHOLE text is a
 * generated output of `generator` (relative to the engine): `harness sync`
 * writes it from its owners (`shippedHookText`,
 * `scripts/verification/staged-move-loss.ts`, over `promotionTriggerHookText`,
 * src/workflow/promotion/trigger-hook.ts) and `harness check` reports a stale
 * one — never a hand edit (UR-02, PROMO34FIX-HOOK-GENERATOR).
 */
export const SHIPPED_HOOK_FILES = deepFreeze({
  directory: ".githooks",
  guarded: ["pre-commit", "pre-merge-commit", "commit-msg"],
  trigger: "reference-transaction",
  generator: "scripts/verification/shipped-hooks.ts",
} as const);

/**
 * THE EVIDENCE IGNORE BLOCK of the root `.gitignore`: the evidence folders git
 * ignores, written by `harness sync` and every ingest from the evidence
 * manifests (src/workflow/evidence-store.ts `syncEvidenceIgnore`). Registered
 * here like every other generated block (design M9), so a candidate's
 * regenerated copy is its own, never a source edit.
 */
export const EVIDENCE_IGNORE_BLOCK = deepFreeze({
  path: ROOT_POLICY.workflow.evidenceStore.ignoreBlock.file,
  generator: "src/workflow/evidence-store.ts",
  begin: ROOT_POLICY.workflow.evidenceStore.ignoreBlock.begin,
  end: ROOT_POLICY.workflow.evidenceStore.ignoreBlock.end,
} as const);

/**
 * THE TASK BOARD (`ROOT_POLICY.workflow.failureOwners.tracker`, repository-relative):
 * its board block, between `begin` and `end`, is rendered from the structured
 * tracker items (`items`, one `<id>.md` per item, `bridlewise-tracker-item/v1`)
 * by `generator` (relative to the engine: src/workflow/failure-owners.ts
 * `syncTrackerBoard`, `harness sync`); the prose around it is hand-written.
 */
export const TRACKER_BOARD = deepFreeze({
  path: ROOT_POLICY.workflow.failureOwners.tracker,
  items: "docs/trackers/items",
  generator: "src/workflow/failure-owners.ts",
  begin: "<!-- BEGIN GENERATED: the task board, from the tracker items (harness sync; engine/src/workflow/failure-owners.ts) -->",
  end: "<!-- END GENERATED: the task board -->",
} as const);

/**
 * THE GENERATED WORKFLOWS (`<directory>/<file>`, repository-relative): every
 * GitHub Actions workflow is written WHOLE by `generator` (relative to the
 * engine) from the gate catalogue; `harness sync` writes them and `harness
 * check` refuses a hand edit, a stale file, or any other file in the folder
 * (github-only §5.1).
 */
export const GENERATED_WORKFLOW_FILES = deepFreeze({
  directory: ".github/workflows",
  files: ["audit.yml", "ci.yml", "codeql.yml", "publish.yml"],
  generator: "src/workflow/gates/workflows.ts",
} as const);

/** Every generated BLOCK a hand-written file can carry (its generator owns the text between `begin` and `end`). */
export const GENERATED_BLOCKS = deepFreeze([README_CONSUMER_BLOCK, DECISION_INDEX, EVIDENCE_IGNORE_BLOCK, TRACKER_BOARD] as const);

/** A generated block's markers. */
export type GeneratedBlockMarkers = Readonly<{ begin: string; end: string }>;

/** Where `block` sits in `text`: its begin marker's start and its end marker's start, or `null` when the text carries no (or a torn) block. */
function blockSpan(text: string, block: GeneratedBlockMarkers): Readonly<{ begin: number; end: number }> | null {
  const begin = text.indexOf(block.begin);
  const end = text.indexOf(block.end);
  return begin < 0 || end < begin ? null : { begin, end };
}

/**
 * THE ONE SPLICE of a generated block: `text` with the body between `block`'s
 * markers replaced by `body` (a blank line after the begin marker, the body,
 * a newline before the end marker), or `null` when the text carries no (or a
 * torn) block — refused by the caller, never silently left ungenerated.
 */
export function spliceGeneratedBlock(text: string, block: GeneratedBlockMarkers, body: string): string | null {
  const span = blockSpan(text, block);
  return span === null ? null : `${text.slice(0, span.begin + block.begin.length)}\n\n${body}\n${text.slice(span.end)}`;
}

/** `text` split at `block`: the text before it, its body, the text after it; `null` when it carries no (or a torn) block. */
export function splitGeneratedBlock(text: string, block: GeneratedBlockMarkers): Readonly<{ before: string; body: string; after: string }> | null {
  const span = blockSpan(text, block);
  return span === null ? null : { before: text.slice(0, span.begin), body: text.slice(span.begin + block.begin.length, span.end), after: text.slice(span.end + block.end.length) };
}

export const SLICE_PROJECTION_PATHS = deepFreeze({
  declarations: "traceability/canonical/slice-declarations.json",
  requirementsRegistry: "traceability/requirements.json",
  requirementsSchemaArtifact: "traceability/s2.4-requirements-schema.json",
  contractSchemaArtifact: "traceability/s2-contract-schemas.json",
  forensicSchemaArtifact: "traceability/s3.1-forensic-schemas.json",
  s2ResearchManifest: "traceability/sources/s2/research-manifest.json",
  s2OfficialManifest: "traceability/sources/s2/manifest.json",
  s31SourceManifest: "traceability/sources/s3.1/manifest.json",
  s2Trace: "traceability/s2.json",
  /** The engine's test surface: a tree that carries it (the development branch) judges every fixture the S2 trace pins; a product tree ships the trace without it. */
  testSurface: "test",
  s24Trace: "traceability/s2.4.json",
  s31Trace: "traceability/s3.1.json",
  downstreamArtifactManifest: "traceability/artifacts/manifest.json",
  downstreamCandidateReceipt: "traceability/candidate.json",
  guardianSpecSchemaArtifact: "traceability/self-protection/guardian-spec-schema.json",
} as const);

export const SLICE_PROJECTION_ARTIFACT_PATHS = deepFreeze([
  SLICE_PROJECTION_PATHS.requirementsSchemaArtifact,
  SLICE_PROJECTION_PATHS.contractSchemaArtifact,
  SLICE_PROJECTION_PATHS.forensicSchemaArtifact,
  SLICE_PROJECTION_PATHS.s2Trace,
  SLICE_PROJECTION_PATHS.s24Trace,
  SLICE_PROJECTION_PATHS.s31Trace,
] as const);
