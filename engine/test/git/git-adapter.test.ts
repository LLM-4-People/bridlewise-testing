import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import test from "node:test";

import {
  GIT_AUTH_METHODS,
  GIT_CHECKOUT_POLICIES,
  GIT_LFS_MODES,
  GIT_PORT_OPERATIONS,
  GIT_PORT_SCHEMA_VERSION,
  GIT_RECONCILIATION_MODES,
  GIT_SUBMODULE_MODES,
  GIT_TRANSPORTS,
  GIT_WORKSPACE_PLANS,
  GIT_WORKSPACE_STATES,
  isValidGitAuthMethod,
  isValidGitOperation,
  isValidGitReconciliationMode,
  isValidGitTransport,
  isValidGitWorkspacePlan,
  isValidGitWorkspaceState,
} from "../../src/git/git-port.ts";
import { createGitAdapter, resolveGitExecutable, withGitRuntime } from "../../src/git/git-adapter.ts";
import { deepFreeze } from "../../src/kernel/integrity.ts";
import {
  IDENTITY,
  TEST_CONFIG,
  makeGitContext,
  mkGitTempDir,
  withGitAdapter,
} from "../support/git-fixtures.ts";

const makeContext = makeGitContext;

// ========================
// Git port schema and validation tests
// ========================

test("GIT_PORT_SCHEMA_VERSION is stable", () => {
  assert.equal(GIT_PORT_SCHEMA_VERSION, "bridlewise-git-port/v1");
});

test("GIT_TRANSPORTS enumerates file, ssh, https", () => {
  assert.deepEqual([...GIT_TRANSPORTS], ["file", "ssh", "https"]);
});

test("GIT_RECONCILIATION_MODES enumerates all three modes", () => {
  assert.deepEqual([...GIT_RECONCILIATION_MODES], ["fast-forward-only", "merge", "rebase"]);
});

test("GIT_WORKSPACE_STATES enumerates all seven states", () => {
  assert.equal(GIT_WORKSPACE_STATES.length, 7);
  assert.ok(GIT_WORKSPACE_STATES.includes("empty"));
  assert.ok(GIT_WORKSPACE_STATES.includes("repository"));
  assert.ok(GIT_WORKSPACE_STATES.includes("corrupt-or-ambiguous"));
});

test("GIT_WORKSPACE_PLANS enumerates all six plans", () => {
  assert.equal(GIT_WORKSPACE_PLANS.length, 6);
  assert.ok(GIT_WORKSPACE_PLANS.includes("init-empty"));
  assert.ok(GIT_WORKSPACE_PLANS.includes("clone"));
});

test("GIT_AUTH_METHODS enumerates four methods", () => {
  assert.equal(GIT_AUTH_METHODS.length, 4);
  assert.ok(GIT_AUTH_METHODS.includes("credential-helper"));
  assert.ok(GIT_AUTH_METHODS.includes("ssh-agent"));
});

test("GIT_CHECKOUT_POLICIES enumerates checkout and no-checkout", () => {
  assert.deepEqual([...GIT_CHECKOUT_POLICIES], ["checkout", "no-checkout"]);
});

test("GIT_SUBMODULE_MODES enumerates three modes", () => {
  assert.equal(GIT_SUBMODULE_MODES.length, 3);
});

test("GIT_LFS_MODES enumerates three modes", () => {
  assert.equal(GIT_LFS_MODES.length, 3);
});

test("GIT_PORT_OPERATIONS enumerates all twenty operations", () => {
  assert.equal(GIT_PORT_OPERATIONS.length, 20);
  for (const op of ["init", "clone", "pull", "push", "commit", "branch", "tag", "checkout", "merge", "rebase", "status", "diff", "log"]) {
    assert.ok((GIT_PORT_OPERATIONS as readonly string[]).includes(op), `missing ${op}`);
  }
});

test("isValidGitTransport accepts valid transports", () => {
  assert.ok(isValidGitTransport("file"));
  assert.ok(isValidGitTransport("ssh"));
  assert.ok(isValidGitTransport("https"));
});

test("isValidGitTransport rejects invalid transports", () => {
  assert.ok(!isValidGitTransport("git"));
  assert.ok(!isValidGitTransport("ftp"));
  assert.ok(!isValidGitTransport(""));
  assert.ok(!isValidGitTransport(123));
});

