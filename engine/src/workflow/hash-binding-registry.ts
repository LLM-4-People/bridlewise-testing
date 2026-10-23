import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { resolve } from "node:path";

import { HarnessError, InputError } from "../kernel/errors.ts";
import { canonicalJson, deepFreeze, sha256 } from "../kernel/integrity.ts";
import { schemaId } from "../kernel/product-identity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { REQUIREMENTS_REGISTRY_IDENTITY_HASH, REQUIREMENTS_REGISTRY_SOURCE_PATH } from "../kernel/requirements.ts";
import { FORENSIC_SCHEMA_BUNDLE_HASH } from "../forensics/forensic-contracts.ts";
import { S3_OFFLINE_FORENSIC_HASH } from "../forensics/offline-forensics.ts";
import { DECISION_INDEX, EVIDENCE_IGNORE_BLOCK, GENERATED_BLOCKS, PIN_AUTHORITY_PATHS, SHIPPED_HOOK_FILES, SLICE_PROJECTION_PATHS, TRACKER_BOARD } from "../kernel/verification-paths.ts";
import { computeGuardianBuildStamp } from "../filesystem/self-protection/guardian-build-stamp.ts";
import { ARCHITECTURE_EXTERNAL_COMMANDS } from "../kernel/architecture-external-commands.ts";
import { ARCHITECTURE_MODULES_PATH } from "./architecture-module-entries.ts";
import { bytePinSha256Ranges } from "./byte-pin-objects.ts";

/**
 * Central hash-binding registry — the single source of truth for every
 * SHA-256 literal that binds a source file's bytes (or a stable field inside
 * a source JSON file) to a literal stored in a target file.
 *
 * Detection (`verifyAllBindings`, used by `harness check`) and repair
 * (`repairAllBindings`, used by `harness regenerate`) consume the SAME
 * registry, so they can never disagree about which bindings exist. No
 * function here claims to cover "all bindings" while only covering a subset:
 * the list below is exhaustive and every function iterates it.
 *
 * A binding is either:
 * - `file-sha256`: the expected literal is `sha256(sourcePath)`.
 * - `json-field`: the expected literal is `JSON.parse(sourcePath)[fieldName]`,
 * falling back to `sha256(sourcePath)` when the field is absent (mirrors the
 * historical `computeInventoryBinding` / `computeDispositionBinding` rules
 * for the `inventoryHash` and `integrityHash` fields).
 *
 * The literal is located in the target by:
 * - TypeScript targets: a `findRegex` whose match is exactly the 64-hex hash
 * (anchored with lookbehind/lookahead on unique surrounding context so the
 * match is unique). Repair replaces the matched hash only, preserving all
 * surrounding formatting.
 * - JSON targets: a `jsonPath` parsed from the target. Verify navigates the
 * path; repair does a surgical string replacement of
 * `"leafKey": "currentValue"` -> `"leafKey": "newValue"` so the rest of the
 * file keeps its exact bytes (no reformatting, no key reordering).
 *
 * Every write goes through `atomicWriteFile` (the canonical atomic-write owner).
 */

export const HASH_BINDING_REGISTRY_VERSION = schemaId("hash-binding-registry", 1);

export type HashMode =
  | Readonly<{ kind: "file-sha256" }>
  | Readonly<{ kind: "json-field"; fieldName: string }>
  /**
   * The expected literal is a value a named MODULE computes — a derived
   * constant (e.g. the requirements registry identity) or a digest over
   * several sealed files plus declared flags (the guardian's reproducible
   * build stamp). `compute` resolves it live, so there is one owner of the
   * derivation and `harness sync` can rewrite the target from it.
   */
  | Readonly<{ kind: "module-constant"; compute: (root: string) => string }>;

export type HashBinding = Readonly<{
  id: string;
  description: string;
  sourcePath: string;
  targetPath: string;
  targetKind: "typescript" | "json";
  hashMode: HashMode;
  findRegex?: string;
  jsonPath?: readonly string[];
}>;

export type BindingVerifyResult = Readonly<{
  id: string;
  matches: boolean;
  expected: string;
  actual: string;
  sourcePath: string;
  targetPath: string;
  error?: string;
}>;

export type BindingRepairResult = Readonly<{
  id: string;
  repaired: boolean;
  previousHash: string;
  newHash: string;
  targetPath: string;
  error?: string;
}>;

export type BindingRegistryReport = Readonly<{
  schemaVersion: typeof HASH_BINDING_REGISTRY_VERSION;
  root: string;
  totalBindings: number;
  matched: number;
  mismatched: number;
  errors: number;
  results: readonly BindingVerifyResult[];
  allMatch: boolean;
  generatedAt: string;
  integrityHash: string;
}>;

export type BindingRepairReport = Readonly<{
  schemaVersion: typeof HASH_BINDING_REGISTRY_VERSION;
  root: string;
  totalBindings: number;
  repairedCount: number;
  alreadyMatchedCount: number;
  errorCount: number;
  results: readonly BindingRepairResult[];
  allMatch: boolean;
  generatedAt: string;
  integrityHash: string;
}>;

const SHA256_HEX = "[0-9a-f]{64}";

const REGEX_META = /[.*+?^${}()|[\]\\]/gu;

function escapeForRegex(literal: string): string {
  return literal.replace(REGEX_META, "\\$&");
}

/**
 * The external-command SOURCE PINS, derived from the inventory's own
 * declarations instead of hand-kept beside them.
 *
 * `externalCommands[].sourceSha256` is a byte-lock of a tracked
 * `verification/` source. The module registrar writes only module entries
 * (src/architecture-modules.ts), so these pins had no generator at all: appending one line to a benchmark
 * command left `harness check` green ("architecture manifest is in sync"),
 * `harness register --write` clean, while `verifyArchitectureSources` reported
 * `architecture-external-command-source-hash-drift`. A source change now
 * re-derives through `harness sync` (the file-sha256 binding repair) or reds
 * the hash-bindings step of `harness check`.
 *
 * Only `publication: "published"` commands are bound: a `not-published`
 * command's source is deliberately absent, and a binding for it would report
 * every check as an error instead of the verifier's named boundary.
 */
