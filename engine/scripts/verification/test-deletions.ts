/**
 * A DELETED TEST IS A NAMED DECISION: the `Test-deleted:` trailer.
 *
 * The suite shrinks in one way only: a test source leaves the recognizable
 * test surface (`isScannedRecognizableTestSource`). A rename that keeps it on
 * the surface still removes a path, and a rename off it (`test/` to `tests/`)
 * removes hundreds. So EVERY path a commit takes off the surface is a
 * deletion, renames included (git's rename detection is a similarity guess,
 * never a decision), and the commit names each one in its own message:
 *
 *   Test-deleted: engine/test/workflow/old-thing.test.ts
 *
 * One trailer per path, the repository-relative path, so
 * `git log --grep '^Test-deleted: <path>'` finds the commit that decided it.
 * Nothing is committed beside the trailer: no list two pull requests could
 * both rewrite (#221). `harness sync --prune <path>` remains only where it
 * writes something: dropping the entry of a deleted test that had an
 * exception disposition (`test_surface_prune_refused`).
 *
 * ONE rule ({@link judgeTestDeletions}), asked of a tree and its parents: the
 * deleted sources are the surface paths EVERY parent holds and the tree does
 * not (so a merge that brings in a deletion its other side already made and
 * named deletes nothing new; an evil merge that drops a test itself does).
 * Every deleted source must be named, and every name must be a deleted source
 * (a trailer naming a test the commit keeps is refused: a declaration nobody
 * can act on hides the one that was meant).
 *
 * Three places ask it, with this one function:
 * - the `commit-msg` hook (`scripts/commit-guard.ts --message`), before the
 *   commit: the tree is the index, the parents `HEAD` and any `MERGE_HEAD`;
 * - the `post-commit` hook, after it: an amend that dropped a trailer is only
 *   visible there, and is reported with its repair;
 * - the required `commit-records` workflow, run from MAIN's definition and
 *   main's code over every commit of a pull request and a merge group
 *   (`node scripts/verification/test-deletions.ts --range <base>..<head>`),
 *   so a branch that skipped the hook cannot land the deletion unnamed.
 */
import { fileURLToPath } from "node:url";

import { HarnessError } from "../../src/kernel/errors.ts";
import { isScannedRecognizableTestSource } from "../../src/kernel/test-surface-manifest.ts";
import { pendingCommitParents, repositoryToplevel } from "../../src/git/repository-ownership.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { engineRelativePath } from "../../src/workflow/checkout-setup.ts";
import { gitText as git, messageTrailerValues } from "./commit-trailers.ts";

/** The trailer key a commit deleting a test carries (exact case: `git log --grep` finds it). */
export const TEST_DELETED_TRAILER = "Test-deleted";

/** This engine's own root: the test surface lives below it. */
const ENGINE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The engine's folder below the top of a repository (`engine`), derived from
 * THIS engine's own checkout as the commit guard derives it: a hook runs the
 * engine of a tree with the same layout, and a fixture runs the real one
 * against a scratch repository.
 */
export function engineFolder(): string {
  const top = repositoryToplevel(ENGINE_ROOT, "directory");
  const folder = top === undefined ? undefined : engineRelativePath(top, ENGINE_ROOT);
  if (folder === undefined || folder.length === 0 || folder.startsWith("..")) {
    throw new HarnessError(`the engine ${ENGINE_ROOT} is not a folder below the top of a git working tree`, "test_deletion_engine_unplaced");
  }
  return folder;
}

/** The tree a judgement reads: the index (the commit being made) or a recorded commit. */
export type JudgedTree = Readonly<{ kind: "index" }> | Readonly<{ kind: "commit"; commit: string }>;

/** The surface paths (repository-relative) `parent` holds and `tree` does not. */
function deletedAgainst(root: string, parent: string, tree: JudgedTree, folder: string): ReadonlySet<string> {
  const options = ["--name-only", "--no-renames", "--diff-filter=D", "-z"];
  const listing = tree.kind === "index"
    ? git(root, ["diff", "--cached", ...options, parent, "--", `${folder}/`])
    : git(root, ["diff-tree", "-r", ...options, parent, tree.commit, "--", `${folder}/`]);
  return new Set(listing.split("\0").filter((path) => path.startsWith(`${folder}/`) && isScannedRecognizableTestSource(path.slice(folder.length + 1))));
}

