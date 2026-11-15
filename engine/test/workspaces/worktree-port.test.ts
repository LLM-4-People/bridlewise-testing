import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveGitExecutable } from "../../src/git/git-adapter.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { deepFreeze } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { isPathWithinWriteSet } from "../../src/workflow/workspace-contracts.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { createRepoWithCommit, IDENTITY, makeGitContext, TEST_CONFIG, withGitAdapter } from "../support/git-fixtures.ts";
import { pinnedPathIdentity } from "../../src/filesystem/pinned-path-internal.ts";
import {
  assertAgentBranchName,
  assertGitSha,
  createWorktreeGitPort,
  createPinnedWorktreeGitExec,
  withGitRuntime,
  parseStatusV2,
  parseWorktreeListPorcelain,
  WorktreeGitError,
  WorktreeGitTimeout,
  WORKTREE_PORT_SCHEMA_VERSION,
  type WorktreeGitExecRequest,
  type WorktreeGitExecResult,
} from "../../src/git/worktree-port.ts";

/** Matches a HarnessError by its typed code. */
function throwsCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error && (error as { code?: unknown }).code === code;
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function makeExec(
  handler: (request: WorktreeGitExecRequest) => WorktreeGitExecResult,
  captured?: WorktreeGitExecRequest[],
) {
  return (request: WorktreeGitExecRequest): WorktreeGitExecResult => {
    captured?.push(request);
    return handler(request);
  };
}

function ok(stdout = ""): WorktreeGitExecResult {
  return deepFreeze({ status: 0, signal: null, timedOut: false, stdout, stderr: "" });
}

// ---------------------------------------------------------------------------
// schema + validation helpers
// ---------------------------------------------------------------------------

test("WORKTREE_PORT_SCHEMA_VERSION is stable", () => {
  assert.equal(WORKTREE_PORT_SCHEMA_VERSION, "bridlewise-worktree-port/v2");
});

test("assertGitSha accepts 40- and 64-hex SHAs", () => {
  assert.doesNotThrow(() => assertGitSha(SHA_A, "ref"));
  assert.doesNotThrow(() => assertGitSha("d".repeat(64), "ref"));
});

test("assertGitSha rejects short, long, and non-hex values", () => {
  for (const value of ["", "abc123", "g".repeat(40), "a".repeat(39), "a".repeat(41), "a".repeat(63)]) {
    assert.throws(() => assertGitSha(value, "ref"), InputError);
  }
});

test("assertAgentBranchName accepts names inside the namespace", () => {
  assert.doesNotThrow(() => assertAgentBranchName("agent/worker/abc123", "agent/"));
});

test("assertAgentBranchName refuses branches outside the namespace", () => {
  assert.throws(() => assertAgentBranchName("feature/x", "agent/"), throwsCode("worktree_branch_namespace_denied"));
  assert.throws(() => assertAgentBranchName("agent/", "agent/"), throwsCode("worktree_branch_namespace_denied"));
  assert.throws(() => assertAgentBranchName("main", "agent/"), throwsCode("worktree_branch_namespace_denied"));
});

test("assertAgentBranchName refuses malformed names", () => {
  for (const branch of ["agent//x", "agent/a..b", "agent/a@{b}", "agent/x/", "agent/x.lock", "agent/-x"]) {
    assert.throws(() => assertAgentBranchName(branch, "agent/"), throwsCode("worktree_branch_invalid"));
  }
});

// ---------------------------------------------------------------------------
// argument construction (fake exec capture)
// ---------------------------------------------------------------------------

test("worktreeAdd constructs the pinned argument vector", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const port = createWorktreeGitPort({ exec: makeExec(() => ok(), captured) });
  port.worktreeAdd({
    repoRoot: "/repo",
    worktreePath: "/wt/a",
    branch: "agent/worker/abc123def456",
    baseSha: SHA_A,
    timeoutMs: 1234,
  });
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]!.args, [
    "-c", "gc.auto=0", "-C", "/repo",
    "worktree", "add", "-b", "agent/worker/abc123def456", "--", "/wt/a", SHA_A,
  ]);
  assert.equal(captured[0]!.cwd, "/repo");
  assert.equal(captured[0]!.timeoutMs, 1234);
});

test("checkout identity preserves common config no-ops and native refusal semantics", () => {
  withGitAdapter((git, runtime, root) => {
    const port = createWorktreeGitPort({ runtime });
    const exec = createPinnedWorktreeGitExec(runtime);
    const timeoutMs = TEST_CONFIG.timeouts.inspectMs;
    const config = (cwd: string, args: readonly string[]): string => {
      const result = exec({ args: ["-c", "gc.auto=0", "-C", cwd, "config", ...args], cwd, timeoutMs, allowedExitCodes: [0] });
      assert.equal(result.status, 0, "the owned native config fixture must succeed");
      return result.stdout;
    };
    const identity = { name: "Target Fixture Contributor", email: "target-fixture@example.invalid" };
    const markerKey = "fixture.agentCheckout";
    const variants: readonly Readonly<{ name: string; value?: string; bare?: boolean; shadow?: boolean; duplicate?: boolean; refusal?: number }>[] = [
      { name: "true", value: "true" }, { name: "on", value: "on" }, { name: "one", value: "1" },
      { name: "YES", value: "YES" }, { name: "bare", bare: true },
      { name: "source-worktree-shadow", value: "true", shadow: true },
      { name: "false", value: "false" }, { name: "absent" },
      { name: "invalid", value: "not-a-boolean", refusal: 128 },
      { name: "duplicate", value: "true", duplicate: true, refusal: 5 },
    ];
    for (const variant of variants) {
      const repoRoot = createRepoWithCommit(git, root, variant.name);
      config(repoRoot, ["--local", "user.name", IDENTITY.name]);
      config(repoRoot, ["--local", "user.email", IDENTITY.email]);
      const worktreePath = join(root, `${variant.name}-target`);
      port.worktreeAddDetached({ repoRoot, worktreePath, commitSha: port.revParse(repoRoot, "HEAD", timeoutMs), timeoutMs });
      const commonConfig = join(port.commonDir(repoRoot, timeoutMs), "config");
      const sourceUser = [config(repoRoot, ["--local", "--get", "user.name"]), config(repoRoot, ["--local", "--get", "user.email"])];
      if (variant.value !== undefined) config(repoRoot, ["--local", "extensions.worktreeConfig", variant.value]);
      if (variant.bare) writeFileSync(commonConfig, "\n[extensions]\n\tworktreeConfig\n", { flag: "a" });
      if (variant.duplicate) config(repoRoot, ["--local", "--add", "extensions.worktreeConfig", "true"]);
      if (variant.shadow) config(repoRoot, ["--worktree", "extensions.worktreeConfig", "false"]);
      const beforeBytes = readFileSync(commonConfig);
      const beforeIdentity = pinnedPathIdentity(lstatSync(commonConfig, { bigint: true }));
      const declare = (): void => port.agentCheckoutIdentity({ repoRoot, worktreePath, identity, markerKey, timeoutMs });
      if (variant.refusal !== undefined) {
        assert.throws(declare, (error: unknown) => error instanceof WorktreeGitError && error.code === "worktree_git_failed" && error.safeDetails["exitCode"] === variant.refusal);
        assert.deepEqual(readFileSync(commonConfig), beforeBytes, `${variant.name}: refusal changed common bytes`);
        assert.deepEqual(pinnedPathIdentity(lstatSync(commonConfig, { bigint: true })), beforeIdentity, `${variant.name}: refusal changed common identity`);
        continue;
      }
      declare();
      if (variant.name === "false" || variant.name === "absent") {
        assert.equal(config(repoRoot, ["--local", "--type=bool", "--get", "extensions.worktreeConfig"]).trim(), "true");
      } else {
        assert.deepEqual(readFileSync(commonConfig), beforeBytes, `${variant.name}: true common boolean must preserve its raw bytes`);
        assert.deepEqual(pinnedPathIdentity(lstatSync(commonConfig, { bigint: true })), beforeIdentity, `${variant.name}: true common boolean must preserve physical identity`);
      }
      const enabledBytes = readFileSync(commonConfig);
      const enabledIdentity = pinnedPathIdentity(lstatSync(commonConfig, { bigint: true }));
      declare();
      assert.deepEqual(readFileSync(commonConfig), enabledBytes, `${variant.name}: repeated declaration changed common bytes`);
      assert.deepEqual(pinnedPathIdentity(lstatSync(commonConfig, { bigint: true })), enabledIdentity, `${variant.name}: repeated declaration rewrote common config`);
      assert.deepEqual([config(repoRoot, ["--local", "--get", "user.name"]), config(repoRoot, ["--local", "--get", "user.email"])], sourceUser);
      assert.equal(config(worktreePath, ["--worktree", "--get", "user.name"]).trim(), identity.name);
      assert.equal(config(worktreePath, ["--worktree", "--get", "user.email"]).trim(), identity.email);
      assert.equal(config(worktreePath, ["--worktree", "--type=bool", "--get", markerKey]).trim(), "true");
      if (variant.shadow) {
        assert.equal(config(repoRoot, ["--type=bool", "--get", "extensions.worktreeConfig"]).trim(), "false");
        assert.equal(config(repoRoot, ["--local", "--type=bool", "--get", "extensions.worktreeConfig"]).trim(), "true");
      }
    }
  });
});