function externalCommandSourceBindings(): readonly HashBinding[] {
  return ARCHITECTURE_EXTERNAL_COMMANDS
    .filter((command) => command.publication === "published")
    .map((command) => ({
      id: `architecture-external-command-${command.id}-source-sha256`,
      description: `${command.path} bytes -> src/kernel/architecture-external-commands.ts [${command.id}].sourceSha256`,
      sourcePath: command.path,
      targetPath: "src/kernel/architecture-external-commands.ts",
      targetKind: "typescript" as const,
      hashMode: { kind: "file-sha256" } as const,
      // Anchored on the command's unique id, tempered so NO other command id
      // may appear between the two anchors: this command's own `sourceSha256`
      // is the only literal the lookbehind can reach. A plain bounded gap was
      // ambiguous once several commands fit inside it (each later pin then had
      // this id somewhere before it).
      findRegex: String.raw`(?<=id: "${escapeForRegex(command.id)}"(?:(?!id: ")[\s\S]){0,2000}?sourceSha256: ")${SHA256_HEX}(?=")`,
    }));
}

const HASH_BINDINGS: readonly HashBinding[] = deepFreeze([
  {
    id: "root-policy-config-contracts-source-sha256",
    description: "src/config-contracts.ts bytes -> root-policy.ts configuration.contract.sourceSha256",
    sourcePath: ROOT_POLICY.configuration.contract.sourcePath,
    targetPath: ROOT_POLICY.sourcePath,
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=sourcePath: "${escapeForRegex(ROOT_POLICY.configuration.contract.sourcePath)}",\s*sourceSha256: ")${SHA256_HEX}(?=")`,
  },
  {
    id: "root-policy-directory-worker-source-sha256",
    description: "src/filesystem/private-directory-create-worker.mjs bytes -> root-policy.ts directoryWorker.sourceSha256",
    sourcePath: ROOT_POLICY.filesystemInfrastructure.privateState.directoryWorker.sourcePath,
    targetPath: ROOT_POLICY.sourcePath,
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=sourcePath: "src/filesystem/private-directory-create-worker\.mjs",\s*sourceSha256: ")${SHA256_HEX}(?=")`,
  },
  {
    id: "requirements-registry-file-sha256",
    description: "traceability/requirements.json bytes -> requirements.ts REQUIREMENTS_REGISTRY_FILE_SHA256",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    targetPath: "src/kernel/requirements.ts",
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=export const REQUIREMENTS_REGISTRY_FILE_SHA256\s*=\s*")${SHA256_HEX}(?=")`,
  },
  {
    id: "requirements-registry-source-sha256",
    description: "traceability/canonical/harness-requirements.md bytes -> requirements.ts REQUIREMENTS_REGISTRY_SOURCE_SHA256",
    sourcePath: REQUIREMENTS_REGISTRY_SOURCE_PATH,
    targetPath: "src/kernel/requirements.ts",
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=export const REQUIREMENTS_REGISTRY_SOURCE_SHA256\s*=\s*")${SHA256_HEX}(?=")`,
  },
  {
    id: "s1-trace-requirements-registry-file-sha256",
    description: "traceability/requirements.json bytes -> traceability/s1.json requirementsRegistry.fileSha256",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    targetPath: "traceability/s1.json",
    targetKind: "json",
    hashMode: { kind: "file-sha256" },
    jsonPath: ["requirementsRegistry", "fileSha256"],
  },
  {
    id: "s1-trace-requirements-registry-identity-hash",
    description: "requirements registry identity -> traceability/s1.json requirementsRegistry.identityHash",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    targetPath: "traceability/s1.json",
    targetKind: "json",
    hashMode: { kind: "module-constant", compute: () => REQUIREMENTS_REGISTRY_IDENTITY_HASH },
    jsonPath: ["requirementsRegistry", "identityHash"],
  },
  {
    id: "s2-trace-requirements-registry-file-sha256",
    description: "traceability/requirements.json bytes -> traceability/s2.json requirementsRegistry.fileSha256",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    targetPath: SLICE_PROJECTION_PATHS.s2Trace,
    targetKind: "json",
    hashMode: { kind: "file-sha256" },
    jsonPath: ["requirementsRegistry", "fileSha256"],
  },
  {
    id: "s2-4-trace-requirements-registry-file-sha256",
    description: "traceability/requirements.json bytes -> traceability/s2.4.json requirementsRegistry.fileSha256",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    targetPath: SLICE_PROJECTION_PATHS.s24Trace,
    targetKind: "json",
    hashMode: { kind: "file-sha256" },
    jsonPath: ["requirementsRegistry", "fileSha256"],
  },
  {
    id: "s3-1-trace-requirements-registry-file-sha256",
    description: "traceability/requirements.json bytes -> traceability/s3.1.json requirementsRegistry.fileSha256",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    targetPath: SLICE_PROJECTION_PATHS.s31Trace,
    targetKind: "json",
    hashMode: { kind: "file-sha256" },
    jsonPath: ["requirementsRegistry", "fileSha256"],
  },
  // The slice trace files pin the requirements registry's IDENTITY (a derived
  // module constant — it rotates when the schema-id namespace rotates, e.g. on
  // a product rename). The expected value is computed live from the registry
  // owner, never read from a file's bytes, so a rename re-derives it through
  // `harness regenerate`/`sync` instead of needing a hand-edit.
  {
    id: "s2-trace-requirements-registry-identity-hash",
    description: "requirements registry identity -> traceability/s2.json requirementsRegistry.identityHash",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    targetPath: SLICE_PROJECTION_PATHS.s2Trace,
    targetKind: "json",
    hashMode: { kind: "module-constant", compute: () => REQUIREMENTS_REGISTRY_IDENTITY_HASH },
    jsonPath: ["requirementsRegistry", "identityHash"],
  },
  {
    id: "s2-4-trace-requirements-registry-identity-hash",
    description: "requirements registry identity -> traceability/s2.4.json requirementsRegistry.identityHash",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    targetPath: SLICE_PROJECTION_PATHS.s24Trace,
    targetKind: "json",
    hashMode: { kind: "module-constant", compute: () => REQUIREMENTS_REGISTRY_IDENTITY_HASH },
    jsonPath: ["requirementsRegistry", "identityHash"],
  },
  {
    id: "s3-1-trace-requirements-registry-identity-hash",
    description: "requirements registry identity -> traceability/s3.1.json requirementsRegistry.identityHash",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    targetPath: SLICE_PROJECTION_PATHS.s31Trace,
    targetKind: "json",
    hashMode: { kind: "module-constant", compute: () => REQUIREMENTS_REGISTRY_IDENTITY_HASH },
    jsonPath: ["requirementsRegistry", "identityHash"],
  },
  // The S3.1 trace's CONTRACT identities are derived module constants too:
  // the offline forensic identity hashes the whole `ROOT_POLICY.forensics`
  // section, so a new forensic domain moved it and nothing regenerated the
  // trace (FIX-1: the S1-B08 scenario was the only witness). Computed live
  // from their owners, so `harness sync` re-derives them and `harness check`
  // reports their drift.
  {
    id: "s3-1-trace-offline-forensic-hash",
    description: "offline forensic identity -> traceability/s3.1.json contracts.offlineForensicHash",
    sourcePath: "src/forensics/offline-forensics.ts",
    targetPath: SLICE_PROJECTION_PATHS.s31Trace,
    targetKind: "json",
    hashMode: { kind: "module-constant", compute: () => S3_OFFLINE_FORENSIC_HASH },
    jsonPath: ["contracts", "offlineForensicHash"],
  },
  {
    id: "s3-1-trace-forensic-schema-bundle-hash",
    description: "generated forensic schema bundle -> traceability/s3.1.json contracts.schemaBundleHash",
    sourcePath: "src/forensics/forensic-contracts.ts",
    targetPath: SLICE_PROJECTION_PATHS.s31Trace,
    targetKind: "json",
    hashMode: { kind: "module-constant", compute: () => FORENSIC_SCHEMA_BUNDLE_HASH },
    jsonPath: ["contracts", "schemaBundleHash"],
  },
  {
    id: "s2-4-trace-requirements-source-artifact-sha256",
    description: "traceability/canonical/harness-requirements.md bytes -> traceability/s2.4.json requirementsRegistry.sourceArtifactSha256",
    sourcePath: REQUIREMENTS_REGISTRY_SOURCE_PATH,
    targetPath: SLICE_PROJECTION_PATHS.s24Trace,
    targetKind: "json",
    hashMode: { kind: "file-sha256" },
    jsonPath: ["requirementsRegistry", "sourceArtifactSha256"],
  },
  {
    id: "s2-4-trace-requirements-schema-artifact-sha256",
    description: "traceability/s2.4-requirements-schema.json bytes -> traceability/s2.4.json requirementsRegistry.schemaArtifact.sha256",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsSchemaArtifact,
    targetPath: SLICE_PROJECTION_PATHS.s24Trace,
    targetKind: "json",
    hashMode: { kind: "file-sha256" },
    jsonPath: ["requirementsRegistry", "schemaArtifact", "sha256"],
  },
  {
    id: "slice-traces-requirements-schema-artifact-sha256",
    description: "traceability/s2.4-requirements-schema.json bytes -> scripts/verification/slice-traces.ts schemaArtifact z.literal",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsSchemaArtifact,
    targetPath: "scripts/tooling/verification/slice-traces.ts",
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=schemaArtifact:\s*z\.strictObject\(\{\s*path:\s*z\.literal\(SLICE_PROJECTION_PATHS\.requirementsSchemaArtifact\),\s*sha256:\s*z\.literal\(")${SHA256_HEX}(?="\),)`,
  },
  {
    id: "s1-verification-requirements-schema-artifact-sha256",
    description: "traceability/s2.4-requirements-schema.json bytes -> scripts/s1-verification.ts sha256(schemaBytes) literal",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsSchemaArtifact,
    targetPath: "scripts/tooling/s1-verification.ts",
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=sha256\(schemaBytes\)\s*!==\s*")${SHA256_HEX}(?=")`,
  },
  {
    id: "root-policy-self-protection-guardian-build-stamp",
    description: "guardian/build-stamp.spec (its sealed sources and declared flags) -> root-policy.ts selfProtection.binaryStamp; the REPRODUCIBLE anchor, not the compiler-built binary's bytes",
    sourcePath: ROOT_POLICY.selfProtection.buildStampSpecPath,
    targetPath: ROOT_POLICY.sourcePath,
    targetKind: "typescript",
    // The stamp is a function of several sealed files, not of one source's
    // bytes, so the owning module computes it (exactly as the Makefile embeds
    // it). `harness sync` rewrites the literal from that computation; no
    // compiler and no built binary is involved, which is what makes it
    // reproducible on any toolchain.
    hashMode: { kind: "module-constant", compute: (root) => computeGuardianBuildStamp(root) },
    findRegex: String.raw`(?<=binaryStamp: ")${SHA256_HEX}(?=")`,
  },
  {
    id: "root-policy-self-protection-spec-schema-artifact-sha256",
    description: "traceability/self-protection/guardian-spec-schema.json bytes -> root-policy.ts selfProtection.specSchemaArtifactSha256",
    sourcePath: ROOT_POLICY.selfProtection.specSchemaArtifactPath,
    targetPath: ROOT_POLICY.sourcePath,
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=specSchemaArtifactSha256: ")${SHA256_HEX}(?=")`,
  },
  {
    /**
     * THE SCHEMA SOURCE — the half of the guardian's admission the published
     * projection cannot see.
     *
     * The artifact binding above hashes the JSON projection. A Zod refinement
     * (`.refine`) is not representable in Draft 2020-12, and `z.toJSONSchema`
     * omits it: the projection, the artifact and the artifact pin stay
     * byte-identical while runtime admission changed. That was the gap — the
     * gate covered the JSON projection only. This binding hashes the MODULE
     * that owns the schema, so any source change (a refinement included) moves
     * the pin and reds `harness check`'s hash-bindings step until
     * `harness sync` re-derives it. The pin is the reviewed source the
     * guardian's admission is compiled from, not a second derivation of the
     * schema's meaning.
     */
    id: "root-policy-self-protection-spec-schema-source-sha256",
    description: "src/filesystem/self-protection/self-protection-contracts.ts bytes -> root-policy.ts selfProtection.specSchemaSourceSha256",
    sourcePath: ROOT_POLICY.selfProtection.specSchemaSourcePath,
    targetPath: ROOT_POLICY.sourcePath,
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=specSchemaSourceSha256: ")${SHA256_HEX}(?=")`,
  },
  ...externalCommandSourceBindings(),
]);

