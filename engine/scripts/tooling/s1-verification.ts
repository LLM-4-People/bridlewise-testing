import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, type Stats } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { parse as parseTypeScriptSource } from "@babel/parser";
import { z } from "zod";

import { hasSecondName } from "../../src/filesystem/link-containment.ts";
import { buildCandidateManifest, candidateTestIdentity } from "./candidate-manifest.ts";
import { configuredExecutionAuthority, loadTestResultFromExecution } from "./test-execution.ts";
import { candidateFormatErrorViolations } from "../verification/candidate-format.ts";
import { loadTestInventory } from "../test-inventory.ts";
import { validateTestReceipt } from "./test-receipt.ts";
import { verifyArchitectureSources, type ArchitectureSource } from "../verification/architecture.ts";
import { verifyArtifactAdmission } from "../tooling/verification/artifact-admission.ts";
import {
  inspectSafeRepositoryRootBoundary,
  listSafeRepositoryTree,
  readSafeRepositoryFile,
} from "../verification/safe-repository-reader.ts";
import { verifyAuditMatrix, verifySliceTraces } from "../tooling/verification/slice-traces.ts";
import {
  containsCoupledLegacySourceSchema,
  containsExternalApplicationReference,
  containsUniqueHistoricalSchemaMarker,
  isForbiddenEffectIdentifier,
  isGovernedTypeScriptPath,
  isTypeScriptLikePath,
  verifyGovernedTypeScriptSource,
} from "../tooling/verification/governed-source.ts";
import {
  FILESYSTEM_WRITE_APIS,
  FILESYSTEM_WRITE_FLAG_NAMES,
} from "../verification/effect-surface.ts";
import {
  analyzeStaticSource,
  tokenizeStaticSource as tokenize,
} from "../verification/static-source.ts";
import { canonicalHash, canonicalJson, deepFreeze, sha256 } from "../../src/kernel/integrity.ts";
import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { bestEffort } from "../../src/shared/best-effort.ts";
import { reportBestEffortFailure } from "../../src/shared/debug/debug-system.ts";
import { ARCHITECTURE_MANIFEST } from "../../src/architecture-manifest.ts";
import { DATA_CLASSIFICATION, FORENSIC_CLASSIFICATIONS } from "../../src/privacy/classification-catalog.ts";
import { configDocumentPath, getConfigDocumentSchema, inspectConfigDocument } from "../../src/kernel/config.ts";
import {
  getConfigContractArtifact,
  buildConfigContract,
  configContractArtifactText,
  type ConfigContractPolicyProjection,
} from "../../src/kernel/config-contracts.ts";
import { extractErrorMessage } from "../../src/kernel/errors.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../src/kernel/json-integrity.ts";
import { sameOrderedValues } from "../../src/kernel/ordered.ts";
import {
  GENERATED_REQUIREMENTS_REGISTRY_SCHEMA,
  parseRequirementsRegistryText,
  requirementApplicabilityProjection,
  requirementRegistryIds,
  requirementsRootBindingViolations,
  REQUIREMENTS_REGISTRY_FILE_SHA256,
  REQUIREMENTS_REGISTRY_IDENTITY_HASH,
  REQUIREMENTS_REGISTRY_SCHEMA_HASH,
  REQUIREMENTS_SCHEMA_ARTIFACT_VERSION,
  REQUIREMENTS_REGISTRY_SOURCE_PATH,
  REQUIREMENTS_REGISTRY_SOURCE_SHA256,
  AUDIT_MATRIX_SCHEMA,
  type RequirementsRegistry,
} from "../../src/kernel/requirements.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { CONFIG_FILE_BASENAME, STATE_DIRECTORY_NAME, cryptoDomain, schemaId, statePath } from "../../src/kernel/product-identity.ts";
// The extension set has exactly one owner and the manifest is not it — the
// manifest used to republish this array as a field, which was a second door
// onto one value. Named directly so the read cannot drift from the owner.
import { ARCHITECTURE_SOURCE_EXTENSIONS } from "../../src/shared/source-extensions.ts";

export { analyzeStaticSource } from "../verification/static-source.ts";
export type {
  EnvironmentAcquisition,
  ModuleAcquisition,
  StaticSourceAnalysis,
} from "../verification/static-source.ts";

export type S1Verification = Readonly<{
  ok: boolean;
  repositoryManifestHash: string;
  violations: readonly string[];
}>;

type StaticLiteralAstNode = Readonly<{ type: string; [key: string]: unknown }>;
type StaticLiteralExtraction =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false }>;

/**
 * The pure string constructors the projection extractor may evaluate. The
 * product-identity rename replaced literal schema-version / crypto-domain
 * strings with `schemaId(slug, version)` / `cryptoDomain(slug, version)` calls;
 * these are the ONLY CallExpressions the extractor resolves, each a pure
 * template over its two literal arguments. Anything else (an unbound callee, a
 * non-literal argument, a computed member call) stays a refusal.
 */
const STATIC_LITERAL_CALLABLE_CONSTRUCTORS: Readonly<
  Record<string, (...args: unknown[]) => Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>>
> = deepFreeze({
  schemaId: (...args: unknown[]) => {
    if (typeof args[0] !== "string" || typeof args[1] !== "number") return { ok: false };
    return { ok: true, value: schemaId(args[0], args[1]) };
  },
  cryptoDomain: (...args: unknown[]) => {
    if (typeof args[0] !== "string" || typeof args[1] !== "number") return { ok: false };
    return { ok: true, value: cryptoDomain(args[0], args[1]) };
  },
  // statePath(...segments) joins the state-directory name with the segments —
  // a pure string constructor over literal string segments, the same class as
  // schemaId/cryptoDomain.
  statePath: (...args: unknown[]) => {
    if (!args.every((arg) => typeof arg === "string")) return { ok: false };
    return { ok: true, value: statePath(...(args as string[])) };
  },
});
type StaticLiteralFreezeBoundary = Readonly<{
  exportedName: string;
  freezerImportSource: string;
  freezerName: string;
  typeName: string;
}>;
type StaticLiteralIdentifierBinding = Readonly<{
  importSource: string;
  value: unknown;
}>;
type CandidateConfigContractProjection = Readonly<{
  policy: ConfigContractPolicyProjection;
  rootContract: unknown;
  rootContracts: unknown;
}>;

const ROOT_POLICY_STATIC_LITERAL_BOUNDARY = deepFreeze({
  exportedName: "ROOT_POLICY",
  freezerImportSource: "./integrity.ts",
  freezerName: "deepFreeze",
  typeName: "RootPolicy",
});
const ROOT_POLICY_STATIC_LITERAL_IDENTIFIER_BINDINGS: Readonly<
  Record<string, StaticLiteralIdentifierBinding>
> = deepFreeze({
  LEXICAL_REUSE_LIMITS: {
    importSource: "./lexical-policy.ts",
    value: ROOT_POLICY.verification.lexicalReuse,
  },
  AUDIT_MATRIX_ANGLES: {
    importSource: "./requirements.ts",
    value: ROOT_POLICY.universalPolicyArchitecture.auditMatrix.angles,
  },
  AUDIT_MATRIX_STAGES: {
    importSource: "./requirements.ts",
    value: ROOT_POLICY.universalPolicyArchitecture.auditMatrix.stages,
  },
  DATA_CLASSIFICATION: {
    importSource: "../privacy/classification-catalog.ts",
    value: DATA_CLASSIFICATION,
  },
  FORENSIC_CLASSIFICATIONS: {
    importSource: "../privacy/classification-catalog.ts",
    value: FORENSIC_CLASSIFICATIONS,
  },
  // The product-identity basenames are template-literal-computed exports
  // (`${PRODUCT_NAME}.config.json`), which the static evaluator cannot resolve
  // — it evaluates only plain literals and bound identifiers. Bind them to
  // their computed values so the `configuration` subtree resolves.
  CONFIG_FILE_BASENAME: {
    importSource: "./product-identity.ts",
    value: CONFIG_FILE_BASENAME,
  },
  STATE_DIRECTORY_NAME: {
    importSource: "./product-identity.ts",
    value: STATE_DIRECTORY_NAME,
  },
});

