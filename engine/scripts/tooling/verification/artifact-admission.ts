import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { canonicalHash, deepFreeze, sha256 } from "../../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../../src/kernel/json-integrity.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import { sameOrderedValues } from "../../../src/kernel/ordered.ts";
import { hasSecretTextSignal } from "../../../src/privacy/secret-signals.ts";
import { strictUtf8Text } from "../../verification/candidate-format.ts";
import { verifyRejectedBinaryFixture } from "./rejected-binary-fixture.ts";
import {
  readSafeRepositoryFile,
  safeRepositoryEntryStatus,
  safeRepositoryRootPathForInternalUse,
  type SafeRepositoryRootAccessInput,
} from "../../verification/safe-repository-reader.ts";

export const ARTIFACT_MANIFEST_PATH = "traceability/artifacts/manifest.json";

const NONEMPTY = z.string().min(1);
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const EXCLUDED_DIRECTORY_NAMES = new Set<string>(ROOT_POLICY.configuration.repositoryScanExclusions);
const EXCLUDED_FILE_NAMES = new Set<string>(ROOT_POLICY.configuration.repositoryScanFileExclusions);
const EXCLUDED_FILE_SUFFIXES = ROOT_POLICY.configuration.repositoryScanFileSuffixExclusions;

const ARTIFACT_ENTRY_SCHEMA = z.strictObject({
  id: z.string().regex(/^ART-[A-F0-9]{12}$/u),
  path: NONEMPTY,
  owner: NONEMPTY,
  artifactType: z.enum([
    "architecture-and-decision",
    "benchmark-design-and-script",
    "finding-and-audit",
    "proposal-and-plan",
    "requirement-source",
    "research-and-source-summary",
    "sanitized-benchmark-result",
    "test-and-reproducibility-strategy",
  ]),
  authorityStatus: z.enum(["canonical", "derived", "non-authoritative-research"]),
  authorityKey: NONEMPTY,
  origin: z.strictObject({
    kind: NONEMPTY,
    capturedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u),
    producingTool: NONEMPTY,
    producingModel: NONEMPTY,
    toolVersion: NONEMPTY,
    configuration: NONEMPTY,
    license: NONEMPTY,
  }),
  integrity: z.strictObject({
    byteLength: z.number().int().nonnegative(),
    sha256: SHA256,
  }),
  contentFormat: z.enum(["canonical-text", "rejected-binary-fixture"]),
  relations: z.strictObject({
    sourceLinks: z.array(NONEMPTY).min(1),
    dependencyLinks: z.array(NONEMPTY),
    supersedes: z.array(NONEMPTY),
    rebuildCommand: NONEMPTY.nullable(),
  }),
  classification: z.strictObject({
    data: z.enum(["public", "project-private", "sensitive-sanitized-historical-research"]),
    secretScan: z.enum(["pass-no-secret-pattern-match", "not-applicable-rejected-binary-fixture"]),
    scannerRevision: z.literal("artifact-secret-patterns/v1"),
  }),
  admission: z.strictObject({
    review: z.literal("builder-admission-reviewed"),
    independentReview: z.enum(["complete", "pending", "not-required-for-byte-preservation"]),
    candidateInventoryBound: z.literal(true),
    rationale: NONEMPTY,
  }),
  retention: z.strictObject({
    policy: NONEMPTY,
    rebuildable: z.boolean(),
  }),
  mayEstablishEvidence: z.boolean(),
});

const REJECTED_CANDIDATE_SCHEMA = z.strictObject({
  id: z.string().regex(/^REJ-[A-F0-9]{12}$/u),
  candidateClass: NONEMPTY,
  disposition: z.literal("excluded-not-admitted"),
  reason: NONEMPTY,
  retainedReplacementLinks: z.array(NONEMPTY),
});

export const ARTIFACT_ADMISSION_MANIFEST_SCHEMA = z.strictObject({
  schemaVersion: z.literal("bridlewise-artifact-admission/v3"),
  role: z.literal("canonical-important-artifact-inventory"),
  policyHash: SHA256,
  generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u),
  managedRoots: z.array(NONEMPTY).min(1),
  selfPath: z.literal(ARTIFACT_MANIFEST_PATH),
  entries: z.array(ARTIFACT_ENTRY_SCHEMA).min(1),
  rejectedCandidates: z.array(REJECTED_CANDIDATE_SCHEMA).min(1),
});

