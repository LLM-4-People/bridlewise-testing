import { mkdirSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { relativePathViolationKinds } from "../../src/filesystem/path-boundary.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import {
  acquireQualifiedTestRepositoryRootCapability,
  acquireRepositoryLocalTestRootCapability,
  deriveQualifiedTestRepositoryReadCapability,
  terminateRepositoryRootCapability,
  type RepositoryRootCapability,
  type RepositoryRootCapabilityTermination,
} from "../../src/filesystem/repository-root-capability-internal.ts";
import {
  qualifiedSafeRepositoryRootAccess,
  type SafeRepositoryRootAccess,
} from "../../scripts/verification/safe-repository-reader.ts";
import { createWorkingCopy } from "../../src/git/working-copy.ts";
import { createOwnedTemporaryDirectory, ensurePrivateStateDirectory, removeOwnedTemporaryDirectory } from "../../src/filesystem/private-state.ts";
import { buildOutputPaths } from "../../src/workflow/hash-binding-registry.ts";
import { applyCheckoutFiles, installedDependencyLinks } from "../../src/workflow/checkout-setup.ts";

export const TEST_REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPOSITORY_LOCAL_TEMPORARY_ROOT = join(
  TEST_REPOSITORY_ROOT,
  ROOT_POLICY.verification.testFixtures.repositoryLocalTemporaryRoot,
);

let ownedTemporaryRoot: string | undefined;
let qualifiedRepositoryRootCapability: RepositoryRootCapability | undefined;
let qualifiedRepositoryReadCapability: RepositoryRootCapability | undefined;
const QUALIFIED_TEMPORARY_CAPABILITIES = new Map<string, RepositoryRootCapability>();
const OWNED_TEMPORARY_DIRECTORIES = new Set<string>();

export type QualifiedRepositoryLocalTemporaryDirectory = Readonly<{
  path: string;
  access: SafeRepositoryRootAccess;
}>;

/**
 * CLEANUP IS REGISTERED BY THE THING THAT CREATES THE MESS, not remembered by
 * each caller.
 *
 * `removeRepositoryLocalTemporaryRoot` existed and several files called it
 * from their own `after` hook. Several did not, and every one of those leaked
 * one `owner-*` directory per process, for ever: the repository held 4938 of
 * them, growing by roughly sixteen on every `npm test`. That is the signature
 * of a list somebody has to remember — the cleanest evidence there is that the
 * obligation was in the wrong place.
 *
 * So the FIRST creation registers the removal. A file that creates a fixture
 * cleans up because it created one, not because somebody wrote a hook; a file
 * that creates none registers nothing. The existing explicit calls stay valid
 * and are idempotent, so nothing had to change at those call sites either.
 *
 * AND A PROCESS THAT NEVER REACHES ITS EXIT HANDLER LEAVES NOTHING FOR EVER.
 * `exit` handlers do not run for a process killed by a signal — a test file
 * the runner aborts at its timeout or its stall, a run killed by hand, the OOM
 * killer — and each of those left its whole `owner-*` root behind: four roots
 * (360 MB of working copies, the newest a month old) were found in the live
 * checkout. The root is therefore an OWNED temporary (named `owner-<pid>-<start
 * time>-<nonce>`, `src/filesystem/private-state.ts`), and creating one first
 * sweeps the roots whose owners are dead. The folders inside it are this
 * process's own and need no owner of their own: a counter names them.
 */
function getOwnedTemporaryRoot(): string {
  if (ownedTemporaryRoot !== undefined) return ownedTemporaryRoot;
  // PROCESS SCOPE, NOT TEST SCOPE, and the distinction is load-bearing:
  // `after()` called from inside a running test registers on THAT test's
  // context, so the root was removed while later tests in the same file were
  // still using it (measured: "repository-local test fixture path is outside
  // its authority"). The owned root belongs to the PROCESS that created it:
  // the owner removes it when the process exits. Files that call
  // `removeRepositoryLocalTemporaryRoot` from their own hook remove it earlier.
  ownedTemporaryRoot = createOwnedTemporaryDirectory(ensurePrivateStateDirectory(REPOSITORY_LOCAL_TEMPORARY_ROOT), "owner-");
  return ownedTemporaryRoot;
}
/** Names the folders inside this process's owned root, which only this process writes. */
let temporaryDirectoriesCreated = 0;