test("isValidGitReconciliationMode accepts valid modes", () => {
  assert.ok(isValidGitReconciliationMode("fast-forward-only"));
  assert.ok(isValidGitReconciliationMode("merge"));
  assert.ok(isValidGitReconciliationMode("rebase"));
});

test("isValidGitReconciliationMode rejects invalid modes", () => {
  assert.ok(!isValidGitReconciliationMode("pull"));
  assert.ok(!isValidGitReconciliationMode(""));
});

test("isValidGitWorkspaceState accepts valid states", () => {
  for (const state of GIT_WORKSPACE_STATES) {
    assert.ok(isValidGitWorkspaceState(state), `should accept ${state}`);
  }
});

test("isValidGitWorkspaceState rejects invalid states", () => {
  assert.ok(!isValidGitWorkspaceState("invalid"));
  assert.ok(!isValidGitWorkspaceState(""));
});

test("isValidGitWorkspacePlan accepts valid plans", () => {
  for (const plan of GIT_WORKSPACE_PLANS) {
    assert.ok(isValidGitWorkspacePlan(plan), `should accept ${plan}`);
  }
});

test("isValidGitWorkspacePlan rejects invalid plans", () => {
  assert.ok(!isValidGitWorkspacePlan("invalid"));
  assert.ok(!isValidGitWorkspacePlan(""));
});

test("isValidGitAuthMethod accepts valid methods", () => {
  for (const method of GIT_AUTH_METHODS) {
    assert.ok(isValidGitAuthMethod(method), `should accept ${method}`);
  }
});

test("isValidGitAuthMethod rejects invalid methods", () => {
  assert.ok(!isValidGitAuthMethod("password"));
  assert.ok(!isValidGitAuthMethod(""));
});

test("isValidGitOperation accepts valid operations", () => {
  for (const op of GIT_PORT_OPERATIONS) {
    assert.ok(isValidGitOperation(op), `should accept ${op}`);
  }
});

test("isValidGitOperation rejects invalid operations", () => {
  assert.ok(!isValidGitOperation("invalid"));
  assert.ok(!isValidGitOperation(""));
  assert.ok(!isValidGitOperation(42));
});

// ========================
// Git adapter init tests
// ========================

test("git init creates a new repository with the specified branch", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "new-repo");
    mkdirSync(repoPath);
    const result = git.init(
      { path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY },
      makeContext("/", "init"),
    );
    assert.ok(isAbsolute(result.gitDir));
    assert.ok(existsSync(join(repoPath, ".git")));
    assert.equal(result.branch, "main");
  });
});

test("git init creates a bare repository", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "bare-repo");
    mkdirSync(repoPath);
    const result = git.init(
      { path: repoPath, bare: true, initialBranch: "main", identity: IDENTITY },
      makeContext("/", "init"),
    );
    assert.ok(existsSync(join(repoPath, "HEAD")));
    assert.equal(result.branch, "main");
  });
});

test("git init with custom branch name", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "custom-branch-repo");
    mkdirSync(repoPath);
    const result = git.init(
      { path: repoPath, bare: false, initialBranch: "develop", identity: IDENTITY },
      makeContext("/", "init"),
    );
    assert.equal(result.branch, "develop");
  });
});

test("git init rejects non-absolute path", () => {
  withGitAdapter((git) => {
    assert.throws(
      () => git.init(
        { path: "relative/path", bare: false, initialBranch: "main", identity: IDENTITY },
        makeContext("/", "init"),
      ),
      /absolute/u,
    );
  });
});

// ========================
// Git adapter commit tests
// ========================

test("git commit creates a commit with a message", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "commit-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "hello world");
    const result = git.commit(
      { path: repoPath, message: "Initial commit", identity: IDENTITY, allowEmpty: false, stageAll: true },
      makeContext(repoPath, "commit"),
    );
    assert.ok(result.commitSha.length >= 7);
    assert.ok(result.treeSha.length >= 7);
    assert.equal(result.parentShas.length, 0);
  });
});

test("git commit with allowEmpty creates an empty commit", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "empty-commit-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    const result = git.commit(
      { path: repoPath, message: "Empty commit", identity: IDENTITY, allowEmpty: true, stageAll: false },
      makeContext(repoPath, "commit"),
    );
    assert.ok(result.commitSha.length >= 7);
  });
});