const PREVIOUS_V2_ARTIFACT_ENTRY_SCHEMA = ARTIFACT_ENTRY_SCHEMA.omit({
  contentFormat: true,
  mayEstablishEvidence: true,
}).extend({
  contentFormat: z.enum(["canonical-text", "deterministic-gzip-archive"]),
});
const PREVIOUS_V2_ARTIFACT_ADMISSION_MANIFEST_SCHEMA = z.strictObject({
  schemaVersion: z.literal("bridlewise-artifact-admission/v2"),
  role: z.literal("canonical-important-artifact-inventory"),
  policyHash: SHA256,
  generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u),
  managedRoots: z.array(NONEMPTY).min(1),
  selfPath: z.literal(ARTIFACT_MANIFEST_PATH),
  entries: z.array(PREVIOUS_V2_ARTIFACT_ENTRY_SCHEMA).min(1),
  rejectedCandidates: z.array(REJECTED_CANDIDATE_SCHEMA).min(1),
});
const LEGACY_ARTIFACT_ENTRY_SCHEMA = PREVIOUS_V2_ARTIFACT_ENTRY_SCHEMA.omit({ contentFormat: true });
const LEGACY_ARTIFACT_ADMISSION_MANIFEST_SCHEMA = z.strictObject({
  schemaVersion: z.literal("bridlewise-artifact-admission/v1"),
  role: z.literal("canonical-important-artifact-inventory"),
  policyHash: SHA256,
  generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u),
  managedRoots: z.array(NONEMPTY).min(1),
  selfPath: z.literal(ARTIFACT_MANIFEST_PATH),
  entries: z.array(LEGACY_ARTIFACT_ENTRY_SCHEMA).min(1),
  rejectedCandidates: z.array(REJECTED_CANDIDATE_SCHEMA).min(1),
});

export type ArtifactAdmissionManifest = Readonly<z.infer<typeof ARTIFACT_ADMISSION_MANIFEST_SCHEMA>>;
export type ArtifactAdmissionInput = Readonly<{
  root: SafeRepositoryRootAccessInput;
  paths: readonly string[];
  manifest?: unknown;
}>;

export function parseArtifactAdmissionManifestText(text: string): ArtifactAdmissionManifest {
  assertNoDuplicateJsonObjectKeys(
    text,
    "Artifact admission manifest contains a duplicate key",
    "artifact_manifest_key_duplicate",
  );
  return ARTIFACT_ADMISSION_MANIFEST_SCHEMA.parse(JSON.parse(text) as unknown);
}

