/**
 * THE TREE LANDING's postconditions (src/workflow/tree-landing.ts), over a
 * port whose answers the test chooses: the states that must never happen in
 * a real repository (a candidate that does not hold the computed tree, a
 * commit recording another tree or other parents, a commit reaching missing
 * objects) are refused, typed, and a hook's refusal is `commit_refused` with
 * its words; a git step that fails is typed by the phase runner — the
 * machine's (a ceiling, a signal, a full disk) `git_errored`, git's own
 * refusal `git_failed`; a push's answer is classified (pushed, rejected,
 * refused, errored). The real flow is `promotion/apply.test.ts`'s and
 * `promotion/publish.test.ts`'s.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import test from "node:test";

import { HarnessError } from "../../src/kernel/errors.ts";
import { gitBlobId } from "../../src/kernel/integrity.ts";
import { directoryGitEnvironment } from "../../src/git/repository-ownership.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { WorktreeGitError, WorktreeGitTimeout, type PushOutcome, type WorktreeGitPort } from "../../src/git/worktree-port.ts";
import { LandingError, commitCandidate, createCandidate, landingGitFailure, pushVerdict, remoteFailureClass, runLandingPhase } from "../../src/workflow/tree-landing.ts";

const T = "a".repeat(40);
const S = "b".repeat(40);
const P = "c".repeat(40);
const C = "d".repeat(40);
const OTHER = "e".repeat(40);
const IDENTITY = { name: "S", email: "s@example.invalid", date: "2026-10-01T00:00:00Z" };

/** A port answering only what the landing asks, each answer chosen by the test. */
function port(answers: Readonly<{ staged?: string; tree?: string; parents?: readonly string[]; missing?: readonly string[]; refuse?: string }>): WorktreeGitPort {
  const unused = (): never => { throw new Error("not asked by the landing"); };
  return new Proxy({}, {
    get: (_target, name) => {
      switch (name) {
        case "worktreeAddDetached": case "mergeOursNoCommit": case "readTreeReset": return () => undefined;
        case "isAncestor": return () => false;
        case "stageAll": return () => answers.staged ?? P;
        case "commit": return () => {
          if (answers.refuse !== undefined) throw new WorktreeGitError("commit", "unexpected exit status 1", { status: 1, signal: null, timedOut: false, stdout: "", stderr: answers.refuse });
          return { commit: C, output: "certified" };
        };
        case "revParse": return (_root: string, ref: string) => {
          if (ref === `${C}^{tree}`) return answers.tree ?? P;
          const parent = /\^(\d)$/u.exec(ref);
          return parent === null ? unused() : (answers.parents ?? [T, S])[Number(parent[1]) - 1] ?? unused();
        };
        case "missingObjects": return () => answers.missing ?? [];
        default: return unused;
      }
    },
  }) as WorktreeGitPort;
}

const commit = (git: WorktreeGitPort) => commitCandidate({ git, root: "/candidate", message: "promote", identity: IDENTITY, tree: P, parents: [T, S], timeoutMs: 5 });

test("a commit with the settled tree, the declared parents and every object answers its id and the hooks' words", () => {
  assert.deepEqual(commit(port({})), { commit: C, output: "certified" });
});

test("a commit recording another tree, or other parents, is a typed mismatch (never published)", () => {
  for (const answers of [{ tree: OTHER }, { parents: [T, OTHER] }, { parents: [OTHER, S] }]) {
    assert.throws(() => commit(port(answers)), (error: unknown) => error instanceof LandingError && error.failure === "candidate_mismatch" && error.code === "landing_candidate_mismatch", JSON.stringify(answers));
  }
});

test("a commit reaching missing objects is objects_missing, naming them", () => {
  assert.throws(() => commit(port({ missing: [OTHER] })), (error: unknown) => error instanceof LandingError && error.failure === "objects_missing" && (error.facts["missing"] as readonly string[])[0] === OTHER);
});

test("a hook's refusal is commit_refused with the hook's words", () => {
  assert.throws(() => commit(port({ refuse: "COMMIT REFUSED — the staged tree is wrong" })), (error: unknown) => error instanceof LandingError && error.failure === "commit_refused" && /the staged tree is wrong/u.test(error.message));
});

test("a candidate that does not hold the computed tree is a typed mismatch", () => {
  assert.throws(
    () => createCandidate({ git: port({ staged: OTHER }), repoRoot: "/repo", path: "/candidate", target: T, source: S, tree: P, message: "m", identity: IDENTITY, timeoutMs: 5 }),
    (error: unknown) => error instanceof LandingError && error.failure === "candidate_mismatch",
  );
  assert.deepEqual(createCandidate({ git: port({}), repoRoot: "/repo", path: "/candidate", target: T, source: S, tree: P, message: "m", identity: IDENTITY, timeoutMs: 5 }), { merged: true });
});

const gitFailed = (stderr: string, status: number | null = 128) => new WorktreeGitError("add -A", `unexpected exit status ${String(status ?? "(signal)")}`, { status, signal: status === null ? "SIGKILL" : null, timedOut: false, stdout: "", stderr });

