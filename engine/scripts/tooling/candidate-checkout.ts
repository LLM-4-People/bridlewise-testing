/**
 * CANDIDATE CHECKOUT — qualify a dirty working tree in a private, complete
 * checkout of it, without touching the checkout it came from.
 *
 *   node engine/scripts/tooling/candidate-checkout.ts create    --target <dir> [--no-setup] [--no-sync] [--prune <test path>]…
 *   node engine/scripts/tooling/candidate-checkout.ts refresh   --target <dir> [--no-sync] [--prune <test path>]…
 *   node engine/scripts/tooling/candidate-checkout.ts sync      --target <dir> [--prune <test path>]…
 *   node engine/scripts/tooling/candidate-checkout.ts diff      --target <dir>
 *   node engine/scripts/tooling/candidate-checkout.ts copy-back --target <dir>
 *   node engine/scripts/tooling/candidate-checkout.ts withdraw-imports --target <dir> --since <ISO instant>
 *   node engine/scripts/tooling/candidate-checkout.ts snapshot  --name <segment>
 *   node engine/scripts/tooling/candidate-checkout.ts create    --target <dir> --from <snapshot ref> [--no-setup] [--no-sync]
 *
 * The SOURCE is the checkout this script lives in (repository-relative, never
 * a configured path). `create` builds the candidate with the one working-copy
 * builder (`src/git/working-copy.ts`, git "stage-all"): every file the source
 * owns, byte for byte, in a repository of its own whose objects are borrowed
 * read-only from the source, whose HEAD is the source's HEAD, and whose OWN
 * index stages the whole dirty tree — the tree that would be committed. It
 * then copies the source's `core.hooksPath`, applies the declared setup
 * (`workspaceIsolation.links`, the config mode, `phases.setup`: dependency
 * installs from the candidate's own lockfiles, the guardian and test binaries,
 * the bundle, and the web suite's module cache, warmed by collecting every
 * test file (`vitest list`): a fresh candidate's first web run built ~90% of
 * its transforms during the run, so it was cold and never judged —
 * step6-readiness-2 F-2 — `src/workflow/checkout-setup.ts`, each command under
 * the native supervisor), and runs `harness sync --with-bundle`, which owns its
 * fixed point (it repeats until a pass changes nothing), staging the
 * regenerated outputs in the candidate.
 *
 * Run the suites there (`cd <dir>/engine && npm test`).
 *
 * - `refresh` re-copies whatever changed in the source since and restages —
 *   except the files the CANDIDATE authors ({@link candidateAuthoredPaths}:
 *   the regenerated outputs and the pinned build outputs they describe) that
 *   the source has not touched since the candidate's base: the source's stale
 *   bytes never overwrite or delete the candidate's regenerated ones, while a
 *   real source edit of such a file (a hand edit of a pin-bearing module) is
 *   taken and re-converged. A changed
 *   setup input (a lockfile, the guardian sources: each command's declared
 *   `inputs`) re-runs that setup command, so a refreshed candidate never
 *   qualifies on stale dependencies or binaries.
 * - `diff` lists the owned paths on which the two disagree.
 * - `copy-back` writes the authored files back into the source, SAFELY: it
 *   refuses (`candidate_source_moved`) when any other source file differs
 *   from the candidate (refresh first), and (`candidate_copy_back_conflict`)
 *   when the source's copy of an authored file changed since the candidate's
 *   base (recorded at create/refresh/copy-back), per file; it reads every
 *   file first (a missing one is `candidate_output_missing`), then commits
 *   them as ONE journaled transaction (`src/filesystem/journaled-commit.ts`:
 *   the checkout write door, backups kept until the source's `harness check`
 *   passes — a failure rolls back, `candidate_copy_back_unverified` — and a
 *   crash is recovered, rolled back, by the next run of this tool). A
 *   verified copy-back records the new base.
 *   It then IMPORTS the candidate's judged suite runs OF ITS CURRENT TREE
 *   (both ledgers: the engine's and the web's) into the source's, marked with
 *   the candidate's path (`importJudgedRuns`, src/shared/run-history.ts): the
 *   source now holds the candidate's tree, so the qualification measured
 *   there is the source's baseline — the commit guard's BASELINE WARNING
 *   reads it instead of a stale live row (step6-readiness-2 F-3). "Of its
 *   current tree": a run that STARTED after the base's `treeSince` — the
 *   instant the candidate's tree last changed (create; a refresh or sync that
 *   changed anything) — and was not a mutation run; the rows of the
 *   candidate's earlier rounds measured trees the source never holds
 *   (wf-del2-correctness NEW-1).
 * - `snapshot --name <segment>` records the SOURCE's tree as it stands (what
 *   `git add -A` would commit) under the one snapshot ref namespace
 *   (`src/git/working-copy.ts` `snapshotWorkingTree`: the real index and the
 *   checkout are never touched, and a snapshot is never the commit of record)
 *   and prints `{ref, commit, tree}` — after a copy-back it is exactly the
 *   qualified tree, and `git diff --name-status HEAD <ref>` is its change set.
 * - `create --from <ref>` builds the candidate from that snapshot instead of
 *   the live worktree (the working copy's `snapshot` mode): a verifier's copy
 *   of exactly the writer's tree, whatever the source holds by then. Only a
 *   snapshot ref is accepted (`candidate_from_not_snapshot`), and the create
 *   writes nothing to the source (no index baseline, no ref). Such a
 *   candidate stays READ-ONLY toward the source: `refresh` and `copy-back`
 *   refuse it (`candidate_from_snapshot`).
 * - `withdraw-imports` removes from the source's ledgers the rows imported
 *   from this candidate that did not measure its tree since `--since` (the
 *   repair for rows imported before that bound existed).
 *
 * THE LIVE INDEX'S PROTECTED BLOBS ARE A RECORDED FACT (`src/git/index-baseline.ts`):
 * `create` records the source's staged blobs that HEAD does not hold, and
 * every subcommand first refuses (`live_index_drifted`) a source index that
 * lost one with no commit taking its place — naming the one repair, the
 * engine CLI's `harness index repair` (`harness index status|record` are its
 * siblings; this tool owns no index verb).
 *
 * The target must be on the source's filesystem (the harness refuses a tmpfs
 * root: `safe_path_root_ancestor_mountpoint`) and absent or empty; missing
 * parent directories are created. INTERIM: A5 replaces this tool with
 * `harness workspace create --overlay` (it will reuse `checkout-setup.ts`);
 * until then the candidate is disposable (`rm -rf <dir>`).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { commitJournaled, recoverJournaledCommit } from "../../src/filesystem/journaled-commit.ts";
import { loadPinnedConfigSnapshot } from "../../src/kernel/config.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { extractErrorMessage, HarnessError, InputError } from "../../src/kernel/errors.ts";
import { canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { configuredGitIdentity, directoryGitEnvironment, repositoryToplevel } from "../../src/git/repository-ownership.ts";
import { createWorkingCopy, refreshWorkingCopy, snapshotWorkingTree, stageInCopy, workingCopyDifferences } from "../../src/git/working-copy.ts";
import { assertIndexAtBaseline, recordIndexBaseline } from "../../src/git/index-baseline.ts";
import { assertSameFilesystem, checkoutCommandRunner, configuredCheckoutCommandRunner, engineRelativePath, owedSetup, prepareCheckout, rerunChangedSetup, type CheckoutCommandRunner, type CheckoutStep, type ConvergenceReport } from "../../src/workflow/checkout-setup.ts";
import { pruneArguments } from "../../src/workflow/harness-commands.ts";
import { buildTestProcessSupervisor } from "../../guardian/build.ts";
import { generatedOutputPaths, buildOutputPaths } from "../../src/workflow/hash-binding-registry.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { importJudgedRuns, suiteLedgerPaths, withdrawImportedRuns } from "../../src/shared/run-history.ts";

const ENGINE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SUBCOMMANDS = ["create", "refresh", "sync", "diff", "copy-back", "withdraw-imports", "snapshot"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/**
 * `prune`: test files deleted on purpose, passed to `harness sync --prune` (each named; see `test_surface_prune_refused`).
 * `since`: `withdraw-imports`' bound (an ISO instant).
 */