export function artifactAdmissionViolations(input: ArtifactAdmissionInput): readonly string[] {
  const violations: string[] = [];
  let manifest: ArtifactAdmissionManifest;
  try {
    manifest = input.manifest === undefined
      ? parseArtifactAdmissionManifestText(strictUtf8Text(readSafeRepositoryFile(
        input.root,
        ARTIFACT_MANIFEST_PATH,
        ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
      ).bytes))
      : ARTIFACT_ADMISSION_MANIFEST_SCHEMA.parse(input.manifest);
  } catch {
    return deepFreeze(["artifact-admission-manifest-missing-or-invalid"]);
  }

  if (manifest.policyHash !== canonicalHash(ROOT_POLICY.artifactGovernance) ||
    canonicalHash(manifest.managedRoots) !== canonicalHash(ROOT_POLICY.artifactGovernance.governedRoots)) {
    violations.push("artifact-admission-policy-drift");
  }

  const entryByPath = uniqueMap(manifest.entries, (entry) => entry.path, "artifact-path-duplicate", violations);
  uniqueMap(manifest.entries, (entry) => entry.id, "artifact-id-duplicate", violations);
  const canonicalAuthorities = manifest.entries.filter((entry) => entry.authorityStatus === "canonical");
  uniqueMap(canonicalAuthorities, (entry) => entry.authorityKey, "artifact-authority-duplicate", violations);

  const expectedPaths = input.paths.filter((path) =>
    path !== manifest.selfPath && manifest.managedRoots.some((root) => path.startsWith(root)) &&
    !isRepositoryScanExcludedPath(path) && isRegularFile(input.root, path)).toSorted();
  const actualPaths = [...entryByPath.keys()].toSorted();
  if (!sameOrderedValues(expectedPaths, actualPaths)) violations.push("artifact-admission-inventory-drift");
  const independentReviewPolicy = ROOT_POLICY.artifactGovernance.independentReview;
  const independentReviewCurrent = isIndependentReviewCurrent(input.root, expectedPaths);

  for (const entry of manifest.entries) {
    if (entry.id !== `ART-${canonicalHash({ path: entry.path }).slice(0, 12).toUpperCase()}` ||
      entry.authorityKey !== `${entry.authorityStatus}:${entry.path}`) {
      violations.push(`artifact-identity-drift:${entry.id}`);
    }
    if (entry.path.startsWith("/") || entry.path.includes("..") || entry.path.includes("\\") ||
      entry.path === "tmp" || entry.path.startsWith("tmp/") || /(?:^|\/)node_modules(?:\/|$)/u.test(entry.path)) {
      violations.push(`artifact-path-forbidden:${entry.id}`);
      continue;
    }
    if (entry.relations.sourceLinks.some((link) => link.startsWith("/tmp/") || link.startsWith("file:"))) {
      violations.push(`artifact-source-locator-forbidden:${entry.id}`);
    }
    if (/\b(?:unknown|unrecorded|pending|tbd)\b/iu.test(entry.origin.license)) {
      violations.push(`artifact-license-unresolved:${entry.id}`);
    }
    if (entry.path.startsWith(independentReviewPolicy.governedPrefix) &&
      entry.admission.independentReview !== (independentReviewCurrent ? "complete" : "pending")) {
      violations.push(`artifact-independent-review-status-drift:${entry.id}`);
    }
    if (entry.admission.independentReview === "pending") {
      violations.push(`artifact-independent-review-pending:${entry.id}`);
    }
    const expectedData = entry.path.includes("/historical-")
      ? "sensitive-sanitized-historical-research"
      : entry.path.startsWith("traceability/sources/") ? "public" : "project-private";
    if (entry.classification.data !== expectedData) {
      violations.push(`artifact-classification-drift:${entry.id}`);
    }
    for (const link of [
      ...entry.relations.sourceLinks,
      ...entry.relations.dependencyLinks,
      ...entry.relations.supersedes,
    ]) {
      const localPath = link.split("#", 1)[0]!;
      if (/^[a-z]+:/iu.test(localPath)) continue;
      if (safeRepositoryEntryStatus(input.root, localPath).status !== "present") {
        violations.push(`artifact-provenance-link-missing:${entry.id}:${localPath}`);
      }
    }
    let bytes: Buffer;
    try {
      bytes = readSafeRepositoryFile(
        input.root,
        entry.path,
        ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
      ).bytes;
    } catch {
      violations.push(`artifact-bytes-missing:${entry.id}`);
      continue;
    }
    if (bytes.length !== entry.integrity.byteLength || sha256(bytes) !== entry.integrity.sha256) {
      violations.push(`artifact-integrity-drift:${entry.id}`);
    }
    const expectedContentFormat = artifactContentFormat(input.root, entry.path, bytes, violations);
    if (entry.contentFormat !== expectedContentFormat) {
      violations.push(`artifact-content-format-drift:${entry.id}`);
    }
    if (expectedContentFormat === "rejected-binary-fixture") {
      if (entry.mayEstablishEvidence ||
        entry.classification.secretScan !== "not-applicable-rejected-binary-fixture") {
        violations.push(`artifact-rejected-binary-fixture-authority-drift:${entry.id}`);
      }
      continue;
    }
    if (!entry.mayEstablishEvidence || entry.classification.secretScan !== "pass-no-secret-pattern-match") {
      violations.push(`artifact-text-authority-drift:${entry.id}`);
    }
    let text: string;
    try {
      text = strictUtf8Text(bytes);
    } catch {
      violations.push(`artifact-secret-or-binary-admission:${entry.id}`);
      continue;
    }
    if (text.includes("\0") || hasSecretTextSignal(text, "admission")) {
      violations.push(`artifact-secret-or-binary-admission:${entry.id}`);
    }
  }

  for (const rejected of manifest.rejectedCandidates) {
    if (rejected.id !== `REJ-${canonicalHash({ candidateClass: rejected.candidateClass })
      .slice(0, 12).toUpperCase()}`) {
      violations.push(`artifact-rejection-identity-drift:${rejected.id}`);
    }
    for (const replacement of rejected.retainedReplacementLinks) {
      if (safeRepositoryEntryStatus(input.root, replacement).status !== "present") {
        violations.push(`artifact-rejection-replacement-missing:${rejected.id}:${replacement}`);
      }
    }
  }

  return deepFreeze([...new Set(violations)].toSorted());
}

