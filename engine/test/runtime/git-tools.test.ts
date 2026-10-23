import assert from "node:assert/strict";
import test from "node:test";

import { SecurityError } from "../../src/kernel/errors.ts";
import { createGitTools } from "../../src/runtime/git-tools.ts";
import type { GitPort, GitRuntime } from "../../src/git/git-adapter.ts";
import type { GitAdapterOptions } from "../../src/git/git-adapter.ts";
import type { GitEffectRecorder, GitCommitRequest } from "../../src/git/git-port.ts";
import { createPrivacyPolicy } from "../../src/privacy/privacy-policy.ts";
import type { WorkspaceGitConfig } from "../../src/kernel/config-contracts.ts";

// ---------------------------------------------------------------------------
// Git tools: a mock GitPort exercises the tool argument handling and result
// serialization without depending on a real git executable. The real GitPort
// adapter is covered by test/git/git-adapter.test.ts.
// ---------------------------------------------------------------------------

const WORKSPACE_GIT: WorkspaceGitConfig = {
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
  credentials: { providerRefs: [], allowedMethods: ["credential-helper"] },
  neverPush: { additiveRules: [{ pattern: "\\.bridlewise/", classification: "harness-private-state" }] },
  capabilities: {
    objectFormat: "sha1", refStorage: "files", credential: "helper", host: "linux",
    submodule: "none", lfs: "none", signer: "none", filesystem: "posix",
  },
  interaction: { safeRecommendation: true, approvalRequired: true },
};

function makeMockGitPort(): GitPort {
  return {
    schemaVersion: "bridlewise-git-port/v1",
    init: () => ({ gitDir: "", head: "", branch: "main" }),
    clone: () => ({ gitDir: "", head: "", branch: "main", remoteUrl: "" }),
    pull: () => ({ fastForward: false, upToDate: true, merged: false, rebased: false, conflicts: [] }),
    push: () => ({ pushed: [], rejected: [] }),
    commit: () => ({ commitSha: "abc123", treeSha: "tree1", parentShas: [] }),
    branch: () => ({ name: "feature", sha: "sha1", checkedOut: true }),
    tag: () => ({ name: "v1", sha: "sha1", annotated: true }),
    checkout: () => ({ ref: "main", head: "abc123", branch: "main" }),
    merge: () => ({ fastForward: false, merged: false, conflicts: [], commitSha: null }),
    rebase: () => ({ rebased: false, conflicts: [], commitSha: null }),
    status: () => ({ branch: "main", head: "abc123", detached: false, unborn: false, entries: [], clean: true }),
    diff: () => ({ patch: "diff --git a/x b/x", filesChanged: 1, insertions: 2, deletions: 1 }),
    log: () => ({ entries: [{ sha: "abc123", parents: [], author: { name: "Test", email: "t@t" }, authorDate: "2026-01-01T00:00:00Z", committer: { name: "Test", email: "t@t" }, commitDate: "2026-01-01T00:00:00Z", message: "init", treeSha: "tree1" }], total: 1 }),
    inspectRepository: () => ({ path: "/", bare: false, gitDir: "/.git", workTree: "/", head: "abc123", headUnborn: false, headDetached: false, currentBranch: "main", remotes: [], refs: [], objectFormat: "sha1", refStorage: "files" }),
    checkConflicts: () => ({ conflicts: [], hasConflicts: false }),
    scanNeverPush: () => ({ violations: [], clean: true }),
    promote: () => ({ promoted: true, fastForward: true, targetSha: "abc123", sourceSha: "def456" }),
    rollback: () => ({ reverted: true, reset: false, newHead: "abc123", commitSha: "abc123" }),
  } as unknown as GitPort;
}

function makeMockAdapterFactory(port: GitPort): (runtime: GitRuntime, options: GitAdapterOptions) => GitPort {
  return (_runtime, _options) => port;
}

