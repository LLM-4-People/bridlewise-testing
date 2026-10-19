/**
 * No-source-hardlinks prevention test.
 *
 * A file in the engine's source tree with nlink > 1 (a hardlink) silently
 * breaks safe-repository-tree verification: `listSafeRepositoryTree` throws
 * `safe_path_hardlink`, which causes `verifyS1Structure` to return early,
 * masking architecture findings. The contamination source was the workflow's
 * experiment seeder, which used `linkSync` (hardlinks) to seed experiment
 * dirs from the engine — the hardlinks shared inodes with the source files,
 * incrementing their nlink. The seeder is gone (retired by the experiment
 * workflow, then deleted with the isolation tooling, A5); the class is not.
 *
 * This test catches the contamination at TWO levels:
 * 1. Behavioural: no file the repository owns under the engine has
 *    nlink > 1 (deny-by-default — ANY hardlinked file fails, regardless of
 *    how it got that way). The population is the ownership reader's, not a
 *    list of directories a seeder declared: with no seeder left, a declared
 *    list would be a claim about nothing.
 * 2. Source-scan: no workflow script in this workspace calls `linkSync`, the
 *    hardlink primitive — the regression caught at the source level before any
 *    contamination occurs.
 *
 * ── WHY THE POPULATION IS DISCOVERED AND NOT NAMED ────────────────────────
 *
 * Arm 2 used to read ONE path, the engine's seeder, resolved against the
 * engine because that is where this suite runs. A STALE FORK of that script
 * sat one directory over at `<workspace>/scripts/harness-root/`, still calling
 * `linkSync`, for the whole life of this guard. The guard's stated subject
 * covered it — an honest reader of the name expects "no source hardlinks" to
 * mean the workspace, and the fork could contaminate exactly the tree arm 1
 * scans, since it seeded from the engine too. The guard stayed green because
 * its universe was a path literal, which is a claim about today's layout.
 *
 * So the universe is now WALKED, across every script root this workspace has,
 * and the rule is deny-by-default over all of them rather than a check on one
 * spelling: no workflow script has a reason to create a hardlink, and one that
 * does is a contamination source whatever it is called. A renamed fork, a
 * second copy, a new seeder nobody has written yet — all covered, because
 * nobody has to remember to add them here.
 *
 * ── THAT SENTENCE WAS TRUE OF THE INTENT AND FALSE OF THE CODE ────────────
 *
 * "Every script root this workspace has" sat above a function returning a
 * HARDCODED two-element list, and the index held three directories named
 * `scripts`. The third, `experiments/exp493-test-fixes/scripts/`, holds a
 * `merge-round.mjs` that is a fork of the workspace's own — the identical
 * fork-of-a-workflow-script shape described three paragraphs up, unwalked for
 * the same reason and found by reading the claim against the code rather than
 * by anything failing.
 *
 * That is the lesson twice in one file: the first version's universe was a
 * path literal, and its replacement was a list of two. The roots are now
 * discovered from the git index, the walked set is asserted to CONTAIN every
 * tracked `.mjs` beneath them, and an empty discovery refuses. What bounds
 * the population is a fact git answers, not a sentence in this header — and
 * the header is now checkable against it rather than merely eloquent.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

// The link-count verdict has ONE owner; this scan consults it rather than
// writing a sixth copy of `nlink > 1`.
import { hasSecondName } from "../../src/filesystem/link-containment.ts";
import { ownedFiles } from "../../src/git/repository-ownership.ts";

const ENGINE_ROOT = process.cwd();
const WORKSPACE_ROOT = resolve(ENGINE_ROOT, "..");
const ENGINE_SCRIPTS = join(ENGINE_ROOT, "scripts");
const WORKSPACE_SCRIPTS = join(WORKSPACE_ROOT, "scripts");

/**
 * Every script root a workflow script can live in — DISCOVERED FROM THE INDEX.
 *
 * ── WHY THIS IS NOT THE TWO NAMES IT USED TO BE ───────────────────────────
 *
 * The header above says the universe is walked "across every script root this
 * workspace has". It was a two-element list: the engine's `scripts/` and the
 * enclosing workspace's. The index holds THREE directories named `scripts`,
 * and the third — `experiments/exp493-test-fixes/scripts/` — holds a
 * `merge-round.mjs` that is a fork of the workspace's own. That is the exact
 * shape this guard was written for: a stale fork of a workflow script, sitting
 * in a directory named `scripts`, invisible because the universe was a list of
 * paths somebody typed. The list had grown a third member and nobody came back
 * here, which is what a list does.
 *
 * So the roots come from git, which already had to be correct for the
 * repository to work, and the walk of each still comes from the filesystem —
 * an UNTRACKED `.mjs` dropped into a known script root is caught, which asking
 * the index for the files as well would have missed.
 *
 * ── WHY `scripts` DIRECTORIES AND NOT EVERY `.mjs` IN THE TREE ────────────
 *
 * Because the wider population is not the same subject, and folding it in
 * would buy an exemption rather than coverage. Measured: exactly one `.mjs`
 * outside every script root calls the hardlink primitive —
 * `verification/benchmarks/secret-spans/test-qualification.mjs` — and it is
 * not an instance of this defect. It hardlinks two names inside an
 * `mkdtempSync(tmpdir())` scratch directory and asserts on the next line that
 * the qualification authority REFUSES it with `safe_path_hardlink`, then
 * removes the whole directory in a `finally`. It cannot raise the link count
 * of any file in this repository, which is the property arm 1 scans for. A
 * population that swept it in would need an exemption saying so, and an
 * exemption is a claim about the world that nothing makes carry evidence —
 * where a script root is a fact the index answers.
 */