export function verifyArtifactAdmission(input: ArtifactAdmissionInput, violations: string[]): void {
  violations.push(...artifactAdmissionViolations(input));
}

export function buildArtifactAdmissionManifest(input: Readonly<{
  root: SafeRepositoryRootAccessInput;
  paths?: readonly string[];
  generatedAt: string;
  previousManifest?: unknown;
}>): ArtifactAdmissionManifest {
  const managedRoots = [...ROOT_POLICY.artifactGovernance.governedRoots];
  const previous = ARTIFACT_ADMISSION_MANIFEST_SCHEMA.safeParse(input.previousManifest);
  const previousV2 = previous.success
    ? undefined
    : PREVIOUS_V2_ARTIFACT_ADMISSION_MANIFEST_SCHEMA.safeParse(input.previousManifest);
  const legacyPrevious = previous.success || previousV2?.success
    ? undefined
    : LEGACY_ARTIFACT_ADMISSION_MANIFEST_SCHEMA.safeParse(input.previousManifest);
  const previousByHash = new Map<string, Readonly<{
    integrity: Readonly<{ byteLength: number; sha256: string }>;
    origin: ArtifactAdmissionManifest["entries"][number]["origin"];
  }>>();
  if (previous.success) {
    for (const entry of previous.data.entries) previousByHash.set(entry.integrity.sha256, entry);
  } else if (previousV2?.success) {
    for (const entry of previousV2.data.entries) previousByHash.set(entry.integrity.sha256, entry);
  } else if (legacyPrevious?.success) {
    for (const entry of legacyPrevious.data.entries) previousByHash.set(entry.integrity.sha256, entry);
  }
  const candidatePaths = input.paths ?? discoverGovernedArtifactPaths(input.root, managedRoots);
  const paths = [...new Set(candidatePaths)].filter((path) =>
    path !== ARTIFACT_MANIFEST_PATH && managedRoots.some((root) => path.startsWith(root)) &&
    !isRepositoryScanExcludedPath(path) && isRegularFile(input.root, path)).toSorted();
  const independentReviewPolicy = ROOT_POLICY.artifactGovernance.independentReview;
  const extensionReviewComplete = isIndependentReviewCurrent(input.root, paths);
  const entries = paths.map((path) => {
    const bytes = readSafeRepositoryFile(
      input.root,
      path,
      ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
    ).bytes;
    const contentViolations: string[] = [];
    const contentFormat = artifactContentFormat(input.root, path, bytes, contentViolations);
    if (contentViolations.length > 0) {
      throw new Error(`artifact admission rejected content format: ${path}`);
    }
    if (contentFormat === "canonical-text") {
      let text: string;
      try {
        text = strictUtf8Text(bytes);
      } catch {
        throw new Error(`artifact admission rejected secret-like or binary content: ${path}`);
      }
      if (text.includes("\0") || hasSecretTextSignal(text, "admission")) {
        throw new Error(`artifact admission rejected secret-like or binary content: ${path}`);
      }
    }
    const digest = sha256(bytes);
    const prior = previousByHash.get(digest);
    const authorityStatus = authorityStatusFor(path);
    const artifactType = artifactTypeFor(path);
    const historical = path.includes("/historical-");
    return {
      id: `ART-${canonicalHash({ path }).slice(0, 12).toUpperCase()}`,
      path,
      owner: ownerFor(path),
      artifactType,
      authorityStatus,
      authorityKey: `${authorityStatus}:${path}`,
      origin: prior?.origin ?? {
        kind: "governed-repository-admission-capture",
        capturedAt: input.generatedAt,
        producingTool: "canonical-artifact-manifest-generator",
        producingModel: "not-applicable-mechanical-inventory-generation",
        toolVersion: "artifact-admission/v1",
        configuration: "ROOT_POLICY.artifactGovernance",
        license: licenseFor(path),
      },
      integrity: { byteLength: bytes.length, sha256: digest },
      contentFormat,
      relations: relationsFor(path),
      classification: {
        data: historical ? "sensitive-sanitized-historical-research" :
          path.startsWith("traceability/sources/") ? "public" : "project-private",
        secretScan: contentFormat === "rejected-binary-fixture"
          ? "not-applicable-rejected-binary-fixture"
          : "pass-no-secret-pattern-match",
        scannerRevision: "artifact-secret-patterns/v1",
      },
      admission: {
        review: "builder-admission-reviewed",
        independentReview: path.startsWith(independentReviewPolicy.governedPrefix)
          ? extensionReviewComplete ? "complete" : "pending"
          : "not-required-for-byte-preservation",
        candidateInventoryBound: true,
        rationale: contentFormat === "rejected-binary-fixture"
          ? "Preserved only as an exact rejected raw fixture; it cannot establish evidence, qualification, finding removal, or readiness."
          : authorityStatus === "non-authoritative-research"
          ? "Preserved as research, method, executable qualification input, or sanitized evidence; it cannot establish product readiness by itself."
          : "Retained as a governed source or derived projection with explicit source links and integrity binding.",
      },
      retention: {
        policy: authorityStatus === "canonical"
          ? "retain-canonical-with-append-only-governed-supersession"
          : "retain-until-explicit-supersession-with-provenance",
        rebuildable: false,
      },
      mayEstablishEvidence: contentFormat !== "rejected-binary-fixture",
    };
  });
  return ARTIFACT_ADMISSION_MANIFEST_SCHEMA.parse({
    schemaVersion: "bridlewise-artifact-admission/v3",
    role: "canonical-important-artifact-inventory",
    policyHash: canonicalHash(ROOT_POLICY.artifactGovernance),
    generatedAt: input.generatedAt,
    managedRoots,
    selfPath: ARTIFACT_MANIFEST_PATH,
    entries,
    rejectedCandidates: rejectedCandidates(),
  });
}

