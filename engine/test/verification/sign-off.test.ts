/**
 * THE DCO AT ITS TWO DOORS (scripts/verification/sign-off.ts): the commit-msg
 * question over a raw message, and CI's question over a range of commits.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AGENT_IDENTITY, committerIdentity, isAgentAccount, messageSignOffProblem, unsignedCommits } from "../../scripts/verification/sign-off.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
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
  assert.equal(messageSignOffProblem(root, `feat: a change\n\n${SIGNED}\n`, committer, committer), null);
  assert.equal(messageSignOffProblem(root, `feat: a change\n\nSigned-off-by: ${committer.name} <${committer.email.toUpperCase()}>\n`, committer, committer), null, "an address compares without case");
  assert.match(messageSignOffProblem(root, "feat: a change\n", committer, committer) ?? "", /carries none/u);
  assert.match(messageSignOffProblem(root, "feat: a change\n\nSigned-off-by: Someone Else <else@example.invalid>\n", committer, committer) ?? "", /Someone Else/u);
  // A `Signed-off-by:` paragraph in the body, followed by more prose, is no trailer (git's own parse).
  assert.notEqual(messageSignOffProblem(root, `feat: a change\n\n${SIGNED}\n\nAnd a closing paragraph of prose.\n`, committer, committer), null);
  // Merges included: a merge message is a message like any other.
  assert.match(messageSignOffProblem(root, "Merge branch 'topic'\n", committer, committer) ?? "", /git merge --signoff/u);
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

// ---------------------------------------------------------------------------
// THE AGENT IDENTITY: an agent commit is the project's identity throughout —
// author, committer and every sign-off — read from ONE declared source; a
// human outside contributor keeps the ordinary DCO.
// ---------------------------------------------------------------------------

const AGENT = AGENT_IDENTITY;
const PERSONAL = { name: "A Person", email: "person@example.invalid" } as const;
const signedBy = (...identities: readonly { name: string; email: string }[]): string =>
  `feat: a change\n\n${identities.map((identity) => `Signed-off-by: ${identity.name} <${identity.email}>`).join("\n")}\n`;

test("agent identity: declared once — the root policy is its one source, and no other source spells it", () => {
  assert.deepEqual(AGENT, ROOT_POLICY.workflow.commitIdentity.agent);
  const engine = join(import.meta.dirname, "..", "..");
  const spelled = execFileSync("git", ["grep", "-l", "-F", AGENT.email, "--", "src", "scripts", "../.github", "../scripts"], { cwd: engine, encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  assert.deepEqual(spelled, ["src/kernel/root-policy.ts"], "the identity is read from the policy, never restated");
});

test("commit-msg: an agent commit whose sign-off, author or committer is a person's own is refused, each named", () => {
  const { root } = repository();
  assert.equal(messageSignOffProblem(root, signedBy(AGENT), AGENT, AGENT), null, "the project identity throughout passes (liveness)");
  // The incident: an extra sign-off with the person's own address beside the agent's.
  assert.match(messageSignOffProblem(root, signedBy(AGENT, PERSONAL), AGENT, AGENT) ?? "", /Signed-off-by is A Person <person@example\.invalid>, not the project's agent identity/u);
  assert.match(messageSignOffProblem(root, signedBy(AGENT), AGENT, PERSONAL) ?? "", /author is A Person/u);
  // A person's committer signing off as themselves, on a commit authored by the agent identity.
  assert.match(messageSignOffProblem(root, signedBy(PERSONAL), PERSONAL, AGENT) ?? "", /committer is A Person/u);
  // The agent's domain is an agent mark too: a different name or mailbox in it is not the identity.
  const sameDomain = { name: "someone", email: `someone@${AGENT.email.split("@")[1]!}` };
  assert.match(messageSignOffProblem(root, signedBy(sameDomain), sameDomain, sameDomain) ?? "", /not the project's agent identity/u);
});

test("commit-msg: a human outside contributor keeps the ordinary DCO — their own name and address, signed off as committer", () => {
  const { root } = repository();
  assert.equal(messageSignOffProblem(root, signedBy(PERSONAL), PERSONAL, PERSONAL), null);
  assert.equal(messageSignOffProblem(root, signedBy(PERSONAL, { name: "Co Author", email: "co@example.invalid" }), PERSONAL, PERSONAL), null, "a human's chain of sign-offs is theirs");
});

test("CI: a pull request a declared agent account opened brings agent commits only; a human's pull request keeps the DCO", () => {
  const { root, git } = repository();
  const base = commit(git, root, "base.txt", `base\n\n${SIGNED}`);
  // A commit that looks human (the test identity, properly signed off).
  commit(git, root, "human.txt", `human\n\n${SIGNED}`);
  assert.deepEqual(unsignedCommits(root, `${base}..HEAD`, false), [], "in a human's pull request, the ordinary DCO holds");
  const refused = unsignedCommits(root, `${base}..HEAD`, true);
  assert.deepEqual(refused.map((line) => /its (\S+) is/u.exec(line)?.[1]), ["author", "committer", "Signed-off-by"], "in an agent's pull request, a person's identity is refused, each role named");
  assert.equal(isAgentAccount(ROOT_POLICY.workflow.commitIdentity.agentAccounts[0]!), true);
  assert.equal(isAgentAccount("an-outside-contributor"), false);

  // An agent-identity commit carrying a person's extra sign-off is refused by its marks alone.
  const agentEnvironment = { GIT_AUTHOR_NAME: AGENT.name, GIT_AUTHOR_EMAIL: AGENT.email, GIT_COMMITTER_NAME: AGENT.name, GIT_COMMITTER_EMAIL: AGENT.email };
  writeFileSync(join(root, "agent.txt"), "agent\n");
  git(["add", "--", "agent.txt"]);
  git(["commit", "-q", "-m", signedBy(AGENT, PERSONAL)], agentEnvironment);
  const agentLines = unsignedCommits(root, "HEAD~1..HEAD", false);
  assert.equal(agentLines.length, 1);
  assert.match(agentLines[0]!, /Signed-off-by is A Person/u);
});

test("the required commit-records check judges the DCO by main's code: the base is checked out, the branch's commits only fetched", () => {
  const workflows = join(import.meta.dirname, "..", "..", "..", ".github", "workflows");
  const dco = readFileSync(join(workflows, "commit-records.yml"), "utf8");
  assert.match(dco, /ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha \}\}/u, "the checkout is the base, never the branch");
  assert.match(dco, /git fetch --no-tags "\$SERVER\/\$REPOSITORY" "refs\/pull\/\$PR_NUMBER\/head"/u, "the branch's commits are fetched as objects");
  assert.match(dco, /--pull-request-author "\$PR_AUTHOR"/u, "the pull request's author decides an agent pull request");
  assert.doesNotMatch(dco, /pull_request_target/u, "no pull_request_target (write access beside a fork's code)");
  assert.match(dco, /^ {2}merge_group:$/mu);
  assert.match(dco, /node scripts\/verification\/sign-off\.ts --range/u, "the one commit-records workflow runs the sign-off judge");
  // One owner: CI carries no second DCO job a trimmed branch could edit.
  assert.doesNotMatch(readFileSync(join(workflows, "ci.yml"), "utf8"), /sign-off\.ts/u);
});