const SCAN_EXCLUSIONS = new Set<string>(ROOT_POLICY.configuration.repositoryScanExclusions);
const SCAN_FILE_EXCLUSIONS = new Set<string>(ROOT_POLICY.configuration.repositoryScanFileExclusions);
const SCAN_FILE_SUFFIX_EXCLUSIONS = ROOT_POLICY.configuration.repositoryScanFileSuffixExclusions;
const HISTORICAL_RESEARCH_EVIDENCE_ALLOWLIST = new Set<string>(
  ROOT_POLICY.productBoundary.historicalResearchEvidenceAllowlist,
);
const EXPECTED_SOURCE_FILES = Object.freeze(ARCHITECTURE_MANIFEST.modules.flatMap((module) =>
  /^src\/[^/]+\.ts$/u.test(module.path) ? [module.path.slice("src/".length)] : []
).toSorted());
const EXPECTED_RUNTIME_SOURCE_FILES = registeredRuntimeProductionSourceFiles();
const TRUSTED_BOOTSTRAP_PATH = registeredArchitectureModulePath("bootstrap-permissions");
const REQUIREMENTS_REGISTRY_REFERENCE_SCHEMA = z.strictObject({
  path: z.literal(ROOT_POLICY.requirements.registryFile),
  schemaVersion: z.literal(ROOT_POLICY.requirements.registrySchemaVersion),
  fileSha256: z.literal(REQUIREMENTS_REGISTRY_FILE_SHA256),
  identityHash: z.literal(REQUIREMENTS_REGISTRY_IDENTITY_HASH),
});
const EXPECTED_CAPABILITIES = Object.freeze(Object.fromEntries(
  Object.entries(ROOT_POLICY.capabilities).map(([name, enabled]) => [name, enabled ? "enabled" : "disabled"]),
));
const ALLOWED_PRODUCTION_BUILTINS = new Set([
  "node:child_process", "node:crypto", "node:fs", "node:os", "node:path", "node:perf_hooks",
  "node:process", "node:readline", "node:sqlite", "node:test", "node:url", "node:util",
]);
const ALLOWED_PRODUCTION_DEPENDENCIES = new Set(["zod", "@babel/parser"]);
const FORBIDDEN_DEPENDENCY_PARTS = Object.freeze(["ai-sdk", "openai", "anthropic", "codex"]);
const FORBIDDEN_DEPENDENCY_NAMES = new Set(["ai", "@ai-sdk/openai-compatible"]);
const EXPECTED_OPEN_SYNC_CALLS: Readonly<Record<string, number>> = Object.freeze({
  "atomic-write.ts": 1,
  "config.ts": 2,
  "preflight.ts": 1,
});
const EXPECTED_BEHAVIORS = Object.freeze([
  { id: "S1-B01", name: "root policy immutability", requirements: ["REQ-024", "REQ-029", "DER-010"], scenarios: ["S1-B01-CONTROL", "S1-B01-FAILURE", "S1-B01-HOSTILE-REAL"] },
  { id: "S1-B02", name: "single configuration document, schema, hash, and freeze", requirements: ["REQ-001", "REQ-006", "REQ-024", "DER-010"], scenarios: ["S1-B02-CONTROL", "S1-B02-FAILURE", "S1-B02-HOSTILE-REAL"] },
  { id: "S1-B03", name: "authenticated principal and project authorization", requirements: ["REQ-024", "REQ-025", "DER-008", "DER-010"], scenarios: ["S1-B03-CONTROL", "S1-B03-FAILURE", "S1-B03-HOSTILE-REAL"] },
  { id: "S1-B04", name: "path capability and root identity", requirements: ["REQ-002", "REQ-005", "REQ-024", "REQ-025", "DER-004", "DER-005", "DER-010"], scenarios: ["S1-B04-CONTROL", "S1-B04-FAILURE", "S1-B04-HOSTILE-REAL"] },
  { id: "S1-B05", name: "classification and egress denial", requirements: ["REQ-004", "REQ-024", "REQ-025", "DER-003", "DER-008"], scenarios: ["S1-B05-CONTROL", "S1-B05-FAILURE", "S1-B05-HOSTILE-REAL"] },
  { id: "S1-B06", name: "deny-by-default composition and preflight", requirements: ["REQ-002", "REQ-013", "REQ-024", "DER-006", "DER-010"], scenarios: ["S1-B06-CONTROL", "S1-B06-FAILURE", "S1-B06-HOSTILE-REAL"] },
  { id: "S1-B07", name: "unsafe live-path quarantine", requirements: ["REQ-002", "REQ-013", "REQ-019", "REQ-020", "REQ-023", "REQ-024", "REQ-025", "DER-009", "DER-010"], scenarios: ["S1-B07-CONTROL", "S1-B07-FAILURE", "S1-B07-HOSTILE-REAL"] },
  { id: "S1-B08", name: "static literal classification and traceability", requirements: ["REQ-001", "REQ-006", "REQ-008", "REQ-029", "DER-011", "DER-018", "DER-028", "DER-035"], scenarios: ["S1-B08-CONTROL", "S1-B08-FAILURE", "S1-B08-HOSTILE-REAL"] },
  { id: "S1-B09", name: "standalone replacement product isolation", requirements: ["REQ-013", "REQ-024", "REQ-029", "REQ-032", "DER-021"], scenarios: ["S1-B09-CONTROL", "S1-B09-FAILURE", "S1-B09-HOSTILE-REAL"] },
  { id: "S1-B10", name: "historical source-schema isolation", requirements: ["REQ-005", "REQ-019", "REQ-020", "REQ-024", "REQ-029", "REQ-033", "DER-022"], scenarios: ["S1-B10-CONTROL", "S1-B10-FAILURE", "S1-B10-HOSTILE-REAL"] },
  { id: "S1-B11", name: "evidence-graph authority and no competing source of truth", requirements: ["REQ-009", "REQ-010", "REQ-016", "REQ-018", "REQ-020", "REQ-021", "REQ-025", "REQ-027", "REQ-029", "REQ-033", "REQ-034", "DER-007", "DER-009", "DER-017", "DER-022", "DER-023"], scenarios: ["S1-B11-CONTROL", "S1-B11-FAILURE", "S1-B11-HOSTILE-REAL"] },
  { id: "S1-B12", name: "universal policy authority and inherited extension conformance", requirements: ["REQ-001", "REQ-006", "REQ-010", "REQ-013", "REQ-014", "REQ-015", "REQ-018", "REQ-020", "REQ-024", "REQ-025", "REQ-026", "REQ-029", "REQ-034", "REQ-035", "DER-006", "DER-007", "DER-009", "DER-010", "DER-011", "DER-017", "DER-018", "DER-023", "DER-024", "DER-034", "DER-035", "DER-036", "DER-037", "DER-038"], scenarios: ["S1-B12-CONTROL", "S1-B12-FAILURE", "S1-B12-HOSTILE-REAL"] },
  { id: "S1-B13", name: "architecture manifest graph ownership and dual-surface audit", requirements: ["REQ-001", "REQ-005", "REQ-006", "REQ-008", "REQ-013", "REQ-014", "REQ-016", "REQ-017", "REQ-020", "REQ-025", "REQ-028", "REQ-029", "REQ-035", "DER-011", "DER-016", "DER-017", "DER-018", "DER-023", "DER-024", "DER-025", "DER-029", "DER-030", "DER-031", "DER-032", "DER-034", "DER-035", "DER-036"], scenarios: ["S1-B13-CONTROL", "S1-B13-FAILURE", "S1-B13-HOSTILE-REAL"] },
  { id: "S1-B14", name: "missing capability fail-closed and qualified equivalence", requirements: ["REQ-002", "REQ-003", "REQ-013", "REQ-028", "DER-006", "DER-024", "DER-025"], scenarios: ["S1-B14-CONTROL", "S1-B14-FAILURE", "S1-B14-HOSTILE-REAL"] },
  { id: "S1-B15", name: "progressive context, governed layout, deterministic scaffolding, bootstrap, interaction, and repository inspection target", requirements: ["REQ-002", "REQ-003", "REQ-010", "REQ-013", "REQ-014", "REQ-016", "REQ-017", "REQ-020", "REQ-025", "REQ-027", "REQ-028", "REQ-034", "DER-009", "DER-016", "DER-017", "DER-018", "DER-023", "DER-025", "DER-026", "DER-033", "DER-034", "DER-036", "DER-039", "DER-040", "DER-041", "DER-042", "DER-043"], scenarios: ["S1-B15-CONTROL", "S1-B15-FAILURE", "S1-B15-HOSTILE-REAL"] },
  { id: "S1-B16", name: "declarative agent modules and typed orchestra target", requirements: ["REQ-001", "REQ-002", "REQ-006", "REQ-009", "REQ-011", "REQ-013", "REQ-014", "REQ-016", "REQ-021", "REQ-025", "REQ-028", "REQ-035", "DER-006", "DER-007", "DER-009", "DER-017", "DER-023", "DER-024", "DER-025", "DER-027", "DER-034", "DER-036"], scenarios: ["S1-B16-CONTROL", "S1-B16-FAILURE", "S1-B16-HOSTILE-REAL"] },
]);
const S1_APPLICABILITY_DECLARATION = deepFreeze((() => {
  const references = [...new Set(EXPECTED_BEHAVIORS.flatMap((behavior) => behavior.requirements))];
  const requirementIds = references.filter((id) => id.startsWith("REQ-")).toSorted();
  const derivedControlIds = references.filter((id) => id.startsWith("DER-")).toSorted();
  return {
    orderedIds: [...requirementIds, ...derivedControlIds],
    requirementIds,
    derivedControlIds,
  };
})());
const TRACE_SCHEMA = z.strictObject({
  schemaVersion: z.literal(1),
  slice: z.literal("S1"),
  name: z.literal("preflight-only trust envelope"),
  auditMatrix: AUDIT_MATRIX_SCHEMA,
  requirementsRegistry: REQUIREMENTS_REGISTRY_REFERENCE_SCHEMA,
  supersedes: z.strictObject({
    commit: z.literal("9135fe4ec53d4e124d2bd4a30cc3ee7455604685"),
    reason: z.literal("fresh-checkout dogfood proved Git cannot preserve the required 0600 config mode"),
  }),
  requirements: z.array(z.string().regex(/^REQ-[0-9]{3}$/u))
    .length(S1_APPLICABILITY_DECLARATION.requirementIds.length),
  derivedControls: z.array(z.string().regex(/^DER-[0-9]{3}$/u))
    .length(S1_APPLICABILITY_DECLARATION.derivedControlIds.length),
  capabilityState: z.strictObject({
    preflight: z.literal("enabled"),
    mutableState: z.literal("disabled"),
    modelInvocation: z.literal("disabled"),
    modelTools: z.literal("disabled"),
    retryDispatch: z.literal("disabled"),
    repositoryMutation: z.literal("disabled"),
    processExecution: z.literal("disabled"),
    networkEgress: z.literal("disabled"),
    sensitiveInput: z.literal("disabled"),
    durableAudit: z.literal("disabled"),
  }),
  literalAuthorities: z.strictObject({
    configurableParameters: z.literal("exact repo-root bridlewise.config.json validated by CONFIG_DOCUMENT_SCHEMA"),
    rootOfTrustInvariants: z.literal("ROOT_POLICY with registry-resolved applicable IDs and canonical hash"),
    derivedValues: z.literal("integrity-only content hashes, OS principal identity, project identity, and provisional descriptor decisions"),
    testFixtureValues: z.literal("test/** only"),
    protocolConstants: z.literal("schema versions, stable error codes, exact preflight and trusted permission-bootstrap commands, and traceability IDs"),
  }),
  trustedSetup: z.strictObject({
    actor: z.literal("human-or-trusted-supervisor"),
    command: z.literal("node scripts/bootstrap-permissions.ts"),
    modelFacing: z.literal(false),
    productReachable: z.literal(false),
    requiredMode: z.literal("0600"),
    target: z.literal("exact-pinned-bridlewise.config.json"),
  }),
  behaviors: z.array(z.strictObject({
    id: z.string(),
    name: z.string(),
    requirements: z.array(z.string()).min(1),
    scenarios: z.array(z.string()).length(3),
  })).length(16),
  acceptance: z.strictObject({
    scenarioKinds: z.tuple([
      z.literal("control"), z.literal("ordinary-failure"), z.literal("hostile-real-boundary"),
    ]),
    minimumScenariosPerBehavior: z.literal(3),
    modelMayNotScoreItself: z.literal(true),
    emptyOrSkippedScenarioFails: z.literal(true),
    candidateMustBeFrozenBeforeFinalHashAudit: z.literal(true),
    receiptAuthenticityClaim: z.literal("none-self-integrity-only"),
  }),
});

type Trace = z.infer<typeof TRACE_SCHEMA>;

function invalidCandidateRootVerification(): S1Verification {
  return deepFreeze({
    ok: false,
    repositoryManifestHash: canonicalHash(["invalid-candidate-root"]),
    violations: ["candidate-root-invalid"],
  });
}

// Content-hash memoization of verifyS1Structure. The function is a pure
// function of the filesystem at `root`: it reads files, parses TypeScript
// with Babel, and derives violations — no writes, no mutable global state.
// `recursiveManifest` hashes the SHA-256 of every file's content into
// `manifest.hash`, so an identical manifest hash guarantees identical file
// content and therefore an identical verification result. The manifest walk
// (~200ms for a candidate, ~1-2s for the full repo) is always paid; the
// expensive verify* phase (~9s, dominated by the Babel parse of every source
// file) is skipped on a cache hit.
//
// The serial test phase uses process isolation (each serial file runs in its
// own node process), so the in-memory cache is per-process and NOT shared
// across the ~8-12 serial processes. Each S1 scenario process pays the cold
// parse on its first verifyS1Structure(REPOSITORY_ROOT) call (~7-12s). The
// FILESYSTEM-BACKED cache (under os.tmpdir()/harness-s1-cache/) is shared
// across all processes on the machine, keyed by the manifest content hash.
// The first process to verify a given manifest hash computes + writes; the
// rest read the cached result instead of re-parsing. This collapses the
// ~10× baseline verifyS1Structure(REPOSITORY_ROOT) calls to 1 compute + 9
// hits. Threshold-triggered trimming currently has a delayed-reset race;
// strict capacity and concurrent bounds remain required repairs.
// Best-effort: a filesystem failure (read-only tmpdir, full disk) falls
// through to computation with no correctness impact.
import { DEFAULT_S1_VERIFICATION_CACHE_MAX_ENTRIES, DEFAULT_S1_FILESYSTEM_CACHE_MAX_ENTRIES, DEFAULT_S1_FILESYSTEM_CACHE_DIRECTORY, DEFAULT_STATIC_LITERAL_PARSE_CACHE_MAX_ENTRIES, DEFAULT_STATIC_LITERAL_EXTRACTION_FILESYSTEM_CACHE_MAX_ENTRIES } from "../../src/workflow/workflow-config.ts";
import { clearArchitectureSourceCache } from "../verification/architecture.ts";
import { clearStaticModuleShapeCache } from "../verification/static-source.ts";
import { clearGovernedSourceParseCache } from "../tooling/verification/governed-source.ts";
import { analysisSemanticsId, createFilesystemCache, createSharedWriteCounter } from "../verification/filesystem-cache.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { shouldExcludeExperiment } from "../../src/shared/source-scan.ts";
const s1VerificationCache = new Map<string, S1Verification>();

const S1_FILESYSTEM_CACHE_SCHEMA_VERSION = "bridlewise-s1-filesystem-cache/v1" as const;

function s1FilesystemCacheDirectory(): string {
  return join(tmpdir(), DEFAULT_S1_FILESYSTEM_CACHE_DIRECTORY);
}

// The shared counter supplies the trim trigger; append/stat/trim/reset are
// separate operations and do not provide a process-independent capacity bound.
const s1FilesystemCacheWriteCounter = createSharedWriteCounter(
  s1FilesystemCacheDirectory(),
  DEFAULT_S1_FILESYSTEM_CACHE_MAX_ENTRIES,
);

function s1FilesystemCachePath(manifestHash: string): string {
  return join(s1FilesystemCacheDirectory(), `${manifestHash}.json`);
}

type CachedS1Verification = Readonly<{
  schemaVersion: string;
  manifestHash: string;
  result: S1Verification;
}>;

function readS1FilesystemCache(manifestHash: string): S1Verification | undefined {
  return bestEffort(() => {
    const path = s1FilesystemCachePath(manifestHash);
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== S1_FILESYSTEM_CACHE_SCHEMA_VERSION) return undefined;
    if (typeof record.manifestHash !== "string" || record.manifestHash !== manifestHash) return undefined;
    if (typeof record.result !== "object" || record.result === null) return undefined;
    const result = record.result as Record<string, unknown>;
    if (typeof result.ok !== "boolean" || result.repositoryManifestHash !== manifestHash ||
      !Array.isArray(result.violations) || !result.violations.every((entry) => typeof entry === "string") ||
      result.ok !== (result.violations.length === 0)) return undefined;
    return deepFreeze({
      ok: result.ok,
      repositoryManifestHash: result.repositoryManifestHash,
      violations: [...result.violations].toSorted(),
    }) as S1Verification;
  }) ?? undefined;
}

function writeS1FilesystemCache(manifestHash: string, result: S1Verification): void {
  bestEffort(() => {
    const directory = s1FilesystemCacheDirectory();
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
    const entry: CachedS1Verification = deepFreeze({
      schemaVersion: S1_FILESYSTEM_CACHE_SCHEMA_VERSION,
      manifestHash,
      result,
    });
    const writeResult = atomicWriteFile(s1FilesystemCachePath(manifestHash), `${canonicalJson(entry)}\n`);
    if (!writeResult.success) {
      reportBestEffortFailure();
      return;
    }
    // Shared threshold-triggered trimming is not a strict entry cap: the
    // append/stat/trim/reset protocol still requires a concurrency repair.
    if (s1FilesystemCacheWriteCounter.increment()) {
      trimS1FilesystemCache();
      s1FilesystemCacheWriteCounter.reset();
    }
  });
}