export function listAllBindings(): readonly HashBinding[] {
  return HASH_BINDINGS;
}

/**
 * EVERY FILE THE SUITE REGENERATES — the binding targets this registry owns
 * plus the wholesale-artifact owners (the test inventory, the disposition
 * manifest, the config schema artifact). Repo-relative from the repository
 * root, because both consumers compare paths as the repository reports them:
 * the testing floor's judgements walk git-reported paths, and the measured
 * surface's file walk declares its paths from the repository root (the
 * `engine/` prefix is the same monorepo-shape assumption that module's
 * measured-path declaration already makes).
 *
 * Its consumers ask this one question through this one derivation, so they
 * can never disagree about which files are regenerated:
 *
 *   - the measured-surface derivation (`tree-identity.ts`), which hashes
 *     a regenerated file with its pin literals normalized away, so a
 *     convergence pin restatement is not a content change of the surface a
 *     profile report binds to;
 *   - every generated-output question (`generatedOutputPaths` below): the
 *     promotion's projection, which judges a regenerated file of the target
 *     pins-normalized (a regeneration is never a target edit) and lets the
 *     candidate re-derive it; the workspace merge's generation-only rule; the
 *     commit guard and the candidate tooling.
 *
 * A binding added tomorrow joins the set with no edit to any consumer — a
 * regenerated file added outside this derivation is a freshness regression
 * waiting to recur, which is the rot a hand-maintained list is.
 */
