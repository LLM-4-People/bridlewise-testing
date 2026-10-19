import { dirname, join } from "node:path";

import { z } from "zod";

import { canonicalHash, deepFreeze, sha256 } from "../../../src/kernel/integrity.ts";
import { InputError, extractErrorMessage } from "../../../src/kernel/errors.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../../src/kernel/json-integrity.ts";
import { relativePathViolationKinds } from "../../../src/filesystem/path-boundary.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import { strictUtf8Text } from "../../verification/candidate-format.ts";
import {
  readSafeRepositoryFile,
  type SafeRepositoryRootAccessInput,
} from "../../verification/safe-repository-reader.ts";

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const NONEMPTY = z.string().min(1);
const MAXIMUM_BYTES = ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes;

const PROJECTION_ENTRY_SCHEMA = z.strictObject({
  originalPath: NONEMPTY,
  searchablePath: NONEMPTY,
  originalBytes: z.number().int().nonnegative(),
  originalSha256: SHA256,
  searchableBytes: z.number().int().nonnegative(),
  searchableSha256: SHA256,
  reconstruction: z.enum(["identity", "append-one-lf"]),
});

const PRESERVATION_MANIFEST_SCHEMA = z.strictObject({
  schemaVersion: z.literal("bridlewise-superseded-benchmark-content/v2"),
  role: z.literal("lossless-normalized-search-projection-and-original-byte-reconstruction"),
  createdAt: z.string(),
  sourceArchives: z.array(z.strictObject({
    path: NONEMPTY,
    byteLength: z.number().int().positive(),
    sha256: SHA256,
    disposition: z.literal("preserved-rejected-binary-fixture"),
  })).length(2),
  outerEntries: z.array(PROJECTION_ENTRY_SCHEMA).min(1),
  runnerEntries: z.array(PROJECTION_ENTRY_SCHEMA).min(1),
});

const REJECTED_FIXTURE_SIDECAR_SCHEMA = z.strictObject({
  schemaVersion: z.literal(ROOT_POLICY.artifactGovernance.binaryArchives.requiredSidecarSchema),
  role: z.literal("preserved-rejected-binary-fixture"),
  archive: z.strictObject({
    path: NONEMPTY,
    byteLength: z.number().int().positive(),
    sha256: SHA256,
    magicHex: z.literal("1f8b"),
  }),
  disposition: z.literal("preserved-rejected-binary-fixture"),
  mayEstablishEvidence: z.literal(false),
  reasonCodes: z.array(NONEMPTY).min(1),
  replacement: z.strictObject({
    contentManifestPath: NONEMPTY,
    contentManifestSha256: SHA256,
    expandedRoot: NONEMPTY,
    selection: z.enum(["outerEntries", "runnerEntries"]),
    expectedEntries: z.number().int().positive(),
  }),
  independentReplay: z.strictObject({
    path: NONEMPTY,
    sha256: SHA256,
    verdict: NONEMPTY,
  }),
});

export type RejectedBinaryFixtureVerification = Readonly<{
  contentFormat: "rejected-binary-fixture";
  violations: readonly string[];
}>;