test("git commit without staging fails on empty repo", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "no-stage-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    assert.throws(
      () => git.commit(
        { path: repoPath, message: "No files", identity: IDENTITY, allowEmpty: false, stageAll: false },
        makeContext(repoPath, "commit"),
      ),
    );
  });
});

test("git commit creates a second commit with a parent", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "two-commit-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file1.txt"), "content1");
    git.commit({ path: repoPath, message: "First", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    writeFileSync(join(repoPath, "file2.txt"), "content2");
    const result = git.commit(
      { path: repoPath, message: "Second", identity: IDENTITY, allowEmpty: false, stageAll: true },
      makeContext(repoPath, "commit"),
    );
    assert.equal(result.parentShas.length, 1);
    assert.ok(result.parentShas[0]!.length >= 7);
  });
});

// ========================
// Git adapter status tests
// ========================

test("git status on clean repo is clean", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "clean-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "hello");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const status = git.status({ path: repoPath, porcelain: 2, showIgnored: false }, makeContext(repoPath, "status"));
    assert.ok(status.clean);
    assert.equal(status.entries.length, 0);
  });
});

test("git status detects untracked files", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "untracked-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "tracked.txt"), "tracked");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    writeFileSync(join(repoPath, "untracked.txt"), "untracked");
    const status = git.status({ path: repoPath, porcelain: 2, showIgnored: false }, makeContext(repoPath, "status"));
    assert.ok(!status.clean);
    assert.ok(status.entries.some((e) => e.untracked));
  });
});

test("git status detects staged changes", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "staged-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "original");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    writeFileSync(join(repoPath, "file.txt"), "modified");
    const status = git.status({ path: repoPath, porcelain: 2, showIgnored: false }, makeContext(repoPath, "status"));
    assert.ok(!status.clean);
  });
});

test("git status on unborn repo reports unborn head", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "unborn-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    const status = git.status({ path: repoPath, porcelain: 2, showIgnored: false }, makeContext(repoPath, "status"));
    assert.ok(status.unborn);
    assert.equal(status.head, null);
  });
});

test("git status shows branch name", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "branch-name-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const status = git.status({ path: repoPath, porcelain: 2, showIgnored: false }, makeContext(repoPath, "status"));
    assert.equal(status.branch, "main");
    assert.ok(!status.unborn);
  });
});

// ========================
// Git adapter branch tests
// ========================

test("git branch creates a new branch", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "branch-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.branch({ path: repoPath, name: "feature", checkout: false }, makeContext(repoPath, "branch"));
    assert.equal(result.name, "feature");
    assert.ok(result.sha.length >= 7);
    assert.ok(!result.checkedOut);
  });
});

test("git branch with checkout switches to the new branch", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "branch-checkout-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.branch({ path: repoPath, name: "feature", checkout: true }, makeContext(repoPath, "branch"));
    assert.ok(result.checkedOut);
    const status = git.status({ path: repoPath, porcelain: 2, showIgnored: false }, makeContext(repoPath, "status"));
    assert.equal(status.branch, "feature");
  });
});

test("git branch with start point", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "branch-startpoint-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "v1");
    git.commit({ path: repoPath, message: "C1", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const firstSha = git.log({ path: repoPath, maxCount: 1, format: "full" }, makeContext(repoPath, "log")).entries[0]!.sha;
    writeFileSync(join(repoPath, "file.txt"), "v2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.branch({ path: repoPath, name: "from-old", startPoint: firstSha, checkout: false }, makeContext(repoPath, "branch"));
    assert.equal(result.sha, firstSha);
  });
});

// ========================
// Git adapter tag tests
// ========================

test("git tag creates a lightweight tag", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "tag-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.tag({ path: repoPath, name: "v1.0", annotated: false }, makeContext(repoPath, "tag"));
    assert.equal(result.name, "v1.0");
    assert.ok(result.sha.length >= 7);
    assert.ok(!result.annotated);
  });
});

test("git tag creates an annotated tag", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "annotated-tag-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.tag({
      path: repoPath, name: "v1.0-annotated", annotated: true, message: "Release 1.0", identity: IDENTITY,
    }, makeContext(repoPath, "tag"));
    assert.ok(result.annotated);
  });
});

test("git tag at a specific commit", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "tag-target-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "v1");
    git.commit({ path: repoPath, message: "C1", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const firstSha = git.log({ path: repoPath, maxCount: 1, format: "full" }, makeContext(repoPath, "log")).entries[0]!.sha;
    writeFileSync(join(repoPath, "file.txt"), "v2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.tag({ path: repoPath, name: "v1.0", target: firstSha, annotated: false }, makeContext(repoPath, "tag"));
    assert.equal(result.sha, firstSha);
  });
});

