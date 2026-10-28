/**
 * THE DCO AT ITS TWO DOORS (scripts/verification/sign-off.ts): the commit-msg
 * question over a raw message, and CI's question over a range of commits.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
  const other = judge(root, "feat: a change\n\nSigned-off-by: Someone Else <else@example.invalid>\n", committer) ?? "";
  assert.match(other, /it carries <redacted [0-9a-f]{12}>/u);
  assert.doesNotMatch(other, /Someone Else|else@/u, "a refusal never echoes a person");
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

test("CI: a merge group is VERIFIED (its ref in GitHub's queue namespace, held at the head); only then do the queue's first-parent merges go unjudged", () => {
  const { root, git } = repository();
  const base = commit(git, root, "base.txt", `base\n\n${SIGNED}`);
  git(["checkout", "-q", "-b", "pr", base]);
  const unsigned = commit(git, root, "pr.txt", "a pull request's commit without a sign-off");
  git(["checkout", "-q", "main"]);
  // The queue's merge: unsigned, as GitHub makes it, on its own queue ref of the remote.
  git(["merge", "-q", "--no-ff", "--no-edit", "pr"], { GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" });
  const head = git(["rev-parse", "HEAD"]).trim();
  const remote = createTempDir("sign-off-remote-");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const queueRef = "refs/heads/gh-readonly-queue/main/pr-1-0000000000000000000000000000000000000000";
  git(["push", "-q", remote, `HEAD:${queueRef}`]);
  assert.deepEqual(unsignedCommits(root, `${base}..HEAD`, { mergeGroup: { ref: queueRef, remote } }).map((line) => line.slice(0, 12)), [unsigned.slice(0, 12)],
    "the queue's merge is not judged; the commit it brings in is");
  // Not the queue's namespace, or not held at the head: nothing is taken for the queue's.
  git(["push", "-q", remote, "HEAD:refs/heads/elsewhere"]);
  assert.match(unsignedCommits(root, `${base}..HEAD`, { mergeGroup: { ref: "refs/heads/elsewhere", remote } }).join("\n"), /not in GitHub's queue namespace/u);
  git(["push", "-q", "--force", remote, `${base}:${queueRef}`]);
  assert.match(unsignedCommits(root, `${base}..HEAD`, { mergeGroup: { ref: queueRef, remote } }).join("\n"), new RegExp(`does not hold the merge group's ref ${queueRef} at ${head.slice(0, 12)}`, "u"));
  // A plain commit on the chain is not the queue's.
  git(["push", "-q", "--force", remote, `HEAD:${queueRef}`]);
  const plain = commit(git, root, "plain.txt", "pushed onto the chain");
  git(["push", "-q", "--force", remote, `HEAD:${queueRef}`]);
  const refused = unsignedCommits(root, `${base}..HEAD`, { mergeGroup: { ref: queueRef, remote } });
  assert.ok(refused.some((line) => line.startsWith(`${plain.slice(0, 12)} is on the merge group's first-parent chain but is not a merge`)), refused.join("\n"));
});

test("identity trailers are judged by KEY (any -by key, any case): one carrying an address is exactly Name <address>; other keys keep their own grammar", () => {
  const { root } = repository();
  const committer = TEST_GIT_IDENTITY;
  // The review's plants: each was ACCEPTED when unreadable trailers were dropped.
  for (const trailer of ["Signed-off-by: person@example.invalid", "Signed-off-by: <person@example.invalid>", `Signed-off-by: ${committer.name} <${committer.email}> person@example.invalid`, "Reviewed-BY: person@example.invalid"]) {
    const refusal = judge(root, `feat: a change\n\n${SIGNED}\n${trailer}\n`, committer) ?? "";
    assert.match(refusal, /carries an address but is not exactly one "Name <address>"/u, `${trailer} was accepted`);
    assert.doesNotMatch(refusal, /person@/u, "a refusal never echoes the address");
  }
  // No address, no mailbox: a human's Reported-by passes; so do the binding Flake-cause trailer and a Link with an @.
  for (const trailer of ["Reported-by: Bob Smith", "Reported-by: @octocat", "Flake-cause: engine/test/x.test.ts::a case => engine/src/x.ts @ 0123456789abcdef0123456789abcdef01234567", "Link: https://example.com/@someone/a-post"]) {
    assert.equal(judge(root, `feat: a change\n\n${SIGNED}\n${trailer}\n`, committer), null, `${trailer} was refused`);
  }
  // Any case of a sign-off key is a sign-off (and is judged as one).
  assert.equal(judge(root, `feat: a change\n\nsigned-off-by: ${committer.name} <${committer.email}>\n`, committer), null);
});

test("agent commit: every -by key in any case, and any address anywhere in the NFKC-normalised message, must be the agent's — refused without echoing the person", () => {
  const { root } = repository();
  const agent = `Signed-off-by: ${AGENT.name} <${AGENT.email}>`;
  const person = `${PERSONAL.name} <${PERSONAL.email}>`;
  const plants: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["a lower-case sign-off", `feat: a change\n\n${agent}\nsigned-off-by: ${person}\n`, /signed-off-by trailer is <redacted [0-9a-f]{12}>/u],
    ["Signed-Off-By", `feat: a change\n\n${agent}\nSigned-Off-By: ${person}\n`, /Signed-Off-By trailer is <redacted [0-9a-f]{12}>/u],
    ["Reviewed-BY", `feat: a change\n\n${agent}\nReviewed-BY: ${person}\n`, /Reviewed-BY trailer is <redacted [0-9a-f]{12}>/u],
    ["Co-authored-by", `feat: a change\n\n${agent}\nCo-authored-by: ${person}\n`, /Co-authored-by trailer is <redacted [0-9a-f]{12}>/u],
    ["a Cc with an address", `feat: a change\n\n${agent}\nCc: ${person}\n`, /message names <redacted [0-9a-f]{12}>/u],
    ["a fullwidth ＠", `feat: a change\n\nreach me at person＠example.invalid\n\n${agent}\n`, /message names <redacted [0-9a-f]{12}>/u],
    ["a body-paragraph sign-off", `feat: a change\n\nSigned-off-by: ${person}\n\nmore prose\n\n${agent}\n`, /message names <redacted [0-9a-f]{12}>/u],
    ["\"Signed off by:\" with spaces", `feat: a change\n\nSigned off by: ${person}\n\n${agent}\n`, /message names <redacted [0-9a-f]{12}>/u],
    ["a bare address in the subject", `feat: thanks ${PERSONAL.email}\n\n${agent}\n`, /message names <redacted [0-9a-f]{12}>/u],
    ["a zero-width space beside the @", `feat: a change\n\nreach person\u200b@\u200bexample.invalid\n\n${agent}\n`, /message names <redacted [0-9a-f]{12}>/u],
    ["a soft hyphen beside the @", `feat: a change\n\nreach person\u00ad@example.invalid\n\n${agent}\n`, /message names <redacted [0-9a-f]{12}>/u],
    ["an ideographic full stop", `feat: a change\n\nreach person@example\u3002invalid\n\n${agent}\n`, /message names <redacted [0-9a-f]{12}>/u],
    ["an IDN domain", `feat: a change\n\nreach person@bücher.example\n\n${agent}\n`, /message names <redacted [0-9a-f]{12}>/u],
    ["a name-only Signed-off-by", `feat: a change\n\n${agent}\nSigned-off-by: Mia Keller\n`, /"Signed-off-by" trailer names someone other than the project's agent identity/u],
    ["a name-only Co-authored-by", `feat: a change\n\n${agent}\nCo-authored-by: Mia Keller\n`, /"Co-authored-by" trailer names someone other than the project's agent identity/u],
    ["an address in a comment line, kept by --cleanup=verbatim", `feat: a change\n\n${agent}\n# ------------------------ >8 ------------------------\n# person@example.invalid\n`, /message names <redacted [0-9a-f]{12}>/u],
  ];
  for (const [name, message, expected] of plants) {
    const refusal = judge(root, message, AGENT) ?? "";
    assert.match(refusal, expected, `${name} was accepted`);
    assert.doesNotMatch(refusal, /A Person|person|example\.invalid|mia|keller|bücher/iu, `${name}: a refusal never echoes the person, their mailbox or their domain`);
  }
  assert.equal(judge(root, `feat: a change\n\n${agent}\n`, AGENT), null, "the agent identity alone passes (liveness)");
});

test("agent identity: a lower-case sign-off or a Co-authored-by trailer carrying a person's address is refused on an agent commit", () => {
  const { root } = repository();
  const agent = `Signed-off-by: ${AGENT.name} <${AGENT.email}>`;
  assert.match(judge(root, `feat: a change\n\n${agent}\nsigned-off-by: ${PERSONAL.name} <${PERSONAL.email}>\n`, AGENT) ?? "", /signed-off-by trailer is <redacted [0-9a-f]{12}>/u);
  assert.match(judge(root, `feat: a change\n\n${agent}\nCo-authored-by: ${PERSONAL.name} <${PERSONAL.email}>\n`, AGENT) ?? "", /Co-authored-by trailer is <redacted [0-9a-f]{12}>/u);
  // On a human's commit, a co-author is theirs to name.
  assert.equal(judge(root, `feat: a change\n\n${SIGNED}\nCo-authored-by: ${PERSONAL.name} <${PERSONAL.email}>\n`, TEST_GIT_IDENTITY), null);
});

test("redaction: a refusal prints only this run's keyed token of an address — the same address the same token, another address another, never its domain", () => {
  const { root } = repository();
  const agent = `Signed-off-by: ${AGENT.name} <${AGENT.email}>`;
  const tokens = (text: string): readonly string[] => [...text.matchAll(/<redacted ([0-9a-f]{12})>/gu)].map((match) => match[1]!);
  const twice = judge(root, `feat: a\n\nperson@vanity-name.example and person@vanity-name.example\n\n${agent}\n`, AGENT) ?? "";
  const other = judge(root, `feat: a\n\nsomeone@vanity-name.example\n\n${agent}\n`, AGENT) ?? "";
  const first = judge(root, `feat: a\n\nperson@vanity-name.example\n\n${agent}\n`, AGENT) ?? "";
  assert.equal(tokens(twice).length, 1, "one address, one refusal");
  assert.deepEqual(tokens(first), tokens(twice), "the same address, the same token within a run");
  assert.notDeepEqual(tokens(other), tokens(first), "another address, another token");
  assert.doesNotMatch(`${twice}${other}`, /vanity|person|someone/u, "nothing of the address, its mailbox or its domain");
});

test("the range reader reads each message whole: a unit or record separator inside a message neither hides the rest nor leaks into the log", () => {
  const { root, git } = repository();
  const agentEnvironment = { GIT_AUTHOR_NAME: AGENT.name, GIT_AUTHOR_EMAIL: AGENT.email, GIT_COMMITTER_NAME: AGENT.name, GIT_COMMITTER_EMAIL: AGENT.email };
  const base = commit(git, root, "base.txt", `base\n\n${SIGNED}`);
  writeFileSync(join(root, "agent.txt"), "agent\n");
  git(["add", "--", "agent.txt"]);
  // A \x1f before the address (it used to end the field and hide the rest), a \x1e inside it (it used to start a "record").
  git(["commit", "-q", "--cleanup=verbatim", "-m", `feat: a change\n\nhidden\x1f person@example.invalid then perso\x1en@example.invalid\n\nSigned-off-by: ${AGENT.name} <${AGENT.email}>\n`], agentEnvironment);
  const refused = unsignedCommits(root, `${base}..HEAD`, { agentPullRequest: true });
  assert.ok(refused.some((line) => /message names <redacted [0-9a-f]{12}>/u.test(line)), refused.join("\n"));
  assert.doesNotMatch(refused.join("\n"), /person|example\.invalid/u, "nothing of the address reaches the log");
  assert.ok(refused.every((line) => /^[0-9a-f]{12}: /u.test(line)), "every line names a real commit");
});

test("a human's byte-exact `git commit -s` passes at BOTH doors whatever their name's spelling: a ZWNJ, an NFD accent, fullwidth letters", () => {
  for (const name of ["Mehr\u200cdad Example", "Jose\u0301 Example", "\uff2a\uff4f\uff53\uff45 Example"]) {
    const { root, git } = repository();
    const person = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: "human@example.invalid", GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: "human@example.invalid" };
    const base = commit(git, root, "base.txt", `base\n\n${SIGNED}`);
    writeFileSync(join(root, "human.txt"), "human\n");
    git(["add", "--", "human.txt"]);
    git(["commit", "-q", "-s", "-m", "a human's change"], person);
    assert.deepEqual(unsignedCommits(root, `${base}..HEAD`), [], `the range door refused ${JSON.stringify(name)}`);
    const identity = { name, email: "human@example.invalid" };
    assert.equal(judge(root, `a human's change\n\nSigned-off-by: ${name} <human@example.invalid>\n`, identity), null, `the hook refused ${JSON.stringify(name)}`);
  }
});

test("a hook run where git resolves no author refuses typed and clear (commit_identity_unreadable), never with git's raw failure", () => {
  const { root, git } = repository();
  git(["config", "user.useConfigOnly", "true"]);
  const saved = Object.fromEntries(["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL", "HOME", "XDG_CONFIG_HOME"].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(saved)) delete process.env[key];
  process.env["HOME"] = createTempDir("sign-off-no-identity-home-");
  process.env["XDG_CONFIG_HOME"] = process.env["HOME"];
  try {
    assert.throws(() => messageSignOffProblem(root, "a change\n"), (error: unknown) =>
      (error as { code?: unknown }).code === "commit_identity_unreadable" && /git names no (author|committer) here/u.test((error as Error).message));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the hook judges what git records: the -v diff below git's own scissors block is never recorded and not judged; any other text below a scissors line is", () => {
  const { root } = repository();
  const agent = `Signed-off-by: ${AGENT.name} <${AGENT.email}>`;
  const verbose = `feat: a change\n\n${agent}\n# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\n# Everything below it will be ignored.\ndiff --git a/x b/x\n+contact person@example.invalid\n`;
  assert.equal(judge(root, verbose, AGENT), null, "the -v diff is cut by git: an address in it is never published");
  const forged = `feat: a change\n\n${agent}\n# ------------------------ >8 ------------------------\n# person@example.invalid\n`;
  assert.match(judge(root, forged, AGENT) ?? "", /message names <redacted [0-9a-f]{12}>/u, "a comment below a bare scissors line is recorded under verbatim");
});

test("the redaction key is per run: two runs print different tokens for the same address", () => {
  const { root, git } = repository();
  const agentEnvironment = { GIT_AUTHOR_NAME: AGENT.name, GIT_AUTHOR_EMAIL: AGENT.email, GIT_COMMITTER_NAME: AGENT.name, GIT_COMMITTER_EMAIL: AGENT.email };
  const base = commit(git, root, "base.txt", `base\n\n${SIGNED}`);
  writeFileSync(join(root, "agent.txt"), "agent\n");
  git(["add", "--", "agent.txt"]);
  git(["commit", "-q", "-m", `feat: thanks person@example.invalid\n\nSigned-off-by: ${AGENT.name} <${AGENT.email}>\n`], agentEnvironment);
  const script = join(import.meta.dirname, "..", "..", "scripts", "verification", "sign-off.ts");
  const tokenOfRun = (): string => {
    const run = spawnSync(process.execPath, [script, "--range", `${base}..HEAD`], { cwd: root, encoding: "utf8" });
    const token = /<redacted ([0-9a-f]{12})>/u.exec(run.stderr)?.[1];
    assert.ok(token !== undefined, `the run printed no token: ${run.stderr}`);
    return token;
  };
  assert.notEqual(tokenOfRun(), tokenOfRun(), "a constant key would make a token a stable public handle of the address");
});

test("agent checkout: a commit made in a checkout the harness made for an agent must be the agent identity, whatever its marks", () => {
  const { root, git } = repository();
  assert.equal(isAgentCheckout(root), false, "a plain repository is no agent checkout");
  git(["config", AGENT_CHECKOUT_KEY, "true"]);
  assert.equal(isAgentCheckout(root), true);
  // The review's plant: committer, author and sign-off all a person's own — no agent mark at all.
  const refusal = judge(root, signedBy(PERSONAL), PERSONAL, PERSONAL, true) ?? "";
  assert.match(refusal, /agent commit and its author is <redacted [0-9a-f]{12}>/u);
  assert.ok(refusal.endsWith(`(this checkout is an agent's: its ${AGENT_CHECKOUT_KEY} is set, so user.name and user.email are ${AGENT.name} <${AGENT.email}>)`), refusal);
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
  assert.match(judge(root, signedBy(AGENT, PERSONAL), AGENT, AGENT) ?? "", /Signed-off-by trailer is <redacted [0-9a-f]{12}>, not the project's agent identity/u);
  assert.match(judge(root, signedBy(AGENT), AGENT, PERSONAL) ?? "", /author is <redacted [0-9a-f]{12}>/u);
  // A person's committer signing off as themselves, on a commit authored by the agent identity.
  assert.match(judge(root, signedBy(PERSONAL), PERSONAL, AGENT) ?? "", /committer is <redacted [0-9a-f]{12}>/u);
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
  assert.deepEqual(refused.map((line) => /its (\S+)(?: trailer)? is|its (message) names/u.exec(line)?.slice(1).find((role) => role !== undefined)), ["author", "committer", "Signed-off-by", "message"], "in an agent's pull request, a person's identity is refused, each role named");
  assert.equal(isAgentAccount(ROOT_POLICY.workflow.commitIdentity.agentAccounts[0]!), true);
  assert.equal(isAgentAccount("an-outside-contributor"), false);

  // An agent-identity commit carrying a person's extra sign-off is refused by its marks alone.
  const agentEnvironment = { GIT_AUTHOR_NAME: AGENT.name, GIT_AUTHOR_EMAIL: AGENT.email, GIT_COMMITTER_NAME: AGENT.name, GIT_COMMITTER_EMAIL: AGENT.email };
  writeFileSync(join(root, "agent.txt"), "agent\n");
  git(["add", "--", "agent.txt"]);
  git(["commit", "-q", "-m", signedBy(AGENT, PERSONAL)], agentEnvironment);
  const agentLines = unsignedCommits(root, "HEAD~1..HEAD");
  assert.equal(agentLines.length, 2, "the trailer, and the address its message names");
  assert.match(agentLines[0]!, /Signed-off-by trailer is <redacted [0-9a-f]{12}>/u);
  assert.match(agentLines[1]!, /its message names <redacted [0-9a-f]{12}>/u);
  assert.doesNotMatch(agentLines.join("\n"), /A Person|person@/u, "the range refusals never echo the person");
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
  assert.match(dco, /--range "\$GROUP_BASE\.\.\$GROUP_HEAD" --merge-group "\$GROUP_REF" --remote "\$SERVER\/\$REPOSITORY"/u, "a merge group is verified by its queue ref");
  assert.match(dco, /A `pull_request` run uses the BRANCH's copy/u, "the header states what it does not guarantee");
  // One owner: CI carries no second DCO job a trimmed branch could edit.
  assert.doesNotMatch(readFileSync(join(workflows, "ci.yml"), "utf8"), /sign-off\.ts/u);
});
