/**
 * A MOVE CANNOT SILENTLY DROP A TRACKED FILE, AND THE HOOK THAT SAYS SO IS
 * ACTUALLY INSTALLED.
 *
 * Two claims, and they fail in opposite directions, so both are driven:
 *
 *   A. the rule refuses at the real door — `git commit` is run on throwaway
 *      repositories with the hook wired exactly as it is wired here, and the
 *      verdict read from git's own exit status rather than from the program's
 *      opinion of itself;
 *   B. every repository that ships the hook has git POINTED at it. The pointer
 *      is `core.hooksPath`, which is per-clone local config and cannot be
 *      tracked, so a tracked hook proves nothing on its own. An unbootstrapped
 *      repository is a red suite here, not a quiet pass.
 *
 * The instrument is independent of the subject throughout: nothing below asks
 * `commitLossFailure` what it thinks. It stages moves and reads the index.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { submoduleRoots } from "../../scripts/verification/gitignore-anchoring.ts";
import {
  GUARDED_HOOKS,
  HOOKS_DIRECTORY,
  HOOK_NAME,
  COMMIT_GUARD_PATH,
  guardHookBody,
  guardHookText,
  handsOverToGuard,
  hookInstallationFailure,
  hookTextIsCanonical,
  judgeLosses,
  readHookInstallations,
  SHIPPED_HOOKS,
  shippedHookText,
  stagedMoveLossFailure,
  type HookInstallation,
} from "../../scripts/verification/staged-move-loss.ts";
import { syncShippedHooks } from "../../scripts/verification/shipped-hooks.ts";
import { PROMOTION_TRIGGER_HOOK, promotionTriggerHookBody, promotionTriggerHookText } from "../../src/workflow/promotion/trigger-hook.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { blobSizes, carriesLosableContent, ignoredCopies, movedIntoIgnored } from "../../src/git/ignored-copies.ts";
import { machineIgnoredFiles } from "../../src/git/repository-ownership.ts";
import { declaredDeletionsPath, declaredDeletionsStatus, declareDeletions, type DeclaredDeletionsView } from "../../src/git/declared-deletions.ts";
import { WEB_RUN_HISTORY_PATH } from "../../src/shared/run-history.ts";

const INTEGRATION_ROOT = resolve(import.meta.dirname, "..", "..");
const HARNESS_ROOT = dirname(INTEGRATION_ROOT);
const COMMIT_GUARD = join(INTEGRATION_ROOT, "scripts", "commit-guard.ts");
const POST_COMMIT = join(INTEGRATION_ROOT, "scripts", "post-commit.ts");
const BOOTSTRAP = `npm run bootstrap:hooks  (from ${INTEGRATION_ROOT})`;

/** The repositories this side of the workspace can reach, from `.gitmodules`. */
function reachableRoots(): readonly string[] {
  return [...new Set([HARNESS_ROOT, ...submoduleRoots(HARNESS_ROOT)])];
}

/** What GIT says the repository root containing `path` is. */
function repositoryRootOf(path: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: path, encoding: "utf8" }).trim();
}

/**
 * The refusal a discovered repository set earns, or `null`.
 *
 * RE-DERIVED AT THE MONOREPO ASSEMBLY (2026-07-30), NOT PORTED. Both hook
 * tests used to open with `roots.length >= 2` — the harness root plus its
 * `integration` submodule, two repositories and two shims. The assembly made
 * them ONE index, so the floor became a claim about a world that no longer
 * exists and the suite went red saying "reached 1" about a tree that is
 * entirely covered. Lowering it to `>= 1` would have been the wrong repair:
 * a scalar floor certifies nothing once discovery is the thing that broke,
 * and `1` is the number an EMPTY `.gitmodules` and a BROKEN parse both give.
 *
 * So the population is now asked of git rather than counted. Two claims, and
 * between them a set that cannot be silently empty or silently wrong:
 *
 *   - the repository that OWNS this test file is in the reached set — which
 *     is the assumption `dirname(INTEGRATION_ROOT)` encodes and the exact one
 *     the assembly invalidated. Move the engine one directory deeper and this
 *     fires, where a count would not;
 *   - every reached path IS a repository root by git's own answer, so a
 *     declared submodule whose checkout became an ordinary directory is a
 *     refusal rather than a member that quietly ships no hook.
 *
 * PURE over the instrument it is handed, so both arms can be planted.
 */
function reachedRepositoriesFailure(
  roots: readonly string[],
  owner: string,
  rootOf: (path: string) => string,
): string | null {
  if (roots.length === 0) return "broken discovery: no repository was reached at all";
  if (!roots.includes(owner)) {
    return (
      `the repository that owns this test (${owner}) is not in the reached set ` +
      `[${roots.join(", ")}], so this guard is judging trees other than its own`
    );
  }
  const notRoots = roots.filter((root) => rootOf(root) !== root);
  if (notRoots.length > 0) {
    return `reached as repository roots, and git does not agree: ${notRoots.join(", ")}`;
  }
  return null;
}

function trackedPaths(root: string): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\0")
    .filter((entry) => entry.length > 0);
}

/**
 * The paths the last COMMIT holds — which is the only thing a refusal can
 * protect.
 *
 * `git ls-files` reads the INDEX, and the index already carries the staged
 * deletion by the time the hook runs; asking it after a refused commit reports
 * the file gone and says nothing about whether the refusal worked. Recorded
 * because it cost a red test that looked like a real escape.
 */
function committedPaths(root: string): readonly string[] {
  return execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  })
    .split("\0")
    .filter((entry) => entry.length > 0);
}

function writeFile(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/**
 * A throwaway repository wired to the REAL guard program.
 *
 * The hook here names `commit-guard.ts` by absolute path rather than by the
 * per-repository expression the shipped shims use, because a scratch tree has
 * no `scripts/` of its own. The shims' own resolution is driven separately,
 * in the repositories where it has to work.
 */
function guardedRepository(): string {
  const root = createTempDir("ch-commit-move-guard-");
  const run = (...args: readonly string[]): void => {
    execFileSync("git", [...args], { cwd: root, stdio: "pipe" });
  };
  run("init", "-q");
  run("config", "user.email", "guard@example.invalid");
  run("config", "user.name", "guard");
  writeFile(root, join(HOOKS_DIRECTORY, HOOK_NAME), guardHookText(HOOK_NAME, JSON.stringify(COMMIT_GUARD)));
  chmodSync(join(root, HOOKS_DIRECTORY, HOOK_NAME), 0o755);
  run("config", "core.hooksPath", HOOKS_DIRECTORY);
  return root;
}

/** `git commit` as DATA: the status is the verdict, so it must not throw. `env` adds to the environment (a `--git-dir` commit). */
function commit(root: string, message: string, env: Readonly<Record<string, string>> = {}): Readonly<{ status: number; stderr: string }> {
  const result = spawnSync("git", ["commit", "-s", "-q", "-m", message], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 24,
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? -1, stderr: result.stderr };
}

/** A repository holding one tracked file and an ignored destination. */
function repositoryWithATrackedFile(): string {
  const root = guardedRepository();
  writeFile(root, ".gitignore", "/archive/\n");
  writeFile(root, "docs/paper.md", "# the only copy\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const before = commit(root, "before");
  assert.equal(before.status, 0, `the baseline commit was refused: ${before.stderr}`);
  assert.ok(trackedPaths(root).includes("docs/paper.md"));
  return root;
}

test("DRIVEN: `mv` into an ignored path plus `git add -A` is REFUSED at the commit", () => {
  const root = repositoryWithATrackedFile();
  mkdirSync(join(root, "archive"), { recursive: true });
  renameSync(join(root, "docs", "paper.md"), join(root, "archive", "paper.md"));
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });

  // The state this catches, confirmed before the verdict is read: git has
  // staged a deletion of the old path and nothing at all for the new one.
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    "D  docs/paper.md",
  );

  const refused = commit(root, "after");
  assert.notEqual(refused.status, 0, "the commit was accepted and the file left the index");
  assert.match(refused.stderr, /COMMIT REFUSED/u);
  assert.match(refused.stderr, /docs\/paper\.md/u);
  assert.match(refused.stderr, /archive\/paper\.md/u);
  assert.match(refused.stderr, /git mv/u);

  // AND THE INDEX IS THE VERDICT, not the message: the file is still tracked
  // at its old path, so the refusal actually prevented the loss rather than
  // describing it. A guard that printed this and committed anyway would pass
  // every assertion above.
  assert.ok(committedPaths(root).includes("docs/paper.md"), "the deletion was committed anyway");
  assert.equal(
    execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    "1",
  );
});

