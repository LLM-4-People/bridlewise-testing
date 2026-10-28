/**
 * THE DCO AT ITS TWO DOORS (scripts/verification/sign-off.ts): the commit-msg
 * question over a raw message, and CI's question over a range of commits.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AGENT_CHECKOUT_KEY, AGENT_IDENTITY, committerIdentity, isAgentAccount, isAgentCheckout, messageSignOffProblem, unsignedCommits } from "../../scripts/verification/sign-off.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { TEST_GIT_IDENTITY, testGitIdentityEnvironment } from "../support/test-git-identity.ts";

const SIGNED = `Signed-off-by: ${TEST_GIT_IDENTITY.name} <${TEST_GIT_IDENTITY.email}>`;

type Who = Readonly<{ name: string; email: string }>;
/** The commit-msg question with explicit idents (the hook reads them from git). */
function judge(root: string, message: string, committer: Who, author: Who = committer, agentCheckout = false): string | null {
  return messageSignOffProblem(root, message, { author, committer }, agentCheckout);
}

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
  assert.equal(judge(root, `feat: a change\n\n${SIGNED}\n`, committer), null);
  assert.equal(judge(root, `feat: a change\n\nSigned-off-by: ${committer.name} <${committer.email.toUpperCase()}>\n`, committer), null, "an address compares without case");
  assert.match(judge(root, "feat: a change\n", committer) ?? "", /carries none/u);
  assert.match(judge(root, "feat: a change\n\nSigned-off-by: Someone Else <else@example.invalid>\n", committer) ?? "", /Someone Else/u);
  // A `Signed-off-by:` paragraph in the body, followed by more prose, is no trailer (git's own parse).
  assert.notEqual(judge(root, `feat: a change\n\n${SIGNED}\n\nAnd a closing paragraph of prose.\n`, committer), null);
  // Merges included: a merge message is a message like any other.
  assert.match(judge(root, "Merge branch 'topic'\n", committer) ?? "", /git merge --signoff/u);
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

