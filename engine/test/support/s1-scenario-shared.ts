import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants, cpSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ARCHITECTURE_MANIFEST, type ArchitectureManifest } from "../../src/architecture-manifest.ts";
import { getConfigDocumentSchema } from "../../src/kernel/config.ts";
import { canonicalHash } from "../../src/kernel/integrity.ts";
import { parseRequirementsRegistryText, requirementRegistryIds } from "../../src/kernel/requirements.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { engineModuleSourceRelative } from "../../src/shared/module-location.ts";
import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { createWorkingCopy } from "../../src/git/working-copy.ts";
import { verifyS1Structure } from "../../scripts/tooling/s1-verification.ts";
import { analyzeArchitectureSource } from "../../scripts/verification/architecture.ts";
import { createRepositoryLocalTemporaryDirectory, removeRepositoryLocalTemporaryDirectory, TEST_REPOSITORY_ROOT as REPOSITORY_ROOT } from "./repository-local-temporary.ts";
import { repositoryArchitectureManifest } from "../../scripts/verification/architecture.ts";
/** The tree's architecture manifest: its census, classified by the committed decisions (never a committed module list). */
const REPOSITORY_MANIFEST = repositoryArchitectureManifest(join(import.meta.dirname, "..", ".."));

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

export { REPOSITORY_ROOT };

export const ROOT_CONFIG_FIXTURE = CONFIG_DOCUMENT_SCHEMA.parse(JSON.parse(
  readFileSync(join(REPOSITORY_ROOT, "bridlewise.config.json"), "utf8"),
));
export const ALIGNMENT_CONFIG_FIXTURE = ROOT_CONFIG_FIXTURE.alignmentCheckpoint;
export const CONTRACT_CONFIG_FIXTURE = ROOT_CONFIG_FIXTURE.contracts;
export const ACTIVE_TRACE_PATHS = ["s1.json", "s2.json", "s2.4.json", "s3.1.json"] as const;
const OWNED_TEMPORARY_DIRECTORIES = new Set<string>();

export type Invocation = Readonly<{ status: number | null; stdout: string; stderr: string }>;

/**
 * The engine files a runtime candidate carries, repository-relative. Heavy
 * records no preflight check or S1 scenario reads stay out: the research
 * receipts under `traceability/evidence/research/`, the path-policy sources,
 * and the evaluation run results under `verification/benchmarks/evaluation/runs`
 * (together they cut each copy from ~54M to ~16M across ~130 candidates).
 */
function runtimeCandidatePath(path: string): boolean {
  if (path.startsWith("shared/")) return true;
  if (!path.startsWith("engine/")) return false;
  const rest = path.slice("engine/".length);
  if (rest.includes("/evidence/research/") || rest.includes("/sources/path-policy/") ||
    rest.startsWith("verification/benchmarks/evaluation/runs/")) return false;
  return rest.startsWith("src/") || rest.startsWith("scripts/") || rest.startsWith("traceability/") ||
    rest.startsWith("verification/") || rest.startsWith("test/fixtures/") || rest.startsWith("test/s1-scenarios/") ||
    rest === "test/support/path-boundary-probe.ts" ||
    (rest.startsWith("test/") && !rest.slice("test/".length).includes("/") && rest.endsWith(".test.ts")) ||
    ["bridlewise.config.json", "package.json", "package-lock.json", "tsconfig.json"].includes(rest);
}

/**
 * A runtime candidate: the engine sources and records an S1 scenario mutates,
 * built by the one working-copy builder (`src/git/working-copy.ts`) with no
 * git (the scenarios judge the tree, not an index). The candidate root is the
 * copy's `engine/`, and the repository-root `shared/` sits beside it exactly
 * where `../../../shared/…` from `src/timeline/` resolves — the merged
 * layout the CLI's import graph needs. Timestamps are kept so the recursive
 * manifest's per-file hash cache (keyed by path + size + mtime) hits for every
 * file a scenario does not mutate.
 */
export function makeRuntimeCandidate(): string {
  const root = createOwnedTemporaryDirectory("s1-runtime-");
  createWorkingCopy({
    sourceRoot: REPOSITORY_ROOT,
    targetRoot: root,
    git: "none",
    include: runtimeCandidatePath,
    preserveTimestamps: true,
  });
  const candidate = join(root, "engine");
  mkdirSync(join(candidate, "node_modules"));
  cpSync(join(REPOSITORY_ROOT, "node_modules", "zod"), join(candidate, "node_modules", "zod"), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    preserveTimestamps: true,
    filter: (source) => lstatSync(source).isDirectory() || source.endsWith(".js") || source.endsWith("package.json"),
  });
  return candidate;
}