export function suiteRegeneratedPaths(): ReadonlySet<string> {
  return new Set([
    ...listAllBindings().map((binding) => `engine/${binding.targetPath}`),
    `engine/${ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath}`,
    GENERATED_CONFIG_SCHEMA_ARTIFACT,
  ]);
}

/**
 * The architecture's module entries, repository-relative: AUTHORED decisions,
 * one entry per line, that the registrar adds to, removes from and marks (and
 * writes in their one form). It carries no pin and is never wholesale: its
 * authored lines must survive a merge.
 */
const GENERATED_ARCHITECTURE_MODULES = `engine/${ARCHITECTURE_MODULES_PATH}`;
/** The config-contract schema artifact, repository-relative: one canonical-JSON blob of the contract. */
const GENERATED_CONFIG_SCHEMA_ARTIFACT = `engine/${ROOT_POLICY.configuration.contract.generatedSchemaPath}`;
/** The guardian spec schema artifact, repository-relative: written by the bundle build from the spec schema. */
const GENERATED_SPEC_SCHEMA_ARTIFACT = `engine/${ROOT_POLICY.selfProtection.specSchemaArtifactPath}`;
/** The canonical important-artifact inventory, repository-relative: rebuilt from the governed roots by `scripts/tooling/artifact-manifest.ts`. */
const GENERATED_ARTIFACT_MANIFEST = `engine/${ROOT_POLICY.artifactGovernance.canonicalInventory}`;

/**
 * THE WHOLLY GENERATED OUTPUTS, repository-relative: the subset of
 * {@link generatedOutputPaths} that holds nothing but a generator's output of
 * the tree — no authored byte. Everything else a sync pass writes is AUTHORED
 * with a generated part (a pin literal in a hand-written module, a README's
 * consumer block, the disposition manifest's hand-decided dispositions,
 * a ratchet baseline's reasons), so its authored part must survive a merge.
 *
 * Consumers: `harness workspace` — such a path is never leasable (two
 * workspaces would fork the generated authority) and a merge conflict on it
 * is resolved to the target's side and re-derived by the regenerate phase
 * (the merged tree's own sources decide its bytes).
 */
export function wholesaleGeneratedPaths(): ReadonlySet<string> {
  return new Set([
    GENERATED_CONFIG_SCHEMA_ARTIFACT,
    GENERATED_SPEC_SCHEMA_ARTIFACT,
    GENERATED_ARTIFACT_MANIFEST,
    ...SHIPPED_HOOK_PATHS,
  ]);
}

/** The shipped hooks (repository-relative), each written whole by its generator (`SHIPPED_HOOK_FILES.generator`). */
const SHIPPED_HOOK_PATHS: readonly string[] = Object.freeze([...SHIPPED_HOOK_FILES.guarded, SHIPPED_HOOK_FILES.trigger].map((hook) => `${SHIPPED_HOOK_FILES.directory}/${hook}`));

/**
 * EVERY PATH A REGENERATE/SYNC PASS MAY WRITE, repository-relative — the one
 * list of generated outputs. It is {@link suiteRegeneratedPaths} (the
 * pin-bearing targets and the wholesale inventory, dispositions and schema
 * artifact) plus the architecture's module entries, which the registrar
 * adds to, removes from and marks and which carry no pin, the guardian spec schema artifact the
 * bundle build writes, the ratchet baselines the pass prunes, the
 * source-authority pins it re-derives (`PIN_AUTHORITY_PATHS`). The same set
 * for every tree: no README carries a generated block any more (a folder's
 * consumers are the import graph's answer, never a committed list that every
 * branch rewrites, #221). Consumers: the commit guard (a commit whose
 * generated outputs are not staged is refused), the working-copy and
 * candidate tooling, the promotion projection, and the generator-door tests.
 */
export function generatedOutputPaths(): ReadonlySet<string> {
  return new Set([
    ...suiteRegeneratedPaths(),
    GENERATED_ARCHITECTURE_MODULES,
    // Written by the bundle build (`scripts/build-bundle.ts`, run by
    // `harness sync --with-bundle` and the checkout setup) from the guardian
    // spec schema: a generated output like the others, so a candidate's
    // regenerated copy is its own, never a source edit.
    GENERATED_SPEC_SCHEMA_ARTIFACT,
    // The canonical important-artifact inventory a synchronise pass rebuilds
    // from the governed roots' repository listing
    // (`scripts/tooling/artifact-manifest.ts`). Its whole text is generated
    // (ids, digests, origins, policy hash), so it is never leasable and a
    // candidate re-derives it instead of merging a copy.
    GENERATED_ARTIFACT_MANIFEST,
    // The ratchet baselines a regenerate pass prunes against their guards'
    // scans (`scripts/verification/ratchet-baselines.ts`; already
    // repository-relative).
    ...Object.values(ROOT_POLICY.verification.ratchetBaselines),
    // The decision index a regenerate pass rebuilds from the decision files
    // (`DECISION_INDEX.generator`).
    DECISION_INDEX.path,
    // The task board a regenerate pass renders from the tracker items
    // (`TRACKER_BOARD.generator`).
    TRACKER_BOARD.path,
    // The root ignore file's evidence block, which a sync pass rewrites from the
    // evidence manifests (`EVIDENCE_IGNORE_BLOCK.generator`).
    EVIDENCE_IGNORE_BLOCK.path,
    // The shipped hooks a regenerate pass writes whole from their owners
    // (`SHIPPED_HOOK_FILES.generator`).
    ...SHIPPED_HOOK_PATHS,
    // The source-authority pins a regenerate pass re-derives
    // (`scripts/pin-authority-regeneration.ts`) and the projection beside one.
    ...Object.values(PIN_AUTHORITY_PATHS).map((path) => `engine/${path}`),
  ]);
}