test("worktreeAdd refuses branches outside the agent namespace", () => {
  const port = createWorktreeGitPort({ exec: makeExec(() => ok()) });
  assert.throws(
    () => port.worktreeAdd({ repoRoot: "/repo", worktreePath: "/wt/a", branch: "feature/x", baseSha: SHA_A, timeoutMs: 1 }), throwsCode("worktree_branch_namespace_denied"),
  );
});

test("worktreeAdd refuses non-absolute paths", () => {
  const port = createWorktreeGitPort({ exec: makeExec(() => ok()) });
  assert.throws(
    () => port.worktreeAdd({ repoRoot: "relative", worktreePath: "/wt/a", branch: "agent/w/x1", baseSha: SHA_A, timeoutMs: 1 }), throwsCode("worktree_path_invalid"),
  );
});

test("worktreeRemove adds --force only when requested", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const port = createWorktreeGitPort({ exec: makeExec(() => ok(), captured) });
  port.worktreeRemove({ repoRoot: "/repo", worktreePath: "/wt/a", force: true, timeoutMs: 5 });
  port.worktreeRemove({ repoRoot: "/repo", worktreePath: "/wt/a", force: false, timeoutMs: 5 });
  assert.ok(captured[0]!.args.includes("--force"));
  assert.ok(!captured[1]!.args.includes("--force"));
});

test("worktreeLock passes --reason", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const port = createWorktreeGitPort({ exec: makeExec(() => ok(), captured) });
  port.worktreeLock({ repoRoot: "/repo", worktreePath: "/wt/a", reason: "quarantine", timeoutMs: 5 });
  assert.deepEqual(captured[0]!.args, ["-c", "gc.auto=0", "-C", "/repo", "worktree", "lock", "--reason", "quarantine", "--", "/wt/a"]);
});

test("diffNameOnly uses three-dot range when requested", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const port = createWorktreeGitPort({ exec: makeExec(() => ok("src/a.ts\0src/b.ts\0"), captured) });
  const paths = port.diffNameOnly({ cwd: "/wt", refA: SHA_A, refB: SHA_B, threeDot: true, timeoutMs: 5 });
  assert.deepEqual(paths, ["src/a.ts", "src/b.ts"]);
  assert.ok(captured[0]!.args.includes(`${SHA_A}...${SHA_B}`));
});

test("diffNameOnly asks git for NUL-delimited paths: a non-ASCII path is returned unquoted and leases through the write-set gate", () => {
  const captured: WorktreeGitExecRequest[] = [];
  // The 16 error-context paths the round's validate refused carried `—`/`§`:
  // without `-z` git C-quotes them, and a string that begins with `"` can
  // never be leased by a write-set entry (commit-chain-stop-at-validate.md §4B).
  const evidencePath = "docs/findings/recovery/evidence/fix06-runtime/qualification/playwright/error-contexts/cockpit-e2e-sweep-airspace-69149-each-a-beat-—-1500px-carbon-chromium.md";
  const port = createWorktreeGitPort({ exec: makeExec(() => ok(`${evidencePath}\0src/plain.ts\0`), captured) });
  const paths = port.diffNameOnly({ cwd: "/wt", refA: SHA_A, refB: SHA_B, threeDot: false, timeoutMs: 5 });
  assert.deepEqual(captured[0]!.args, ["-c", "gc.auto=0", "-C", "/wt", "diff", "--name-only", "-z", `${SHA_A}..${SHA_B}`]);
  assert.deepEqual(paths, [evidencePath, "src/plain.ts"]);
  assert.ok(isPathWithinWriteSet(paths[0]!, ["docs/findings/recovery"]), "the non-ASCII path matches its leased write-set entry");
});