function trimS1FilesystemCache(): void {
  bestEffort(() => {
    const directory = s1FilesystemCacheDirectory();
    const entries = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const stats = statSync(join(directory, name));
        return { name, mtimeMs: stats.mtimeMs };
      })
      .toSorted((left, right) => left.mtimeMs - right.mtimeMs);
    const excess = entries.length - DEFAULT_S1_FILESYSTEM_CACHE_MAX_ENTRIES;
    if (excess <= 0) return;
    for (let index = 0; index < excess; index += 1) {
      bestEffort(() => {
        unlinkSync(join(directory, entries[index]!.name));
      });
    }
  });
}

export function clearVerifyS1StructureCache(): void {
  s1VerificationCache.clear();
  clearArchitectureSourceCache();
  clearStaticModuleShapeCache();
  clearGovernedSourceParseCache();
  clearStaticLiteralParseCache();
}

// Current safe bytes belong to one verification. The map is created at the
// public entry, passed through its consumers, and released on every return.
// Metadata cannot certify bytes from another verification or candidate root.
type ManifestFileContent = { bytes: Uint8Array; text?: string };
type ManifestFileContents = Map<string, ManifestFileContent>;

function cachedReadFileText(root: string, path: string, contents: ManifestFileContents): string | undefined {
  let content = contents.get(path);
  if (content === undefined) {
    try {
      const read = readSafeRepositoryFile(root, path, ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes);
      content = { bytes: read.bytes };
      contents.set(path, content);
    } catch {
      return undefined;
    }
  }
  // Architecture accepts replacement characters. Candidate policy decoding
  // remains fatal at readSafeCandidateText; these answers are not shared.
  return content.text ??= new TextDecoder("utf-8", { fatal: false }).decode(content.bytes);
}

export function verifyS1Structure(candidateRoot: string): S1Verification {
  if (typeof candidateRoot !== "string") return invalidCandidateRootVerification();
  const root = resolve(candidateRoot);
  const violations: string[] = [];
  const contents: ManifestFileContents = new Map();
  const manifest = recursiveManifest(root, violations, contents);
  if (!manifest.safeForConsumers) {
    const unsafeResult = deepFreeze({
      ok: false,
      repositoryManifestHash: manifest.hash,
      violations: [...new Set(violations)].toSorted(),
    });
    cacheS1Verification(manifest.hash, unsafeResult);
    return unsafeResult;
  }
  const cached = s1VerificationCache.get(manifest.hash);
  if (cached !== undefined) {
    return cached;
  }
  // Filesystem-backed cache: shared across serial-phase processes. The
  // in-memory cache is per-process (the serial phase uses
  // isolation: "process"), so each S1 scenario process starts with a cold
  // in-memory cache. The filesystem cache (keyed by manifest hash, shared
  // across all processes on the machine) lets the first process to verify a
  // given manifest hash share its result with the rest. A cache hit here
  // skips the expensive verify* phase (~9s of Babel parsing).
  const filesystemCached = readS1FilesystemCache(manifest.hash);
  if (filesystemCached !== undefined) {
    s1VerificationCache.set(manifest.hash, filesystemCached);
    return filesystemCached;
  }
  verifyArtifactAdmission({ root, paths: manifest.paths }, violations);
  verifyStandaloneProductBoundary(root, manifest.paths, violations, contents);
  verifyEvidenceGraphAuthority(root, manifest.paths, violations, contents);
  verifyUniversalPolicyArchitecture(root, manifest.paths, violations);
  verifyAdditionalRootPolicyAuthorities(root, violations);
  verifyTestExecutionOperationAuthority(root, violations);
  verifyConfigContract(root, violations);
  verifyConfigurationSurface(root, manifest.paths, violations);
  verifySourceManifest(manifest.paths, violations);
  verifyArchitecture(root, manifest.paths, violations, contents);
  verifyTrustedBootstrapSurface(root, manifest.paths, violations);
  verifyPackageAndLock(root, violations);
  verifyProductionGraph(root, violations);
  verifyStaticConfigurationSources(root, violations);
  verifyNoProductionEffects(root, violations);
  const requirementsRegistry = verifyRequirementsRegistry(root, manifest.paths, violations);
  try {
    loadTestInventory(root);
  } catch {
    violations.push("test-inventory-invalid-or-incomplete");
  }
  const trace = parseTrace(join(root, "traceability", "s1.json"), violations);
  if (trace) verifyTrace(trace, requirementsRegistry, violations);
  const activeSliceReferences = verifySliceTraces({
    root,
    paths: manifest.paths,
    registry: requirementsRegistry,
    violations,
  });
  if (trace && requirementsRegistry) {
    try {
      const expectedRootPolicyIds = [...requirementRegistryIds(requirementsRegistry, [
        ...trace.requirements,
        ...trace.derivedControls,
        ...activeSliceReferences,
      ])];
      if (!sameOrderedValues(ROOT_POLICY.requirements.applicableIds, expectedRootPolicyIds)) {
        violations.push("root-policy-trace-id-mismatch");
      }
    } catch {
      violations.push("root-policy-trace-id-projection-invalid");
    }
  }
  violations.push(...requirementsRootBindingViolations(ROOT_POLICY.requirements));
  if (requirementsRegistry) {
    verifyRequirementReferences(
      ROOT_POLICY.requirements.applicableIds,
      requirementsRegistry,
      "root-policy",
      violations,
    );
  }
  const result = deepFreeze({
    ok: violations.length === 0,
    repositoryManifestHash: manifest.hash,
    violations: [...new Set(violations)].toSorted(),
  });
  cacheS1Verification(manifest.hash, result);
  return result;
}

function cacheS1Verification(manifestHash: string, result: S1Verification): void {
  if (s1VerificationCache.size >= DEFAULT_S1_VERIFICATION_CACHE_MAX_ENTRIES) {
    // Evict the oldest entry (FIFO) to bound memory. A test run produces at
    // most ~117 distinct hashes, well under the cap; this guard only matters
    // for pathological inventories.
    const oldest = s1VerificationCache.keys().next();
    if (!oldest.done) s1VerificationCache.delete(oldest.value);
  }
  s1VerificationCache.set(manifestHash, result);
  // Best-effort filesystem cache write: shared across serial-phase processes.
  // A write failure reports through the fixed best-effort diagnostic; the
  // in-memory cache + computation are still correct, just slower for other
  // processes that miss the filesystem cache.
  writeS1FilesystemCache(manifestHash, result);
}

function verifyArchitecture(root: string, paths: readonly string[], violations: string[], contents: ManifestFileContents): void {
  const sources = paths
    .filter((path) => ARCHITECTURE_MANIFEST.sourceRoots.some((prefix) => path.startsWith(prefix)) &&
      ARCHITECTURE_SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) &&
      !isTransientSourcePath(path))
    .map((path) => {
      const source = cachedReadFileText(root, path, contents);
      if (source === undefined) {
        violations.push(`architecture-source-unreadable:${path}`);
        return undefined;
      }
      return { path, source };
    })
    .filter((entry): entry is { path: string; source: string } => entry !== undefined);
  const externalCommandSources = readExternalCommandSources(root, violations);
  violations.push(...verifyArchitectureSources(
    sources,
    ARCHITECTURE_MANIFEST,
    externalCommandSources,
  ).violations);
}

function readExternalCommandSources(
  root: string,
  violations: string[],
): readonly ArchitectureSource[] {
  const entries: ArchitectureSource[] = [];
  for (const command of ARCHITECTURE_MANIFEST.externalCommands) {
    // A source the public snapshot declares not-published is EXPECTED absent:
    // the architecture verifier names that boundary itself. Only an
    // unexpected source at the path is read, so it can be refused as an
    // accidental publication (and hash-checked for a diagnostic receipt).
    if (command.publication === "not-published" && !existsSync(join(root, command.path))) continue;
    try {
      const bytes = readSafeRepositoryFile(
        root,
        command.path,
        ARCHITECTURE_MANIFEST.analysisLimits.maximumSourceBytes,
      ).bytes;
      entries.push({
        path: command.path,
        source: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      });
    } catch (error) {
      violations.push(`architecture-external-command-source-unreadable:${command.path}:${extractErrorMessage(error)}`);
    }
  }
  return deepFreeze(entries);
}

function isTransientSourcePath(path: string): boolean {
  return path.slice(path.lastIndexOf("/") + 1).startsWith(".");
}

export function verifyS1Repository(candidateRoot: string, testReceipt: unknown): S1Verification {
  if (typeof candidateRoot !== "string") return invalidCandidateRootVerification();
  const structure = verifyS1Structure(candidateRoot);
  const violations = [...structure.violations];
  try {
    const manifest = buildCandidateManifest(candidateRoot);
    const inventory = loadTestInventory(candidateRoot);
    violations.push(...validateTestReceipt(testReceipt, candidateTestIdentity(manifest), inventory));
  } catch (error) {
    const candidateFormatViolations = candidateFormatErrorViolations(error);
    if (candidateFormatViolations === undefined) violations.push("candidate-manifest-or-test-receipt-unavailable");
    else violations.push(...candidateFormatViolations);
  }
  return deepFreeze({
    ok: violations.length === 0,
    repositoryManifestHash: structure.repositoryManifestHash,
    violations: [...new Set(violations)].toSorted(),
  });
}

function recursiveManifest(
  root: string,
  violations: string[],
  contents: ManifestFileContents,
): Readonly<{ paths: readonly string[]; hash: string; safeForConsumers: boolean }> {
  const records: Array<Readonly<Record<string, string | number>>> = [];
  let safeForConsumers = true;
  const rootBoundary = inspectSafeRepositoryRootBoundary(root);
  if (!rootBoundary.ok) {
    violations.push(`repository-root-boundary:${rootBoundary.code ?? "unknown"}`);
    return { paths: [], hash: canonicalHash(records), safeForConsumers: false };
  }
  try {
    listSafeRepositoryTree(root, "src", {
      maximumDepth: ROOT_POLICY.verification.testDiscovery.maximumDepth,
      maximumEntries: ROOT_POLICY.verification.testDiscovery.maximumEntries,
      excludedDirectory: shouldExcludeExperiment,
    });
  } catch {
    violations.push("repository-root-or-source-tree-unsafe");
    return { paths: [], hash: canonicalHash(records), safeForConsumers: false };
  }
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name));
    } catch {
      violations.push(`manifest-directory-unreadable:${relative(root, directory) || "."}`);
      safeForConsumers = false;
      return;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      let stats: Stats;
      try {
        stats = lstatSync(absolute);
      } catch {
        violations.push(`manifest-entry-unreadable:${path}`);
        safeForConsumers = false;
        continue;
      }
      const excludedDirectory = SCAN_EXCLUSIONS.has(entry.name);
      const excludedFile = SCAN_FILE_EXCLUSIONS.has(entry.name) ||
        SCAN_FILE_SUFFIX_EXCLUSIONS.some((suffix) => entry.name.endsWith(suffix));
      if (excludedDirectory || excludedFile) {
        // An excluded entry that is a symlink (e.g. `node_modules` or
        // `large-codebases` shared via a symlink with a sibling workspace) is
        // a valid exclusion: it is excluded regardless of whether the leaf is
        // a directory or a symlink-to-directory. Rejecting it as
        // `manifest-exclusion-invalid` would mark the whole tree unsafe for
        // consumers and abort verification before the architecture findings
        // are reported. Accept a symlink as a valid excluded directory/file.
        if ((excludedDirectory && !stats.isDirectory() && !stats.isSymbolicLink()) ||
          (excludedFile && !stats.isFile() && !stats.isSymbolicLink())) {
          violations.push(`manifest-exclusion-invalid:${path}`);
          safeForConsumers = false;
        }
        continue;
      }
      if (stats.isSymbolicLink()) {
        violations.push(`repository-symlink:${path}`);
        safeForConsumers = false;
        records.push({ path, type: "symlink", mode: (stats.mode & 0o7777).toString(8), bytes: stats.size });
        continue;
      }
      if (stats.isDirectory()) {
        records.push({ path, type: "directory", mode: (stats.mode & 0o7777).toString(8), bytes: 0 });
        visit(absolute);
        continue;
      }
      if (!stats.isFile()) {
        violations.push(`repository-special-entry:${path}`);
        safeForConsumers = false;
        continue;
      }
      if (hasSecondName(stats.nlink)) {
        violations.push(`repository-hardlink:${path}`);
        safeForConsumers = false;
        records.push({
          path,
          type: "hardlink",
          mode: (stats.mode & 0o7777).toString(8),
          bytes: stats.size,
          links: stats.nlink,
        });
        continue;
      }
      let read;
      try {
        read = readSafeRepositoryFile(
          root,
          path,
          ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
        );
      } catch {
        violations.push(`manifest-entry-unreadable:${path}`);
        safeForConsumers = false;
        records.push({
          path,
          type: "unreadable-file",
          mode: (stats.mode & 0o7777).toString(8),
          bytes: stats.size,
        });
        continue;
      }
      const fileSha256 = sha256(read.bytes);
      records.push({
        path,
        type: "file",
        mode: (read.mode & 0o7777).toString(8),
        bytes: read.bytes.length,
        sha256: fileSha256,
      });
      contents.set(path, { bytes: read.bytes });
    }
  };
  visit(root);
  return {
    paths: records.map((record) => String(record.path)),
    hash: canonicalHash(records),
    safeForConsumers,
  };
}