/**
 * The ignored build outputs a working copy carries beside the tree (the
 * bundle), repository-relative. None is pinned by a committed digest: a build
 * output's digest is a function of the tree and the toolchain, never a value
 * the tree should hold, and a committed one rewrote one line of root-policy.ts
 * on every engine change and conflicted on nearly every merge (#221). The
 * guardian binary is not here either: it is bound by a reproducible stamp over
 * its committed SOURCES. The test working copies, the candidate checkout's
 * copy-back and the promoter carry these.
 */
export function buildOutputPaths(): readonly string[] {
  return [`engine/${ROOT_POLICY.selfProtection.bundleRelativePath}`];
}

/**
 * A 64-hex literal the registry (or a declared pin authority) re-derives from
 * the tree, located inside a target file's text by that owner's own locator.
 */
export type BindingPinRange = Readonly<{ literal: string; start: number; end: number }>;

const SHA256_LITERAL = /^[0-9a-f]{64}$/u;
const HEX_64_GLOBAL = /[0-9a-f]{64}/gu;

/**
 * The in-source declaration of a region whose 64-hex literals are AUTHORED
 * refusal pins (a value that MUST NOT be auto-repaired: a pin a generator can
 * rewrite refuses nothing). The normalizer already leaves them alone because
 * it only rewrites registry-bound literals; the guard in
 * `test/verification/hash-binding-registry.test.ts` reads these markers so a
 * new unowned literal in a suite-regenerated module cannot hide beside them.
 * Declared in place, never as a list of literal values elsewhere (a second
 * copy of a pin is a second owner).
 */
export const AUTHORED_PIN_REGION = deepFreeze({
  begin: "// BEGIN AUTHORED PINS",
  end: "// END AUTHORED PINS",
} as const);

