/**
 * THE PINNED CORPUS SUBSET: one owner of the manifest, the fetch, and the check.
 *
 * The suite measures real code at real scale — a parser against Babel, a walker
 * against Express — and the 4.1 GB `large-codebases` cache that carries it is
 * vendored, gitignored, and never published. That made the corpus an
 * unreproducible prerequisite: a fresh clone could not run the tests that read
 * it, and `required-fixture-roots.ts` could only tell a reader to copy the
 * cache from some other checkout.
 *
 * This module replaces that dead end with the smallest reproducible contract:
 *
 *   - `corpus-manifest.json` is GENERATED from the members the public tests
 *     actually read (lodash, express, babel/traverse), pinning each member's
 *     upstream, full commit, licence, and the size and sha256 of every file.
 *     It carries no corpus content, no absolute path, and no `.git` metadata.
 *   - `fetch` materialises exactly those files from the pinned commits with a
 *     blobless partial clone, verifies every size and hash, and links the
 *     result at `engine/large-codebases` (outside the repository, as the
 *     scanner guard requires).
 *   - `verify` is the one judgement of "the cache is what the manifest says";
 *     a mismatch names the path instead of letting a test read drifted bytes.
 *
 * WHY A SUBSET AND NOT THE CACHE. The cache is a mixed-licence assembly of
 * dozens of upstream checkouts, nested histories, duplicate trees and
 * test-only key/certificate/environment fixtures. Republishing it would
 * redistribute third-party code under incompatible terms and preserve
 * material a current-tree scan does not clear. The public tests read 56 files
 * from three permissively licensed members; that is what this pins.
 *
 * WHY THE MANIFEST IS GENERATED AND NEVER HAND-EDITED. A hand-typed hash is a
 * claim nobody re-derives, and a drifted corpus then fails a test with no
 * explanation. `manifest` reads the members read-only, hashes the BLOBS at the
 * pinned commit (not the working tree, which may carry local edits), and
 * writes the file atomically. `verify` recomputes the same digest, so editing
 * a hash by hand refuses instead of passing.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { ownedSiblingTemporaryName } from "../../src/filesystem/private-state.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

/** Repository-relative path the tests resolve the corpus at. */
export const CORPUS_ROOT = "engine/large-codebases";
/** The generated manifest, committed. */
export const MANIFEST_PATH = "engine/test/fixtures/corpus-manifest.json";
export const MANIFEST_SCHEMA = "bridlewise-corpus-manifest/v1";
/**
 * Bumped when the manifest's SHAPE changes. The fetch and verify paths refuse a
 * revision they do not know, so an old copy cannot be judged by new rules.
 */
export const GENERATOR_REVISION = "corpus-ts-1";

/** Licences the publisher has reviewed as permissive. A new member is a review, not a config edit. */
export const PERMITTED_LICENSES: readonly string[] = Object.freeze(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"]);

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..", "..");

export type CorpusFile = Readonly<{ path: string; sizeBytes: number; sha256: string }>;
export type CorpusMember = Readonly<{
  name: string;
  upstream: string;
  commit: string;
  license: string;
  files: readonly CorpusFile[];
}>;
export type CorpusDerived = Readonly<{
  path: string;
  member: string;
  source: string;
  sizeBytes: number;
  sha256: string;
}>;
export type CorpusManifest = Readonly<{
  schemaVersion: string;
  generatorRevision: string;
  root: string;
  members: readonly CorpusMember[];
  derived: readonly CorpusDerived[];
  notIncluded: string;
  manifestSha256: string;
}>;

export class CorpusError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CorpusError";
    this.code = code;
  }
}

function refuse(code: string, message: string): never {
  throw new CorpusError(code, message);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * A manifest path is repository-relative INSIDE the cache and must stay there:
 * no absolute path, no `..`, no backslash, no empty or `.` segment. The fetch
 * writes exactly this string under the cache, so a hostile manifest path would
 * be a write outside it.
 */
export function safeRelativePath(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length === 0) refuse("corpus_path_invalid", `${subject}: path must be a non-empty string`);
  if (isAbsolute(value)) refuse("corpus_path_invalid", `${subject}: path must be relative, got ${value}`);
  if (value.includes("\\")) refuse("corpus_path_invalid", `${subject}: path must use forward slashes, got ${value}`);
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      refuse("corpus_path_invalid", `${subject}: path has an empty, '.' or '..' segment: ${value}`);
    }
  }
  return value;
}