/** Read the actual candidate leaf; a canonical binding is not a source witness. */
function candidateLexicalPolicyMatches(root: string): boolean {
  const source = readSafeCandidateText(
    root,
    join(dirname(ROOT_POLICY.sourcePath), ROOT_POLICY_STATIC_LITERAL_IDENTIFIER_BINDINGS.LEXICAL_REUSE_LIMITS!.importSource),
    ROOT_POLICY.forensics.limits.maximumInputBytes,
  );
  if (source === undefined) return false;
  const program = parseStaticLiteralSource(source);
  if (program === undefined) return false;
  const statements = staticLiteralAstNodeArray(program.body);
  // The dependency-free leaf has one frozen export. No import, shadowed
  // Object, extra statement or executable initializer is admitted here.
  if (statements.length !== 1 || statements[0]!.type !== "ExportNamedDeclaration") return false;
  const declaration = staticLiteralAstNode(statements[0]!.declaration);
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") return false;
  const declarators = staticLiteralAstNodeArray(declaration.declarations);
  if (declarators.length !== 1) return false;
  const identifier = staticLiteralAstNode(declarators[0]!.id);
  const initializer = unwrapStaticLiteralExpression(staticLiteralAstNode(declarators[0]!.init));
  if (identifier?.type !== "Identifier" || identifier.name !== "LEXICAL_REUSE_LIMITS" || initializer?.type !== "CallExpression") return false;
  const callee = staticLiteralAstNode(initializer.callee);
  const object = callee ? staticLiteralAstNode(callee.object) : undefined;
  const property = callee ? staticLiteralAstNode(callee.property) : undefined;
  const args = staticLiteralAstNodeArray(initializer.arguments);
  if (callee?.type !== "MemberExpression" || callee.computed === true || object?.type !== "Identifier" || object.name !== "Object" || property?.type !== "Identifier" || property.name !== "freeze" || args.length !== 1) return false;
  const value = evaluateStaticLiteral(args[0]!, ROOT_POLICY.forensics.limits.maximumDepth);
  return value.ok && canonicalHash(value.value) === canonicalHash(ROOT_POLICY.verification.lexicalReuse);
}

function verifyConfigContract(root: string, violations: string[]): void {
  if (!candidateLexicalPolicyMatches(root)) {
    violations.push("config-contract-lexical-policy-projection");
    return;
  }
  const candidateRootPolicySource = readSafeCandidateText(
    root,
    ROOT_POLICY.sourcePath,
    ROOT_POLICY.forensics.limits.maximumInputBytes,
  );
  if (candidateRootPolicySource === undefined) {
    violations.push("config-contract-root-policy-unreadable");
    return;
  }
  const candidate = candidateConfigContractProjection(candidateRootPolicySource);
  if (candidate === undefined) {
    violations.push("config-contract-root-policy-projection");
    return;
  }

  try {
    if (canonicalHash(candidate.rootContract) !== canonicalHash(ROOT_POLICY.configuration.contract) ||
      canonicalHash(candidate.rootContracts) !== canonicalHash(ROOT_POLICY.contracts)) {
      violations.push("config-contract-root-policy-projection");
      return;
    }
  } catch {
    violations.push("config-contract-root-policy-projection");
    return;
  }
  let candidateContract: ReturnType<typeof buildConfigContract>;
  try {
    candidateContract = buildConfigContract(candidate.policy);
  } catch {
    violations.push("config-contract-root-policy-projection");
    return;
  }
  if (canonicalHash(candidateContract.artifact) !== canonicalHash(getConfigContractArtifact())) {
    violations.push("config-contract-root-policy-projection");
    return;
  }

  const sourcePath = ROOT_POLICY.configuration.contract.sourcePath;
  let candidateSourceBytes: Uint8Array;
  try {
    candidateSourceBytes = readSafeRepositoryFile(
      root,
      sourcePath,
      ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
    ).bytes;
  } catch {
    violations.push("config-contract-source-unreadable");
    return;
  }
  if (sha256(candidateSourceBytes) !== candidate.policy.configuration.contract.sourceSha256) {
    violations.push("config-contract-source-hash");
  }

  const artifactPath = ROOT_POLICY.configuration.contract.generatedSchemaPath;
  let artifactText: string;
  try {
    artifactText = new TextDecoder("utf-8", { fatal: true }).decode(readSafeRepositoryFile(
      root,
      artifactPath,
      ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
    ).bytes);
  } catch {
    violations.push("config-contract-artifact-unreadable");
    return;
  }
  try {
    assertNoDuplicateJsonObjectKeys(
      artifactText,
      "Config contract artifact contains duplicate keys",
      "config_contract_artifact_key_duplicate",
    );
    const artifact: unknown = JSON.parse(artifactText);
    const expectedArtifactText = configContractArtifactText(candidateContract.artifact);
    if (artifactText !== expectedArtifactText || canonicalHash(artifact) !== canonicalHash(
      candidateContract.artifact,
    )) {
      violations.push("config-contract-artifact-drift");
    }
  } catch {
    violations.push("config-contract-artifact-invalid");
  }
}

function candidateConfigContractProjection(source: string): CandidateConfigContractProjection | undefined {
  const configuration = extractBoundedTopLevelStaticLiteral(
    source,
    "ROOT_POLICY_VALUE",
    ["configuration"],
    ROOT_POLICY_STATIC_LITERAL_BOUNDARY,
    ROOT_POLICY_STATIC_LITERAL_IDENTIFIER_BINDINGS,
  );
  const contracts = extractBoundedTopLevelStaticLiteral(
    source,
    "ROOT_POLICY_VALUE",
    ["contracts"],
    ROOT_POLICY_STATIC_LITERAL_BOUNDARY,
    ROOT_POLICY_STATIC_LITERAL_IDENTIFIER_BINDINGS,
  );
  const universalPolicyArchitecture = extractBoundedTopLevelStaticLiteral(
    source,
    "ROOT_POLICY_VALUE",
    ["universalPolicyArchitecture"],
    ROOT_POLICY_STATIC_LITERAL_BOUNDARY,
    ROOT_POLICY_STATIC_LITERAL_IDENTIFIER_BINDINGS,
  );
  const verification = extractBoundedTopLevelStaticLiteral(
    source,
    "ROOT_POLICY_VALUE",
    ["verification"],
    ROOT_POLICY_STATIC_LITERAL_BOUNDARY,
    ROOT_POLICY_STATIC_LITERAL_IDENTIFIER_BINDINGS,
  );
  const runtime = extractBoundedTopLevelStaticLiteral(
    source,
    "ROOT_POLICY_VALUE",
    ["runtime"],
    ROOT_POLICY_STATIC_LITERAL_BOUNDARY,
  );
  const tools = extractBoundedTopLevelStaticLiteral(
    source,
    "ROOT_POLICY_VALUE",
    ["tools"],
    ROOT_POLICY_STATIC_LITERAL_BOUNDARY,
  );
  const editor = extractBoundedTopLevelStaticLiteral(
    source,
    "ROOT_POLICY_VALUE",
    ["editor"],
    ROOT_POLICY_STATIC_LITERAL_BOUNDARY,
  );
  const timeline = extractBoundedTopLevelStaticLiteral(
    source,
    "ROOT_POLICY_VALUE",
    ["timeline"],
    ROOT_POLICY_STATIC_LITERAL_BOUNDARY,
  );
  const resourceLock = extractBoundedTopLevelStaticLiteral(
    source,
    "ROOT_POLICY_VALUE",
    ["resourceLock"],
    ROOT_POLICY_STATIC_LITERAL_BOUNDARY,
  );
  const evaluation = extractBoundedTopLevelStaticLiteral(
    source,
    "ROOT_POLICY_VALUE",
    ["evaluation"],
    ROOT_POLICY_STATIC_LITERAL_BOUNDARY,
  );
  const migrationAuthority = extractBoundedTopLevelStaticLiteral(
    source,
    "ROOT_POLICY_VALUE",
    ["migrationAuthority"],
    ROOT_POLICY_STATIC_LITERAL_BOUNDARY,
  );
  if (!configuration.ok || !contracts.ok || !universalPolicyArchitecture.ok || !verification.ok ||
    !runtime.ok || !tools.ok || !editor.ok || !timeline.ok || !resourceLock.ok ||
    !evaluation.ok || !migrationAuthority.ok ||
    !isStaticLiteralRecord(configuration.value) ||
    !isStaticLiteralRecord(configuration.value.contract) ||
    !isStaticLiteralRecord(verification.value) ||
    !isStaticLiteralRecord(runtime.value) ||
    !isStaticLiteralRecord(tools.value) ||
    !isStaticLiteralRecord(editor.value) ||
    !isStaticLiteralRecord(timeline.value) ||
    !isStaticLiteralRecord(resourceLock.value) ||
    !isStaticLiteralRecord(evaluation.value) ||
    !isStaticLiteralRecord(migrationAuthority.value)) {
    return undefined;
  }
  const policy = {
    configuration: configuration.value,
    contracts: contracts.value,
    universalPolicyArchitecture: universalPolicyArchitecture.value,
    verification: verification.value,
    runtime: runtime.value,
    tools: tools.value,
    editor: editor.value,
    timeline: timeline.value,
    resourceLock: resourceLock.value,
    evaluation: evaluation.value,
    migrationAuthority: migrationAuthority.value,
  } as ConfigContractPolicyProjection;
  return {
    policy,
    rootContract: configuration.value.contract,
    rootContracts: contracts.value,
  };
}

function isStaticLiteralRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function readSafeCandidateText(root: string, path: string, maximumBytes: number): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      readSafeRepositoryFile(root, path, maximumBytes).bytes,
    );
  } catch {
    return undefined;
  }
}

function verifyConfigurationSurface(root: string, paths: readonly string[], violations: string[]): void {
  const configs = paths.filter((path) => path.endsWith(".config.json"));
  if (!sameOrderedValues(configs, [ROOT_POLICY.configuration.basename])) {
    violations.push("single-pinned-config-document");
  }
  // Through the ONE config read/refusal API (UTF-8, duplicate keys, JSON,
  // object shape — typed codes), never a lossy `JSON.parse(readFileSync)`;
  // the refusal is REPORTED as the violation, with its own code.
  const inspection = inspectConfigDocument(configDocumentPath(root));
  if (inspection.state !== "ok") violations.push(`config-document-refused:${inspection.state === "absent" ? "config_not_found" : inspection.code}`);
  const config = inspection.state === "ok" ? inspection.document : undefined;
  if (!getConfigDocumentSchema().safeParse(config).success || !isPlainObject(config) || !isPlainObject(config.project) ||
    config.project.root !== ROOT_POLICY.configuration.projectRootLiteral) {
    violations.push("pinned-config-root-invalid");
  }
}

function verifySourceManifest(paths: readonly string[], violations: string[]): void {
  const actual = paths.filter((path) => /^src\/[^/]+\.ts$/u.test(path))
    .map((path) => path.slice("src/".length)).toSorted();
  if (!sameOrderedValues(actual, [...EXPECTED_SOURCE_FILES].toSorted())) {
    violations.push("s1-production-source-manifest");
  }
  for (const forbidden of ["core.ts", "store.ts", "state-boundary.ts", "text-validation.ts", "agent.ts", "model.ts", "workspace.ts"]) {
    if (paths.includes(`src/${forbidden}`)) violations.push(`forbidden-production-source:${forbidden}`);
  }
}

function isHistoricalResearchEvidencePath(path: string): boolean {
  return [...HISTORICAL_RESEARCH_EVIDENCE_ALLOWLIST].some((allowed) => {
    if (!allowed.endsWith("/")) return path === allowed;
    return path === allowed.slice(0, -1) || path.startsWith(allowed);
  });
}