test("DRIVEN: a move check that cannot answer STILL refuses — the message is decoration, the exit code is the refusal", () => {
  // The check's own crash path: an ignored file whose name holds a newline
  // cannot travel through `hash-object --stdin-paths`, so the rule throws
  // (deny-by-default at the rule). The door must then refuse the commit —
  // "a check that fails open certifies the commit it could not examine" is
  // the program's own contract. The exact regression this arm watches: the
  // catch printed `COMMIT REFUSED … could not run` and never set the exit
  // code, so git proceeded and COMMITTED. The message assertions alone cannot
  // tell that from a refusal; rev-list can.
  const root = repositoryWithATrackedFile();
  mkdirSync(join(root, "archive"), { recursive: true });
  rmSync(join(root, "docs", "paper.md"));
  // The crash producer: an ignored path whose name holds a newline. git
  // handles it fine; the RULE refuses to hash it (the newline cannot survive
  // --stdin-paths). Asserted from git, so a fixture that stopped producing
  // the crash arm shows up here instead of as a false green below.
  writeFile(root, join("archive", "bad\nname"), "");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(
    (machineIgnoredFiles(root, "inherited") ?? []).includes("archive/bad\nname"),
    true,
    "the fixture did not plant the crash-producing ignored path, so this never reaches the crash branch",
  );

  const verdict = commit(root, "a deletion the check cannot judge");
  assert.notEqual(verdict.status, 0, "the commit was ACCEPTED although the move check crashed — the door failed open");
  assert.match(verdict.stderr, /COMMIT REFUSED/u);
  // The crash branch's own wording, not the loss branch's ("a file would
  // leave the index"): a refusal earned by the check actually finding a loss
  // would satisfy everything above.
  assert.match(verdict.stderr, /could not run/u);
  assert.equal(
    execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    "1",
    "the commit landed anyway — the refusal was a message, not an exit code",
  );

  // AND THE GUARD IS STILL AWAKE in the same repository shape: a real move
  // must still be refused, or the verdict above is evidence about a door that
  // stopped judging rather than about the crash branch. The refused commit
  // left the deletion staged — unstage it and restore the bytes so the move
  // below starts from the same clean shape every other arm uses.
  rmSync(join(root, "archive", "bad\nname"));
  execFileSync("git", ["reset", "-q"], { cwd: root, stdio: "pipe" });
  writeFile(root, "docs/paper.md", "# the only copy\n");
  renameSync(join(root, "docs", "paper.md"), join(root, "archive", "paper.md"));
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "a real move, in the same tree");
  assert.notEqual(refused.status, 0, "the guard stopped refusing real moves");
  assert.match(refused.stderr, /archive\/paper\.md/u);
});

test("DRIVEN: the two spellings are told apart — `git mv` into the same ignored path commits", () => {
  // The control that gives the refusal its meaning, and the reason the rule
  // reads git's raw diff rather than counting deletions: `git mv` into an
  // ignored path keeps the file TRACKED, so git reports a rename and there is
  // no loss to refuse. Same destination, same intent, opposite mechanics.
  const root = repositoryWithATrackedFile();
  mkdirSync(join(root, "archive"), { recursive: true });
  execFileSync("git", ["mv", "docs/paper.md", "archive/paper.md"], { cwd: root, stdio: "pipe" });
  const accepted = commit(root, "moved with git mv");
  assert.equal(accepted.status, 0, `a correct move was refused: ${accepted.stderr}`);
  assert.ok(committedPaths(root).includes("archive/paper.md"));
});

test("DRIVEN: a real deletion, and a move to a tracked path, are not refused", () => {
  // Two false-positive directions. A guard that refuses either of these would
  // be turned off within a day, which is a worse outcome than not having it.
  const deleted = repositoryWithATrackedFile();
  rmSync(join(deleted, "docs", "paper.md"));
  execFileSync("git", ["add", "-A"], { cwd: deleted, stdio: "pipe" });
  const removal = commit(deleted, "deliberately removed");
  assert.equal(removal.status, 0, `a deliberate deletion was refused: ${removal.stderr}`);
  assert.ok(!committedPaths(deleted).includes("docs/paper.md"));

  const moved = repositoryWithATrackedFile();
  renameSync(join(moved, "docs", "paper.md"), join(moved, "docs", "renamed.md"));
  execFileSync("git", ["add", "-A"], { cwd: moved, stdio: "pipe" });
  const rename = commit(moved, "moved to a tracked path");
  assert.equal(rename.status, 0, `an ordinary rename was refused: ${rename.stderr}`);
  assert.ok(committedPaths(moved).includes("docs/renamed.md"));

  // A DANGLING symbolic link among the ignored files is not a copy of
  // anything, and it never makes the check fail to answer (the size filter
  // stats every ignored file: an absent target is absent, not an error).
  const dangling = repositoryWithATrackedFile();
  mkdirSync(join(dangling, "archive"), { recursive: true });
  symlinkSync(join(dangling, "archive", "no-such-target"), join(dangling, "archive", "dangling.md"));
  rmSync(join(dangling, "docs", "paper.md"));
  execFileSync("git", ["add", "-A"], { cwd: dangling, stdio: "pipe" });
  const beside = commit(dangling, "deleted beside a dangling ignored link");
  assert.equal(beside.status, 0, `a deletion beside a dangling ignored link was refused: ${beside.stderr}`);
});