export function createRepositoryLocalTemporaryDirectory(prefix: string): string {
  if (relativePathViolationKinds(prefix).length > 0 || prefix.length === 0 || prefix.includes("/")) {
    throw new Error("repository-local test fixture prefix is invalid");
  }
  temporaryDirectoriesCreated += 1;
  const path = join(getOwnedTemporaryRoot(), `${prefix}${String(temporaryDirectoriesCreated)}`);
  mkdirSync(path, { mode: 0o700 });
  OWNED_TEMPORARY_DIRECTORIES.add(path);
  return path;
}

export type RepositoryWorkingCopy = Readonly<{
  /** The copy of the repository's top level. */
  root: string;
  /** The engine root inside the copy — the tree the harness commands run on. */
  engineRoot: string;
}>;

/**
 * A private working copy of this repository, for a test that drives a
 * WRITE-MODE generator (`harness sync`, `harness regenerate`, `harness
 * register --write` rewrite tracked generated files whenever the tree they
 * are given disagrees with them). Pointed at the live checkout, such a test
 * rewrote three tracked files of the real repository during a full run.
 *
 * Built by the one working-copy builder (`src/git/working-copy.ts`) with a
 * MIRRORED git: its own repository, the live HEAD and a copy of the live
 * index, so every git question a generator asks (the conservation identity's
 * tracked set, untracked test sources, ignore rules) is answered by the copy
 * exactly as by the checkout it mirrors — never by the live repository from an
 * ignored subdirectory. What it holds besides the owned bytes is the pinned
 * build outputs (the hash-binding registry's `build-output` bindings, e.g. the
 * bundle), which the commands verify. It sits under the repository-local
 * fixture root, so dependencies resolve upward to the live `node_modules`.
 *
 * `include` narrows the population (repository-relative paths) for a test
 * that needs less than the whole tree; the whole owned repository is the
 * default because engine sources import sibling roots (`../shared/`).
 */
export function createRepositoryWorkingCopy(
  prefix: string,
  options: Readonly<{ include?: (repositoryPath: string) => boolean }> = {},
): RepositoryWorkingCopy {
  const root = createRepositoryLocalTemporaryDirectory(prefix);
  const copy = createWorkingCopy({
    sourceRoot: TEST_REPOSITORY_ROOT,
    targetRoot: root,
    git: "mirror",
    carry: buildOutputPaths(),
    ...(options.include === undefined ? {} : { include: options.include }),
  });
  // The installed dependencies, linked at their own places (the commit guard's staged tree does the same): every
  // command in the copy, the bundle rebuild `harness check` compares with included, resolves what the checkout does.
  const engineRelative = engineRelativePath(copy.sourceRoot);
  const linked = applyCheckoutFiles(copy.root, copy.sourceRoot, engineRelative, { links: installedDependencyLinks(copy.sourceRoot) });
  const failed = linked.filter((step) => step.status === "fail");
  if (failed.length > 0) throw new Error(`the working copy's dependencies could not be linked: ${failed.map((step) => step.message).join("; ")}`);
  return Object.freeze({ root: copy.root, engineRoot: join(copy.root, engineRelative) });
}

/**
 * The population a generator test needs: the engine and the repository-root
 * `shared/` its sources import. The web tree (about half the bytes) is never
 * read by the engine's generators; in a mirrored copy it stays in the index as
 * skip-worktree, so the tracked set is still the checkout's.
 */
export function engineGeneratorPopulation(repositoryPath: string): boolean {
  return repositoryPath.startsWith("engine/") || repositoryPath.startsWith("shared/");
}

function engineRelativePath(repositoryRoot: string): string {
  return relative(repositoryRoot, TEST_REPOSITORY_ROOT).split(sep).join("/");
}


export function createQualifiedRepositoryLocalTemporaryDirectory(
  prefix: string,
): QualifiedRepositoryLocalTemporaryDirectory {
  const path = createRepositoryLocalTemporaryDirectory(prefix);
  try {
    const capability = acquireRepositoryLocalTestRootCapability(qualifiedRepositoryRoot(), path);
    QUALIFIED_TEMPORARY_CAPABILITIES.set(path, capability);
    return Object.freeze({ path, access: qualifiedSafeRepositoryRootAccess(capability) });
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    OWNED_TEMPORARY_DIRECTORIES.delete(path);
    throw error;
  }
}

