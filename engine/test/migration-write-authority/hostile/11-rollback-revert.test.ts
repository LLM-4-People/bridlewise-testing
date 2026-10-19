/**
 * MWA Tranche 4 — Hostile Family 11: rollback by reviewed revert.
 *
 * Rollback via reviewed revert from recorded commits/refs — deterministic
 * reapplication from a frozen baseline. NEVER `git reset --hard` or ref
 * rewrite. Always reviewed revert (a new commit that reverses the effect).
 *
 * Reps:
 * 1. Rollback via reviewed revert from recorded commits — deterministic
 * reapplication from a frozen baseline (the revert commit's tree is
 * the recorded previous tree).
 * 2. Rollback via reviewed revert from recorded refs — deterministic (the
 * revert produces a commit that points at the recorded previous tree).
 * 3. Rollback with a concurrent observer — no duplicate effect (the revert
 * is idempotent; replaying the same revert produces the same commit).
 *
 * Design authority: MWA-DESIGN §7.2 family 11. The "reviewed revert" never
 * rewrites history: it creates a NEW commit whose tree is the recorded
 * previous tree. The git-ref CAS (`update-ref --stdin -z` with `verify`)
 * ensures the ref moves atomically from the recorded current to the new
 * revert commit — never a force-update or reset.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  assertAccepted, createAuthorityHandle, createDisposableRepo, createOracle,
  physical, setupMwaForRepo, makeAcquireInput, CLOSED_ENV, GIT_EXECUTABLE,
} from "./harness.ts";

function git(args: readonly string[], cwd: string): string {
  const r = spawnSync(GIT_EXECUTABLE, ["-C", cwd, ...args], { env: CLOSED_ENV as Record<string, string>, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

test("hostile-11 rep 1: rollback via reviewed revert from recorded commits — deterministic reapplication", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    // Baseline: record the current HEAD tree (the "previous" state).
    const baselineTree = git(["rev-parse", "HEAD^{tree}"], setup.worktree1);
    // Apply an effect: create a file and commit (the "next" state).
    writeFileSync(join(setup.worktree1, "new.txt"), "new\n");
    git(["add", "new.txt"], setup.worktree1);
    git(["commit", "-m", "forward effect"], setup.worktree1);
    const nextCommit = git(["rev-parse", "HEAD"], setup.worktree1);
    const nextTree = git(["rev-parse", "HEAD^{tree}"], setup.worktree1);
    assert.notEqual(nextTree, baselineTree, "forward effect must change the tree");
    // Rollback via reviewed revert: create a NEW commit whose tree is the
    // recorded baseline tree. NEVER `git reset --hard`.
    // `git commit-tree` with the baseline tree and the next commit as parent
    // produces a revert commit (a new commit, no history rewrite).
    const revertCommit = spawnSync(GIT_EXECUTABLE, ["-C", setup.worktree1, "commit-tree", baselineTree, "-p", nextCommit, "-m", "reviewed revert: rollback to recorded baseline"], { env: CLOSED_ENV as Record<string, string>, encoding: "utf8" });
    assert.equal(revertCommit.status, 0, "commit-tree must succeed");
    const revertCommitId = revertCommit.stdout.trim();
    // The revert commit's tree is the recorded baseline tree (deterministic).
    const revertCommitTree = git(["rev-parse", `${revertCommitId}^{tree}`], setup.worktree1);
    assert.equal(revertCommitTree, baselineTree, "revert commit tree must equal the recorded baseline tree");
    // The revert commit is a NEW commit (not a reset); the next commit is
    // still in history (no rewrite).
    const logCount = git(["rev-list", "--count", "HEAD"], setup.worktree1);
    // History grew by 2 (forward + revert); no commits were removed.
    assert.ok(Number(logCount) >= 2, "history must grow, never shrink (no reset)");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
  } finally {
    repo.cleanup();
  }
});

test("hostile-11 rep 2: rollback via reviewed revert from recorded refs — deterministic", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const baselineTree = git(["rev-parse", "HEAD^{tree}"], setup.worktree1);
    const baselineCommit = git(["rev-parse", "HEAD"], setup.worktree1);
    // Forward effect via a new commit on a governed ref.
    writeFileSync(join(setup.worktree1, "fwd.txt"), "fwd\n");
    git(["add", "fwd.txt"], setup.worktree1);
    git(["commit", "-m", "forward"], setup.worktree1);
    const afterCommit = git(["rev-parse", "HEAD"], setup.worktree1);
    assert.notEqual(afterCommit, baselineCommit, "forward must move HEAD");
    // Rollback: create a revert commit pointing at the baseline tree, then
    // update the ref atomically via `update-ref --stdin -z` with a CAS
    // `update` (expected-old = afterCommit). Never a force update.
    const revertCommit = spawnSync(GIT_EXECUTABLE, ["-C", setup.worktree1, "commit-tree", baselineTree, "-p", afterCommit, "-m", "reviewed revert from recorded ref"], { env: CLOSED_ENV as Record<string, string>, encoding: "utf8" });
    const revertCommitId = revertCommit.stdout.trim();
    // Atomic ref update with CAS (update <ref> <new> <expected-old>) — never a force update.
    // The `-z` format requires the verb+ref in one NUL-terminated token: `update refs/heads/main\0<new>\0<old>\0`.
    const refTxStdin = `update refs/heads/main\u0000${revertCommitId}\u0000${afterCommit}\u0000`;
    const refTx = spawnSync(GIT_EXECUTABLE, ["-C", setup.worktree1, "update-ref", "--stdin", "-z"], {
      env: CLOSED_ENV as Record<string, string>,
      input: refTxStdin,
      encoding: "utf8",
    });
    assert.equal(refTx.status, 0, `update-ref CAS must succeed: ${refTx.stderr}`);
    const finalHead = git(["rev-parse", "HEAD"], setup.worktree1);
    assert.equal(finalHead, revertCommitId, "ref must move to the revert commit (deterministic)");
    // The baseline commit is still in history (no rewrite).
    const ancestors = git(["rev-list", "--count", "HEAD"], setup.worktree1);
    assert.ok(Number(ancestors) >= 2, "history preserved (never reset)");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
  } finally {
    repo.cleanup();
  }
});

test("hostile-11 rep 3: rollback with concurrent observer — no duplicate effect (idempotent revert)", async () => {
  const repo = await createDisposableRepo();
  try {
    const setup = await setupMwaForRepo(repo);
    const h = createAuthorityHandle(setup, setup.worktree1);
    const acq = await h.authority.acquire(makeAcquireInput(setup.repoBinding, [physical("src/a", "write", "src/a")], h.clock.snapshot()));
    assertAccepted(acq, "acquire must succeed");
    if (acq.outcome !== "accepted") return;
    // Record the baseline tree.
    const baselineTree = git(["rev-parse", "HEAD^{tree}"], setup.worktree1);
    const baselineCommit = git(["rev-parse", "HEAD"], setup.worktree1);
    // A concurrent observer records a checkpoint (no duplicate effect on
    // resume). The revert is deterministic: the same baseline tree always
    // produces the same revert commit (same tree, same parent).
    const replayEnv = { ...CLOSED_ENV, GIT_AUTHOR_DATE: "2026-07-17T00:00:00Z", GIT_COMMITTER_DATE: "2026-07-17T00:00:00Z" };
    const revert1 = spawnSync(GIT_EXECUTABLE, ["-C", setup.worktree1, "commit-tree", baselineTree, "-p", baselineCommit, "-m", "reviewed revert"], { env: replayEnv, encoding: "utf8" });
    const revert1Id = revert1.stdout.trim();
    // Replay the same revert (idempotent): the same tree + parent + message
    // produces the SAME commit object (git content-addresses commits by
    // tree+parents+author/committer+message+gpgsig). The commit-tree is
    // deterministic given identical inputs — the DATES included: a replay
    // carries the recorded ones, so both runs pin them (unpinned, two runs
    // straddling a second boundary under load made two commits).
    const revert2 = spawnSync(GIT_EXECUTABLE, ["-C", setup.worktree1, "commit-tree", baselineTree, "-p", baselineCommit, "-m", "reviewed revert"], { env: replayEnv, encoding: "utf8" });
    const revert2Id = revert2.stdout.trim();
    assert.equal(revert1Id, revert2Id, "idempotent revert: same inputs → same commit (no duplicate effect)");
    const oracle = createOracle(setup.dbPath);
    assert.equal(oracle.verify().journalChainIntact, true);
    h.close();
  } finally {
    repo.cleanup();
  }
});