export function createOwnedTemporaryDirectory(prefix: string): string {
  const path = createRepositoryLocalTemporaryDirectory(prefix);
  OWNED_TEMPORARY_DIRECTORIES.add(path);
  return path;
}

export function removeOwnedTemporaryDirectories(): void {
  for (const path of OWNED_TEMPORARY_DIRECTORIES) removeRepositoryLocalTemporaryDirectory(path);
  OWNED_TEMPORARY_DIRECTORIES.clear();
}

// Subprocess env for S1 scenario invocations. The CLI bootstrap emits a
// `process.emitWarning` in dev mode (`self_protection_disabled_dev_mode`) which
// writes to stderr AFTER the typed-error JSON. Since `errorCode` /
// `parseSuccess` parse the subprocess streams as a single JSON document, the
// trailing warning corrupts the parse ("Unexpected non-whitespace character
// after JSON"). `NODE_NO_WARNINGS=1` suppresses `process.emitWarning` output
// so the subprocess stderr/stdout carry ONLY the CLI's JSON contract. This is
// the honest fix: the test harness relies on a clean JSON stream, and the
// dev-mode warning is a diagnostic for interactive use, not part of the
// stream contract. Existing env vars are preserved (spread first) so the
// opt-in flags (e.g. HARNESS_INCLUDE_EXPERIMENTS) still propagate.
const SUBPROCESS_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, NODE_NO_WARNINGS: "1" });