test("DRIVEN: deleting an EMPTY tracked file is not refused, though the tree is full of empty ignored ones", () => {
  // THE ARM THAT WAS MISSING, AND WHY IT WAS MISSING. The false-positive test
  // above builds its fixture with `"# the only copy\n"`, so every deletion this
  // guard had ever judged carried content — and the ONE blob that identifies
  // nothing was never in the population. The empty blob is shared by every
  // zero-byte file in existence, so an empty deletion matched every empty
  // IGNORED file on disk. Measured on this repository before the repair:
  // removing `engine/test_edit_tool.txt` (0 bytes) was refused, naming a dozen
  // unrelated paths including `node_modules/undici/lib/llhttp/.gitkeep`.
  //
  // The fixture reproduces that condition rather than asserting around it: the
  // ignored directory is stocked with empty files FIRST, so a guard that keyed
  // on the empty blob has something to find and this test can tell the repair
  // from an empty tree.
  const root = repositoryWithATrackedFile();
  writeFile(root, "marker.keep", "");
  execFileSync("git", ["add", "marker.keep"], { cwd: root, stdio: "pipe" });
  const seeded = commit(root, "an empty tracked file");
  assert.equal(seeded.status, 0, `seeding the empty file was refused: ${seeded.stderr}`);

  mkdirSync(join(root, "archive"), { recursive: true });
  for (const name of ["unrelated-a", "unrelated-b", ".gitkeep"]) {
    writeFile(root, join("archive", name), "");
  }
  // The confound is real: git agrees these are the same blob as the file being
  // deleted. Asserted, so a later change that stopped creating them would show
  // up as this test going vacuous rather than as it going green.
  const emptyBlob = execFileSync("git", ["hash-object", "marker.keep"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert.equal(
    execFileSync("git", ["hash-object", join("archive", ".gitkeep")], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    emptyBlob,
    "the confound is absent: the ignored empty files do not share the deleted file's blob",
  );

  rmSync(join(root, "marker.keep"));
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const removal = commit(root, "the empty file is deliberately gone");
  assert.equal(
    removal.status,
    0,
    `deleting an empty file was refused because unrelated empty files exist: ${removal.stderr}`,
  );
  assert.ok(!committedPaths(root).includes("marker.keep"));

  // AND THE GUARD IS STILL AWAKE IN THE SAME REPOSITORY, with the same ignored
  // directory: a NON-empty move must still be refused. Otherwise "no refusal"
  // above would be evidence about a guard that had stopped judging at all.
  renameSync(join(root, "docs", "paper.md"), join(root, "archive", "paper.md"));
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "a real move, in the same tree");
  assert.notEqual(refused.status, 0, "the guard stopped refusing real moves");
  assert.match(refused.stderr, /archive\/paper\.md/u);
});

test("DRIVEN: untracking a file IN PLACE with `git rm --cached` is not refused", () => {
  // THE ARM THAT WAS MISSING, AND WHAT IT COST. Every case above moves the
  // bytes somewhere else — `mv` plus `add -A`, `git mv`, a real deletion, a
  // move that also renames. Not one of them leaves the file where it was, so
  // `from === to` was outside the whole test set, and `movedIntoIgnored` never
  // compares the two. The refusal that resulted printed
  // `<path> is on disk at <path>, which git IGNORES` — the same path twice —
  // and its only sanctioned escape was "remove the copy on disk first", which
  // for an in-place untracking means deleting the very bytes the operation
  // exists to keep. So the person doing it reached for `--no-verify`, which is
  // the guard turned off for every OTHER check in the same commit.
  //
  // IT IS ALLOWED, and the reason is mechanical rather than a judgement about
  // intent. This guard exists because bytes survive while the index entry does
  // not AND NOTHING NAMES WHERE THEY WENT. Here they went nowhere: `git status`
  // shows a staged deletion of exactly the path the operator typed, which is
  // the whole visible content of the operation.
  //
  // THE ENUMERATION OF PRODUCERS THAT USED TO SIT HERE WAS WRONG. It read
  // "`git rm --cached` and `git update-index --force-remove` are the only
  // producers", on the grounds that an ignore rule has no effect on a path
  // already in the index. A third one exists and the test below drives it. The
  // safety of the skip does not depend on the list, and never did: it is per
  // pair, which the test after that one drives.
  const root = repositoryWithATrackedFile();

  // The exact shape #118 hit: the path becomes ignored, then is untracked in
  // place. The rule is added FIRST so the file is ignored at the moment of the
  // commit, which is what puts it in front of the guard at all.
  writeFile(root, ".gitignore", "/archive/\n/docs/paper.md\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["rm", "--cached", "-q", "docs/paper.md"], { cwd: root, stdio: "pipe" });

  // The state, confirmed before the verdict: a staged deletion, and the bytes
  // still on disk at the SAME path — which git now ignores.
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    "M  .gitignore\nD  docs/paper.md",
  );
  assert.ok(existsSync(join(root, "docs", "paper.md")));
  // EQUAL TO 0, NOT MERELY DIFFERENT FROM 1. `check-ignore -q` answers 0 for
  // "ignored" and 1 for "not ignored", and everything else is a failure to ask
  // the question at all: 128 for a bad repository or a bad argv, and `null`
  // for a git that never launched. A `notEqual(…, 1)` precondition is
  // satisfied by both of those, so a fixture that had silently stopped being
  // ignored would still let the acceptance verdict below be reported — the
  // whole "in-place untracking is accepted" result measured on a path that was
  // never in front of the rule.
  assert.equal(
    spawnSync("git", ["check-ignore", "-q", "--no-index", "--", "docs/paper.md"], { cwd: root })
      .status,
    0,
    "the fixture did not make the path ignored, so this never reaches the rule",
  );

  const accepted = commit(root, "stop tracking it, keep the bytes");
  assert.equal(
    accepted.status,
    0,
    `a deliberate in-place untracking was refused: ${accepted.stderr}`,
  );
  assert.ok(!committedPaths(root).includes("docs/paper.md"), "the untracking did not happen");
  assert.ok(
    existsSync(join(root, "docs", "paper.md")),
    "the bytes are gone, so this was not an untracking at all",
  );

  // AND THE GUARD IS STILL AWAKE IN THE SAME REPOSITORY: a real move must
  // still be refused, or "not refused" above is evidence about a guard that
  // stopped judging rather than about the arm just added.
  writeFile(root, "docs/other.md", "# the only copy of this one\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "a second tracked file").status, 0);
  mkdirSync(join(root, "archive"), { recursive: true });
  renameSync(join(root, "docs", "other.md"), join(root, "archive", "other.md"));
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "a real move, in the same tree");
  assert.notEqual(refused.status, 0, "the guard stopped refusing real moves");
  assert.match(refused.stderr, /archive\/other\.md/u);
});

test("DRIVEN: a generated directory that becomes ignored reaches `from === to` with no `rm --cached`", () => {
  // THE THIRD PRODUCER, AND THE REASON THIS ARM EXISTS. The exemption above
  // was justified by an ENUMERATION — `git rm --cached` and
  // `git update-index --force-remove` were said to be the only ways to reach
  // a deletion whose bytes are at the same path — resting on "an ignore rule
  // has no effect on a path already in the index". That sentence is true and
  // the conclusion drawn from it is not: the rule stops protecting the path
  // the moment the file is absent from DISK, and a generated file is absent
  // from disk after every clean.
  //
  // So the repository's own sanctioned flow reaches it: add a rule for a
  // generated directory, rebuild (which removes then recreates the file),
  // `git add -A`. §8 requires an exemption to carry the same evidence burden
  // as a detection, and an enumeration of producers is a claim about the
  // world. This one was wrong, so the claim is replaced by the property the
  // skip actually rests on — and the arm below drives that property.
  const root = guardedRepository();
  writeFile(root, "generated/out.txt", "deterministic bytes\n");
  writeFile(root, "src/keep.txt", "source\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "the generated output was tracked").status, 0);

  // 1. The sanctioned change: the generated tree gets an ignore rule.
  writeFile(root, ".gitignore", "/generated/\n");
  // 2. A clean removes it from disk. NOT `git rm`, NOT `update-index` — the
  //    file simply stops existing, which is what a rebuild does.
  rmSync(join(root, "generated"), { recursive: true, force: true });
  // 3. `git add -A` stages the deletion. The rule does not defend the path,
  //    because the path is in the index and gone from disk.
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    "A  .gitignore\nD  generated/out.txt",
  );
  // 4. The deterministic generator runs and writes the same bytes back.
  writeFile(root, "generated/out.txt", "deterministic bytes\n");

  // The state is now exactly `from === to`: a staged deletion whose blob is on
  // disk at the SAME path, which git ignores. Asserted from git rather than
  // assumed, so a fixture that drifted shows up here instead of downstream.
  const staged = execFileSync("git", ["rev-parse", ":0:.gitignore"], { cwd: root });
  assert.ok(staged.length > 0);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD:generated/out.txt"], { cwd: root, encoding: "utf8" }).trim(),
    execFileSync("git", ["hash-object", "generated/out.txt"], { cwd: root, encoding: "utf8" }).trim(),
    "the fixture did not recreate identical bytes, so this never reaches the from === to pair",
  );
  assert.equal(
    spawnSync("git", ["check-ignore", "-q", "--no-index", "--", "generated/out.txt"], { cwd: root })
      .status,
    0,
    "the fixture did not make the path ignored, so this never reaches the rule",
  );

  const accepted = commit(root, "the generated tree is no longer tracked");
  assert.equal(
    accepted.status,
    0,
    `the repository's own sanctioned untracking flow was refused: ${accepted.stderr}`,
  );
  assert.ok(!committedPaths(root).includes("generated/out.txt"));
  assert.ok(existsSync(join(root, "generated", "out.txt")), "the bytes are gone");

  // AND THE SKIP IS PER PAIR, WHICH IS WHAT THE EXEMPTION ACTUALLY RESTS ON.
  // Same repository, one commit holding BOTH shapes: `src/keep.txt` is
  // untracked in place AND a second copy of its exact bytes is moved into the
  // ignored tree. A skip that keyed on the commit, or on the blob, would let
  // the real move through beside the in-place untracking.
  writeFile(root, ".gitignore", "/generated/\n/src/keep.txt\n");
  writeFile(root, "generated/keep-copy.txt", "source\n");
  execFileSync("git", ["rm", "--cached", "-q", "src/keep.txt"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "an in-place untracking beside a real move of the same blob");
  assert.notEqual(
    refused.status,
    0,
    "a real move rode in beside an in-place untracking of the same blob",
  );
  assert.match(refused.stderr, /generated\/keep-copy\.txt/u);
  assert.ok(committedPaths(root).includes("src/keep.txt"), "the deletion was committed anyway");
});

test("the rule never pairs a deletion with the path it was deleted FROM", () => {
  // The pure statement, supplied from outside: one deletion whose bytes are at
  // the same path (an in-place untracking) and one whose bytes moved, both
  // carrying the same blob, so a rule that ignored the path would answer two
  // losses here. The repaired one answers the move only.
  const losses = movedIntoIgnored(
    [{ path: "docs/paper.md", blob: "aaa", size: 10 }],
    [
      { path: "docs/paper.md", blob: "aaa" },
      { path: "archive/paper.md", blob: "aaa" },
    ],
  );
  assert.deepEqual([...losses], [{ from: "docs/paper.md", to: "archive/paper.md" }]);

  // And the untracking ALONE reports nothing at all, rather than reporting a
  // shorter list that happens to look right.
  assert.deepEqual(
    [
      ...movedIntoIgnored(
        [{ path: "docs/paper.md", blob: "aaa", size: 10 }],
        [{ path: "docs/paper.md", blob: "aaa" }],
      ),
    ],
    [],
  );
});

test("the empty blob is skipped at the RULE, not only at the door", () => {
  // The pure statement of the same thing, supplied from outside: one empty
  // deletion against three ignored files that all carry the empty blob. A
  // guard keying on blob alone answers three losses here; the repaired one
  // answers none, and still answers the loss beside it.
  const emptyBlob = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
  const ignored = [
    { path: "node_modules/a/.gitkeep", blob: emptyBlob },
    { path: "node_modules/b/empty.js", blob: emptyBlob },
    { path: "archive/paper.md", blob: "aaa" },
  ];
  const losses = movedIntoIgnored(
    [
      { path: "engine/scratch.txt", blob: emptyBlob, size: 0 },
      { path: "docs/paper.md", blob: "aaa", size: 10 },
    ],
    ignored,
  );
  assert.deepEqual([...losses], [{ from: "docs/paper.md", to: "archive/paper.md" }]);

  // THE PREDICATE ITSELF, so the reason is asserted and not merely implied by
  // the outcome above.
  assert.equal(carriesLosableContent({ path: "x", blob: emptyBlob, size: 0 }), false);
  assert.equal(carriesLosableContent({ path: "x", blob: "aaa", size: 1 }), true);
});

test("DRIVEN: the rule matches CONTENT, so a move that also renames is caught", () => {
  // The class, not the instance. A rule keyed to the basename would miss this
  // and would fire on two unrelated files that share a name.
  const root = repositoryWithATrackedFile();
  mkdirSync(join(root, "archive"), { recursive: true });
  renameSync(join(root, "docs", "paper.md"), join(root, "archive", "something-else-entirely.md"));
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "moved and renamed");
  assert.notEqual(refused.status, 0, "a renaming move into an ignored path was accepted");
  assert.match(refused.stderr, /archive\/something-else-entirely\.md/u);
  assert.ok(committedPaths(root).includes("docs/paper.md"));
});

/**
 * A scratch repository laid out like `root` for its SHIPPED hook `name`: the
 * hook's exact bytes at `.githooks/<name>`, and `engine` a link to `root`'s
 * engine, so the shim resolves `$root/engine/...` exactly as it does where it
 * ships — while every effect lands in the scratch repository's own git and
 * state, never in the checkout under test (a post-commit run on the live
 * checkout consumed ITS declarations: wf-del-verify N5).
 */
function shippedHookRepository(root: string, name: string): Readonly<{ scratch: string; hook: string }> {
  const scratch = createTempDir("ch-shipped-hook-");
  execFileSync("git", ["init", "-q"], { cwd: scratch, stdio: "pipe" });
  const hook = join(scratch, HOOKS_DIRECTORY, name);
  mkdirSync(dirname(hook), { recursive: true });
  copyFileSync(join(root, HOOKS_DIRECTORY, name), hook);
  chmodSync(hook, 0o755);
  symlinkSync(join(root, "engine"), join(scratch, "engine"));
  writeFile(scratch, "readme.md", "# scratch\n");
  execFileSync("git", ["-c", "user.name=hook", "-c", "user.email=hook@example.invalid", "commit", "-s", "-q", "--allow-empty", "-m", "base"], { cwd: scratch, stdio: "pipe" });
  return { scratch, hook };
}

test("the shipped hook of every reachable repository resolves and runs", () => {
  // The shims are the one repository-specific part — each names the path to
  // the shared program, and a path is exactly what goes stale. Running each
  // one against the tree it ships in proves the resolution, which no amount
  // of reading it could; what may NOT happen is the program failing to load.
  const roots = reachableRoots();
  const reach = reachedRepositoriesFailure(roots, repositoryRootOf(INTEGRATION_ROOT), repositoryRootOf);
  assert.equal(reach, null, reach ?? "");
  for (const root of roots) {
    for (const name of GUARDED_HOOKS) {
      assert.ok(existsSync(join(root, HOOKS_DIRECTORY, name)), `${root} ships no ${HOOKS_DIRECTORY}/${name}`);
      const { scratch, hook } = shippedHookRepository(root, name);
      // Invoked the way git invokes it: `commit-msg` is handed the message file.
      const message = join(scratch, "COMMIT_EDITMSG");
      // Signed off by the committer the hook sees (the DCO is one of the message's duties).
      writeFile(scratch, "COMMIT_EDITMSG", "a message\n\nSigned-off-by: hook <hook@example.invalid>\n");
      // The identities git hands a commit's hooks: it resolves author and committer before it runs them.
      const committer = { GIT_COMMITTER_NAME: "hook", GIT_COMMITTER_EMAIL: "hook@example.invalid", GIT_AUTHOR_NAME: "hook", GIT_AUTHOR_EMAIL: "hook@example.invalid" };
      const result = spawnSync("sh", [hook, ...(name === "commit-msg" ? [message] : [])], { cwd: scratch, encoding: "utf8", maxBuffer: 1 << 24, env: { ...process.env, ...committer } });
      assert.equal(result.status, 0, `${root}: the shipped ${name} failed to run on a repository with nothing staged:\n${result.stderr}`);
    }
  }
});

test("the shipped post-commit hook of every reachable repository resolves and runs, and consumes in the repository that committed", () => {
  // The shim is the repository-specific part (it names the program's path).
  // With no declaration it consumes nothing and exits 0; with one whose path
  // the last commit deleted, it consumes THAT repository's record.
  for (const root of reachableRoots()) {
    assert.ok(existsSync(join(root, HOOKS_DIRECTORY, "post-commit")), `${root} ships no ${HOOKS_DIRECTORY}/post-commit`);
    const { scratch, hook } = shippedHookRepository(root, "post-commit");
    const run = (): ReturnType<typeof spawnSync> => spawnSync("sh", [hook], { cwd: scratch, encoding: "utf8", maxBuffer: 1 << 24 });
    const idle = run();
    assert.equal(idle.status, 0, `${root}: the post-commit hook failed to run:\n${String(idle.stderr)}`);
    assert.doesNotMatch(String(idle.stderr), /could not be consumed/u);
    execFileSync("git", ["add", "readme.md"], { cwd: scratch, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=hook", "-c", "user.email=hook@example.invalid", "commit", "-s", "-q", "-m", "add"], { cwd: scratch, stdio: "pipe" });
    rmSync(join(scratch, "readme.md"));
    declareDeletions(scratch, ["readme.md"]);
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=hook", "-c", "user.email=hook@example.invalid", "commit", "-s", "-q", "-a", "-m", "delete"], { cwd: scratch, stdio: "pipe" });
    const consumed = run();
    assert.equal(consumed.status, 0, String(consumed.stderr));
    assert.match(String(consumed.stderr), /1 declared deletion\(s\) consumed/u);
    assert.equal(existsSync(declaredDeletionsPath(scratch)), false);
  }
});

test("THE REACH IS ITSELF CHECKED: a discovery that shrank or drifted is a refusal", () => {
  // PLANTS, supplied from outside: each arm of the population rule, so the
  // green verdict above is about this workspace and not about a check that
  // stopped checking. This is the shape that failed silently for three
  // repositories' worth of history — the reach was a scalar, and a scalar
  // cannot tell "everything is covered" from "discovery stopped working".
  const rootOf = (path: string): string => (path === "/w/nested" ? "/w" : path);
  assert.equal(reachedRepositoriesFailure(["/w", "/w/sub"], "/w", rootOf), null);
  assert.match(reachedRepositoriesFailure([], "/w", rootOf) ?? "", /broken discovery/u);
  // The assembly's actual failure: the owning repository dropped out because
  // the path expression that names it stopped being true.
  assert.match(
    reachedRepositoriesFailure(["/elsewhere"], "/w", rootOf) ?? "",
    /is not in the reached set/u,
  );
  // A declared submodule whose checkout is now an ordinary directory: git
  // answers with the ENCLOSING repository, and the member ships no hook.
  assert.match(
    reachedRepositoriesFailure(["/w", "/w/nested"], "/w", rootOf) ?? "",
    /git does not agree: \/w\/nested/u,
  );
});

test("THE SHIPPED HOOKS ARE GENERATED: each hook's whole text is its owner's (canonical by construction); the generator reports a hand edit or a missing hook stale and rewrites it, a new one executable (PROMO34FIX-HOOK-GENERATOR)", () => {
  for (const hook of SHIPPED_HOOKS) {
    assert.equal(hookTextIsCanonical(shippedHookText(hook), hook), true, `${hook}: the owner's text is canonical`);
    assert.equal(readFileSync(join(HARNESS_ROOT, HOOKS_DIRECTORY, hook), "utf8"), shippedHookText(hook), `${hook}: the tracked hook is its owner's text`);
  }
  const root = createTempDir("shipped-hooks-");
  mkdirSync(join(root, HOOKS_DIRECTORY));
  for (const hook of SHIPPED_HOOKS) writeFileSync(join(root, HOOKS_DIRECTORY, hook), shippedHookText(hook), { mode: 0o755 });
  assert.deepEqual(syncShippedHooks(root, false), { allCurrent: true, status: "current", changed: [] });
  writeFileSync(join(root, HOOKS_DIRECTORY, HOOK_NAME), `${shippedHookText(HOOK_NAME)}# a hand-added line\n`);
  rmSync(join(root, HOOKS_DIRECTORY, PROMOTION_TRIGGER_HOOK));
  const stale = [`${HOOKS_DIRECTORY}/${HOOK_NAME}`, `${HOOKS_DIRECTORY}/${PROMOTION_TRIGGER_HOOK}`];
  assert.deepEqual(syncShippedHooks(root, false), { allCurrent: false, status: "stale", changed: stale });
  assert.deepEqual(syncShippedHooks(root, true), { allCurrent: true, status: "regenerated", changed: stale });
  assert.equal(readFileSync(join(root, HOOKS_DIRECTORY, HOOK_NAME), "utf8"), shippedHookText(HOOK_NAME));
  assert.equal(statSync(join(root, HOOKS_DIRECTORY, PROMOTION_TRIGGER_HOOK)).mode & 0o777, 0o755, "a new hook is executable");
  assert.deepEqual(syncShippedHooks(createTempDir("shipped-hooks-absent-"), false), { allCurrent: true, status: "absent", changed: [] });
});

test("DENY BY DEFAULT: an unbootstrapped repository is a refusal, with the command to fix it", () => {
  const roots = reachableRoots();
  const installations: readonly HookInstallation[] = roots.flatMap((root) => readHookInstallations(root));
  assert.deepEqual([...new Set(installations.map((installation) => installation.hook))], [...SHIPPED_HOOKS], "every shipped hook is examined (the guarded ones and the promotion trigger)");
  const failure = hookInstallationFailure(installations, BOOTSTRAP);
  assert.equal(failure, null, failure ?? "");

  // PLANTS, supplied from outside: every branch of the refusal, so a green
  // verdict above is about the repositories and not about a rule that stopped
  // ruling. Each is asserted individually — a conjunction of four detectors
  // needs four liveness checks, not one.
  const good = installations[0];
  assert.ok(good !== undefined);
  const variant = (change: Partial<HookInstallation>): string =>
    hookInstallationFailure([{ ...good, ...change }], BOOTSTRAP) ?? "";
  assert.match(variant({ hooksPath: null }), /core\.hooksPath is not set/u);
  assert.match(variant({ hooksPath: ".git/hooks" }), /core\.hooksPath is "\.git\/hooks"/u);
  assert.match(variant({ present: false }), /does not exist/u);
  assert.match(variant({ tracked: false }), /is not tracked/u);
  assert.match(variant({ executable: false }), /is not executable/u);
  assert.match(variant({ canonical: false }), /is not canonical: it no longer hands over to commit-guard\.ts/u);
  assert.match(hookInstallationFailure([{ ...good, hook: PROMOTION_TRIGGER_HOOK, canonical: false }], BOOTSTRAP) ?? "", /reference-transaction is not canonical: it no longer runs exactly the promotion trigger's code/u);
  assert.match(hookInstallationFailure([], BOOTSTRAP) ?? "", /broken discovery/u);
  // The way out is printed, because a missing per-clone setting is a state
  // someone has to be told how to leave.
  assert.match(variant({ hooksPath: null }), /npm run bootstrap:hooks/u);
});

test("the promotion trigger is canonical only as its owner's code lines: the shipped hook is; a `set -e`, a lost `exit 0`, another variable, an extra statement or a foreground run is not (J15: a failing reference-transaction hook blocks every ref update)", () => {
  const shipped = readFileSync(join(INTEGRATION_ROOT, "..", HOOKS_DIRECTORY, PROMOTION_TRIGGER_HOOK), "utf8");
  assert.equal(shipped, promotionTriggerHookText(), "the shipped hook is its owner's text, byte for byte");
  assert.equal(hookTextIsCanonical(shipped, PROMOTION_TRIGGER_HOOK), true);
  const body = promotionTriggerHookBody();
  const hook = (...lines: readonly string[]): string => `${["#!/bin/sh", ...lines].join("\n")}\n`;
  assert.equal(hookTextIsCanonical(hook("# a comment", "", ...body, "# another"), PROMOTION_TRIGGER_HOOK), true, "comments and blank lines aside");
  const refused: ReadonlyArray<readonly [string, string]> = [
    ["set -e first", hook("set -e", ...body)],
    ["the last exit 0 lost", hook(...body.slice(0, -1))],
    ["another run variable", hook(...body.map((line) => line.replace(ROOT_POLICY.workflow.promotion.runEnvironmentVariable, "OTHER_VARIABLE")))],
    ["an extra statement", hook(...body.slice(0, -1), "false", body.at(-1)!)],
    ["the run in the foreground", hook(...body.map((line) => line.replace(/ & \)$/u, " )")))],
    ["another interpreter", `${["#!/bin/bash", ...body].join("\n")}\n`],
    ["a guard hook's text", guardHookText(HOOK_NAME)],
  ];
  for (const [what, text] of refused) assert.equal(hookTextIsCanonical(text, PROMOTION_TRIGGER_HOOK), false, `${what} was accepted`);
  assert.equal(hookTextIsCanonical(promotionTriggerHookText(), HOOK_NAME), false, "the trigger never stands in for a guard hook");
});

test("a hook HANDS OVER to the guard only as its CANONICAL text: the shipped hooks do; a mention, a neutered exec, another interpreter, a swallowed line or a look-alike program does not (wf1b2-design G6; WF-1b3b verify H1)", () => {
  for (const hook of GUARDED_HOOKS) {
    assert.equal(handsOverToGuard(readFileSync(join(INTEGRATION_ROOT, "..", HOOKS_DIRECTORY, hook), "utf8"), hook), true, `the shipped ${hook} does not hand over`);
    assert.equal(handsOverToGuard(guardHookText(hook), hook), true, `the canonical ${hook} does not hand over`);
    assert.equal(handsOverToGuard(guardHookText(hook, JSON.stringify(COMMIT_GUARD_PATH)), hook), true, `the canonical ${hook} naming this harness's guard does not hand over`);
  }
  assert.equal(COMMIT_GUARD_PATH, COMMIT_GUARD, "the accepted absolute guard is this harness's own program");
  const [setE, rootLine, execLine, programLine] = guardHookBody(HOOK_NAME);
  const hook = (...lines: readonly string[]): string => `${lines.join("\n")}\n`;
  const canonical = ["#!/bin/sh", setE!, rootLine!, execLine!, programLine!] as const;
  assert.equal(handsOverToGuard(hook("#!/bin/sh", "# a header comment", "", "  # an indented one", ...canonical.slice(1), "# a trailing comment"), HOOK_NAME), true, "comments and blank lines outside the body");
  const refused: ReadonlyArray<readonly [string, string, string]> = [
    ["a mention in a comment", hook("#!/bin/sh", "# commit-guard.ts", "exit 0"), HOOK_NAME],
    ["a trailing comment mention", hook("#!/bin/sh", "exit 0 # commit-guard.ts"), HOOK_NAME],
    ["a swallowed status", hook(...canonical.slice(0, 4), `${programLine!} || true`), HOOK_NAME],
    ["a command after the guard", hook(...canonical.slice(0, 4), `${programLine!}; exit 0`), HOOK_NAME],
    ["a backgrounded guard", hook(...canonical.slice(0, 4), `${programLine!} &`), HOOK_NAME],
    ["no exec (the hook's status is not the guard's)", hook(...canonical.slice(0, 3), execLine!.replace(/^exec /u, ""), programLine!), HOOK_NAME],
    ["a statement before the guard", hook(canonical[0], "true", ...canonical.slice(1)), HOOK_NAME],
    ["a statement after the guard", hook(...canonical, "exit 0"), HOOK_NAME],
    ["a #!/bin/true interpreter", hook("#!/bin/true", ...canonical.slice(1)), HOOK_NAME],
    ["a #!/bin/sh -n interpreter", hook("#!/bin/sh -n", ...canonical.slice(1)), HOOK_NAME],
    ["no interpreter line", hook(...canonical.slice(1)), HOOK_NAME],
    ["a comment ending in a backslash before `exit 0`", hook("#!/bin/sh", "# note \\", "exit 0", ...canonical.slice(1)), HOOK_NAME],
    ["a comment inside the continuation", hook(...canonical.slice(0, 4), "# the program", programLine!), HOOK_NAME],
    ["a program elsewhere named like the guard", hook(...canonical.slice(0, 4), programLine!.replace(/"\$root\/engine\/scripts\/commit-guard\.ts"/u, "/tmp/x/commit-guard.ts")), HOOK_NAME],
    ["a program beside the root named like the guard", hook(...canonical.slice(0, 4), programLine!.replace("$root/engine/scripts/", "$root/../elsewhere/")), HOOK_NAME],
    ["a bare relative program", hook(...canonical.slice(0, 4), programLine!.replace(/"\$root\/engine\/scripts\/commit-guard\.ts"/u, "./commit-guard.ts")), HOOK_NAME],
    ["another program", hook(...canonical.slice(0, 4), programLine!.replace("commit-guard.ts", "not-the-guard.ts")), HOOK_NAME],
    ["a second root variable", hook(canonical[0], setE!, "other=$(git rev-parse --show-toplevel)", rootLine!, execLine!, programLine!), HOOK_NAME],
    ["an unknown root", hook(...canonical.slice(0, 4), programLine!.replace(/"\$root"$/u, '"/tmp/elsewhere"')), HOOK_NAME],
    ["a substituted command in the arguments", hook(...canonical.slice(0, 4), `${programLine!} "$(rm -rf /)"`), HOOK_NAME],
    ["CRLF line ends", hook(...canonical).replaceAll("\n", "\r\n"), HOOK_NAME],
    ["the merge hook without its flag", guardHookText(HOOK_NAME), "pre-merge-commit"],
    ["the message hook without its file", guardHookText(HOOK_NAME).replace(/\n$/u, " --message\n"), "commit-msg"],
    ["an unguarded hook name", guardHookText(HOOK_NAME), "post-commit"],
    ["an empty hook", "#!/bin/sh\n", HOOK_NAME],
  ];
  for (const [what, text, name] of refused) assert.equal(handsOverToGuard(text, name), false, `${what} was accepted as a hand-over`);
});

test("the rule pairs a deletion with an ignored copy by blob, and reports nothing otherwise", () => {
  // The pure half, planted directly, so the shape of the answer is pinned
  // independently of git being installed and behaving.
  const losses = movedIntoIgnored(
    [
      { path: "docs/paper.md", blob: "aaa", size: 10 },
      { path: "src/gone.ts", blob: "bbb", size: 20 },
    ],
    [
      { path: "archive/paper.md", blob: "aaa" },
      { path: "node_modules/x/index.js", blob: "ccc" },
    ],
  );
  assert.deepEqual([...losses], [{ from: "docs/paper.md", to: "archive/paper.md" }]);
  const judged = judgeLosses(losses, [{ path: "docs/paper.md", blob: "aaa", size: 10 }, { path: "src/gone.ts", blob: "bbb", size: 20 }], NO_DECLARATIONS, () => false);
  assert.deepEqual(judged.accepted, []);
  assert.deepEqual(judged.refused.map((loss) => [loss.deletion.path, loss.copies, loss.verdict]), [["docs/paper.md", ["archive/paper.md"], "undeclared"]]);
  assert.match(stagedMoveLossFailure(judged.refused) ?? "", /archive\/paper\.md/u);
  assert.match(stagedMoveLossFailure(judged.refused) ?? "", /docs\/paper\.md {2}\[staged_move_loss\]/u);
  assert.equal(stagedMoveLossFailure([]), null);
  assert.deepEqual([...movedIntoIgnored([], [{ path: "a", blob: "aaa" }])], []);
});

/** A checkout with no declarations. */
const NO_DECLARATIONS: DeclaredDeletionsView = { recordPath: "/none", head: "1".repeat(40), moves: 1, foreignGitDirectory: null, entries: new Map() };

test("THE DECLARED-DELETION EXCEPTION at the rule: one deletion, every copy, accepted only when declared with the same blob against this HEAD", () => {
  // Planted: the pure half, so each verdict is pinned without git. One
  // deletion has two ignored copies; they are judged TOGETHER, never one
  // pair accepted and the other refused.
  const deletions = [
    { path: "docs/paper.md", blob: "a".repeat(40), size: 10 },
    { path: "docs/notes.md", blob: "b".repeat(40), size: 10 },
  ];
  const losses = [
    { from: "docs/paper.md", to: ".bkp/paper.md" },
    { from: "docs/paper.md", to: "research/frozen/docs/paper.md" },
    { from: "docs/notes.md", to: ".bkp/notes.md" },
  ];
  const bothCopies = [".bkp/paper.md", "research/frozen/docs/paper.md"];
  const declared = (entries: readonly (readonly [string, string, string])[], head = "1".repeat(40), foreignGitDirectory: string | null = null, copies: readonly string[] = bothCopies): DeclaredDeletionsView => ({
    recordPath: "/r", head, moves: 1, foreignGitDirectory, entries: new Map(entries.map(([path, blob, at]) => [path, { path, blob, head: at, moves: 1, copies: [...copies] }])),
  });
  const absent = (): boolean => false;
  const verdicts = (view: DeclaredDeletionsView, present: (path: string) => boolean = absent): readonly (readonly [string, string, number])[] => {
    const { accepted, refused } = judgeLosses(losses, deletions, view, present);
    return [...accepted, ...refused].map((loss) => [loss.deletion.path, loss.verdict, loss.copies.length] as const);
  };
  assert.deepEqual(verdicts(NO_DECLARATIONS), [["docs/paper.md", "undeclared", 2], ["docs/notes.md", "undeclared", 1]]);
  const exact = declared([["docs/paper.md", "a".repeat(40), "1".repeat(40)]]);
  assert.deepEqual(judgeLosses(losses, deletions, exact, absent).accepted.map((loss) => [loss.deletion.path, loss.copies]), [["docs/paper.md", bothCopies]]);
  assert.deepEqual(judgeLosses(losses, deletions, exact, absent).refused.map((loss) => [loss.deletion.path, loss.verdict]), [["docs/notes.md", "undeclared"]], "a declaration of one path covered another");
  assert.deepEqual(verdicts(declared([["docs/paper.md", "c".repeat(40), "1".repeat(40)]])), [["docs/paper.md", "mismatched", 2], ["docs/notes.md", "undeclared", 1]]);
  assert.deepEqual(verdicts(declared([["docs/paper.md", "a".repeat(40), "0".repeat(40)]])), [["docs/paper.md", "stale", 2], ["docs/notes.md", "undeclared", 1]]);
  assert.deepEqual(verdicts(declared([["docs/paper.md", "a".repeat(40), "1".repeat(40)]], "1".repeat(40), "/other/.git")), [["docs/paper.md", "foreign", 2], ["docs/notes.md", "undeclared", 1]]);
  // STILL ABSENT, AND THE SAME COPIES (V1): the path back on disk expires the
  // declaration; a copy it did not record is a copy nobody declared.
  assert.deepEqual(verdicts(exact, (path) => path === "docs/paper.md"), [["docs/paper.md", "expired", 2], ["docs/notes.md", "undeclared", 1]]);
  const oneCopy = declared([["docs/paper.md", "a".repeat(40), "1".repeat(40)]], "1".repeat(40), null, [".bkp/paper.md"]);
  assert.deepEqual(verdicts(oneCopy), [["docs/paper.md", "copies-changed", 2], ["docs/notes.md", "undeclared", 1]]);
  assert.deepEqual(judgeLosses(losses, deletions, oneCopy, absent).refused[0]?.undeclaredCopies, ["research/frozen/docs/paper.md"]);
  const failure = stagedMoveLossFailure(judgeLosses(losses, deletions, declared([["docs/paper.md", "a".repeat(40), "0".repeat(40)], ["docs/notes.md", "d".repeat(40), "1".repeat(40)]]), absent).refused) ?? "";
  assert.match(failure, /docs\/paper\.md {2}\[declared_deletion_stale\]/u);
  assert.match(failure, /docs\/notes\.md {2}\[declared_deletion_mismatched\]/u);
  assert.match(failure, /harness deletions declare/u, "the refusal names the declared way out");
  const changed = stagedMoveLossFailure(judgeLosses(losses, deletions, oneCopy, absent).refused) ?? "";
  assert.match(changed, /docs\/paper\.md {2}\[declared_deletion_copies_changed\]/u);
  assert.match(changed, /also finds research\/frozen\/docs\/paper\.md/u);
  assert.match(stagedMoveLossFailure(judgeLosses(losses, deletions, exact, (path) => path === "docs/paper.md").refused) ?? "", /\[declared_deletion_expired\]/u);
  // The merge route is named only in a merge (N6).
  assert.doesNotMatch(failure, /This is a MERGE/u);
  assert.match(stagedMoveLossFailure(judgeLosses(losses, deletions, NO_DECLARATIONS, absent).refused, true) ?? "", /git has left the merge in progress: declare the deletion, then git commit/u);
});

/**
 * {@link repositoryWithATrackedFile} plus a second tracked file and the
 * `post-commit` hook wired to the REAL program, as `.githooks/post-commit`
 * wires it: the declared-deletion arms drive the whole cycle (declare, the
 * guard's acceptance, the consumption after the commit).
 */
function declaringRepository(): string {
  const root = repositoryWithATrackedFile();
  writeFile(root, "docs/other.md", "# another file\n");
  writeFile(
    root,
    join(HOOKS_DIRECTORY, "post-commit"),
    `#!/bin/sh\nexec node --experimental-strip-types ${JSON.stringify(POST_COMMIT)} "$(git rev-parse --show-toplevel)"\n`,
  );
  chmodSync(join(root, HOOKS_DIRECTORY, "post-commit"), 0o755);
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const wired = commit(root, "wire the post-commit hook");
  assert.equal(wired.status, 0, `wiring the post-commit hook was refused: ${wired.stderr}`);
  return root;
}

/** The ignored-copy move every declared arm starts from: `docs/paper.md` into the ignored `archive/`. */
function moveThePaperIntoTheArchive(root: string): void {
  mkdirSync(join(root, "archive"), { recursive: true });
  renameSync(join(root, "docs", "paper.md"), join(root, "archive", "paper.md"));
}

test("DRIVEN: a DECLARED deletion with an ignored copy is ACCEPTED, the copy stays, and the post-commit hook consumes the declaration", () => {
  const root = declaringRepository();
  moveThePaperIntoTheArchive(root);
  declareDeletions(root, ["docs/paper.md"]);
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const accepted = commit(root, "retire the paper on purpose, keeping the archived copy");
  assert.equal(accepted.status, 0, `a declared deletion was refused: ${accepted.stderr}`);
  assert.match(accepted.stderr, /DECLARED DELETIONS/u, "an accepted declared deletion must be heard");
  assert.match(accepted.stderr, /archive\/paper\.md/u);
  assert.ok(!committedPaths(root).includes("docs/paper.md"), "the declared deletion was not committed");
  assert.equal(readFileSync(join(root, "archive", "paper.md"), "utf8"), "# the only copy\n", "the ignored copy must stay on disk");
  // CONSUMED: the post-commit hook removed the declaration the commit used.
  assert.equal(existsSync(declaredDeletionsPath(root)), false, "the post-commit hook did not consume the declaration");
  assert.deepEqual(declaredDeletionsStatus(root).declarations, []);
});

test("DRIVEN: an ACCIDENTAL move is still refused, and a declaration of ANOTHER path does not cover it", () => {
  const root = declaringRepository();
  rmSync(join(root, "docs", "other.md"));
  declareDeletions(root, ["docs/other.md"]);
  moveThePaperIntoTheArchive(root);
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "one declared deletion, one accidental move");
  assert.notEqual(refused.status, 0, "an undeclared move into an ignored path was accepted");
  assert.match(refused.stderr, /docs\/paper\.md {2}\[staged_move_loss\]/u);
  assert.doesNotMatch(refused.stderr, /DECLARED DELETIONS/u, "no deletion here has an ignored copy AND a declaration");
  assert.ok(committedPaths(root).includes("docs/paper.md"), "the accidental deletion was committed anyway");
  assert.ok(committedPaths(root).includes("docs/other.md"), "the refused commit landed");
  assert.equal(declaredDeletionsStatus(root).declarations.length, 1, "a refused commit consumed a declaration");
});

test("DRIVEN: a STALE declaration (HEAD moved since) is REFUSED; declaring again against the new HEAD is accepted", () => {
  const root = declaringRepository();
  moveThePaperIntoTheArchive(root);
  declareDeletions(root, ["docs/paper.md"]);
  writeFile(root, "unrelated.md", "# something else\n");
  execFileSync("git", ["add", "unrelated.md"], { cwd: root, stdio: "pipe" });
  const moved = commit(root, "an unrelated commit moves HEAD");
  assert.equal(moved.status, 0, moved.stderr);
  assert.deepEqual(declaredDeletionsStatus(root).declarations.map((entry) => entry.state), ["stale"], "a commit that did not delete the path consumed its declaration");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "the deletion, on a stale declaration");
  assert.notEqual(refused.status, 0, "a stale declaration was honoured");
  assert.match(refused.stderr, /docs\/paper\.md {2}\[declared_deletion_stale\]/u);
  assert.match(refused.stderr, /HEAD has moved since/u);
  assert.ok(committedPaths(root).includes("docs/paper.md"));

  declareDeletions(root, ["docs/paper.md"]);
  const accepted = commit(root, "the deletion, declared against this HEAD");
  assert.equal(accepted.status, 0, `a fresh declaration was refused: ${accepted.stderr}`);
  assert.ok(!committedPaths(root).includes("docs/paper.md"));
  assert.equal(existsSync(declaredDeletionsPath(root)), false);
});

test("DRIVEN: a MISMATCHED declaration (the file changed since) is REFUSED", () => {
  const root = declaringRepository();
  moveThePaperIntoTheArchive(root);
  declareDeletions(root, ["docs/paper.md"]);
  // The file comes back with other bytes and they are committed: the blob
  // the declaration names is no longer the one a deletion would remove.
  writeFile(root, "docs/paper.md", "# the paper, revised after it was declared\n");
  execFileSync("git", ["add", "docs/paper.md"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "revise the paper").status, 0);
  renameSync(join(root, "docs", "paper.md"), join(root, "archive", "paper.md"));
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "the revised paper, on the old declaration");
  assert.notEqual(refused.status, 0, "a declaration of other bytes was honoured");
  assert.match(refused.stderr, /docs\/paper\.md {2}\[declared_deletion_mismatched\]/u);
  assert.ok(committedPaths(root).includes("docs/paper.md"));
});

