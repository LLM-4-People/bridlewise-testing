import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  type GitPort,
} from "../src/git/git-port.ts";
import { createWorkspaceLifecycle } from "../src/git/workspace-lifecycle.ts";
import {
  IDENTITY,
  TEST_CONFIG,
  createRepoWithCommit,
  makeGitContext,
  withGitAdapter,
} from "./support/git-fixtures.ts";

const makeContext = makeGitContext;

function withLifecycle<T>(operation: (lifecycle: ReturnType<typeof createWorkspaceLifecycle>, git: GitPort, root: string) => T): T {
  return withGitAdapter((git, _runtime, root) => {
    const lifecycle = createWorkspaceLifecycle(git, TEST_CONFIG);
    return operation(lifecycle, git, root);
  });
}

function createRepo(git: GitPort, root: string, name: string): string {
  return createRepoWithCommit(git, root, name, { readmeContent: "# Test Repo", commitMessage: "Initial commit" });
}

// ========================
// Workspace onboarding detection tests
// ========================

test("onboarding.detect returns empty for a new empty directory", () => {
  withLifecycle((_lifecycle, _git, root) => {
    const emptyDir = join(root, "empty");
    mkdirSync(emptyDir);
    const state = _lifecycle.onboarding.detect(emptyDir, makeContext(emptyDir, "inspect"));
    assert.equal(state, "empty");
  });
});

test("onboarding.detect returns nonempty-unversioned for directory with files", () => {
  withLifecycle((lifecycle, _git, root) => {
    const dir = join(root, "nonempty");
    mkdirSync(dir);
    writeFileSync(join(dir, "file.txt"), "content");
    const state = lifecycle.onboarding.detect(dir, makeContext(dir, "inspect"));
    assert.equal(state, "nonempty-unversioned");
  });
});

test("onboarding.detect returns repository for an initialized git repo", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "repo");
    const state = lifecycle.onboarding.detect(repoPath, makeContext(repoPath, "inspect"));
    assert.equal(state, "repository");
  });
});

test("onboarding.detect returns corrupt-or-ambiguous for non-existent path", () => {
  withLifecycle((lifecycle, _git, root) => {
    const state = lifecycle.onboarding.detect(join(root, "nonexistent"), makeContext(root, "inspect"));
    assert.equal(state, "corrupt-or-ambiguous");
  });
});