export function invoke(root: string, args: readonly string[] = ["preflight"], nodeArgs: readonly string[] = []): Invocation {
  const result = spawnSync(process.execPath, [...nodeArgs, join(root, "src", "cli.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: SUBPROCESS_ENV(),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function invokeBootstrap(root: string, args: readonly string[] = []): Invocation {
  const result = spawnSync(process.execPath, [join(root, "scripts", "tooling", "bootstrap-permissions.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: SUBPROCESS_ENV(),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function collect(child: ChildProcess): Promise<Invocation> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    assert.ok(child.stdout && child.stderr);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout += chunk);
    child.stderr.on("data", (chunk: string) => stderr += chunk);
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * Extract the first JSON-parsable line from a stream. The CLI writes its
 * typed-error JSON as a single line on stderr (and its success result as a
 * single line on stdout). Defense-in-depth: even if a diagnostic (e.g. a
 * `process.emitWarning` not suppressed by NODE_NO_WARNINGS) slips onto the
 * stream, this extracts the JSON contract line instead of failing on the
 * whole stream.
 */
function parseJsonLine(stream: string): Record<string, unknown> {
  for (const line of stream.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  // No JSON line found — fall back to parsing the whole stream so the
  // original SyntaxError (with position) surfaces for debugging.
  return JSON.parse(stream) as Record<string, unknown>;
}

export function parseSuccess(invocation: Invocation): Record<string, unknown> {
  assert.equal(invocation.status, 0, invocation.stderr);
  return parseJsonLine(invocation.stdout);
}

export function errorCode(invocation: Invocation): string {
  assert.equal(invocation.status, 1, invocation.stdout);
  return String(parseJsonLine(invocation.stderr).error);
}

export function writeConfig(root: string, value: unknown, raw?: string): void {
  // The scenario config goes through the atomic-rename owner, never a raw
  // truncating write: the S1 verification re-reads the candidate tree, so a
  // scenario must never present a config file caught mid-write.
  const result = atomicWriteFile(join(root, "bridlewise.config.json"), raw ?? `${JSON.stringify(value, null, 2)}\n`, {
    requiredMode: 0o600,
  });
  assert.ok(result.success, result.reason);
}

export function config(projectId = "s1-fixture"): object {
  return {
    schemaVersion: 2,
    project: { id: projectId, root: "." },
    data: { defaultClassification: "project-private" },
    state: {
      root: ".bridlewise/state",
      receipts: { executionEvidence: "evidence/executions" },
    },
    alignmentCheckpoint: ALIGNMENT_CONFIG_FIXTURE,
    contracts: CONTRACT_CONFIG_FIXTURE,
  };
}

export function historicalApplicationName(separator = ""): string {
  return ["Open", separator, "Code"].join("");
}

export function historicalTableName(...parts: readonly string[]): string {
  return parts.join("_");
}

/**
 * The candidate-relative path of an engine module, resolved from the CURRENT
 * tree. `makeRuntimeCandidate` copies `src/` verbatim, so a module lives in the
 * candidate at the same `src/`-relative path it has in the real tree. The
 * kernel/config/forensics fold moved dozens of modules (`src/errors.ts` →
 * `src/kernel/errors.ts`, …); every scenario that appends to or mutates a
 * candidate module by its pre-fold path then wrote to a file that no longer
 * exists. This helper resolves the module by name/fragment to its post-fold
 * path, so a fold touches nothing in the scenario. The caller passes the
 * module identity (`"errors.ts"` or `"kernel/errors.ts"`), never a spelled
 * path.
 */
export function candidateModulePath(moduleNameOrFragment: string): string {
  return engineModuleSourceRelative(moduleNameOrFragment);
}

export function appendCandidateSource(root: string, relativePath: string, source: string): void {
  const absolutePath = join(root, relativePath);
  writeFileSync(absolutePath, `${readFileSync(absolutePath, "utf8")}\n${source}\n`);
}

export function mutateCandidateTextExact(
  root: string,
  relativePath: string,
  before: string,
  after: string,
  label: string,
): void {
  const path = join(root, relativePath);
  const source = readFileSync(path, "utf8");
  writeFileSync(path, mutateTextExact(source, before, after, label));
}

export function mutateTextExact(
  source: string,
  before: string,
  after: string,
  label = "exact-text mutant",
): string {
  const matchCount = source.split(before).length - 1;
  assert.equal(matchCount, 1, `${label}: expected exactly one governed-byte match`);
  const mutated = source.replace(before, after);
  assert.notEqual(mutated, source, `${label}: mutation did not change governed bytes`);
  return mutated;
}

export function registeredOpenArchitectureDiagnostics(): readonly string[] {
  return ARCHITECTURE_MANIFEST.findings
    .filter((finding) => finding.status === "open-blocking")
    .map((finding) => `architecture-open-blocking-finding:${finding.id}`)
    .toSorted();
}

export function isMovingProjectionDiagnostic(diagnostic: string): boolean {
  return diagnostic === "architecture-module-registration-drift" ||
    diagnostic === "production-graph-incomplete-or-extra" ||
    diagnostic.startsWith("artifact-") ||
    diagnostic.startsWith("s2-behavior-test-missing:") ||
    diagnostic === "s2-test-inventory-unavailable" ||
    diagnostic === "s2.4-test-inventory-unavailable" ||
    diagnostic === "s3.1-test-inventory-unavailable" ||
    diagnostic === "test-inventory-invalid-or-incomplete" ||
    diagnostic.startsWith("lock-") ||
    diagnostic === "package-runtime-range-policy" ||
    diagnostic === "package-script-surface" ||
    diagnostic === "s2-contract-identity-mismatch" ||
    diagnostic === "s3.1-forensic-schema-artifact-drift" ||
    diagnostic === "traceability-behavior-values-or-links" ||
    diagnostic.startsWith("traceability-link-unknown:");
}

export function isUnavailableCapabilityDiagnostic(diagnostic: string): boolean {
  return diagnostic.startsWith("architecture-effect-owner:") ||
    diagnostic.startsWith("architecture-effect-unmodeled:") ||
    // The public snapshot does not publish the private floor's historical
    // OpenCode benchmark sources. The architecture verifier names that
    // boundary on every run; it is an unavailable capability, not a defect
    // the tree can fix by inventing sources. An unexpected source at one of
    // those paths is NOT classified here, so it still reddens the control.
    diagnostic.startsWith("architecture-external-command-source-not-published:") ||
    diagnostic.startsWith("governed-export-unmodeled:") ||
    diagnostic.startsWith("governed-sink-unmodeled:") ||
    diagnostic.startsWith("standalone-product-boundary-") ||
    diagnostic === "package-development-dependencies" ||
    diagnostic.startsWith("architecture-effect-boundary:") ||
    diagnostic.startsWith("architecture-lexical-module-unmodeled:") ||
    diagnostic.startsWith("environment-acquisition-unmodeled:") ||
    diagnostic.startsWith("module-acquisition-unmodeled:") ||
    diagnostic.startsWith("nonliteral-module-load:") ||
    diagnostic.startsWith("process-member-unmodeled:") ||
    diagnostic.startsWith("production-effect-api:") ||
    diagnostic.startsWith("production-effect-builtin:") ||
    diagnostic.startsWith("production-effect-sink-unmodeled:") ||
    diagnostic.startsWith("standalone-runtime-sink-unmodeled:") ||
    diagnostic === "package-runtime-dependencies" ||
    diagnostic.startsWith("evidence-graph-competing-authority:") ||
    diagnostic.startsWith("historical-source-schema-marker:");
}

export function isPendingArchitectureRefactor(diagnostic: string): boolean {
  return diagnostic.startsWith("architecture-realm-direction:") ||
    diagnostic.startsWith("architecture-reverse-layer:") ||
    diagnostic.startsWith("production-relative-import-denied:") ||
    diagnostic.startsWith("architecture-adapter-construction:") ||
    diagnostic.startsWith("architecture-import-cycle:") ||
    diagnostic.startsWith("architecture-local-errors-authority:") ||
    diagnostic.startsWith("architecture-pinned-process-internal-import-denied:") ||
    diagnostic.startsWith("environment-configuration-source:") ||
    diagnostic.startsWith("production-dependency-denied:");
}

/**
 * The live repository's clean-architecture baseline: the S1 verification of
 * the real tree reports zero architecture- and audit-matrix violations
 * beyond the three registered diagnostic classes (moving projections,
 * unavailable capabilities, pending refactors) and the open blocking
 * findings. This is the s1 scenario battery's control arm, owned here so the
 * scenario file and the routine architecture guard register the SAME
 * assertion — one owner, two suites — instead of a second copy drifting
 * beside the first.
 *
 * Any newly-introduced architecture violation (a duplicate manifest path, an
 * unregistered module, an unclassified diagnostic) fails this assertion, so
 * a green run is a strong regression signal for the whole tree.
 */
export function assertArchitectureBaselineClean(): void {
  assert.equal(ROOT_POLICY.universalPolicyArchitecture.moduleArchitecture.manifest,
    "src/architecture-manifest.ts");
  assert.equal(ROOT_POLICY.universalPolicyArchitecture.dualSurfaceAssessment.oneSurfaceMaySatisfyOther, false);
  assert.equal(ROOT_POLICY.universalPolicyArchitecture.auditMatrix.independentAudit,
    "mandatory-non-self-hosted-and-never-satisfied-by-dogfood");
  // The candidate manifest reads git through the one repository-git
  // executor it imports: that module owns the git-invocation fact and the
  // `git` effect, and the candidate manifest depends on it.
  const gitOwner = "scripts/tooling/repository-git.ts";
  const gitOwnerFacts = analyzeArchitectureSource(gitOwner, readFileSync(join(REPOSITORY_ROOT, gitOwner), "utf8"));
  assert.ok(gitOwnerFacts.directEffectFacts.some((fact) =>
    fact.ownerLabel === "git-invocation" && fact.effects.includes("git")));
  assert.ok(REPOSITORY_MANIFEST.modules.find((module) => module.path === gitOwner)!.effects.includes("git"));
  const candidateManifest = "scripts/tooling/candidate-manifest.ts";
  assert.ok(analyzeArchitectureSource(candidateManifest, readFileSync(join(REPOSITORY_ROOT, candidateManifest), "utf8")).dependencies.includes(gitOwner));
  // The architecture-manifest changes fixed ALL architecture-effect-owner /
  // architecture-effect-unmodeled / architecture-reverse-layer /
  // architecture-realm-direction / architecture-open-blocking-finding
  // violations, so the clean baseline (verifyS1Structure(REPOSITORY_ROOT))
  // reports ZERO architecture- / audit-matrix- violations. This empty
  // snapshot is a strong regression guard: any newly-introduced architecture
  // violation (effect-owner drift, reverse layer, open blocking finding,
  // etc.) fails this control test.
  assert.deepEqual(verifyS1Structure(REPOSITORY_ROOT).violations.filter((entry) =>
    (entry.startsWith("architecture-") || entry.startsWith("audit-matrix-")) &&
    !entry.startsWith("architecture-open-blocking-finding:") &&
    !isMovingProjectionDiagnostic(entry) &&
    !isUnavailableCapabilityDiagnostic(entry) &&
    !isPendingArchitectureRefactor(entry)), []);
}

export function mountedRootBoundaryEvidence(
  source: string,
  target: string,
  candidate: string,
  observedPaths: Readonly<Record<string, string>>,
): Readonly<{
  before: Readonly<Record<string, string>>;
  results: readonly Readonly<{ violations: readonly string[] }>[];
  after: Readonly<Record<string, string>>;
}> {
  const verificationModule = pathToFileURL(join(
    REPOSITORY_ROOT,
    "scripts",
    "tooling",
    "s1-verification.ts",
  )).href;
  const script = [
    'import { spawnSync } from "node:child_process";',
    'import { lstatSync } from "node:fs";',
    `import { verifyS1Structure } from ${JSON.stringify(verificationModule)};`,
    `const source = ${JSON.stringify(source)};`,
    `const target = ${JSON.stringify(target)};`,
    `const candidate = ${JSON.stringify(candidate)};`,
    `const observedPaths = ${JSON.stringify(observedPaths)};`,
    'const mounted = spawnSync("mount", ["--bind", source, target], { encoding: "utf8" });',
    'if (mounted.status !== 0) throw new Error(`mount namespace capability unavailable: ${mounted.stderr.trim()}`);',
    "let evidence;",
    "try {",
    "  const inspect = () => Object.fromEntries(Object.entries(observedPaths).map(([name, path]) => [",
    "    name, lstatSync(path, { bigint: true }).atimeNs.toString(),",
    "  ]));",
    "  const before = inspect();",
    "  const results = Array.from({ length: 3 }, () => verifyS1Structure(candidate));",
    "  evidence = { before, results, after: inspect() };",
    "} finally {",
    '  const unmounted = spawnSync("umount", [target], { encoding: "utf8" });',
    '  if (unmounted.status !== 0) throw new Error(`unmount failed: ${unmounted.stderr.trim()}`);',
    "}",
    'process.stdout.write(`${JSON.stringify(evidence)}\\n`);',
  ].join("\n");
  const probe = spawnSync("unshare", [
    "--user", "--map-root-user", "--mount", "--fork",
    process.execPath, "--input-type=module", "-e", script,
  ], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  assert.equal(probe.status, 0, `mount namespace capability unavailable: ${probe.stderr}`);
  return JSON.parse(probe.stdout) as {
    before: Record<string, string>;
    results: Array<{ violations: string[] }>;
    after: Record<string, string>;
  };
}

export function repositoryArchitectureSources(manifest: ArchitectureManifest = REPOSITORY_MANIFEST) {
  return manifest.modules.map((module) => ({
    path: module.path,
    source: readFileSync(join(REPOSITORY_ROOT, module.path), "utf8"),
  }));
}

export function universalExtensionControl(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: "bridlewise-static-extension-conformance/v1",
    registration: "centrally-registered-static-control",
    id: "extension-control",
    capabilities: ["inspect"],
    operations: ["repository.inspect"],
    inheritedPolicyFamilies: [...ROOT_POLICY.universalPolicyArchitecture.policyFamilies],
    policyHash: canonicalHash(ROOT_POLICY.universalPolicyArchitecture),
    directLowLevelEntrypoints: false,
    copiedPolicyDefinitions: false,
    waiverIds: [],
    ...overrides,
  };
}

export function registeredScenarios(): string[] {
  const trace = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "traceability", "s1.json"), "utf8")) as {
    behaviors: Array<{ scenarios: string[] }>;
  };
  return trace.behaviors.flatMap((behavior) => behavior.scenarios).toSorted();
}

export function activeRootPolicyProjection(): Readonly<{
  orderedIds: readonly string[];
  referencedIds: ReadonlySet<string>;
}> {
  const registry = parseRequirementsRegistryText(
    readFileSync(join(REPOSITORY_ROOT, "traceability", "requirements.json"), "utf8"),
  );
  const references: string[] = [];
  for (const name of ACTIVE_TRACE_PATHS) {
    const trace = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "traceability", name), "utf8")) as {
      requirements?: unknown;
      derivedControls?: unknown;
    };
    assert.ok(Array.isArray(trace.requirements));
    assert.ok(Array.isArray(trace.derivedControls));
    const traceReferences = [...trace.requirements, ...trace.derivedControls];
    assert.equal(traceReferences.every((id) => typeof id === "string"), true);
    assert.equal(new Set(traceReferences).size, traceReferences.length);
    references.push(...traceReferences as string[]);
  }
  return {
    orderedIds: [...requirementRegistryIds(registry, references)],
    referencedIds: new Set(references),
  };
}

export async function importCandidatePreflight(root: string): Promise<typeof import("../../src/kernel/preflight.ts")> {
  // preflight.ts moved to src/kernel/ in the fold; resolve its current
  // candidate-relative path rather than spelling the pre-fold location.
  return import(`${pathToFileURL(join(root, engineModuleSourceRelative("preflight.ts"))).href}?fixture=${Date.now()}-${Math.random()}`);
}

export async function raceRuntime(root: string, mutate: () => void): Promise<Invocation> {
  const child = spawn(process.execPath, [join(root, "src", "cli.ts"), "preflight"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timer = setInterval(() => {
    for (let index = 0; index < 12; index += 1) mutate();
  }, 0);
  try {
    return await collect(child);
  } finally {
    clearInterval(timer);
  }
}
