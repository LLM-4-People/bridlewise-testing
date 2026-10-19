import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { sha256 } from "../../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../../src/kernel/json-integrity.ts";
import { decideFilesystemBoundary } from "../../../src/filesystem/path-boundary.ts";

export const SCOPE_MANIFEST_FORMAT = "harness.synthetic-exact-scope/v1";
export const VERIFY_OPERATION = "verify_manifest";
export const SCOPE_GUARD_LIMITS = Object.freeze({
  maximumComponentBytes: 255,
  maximumFileBytes: 16 * 1024 * 1024,
  maximumFiles: 128,
  maximumIdentifierBytes: 128,
  maximumManifestBytes: 1024 * 1024,
  maximumPathBytes: 4096,
  maximumPathComponents: 64,
  maximumRequestBytes: 2 * 1024 * 1024,
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SAFE_CANONICAL_COMPONENT_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?|\.[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)$/u;
const FORBIDDEN_RESERVED_COMPONENT_PATTERN = /^(?:dev|fd|proc|sys)$/iu;
const FORBIDDEN_ARTIFACT_NAME_PATTERN = /(?:^|[._-])(?:db|databases?|logs?|outputs?|packets?|quarantine|review[-_]?packets?|scratch|shm|sqlite|wal)(?:$|[._-])/iu;
const FORBIDDEN_SENSITIVE_PATTERN = /(?:^|[._-])(?:api[-_]?keys?|credentials?|passwords?|secrets?|tokens?)(?:$|[._-])/iu;
const FORBIDDEN_DATABASE_PATTERN = /(?:\.(?:db|sqlite|sqlite3|wal|shm)|-(?:wal|shm))$/iu;
const FORBIDDEN_LOG_PATTERN = /(?:\.logs?|-(?:stdout|stderr))$/iu;
const FORBIDDEN_DISCOVERY_OPERATIONS = new Set([
  "discover",
  "find",
  "glob",
  "grep",
  "list",
  "read_tree",
  "recursive_search",
  "rg",
  "scan",
  "search",
]);

export type ScopeGuardCode =
  | "scope_ambiguous"
  | "scope_case_ambiguous"
  | "scope_changed"
  | "scope_cross_device"
  | "scope_discovery_denied"
  | "scope_duplicate"
  | "scope_forbidden_name"
  | "scope_hardlink_denied"
  | "scope_hash_mismatch"
  | "scope_identity_mismatch"
  | "scope_internal_failure"
  | "scope_invalid_manifest"
  | "scope_missing"
  | "scope_mountpoint_denied"
  | "scope_not_regular"
  | "scope_outside_sandbox"
  | "scope_size_mismatch"
  | "scope_symlink_denied"
  | "scope_tainted_claim_denied"
  | "scope_traversal_denied"
  | "scope_unlisted_denied";

export class ScopeGuardError extends Error {
  readonly code: ScopeGuardCode;

  constructor(code: ScopeGuardCode) {
    super(code);
    this.name = "ScopeGuardError";
    this.code = code;
  }
}

export interface ExactFileIdentity {
  readonly id: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly device: string;
  readonly inode: string;
}

export interface SyntheticScopeManifest {
  readonly format: typeof SCOPE_MANIFEST_FORMAT;
  readonly fixtureClass: "generated-synthetic-only";
  readonly rootRealpath: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly operation: typeof VERIFY_OPERATION;
  readonly files: readonly ExactFileIdentity[];
  readonly transcriptTainted: boolean;
}

export interface ScopeGuardRequest {
  readonly syntheticSandboxRoot: string;
  readonly manifestJson: string;
  readonly operation: string;
  readonly requestedFileIds: readonly string[];
}

export interface ContentFreeVerificationReceipt {
  readonly manifestSha256: string;
  readonly admittedFileCount: number;
  readonly verifiedFileCount: number;
  readonly allHashesMatched: boolean;
  readonly descriptorRelativeAncestorBinding: false;
  readonly stableParentChainVerified: false;
  readonly fullIsolationVerified: false;
  readonly callerIsolationDeclarationsAreProof: false;
  readonly syntheticQualificationOnly: true;
  readonly realHistoryReady: false;
  readonly sec001Open: true;
}

export interface ContentFreeFailureReceipt {
  readonly errorCode: ScopeGuardCode;
  readonly syntheticQualificationOnly: true;
  readonly realHistoryReady: false;
  readonly sec001Open: true;
}

export function toContentFreeFailureReceipt(error: unknown): ContentFreeFailureReceipt {
  const normalized = normalizeScopeGuardError(error);
  return Object.freeze({
    errorCode: normalized.code,
    syntheticQualificationOnly: true,
    realHistoryReady: false,
    sec001Open: true,
  });
}

export function normalizeScopeGuardError(error: unknown): ScopeGuardError {
  return error instanceof ScopeGuardError ? error : new ScopeGuardError("scope_internal_failure");
}

interface StableIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export function assertExactOperation(operation: string): void {
  const normalized = operation.normalize("NFC").toLowerCase();
  if (FORBIDDEN_DISCOVERY_OPERATIONS.has(normalized)) {
    throw new ScopeGuardError("scope_discovery_denied");
  }
  if (operation !== VERIFY_OPERATION) throw new ScopeGuardError("scope_unlisted_denied");
}

export function parseSyntheticScopeManifest(manifestJson: string): SyntheticScopeManifest {
  if (Buffer.byteLength(manifestJson, "utf8") > SCOPE_GUARD_LIMITS.maximumManifestBytes) {
    throw new ScopeGuardError("scope_invalid_manifest");
  }
  try {
    assertNoDuplicateJsonObjectKeys(
      manifestJson,
      "scope_invalid_manifest",
      "scope_invalid_manifest",
    );
  } catch {
    throw new ScopeGuardError("scope_invalid_manifest");
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(manifestJson) as unknown;
  } catch {
    throw new ScopeGuardError("scope_invalid_manifest");
  }
  if (!isPlainObject(candidate)) throw new ScopeGuardError("scope_invalid_manifest");
  assertExactKeys(candidate, [
    "files",
    "fixtureClass",
    "format",
    "operation",
    "rootDevice",
    "rootInode",
    "rootRealpath",
    "transcriptTainted",
  ]);
  if (
    candidate.format !== SCOPE_MANIFEST_FORMAT ||
    candidate.fixtureClass !== "generated-synthetic-only" ||
    candidate.operation !== VERIFY_OPERATION ||
    typeof candidate.transcriptTainted !== "boolean" ||
    typeof candidate.rootRealpath !== "string" ||
    typeof candidate.rootDevice !== "string" ||
    typeof candidate.rootInode !== "string" ||
    !Array.isArray(candidate.files)
  ) {
    throw new ScopeGuardError("scope_invalid_manifest");
  }
  if (candidate.files.length === 0 || candidate.files.length > SCOPE_GUARD_LIMITS.maximumFiles) {
    throw new ScopeGuardError("scope_invalid_manifest");
  }
  validateAbsoluteScopePath(candidate.rootRealpath);

  const files = candidate.files.map(parseExactFileIdentity);
  const ids = new Set<string>();
  const paths = new Set<string>();
  const caseFoldedPaths = new Set<string>();
  const inodes = new Set<string>();
  for (const file of files) {
    const folded = file.relativePath.toLowerCase();
    const inodeKey = `${file.device}:${file.inode}`;
    if (ids.has(file.id) || paths.has(file.relativePath) || inodes.has(inodeKey)) {
      throw new ScopeGuardError("scope_duplicate");
    }
    if (caseFoldedPaths.has(folded)) throw new ScopeGuardError("scope_case_ambiguous");
    ids.add(file.id);
    paths.add(file.relativePath);
    caseFoldedPaths.add(folded);
    inodes.add(inodeKey);
  }

  return {
    format: SCOPE_MANIFEST_FORMAT,
    fixtureClass: "generated-synthetic-only",
    rootRealpath: candidate.rootRealpath,
    rootDevice: candidate.rootDevice,
    rootInode: candidate.rootInode,
    operation: VERIFY_OPERATION,
    files,
    transcriptTainted: candidate.transcriptTainted,
  };
}

export function parseScopeGuardRequestJson(requestJson: string): ScopeGuardRequest {
  if (Buffer.byteLength(requestJson, "utf8") > SCOPE_GUARD_LIMITS.maximumRequestBytes) {
    throw new ScopeGuardError("scope_invalid_manifest");
  }
  try {
    assertNoDuplicateJsonObjectKeys(
      requestJson,
      "scope_invalid_manifest",
      "scope_invalid_manifest",
    );
  } catch {
    throw new ScopeGuardError("scope_invalid_manifest");
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(requestJson) as unknown;
  } catch {
    throw new ScopeGuardError("scope_invalid_manifest");
  }
  if (!isPlainObject(candidate)) throw new ScopeGuardError("scope_invalid_manifest");
  assertExactKeys(candidate, ["manifestJson", "operation", "requestedFileIds", "syntheticSandboxRoot"]);
  if (
    typeof candidate.syntheticSandboxRoot !== "string" ||
    typeof candidate.manifestJson !== "string" ||
    typeof candidate.operation !== "string" ||
    !Array.isArray(candidate.requestedFileIds) ||
    candidate.requestedFileIds.length > SCOPE_GUARD_LIMITS.maximumFiles ||
    candidate.requestedFileIds.some((id) =>
      typeof id !== "string" ||
      !IDENTIFIER_PATTERN.test(id) ||
      Buffer.byteLength(id, "utf8") > SCOPE_GUARD_LIMITS.maximumIdentifierBytes
    )
  ) {
    throw new ScopeGuardError("scope_invalid_manifest");
  }
  validateAbsoluteScopePath(candidate.syntheticSandboxRoot);
  return {
    syntheticSandboxRoot: candidate.syntheticSandboxRoot,
    manifestJson: candidate.manifestJson,
    operation: candidate.operation,
    requestedFileIds: [...candidate.requestedFileIds] as string[],
  };
}

export async function verifySyntheticExactScope(
  request: ScopeGuardRequest,
): Promise<ContentFreeVerificationReceipt> {
  try {
    return await verifySyntheticExactScopeInternal(request);
  } catch (error) {
    throw normalizeScopeGuardError(error);
  }
}

async function verifySyntheticExactScopeInternal(
  request: ScopeGuardRequest,
): Promise<ContentFreeVerificationReceipt> {
  assertExactOperation(request.operation);
  const manifest = parseSyntheticScopeManifest(request.manifestJson);
  if (manifest.transcriptTainted !== false) {
    throw new ScopeGuardError("scope_tainted_claim_denied");
  }

  const sandbox = await canonicalDirectory(request.syntheticSandboxRoot, undefined);
  const root = await canonicalDirectory(manifest.rootRealpath, sandbox);
  if (root.path !== manifest.rootRealpath) throw new ScopeGuardError("scope_identity_mismatch");
  if (root.identity.dev.toString() !== manifest.rootDevice || root.identity.ino.toString() !== manifest.rootInode) {
    throw new ScopeGuardError("scope_identity_mismatch");
  }
  const boundary = decideFilesystemBoundary(sandbox.identity.dev, root.identity.dev, false);
  if (boundary === "path_cross_device_denied") throw new ScopeGuardError("scope_cross_device");
  if (boundary === "path_mountpoint_denied") throw new ScopeGuardError("scope_mountpoint_denied");

  const manifestById = new Map(manifest.files.map((file) => [file.id, file]));
  const requestedIds = new Set<string>();
  for (const id of request.requestedFileIds) {
    if (typeof id !== "string" || !IDENTIFIER_PATTERN.test(id)) {
      throw new ScopeGuardError("scope_unlisted_denied");
    }
    if (requestedIds.has(id)) throw new ScopeGuardError("scope_duplicate");
    if (!manifestById.has(id)) throw new ScopeGuardError("scope_unlisted_denied");
    requestedIds.add(id);
  }
  if (requestedIds.size !== manifest.files.length) throw new ScopeGuardError("scope_unlisted_denied");

  let verifiedFileCount = 0;
  for (const file of manifest.files) {
    await verifyExactFile(root.path, root.identity.dev, file);
    verifiedFileCount += 1;
  }
  const rootAfter = await lstat(root.path, { bigint: true }).catch(() => undefined);
  if (!rootAfter || !sameIdentity(root.identity, toStableIdentity(rootAfter))) {
    throw new ScopeGuardError("scope_changed");
  }

  return Object.freeze({
    manifestSha256: sha256(request.manifestJson),
    admittedFileCount: manifest.files.length,
    verifiedFileCount,
    allHashesMatched: verifiedFileCount === manifest.files.length,
    descriptorRelativeAncestorBinding: false,
    stableParentChainVerified: false,
    fullIsolationVerified: false,
    callerIsolationDeclarationsAreProof: false,
    syntheticQualificationOnly: true,
    realHistoryReady: false,
    sec001Open: true,
  });
}

export function validateRelativePath(relativePath: string): readonly string[] {
  if (
    relativePath.length === 0 ||
    relativePath !== relativePath.normalize("NFC") ||
    isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    /[\u0000-\u001f\u007f]/u.test(relativePath)
  ) {
    throw new ScopeGuardError("scope_traversal_denied");
  }
  const components = relativePath.split("/");
  if (
    Buffer.byteLength(relativePath, "utf8") > SCOPE_GUARD_LIMITS.maximumPathBytes ||
    components.length > SCOPE_GUARD_LIMITS.maximumPathComponents ||
    components.some((component) =>
      component.length === 0 ||
      component === "." ||
      component === ".." ||
      Buffer.byteLength(component, "utf8") > SCOPE_GUARD_LIMITS.maximumComponentBytes
    )
  ) {
    throw new ScopeGuardError("scope_traversal_denied");
  }
  for (const component of components) assertAllowedComponent(component);
  return components;
}

export function validateAbsoluteScopePath(path: string): void {
  const canonicalSyntax = isAbsolute(path) ? resolve(path) : "";
  if (
    !isAbsolute(path) ||
    canonicalSyntax === sep ||
    path !== path.normalize("NFC") ||
    path !== canonicalSyntax ||
    Buffer.byteLength(path, "utf8") > SCOPE_GUARD_LIMITS.maximumPathBytes
  ) {
    throw new ScopeGuardError("scope_ambiguous");
  }
  for (const component of resolve(path).split(sep).filter((value) => value.length > 0)) {
    assertAllowedComponent(component);
  }
}

function parseExactFileIdentity(candidate: unknown): ExactFileIdentity {
  if (!isPlainObject(candidate)) throw new ScopeGuardError("scope_invalid_manifest");
  assertExactKeys(candidate, ["byteLength", "device", "id", "inode", "relativePath", "sha256"]);
  if (
    typeof candidate.id !== "string" ||
    !IDENTIFIER_PATTERN.test(candidate.id) ||
    Buffer.byteLength(candidate.id, "utf8") > SCOPE_GUARD_LIMITS.maximumIdentifierBytes ||
    typeof candidate.relativePath !== "string" ||
    typeof candidate.sha256 !== "string" ||
    !SHA256_PATTERN.test(candidate.sha256) ||
    !Number.isSafeInteger(candidate.byteLength) ||
    (candidate.byteLength as number) < 0 ||
    typeof candidate.device !== "string" ||
    !/^[0-9]+$/u.test(candidate.device) ||
    typeof candidate.inode !== "string" ||
    !/^[0-9]+$/u.test(candidate.inode)
  ) {
    throw new ScopeGuardError("scope_invalid_manifest");
  }
  validateRelativePath(candidate.relativePath);
  return {
    id: candidate.id,
    relativePath: candidate.relativePath,
    sha256: candidate.sha256,
    byteLength: candidate.byteLength as number,
    device: candidate.device,
    inode: candidate.inode,
  };
}

function assertAllowedComponent(component: string): void {
  if (
    component !== component.normalize("NFC") ||
    !SAFE_CANONICAL_COMPONENT_PATTERN.test(component) ||
    FORBIDDEN_RESERVED_COMPONENT_PATTERN.test(component) ||
    FORBIDDEN_ARTIFACT_NAME_PATTERN.test(component) ||
    FORBIDDEN_SENSITIVE_PATTERN.test(component) ||
    FORBIDDEN_DATABASE_PATTERN.test(component) ||
    FORBIDDEN_LOG_PATTERN.test(component) ||
    /[*?\[\]{}]/u.test(component)
  ) {
    throw new ScopeGuardError("scope_forbidden_name");
  }
}

async function canonicalDirectory(
  suppliedPath: string,
  enclosingSandbox: Readonly<{ path: string; identity: StableIdentity }> | undefined,
): Promise<Readonly<{ path: string; identity: StableIdentity }>> {
  validateAbsoluteScopePath(suppliedPath);
  const suppliedLstat = await lstat(suppliedPath, { bigint: true }).catch(() => undefined);
  if (!suppliedLstat) throw new ScopeGuardError("scope_missing");
  if (suppliedLstat.isSymbolicLink()) throw new ScopeGuardError("scope_symlink_denied");
  if (!suppliedLstat.isDirectory()) throw new ScopeGuardError("scope_not_regular");
  const canonical = await realpath(suppliedPath).catch(() => undefined);
  if (!canonical || canonical !== resolve(suppliedPath)) throw new ScopeGuardError("scope_ambiguous");
  if (enclosingSandbox && !isStrictDescendant(enclosingSandbox.path, canonical)) {
    throw new ScopeGuardError("scope_outside_sandbox");
  }
  return { path: canonical, identity: toStableIdentity(suppliedLstat) };
}

async function verifyExactFile(root: string, rootDevice: bigint, expected: ExactFileIdentity): Promise<void> {
  const components = validateRelativePath(expected.relativePath);
  let parent = root;
  for (const component of components.slice(0, -1)) {
    parent = resolve(parent, component);
    await verifyParentDirectory(root, parent, rootDevice);
  }
  const candidate = resolve(root, ...components);
  if (!isStrictDescendant(root, candidate)) throw new ScopeGuardError("scope_traversal_denied");
  const beforeLstat = await lstat(candidate, { bigint: true }).catch(() => undefined);
  if (!beforeLstat) throw new ScopeGuardError("scope_missing");
  if (beforeLstat.isSymbolicLink()) throw new ScopeGuardError("scope_symlink_denied");
  if (!beforeLstat.isFile()) throw new ScopeGuardError("scope_not_regular");
  const before = toStableIdentity(beforeLstat);
  if (before.nlink !== 1n) throw new ScopeGuardError("scope_hardlink_denied");
  if (before.dev !== rootDevice) throw new ScopeGuardError("scope_cross_device");
  if (before.dev.toString() !== expected.device || before.ino.toString() !== expected.inode) {
    throw new ScopeGuardError("scope_identity_mismatch");
  }
  if (before.size !== BigInt(expected.byteLength)) throw new ScopeGuardError("scope_size_mismatch");
  const canonical = await realpath(candidate).catch(() => undefined);
  if (!canonical || canonical !== candidate) throw new ScopeGuardError("scope_ambiguous");

  const handle = await open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => undefined);
  if (!handle) throw new ScopeGuardError("scope_changed");
  try {
    const opened = toStableIdentity(await handle.stat({ bigint: true }));
    if (!sameIdentity(before, opened)) throw new ScopeGuardError("scope_changed");
    if (opened.size > BigInt(SCOPE_GUARD_LIMITS.maximumFileBytes)) {
      throw new ScopeGuardError("scope_size_mismatch");
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new ScopeGuardError("scope_changed");
      offset += read.bytesRead;
    }
    const openedAfter = toStableIdentity(await handle.stat({ bigint: true }));
    if (!sameIdentity(opened, openedAfter)) throw new ScopeGuardError("scope_changed");
    if (sha256(bytes) !== expected.sha256) throw new ScopeGuardError("scope_hash_mismatch");
  } finally {
    await handle.close();
  }

  const afterLstat = await lstat(candidate, { bigint: true }).catch(() => undefined);
  if (!afterLstat || !sameIdentity(before, toStableIdentity(afterLstat))) {
    throw new ScopeGuardError("scope_changed");
  }
  const canonicalAfter = await realpath(candidate).catch(() => undefined);
  if (canonicalAfter !== candidate) throw new ScopeGuardError("scope_changed");
}

async function verifyParentDirectory(root: string, candidate: string, rootDevice: bigint): Promise<void> {
  if (!isStrictDescendant(root, candidate)) throw new ScopeGuardError("scope_traversal_denied");
  const info = await lstat(candidate, { bigint: true }).catch(() => undefined);
  if (!info) throw new ScopeGuardError("scope_missing");
  if (info.isSymbolicLink()) throw new ScopeGuardError("scope_symlink_denied");
  if (!info.isDirectory()) throw new ScopeGuardError("scope_not_regular");
  const boundary = decideFilesystemBoundary(rootDevice, info.dev, false);
  if (boundary === "path_cross_device_denied") throw new ScopeGuardError("scope_cross_device");
  const canonical = await realpath(candidate).catch(() => undefined);
  if (canonical !== candidate) throw new ScopeGuardError("scope_ambiguous");
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot.length > 0 && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

function toStableIdentity(info: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}): StableIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mode: info.mode,
    nlink: info.nlink,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

function sameIdentity(left: StableIdentity, right: StableIdentity): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(value).toSorted();
  const sortedExpected = [...expected].toSorted();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new ScopeGuardError("scope_invalid_manifest");
  }
}