test("DRIVEN: a declaration record copied from another repository is FOREIGN and refused", () => {
  const first = declaringRepository();
  moveThePaperIntoTheArchive(first);
  declareDeletions(first, ["docs/paper.md"]);
  const second = declaringRepository();
  moveThePaperIntoTheArchive(second);
  mkdirSync(dirname(declaredDeletionsPath(second)), { recursive: true });
  copyFileSync(declaredDeletionsPath(first), declaredDeletionsPath(second));
  execFileSync("git", ["add", "-A"], { cwd: second, stdio: "pipe" });
  const refused = commit(second, "a deletion covered only by another repository's declaration");
  assert.notEqual(refused.status, 0, "another repository's declaration was honoured");
  assert.match(refused.stderr, /docs\/paper\.md {2}\[declared_deletions_foreign\]/u);
  assert.ok(committedPaths(second).includes("docs/paper.md"));
});

test("DRIVEN (V1): declare, restore the file, then an ACCIDENTAL move of it — the copy nobody declared is refused", () => {
  // wf-del-verify A1a: the declaration was made while the file was gone; it
  // came back (`git checkout --`) and was later moved into an ignored folder
  // by accident. The declaration used to cover the accident.
  const root = declaringRepository();
  rmSync(join(root, "docs", "paper.md"));
  declareDeletions(root, ["docs/paper.md"]);
  execFileSync("git", ["checkout", "--", "docs/paper.md"], { cwd: root, stdio: "pipe" });
  assert.deepEqual(declaredDeletionsStatus(root).declarations.map((entry) => entry.state), ["expired"], "a file that came back left its declaration pending");
  moveThePaperIntoTheArchive(root);
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "an accidental move under an old declaration");
  assert.notEqual(refused.status, 0, "a declaration made before the file came back covered its accidental move");
  assert.match(refused.stderr, /docs\/paper\.md {2}\[declared_deletion_copies_changed\]/u);
  assert.match(refused.stderr, /also finds archive\/paper\.md/u);
  assert.ok(committedPaths(root).includes("docs/paper.md"), "the accidental deletion was committed anyway");
});