function callTool(tools: ReturnType<typeof createGitTools>, name: string, args: Record<string, unknown> = {}): unknown {
  const tool = tools.find((t) => t.definition.function.name === name);
  assert.ok(tool, `tool ${name} must be registered`);
  return JSON.parse(tool!.handler(args, { repositoryRoot: "/repo" }));
}

test("git-tools: registers exactly five tools", () => {
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makeMockGitPort()),
  });
  const names = tools.map((t) => t.definition.function.name);
  assert.deepEqual(names.toSorted(), ["git_branch", "git_commit", "git_diff", "git_log", "git_status"]);
});

test("git-tools: git_status returns branch and clean flag", () => {
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makeMockGitPort()),
  });
  const result = callTool(tools, "git_status") as { branch: string; clean: boolean };
  assert.equal(result.branch, "main");
  assert.equal(result.clean, true);
});

test("git-tools: git_diff forwards staged and refs", () => {
  const port = makeMockGitPort();
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(port),
  });
  const result = callTool(tools, "git_diff", { staged: true, refA: "HEAD~1", refB: "HEAD", contextLines: 5 }) as { filesChanged: number };
  assert.equal(result.filesChanged, 1);
});

test("git-tools: git_diff rejects when only one ref is provided", () => {
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makeMockGitPort()),
  });
  assert.throws(() => callTool(tools, "git_diff", { refA: "HEAD" }), /refA and refB/);
});

test("git-tools: git_log returns entries bounded by maxCount", () => {
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makeMockGitPort()),
  });
  const result = callTool(tools, "git_log", { maxCount: 10 }) as { total: number; entries: ReadonlyArray<{ sha: string }> };
  assert.equal(result.total, 1);
  assert.equal(result.entries[0]!.sha, "abc123");
});

test("git-tools: git_log rejects maxCount over 100", () => {
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makeMockGitPort()),
  });
  assert.throws(() => callTool(tools, "git_log", { maxCount: 101 }), /maxCount/);
});

test("git-tools: git_branch requires a name", () => {
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makeMockGitPort()),
  });
  assert.throws(() => callTool(tools, "git_branch", {}), /name must be a non-empty string/);
});

test("git-tools: git_branch forwards name and checkout", () => {
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makeMockGitPort()),
  });
  const result = callTool(tools, "git_branch", { name: "feature", checkout: true }) as { name: string; checkedOut: boolean };
  assert.equal(result.name, "feature");
  assert.equal(result.checkedOut, true);
});

test("git-tools: git_commit requires a message", () => {
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makeMockGitPort()),
  });
  assert.throws(() => callTool(tools, "git_commit", {}), /message must be a non-empty string/);
});

test("git-tools: git_commit returns the commit sha", () => {
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makeMockGitPort()),
  });
  const result = callTool(tools, "git_commit", { message: "test commit" }) as { commitSha: string };
  assert.equal(result.commitSha, "abc123");
});

// ---------------------------------------------------------------------------
// MINOR-9: error propagation, timeline recording, never-push safety, redaction
// ---------------------------------------------------------------------------

function makeRecorderCapturingFactory(
  buildPort: (recorder: GitEffectRecorder | undefined) => GitPort,
): (runtime: GitRuntime, options: GitAdapterOptions) => GitPort {
  return (_runtime, options) => buildPort(options.recorder);
}

test("git-tools: a throwing GitPort method propagates the error gracefully", () => {
  const port: GitPort = {
    ...makeMockGitPort(),
    status: () => { throw new Error("git status exploded"); },
  } as unknown as GitPort;
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(port),
  });
  assert.throws(() => callTool(tools, "git_status"), /git status exploded/);
});