test("a git step's failure is typed: the machine's (a ceiling, a signal, a full disk; either git door) git_errored, git's own refusal git_failed, anything else untouched", () => {
  const cases: readonly (readonly [unknown, string | null])[] = [
    [new WorktreeGitTimeout("add -A", 30_000), "git_errored"],
    [gitFailed("", null), "git_errored"],
    [gitFailed("error: unable to write file x: No space left on device"), "git_errored"],
    [gitFailed("fatal: Unable to create '/candidate/.git/index.lock': File exists."), "git_failed"],
    [new HarnessError("git log failed: it reached its 5ms ceiling and was killed", "tree_reader_git_failed", true, { ending: "ceiling" }), "git_errored"],
    [new HarnessError("git log failed: bad revision", "tree_reader_git_failed", false, { ending: "exited" }), "git_failed"],
    [new HarnessError("something else", "other_failure"), null],
    [new Error("a bug"), null],
  ];
  for (const [error, failure] of cases) {
    const typed = landingGitFailure(error, "settle");
    assert.equal(typed?.failure ?? null, failure, String(error));
    if (typed !== null) assert.equal(typed.facts["phase"], "settle");
  }
});

test("the phase runner types a git step that failed inside its phase (never an untyped escape) and passes every other error through", async () => {
  await assert.rejects(runLandingPhase("settle", {}, () => { throw new WorktreeGitTimeout("add -A", 30_000); }), (error: unknown) => error instanceof LandingError && error.failure === "git_errored" && error.retryable);
  await assert.rejects(runLandingPhase("candidate", {}, () => { throw gitFailed("fatal: not a tree"); }), (error: unknown) => error instanceof LandingError && error.failure === "git_failed");
  const own = new LandingError("gate_failed", "a gate failed");
  await assert.rejects(runLandingPhase("settle", {}, () => { throw own; }), (error: unknown) => error === own);
  const bug = new TypeError("a bug");
  await assert.rejects(runLandingPhase("settle", {}, () => { throw bug; }), (error: unknown) => error === bug);
});

test("a commit the machine ended (its ceiling, a signal) is git_errored, never blamed on the tree as commit_refused", async () => {
  const ended = new Proxy(port({}), { get: (target, name) => (name === "commit" ? () => { throw gitFailed("", null); } : Reflect.get(target, name)) });
  await assert.rejects(runLandingPhase("commit", {}, () => commit(ended)), (error: unknown) => error instanceof LandingError && error.failure === "git_errored");
});

test("a push's verdict: every ref moved is pushed; a non-fast-forward is rejected (the remote moved: re-plan); the remote's own refusal or a permission is refused; no ref reported and no refusal words is errored (unreached)", () => {
  const ref = (flag: string, summary: string) => ({ flag, source: C, destination: "refs/heads/prod", summary });
  const cases: ReadonlyArray<readonly [string, PushOutcome, string]> = [
    ["pushed", { status: 0, refs: [ref(" ", `${T}..${C}`), ref("*", "[new reference]")], stderr: "" }, "pushed"],
    ["non-fast-forward", { status: 1, refs: [ref("!", "[rejected] (non-fast-forward)"), ref("!", "[rejected] (atomic push failed)")], stderr: "error: failed to push some refs" }, "rejected"],
    ["fetch first", { status: 1, refs: [ref("!", "[rejected] (fetch first)")], stderr: "" }, "rejected"],
    ["the remote's hook", { status: 1, refs: [ref("!", "[remote rejected] (pre-receive hook declined)")], stderr: "" }, "refused"],
    ["a permission", { status: 128, refs: [], stderr: "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://example.invalid/r.git/'" }, "refused"],
    ["a protected branch", { status: 1, refs: [], stderr: "remote: GitLab: You are not allowed to push code to protected branches" }, "refused"],
    ["an unknown host", { status: 128, refs: [], stderr: "fatal: unable to access 'https://example.invalid/r.git/': Could not resolve host: example.invalid" }, "errored"],
    ["a reset connection", { status: 128, refs: [], stderr: "fatal: the remote end hung up unexpectedly" }, "errored"],
  ];
  for (const [what, outcome, verdict] of cases) assert.equal(pushVerdict(outcome).verdict, verdict, what);
  assert.equal(remoteFailureClass("fatal: 'origin' does not appear to be a git repository"), "refused", "a misnamed remote is a configuration to fix, never retried");
  assert.equal(remoteFailureClass("fatal: repository 'https://git.example.invalid/team/gone.git/' not found"), "refused", "git's own words for a missing repository");
  assert.equal(remoteFailureClass("remote: Repository not found.\nfatal: Authentication failed"), "refused", "a forge's words for it");
});

test("gitBlobId: the id git itself gives a blob, in a SHA-1 and in a SHA-256 repository (the torn completion's check of a symbolic link's target)", () => {
  for (const format of ["sha1", "sha256"] as const) {
    const directory = createTempDir(`tree-landing-blob-id-${format}-`);
    try {
      const git = (args: readonly string[], input?: string): string =>
        execFileSync("git", args, { cwd: directory, env: directoryGitEnvironment(), input, encoding: "utf8" }).trim();
      git(["init", "--quiet", `--object-format=${format}`]);
      const like = git(["hash-object", "--stdin"], "");
      for (const bytes of ["", "../target/of/a link", "ünïcode\n\0binary"]) {
        assert.equal(gitBlobId(Buffer.from(bytes), like), git(["hash-object", "--stdin"], bytes), `${format}: ${JSON.stringify(bytes)}`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
