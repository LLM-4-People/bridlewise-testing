/**
 * MigrationWriteAuthority — `MigrationRepositoryFactsPort` adapter.
 *
 * Read-only Git facts: resolves the common directory, git directory, object
 * store, refs directory, worktree root, index, and repository state through
 * the 13 frozen Git commands (evidence:
 * `verification/benchmarks/coordination/migration-write-authority/repository-facts-contract.mjs`
 * lines 11–25) and the five scenarios (ordinary/detached/separate/bare/
 * unborn). The adapter holds the common-directory descriptor open through the
 * acquisition, rechecks its identity before returning, and runs Git with the
 * closed environment from `ROOT_POLICY.verification.candidateFormat.gitIdentity`
 * — no ambient `PATH`, no shell.
 *
 * Design authority: MWA-DESIGN §2.5. The returned shape is the committed
 * `MigrationRepositoryFacts` contract (contracts.ts), which is the production
 * authority; the benchmark's `acquisition`/`head` fields remain evidence and
 * are not duplicated into the production contract.
 */

import { closeSync, existsSync, fstatSync, openSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";

import { InputError } from "../../../../src/kernel/errors.ts";
import { canonicalHash, deepFreeze, sha256 } from "../../../../src/kernel/integrity.ts";
import {
  type BackendError,
  type MigrationRepositoryFacts,
  type MigrationRepositoryFactsPort,
  type PathIdentity,
  type RepositoryBinding,
  type Sha256,
  type TypedAbsence,
} from "./contracts.ts";
import { pathIdentityFromStat } from "./internal.ts";
import { runCpuBoundedSync } from "../../../../src/process/bounded-run-sync.ts";
import { subprocessBounds } from "../../../../src/workflow/workflow-config.ts";

// ---------------------------------------------------------------------------
// Closed-environment view (injected from ROOT_POLICY at composition)
// ---------------------------------------------------------------------------

/**
 * The slice of `ROOT_POLICY.verification.candidateFormat.gitIdentity` the
 * adapter needs. Tranche 3 wires the real root policy; Tranche 2 takes it
 * explicitly so the foundation cascade's `ROOT_POLICY_HASH` stays stable.
 */
export type MigrationRepositoryFactsConfig = Readonly<{
  /** Absolute git executable path (no ambient PATH lookup). */
  executablePath: string;
  /** Closed process environment (GIT_OPTIONAL_LOCKS=0, GIT_CONFIG_NOSYSTEM=1,
   * HOME=/nonexistent/..., PATH=/usr/bin:/bin, …). */
  processEnvironment: Readonly<Record<string, string>>;
  /** `-c key=value` configuration overrides applied before each command. */
  configurationOverrides: readonly string[];
}>;

// ---------------------------------------------------------------------------
// Descriptor-verified path identity
// ---------------------------------------------------------------------------

/**
 * Stable identity hash of a `PathIdentity`: uses only `device`, `inode`, and
 * `kind` — the fields that uniquely identify a filesystem object without being
 * affected by benign operations that add/remove children (which change
 * `links`), chmod/chown (which change `mode`/`ownerUid`/`ownerGid`), etc. The
 * full `PathIdentity` (with `links`) is still used for descriptor rechecks that
 * detect mid-acquisition replacement; the repository binding uses this stable
 * subset so the binding survives the genesis operation creating a subdir.
 */
function stablePathIdentityHash(identity: PathIdentity): Sha256 {
  return canonicalHash({ device: identity.device, inode: identity.inode, kind: identity.kind });
}

function statPathIdentity(absolutePath: string): PathIdentity {
  return pathIdentityFromStat(statSync(absolutePath));
}

function typedAbsenceFor(absentPath: string): TypedAbsence {
  const parent = dirname(absentPath);
  const entryName = basename(absentPath);
  return deepFreeze({ kind: "absent", parentIdentity: statPathIdentity(parent), entryName });
}

// ---------------------------------------------------------------------------
// Git command runner
// ---------------------------------------------------------------------------

interface CommandEvent {
  readonly argv: readonly string[];
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runGitCommand(
  executable: string,
  repositoryLocator: string,
  overrides: readonly string[],
  env: Readonly<Record<string, string>>,
  args: readonly string[],
): CommandEvent {
  const argv: string[] = ["-C", repositoryLocator];
  for (const override of overrides) argv.push("-c", override);
  argv.push(...args);
  // One bounded run in the given CLOSED environment; a run the bounds stopped answers no status.
  const run = runCpuBoundedSync(executable, argv, { cwd: process.cwd(), env, bounds: subprocessBounds({}) });
  return deepFreeze({
    argv: Object.freeze(argv) as readonly string[],
    status: run.ending === "exited" ? run.status : null,
    signal: run.signal,
    stdout: run.stdout.toString("utf8"),
    stderr: run.ending === "exited" ? run.stderr.toString("utf8") : `${run.stderr.toString("utf8")}(the run ended ${run.ending})`,
  });
}

/** The 13 frozen repository-facts commands (evidence: benchmark lines 11–25). */
const FROZEN_COMMANDS: readonly (readonly string[])[] = Object.freeze([
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  ["rev-parse", "--path-format=absolute", "--git-dir"],
  ["rev-parse", "--absolute-git-dir"],
  ["rev-parse", "--show-toplevel"],
  ["rev-parse", "--is-bare-repository"],
  ["rev-parse", "--is-inside-work-tree"],
  ["rev-parse", "--show-object-format=storage"],
  ["rev-parse", "--verify", "HEAD"],
  ["symbolic-ref", "-q", "HEAD"],
  ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
  ["rev-parse", "--path-format=absolute", "--git-path", "refs"],
  ["rev-parse", "--path-format=absolute", "--git-path", "index"],
  ["config", "--get", "core.repositoryformatversion"],
]);

function successfulValue(event: CommandEvent, label: string): string {
  if (event.status !== 0 || event.signal !== null || event.stderr !== "") {
    throw new InputError(`repository command failed: ${label}`, "backend_corrupt");
  }
  const out = event.stdout;
  if (!out.endsWith("\n") || out.slice(0, -1).includes("\n")) {
    throw new InputError(`repository command output not a single line: ${label}`, "backend_corrupt");
  }
  return out.slice(0, -1);
}

function failedValue(event: CommandEvent, label: string): null {
  if (event.status === null || event.signal !== null) {
    throw new InputError(`repository command signaled: ${label}`, "backend_corrupt");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type MigrationRepositoryFactsAdapter = MigrationRepositoryFactsPort & {
  readonly executablePath: string;
  readonly closedEnvironment: Readonly<Record<string, string>>;
};

export function createMigrationRepositoryFactsAdapter(input: Readonly<{
  repositoryLocator: string;
  config: MigrationRepositoryFactsConfig;
}>): MigrationRepositoryFactsAdapter {
  if (typeof input.repositoryLocator !== "string" || input.repositoryLocator.length === 0) {
    throw new InputError("repositoryLocator is required", "input_invalid");
  }
  const locator = input.repositoryLocator;
  const executable = input.config.executablePath;
  const env = input.config.processEnvironment;
  const overrides = input.config.configurationOverrides;

  function acquireFacts(): MigrationRepositoryFacts {
    // Run the 13 frozen commands. The common-directory descriptor is held open
    // across the read sequence and its identity rechecked before returning.
    const commands = FROZEN_COMMANDS.map((args) => runGitCommand(executable, locator, overrides, env, args));

    const commonPath = successfulValue(commands[0]!, "common-directory");
    const gitDirectory = successfulValue(commands[1]!, "git-directory");
    const absoluteGitDirectory = successfulValue(commands[2]!, "absolute-git-directory");
    if (gitDirectory !== absoluteGitDirectory) {
      throw new InputError("git-directory commands disagree", "backend_corrupt");
    }
    const bareEvent = commands[4]!;
    const bare = successfulValue(bareEvent, "bare") === "true";
    // worktree: fails (status 128) for bare repositories.
    const worktreeEvent = commands[3]!;
    const worktreePath = bare ? failedValue(worktreeEvent, "worktree") : successfulValue(worktreeEvent, "worktree");
    const insideWorktree = successfulValue(commands[5]!, "inside-worktree") === "true";
    const objectFormat = successfulValue(commands[6]!, "object-format") as "sha1" | "sha256";
    if (objectFormat !== "sha1" && objectFormat !== "sha256") {
      throw new InputError(`unsupported object format: ${objectFormat}`, "schema-unsupported");
    }
    const objectStore = successfulValue(commands[9]!, "object-store");
    const refsDirectory = successfulValue(commands[10]!, "refs-directory");
    const indexPath = successfulValue(commands[11]!, "index");
    const repositoryFormatVersion = successfulValue(commands[12]!, "repository-format");

    // Hold the common-directory descriptor open and recheck identity.
    if (!existsSync(commonPath)) {
      throw new InputError("common directory does not exist", "backend_corrupt");
    }
    const fd = openSync(commonPath, "r");
    try {
      const initialStat = fstatSync(fd);
      if (initialStat === undefined || !initialStat.isDirectory()) {
        throw new InputError("common directory is not a directory", "backend_corrupt");
      }
      const initialIdentity = pathIdentityFromStat(initialStat);
      // Build the remaining path identities while the descriptor is held.
      const commonDirectory = statPathIdentity(commonPath);
      const gitDirIdentity = statPathIdentity(gitDirectory);
      const objectStoreIdentity = statPathIdentity(objectStore);
      const refsDirectoryIdentity = statPathIdentity(refsDirectory);
      const worktreeRoot = worktreePath === null ? null : statPathIdentity(worktreePath);
      const index = existsSync(indexPath) ? statPathIdentity(indexPath) : typedAbsenceFor(indexPath);
      // Recheck the common-directory identity before returning.
      const recheckStat = fstatSync(fd);
      if (recheckStat === undefined) {
        throw new InputError("common directory descriptor recheck failed", "backend_corrupt");
      }
      const recheckIdentity = pathIdentityFromStat(recheckStat);
      if (initialIdentity.device !== recheckIdentity.device || initialIdentity.inode !== recheckIdentity.inode || initialIdentity.mode !== recheckIdentity.mode) {
        throw new InputError("common directory identity changed during acquisition", "backend_corrupt");
      }

      // Repository binding: deterministic sha256 of the descriptor-verified
      // common directory + object store + object format. The binding uses a
      // STABLE identity subset (device + inode + kind) — NOT the full
      // `PathIdentity` (which includes `links`, `mode`, `ownerUid`, `ownerGid`
      // that change under benign operations: the genesis tool creates the
      // authority root as a subdir of the common dir, incrementing `links`;
      // git adding objects increments the object store's `links`). A binding
      // that changed across the genesis operation would make every post-
      // genesis acquire fail with `repository-mismatch`. The full
      // `PathIdentity` (with `links`) is still used for the descriptor recheck
      // above (detecting mid-acquisition replacement), but the binding must be
      // stable so the genesis-record identity matches post-genesis facts.
      // (Tranche 4 hostile-matrix root-cause fix.)
      const commonDirectoryIdentity = stablePathIdentityHash(commonDirectory);
      const objectStoreHash = stablePathIdentityHash(objectStoreIdentity);
      const repositoryIdentity = sha256([commonDirectoryIdentity, objectStoreHash, objectFormat].join("\u0000"));
      const repositoryBinding: RepositoryBinding = deepFreeze({
        repositoryIdentity,
        commonDirectoryIdentity,
        objectStoreIdentity: objectStoreHash,
        objectFormat,
      });

      return deepFreeze({
        schemaVersion: "migration-repository-facts/v1",
        repositoryLocator: locator,
        commonDirectory,
        gitDirectory: gitDirIdentity,
        objectStore: objectStoreIdentity,
        refsDirectory: refsDirectoryIdentity,
        worktreeRoot,
        index,
        repositoryState: deepFreeze({ bare, insideWorktree, objectFormat, repositoryFormatVersion }),
        repositoryBinding,
      });
    } finally {
      closeSync(fd);
    }
  }

  return deepFreeze({
    executablePath: executable,
    closedEnvironment: env,
    acquire: async (): Promise<MigrationRepositoryFacts> => acquireFacts(),
  }) as MigrationRepositoryFactsAdapter;
}

// ---------------------------------------------------------------------------
// BackendError helper (typed blocker)
// ---------------------------------------------------------------------------

export function factsBackendError(code: BackendError["code"], message: string): BackendError {
  return deepFreeze({ code, message });
}
