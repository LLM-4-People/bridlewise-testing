/**
 * THE DCO AT ITS TWO DOORS (scripts/verification/sign-off.ts): the commit-msg
 * question over a raw message, and CI's question over a range of commits.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { committerIdentity, messageSignOffProblem, unsignedCommits } from "../../scripts/verification/sign-off.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { TEST_GIT_IDENTITY, testGitIdentityEnvironment } from "../support/test-git-identity.ts";

const SIGNED = `Signed-off-by: ${TEST_GIT_IDENTITY.name} <${TEST_GIT_IDENTITY.email}>`;

function repository(): Readonly<{ root: string; git: (args: readonly string[], environment?: Readonly<Record<string, string>>) => string }> {
  const root = createTempDir("sign-off-");
  const git = (args: readonly string[], environment: Readonly<Record<string, string>> = {}): string =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root, encoding: "utf8", env: { ...process.env, ...testGitIdentityEnvironment(), ...environment },
    });
  git(["init", "-q", "-b", "main"]);
  return { root, git };
}

function commit(git: (args: readonly string[]) => string, root: string, file: string, message: string): string {
  writeFileSync(join(root, file), `${file}\n`);
  git(["add", "--", file]);
  git(["commit", "-q", "-m", message]);
  return git(["rev-parse", "HEAD"]).trim();
}

test("commit-msg: a message signed off by the committer passes; none, another's or a body line is refused", () => {
  const { root } = repository();
  const committer = TEST_GIT_IDENTITY;
  assert.equal(messageSignOffProblem(root, `feat: a change\n\n${SIGNED}\n`, committer), null);
  assert.equal(messageSignOffProblem(root, `feat: a change\n\nSigned-off-by: ${committer.name} <${committer.email.toUpperCase()}>\n`, committer), null, "an address compares without case");
  assert.match(messageSignOffProblem(root, "feat: a change\n", committer) ?? "", /carries none/u);
  assert.match(messageSignOffProblem(root, "feat: a change\n\nSigned-off-by: Someone Else <else@example.invalid>\n", committer) ?? "", /Someone Else/u);
  // A `Signed-off-by:` paragraph in the body, followed by more prose, is no trailer (git's own parse).
  assert.notEqual(messageSignOffProblem(root, `feat: a change\n\n${SIGNED}\n\nAnd a closing paragraph of prose.\n`, committer), null);
  // Merges included: a merge message is a message like any other.
  assert.match(messageSignOffProblem(root, "Merge branch 'topic'\n", committer) ?? "", /git merge --signoff/u);
});

test("commit-msg: the committer is the one git will record here", () => {
  const { root } = repository();
  process.env.GIT_COMMITTER_NAME = TEST_GIT_IDENTITY.name;
  process.env.GIT_COMMITTER_EMAIL = TEST_GIT_IDENTITY.email;
  try {
    assert.deepEqual(committerIdentity(root), TEST_GIT_IDENTITY);
  } finally {
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;
  }
});

test("CI: every commit of a range carries its own committer's sign-off; a merge GitHub made itself is mechanical", () => {
  const { root, git } = repository();
  const base = commit(git, root, "base.txt", `base\n\n${SIGNED}`);
  commit(git, root, "signed.txt", `signed\n\n${SIGNED}`);
  assert.deepEqual(unsignedCommits(root, `${base}..HEAD`), [], "a signed range passes (liveness)");

  const unsigned = commit(git, root, "unsigned.txt", "unsigned");
  git(["checkout", "-q", "-b", "topic", base]);
  commit(git, root, "topic.txt", `topic\n\n${SIGNED}`);
  git(["checkout", "-q", "main"]);
  git(["merge", "-q", "--no-ff", "--no-edit", "topic"]);
  const merge = git(["rev-parse", "HEAD"]).trim();
  assert.deepEqual(
    unsignedCommits(root, `${base}..HEAD`).map((line) => line.slice(0, 12)).toSorted(),
    [merge.slice(0, 12), unsigned.slice(0, 12)].toSorted(),
    "an unsigned commit and an unsigned merge are both named",
  );

  // GitHub's own merge (the merge queue's, a merged pull request's) is mechanical.
  git(["reset", "-q", "--hard", "HEAD~1"]);
  git(["merge", "-q", "--no-ff", "--no-edit", "topic"], { GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" });
  assert.deepEqual(unsignedCommits(root, `${base}..HEAD`).map((line) => line.slice(0, 12)), [unsigned.slice(0, 12)], "only the unsigned work commit is named");

  // A commit GitHub committed that is NOT a merge is judged like any other.
  writeFileSync(join(root, "web.txt"), "web\n");
  git(["add", "--", "web.txt"]);
  git(["commit", "-q", "-m", "an edit made on the web"], { GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" });
  assert.equal(unsignedCommits(root, `${base}..HEAD`).length, 2);
});