export function verifyRejectedBinaryFixture(
  root: SafeRepositoryRootAccessInput,
  path: string,
  bytes: Uint8Array,
): RejectedBinaryFixtureVerification {
  const violations: string[] = [];
  const policy = ROOT_POLICY.artifactGovernance.binaryArchives;
  const fixture = policy.retainedFixtures.find((entry) => entry.path === path);
  if (fixture === undefined) {
    return result([`artifact-binary-valid-evidence-admission-suspended:${safeLabel(path)}`]);
  }
  const expectedMagic = Buffer.from(policy.requiredMagicHex, "hex");
  if (bytes.length !== fixture.byteLength || sha256(bytes) !== fixture.sha256 ||
    bytes.length < expectedMagic.length ||
    !Buffer.from(bytes.subarray(0, expectedMagic.length)).equals(expectedMagic)) {
    violations.push(`artifact-rejected-binary-fixture-identity-drift:${safeLabel(path)}`);
  }
  const sidecarPath = `${path}${policy.requiredSidecarSuffix}`;
  let sidecar: z.infer<typeof REJECTED_FIXTURE_SIDECAR_SCHEMA>;
  try {
    sidecar = parseCanonicalJson(
      readSafeRepositoryFile(root, sidecarPath, MAXIMUM_BYTES).bytes,
      REJECTED_FIXTURE_SIDECAR_SCHEMA,
    );
  } catch {
    return result([...violations, `artifact-rejected-binary-fixture-sidecar-invalid:${safeLabel(path)}`]);
  }
  if (sidecar.archive.path !== path || sidecar.archive.byteLength !== fixture.byteLength ||
    sidecar.archive.sha256 !== fixture.sha256 || sidecar.archive.magicHex !== policy.requiredMagicHex ||
    !sidecar.reasonCodes.includes(fixture.reasonCode)) {
    violations.push(`artifact-rejected-binary-fixture-sidecar-drift:${safeLabel(path)}`);
  }
  let manifestBytes: Buffer;
  let manifest: z.infer<typeof PRESERVATION_MANIFEST_SCHEMA>;
  let replayBytes: Buffer;
  try {
    manifestBytes = readSafeRepositoryFile(root, sidecar.replacement.contentManifestPath, MAXIMUM_BYTES).bytes;
    manifest = parseCanonicalJson(manifestBytes, PRESERVATION_MANIFEST_SCHEMA);
    replayBytes = readSafeRepositoryFile(root, sidecar.independentReplay.path, MAXIMUM_BYTES).bytes;
  } catch {
    return result([...violations, `artifact-rejected-binary-fixture-replacement-invalid:${safeLabel(path)}`]);
  }
  if (sha256(manifestBytes) !== sidecar.replacement.contentManifestSha256 ||
    sha256(replayBytes) !== sidecar.independentReplay.sha256) {
    violations.push(`artifact-rejected-binary-fixture-replacement-drift:${safeLabel(path)}`);
  }
  const archiveName = path.split("/").at(-1);
  if (!manifest.sourceArchives.some((entry) => entry.path === archiveName &&
    entry.byteLength === fixture.byteLength && entry.sha256 === fixture.sha256)) {
    violations.push(`artifact-rejected-binary-fixture-source-binding-drift:${safeLabel(path)}`);
  }
  const entries = manifest[sidecar.replacement.selection];
  if (entries.length !== sidecar.replacement.expectedEntries ||
    new Set(entries.map((entry) => entry.searchablePath)).size !== entries.length) {
    violations.push(`artifact-rejected-binary-fixture-projection-count-drift:${safeLabel(path)}`);
  }
  const manifestDirectory = dirname(sidecar.replacement.contentManifestPath);
  if (sidecar.replacement.expandedRoot !== manifestDirectory) {
    violations.push(`artifact-rejected-binary-fixture-expanded-root-drift:${safeLabel(path)}`);
  }
  for (const entry of entries) {
    try {
      if (relativePathViolationKinds(entry.searchablePath).length > 0) {
        throw new Error("search projection path is unsafe");
      }
      const searchablePath = join(sidecar.replacement.expandedRoot, entry.searchablePath).replaceAll("\\", "/");
      const searchable = readSafeRepositoryFile(root, searchablePath, MAXIMUM_BYTES).bytes;
      if (searchable.length !== entry.searchableBytes || sha256(searchable) !== entry.searchableSha256) {
        violations.push(`artifact-search-projection-drift:${safeLabel(searchablePath)}`);
        continue;
      }
      const reconstructed = reconstructOriginalBytes(searchable, entry.reconstruction);
      if (reconstructed.length !== entry.originalBytes || sha256(reconstructed) !== entry.originalSha256) {
        violations.push(`artifact-original-byte-reconstruction-drift:${safeLabel(searchablePath)}`);
      }
    } catch {
      violations.push(`artifact-search-projection-unreadable:${safeLabel(entry.searchablePath)}`);
    }
  }
  return result(violations);
}

export function reconstructOriginalBytes(
  searchable: Uint8Array,
  transform: "identity" | "append-one-lf",
): Buffer {
  return transform === "identity"
    ? Buffer.from(searchable)
    : Buffer.concat([Buffer.from(searchable), Buffer.from("\n")]);
}

