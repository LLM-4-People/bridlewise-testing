import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { canonicalHash, canonicalJson, deepFreeze, sha256 } from "../../src/kernel/integrity.ts";
import { HarnessError, extractErrorMessage } from "../../src/kernel/errors.ts";
import { hasSecondName } from "../../src/filesystem/link-containment.ts";
import { pinnedPathIdentityHash } from "../../src/filesystem/pinned-path-internal.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { VERSIONED_IGNORE_RULES } from "../../src/git/repository-ownership.ts";
import {
  candidateFormatForBytes,
  candidateFormatErrorViolations,
  candidateFormatPolicyHash,
  candidatePathRejectedWithoutContentRead,
  candidatePathViolations,
  rejectedCandidatePathViolation,
  createCandidateFormatError,
  strictUtf8Text,
  type ImmutableTextSourceException,
} from "../verification/candidate-format.ts";
import { probeRepositoryGit, repositoryTreeEntries, fileGitMode, gitBlobObjectId } from "./repository-git.ts";
import { parseIndexRecords } from "../../src/git/index-entries.ts";
import { parseS2OfficialFragmentManifestText } from "../verification/official-fragment-manifest.ts";
import {
  rawSafeRepositoryRootAccess,
  readSafeRepositoryFile,
  safeRepositoryEntryStatus,
  safeRepositoryRootPathForInternalUse,
  type SafeRepositoryReadHooks,
  type SafeRepositoryRootAccessInput,
} from "../verification/safe-repository-reader.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

type GitMode = "100644" | "100755";

export const CANDIDATE_MANIFEST_SCHEMA_VERSION = "bridlewise-candidate-manifest/v2" as const;

export type CandidateFile = Readonly<{
  path: string;
  type: "file";
  mode: GitMode;
  bytes: number;
  sha256: string;
  format: "binary-exempt" | "canonical-text" | "immutable-source-text-exempt";
  formatAuthority?: ImmutableTextSourceException;
}>;

export type CandidateDeletion = Readonly<{
  path: string;
  baseMode: string;
  baseObjectId: string;
}>;

export type CandidateWorkspaceEntry = Readonly<{
  path: string;
  head: Readonly<{ mode: string; objectId: string }> | null;
  index: Readonly<{ mode: string; objectId: string }> | null;
  worktree: Readonly<{ mode: GitMode; bytes: number; sha256: string; objectId: string }> | null;
  states: readonly string[];
}>;

export type CandidateManifest = Readonly<{
  schemaVersion: typeof CANDIDATE_MANIFEST_SCHEMA_VERSION;
  command: "node scripts/candidate-manifest.ts --root .";
  hashAlgorithm: "sha256-canonical-json";
  gitObjectFormat: "sha1" | "sha256";
  baseCommit: string;
  baseTree: string;
  indexIdentity: Readonly<{
    entriesHash: string;
    fileBytes: number;
    fileSha256: string;
    resolvedPathSha256: string;
  }>;
  formatPolicy: Readonly<{
    revision: typeof ROOT_POLICY.verification.candidateFormat.revision;
    sha256: string;
  }>;
  files: readonly CandidateFile[];
  deletions: readonly CandidateDeletion[];
  semanticTreeHash: string;
  formatVerificationHash: string;
  workspace: Readonly<{
    headReference: string;
    entries: readonly CandidateWorkspaceEntry[];
    indexWorktree: "different" | "equal";
    stateHash: string;
  }>;
  publication: Readonly<{
    eligibility: "blocked-index-worktree-drift" | "ready";
    checkpointPrerequisiteHash: string | null;
  }>;
}>;

export type CandidateTestIdentity = Readonly<{
  manifestSchemaVersion: typeof CANDIDATE_MANIFEST_SCHEMA_VERSION;
  formatPolicyRevision: typeof ROOT_POLICY.verification.candidateFormat.revision;
  semanticTreeHash: string;
  formatVerificationHash: string;
}>;

type GitTreeEntry = Readonly<{ path: string; mode: string; objectId: string }>;
type WorktreeIdentity = Readonly<{ mode: GitMode; bytes: number; sha256: string; objectId: string }>;

/**
 * Stat-level identity (device/inode/size/mtime/ctime/…) of every file in
 * the built manifest, captured from the same safe reads that produced the
 * content digests. Enables cheap change detection: a file whose stat
 * identity is unchanged cannot have been rewritten by any non-root process
 * (ctime cannot be forged), so its recorded hashes can be reused without a
 * re-read.
 */
export type CandidateManifestBuild = Readonly<{
  manifest: CandidateManifest;
  fileIdentities: ReadonlyMap<string, string>;
  /**
   * Paths that the enumeration listed and that were GONE by the time the
   * build read them — a concurrent writer removed them mid-scan. They are not
   * in the manifest, because a file that is no longer there was never part of
   * this snapshot. Recorded rather than dropped silently: the count is the
   * measure of how much the tree moved under the build, and a caller that
   * expects a quiet tree can refuse on it.
   */
  vanishedPaths: readonly string[];
}>;

export function buildCandidateManifest(access: SafeRepositoryRootAccessInput): CandidateManifest {
  return buildCandidateManifestDetailed(access).manifest;
}