test("DRIVEN (V1): a copy made AFTER the declaration is refused; declaring again records it and the commit is accepted", () => {
  // wf-del-verify A11b: declared while no ignored copy existed.
  const root = declaringRepository();
  rmSync(join(root, "docs", "paper.md"));
  declareDeletions(root, ["docs/paper.md"]);
  writeFile(root, "archive/paper.md", "# the only copy\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "a copy nobody declared");
  assert.notEqual(refused.status, 0, "a copy made after the declaration was accepted");
  assert.match(refused.stderr, /\[declared_deletion_copies_changed\]/u);
  declareDeletions(root, ["docs/paper.md"]);
  const accepted = commit(root, "the copy is declared now");
  assert.equal(accepted.status, 0, `a declaration that records the copy was refused: ${accepted.stderr}`);
  assert.match(accepted.stderr, /DECLARED DELETIONS/u);
});

test("DRIVEN (V1 expired): declared, restored, then untracked in place with `git rm --cached` — the path is on disk again, so the declaration is EXPIRED and the commit is refused", () => {
  // wf-del2-correctness NEW-2: the guard's own "still absent at commit" check
  // had no arm (mutant VM15, `present` always false, survived and accepted this
  // commit with the file left on disk untracked).
  const root = declaringRepository();
  moveThePaperIntoTheArchive(root);
  declareDeletions(root, ["docs/paper.md"]);
  execFileSync("git", ["checkout", "--", "docs/paper.md"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["rm", "-q", "--cached", "docs/paper.md"], { cwd: root, stdio: "pipe" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const refused = commit(root, "an in-place untracking under a declaration of a file that came back");
  assert.notEqual(refused.status, 0, "a declaration covered a deletion whose path is on disk again");
  assert.match(refused.stderr, /docs\/paper\.md {2}\[declared_deletion_expired\]/u);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), head, "HEAD moved: the refused commit landed");
});

test("DRIVEN (gitlink): removing a submodule is ACCEPTED — a gitlink names another repository's commit, never a blob of this one", () => {
  // wf-del2-correctness NEW-3: without the gitlink skip the guard asked this
  // object store for the submodule's commit and refused every submodule
  // removal ("does not hold <commit>"); mutant VM1 survived the suite.
  const upstream = createTempDir("ch-commit-move-submodule-");
  execFileSync("git", ["init", "-q"], { cwd: upstream, stdio: "pipe" });
  writeFile(upstream, "lib.md", "# a library\n");
  execFileSync("git", ["add", "lib.md"], { cwd: upstream, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=guard@example.invalid", "-c", "user.name=guard", "commit", "-s", "-q", "-m", "lib"], { cwd: upstream, stdio: "pipe" });
  const root = repositoryWithATrackedFile();
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "vendor/sub"], { cwd: root, stdio: "pipe" });
  const added = commit(root, "add a submodule");
  assert.equal(added.status, 0, `adding a submodule was refused: ${added.stderr}`);
  execFileSync("git", ["rm", "-q", "vendor/sub"], { cwd: root, stdio: "pipe" });
  assert.match(execFileSync("git", ["diff", "--cached", "--raw", "--no-abbrev"], { cwd: root, encoding: "utf8" }), /^:160000 000000 /mu, "the fixture does not stage a gitlink deletion");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const removed = commit(root, "remove the submodule");
  assert.equal(removed.status, 0, `removing a submodule was refused: ${removed.stderr}`);
  assert.notEqual(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), head, "HEAD did not move");
  assert.ok(!committedPaths(root).includes("vendor/sub"));
});

test("blobSizes: a well-formed object name the store does not hold is the typed git_blob_missing, never a size", () => {
  // wf-del2-correctness NEW-4 (mutant VM13 survived): a short answer from
  // `cat-file --batch-check` must never read as "no size needed".
  const root = repositoryWithATrackedFile();
  const absent = "1".repeat(40);
  assert.throws(() => blobSizes(root, [absent], "inherited"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "git_blob_missing");
    assert.match((error as Error).message, new RegExp(absent, "u"));
    return true;
  });
});

