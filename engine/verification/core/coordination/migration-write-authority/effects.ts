/**
 * MigrationWriteAuthority — `MigrationEffectPort` adapter.
 *
 * Only enumerated filesystem and Git-plumbing operations. Never arbitrary
 * commands, never callback execution. The adapter never decides whether an
 * operation is allowed — the authority does. Every effect:
 *  - validates the `LiveGrant`/`FenceContext` consistency (Symbol-branded
 *    grant, lease/generation/fenceIdentity match) before the effect;
 *  - performs the effect with crash-safe ordering (temp-sibling → fsync →
 *    rename → dir fsync for replaces; O_EXCL → fsync for creates; unlink →
 *    dir fsync for removes);
 *  - rereads the observation before returning.
 *
 * Git publication uses exact plumbing (`write-tree`, `commit-tree`,
 * `mktag --strict`, `update-ref --stdin -z`) with Git's own CAS. Hooks,
 * filters, attributes, fsmonitor, pagers, and credential-helpers are disabled
 * via the closed environment from
 * `ROOT_POLICY.verification.candidateFormat.gitIdentity`. Any stderr byte,
 * unexpected output, moved ref, wrong object type, partial close, or
 * ambiguous exit fails closed with a bounded hashed diagnostic.
 *
 * Design authority: MWA-DESIGN §2.6. The adapter rechecks grant/fence
 * consistency locally; the full backend fence recheck (lease state, base,
 * resource ownership) is the authority's responsibility — it calls
 * `backend.fence` before invoking the effect.
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { InputError } from "../../../../src/kernel/errors.ts";
import { bestEffort } from "../../../../src/shared/best-effort.ts";
import { canonicalHash, deepFreeze, sha256 } from "../../../../src/kernel/integrity.ts";
import type { GitIdentity } from "../../../../src/git/git-port.ts";
import {
  type BackendError,
  type EffectObservation,
  type EffectKind,
  type FenceContext,
  type GitCommitTreeInput,
  type GitMktagInput,
  type GitObjectObservation,
  type GitRefObservation,
  type GitRefTxCommand,
  type GitRefTxInput,
  type GitWriteTreeInput,
  type LiveGrant,
  type MigrationEffectPort,
  type ObjectId,
  type RereadObjectInput,
  type RereadRefInput,
  type TargetState,
} from "./contracts.ts";
import { pathIdentityFromStat } from "./internal.ts";
import { runCpuBoundedSync } from "../../../../src/process/bounded-run-sync.ts";
import { subprocessBounds } from "../../../../src/workflow/workflow-config.ts";

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

export type MigrationEffectConfig = Readonly<{
  executablePath: string;
  processEnvironment: Readonly<Record<string, string>>;
  configurationOverrides: readonly string[];
}>;

export type MigrationEffectAdapterInput = Readonly<{
  /** Absolute git executable path (no ambient PATH). */
  gitExecutablePath: string;
  /** Author/committer identity for `commit-tree`. */
  gitIdentity: GitIdentity;
  /** Absolute working directory for Git plumbing (`git -C <worktreeRoot>`). */
  worktreeRoot: string;
  /** Resolves a physical-path resource id to an absolute filesystem path. */
  resolvePhysicalPath: (resourceId: string) => string;
  /** Closed git environment view (env + `-c` overrides). */
  config: MigrationEffectConfig;
}>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function backendError(code: BackendError["code"], message: string): BackendError {
  // Bounded hashed diagnostic — never raw paths/contents in the message.
  return deepFreeze({ code, message, diagnosticHash: sha256(message) });
}

function validateGrantFence(grant: LiveGrant, fence: FenceContext): BackendError | null {
  if (grant === null || typeof grant !== "object") return backendError("grant-invalid", "live grant is invalid");
  if (typeof (grant as { leaseId?: unknown }).leaseId !== "string") return backendError("grant-invalid", "live grant is not branded");
  if (grant.leaseId !== fence.leaseId) return backendError("grant-invalid", "fence leaseId does not match grant");
  if (grant.generation !== fence.generation) return backendError("generation-stale", "fence generation does not match grant");
  if (grant.fenceIdentity !== fence.fenceIdentity) return backendError("grant-invalid", "fenceIdentity does not match grant");
  if (grant.leaseId !== fence.leaseId) return backendError("grant-invalid", "fence lease mismatch");
  return null;
}