type Options = Readonly<{ subcommand: Subcommand; target: string; setup: boolean; sync: boolean; prune: readonly string[]; since: string | null; from: string | null; name: string | null }>;

function parseArguments(argv: readonly string[]): Options {
  const [subcommand, ...rest] = argv;
  if (!SUBCOMMANDS.includes(subcommand as Subcommand)) {
    throw new InputError(`usage: candidate-checkout <${SUBCOMMANDS.join("|")}> --target <dir> [--from <snapshot ref>] [--no-setup] [--no-sync] [--prune <test path>]… [--since <ISO instant>] | snapshot --name <segment>`, "candidate_usage");
  }
  let target: string | undefined;
  let from: string | null = null;
  let name: string | null = null;
  let setup = true;
  let sync = true;
  const prune: string[] = [];
  let since: string | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--target") target = rest[++index];
    else if (flag === "--no-setup" && subcommand === "create") setup = false;
    else if (flag === "--no-sync" && (subcommand === "create" || subcommand === "refresh")) sync = false;
    else if (flag === "--prune" && (subcommand === "create" || subcommand === "refresh" || subcommand === "sync") && index + 1 < rest.length) prune.push(rest[++index]!);
    else if (flag === "--since" && subcommand === "withdraw-imports" && index + 1 < rest.length) since = rest[++index]!;
    else if (flag === "--from" && subcommand === "create" && index + 1 < rest.length) from = rest[++index]!;
    else if (flag === "--name" && subcommand === "snapshot" && index + 1 < rest.length) name = rest[++index]!;
    else throw new InputError(`unknown ${subcommand} flag: ${String(flag)}`, "candidate_usage");
  }
  if (subcommand === "snapshot") {
    if (name === null) throw new InputError("snapshot needs --name <segment>", "candidate_usage");
    return Object.freeze({ subcommand, target: "", setup: false, sync: false, prune: Object.freeze([]), since: null, from: null, name });
  }
  if (target === undefined || target.length === 0) throw new InputError("--target <dir> is required", "candidate_usage");
  if (subcommand === "withdraw-imports" && (since === null || !Number.isFinite(Date.parse(since)))) {
    throw new InputError("withdraw-imports needs --since <ISO instant>: the instant the candidate's tree last changed", "candidate_usage");
  }
  return Object.freeze({ subcommand: subcommand as Subcommand, target: resolve(target), setup, sync, prune: Object.freeze(prune), since, from, name: null });
}