function verifyStandaloneProductBoundary(
  root: string,
  paths: readonly string[],
  violations: string[],
  contents: ManifestFileContents,
): void {
  const candidateRootPolicy = readSafeCandidateText(
    root,
    ROOT_POLICY.sourcePath,
    ROOT_POLICY.forensics.limits.maximumInputBytes,
  );
  if (candidateRootPolicy === undefined) {
    violations.push("standalone-product-boundary-root-source-unreadable");
  } else {
    if (!staticRootPolicySubtreeMatches(
      candidateRootPolicy,
      ["productBoundary"],
      ROOT_POLICY.productBoundary,
    )) {
      violations.push("standalone-product-boundary-root-source");
    }
    if (!staticRootPolicySubtreeMatches(
      candidateRootPolicy,
      ["storageArchitecture"],
      ROOT_POLICY.storageArchitecture,
    )) {
      violations.push("historical-source-schema-root-source");
    }
  }

  for (const path of paths) {
    if (isHistoricalResearchEvidencePath(path)) continue;
    if (containsExternalApplicationReference(path)) {
      violations.push(`standalone-product-boundary-reference:${path}`);
    }
    if (containsUniqueHistoricalSchemaMarker(path)) {
      violations.push(`historical-source-schema-marker:${path}`);
    }
    const absolute = join(root, path);
    let stats: Stats;
    try {
      stats = lstatSync(absolute);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    const source = cachedReadFileText(root, path, contents);
    if (source === undefined) {
      violations.push(`standalone-product-boundary-file-unreadable:${path}`);
      continue;
    }
    if (isTypeScriptLikePath(path)) {
      if (isGovernedTypeScriptPath(path)) {
        verifyGovernedTypeScriptSource(
          path,
          architectureRegistryProductBoundaryProjection(path, source),
          violations,
          path.startsWith("src/"),
          allowedEffectIdentifiersForPath(path),
        );
      }
      continue;
    }
    if (containsExternalApplicationReference(source)) {
      violations.push(`standalone-product-boundary-reference:${path}`);
    }
    if (containsUniqueHistoricalSchemaMarker(source)) {
      violations.push(`historical-source-schema-marker:${path}`);
    }
    if (containsCoupledLegacySourceSchema(source)) {
      violations.push(`historical-source-schema-coupling:${path}`);
    }
  }
}

function allowedEffectIdentifiersForPath(path: string): ReadonlySet<string> {
  const module = ARCHITECTURE_MANIFEST.modules.find((entry) => entry.path === path);
  if (module === undefined) return new Set();
  const allowed = new Set<string>();
  if (module.effects.includes("filesystem-write")) {
    for (const api of FILESYSTEM_WRITE_APIS) allowed.add(api);
    for (const flag of FILESYSTEM_WRITE_FLAG_NAMES) allowed.add(flag);
    allowed.add("umask");
  }
  if (module.effects.includes("filesystem-read") || module.effects.includes("filesystem-write")) {
    allowed.add("symlink");
  }
  if (module.effects.includes("network")) {
    allowed.add("fetch");
  }
  if (module.effects.includes("process-status") || module.effects.includes("process-control")) {
    allowed.add("abort");
    allowed.add("kill");
  }
  if (module.effects.includes("environment-access")) {
    allowed.add("env");
  }
  return allowed;
}

function architectureRegistryProductBoundaryProjection(path: string, source: string): string {
  if (path !== "src/architecture-manifest.ts") return source;
  let projected = source;
  const allowedReferences = ARCHITECTURE_MANIFEST.modules
    .map((module) => module.path)
    .filter((modulePath) => isHistoricalResearchEvidencePath(modulePath) &&
      containsExternalApplicationReference(modulePath));
  for (const reference of allowedReferences) {
    projected = projected.replaceAll(
      JSON.stringify(reference),
      JSON.stringify("verification/benchmarks/[registered-historical-research-source]"),
    );
  }
  return projected;
}

function verifyEvidenceGraphAuthority(
  root: string,
  paths: readonly string[],
  violations: string[],
  contents: ManifestFileContents,
): void {
  if (new Set(ROOT_POLICY.evidenceGraphArchitecture.eventEnvelope.typedIdentities).size !==
    ROOT_POLICY.evidenceGraphArchitecture.eventEnvelope.typedIdentities.length ||
    new Set(ROOT_POLICY.evidenceGraphArchitecture.edgeTypes).size !==
    ROOT_POLICY.evidenceGraphArchitecture.edgeTypes.length) {
    violations.push("evidence-graph-taxonomy-invalid");
  }

  const rootPolicySource = readSafeCandidateText(
    root,
    ROOT_POLICY.sourcePath,
    ROOT_POLICY.forensics.limits.maximumInputBytes,
  );
  if (rootPolicySource === undefined) {
    violations.push("evidence-graph-root-source-unreadable");
  } else if (!staticRootPolicySubtreeMatches(
    rootPolicySource,
    ["evidenceGraphArchitecture"],
    ROOT_POLICY.evidenceGraphArchitecture,
  )) {
    violations.push("evidence-graph-root-source");
  }

  for (const path of paths) {
    if (path === ROOT_POLICY.sourcePath || HISTORICAL_RESEARCH_EVIDENCE_ALLOWLIST.has(path)) continue;
    if (isTypeScriptLikePath(path)) continue;
    const absolute = join(root, path);
    let stats: Stats;
    try {
      stats = lstatSync(absolute);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    const source = cachedReadFileText(root, path, contents);
    if (source === undefined) {
      violations.push(`evidence-graph-authority-file-unreadable:${path}`);
      continue;
    }
    if (containsCompetingEvidenceAuthority(source)) {
      violations.push(`evidence-graph-competing-authority:${path}`);
    }
  }
}

function containsCompetingEvidenceAuthority(value: string): boolean {
  const authorityKeys = [["source", "Of", "Truth"].join(""), ["author", "ity"].join("")];
  const competingStores = ["timeline", "graph", "search", "memory", "attempt", "git", "operational", "projection"];
  const expression = "\\b(?:" + authorityKeys.join("|") + ")[\"']?\\s*[:=]\\s*[\"'`]?\\s*(?:" +
    competingStores.join("|") + ")[A-Za-z0-9_.-]*";
  return new RegExp(expression, "iu").test(value);
}

export function universalPolicyExtensionConformanceViolations(value: unknown): readonly string[] {
  const violations: string[] = [];
  if (!isPlainObject(value)) return deepFreeze(["extension-manifest-invalid"]);
  const expectedKeys = [
    "capabilities", "copiedPolicyDefinitions", "directLowLevelEntrypoints", "id", "inheritedPolicyFamilies",
    "operations", "policyHash", "registration", "schemaVersion", "waiverIds",
  ];
  if (!sameOrderedValues(Object.keys(value).toSorted(), expectedKeys)) {
    violations.push("extension-manifest-invalid");
  }
  if (value.schemaVersion !== "bridlewise-static-extension-conformance/v1" ||
    value.registration !== "centrally-registered-static-control" ||
    typeof value.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value.id)) {
    violations.push("extension-registration-invalid");
  }
  for (const key of ["capabilities", "operations"] as const) {
    const entries = value[key];
    if (!Array.isArray(entries) || entries.length === 0 ||
      entries.some((entry) => typeof entry !== "string" || entry.length === 0) ||
      new Set(entries).size !== entries.length) {
      violations.push(`extension-${key}-invalid`);
    }
  }
  if (!Array.isArray(value.inheritedPolicyFamilies) ||
    !sameOrderedValues(value.inheritedPolicyFamilies, ROOT_POLICY.universalPolicyArchitecture.policyFamilies)) {
    violations.push("extension-policy-inheritance-incomplete");
  }
  if (value.policyHash !== canonicalHash(ROOT_POLICY.universalPolicyArchitecture)) {
    violations.push("extension-policy-hash-mismatch");
  }
  if (value.directLowLevelEntrypoints !== false) violations.push("extension-direct-entrypoint-denied");
  if (value.copiedPolicyDefinitions !== false) violations.push("extension-copied-policy-denied");
  if (!Array.isArray(value.waiverIds) || value.waiverIds.length !== 0) {
    violations.push("extension-waiver-unavailable");
  }
  return deepFreeze([...new Set(violations)].toSorted());
}

function staticRootPolicySubtreeMatches(
  source: string,
  propertyPath: readonly string[],
  expected: unknown,
): boolean {
  const candidate = extractBoundedTopLevelStaticLiteral(
    source,
    "ROOT_POLICY_VALUE",
    propertyPath,
    ROOT_POLICY_STATIC_LITERAL_BOUNDARY,
    ROOT_POLICY_STATIC_LITERAL_IDENTIFIER_BINDINGS,
  );
  return candidate.ok && canonicalHash(candidate.value) === canonicalHash(expected);
}

// Content-hash memoization of the Babel parse in extractBoundedTopLevelStaticLiteral.
// The function parses root-policy.ts (or any governed source) with Babel up to
// ~11 times per verifyS1Structure call (once per propertyPath: configuration,
// contracts, universalPolicyArchitecture, etc.). The parse is identical across
// calls with the same source, so caching the parsed program by content hash
// collapses 11 Babel parses into 1 per distinct source. The cache is cleared
// alongside the S1 verification cache by clearVerifyS1StructureCache.
const STATIC_LITERAL_PARSE_CACHE_MAX_ENTRIES = DEFAULT_STATIC_LITERAL_PARSE_CACHE_MAX_ENTRIES;
const staticLiteralParseCache = new Map<string, StaticLiteralAstNode | undefined>();

// Filesystem-backed cache for the EVALUATED extraction result. The in-memory
// parse cache above stores non-serializable Babel AST nodes, so it is
// per-process and NOT shared across the serial-phase processes. This cache
// stores the serializable StaticLiteralExtraction ({ ok, value? }), keyed by
// the content hash + bindingName + propertyPath + freezeBoundary hash +
// identifierBindings hash + the extraction evaluator's own bytes (the salt
// below). The first process to extract a given tuple computes + writes; the
// rest read the cached result instead of re-parsing root-policy.ts with Babel.
// Best-effort: a filesystem failure falls through to computation with no
// correctness impact.
const staticLiteralExtractionFilesystemCache = createFilesystemCache({
  directory: "harness-static-literal-cache",
  maxEntries: DEFAULT_STATIC_LITERAL_EXTRACTION_FILESYSTEM_CACHE_MAX_ENTRIES,
});

// Readonly arguments may still change at runtime, including nested values.
// Hash their current contents per call; do not retain caller object identities.

function validateStaticLiteralExtraction(value: unknown): StaticLiteralExtraction | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok !== true && record.ok !== false) return undefined;
  if (record.ok === false) return deepFreeze({ ok: false });
  if (!Object.hasOwn(record, "value")) return undefined;
  // Reuse the canonical value authority, including nested finite-number
  // admission. JSON.parse alone accepts overflow exponents as Infinity.
  canonicalJson(record.value);
  return deepFreeze({ ok: true, value: record.value });
}

function clearStaticLiteralParseCache(): void {
  staticLiteralParseCache.clear();
}

function parseStaticLiteralSource(source: string): StaticLiteralAstNode | undefined {
  const limits = ROOT_POLICY.forensics.limits;
  if (Buffer.byteLength(source, "utf8") > limits.maximumInputBytes) return undefined;
  const contentHash = sha256(Buffer.from(source, "utf8"));
  if (staticLiteralParseCache.has(contentHash)) {
    return staticLiteralParseCache.get(contentHash);
  }
  let program: StaticLiteralAstNode | undefined;
  try {
    const parsed = parseTypeScriptSource(source, {
      sourceType: "module",
      plugins: ["typescript"],
      errorRecovery: false,
      attachComment: false,
      tokens: false,
    }) as unknown as { program?: unknown };
    program = staticLiteralAstNode(parsed.program);
  } catch {
    program = undefined;
  }
  if (program !== undefined && (!program || program.type !== "Program" ||
    !staticLiteralAstWithinNodeBudget(program, limits.maximumNodes))) {
    program = undefined;
  }
  if (staticLiteralParseCache.size >= STATIC_LITERAL_PARSE_CACHE_MAX_ENTRIES) {
    const oldest = staticLiteralParseCache.keys().next();
    if (!oldest.done) staticLiteralParseCache.delete(oldest.value);
  }
  staticLiteralParseCache.set(contentHash, program);
  return program;
}

export function extractBoundedTopLevelStaticLiteral(
  source: string,
  bindingName: string,
  propertyPath: readonly string[],
  freezeBoundary?: StaticLiteralFreezeBoundary,
  identifierBindings: Readonly<Record<string, StaticLiteralIdentifierBinding>> = {},
): StaticLiteralExtraction {
  // Filesystem-backed cache (shared across serial-phase processes). The
  // extraction is a pure function of (source, bindingName, propertyPath,
  // freezeBoundary, identifierBindings) AND the evaluator that produced it:
  // an entry written before the evaluator's behavior changed must never be
  // served after it, or a fixed check would keep answering from before the
  // fix. The salt is the evaluator's own bytes plus the constructor module
  // the evaluator resolves calls into (product-identity.ts supplies the
  // schemaId/cryptoDomain/statePath pure constructors that shape the cached
  // value). Unavailable evaluator bytes bypass the result cache. The local
  // Babel parse cache remains a separate source-content memo.
  // A cache hit skips both the Babel parse AND the AST walk. The cache key
  // frames every input in an ordered JSON tuple, preserving property segments.
  const contentHash = sha256(Buffer.from(source, "utf8"));
  const boundaryHash = freezeBoundary === undefined ? "none" : canonicalHash(freezeBoundary);
  const bindingsHash = canonicalHash(identifierBindings);
  const semanticsId = analysisSemanticsId(import.meta.url, new URL("../../src/kernel/product-identity.ts", import.meta.url), new URL("../../src/kernel/lexical-policy.ts", import.meta.url));
  const cacheKey = semanticsId === undefined ? undefined : canonicalJson([
    contentHash, bindingName, propertyPath, boundaryHash, bindingsHash, semanticsId,
  ]);
  const filesystemCached = cacheKey === undefined ? undefined : staticLiteralExtractionFilesystemCache.read<StaticLiteralExtraction>(
    cacheKey,
    validateStaticLiteralExtraction,
  );
  if (filesystemCached !== undefined) return filesystemCached;
  const result = computeBoundedTopLevelStaticLiteral(
    source,
    bindingName,
    propertyPath,
    freezeBoundary,
    identifierBindings,
  );
  if (cacheKey !== undefined) staticLiteralExtractionFilesystemCache.write(cacheKey, result);
  return result;
}