test("onboarding.detect returns bare for a bare repo", () => {
  withLifecycle((lifecycle, git, root) => {
    const barePath = join(root, "bare");
    mkdirSync(barePath);
    git.init({ path: barePath, bare: true, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    const state = lifecycle.onboarding.detect(barePath, makeContext(barePath, "inspect"));
    assert.equal(state, "bare");
  });
});

test("onboarding.detect rejects non-absolute path", () => {
  withLifecycle((lifecycle) => {
    assert.throws(
      () => lifecycle.onboarding.detect("relative", makeContext("/", "inspect")),
      /absolute/u,
    );
  });
});

// ========================
// Workspace onboarding recommendation tests
// ========================

test("onboarding.recommend returns init-empty for empty state", () => {
  withLifecycle((lifecycle) => {
    const plan = lifecycle.onboarding.recommend("/tmp", "empty");
    assert.equal(plan, "init-empty");
  });
});

test("onboarding.recommend returns import-and-init for nonempty-unversioned", () => {
  withLifecycle((lifecycle) => {
    const plan = lifecycle.onboarding.recommend("/tmp", "nonempty-unversioned");
    assert.equal(plan, "import-and-init");
  });
});

test("onboarding.recommend returns reconcile for repository", () => {
  withLifecycle((lifecycle) => {
    const plan = lifecycle.onboarding.recommend("/tmp", "repository");
    assert.equal(plan, "reconcile");
  });
});

test("onboarding.recommend returns attach for linked-worktree", () => {
  withLifecycle((lifecycle) => {
    const plan = lifecycle.onboarding.recommend("/tmp", "linked-worktree");
    assert.equal(plan, "attach");
  });
});

test("onboarding.recommend returns fork for bare", () => {
  withLifecycle((lifecycle) => {
    const plan = lifecycle.onboarding.recommend("/tmp", "bare");
    assert.equal(plan, "fork");
  });
});

test("onboarding.recommend returns attach for nested", () => {
  withLifecycle((lifecycle) => {
    const plan = lifecycle.onboarding.recommend("/tmp", "nested");
    assert.equal(plan, "attach");
  });
});

test("onboarding.recommend returns reconcile for corrupt-or-ambiguous", () => {
  withLifecycle((lifecycle) => {
    const plan = lifecycle.onboarding.recommend("/tmp", "corrupt-or-ambiguous");
    assert.equal(plan, "reconcile");
  });
});

// ========================
// Workspace onboarding execution tests
// ========================

test("onboarding.execute init-empty creates a new repository", () => {
  withLifecycle((lifecycle, _git, root) => {
    const repoPath = join(root, "init-test");
    mkdirSync(repoPath);
    const result = lifecycle.onboarding.execute(
      { path: repoPath, plan: "init-empty", identity: IDENTITY },
      makeContext("/", "init"),
    );
    assert.equal(result.action, "init");
    assert.equal(result.state, "repository");
    assert.ok(result.repositoryInfo !== null);
    assert.ok(existsSync(join(repoPath, ".git")));
  });
});

test("onboarding.execute init-empty rejects non-empty directory", () => {
  withLifecycle((lifecycle, _git, root) => {
    const dir = join(root, "non-empty-init");
    mkdirSync(dir);
    writeFileSync(join(dir, "file.txt"), "content");
    assert.throws(
      () => lifecycle.onboarding.execute(
        { path: dir, plan: "init-empty", identity: IDENTITY },
        makeContext("/", "init"),
      ),
      /non.empty/u,
    );
  });
});

test("onboarding.execute import-and-init imports existing data", () => {
  withLifecycle((lifecycle, _git, root) => {
    const dir = join(root, "import-test");
    mkdirSync(dir);
    writeFileSync(join(dir, "file.txt"), "existing content");
    const result = lifecycle.onboarding.execute(
      { path: dir, plan: "import-and-init", identity: IDENTITY },
      makeContext("/", "init"),
    );
    assert.equal(result.action, "import");
    assert.equal(result.state, "repository");
    assert.ok(existsSync(join(dir, ".git")));
  });
});

test("onboarding.execute clone creates a clone", () => {
  withLifecycle((lifecycle, git, root) => {
    const sourcePath = createRepo(git, root, "clone-source");
    const destPath = join(root, "clone-dest");
    mkdirSync(destPath);
    const result = lifecycle.onboarding.execute(
      { path: destPath, plan: "clone", identity: IDENTITY, remoteUrl: sourcePath },
      makeContext("/", "clone"),
    );
    assert.equal(result.action, "clone");
    assert.ok(existsSync(join(destPath, ".git")));
  });
});

test("onboarding.execute reconcile inspects an existing repo", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "reconcile-test");
    const result = lifecycle.onboarding.execute(
      { path: repoPath, plan: "reconcile", identity: IDENTITY },
      makeContext(repoPath, "inspect"),
    );
    assert.equal(result.action, "reconcile");
    assert.ok(result.repositoryInfo !== null);
  });
});

test("onboarding.execute clone requires remoteUrl", () => {
  withLifecycle((lifecycle, _git, root) => {
    const destPath = join(root, "clone-no-url");
    mkdirSync(destPath);
    rmSync(destPath, { recursive: true, force: true });
    assert.throws(
      () => lifecycle.onboarding.execute(
        { path: join(root, "clone-no-url"), plan: "clone", identity: IDENTITY },
        makeContext("/", "clone"),
      ),
      /remoteUrl/u,
    );
  });
});

// ========================
// Remote management tests
// ========================

test("remotes.configure with same fetch and push remote", () => {
  withLifecycle((lifecycle, _git, root) => {
    const result = lifecycle.remotes.configure(
      {
        path: root,
        fetchRemoteName: "origin",
        fetchUrl: "file:///path/to/repo",
      },
      makeContext(root, "remote"),
    );
    assert.ok(!result.separate);
    assert.equal(result.fetchRemote.name, "origin");
    assert.equal(result.pushRemote.name, "origin");
  });
});

test("remotes.configure with separate fetch and push remotes", () => {
  withLifecycle((lifecycle, _git, root) => {
    const result = lifecycle.remotes.configure(
      {
        path: root,
        fetchRemoteName: "upstream",
        fetchUrl: "file:///upstream/repo",
        pushRemoteName: "origin",
        pushUrl: "file:///fork/repo",
      },
      makeContext(root, "remote"),
    );
    assert.ok(result.separate);
    assert.equal(result.fetchRemote.name, "upstream");
    assert.equal(result.pushRemote.name, "origin");
  });
});