function sourceRoot(): string {
  const root = repositoryToplevel(ENGINE_ROOT, "directory");
  if (root === undefined) throw new InputError(`the source ${ENGINE_ROOT} is not inside a git working tree`, "candidate_source_invalid");
  return root;
}

/** A config value as git resolves it in `source` (every scope), or `null` when unset. */
function sourceConfig(source: string, key: string): string | null {
  const answer = spawnSync("git", ["config", "--get", key], { cwd: source, env: directoryGitEnvironment(), encoding: "utf8" });
  return answer.status === 0 ? answer.stdout.trim() : null;
}

function git(cwd: string, argv: readonly string[]): string {
  return execFileSync("git", argv, { cwd, env: directoryGitEnvironment(), encoding: "utf8" }).trim();
}

/**
 * THE ONE LIST of files the candidate authors (its sync regenerates them):
 * the generated outputs and the pinned build outputs their pins describe.
 * Refresh never overwrites them; copy-back writes only them.
 */
function candidateAuthoredPaths(target: string): readonly string[] {
  return [...generatedOutputPaths(target), ...buildOutputPaths()];
}

/** Where the candidate records the source's authored bytes it last saw (in its own git dir). */
function basePath(target: string): string {
  return join(target, ".git", "bridlewise-candidate-base.json");
}

/**
 * The candidate's base: `authored`, the source's authored bytes it last saw
 * (path → digest, `null`: absent); `treeSince`, the instant the candidate's
 * own tree last changed (create, and every refresh or sync that changed a
 * file) — the bound of the runs a copy-back imports; `setupOwed`, the setup
 * commands that have not succeeded since their last attempt (`owedSetup`:
 * the next refresh runs them whatever their inputs say).
 */
type CandidateBase = Readonly<{ authored: Readonly<Record<string, string | null>>; treeSince: string; from?: string; setupOwed?: readonly string[] }>;