function computeBoundedTopLevelStaticLiteral(
  source: string,
  bindingName: string,
  propertyPath: readonly string[],
  freezeBoundary?: StaticLiteralFreezeBoundary,
  identifierBindings: Readonly<Record<string, StaticLiteralIdentifierBinding>> = {},
): StaticLiteralExtraction {
  const limits = ROOT_POLICY.forensics.limits;
  const program = parseStaticLiteralSource(source);
  if (program === undefined) return { ok: false };
  const initializers: StaticLiteralAstNode[] = [];
  let bindingStatementIndex = -1;
  const statements = staticLiteralAstNodeArray(program.body);
  for (let statementIndex = 0; statementIndex < statements.length; statementIndex += 1) {
    const statement = statements[statementIndex]!;
    const declaration = statement.type === "ExportNamedDeclaration"
      ? staticLiteralAstNode(statement.declaration)
      : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    const declarators = staticLiteralAstNodeArray(declaration.declarations);
    for (const declarator of declarators) {
      const identifier = staticLiteralAstNode(declarator.id);
      if (identifier?.type !== "Identifier" || identifier.name !== bindingName) continue;
      const initializer = staticLiteralAstNode(declarator.init);
      if (declaration.kind !== "const" || !initializer || declarators.length !== 1) return { ok: false };
      initializers.push(initializer);
      bindingStatementIndex = statementIndex;
    }
  }
  if (initializers.length !== 1) return { ok: false };
  if (!staticLiteralIdentifierImportsValid(statements, identifierBindings)) return { ok: false };
  if (freezeBoundary !== undefined && !staticLiteralFreezeBoundaryValid(
    statements,
    bindingStatementIndex,
    bindingName,
    freezeBoundary,
  )) {
    return { ok: false };
  }
  let current = unwrapStaticLiteralExpression(initializers[0]);
  for (const propertyName of propertyPath) {
    if (!current) return { ok: false };
    const properties = staticLiteralObjectProperties(current);
    if (!properties.ok) return { ok: false };
    current = properties.values.get(propertyName);
  }
  if (!current) return { ok: false };
  const evaluated = evaluateStaticLiteral(current, limits.maximumDepth, 0, identifierBindings);
  if (!evaluated.ok) return evaluated;
  try {
    if (Buffer.byteLength(canonicalJson(evaluated.value), "utf8") > limits.maximumCanonicalBytes) {
      return { ok: false };
    }
  } catch {
    return { ok: false };
  }
  return evaluated;
}

function staticLiteralFreezeBoundaryValid(
  statements: readonly StaticLiteralAstNode[],
  bindingStatementIndex: number,
  bindingName: string,
  boundary: StaticLiteralFreezeBoundary,
): boolean {
  if (bindingStatementIndex < 0) return false;
  if (statements.slice(0, bindingStatementIndex).some((statement) =>
    statement.type !== "ImportDeclaration")) {
    return false;
  }
  if (!staticLiteralIdentifierImportsValid(statements, {
    [boundary.freezerName]: { importSource: boundary.freezerImportSource },
  })) return false;

  let typeAliasSeen = false;
  let frozenExportSeen = false;
  for (let index = bindingStatementIndex + 1; index < statements.length; index += 1) {
    const statement = statements[index]!;
    if (!typeAliasSeen && exactStaticLiteralTypeAlias(statement, bindingName, boundary.typeName)) {
      typeAliasSeen = true;
      continue;
    }
    if (typeAliasSeen && exactStaticLiteralFrozenExport(statement, bindingName, boundary)) {
      frozenExportSeen = true;
      break;
    }
    return false;
  }
  return typeAliasSeen && frozenExportSeen;
}

function staticLiteralIdentifierImportsValid(
  statements: readonly StaticLiteralAstNode[],
  bindings: Readonly<Record<string, Pick<StaticLiteralIdentifierBinding, "importSource">>>,
): boolean {
  for (const [name, binding] of Object.entries(bindings)) {
    const matchingImports = statements.filter((statement) => {
      // Candidate TypeScript is untrusted and never executed here. Both
      // lexical values and the freezer require bindings that survive type
      // erasure; an erased declaration or named specifier has no authority.
      if (statement.type !== "ImportDeclaration" || statement.importKind !== "value") return false;
      // Attributes can change loading semantics (e.g. demand JSON from a TS
      // owner). Unsupported assertions/phases are also denied if a future
      // parser admits them; only an ordinary runtime import supplies a value.
      if (staticLiteralAstNodeArray(statement.attributes).length !== 0 ||
        staticLiteralAstNodeArray(statement.assertions).length !== 0 ||
        (statement.phase !== undefined && statement.phase !== null)) return false;
      const source = staticLiteralAstNode(statement.source);
      if (source?.type !== "StringLiteral" || source.value !== binding.importSource) return false;
      return staticLiteralAstNodeArray(statement.specifiers).some((specifier) => {
        const imported = staticLiteralAstNode(specifier.imported);
        const local = staticLiteralAstNode(specifier.local);
        return specifier.type === "ImportSpecifier" && specifier.importKind === "value" && imported?.type === "Identifier" &&
          imported.name === name && local?.type === "Identifier" && local.name === name;
      });
    });
    if (matchingImports.length !== 1) return false;
  }
  return true;
}

function exactStaticLiteralTypeAlias(
  statement: StaticLiteralAstNode,
  bindingName: string,
  typeName: string,
): boolean {
  if (statement.type !== "ExportNamedDeclaration") return false;
  const declaration = staticLiteralAstNode(statement.declaration);
  const identifier = declaration ? staticLiteralAstNode(declaration.id) : undefined;
  const annotation = declaration ? staticLiteralAstNode(declaration.typeAnnotation) : undefined;
  const expressionName = annotation ? staticLiteralAstNode(annotation.exprName) : undefined;
  return declaration?.type === "TSTypeAliasDeclaration" && identifier?.type === "Identifier" &&
    identifier.name === typeName && annotation?.type === "TSTypeQuery" &&
    expressionName?.type === "Identifier" && expressionName.name === bindingName;
}

function exactStaticLiteralFrozenExport(
  statement: StaticLiteralAstNode,
  bindingName: string,
  boundary: StaticLiteralFreezeBoundary,
): boolean {
  if (statement.type !== "ExportNamedDeclaration") return false;
  const declaration = staticLiteralAstNode(statement.declaration);
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") return false;
  const declarators = staticLiteralAstNodeArray(declaration.declarations);
  if (declarators.length !== 1) return false;
  const identifier = staticLiteralAstNode(declarators[0]!.id);
  const initializer = unwrapStaticLiteralExpression(staticLiteralAstNode(declarators[0]!.init));
  if (identifier?.type !== "Identifier" || identifier.name !== boundary.exportedName ||
    initializer?.type !== "CallExpression" && initializer?.type !== "OptionalCallExpression") {
    return false;
  }
  const callee = staticLiteralAstNode(initializer.callee);
  const argumentsList = staticLiteralAstNodeArray(initializer.arguments);
  return callee?.type === "Identifier" && callee.name === boundary.freezerName &&
    argumentsList.length === 1 && argumentsList[0]!.type === "Identifier" &&
    argumentsList[0]!.name === bindingName;
}

function staticLiteralObjectProperties(
  input: StaticLiteralAstNode,
): Readonly<{ ok: true; values: ReadonlyMap<string, StaticLiteralAstNode> }> | Readonly<{ ok: false }> {
  const node = unwrapStaticLiteralExpression(input);
  if (node?.type !== "ObjectExpression") return { ok: false };
  const values = new Map<string, StaticLiteralAstNode>();
  const rawProperties = Array.isArray(node.properties) ? node.properties : [];
  for (const rawProperty of rawProperties) {
    const property = staticLiteralAstNode(rawProperty);
    if (!property || property.type !== "ObjectProperty" || property.computed === true ||
      property.method === true) {
      return { ok: false };
    }
    const name = staticLiteralPropertyName(property);
    const value = staticLiteralAstNode(property.value);
    if (name === undefined || !value || values.has(name)) return { ok: false };
    values.set(name, value);
  }
  return { ok: true, values };
}

