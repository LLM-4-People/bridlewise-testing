/**
 * TWO PRS THAT ADD DIFFERENT MODULES MERGE WITH ZERO CONFLICTS (#221).
 *
 * The merge queue dropped PRs touching unrelated code because every branch
 * rewrote the same committed generated aggregates — the architecture
 * manifest's per-module export counts and name hashes, the artifact
 * inventory's digests, the test-surface dispositions' whole-file hash, the
 * README consumer blocks — and GitHub's queue cannot regenerate them.
 *
 * The measure, planted: on a working copy of this tree, add a module and its
 * test (in ONE folder, the worst case for any sorted list), run the real
 * `harness regenerate --write`, and do it again for a second module from the
 * same base. git's own three-way merge (`git merge-file`) of every file both
 * branches changed must find no conflict; and, stronger, neither branch may
 * change any file but the two it added, so no aggregate is shared at all.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ownedFiles } from "../../src/git/repository-ownership.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { harnessRegenerate } from "../../src/workflow/harness-commands.ts";
import { createRepositoryWorkingCopy, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";

/**
 * sha256 of every file a commit could record in the copy at `root`, by repository-relative path: the one
 * ownership reader's answer (`ownedFiles`: tracked, plus untracked and not ignored, unstaged deletions
 * absent), never a hand-kept list of folders to skip. The test inventory is a cache, never committed.
 */
function snapshot(root: string): ReadonlyMap<string, string> {
  const owned = ownedFiles(root);
  assert.ok(owned !== undefined && owned.length > 0, "the copy is a repository with files (liveness)");
  const files = new Map<string, string>();
  for (const path of owned) {
    const absolute = join(root, path);
    if (statSync(absolute).isFile()) files.set(path, sha256(readFileSync(absolute)));
  }
  files.delete("engine/traceability/s1-test-inventory.json");
  return files;
}

/** The repository-relative files a branch changed, added or removed relative to `base`. */
function changed(base: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): readonly string[] {
  return [...new Set([...base.keys(), ...after.keys()])].filter((path) => base.get(path) !== after.get(path)).toSorted();
}

/** One branch, prepared from the same base: a whole-repository working copy and its snapshot before anything changes. */
interface Branch {
  readonly name: string;
  readonly root: string;
  readonly engineRoot: string;
  readonly before: ReadonlyMap<string, string>;
  readonly added: readonly string[];
}

function branchFrom(name: string): Branch {
  // The WHOLE repository: a regenerate writes beside the engine too (the web's READMEs, the forge and community files).
  const copy = createRepositoryWorkingCopy(`adding-${name}-`);
  return { name, root: copy.root, engineRoot: copy.engineRoot, before: snapshot(copy.root), added: [`engine/src/workflow/${name}.ts`, `engine/test/workflow/${name}.test.ts`] };
}

/** Add the branch's module and test in src/workflow/ and test/workflow/, regenerate, answer what changed. */
function addAndRegenerate(branch: Branch): readonly string[] {
  const symbol = branch.name.replaceAll("-", "");
  writeFileSync(join(branch.root, branch.added[0]!), `/** A module added on its own branch. */\nexport function ${symbol}(): number {\n  return 1;\n}\n`);
  writeFileSync(join(branch.root, branch.added[1]!), `import assert from "node:assert/strict";\nimport test from "node:test";\n\nimport { ${symbol} } from "../../src/workflow/${branch.name}.ts";\n\ntest("${branch.name} answers one", () => {\n  assert.equal(${symbol}(), 1);\n});\n`);
  // The copy's own index holds the new sources, as a commit would (a new test source must be in the index).
  execFileSync("git", ["add", "-N", "--", ...branch.added], { cwd: branch.root });
  const regenerated = harnessRegenerate(branch.engineRoot, { write: true });
  assert.equal(regenerated.status, "pass", `the regenerate of ${branch.name} converges: ${JSON.stringify(regenerated.result).slice(0, 2000)}`);
  return changed(branch.before, snapshot(branch.root));
}

function textAt(root: string, path: string): string {
  return existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : "";
}

/** git's own three-way merge of one file: the number of conflicting hunks (`git merge-file` exits with it). */
function mergeConflicts(scratch: string, base: string, ours: string, theirs: string): number {
  const [basePath, oursPath, theirsPath] = ["base", "ours", "theirs"].map((side) => join(scratch, `merge-${side}`));
  writeFileSync(basePath!, base);
  writeFileSync(oursPath!, ours);
  writeFileSync(theirsPath!, theirs);
  const merged = spawnSync("git", ["merge-file", "-p", "--quiet", oursPath!, basePath!, theirsPath!], { encoding: "utf8" });
  assert.ok(merged.status !== null && merged.status >= 0 && merged.status < 128, `git merge-file ran: ${merged.stderr}`);
  return merged.status;
}

test("two branches that add different modules in one folder change only their own files: their merge cannot conflict", () => {
  const one = branchFrom("zz-added-on-one-branch");
  const other = branchFrom("zz-added-on-another");
  try {
    const oneChanges = addAndRegenerate(one);
    // The base of every file the first branch changed, read while the second copy is still the base.
    const base = new Map(oneChanges.map((path) => [path, textAt(other.root, path)]));
    const otherChanges = addAndRegenerate(other);
    const scratch = mkdtempSync(join(one.root, ".merge-"));
    const conflicting = oneChanges
      .filter((path) => otherChanges.includes(path))
      .flatMap((path) => {
        const hunks = mergeConflicts(scratch, base.get(path)!, textAt(one.root, path), textAt(other.root, path));
        return hunks === 0 ? [] : [`${path} (${hunks} conflicting hunk${hunks === 1 ? "" : "s"})`];
      });
    assert.deepEqual(conflicting, [], "git merges the two branches without a conflict");
    assert.deepEqual(oneChanges, [...one.added].toSorted(), "adding a module and its test rewrites no committed aggregate");
    assert.deepEqual(otherChanges, [...other.added].toSorted(), "adding a module and its test rewrites no committed aggregate");
  } finally {
    removeRepositoryLocalTemporaryDirectory(one.root);
    removeRepositoryLocalTemporaryDirectory(other.root);
  }
});