function scriptRoots(): readonly string[] {
  const listed = execFileSync("git", ["-C", WORKSPACE_ROOT, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((entry) => entry.length > 0);
  const roots = new Set<string>();
  for (const tracked of listed) {
    const segments = tracked.split("/");
    // The LAST `scripts` segment, so a nested one is its own root and the
    // walk of an outer root does not decide whether an inner one was reached.
    const at = segments.lastIndexOf("scripts");
    if (at === -1) continue;
    roots.add(join(WORKSPACE_ROOT, ...segments.slice(0, at + 1)));
  }
  // AN EMPTY DISCOVERY IS A REFUSAL, NOT AN EMPTY WORKSPACE. A `git` that
  // failed, a cwd that moved, or a checkout with no index all answer "no
  // script roots", and a scan over nothing reports a clean tree in no time at
  // all — the failure shape this guard's own header describes.
  assert.ok(
    roots.size > 0,
    `no script root was discovered under ${WORKSPACE_ROOT}. A scan whose universe is empty ` +
      `passes instantly having examined nothing, which is indistinguishable from a clean tree.`,
  );
  return [...roots].filter((directory) => existsSync(directory)).sort();
}

function listFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Every workflow script in this workspace, whatever it is named.
 *
 * `.mjs` is the extension the workflow tooling is written in, and it is what
 * separates this population from the verification modules under
 * `scripts/verification/`, where `immutable-receipt.ts` creates a hardlink
 * DELIBERATELY as its atomicity primitive. That is not a tree copier and it
 * seeds nothing; folding it in would force an exemption, and an exemption is a
 * claim about the world that nothing makes carry evidence.
 */
function workflowScripts(): readonly string[] {
  return scriptRoots()
    .flatMap((root) => listFiles(root))
    .filter((file) => file.endsWith(".mjs"))
    .sort();
}

test("NoSourceHardlinks: no file the repository owns under the engine has nlink > 1 (deny-by-default)", () => {
  // The population is what the repository owns (tracked plus untracked-not-
  // ignored, the one ownership reader), under the engine: every file a
  // safe-repository-tree walk of the engine can meet. An EMPTY population is
  // a refusal: a scan over nothing reports a clean tree in no time at all.
  const owned = (ownedFiles(WORKSPACE_ROOT) ?? []).filter((path) => path.startsWith("engine/"));
  assert.ok(owned.length > 0, `the ownership reader returned no engine file under ${WORKSPACE_ROOT}, so this scan has no subject`);
  const hardlinked: string[] = [];
  for (const path of owned) {
    const stats = statSync(join(WORKSPACE_ROOT, path), { throwIfNoEntry: false });
    if (stats !== undefined && stats.isFile() && hasSecondName(stats.nlink)) hardlinked.push(`${path} (nlink=${stats.nlink})`);
  }
  assert.equal(
    hardlinked.length,
    0,
    `Source tree contamination: ${hardlinked.length} owned engine file(s) have nlink > 1 (hardlinks).\n` +
      hardlinked.slice(0, 20).map((h) => `  ${h}`).join("\n") +
      (hardlinked.length > 20 ? `\n  ... and ${hardlinked.length - 20} more` : ""),
  );
});

test("NoSourceHardlinks: NO workflow script calls linkSync (the hardlink primitive)", () => {
  const roots = scriptRoots();
  // CONTAINMENT, NOT A COUNT. Both roots exist in this workspace, and a run
  // where the enclosing one stopped being walked is exactly how the stale fork
  // survived — a smaller universe reporting the same green.
  assert.ok(roots.includes(ENGINE_SCRIPTS), "the engine's script root was not walked");
  if (existsSync(WORKSPACE_SCRIPTS)) {
    assert.ok(
      roots.includes(WORKSPACE_SCRIPTS),
      `${WORKSPACE_SCRIPTS} exists and was not walked, so a script sitting there is invisible ` +
        `to this rule`,
    );
  }

  // …AND THE ROOTS THE LIST NEVER HELD. The discovery must reach every
  // directory named `scripts` the index knows about, or it has replaced a
  // two-name list with a one-name one and reported the same green. Derived
  // here from git a second time rather than from `scriptRoots`, so the two
  // cannot agree by sharing a bug.
  const indexed = execFileSync("git", ["-C", WORKSPACE_ROOT, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((entry) => entry.length > 0)
    .filter((entry) => entry.split("/").includes("scripts"));
  assert.ok(indexed.length > 0, "the index holds no path under any directory named scripts");
  for (const tracked of indexed) {
    const segments = tracked.split("/");
    const root = join(WORKSPACE_ROOT, ...segments.slice(0, segments.lastIndexOf("scripts") + 1));
    assert.ok(
      roots.includes(root),
      `${root} holds tracked files and was not walked, so a script sitting there is invisible ` +
        `to this rule — which is how a stale fork survived the first version of this guard`,
    );
  }

  const scripts = workflowScripts();
  // POPULATION AS CONTAINMENT, NOT A FLOOR. A floor of 2 was being cleared by
  // a population of 83, so it could have lost 81 files in silence. Every
  // tracked `.mjs` under a discovered root must be in the walked set, and the
  // walk may hold more (an untracked script is still a script).
  // An unstaged DELETION of a tracked script is simply absent (the walk's
  // index oracle rule, WORKFLOW.md): the index still names it until the
  // deletion is committed, and there is nothing on disk to contaminate.
  const trackedScripts = indexed
    .filter((entry) => entry.endsWith(".mjs"))
    .map((entry) => join(WORKSPACE_ROOT, entry))
    .filter((file) => existsSync(file));
  assert.ok(
    trackedScripts.length > 0,
    "the index holds no .mjs under any script root, so this scan has no subject",
  );
  const walked = new Set(scripts);
  const unwalked = trackedScripts.filter((file) => !walked.has(file));
  assert.deepEqual(
    unwalked,
    [],
    `${unwalked.length} tracked workflow script(s) the index holds were not walked:\n` +
      unwalked.map((file) => `  ${file}`).join("\n"),
  );

  // Match `linkSync(` (the hardlink function call) but NOT `readlinkSync(` or
  // `unlinkSync(`. The `\b` before `linkSync` ensures a name where it is
  // preceded by other letters does NOT match.
  const offenders = scripts.filter((file) => /\blinkSync\s*\(/u.test(readFileSync(file, "utf8")));
  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} workflow script(s) call linkSync — hardlinks contaminate the source ` +
      `tree (nlink > 1), which makes safe-repository-tree verification throw and mask every ` +
      `architecture finding behind it. Use copyFileSync with COPYFILE_FICLONE (reflinks, which ` +
      `fall back to a plain copy) instead:\n` +
      offenders.map((file) => `  ${file}`).join("\n"),
  );
});