test("ignoredCopies: a checkout git cannot list is the typed ignored_population_unreadable, never \"no ignored files\"", () => {
  // wf-del2-design D10: `machineIgnoredFiles(...) ?? []` read "not a work tree"
  // as an empty population, so nothing was paired and the commit certified.
  const notACheckout = createTempDir("ch-commit-move-no-git-");
  assert.throws(() => ignoredCopies(notACheckout, [{ path: "docs/paper.md", blob: "1".repeat(40), size: 16 }], "directory"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "ignored_population_unreadable");
    return true;
  });
});

test("DRIVEN (V4): a declaration made before HEAD moved stays stale even after reset --soft brings HEAD back", () => {
  // wf-del-verify A4b: `reset --soft` to the declared commit made it pending again.
  const root = declaringRepository();
  moveThePaperIntoTheArchive(root);
  declareDeletions(root, ["docs/paper.md"]);
  writeFile(root, "unrelated.md", "# something else\n");
  execFileSync("git", ["add", "unrelated.md"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "HEAD moves").status, 0);
  execFileSync("git", ["reset", "-q", "--soft", "HEAD~1"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "the deletion, on a declaration HEAD moved away from and back to");
  assert.notEqual(refused.status, 0, "a declaration revived by reset --soft was honoured");
  assert.match(refused.stderr, /docs\/paper\.md {2}\[declared_deletion_stale\]/u);
  assert.ok(committedPaths(root).includes("docs/paper.md"));
});

test("DRIVEN (V2): a commit into another git directory (GIT_DIR + a linked work tree) is judged by THAT git's declarations, never the worktree's", () => {
  // wf-del-verify A9a: the guard read the worktree's record and HEAD while
  // judging the main git's index, so a worktree-local declaration made against
  // another HEAD covered a deletion committed on main.
  const main = declaringRepository();
  const linked = join(createTempDir("ch-commit-move-linked-"), "tree");
  execFileSync("git", ["worktree", "add", "-q", "-b", "side", linked], { cwd: main, stdio: "pipe" });
  writeFile(linked, "side.md", "# only on the side branch\n");
  execFileSync("git", ["add", "side.md"], { cwd: linked, stdio: "pipe" });
  assert.equal(commit(linked, "the side branch moves ahead").status, 0);
  moveThePaperIntoTheArchive(linked);
  declareDeletions(linked, ["docs/paper.md"]);
  const mainGit = { GIT_DIR: join(main, ".git"), GIT_WORK_TREE: linked };
  execFileSync("git", ["add", "-A"], { cwd: linked, stdio: "pipe", env: { ...process.env, ...mainGit } });
  const refused = commit(linked, "main's index, the linked work tree", mainGit);
  assert.notEqual(refused.status, 0, "a worktree's declaration covered a deletion committed into main's git");
  assert.match(refused.stderr, /docs\/paper\.md {2}\[staged_move_loss\]/u);
  assert.ok(committedPaths(main).includes("docs/paper.md"), "main lost the file");

  // And a declaration made IN THAT GIT is what counts: accepted, then consumed
  // from that git's record by the post-commit hook, which runs in the same
  // environment (the worktree's own record is not the one consumed).
  moveThePaperIntoTheArchive(main);
  declareDeletions(main, ["docs/paper.md"]);
  const accepted = commit(linked, "main's index, declared in main's git", mainGit);
  assert.equal(accepted.status, 0, `a declaration of the committing git was refused: ${accepted.stderr}`);
  assert.match(accepted.stderr, /DECLARED DELETIONS/u);
  assert.ok(!committedPaths(main).includes("docs/paper.md"));
  assert.equal(existsSync(declaredDeletionsPath(main)), false, "the post-commit hook did not consume the committing git's declaration");
  assert.equal(declaredDeletionsStatus(linked).declarations.length, 1, "the post-commit hook consumed the worktree's record instead");
});

test("DRIVEN (P3): a move into a folder only .git/info/exclude ignores, and a rename to a core.excludesFile pattern, are REFUSED", () => {
  // The move-loss population is what `git add -A` skipped ON THIS MACHINE:
  // judged by the versioned rules alone, both commits dropped the file green.
  const excluded = repositoryWithATrackedFile();
  writeFileSync(join(excluded, ".git", "info", "exclude"), "/scratchx/\n");
  mkdirSync(join(excluded, "scratchx"));
  renameSync(join(excluded, "docs", "paper.md"), join(excluded, "scratchx", "paper.md"));
  execFileSync("git", ["add", "-A"], { cwd: excluded, stdio: "pipe" });
  const byInfo = commit(excluded, "into a machine-local ignored folder");
  assert.notEqual(byInfo.status, 0, "a move into a .git/info/exclude folder dropped a tracked file");
  assert.match(byInfo.stderr, /scratchx\/paper\.md/u);

  const global = repositoryWithATrackedFile();
  const excludesFile = join(createTempDir("ch-commit-move-excludes-"), "ignore");
  writeFileSync(excludesFile, "*.orig\n");
  execFileSync("git", ["config", "core.excludesFile", excludesFile], { cwd: global, stdio: "pipe" });
  renameSync(join(global, "docs", "paper.md"), join(global, "docs", "paper.md.orig"));
  execFileSync("git", ["add", "-A"], { cwd: global, stdio: "pipe" });
  const byExcludes = commit(global, "renamed to a core.excludesFile pattern");
  assert.notEqual(byExcludes.status, 0, "a rename to a core.excludesFile pattern dropped a tracked file");
  assert.match(byExcludes.stderr, /docs\/paper\.md\.orig/u);
  assert.ok(committedPaths(global).includes("docs/paper.md"));
});

test("DRIVEN (P4): a file moved into an ignored folder with a symbolic link left in its place (a typechange) is REFUSED", () => {
  const root = repositoryWithATrackedFile();
  moveThePaperIntoTheArchive(root);
  symlinkSync("../archive/paper.md", join(root, "docs", "paper.md"));
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(), "T  docs/paper.md", "the fixture is not a typechange");
  const refused = commit(root, "the file's bytes leave for an ignored folder behind a symlink");
  assert.notEqual(refused.status, 0, "a typechange that dropped the file's content was accepted");
  assert.match(refused.stderr, /docs\/paper\.md {2}\[staged_move_loss\]/u);
});