function authorityStatusFor(path: string): "canonical" | "derived" | "non-authoritative-research" {
  if (path === "traceability/canonical/harness-requirements.md") return "canonical";
  if (path.startsWith("docs/research/") || path.startsWith("verification/")) return "non-authoritative-research";
  return "derived";
}

function artifactTypeFor(path: string): ArtifactAdmissionManifest["entries"][number]["artifactType"] {
  if (path.startsWith("docs/architecture/")) return "architecture-and-decision";
  if (path.startsWith("verification/")) return "benchmark-design-and-script";
  if (path.startsWith("traceability/findings/")) return "finding-and-audit";
  if (path === "traceability/canonical/harness-requirements.md" || path === "traceability/requirements.json") {
    return "requirement-source";
  }
  if (path.startsWith("traceability/s") || path.startsWith("traceability/sources/")) {
    return "test-and-reproducibility-strategy";
  }
  if (path.startsWith("docs/research/")) return "research-and-source-summary";
  return "proposal-and-plan";
}

function ownerFor(path: string): string {
  for (const [fragment, owner] of [
    ["/git/", "workspace-and-git"], ["/context/", "repository-intelligence-and-context"],
    ["/extensions/", "self-evolution"], ["/historical-", "historical-research"],
    ["/storage/", "storage"], ["/security/", "security"], ["/quality-packs/", "quality"],
    ["/code-intelligence/", "repository-intelligence-and-context"], ["/agents/", "agent-orchestration"],
  ] as const) {
    if (`/${path}`.includes(fragment)) return owner;
  }
  if (path.startsWith("docs/architecture/")) return "architecture";
  if (path.startsWith("traceability/")) return "traceability";
  return "verification";
}