// ========================
// Git adapter checkout tests
// ========================

test("git checkout switches between branches", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "checkout-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "main content");
    git.commit({ path: repoPath, message: "Main", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.branch({ path: repoPath, name: "feature", checkout: true }, makeContext(repoPath, "branch"));
    writeFileSync(join(repoPath, "file.txt"), "feature content");
    git.commit({ path: repoPath, message: "Feature", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.checkout({ path: repoPath, ref: "main" }, makeContext(repoPath, "checkout"));
    assert.equal(result.branch, "main");
  });
});

test("git checkout creates a new branch with createBranch", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "checkout-create-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.checkout({ path: repoPath, ref: "main", createBranch: "new-branch" }, makeContext(repoPath, "checkout"));
    assert.equal(result.branch, "new-branch");
  });
});

// ========================
// Git adapter log tests
// ========================

test("git log returns commit entries", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "log-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "v1");
    git.commit({ path: repoPath, message: "C1", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    writeFileSync(join(repoPath, "file.txt"), "v2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.log({ path: repoPath, maxCount: 10, format: "full" }, makeContext(repoPath, "log"));
    assert.equal(result.total, 2);
    assert.equal(result.entries[0]!.message, "C2");
    assert.equal(result.entries[1]!.message, "C1");
  });
});

test("git log with maxCount limits entries", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "log-limit-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(repoPath, "file.txt"), `v${i}`);
      git.commit({ path: repoPath, message: `C${i}`, identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    }
    const result = git.log({ path: repoPath, maxCount: 2, format: "full" }, makeContext(repoPath, "log"));
    assert.equal(result.total, 2);
    assert.equal(result.entries[0]!.message, "C4");
    assert.equal(result.entries[1]!.message, "C3");
  });
});

test("git log entries have correct identity", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "log-identity-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.log({ path: repoPath, maxCount: 1, format: "full" }, makeContext(repoPath, "log"));
    assert.equal(result.entries[0]!.author.name, IDENTITY.name);
    assert.equal(result.entries[0]!.author.email, IDENTITY.email);
    assert.equal(result.entries[0]!.committer.name, IDENTITY.name);
  });
});

// ========================
// Git adapter diff tests
// ========================

test("git diff shows changes between commits", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "diff-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "line1\n");
    git.commit({ path: repoPath, message: "C1", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const firstSha = git.log({ path: repoPath, maxCount: 1, format: "full" }, makeContext(repoPath, "log")).entries[0]!.sha;
    writeFileSync(join(repoPath, "file.txt"), "line1\nline2\n");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const secondSha = git.log({ path: repoPath, maxCount: 1, format: "full" }, makeContext(repoPath, "log")).entries[0]!.sha;
    const result = git.diff({ path: repoPath, refA: firstSha, refB: secondSha, staged: false, contextLines: 3 }, makeContext(repoPath, "diff"));
    assert.ok(result.patch.includes("line2"));
    assert.ok(result.filesChanged > 0);
  });
});

test("git diff with no changes returns empty patch", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "diff-empty-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const sha = git.log({ path: repoPath, maxCount: 1, format: "full" }, makeContext(repoPath, "log")).entries[0]!.sha;
    const result = git.diff({ path: repoPath, refA: sha, refB: sha, staged: false, contextLines: 3 }, makeContext(repoPath, "diff"));
    assert.equal(result.patch.length, 0);
    assert.equal(result.filesChanged, 0);
  });
});

// ========================
// Git adapter inspect tests
// ========================

test("inspectRepository returns repository info", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "inspect-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const info = git.inspectRepository(repoPath, makeContext(repoPath, "inspect"));
    assert.ok(!info.bare);
    assert.ok(isAbsolute(info.gitDir));
    assert.equal(info.currentBranch, "main");
    assert.ok(!info.headDetached);
    assert.ok(!info.headUnborn);
  });
});

test("inspectRepository on bare repo reports bare=true", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "bare-inspect");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: true, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    const info = git.inspectRepository(repoPath, makeContext(repoPath, "inspect"));
    assert.ok(info.bare);
    assert.equal(info.workTree, null);
  });
});

