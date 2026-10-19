import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { InputError } from "../../../../../src/kernel/errors.ts";
import { deepFreeze, sha256 } from "../../../../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../../../../src/kernel/root-policy.ts";

import { encodeBase64urlBytes } from "../domain/path-bytes.ts";
import { createContentBlob, type ContentBlob } from "../pack.ts";
import {
  createContentTree,
  verifyContentTreeBlobSet,
  type ContentTree,
  type ContentTreeEntry,
} from "../tree.ts";

const TREE_POLICY = ROOT_POLICY.artifactGovernance.contentAddressedEvidence.tree;

export type ContentTreeScan = Readonly<{
  tree: ContentTree;
  blobs: readonly ContentBlob[];
  logicalByteLength: number;
}>;

export function scanContentTree(sourceRootInput: string): ContentTreeScan {
  const sourceRoot = canonicalSourceRoot(sourceRootInput);
  const rootStats = lstatSync(sourceRoot, { bigint: true });
  const entries: ContentTreeEntry[] = [];
  const blobsByDigest = new Map<string, ContentBlob>();
  let logicalByteLength = 0;

  const visit = (segments: readonly Buffer[]): void => {
    if (segments.length > TREE_POLICY.maximumDepth) {
      throw new InputError("Content tree exceeds depth limit", "content_store_tree_depth_exceeded");
    }
    const directoryPath = rawChildPath(sourceRoot, segments);
    const before = lstatSync(directoryPath, { bigint: true, throwIfNoEntry: false });
    if (!before?.isDirectory() || before.isSymbolicLink() || before.dev !== rootStats.dev) {
      throw new InputError("Content tree directory is unsafe", "content_store_tree_directory_unsafe");
    }
    const children = readdirSync(directoryPath, {
      encoding: "buffer",
      withFileTypes: true,
    }) as unknown as Dirent<Buffer>[];
    children.sort((left, right) => Buffer.compare(left.name, right.name));
    for (const child of children) {
      if (entries.length >= TREE_POLICY.maximumEntries) {
        throw new InputError("Content tree exceeds entry limit", "content_store_tree_entry_limit");
      }
      const childSegments = [...segments, Buffer.from(child.name)];
      const pathSegmentsBase64url = childSegments.map((segment) => encodeBase64urlBytes(segment));
      const path = rawChildPath(sourceRoot, childSegments);
      const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (!stats || stats.dev !== rootStats.dev) {
        throw new InputError("Content tree entry changed", "content_store_tree_entry_unsafe");
      }
      const mode = Number(stats.mode & 0o7777n);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        entries.push({ kind: "directory", mode, pathSegmentsBase64url });
        visit(childSegments);
        continue;
      }
      if (stats.isFile() && !stats.isSymbolicLink()) {
        if (stats.nlink !== 1n) {
          throw new InputError("Content tree hardlink is forbidden", "content_store_tree_hardlink_forbidden");
        }
        if (stats.size > BigInt(TREE_POLICY.maximumBlobBytes)) {
          throw new InputError("Content tree blob exceeds limit", "content_store_tree_blob_limit");
        }
        const bytes = readStableFile(path, stats);
        logicalByteLength += bytes.byteLength;
        if (logicalByteLength > TREE_POLICY.maximumLogicalBytes) {
          throw new InputError("Content tree exceeds logical byte limit", "content_store_tree_logical_limit");
        }
        const blob = createContentBlob(bytes, TREE_POLICY.maximumBlobBytes);
        blobsByDigest.set(blob.sha256, blob);
        entries.push({
          kind: "file",
          mode,
          pathSegmentsBase64url,
          byteLength: blob.byteLength,
          blobSha256: blob.sha256,
        });
        continue;
      }
      if (stats.isSymbolicLink()) {
        const target = Buffer.from(readlinkSync(path, { encoding: "buffer" }));
        if (target.byteLength === 0 || target.includes(0)) {
          throw new InputError("Content tree symlink is invalid", "content_store_tree_symlink_invalid");
        }
        entries.push({
          kind: "symlink",
          mode,
          pathSegmentsBase64url,
          targetBase64url: encodeBase64urlBytes(target),
          targetByteLength: target.byteLength,
          targetSha256: sha256(target),
        });
        continue;
      }
      throw new InputError("Content tree special entry is forbidden", "content_store_tree_special_forbidden");
    }
    const after = lstatSync(directoryPath, { bigint: true, throwIfNoEntry: false });
    if (!after || !sameDirectoryIdentity(before, after)) {
      throw new InputError("Content tree directory changed", "content_store_tree_directory_changed");
    }
  };

  visit([]);
  const tree = createContentTree(entries);
  const blobs = [...blobsByDigest.values()].toSorted((left, right) => left.sha256.localeCompare(right.sha256));
  verifyContentTreeBlobSet(tree, new Set(blobs.map((blob) => blob.sha256)));
  return deepFreeze({ tree, blobs, logicalByteLength });
}

function canonicalSourceRoot(input: string): string {
  if (!isAbsolute(input) || resolve(input) !== input || input.includes("\0")) {
    throw new InputError("Content source root is invalid", "content_store_source_root_invalid");
  }
  let canonical: string;
  try {
    canonical = realpathSync(input);
  } catch {
    throw new InputError("Content source root is unavailable", "content_store_source_root_invalid");
  }
  const stats = lstatSync(input, { bigint: true, throwIfNoEntry: false });
  if (canonical !== input || !stats?.isDirectory() || stats.isSymbolicLink()) {
    throw new InputError("Content source root is aliased", "content_store_source_root_invalid");
  }
  return canonical;
}

function rawChildPath(root: string, segments: readonly Buffer[]): Buffer {
  const values = [Buffer.from(root), ...segments.flatMap((segment) => [Buffer.from("/"), segment])];
  return Buffer.concat(values);
}

function readStableFile(path: Buffer, before: BigIntStats): Buffer {
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!after || !sameFileIdentity(before, after) || bytes.byteLength !== Number(after.size)) {
    throw new InputError("Content tree file changed", "content_store_tree_file_changed");
  }
  return bytes;
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.uid === right.uid && left.gid === right.gid &&
    left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}