function licenseFor(path: string): string {
  if (path.startsWith("traceability/sources/s2/openai-")) return "MIT:traceability/sources/s2/openai-LICENSE";
  if (path.startsWith("traceability/sources/s2/mcp-")) return "MIT:traceability/sources/s2/mcp-LICENSE";
  if (path.startsWith("traceability/sources/s3.1/jcs-")) return "Apache-2.0:traceability/sources/s3.1/jcs-LICENSE";
  if (path.includes("/historical-")) {
    return "project-internal-sanitized-historical-research-no-redistribution-license-asserted";
  }
  if (path.includes("/git/")) {
    return "project-internal-research-primary-source-identities-in-docs/research/git/qualification/sources.lock.json";
  }
  return "project-internal-no-external-redistribution-license-asserted";
}

function relationsFor(path: string): ArtifactAdmissionManifest["entries"][number]["relations"] {
  const requirements = "traceability/canonical/harness-requirements.md";
  const independentReview = ROOT_POLICY.artifactGovernance.independentReview;
  if (path.startsWith(independentReview.governedPrefix)) {
    const requiredReports: readonly string[] = independentReview.requiredReports;
    const reportIndex = requiredReports.indexOf(path);
    return {
      sourceLinks: [reportIndex >= 0 ? independentReview.reviewedArtifact : requirements],
      dependencyLinks: path === independentReview.reviewedArtifact
        ? [...requiredReports]
        : reportIndex >= 0 ? requiredReports.slice(0, reportIndex) : [],
      supersedes: [],
      rebuildCommand: null,
    };
  }
  if (path.startsWith("docs/research/git/") || path.startsWith("verification/benchmarks/git/")) {
    const manifest = "verification/benchmarks/git/MANIFEST.json";
    return {
      sourceLinks: [path === manifest ? "docs/research/git/qualification/sources.lock.json" : manifest],
      dependencyLinks: path === manifest ? ["verification/benchmarks/git/scenario-catalog.json"] : [],
      supersedes: [],
      rebuildCommand: path === manifest ? "python3 verification/benchmarks/git/qualification.py verify-manifest" : null,
    };
  }
  if (path.startsWith("docs/research/context/") || path.startsWith("verification/benchmarks/context/")) {
    const manifest = "docs/research/context/qualification/manifest.json";
    return {
      sourceLinks: [path === manifest ? requirements : manifest], dependencyLinks: [], supersedes: [],
      rebuildCommand: path === manifest ? "python3 verification/benchmarks/context/validate-suite.py" : null,
    };
  }
  return { sourceLinks: [requirements], dependencyLinks: [], supersedes: [], rebuildCommand: null };
}

function rejectedCandidates(): ArtifactAdmissionManifest["rejectedCandidates"] {
  const values = [
    ["raw-personal-conversation-and-database-records", "Contains raw personal historical data; only sanitized aggregate methodology and results are admitted.", "traceability/findings/SEC-001-runbook-search-scope-exposure.md"],
    ["credential-and-redaction-key-material", "Credential or secret key material is never admitted to the repository.", "traceability/canonical/harness-requirements.md"],
    ["dependency-trees-caches-downloaded-tools-and-model-weights", "Rebuildable third-party dependencies and caches are excluded; manifests, locks, versions, and source links are retained instead.", "package-lock.json"],
    ["transient-databases-and-compiled-probe-output", "Transient databases and rebuildable binaries are execution artifacts rather than durable authority.", "traceability/evidence/research/storage/s4-storage-qualification/artifacts/qualification-results.json"],
    ["raw-editor-history-jsonl-baselines", "Raw conversation-derived editor baselines are excluded; sanitized aggregate and benchmark protocol artifacts are retained.", "traceability/canonical/harness-requirements.md"],
    ["private-code-intelligence-call-fixtures", "Raw tool transcripts and copied private project fixtures are excluded; method and aggregate evidence are retained.", "traceability/evidence/research/code-intelligence/measured-summary.json"],
    ["historical-review-packet-subtree", "Confidentiality-sensitive packets are never inspected or admitted; the scope-control incident is retained without packet content.", "traceability/findings/SEC-001-runbook-search-scope-exposure.md"],
    ["superseded-git-source-lock-copy", "Removed stale pre-reconciliation source lock sha256:c73107aa6e26208438ffeb86a3db22a355c2eeb552d53d81019cae87147bb2ea; the final canonical docs source lock is retained.", "docs/research/git/qualification/sources.lock.json"],
  ] as const;
  return values.map(([candidateClass, reason, replacement]) => ({
    id: `REJ-${canonicalHash({ candidateClass }).slice(0, 12).toUpperCase()}`,
    candidateClass,
    disposition: "excluded-not-admitted" as const,
    reason,
    retainedReplacementLinks: [replacement],
  }));
}