test("remotes.configure sanitizes URLs with credentials", () => {
  withLifecycle((lifecycle, _git, root) => {
    const result = lifecycle.remotes.configure(
      {
        path: root,
        fetchRemoteName: "origin",
        fetchUrl: "https://user:pass@github.com/repo",
      },
      makeContext(root, "remote"),
    );
    assert.ok(!result.fetchRemote.urlIdentity.includes("user:pass"));
  });
});

test("remotes.list returns remotes from a repo", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "remote-list");
    const remotes = lifecycle.remotes.list(repoPath, makeContext(repoPath, "inspect"));
    assert.ok(Array.isArray(remotes));
  });
});

// ========================
// Sync tests
// ========================

test("sync.pull fast-forwards from a local remote", () => {
  withLifecycle((lifecycle, git, root) => {
    const sourcePath = createRepo(git, root, "sync-source");
    const destPath = join(root, "sync-dest");
    git.clone({ url: sourcePath, destination: destPath, bare: false, identity: IDENTITY }, makeContext("/", "clone"));
    writeFileSync(join(sourcePath, "new-file.txt"), "new content");
    git.commit({ path: sourcePath, message: "New file", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(sourcePath, "commit"));
    const result = lifecycle.sync.pull(
      { path: destPath, remote: "origin", branch: "main", identity: IDENTITY, reconciliation: "fast-forward-only" },
      makeContext(destPath, "pull"),
    );
    assert.ok(result.fastForward || result.upToDate);
    assert.equal(result.conflicts.length, 0);
  });
});

test("sync.detectConflicts returns no conflicts on clean repo", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "conflict-clean");
    const result = lifecycle.sync.detectConflicts(repoPath, makeContext(repoPath, "conflict-check"));
    assert.ok(!result.hasConflicts);
  });
});

// ========================
// Branch management tests
// ========================

test("branches.createFeatureBranch creates and checks out a branch", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "feature-branch");
    const result = lifecycle.branches.createFeatureBranch(
      { path: repoPath, branchName: "feature-1", identity: IDENTITY },
      makeContext(repoPath, "branch"),
    );
    assert.equal(result.branchName, "feature-1");
    assert.ok(result.created);
    assert.ok(result.checkedOut);
  });
});

test("branches.createFeatureBranch with start point", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "feature-startpoint");
    const firstSha = git.log({ path: repoPath, maxCount: 1, format: "full" }, makeContext(repoPath, "log")).entries[0]!.sha;
    writeFileSync(join(repoPath, "file2.txt"), "content2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = lifecycle.branches.createFeatureBranch(
      { path: repoPath, branchName: "from-old", startPoint: firstSha, identity: IDENTITY },
      makeContext(repoPath, "branch"),
    );
    assert.ok(result.sha.length >= 7);
  });
});

test("branches.list returns all branches", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "branch-list");
    git.branch({ path: repoPath, name: "dev", checkout: false }, makeContext(repoPath, "branch"));
    git.branch({ path: repoPath, name: "feature", checkout: false }, makeContext(repoPath, "branch"));
    const branches = lifecycle.branches.list(repoPath, makeContext(repoPath, "inspect"));
    assert.ok(branches.includes("refs/heads/main"));
    assert.ok(branches.includes("refs/heads/dev"));
    assert.ok(branches.includes("refs/heads/feature"));
  });
});

test("branches.switch checks out a branch", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "branch-switch");
    git.branch({ path: repoPath, name: "target", checkout: false }, makeContext(repoPath, "branch"));
    const result = lifecycle.branches.switch(repoPath, "target", makeContext(repoPath, "checkout"));
    assert.equal(result.branch, "target");
  });
});

// ========================
// Checkpoint tests
// ========================

test("checkpoints.create creates an annotated tag", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "checkpoint-create");
    const result = lifecycle.checkpoints.create(
      { path: repoPath, name: "v1.0", message: "Checkpoint v1.0", identity: IDENTITY },
      makeContext(repoPath, "tag"),
    );
    assert.ok(result.name.includes("v1.0"));
    assert.ok(result.annotated);
  });
});

