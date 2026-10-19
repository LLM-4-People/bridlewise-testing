import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import {
  createLiveGrant,
  type BackendError,
  type EffectObservation,
  type FenceContext,
  type GitObjectObservation,
  type GitRefObservation,
  type LiveGrant,
} from "../../verification/core/coordination/migration-write-authority/contracts.ts";
import { createMigrationEffectAdapter } from "../../verification/core/coordination/migration-write-authority/effects.ts";
import { mkTempDir } from "../support/temp-dir.ts";

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
} as Record<string, string>);

const CONFIG_OVERRIDES = Object.freeze([
  "core.attributesFile=/dev/null",
  "core.excludesFile=/dev/null",
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "core.pager=cat",
  "core.untrackedCache=false",
]);

const GIT_IDENTITY = Object.freeze({ name: "Code Harness", email: "harness@example.invalid" });

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync("/usr/bin/git", ["-C", cwd, ...args], {
    env: { ...CLOSED_ENV, GIT_AUTHOR_NAME: "Code Harness", GIT_AUTHOR_EMAIL: "harness@example.invalid", GIT_COMMITTER_NAME: "Code Harness", GIT_COMMITTER_EMAIL: "harness@example.invalid" },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function setupRepoWithCommit(): { worktree: string; commitSha: string; treeSha: string } {
  const worktree = mkTempDir("mwa-effects-");
  git(["init", "--initial-branch=main", worktree], "/");
  writeFileSync(join(worktree, "a.txt"), "a\n");
  git(["add", "a.txt"], worktree);
  git(["commit", "-m", "init"], worktree);
  const commitSha = git(["rev-parse", "HEAD"], worktree);
  const treeSha = git(["rev-parse", "HEAD^{tree}"], worktree);
  return { worktree, commitSha, treeSha };
}

let nonce = 0;
function makeGrant(fenceIdentity = sha256("fence")): { grant: LiveGrant; fence: (resourceId: string, effectId?: string) => FenceContext } {
  nonce += 1;
  const leaseId = `11111111-1111-4111-8111-${String(nonce).padStart(12, "0")}`;
  const generation = "1";
  const grant = createLiveGrant({
    leaseId,
    generation,
    fenceIdentity,
    repositoryIdentity: "a".repeat(64),
    resourceRegistryIdentity: "b".repeat(64),
    processIdentity: "c".repeat(64),
  });
  const fence = (resourceId: string, effectId = "22222222-2222-4222-8222-222222222222"): FenceContext =>
    Object.freeze({ leaseId, generation, fenceIdentity, effectId, resourceId });
  return { grant, fence };
}

function makeAdapter(worktree: string) {
  return createMigrationEffectAdapter({
    gitExecutablePath: "/usr/bin/git",
    gitIdentity: GIT_IDENTITY,
    worktreeRoot: worktree,
    resolvePhysicalPath: (id) => join(worktree, id),
    config: { executablePath: "/usr/bin/git", processEnvironment: CLOSED_ENV, configurationOverrides: CONFIG_OVERRIDES },
  });
}

function isBackendError(v: unknown): v is BackendError {
  return v !== null && typeof v === "object" && (v as { code?: string }).code !== undefined && typeof (v as { outcome?: string }).outcome === "undefined";
}

// ---------------------------------------------------------------------------
// createFileExclusive
// ---------------------------------------------------------------------------

test("effect: createFileExclusive creates a 0600 file and rechecks identity", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.createFileExclusive({ grant, fence: fence("f1"), resourceId: "f1", intendedBytes: Buffer.from("hello\n"), intendedMode: 0o600 });
    assert.ok(!isBackendError(obs), "createFileExclusive should succeed");
    assert.equal((obs as EffectObservation).effectKind, "filesystem-create");
    assert.equal((obs as EffectObservation).observedState.kind, "file");
    const stats = spawnSync("/usr/bin/stat", ["-c", "%a", join(worktree, "f1")], { encoding: "utf8" });
    assert.equal(stats.stdout.trim(), "600");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("effect: createFileExclusive fails when the destination already exists", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const r1 = adapter.createFileExclusive({ grant, fence: fence("f1"), resourceId: "f1", intendedBytes: Buffer.from("a"), intendedMode: 0o600 });
    assert.ok(!isBackendError(r1));
    const r2 = adapter.createFileExclusive({ grant, fence: fence("f1"), resourceId: "f1", intendedBytes: Buffer.from("b"), intendedMode: 0o600 });
    assert.ok(isBackendError(r2));
    assert.equal((r2 as BackendError).code, "cas-mismatch");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// replaceFile
// ---------------------------------------------------------------------------

test("effect: replaceFile writes via temp-sibling + rename and rechecks", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    writeFileSync(join(worktree, "f2"), "old\n");
    const obs = adapter.replaceFile({ grant, fence: fence("f2"), resourceId: "f2", intendedBytes: Buffer.from("new\n"), intendedMode: 0o644 });
    assert.ok(!isBackendError(obs));
    assert.equal((obs as EffectObservation).effectKind, "filesystem-replace");
    assert.equal(readFileSync(join(worktree, "f2"), "utf8"), "new\n");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// removeFile
// ---------------------------------------------------------------------------

test("effect: removeFile unlinks and rechecks absence", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    writeFileSync(join(worktree, "f3"), "x\n");
    const obs = adapter.removeFile({ grant, fence: fence("f3"), resourceId: "f3" });
    assert.ok(!isBackendError(obs));
    assert.equal((obs as EffectObservation).effectKind, "filesystem-remove");
    assert.equal((obs as EffectObservation).observedState.kind, "absent");
    assert.equal(existsSync(join(worktree, "f3")), false);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("effect: removeFile on an already-absent file rechecks absence", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.removeFile({ grant, fence: fence("absent"), resourceId: "absent" });
    assert.ok(!isBackendError(obs));
    assert.equal((obs as EffectObservation).observedState.kind, "absent");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// syncDirectory
// ---------------------------------------------------------------------------

test("effect: syncDirectory fsyncs a directory and rechecks it", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.syncDirectory({ grant, fence: fence("."), directory: worktree });
    assert.ok(!isBackendError(obs));
    assert.equal((obs as EffectObservation).effectKind, "filesystem-sync");
    assert.equal((obs as EffectObservation).observedState.kind, "directory");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// gitWriteTree
// ---------------------------------------------------------------------------

test("effect: gitWriteTree writes a tree from the authorized index", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    writeFileSync(join(worktree, "b.txt"), "b\n");
    git(["add", "b.txt"], worktree);
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.gitWriteTree({ grant, fence: fence("tree-1"), resourceId: "tree-1" });
    assert.ok(!isBackendError(obs), `gitWriteTree failed: ${(obs as BackendError)?.message}`);
    assert.equal((obs as GitObjectObservation).objectKind, "tree");
    assert.match((obs as GitObjectObservation).objectId, /^[0-9a-f]{40}$/u);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// gitCommitTree
// ---------------------------------------------------------------------------

test("effect: gitCommitTree creates a commit with explicit parents and a message", () => {
  const { worktree, commitSha, treeSha } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.gitCommitTree({ grant, fence: fence("commit-1"), resourceId: "commit-1", treeObjectId: treeSha, parents: [commitSha], message: "second\n" });
    assert.ok(!isBackendError(obs));
    assert.equal((obs as GitObjectObservation).objectKind, "commit");
    // Verify the new commit's parent is the original commit.
    const newCommit = (obs as GitObjectObservation).objectId;
    const parent = git(["rev-parse", `${newCommit}^`], worktree);
    assert.equal(parent, commitSha);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("effect: gitCommitTree creates a root commit with no parents", () => {
  const { worktree, treeSha } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.gitCommitTree({ grant, fence: fence("root-commit"), resourceId: "root-commit", treeObjectId: treeSha, parents: [], message: "root\n" });
    assert.ok(!isBackendError(obs));
    assert.equal((obs as GitObjectObservation).objectKind, "commit");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// gitMktagStrict
// ---------------------------------------------------------------------------

test("effect: gitMktagStrict creates a tag object with --strict validation", () => {
  const { worktree, commitSha } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const tagBytes = Buffer.from(
      `object ${commitSha}\ntype commit\ntag v1\ntagger Code Harness <harness@example.invalid> 1700000000 +0000\n\nmessage\n`,
    );
    const obs = adapter.gitMktagStrict({ grant, fence: fence("tag-1"), resourceId: "tag-1", tagBytes });
    assert.ok(!isBackendError(obs), `mktag failed: ${(obs as BackendError)?.message}`);
    assert.equal((obs as GitObjectObservation).objectKind, "tag");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("effect: gitMktagStrict fails closed on an invalid tag object", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.gitMktagStrict({ grant, fence: fence("bad-tag"), resourceId: "bad-tag", tagBytes: Buffer.from("not a tag\n") });
    assert.ok(isBackendError(obs));
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// gitUpdateRefTransaction
// ---------------------------------------------------------------------------

test("effect: gitUpdateRefTransaction creates a ref with CAS", () => {
  const { worktree, commitSha } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.gitUpdateRefTransaction({
      grant,
      fence: fence("ref-create"),
      resourceId: "ref-create",
      commands: [
        { kind: "start" },
        { kind: "create", refName: "refs/heads/feature", newObjectId: commitSha },
        { kind: "prepare" },
        { kind: "commit" },
      ],
    });
    assert.ok(!isBackendError(obs), `ref create failed: ${(obs as BackendError)?.message}`);
    assert.equal((obs as GitRefObservation).refName, "refs/heads/feature");
    assert.equal((obs as GitRefObservation).newObjectId, commitSha);
    assert.equal(git(["rev-parse", "refs/heads/feature"], worktree), commitSha);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("effect: gitUpdateRefTransaction rejects a CAS mismatch (wrong expectedOld)", () => {
  const { worktree, commitSha } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.gitUpdateRefTransaction({
      grant,
      fence: fence("ref-cas"),
      resourceId: "ref-cas",
      commands: [
        { kind: "start" },
        // verify expects the wrong old value → update-ref rejects.
        { kind: "update", refName: "refs/heads/main", newObjectId: commitSha, expectedOld: "0".repeat(40) },
        { kind: "prepare" },
        { kind: "commit" },
      ],
    });
    assert.ok(isBackendError(obs));
    assert.equal((obs as BackendError).code, "cas-mismatch");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// rereadObject / rereadRef
// ---------------------------------------------------------------------------

test("effect: rereadObject reopens and verifies a commit object", () => {
  const { worktree, commitSha } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.rereadObject({ grant, fence: fence("obj-1"), resourceId: "obj-1", objectId: commitSha, expectedKind: "commit" });
    assert.ok(!isBackendError(obs));
    assert.equal((obs as GitObjectObservation).objectKind, "commit");
    assert.equal((obs as GitObjectObservation).objectId, commitSha);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("effect: rereadObject fails closed on a wrong expected kind", () => {
  const { worktree, commitSha } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.rereadObject({ grant, fence: fence("obj-wrong"), resourceId: "obj-wrong", objectId: commitSha, expectedKind: "tree" });
    assert.ok(isBackendError(obs));
    assert.equal((obs as BackendError).code, "effect-unknown");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("effect: rereadRef reopens and verifies an existing ref", () => {
  const { worktree, commitSha } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.rereadRef({ grant, fence: fence("ref-1"), resourceId: "ref-1", refName: "refs/heads/main" });
    assert.ok(!isBackendError(obs));
    assert.equal((obs as GitRefObservation).newObjectId, commitSha);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("effect: rereadRef fails closed on a nonexistent ref", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.rereadRef({ grant, fence: fence("ref-missing"), resourceId: "ref-missing", refName: "refs/heads/nope" });
    assert.ok(isBackendError(obs));
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// LiveGrant + FenceContext required (fail-closed on mismatch)
// ---------------------------------------------------------------------------

test("effect: a stale generation fence is rejected", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    const { grant } = makeGrant();
    const adapter = makeAdapter(worktree);
    const staleFence: FenceContext = Object.freeze({ leaseId: grant.leaseId, generation: "0", fenceIdentity: grant.fenceIdentity, effectId: "e1", resourceId: "f1" });
    const obs = adapter.createFileExclusive({ grant, fence: staleFence, resourceId: "f1", intendedBytes: Buffer.from("x"), intendedMode: 0o600 });
    assert.ok(isBackendError(obs));
    assert.equal((obs as BackendError).code, "generation-stale");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("effect: a mismatched fenceIdentity is rejected", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    const { grant } = makeGrant();
    const adapter = makeAdapter(worktree);
    const forgedFence: FenceContext = Object.freeze({ leaseId: grant.leaseId, generation: grant.generation, fenceIdentity: "0".repeat(64), effectId: "e1", resourceId: "f1" });
    const obs = adapter.createFileExclusive({ grant, fence: forgedFence, resourceId: "f1", intendedBytes: Buffer.from("x"), intendedMode: 0o600 });
    assert.ok(isBackendError(obs));
    assert.equal((obs as BackendError).code, "grant-invalid");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("effect: an unbranded grant is rejected", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    const { fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const fakeGrant = { leaseId: "x", generation: "1", fenceIdentity: "y", repositoryIdentity: "z", resourceRegistryIdentity: "w", processIdentity: "v" } as unknown as LiveGrant;
    const obs = adapter.createFileExclusive({ grant: fakeGrant, fence: fence("f1"), resourceId: "f1", intendedBytes: Buffer.from("x"), intendedMode: 0o600 });
    assert.ok(isBackendError(obs));
    assert.equal((obs as BackendError).code, "grant-invalid");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Containment: resolved path must stay within the worktree root (MINOR 4)
// ---------------------------------------------------------------------------

function escapedCleanup(worktree: string, name: string): void {
  const escaped = resolve(join(worktree, "..", name));
  rmSync(worktree, { recursive: true, force: true });
  try { rmSync(escaped, { force: true }); } catch { /* already gone */ }
}

test("effect: createFileExclusive rejects a path that escapes the worktree root", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.createFileExclusive({ grant, fence: fence("../evil"), resourceId: "../evil", intendedBytes: Buffer.from("x"), intendedMode: 0o600 });
    assert.ok(isBackendError(obs), "path escape must fail");
    assert.equal((obs as BackendError).code, "filesystem-unsupported", "path escape must fail with filesystem-unsupported");
    assert.equal(existsSync(join(worktree, "..", "evil")), false, "no file must be created outside the worktree");
  } finally {
    escapedCleanup(worktree, "evil");
  }
});

test("effect: replaceFile rejects a path that escapes the worktree root", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.replaceFile({ grant, fence: fence("../evil2"), resourceId: "../evil2", intendedBytes: Buffer.from("x"), intendedMode: 0o600 });
    assert.ok(isBackendError(obs), "path escape must fail");
    assert.equal((obs as BackendError).code, "filesystem-unsupported");
  } finally {
    escapedCleanup(worktree, "evil2");
  }
});

test("effect: removeFile rejects a path that escapes the worktree root", () => {
  const { worktree } = setupRepoWithCommit();
  try {
    const { grant, fence } = makeGrant();
    const adapter = makeAdapter(worktree);
    const obs = adapter.removeFile({ grant, fence: fence("../evil3"), resourceId: "../evil3" });
    assert.ok(isBackendError(obs), "path escape must fail");
    assert.equal((obs as BackendError).code, "filesystem-unsupported");
  } finally {
    escapedCleanup(worktree, "evil3");
  }
});