function positiveInteger(value: unknown, subject: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    refuse("corpus_size_invalid", `${subject}: sizeBytes must be a non-negative integer`);
  }
  return value;
}

function sha256Value(value: unknown, subject: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    refuse("corpus_hash_invalid", `${subject}: sha256 must be 64 lowercase hex characters`);
  }
  return value;
}

function commitValue(value: unknown, subject: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    refuse("corpus_commit_invalid", `${subject}: commit must be a full 40-character lowercase hex id`);
  }
  return value;
}

function publicUpstream(value: unknown, subject: string): string {
  if (typeof value !== "string" || !/^https:\/\/[^\s]+\.git$/.test(value)) {
    refuse("corpus_upstream_invalid", `${subject}: upstream must be an https git URL, got ${String(value)}`);
  }
  return value;
}

/**
 * The digest covers the manifest's MEANING, not its formatting: the schema,
 * revision, root, members (with every file), derived entries, and the
 * not-included statement. `manifestSha256` itself is excluded, or the digest
 * could never be computed.
 */
export function manifestPayload(manifest: Omit<CorpusManifest, "manifestSha256">): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    generatorRevision: manifest.generatorRevision,
    root: manifest.root,
    members: manifest.members.map((member) => ({
      name: member.name,
      upstream: member.upstream,
      commit: member.commit,
      license: member.license,
      files: member.files.map((file) => ({ path: file.path, sizeBytes: file.sizeBytes, sha256: file.sha256 })),
    })),
    derived: manifest.derived.map((entry) => ({
      path: entry.path,
      member: entry.member,
      source: entry.source,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    })),
    notIncluded: manifest.notIncluded,
  });
}

export function manifestDigest(manifest: Omit<CorpusManifest, "manifestSha256">): string {
  return sha256Hex(manifestPayload(manifest));
}

/** Validate a parsed manifest. Every refusal names the field and the reason. */
export function validateManifest(value: unknown): CorpusManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("corpus_manifest_invalid", "manifest must be a JSON object");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== MANIFEST_SCHEMA) {
    refuse("corpus_manifest_invalid", `manifest: expected schemaVersion ${MANIFEST_SCHEMA}, got ${String(raw.schemaVersion)}`);
  }
  if (raw.generatorRevision !== GENERATOR_REVISION) {
    refuse("corpus_manifest_invalid", `manifest: expected generatorRevision ${GENERATOR_REVISION}, got ${String(raw.generatorRevision)}`);
  }
  if (raw.root !== CORPUS_ROOT) refuse("corpus_manifest_invalid", `manifest: root must be ${CORPUS_ROOT}, got ${String(raw.root)}`);
  if (!Array.isArray(raw.members) || raw.members.length === 0) refuse("corpus_manifest_invalid", "manifest: members must be a non-empty array");
  if (!Array.isArray(raw.derived)) refuse("corpus_manifest_invalid", "manifest: derived must be an array");
  if (typeof raw.notIncluded !== "string" || raw.notIncluded.length < 20) {
    refuse("corpus_manifest_invalid", "manifest: notIncluded must state what is not published");
  }

  const names = new Set<string>();
  const members = raw.members.map((entry, index) => {
    const subject = `manifest member ${index}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) refuse("corpus_manifest_invalid", `${subject}: must be an object`);
    const member = entry as Record<string, unknown>;
    if (typeof member.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(member.name)) refuse("corpus_manifest_invalid", `${subject}: name must be a lowercase slug`);
    if (names.has(member.name)) refuse("corpus_manifest_invalid", `${subject}: duplicate member ${member.name}`);
    names.add(member.name);
    const license = String(member.license);
    if (!PERMITTED_LICENSES.includes(license)) {
      refuse("corpus_license_unreviewed", `${subject} (${member.name}): licence ${license} is not in the reviewed permissive set`);
    }
    if (!Array.isArray(member.files)) refuse("corpus_manifest_invalid", `${subject}: files must be an array`);
    const seen = new Set<string>();
    const files = member.files.map((file, fileIndex) => {
      const at = `${subject} (${member.name}) file ${fileIndex}`;
      if (file === null || typeof file !== "object" || Array.isArray(file)) refuse("corpus_manifest_invalid", `${at}: must be an object`);
      const record = file as Record<string, unknown>;
      const path = safeRelativePath(record.path, at);
      if (seen.has(path)) refuse("corpus_manifest_invalid", `${at}: duplicate path ${path}`);
      seen.add(path);
      return Object.freeze({ path, sizeBytes: positiveInteger(record.sizeBytes, at), sha256: sha256Value(record.sha256, at) });
    });
    const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return Object.freeze({
      name: member.name,
      upstream: publicUpstream(member.upstream, subject),
      commit: commitValue(member.commit, subject),
      license,
      files: Object.freeze(sorted),
    });
  });

  const derivedPaths = new Set<string>();
  const derived = raw.derived.map((entry, index) => {
    const subject = `manifest derived ${index}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) refuse("corpus_manifest_invalid", `${subject}: must be an object`);
    const record = entry as Record<string, unknown>;
    const path = safeRelativePath(record.path, subject);
    if (derivedPaths.has(path)) refuse("corpus_manifest_invalid", `${subject}: duplicate path ${path}`);
    derivedPaths.add(path);
    if (typeof record.member !== "string" || !names.has(record.member)) {
      refuse("corpus_manifest_invalid", `${subject}: member ${String(record.member)} is not a manifest member`);
    }
    // The source is read from the member's pinned commit, so it need not be one
    // of the member's allow-listed files (the scanner bait is exactly that case).
    const source = safeRelativePath(record.source, subject);
    return Object.freeze({
      path,
      member: record.member,
      source,
      sizeBytes: positiveInteger(record.sizeBytes, subject),
      sha256: sha256Value(record.sha256, subject),
    });
  });

  const payload = {
    schemaVersion: MANIFEST_SCHEMA,
    generatorRevision: GENERATOR_REVISION,
    root: CORPUS_ROOT,
    members,
    derived,
    notIncluded: raw.notIncluded,
  };
  const digest = manifestDigest(payload);
  if (sha256Value(raw.manifestSha256, "manifest") !== digest) {
    refuse("corpus_manifest_digest_mismatch", "manifest: manifestSha256 does not match its contents — regenerate it; do not edit a hash by hand");
  }
  return Object.freeze({ ...payload, manifestSha256: digest });
}