test("checkpoints.list returns tags in the namespace", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "checkpoint-list");
    lifecycle.checkpoints.create(
      { path: repoPath, name: "v1.0", message: "C1", identity: IDENTITY },
      makeContext(repoPath, "tag"),
    );
    lifecycle.checkpoints.create(
      { path: repoPath, name: "v2.0", message: "C2", identity: IDENTITY },
      makeContext(repoPath, "tag"),
    );
    const checkpoints = lifecycle.checkpoints.list(repoPath, "harness-checkpoint", makeContext(repoPath, "inspect"));
    assert.ok(checkpoints.length >= 2);
  });
});

// ========================
// Promotion tests
// ========================

test("promotion.promote fast-forwards target branch", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "promote-test");
    git.branch({ path: repoPath, name: "testing", checkout: false }, makeContext(repoPath, "branch"));
    git.branch({ path: repoPath, name: "feature", checkout: true }, makeContext(repoPath, "branch"));
    writeFileSync(join(repoPath, "new-file.txt"), "new");
    git.commit({ path: repoPath, message: "Feature commit", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = lifecycle.promotion.promote(
      { path: repoPath, sourceBranch: "feature", targetBranch: "testing", identity: IDENTITY },
      makeContext(repoPath, "promote"),
    );
    assert.ok(result.promoted);
  });
});

test("promotion.verifyClean returns true for clean repo", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "verify-clean");
    assert.ok(lifecycle.promotion.verifyClean(repoPath, makeContext(repoPath, "status")));
  });
});

test("promotion.verifyClean returns false for dirty repo", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "verify-dirty");
    writeFileSync(join(repoPath, "new-file.txt"), "untracked");
    assert.ok(!lifecycle.promotion.verifyClean(repoPath, makeContext(repoPath, "status")));
  });
});

test("promotion.promote rejects when working tree is not clean", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "promote-dirty");
    git.branch({ path: repoPath, name: "testing", checkout: false }, makeContext(repoPath, "branch"));
    git.branch({ path: repoPath, name: "feature", checkout: true }, makeContext(repoPath, "branch"));
    writeFileSync(join(repoPath, "new-file.txt"), "new");
    git.commit({ path: repoPath, message: "Feature", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    writeFileSync(join(repoPath, "dirty.txt"), "dirty");
    assert.throws(
      () => lifecycle.promotion.promote(
        { path: repoPath, sourceBranch: "feature", targetBranch: "testing", identity: IDENTITY },
        makeContext(repoPath, "promote"),
      ),
      /clean/u,
    );
  });
});

test("promotion.promote rejects when never-push violations exist", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "promote-never-push");
    mkdirSync(join(repoPath, "secrets"));
    writeFileSync(join(repoPath, "secrets", "key.pem"), "PRIVATE KEY");
    git.commit({ path: repoPath, message: "Add secrets", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.branch({ path: repoPath, name: "testing", checkout: false }, makeContext(repoPath, "branch"));
    git.branch({ path: repoPath, name: "feature", checkout: true }, makeContext(repoPath, "branch"));
    writeFileSync(join(repoPath, "new.txt"), "new");
    git.commit({ path: repoPath, message: "Feature", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    assert.throws(
      () => lifecycle.promotion.promote(
        { path: repoPath, sourceBranch: "feature", targetBranch: "testing", identity: IDENTITY },
        makeContext(repoPath, "promote"),
      ),
      /never.push/u,
    );
  });
});

// ========================
// Rollback tests
// ========================

test("rollback.execute with revert creates a revert commit", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "rollback-test");
    writeFileSync(join(repoPath, "file.txt"), "v2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const firstSha = git.log({ path: repoPath, maxCount: 2, format: "full" }, makeContext(repoPath, "log")).entries[1]!.sha;
    const result = lifecycle.rollback.execute(
      { path: repoPath, target: firstSha, identity: IDENTITY, mode: "revert" },
      makeContext(repoPath, "rollback"),
    );
    assert.ok(result.reverted);
    assert.ok(result.commitSha !== null);
  });
});

test("rollback.execute with reset-soft moves HEAD back", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "rollback-soft");
    writeFileSync(join(repoPath, "file.txt"), "v2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const firstSha = git.log({ path: repoPath, maxCount: 2, format: "full" }, makeContext(repoPath, "log")).entries[1]!.sha;
    const result = lifecycle.rollback.execute(
      { path: repoPath, target: firstSha, identity: IDENTITY, mode: "reset-soft" },
      makeContext(repoPath, "rollback"),
    );
    assert.ok(result.reset);
    assert.equal(result.newHead, firstSha);
  });
});

