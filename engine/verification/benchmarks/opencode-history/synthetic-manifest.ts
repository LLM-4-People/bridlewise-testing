import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { sha256 } from "../../../src/kernel/integrity.ts";
import {
  SCOPE_MANIFEST_FORMAT,
  parseSyntheticScopeManifest,
  SCOPE_GUARD_LIMITS,
  normalizeScopeGuardError,
  ScopeGuardError,
  VERIFY_OPERATION,
  type ExactFileIdentity,
  type SyntheticScopeManifest,
  validateAbsoluteScopePath,
  validateRelativePath,
} from "./scope-guard.ts";

export interface SyntheticManifestInput {
  readonly syntheticSandboxRoot: string;
  readonly root: string;
  readonly exactFiles: readonly Readonly<{ id: string; relativePath: string }>[];
  readonly transcriptTainted?: boolean;
}

export async function prepareSyntheticManifest(input: SyntheticManifestInput): Promise<string> {
  try {
    return await prepareSyntheticManifestInternal(input);
  } catch (error) {
    throw normalizeScopeGuardError(error);
  }
}

async function prepareSyntheticManifestInternal(input: SyntheticManifestInput): Promise<string> {
  if (input.transcriptTainted !== undefined && input.transcriptTainted !== false) {
    throw new ScopeGuardError("scope_tainted_claim_denied");
  }
  if (input.exactFiles.length === 0 || input.exactFiles.length > SCOPE_GUARD_LIMITS.maximumFiles) {
    throw new ScopeGuardError("scope_invalid_manifest");
  }
  const sandbox = await exactCanonicalDirectory(input.syntheticSandboxRoot);
  const root = await exactCanonicalDirectory(input.root);
  if (!isStrictDescendant(sandbox, root)) throw new ScopeGuardError("scope_outside_sandbox");
  const rootInfo = await lstat(root, { bigint: true });
  const ids = new Set<string>();
  const paths = new Set<string>();
  const inodes = new Set<string>();
  const files: ExactFileIdentity[] = [];

  for (const exactFile of input.exactFiles) {
    if (ids.has(exactFile.id) || paths.has(exactFile.relativePath)) {
      throw new ScopeGuardError("scope_duplicate");
    }
    const components = validateRelativePath(exactFile.relativePath);
    const candidate = resolve(root, ...components);
    if (!isStrictDescendant(root, candidate)) throw new ScopeGuardError("scope_traversal_denied");
    const info = await lstat(candidate, { bigint: true });
    if (info.isSymbolicLink()) throw new ScopeGuardError("scope_symlink_denied");
    if (!info.isFile()) throw new ScopeGuardError("scope_not_regular");
    if (info.nlink !== 1n) throw new ScopeGuardError("scope_hardlink_denied");
    if (info.dev !== rootInfo.dev) throw new ScopeGuardError("scope_cross_device");
    if ((await realpath(candidate)) !== candidate) throw new ScopeGuardError("scope_ambiguous");
    const inodeKey = `${info.dev}:${info.ino}`;
    if (inodes.has(inodeKey)) throw new ScopeGuardError("scope_duplicate");

    const handle = await open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) {
        throw new ScopeGuardError("scope_changed");
      }
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
      const after = await handle.stat({ bigint: true });
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) {
        throw new ScopeGuardError("scope_changed");
      }
      files.push({
        id: exactFile.id,
        relativePath: exactFile.relativePath,
        sha256: sha256(bytes),
        byteLength: bytes.length,
        device: opened.dev.toString(),
        inode: opened.ino.toString(),
      });
    } finally {
      await handle.close();
    }
    ids.add(exactFile.id);
    paths.add(exactFile.relativePath);
    inodes.add(inodeKey);
  }
  if (files.length === 0) throw new ScopeGuardError("scope_invalid_manifest");

  const manifest: SyntheticScopeManifest = {
    format: SCOPE_MANIFEST_FORMAT,
    fixtureClass: "generated-synthetic-only",
    rootRealpath: root,
    rootDevice: rootInfo.dev.toString(),
    rootInode: rootInfo.ino.toString(),
    operation: VERIFY_OPERATION,
    files,
    transcriptTainted: false,
  };
  const manifestJson = JSON.stringify(manifest);
  parseSyntheticScopeManifest(manifestJson);
  return manifestJson;
}

async function exactCanonicalDirectory(path: string): Promise<string> {
  validateAbsoluteScopePath(path);
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink()) throw new ScopeGuardError("scope_symlink_denied");
  if (!info.isDirectory()) throw new ScopeGuardError("scope_not_regular");
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) throw new ScopeGuardError("scope_ambiguous");
  return canonical;
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot.length > 0 && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}