function evaluateStaticLiteral(
  input: StaticLiteralAstNode,
  maximumDepth: number,
  depth = 0,
  identifierBindings: Readonly<Record<string, StaticLiteralIdentifierBinding>> = {},
): StaticLiteralExtraction {
  if (depth > maximumDepth) return { ok: false };
  const node = unwrapStaticLiteralExpression(input);
  if (!node) return { ok: false };
  if (node.type === "StringLiteral") return { ok: true, value: String(node.value) };
  if (node.type === "BooleanLiteral") return { ok: true, value: Boolean(node.value) };
  if (node.type === "NullLiteral") return { ok: true, value: null };
  if (node.type === "NumericLiteral") {
    const value = Number(node.value);
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (node.type === "Identifier" && typeof node.name === "string") {
    const binding = identifierBindings[node.name];
    return binding === undefined ? { ok: false } : { ok: true, value: binding.value };
  }
  // A call to a KNOWN pure string constructor (`schemaId` / `cryptoDomain` from
  // the product-identity owner) with literal arguments is statically evaluable:
  // the constructor is a pure template over its two arguments. The product
  // identity rename replaced literal schema-version strings with these calls,
  // so the projection extractor must resolve them or every pinned subtree that
  // carries a schemaId/cryptoDomain fails as "not a static literal". Refuse
  // anything else (an unbound callee, a non-literal argument, a computed call).
  if (node.type === "CallExpression") {
    const callee = staticLiteralAstNode(node.callee);
    if (callee?.type !== "Identifier" || typeof callee.name !== "string") return { ok: false };
    const constructor: ((...args: unknown[]) => StaticLiteralExtraction) | undefined =
      STATIC_LITERAL_CALLABLE_CONSTRUCTORS[callee.name];
    if (constructor === undefined) return { ok: false };
    const args = staticLiteralAstNodeArray(node.arguments);
    const evaluatedArgs: unknown[] = [];
    for (const arg of args) {
      const evaluated = evaluateStaticLiteral(arg, maximumDepth, depth + 1, identifierBindings);
      if (!evaluated.ok) return evaluated;
      evaluatedArgs.push(evaluated.value);
    }
    return constructor(...evaluatedArgs);
  }
  if (node.type === "MemberExpression" && node.computed !== true) {
    const object = staticLiteralAstNode(node.object);
    const property = staticLiteralAstNode(node.property);
    if (object?.type !== "Identifier" || typeof object.name !== "string" ||
      property?.type !== "Identifier" || typeof property.name !== "string") {
      return { ok: false };
    }
    const binding = identifierBindings[object.name];
    if (binding === undefined || binding.value === null || typeof binding.value !== "object" ||
      !Object.hasOwn(binding.value, property.name)) {
      return { ok: false };
    }
    return {
      ok: true,
      value: (binding.value as Readonly<Record<string, unknown>>)[property.name],
    };
  }
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    const argument = staticLiteralAstNode(node.argument);
    const evaluated = argument
      ? evaluateStaticLiteral(argument, maximumDepth, depth + 1, identifierBindings)
      : { ok: false } as const;
    if (!evaluated.ok || typeof evaluated.value !== "number") return { ok: false };
    return { ok: true, value: node.operator === "-" ? -evaluated.value : evaluated.value };
  }
  if (node.type === "ArrayExpression") {
    if (!Array.isArray(node.elements)) return { ok: false };
    const output: unknown[] = [];
    for (const rawElement of node.elements) {
      const element = staticLiteralAstNode(rawElement);
      if (!element || element.type === "SpreadElement") return { ok: false };
      const evaluated = evaluateStaticLiteral(element, maximumDepth, depth + 1, identifierBindings);
      if (!evaluated.ok) return evaluated;
      output.push(evaluated.value);
    }
    return { ok: true, value: output };
  }
  if (node.type === "ObjectExpression") {
    const properties = staticLiteralObjectProperties(node);
    if (!properties.ok) return properties;
    const output = Object.create(null) as Record<string, unknown>;
    for (const [name, valueNode] of properties.values) {
      const evaluated = evaluateStaticLiteral(valueNode, maximumDepth, depth + 1, identifierBindings);
      if (!evaluated.ok) return evaluated;
      Object.defineProperty(output, name, {
        value: evaluated.value,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    return { ok: true, value: output };
  }
  return { ok: false };
}

function unwrapStaticLiteralExpression(
  input: StaticLiteralAstNode | undefined,
): StaticLiteralAstNode | undefined {
  let current = input;
  while (current && [
    "ParenthesizedExpression", "TSAsExpression", "TSInstantiationExpression", "TSNonNullExpression",
    "TSSatisfiesExpression", "TSTypeAssertion",
  ].includes(current.type)) {
    current = staticLiteralAstNode(current.expression);
  }
  return current;
}

function staticLiteralPropertyName(property: StaticLiteralAstNode): string | undefined {
  const key = staticLiteralAstNode(property.key);
  if (!key) return undefined;
  if (key.type === "Identifier") return String(key.name);
  if (key.type === "StringLiteral" || key.type === "NumericLiteral") return String(key.value);
  return undefined;
}

function staticLiteralAstWithinNodeBudget(root: StaticLiteralAstNode, maximumNodes: number): boolean {
  const pending = [root];
  const visited = new Set<StaticLiteralAstNode>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (visited.size > maximumNodes) return false;
    pending.push(...staticLiteralAstChildren(node));
  }
  return true;
}

function staticLiteralAstNode(value: unknown): StaticLiteralAstNode | undefined {
  return value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
    ? value as StaticLiteralAstNode
    : undefined;
}

function staticLiteralAstNodeArray(value: unknown): readonly StaticLiteralAstNode[] {
  return Array.isArray(value)
    ? value.map(staticLiteralAstNode).filter((entry): entry is StaticLiteralAstNode => entry !== undefined)
    : [];
}

function staticLiteralAstChildren(node: StaticLiteralAstNode): readonly StaticLiteralAstNode[] {
  const children: StaticLiteralAstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (["comments", "end", "errors", "extra", "loc", "start", "tokens", "type"].includes(key)) continue;
    const child = staticLiteralAstNode(value);
    if (child) children.push(child);
    else if (Array.isArray(value)) children.push(...staticLiteralAstNodeArray(value));
  }
  return children;
}

function verifyUniversalPolicyArchitecture(
  root: string,
  paths: readonly string[],
  violations: string[],
): void {
  const rootPolicySource = readSafeCandidateText(
    root,
    ROOT_POLICY.sourcePath,
    ROOT_POLICY.forensics.limits.maximumInputBytes,
  );
  if (rootPolicySource === undefined) {
    violations.push("universal-policy-root-source-unreadable");
  } else if (!staticRootPolicySubtreeMatches(
    rootPolicySource,
    ["universalPolicyArchitecture"],
    ROOT_POLICY.universalPolicyArchitecture,
  )) {
    violations.push("universal-policy-root-source");
  }

  const packageDocument = parseJson(join(root, "package.json"), violations);
  if (isPlainObject(packageDocument) && isPlainObject(packageDocument.exports) &&
    !sameOrderedValues(Object.keys(packageDocument.exports).toSorted(), ["."])) {
    violations.push("universal-policy-unregistered-entrypoint:package.json");
  }

  for (const path of paths) {
    if (/\b(?:direct|raw|unregistered)[._-]?(?:effect|entrypoint|gateway)\b/iu.test(path)) {
      violations.push(`universal-policy-unregistered-entrypoint:${path}`);
    }
  }
}

function verifyTestExecutionOperationAuthority(root: string, violations: string[]): void {
  const rootPolicySource = readSafeCandidateText(
    root,
    ROOT_POLICY.sourcePath,
    ROOT_POLICY.forensics.limits.maximumInputBytes,
  );
  if (rootPolicySource === undefined) {
    violations.push("test-execution-operation-root-source-unreadable");
  } else if (!staticRootPolicySubtreeMatches(
    rootPolicySource,
    ["receipts", "testExecution"],
    ROOT_POLICY.receipts.testExecution,
  )) {
    violations.push("test-execution-operation-root-source");
  }
}

function verifyAdditionalRootPolicyAuthorities(root: string, violations: string[]): void {
  const rootPolicySource = readSafeCandidateText(
    root,
    ROOT_POLICY.sourcePath,
    ROOT_POLICY.forensics.limits.maximumInputBytes,
  );
  const authorities = [
    {
      propertyPath: ["projectLayoutArchitecture"],
      expected: ROOT_POLICY.projectLayoutArchitecture,
      diagnostic: "project-layout-root-source",
    },
    {
      propertyPath: ["conversationBootstrapArchitecture"],
      expected: ROOT_POLICY.conversationBootstrapArchitecture,
      diagnostic: "conversation-bootstrap-root-source",
    },
    {
      propertyPath: ["governedInteractionArchitecture"],
      expected: ROOT_POLICY.governedInteractionArchitecture,
      diagnostic: "governed-interaction-root-source",
    },
    {
      propertyPath: ["modelRepositoryInspectionArchitecture"],
      expected: ROOT_POLICY.modelRepositoryInspectionArchitecture,
      diagnostic: "model-repository-inspection-root-source",
    },
    {
      propertyPath: ["steeringContinuityArchitecture"],
      expected: ROOT_POLICY.steeringContinuityArchitecture,
      diagnostic: "steering-continuity-root-source",
    },
    {
      propertyPath: ["runtimeLanguageArchitecture"],
      expected: ROOT_POLICY.runtimeLanguageArchitecture,
      diagnostic: "runtime-language-root-source",
    },
  ] as const;
  if (rootPolicySource === undefined) {
    for (const authority of authorities) violations.push(`${authority.diagnostic}-unreadable`);
    return;
  }
  for (const authority of authorities) {
    if (!staticRootPolicySubtreeMatches(
      rootPolicySource,
      authority.propertyPath,
      authority.expected,
    )) {
      violations.push(authority.diagnostic);
    }
  }
}

function verifyTrustedBootstrapSurface(root: string, paths: readonly string[], violations: string[]): void {
  if (!paths.includes(TRUSTED_BOOTSTRAP_PATH)) {
    violations.push("trusted-bootstrap-script-missing");
    return;
  }
  const source = readFileSync(join(root, TRUSTED_BOOTSTRAP_PATH), "utf8");
  verifyGovernedTypeScriptSource(
    TRUSTED_BOOTSTRAP_PATH,
    source,
    violations,
    true,
    new Set(["fchmodSync"]),
  );
  const analysis = analyzeStaticSource(source, TRUSTED_BOOTSTRAP_PATH);
  // The bootstrap's import of the root policy is RELATIVE to the script's own
  // depth: `scripts/tooling/bootstrap-permissions.ts` reaches the engine root
  // two levels up, so the specifier is `../../src/...`, derived from the
  // script's directory depth rather than spelled so the check survives the
  // next tooling move.
  const bootstrapDirPrefix = TRUSTED_BOOTSTRAP_PATH.split("/").slice(0, -1).map(() => "..").join("/");
  const rootPolicySpecifier = `${bootstrapDirPrefix}/${ROOT_POLICY.sourcePath}`;
  const expectedSpecifiers = [
    "../../src/kernel/errors.ts",
    // The bootstrap refuses a configuration file that has a SECOND NAME (a
    // hard link), and it asks the one module that owns that question rather
    // than re-deriving `nlink !== 1` locally. Declared here because this list
    // is the bootstrap's import surface: an undeclared import is a violation,
    // which is the point — the import landed without this line and the
    // resulting diagnostic sat unread inside a slow-gated test file.
    "../../src/filesystem/link-containment.ts",
    "../../src/kernel/integrity.ts",
    "../../src/filesystem/linux-path.ts",
    rootPolicySpecifier,
    "node:fs",
    "node:path",
    "node:url",
  ];
  const actualSpecifiers = analysis.moduleAcquisitions.map((entry) => entry.specifier).toSorted();
  // Compare as SETS, sorted on both sides: the invariant is that the import
  // surface is exactly this set, not that the source lists them in a lexical
  // order. A literal expected list in declaration order falses on any fold
  // whose module names sort differently than the declaration.
  const expectedSorted = [...expectedSpecifiers].toSorted();
  if (analysis.moduleAcquisitions.some((entry) => entry.kind !== "direct-import") ||
    !sameOrderedValues(actualSpecifiers, expectedSorted)) {
    violations.push("trusted-bootstrap-import-surface");
  }
  if (analysis.environmentAcquisitions.length > 0 || analysis.unmodeledEnvironmentAccess) {
    violations.push("trusted-bootstrap-environment-source");
  }
  if (analysis.unmodeledModuleAcquisition || /\bexport\b/u.test(source)) {
    violations.push("trusted-bootstrap-module-surface");
  }
  const tokens = tokenize(source, TRUSTED_BOOTSTRAP_PATH);
  const identifiers = tokens.filter((token) => token.kind === "identifier").map((token) => token.value);
  const forbiddenEffects = [...new Set(identifiers.filter((identifier) =>
    isForbiddenEffectIdentifier(identifier) && identifier !== "fchmodSync"
  ))];
  const descriptorModeChanges = tokens.filter((token, index) =>
    token.value === "fchmodSync" && tokens[index + 1]?.value === "("
  ).length;
  if (forbiddenEffects.length > 0 || descriptorModeChanges !== 1) {
    violations.push("trusted-bootstrap-effect-surface");
  }
}

function verifyPackageAndLock(root: string, violations: string[]): void {
  const packageDocument = parseJson(join(root, "package.json"), violations);
  const lockDocument = parseJson(join(root, "package-lock.json"), violations);
  if (!isPlainObject(packageDocument) || !isPlainObject(lockDocument)) return;
  const dependencies = stringRecord(packageDocument.dependencies);
  const devDependencies = stringRecord(packageDocument.devDependencies);
  if (!dependencies || !sameOrderedValues(Object.keys(dependencies).toSorted(), ["@babel/parser", "zod"])) {
    violations.push("package-runtime-dependencies");
  }
  if (!devDependencies ||
    !sameOrderedValues(Object.keys(devDependencies).toSorted(), ["@types/node", "ajv", "typescript"])) {
    violations.push("package-development-dependencies");
  }
  if (dependencies && Object.values(dependencies).some((value) => !value.startsWith("^"))) {
    violations.push("package-runtime-range-policy");
  }
  if (devDependencies && Object.values(devDependencies).some((value) => !value.startsWith("^"))) {
    violations.push("package-development-range-policy");
  }
  if (!isPlainObject(packageDocument.exports) || Object.keys(packageDocument.exports).length !== 1 ||
    packageDocument.exports["."] !== "./src/cli.ts") {
    violations.push("package-export-surface");
  }
  if (Object.hasOwn(packageDocument, "main") || Object.hasOwn(packageDocument, "bin")) {
    violations.push("package-alternate-entrypoint");
  }
  const expectedScripts = {
    start: "node src/cli.ts",
    typecheck: "tsc --noEmit",
    test: "node scripts/run-tests.ts",
    "inventory:generate": "node scripts/test-inventory.ts --write",
    "inventory:check": "node scripts/test-inventory.ts --check",
    "inventory:recover": "node scripts/test-inventory.ts --recover",
    coverage: "node scripts/coverage.ts",
    "test:coverage": "npm run coverage",
    "manifest:candidate": "node scripts/candidate-manifest.ts --root .",
    "verify:s1": "node scripts/check.ts",
    check: "npm run typecheck && node scripts/check.ts",
    "foundation:plan": "node scripts/foundation.ts plan",
    "foundation:check": "node scripts/foundation.ts check",
    "foundation:write": "node scripts/foundation.ts write",
    "foundation:recover": "node scripts/foundation.ts recover",
  };
  if (!isPlainObject(packageDocument.scripts) || canonicalHash(packageDocument.scripts) !== canonicalHash(expectedScripts)) {
    violations.push("package-script-surface");
  }
  verifyPackageCompositionRoots(packageDocument, violations);
  if (packageDocument.name !== "bridlewise" || packageDocument.version !== "0.1.0" ||
    packageDocument.private !== true || packageDocument.type !== "module" ||
    !isPlainObject(packageDocument.engines) || packageDocument.engines.node !== ">=24.18.0 <25.0.0") {
    violations.push("package-identity-or-engine");
  }
  if (lockDocument.name !== packageDocument.name || lockDocument.version !== packageDocument.version ||
    lockDocument.lockfileVersion !== 3 || lockDocument.requires !== true) {
    violations.push("lock-identity-or-version");
  }
  const packages = isPlainObject(lockDocument.packages) ? lockDocument.packages : undefined;
  if (!packages) {
    violations.push("lock-packages-invalid");
    return;
  }
  const lockRoot = isPlainObject(packages[""]) ? packages[""] : undefined;
  if (!lockRoot || !sameRecord(stringRecord(lockRoot.dependencies), dependencies) ||
    !sameRecord(stringRecord(lockRoot.devDependencies), devDependencies)) {
    violations.push("lock-root-package-mismatch");
  }
  const reachable = new Set<string>([""]);
  const pending = [""];
  while (pending.length > 0) {
    const key = pending.pop()!;
    const entry = isPlainObject(packages[key]) ? packages[key] : undefined;
    if (!entry) continue;
    for (const mapName of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
      const map = stringRecord(entry[mapName]);
      if (!map) continue;
      for (const name of Object.keys(map)) {
        const dependencyKey = `node_modules/${name}`;
        if (!Object.hasOwn(packages, dependencyKey)) {
          violations.push(`lock-dependency-missing:${name}`);
        } else if (!reachable.has(dependencyKey)) {
          reachable.add(dependencyKey);
          pending.push(dependencyKey);
        }
      }
    }
  }
  const allPackageKeys = Object.keys(packages).toSorted();
  for (const key of allPackageKeys) {
    if (!reachable.has(key)) violations.push(`lock-package-unreachable:${key}`);
    const normalized = key.toLocaleLowerCase("en-US");
    const dependencyName = key.replace(/^.*node_modules\//u, "");
    if (FORBIDDEN_DEPENDENCY_NAMES.has(dependencyName) ||
      FORBIDDEN_DEPENDENCY_PARTS.some((part) => normalized.includes(part))) {
      violations.push(`forbidden-lock-package:${key}`);
    }
    if (key === "") continue;
    const entry = isPlainObject(packages[key]) ? packages[key] : undefined;
    if (!entry || typeof entry.version !== "string" || typeof entry.integrity !== "string" ||
      typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://registry.npmjs.org/")) {
      violations.push(`lock-package-evidence-invalid:${key}`);
    }
  }
}

function verifyPackageCompositionRoots(
  packageDocument: Readonly<Record<string, unknown>>,
  violations: string[],
): void {
  const commandPaths = new Set<string>();
  if (isPlainObject(packageDocument.scripts)) {
    for (const command of Object.values(packageDocument.scripts)) {
      if (typeof command !== "string") continue;
      for (const match of command.matchAll(/(?:^|&&\s*)node\s+((?:scripts|src|verification)\/[A-Za-z0-9._/-]+)/gu)) {
        commandPaths.add(match[1]!);
      }
    }
  }
  if (isPlainObject(packageDocument.exports) && typeof packageDocument.exports["."] === "string") {
    commandPaths.add(packageDocument.exports["."].replace(/^\.\//u, ""));
  }
  const compositionRoots = new Set(Object.values(ARCHITECTURE_MANIFEST.compositionRoots).flat());
  for (const path of commandPaths) {
    if (!compositionRoots.has(path)) violations.push(`architecture-package-command-root-unregistered:${path}`);
  }
}

function verifyProductionGraph(root: string, violations: string[]): void {
  const entry = join(root, "src", "cli.ts");
  const visited = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      violations.push(`production-import-unreadable:${relative(root, path)}`);
      continue;
    }
    for (const moduleLoad of analyzeStaticSource(source, path).moduleAcquisitions) {
      if (moduleLoad.specifier === null) violations.push(`nonliteral-module-load:${relative(root, path)}`);
      else inspectSpecifier(moduleLoad.specifier, path, root, pending, violations);
    }
  }
  const reached = [...visited].map((path) => relative(join(root, "src"), path).split(sep).join("/")).toSorted();
  if (!sameOrderedValues(reached, [...EXPECTED_RUNTIME_SOURCE_FILES].toSorted())) {
    violations.push("production-graph-incomplete-or-extra");
  }
}

function inspectSpecifier(
  specifier: string,
  sourcePath: string,
  root: string,
  pending: string[],
  violations: string[],
): void {
  if (specifier.startsWith("node:")) {
    if (!ALLOWED_PRODUCTION_BUILTINS.has(specifier)) violations.push(`production-effect-builtin:${specifier}`);
    return;
  }
  if (!specifier.startsWith(".")) {
    if (!ALLOWED_PRODUCTION_DEPENDENCIES.has(specifier)) violations.push(`production-dependency-denied:${specifier}`);
    return;
  }
  const target = resolve(dirname(sourcePath), specifier);
  const sourceRoot = join(root, "src") + sep;
  if (!target.startsWith(sourceRoot) || !target.endsWith(".ts") || !existsSync(target)) {
    violations.push(`production-relative-import-denied:${relative(root, target)}`);
    return;
  }
  pending.push(target);
}

function verifyStaticConfigurationSources(root: string, violations: string[]): void {
  for (const name of EXPECTED_SOURCE_FILES) {
    const path = join(root, "src", name);
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const analysis = analyzeStaticSource(source, path);
    if (analysis.unmodeledModuleAcquisition) violations.push(`module-acquisition-unmodeled:${name}`);
  }
  const packageDocument = parseJson(join(root, "package.json"), violations);
  if (isPlainObject(packageDocument) && isPlainObject(packageDocument.scripts) && Object.values(packageDocument.scripts)
    .some((value) => typeof value === "string" && /process(?:\s*\.\s*env|\s*\[\s*["']env["']\s*\])/u.test(value))) {
    violations.push("environment-configuration-source:package-scripts");
  }
}

function verifyNoProductionEffects(root: string, violations: string[]): void {
  for (const name of EXPECTED_SOURCE_FILES) {
    const path = join(root, "src", name);
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const tokens = tokenize(source, path);
    const allowedIds = allowedEffectIdentifiersForPath(`src/${name}`);
    const forbidden = [...new Set(
      tokens
        .filter((token, index) =>
          token.kind === "identifier" &&
          isForbiddenEffectIdentifier(token.value) &&
          !allowedIds.has(token.value) &&
          tokens[index + 1]?.value === "("
        )
        .map((token) => token.value)
    )];
    if (forbidden.length > 0) violations.push(`production-effect-api:${name}:${forbidden.toSorted().join(",")}`);
    const openCalls = tokens.filter((token, index) => token.value === "openSync" && tokens[index + 1]?.value === "(").length;
    if (openCalls !== (EXPECTED_OPEN_SYNC_CALLS[name] ?? 0)) {
      violations.push(`production-open-call-surface:${name}`);
    }
  }
}

function verifyRequirementsRegistry(
  root: string,
  paths: readonly string[],
  violations: string[],
): RequirementsRegistry | undefined {
  const registryPath = join(root, ROOT_POLICY.requirements.registryFile);
  let registryBytes: Buffer;
  let registry: RequirementsRegistry;
  try {
    registryBytes = readFileSync(registryPath);
    if (sha256(registryBytes) !== REQUIREMENTS_REGISTRY_FILE_SHA256) {
      violations.push("requirements-registry-file-hash-drift");
    }
    registry = parseRequirementsRegistryText(registryBytes.toString("utf8"));
  } catch {
    violations.push("requirements-registry-missing-or-invalid");
    return undefined;
  }
  if (!paths.includes(ROOT_POLICY.requirements.registryFile)) {
    violations.push("requirements-registry-manifest-missing");
  }
  if (!paths.includes(REQUIREMENTS_REGISTRY_SOURCE_PATH) ||
    ROOT_POLICY.requirements.sourceArtifact !== REQUIREMENTS_REGISTRY_SOURCE_PATH) {
    violations.push("requirements-source-artifact-manifest-missing");
  } else {
    try {
      const sourceBytes = readFileSync(join(root, REQUIREMENTS_REGISTRY_SOURCE_PATH));
      const sourceText = sourceBytes.toString("utf8");
      const lineCount = sourceText.endsWith("\n") ? sourceText.split("\n").length - 1 : sourceText.split("\n").length;
      if (sha256(sourceBytes) !== REQUIREMENTS_REGISTRY_SOURCE_SHA256 ||
        sourceBytes.length !== registry.sourceArtifact.byteLength ||
        lineCount !== registry.sourceArtifact.lineCount || !sourceText.endsWith("\n")) {
        violations.push("requirements-source-artifact-drift");
      }
    } catch {
      violations.push("requirements-source-artifact-missing-or-unreadable");
    }
  }
  const schemaPath = join(root, "traceability", "s2.4-requirements-schema.json");
  const expectedSchemaArtifact = {
    schemaVersion: REQUIREMENTS_SCHEMA_ARTIFACT_VERSION,
    registryFileSha256: REQUIREMENTS_REGISTRY_FILE_SHA256,
    schemaHash: REQUIREMENTS_REGISTRY_SCHEMA_HASH,
    schema: GENERATED_REQUIREMENTS_REGISTRY_SCHEMA,
  };
  try {
    const schemaBytes = readFileSync(schemaPath);
    const expectedBytes = `${canonicalJson(expectedSchemaArtifact)}\n`;
    if (schemaBytes.toString("utf8") !== expectedBytes ||
      sha256(schemaBytes) !== "7af5c35d52bafeac122e977bb613447b411a0c1c5234c44163b9c68988122d68") {
      violations.push("requirements-registry-schema-artifact-drift");
    }
  } catch {
    violations.push("requirements-registry-schema-artifact-missing");
  }
  return registry;
}

function verifyRequirementReferences(
  references: readonly string[],
  registry: RequirementsRegistry,
  source: string,
  violations: string[],
): void {
  const known = requirementRegistryIds(registry);
  if (new Set(references).size !== references.length) {
    violations.push(`requirements-registry-duplicate-trace-link:${source}`);
  }
  for (const reference of references) {
    if (!known.has(reference as never)) {
      violations.push(`requirements-registry-unknown-trace-link:${source}:${reference}`);
    }
  }
}

function parseTrace(path: string, violations: string[]): Trace | undefined {
  const value = parseJson(path, violations);
  const parsed = TRACE_SCHEMA.safeParse(value);
  if (!parsed.success) {
    violations.push("traceability-schema-or-value-invalid");
    return undefined;
  }
  return parsed.data;
}

function verifyTrace(
  trace: Trace,
  registry: RequirementsRegistry | undefined,
  violations: string[],
): void {
  verifyAuditMatrix(trace.auditMatrix, "s1", violations);
  let applicability: ReturnType<typeof requirementApplicabilityProjection> | undefined;
  if (registry) {
    try {
      applicability = requirementApplicabilityProjection(
        registry,
        S1_APPLICABILITY_DECLARATION.orderedIds,
      );
      if (canonicalHash(applicability) !== canonicalHash(S1_APPLICABILITY_DECLARATION)) {
        violations.push("traceability-applicability-projection-drift");
      }
      if (!sameOrderedValues(trace.requirements, applicability.requirementIds)) {
        violations.push("traceability-requirements-order-or-value");
      }
      if (!sameOrderedValues(trace.derivedControls, applicability.derivedControlIds)) {
        violations.push("traceability-derived-order-or-value");
      }
    } catch {
      violations.push("traceability-applicability-projection-invalid");
    }
  }
  if (canonicalHash(trace.capabilityState) !== canonicalHash(EXPECTED_CAPABILITIES)) {
    violations.push("traceability-capability-state");
  }
  if (canonicalHash(trace.behaviors) !== canonicalHash(EXPECTED_BEHAVIORS)) {
    violations.push("traceability-behavior-values-or-links");
  }
  if (registry) {
    verifyRequirementReferences(
      [...trace.requirements, ...trace.derivedControls],
      registry,
      "s1-trace",
      violations,
    );
  }
  const known = new Set(applicability?.orderedIds ?? []);
  const linked = new Set<string>();
  const scenarios = new Set<string>();
  for (const [index, behavior] of trace.behaviors.entries()) {
    const id = `S1-B${String(index + 1).padStart(2, "0")}`;
    if (behavior.id !== id || behavior.name.trim() === "") violations.push(`traceability-behavior-identity:${id}`);
    const expectedScenarios = [`${id}-CONTROL`, `${id}-FAILURE`, `${id}-HOSTILE-REAL`];
    if (!sameOrderedValues(behavior.scenarios, expectedScenarios)) {
      violations.push(`traceability-scenarios:${id}`);
    }
    for (const requirement of behavior.requirements) {
      if (!known.has(requirement)) violations.push(`traceability-link-unknown:${id}:${requirement}`);
      linked.add(requirement);
    }
    for (const scenario of behavior.scenarios) {
      if (scenarios.has(scenario)) violations.push(`traceability-scenario-duplicate:${scenario}`);
      scenarios.add(scenario);
    }
  }
  for (const id of applicability?.orderedIds ?? []) {
    if (!linked.has(id)) violations.push(`traceability-link-missing:${id}`);
  }
  if (scenarios.size !== 48) violations.push("traceability-scenario-total");
}

function parseJson(path: string, violations: string[]): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    violations.push(`json-missing-or-invalid:${path.split(sep).at(-1) ?? "unknown"}`);
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value) || Object.values(value).some((entry) => typeof entry !== "string")) return undefined;
  return value as Record<string, string>;
}

function sameRecord(left: Record<string, string> | undefined, right: Record<string, string> | undefined): boolean {
  return left !== undefined && right !== undefined && canonicalHash(left) === canonicalHash(right);
}

function registeredRuntimeProductionSourceFiles(): readonly string[] {
  const moduleByPath = new Map(ARCHITECTURE_MANIFEST.modules.map((module) => [module.path, module]));
  const pending = [...ARCHITECTURE_MANIFEST.compositionRoots.runtime];
  const reached = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (reached.has(path)) continue;
    const module = moduleByPath.get(path);
    if (module === undefined) throw new Error(`Runtime composition root dependency is unregistered: ${path}`);
    reached.add(path);
    for (const dependency of module.dependencies) {
      if (moduleByPath.has(dependency)) pending.push(dependency);
    }
  }
  return Object.freeze([...reached]
    .filter((path) => /^src\/.*\.ts$/u.test(path))
    .map((path) => path.slice("src/".length))
    .toSorted());
}

function registeredArchitectureModulePath(id: string): string {
  const matches = ARCHITECTURE_MANIFEST.modules.filter((module) => module.id === id);
  if (matches.length !== 1) throw new Error(`Architecture module registration is invalid: ${id}`);
  return matches[0]!.path;
}

function parseArguments(argv: readonly string[]): Readonly<{ root: string; attemptId: string }> {
  if (argv.length !== 4 || argv[0] !== "--root" || argv[1] !== "." || argv[2] !== "--attempt" ||
    !argv[3]) {
    throw new Error("Usage: s1-verification --root . --attempt UUID");
  }
  return { root: argv[1], attemptId: argv[3] };
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  try {
    const input = parseArguments(process.argv.slice(2));
    const receipt = loadTestResultFromExecution(configuredExecutionAuthority().receipt, input.attemptId);
    const result = verifyS1Repository(input.root, receipt);
    process.stdout.write(`${canonicalJson(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${canonicalJson({
      error: "verification_input_invalid",
      message: extractErrorMessage(error),
    })}\n`);
    process.exitCode = 1;
  }
}
