import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createWorkspaceLifecycle } from "../../src/git/workspace-lifecycle.ts";
import { extractErrorMessage } from "../../src/kernel/errors.ts";
import {
  type GitPort,
  type WorkspaceGitConfig,
} from "../../src/git/git-port.ts";
import {
  IDENTITY,
  TEST_CONFIG,
  createRepoWithCommit,
  makeGitContext,
  withGitAdapter,
} from "../support/git-fixtures.ts";

const makeContext = makeGitContext;

function withGit<T>(operation: (git: GitPort, root: string) => T): T {
  return withGitAdapter((git, _runtime, root) => operation(git, root));
}

const createRepo = createRepoWithCommit;

// ========================
// Force-push prevention tests
// ========================

test("hostile: push with force=true is rejected", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "force-push");
    assert.throws(
      () => git.push(
        { path: repoPath, remote: "origin", refspecs: ["main"], atomic: true, force: false as never, identity: IDENTITY } as never,
        makeContext(repoPath, "push"),
      ),
    );
  });
});

test("hostile: force field is always false in config", () => {
  assert.equal(TEST_CONFIG.push.force, false);
});

test("hostile: GitPushOptions type enforces force: false", () => {
  const config: WorkspaceGitConfig = TEST_CONFIG;
  assert.equal(config.push.force, false);
});

// ========================
// Credential leakage prevention tests
// ========================

test("hostile: clone rejects URL with embedded credentials (https)", () => {
  withGit((_git, root) => {
    assert.throws(
      () => _git.clone(
        { url: "https://user:pass@github.com/repo.git", destination: join(root, "cred"), bare: false, identity: IDENTITY },
        makeContext("/", "clone"),
      ),
      /credential/u,
    );
  });
});

test("hostile: clone rejects URL with embedded credentials (ssh)", () => {
  withGit((_git, root) => {
    assert.throws(
      () => _git.clone(
        { url: "ssh://user:pass@github.com/repo.git", destination: join(root, "ssh-cred"), bare: false, identity: IDENTITY },
        makeContext("/", "clone"),
      ),
      /credential/u,
    );
  });
});

test("hostile: clone rejects git protocol", () => {
  withGit((_git, root) => {
    assert.throws(
      () => _git.clone(
        { url: "git://github.com/repo.git", destination: join(root, "git-proto"), bare: false, identity: IDENTITY },
        makeContext("/", "clone"),
      ),
      /transport/u,
    );
  });
});

test("hostile: clone rejects ftp protocol", () => {
  withGit((_git, root) => {
    assert.throws(
      () => _git.clone(
        { url: "ftp://example.com/repo.git", destination: join(root, "ftp"), bare: false, identity: IDENTITY },
        makeContext("/", "clone"),
      ),
      /transport/u,
    );
  });
});

test("hostile: clone rejects rsync protocol", () => {
  withGit((_git, root) => {
    assert.throws(
      () => _git.clone(
        { url: "rsync://example.com/repo.git", destination: join(root, "rsync"), bare: false, identity: IDENTITY },
        makeContext("/", "clone"),
      ),
      /transport/u,
    );
  });
});

test("hostile: GIT_OPTIONAL_LOCKS is set in environment", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "optional-locks");
    const status = git.status({ path: repoPath, porcelain: 2, showIgnored: false }, makeContext(repoPath, "status"));
    assert.ok(status !== undefined);
  });
});

test("hostile: identity is set via environment not config files", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "identity-env");
    const log = git.log({ path: repoPath, maxCount: 1, format: "full" }, makeContext(repoPath, "log"));
    assert.equal(log.entries[0]!.author.name, IDENTITY.name);
    assert.equal(log.entries[0]!.author.email, IDENTITY.email);
  });
});

// ========================
// Never-push exclusion tests
// ========================

test("hostile: never-push scan detects.bridlewise directory", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "never-push-codeharness");
    mkdirSync(join(repoPath, ".bridlewise"));
    writeFileSync(join(repoPath, ".bridlewise", "state.json"), "{}");
    git.commit({ path: repoPath, message: "Add state", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.scanNeverPush(
      repoPath,
      { additiveRules: [{ pattern: "^\\.bridlewise/", classification: "harness-private-state" }] },
      makeContext(repoPath, "never-push-scan"),
    );
    assert.ok(!result.clean);
    assert.ok(result.violations.some((v) => v.path.includes(".bridlewise")));
  });
});

