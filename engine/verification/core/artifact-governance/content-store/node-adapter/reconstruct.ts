import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { InputError } from "../../../../../src/kernel/errors.ts";
import { sha256 } from "../../../../../src/kernel/integrity.ts";
import {
  assertExactWriteAuthorized,
  bindTransientWriteRootCapability,
  type ExactWriteLease,
  type TransientWriteRootCapability,
} from "../../../../../src/modules/effect-boundary/index.ts";

import { readContentBlobBytes, type ContentBlob } from "../pack.ts";
import {
  verifyContentTreeBlobSet,
  type ContentTree,
  type ContentTreeEntry,
} from "../tree.ts";

type ProtectedContentRootObservation = Readonly<{
  repositoryRoot: string;
  device: string;
  inode: string;
}>;

export type ContentRootCapability = TransientWriteRootCapability;

export type ContentReconstructionRequest = Readonly<{
  root: ContentRootCapability;
  destinationRelativePath: string;
  lease: ExactWriteLease;
  tree: ContentTree;
  blobs: readonly ContentBlob[];
}>;

const ROOT_OBSERVATIONS = new WeakMap<ContentRootCapability, ProtectedContentRootObservation>();

export function observeContentRoot(repositoryRootInput: string): ContentRootCapability {
  const observation = readProtectedRootObservation(repositoryRootInput);
  const capability = bindTransientWriteRootCapability(observation);
  ROOT_OBSERVATIONS.set(capability, observation);
  return capability;
}

/** Node-adapter-internal bridge. The protected path never enters a record or the public barrel. */
export function withObservedContentRootForNodeAdapterInternal<Result>(
  root: ContentRootCapability,
  operation: (repositoryRoot: string) => Result,
): Result {
  const protectedRoot = requireCurrentRootObservation(root);
  const result = operation(protectedRoot.repositoryRoot);
  const after = readProtectedRootObservation(protectedRoot.repositoryRoot);
  if (after.device !== protectedRoot.device || after.inode !== protectedRoot.inode) {
    throw new InputError("Content root identity changed", "content_store_root_identity_changed");
  }
  return result;
}

export function reconstructContentTree(request: ContentReconstructionRequest): void {
  const protectedRoot = requireCurrentRootObservation(request.root);
  const logicalEffect = {
    operation: "create-directory" as const,
    relativePath: request.destinationRelativePath,
  };
  assertExactWriteAuthorized(request.lease, request.root, logicalEffect);
  const blobBytes = validateReconstructionInputs(request.tree, request.blobs);
  const destination = confinedDestination(protectedRoot.repositoryRoot, request.destinationRelativePath);
  if (lstatSync(destination, { bigint: true, throwIfNoEntry: false }) !== undefined) {
    throw new InputError("Content reconstruction target exists", "content_store_reconstruction_target_exists");
  }

  mkdirSync(destination, { mode: 0o700 });
  const directoryEntries: Array<Extract<ContentTreeEntry, { kind: "directory" }>> = [];
  for (const entry of request.tree.entries) {
    const path = rawChildPath(destination, decodePath(entry.pathSegmentsBase64url));
    if (entry.kind === "directory") {
      mkdirSync(path, { mode: entry.mode });
      directoryEntries.push(entry);
    } else if (entry.kind === "file") {
      const bytes = blobBytes.get(entry.blobSha256)!;
      writeFileSync(path, bytes, { flag: "wx", mode: entry.mode });
    } else {
      symlinkSync(Buffer.from(entry.targetBase64url, "base64url"), path);
    }
  }
  for (const entry of directoryEntries.toReversed()) {
    const path = rawChildPath(destination, decodePath(entry.pathSegmentsBase64url));
    const mode = Number(statSync(path, { bigint: true }).mode & 0o7777n);
    if (mode !== entry.mode) {
      throw new InputError("Content reconstruction mode drifted", "content_store_reconstruction_mode_invalid");
    }
  }
  const after = readProtectedRootObservation(protectedRoot.repositoryRoot);
  if (after.device !== protectedRoot.device || after.inode !== protectedRoot.inode) {
    throw new InputError("Content reconstruction root changed", "content_store_root_identity_changed");
  }
}

