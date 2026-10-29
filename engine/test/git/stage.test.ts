/**
 * THE WAY TO STAGE, DRIVEN (`harness stage`: src/git/index-baseline.ts
 * `stagePaths`). In a planted repository: the tracked files the working tree
 * changed (edits and deletions) and the new paths named are staged, each by
 * its literal path, and nothing unnamed ever is; a named path that is badly
 * spelled, missing, a folder or ignored refuses; a drifted index refuses; a change over
 * a protected staged blob refuses; each refusal leaves the index untouched.
 * `ws create` prints the stage command in the workspace's instructions.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { recordIndexBaseline, stagePaths } from "../../src/git/index-baseline.ts";
import { workspaceInstructions } from "../../src/workflow/workspace-cli.ts";
import type { WorkspaceRecord } from "../../src/workflow/workspace-contracts.ts";
import { createTempDir } from "../support/temp-dir.ts";

function git(root: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-c", "user.name=Stage Test", "-c", "user.email=stage@example.invalid", ...args], { cwd: root, encoding: "utf8" });
}

/** A committed repository whose working tree then edits one file, deletes another, and adds two untracked files and a folder of one. */
function plantedRepository(): string {
  const root = createTempDir("harness-stage-");
  git(root, "init", "-q");
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "lib", "edited.ts"), "export const edited = 1;\n");
  writeFileSync(join(root, "lib", "deleted.ts"), "export const deleted = 1;\n");
  git(root, "add", "--", "lib/edited.ts", "lib/deleted.ts");
  git(root, "commit", "-q", "-m", "base");
  writeFileSync(join(root, "lib", "edited.ts"), "export const edited = 2;\n");
  rmSync(join(root, "lib", "deleted.ts"));
  writeFileSync(join(root, "lib", "named.ts"), "export const named = 1;\n");
  writeFileSync(join(root, "lib", "unnamed.ts"), "export const unnamed = 1;\n");
  mkdirSync(join(root, "lib", "folder"));
  writeFileSync(join(root, "lib", "folder", "inside.ts"), "export const inside = 1;\n");
  return root;
}

const stagedStatus = (root: string): string => git(root, "diff", "--cached", "--name-status");
const refusedWith = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

test("the tracked files the working tree changed and the named new paths are staged; nothing unnamed is", () => {
  const root = plantedRepository();
  const answer = stagePaths(root, ["lib/named.ts"]);
  assert.deepEqual([...answer.staged].sort(), ["lib/deleted.ts", "lib/edited.ts", "lib/named.ts"]);
  assert.equal(stagedStatus(root), "D\tlib/deleted.ts\nM\tlib/edited.ts\nA\tlib/named.ts\n");
  assert.match(git(root, "status", "--porcelain"), /^\?\? lib\/folder\/\n\?\? lib\/unnamed\.ts\n$/mu, "the unnamed file and folder stay untracked");
});

test("each path is literal: a name that would be a glob stages that one file, and one whose file is absent refuses rather than matching others", () => {
  const root = plantedRepository();
  writeFileSync(join(root, "lib", "a.ts"), "a\n");
  // git globs a pathspec only when no file has its literal name: that case is refused as missing, never matched.
  assert.throws(() => stagePaths(root, ["lib/[ab].ts"]), refusedWith("stage_path_missing"));
  assert.equal(stagedStatus(root), "");
  writeFileSync(join(root, "lib", "[ab].ts"), "the literal name\n");
  stagePaths(root, ["lib/[ab].ts"]);
  assert.match(stagedStatus(root), /^A\tlib\/\[ab\]\.ts$/mu);
  assert.doesNotMatch(stagedStatus(root), /lib\/a\.ts/u, "lib/a.ts was matched by the name as a glob");
});

test("a named path badly spelled, missing or a folder refuses, before the index is touched", () => {
  for (const [path, code] of [
    ["-A", "stage_path_invalid"],
    [".", "stage_path_invalid"],
    ["lib/../lib/named.ts", "stage_path_invalid"],
    ["/etc/passwd", "stage_path_invalid"],
    [":(glob)lib/*", "stage_path_invalid"],
    ["", "stage_path_invalid"],
    ["lib/absent.ts", "stage_path_missing"],
    ["lib/folder", "stage_path_directory"],
  ] as const) {
    const root = plantedRepository();
    assert.throws(() => stagePaths(root, ["lib/named.ts", path]), refusedWith(code), JSON.stringify(path));
    assert.equal(stagedStatus(root), "", `${JSON.stringify(path)}: nothing was staged`);
  }
});

test("a named ignored path refuses with its own code, naming the rule; a tracked file an ignore rule would match still stages", () => {
  const root = plantedRepository();
  writeFileSync(join(root, ".gitignore"), "*.log\n");
  git(root, "add", "--", ".gitignore");
  git(root, "commit", "-q", "-m", "ignore logs");
  writeFileSync(join(root, "lib", "run.log"), "raw output\n");
  assert.throws(
    () => stagePaths(root, ["lib/named.ts", "lib/run.log"]),
    (error: unknown) => (error as { code?: string }).code === "stage_path_ignored" && (error as Error).message.includes("lib/run.log is ignored by .gitignore:1:*.log"),
  );
  assert.equal(stagedStatus(root), "", "nothing was staged");
  // A tracked file is never ignored: force-tracked once, it stages as a modification like any other.
  git(root, "add", "-f", "--", "lib/run.log");
  git(root, "commit", "-q", "-m", "keep one log");
  writeFileSync(join(root, "lib", "run.log"), "edited\n");
  stagePaths(root, ["lib/run.log"]);
  assert.match(stagedStatus(root), /^M\tlib\/run\.log$/mu);
});

