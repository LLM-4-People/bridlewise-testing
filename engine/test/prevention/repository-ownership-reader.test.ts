/**
 * GUARD SUBJECT: "which files does the repository own" has ONE reader — no other source asks git for a population
 * GUARD OWNS: engine/src/git/repository-ownership.ts (trackedFiles, ownedFiles, ignoredEntries, trackedIgnoredFiles, repositoryOwnership, and the one declared machine-local population machineIgnoredFiles)
 * GUARD PLANT: a `git ls-files` call passing `--others`, `--ignored`, `--cached` or an `--exclude*` rule anywhere else
 * GUARD DRIVEN: the reader's populations on a planted repository (tracked, owned, ignored, collapsed ignored, tracked-but-ignored), including a machine-local `.git/info/exclude` entry that must NOT change the answer
 * GUARD LIVENESS: the scan flags a planted call before the universe is judged, and the universe holds the reader itself
 *
 * THE CLASS. Seven readers answered the same question with two rule sets: the
 * checkpoint capture and the staged-move guard read `--exclude-standard`
 * (which includes `.git/info/exclude` and the user's global excludes), the
 * candidate manifest and the working copy read the versioned `.gitignore`
 * files only. One machine-local exclude entry, and the capture, the manifest
 * and the copy disagreed about what the repository owns. The rule is decided
 * once, in the reader: VERSIONED rules only — with ONE declared exception
 * inside the reader, `machineIgnoredFiles` (what `git add -A` skipped on THIS
 * machine, the move-loss check's population): judged by the versioned rules
 * alone, a move into a folder only `.git/info/exclude` ignores dropped a
 * tracked file with the commit guard green (wf-del-verify P3).
 *
 * Declared exceptions, each with its reason, are listed below.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import {
  headCommit,
  ignoredEntries,
  machineIgnoredFiles,
  ownedFiles,
  repositoryOwnership,
  trackedFiles,
  trackedIgnoredFiles,
} from "../../src/git/repository-ownership.ts";
import { sourceViewOf } from "../../scripts/verification/source-view.ts";
import { walk } from "../../scripts/verification/source-walk.ts";
import { createTempDir } from "../support/temp-dir.ts";

const ENGINE_ROOT = join(import.meta.dirname, "..", "..");
const REPOSITORY_ROOT = join(ENGINE_ROOT, "..");
const READER = "engine/src/git/repository-ownership.ts";

const DECLARED_EXCEPTIONS: Readonly<Record<string, string>> = {
  "engine/scripts/tooling/candidate-manifest.ts":
    "candidate-format integrity reader: runs the PINNED git executable with configuration overrides and strict UTF-8 refusal codes; uses VERSIONED_IGNORE_RULES",
  "engine/test/prevention/repository-ownership-reader.test.ts":
    "this guard's own planted spellings",
  "server/intelligence/git-ops-bridge.ts":
    "product git tool over a USER workspace: asks about one named path the user's own git answers, not about this repository",
};

const POPULATION_FLAG = /["'`]--(?:others|ignored|cached|exclude[^"'`]*)["'`]/u;

/** Every `ls-files` call site whose argument list asks for a population. */
export function populationQueries(path: string, text: string): readonly string[] {
  const code = sourceViewOf(text, path).codeWithStrings();
  const hits: string[] = [];
  for (const match of code.matchAll(/["'`]ls-files["'`]/gu)) {
    const ends = ["]", ")"].map((character) => code.indexOf(character, match.index)).filter((index) => index >= 0);
    const argumentsText = code.slice(match.index, ends.length === 0 ? match.index + 400 : Math.min(...ends));
    if (POPULATION_FLAG.test(argumentsText)) hits.push(`${path}:${code.slice(0, match.index).split("\n").length}`);
  }
  return hits;
}

function plantRepository(): string {
  const root = createTempDir("ownership-reader-");
  const git = (...argv: string[]): string => execFileSync("git", argv, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  mkdirSync(join(root, "lib"), { recursive: true });
  mkdirSync(join(root, "build", "deep"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "/build/\n*.log\n");
  writeFileSync(join(root, "lib", "tracked.ts"), "export {};\n");
  writeFileSync(join(root, "lib", "forced.log"), "forced\n");
  git("add", ".gitignore", "lib/tracked.ts");
  git("add", "-f", "lib/forced.log");
  writeFileSync(join(root, "lib", "untracked.ts"), "export {};\n");
  writeFileSync(join(root, "lib", "noise.log"), "noise\n");
  writeFileSync(join(root, "build", "deep", "out.js"), "x\n");
  // A MACHINE-LOCAL rule: it must not change what the repository owns.
  writeFileSync(join(root, ".git", "info", "exclude"), "lib/untracked.ts\n");
  return root;
}

test("repository ownership: every population comes from the versioned rules, never machine-local excludes", () => {
  const root = plantRepository();
  assert.deepEqual([...trackedFiles(root)!].sort(), [".gitignore", "lib/forced.log", "lib/tracked.ts"]);
  assert.deepEqual([...ownedFiles(root)!].sort(), [".gitignore", "lib/forced.log", "lib/tracked.ts", "lib/untracked.ts"]);
  // THE ONE MACHINE-LOCAL POPULATION: what `git add -A` skips here, so the
  // `.git/info/exclude` entry IS in it — and in no other answer above.
  assert.deepEqual([...machineIgnoredFiles(root, "inherited")!].sort(), ["build/deep/out.js", "lib/noise.log", "lib/untracked.ts"]);
  assert.equal(machineIgnoredFiles(createTempDir("ownership-reader-no-repo-"), "inherited"), undefined);
  assert.deepEqual([...ignoredEntries(root)!].sort(), ["build/", "lib/noise.log"]);
  assert.deepEqual([...trackedIgnoredFiles(root)!], ["lib/forced.log"]);
  const ownership = repositoryOwnership(root)!;
  assert.equal(ownership.isIgnored(join(root, "build", "deep", "out.js")), true);
  assert.equal(ownership.isIgnored(join(root, "lib", "untracked.ts")), false);
  assert.equal(repositoryOwnership(join(root, "lib"))!.isIgnored(join(root, "lib", "noise.log")), true);
  const outside = createTempDir("ownership-reader-none-");
  assert.equal(ownedFiles(outside), undefined, "no repository is an absence, never an empty population");
});

test("repository ownership: the scan flags a planted population query and leaves a plain tracked listing alone", () => {
  assert.equal(populationQueries("p.ts", 'execFileSync("git", ["ls-files", "--others", "--exclude-standard"]);').length, 1);
  assert.equal(populationQueries("p.ts", 'git(root, ["ls-files", "-z", "--cached", "--", "."]);').length, 1);
  assert.equal(populationQueries("p.ts", 'execFileSync("git", ["ls-files", "-z"], { cwd });').length, 0);
  assert.equal(populationQueries("p.ts", '// git ls-files --others --ignored\n').length, 0);
});

test("repository ownership: no source outside the reader asks git for a population", () => {
  const roots = ["engine/src", "engine/scripts", "engine/test", "tests", "scripts", "server", "src"];
  const files = roots.flatMap((root) => walk(join(REPOSITORY_ROOT, root), { exts: [".ts", ".mts", ".mjs", ".js"] }));
  const paths = files.map((file) => relative(REPOSITORY_ROOT, file).split("\\").join("/"));
  assert.ok(paths.includes(READER), "the scan no longer reaches the reader");
  const hits = files.flatMap((file, index) => {
    const path = paths[index]!;
    if (path === READER || DECLARED_EXCEPTIONS[path] !== undefined) return [];
    return populationQueries(path, readFileSync(file, "utf8"));
  });
  assert.deepEqual(hits, [], "ask engine/src/git/repository-ownership.ts; it decides the rule set once (versioned .gitignore only)");
  for (const path of Object.keys(DECLARED_EXCEPTIONS)) {
    const index = paths.indexOf(path);
    assert.ok(index >= 0 && populationQueries(path, readFileSync(files[index]!, "utf8")).length > 0,
      `declared exception ${path} no longer asks for a population; remove it from the list`);
  }
});

test("headCommit: a git that could not even be started is the typed refusal, never a TypeError (WF-1b3b verify L6)", () => {
  // A working directory that does not exist makes the spawn itself fail (ENOENT): no stderr to read.
  const gone = join(createTempDir("head-commit-gone-"), "missing");
  assert.throws(() => headCommit(gone, "inherited"), (error: unknown) =>
    (error as { code?: string }).code === "repository_head_unreadable" && /git did not run \(ENOENT\)/u.test((error as Error).message));
});