test("DRIVEN (P1): a move into an ignored folder beside a SIMILAR new tracked file is REFUSED — rename detection never hides a loss", () => {
  const root = guardedRepository();
  writeFile(root, ".gitignore", "/archive/\n");
  const lines = Array.from({ length: 20 }, (_, index) => `line ${String(index)} of the long paper`);
  writeFile(root, "docs/long.md", `${lines.join("\n")}\n`);
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "a long paper").status, 0);
  mkdirSync(join(root, "archive"), { recursive: true });
  renameSync(join(root, "docs", "long.md"), join(root, "archive", "long.md"));
  writeFile(root, "docs/long-new.md", `${[...lines.slice(0, 19), "a changed last line"].join("\n")}\n`);
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  // The confound, asserted: with rename detection git reads this as a rename.
  assert.match(execFileSync("git", ["diff", "--cached", "--name-status"], { cwd: root, encoding: "utf8" }), /^R\d+\tdocs\/long\.md\tdocs\/long-new\.md$/mu);
  const refused = commit(root, "a similar new file masks the move");
  assert.notEqual(refused.status, 0, "a rename-similar new file hid a move into an ignored folder");
  assert.match(refused.stderr, /docs\/long\.md {2}\[staged_move_loss\]/u);
  assert.match(refused.stderr, /archive\/long\.md/u);
});