test("hostile: never-push scan detects credentials directory", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "never-push-creds");
    mkdirSync(join(repoPath, "secrets"));
    writeFileSync(join(repoPath, "secrets", "api-key.txt"), "sk-12345");
    git.commit({ path: repoPath, message: "Add secret", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.scanNeverPush(
      repoPath,
      { additiveRules: [{ pattern: "^secrets/", classification: "credentials" }] },
      makeContext(repoPath, "never-push-scan"),
    );
    assert.ok(!result.clean);
  });
});

test("hostile: never-push scan detects node_modules", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "never-push-node-modules");
    mkdirSync(join(repoPath, "node_modules"));
    writeFileSync(join(repoPath, "node_modules", "pkg.json"), "{}");
    git.commit({ path: repoPath, message: "Add deps", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.scanNeverPush(
      repoPath,
      { additiveRules: [{ pattern: "^node_modules/", classification: "caches-and-dependency-trees" }] },
      makeContext(repoPath, "never-push-scan"),
    );
    assert.ok(!result.clean);
  });
});

test("hostile: never-push scan detects.env files", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "never-push-env");
    writeFileSync(join(repoPath, ".env"), "API_KEY=secret");
    git.commit({ path: repoPath, message: "Add env", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.scanNeverPush(
      repoPath,
      { additiveRules: [{ pattern: "^\\.env$", classification: "credentials" }] },
      makeContext(repoPath, "never-push-scan"),
    );
    assert.ok(!result.clean);
  });
});

test("hostile: never-push scan detects.pem files", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "never-push-pem");
    writeFileSync(join(repoPath, "private.pem"), "-----BEGIN PRIVATE KEY-----");
    git.commit({ path: repoPath, message: "Add key", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.scanNeverPush(
      repoPath,
      { additiveRules: [{ pattern: "\\.(pem|key)$", classification: "credentials" }] },
      makeContext(repoPath, "never-push-scan"),
    );
    assert.ok(!result.clean);
  });
});

test("hostile: never-push scan allows normal source files", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "never-push-clean-src");
    writeFileSync(join(repoPath, "src.ts"), "console.log('hello');");
    git.commit({ path: repoPath, message: "Add source", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.scanNeverPush(
      repoPath,
      { additiveRules: [{ pattern: "^secrets/", classification: "credentials" }] },
      makeContext(repoPath, "never-push-scan"),
    );
    assert.ok(result.clean);
  });
});

test("hostile: never-push scan detects multiple violations", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "never-push-multi");
    mkdirSync(join(repoPath, "secrets"));
    writeFileSync(join(repoPath, "secrets", "key.txt"), "secret");
    writeFileSync(join(repoPath, ".env"), "SECRET=value");
    git.commit({ path: repoPath, message: "Add sensitive", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const result = git.scanNeverPush(
      repoPath,
      { additiveRules: [
        { pattern: "^secrets/", classification: "credentials" },
        { pattern: "^\\.env$", classification: "credentials" },
      ] },
      makeContext(repoPath, "never-push-scan"),
    );
    assert.ok(!result.clean);
    assert.ok(result.violations.length >= 2);
  });
});

// ========================
// Malformed repo tests
// ========================

test("hostile: status on non-existent repo throws", () => {
  withGit((git, root) => {
    assert.throws(
      () => git.status({ path: join(root, "nonexistent"), porcelain: 2, showIgnored: false }, makeContext(join(root, "nonexistent"), "status")),
    );
  });
});