export function readManifest(path = join(REPOSITORY_ROOT, MANIFEST_PATH)): CorpusManifest {
  if (!existsSync(path)) refuse("corpus_manifest_absent", `corpus manifest is absent at ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    refuse("corpus_manifest_invalid", `corpus manifest is not valid JSON: ${(error as Error).message}`);
  }
  return validateManifest(parsed);
}

/** The cache root: outside every checkout, under the user's cache home by default. */
export function defaultCacheDir(manifest: CorpusManifest, base = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "bridlewise", "corpus")): string {
  return join(base, manifest.manifestSha256.slice(0, 12));
}

export type CorpusProblem = Readonly<{ path: string; reason: string }>;
export type CorpusVerdict = Readonly<{ ok: boolean; root: string | null; problems: readonly CorpusProblem[] }>;

function resolveRootOutsideRepository(repoRoot: string): string | null {
  const target = join(repoRoot, CORPUS_ROOT);
  if (!existsSync(target)) return null;
  const real = realpathSync(target);
  const inside = relative(repoRoot, real);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
    refuse("corpus_inside_tree", `${CORPUS_ROOT} resolves inside the repository (${real}); the corpus must live outside the tree`);
  }
  return real;
}

/**
 * Judge the cache against the manifest. Every mismatch is listed with the path
 * that carries it — a single "verification failed" hides which file drifted.
 */
export function verifyCorpus(repoRoot: string, manifest: CorpusManifest): CorpusVerdict {
  let root: string | null = null;
  try {
    root = resolveRootOutsideRepository(repoRoot);
  } catch (error) {
    return { ok: false, root: null, problems: [{ path: CORPUS_ROOT, reason: (error as CorpusError).message }] };
  }
  if (root === null) {
    return { ok: false, root: null, problems: [{ path: CORPUS_ROOT, reason: `absent — run npm run corpus:fetch` }] };
  }
  const problems = judgeCache(root, manifest);
  return { ok: problems.length === 0, root, problems };
}

/**
 * Judge one cache directory against the manifest. The root resolver decides
 * WHICH directory is the corpus; this is the one verifier, shared by `verify`
 * (over the declared root) and `fetch` (over the cache it is about to reuse).
 * Two verifiers would drift, and fetch would judge a fresh clone by a link it
 * has not created yet.
 */
function judgeCache(root: string, manifest: CorpusManifest): CorpusProblem[] {
  const problems: CorpusProblem[] = [];
  const readme = join(root, "README.md");
  if (!existsSync(readme)) problems.push({ path: "README.md", reason: "the cache must carry its generated README" });
  for (const member of manifest.members) {
    for (const file of member.files) {
      const target = join(root, member.name, file.path);
      if (!existsSync(target)) {
        problems.push({ path: `${member.name}/${file.path}`, reason: "missing" });
        continue;
      }
      const bytes = readFileSync(target);
      if (bytes.byteLength !== file.sizeBytes) {
        problems.push({ path: `${member.name}/${file.path}`, reason: `size ${bytes.byteLength} != manifest ${file.sizeBytes}` });
        continue;
      }
      if (sha256Hex(bytes) !== file.sha256) problems.push({ path: `${member.name}/${file.path}`, reason: "sha256 mismatch" });
    }
  }
  for (const entry of manifest.derived) {
    const target = join(root, entry.path);
    if (!existsSync(target)) {
      problems.push({ path: entry.path, reason: "missing" });
      continue;
    }
    const bytes = readFileSync(target);
    if (bytes.byteLength !== entry.sizeBytes || sha256Hex(bytes) !== entry.sha256) {
      problems.push({ path: entry.path, reason: "size or sha256 mismatch" });
    }
  }
  return problems;
}

/** The generated README: provenance, the digest, and the removal path. */
export function cacheReadme(manifest: CorpusManifest): string {
  const members = manifest.members.map((member) => `- \`${member.name}\` — ${member.upstream} @ ${member.commit} (${member.license})`).join("\n");
  return [
    "# Pinned corpus subset (generated)",
    "",
    `Manifest: \`${MANIFEST_PATH}\``,
    `Manifest digest: \`${manifest.manifestSha256}\``,
    "",
    "This directory is materialised by `npm run corpus:fetch` from the pinned members below.",
    "It holds only the files the public suite reads. Do not edit it: `npm run corpus:verify`",
    "refuses a file whose size or sha256 does not match the manifest. Re-run the fetch instead.",
    "",
    "## Members",
    "",
    members,
    "",
    "## Removing it",
    "",
    "`unlink engine/large-codebases` removes the link; this cache stays for reuse.",
    "",
  ].join("\n");
}