test("DRIVEN (N6): a merge bringing a deliberate deletion is refused with the route — the merge stays in progress, declare, commit — and that route is accepted", () => {
  const root = declaringRepository();
  // Wired as `.githooks/pre-merge-commit` wires it: the same guard, told this is the merge's own commit.
  writeFile(root, join(HOOKS_DIRECTORY, "pre-merge-commit"), guardHookText("pre-merge-commit", JSON.stringify(COMMIT_GUARD)));
  chmodSync(join(root, HOOKS_DIRECTORY, "pre-merge-commit"), 0o755);
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "wire the pre-merge-commit hook").status, 0);
  const base = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-q", "-b", "retire"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["rm", "-q", "docs/paper.md"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "retire the paper").status, 0);
  execFileSync("git", ["checkout", "-q", base], { cwd: root, stdio: "pipe" });
  writeFile(root, "local.md", "# a local change, so the merge is not a fast-forward\n");
  execFileSync("git", ["add", "local.md"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "local work").status, 0);
  writeFile(root, "archive/paper.md", "# the only copy\n");
  const merged = spawnSync("git", ["merge", "--signoff", "-q", "--no-edit", "retire"], { cwd: root, encoding: "utf8" });
  assert.notEqual(merged.status, 0, "the merge bringing a deletion with an ignored copy was accepted");
  assert.match(merged.stderr, /This is a MERGE/u);
  assert.match(merged.stderr, /git has left the merge in progress: declare the deletion, then git commit/u);
  assert.doesNotMatch(merged.stderr, /merge --abort/u, "the route must not send anyone through a reset-family command");
  // The route, exactly as printed: git kept MERGE_HEAD; declare, then commit.
  assert.ok(existsSync(join(root, ".git", "MERGE_HEAD")), "git did not leave the merge in progress after the refusal");
  declareDeletions(root, ["docs/paper.md"]);
  const accepted = commit(root, "merge the retirement, declared");
  assert.equal(accepted.status, 0, `the declared merge route was refused: ${accepted.stderr}`);
  assert.ok(!committedPaths(root).includes("docs/paper.md"));
  assert.equal(execFileSync("git", ["rev-list", "--parents", "-1", "HEAD"], { cwd: root, encoding: "utf8" }).trim().split(" ").length, 3, "the accepted commit is the merge");
});

test("DRIVEN (F-3): the BASELINE WARNING says where its run was measured when a candidate's copy-back imported it", () => {
  // step6-readiness-2 F-3: qualification runs in a candidate, so the live
  // ledger's newest row was ten days old; the copy-back now imports the
  // candidate's rows (`importJudgedRuns`), and the warning names the candidate.
  const root = repositoryWithATrackedFile();
  const ledger = join(root, WEB_RUN_HISTORY_PATH);
  const plant = (runs: readonly object[]): void => {
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, JSON.stringify({ runs }));
  };
  const row = { timestamp: "2026-09-30T00:00:00.000Z", cpuMsPerTestFile: 1, testModuleCount: 1, failures: ["owned red"] };
  plant([row]);
  writeFile(root, "docs/paper.md", "# edited once\n");
  execFileSync("git", ["add", "--", "docs/paper.md"], { cwd: root, stdio: "pipe" });
  const live = commit(root, "a live row");
  assert.equal(live.status, 0, live.stderr);
  assert.match(live.stderr, /BASELINE WARNING — the last recorded full-suite run \(2026-09-30T00:00:00\.000Z\) had 1 failure row/u);
  plant([{ ...row, importedFrom: "/state/some-candidate/repo" }]);
  writeFile(root, "docs/paper.md", "# edited twice\n");
  execFileSync("git", ["add", "--", "docs/paper.md"], { cwd: root, stdio: "pipe" });
  const imported = commit(root, "an imported row");
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stderr, /\(2026-09-30T00:00:00\.000Z, measured in the candidate \/state\/some-candidate\/repo\) had 1 failure row/u);
});
