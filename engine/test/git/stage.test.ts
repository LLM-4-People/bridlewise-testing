/**
 * THE WAY TO STAGE, DRIVEN (`harness stage`: src/git/index-baseline.ts
 * `stagePaths`). In a planted repository: the tracked files the working tree
 * changed (edits and deletions) and the new paths named are staged, each by
 * its literal path, and nothing unnamed ever is; a named path that is badly
 * spelled, missing or a folder refuses; a drifted index refuses; a change over
 * a protected staged blob refuses; each refusal leaves the index untouched.
 * `ws create` prints the stage command in the workspace's instructions.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