function git(args: readonly string[], cwd: string): Buffer {
  return execFileSync("git", args, { cwd, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }) as Buffer;
}

/**
 * THE NETWORK BOUND. A fetch from an upstream (and the partial clone's lazy
 * blob reads, which reach the promisor remote) waited on the network without
 * limit: a stalled host held the run for its whole budget. Each network step
 * now runs under git's own stall detector (`http.lowSpeedLimit` /
 * `http.lowSpeedTime`: below this many bytes a second for this long, from the
 * connection on, git gives up), which ends a silent host, a dead connection
 * and a stalled transfer alike, in a typed refusal naming the host — never a
 * retry. Upstreams are https only (`publicUpstream`), so the detector always
 * applies. There is deliberately no process timeout on top: killing `git`
 * leaves its remote helper holding the output pipe, and the synchronous call
 * then waits for the helper anyway (measured: the test hung).
 */
export type CorpusNetworkBound = Readonly<{ stallBytesPerSecond: number; stallSeconds: number }>;
export const CORPUS_NETWORK_BOUND: CorpusNetworkBound = Object.freeze({
  stallBytesPerSecond: 1_000,
  stallSeconds: 60,
});

function upstreamHost(upstream: string): string {
  try {
    return new URL(upstream).host || upstream;
  } catch {
    return upstream;
  }
}