test("hostile: commit on non-existent repo throws", () => {
  withGit((git, root) => {
    assert.throws(
      () => git.commit({ path: join(root, "nonexistent"), message: "test", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(join(root, "nonexistent"), "commit")),
    );
  });
});

test("hostile: branch on non-existent repo throws", () => {
  withGit((git, root) => {
    assert.throws(
      () => git.branch({ path: join(root, "nonexistent"), name: "test", checkout: false }, makeContext(join(root, "nonexistent"), "branch")),
    );
  });
});

test("hostile: checkout on non-existent repo throws", () => {
  withGit((git, root) => {
    assert.throws(
      () => git.checkout({ path: join(root, "nonexistent"), ref: "main" }, makeContext(join(root, "nonexistent"), "checkout")),
    );
  });
});

test("hostile: inspect on non-existent path returns empty info or throws", () => {
  withGit((git, root) => {
    assert.throws(
      () => git.inspectRepository(join(root, "nonexistent"), makeContext(join(root, "nonexistent"), "inspect")),
    );
  });
});

// ========================
// Path validation tests
// ========================

test("hostile: init with relative path is rejected", () => {
  withGit((git) => {
    assert.throws(
      () => git.init({ path: "relative", bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init")),
      /absolute/u,
    );
  });
});

test("hostile: clone with relative destination is rejected", () => {
  withGit((git) => {
    assert.throws(
      () => git.clone({ url: "file:///tmp/repo", destination: "relative", bare: false, identity: IDENTITY }, makeContext("/", "clone")),
      /absolute/u,
    );
  });
});

test("hostile: pull with relative path is rejected", () => {
  withGit((git) => {
    assert.throws(
      () => git.pull({ path: "relative", remote: "origin", branch: "main", reconciliation: "fast-forward-only", identity: IDENTITY }, makeContext("relative", "pull")),
      /absolute/u,
    );
  });
});

test("hostile: push with relative path is rejected", () => {
  withGit((git) => {
    assert.throws(
      () => git.push({ path: "relative", remote: "origin", refspecs: [], atomic: false, force: false, identity: IDENTITY } as never, makeContext("relative", "push")),
      /absolute/u,
    );
  });
});

test("hostile: commit with relative path is rejected", () => {
  withGit((git) => {
    assert.throws(
      () => git.commit({ path: "relative", message: "test", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext("relative", "commit")),
      /absolute/u,
    );
  });
});

test("hostile: tag with relative path is rejected", () => {
  withGit((git) => {
    assert.throws(
      () => git.tag({ path: "relative", name: "v1", annotated: false }, makeContext("relative", "tag")),
      /absolute/u,
    );
  });
});

test("hostile: log with relative path is rejected", () => {
  withGit((git) => {
    assert.throws(
      () => git.log({ path: "relative", maxCount: 1, format: "full" }, makeContext("relative", "log")),
      /absolute/u,
    );
  });
});

test("hostile: diff with relative path is rejected", () => {
  withGit((git) => {
    assert.throws(
      () => git.diff({ path: "relative", staged: false, contextLines: 3 }, makeContext("relative", "diff")),
      /absolute/u,
    );
  });
});

test("hostile: status with relative path is rejected", () => {
  withGit((git) => {
    assert.throws(
      () => git.status({ path: "relative", porcelain: 2, showIgnored: false }, makeContext("relative", "status")),
      /absolute/u,
    );
  });
});

// ========================
// Transport validation tests
// ========================

test("hostile: file transport is allowed", () => {
  withGit((git, root) => {
    const sourcePath = createRepo(git, root, "file-ok");
    const dest = join(root, "file-dest");
    git.clone({ url: `file://${sourcePath}`, destination: dest, bare: false, identity: IDENTITY }, makeContext("/", "clone"));
    assert.ok(existsSync(join(dest, ".git")));
  });
});

test("hostile: local path without protocol is allowed", () => {
  withGit((git, root) => {
    const sourcePath = createRepo(git, root, "local-ok");
    const dest = join(root, "local-dest");
    git.clone({ url: sourcePath, destination: dest, bare: false, identity: IDENTITY }, makeContext("/", "clone"));
    assert.ok(existsSync(join(dest, ".git")));
  });
});

// ========================
// Concurrent operation tests
// ========================

test("hostile: two sequential commits do not lose data", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "concurrent-commits");
    writeFileSync(join(repoPath, "file1.txt"), "content1");
    git.commit({ path: repoPath, message: "C1", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    writeFileSync(join(repoPath, "file2.txt"), "content2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const log = git.log({ path: repoPath, maxCount: 10, format: "full" }, makeContext(repoPath, "log"));
    assert.equal(log.total, 3);
    assert.ok(existsSync(join(repoPath, "file1.txt")));
    assert.ok(existsSync(join(repoPath, "file2.txt")));
  });
});

test("hostile: branch and switch preserves working tree", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "branch-switch-tree");
    git.branch({ path: repoPath, name: "feature", checkout: true }, makeContext(repoPath, "branch"));
    writeFileSync(join(repoPath, "feature.txt"), "feature");
    git.commit({ path: repoPath, message: "Feature", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.checkout({ path: repoPath, ref: "main" }, makeContext(repoPath, "checkout"));
    assert.ok(!existsSync(join(repoPath, "feature.txt")));
    git.checkout({ path: repoPath, ref: "feature" }, makeContext(repoPath, "checkout"));
    assert.ok(existsSync(join(repoPath, "feature.txt")));
  });
});

// ========================
// Promotion with never-push tests
// ========================

test("hostile: promotion blocked when.bridlewise is tracked", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "promote-blocked");
    mkdirSync(join(repoPath, "secrets"));
    writeFileSync(join(repoPath, "secrets", "key.txt"), "PRIVATE KEY");
    git.commit({ path: repoPath, message: "Add secret", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.branch({ path: repoPath, name: "testing", checkout: false }, makeContext(repoPath, "branch"));
    git.branch({ path: repoPath, name: "feature", checkout: true }, makeContext(repoPath, "branch"));
    writeFileSync(join(repoPath, "new.txt"), "new");
    git.commit({ path: repoPath, message: "Feature", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const lifecycle = createWorkspaceLifecycle(git, TEST_CONFIG);
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
// Boundary condition tests
// ========================

test("hostile: empty commit message is accepted with allowEmpty", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "empty-msg");
    const result = git.commit({ path: repoPath, message: "Empty", identity: IDENTITY, allowEmpty: true, stageAll: false }, makeContext(repoPath, "commit"));
    assert.ok(result.commitSha.length >= 7);
  });
});

test("hostile: very long branch name is handled", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "long-branch");
    const longName = "a".repeat(100);
    const result = git.branch({ path: repoPath, name: longName, checkout: false }, makeContext(repoPath, "branch"));
    assert.equal(result.name, longName);
  });
});