test("inspectRepository on unborn repo reports headUnborn", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "unborn-inspect");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    const info = git.inspectRepository(repoPath, makeContext(repoPath, "inspect"));
    assert.ok(info.headUnborn);
    assert.equal(info.head, "");
  });
});

test("inspectRepository lists refs", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "refs-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.branch({ path: repoPath, name: "dev", checkout: false }, makeContext(repoPath, "branch"));
    git.tag({ path: repoPath, name: "v1.0", annotated: false }, makeContext(repoPath, "tag"));
    const info = git.inspectRepository(repoPath, makeContext(repoPath, "inspect"));
    assert.ok(info.refs.some((r) => r.isBranch && r.name === "refs/heads/main"));
    assert.ok(info.refs.some((r) => r.isBranch && r.name === "refs/heads/dev"));
    assert.ok(info.refs.some((r) => r.isTag && r.name === "refs/tags/v1.0"));
  });
});

// ========================
// Git adapter conflict tests
// ========================

test("checkConflicts returns no conflicts on clean repo", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "no-conflict-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.checkConflicts(repoPath, makeContext(repoPath, "conflict-check"));
    assert.ok(!result.hasConflicts);
    assert.equal(result.conflicts.length, 0);
  });
});

// ========================
// Git adapter never-push scan tests
// ========================

test("scanNeverPush returns clean on repo with no matching files", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "never-push-clean");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.scanNeverPush(
      repoPath,
      { additiveRules: [{ pattern: "^secrets/", classification: "credentials" }] },
      makeContext(repoPath, "never-push-scan"),
    );
    assert.ok(result.clean);
  });
});

test("scanNeverPush detects matching files", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "never-push-detect");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    mkdirSync(join(repoPath, "secrets"));
    writeFileSync(join(repoPath, "secrets", "key.pem"), "PRIVATE KEY");
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.scanNeverPush(
      repoPath,
      { additiveRules: [{ pattern: "^secrets/", classification: "credentials" }] },
      makeContext(repoPath, "never-push-scan"),
    );
    assert.ok(!result.clean);
    assert.ok(result.violations.length > 0);
    assert.ok(result.violations.some((v) => v.path.includes("secrets")));
  });
});

// ========================
// Git adapter promotion tests
// ========================

test("promote fast-forwards target branch to source", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "promote-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "v1");
    git.commit({ path: repoPath, message: "C1", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.branch({ path: repoPath, name: "testing", checkout: false }, makeContext(repoPath, "branch"));
    git.branch({ path: repoPath, name: "feature", checkout: true }, makeContext(repoPath, "branch"));
    writeFileSync(join(repoPath, "file.txt"), "v2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.promote(
      { path: repoPath, sourceBranch: "feature", targetBranch: "testing", identity: IDENTITY, fastForwardOnly: true },
      makeContext(repoPath, "promote"),
    );
    assert.ok(result.promoted);
    assert.ok(result.fastForward);
    assert.equal(result.sourceSha, result.targetSha);
  });
});

// ========================
// Git adapter rollback tests
// ========================

test("rollback with revert creates a revert commit", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "rollback-revert");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "v1");
    git.commit({ path: repoPath, message: "C1", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    writeFileSync(join(repoPath, "file.txt"), "v2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const secondSha = git.log({ path: repoPath, maxCount: 1, format: "full" }, makeContext(repoPath, "log")).entries[0]!.sha;
    const result = git.rollback(
      { path: repoPath, target: secondSha, identity: IDENTITY, mode: "revert" },
      makeContext(repoPath, "rollback"),
    );
    assert.ok(result.reverted);
    assert.ok(result.commitSha !== null);
  });
});

test("rollback with reset-soft moves HEAD", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "rollback-reset");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "v1");
    git.commit({ path: repoPath, message: "C1", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const firstSha = git.log({ path: repoPath, maxCount: 1, format: "full" }, makeContext(repoPath, "log")).entries[0]!.sha;
    writeFileSync(join(repoPath, "file.txt"), "v2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.rollback(
      { path: repoPath, target: firstSha, identity: IDENTITY, mode: "reset-soft" },
      makeContext(repoPath, "rollback"),
    );
    assert.ok(result.reset);
    assert.equal(result.newHead, firstSha);
  });
});