/** A git step that reaches `member`'s upstream: stall-bounded, hang-bounded, refused by name. */
function networkGit(args: readonly string[], cwd: string, member: Readonly<{ name: string; upstream: string }>, bound: CorpusNetworkBound): Buffer {
  const bounded = [
    "-c", `http.lowSpeedLimit=${String(bound.stallBytesPerSecond)}`,
    "-c", `http.lowSpeedTime=${String(bound.stallSeconds)}`,
    ...args,
  ];
  try {
    return execFileSync("git", bounded, {
      cwd, encoding: "buffer", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }) as Buffer;
  } catch (error) {
    const failure = error as { stderr?: Buffer };
    const detail = (failure.stderr?.toString("utf8") ?? "").trim().split("\n").filter((line) => line.length > 0).at(-1) ?? "";
    const host = upstreamHost(member.upstream);
    if (/too slow|timed out|timeout/iu.test(detail)) {
      refuse("corpus_fetch_stalled", `fetching ${member.name} from ${host} stalled below ${String(bound.stallBytesPerSecond)} B/s for ${String(bound.stallSeconds)} s: ${detail}`);
    }
    refuse("corpus_fetch_failed", `fetching ${member.name} from ${host} failed: ${detail || (error as Error).message}`);
  }
}

function gitText(args: readonly string[], cwd: string): string {
  return git(args, cwd).toString("utf8").trim();
}

/** Write one file, creating its parents. The caller has already validated the path. */
function writeCacheFile(root: string, relativePath: string, bytes: Buffer): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

/**
 * Materialise the subset. Builds in a sibling directory and renames it into
 * place only after it verifies, so a killed fetch never leaves a half cache
 * that the next run would judge as the real one.
 */