function isRegularFile(root: SafeRepositoryRootAccessInput, path: string): boolean {
  const status = safeRepositoryEntryStatus(root, path);
  return status.status === "present" && status.kind === "file";
}

function artifactContentFormat(
  root: SafeRepositoryRootAccessInput,
  path: string,
  bytes: Uint8Array,
  violations: string[],
): "canonical-text" | "rejected-binary-fixture" {
  const policy = ROOT_POLICY.artifactGovernance.binaryArchives;
  if (!path.endsWith(policy.retainedSuffix)) return "canonical-text";
  const result = verifyRejectedBinaryFixture(root, path, bytes);
  violations.push(...result.violations);
  return result.contentFormat;
}

function isIndependentReviewCurrent(root: SafeRepositoryRootAccessInput, paths: readonly string[]): boolean {
  const policy = ROOT_POLICY.artifactGovernance.independentReview;
  const latestReport = policy.requiredReports.at(-1);
  const requiredPaths = [policy.reviewedArtifact, ...policy.reviewedInputs, ...policy.requiredReports];
  if (latestReport === undefined || !requiredPaths.every((path) => paths.includes(path) && isRegularFile(root, path))) {
    return false;
  }
  let reportText: string;
  try {
    reportText = strictUtf8Text(readSafeRepositoryFile(
      root,
      latestReport,
      ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
    ).bytes);
  } catch {
    return false;
  }
  return policy.reviewedInputs.every((path) => {
    try {
      return reportText.includes(sha256(readSafeRepositoryFile(
        root,
        path,
        ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
      ).bytes));
    } catch {
      return false;
    }
  });
}

function discoverGovernedArtifactPaths(
  root: SafeRepositoryRootAccessInput,
  managedRoots: readonly string[],
): readonly string[] {
  const rootPath = safeRepositoryRootPathForInternalUse(root);
  // A governed root that the package does not carry contributes no artifacts.
  // The public development floor splits its tree: the engine package roots
  // `traceability/` and `verification/`, while the human documentation root
  // `docs/` sits at the repository root, outside the engine's artifact-admission
  // root (the candidate verifier and the S1 structure check both scan the
  // engine). Absence is a tree-shape fact here, never an empty population: if
  // NO governed root exists the inventory would certify nothing, so that still
  // refuses below.
  const roots = managedRoots.map((managedRoot) => managedRoot.replace(/\/$/u, ""));
  const presentRoots = roots.filter((managedRoot) => existsSync(join(rootPath, managedRoot)));
  if (presentRoots.length === 0) {
    throw new Error(`no governed artifact root exists under ${rootPath} (expected one of: ${roots.join(", ")})`);
  }
  const paths: string[] = [];
  const visit = (relativeDirectory: string): void => {
    const absoluteDirectory = join(rootPath, relativeDirectory);
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })
      .toSorted((left, right) => left.name.localeCompare(right.name))) {
      const path = `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`governed artifact symlink is forbidden: ${path}`);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name)) visit(path);
      } else if (entry.isFile()) {
        if (!isRepositoryScanExcludedPath(path)) paths.push(path);
      }
      else throw new Error(`governed artifact special entry is forbidden: ${path}`);
    }
  };
  for (const managedRoot of presentRoots) visit(managedRoot);
  return paths.toSorted();
}

function isRepositoryScanExcludedPath(path: string): boolean {
  const segments = path.split("/");
  const fileName = segments.at(-1) ?? "";
  return segments.slice(0, -1).some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment)) ||
    EXCLUDED_FILE_NAMES.has(fileName) || EXCLUDED_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

function uniqueMap<T>(
  entries: readonly T[],
  key: (entry: T) => string,
  code: string,
  violations: string[],
): Map<string, T> {
  const output = new Map<string, T>();
  for (const entry of entries) {
    const value = key(entry);
    if (output.has(value)) violations.push(`${code}:${value}`);
    else output.set(value, entry);
  }
  return output;
}