test("git-tools: git_commit invokes the timeline recorder", () => {
  let recordCalls = 0;
  const baseRecorder: GitEffectRecorder = {
    recordGitOperation: () => { recordCalls += 1; return { eventId: "e", sequence: "", chainHash: "" }; },
    recordCommit: () => { recordCalls += 1; return { eventId: "e", sequence: "", chainHash: "" }; },
  };
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeRecorderCapturingFactory((recorder) => ({
      ...makeMockGitPort(),
      commit: (req: GitCommitRequest) => {
        recorder?.recordCommit({ commitSha: "abc123", description: `git commit: ${req.message}` });
        return { commitSha: "abc123", treeSha: "tree1", parentShas: [] };
      },
    } as unknown as GitPort)),
    recorder: baseRecorder,
  });
  callTool(tools, "git_commit", { message: "recorded commit" });
  assert.ok(recordCalls >= 1, "the recorder must be invoked for git_commit");
});

test("git-tools: git_commit with stageAll refuses when never-push files are present", () => {
  const port: GitPort = {
    ...makeMockGitPort(),
    scanNeverPush: () => ({
      violations: [{
        pattern: "\\.bridlewise/",
        path: ".bridlewise/secret.key",
        classification: "harness-private-state",
        reason: "matches never-push pattern: \\.bridlewise/",
      }],
      clean: false,
    }),
  } as unknown as GitPort;
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(port),
  });
  assert.throws(
    () => callTool(tools, "git_commit", { message: "leak secrets" }),
    (e: unknown) => e instanceof SecurityError
      && /never-push/.test((e as Error).message)
      && /\.bridlewise\/secret\.key/.test((e as Error).message),
    "stageAll commit with never-push files must throw a SecurityError naming the offending path",
  );
});

test("git-tools: git_commit with stageAll proceeds when never-push scan is clean", () => {
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makeMockGitPort()),
  });
  const result = callTool(tools, "git_commit", { message: "clean commit" }) as { commitSha: string };
  assert.equal(result.commitSha, "abc123");
});

test("git-tools: secret-like commit message is redacted before reaching the timeline recorder", () => {
  const recorded: string[] = [];
  const baseRecorder: GitEffectRecorder = {
    recordGitOperation: (i) => { recorded.push(i.description); return { eventId: "e", sequence: "", chainHash: "" }; },
    recordCommit: (i) => { recorded.push(i.description); return { eventId: "e", sequence: "", chainHash: "" }; },
  };
  const secret = ("gh" + "p_012345678901234567890123456789");
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeRecorderCapturingFactory((recorder) => ({
      ...makeMockGitPort(),
      commit: (req: GitCommitRequest) => {
        recorder?.recordCommit({ commitSha: "abc123", description: `git commit: ${req.message}` });
        return { commitSha: "abc123", treeSha: "tree1", parentShas: [] };
      },
    } as unknown as GitPort)),
    recorder: baseRecorder,
    privacyPolicy: createPrivacyPolicy({}),
  });
  callTool(tools, "git_commit", { message: `fix: rotate token ${secret} in config` });
  assert.equal(recorded.length, 1, "recordCommit must be invoked once");
  assert.ok(!recorded[0]!.includes(secret), `the raw secret must be redacted; got: ${recorded[0]}`);
  assert.ok(recorded[0]!.includes("[REDACTED:token]"), `the redaction replacement must appear; got: ${recorded[0]}`);
});

// ---------------------------------------------------------------------------
// G-1: git_diff bounded output
// ---------------------------------------------------------------------------

function makePortWithPatch(patch: string): GitPort {
  return {
    ...makeMockGitPort(),
    diff: () => {
      let insertions = 0;
      for (const line of patch.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) insertions += 1;
      }
      return { patch, filesChanged: 1, insertions, deletions: 0 };
    },
  } as unknown as GitPort;
}

test("git-tools: git_diff returns the full patch when within maxOutputBytes (G-1)", () => {
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makeMockGitPort()),
  });
  const result = callTool(tools, "git_diff") as { patch: string; truncated?: boolean; filesChanged: number };
  assert.equal(result.patch, "diff --git a/x b/x");
  assert.equal(result.truncated, undefined, "a small diff must not carry truncation metadata");
  assert.equal(result.filesChanged, 1);
});