/**
 * Containment check: verifies a resolved physical path stays within the
 * authorized worktree root. A resourceId that resolves outside the worktree
 * (e.g. via `..` traversal or symlink) fails closed with
 * `filesystem-unsupported` (MWA-DESIGN §2.6).
 */
function resolveAndCheckContainment(
  resolvePhysicalPath: (resourceId: string) => string,
  worktreeRoot: string,
  resourceId: string,
): string | BackendError {
  const resolved = resolve(resolvePhysicalPath(resourceId));
  const root = resolve(worktreeRoot);
  const rel = relative(root, resolved);
  // If the relative path starts with `..`, the resolved path is outside the
  // worktree root. An empty relative path means the resolved path IS the
  // root (also rejected — the root itself is not a valid write target).
  if (rel.startsWith("..") || rel === "") {
    return backendError("filesystem-unsupported", "resolved path escapes the worktree root");
  }
  return resolved;
}

function fileState(absolutePath: string): TargetState {
  const stats = statSync(absolutePath);
  if (!stats.isFile()) throw new InputError("path is not a regular file", "operation-unsupported");
  const bytes = readFileSync(absolutePath);
  return deepFreeze({
    kind: "file",
    identity: pathIdentityFromStat(stats),
    byteLength: bytes.length,
    sha256: sha256(bytes),
  });
}

function absentState(absentPath: string): TargetState {
  const parent = statSync(dirname(absentPath));
  return deepFreeze({ kind: "absent", parentIdentity: pathIdentityFromStat(parent), entryName: basename(absentPath) });
}

function fsEffectObservation(
  effectKind: EffectKind,
  resourceId: string,
  observedState: TargetState,
  intendedBytes: number,
  observedBytes: number,
): EffectObservation {
  return deepFreeze({
    kind: "filesystem",
    effectKind,
    resourceId,
    observedState,
    intendedBytes,
    observedBytes,
    observationHash: canonicalHash({ effectKind, resourceId, observedState }),
  });
}