export function isExactRootOrDescendantDestinationParent(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function requireCurrentRootObservation(root: ContentRootCapability): ProtectedContentRootObservation {
  const protectedRoot = ROOT_OBSERVATIONS.get(root);
  if (protectedRoot === undefined) {
    throw new InputError("Content root capability is invalid", "content_store_root_capability_invalid");
  }
  const current = readProtectedRootObservation(protectedRoot.repositoryRoot);
  if (current.device !== protectedRoot.device || current.inode !== protectedRoot.inode) {
    throw new InputError("Content root identity changed", "content_store_root_identity_changed");
  }
  return protectedRoot;
}

function readProtectedRootObservation(repositoryRootInput: string): ProtectedContentRootObservation {
  if (!isAbsolute(repositoryRootInput) || resolve(repositoryRootInput) !== repositoryRootInput ||
    repositoryRootInput.includes("\0")) {
    throw new InputError("Content root is not canonical", "content_store_root_invalid");
  }
  let realPath: string;
  try {
    realPath = realpathSync(repositoryRootInput);
  } catch {
    throw new InputError("Content root is unavailable", "content_store_root_invalid");
  }
  if (realPath !== repositoryRootInput) {
    throw new InputError("Content root is aliased", "content_store_root_invalid");
  }
  const lexical = lstatSync(repositoryRootInput, { bigint: true, throwIfNoEntry: false });
  if (!lexical?.isDirectory() || lexical.isSymbolicLink()) {
    throw new InputError("Content root is not a directory", "content_store_root_invalid");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      repositoryRootInput,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(repositoryRootInput, { bigint: true, throwIfNoEntry: false });
    if (!after || !sameDirectoryIdentity(lexical, opened) || !sameDirectoryIdentity(opened, after)) {
      throw new InputError("Content root identity changed", "content_store_root_identity_changed");
    }
    return Object.freeze({
      repositoryRoot: realPath,
      device: opened.dev.toString(10),
      inode: opened.ino.toString(10),
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function confinedDestination(root: string, relativePath: string): string {
  const destination = resolve(root, relativePath);
  const roundTrip = relative(root, destination).split(sep).join("/");
  if (roundTrip !== relativePath || destination === root || !destination.startsWith(`${root}${sep}`)) {
    throw new InputError("Content destination escapes root", "content_store_destination_unconfined");
  }
  const parent = dirname(destination);
  let canonicalParent: string;
  try {
    canonicalParent = realpathSync(parent);
  } catch {
    throw new InputError("Content destination parent is absent", "content_store_destination_parent_invalid");
  }
  if (canonicalParent !== parent ||
    !isExactRootOrDescendantDestinationParent(root, canonicalParent)) {
    throw new InputError("Content destination parent is aliased", "content_store_destination_parent_invalid");
  }
  return destination;
}

function validateReconstructionInputs(
  tree: ContentTree,
  blobs: readonly ContentBlob[],
): ReadonlyMap<string, Uint8Array> {
  const byDigest = new Map<string, Uint8Array>();
  for (const blob of blobs) {
    if (byDigest.has(blob.sha256)) {
      throw new InputError("Content reconstruction blob is duplicated", "content_store_blob_duplicate");
    }
    const bytes = readContentBlobBytes(blob);
    if (bytes.byteLength !== blob.byteLength || sha256(bytes) !== blob.sha256) {
      throw new InputError("Content reconstruction blob is invalid", "content_store_blob_digest_mismatch");
    }
    byDigest.set(blob.sha256, bytes);
  }
  verifyContentTreeBlobSet(tree, new Set(byDigest.keys()));
  return byDigest;
}

function rawChildPath(root: string, segments: readonly Buffer[]): Buffer {
  const values = [Buffer.from(root), ...segments.flatMap((segment) => [Buffer.from("/"), segment])];
  return Buffer.concat(values);
}

function decodePath(pathSegmentsBase64url: readonly string[]): readonly Buffer[] {
  return pathSegmentsBase64url.map((segment) => Buffer.from(segment, "base64url"));
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
}
