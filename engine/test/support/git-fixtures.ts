import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  createGitAdapter,
  resolveGitExecutable,
  withGitRuntime,
  type GitRuntime,
} from "../../src/git/git-adapter.ts";
import {
  type GitIdentity,
  type GitOperationContext,
  type GitPort,
  type WorkspaceGitConfig,
} from "../../src/git/git-port.ts";
import { deepFreeze } from "../../src/kernel/integrity.ts";
import { createTempDir } from "./temp-dir.ts";
import { TEST_GIT_IDENTITY } from "./test-git-identity.ts";

/**
 * Shared git test fixtures. The single owner of the IDENTITY / TEST_CONFIG /
 * makeContext / withGitAdapter / createRepo block previously copied
 * near-verbatim across `git-adapter.test.ts`, `git-hostile.test.ts`, and
 * `workspace-lifecycle.test.ts` (including one drifted `neverPush` value —
 * inert because `scanNeverPush` receives its rules as an explicit argument).
 *
 * Temporary roots are tracked in a registry and removed by one `test.after`
 * hook so no git test can leak directories.
 */

const TEMPORARY_PATHS = new Set<string>();

test.after(() => {
  for (const path of TEMPORARY_PATHS) rmSync(path, { recursive: true, force: true });
});

export function mkGitTempDir(prefix: string): string {
  const root = createTempDir(`${prefix}-`);
  TEMPORARY_PATHS.add(root);
  return root;
}

/** The one fixture identity (`test-git-identity.ts`, shared with the web suite). */
export const IDENTITY: GitIdentity = TEST_GIT_IDENTITY;

export function makeGitContext(workingDirectory: string, operation: string, timeoutMs = 30000): GitOperationContext {
  return deepFreeze({
    workingDirectory,
    identity: IDENTITY,
    environment: {},
    timeoutMs,
    operation: operation as GitOperationContext["operation"],
    description: `git ${operation} at ${workingDirectory}`,
  });
}

export const TEST_CONFIG: WorkspaceGitConfig = deepFreeze({
  remoteRoles: {
    fetch: { name: "origin", urlIdentity: "file:///dev/null", refspecs: ["+refs/heads/*:refs/remotes/origin/*"] },
  },
  allowedTransports: ["file", "ssh", "https"],
  allowedHosts: [],
  defaultBranch: "main",
  clone: { rejectShallow: true, checkoutPolicy: "checkout", submoduleMode: "none", lfsMode: "none" },
  reconciliation: { mode: "fast-forward-only", unrelatedHistory: "reject" },
  push: { refspecs: ["refs/heads/main:refs/heads/main"], atomic: true, signed: false, force: false, protectedRefs: ["refs/heads/main"] },
  timeouts: { inspectMs: 30000, fetchMs: 60000, pushMs: 60000, verifyMs: 30000, addMs: 30000, commitMs: 30000 },
  retries: { inspectAttempts: 3, fetchAttempts: 3, pushAttempts: 2, verifyAttempts: 3 },
  checkpoint: { namespace: "harness-checkpoint", retention: 100, compensation: "tag" },
  credentials: { providerRefs: [], allowedMethods: ["credential-helper", "ssh-agent"] },
  neverPush: { additiveRules: [{ pattern: "^secrets/", classification: "credentials" }] },
  capabilities: { objectFormat: "sha1", refStorage: "files", credential: "credential-helper", host: "local-bare", submodule: "none", lfs: "none", signer: "none", filesystem: "posix" },
  interaction: { safeRecommendation: true, approvalRequired: true },
});

export function withGitAdapter<T>(operation: (git: GitPort, runtime: GitRuntime, root: string) => T): T {
  const root = mkGitTempDir("git-test");
  const gitPath = resolveGitExecutable();
  return withGitRuntime(gitPath, 268_435_456, (runtime) => {
    const git = createGitAdapter(runtime, { config: TEST_CONFIG });
    return operation(git, runtime, root);
  });
}

export function createRepoWithCommit(
  git: GitPort,
  root: string,
  name: string,
  options?: { readonly readmeContent?: string; readonly commitMessage?: string },
): string {
  const repoPath = join(root, name);
  mkdirSync(repoPath);
  git.init({ path: repoPath, bare: false, initialBranch: "main", identity: IDENTITY }, makeGitContext("/", "init"));
  writeFileSync(join(repoPath, "README.md"), options?.readmeContent ?? "# Test");
  git.commit(
    { path: repoPath, message: options?.commitMessage ?? "Init", identity: IDENTITY, allowEmpty: false, stageAll: true },
    makeGitContext(repoPath, "commit"),
  );
  return repoPath;
}
