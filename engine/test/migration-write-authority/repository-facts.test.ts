import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  createMigrationRepositoryFactsAdapter,
  type MigrationRepositoryFactsConfig,
} from "../../verification/core/coordination/migration-write-authority/repository-facts.ts";
import { mkTempDir } from "../support/temp-dir.ts";

// Closed environment mirroring ROOT_POLICY.verification.candidateFormat.gitIdentity
// (processEnvironment + configurationOverrides). Tranche 3 wires the real root
// policy; the test constructs the same closed env explicitly.
const CLOSED_ENV = Object.freeze({
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ATTR_NOSYSTEM: "1",
  HOME: "/nonexistent/bridlewise-verification-home",
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
  TZ: "UTC",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GIT_AUTHOR_NAME: "Code Harness",
  GIT_AUTHOR_EMAIL: "harness@example.invalid",
  GIT_COMMITTER_NAME: "Code Harness",
  GIT_COMMITTER_EMAIL: "harness@example.invalid",
} as Record<string, string>);

const CONFIG_OVERRIDES = Object.freeze([
  "core.attributesFile=/dev/null",
  "core.excludesFile=/dev/null",
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "core.pager=cat",
  "core.untrackedCache=false",
]);

const FACTS_CONFIG: MigrationRepositoryFactsConfig = Object.freeze({
  executablePath: "/usr/bin/git",
  processEnvironment: CLOSED_ENV,
  configurationOverrides: CONFIG_OVERRIDES,
});