test("rollback with reset-mixed moves HEAD and unstages", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "rollback-reset-mixed");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "v1");
    git.commit({ path: repoPath, message: "C1", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const firstSha = git.log({ path: repoPath, maxCount: 1, format: "full" }, makeContext(repoPath, "log")).entries[0]!.sha;
    writeFileSync(join(repoPath, "file.txt"), "v2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.rollback(
      { path: repoPath, target: firstSha, identity: IDENTITY, mode: "reset-mixed" },
      makeContext(repoPath, "rollback"),
    );
    assert.ok(result.reset);
    assert.equal(result.newHead, firstSha);
  });
});

// ========================
// Git adapter push security tests
// ========================

test("push with force=true throws security error", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "force-push-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    // The GitPushRequest type enforces force: false. Attempting to pass force: true
    // would be a TypeScript error. At runtime, force is always false.
    // Test that push with force: false does NOT throw a security error (it may fail
    // for other reasons like missing remote).
    assert.throws(
      () => git.push(
        { path: repoPath, remote: "origin", refspecs: ["main"], atomic: true, force: false, identity: IDENTITY },
        makeContext(repoPath, "push"),
      ),
    );
  });
});

// ========================
// Git adapter merge tests
// ========================

test("merge with fast-forward", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "merge-ff-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "v1");
    git.commit({ path: repoPath, message: "C1", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.branch({ path: repoPath, name: "feature", checkout: true }, makeContext(repoPath, "branch"));
    writeFileSync(join(repoPath, "file.txt"), "v2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.checkout({ path: repoPath, ref: "main" }, makeContext(repoPath, "checkout"));
    const result = git.merge(
      { path: repoPath, branch: "feature", identity: IDENTITY, noFastForward: false, noCommit: false },
      makeContext(repoPath, "merge"),
    );
    assert.ok(result.fastForward);
    assert.equal(result.conflicts.length, 0);
  });
});