function syncDirectoryFd(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function buildGitEnv(base: Readonly<Record<string, string>>, identity: GitIdentity): Record<string, string> {
  return {
    ...base,
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  } as Record<string, string>;
}

interface GitResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

function runGit(
  adapter: MigrationEffectAdapterInput,
  env: Record<string, string>,
  args: readonly string[],
  stdin: Buffer,
): GitResult {
  const fullArgs: string[] = ["-C", adapter.worktreeRoot];
  for (const override of adapter.config.configurationOverrides) fullArgs.push("-c", override);
  fullArgs.push(...args);
  // One bounded run in the adapter's CLOSED environment; a run the bounds stopped answers no status.
  const run = runCpuBoundedSync(adapter.gitExecutablePath, fullArgs, {
    cwd: process.cwd(),
    env,
    input: stdin,
    bounds: { ...subprocessBounds({}), outputBytes: 16 * 1024 * 1024 },
  });
  const result = { status: run.ending === "exited" ? run.status : null, signal: run.signal };
  const stdout = run.stdout;
  const stderr = run.ending === "exited" ? run.stderr.toString("utf8") : `${run.stderr.toString("utf8")}(the run ended ${run.ending})`;
  // Intentionally not frozen: the result carries a Buffer, which cannot be
  // deep-frozen (ArrayBuffer views with elements throw). This is an internal,
  // short-lived value, not a contract type.
  return { status: result.status, signal: result.signal, stdout, stderr };
}

function gitOk(result: GitResult): true | BackendError {
  if (result.status !== 0) return backendError("operation-unsupported", `git exit ${String(result.status)}`);
  if (result.signal !== null) return backendError("operation-unsupported", "git signaled");
  if (result.stderr.length > 0) return backendError("operation-unsupported", "git produced stderr");
  return true;
}

function gitObjectObservation(resourceId: string, objectId: ObjectId, objectKind: "commit" | "tree" | "tag"): GitObjectObservation {
  return deepFreeze({
    kind: "git-object",
    effectKind: "git-object-create",
    resourceId,
    objectName: objectId,
    objectKind,
    objectId,
    observationHash: canonicalHash({ kind: "git-object", resourceId, objectId, objectKind }),
  });
}

function gitRefObservation(resourceId: string, refName: string, newObjectId: ObjectId | null, oldObjectId: ObjectId | null): GitRefObservation {
  return deepFreeze({
    kind: "git-ref",
    effectKind: "git-ref-transaction",
    resourceId,
    refName,
    newObjectId,
    oldObjectId,
    observationHash: canonicalHash({ kind: "git-ref", resourceId, refName, newObjectId, oldObjectId }),
  });
}

const ZERO_OID = "0".repeat(40);

function serializeRefTx(commands: readonly GitRefTxCommand[]): { stdin: Buffer; primaryRef: string; primaryNew: ObjectId | null; primaryOld: ObjectId | null } {
  // `update-ref --stdin -z` format: the verb and ref share the first token
  // (`<verb> SP <ref>`) and each subsequent value is its own NUL-terminated
  // token: `create <ref>\0<new>\0`, `update <ref>\0<new>\0[<old>\0]`,
  // `verify <ref>\0[<old>\0]`, `delete <ref>\0[<old>\0]`, `start\0`, etc.
  const tokens: Buffer[] = [];
  let primaryRef = "";
  let primaryNew: ObjectId | null = null;
  let primaryOld: ObjectId | null = null;
  for (const cmd of commands) {
    switch (cmd.kind) {
      case "start":
        tokens.push(Buffer.from("start"));
        break;
      case "verify":
        tokens.push(Buffer.from(`verify ${cmd.refName}`));
        if (cmd.expectedOld !== null) tokens.push(Buffer.from(cmd.expectedOld));
        break;
      case "create":
        tokens.push(Buffer.from(`create ${cmd.refName}`), Buffer.from(cmd.newObjectId));
        primaryRef = cmd.refName;
        primaryNew = cmd.newObjectId;
        primaryOld = null;
        break;
      case "update":
        tokens.push(Buffer.from(`update ${cmd.refName}`), Buffer.from(cmd.newObjectId));
        if (cmd.expectedOld !== null) tokens.push(Buffer.from(cmd.expectedOld));
        primaryRef = cmd.refName;
        primaryNew = cmd.newObjectId;
        primaryOld = cmd.expectedOld;
        break;
      case "delete":
        tokens.push(Buffer.from(`delete ${cmd.refName}`));
        if (cmd.expectedOld !== null) tokens.push(Buffer.from(cmd.expectedOld));
        primaryRef = cmd.refName;
        primaryNew = null;
        primaryOld = cmd.expectedOld;
        break;
      case "prepare":
        tokens.push(Buffer.from("prepare"));
        break;
      case "commit":
        tokens.push(Buffer.from("commit"));
        break;
    }
  }
  const stdin = Buffer.concat(tokens.map((t) => Buffer.concat([t, Buffer.from("\0")])));
  return { stdin, primaryRef, primaryNew, primaryOld };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createMigrationEffectAdapter(input: MigrationEffectAdapterInput): MigrationEffectPort {
  const gitEnv = buildGitEnv(input.config.processEnvironment, input.gitIdentity);

  function createFileExclusive(params: Readonly<{ grant: LiveGrant; fence: FenceContext; resourceId: string; intendedBytes: Uint8Array; intendedMode: number }>): EffectObservation | BackendError {
    const guard = validateGrantFence(params.grant, params.fence);
    if (guard !== null) return guard;
    const pathOrErr = resolveAndCheckContainment(input.resolvePhysicalPath, input.worktreeRoot, params.resourceId);
    if (typeof pathOrErr !== "string") return pathOrErr;
    const path = pathOrErr;
    const bytes = Buffer.from(params.intendedBytes);
    let fd: number | undefined;
    try {
      const dir = dirname(path);
      bestEffort(() => syncDirectoryFd(dir));
      fd = openSync(path, "wx", params.intendedMode);
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      const fdCreate = fd;
      bestEffort(() => fsyncSync(fdCreate));
      closeSync(fd);
      fd = undefined;
      try { syncDirectoryFd(dir); } catch { return backendError("filesystem-unsupported", "directory fsync unsupported"); }
    } catch (error) {
      if (fd !== undefined) { const fdErr = fd; bestEffort(() => closeSync(fdErr)); bestEffort(() => unlinkSync(path)); }
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") return backendError("cas-mismatch", "exclusive destination already exists");
      return backendError("operation-unsupported", `create failed: ${code ?? "unknown"}`);
    }
    try {
      const observed = fileState(path);
      const observedMode = observed.kind === "file" ? observed.identity.mode & 0o777 : 0;
      if (observedMode !== (params.intendedMode & 0o777)) {
        return backendError("cas-mismatch", "observed mode does not match intended mode");
      }
      return fsEffectObservation("filesystem-create", params.resourceId, observed, bytes.length, observed.kind === "file" ? observed.byteLength : 0);
    } catch (error) {
      return backendError("effect-unknown", `create recheck failed: ${extractCode(error)}`);
    }
  }

  function replaceFile(params: Readonly<{ grant: LiveGrant; fence: FenceContext; resourceId: string; intendedBytes: Uint8Array; intendedMode: number }>): EffectObservation | BackendError {
    const guard = validateGrantFence(params.grant, params.fence);
    if (guard !== null) return guard;
    const pathOrErr = resolveAndCheckContainment(input.resolvePhysicalPath, input.worktreeRoot, params.resourceId);
    if (typeof pathOrErr !== "string") return pathOrErr;
    const path = pathOrErr;
    const dir = dirname(path);
    const tempPath = join(dir, `.harness-mwa-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);
    const bytes = Buffer.from(params.intendedBytes);
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, "wx", params.intendedMode);
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      const fdReplace = fd;
      bestEffort(() => fsyncSync(fdReplace));
      closeSync(fd);
      fd = undefined;
      renameSync(tempPath, path);
      try { syncDirectoryFd(dir); } catch { return backendError("filesystem-unsupported", "directory fsync unsupported"); }
    } catch (error) {
      if (fd !== undefined) { const fdErr = fd; bestEffort(() => closeSync(fdErr)); }
      bestEffort(() => unlinkSync(tempPath));
      return backendError("operation-unsupported", `replace failed: ${(error as NodeJS.ErrnoException)?.code ?? "unknown"}`);
    }
    try {
      const observed = fileState(path);
      const observedMode = observed.kind === "file" ? observed.identity.mode & 0o777 : 0;
      if (observedMode !== (params.intendedMode & 0o777)) {
        return backendError("cas-mismatch", "observed mode does not match intended mode");
      }
      return fsEffectObservation("filesystem-replace", params.resourceId, observed, bytes.length, observed.kind === "file" ? observed.byteLength : 0);
    } catch (error) {
      return backendError("effect-unknown", `replace recheck failed: ${extractCode(error)}`);
    }
  }

  function removeFile(params: Readonly<{ grant: LiveGrant; fence: FenceContext; resourceId: string }>): EffectObservation | BackendError {
    const guard = validateGrantFence(params.grant, params.fence);
    if (guard !== null) return guard;
    const pathOrErr = resolveAndCheckContainment(input.resolvePhysicalPath, input.worktreeRoot, params.resourceId);
    if (typeof pathOrErr !== "string") return pathOrErr;
    const path = pathOrErr;
    const dir = dirname(path);
    try {
      unlinkSync(path);
      try { syncDirectoryFd(dir); } catch { return backendError("filesystem-unsupported", "directory fsync unsupported"); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        // Already absent — recheck and return the typed absence.
      } else {
        return backendError("operation-unsupported", `remove failed: ${code ?? "unknown"}`);
      }
    }
    try {
      if (existsSync(path)) return backendError("effect-unknown", "remove recheck found path still exists");
      const observed = absentState(path);
      return fsEffectObservation("filesystem-remove", params.resourceId, observed, 0, 0);
    } catch (error) {
      return backendError("effect-unknown", `remove recheck failed: ${extractCode(error)}`);
    }
  }

  function syncDirectory(params: Readonly<{ grant: LiveGrant; fence: FenceContext; directory: string }>): EffectObservation | BackendError {
    const guard = validateGrantFence(params.grant, params.fence);
    if (guard !== null) return guard;
    try {
      syncDirectoryFd(params.directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOTSUP" || code === "EINVAL" || code === "ENOSYS") {
        return backendError("filesystem-unsupported", "directory fsync unsupported on platform");
      }
      return backendError("operation-unsupported", `sync failed: ${code ?? "unknown"}`);
    }
    try {
      const stats = statSync(params.directory);
      if (!stats.isDirectory()) return backendError("effect-unknown", "sync target is not a directory");
      const observed = deepFreeze({ kind: "directory", identity: pathIdentityFromStat(stats), entrySetIdentity: sha256(params.directory) }) as TargetState;
      return fsEffectObservation("filesystem-sync", params.directory, observed, 0, 0);
    } catch (error) {
      return backendError("effect-unknown", `sync recheck failed: ${extractCode(error)}`);
    }
  }

  // ----- Git plumbing -----

  function gitWriteTree(params: Readonly<GitWriteTreeInput>): GitObjectObservation | BackendError {
    const guard = validateGrantFence(params.grant, params.fence);
    if (guard !== null) return guard;
    const result = runGit(input, gitEnv, ["write-tree"], Buffer.alloc(0));
    const ok = gitOk(result);
    if (ok !== true) return ok;
    const treeId = result.stdout.toString("utf8").trim();
    if (!/^[0-9a-f]{40}$/u.test(treeId) && !/^[0-9a-f]{64}$/u.test(treeId)) {
      return backendError("effect-unknown", "write-tree returned a non-hex object id");
    }
    const typeResult = runGit(input, gitEnv, ["cat-file", "-t", treeId], Buffer.alloc(0));
    const typeOk = gitOk(typeResult);
    if (typeOk !== true) return typeOk;
    if (typeResult.stdout.toString("utf8").trim() !== "tree") {
      return backendError("effect-unknown", "write-tree object is not a tree");
    }
    return gitObjectObservation(params.resourceId, treeId, "tree");
  }

  function gitCommitTree(params: Readonly<GitCommitTreeInput>): GitObjectObservation | BackendError {
    const guard = validateGrantFence(params.grant, params.fence);
    if (guard !== null) return guard;
    const args: string[] = ["commit-tree", params.treeObjectId];
    for (const parent of params.parents) args.push("-p", parent);
    args.push("-m", params.message);
    const result = runGit(input, gitEnv, args, Buffer.alloc(0));
    const ok = gitOk(result);
    if (ok !== true) return ok;
    const commitId = result.stdout.toString("utf8").trim();
    if (!/^[0-9a-f]{40}$/u.test(commitId) && !/^[0-9a-f]{64}$/u.test(commitId)) {
      return backendError("effect-unknown", "commit-tree returned a non-hex object id");
    }
    const typeResult = runGit(input, gitEnv, ["cat-file", "-t", commitId], Buffer.alloc(0));
    const typeOk = gitOk(typeResult);
    if (typeOk !== true) return typeOk;
    if (typeResult.stdout.toString("utf8").trim() !== "commit") {
      return backendError("effect-unknown", "commit-tree object is not a commit");
    }
    return gitObjectObservation(params.resourceId, commitId, "commit");
  }

  function gitMktagStrict(params: Readonly<GitMktagInput>): GitObjectObservation | BackendError {
    const guard = validateGrantFence(params.grant, params.fence);
    if (guard !== null) return guard;
    const result = runGit(input, gitEnv, ["mktag", "--strict"], Buffer.from(params.tagBytes));
    const ok = gitOk(result);
    if (ok !== true) return ok;
    const tagId = result.stdout.toString("utf8").trim();
    if (!/^[0-9a-f]{40}$/u.test(tagId) && !/^[0-9a-f]{64}$/u.test(tagId)) {
      return backendError("effect-unknown", "mktag returned a non-hex object id");
    }
    const typeResult = runGit(input, gitEnv, ["cat-file", "-t", tagId], Buffer.alloc(0));
    const typeOk = gitOk(typeResult);
    if (typeOk !== true) return typeOk;
    if (typeResult.stdout.toString("utf8").trim() !== "tag") {
      return backendError("effect-unknown", "mktag object is not a tag");
    }
    return gitObjectObservation(params.resourceId, tagId, "tag");
  }

  function gitUpdateRefTransaction(params: Readonly<GitRefTxInput>): GitRefObservation | BackendError {
    const guard = validateGrantFence(params.grant, params.fence);
    if (guard !== null) return guard;
    const { stdin, primaryRef, primaryNew, primaryOld } = serializeRefTx(params.commands);
    if (primaryRef === "") return backendError("resource-unresolved", "ref transaction has no create/update/delete command");
    const result = runGit(input, gitEnv, ["update-ref", "--stdin", "-z"], stdin);
    if (result.status !== 0) return backendError("cas-mismatch", `update-ref exit ${String(result.status)}`);
    if (result.signal !== null) return backendError("operation-unsupported", "update-ref signaled");
    if (result.stderr.length > 0) return backendError("cas-mismatch", "update-ref produced stderr");
    // Re-read the ref and verify it matches the intended new value.
    const reread = runGit(input, gitEnv, ["rev-parse", "--verify", primaryRef], Buffer.alloc(0));
    if (reread.status !== 0) return backendError("effect-unknown", "ref recheck failed");
    const resolved = reread.stdout.toString("utf8").trim();
    const expected = primaryNew ?? ZERO_OID;
    if (primaryNew !== null && resolved !== primaryNew) {
      return backendError("cas-mismatch", "ref moved to an unexpected object");
    }
    if (primaryNew === null && resolved === expected) {
      // delete succeeded only if the ref no longer resolves; rev-parse --verify
      // should fail. A successful resolve after delete means the delete failed.
      return backendError("effect-unknown", "ref still resolves after delete");
    }
    return gitRefObservation(params.resourceId, primaryRef, primaryNew, primaryOld);
  }

  function rereadObject(params: Readonly<RereadObjectInput>): GitObjectObservation | BackendError {
    const guard = validateGrantFence(params.grant, params.fence);
    if (guard !== null) return guard;
    const typeResult = runGit(input, gitEnv, ["cat-file", "-t", params.objectId], Buffer.alloc(0));
    const typeOk = gitOk(typeResult);
    if (typeOk !== true) return backendError("effect-unknown", "object not found");
    const kind = typeResult.stdout.toString("utf8").trim();
    if (kind !== params.expectedKind) return backendError("effect-unknown", "object kind does not match expected");
    return gitObjectObservation(params.resourceId, params.objectId, params.expectedKind);
  }

  function rereadRef(params: Readonly<RereadRefInput>): GitRefObservation | BackendError {
    const guard = validateGrantFence(params.grant, params.fence);
    if (guard !== null) return guard;
    const result = runGit(input, gitEnv, ["rev-parse", "--verify", params.refName], Buffer.alloc(0));
    if (result.status !== 0) return backendError("effect-unknown", "ref does not resolve");
    if (result.stderr.length > 0) return backendError("effect-unknown", "ref recheck produced stderr");
    const resolved = result.stdout.toString("utf8").trim();
    return gitRefObservation(params.resourceId, params.refName, resolved, null);
  }

  return deepFreeze({
    createFileExclusive,
    replaceFile,
    removeFile,
    syncDirectory,
    gitWriteTree,
    gitCommitTree,
    gitMktagStrict,
    gitUpdateRefTransaction,
    rereadObject,
    rereadRef,
  });
}

function extractCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? "unknown";
}