export function qualifiedTestRepositoryRootReadAccess(): SafeRepositoryRootAccess {
  qualifiedRepositoryReadCapability ??= deriveQualifiedTestRepositoryReadCapability(qualifiedRepositoryRoot());
  return qualifiedSafeRepositoryRootAccess(qualifiedRepositoryReadCapability);
}

/**
 * `pass` with a read access on a capability of ITS OWN, closed when the pass
 * ends: a capability's borrow budget (`maximumBorrowOperationsPerCapability`)
 * is per capability, and the shared one above is spent by every read of the
 * process, so two whole-tree passes on it exceed the budget once the tree is
 * past half of it. One live read capability per root at a time: a pass runs
 * while the shared one is not live.
 */
export function withSeparateTestRepositoryRootReadAccess<T>(pass: (access: SafeRepositoryRootAccess) => T): T {
  const capability = deriveQualifiedTestRepositoryReadCapability(qualifiedRepositoryRoot());
  try {
    return pass(qualifiedSafeRepositoryRootAccess(capability));
  } finally {
    terminateRepositoryRootCapability(capability, "closed");
  }
}

export function qualifiedTestRepositoryRootCreationCapabilityForQualification(): RepositoryRootCapability {
  return qualifiedRepositoryRoot();
}

export function terminateQualifiedRepositoryLocalTemporaryDirectory(
  fixture: QualifiedRepositoryLocalTemporaryDirectory,
  disposition: RepositoryRootCapabilityTermination,
): void {
  const capability = QUALIFIED_TEMPORARY_CAPABILITIES.get(fixture.path);
  if (capability === undefined || fixture.access.acquisition !== "qualified-capability" ||
    fixture.access.capability !== capability) {
    throw new Error("qualified repository-local test fixture authority is invalid");
  }
  terminateRepositoryRootCapability(capability, disposition);
  QUALIFIED_TEMPORARY_CAPABILITIES.delete(fixture.path);
  rmSync(fixture.path, { recursive: true, force: true });
}

export function removeRepositoryLocalTemporaryDirectory(path: string): void {
  if (ownedTemporaryRoot === undefined || !OWNED_TEMPORARY_DIRECTORIES.has(path)) {
    throw new Error("repository-local test fixture path is outside its authority");
  }
  const capability = QUALIFIED_TEMPORARY_CAPABILITIES.get(path);
  if (capability !== undefined) {
    terminateRepositoryRootCapability(capability, "closed");
    QUALIFIED_TEMPORARY_CAPABILITIES.delete(path);
  }
  rmSync(path, { recursive: true, force: true });
  OWNED_TEMPORARY_DIRECTORIES.delete(path);
}

export function removeRepositoryLocalTemporaryRoot(): void {
  for (const [path, capability] of [...QUALIFIED_TEMPORARY_CAPABILITIES.entries()].toSorted()) {
    terminateRepositoryRootCapability(capability, "closed");
    QUALIFIED_TEMPORARY_CAPABILITIES.delete(path);
  }
  if (ownedTemporaryRoot !== undefined) {
    removeOwnedTemporaryDirectory(ownedTemporaryRoot);
    ownedTemporaryRoot = undefined;
  }
  OWNED_TEMPORARY_DIRECTORIES.clear();
  if (qualifiedRepositoryReadCapability !== undefined) {
    terminateRepositoryRootCapability(qualifiedRepositoryReadCapability, "closed");
    qualifiedRepositoryReadCapability = undefined;
  }
  if (qualifiedRepositoryRootCapability !== undefined) {
    terminateRepositoryRootCapability(qualifiedRepositoryRootCapability, "closed");
    qualifiedRepositoryRootCapability = undefined;
  }
}

function qualifiedRepositoryRoot(): RepositoryRootCapability {
  qualifiedRepositoryRootCapability ??= acquireQualifiedTestRepositoryRootCapability();
  return qualifiedRepositoryRootCapability;
}