/** One target file's owned literal ranges, derived from the bindings that target it. */
export function bindingPinRanges(targetPath: string, text: string): readonly BindingPinRange[] {
  const ranges: BindingPinRange[] = [];
  for (const binding of listAllBindings()) {
    if (binding.targetPath !== targetPath) continue;
    if (binding.targetKind === "typescript") {
      if (binding.findRegex === undefined) continue;
      let pattern: RegExp;
      try {
        pattern = new RegExp(binding.findRegex, "gu");
      } catch (error) {
        // A registry locator that does not compile is a broken owner, not a
        // file with no pins: skip it and the binding silently never normalizes
        // (the round-5 defect shape). Name it and stop.
        throw new HarnessError(
          `${binding.id}: findRegex is not a valid pattern (${error instanceof Error ? error.message : String(error)})`,
          "hash_binding_regex_invalid",
        );
      }
      for (const match of text.matchAll(pattern)) {
        if (!SHA256_LITERAL.test(match[0]) || match.index === undefined) continue;
        ranges.push({ literal: match[0], start: match.index, end: match.index + match[0].length });
      }
      continue;
    }
    // A JSON binding names the value by its path. Resolve it from THIS text
    // (the target's current literal, never a static import), then locate the
    // one `"<leaf>": "<value>"` pair that carries it. An ambiguous locator is
    // left un-normalized rather than guessed at.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // This binding targets a JSON document; bytes that do not parse are a
      // corrupt target, not "no pin here". Refuse loudly rather than compare a
      // document to itself with its pins left in place.
      throw new HarnessError(
        `${binding.id}: target ${targetPath} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        "hash_binding_json_invalid",
      );
    }
    const value = jsonValueAtPath(parsed, binding.jsonPath ?? []);
    if (typeof value !== "string" || !SHA256_LITERAL.test(value)) continue;
    const leaf = binding.jsonPath?.at(-1);
    if (leaf === undefined) continue;
    const matches = [...text.matchAll(new RegExp(`"${escapeForRegex(leaf)}"\\s*:\\s*"${value}"`, "gu"))];
    if (matches.length !== 1 || matches[0]!.index === undefined) continue;
    const start = matches[0]!.index + matches[0]![0].lastIndexOf(value);
    ranges.push({ literal: value, start, end: start + value.length });
  }
  return deepFreeze(dedupePinRanges(ranges));
}

function jsonValueAtPath(root: unknown, jsonPath: readonly string[]): unknown {
  let current = root;
  for (const key of jsonPath) {
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isSafeInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

function dedupePinRanges(ranges: readonly BindingPinRange[]): readonly BindingPinRange[] {
  const byStart = new Map<number, BindingPinRange>();
  for (const range of ranges) {
    if (!byStart.has(range.start)) byStart.set(range.start, range);
  }
  return [...byStart.values()].toSorted((left, right) => left.start - right.start);
}

/** Whether `targetPath` (engine-relative) is a registered source-authority file. */
function isPinAuthorityTarget(targetPath: string): boolean {
  return (Object.values(PIN_AUTHORITY_PATHS) as readonly string[]).includes(targetPath);
}

/**
 * The `{path, byteLength, sha256}` pin literals the pin-authority driver
 * re-derives in a source-authority file.
 *
 * ── THE STRUCTURE, NOT THE FIELD NAME ─────────────────────────────────────
 *
 * This used to match ANY `sha256: "<64 hex>"` field in a registered
 * pin-authority module. The driver does not: it rewrites the `sha256` of an
 * object that ALSO carries a string `path` and a numeric `byteLength`, and
 * only when that path names a live file. So an authored value written in the
 * same shape — `export const PROBE = { sha256: "<64 hex>" }` — was normalized
 * away and the change that added it was judged `isGenerationOnlyChange`,
 * exempting it from the lease and write-set checks while the driver never
 * owned it. The ranges now come from the driver's own structural reader
 * (`byte-pin-objects.ts`, shared with `scripts/pin-authority-regeneration.ts`),
 * so the normalizer and the writer cannot disagree about what a pin is.
 */
function pinAuthorityRanges(text: string): readonly BindingPinRange[] {
  try {
    return bytePinSha256Ranges(text);
  } catch (error) {
    throw new HarnessError(
      `pin-authority source is not parseable TypeScript: ${error instanceof Error ? error.message : String(error)}`,
      "hash_binding_pin_source_invalid",
    );
  }
}

/**
 * Replace the literals a generated file's OWNERS re-derive with a stable
 * marker, so two blobs that differ only in regenerated pins compare equal.
 *
 * ── IT IS DERIVED, NOT BLANKET ──────────────────────────────────────────
 *
 * This used to replace EVERY 64-hex literal in a suite-regenerated file. A
 * suite-regenerated module also carries AUTHORED values (root policy's
 * retained-fixture hashes, its runtime-identity pins, its surface-conservation
 * refusal pins; the requirements registry's historical append provenance), and
 * a change to one of those was judged `isGenerationOnlyChange` — exempting it
 * from the lease, write-set, merged-since and promotion checks. A hand edit of
 * an authored pin is a source edit.
 *
 * The population is now the owners' own locators:
 * - a TypeScript target: each binding's `findRegex`, its exact match only;
 * - a JSON data target: every literal (the whole document is generated data
 *   re-derived by the slice-projection build, and its binding locators are
 *   dynamic — the s2 fixture digests are declared by the trace itself);
 * - a registered pin-authority file: the `sha256` fields its driver rewrites.
 *
 * A literal no owner locates is left intact, so an authored change is visible
 * to every consumer of this normalization.
 */
export function regeneratedPinRanges(path: string, text: string): readonly BindingPinRange[] {
  const targetPath = path.startsWith("engine/") ? path.slice("engine/".length) : path;
  const owningBindings = listAllBindings().filter((binding) => binding.targetPath === targetPath);
  let ranges: readonly BindingPinRange[];
  if (owningBindings.some((binding) => binding.targetKind === "json")) {
    ranges = [...text.matchAll(HEX_64_GLOBAL)].map((match) => ({
      literal: match[0],
      start: match.index!,
      end: match.index! + match[0].length,
    }));
  } else {
    ranges = bindingPinRanges(targetPath, text);
  }
  if (isPinAuthorityTarget(targetPath)) ranges = [...ranges, ...pinAuthorityRanges(text)];
  return dedupePinRanges(ranges);
}

export function stripRegeneratedPins(path: string, text: string): string {
  const ranges = regeneratedPinRanges(path, text);
  let stripped = text;
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
    stripped = `${stripped.slice(0, range.start)}<regenerated-pin>${stripped.slice(range.end)}`;
  }
  return stripped;
}

/** The text with the body of every `begin`…`end` block blanked (the markers stay; an unterminated block is left as it is). */
function blankBlocks(text: string, begin: string, end: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const opened = text.indexOf(begin, from);
    const closed = opened < 0 ? -1 : text.indexOf(end, opened + begin.length);
    if (closed < 0) return out + text.slice(from);
    out += `${text.slice(from, opened + begin.length)}<generated-block>`;
    from = closed;
  }
}

/**
 * A generated output's text with its GENERATED parts blanked: the pin
 * literals of a pin-bearing file ({@link suiteRegeneratedPaths}, the
 * source-authority pins) and the body of every generated block
 * (`GENERATED_BLOCKS`: the decision index, the evidence ignore block). What
 * is left is the file's AUTHORED part.
 */
function stripGeneratedParts(path: string, text: string): string {
  const pinBearing = suiteRegeneratedPaths().has(path) || Object.values(PIN_AUTHORITY_PATHS).some((pinned) => `engine/${pinned}` === path);
  return GENERATED_BLOCKS.reduce((current, block) => blankBlocks(current, block.begin, block.end), pinBearing ? stripRegeneratedPins(path, text) : text);
}

/**
 * THE ONE ANSWER to "is this change of a generated output REGENERATION
 * ONLY?" (`path` ∈ {@link generatedOutputPaths}; `before`/`after` its texts,
 * null where the tree has none): a wholly generated output always is
 * ({@link wholesaleGeneratedPaths}); any other is only when its authored
 * part ({@link stripGeneratedParts}) is unchanged — an added, deleted or
 * hand-edited file is an authored change. Consumers: `harness workspace`'s
 * lease exemption (the write-set proof, the merge precheck, the merged-since
 * and pending-lease checks) and its conflict resolution, so a hand edit of a
 * file that also carries a pin or a generated block is leased like any
 * source.
 */
export function isGenerationOnlyChange(path: string, before: string | null, after: string | null): boolean {
  if (wholesaleGeneratedPaths().has(path)) return true;
  return before !== null && after !== null && stripGeneratedParts(path, before) === stripGeneratedParts(path, after);
}

/** A binding's source is a committed file; its absence means an incomplete working tree, which no build repairs. */
function missingSourceMessage(binding: HashBinding): string {
  return `${binding.sourcePath} is missing from the working tree, so the hash binding ` +
    `"${binding.id}" has nothing to pin. It is a committed repository source, ` +
    `so no build produces it — restore it from version control.`;
}

export function computeBindingHash(root: string, binding: HashBinding): string {
  // A module-constant binding's expected value is computed by the owning
  // module, not derived from a file's bytes — resolve it live before any file
  // read (the sourcePath still anchors where the value CONCEPTUALLY comes from
  // and is verified to exist below for the repository-source origin).
  if (binding.hashMode.kind === "module-constant") {
    return binding.hashMode.compute(root);
  }
  const sourceAbsolutePath = resolve(root, binding.sourcePath);
  if (!existsSync(sourceAbsolutePath)) {
    throw new InputError(missingSourceMessage(binding), "input_error");
  }
  const sourceText = readFileSync(sourceAbsolutePath, "utf8");
  if (binding.hashMode.kind === "file-sha256") {
    return sha256(sourceText);
  }
  const fieldName = binding.hashMode.fieldName;
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    throw new InputError(`hash binding source is not valid JSON: ${binding.sourcePath}`, "input_error");
  }
  const fieldValue = readJsonPath(parsed, [fieldName]);
  return typeof fieldValue === "string" && /^[0-9a-f]{64}$/u.test(fieldValue) ? fieldValue : sha256(sourceText);
}

export function verifyBinding(root: string, binding: HashBinding): BindingVerifyResult {
  const base = {
    id: binding.id,
    sourcePath: binding.sourcePath,
    targetPath: binding.targetPath,
  };
  let expected: string;
  try {
    expected = computeBindingHash(root, binding);
  } catch (error) {
    return deepFreeze({ ...base, matches: false, expected: "", actual: "", error: errorMessage(error) });
  }
  let actual: string;
  try {
    actual = readCurrentLiteral(root, binding);
  } catch (error) {
    return deepFreeze({ ...base, matches: false, expected, actual: "", error: errorMessage(error) });
  }
  return deepFreeze({ ...base, matches: expected === actual, expected, actual });
}

/**
 * The bindings APPLICABLE to this tree. A binding pins a hash into a target
 * file; a tree that does not carry that target file (a product-only tree that
 * ships no verification-runner scripts) has nothing for the binding to
 * verify — its absence is the tree's shape, not drift. Filtering at this ONE
 * choke point (rather than in each verify/repair) means every consumer judges
 * the same applicable set. A binding whose target IS present is always
 * judged, so the filter can never mask real drift on a tree that carries the
 * file.
 */
function applicableBindings(root: string): readonly HashBinding[] {
  return [...HASH_BINDINGS, ...fixtureDigestBindings(root)].filter((binding) => existsSync(resolve(root, binding.targetPath)));
}

/**
 * THE S2 BEHAVIOUR FIXTURE DIGESTS ARE BINDINGS TOO — derived, not listed.
 *
 * `traceability/s2.json` pins every behaviour fixture by `sha256`
 * (`behaviors[i].fixtures[j]`), and the slice verifier refuses a fixture whose
 * bytes disagree (`s2-fixture-hash-mismatch`). No generator owned those pins,
 * so an edited fixture could only be re-pinned by hand — and twenty were left
 * stale when the Responses fixtures were rewritten. Each entry the trace
 * declares becomes a `file-sha256` binding from the fixture's bytes to its
 * own `sha256` field, so `harness sync` re-pins it and `harness check`
 * (hash-bindings) reports it. Derived from the trace on every call: a fixture
 * added to the trace is bound the moment it is declared.
 *
 * A tree that does not carry the test surface at all (`test/`) binds none:
 * the product tree a promotion builds ships the trace but never the test
 * surface, so its pins there describe fixtures that live on the development
 * branch. In a tree that carries the test surface, a declared fixture that is
 * missing stays an error, as any absent source is — the fixtures' folder
 * deleted wholesale included (`harness check`, the commit guard's facts leg,
 * still refuses it; keyed on the folder itself it went silent: PROMO-2 N6).
 */
export function fixtureDigestBindings(root: string): readonly HashBinding[] {
  const tracePath = resolve(root, SLICE_PROJECTION_PATHS.s2Trace);
  if (!existsSync(tracePath) || !existsSync(resolve(root, SLICE_PROJECTION_PATHS.testSurface))) return [];
  const trace = JSON.parse(readFileSync(tracePath, "utf8")) as { behaviors?: unknown };
  if (!Array.isArray(trace.behaviors)) return [];
  const bindings: HashBinding[] = [];
  trace.behaviors.forEach((behavior: unknown, behaviorIndex) => {
    const fixtures = (behavior as { fixtures?: unknown } | null)?.fixtures;
    if (!Array.isArray(fixtures)) return;
    fixtures.forEach((fixture: unknown, fixtureIndex) => {
      const path = (fixture as { path?: unknown } | null)?.path;
      if (typeof path !== "string") return;
      bindings.push({
        id: `s2-fixture-digest:${path}`,
        description: `${path} bytes -> ${SLICE_PROJECTION_PATHS.s2Trace} behaviors[${behaviorIndex}].fixtures[${fixtureIndex}].sha256`,
        sourcePath: path,
            targetPath: SLICE_PROJECTION_PATHS.s2Trace,
        targetKind: "json",
        hashMode: { kind: "file-sha256" },
        jsonPath: ["behaviors", String(behaviorIndex), "fixtures", String(fixtureIndex), "sha256"],
      });
    });
  });
  return bindings;
}

export function verifyAllBindings(root: string): BindingRegistryReport {
  const results = applicableBindings(root).map((binding) => verifyBinding(root, binding));
  return buildRegistryReport(root, results);
}

/**
 * Verify a single binding by its registry id. This is the file-truthful way
 * to read the CURRENT on-disk literal for a binding: `result.actual` always
 * comes from the target file's current bytes, never from a static in-process
 * import that may be stale after a write in the same process.
 */
export function verifyBindingById(root: string, id: string): BindingVerifyResult {
  const binding = HASH_BINDINGS.find((entry) => entry.id === id);
  if (binding === undefined) {
    throw new InputError(`unknown hash binding id: ${id}`, "input_error");
  }
  return verifyBinding(root, binding);
}

export function repairBinding(root: string, binding: HashBinding): BindingRepairResult {
  const base = { id: binding.id, targetPath: binding.targetPath };
  let newHash: string;
  try {
    newHash = computeBindingHash(root, binding);
  } catch (error) {
    return deepFreeze({ ...base, repaired: false, previousHash: "", newHash: "", error: errorMessage(error) });
  }
  const targetAbsolutePath = resolve(root, binding.targetPath);
  if (!existsSync(targetAbsolutePath)) {
    return deepFreeze({ ...base, repaired: false, previousHash: "", newHash: "", error: "target file not found" });
  }
  let content = readFileSync(targetAbsolutePath, "utf8");
  let previousHash: string;
  try {
    previousHash = readCurrentLiteralFromContent(binding, content);
  } catch (error) {
    return deepFreeze({ ...base, repaired: false, previousHash: "", newHash, error: errorMessage(error) });
  }
  if (previousHash === newHash) {
    return deepFreeze({ ...base, repaired: false, previousHash, newHash });
  }
  try {
    content = replaceCurrentLiteral(binding, content, previousHash, newHash);
  } catch (error) {
    return deepFreeze({ ...base, repaired: false, previousHash, newHash, error: errorMessage(error) });
  }
  const writeResult = atomicWriteFile(targetAbsolutePath, content);
  if (!writeResult.success) {
    return deepFreeze({ ...base, repaired: false, previousHash, newHash, error: writeResult.reason ?? "atomic write failed" });
  }
  return deepFreeze({ ...base, repaired: true, previousHash, newHash });
}

export function repairAllBindings(
  root: string,
  options: Readonly<{ write?: boolean }> = {},
): BindingRepairReport {
  const write = options.write ?? true;
  const results = applicableBindings(root).map((binding) => {
    if (!write) {
      return verifyBasedRepairResult(root, binding);
    }
    return repairBinding(root, binding);
  });
  return buildRepairReport(root, results);
}

function verifyBasedRepairResult(root: string, binding: HashBinding): BindingRepairResult {
  const verify = verifyBinding(root, binding);
  return deepFreeze({
    id: binding.id,
    targetPath: binding.targetPath,
    repaired: false,
    previousHash: verify.actual,
    newHash: verify.expected,
    ...(verify.error !== undefined ? { error: verify.error } : {}),
  });
}

function readCurrentLiteral(root: string, binding: HashBinding): string {
  const targetAbsolutePath = resolve(root, binding.targetPath);
  if (!existsSync(targetAbsolutePath)) {
    throw new InputError(`hash binding target file not found: ${binding.targetPath}`, "input_error");
  }
  const content = readFileSync(targetAbsolutePath, "utf8");
  return readCurrentLiteralFromContent(binding, content);
}

function readCurrentLiteralFromContent(binding: HashBinding, content: string): string {
  if (binding.targetKind === "typescript") {
    return readTypescriptLiteral(binding, content);
  }
  return readJsonLiteral(binding, content);
}

function readTypescriptLiteral(binding: HashBinding, content: string): string {
  return uniqueLiteralMatch(binding, content, binding.targetPath).text;
}

/**
 * The ONE locator of a binding's literal: its `findRegex`, matched exactly
 * once in `content` (the target's text). Zero or several matches are a typed refusal naming `where`,
 * never a guess: a decoy spelled like the pin makes the text ambiguous, it
 * never acquires the pin's exemption.
 */
function uniqueLiteralMatch(binding: HashBinding, content: string, where: string): Readonly<{ index: number; text: string }> {
  const pattern = binding.findRegex;
  if (pattern === undefined) {
    throw new InputError(`typescript binding ${binding.id} has no findRegex`, "input_error");
  }
  const matches = [...content.matchAll(new RegExp(pattern, "gu"))];
  if (matches.length === 0) {
    throw new InputError(`hash literal not found in ${where} for binding ${binding.id}`, "input_error");
  }
  if (matches.length > 1) {
    throw new InputError(`hash literal match is ambiguous in ${where} (${matches.length} occurrences) for binding ${binding.id}`, "input_error");
  }
  const match = matches[0]!;
  return { index: match.index!, text: match[0] };
}

function replaceUniqueLiteral(binding: HashBinding, text: string, literal: string, where: string): string {
  const match = uniqueLiteralMatch(binding, text, where);
  return `${text.slice(0, match.index)}${literal}${text.slice(match.index + match.text.length)}`;
}

function readJsonLiteral(binding: HashBinding, content: string): string {
  const jsonPath = binding.jsonPath;
  if (jsonPath === undefined || jsonPath.length === 0) {
    throw new InputError(`json binding ${binding.id} has no jsonPath`, "input_error");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new InputError(`target is not valid JSON: ${binding.targetPath}`, "input_error");
  }
  const value = readJsonPath(parsed, jsonPath);
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new InputError(`json path ${jsonPath.join(".")} in ${binding.targetPath} is not a 64-hex string`, "input_error");
  }
  return value;
}

function replaceCurrentLiteral(binding: HashBinding, content: string, previousHash: string, newHash: string): string {
  if (binding.targetKind === "typescript") {
    return replaceTypescriptLiteral(binding, content, newHash);
  }
  return replaceJsonLiteral(binding, content, previousHash, newHash);
}

function replaceTypescriptLiteral(binding: HashBinding, content: string, newHash: string): string {
  return replaceUniqueLiteral(binding, content, newHash, binding.targetPath);
}

function replaceJsonLiteral(binding: HashBinding, content: string, previousHash: string, newHash: string): string {
  const jsonPath = binding.jsonPath!;
  const leafKey = jsonPath[jsonPath.length - 1]!;
  const escapedKey = escapeRegex(leafKey);
  const escapedPrevious = escapeRegex(previousHash);
  const regex = new RegExp(`("${escapedKey}"\\s*:\\s*")${escapedPrevious}(")`, "u");
  const matches = content.match(regex);
  if (matches === null) {
    throw new InputError(`json literal "${leafKey}": "${previousHash}" not found in ${binding.targetPath}`, "input_error");
  }
  const remaining = content.replace(regex, "");
  if (remaining.match(regex) !== null) {
    throw new InputError(`json literal "${leafKey}": "${previousHash}" is not unique in ${binding.targetPath}`, "input_error");
  }
  return content.replace(regex, `$1${newHash}$2`);
}

function readJsonPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (Array.isArray(current)) {
      // An array step is a decimal index, never a property name.
      if (!/^(?:0|[1-9]\d*)$/u.test(key)) return undefined;
      current = current[Number(key)];
      continue;
    }
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function buildRegistryReport(root: string, results: readonly BindingVerifyResult[]): BindingRegistryReport {
  const matched = results.filter((result) => result.matches).length;
  const errors = results.filter((result) => result.error !== undefined).length;
  const mismatched = results.length - matched;
  const unsigned = {
    schemaVersion: HASH_BINDING_REGISTRY_VERSION,
    root,
    totalBindings: results.length,
    matched,
    mismatched,
    errors,
    results: deepFreeze(results),
    allMatch: matched === results.length,
    generatedAt: new Date().toISOString(),
  } as const;
  return deepFreeze({ ...unsigned, integrityHash: sha256(canonicalJson(unsigned)) } as BindingRegistryReport);
}

function buildRepairReport(root: string, results: readonly BindingRepairResult[]): BindingRepairReport {
  const repairedCount = results.filter((result) => result.repaired).length;
  const errorCount = results.filter((result) => result.error !== undefined).length;
  const alreadyMatchedCount = results.filter((result) => !result.repaired && result.error === undefined && result.previousHash === result.newHash).length;
  const unsigned = {
    schemaVersion: HASH_BINDING_REGISTRY_VERSION,
    root,
    totalBindings: results.length,
    repairedCount,
    alreadyMatchedCount,
    errorCount,
    results: deepFreeze(results),
    allMatch: errorCount === 0 && results.every((result) => result.previousHash === result.newHash || result.repaired),
    generatedAt: new Date().toISOString(),
  } as const;
  return deepFreeze({ ...unsigned, integrityHash: sha256(canonicalJson(unsigned)) } as BindingRepairReport);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