/**
 * Every repository-relative path a preserved rejected fixture's search
 * projection binds — derived from the fixture authority (the policy's
 * retained fixtures, their sidecars, and the content manifests they name),
 * never enumerated by hand. The projection files are the archive's
 * searchable replacement content: the verifier reads them on every run, so
 * they are current-codebase even when their path shape (a superseded
 * document) says history. This is the readership a source scan cannot see:
 * the binding lives in DATA (a manifest entry), constructed at read time
 * (`expandedRoot` + `searchablePath`), so no source text ever contains the
 * path. Both halves of one fixture's entries are returned (outer and
 * runner), whether or not the sidecar selects them for verification — both
 * are preserved content the tree must hold.
 *
 * The reader is supplied by the caller so the derivation stays pure over
 * the bytes it is handed; a caller reading the live tree passes a bound
 * `readFileSync`; a reader of a ref answers `undefined` for a path the ref
 * does not hold. A fixture whose SIDECAR is not in this tree (ENOENT, or
 * `undefined`) contributes nothing — the tree does not carry that fixture, which is the
 * honest answer for a scratch or partial tree, and on the real tree the
 * verifier's own sidecar check already reds on the absence. Every OTHER
 * failure — a corrupt sidecar, a named-but-missing manifest, invalid
 * metadata — THROWS: a fixture census that cannot derive its universe must
 * fail loudly, never exclude nothing and certify everything.
 */
export function preservedFixtureProjectionPaths(
  read: (repositoryRelativePath: string) => Uint8Array | undefined,
): readonly string[] {
  const policy = ROOT_POLICY.artifactGovernance.binaryArchives;
  const metadataUnreadable = (path: string, error: unknown): InputError =>
    new InputError(
      `preserved fixture projection metadata is unreadable: ${path} (${extractErrorMessage(error)})`,
      "fixture_projection_metadata_unreadable",
      { path },
    );
  const paths = new Set<string>();
  for (const fixture of policy.retainedFixtures) {
    const sidecarPath = `${fixture.path}${policy.requiredSidecarSuffix}`;
    let sidecar: z.infer<typeof REJECTED_FIXTURE_SIDECAR_SCHEMA>;
    try {
      const bytes = read(sidecarPath);
      if (bytes === undefined) continue;
      sidecar = parseCanonicalJson(bytes, REJECTED_FIXTURE_SIDECAR_SCHEMA);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw metadataUnreadable(fixture.path, error);
    }
    let manifest: z.infer<typeof PRESERVATION_MANIFEST_SCHEMA>;
    try {
      const bytes = read(sidecar.replacement.contentManifestPath);
      if (bytes === undefined) throw new InputError(`the content manifest ${sidecar.replacement.contentManifestPath} is not in this tree`, "fixture_projection_metadata_unreadable");
      manifest = parseCanonicalJson(bytes, PRESERVATION_MANIFEST_SCHEMA);
    } catch (error) {
      throw metadataUnreadable(fixture.path, error);
    }
    for (const entry of [...manifest.outerEntries, ...manifest.runnerEntries]) {
      paths.add(join(sidecar.replacement.expandedRoot, entry.searchablePath).replaceAll("\\", "/"));
    }
  }
  return [...paths].toSorted();
}

function parseCanonicalJson<T>(bytes: Uint8Array, schema: z.ZodType<T>): T {
  const text = strictUtf8Text(bytes);
  assertNoDuplicateJsonObjectKeys(text, "Rejected fixture metadata has duplicate keys", "fixture_key_duplicate");
  return schema.parse(JSON.parse(text) as unknown);
}

function result(violations: readonly string[]): RejectedBinaryFixtureVerification {
  return deepFreeze({
    contentFormat: "rejected-binary-fixture",
    violations: [...new Set(violations)].toSorted(),
  });
}

function safeLabel(path: string): string {
  try {
    return encodeURIComponent(path);
  } catch {
    return `sha256-${canonicalHash({ path })}`;
  }
}