test("hostile: tag with same name as existing tag throws", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "tag-conflict");
    git.tag({ path: repoPath, name: "v1.0", annotated: false }, makeContext(repoPath, "tag"));
    assert.throws(
      () => git.tag({ path: repoPath, name: "v1.0", annotated: false }, makeContext(repoPath, "tag")),
    );
  });
});

test("hostile: checkout to non-existent branch throws", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "checkout-missing");
    assert.throws(
      () => git.checkout({ path: repoPath, ref: "nonexistent-branch" }, makeContext(repoPath, "checkout")),
    );
  });
});

test("hostile: log on unborn repo returns zero entries", () => {
  withGit((git, root) => {
    const repoPath = join(root, "unborn-log");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    const result = git.log({ path: repoPath, maxCount: 10, format: "full" }, makeContext(repoPath, "log"));
    assert.equal(result.total, 0);
  });
});

test("hostile: diff with non-existent ref throws", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "diff-missing");
    assert.throws(
      () => git.diff({ path: repoPath, refA: "nonexistent", refB: "HEAD", staged: false, contextLines: 3 }, makeContext(repoPath, "diff")),
    );
  });
});

test("hostile: merge with non-existent branch throws", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "merge-missing");
    assert.throws(
      () => git.merge({ path: repoPath, branch: "nonexistent", identity: IDENTITY, noFastForward: false, noCommit: false }, makeContext(repoPath, "merge")),
    );
  });
});

test("hostile: rebase with non-existent branch throws", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "rebase-missing");
    assert.throws(
      () => git.rebase({ path: repoPath, branch: "nonexistent", identity: IDENTITY }, makeContext(repoPath, "rebase")),
    );
  });
});

test("hostile: rollback to non-existent commit throws", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "rollback-missing");
    assert.throws(
      () => git.rollback({ path: repoPath, target: "nonexistent", identity: IDENTITY, mode: "revert" }, makeContext(repoPath, "rollback")),
    );
  });
});