test("diffNameOnly on a real repository: the changed path with `—`/`§` arrives unquoted and inside the leased write set", () => {
  withGitRuntime(resolveGitExecutable(), 268435456, (runtime) => {
    const exec = createPinnedWorktreeGitExec(runtime);
    const port = createWorktreeGitPort({ runtime });
    const root = createTempDir("worktree-port-nonascii-");
    const run = (args: readonly string[]): void => {
      const result = exec({
        args: ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
        cwd: root,
        timeoutMs: 30_000,
        allowedExitCodes: [0],
      });
      if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${result.stderr}`);
    };
    run(["init", "-q", "-b", "main", "."]);
    run(["commit", "--allow-empty", "-q", "-m", "base"]);
    const baseSha = port.revParse(root, "HEAD", 30_000);
    const evidencePath = "docs/findings/recovery/error-contexts/cockpit-e2e-sweep-airspace-69149-each-a-beat-—-1500px-carbon-chromium.md";
    const absolute = join(root, evidencePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "# the refused class: — and § in a changed path\n");
    run(["add", "--", evidencePath]);
    run(["commit", "-q", "-m", "evidence"]);
    const head = port.revParse(root, "HEAD", 30_000);
    const paths = port.diffNameOnly({ cwd: root, refA: baseSha, refB: head, threeDot: false, timeoutMs: 30_000 });
    assert.ok(!paths[0]!.startsWith("\""), `the path is never C-quoted: ${paths[0]}`);
    assert.deepEqual(paths, [evidencePath]);
    assert.ok(isPathWithinWriteSet(paths[0]!, ["docs/findings/recovery"]), "the write-set proof leases it");
  });
});

test("deleteBranch refuses branches outside the namespace", () => {
  const port = createWorktreeGitPort({ exec: makeExec(() => ok()) });
  assert.throws(() => port.deleteBranch("/repo", "main", true, 5), throwsCode("worktree_branch_namespace_denied"));
});

// ---------------------------------------------------------------------------
// porcelain parsing
// ---------------------------------------------------------------------------

test("parseWorktreeListPorcelain parses entries with flags", () => {
  const text = [
    `worktree /repo`,
    `HEAD ${SHA_A}`,
    `branch refs/heads/main`,
    ``,
    `worktree /wt/agent-a`,
    `HEAD ${SHA_B}`,
    `branch refs/heads/agent/worker/x`,
    `locked quarantined`,
    ``,
    `worktree /wt/detached`,
    `HEAD ${SHA_C}`,
    `detached`,
    `prunable gitdir file points to non-existent location`,
    ``,
  ].join("\n");
  const entries = parseWorktreeListPorcelain(text);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { path: "/repo", head: SHA_A, branch: "refs/heads/main", detached: false, bare: false, locked: false, prunable: false });
  assert.equal(entries[1]!.locked, true);
  assert.equal(entries[2]!.detached, true);
  assert.equal(entries[2]!.prunable, true);
  assert.equal(entries[2]!.branch, null);
});

test("parseWorktreeListPorcelain rejects malformed input", () => {
  assert.throws(() => parseWorktreeListPorcelain("HEAD abc\n"), throwsCode("worktree_list_parse_failed"));
  assert.throws(() => parseWorktreeListPorcelain("worktree /x\n"), throwsCode("worktree_list_parse_failed"));
});

// ---------------------------------------------------------------------------
// timeout + error handling
// ---------------------------------------------------------------------------

test("a timed-out exec raises WorktreeGitTimeout", () => {
  const port = createWorktreeGitPort({
    exec: makeExec(() => deepFreeze({ status: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" })),
  });
  assert.throws(
    () => port.revParse("/repo", "HEAD", 1),
    (error: unknown) => error instanceof WorktreeGitTimeout && error.code === "worktree_git_timeout",
  );
});

test("a disallowed exit status raises WorktreeGitError with sanitized stderr", () => {
  const port = createWorktreeGitPort({
    exec: makeExec(() => deepFreeze({
      status: 128,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "fatal: unable to read https://user:hunter2@example.com/repo.git",
    })),
  });
  try {
    port.revParse("/repo", "HEAD", 5);
    assert.fail("expected WorktreeGitError");
  } catch (error) {
    assert.ok(error instanceof WorktreeGitError);
    const stderr = String((error as WorktreeGitError).safeDetails.stderr);
    assert.ok(!stderr.includes("hunter2"), `credentials leaked into error: ${stderr}`);
  }
});

test("NUL bytes in arguments are rejected before exec", () => {
  let calls = 0;
  const port = createWorktreeGitPort({ exec: makeExec(() => { calls += 1; return ok(); }) });
  assert.throws(
    () => port.worktreeRemove({ repoRoot: "/repo", worktreePath: "/wt/\0x", force: false, timeoutMs: 1 }),
    InputError,
  );
  assert.equal(calls, 0);
});

test("revListCount parses a non-negative integer", () => {
  const port = createWorktreeGitPort({ exec: makeExec(() => ok("7\n")) });
  assert.equal(port.revListCount("/repo", SHA_A, SHA_B, 5), 7);
});

test("revListCount rejects malformed output", () => {
  const port = createWorktreeGitPort({ exec: makeExec(() => ok("many\n")) });
  assert.throws(() => port.revListCount("/repo", SHA_A, SHA_B, 5), throwsCode("worktree_rev_list_parse_failed"));
});

test("verifyWorktreeIntact returns false when the gitdir probe fails", () => {
  const port = createWorktreeGitPort({
    exec: makeExec(() => deepFreeze({ status: 128, signal: null, timedOut: false, stdout: "", stderr: "not a git repository" })),
  });
  assert.equal(port.verifyWorktreeIntact("/definitely/not/a/worktree", 5), false);
});

test("the port requires an exec or a runtime", () => {
  assert.throws(() => createWorktreeGitPort({}), throwsCode("worktree_exec_missing"));
});

test("the port requires the namespace to end with a slash", () => {
  assert.throws(() => createWorktreeGitPort({ exec: makeExec(() => ok()), branchNamespace: "agent" }), throwsCode("worktree_namespace_invalid"));
});


test("native pinned timeout maps to worktree timeout while an ordinary signal stays an execution error", () => {
  withGitRuntime(process.execPath, 268435456, (runtime) => {
    const pinned = createPinnedWorktreeGitExec(runtime);
    const request = { cwd: process.cwd(), allowedExitCodes: [0], timeoutMs: 1000,
      args: ["-e", 'process.kill(process.pid,"SIGTERM")'] };
    const signalled = pinned(request);
    assert.equal(signalled.status, null); assert.equal(signalled.signal, "SIGTERM"); assert.equal(signalled.timedOut, false);
    const signalledPort = createWorktreeGitPort({ exec: () => signalled });
    assert.throws(() => signalledPort.status(process.cwd(), 1000), (error: unknown) => error instanceof WorktreeGitError && !(error instanceof WorktreeGitTimeout));
    const timeoutPort = createWorktreeGitPort({ exec: () => pinned({ ...request, timeoutMs: 100, args: ["-e", "setTimeout(()=>{},3000)"] }) });
    assert.throws(() => timeoutPort.status(process.cwd(), 100), (error: unknown) => error instanceof WorktreeGitTimeout && error.code === "worktree_git_timeout");
  });
});

// ---------------------------------------------------------------------------
// the integrator's operations: argument vectors, refusals as data, hostile input
// ---------------------------------------------------------------------------

function refused(stderr: string, status = 1): WorktreeGitExecResult {
  return deepFreeze({ status, signal: null, timedOut: false, stdout: "", stderr });
}

test("the land operations: ff-only and a compare-and-swap update-ref, whose refusals are data, never exceptions", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const answers = [ok(), refused("fatal: Not possible to fast-forward, aborting.", 128), ok(), refused("fatal: cannot lock ref 'refs/heads/side': is at x but expected y", 128)];
  const port = createWorktreeGitPort({ exec: makeExec(() => answers.shift()!, captured) });
  assert.deepEqual(port.mergeFfOnly("/canonical", SHA_A, 5), { refusal: null });
  assert.match(port.mergeFfOnly("/canonical", SHA_A, 5).refusal ?? "", /Not possible to fast-forward/u);
  assert.deepEqual(port.updateRef("/repo", "refs/heads/side", SHA_B, SHA_A, 5), { refusal: null });
  assert.match(port.updateRef("/repo", "refs/heads/side", SHA_B, SHA_A, 5).refusal ?? "", /cannot lock ref/u);
  assert.deepEqual(captured[0]!.args, ["-c", "gc.auto=0", "-C", "/canonical", "merge", "-q", "--ff-only", "--no-autostash", SHA_A]);
  assert.deepEqual(captured[2]!.args, ["-c", "gc.auto=0", "-C", "/repo", "update-ref", "refs/heads/side", SHA_B, SHA_A], "the old value makes it a compare-and-swap");
  assert.deepEqual(captured[0]!.allowedExitCodes, [0, 1, 128]);
});

test("update-ref moves branches only, never HEAD or another namespace, and takes full SHAs", () => {
  const port = createWorktreeGitPort({ exec: makeExec(() => ok()) });
  for (const ref of ["HEAD", "refs/tags/v1", "refs/bridlewise/snapshots/x", "-d"]) {
    assert.throws(() => port.updateRef("/repo", ref, SHA_B, SHA_A, 5), InputError, ref);
  }
  assert.throws(() => port.updateRef("/repo", "refs/heads/x", "HEAD", SHA_A, 5), throwsCode("worktree_git_sha_invalid"));
});

test("the in-workspace merge: --no-ff --no-commit on an agent branch, conflicts read from the unmerged entries", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const answers = [refused("CONFLICT (content): Merge conflict in engine/src/kernel/root-policy.ts"), ok("engine/src/kernel/root-policy.ts\0src/b.ts\0")];
  const port = createWorktreeGitPort({ exec: makeExec(() => answers.shift()!, captured) });
  const merged = port.mergeNoCommit({ cwd: "/wt", branch: "agent/w/n1", message: "merge: workspace w-n1 (w)", timeoutMs: 5 });
  assert.deepEqual(merged, { clean: false, conflictPaths: ["engine/src/kernel/root-policy.ts", "src/b.ts"] });
  assert.deepEqual(captured[0]!.args, ["-c", "gc.auto=0", "-C", "/wt", "merge", "--no-ff", "--no-commit", "--no-autostash", "-m", "merge: workspace w-n1 (w)", "--", "agent/w/n1"]);
  assert.deepEqual(captured[1]!.args, ["-c", "gc.auto=0", "-C", "/wt", "diff", "--name-only", "--diff-filter=U", "-z"]);
  assert.throws(() => port.mergeNoCommit({ cwd: "/wt", branch: "main", message: "m", timeoutMs: 5 }), throwsCode("worktree_branch_namespace_denied"));
  const stopped = createWorktreeGitPort({ exec: makeExec((request) => request.args.includes("--diff-filter=U") ? ok("") : refused("error: something else")) });
  assert.throws(() => stopped.mergeNoCommit({ cwd: "/wt", branch: "agent/w/n1", message: "m", timeoutMs: 5 }), throwsCode("worktree_git_failed"), "a stop with no conflicted path is an error, not a clean merge");
});

test("blobAt answers null for a path the commit's tree does not have; resolveToOurs checks out and stages exactly the paths", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const answers = [ok("text at the commit\n"), refused("fatal: path 'x' does not exist in 'aaaa'", 128), ok(), ok()];
  const port = createWorktreeGitPort({ exec: makeExec(() => answers.shift()!, captured) });
  assert.equal(port.blobAt("/wt", SHA_A, "x", 5), "text at the commit\n");
  assert.equal(port.blobAt("/wt", SHA_A, "x", 5), null);
  assert.throws(() => port.blobAt("/wt", "HEAD", "x", 5), InputError, "only a commit id, never a revision expression");
  port.resolveToOurs("/wt", ["a", "b"], 5);
  assert.deepEqual(captured[0]!.args, ["-c", "gc.auto=0", "-C", "/wt", "cat-file", "blob", `${SHA_A}:x`]);
  assert.deepEqual(captured[2]!.args, ["-c", "gc.auto=0", "-C", "/wt", "checkout", "--ours", "--", "a", "b"]);
  assert.deepEqual(captured[3]!.args, ["-c", "gc.auto=0", "-C", "/wt", "add", "--", "a", "b"]);
  assert.throws(() => port.resolveToOurs("/wt", ["a\nb"], 5), InputError, "a path carrying a newline is refused");
});

test("a commit runs the hooks with a projected environment; every other operation runs without one", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const port = createWorktreeGitPort({ exec: makeExec(() => ok(`${SHA_A}\n`), captured) });
  assert.deepEqual(port.commit({ cwd: "/wt", message: "merge: workspace w (w)", timeoutMs: 5 }), { commit: SHA_A, output: `${SHA_A}` }, "the commit and what it printed");
  assert.equal(captured[0]!.hooks, true);
  assert.deepEqual(captured[0]!.args, ["-c", "gc.auto=0", "-C", "/wt", "commit", "-q", "--signoff", "-m", "merge: workspace w (w)"]);
  assert.equal(captured[1]!.hooks, undefined, "the rev-parse after it runs no hook");
  assert.throws(() => port.commit({ cwd: "/wt", message: "a\0b", timeoutMs: 5 }), InputError);
});

test("the hook environment is a projection: the child finds its programs and temp folder, never this process's secrets", () => {
  const planted = "HOOK_PROJECTION_PROBE_SECRET";
  const previous = process.env[planted];
  process.env[planted] = "must-not-reach-a-hook";
  try {
    withGitRuntime(process.execPath, 268435456, (runtime) => {
      const pinned = createPinnedWorktreeGitExec(runtime);
      const probe = ["-e", "process.stdout.write(JSON.stringify(process.env))"];
      const hooked = JSON.parse(pinned({ cwd: process.cwd(), allowedExitCodes: [0], timeoutMs: 10_000, args: probe, hooks: true }).stdout) as Record<string, string>;
      const plain = JSON.parse(pinned({ cwd: process.cwd(), allowedExitCodes: [0], timeoutMs: 10_000, args: probe }).stdout) as Record<string, string>;
      assert.equal(hooked["PATH"], process.env["PATH"], "a hook finds node and npm");
      assert.equal(hooked["HOME"], process.env["HOME"]);
      if (process.env["TMPDIR"] !== undefined) assert.equal(hooked["TMPDIR"], process.env["TMPDIR"], "a test run's private temp folder reaches the hook");
      assert.equal(hooked[planted], undefined, "an unlisted variable never reaches a hook");
      assert.equal(hooked["GIT_CONFIG_GLOBAL"], "/dev/null", "the pinned git's own isolation stays");
      assert.equal(plain["PATH"], undefined, "an operation that runs no hook gets no PATH");
    });
  } finally {
    if (previous === undefined) delete process.env[planted];
    else process.env[planted] = previous;
  }
});

test("repository questions: the common dir, the top level and the checked-out branch (null when detached)", () => {
  const answers = [ok("/home/u/repo/.git\n"), ok("/home/u/repo-testing\n"), ok("testing\n"), refused("")];
  const port = createWorktreeGitPort({ exec: makeExec(() => answers.shift()!) });
  assert.equal(port.commonDir("/home/u/repo-testing/engine", 5), "/home/u/repo/.git");
  assert.equal(port.toplevel("/home/u/repo-testing/engine", 5), "/home/u/repo-testing");
  assert.equal(port.symbolicBranch("/home/u/repo-testing", 5), "testing");
  assert.equal(port.symbolicBranch("/home/u/detached", 5), null);
  assert.throws(() => port.commonDir("relative/path", 5), throwsCode("worktree_path_invalid"));
});

test("deletedBlobs reads the raw deletions between two trees (renames off)", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const raw = `:100644 000000 ${SHA_C} ${"0".repeat(40)} D\0gone.txt\0:100755 000000 ${SHA_B} ${"0".repeat(40)} D\0bin/x\0`;
  const port = createWorktreeGitPort({ exec: makeExec(() => ok(raw), captured) });
  assert.deepEqual(port.deletedBlobs("/repo", SHA_A, SHA_B, 5), [{ path: "gone.txt", blob: SHA_C }, { path: "bin/x", blob: SHA_B }]);
  assert.deepEqual(captured[0]!.args, ["-c", "gc.auto=0", "-C", "/repo", "diff-tree", "-r", "--raw", "--no-abbrev", "--no-renames", "--diff-filter=D", "-z", SHA_A, SHA_B]);
});

test("worktreeAddDetached, checkoutDetached and the checkout back to a branch take validated inputs", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const port = createWorktreeGitPort({ exec: makeExec(() => ok(), captured) });
  port.worktreeAddDetached({ repoRoot: "/repo", worktreePath: "/wt/v", commitSha: SHA_A, timeoutMs: 5 });
  port.checkoutDetached("/wt/a", SHA_B, 5);
  port.checkoutBranch("/wt/a", "agent/w/n", 5, true);
  assert.deepEqual(captured.map((request) => request.args.slice(4)), [
    ["worktree", "add", "--detach", "--", "/wt/v", SHA_A],
    ["checkout", "-q", "--detach", SHA_B],
    ["checkout", "-q", "-f", "agent/w/n", "--"],
  ]);
  assert.throws(() => port.checkoutBranch("/wt/a", "main", 5), throwsCode("worktree_branch_namespace_denied"));
  assert.throws(() => port.checkoutDetached("/wt/a", "HEAD~1", 5), throwsCode("worktree_git_sha_invalid"));
});

test("the promotion's candidate operations: merge -s ours of a commit, read-tree --reset, stage-all answering the tree, missing objects", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const answers = [ok(), ok(), ok(), ok(`${SHA_C}\n`), ok(`${SHA_A}\n?${SHA_B}\n${SHA_C} path\n`)];
  const port = createWorktreeGitPort({ exec: makeExec(() => answers.shift()!, captured) });
  const identity = { name: "Source Committer", email: "s@example.invalid", date: "2026-10-01T00:00:00-04:00" };
  port.mergeOursNoCommit({ cwd: "/cand", commit: SHA_A, message: "promote(p): dev@aaaaaaaa", identity, timeoutMs: 5 });
  port.readTreeReset("/cand", SHA_B, 5);
  assert.equal(port.stageAll("/cand", 5), SHA_C);
  assert.deepEqual(port.missingObjects("/cand", SHA_A, SHA_C, 5), [SHA_B]);
  assert.deepEqual(captured.map((request) => request.args.slice(4)), [
    ["merge", "-q", "-s", "ours", "--no-ff", "--no-commit", "--no-autostash", "-m", "promote(p): dev@aaaaaaaa", SHA_A],
    ["read-tree", "-u", "--reset", SHA_B],
    ["add", "-A"],
    ["write-tree"],
    ["rev-list", "--objects", "--missing=print", SHA_A, `^${SHA_C}`],
  ]);
  assert.deepEqual(captured[0]!.identity, identity, "the merge carries the dated identity");
  assert.throws(() => port.mergeOursNoCommit({ cwd: "/cand", commit: "testing", message: "m", timeoutMs: 5 }), throwsCode("worktree_git_sha_invalid"), "a commit id, never a branch expression");
  assert.throws(() => port.readTreeReset("/cand", "HEAD", 5), throwsCode("worktree_git_sha_invalid"));
});

test("a dated identity sets both dates; the pinned exec projects it into git's environment", () => {
  withGitRuntime(process.execPath, 268435456, (runtime) => {
    const exec = createPinnedWorktreeGitExec(runtime);
    const result = exec({
      args: ["-e", "process.stdout.write([process.env.GIT_AUTHOR_DATE, process.env.GIT_COMMITTER_DATE, process.env.GIT_COMMITTER_NAME].join('|'))"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      allowedExitCodes: [0],
      identity: { name: "S", email: "s@example.invalid", date: "2026-10-01T00:00:00-04:00" },
    });
    assert.equal(result.stdout, "2026-10-01T00:00:00-04:00|2026-10-01T00:00:00-04:00|S");
  });
});

test("the harness's own refs: created only when absent and deleted only at their old value; never a branch, tag or remote-tracking ref", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const answers = [ok(), refused("fatal: cannot lock ref 'refs/bridlewise/promotion/p/pending': reference already exists", 128), ok()];
  const port = createWorktreeGitPort({ exec: makeExec(() => answers.shift()!, captured) });
  assert.deepEqual(port.createRef("/repo", "refs/bridlewise/promotion/p/pending", SHA_A, 5), { refusal: null });
  assert.match(port.createRef("/repo", "refs/bridlewise/promotion/p/pending", SHA_A, 5).refusal ?? "", /already exists/u);
  assert.deepEqual(port.deleteRef("/repo", "refs/bridlewise/promotion/p/pending", SHA_A, 5), { refusal: null });
  assert.deepEqual(captured[0]!.args.slice(4), ["update-ref", "refs/bridlewise/promotion/p/pending", SHA_A, ""], "git's empty old value: create only");
  assert.deepEqual(captured[2]!.args.slice(4), ["update-ref", "--no-deref", "-d", "refs/bridlewise/promotion/p/pending", SHA_A]);
  for (const ref of ["refs/heads/master", "refs/tags/v1", "refs/remotes/origin/master", "HEAD", "refs/x", "-d", "refs/bridlewise/../heads/x"]) {
    assert.throws(() => port.createRef("/repo", ref, SHA_A, 5), InputError, ref);
    assert.throws(() => port.deleteRef("/repo", ref, SHA_A, 5), InputError, ref);
  }
});

test("the remote operations: an atomic, never-forced push answered per ref (--porcelain), a fetch into remote-tracking or harness refs only, a listing of the exact refs asked", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const answers = [
    ok(`To /r.git\n \t${SHA_A}:refs/heads/prod\t${SHA_B}..${SHA_A}\n*\trefs/x/receipts/a:refs/x/receipts/a\t[new reference]\nDone\n`),
    deepFreeze({ status: 1, signal: null, timedOut: false, stdout: "To /r.git\n!\t" + SHA_A + ":refs/heads/prod\t[rejected] (fetch first)\nDone\n", stderr: "error: failed to push some refs" }),
    ok(""),
    ok(`${SHA_A}\trefs/heads/prod\n${SHA_B}\trefs/heads/other/prod\n${SHA_C}\trefs/heads/dev\n`),
    deepFreeze({ status: 128, signal: null, timedOut: false, stdout: "", stderr: "fatal: unable to access 'https://user:secret@example.invalid/r.git/': Could not resolve host" }),
  ];
  const port = createWorktreeGitPort({ exec: makeExec(() => answers.shift()!, captured) });
  const pushed = port.pushAtomic("/repo", "origin", [`${SHA_A}:refs/heads/prod`, "refs/x/receipts/a:refs/x/receipts/a"], 5);
  assert.deepEqual(pushed, { status: 0, refs: [{ flag: " ", source: SHA_A, destination: "refs/heads/prod", summary: `${SHA_B}..${SHA_A}` }, { flag: "*", source: "refs/x/receipts/a", destination: "refs/x/receipts/a", summary: "[new reference]" }], stderr: "" });
  assert.deepEqual(captured[0]!.args, ["-c", "gc.auto=0", "-C", "/repo", "push", "--atomic", "--porcelain", "origin", `${SHA_A}:refs/heads/prod`, "refs/x/receipts/a:refs/x/receipts/a"]);
  assert.equal(captured[0]!.network, true, "a push reaches the remote with the user's transport");
  const rejected = port.pushAtomic("/repo", "origin", [`${SHA_A}:refs/heads/prod`], 5);
  assert.deepEqual(rejected.refs.map((ref) => [ref.flag, ref.summary]), [["!", "[rejected] (fetch first)"]], "a rejection is data, never an exception");
  const hold = `+${ROOT_POLICY.workflow.promotion.refNamespace}/p/hold:${ROOT_POLICY.workflow.promotion.refNamespace}/p/hold`;
  assert.equal(port.fetchRefs("/repo", "origin", ["+refs/heads/prod:refs/remotes/origin/prod", hold], 5).refusal, null);
  assert.deepEqual(captured[2]!.args, ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-C", "/repo", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", "+refs/heads/prod:refs/remotes/origin/prod", hold]);
  assert.equal(captured[2]!.network, true);
  const listed = port.lsRemote("/repo", "origin", ["refs/heads/prod", "refs/heads/dev", "refs/heads/absent"], 5);
  assert.deepEqual([...listed.refs], [["refs/heads/prod", SHA_A], ["refs/heads/dev", SHA_C]], "a pattern's tail match (refs/heads/other/prod) is not the ref asked for");
  const unreachable = port.lsRemote("/repo", "origin", ["refs/heads/prod"], 5);
  assert.equal(unreachable.refs.size, 0);
  assert.match(unreachable.refusal ?? "", /Could not resolve host/u);
  assert.doesNotMatch(unreachable.refusal ?? "", /secret/u, "a URL's userinfo never reaches an answer");
  // Never forced, never a branch or tag fetched over, never an option.
  for (const [what, call] of [
    ["a forced push", () => port.pushAtomic("/repo", "origin", [`+${SHA_A}:refs/heads/prod`], 5)],
    ["a push to a short ref", () => port.pushAtomic("/repo", "origin", [`${SHA_A}:prod`], 5)],
    ["an empty push", () => port.pushAtomic("/repo", "origin", [], 5)],
    ["a fetch into a branch", () => port.fetchRefs("/repo", "origin", ["+refs/heads/prod:refs/heads/prod"], 5)],
    ["a fetch into a tag", () => port.fetchRefs("/repo", "origin", ["refs/tags/v1:refs/tags/v1"], 5)],
    ["a fetch into the stash (L14)", () => port.fetchRefs("/repo", "origin", ["+refs/heads/prod:refs/stash"], 5)],
    ["a fetch into notes (L14)", () => port.fetchRefs("/repo", "origin", ["refs/notes/commits:refs/notes/commits"], 5)],
    ["a fetch into ANOTHER remote's tracking refs (L14)", () => port.fetchRefs("/repo", "origin", ["+refs/heads/prod:refs/remotes/upstream/prod"], 5)],
    ["a remote spelled as an option", () => port.lsRemote("/repo", "--upload-pack=x", ["refs/heads/prod"], 5)],
    ["a traversing ref", () => port.pushAtomic("/repo", "origin", [`${SHA_A}:refs/heads/../x`], 5)],
  ] as const) {
    assert.throws(call, throwsCode("worktree_argument_invalid"), what);
  }
});

test("a remote operation's environment is the network projection (the user's own git configuration and agent, never this process's secrets) and carries the promotion run variable; every other operation keeps the isolated configuration", () => {
  const planted = "NETWORK_PROJECTION_PROBE_SECRET";
  const previous = process.env[planted];
  process.env[planted] = "must-not-reach-git";
  try {
    withGitRuntime(process.execPath, 268435456, (runtime) => {
      const pinned = createPinnedWorktreeGitExec(runtime);
      const probe = ["-e", "process.stdout.write(JSON.stringify(process.env))"];
      const network = JSON.parse(pinned({ cwd: process.cwd(), allowedExitCodes: [0], timeoutMs: 10_000, args: probe, network: true }).stdout) as Record<string, string>;
      const plain = JSON.parse(pinned({ cwd: process.cwd(), allowedExitCodes: [0], timeoutMs: 10_000, args: probe }).stdout) as Record<string, string>;
      assert.equal(network[ROOT_POLICY.workflow.promotion.runEnvironmentVariable], String(process.pid), "the trigger hook knows the promoter's own fetch or push");
      assert.equal(network["GIT_CONFIG_GLOBAL"], undefined, "the user's own git configuration (a credential helper) applies");
      assert.equal(network["GIT_TERMINAL_PROMPT"], "0", "never a prompt");
      assert.equal(network["HOME"], process.env["HOME"]);
      assert.equal(network[planted], undefined, "an unlisted variable never reaches git");
      assert.equal(plain["GIT_CONFIG_GLOBAL"], "/dev/null");
      assert.equal(plain[ROOT_POLICY.workflow.promotion.runEnvironmentVariable], undefined);
    });
  } finally {
    if (previous === undefined) delete process.env[planted];
    else process.env[planted] = previous;
  }
});

test("a torn landing's index operations: the entries of a commit at paths (ls-tree, repository-relative), their blob ids (filters applied), and the staged entries or removals", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const answers = [ok(`100644 blob ${SHA_A}\tproduct/a.ts\x00120000 blob ${SHA_B}\tproduct/link.ts\x00`), ok(`${SHA_A}\n${SHA_B}\n`), ok(), ok()];
  const port = createWorktreeGitPort({ exec: makeExec(() => answers.shift()!, captured) });
  assert.deepEqual([...port.treeEntries("/w", SHA_C, ["product/a.ts", "product/link.ts", "gone.ts"], 5)], [["product/a.ts", { mode: "100644", oid: SHA_A }], ["product/link.ts", { mode: "120000", oid: SHA_B }]]);
  assert.deepEqual(captured[0]!.args, ["-c", "gc.auto=0", "-C", "/w", "ls-tree", "-z", "--full-tree", SHA_C, "--", "product/a.ts", "product/link.ts", "gone.ts"]);
  assert.deepEqual(port.hashObjects("/w", ["product/a.ts", "b.ts"], 5), [SHA_A, SHA_B]);
  port.updateIndexEntries("/w", [{ path: "product/a.ts", mode: "100644", oid: SHA_A }, { path: "gone.ts", remove: true }], 5);
  assert.deepEqual(captured[2]!.args, ["-c", "gc.auto=0", "-C", "/w", "update-index", "--add", "--cacheinfo", `100644,${SHA_A},product/a.ts`]);
  assert.deepEqual(captured[3]!.args, ["-c", "gc.auto=0", "-C", "/w", "update-index", "--force-remove", "--", "gone.ts"]);
  assert.throws(() => port.updateIndexEntries("/w", [{ path: "a,b.ts", mode: "100644", oid: SHA_A }], 5), throwsCode("worktree_argument_invalid"), "a path --cacheinfo cannot spell");
  assert.throws(() => port.updateIndexEntries("/w", [{ path: "sub", mode: "160000", oid: SHA_A }], 5), throwsCode("worktree_argument_invalid"), "a gitlink is never staged");
});

test("status: `--porcelain=v2 -z` read whole — a path with a space, a quote or ` -> `, a rename's new and old path, staged and unstaged sides, untracked files (A5-design L3)", () => {
  const record = (fields: string) => `${fields}\0`;
  const sha = "a".repeat(40);
  const output = [
    record(`# branch.oid ${sha}`),
    record(`1 .M N... 100644 100644 100644 ${sha} ${sha} a file with spaces.txt`),
    record(`1 M. N... 100644 100644 100644 ${sha} ${sha} quoted "name" -> not a rename.ts`),
    `2 R. N... 100644 100644 100644 ${sha} ${sha} R100 new name.ts\0old name.ts\0`,
    record(`u UU N... 100644 100644 100644 100644 ${sha} ${sha} ${sha} conflicted.ts`),
    record("? new dir/untracked file.ts"),
    record("! ignored.log"),
  ].join("");
  assert.deepEqual(parseStatusV2(output), [
    { path: "a file with spaces.txt", staged: false, unstaged: true, untracked: false },
    { path: "quoted \"name\" -> not a rename.ts", staged: true, unstaged: false, untracked: false },
    { path: "new name.ts", staged: true, unstaged: false, untracked: false, from: "old name.ts" },
    { path: "conflicted.ts", staged: true, unstaged: true, untracked: false },
    { path: "new dir/untracked file.ts", staged: false, unstaged: false, untracked: true },
  ]);
});

// These surfaces share only the expected-tip native deletion primitive;
// their public namespace guards remain separate.
function retirementRefSurfaces(port: ReturnType<typeof createWorktreeGitPort>) {
  const branch = "agent/worker/retirement";
  const recoveryPrefix = "refs/bridlewise/retirement/";
  const recovery = recoveryPrefix + "pending";
  return [
    {
      name: "branch",
      ref: "refs/heads/" + branch,
      create: (repo: string, tip: string, timeoutMs: number) => port.updateRef(repo, "refs/heads/" + branch, tip, "0".repeat(tip.length), timeoutMs),
      read: (repo: string, timeoutMs: number) => port.branchTip(repo, branch, timeoutMs),
      remove: (repo: string, tip: string, timeoutMs: number) => port.deleteBranchAt(repo, branch, tip, timeoutMs),
    },
    {
      name: "recovery",
      ref: recovery,
      create: (repo: string, tip: string, timeoutMs: number) => port.createRef(repo, recovery, tip, timeoutMs),
      read: (repo: string, timeoutMs: number) => port.refsUnder(repo, recoveryPrefix, timeoutMs).get(recovery) ?? null,
      remove: (repo: string, tip: string, timeoutMs: number) => port.deleteRef(repo, recovery, tip, timeoutMs),
    },
  ] as const;
}

test("expected-tip deletion uses one non-dereferencing request while branch namespace remains configurable", () => {
  const captured: WorktreeGitExecRequest[] = [];
  const port = createWorktreeGitPort({ exec: makeExec(() => ok(), captured) });
  assert.deepEqual(port.deleteBranchAt("/repo", "agent/worker/retired", SHA_A, 5), { refusal: null });
  const custom = createWorktreeGitPort({ branchNamespace: "owned/", exec: makeExec(() => ok(), captured) });
  const sha256Tip = "d".repeat(64);
  assert.deepEqual(custom.deleteBranchAt("/repo", "owned/team/retired", sha256Tip, 9), { refusal: null });
  assert.deepEqual(port.deleteRef("/repo", "refs/bridlewise/retirement/pending", SHA_A, 7), { refusal: null });
  assert.deepEqual(captured.map((request) => request.args), [
    ["-c", "gc.auto=0", "-C", "/repo", "update-ref", "--no-deref", "-d", "refs/heads/agent/worker/retired", SHA_A],
    ["-c", "gc.auto=0", "-C", "/repo", "update-ref", "--no-deref", "-d", "refs/heads/owned/team/retired", sha256Tip],
    ["-c", "gc.auto=0", "-C", "/repo", "update-ref", "--no-deref", "-d", "refs/bridlewise/retirement/pending", SHA_A],
  ]);
  assert.deepEqual(captured.map((request) => request.cwd), ["/repo", "/repo", "/repo"]);
  assert.deepEqual(captured.map((request) => request.timeoutMs), [5, 9, 7]);
  assert.ok(captured.every((request) => request.allowedExitCodes.join(",") === "0,1,128"));
  assert.ok(captured.every((request) => !request.args.includes("-D") && request.network !== true));
});

test("expected-tip deletion keeps both public authority guards before any Git call", () => {
  let calls = 0;
  const exec = makeExec(() => { calls += 1; return ok(); });
  const port = createWorktreeGitPort({ exec });
  const invalid = [
    { root: "relative", branch: "agent/worker/retired", tip: SHA_A, code: "worktree_path_invalid" },
    { root: "/repo", branch: "main", tip: SHA_A, code: "worktree_branch_namespace_denied" },
    { root: "/repo", branch: "agent/", tip: SHA_A, code: "worktree_branch_namespace_denied" },
    { root: "/repo", branch: "agent//retired", tip: SHA_A, code: "worktree_branch_invalid" },
    { root: "/repo", branch: "agent/worker/retired", tip: "HEAD", code: "worktree_git_sha_invalid" },
    { root: "/repo", branch: "agent/worker/retired", tip: "g".repeat(40), code: "worktree_git_sha_invalid" },
  ] as const;
  for (const input of invalid) {
    assert.throws(() => port.deleteBranchAt(input.root, input.branch, input.tip, 5),
      (error: unknown) => error instanceof InputError && error.code === input.code);
  }
  const custom = createWorktreeGitPort({ branchNamespace: "owned/", exec });
  assert.throws(() => custom.deleteBranchAt("/repo", "agent/worker/retired", SHA_A, 5),
    (error: unknown) => error instanceof InputError && error.code === "worktree_branch_namespace_denied");
  assert.throws(() => port.deleteRef("/repo", "refs/heads/main", SHA_A, 5),
    (error: unknown) => error instanceof InputError && error.code === "worktree_argument_invalid");
  assert.throws(() => port.deleteRef("relative", "refs/bridlewise/retirement/pending", SHA_A, 5),
    (error: unknown) => error instanceof InputError && error.code === "worktree_path_invalid");
  assert.throws(() => port.deleteRef("/repo", "refs/bridlewise/retirement/pending", "HEAD", 5),
    (error: unknown) => error instanceof InputError && error.code === "worktree_git_sha_invalid");
  assert.equal(calls, 0, "no rejected input reaches native Git");
});

test("both expected-tip deletion surfaces return sanitized native refusals without a force retry", () => {
  for (const status of [1, 128]) {
    for (const surfaceName of ["branch", "recovery"] as const) {
      const captured: WorktreeGitExecRequest[] = [];
      const port = createWorktreeGitPort({
        exec: makeExec(() => deepFreeze({
          status, signal: null, timedOut: false, stdout: "",
          stderr: "fatal: cannot lock ref; see https://fixture-user:fixture-password@example.invalid/repo",
        }), captured),
      });
      const surface = retirementRefSurfaces(port).find((candidate) => candidate.name === surfaceName)!;
      const refusal = surface.remove("/repo", SHA_A, 5).refusal;
      assert.ok(refusal !== null);
      assert.match(refusal, /cannot lock ref/u, "the native refusal remains visible");
      assert.doesNotMatch(refusal, /fixture-user|fixture-password/u, "the existing credential redaction policy is retained");
      assert.equal(captured.length, 1, "a refusal never triggers a fallback deletion");
      assert.deepEqual(captured[0]!.args, [
        "-c", "gc.auto=0", "-C", "/repo", "update-ref", "--no-deref", "-d", surface.ref, SHA_A,
      ]);
    }
  }
});

test("both expected-tip deletion surfaces preserve a ref moved after judgment and delete only its exact current tip", () => {
  withGitAdapter((git, runtime, root) => {
    const repo = createRepoWithCommit(git, root, "ref-cas");
    const native = createPinnedWorktreeGitExec(runtime);
    const captured: WorktreeGitExecRequest[] = [];
    const port = createWorktreeGitPort({ exec: makeExec(native, captured) });
    const timeoutMs = TEST_CONFIG.timeouts.inspectMs;
    const surfaces = retirementRefSurfaces(port);
    const headA = port.revParse(repo, "HEAD", timeoutMs);
    for (const surface of surfaces) assert.deepEqual(surface.create(repo, headA, timeoutMs), { refusal: null });
    git.commit({ path: repo, message: "Preserved native progress", identity: IDENTITY, allowEmpty: true, stageAll: false },
      makeGitContext(repo, "commit", timeoutMs));
    const headB = port.revParse(repo, "HEAD", timeoutMs);
    assert.notEqual(headB, headA, "the races use two actual native commits");
    for (const surface of surfaces) {
      // Fixture setup needs both ref families; public updateRef intentionally permits only heads.
      const advanced = native({
        args: ["-c", "gc.auto=0", "-C", repo, "update-ref", surface.ref, headB, headA],
        cwd: repo, timeoutMs, allowedExitCodes: [0],
      });
      assert.equal(advanced.status, 0, "the fixture advances exactly the expected ref from A to B");
    }
    const stageAtB = port.lsFilesStage(repo, timeoutMs);
    const readme = join(repo, "README.md");
    writeFileSync(readme, "unfinished staged owner work\n");
    const staged = native({
      args: ["-c", "gc.auto=0", "-C", repo, "add", "--", "README.md"],
      cwd: repo, timeoutMs, allowedExitCodes: [0],
    });
    assert.equal(staged.status, 0);
    const before = { head: headB, stage: port.lsFilesStage(repo, timeoutMs), bytes: readFileSync(readme) };
    assert.notEqual(before.stage, stageAtB, "a unique staged owner blob really exists");
    for (const surface of surfaces) {
      const refusal = surface.remove(repo, headA, timeoutMs).refusal;
      assert.ok(refusal !== null);
      assert.ok(refusal.includes(headA) && refusal.includes(headB), "Git names the expected and intervening native tips");
      assert.equal(surface.read(repo, timeoutMs), headB, "the intervening ref remains reachable");
      assert.deepEqual(surface.remove(repo, headB, timeoutMs), { refusal: null });
      assert.equal(surface.read(repo, timeoutMs), null, "only the expected owned ref is deleted");
      assert.equal(port.revParse(repo, "HEAD", timeoutMs), before.head);
      assert.equal(port.lsFilesStage(repo, timeoutMs), before.stage, "staged owner blobs and paths are retained");
      assert.deepEqual(readFileSync(readme), before.bytes, "working bytes are retained");
    }
    const deletes = captured.filter((request) => request.args.includes("update-ref") && request.args.includes("-d"));
    assert.equal(deletes.length, 4);
    assert.ok(deletes.every((request) => request.args.includes("--no-deref") && !request.args.includes("-D")));
  });
});

test("both expected-tip deletion surfaces preserve the actual native missing-ref verdict", () => {
  withGitAdapter((git, runtime, root) => {
    const repo = createRepoWithCommit(git, root, "ref-missing");
    const native = createPinnedWorktreeGitExec(runtime);
    const port = createWorktreeGitPort({ runtime });
    const timeoutMs = TEST_CONFIG.timeouts.inspectMs;
    const head = port.revParse(repo, "HEAD", timeoutMs);
    const before = { head, stage: port.lsFilesStage(repo, timeoutMs), bytes: readFileSync(join(repo, "README.md")) };
    for (const surface of retirementRefSurfaces(port)) {
      assert.equal(surface.read(repo, timeoutMs), null);
      const oracle = native({
        args: ["-c", "gc.auto=0", "-C", repo, "update-ref", "--no-deref", "-d", surface.ref, head],
        cwd: repo, timeoutMs, allowedExitCodes: [0, 1, 128],
      });
      assert.ok(oracle.status === 0 || oracle.status === 1 || oracle.status === 128);
      assert.deepEqual(surface.remove(repo, head, timeoutMs), {
        refusal: oracle.status === 0 ? null : (oracle.stderr + oracle.stdout).trim(),
      }, "the local ref and object-id oracle determines the exact verdict, not an invented missing-ref rule");
      assert.equal(surface.read(repo, timeoutMs), null);
      assert.equal(port.revParse(repo, "HEAD", timeoutMs), before.head);
      assert.equal(port.lsFilesStage(repo, timeoutMs), before.stage);
      assert.deepEqual(readFileSync(join(repo, "README.md")), before.bytes);
    }
  });
});

test("both expected-tip deletion surfaces address symbolic aliases without deleting protected main", () => {
  withGitAdapter((git, runtime, root) => {
    const repo = createRepoWithCommit(git, root, "ref-symbolic");
    const native = createPinnedWorktreeGitExec(runtime);
    const port = createWorktreeGitPort({ runtime });
    const timeoutMs = TEST_CONFIG.timeouts.inspectMs;
    const main = "refs/heads/" + TEST_CONFIG.defaultBranch;
    const mainOid = port.revParse(repo, main, timeoutMs);
    const readme = join(repo, "README.md");
    writeFileSync(readme, "staged work behind protected main\n");
    const staged = native({
      args: ["-c", "gc.auto=0", "-C", repo, "add", "--", "README.md"],
      cwd: repo, timeoutMs, allowedExitCodes: [0],
    });
    assert.equal(staged.status, 0);
    const before = { head: mainOid, stage: port.lsFilesStage(repo, timeoutMs), bytes: readFileSync(readme) };
    for (const surface of retirementRefSurfaces(port)) {
      const oracleAlias = surface.ref + "-oracle";
      for (const ref of [surface.ref, oracleAlias]) {
        const created = native({
          args: ["-c", "gc.auto=0", "-C", repo, "symbolic-ref", ref, main],
          cwd: repo, timeoutMs, allowedExitCodes: [0],
        });
        assert.equal(created.status, 0);
      }
      const oracle = native({
        args: ["-c", "gc.auto=0", "-C", repo, "update-ref", "--no-deref", "-d", oracleAlias, mainOid],
        cwd: repo, timeoutMs, allowedExitCodes: [0, 1, 128],
      });
      assert.ok(oracle.status === 0 || oracle.status === 1 || oracle.status === 128);
      const oracleSymbolic = native({
        args: ["-c", "gc.auto=0", "-C", repo, "symbolic-ref", "-q", oracleAlias],
        cwd: repo, timeoutMs, allowedExitCodes: [0, 1],
      });
      const oracleNamed = native({
        args: ["-c", "gc.auto=0", "-C", repo, "rev-parse", "-q", "--verify", oracleAlias],
        cwd: repo, timeoutMs, allowedExitCodes: [0, 1, 128],
      });
      assert.ok(oracleNamed.status === 0 || oracleNamed.status === 1 || oracleNamed.status === 128);
      const oracleNamedTip = oracleNamed.status === 0 ? oracleNamed.stdout.trim() : null;
      const actual = surface.remove(repo, mainOid, timeoutMs);
      const protectedMain = native({
        args: ["-c", "gc.auto=0", "-C", repo, "rev-parse", "-q", "--verify", main + "^{commit}"],
        cwd: repo, timeoutMs, allowedExitCodes: [0, 1, 128],
      });
      assert.equal(protectedMain.status, 0, "the protected target ref must remain present");
      assert.equal(protectedMain.stdout.trim(), mainOid, "the protected target never moves");
      const actualNamedTip = surface.read(repo, timeoutMs);
      assert.equal(actualNamedTip, oracleNamedTip, "the named ref matches the actual native deletion oracle");
      if (oracle.status === 0) assert.equal(actualNamedTip, null, "successful deletion removes the named ref, including a direct-ref replacement");
      assert.equal(actual.refusal === null, oracle.status === 0, "alias deletion or refusal follows the real non-dereferencing oracle");
      if (oracle.status !== 0) assert.ok(actual.refusal !== null && actual.refusal.length > 0);
      const actualSymbolic = native({
        args: ["-c", "gc.auto=0", "-C", repo, "symbolic-ref", "-q", surface.ref],
        cwd: repo, timeoutMs, allowedExitCodes: [0, 1],
      });
      assert.equal(actualSymbolic.status, oracleSymbolic.status);
      assert.equal(actualSymbolic.stdout, oracleSymbolic.stdout, "the public API preserves its oracle alias disposition");
      assert.equal(port.revParse(repo, "HEAD", timeoutMs), before.head);
      assert.equal(port.lsFilesStage(repo, timeoutMs), before.stage);
      assert.deepEqual(readFileSync(readme), before.bytes);
    }
  });
});
