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
 * same base. Neither branch may change any file but the two it added — so the
 * two branches touch disjoint files, and their merge has nothing to conflict
 * on.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import { harnessRegenerate } from "../../src/workflow/harness-commands.ts";
import { createRepositoryWorkingCopy, engineGeneratorPopulation, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";

/** Folders a regenerate never commits (caches, dependencies, build output, runtime state). */
const UNCOMMITTED = new Set(["node_modules", ".bridlewise", "dist", ".git"]);

/** sha256 of every committed-kind file under `root`, by engine-relative path (the test inventory is a cache, never committed). */
function snapshot(root: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (UNCOMMITTED.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.set(relative(root, absolute).split("\\").join("/"), sha256(readFileSync(absolute)));
    }
  };
  walk(root);
  files.delete("traceability/s1-test-inventory.json");
  return files;
}

/** The engine-relative files a branch changed, added or removed relative to `base`. */
function changed(base: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): readonly string[] {
  return [...new Set([...base.keys(), ...after.keys()])].filter((path) => base.get(path) !== after.get(path)).toSorted();
}

/** One branch: add `name`'s module and test in src/workflow/ and test/workflow/, regenerate, answer what changed. */
function branchAdding(name: string): Readonly<{ changes: readonly string[]; added: readonly string[] }> {
  const copy = createRepositoryWorkingCopy(`adding-${name}-`, { include: engineGeneratorPopulation });
  try {
    const root = copy.engineRoot;
    const before = snapshot(root);
    const added = [`src/workflow/${name}.ts`, `test/workflow/${name}.test.ts`];
    writeFileSync(join(root, added[0]!), `/** A module added on its own branch. */\nexport function ${name.replaceAll("-", "")}(): number {\n  return 1;\n}\n`);
    writeFileSync(join(root, added[1]!), `import assert from "node:assert/strict";\nimport test from "node:test";\n\nimport { ${name.replaceAll("-", "")} } from "../../src/workflow/${name}.ts";\n\ntest("${name} answers one", () => {\n  assert.equal(${name.replaceAll("-", "")}(), 1);\n});\n`);
    // The copy's own index holds the new sources, as a commit would (a new test source must be in the index).
    execFileSync("git", ["add", "-N", "--", ...added], { cwd: root });
    const regenerated = harnessRegenerate(root, { write: true });
    assert.equal(regenerated.status, "pass", `the regenerate of ${name} converges: ${JSON.stringify(regenerated.result).slice(0, 2000)}`);
    return { changes: changed(before, snapshot(root)), added };
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
}

test("two branches that add different modules in one folder change only their own files: their merge cannot conflict", () => {
  const one = branchAdding("zz-added-on-one-branch");
  const other = branchAdding("zz-added-on-another");
  assert.deepEqual(one.changes, [...one.added].toSorted(), "adding a module and its test rewrites no committed aggregate");
  assert.deepEqual(other.changes, [...other.added].toSorted(), "adding a module and its test rewrites no committed aggregate");
  assert.deepEqual(one.changes.filter((path) => other.changes.includes(path)), [], "the two branches touch disjoint files: nothing to conflict on");
});