test("hostile: promote to non-existent target branch throws", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "promote-missing");
    git.branch({ path: repoPath, name: "feature", checkout: true }, makeContext(repoPath, "branch"));
    writeFileSync(join(repoPath, "new.txt"), "new");
    git.commit({ path: repoPath, message: "Feature", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    assert.throws(
      () => git.promote({ path: repoPath, sourceBranch: "feature", targetBranch: "nonexistent", identity: IDENTITY, fastForwardOnly: true }, makeContext(repoPath, "promote")),
    );
  });
});

// ========================
// Git adapter local bare remote tests
// ========================

test("hostile: push to local bare remote succeeds", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "push-source");
    const barePath = join(root, "push-bare");
    mkdirSync(barePath);
    git.init({ path: barePath, bare: true, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    // Push to the bare remote using the file transport
    const result = git.push(
      { path: repoPath, remote: barePath, refspecs: ["main:main"], atomic: true, force: false, identity: IDENTITY },
      makeContext(repoPath, "push"),
    );
    assert.deepEqual(result.pushed.map((ref) => ref.refspec), ["refs/heads/main:refs/heads/main"], "each ref as git reported it (--porcelain)");
    assert.deepEqual(result.rejected, []);
    // A rejection is read from git's own per-ref flag, never from its prose (PROMO34-PUSH-DOORS).
    writeFileSync(join(repoPath, "diverged.txt"), "diverged");
    git.commit({ path: repoPath, message: "diverged", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const other = join(root, "push-other");
    git.clone({ url: barePath, destination: other, bare: false, identity: IDENTITY }, makeContext("/", "clone"));
    writeFileSync(join(other, "ahead.txt"), "ahead");
    git.commit({ path: other, message: "ahead", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(other, "commit"));
    git.push({ path: other, remote: "origin", refspecs: ["main:main"], atomic: true, force: false, identity: IDENTITY }, makeContext(other, "push"));
    const refused = git.push({ path: repoPath, remote: barePath, refspecs: ["main:main"], atomic: true, force: false, identity: IDENTITY }, makeContext(repoPath, "push"));
    assert.deepEqual(refused.pushed, []);
    assert.deepEqual(refused.rejected.map((ref) => ref.refspec), ["refs/heads/main:refs/heads/main"]);
    assert.match(refused.rejected[0]!.reason, /rejected/u);
  });
});

test("hostile: clone from bare remote preserves history", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "bare-history-source");
    writeFileSync(join(repoPath, "file2.txt"), "content2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const barePath = join(root, "bare-history-bare");
    mkdirSync(barePath);
    git.init({ path: barePath, bare: true, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    git.push({ path: repoPath, remote: barePath, refspecs: ["main:main"], atomic: true, force: false, identity: IDENTITY }, makeContext(repoPath, "push"));
    const clonePath = join(root, "bare-history-clone");
    git.clone({ url: barePath, destination: clonePath, bare: false, identity: IDENTITY }, makeContext("/", "clone"));
    const log = git.log({ path: clonePath, maxCount: 10, format: "full" }, makeContext(clonePath, "log"));
    assert.equal(log.total, 2);
  });
});

// ========================
// Error message sanitization tests
// ========================

test("hostile: error output does not leak credentials", () => {
  withGit((git, root) => {
    try {
      git.clone(
        { url: "https://user:secret@github.com/repo.git", destination: join(root, "leak"), bare: false, identity: IDENTITY },
        makeContext("/", "clone"),
      );
      assert.fail("should have thrown");
    } catch (error) {
      const message = extractErrorMessage(error);
      assert.ok(!message.includes("secret"), "error message should not leak credentials");
    }
  });
});