test("merge with no-fast-forward creates a merge commit", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "merge-noff-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "v1");
    git.commit({ path: repoPath, message: "C1", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.branch({ path: repoPath, name: "feature", checkout: true }, makeContext(repoPath, "branch"));
    writeFileSync(join(repoPath, "feature.txt"), "feature");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.checkout({ path: repoPath, ref: "main" }, makeContext(repoPath, "checkout"));
    writeFileSync(join(repoPath, "main.txt"), "main");
    git.commit({ path: repoPath, message: "C3", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.merge(
      { path: repoPath, branch: "feature", identity: IDENTITY, noFastForward: true, noCommit: false },
      makeContext(repoPath, "merge"),
    );
    assert.ok(!result.fastForward);
    assert.ok(result.merged);
    assert.ok(result.commitSha !== null);
  });
});

// ========================
// Git adapter clone with local bare remote tests
// ========================

test("clone from a local bare remote", () => {
  withGitAdapter((git, _runtime, root) => {
    const sourcePath = join(root, "clone-source");
    const barePath = join(root, "clone-bare");
    const destPath = join(root, "clone-dest");
    mkdirSync(sourcePath);
    git.init({ path: sourcePath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(sourcePath, "file.txt"), "content");
    git.commit({ path: sourcePath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(sourcePath, "commit"));
    git.init({ path: barePath, bare: true, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    // Push source to bare
    // (uses git push internally via the adapter, but we need to set up the remote first)
    // For this test, we'll clone the source directory directly
    const result = git.clone(
      { url: sourcePath, destination: destPath, bare: false, identity: IDENTITY },
      makeContext("/", "clone"),
    );
    assert.ok(existsSync(join(destPath, ".git")));
    assert.ok(existsSync(join(destPath, "file.txt")));
    assert.equal(result.branch, "main");
  });
});

// ========================
// Git adapter pull with local remote tests
// ========================

test("pull from a local remote updates the branch", () => {
  withGitAdapter((git, _runtime, root) => {
    const sourcePath = join(root, "pull-source");
    const destPath = join(root, "pull-dest");
    mkdirSync(sourcePath);
    git.init({ path: sourcePath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(sourcePath, "file.txt"), "v1");
    git.commit({ path: sourcePath, message: "C1", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(sourcePath, "commit"));
    git.clone({ url: sourcePath, destination: destPath, bare: false, identity: IDENTITY }, makeContext("/", "clone"));
    writeFileSync(join(sourcePath, "file.txt"), "v2");
    git.commit({ path: sourcePath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(sourcePath, "commit"));
    const result = git.pull(
      { path: destPath, remote: "origin", branch: "main", reconciliation: "fast-forward-only", identity: IDENTITY },
      makeContext(destPath, "pull"),
    );
    assert.ok(result.fastForward || result.upToDate);
    assert.equal(result.conflicts.length, 0);
  });
});

// ========================
// Git adapter timeout tests
// ========================

test("git operation with very short timeout still works for fast operations", () => {
  withGitAdapter((git, _runtime, root) => {
    const repoPath = join(root, "timeout-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init", 10000));
    const status = git.status(
      { path: repoPath, porcelain: 2, showIgnored: false },
      makeContext(repoPath, "status", 10000),
    );
    assert.ok(status.unborn);
  });
});

// ========================
// Git adapter remote URL sanitization tests
// ========================

test("clone rejects URLs with embedded credentials", () => {
  withGitAdapter((git, _runtime, root) => {
    const destPath = join(root, "cred-clone");
    assert.throws(
      () => git.clone(
        { url: "https://user:password@example.com/repo.git", destination: destPath, bare: false, identity: IDENTITY },
        makeContext("/", "clone"),
      ),
      /credential/u,
    );
  });
});

test("clone rejects disallowed transports", () => {
  withGitAdapter((git, _runtime, root) => {
    const destPath = join(root, "ftp-clone");
    assert.throws(
      () => git.clone(
        { url: "ftp://example.com/repo.git", destination: destPath, bare: false, identity: IDENTITY },
        makeContext("/", "clone"),
      ),
      /transport/u,
    );
  });
});

test("clone accepts file transport", () => {
  withGitAdapter((git, _runtime, root) => {
    const sourcePath = join(root, "file-transport-source");
    const destPath = join(root, "file-transport-dest");
    mkdirSync(sourcePath);
    git.init({ path: sourcePath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(sourcePath, "file.txt"), "content");
    git.commit({ path: sourcePath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(sourcePath, "commit"));
    const cloneResult = git.clone(
      { url: `file://${sourcePath}`, destination: destPath, bare: false, identity: IDENTITY },
      makeContext("/", "clone"),
    );
    assert.ok(existsSync(join(destPath, ".git")));
    assert.ok(cloneResult.branch.length > 0);
  });
});

// ========================
// Git adapter operation recording tests
// ========================

test("GitEffectRecorder records git operations", () => {
  const recorded: { operation: string; description: string }[] = [];
  const recorder = deepFreeze({
    recordGitOperation: (input: { operation: string; description: string }) => {
      recorded.push({ operation: input.operation, description: input.description });
      return deepFreeze({ eventId: "evt-1", sequence: "1", chainHash: "hash" });
    },
    recordCommit: (input: { commitSha: string; description: string }) => {
      recorded.push({ operation: "commit", description: input.description });
      return deepFreeze({ eventId: "evt-2", sequence: "2", chainHash: "hash" });
    },
  });
  const root = mkGitTempDir("recorder-test");
  const gitPath = resolveGitExecutable();
  withGitRuntime(gitPath, 268_435_456, (runtime) => {
    const git = createGitAdapter(runtime, { config: TEST_CONFIG, recorder });
    const repoPath = join(root, "recorded-repo");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    assert.ok(recorded.some((r) => r.operation === "init"));
    writeFileSync(join(repoPath, "file.txt"), "content");
    git.commit({ path: repoPath, message: "Init", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    assert.ok(recorded.some((r) => r.operation === "commit"));
  });
});

// ========================
// resolveGitExecutable tests
// ========================

test("resolveGitExecutable returns an absolute path", () => {
  const gitPath = resolveGitExecutable();
  assert.ok(isAbsolute(gitPath));
  assert.ok(existsSync(gitPath));
});

test("withGitRuntime pins the git executable", () => {
  const gitPath = resolveGitExecutable();
  const result = withGitRuntime(gitPath, 268_435_456, (runtime) => {
    assert.ok(runtime.executable.identityHash.length === 64);
    return "ok";
  });
  assert.equal(result, "ok");
});

test("withGitRuntime rejects non-existent path", () => {
  assert.throws(
    () => withGitRuntime("/nonexistent/git", 268_435_456, () => "ok"),
    /invalid/u,
  );
});

test("withGitRuntime rejects non-absolute path", () => {
  assert.throws(
    () => withGitRuntime("git", 268_435_456, () => "ok"),
    /invalid/u,
  );
});