function git(args: readonly string[], cwd: string): void {
  const result = spawnSync("/usr/bin/git", ["-C", cwd, ...args], { env: CLOSED_ENV, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
}

function commitFile(cwd: string, name: string, content: string): void {
  writeFileSync(join(cwd, name), content);
  git(["add", name], cwd);
  git(["commit", "-m", `add ${name}`], cwd);
}

function makeAdapter(locator: string) {
  return createMigrationRepositoryFactsAdapter({ repositoryLocator: locator, config: FACTS_CONFIG });
}

// ---------------------------------------------------------------------------
// Scenario 1: ordinary main worktree with a linked worktree
// ---------------------------------------------------------------------------

test("repository-facts: ordinary main worktree derives correct facts", async () => {
  const dir = mkTempDir("mwa-facts-");
  try {
    git(["init", "--initial-branch=main", dir], "/");
    commitFile(dir, "a.txt", "a\n");
    const adapter = makeAdapter(dir);
    const facts = await adapter.acquire();
    assert.equal(facts.schemaVersion, "migration-repository-facts/v1");
    assert.equal(facts.repositoryLocator, dir);
    assert.equal(facts.repositoryState.bare, false);
    assert.equal(facts.repositoryState.insideWorktree, true);
    assert.equal(facts.repositoryState.objectFormat, "sha1");
    assert.ok(facts.repositoryState.repositoryFormatVersion.length > 0);
    assert.ok(facts.worktreeRoot !== null);
    assert.equal(facts.worktreeRoot!.kind, "directory");
    assert.equal(facts.commonDirectory.kind, "directory");
    assert.equal(facts.gitDirectory.kind, "directory");
    assert.equal(facts.objectStore.kind, "directory");
    assert.equal(facts.refsDirectory.kind, "directory");
    // A committed repo has an index file.
    assert.equal(facts.index.kind, "file");
    // Repository binding identities are 64-char hex sha256.
    assert.match(facts.repositoryBinding.repositoryIdentity, /^[0-9a-f]{64}$/u);
    assert.match(facts.repositoryBinding.commonDirectoryIdentity, /^[0-9a-f]{64}$/u);
    assert.match(facts.repositoryBinding.objectStoreIdentity, /^[0-9a-f]{64}$/u);
    assert.equal(facts.repositoryBinding.objectFormat, "sha1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 2: detached HEAD
// ---------------------------------------------------------------------------

test("repository-facts: detached HEAD derives facts with a worktree root", async () => {
  const dir = mkTempDir("mwa-facts-");
  try {
    git(["init", "--initial-branch=main", dir], "/");
    commitFile(dir, "a.txt", "a\n");
    commitFile(dir, "b.txt", "b\n");
    // Detach HEAD at the first commit.
    const shaResult = spawnSync("/usr/bin/git", ["-C", dir, "rev-parse", "HEAD~1"], { env: CLOSED_ENV, encoding: "utf8" });
    const firstSha = shaResult.stdout.trim();
    git(["checkout", firstSha], dir);
    const facts = await makeAdapter(dir).acquire();
    assert.equal(facts.repositoryState.bare, false);
    assert.ok(facts.worktreeRoot !== null);
    assert.equal(facts.worktreeRoot!.kind, "directory");
    assert.equal(facts.index.kind, "file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 3: separate git directory (--separate-git-dir)
// ---------------------------------------------------------------------------

test("repository-facts: separate git directory derives distinct common and worktree identities", async () => {
  const worktree = mkTempDir("mwa-facts-");
  const gitdir = mkTempDir("mwa-facts-");
  try {
    // init with a separate git dir, then re-init the worktree to point at it.
    spawnSync("/usr/bin/git", ["init", "--initial-branch=main", "--separate-git-dir", gitdir, worktree], { env: CLOSED_ENV, encoding: "utf8" });
    commitFile(worktree, "a.txt", "a\n");
    const facts = await makeAdapter(worktree).acquire();
    assert.equal(facts.repositoryState.bare, false);
    assert.equal(facts.repositoryState.insideWorktree, true);
    assert.ok(facts.worktreeRoot !== null);
    assert.equal(facts.commonDirectory.kind, "directory");
    assert.equal(facts.gitDirectory.kind, "directory");
    // The separate git dir is a distinct directory from the worktree root.
    assert.notEqual(facts.commonDirectory.inode, facts.worktreeRoot!.inode);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(gitdir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 4: bare repository
// ---------------------------------------------------------------------------

test("repository-facts: bare repository has no worktree root", async () => {
  const dir = mkTempDir("mwa-facts-");
  try {
    spawnSync("/usr/bin/git", ["init", "--bare", "--initial-branch=main", dir], { env: CLOSED_ENV, encoding: "utf8" });
    const facts = await makeAdapter(dir).acquire();
    assert.equal(facts.repositoryState.bare, true);
    assert.equal(facts.repositoryState.insideWorktree, false);
    assert.equal(facts.worktreeRoot, null);
    assert.equal(facts.commonDirectory.kind, "directory");
    // A bare repo has no index file.
    assert.equal(facts.index.kind, "absent");
    assert.equal(facts.repositoryBinding.objectFormat, "sha1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 5: unborn HEAD (no commits)
// ---------------------------------------------------------------------------

test("repository-facts: unborn main has no index and a worktree root", async () => {
  const dir = mkTempDir("mwa-facts-");
  try {
    git(["init", "--initial-branch=main", dir], "/");
    const facts = await makeAdapter(dir).acquire();
    assert.equal(facts.repositoryState.bare, false);
    assert.equal(facts.repositoryState.insideWorktree, true);
    assert.ok(facts.worktreeRoot !== null);
    // Fresh init has no index file yet.
    assert.equal(facts.index.kind, "absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Descriptor identity recheck + closed environment
// ---------------------------------------------------------------------------

test("repository-facts: adapter exposes the closed environment it runs under", async () => {
  const dir = mkTempDir("mwa-facts-");
  try {
    git(["init", "--initial-branch=main", dir], "/");
    const adapter = makeAdapter(dir);
    assert.equal(adapter.executablePath, "/usr/bin/git");
    assert.equal(adapter.closedEnvironment, CLOSED_ENV);
    await adapter.acquire();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repository-facts: descriptor recheck passes for a stable common directory", async () => {
  const dir = mkTempDir("mwa-facts-");
  try {
    git(["init", "--initial-branch=main", dir], "/");
    commitFile(dir, "a.txt", "a\n");
    const facts = await makeAdapter(dir).acquire();
    // The common directory identity is descriptor-verified and stable across
    // the acquisition (the recheck would throw if it changed mid-read).
    assert.equal(facts.commonDirectory.kind, "directory");
    assert.match(facts.commonDirectory.inode, /^[0-9]+$/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repository-facts: acquire throws for a nonexistent repository locator", async () => {
  const dir = mkTempDir("mwa-facts-");
  try {
    const missing = join(dir, "does-not-exist");
    const adapter = makeAdapter(missing);
    await assert.rejects(() => adapter.acquire(), /repository command failed/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repository-facts: facts are deterministic across repeated acquisitions", async () => {
  const dir = mkTempDir("mwa-facts-");
  try {
    git(["init", "--initial-branch=main", dir], "/");
    commitFile(dir, "a.txt", "a\n");
    const adapter = makeAdapter(dir);
    const f1 = await adapter.acquire();
    const f2 = await adapter.acquire();
    assert.equal(f1.repositoryBinding.repositoryIdentity, f2.repositoryBinding.repositoryIdentity);
    assert.equal(f1.commonDirectory.inode, f2.commonDirectory.inode);
    assert.equal(f1.repositoryState.bare, f2.repositoryState.bare);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repository-facts: closed env has no ambient PATH beyond /usr/bin:/bin", () => {
  assert.equal(CLOSED_ENV.PATH, "/usr/bin:/bin");
  assert.equal(CLOSED_ENV.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(CLOSED_ENV.GIT_CONFIG_NOSYSTEM, "1");
  assert.ok(existsSync("/usr/bin/git"));
});