/**
 * @param readHooks the safe reader's existing observation hooks, forwarded to
 * the per-file read. Production passes nothing. It is threaded here rather
 * than invented because the reader ALREADY owns this seam
 * (`SafeRepositoryReadHooks`) for exactly one purpose: making a
 * time-of-check/time-of-use window drivable instead of hoping to hit it. The
 * removal-during-scan branch below is otherwise unreachable from outside the
 * process — the window is between two synchronous calls — and a branch nothing
 * can drive is a branch nobody can prove.
 */
export function buildCandidateManifestDetailed(
  access: SafeRepositoryRootAccessInput,
  readHooks: SafeRepositoryReadHooks = {},
): CandidateManifestBuild {
  const candidateRoot = safeRepositoryRootPathForInternalUse(access);
  const root = realpathSync(resolve(candidateRoot));
  const gitRoot = realpathSync(gitText(root, ["rev-parse", "--show-toplevel"]));
  // RE-DERIVED AT THE MONOREPO ASSEMBLY (2026-07-30). This required
  // `root === gitRoot`, which was the right question while this package was
  // its own repository: it made sure the git facts below describe the tree
  // `root` names. `engine/` is now a subdirectory of a larger repository, and
  // the equality refused the real tree outright — the whole suite stopped.
  //
  // The question it was asking is still asked, by a different fact: git scopes
  // `ls-tree -r HEAD`, `ls-files` and `diff-index` to the CWD PREFIX and
  // returns paths relative to it, so every entry below already describes this
  // subtree and nothing above it. Measured on the assembled tree: 2,060 from
  // `ls-tree -r HEAD` and 2,060 from `ls-files`, both engine-relative, against
  // 3,222 tracked in the repository. What must not happen is `root` sitting
  // OUTSIDE the worktree the queries answer about, so that is what is checked.
  if (root !== gitRoot && !root.startsWith(`${gitRoot}/`)) {
    throw new Error("candidate root must be inside the Git worktree it is measured against");
  }
  const gitObjectFormat = parseGitObjectFormat(gitText(root, ["rev-parse", "--show-object-format"]));
  const baseCommit = gitText(root, ["rev-parse", "HEAD"]);
  const baseTree = gitText(root, ["rev-parse", "HEAD^{tree}"]);
  const headReference = gitOptionalText(root, ["symbolic-ref", "-q", "HEAD"]) ?? "detached";
  const headEntries = gitTreeEntries(root);
  const indexEntries = gitIndexEntries(root);
  const indexIdentity = readIndexIdentity(root, indexEntries);
  const currentPaths = candidateCurrentPaths(root, access);
  const pathViolations = [...new Set([
    ...currentPaths,
    ...headEntries.map((entry) => entry.path),
    ...indexEntries.map((entry) => entry.path),
  ].flatMap((path) => candidatePathViolations(path)))];
  pathViolations.push(...portableCollisionViolations(currentPaths));
  for (const path of currentPaths) {
    if (candidatePathRejectedWithoutContentRead(path)) {
      pathViolations.push(rejectedCandidatePathViolation(path));
    }
  }
  pathViolations.push(...unsupportedGitStateViolations(root, currentPaths, indexEntries));
  if (pathViolations.length > 0) throw createCandidateFormatError(pathViolations);

  const headByPath = uniqueEntryMap(headEntries, "HEAD");
  const indexByPath = uniqueEntryMap(indexEntries, "index");
  const immutableSources = loadImmutableSourceExceptions(access, headByPath, gitObjectFormat, currentPaths);
  const worktreeByPath = new Map<string, WorktreeIdentity>();
  const fileIdentities = new Map<string, string>();
  const violations: string[] = [];
  const files: CandidateFile[] = [];
  const vanishedPaths: string[] = [];
  for (const path of currentPaths) {
    const entry = readCandidateFileEntry(access, path, immutableSources.get(path), gitObjectFormat, readHooks);
    // A path that disappeared between the existence filter above and this read
    // is DROPPED, exactly as the filter would have dropped it a moment later.
    // Refusing instead made a concurrent writer's temporary file into a format
    // violation of this repository — a verdict about someone else's tree.
    if (entry.vanished === true) {
      vanishedPaths.push(path);
      continue;
    }
    violations.push(...entry.violations);
    if (entry.file !== undefined && entry.worktree !== undefined && entry.identityHash !== undefined) {
      worktreeByPath.set(path, entry.worktree);
      fileIdentities.set(path, entry.identityHash);
      files.push(entry.file);
    }
  }
  if (violations.length > 0) throw createCandidateFormatError(violations);

  const orderedFiles = files.toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const allWorkspacePaths = [...new Set([
    ...headByPath.keys(), ...indexByPath.keys(), ...worktreeByPath.keys(),
  ])].toSorted();
  const workspaceEntries = allWorkspacePaths.map((path) => workspaceEntry(
    path,
    headByPath.get(path),
    indexByPath.get(path),
    worktreeByPath.get(path),
  ));
  const deletions = allWorkspacePaths.filter((path) =>
    headByPath.has(path) && !worktreeByPath.has(path)
  ).map((path): CandidateDeletion => {
    const head = headByPath.get(path)!;
    return deepFreeze({ path, baseMode: head.mode, baseObjectId: head.objectId });
  });
  const semanticTreeHash = canonicalHash({
    domain: "candidate-semantic-tree/v1",
    files: orderedFiles.map((file) => ({
      path: file.path,
      type: file.type,
      mode: file.mode,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  });
  const formatPolicy = deepFreeze({
    revision: ROOT_POLICY.verification.candidateFormat.revision,
    sha256: candidateFormatPolicyHash(),
  });
  const formatVerificationHash = canonicalHash({
    domain: "candidate-format-verification/v1",
    policy: formatPolicy,
    outcomes: orderedFiles.map((file) => ({
      path: file.path,
      classification: file.format,
      ...(file.formatAuthority === undefined ? {} : { authority: file.formatAuthority }),
    })),
  });
  const indexWorktree = indexWorktreeEqual(indexByPath, worktreeByPath) ? "equal" : "different";
  const workspaceState = {
    domain: "candidate-workspace-state/v1",
    baseCommit,
    baseTree,
    headReference,
    indexIdentity,
    gitObjectFormat,
    entries: workspaceEntries,
  };
  const stateHash = canonicalHash(workspaceState);
  const eligibility = indexWorktree === "equal" ? "ready" : "blocked-index-worktree-drift";
  const checkpointPrerequisiteHash = eligibility === "ready" ? canonicalHash({
    domain: "candidate-checkpoint-prerequisite/v1",
    semanticTreeHash,
    formatVerificationHash,
    workspaceStateHash: stateHash,
    baseCommit,
    baseTree,
    indexIdentity,
  }) : null;
  // THE TWO HALVES OF THE ENUMERATION MUST AGREE ON WHAT VANISHED.
  //
  // `verifySnapshotUnchanged` re-lists the tree and compares the list against
  // the one this build started from. A path dropped above but left in the
  // snapshot would make those two lists differ by exactly that path, so the
  // refusal would simply move from `candidate-entry-unreadable` to
  // `candidate-changed-during-verification` and the race would be renamed
  // rather than fixed. The snapshot is therefore the set the manifest was
  // actually built from.
  const scannedPaths = vanishedPaths.length === 0
    ? currentPaths
    : currentPaths.filter((path) => !vanishedPaths.includes(path));
  verifySnapshotUnchanged(access, {
    baseCommit,
    baseTree,
    headReference,
    indexIdentity,
    currentPaths: scannedPaths,
    indexEntries,
    worktreeByPath,
    fileIdentities,
    gitObjectFormat,
  });
  const manifest: CandidateManifest = deepFreeze({
    schemaVersion: CANDIDATE_MANIFEST_SCHEMA_VERSION,
    command: "node scripts/candidate-manifest.ts --root .",
    hashAlgorithm: "sha256-canonical-json",
    gitObjectFormat,
    baseCommit,
    baseTree,
    indexIdentity,
    formatPolicy,
    files: orderedFiles,
    deletions,
    semanticTreeHash,
    formatVerificationHash,
    workspace: { headReference, entries: workspaceEntries, indexWorktree, stateHash },
    publication: { eligibility, checkpointPrerequisiteHash },
  });
  return deepFreeze({ manifest, fileIdentities, vanishedPaths: [...vanishedPaths].toSorted() });
}

/**
 * Read and classify one candidate file. Shared by the initial manifest
 * build and the stat-delta refresh so both paths apply identical read,
 * LFS-pointer, mode-normalization, digest, and format-classification rules.
 * A `file`/`worktree`/`identityHash` triple is produced only when the file
 * passed every content-level check; violations are accumulated by the
 * caller exactly as the original inline loop did.
 */
function readCandidateFileEntry(
  access: SafeRepositoryRootAccessInput,
  path: string,
  immutableException: ImmutableTextSourceException | undefined,
  gitObjectFormat: "sha1" | "sha256",
  readHooks: SafeRepositoryReadHooks = {},
): Readonly<{
  file?: CandidateFile;
  worktree?: WorktreeIdentity;
  identityHash?: string;
  /**
   * The path passed the enumeration's existence filter and was GONE by the
   * time this function read it. Reported as its own outcome rather than as a
   * violation — see the note at the enumeration.
   */
  vanished?: true;
  violations: string[];
}> {
  let read;
  try {
    read = readSafeRepositoryFile(
      access,
      path,
      ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
      readHooks,
    );
  } catch (error) {
    // ── ENUMERATE-THEN-READ OVER A LIVE TREE, AND THE ONE OUTCOME THAT IS
    //    NOT A FORMAT VIOLATION ───────────────────────────────────────────
    //
    // The caller lists paths, filters them by existence, and reads them in a
    // loop that takes seconds over ~2,000 files. Between the filter and the
    // read, ANY concurrent writer can remove a path — a parallel test's
    // temporary file, an editor, a build. The read then failed with
    // `candidate-entry-unreadable:<path>` and the whole manifest was refused.
    //
    // Measured: one run in six of the full suite, always naming a file that
    // belonged to an unrelated test. That is not a statement about the
    // candidate's FORMAT, which is what this function's other outcomes are;
    // it is the tree having moved under the enumeration, and the honest answer
    // is that a file which is no longer there is not part of the snapshot.
    //
    // Reported separately from `violations` so the caller decides, and so
    // "vanished" can never be silently produced by any of the format checks
    // below. The existence filter at the enumeration keeps its meaning: this
    // is the same verdict it would have reached a moment later.
    if (error instanceof Error && "code" in error && error.code === "safe_path_missing") {
      return { vanished: true, violations: [] };
    }
    return { violations: [candidateSafeReadViolation(error, path)] };
  }
  const bytes = read.bytes;
  if (bytes.subarray(0, 43).toString("ascii") === "version https://git-lfs.github.com/spec/v1\n") {
    return { violations: [`candidate-lfs-pointer-unqualified:${safePathLabel(path)}`] };
  }
  const mode = fileGitMode(read.mode);
  const digest = sha256(bytes);
  const objectId = gitBlobObjectId(bytes, gitObjectFormat);
  const format = candidateFormatForBytes(path, bytes, immutableException);
  return {
    file: deepFreeze({
      path,
      type: "file",
      mode,
      bytes: bytes.length,
      sha256: digest,
      format: format.classification,
      ...(format.exception === undefined ? {} : { formatAuthority: format.exception }),
    }),
    worktree: deepFreeze({ mode, bytes: bytes.length, sha256: digest, objectId }),
    identityHash: read.identityHash,
    violations: [...format.violations],
  };
}

export function candidateTestIdentity(manifest: CandidateManifest): CandidateTestIdentity {
  return deepFreeze({
    manifestSchemaVersion: manifest.schemaVersion,
    formatPolicyRevision: manifest.formatPolicy.revision,
    semanticTreeHash: manifest.semanticTreeHash,
    formatVerificationHash: manifest.formatVerificationHash,
  });
}

/**
 * Compute a {@link CandidateTestIdentity} excluding runner-written artifacts.
 *
 * The test runner itself writes a known set of tracked files during a test run
 * (the test inventory, root-policy hash bindings, the architecture manifest).
 * The candidate-identity check compares the worktree before and after the test
 * run; without exclusions, these legitimate runner writes fire a false
 * `candidate-identity-changed`. This function recomputes the semantic tree
 * hash and format verification hash over the manifest's files MINUS the
 * excluded paths, so only external/unexpected changes are detected.
 */
export function candidateTestIdentityExcluding(
  manifest: CandidateManifest,
  excludePaths: readonly string[],
): CandidateTestIdentity {
  const excludeSet = new Set(excludePaths);
  // Support prefix matching: paths ending with "*" match any file starting
  // with the prefix (without the "*"). This handles test-runner-created files
  // with unpredictable names (e.g., UUID-based foundation-cascade fixtures).
  const excludePrefixes = excludePaths
    .filter((p) => p.endsWith("*"))
    .map((p) => p.slice(0, -1));
  const filtered = manifest.files
    .filter((file) =>
      !excludeSet.has(file.path) &&
      !excludePrefixes.some((prefix) => file.path.startsWith(prefix))
    )
    .toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const semanticTreeHash = canonicalHash({
    domain: "candidate-semantic-tree/v1",
    files: filtered.map((file) => ({
      path: file.path,
      type: file.type,
      mode: file.mode,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  });
  const formatVerificationHash = canonicalHash({
    domain: "candidate-format-verification/v1",
    policy: manifest.formatPolicy,
    outcomes: filtered.map((file) => ({
      path: file.path,
      classification: file.format,
      ...(file.formatAuthority === undefined ? {} : { authority: file.formatAuthority }),
    })),
  });
  return deepFreeze({
    manifestSchemaVersion: manifest.schemaVersion,
    formatPolicyRevision: manifest.formatPolicy.revision,
    semanticTreeHash,
    formatVerificationHash,
  });
}

function gitTreeEntries(root: string): readonly GitTreeEntry[] {
  let entries: ReturnType<typeof repositoryTreeEntries>;
  try { entries = repositoryTreeEntries(root); }
  catch (error) {
    if (error instanceof HarnessError && error.code === "repository_git_utf8_invalid") throw createCandidateFormatError(["candidate-git-path-invalid-utf8:ls-tree"]);
    if (error instanceof HarnessError && error.code === "repository_git_failed") {
      const { operation, stderrBytes, stderrSha256 } = error.safeDetails;
      throw createCandidateFormatError([Number(stderrBytes) > 0
        ? `candidate-git-probe-stderr:${operation}:sha256-${stderrSha256}:bytes-${stderrBytes}`
        : `candidate-git-probe-failed:${operation}`]);
    }
    if (error instanceof HarnessError) throw createCandidateFormatError([`candidate-git-tree-invalid:${error.code}`]);
    throw error;
  }
  return entries.map((entry) => {
    if (entry.kind !== "blob") throw createCandidateFormatError(["candidate-submodule-or-gitlink-rejected"]);
    return deepFreeze({ mode: entry.mode, objectId: entry.objectId, path: entry.path });
  });
}

function gitIndexEntries(root: string): readonly GitTreeEntry[] {
  return parseIndexRecords(gitRecords(root, ["ls-files", "--stage"])).map((entry) => {
    if (entry.stage !== 0) throw createCandidateFormatError(["candidate-unmerged-index-rejected"]);
    if (/^0+$/u.test(entry.objectId)) throw createCandidateFormatError(["candidate-intent-to-add-rejected"]);
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw createCandidateFormatError([`candidate-index-mode-rejected:${entry.mode}`]);
    }
    return deepFreeze({ mode: entry.mode, objectId: entry.objectId, path: entry.path });
  });
}

function unsupportedGitStateViolations(
  root: string,
  currentPaths: readonly string[],
  indexEntries: readonly GitTreeEntry[],
): readonly string[] {
  const violations: string[] = [];
  if (gitOptionalText(root, ["config", "--bool", "core.sparseCheckout"]) === "true") {
    violations.push("candidate-sparse-checkout-unqualified");
  }
  if (currentPaths.includes(".gitattributes")) violations.push("candidate-git-attributes-unqualified");
  const indexPaths = new Set(indexEntries.map((entry) => entry.path));
  for (const record of gitRecords(root, ["status", "--porcelain=v2", "--untracked-files=all"])) {
    const intent = /^1\s+[^ ]+\s+[^ ]+\s+[^ ]+\s+000000\s+[^ ]+\s+[^ ]+\s+[^ ]+\s+([\s\S]+)$/u.exec(record);
    if (intent?.[1] !== undefined && indexPaths.has(intent[1])) {
      violations.push(`candidate-intent-to-add-rejected:${safePathLabel(intent[1])}`);
    }
  }
  for (const record of gitRecords(root, ["ls-files", "-v"])) {
    const match = /^([^ ])\s([\s\S]+)$/u.exec(record);
    if (!match?.[1] || match[2] === undefined || !indexPaths.has(match[2])) continue;
    if (match[1] === "S") violations.push(`candidate-skip-worktree-rejected:${safePathLabel(match[2])}`);
    if (match[1] === match[1].toLowerCase()) {
      violations.push(`candidate-assume-unchanged-rejected:${safePathLabel(match[2])}`);
    }
  }
  return deepFreeze(violations.toSorted());
}

function loadImmutableSourceExceptions(
  access: SafeRepositoryRootAccessInput,
  headByPath: ReadonlyMap<string, GitTreeEntry>,
  gitObjectFormat: "sha1" | "sha256",
  currentPaths: readonly string[],
): ReadonlyMap<string, ImmutableTextSourceException> {
  const output = new Map<string, ImmutableTextSourceException>();
  const current = new Set(currentPaths);
  for (const authorityPath of ROOT_POLICY.verification.candidateFormat
    .immutableTextSourceExceptions.authorityManifests) {
    const head = headByPath.get(authorityPath);
    if (head === undefined || !current.has(authorityPath)) continue;
    let bytes: Buffer;
    try {
      bytes = readSafeRepositoryFile(access, authorityPath, 65_536).bytes;
    } catch (error) {
      throw createCandidateFormatError([candidateSafeReadViolation(error, authorityPath)]);
    }
    if (gitBlobObjectId(bytes, gitObjectFormat) !== head.objectId) continue;
    const manifest = parseS2OfficialFragmentManifestText(strictUtf8Text(bytes));
    const authoritySha256 = sha256(bytes);
    for (const source of manifest.sources) {
      for (const fragment of source.fragments) {
        if (output.has(fragment.path)) throw new Error("immutable source fragment path is duplicated");
        output.set(fragment.path, deepFreeze({
          path: fragment.path,
          sha256: fragment.sha256,
          authorityPath,
          authoritySha256,
          role: ROOT_POLICY.verification.candidateFormat.immutableTextSourceExceptions.authorityRole,
        }));
      }
    }
  }
  return output;
}

function workspaceEntry(
  path: string,
  head: GitTreeEntry | undefined,
  index: GitTreeEntry | undefined,
  worktree: WorktreeIdentity | undefined,
): CandidateWorkspaceEntry {
  const states: string[] = [];
  if (head === undefined && index === undefined && worktree !== undefined) states.push("untracked");
  if (head === undefined && index !== undefined) states.push("added-to-index");
  if (head !== undefined && index === undefined) states.push("deleted-from-index");
  if (head !== undefined && index !== undefined &&
    (head.mode !== index.mode || head.objectId !== index.objectId)) states.push("staged-change");
  if (index !== undefined && worktree === undefined) states.push("deleted-from-worktree");
  if (index !== undefined && worktree !== undefined &&
    (index.mode !== worktree.mode || index.objectId !== worktree.objectId)) states.push("unstaged-change");
  if (head !== undefined && index !== undefined && worktree !== undefined && states.length === 0) states.push("clean");
  return deepFreeze({ path, head: head ?? null, index: index ?? null, worktree: worktree ?? null, states });
}

function indexWorktreeEqual(
  indexByPath: ReadonlyMap<string, GitTreeEntry>,
  worktreeByPath: ReadonlyMap<string, WorktreeIdentity>,
): boolean {
  if (indexByPath.size !== worktreeByPath.size) return false;
  for (const [path, worktree] of worktreeByPath) {
    const index = indexByPath.get(path);
    if (index === undefined || index.mode !== worktree.mode || index.objectId !== worktree.objectId) return false;
  }
  return true;
}

/**
 * Deterministic subset of paths that receive a full safe re-read during
 * change verification. The stat-identity pass covers every file; the
 * sampled re-read additionally verifies content digests for a bounded
 * subset (stride over the sorted path list) so the verification cost stays
 * constant instead of scaling with repository size.
 */
const VERIFICATION_SAMPLE_LIMIT = 64;

function sampledVerificationPaths(paths: readonly string[]): ReadonlySet<string> {
  const stride = Math.max(1, Math.ceil(paths.length / VERIFICATION_SAMPLE_LIMIT));
  return new Set(paths.filter((_, index) => index % stride === 0));
}

/**
 * Cheap stat-level identity for a previously validated candidate file, or
 * `undefined` when the path no longer stats as a plain file. Computed from
 * the same stat fields the safe reader hashes, so it is directly comparable
 * to the identityHash recorded during the initial safe read.
 */
function statIdentityHash(root: string, path: string): string | undefined {
  try {
    const stats = lstatSync(join(root, path), { bigint: true });
    if (!stats.isFile()) return undefined;
    return pinnedPathIdentityHash(stats);
  } catch {
    return undefined;
  }
}

function verifySnapshotUnchanged(access: SafeRepositoryRootAccessInput, snapshot: Readonly<{
  baseCommit: string;
  baseTree: string;
  headReference: string;
  indexIdentity: CandidateManifest["indexIdentity"];
  currentPaths: readonly string[];
  indexEntries: readonly GitTreeEntry[];
  worktreeByPath: ReadonlyMap<string, WorktreeIdentity>;
  fileIdentities: ReadonlyMap<string, string>;
  gitObjectFormat: "sha1" | "sha256";
}>): void {
  const root = safeRepositoryRootPathForInternalUse(access);
  const currentPaths = candidateCurrentPaths(root, access);
  const indexEntries = gitIndexEntries(root);
  if (gitText(root, ["rev-parse", "HEAD"]) !== snapshot.baseCommit ||
    gitText(root, ["rev-parse", "HEAD^{tree}"]) !== snapshot.baseTree ||
    (gitOptionalText(root, ["symbolic-ref", "-q", "HEAD"]) ?? "detached") !== snapshot.headReference ||
    canonicalHash(readIndexIdentity(root, indexEntries)) !== canonicalHash(snapshot.indexIdentity) ||
    canonicalHash(currentPaths) !== canonicalHash(snapshot.currentPaths) ||
    canonicalHash(indexEntries) !== canonicalHash(snapshot.indexEntries)) {
    throw createCandidateFormatError(["candidate-changed-during-verification"]);
  }
  const sampled = sampledVerificationPaths([...snapshot.worktreeByPath.keys()]);
  for (const [path, expected] of snapshot.worktreeByPath) {
    // Cheap gate: an unchanged stat identity proves the file was not
    // rewritten since its safe read. Only stat-different files and the
    // deterministic sample pay for a full safe re-read and digest compare.
    if (statIdentityHash(root, path) === snapshot.fileIdentities.get(path) && !sampled.has(path)) {
      continue;
    }
    let read;
    try {
      read = readSafeRepositoryFile(
        access,
        path,
        ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
      );
    } catch {
      throw createCandidateFormatError(["candidate-changed-during-verification"]);
    }
    if (fileGitMode(read.mode) !== expected.mode || read.bytes.length !== expected.bytes ||
      sha256(read.bytes) !== expected.sha256 ||
      gitBlobObjectId(read.bytes, snapshot.gitObjectFormat) !== expected.objectId) {
      throw createCandidateFormatError(["candidate-changed-during-verification"]);
    }
  }
}

/**
 * Re-derive the candidate test identity after a test run without a second
 * full 1,000+-file read+hash pass. Reuses the before-run build: Git
 * structural state (commit, tree, ref, index) is re-probed, the retained
 * (non-excluded) path set is re-listed, and only files whose stat identity
 * changed are re-read and re-hashed. Any structural drift falls back to a
 * full rebuild so correctness never depends on the delta path being right.
 */
export function refreshCandidateTestIdentityExcluding(
  access: SafeRepositoryRootAccessInput,
  previous: CandidateManifestBuild,
  excludePaths: readonly string[],
): CandidateTestIdentity {
  const root = realpathSync(safeRepositoryRootPathForInternalUse(access));
  const fullRebuild = (): CandidateTestIdentity =>
    candidateTestIdentityExcluding(buildCandidateManifest(access), excludePaths);
  const manifest = previous.manifest;
  if (gitText(root, ["rev-parse", "HEAD"]) !== manifest.baseCommit ||
    gitText(root, ["rev-parse", "HEAD^{tree}"]) !== manifest.baseTree ||
    (gitOptionalText(root, ["symbolic-ref", "-q", "HEAD"]) ?? "detached") !== manifest.workspace.headReference) {
    return fullRebuild();
  }
  const indexEntries = gitIndexEntries(root);
  if (canonicalHash(readIndexIdentity(root, indexEntries)) !== canonicalHash(manifest.indexIdentity)) {
    return fullRebuild();
  }
  const excludeSet = new Set(excludePaths);
  const excludePrefixes = excludePaths.filter((path) => path.endsWith("*")).map((path) => path.slice(0, -1));
  const isExcluded = (path: string): boolean =>
    excludeSet.has(path) || excludePrefixes.some((prefix) => path.startsWith(prefix));
  const currentPaths = candidateCurrentPaths(root, access);
  const retainedPaths = currentPaths.filter((path) => !isExcluded(path));
  const previousRetainedPaths = manifest.files.map((file) => file.path).filter((path) => !isExcluded(path));
  if (canonicalHash(retainedPaths) !== canonicalHash(previousRetainedPaths)) return fullRebuild();

  const previousFilesByPath = new Map(manifest.files.map((file) => [file.path, file]));
  const changedPaths: string[] = [];
  const files: CandidateFile[] = [];
  for (const path of retainedPaths) {
    const previousFile = previousFilesByPath.get(path);
    if (previousFile !== undefined && statIdentityHash(root, path) === previous.fileIdentities.get(path)) {
      files.push(previousFile);
    } else {
      changedPaths.push(path);
    }
  }
  if (changedPaths.length > 0) {
    const headByPath = uniqueEntryMap(gitTreeEntries(root), "HEAD");
    const immutableSources = loadImmutableSourceExceptions(
      access,
      headByPath,
      manifest.gitObjectFormat,
      currentPaths,
    );
    const violations: string[] = [];
    for (const path of changedPaths) {
      const entry = readCandidateFileEntry(access, path, immutableSources.get(path), manifest.gitObjectFormat);
      // Same live-tree race as the initial build, and the same answer: a path
      // that disappeared between this function's existence filter and its read
      // is not a format violation. Here the delta's own precondition — that
      // the retained path set still matches the previous build's — has been
      // broken by the removal, so the honest move is the full rebuild this
      // function already falls back to for every other kind of structural
      // drift, rather than a manifest missing a file it claims to hold.
      if (entry.vanished === true) return fullRebuild();
      violations.push(...entry.violations);
      if (entry.file !== undefined) files.push(entry.file);
    }
    if (violations.length > 0) throw createCandidateFormatError(violations);
  }
  // Spot-check reused digests: a deterministic sample of the stat-unchanged
  // files is fully re-read so a forged-stat modification is still caught.
  const sampled = sampledVerificationPaths(retainedPaths.filter((path) => !changedPaths.includes(path)));
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  for (const path of sampled) {
    const expected = filesByPath.get(path);
    if (expected === undefined) return fullRebuild();
    let read;
    try {
      read = readSafeRepositoryFile(
        access,
        path,
        ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
      );
    } catch {
      return fullRebuild();
    }
    if (sha256(read.bytes) !== expected.sha256) return fullRebuild();
  }
  const orderedFiles = files.toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return candidateTestIdentityExcluding({ ...manifest, files: orderedFiles }, []);
}

function readIndexIdentity(
  root: string,
  entries: readonly GitTreeEntry[],
): CandidateManifest["indexIdentity"] {
  const gitDirectory = realpathSync(gitText(root, ["rev-parse", "--absolute-git-dir"]));
  const configuredPath = gitText(root, ["rev-parse", "--git-path", "index"]);
  const absolute = resolve(root, configuredPath);
  const unresolvedStats = lstatSync(absolute);
  if (unresolvedStats.isSymbolicLink()) {
    throw createCandidateFormatError(["candidate-index-file-identity-rejected"]);
  }
  const canonical = realpathSync(absolute);
  if (canonical !== gitDirectory && !canonical.startsWith(`${gitDirectory}${sep}`)) {
    throw createCandidateFormatError(["candidate-index-path-outside-worktree-git-directory"]);
  }
  const stats = lstatSync(canonical);
  if (!stats.isFile() || stats.isSymbolicLink() || hasSecondName(stats.nlink)) {
    throw createCandidateFormatError(["candidate-index-file-identity-rejected"]);
  }
  const bytes = readFileSync(canonical);
  return deepFreeze({
    entriesHash: canonicalHash({ domain: "candidate-index-entries/v1", entries }),
    fileBytes: bytes.length,
    fileSha256: sha256(bytes),
    resolvedPathSha256: sha256(canonical),
  });
}

function portableCollisionViolations(paths: readonly string[]): readonly string[] {
  const seen = new Map<string, string>();
  const violations: string[] = [];
  for (const path of paths) {
    const identity = path.normalize("NFC").toLowerCase();
    const prior = seen.get(identity);
    if (prior !== undefined && prior !== path) {
      violations.push(`candidate-portable-path-collision:${safePathLabel(prior)}:${safePathLabel(path)}`);
    } else {
      seen.set(identity, path);
    }
  }
  return deepFreeze(violations.toSorted());
}

function uniqueEntryMap(entries: readonly GitTreeEntry[], surface: string): Map<string, GitTreeEntry> {
  const output = new Map<string, GitTreeEntry>();
  for (const entry of entries) {
    if (output.has(entry.path)) throw new Error(`${surface} contains a duplicate path`);
    output.set(entry.path, entry);
  }
  return output;
}

function entryExists(access: SafeRepositoryRootAccessInput, path: string): boolean {
  return safeRepositoryEntryStatus(access, path).status !== "missing";
}

function candidateSafeReadViolation(error: unknown, path: string): string {
  const label = safePathLabel(path);
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") {
    return `candidate-entry-unreadable:${label}`;
  }
  const byCode: Readonly<Record<string, string>> = {
    safe_path_ancestor_symlink: "candidate-entry-ancestor-symlink-rejected",
    safe_path_ancestor_unsafe: "candidate-entry-ancestor-unsafe-rejected",
    safe_path_boundary: "candidate-entry-boundary-rejected",
    safe_path_hardlink: "candidate-entry-hardlink-rejected",
    safe_path_identity_changed: "candidate-entry-changed-during-read",
    safe_path_special: "candidate-entry-special-rejected",
    safe_path_symlink: "candidate-entry-symlink-rejected",
    safe_path_too_large: "candidate-entry-too-large",
  };
  return `${byCode[error.code] ?? "candidate-entry-unreadable"}:${label}`;
}

function parseGitObjectFormat(value: string): "sha1" | "sha256" {
  if (value !== "sha1" && value !== "sha256") throw new Error("unsupported Git object format");
  return value;
}

function gitText(root: string, args: readonly string[]): string {
  const result = git(root, args);
  return strictUtf8Text(result.stdout).trim();
}

function gitOptionalText(root: string, args: readonly string[]): string | undefined {
  const result = runGitProbe(root, args, [0, 1]);
  if (result.status === 1) return undefined;
  return strictUtf8Text(result.stdout).trim();
}

function gitPaths(root: string, args: readonly string[]): string[] {
  return splitNul(git(root, [...args, "-z"]).stdout).map((record) => decodeGitPath(record, args[0]));
}

/**
 * THE CANDIDATE POPULATION, ONE ANSWER — the three enumerations below (the
 * builder, the changed-during-verification check and the incremental
 * rebuild) must agree on what is a candidate, so the question is asked
 * once: every path the repository owns under the root that exists, but the
 * declared frozen record trees (`candidateFormat.recordRoots`: history kept
 * as measured — the governed-artifact census would reject a preserved binary
 * fixture there that it admits under its product spelling).
 */
function candidateCurrentPaths(root: string, access: SafeRepositoryRootAccessInput): readonly string[] {
  const { recordRoots } = ROOT_POLICY.verification.candidateFormat;
  return gitPaths(root, ["ls-files", "--cached", "--others", VERSIONED_IGNORE_RULES])
    .filter((path) => !recordRoots.some((record) => path.startsWith(record)))
    .filter((path) => entryExists(access, path))
    .toSorted();
}

function gitRecords(root: string, args: readonly string[]): string[] {
  return splitNul(git(root, [...args, "-z"]).stdout).map((record) => {
    try {
      return strictUtf8Text(record);
    } catch {
      throw createCandidateFormatError([`candidate-git-path-invalid-utf8:${args[0] ?? "command"}`]);
    }
  });
}

function decodeGitPath(record: Uint8Array, command: string | undefined): string {
  try {
    return strictUtf8Text(record);
  } catch {
    throw createCandidateFormatError([`candidate-git-path-invalid-utf8:${command ?? "command"}`]);
  }
}

function splitNul(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      if (index > start) records.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== bytes.length) throw new Error("Git NUL-delimited output is unterminated");
  return records;
}

function git(root: string, args: readonly string[]): Readonly<{ stdout: Buffer }> {
  const result = runGitProbe(root, args, [0]);
  return { stdout: result.stdout };
}

function runGitProbe(
  root: string,
  args: readonly string[],
  allowedStatuses: readonly number[],
): Readonly<{ status: number; stdout: Buffer }> {
  const result = probeRepositoryGit(root, args);
  const command = args[0] ?? "command";
  if (result.stderr.length > 0) {
    throw createCandidateFormatError([
      `candidate-git-probe-stderr:${command}:sha256-${sha256(result.stderr)}:bytes-${result.stderr.length}`,
    ]);
  }
  if (result.status === null || !allowedStatuses.includes(result.status)) {
    throw createCandidateFormatError([`candidate-git-probe-failed:${command}`]);
  }
  return { status: result.status, stdout: result.stdout };
}

function safePathLabel(path: string): string {
  try {
    return encodeURIComponent(path);
  } catch {
    return `sha256-${canonicalHash({ path })}`;
  }
}

/**
 * `--root .` prints the manifest, or a refusal (its violations) on stderr and
 * exit 1. `--root . --verdict` answers only whether the engine runner would
 * accept the tree, the question `harness check`'s candidate-format step asks:
 * `{"accepted":true,"files":N}`, or `{"accepted":false,"violations":[…]}` and
 * exit 1 — on stdout either way, since the verdict IS the answer.
 */
function parseArguments(argv: readonly string[]): Readonly<{ root: string; verdict: boolean }> {
  const verdict = argv.length === 3 && argv[2] === "--verdict";
  if ((argv.length !== 2 && !verdict) || argv[0] !== "--root" || argv[1] !== ".") {
    throw new Error("Usage: candidate-manifest --root . [--verdict]");
  }
  return { root: resolve(argv[1]), verdict };
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const { root, verdict } = parseArguments(process.argv.slice(2));
  try {
    const manifest = buildCandidateManifest(rawSafeRepositoryRootAccess(root));
    process.stdout.write(`${canonicalJson(verdict ? { accepted: true, files: manifest.files.length } : manifest)}\n`);
  } catch (error) {
    const violations = candidateFormatErrorViolations(error) ?? ["candidate-manifest-unavailable"];
    if (verdict) process.stdout.write(`${canonicalJson({ accepted: false, violations, message: extractErrorMessage(error) })}\n`);
    else process.stderr.write(`${canonicalJson({
      error: "candidate_manifest_failed",
      violations,
      message: extractErrorMessage(error),
    })}\n`);
    process.exitCode = 1;
  }
}