/** The recognizable test sources `tree` deletes from EVERY one of `parents`, sorted (none for a root commit). */
export function deletedTestSources(root: string, parents: readonly string[], tree: JudgedTree, folder: string = engineFolder()): readonly string[] {
  const [first, ...others] = parents;
  if (first === undefined) return [];
  const deleted = deletedAgainst(root, first, tree, folder);
  const fromEvery = others.reduce<readonly string[]>((kept, parent) => {
    const also = deletedAgainst(root, parent, tree, folder);
    return kept.filter((path) => also.has(path));
  }, [...deleted]);
  return fromEvery.toSorted();
}

/** What a commit's trailers leave wrong: deleted sources nobody named, and names of sources it did not delete. */
export type TestDeletionVerdict = Readonly<{ undeclared: readonly string[]; notDeleted: readonly string[] }>;

/** THE rule: every deleted source named, every name a deleted source. */
export function judgeTestDeletions(deleted: readonly string[], declared: readonly string[]): TestDeletionVerdict {
  const named = new Set(declared);
  const removed = new Set(deleted);
  return {
    undeclared: deleted.filter((path) => !named.has(path)),
    notDeleted: [...new Set(declared)].filter((path) => !removed.has(path)).toSorted(),
  };
}

/** The verdict as refusal lines (empty when the commit names exactly what it deletes). */
export function testDeletionProblems(verdict: TestDeletionVerdict): readonly string[] {
  return [
    ...verdict.undeclared.map((path) => `${path}: deleted from the test surface without a ${TEST_DELETED_TRAILER} trailer (test_deletion_undeclared)`),
    ...verdict.notDeleted.map((path) => `${path}: named by a ${TEST_DELETED_TRAILER} trailer, but this commit does not delete it (test_deletion_declared_not_deleted)`),
  ];
}

/** The `commit-msg` question: the staged change (parents `HEAD` and any `MERGE_HEAD`) against the message about to be recorded. */
export function stagedTestDeletionVerdict(root: string, message: string, folder: string = engineFolder()): TestDeletionVerdict {
  const deleted = deletedTestSources(root, pendingCommitParents(root, "inherited"), { kind: "index" }, folder);
  return judgeTestDeletions(deleted, messageTrailerValues(root, message, TEST_DELETED_TRAILER));
}

/** The question asked of a recorded commit: its real parents and its own message. */
export function commitTestDeletionVerdict(root: string, commit: string, folder: string = engineFolder()): TestDeletionVerdict {
  const parents = git(root, ["rev-list", "--parents", "-n", "1", commit]).trim().split(" ").slice(1);
  const deleted = deletedTestSources(root, parents, { kind: "commit", commit }, folder);
  return judgeTestDeletions(deleted, messageTrailerValues(root, git(root, ["log", "-1", "--format=%B", commit]), TEST_DELETED_TRAILER));
}

/** Every commit of `range` (`<base>..<head>`, oldest first) with what its trailers leave wrong; commits that are right are left out. */
export function rangeTestDeletionProblems(root: string, range: string, folder: string = engineFolder()): ReadonlyArray<Readonly<{ commit: string; problems: readonly string[] }>> {
  const commits = git(root, ["rev-list", "--reverse", range, "--"]).split("\n").filter((line) => line.length > 0);
  return commits.flatMap((commit) => {
    const problems = testDeletionProblems(commitTestDeletionVerdict(root, commit, folder));
    return problems.length === 0 ? [] : [{ commit, problems }];
  });
}

// The required workflow's door: `--range <base>..<head>`, judged in the
// repository holding the current directory.
if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const at = process.argv.indexOf("--range");
  const range = at < 0 ? undefined : process.argv[at + 1];
  const root = repositoryToplevel(process.cwd(), "directory");
  if (range === undefined || root === undefined) {
    process.stderr.write("usage: node scripts/verification/test-deletions.ts --range <base>..<head> (inside a git working tree)\n");
    process.exitCode = 2;
  } else {
    const refused = rangeTestDeletionProblems(root, range);
    for (const { commit, problems } of refused) {
      process.stderr.write(`${commit}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n`);
    }
    process.stdout.write(`${JSON.stringify({ range, refusedCommits: refused.length })}\n`);
    if (refused.length > 0) {
      process.stderr.write(
        `\nA test deletion is a decision the deleting commit names: one "${TEST_DELETED_TRAILER}: <path>" trailer per test source it takes off the surface, ` +
          `and no trailer for a test it keeps. Reword the commits named above.\n`,
      );
      process.exitCode = 1;
    }
  }
}