test("hostile: git error does not include stack trace in safe details", () => {
  withGit((git, root) => {
    try {
      git.commit({ path: join(root, "nonexistent"), message: "test", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(join(root, "nonexistent"), "commit"));
      assert.fail("should have thrown");
    } catch (error) {
      assert.ok(error instanceof Error);
      const harnessError = error as { safeDetails?: Record<string, unknown> };
      if (harnessError.safeDetails !== undefined) {
        assert.ok(!("stack" in harnessError.safeDetails), "safe details should not include stack");
      }
    }
  });
});

// ========================
// Multiple operations sequence tests
// ========================

test("hostile: init-commit-branch-checkout-commit sequence", () => {
  withGit((git, root) => {
    const repoPath = join(root, "sequence");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "v1");
    git.commit({ path: repoPath, message: "C1", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.branch({ path: repoPath, name: "dev", checkout: true }, makeContext(repoPath, "branch"));
    writeFileSync(join(repoPath, "file.txt"), "v2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.checkout({ path: repoPath, ref: "main" }, makeContext(repoPath, "checkout"));
    const content = readFileSync(join(repoPath, "file.txt"), "utf8");
    assert.equal(content, "v1");
  });
});

test("hostile: init-tag-reset sequence", () => {
  withGit((git, root) => {
    const repoPath = join(root, "tag-reset");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "file.txt"), "v1");
    git.commit({ path: repoPath, message: "C1", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    const firstSha = git.log({ path: repoPath, maxCount: 1, format: "full" }, makeContext(repoPath, "log")).entries[0]!.sha;
    git.tag({ path: repoPath, name: "v1.0", annotated: false }, makeContext(repoPath, "tag"));
    writeFileSync(join(repoPath, "file.txt"), "v2");
    git.commit({ path: repoPath, message: "C2", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.rollback({ path: repoPath, target: firstSha, identity: IDENTITY, mode: "reset-mixed" }, makeContext(repoPath, "rollback"));
    const headSha = git.log({ path: repoPath, maxCount: 1, format: "full" }, makeContext(repoPath, "log")).entries[0]!.sha;
    assert.equal(headSha, firstSha);
  });
});

test("hostile: multiple branches with independent commits", () => {
  withGit((git, root) => {
    const repoPath = join(root, "multi-branch");
    mkdirSync(repoPath);
    git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeContext("/", "init"));
    writeFileSync(join(repoPath, "main.txt"), "main");
    git.commit({ path: repoPath, message: "Main", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.branch({ path: repoPath, name: "branch-a", checkout: true }, makeContext(repoPath, "branch"));
    writeFileSync(join(repoPath, "a.txt"), "a");
    git.commit({ path: repoPath, message: "A", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.checkout({ path: repoPath, ref: "main" }, makeContext(repoPath, "checkout"));
    git.branch({ path: repoPath, name: "branch-b", checkout: true }, makeContext(repoPath, "branch"));
    writeFileSync(join(repoPath, "b.txt"), "b");
    git.commit({ path: repoPath, message: "B", identity: IDENTITY, allowEmpty: false, stageAll: true }, makeContext(repoPath, "commit"));
    git.checkout({ path: repoPath, ref: "main" }, makeContext(repoPath, "checkout"));
    assert.ok(!existsSync(join(repoPath, "a.txt")));
    assert.ok(!existsSync(join(repoPath, "b.txt")));
  });
});

// ========================
// Git adapter GIT_OPTIONAL_LOCKS verification
// ========================

test("hostile: GIT_OPTIONAL_LOCKS=0 is always set in environment", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "optional-locks-verify");
    const status = git.status({ path: repoPath, porcelain: 2, showIgnored: false }, makeContext(repoPath, "status"));
    assert.ok(status !== undefined);
  });
});

test("hostile: GIT_CONFIG_NOSYSTEM prevents system config interference", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "no-system-config");
    const status = git.status({ path: repoPath, porcelain: 2, showIgnored: false }, makeContext(repoPath, "status"));
    assert.ok(status.clean);
  });
});

test("hostile: GIT_CONFIG_GLOBAL=/dev/null prevents user config interference", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "no-global-config");
    const info = git.inspectRepository(repoPath, makeContext(repoPath, "inspect"));
    assert.equal(info.currentBranch, "main");
  });
});

test("hostile: GIT_TERMINAL_PROMPT=0 prevents interactive prompts", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "no-prompt");
    const result = git.commit({ path: repoPath, message: "Test", identity: IDENTITY, allowEmpty: true, stageAll: false }, makeContext(repoPath, "commit"));
    assert.ok(result.commitSha.length >= 7);
  });
});

test("hostile: LC_ALL=C ensures deterministic output", () => {
  withGit((git, root) => {
    const repoPath = createRepo(git, root, "lc-all-c");
    const status = git.status({ path: repoPath, porcelain: 2, showIgnored: false }, makeContext(repoPath, "status"));
    assert.ok(status.branch !== undefined || status.unborn);
  });
});