test("rollback.execute with reset-mixed moves HEAD and unstages", () => {
  withLifecycle((lifecycle, git, root) => {
    const repoPath = createRepo(git, root, "rollback-mixed");
    writeFileSync(join(repoPath, "file.txt"), "v2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const firstSha = git.log({ path: repoPath, maxCount: 2, format: "full" }, makeContext(repoPath, "log")).entries[1]!.sha;
    const result = lifecycle.rollback.execute(
      { path: repoPath, target: firstSha, identity: IDENTITY, mode: "reset-mixed" },
      makeContext(repoPath, "rollback"),
    );
    assert.ok(result.reset);
  });
});

// ========================
// Bare repo fork tests
// ========================

test("onboarding.execute fork inspects a bare repo", () => {
  withLifecycle((lifecycle, git, root) => {
    const barePath = join(root, "bare-fork");
    mkdirSync(barePath);
    git.init({ path: barePath, bare: true, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    const result = lifecycle.onboarding.execute(
      { path: barePath, plan: "fork", identity: IDENTITY, remoteUrl: "file:///source/repo" },
      makeContext(barePath, "inspect"),
    );
    assert.equal(result.action, "fork");
  });
});

test("onboarding.execute fork requires remoteUrl", () => {
  withLifecycle((lifecycle, git, root) => {
    const barePath = join(root, "bare-fork-no-url");
    mkdirSync(barePath);
    git.init({ path: barePath, bare: true, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    assert.throws(
      () => lifecycle.onboarding.execute(
        { path: barePath, plan: "fork", identity: IDENTITY },
        makeContext(barePath, "inspect"),
      ),
      /remoteUrl/u,
    );
  });
});

// ========================
// Remote management with custom refspecs
// ========================

test("remotes.configure with custom fetch refspecs", () => {
  withLifecycle((lifecycle, _git, root) => {
    const result = lifecycle.remotes.configure(
      {
        path: root,
        fetchRemoteName: "origin",
        fetchUrl: "file:///repo",
        fetchRefspecs: ["+refs/heads/main:refs/remotes/origin/main"],
      },
      makeContext(root, "remote"),
    );
    assert.ok(result.fetchRemote.refspecs.includes("+refs/heads/main:refs/remotes/origin/main"));
  });
});

test("remotes.configure with custom push refspecs", () => {
  withLifecycle((lifecycle, _git, root) => {
    const result = lifecycle.remotes.configure(
      {
        path: root,
        fetchRemoteName: "origin",
        fetchUrl: "file:///repo",
        pushRemoteName: "origin",
        pushUrl: "file:///push-repo",
        pushRefspecs: ["refs/heads/main:refs/heads/main"],
      },
      makeContext(root, "remote"),
    );
    assert.ok(result.pushRemote.refspecs.includes("refs/heads/main:refs/heads/main"));
  });
});

// ========================
// Onboarding import-and-init validation tests
// ========================

test("onboarding.execute import-and-init rejects empty directory", () => {
  withLifecycle((lifecycle, _git, root) => {
    const dir = join(root, "import-empty");
    mkdirSync(dir);
    assert.throws(
      () => lifecycle.onboarding.execute(
        { path: dir, plan: "import-and-init", identity: IDENTITY },
        makeContext("/", "init"),
      ),
      /nonempty/u,
    );
  });
});

test("onboarding.execute reconcile rejects empty directory", () => {
  withLifecycle((lifecycle, _git, root) => {
    const dir = join(root, "reconcile-empty");
    mkdirSync(dir);
    assert.throws(
      () => lifecycle.onboarding.execute(
        { path: dir, plan: "reconcile", identity: IDENTITY },
        makeContext(dir, "inspect"),
      ),
      /repository/u,
    );
  });
});

test("onboarding.execute attach rejects non-worktree directory", () => {
  withLifecycle((lifecycle, _git, root) => {
    const dir = join(root, "attach-regular");
    mkdirSync(dir);
    assert.throws(
      () => lifecycle.onboarding.execute(
        { path: dir, plan: "attach", identity: IDENTITY },
        makeContext(dir, "inspect"),
      ),
      /linked.worktree|nested/u,
    );
  });
});