function sourceDigest(path: string): string | null {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

function writeBase(target: string, base: CandidateBase): void {
  const result = atomicWriteFile(basePath(target), `${canonicalJson(base)}\n`);
  if (!result.success) throw new HarnessError(`could not record the candidate base: ${result.reason ?? "unknown"}`, "candidate_base_write_failed");
}

/**
 * Records the source's current authored bytes as the candidate's base
 * (create, refresh, copy-back). `treeChanged`: the candidate's tree just
 * changed, so `treeSince` moves to now; otherwise it is kept.
 */
function recordBase(source: string, target: string, treeChanged: boolean, from?: string): void {
  const authored = Object.fromEntries(candidateAuthoredPaths(target).map((path) => [path, sourceDigest(join(source, path))]));
  const previous = existsSync(basePath(target)) ? readBase(target) : undefined;
  const kept = from ?? previous?.from;
  writeBase(target, {
    authored, treeSince: treeChanged ? new Date().toISOString() : readBase(target).treeSince, ...(kept === undefined ? {} : { from: kept }),
    ...(previous?.setupOwed === undefined ? {} : { setupOwed: previous.setupOwed }),
  });
}

/** Records the setup commands still owed after `steps` (see {@link CandidateBase}). */
function recordSetupOwed(target: string, isolation: Parameters<typeof owedSetup>[0], steps: readonly CheckoutStep[]): void {
  const base = readBase(target);
  writeBase(target, { ...base, setupOwed: owedSetup(isolation, steps, new Set(base.setupOwed ?? [])) });
}

/** A candidate built from a snapshot is read-only toward the source: refresh and copy-back would mix two trees. */
function refuseSnapshotCandidate(target: string, subcommand: string): void {
  const { from } = readBase(target);
  if (from !== undefined) {
    throw new InputError(`the candidate at ${target} was built from the snapshot ${from}; it is read-only toward the source, so ${subcommand} is refused (create a fresh candidate instead)`, "candidate_from_snapshot");
  }
}

/** The candidate's tree changed (a sync rewrote a generated output): `treeSince` moves to now. */
function recordTreeChanged(target: string): void {
  writeBase(target, { ...readBase(target), treeSince: new Date().toISOString() });
}

function readBase(target: string): CandidateBase {
  if (!existsSync(basePath(target))) {
    throw new HarnessError(`the candidate has no recorded base (${basePath(target)}); recreate it`, "candidate_base_missing");
  }
  const base = JSON.parse(readFileSync(basePath(target), "utf8")) as Partial<CandidateBase>;
  if (typeof base.authored !== "object" || base.authored === null || typeof base.treeSince !== "string" || !Number.isFinite(Date.parse(base.treeSince))) {
    throw new HarnessError(`the candidate base at ${basePath(target)} is not this tool's record (no authored bytes or tree instant); recreate the candidate`, "candidate_base_missing");
  }
  return base as CandidateBase;
}

/**
 * The authored paths the SOURCE has not touched since the candidate's base:
 * the candidate's regenerated copy stays (the source's is merely stale). An
 * authored path the source DID change since (a hand edit of a pin-bearing
 * file, or another writer's regeneration) is taken from the source again and
 * re-converged.
 */
function untouchedAuthoredPaths(source: string, target: string): ReadonlySet<string> {
  const { authored } = readBase(target);
  return new Set(candidateAuthoredPaths(target).filter((path) => (authored[path] ?? null) === sourceDigest(join(source, path))));
}

function stageGeneratedOutputs(target: string): void {
  stageInCopy(target, [...generatedOutputPaths(target)]);
}

/**
 * `harness sync --with-bundle` in the candidate, by the CANDIDATE's own
 * engine (its sources are what is being synced): the command owns the fixed
 * point and reports its passes (`result.convergence`).
 */
function syncCandidate(target: string, engineRelative: string, prune: readonly string[]): ConvergenceReport {
  const engineRoot = join(target, engineRelative);
  const result = spawnSync(process.execPath, [join(engineRoot, "src", "cli.ts"), "harness", "sync", "--with-bundle", ...pruneArguments(prune)], {
    cwd: engineRoot, env: directoryGitEnvironment(), encoding: "utf8", maxBuffer: ROOT_POLICY.runtime.limits.maximumGitOutputBytes,
  });
  const report = (JSON.parse(result.stdout.trim().split("\n").at(-1) || "null") as { status?: string; result?: { convergence?: ConvergenceReport } } | null);
  if (result.status !== 0 || report?.status !== "pass" || report.result?.convergence === undefined) {
    throw new HarnessError(`harness sync failed in ${engineRoot}: ${`${result.stdout}${result.stderr}`.trim().split("\n").slice(-8).join("\n")}`, "candidate_sync_failed");
  }
  return report.result.convergence;
}

/** The runner of the candidate's declared commands: the source engine's native supervisor, as the configuration declares the runner. */
function commandRunner(document: ReturnType<typeof loadPinnedConfigSnapshot>["document"], isolation: NonNullable<ReturnType<typeof loadPinnedConfigSnapshot>["document"]["workspaceIsolation"]>): CheckoutCommandRunner {
  return configuredCheckoutCommandRunner(document, isolation, buildTestProcessSupervisor(), (step) => process.stderr.write(`${canonicalJson({ setup: step })}\n`));
}

function converge(target: string, engineRelative: string, prune: readonly string[]): ConvergenceReport {
  const report = syncCandidate(target, engineRelative, prune);
  stageGeneratedOutputs(target);
  // A pass that rewrote an output changed the candidate's tree: a run measured
  // before now measured other bytes.
  if (report.changedByPass.some((changed) => changed.length > 0)) recordTreeChanged(target);
  // A tracked output the first pass rewrote is NAMED, on stderr as well as in
  // the result: the source's generated values are not what its sources give.
  for (const finding of report.findings) process.stderr.write(`${canonicalJson({ finding })}\n`);
  return report;
}

/** Where an interrupted copy-back into `source` is journaled (the source's own state directory). */
/** The copy-back transaction's journal name (the journaled-commit owner derives its path). */
const COPY_BACK_JOURNAL = "candidate-copy-back";

async function run(options: Options): Promise<unknown> {
  const source = sourceRoot();
  const engineRelative = engineRelativePath(source, ENGINE_ROOT);
  const target = options.target;
  // Every run first finishes a copy-back a crash interrupted (rolled back:
  // nothing verified it), so no command ever works from a half-written source.
  // A copy-back whose owner is still RUNNING is left alone (`in-progress`):
  // reading commands go on and say so; a second copy-back is refused.
  const recovered = recoverJournaledCommit(source, COPY_BACK_JOURNAL);
  if (recovered !== "none") process.stderr.write(`${canonicalJson({ recoveredCopyBack: recovered })}\n`);
  if (recovered === "in-progress" && options.subcommand !== "diff") {
    throw new HarnessError("another run is copying a candidate back into this checkout right now; wait for it to finish", "candidate_copy_back_in_progress");
  }
  // The source's index is where it was recorded (the header), before anything.
  assertIndexAtBaseline(source);
  if (options.subcommand === "snapshot") {
    const snapshot = snapshotWorkingTree(source, { message: `candidate snapshot ${options.name!}`, name: options.name! });
    return { ref: snapshot.ref, commit: snapshot.commit, tree: snapshot.tree, parent: snapshot.parent };
  }
  // Every subcommand but `create` acts on an EXISTING candidate: a missing one
  // is named, never "undefinedundefined" (sync) or a diff listing the whole
  // source as only-in-source with exit 0 (wf1b-correctness §5 minor gaps).
  if (options.subcommand !== "create" && !existsSync(join(target, ".git"))) {
    throw new InputError(`there is no candidate at ${target} (create it first: candidate-checkout create --target ${target})`, "candidate_target_missing");
  }
  switch (options.subcommand) {
    case "create": {
      assertSameFilesystem(source, target, "candidate_target_filesystem_mismatch");
      // A copy of a recorded SNAPSHOT (a verifier's) is read-only toward the
      // source: it reads nothing of the source's index, so it records no index
      // baseline there, and only a snapshot ref names such a tree (`HEAD` or a
      // branch would build a copy whose own commit shows as a staged diff).
      const namespace = `${ROOT_POLICY.verification.workingTreeSnapshot.refNamespace}/`;
      if (options.from !== null && !options.from.startsWith(namespace)) {
        throw new InputError(`--from takes a snapshot ref (${namespace}<name>, printed by \`snapshot --name\`), not ${options.from}`, "candidate_from_not_snapshot");
      }
      const indexBaseline = options.from === null ? recordIndexBaseline(source) : "not recorded: a snapshot copy reads nothing of the source's index";
      const copy = options.from === null
        ? createWorkingCopy({ sourceRoot: source, targetRoot: target, git: "stage-all" })
        : createWorkingCopy({ sourceRoot: source, targetRoot: target, git: "snapshot", commit: options.from });
      recordBase(source, target, true, options.from ?? undefined);
      // The source's hooks run in the candidate too (exit 1 = no hooksPath set).
      const hooksPath = sourceConfig(source, "core.hooksPath");
      if (hooksPath !== null) git(target, ["config", "core.hooksPath", hooksPath]);
      // The source's git IDENTITY too (as git resolves it there: the local,
      // global or system value), so a snapshot or a commit in the candidate
      // is attributed as the source's would be — never git's refusal, never
      // an invented author. A source without one is stated in the result.
      const identity = configuredGitIdentity(source);
      if (identity !== null) {
        git(target, ["config", "user.name", identity.name]);
        git(target, ["config", "user.email", identity.email]);
      }
      const { document } = loadPinnedConfigSnapshot();
      const isolation = document.workspaceIsolation;
      if (isolation === undefined) throw new InputError("workspaceIsolation is not configured; it declares the checkout setup", "candidate_setup_unconfigured");
      const setup = options.setup ? await prepareCheckout(target, source, engineRelative, isolation, checkoutCommandRunner(target, commandRunner(document, isolation))) : [];
      recordSetupOwed(target, isolation, setup);
      if (setup.some((step) => step.status === "fail")) {
        throw new HarnessError(`candidate setup failed: ${canonicalJson(setup)}`, "candidate_setup_failed");
      }
      const convergence = options.sync ? converge(target, engineRelative, options.prune) : "skipped";
      return { target, head: copy.head, files: copy.paths.length, hooksPath, identity: identity ?? "none (the source has no git identity: commits in the candidate will be refused by git)", setup, convergence, indexBaseline };
    }
    case "refresh": {
      refuseSnapshotCandidate(target, "refresh");
      const refreshed = refreshWorkingCopy(source, target, untouchedAuthoredPaths(source, target));
      recordBase(source, target, refreshed.length > 0);
      const { document } = loadPinnedConfigSnapshot();
      const isolation = document.workspaceIsolation;
      if (isolation === undefined) throw new InputError("workspaceIsolation is not configured; it declares the checkout setup", "candidate_setup_unconfigured");
      const setupRerun = await rerunChangedSetup(isolation, refreshed.map(({ path }) => path), checkoutCommandRunner(target, commandRunner(document, isolation)), undefined, new Set(readBase(target).setupOwed ?? []));
      recordSetupOwed(target, isolation, setupRerun);
      if (setupRerun.some((step) => step.status === "fail")) {
        throw new HarnessError(`candidate setup re-run failed: ${canonicalJson(setupRerun)}`, "candidate_setup_failed");
      }
      return { target, refreshed, setupRerun, convergence: options.sync ? converge(target, engineRelative, options.prune) : "skipped" };
    }
    case "sync":
      return { target, convergence: converge(target, engineRelative, options.prune) };
    case "diff":
      return { target, differences: workingCopyDifferences(source, target) };
    case "copy-back":
      refuseSnapshotCandidate(target, "copy-back");
      return { target, ...copyBack(source, target, engineRelative) };
    case "withdraw-imports":
      return { target, since: options.since, withdrawn: Object.fromEntries(Object.entries(suiteLedgerPaths(engineRelative)).map(([suite, path]) => [suite, withdrawImportedRuns(join(source, path), target, options.since!)])) };
  }
}

/**
 * Writes the candidate's authored files into the source, all or nothing —
 * see the header for the refusals. Returns what it wrote and the check.
 */
function copyBack(source: string, target: string, engineRelative: string): Readonly<{ written: readonly string[]; check: string; ledgers: Readonly<Record<string, number | string>> }> {
  const authored = new Set(candidateAuthoredPaths(target));
  // The candidate must describe the source as it is NOW: any other
  // difference means the source moved since the candidate took it (or the
  // candidate was edited directly) — its outputs are not the source's.
  const moved = workingCopyDifferences(source, target).filter(({ path }) => !authored.has(path));
  if (moved.length > 0) {
    throw new HarnessError(
      `the source differs from the candidate outside the authored outputs (${moved.map(({ path, state }) => `${path} ${state}`).join(", ")}); ` +
        "refresh the candidate (and re-qualify) before copying back",
      "candidate_source_moved",
    );
  }
  const untouched = untouchedAuthoredPaths(source, target);
  const conflicts = [...authored].filter((path) => !untouched.has(path));
  if (conflicts.length > 0) {
    throw new HarnessError(
      `the source's copy of ${conflicts.join(", ")} changed since the candidate's base; another writer regenerated it — refresh the candidate first`,
      "candidate_copy_back_conflict",
    );
  }
  // Read everything first: a missing output refuses before any write.
  const files = [...authored].flatMap((path) => {
    const from = join(target, path);
    const stats = lstatSync(from, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isFile()) {
      throw new HarnessError(`the candidate has no ${path} (was it created with --no-setup?)`, "candidate_output_missing");
    }
    const bytes = readFileSync(from);
    const existing = lstatSync(join(source, path), { throwIfNoEntry: false });
    if (existing !== undefined && readFileSync(join(source, path)).equals(bytes)) return [];
    return [{ path, bytes, mode: (existing ?? stats).mode & 0o7777 }];
  });
  if (files.length > 0) {
    // ONE journaled transaction (src/filesystem/journaled-commit.ts): the
    // checkout write door for every target, the backups kept on disk until
    // the source's own `harness check` passes (a failure rolls every file
    // back), and a crash at any point is recovered by the next run.
    commitJournaled(source, COPY_BACK_JOURNAL, files, {
      verify: () => {
        const engineRoot = join(source, engineRelative);
        const check = spawnSync(process.execPath, [join(engineRoot, "src", "cli.ts"), "harness", "check", "--skip-typecheck"], {
          cwd: engineRoot, env: directoryGitEnvironment(), encoding: "utf8",
        });
        if (check.status !== 0) {
          throw new HarnessError(
            `copy-back of ${files.map(({ path }) => path).join(", ")} was rolled back: harness check fails in the source: ` +
              failedCheckSteps(check.stdout, check.stderr),
            "candidate_copy_back_unverified",
          );
        }
      },
    });
  }
  // The source now holds the candidate's outputs: they are the new base, so
  // the next copy-back does not mistake its own writes for another writer's.
  recordBase(source, target, false);
  return { written: files.map(({ path }) => path), check: files.length > 0 ? "pass" : "nothing-to-write", ledgers: importLedgers(source, target, engineRelative) };
}

/**
 * What a failed `harness check` refused, by step: its JSON result (the last
 * JSON line of stdout) names each failing step and its message. The progress
 * lines on stderr say only which step was running, so they are quoted only
 * when the check produced no result at all (it died before reporting).
 */
function failedCheckSteps(stdout: string, stderr: string): string {
  const line = stdout.trim().split("\n").reverse().find((entry) => entry.startsWith("{"));
  if (line !== undefined) {
    const parsed = JSON.parse(line) as { result?: Record<string, unknown> };
    const failed = Object.values(parsed.result ?? {}).flatMap((value) => {
      if (typeof value !== "object" || value === null) return [];
      const step = value as { step?: unknown; status?: unknown; message?: unknown };
      return step.status === "fail" ? [`${String(step.step)}: ${String(step.message)}`] : [];
    });
    if (failed.length > 0) return failed.join(" | ");
  }
  return `no step result was reported: ${`${stdout}${stderr}`.trim().split("\n").slice(-8).join("\n")}`;
}

/**
 * The candidate's judged suite runs of its current tree (runs started after
 * the base's `treeSince`), imported into the source's ledgers (see the
 * header): per ledger, the number of rows imported, or why it could not be —
 * reported, never thrown: the copy-back itself is done and verified.
 */
function importLedgers(source: string, target: string, engineRelative: string): Readonly<Record<string, number | string>> {
  const { treeSince } = readBase(target);
  return Object.fromEntries(Object.entries(suiteLedgerPaths(engineRelative)).map(([suite, path]) => {
    try {
      return [suite, importJudgedRuns(join(target, path), join(source, path), target, treeSince)];
    } catch (error) {
      return [suite, `not imported: ${extractErrorMessage(error)}`];
    }
  }));
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  try {
    process.stdout.write(`${canonicalJson(await run(parseArguments(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${canonicalJson({ error: (error as { code?: string }).code ?? "candidate_failed", message: extractErrorMessage(error) })}\n`);
    process.exitCode = 1;
  }
}