/**
 * A real diff3 merge with three conflicted files: `f.txt` (plain markers), `big.txt` (its
 * `conflict-marker-size=10` attribute: ten-character markers) and `doc.md` (a setext `=======` heading).
 */
function conflictedMerge(): string {
  const root = createTempDir("harness-stage-merge-");
  git(root, "init", "-q");
  writeFileSync(join(root, ".gitattributes"), "big.txt conflict-marker-size=10\n");
  writeFileSync(join(root, "f.txt"), "a\nb\nc\n");
  writeFileSync(join(root, "big.txt"), "x\n");
  writeFileSync(join(root, "doc.md"), "Title\n=======\n\nbase\n");
  git(root, "add", "--", ".gitattributes", "f.txt", "big.txt", "doc.md");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "theirs");
  writeFileSync(join(root, "f.txt"), "a\nTHEIRS\nc\n");
  writeFileSync(join(root, "big.txt"), "theirs\n");
  writeFileSync(join(root, "doc.md"), "Title\n=======\n\ntheirs\n");
  git(root, "commit", "-q", "-a", "-m", "theirs");
  git(root, "checkout", "-q", "-");
  writeFileSync(join(root, "f.txt"), "a\nOURS\nc\n");
  writeFileSync(join(root, "big.txt"), "ours\n");
  writeFileSync(join(root, "doc.md"), "Title\n=======\n\nours\n");
  git(root, "commit", "-q", "-a", "-m", "ours");
  spawnSync("git", ["-c", "user.name=Stage Test", "-c", "user.email=stage@example.invalid", "-c", "merge.conflictStyle=diff3", "merge", "-q", "theirs"], { cwd: root });
  assert.equal(git(root, "ls-files", "-u").split("\n").filter((line) => line.length > 0).length, 9, "three files, three stages each, unmerged");
  return root;
}

const unmergedPaths = (root: string): readonly string[] => [...new Set(git(root, "ls-files", "-u").split("\n").filter((line) => line.length > 0).map((line) => line.split("\t")[1]!))].sort();

test("git judges the leftover conflict markers: diff3 markers and a conflict-marker-size of 10 refuse; a resolved setext heading stages", () => {
  const root = conflictedMerge();
  // diff3 markers (with the ||||||| base) in f.txt, ten-character ones in big.txt, and doc.md's own markers: all refused.
  assert.match(readFileSync(join(root, "f.txt"), "utf8"), /^\|{7} /mu, "diff3 style: the base section is there");
  assert.match(readFileSync(join(root, "big.txt"), "utf8"), /^<{10} /mu, "the attribute's ten-character markers are there");
  assert.throws(() => stagePaths(root, []), (error: unknown) => (error as { code?: string }).code === "stage_conflict_unresolved" && ["f.txt", "big.txt", "doc.md"].every((path) => (error as Error).message.includes(path)));
  assert.deepEqual(unmergedPaths(root), ["big.txt", "doc.md", "f.txt"], "nothing was staged");
  // doc.md resolved, keeping its setext heading (a line of seven "="s) and a trailing space (a whitespace finding, not this question).
  writeFileSync(join(root, "doc.md"), "Title\n=======\n\nresolved \n");
  // big.txt still holds its ten-character markers: refused, while doc.md is not named.
  assert.throws(() => stagePaths(root, []), (error: unknown) => (error as { code?: string }).code === "stage_conflict_unresolved" && (error as Error).message.includes("big.txt") && !(error as Error).message.includes("doc.md"));
  writeFileSync(join(root, "big.txt"), "resolved\n");
  writeFileSync(join(root, "f.txt"), "a\nresolved\nc\n");
  stagePaths(root, []);
  assert.deepEqual(unmergedPaths(root), [], "every resolved file is staged and its conflict marked resolved");
  assert.equal(readFileSync(join(root, "doc.md"), "utf8"), "Title\n=======\n\nresolved \n");
});

test("a change over a protected staged blob refuses, and so does a drifted index; the index stays as it was", () => {
  const root = plantedRepository();
  // A staged blob that exists nowhere else (the working tree moves on after staging), recorded as protected.
  writeFileSync(join(root, "lib", "edited.ts"), "export const edited = 'only staged';\n");
  git(root, "add", "--", "lib/edited.ts");
  recordIndexBaseline(root);
  writeFileSync(join(root, "lib", "edited.ts"), "export const edited = 'after staging';\n");
  const before = git(root, "ls-files", "-s");
  assert.throws(() => stagePaths(root, ["lib/named.ts"]), refusedWith("stage_protected_entry"));
  assert.equal(git(root, "ls-files", "-s"), before);
  // The protected entry dropped by a slip: drift, refused until repaired.
  git(root, "rm", "-q", "--cached", "-f", "lib/edited.ts");
  assert.throws(() => stagePaths(root, ["lib/named.ts"]), refusedWith("live_index_drifted"));
});

test("ws create prints the stage command in the workspace's instructions; a read-only workspace gets none", () => {
  const record = (branch: string | null) => ({ workspaceId: "w-1", lease: { worktreePath: "/w", branch } }) as unknown as WorkspaceRecord;
  const lines = workspaceInstructions(record("ws/w-1"));
  assert.ok(lines.some((line) => line.includes("harness stage <new path>") && line.includes("never `git add -A`")), lines.join("\n"));
  assert.deepEqual(workspaceInstructions(record(null)), ["read in /w (read-only: it never merges)"]);
});
