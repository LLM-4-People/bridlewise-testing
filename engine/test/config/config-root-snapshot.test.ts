/**
 * WHAT A CONFIGURATION BOOTSTRAP HOLDS THE ROOT BY. The pinned loader compares
 * the root's entries before and after its reads (`directoryEntriesHash`,
 * src/kernel/config.ts). An entry the configuration surface excludes — the
 * state directory above all — is held by what it is, not by its times: work
 * made inside it (an MCP server's home, a confined scratch folder) is not a
 * change of the configuration, and refused every bootstrap it overlapped.
 * Replacing that entry, or changing what it is, still changes the snapshot,
 * and any other entry is held by its times as before.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { directoryEntriesHash, directorySnapshot, directorySnapshotChanged, harnessFolderChanges, harnessFolderIdentity } from "../../src/kernel/config.ts";
import { sameDirectoryIdentity, sameIdentity } from "../../src/shared/identity.ts";
import { repositoryRefChanges, repositoryRefIdentity } from "../../src/git/repository-ownership.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";
import { STATE_DIRECTORY_NAME } from "../../src/kernel/product-identity.ts";
import { createTempDir } from "../support/temp-dir.ts";

test("work INSIDE an excluded entry leaves the root snapshot unchanged; replacing it, re-moding it or touching a held entry changes it", () => {
  const root = createTempDir("config-root-snapshot-");
  const state = join(root, STATE_DIRECTORY_NAME);
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(root, "held.json"), "{}\n");
  mkdirSync(join(root, "src"));
  const before = directoryEntriesHash(root);

  mkdirSync(join(state, "mcp-home"));
  writeFileSync(join(state, "mcp-home", "note"), "x");
  mkdirSync(join(state, "confined-scratch"));
  assert.equal(directoryEntriesHash(root), before, "an entry made inside the state directory is no change of the configuration");

  chmodSync(state, 0o750);
  assert.notEqual(directoryEntriesHash(root), before, "a state directory whose mode changed is another entry");
  chmodSync(state, 0o700);
  assert.equal(directoryEntriesHash(root), before);

  const moved = join(root, "elsewhere");
  mkdirSync(moved, { mode: 0o700 });
  rmdirSync(join(state, "confined-scratch"));
  renameSync(state, join(root, "old-state"));
  renameSync(moved, state);
  const replaced = directoryEntriesHash(root);
  assert.notEqual(replaced, before, "a replaced state directory (another inode) changes the snapshot");

  mkdirSync(join(root, "src", "inner"));
  assert.notEqual(directoryEntriesHash(root), replaced, "an entry the surface holds is still held by its times");
  const now = new Date();
  utimesSync(join(root, "held.json"), now, new Date(now.getTime() + 5_000));
  assert.notEqual(directoryEntriesHash(root), replaced);
});

test("the parent check is IDENTITY: a sibling the surface excludes, made mid-read, is the same directory and no change (FLAKY-CONFIG-PARENT-CHURN)", () => {
  const root = createTempDir("config-parent-sibling-");
  writeFileSync(join(root, "bridlewise.config.json"), "{}\n");
  mkdirSync(join(root, "src"));
  const before = directorySnapshot(root);
  // What a concurrent test did on a fresh checkout: the state directory made beside the config, and work inside it.
  mkdirSync(join(root, STATE_DIRECTORY_NAME), { mode: 0o700 });
  mkdirSync(join(root, STATE_DIRECTORY_NAME, "state"), { recursive: true });
  mkdirSync(join(root, "node_modules"));
  const after = directorySnapshot(root);
  assert.equal(sameIdentity(before.identity, after.identity), false, "the folder's times and link count moved (the old check's refusal)");
  assert.equal(sameDirectoryIdentity(before.identity, after.identity), true, "it is the same directory");
  assert.equal(directorySnapshotChanged(before, after), false, "a sibling the surface excludes, made mid-read, is no change of the configuration");
  // An excluded sibling that was there and is REPLACED is a change.
  renameSync(join(root, STATE_DIRECTORY_NAME), join(root, "old-state"));
  mkdirSync(join(root, STATE_DIRECTORY_NAME), { mode: 0o700 });
  assert.equal(directorySnapshotChanged(after, directorySnapshot(root)), true, "a replaced state directory is another entry");
  // A sibling the surface HOLDS is still a change of the configuration surface.
  writeFileSync(join(root, "src", "new.ts"), "export {};\n");
  assert.equal(directorySnapshotChanged(after, directorySnapshot(root)), true);
});

test("the parent check is IDENTITY: a swapped directory (a different one renamed into place) is refused as another directory", () => {
  const parent = createTempDir("config-parent-swap-");
  const engine = join(parent, "engine");
  mkdirSync(engine);
  writeFileSync(join(engine, "bridlewise.config.json"), "{}\n");
  const before = directorySnapshot(engine);
  // The same name, the same entries, another directory.
  const impostor = join(parent, "impostor");
  mkdirSync(impostor);
  writeFileSync(join(impostor, "bridlewise.config.json"), "{}\n");
  renameSync(engine, join(parent, "engine-old"));
  renameSync(impostor, engine);
  const after = directorySnapshot(engine);
  assert.equal(sameDirectoryIdentity(before.identity, after.identity), false, "another inode at the same path is another directory");
  assert.equal(directorySnapshotChanged(before, after), true);
});

test("the live harness folder's identity names every place a test changed — a file made at the root, one made, re-linked or removed below it — and nothing for work inside the state folder (R3-1)", () => {
  const root = createTempDir("harness-folder-identity-");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export {};\n");
  mkdirSync(join(root, STATE_DIRECTORY_NAME));
  const before = harnessFolderIdentity(root);
  assert.deepEqual(harnessFolderChanges(before, harnessFolderIdentity(root)), [], "an untouched folder");
  mkdirSync(join(root, STATE_DIRECTORY_NAME, "mcp-home"));
  writeFileSync(join(root, STATE_DIRECTORY_NAME, "mcp-home", "x"), "state");
  assert.deepEqual(harnessFolderChanges(before, harnessFolderIdentity(root)), [], "work inside the state folder is not the harness's identity");
  writeFileSync(join(root, ".probe-config.json"), "{}");
  linkSync(join(root, "src", "a.ts"), join(root, "a-second-name"));
  assert.deepEqual(harnessFolderChanges(before, harnessFolderIdentity(root)), [".probe-config.json", "a-second-name", "src/a.ts"], "made at the root, and a second name for a file below it");
  rmSync(join(root, ".probe-config.json"));
  rmSync(join(root, "a-second-name"));
  assert.ok(harnessFolderChanges(before, harnessFolderIdentity(root)).includes("src/a.ts"), "a file re-linked and restored still changed (its change time moved)");
});

test("the engine runner judges the live harness folder before the first test and after the last, and fails the run naming what changed", () => {
  const runner = readFileSync(new URL("../../scripts/tooling/run-tests.ts", import.meta.url), "utf8");
  const start = runner.indexOf("const harnessAtStart = harnessFolderIdentity(root);");
  const run = runner.indexOf("await runTestsWithEvidence(");
  const end = runner.indexOf("harnessFolderChanges(harnessAtStart, harnessFolderIdentity(root))");
  assert.ok(start > 0 && start < run && run < end, "taken before the run and compared after it");
  assert.match(runner.slice(end), /gate: "harness-folder", kind: "fail"/u, "a change is a failed qualification outcome of the run");
  const refsStart = runner.indexOf("const refsAtStart = repositoryRefIdentity(root);");
  assert.ok(refsStart > 0 && refsStart < run && run < runner.indexOf("repositoryRefChanges(refsAtStart, repositoryRefIdentity(root))"), "the repository's HEAD and branch, before the run and after it");
});

test("the repository a run must not move: a commit, a reset and a checkout in the real checkout are each named; an untouched one, and a git command in a repository of its own, are not (round 14, the stray commit on testing)", () => {
  const top = createTempDir("repository-refs-");
  const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...testGitIdentityEnvironment() } });
  git(top, "init", "-q", "-b", "testing");
  writeFileSync(join(top, "a.txt"), "a\n");
  git(top, "add", "a.txt");
  git(top, "commit", "-q", "-m", "first");
  const before = repositoryRefIdentity(top);
  assert.deepEqual(repositoryRefChanges(before, repositoryRefIdentity(top)), [], "an untouched checkout");
  const scratch = createTempDir("repository-refs-scratch-");
  git(scratch, "init", "-q");
  writeFileSync(join(scratch, "b.txt"), "b\n");
  git(scratch, "add", "b.txt");
  git(scratch, "commit", "-q", "-m", "a repository of its own");
  assert.deepEqual(repositoryRefChanges(before, repositoryRefIdentity(top)), [], "a commit in a repository of its own moves nothing here");
  // The stray commit's shape: `commit -a` run in the real checkout.
  writeFileSync(join(top, "a.txt"), "edited\n");
  git(top, "commit", "-q", "-a", "-m", "second");
  assert.match(repositoryRefChanges(before, repositoryRefIdentity(top)).join("; "), /HEAD moved from [0-9a-f]{40} to [0-9a-f]{40}/u);
  git(top, "checkout", "-q", "-b", "elsewhere");
  assert.match(repositoryRefChanges(before, repositoryRefIdentity(top)).join("; "), /HEAD names refs\/heads\/elsewhere, not refs\/heads\/testing/u);
});