export function fetchCorpus(manifest: CorpusManifest, options: { cacheDir?: string; repoRoot?: string; log?: (line: string) => void; network?: CorpusNetworkBound } = {}): string {
  const repoRoot = options.repoRoot ?? REPOSITORY_ROOT;
  const network = options.network ?? CORPUS_NETWORK_BOUND;
  const cacheDir = options.cacheDir ?? defaultCacheDir(manifest);
  const log = options.log ?? (() => {});
  const inside = relative(repoRoot, cacheDir);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
    refuse("corpus_cache_inside_tree", `cache ${cacheDir} must live outside the repository`);
  }
  if (existsSync(cacheDir)) {
    // Judge the cache itself, never the declared root: in a fresh clone the
    // root is not linked yet, and the reused cache is the whole point.
    const problems = judgeCache(cacheDir, manifest);
    if (problems.length === 0) {
      log(`cache already verified: ${cacheDir}`);
      return cacheDir;
    }
    refuse("corpus_cache_exists", `cache ${cacheDir} exists but does not verify (${problems[0]!.path}: ${problems[0]!.reason}); remove it yourself or pass --cache`);
  }
  // An owned sibling name (pid, start time and a nonce): an abandoned
  // staging tree of a dead run is never mistaken for this run's.
  const staging = join(dirname(cacheDir), ownedSiblingTemporaryName(basename(cacheDir), "corpus-staging"));
  mkdirSync(staging, { recursive: true });
  try {
    for (const member of manifest.members) {
      const checkout = join(staging, member.name);
      mkdirSync(checkout, { recursive: true });
      log(`fetching ${member.name} @ ${member.commit}`);
      git(["init", "-q"], checkout);
      git(["remote", "add", "origin", member.upstream], checkout);
      networkGit(["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", member.commit], checkout, member, network);
      for (const file of member.files) {
        // A partial clone reads the blob from the promisor remote: a network step.
        const bytes = networkGit(["cat-file", "blob", `${member.commit}:${file.path}`], checkout, member, network);
        if (bytes.byteLength !== file.sizeBytes || sha256Hex(bytes) !== file.sha256) {
          refuse("corpus_blob_mismatch", `${member.name}/${file.path}: fetched blob does not match the manifest`);
        }
        writeCacheFile(join(staging, member.name), file.path, bytes);
      }
    }
    for (const entry of manifest.derived) {
      const member = manifest.members.find((candidate) => candidate.name === entry.member);
      if (member === undefined) refuse("corpus_manifest_invalid", `derived ${entry.path}: unknown member ${entry.member}`);
      const source = networkGit(["cat-file", "blob", `${member.commit}:${entry.source}`], join(staging, member.name), member, network);
      if (source.byteLength !== entry.sizeBytes || sha256Hex(source) !== entry.sha256) {
        refuse("corpus_blob_mismatch", `${entry.path}: derived blob does not match the manifest`);
      }
      writeCacheFile(staging, entry.path, source);
    }
    for (const member of manifest.members) rmSync(join(staging, member.name, ".git"), { recursive: true, force: true });
    writeFileSync(join(staging, "README.md"), cacheReadme(manifest));
    // Verify BEFORE the rename: a cache that cannot pass its own check must not become the cache.
    const problems: CorpusProblem[] = [];
    for (const member of manifest.members) {
      for (const file of member.files) {
        const target = join(staging, member.name, file.path);
        const bytes = existsSync(target) ? readFileSync(target) : null;
        if (bytes === null || bytes.byteLength !== file.sizeBytes || sha256Hex(bytes) !== file.sha256) {
          problems.push({ path: `${member.name}/${file.path}`, reason: "missing or mismatched after fetch" });
        }
      }
    }
    for (const entry of manifest.derived) {
      const target = join(staging, entry.path);
      const bytes = existsSync(target) ? readFileSync(target) : null;
      if (bytes === null || bytes.byteLength !== entry.sizeBytes || sha256Hex(bytes) !== entry.sha256) {
        problems.push({ path: entry.path, reason: "missing or mismatched after fetch" });
      }
    }
    if (problems.length > 0) {
      refuse("corpus_fetch_incomplete", `fetch did not produce a verifiable cache: ${problems.map((problem) => problem.path).join(", ")}`);
    }
    renameSync(staging, cacheDir);
    log(`cache written: ${cacheDir}`);
    return cacheDir;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Link the verified cache at the repository path the tests read. Never overwrites. */
export function linkCorpus(repoRoot: string, cacheDir: string): string {
  const target = join(repoRoot, CORPUS_ROOT);
  if (existsSync(target) || isSymlink(target)) {
    if (isSymlink(target)) {
      const linked = resolve(dirname(target), readlinkSync(target));
      if (existsSync(linked) && realpathSync(linked) === realpathSync(cacheDir)) return target;
      // A link into the SAME corpus cache area is our own previous fetch (the
      // manifest was regenerated); replacing it is not touching a foreign tree.
      if (dirname(linked) === dirname(resolve(cacheDir))) {
        rmSync(target);
      } else {
        refuse("corpus_link_exists", `${CORPUS_ROOT} is a symlink to ${linked}, not this cache; remove it yourself`);
      }
    } else {
      refuse("corpus_link_exists", `${CORPUS_ROOT} exists as a real directory; move it aside yourself`);
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(cacheDir, target, "dir");
  return target;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// ── generation ──────────────────────────────────────────────────────────────

type MemberSpec = Readonly<{
  name: string;
  upstream: string;
  license: string;
  files: readonly RegExp[];
}>;

/**
 * What the public tests read, and nothing else. A new member is a licensing
 * review and a manifest regeneration, not a glob someone edits at a call site.
 */
const MEMBERS: readonly MemberSpec[] = Object.freeze([
  Object.freeze({ name: "lodash", upstream: "https://github.com/lodash/lodash.git", license: "MIT", files: [/^package\.json$/, /^lodash\.js$/, /^lib\/.*\.js$/] }),
  // Express keeps every function in `lib/`, and the awareness walk excludes
  // `lib` by default, so the member also pins the examples: without them the
  // real-codebase smoke reads a tree with zero functions and fails.
  Object.freeze({ name: "express", upstream: "https://github.com/expressjs/express.git", license: "MIT", files: [/^package\.json$/, /^index\.js$/, /^lib\/.*\.js$/, /^examples\/.*\.js$/] }),
  Object.freeze({ name: "babel", upstream: "https://github.com/babel/babel.git", license: "MIT", files: [/^eslint\.config\.ts$/, /^package\.json$/, /^packages\/babel-traverse\/src\/.*\.ts$/] }),
]);

/**
 * The scanner bait: the public guard reads the 11,064-byte Lodash test page at
 * this cache path, so the fetch derives it from the pinned Lodash commit.
 */
const DERIVED: readonly { path: string; member: string; source: string }[] = Object.freeze([
  Object.freeze({ path: "real-20/lodash/test/index.html", member: "lodash", source: "test/index.html" }),
]);

const NOT_INCLUDED =
  "The other members of the private 4.1 GB cache (real-20, typescript, multi-lang, sympy, zod and the rest) " +
  "are not read by the public tests and are not published; this manifest pins only lodash, express and babel/traverse.";

/** Generate the manifest from a corpus root. Read-only over the corpus. */
export function generateManifest(corpusRoot: string): CorpusManifest {
  const members: CorpusMember[] = [];
  for (const spec of MEMBERS) {
    const checkout = join(corpusRoot, spec.name);
    if (!existsSync(checkout)) refuse("corpus_member_absent", `corpus member ${spec.name} is absent at ${checkout}`);
    const upstream = gitText(["remote", "get-url", "origin"], checkout);
    if (upstream !== spec.upstream) refuse("corpus_upstream_mismatch", `${spec.name}: origin is ${upstream}, expected ${spec.upstream}`);
    const commit = gitText(["rev-parse", "HEAD"], checkout);
    commitValue(commit, spec.name);
    const listed = gitText(["ls-tree", "-r", "--name-only", commit], checkout).split("\n").filter((path) => path.length > 0);
    const wanted = listed.filter((path) => spec.files.some((pattern) => pattern.test(path))).sort();
    if (wanted.length === 0) refuse("corpus_member_empty", `${spec.name}: no file matches the member's patterns — the allowlist is stale`);
    const files = wanted.map((path) => {
      const bytes = git(["cat-file", "blob", `${commit}:${path}`], checkout);
      return Object.freeze({ path, sizeBytes: bytes.byteLength, sha256: sha256Hex(bytes) });
    });
    members.push(Object.freeze({ name: spec.name, upstream, commit, license: spec.license, files: Object.freeze(files) }));
  }
  const derived = DERIVED.map((entry) => {
    const member = members.find((candidate) => candidate.name === entry.member);
    if (member === undefined) refuse("corpus_manifest_invalid", `derived ${entry.path}: unknown member ${entry.member}`);
    const bytes = git(["cat-file", "blob", `${member.commit}:${entry.source}`], join(corpusRoot, entry.member));
    return Object.freeze({ path: entry.path, member: entry.member, source: entry.source, sizeBytes: bytes.byteLength, sha256: sha256Hex(bytes) });
  });
  const payload = { schemaVersion: MANIFEST_SCHEMA, generatorRevision: GENERATOR_REVISION, root: CORPUS_ROOT, members, derived, notIncluded: NOT_INCLUDED };
  return Object.freeze({ ...payload, manifestSha256: manifestDigest(payload) });
}

export function writeManifest(manifest: CorpusManifest, path = join(REPOSITORY_ROOT, MANIFEST_PATH)): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

export function main(argv: readonly string[]): number {
  const command = argv[0];
  try {
    if (command === "manifest") {
      const corpus = parseArg(argv, "--corpus") ?? join(REPOSITORY_ROOT, "engine", "large-codebases");
      if (!existsSync(corpus)) refuse("corpus_member_absent", `corpus root is absent at ${corpus}; generate the manifest where the cache lives`);
      const manifest = generateManifest(corpus);
      const path = writeManifest(manifest);
      process.stdout.write(`wrote ${path} (${manifest.members.reduce((count, member) => count + member.files.length, 0)} files, digest ${manifest.manifestSha256.slice(0, 12)})\n`);
      return 0;
    }
    if (command === "fetch") {
      const manifest = readManifest();
      const cacheDir = parseArg(argv, "--cache") ?? defaultCacheDir(manifest);
      const written = fetchCorpus(manifest, { cacheDir, log: (line) => process.stdout.write(`${line}\n`) });
      const link = linkCorpus(REPOSITORY_ROOT, written);
      const verdict = verifyCorpus(REPOSITORY_ROOT, manifest);
      if (!verdict.ok) refuse("corpus_verify_failed", `fetch linked ${link} but verification failed: ${verdict.problems.map((problem) => problem.path).join(", ")}`);
      process.stdout.write(`${CORPUS_ROOT} -> ${written}\n`);
      return 0;
    }
    if (command === "verify") {
      const manifest = readManifest();
      const verdict = verifyCorpus(REPOSITORY_ROOT, manifest);
      if (!verdict.ok) {
        for (const problem of verdict.problems) process.stderr.write(`${problem.path}: ${problem.reason}\n`);
        return 1;
      }
      process.stdout.write(`corpus verified at ${verdict.root}\n`);
      return 0;
    }
    process.stderr.write("usage: corpus.ts <manifest|fetch|verify> [--corpus DIR] [--cache DIR]\n");
    return 2;
  } catch (error) {
    if (error instanceof CorpusError) {
      process.stderr.write(`corpus: ${error.code}: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = main(process.argv.slice(2));
}