test("CI: every commit of a range carries its own committer's sign-off; no committer name exempts a merge", () => {
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

  // NO NAME IS AN EXEMPTION: a merge whose committer SAYS it is GitHub is judged like any other.
  git(["reset", "-q", "--hard", "HEAD~1"]);
  git(["merge", "-q", "--no-ff", "--no-edit", "topic"], { GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" });
  const forged = git(["rev-parse", "HEAD"]).trim();
  assert.deepEqual(
    unsignedCommits(root, `${base}..HEAD`).map((line) => line.slice(0, 12)).toSorted(),
    [forged.slice(0, 12), unsigned.slice(0, 12)].toSorted(),
    "a merge claiming GitHub as its committer is not exempt",
  );
});

test("CI: in a merge group, only the queue's own first-parent merges go unjudged; every commit they bring in is judged, and a non-merge on that chain is refused", () => {
  const { root, git } = repository();
  const base = commit(git, root, "base.txt", `base\n\n${SIGNED}`);
  git(["checkout", "-q", "-b", "pr", base]);
  const unsigned = commit(git, root, "pr.txt", "a pull request's commit without a sign-off");
  git(["checkout", "-q", "main"]);
  // The queue's merge: unsigned, as GitHub makes it; it is the group's first-parent chain.
  git(["merge", "-q", "--no-ff", "--no-edit", "pr"], { GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" });
  assert.deepEqual(unsignedCommits(root, `${base}..HEAD`, { mergeGroup: true }).map((line) => line.slice(0, 12)), [unsigned.slice(0, 12)],
    "the queue's merge is not judged; the commit it brings in is");
  // A plain commit on the chain is not the queue's.
  const plain = commit(git, root, "plain.txt", "pushed onto the chain");
  const refused = unsignedCommits(root, `${base}..HEAD`, { mergeGroup: true });
  assert.ok(refused.some((line) => line.startsWith(`${plain.slice(0, 12)} is on the merge group's first-parent chain but is not a merge`)), refused.join("\n"));
});

test("identity trailers: every one is exactly Name <address>, judged in any spelling of its key — never dropped", () => {
  const { root } = repository();
  const committer = TEST_GIT_IDENTITY;
  // The review's plants: each was ACCEPTED when unreadable trailers were dropped.
  for (const trailer of ["Signed-off-by: person@example.invalid", "Signed-off-by: <person@example.invalid>", `Signed-off-by: ${committer.name} <${committer.email}> person@example.invalid`, "Reported-by: someone"]) {
    assert.match(judge(root, `feat: a change\n\n${SIGNED}\n${trailer}\n`, committer) ?? "", /is not exactly one "Name <address>"/u, `${trailer} was accepted`);
  }
  // Any case of a sign-off key is a sign-off (and is judged as one).
  assert.equal(judge(root, `feat: a change\n\nsigned-off-by: ${committer.name} <${committer.email}>\n`, committer), null);
});

test("agent identity: a lower-case sign-off or a Co-authored-by trailer carrying a person's address is refused on an agent commit", () => {
  const { root } = repository();
  const agent = `Signed-off-by: ${AGENT.name} <${AGENT.email}>`;
  assert.match(judge(root, `feat: a change\n\n${agent}\nsigned-off-by: ${PERSONAL.name} <${PERSONAL.email}>\n`, AGENT) ?? "", /signed-off-by trailer is A Person/u);
  assert.match(judge(root, `feat: a change\n\n${agent}\nCo-authored-by: ${PERSONAL.name} <${PERSONAL.email}>\n`, AGENT) ?? "", /Co-authored-by trailer is A Person/u);
  // On a human's commit, a co-author is theirs to name.
  assert.equal(judge(root, `feat: a change\n\n${SIGNED}\nCo-authored-by: ${PERSONAL.name} <${PERSONAL.email}>\n`, TEST_GIT_IDENTITY), null);
});

test("agent checkout: a commit made in a checkout the harness made for an agent must be the agent identity, whatever its marks", () => {
  const { root, git } = repository();
  assert.equal(isAgentCheckout(root), false, "a plain repository is no agent checkout");
  git(["config", AGENT_CHECKOUT_KEY, "true"]);
  assert.equal(isAgentCheckout(root), true);
  // The review's plant: committer, author and sign-off all a person's own — no agent mark at all.
  assert.match(judge(root, signedBy(PERSONAL), PERSONAL, PERSONAL, true) ?? "", /agent commit and its author is A Person[\s\S]*this checkout is an agent's/u);
  assert.equal(judge(root, signedBy(AGENT), AGENT, AGENT, true), null);
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
  assert.equal(judge(root, signedBy(AGENT), AGENT, AGENT), null, "the project identity throughout passes (liveness)");
  // The incident: an extra sign-off with the person's own address beside the agent's.
  assert.match(judge(root, signedBy(AGENT, PERSONAL), AGENT, AGENT) ?? "", /Signed-off-by trailer is A Person <person@example\.invalid>, not the project's agent identity/u);
  assert.match(judge(root, signedBy(AGENT), AGENT, PERSONAL) ?? "", /author is A Person/u);
  // A person's committer signing off as themselves, on a commit authored by the agent identity.
  assert.match(judge(root, signedBy(PERSONAL), PERSONAL, AGENT) ?? "", /committer is A Person/u);
  // The agent's domain is an agent mark too: a different name or mailbox in it is not the identity.
  const sameDomain = { name: "someone", email: `someone@${AGENT.email.split("@")[1]!}` };
  assert.match(judge(root, signedBy(sameDomain), sameDomain, sameDomain) ?? "", /not the project's agent identity/u);
});

test("commit-msg: a human outside contributor keeps the ordinary DCO — their own name and address, signed off as committer", () => {
  const { root } = repository();
  assert.equal(judge(root, signedBy(PERSONAL), PERSONAL, PERSONAL), null);
  assert.equal(judge(root, signedBy(PERSONAL, { name: "Co Author", email: "co@example.invalid" }), PERSONAL, PERSONAL), null, "a human's chain of sign-offs is theirs");
});

test("CI: a pull request a declared agent account opened brings agent commits only; a human's pull request keeps the DCO", () => {
  const { root, git } = repository();
  const base = commit(git, root, "base.txt", `base\n\n${SIGNED}`);
  // A commit that looks human (the test identity, properly signed off).
  commit(git, root, "human.txt", `human\n\n${SIGNED}`);
  assert.deepEqual(unsignedCommits(root, `${base}..HEAD`), [], "in a human's pull request, the ordinary DCO holds");
  const refused = unsignedCommits(root, `${base}..HEAD`, { agentPullRequest: true });
  assert.deepEqual(refused.map((line) => /its (\S+)(?: trailer)? is/u.exec(line)?.[1]), ["author", "committer", "Signed-off-by"], "in an agent's pull request, a person's identity is refused, each role named");
  assert.equal(isAgentAccount(ROOT_POLICY.workflow.commitIdentity.agentAccounts[0]!), true);
  assert.equal(isAgentAccount("an-outside-contributor"), false);

  // An agent-identity commit carrying a person's extra sign-off is refused by its marks alone.
  const agentEnvironment = { GIT_AUTHOR_NAME: AGENT.name, GIT_AUTHOR_EMAIL: AGENT.email, GIT_COMMITTER_NAME: AGENT.name, GIT_COMMITTER_EMAIL: AGENT.email };
  writeFileSync(join(root, "agent.txt"), "agent\n");
  git(["add", "--", "agent.txt"]);
  git(["commit", "-q", "-m", signedBy(AGENT, PERSONAL)], agentEnvironment);
  const agentLines = unsignedCommits(root, "HEAD~1..HEAD");
  assert.equal(agentLines.length, 1);
  assert.match(agentLines[0]!, /Signed-off-by trailer is A Person/u);
});

test("the commit-records workflow checks out the base and only fetches the branch's commits — a spelling pin, not a boundary (a pull_request run uses the branch's copy; the boundary is the door App, #67)", () => {
  const workflows = join(import.meta.dirname, "..", "..", "..", ".github", "workflows");
  const dco = readFileSync(join(workflows, "commit-records.yml"), "utf8");
  assert.match(dco, /ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha \}\}/u, "the checkout is the base, never the branch");
  assert.match(dco, /git fetch --no-tags "\$SERVER\/\$REPOSITORY" "refs\/pull\/\$PR_NUMBER\/head"/u, "the branch's commits are fetched as objects");
  assert.match(dco, /--pull-request-author "\$PR_AUTHOR"/u, "the pull request's author decides an agent pull request");
  assert.doesNotMatch(dco, /pull_request_target/u, "no pull_request_target (write access beside a fork's code)");
  assert.match(dco, /^ {2}merge_group:$/mu);
  assert.match(dco, /node scripts\/verification\/sign-off\.ts --range/u, "the one commit-records workflow runs the sign-off judge");
  assert.match(dco, /--range "\$GROUP_BASE\.\.\$GROUP_HEAD" --merge-group/u, "a merge group is read as one");
  assert.match(dco, /A `pull_request` run uses the BRANCH's copy/u, "the header states what it does not guarantee");
  // One owner: CI carries no second DCO job a trimmed branch could edit.
  assert.doesNotMatch(readFileSync(join(workflows, "ci.yml"), "utf8"), /sign-off\.ts/u);
});