test("git-tools: git_diff truncates an oversized patch with stats and a per-file summary (G-1)", () => {
  const bigPatch = `diff --git a/big.ts b/big.ts\n+${"x".repeat(4_000)}\n`;
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makePortWithPatch(bigPatch)),
    maxOutputBytes: 1_000,
  });
  const result = callTool(tools, "git_diff") as {
    truncated: boolean; statsOnly: boolean; patch: string; patchBytes: number;
    maxOutputBytes: number; files: ReadonlyArray<{ path: string; insertions: number }>;
    filesChanged: number; message: string;
  };
  assert.equal(result.truncated, true);
  assert.equal(result.statsOnly, false);
  assert.ok(Buffer.byteLength(result.patch, "utf8") <= 1_000, "the truncated patch must fit the byte cap");
  assert.ok(result.patchBytes > 1_000, "patchBytes must report the true size");
  assert.equal(result.maxOutputBytes, 1_000);
  assert.equal(result.filesChanged, 1);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.path, "big.ts");
  assert.equal(result.files[0]!.insertions, 1);
  assert.match(result.message, /diff truncated at 1000 bytes/);
});

test("git-tools: git_diff returns stats only for an extremely large patch (G-1)", () => {
  // > maxOutputBytes * 8 (the stats-only factor) → no patch content at all.
  const hugePatch = `diff --git a/huge.ts b/huge.ts\n${`+${"x".repeat(999)}\n`.repeat(20)}`;
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makePortWithPatch(hugePatch)),
    maxOutputBytes: 1_000,
  });
  const result = callTool(tools, "git_diff") as {
    truncated: boolean; statsOnly: boolean; patch: string | null; message: string;
    files: ReadonlyArray<{ path: string }>;
  };
  assert.equal(result.truncated, true);
  assert.equal(result.statsOnly, true);
  assert.equal(result.patch, null, "stats-only results must omit the patch");
  assert.match(result.message, /stats only/);
  assert.equal(result.files[0]!.path, "huge.ts");
});

test("git-tools: git_diff honors the default cap from the shared tool bounds when maxOutputBytes is absent (G-1)", () => {
  // DEFAULT_TOOL_RESOURCE_BOUNDS.maxOutputBytes is 1 MiB; a patch just over
  // that must truncate even without an explicit option.
  const bigPatch = `diff --git a/big.ts b/big.ts\n+${"x".repeat(1_100_000)}\n`;
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makePortWithPatch(bigPatch)),
  });
  const result = callTool(tools, "git_diff") as { truncated: boolean; statsOnly: boolean; patch: string; maxOutputBytes: number };
  assert.equal(result.truncated, true);
  assert.equal(result.statsOnly, false, "1.1 MB is above the cap but below the stats-only threshold");
  assert.equal(result.maxOutputBytes, 1_048_576);
  assert.ok(Buffer.byteLength(result.patch, "utf8") <= result.maxOutputBytes);
});

test("git-tools: git_diff per-file summary is bounded and counts multiple files (G-1)", () => {
  const twoFilePatch = [
    "diff --git a/one.ts b/one.ts",
    "+added-one",
    "-removed-one",
    "diff --git a/two.ts b/two.ts",
    "+added-two-a",
    "+added-two-b",
    "",
  ].join("\n");
  const tools = createGitTools({
    repositoryRoot: "/repo",
    config: WORKSPACE_GIT,
    gitExecutablePath: "/usr/bin/git",
    adapterFactory: makeMockAdapterFactory(makePortWithPatch(twoFilePatch)),
    maxOutputBytes: 40,
  });
  const result = callTool(tools, "git_diff") as { files: ReadonlyArray<{ path: string; insertions: number; deletions: number }> };
  assert.deepEqual(
    result.files.map((f) => [f.path, f.insertions, f.deletions]),
    [["one.ts", 1, 1], ["two.ts", 2, 0]],
  );
});
