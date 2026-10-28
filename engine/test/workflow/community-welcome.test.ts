/**
 * THE WELCOME, THE THANK-YOU, CREDIT AND MODERATION, driven
 * (`src/workflow/community/welcome.ts`, `credit.ts`, `moderation.ts`): a
 * newcomer's first issue or pull request is welcomed once (GitHub's count
 * decides "first", `author_association` only the words, a bot never), a first
 * landed pull request is thanked once, credit is a pure function of the
 * commits with the tooling excluded, the spam signal follows its mode and
 * never applies a limit, and a closed issue's lock falls due on the declared
 * day — against the fake GitHub.
 */
import assert from "node:assert/strict";
import { cpSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HarnessError } from "../../src/kernel/errors.ts";
import { contributorsOf, landedCommits, releaseCredit, type CreditCommit } from "../../src/workflow/community/credit.ts";
import type { CommunityExecutor } from "../../src/workflow/community/executor.ts";
import { applyInteractionLimit, lockDue, MODERATION_PATH, readModeration, spamSignal, type Interaction } from "../../src/workflow/community/moderation.ts";
import { replyMarker } from "../../src/workflow/community/replies.ts";
import { greetingFor, thankFirstLanding, thankLandedRange, welcomeIssue, welcomeOpenPullRequests, welcomeReply } from "../../src/workflow/community/welcome.ts";
import { memoryCredential } from "../../src/workflow/forge/credentials.ts";
import { githubClient } from "../../src/workflow/forge/github.ts";
import { fakeGithub, type FakeGithub } from "../forge/fake-github.ts";
import { withTempDir } from "../support/temp-dir.ts";

const REPOSITORY = dirname(fileURLToPath(new URL("../../", import.meta.url)));
const BOT = "bridlewise-publisher[bot]";

type Comment = { id: number; body: string; user: { login: string } };

function setup(): { fake: FakeGithub; executor: CommunityExecutor; comments: (n: number) => Comment[]; searches: Map<string, number> } {
  const fake = fakeGithub();
  const lists = new Map<number, Comment[]>();
  const comments = (n: number): Comment[] => {
    if (!lists.has(n)) {
      lists.set(n, []);
      fake.objects.set(`/repos/o/r/issues/${String(n)}/comments`, lists.get(n));
    }
    return lists.get(n)!;
  };
  let nextId = 7000;
  fake.route("POST", /^\/repos\/o\/r\/issues\/(\d+)\/comments$/u, (request, match) => {
    const created = { id: nextId++, body: (request.body as { body: string }).body, user: { login: fake.principalOf(request) ?? "?" } };
    comments(Number(match[1])).push(created);
    return { status: 201, body: created };
  });
  const searches = new Map<string, number>();
  fake.route("GET", /^\/search\/issues$/u, (request) => {
    const q = request.query.get("q") ?? "";
    const count = [...searches.entries()].find(([needle]) => q.includes(needle))?.[1];
    return count === undefined ? { status: 422, body: { message: `unplanted search ${q}` } } : { status: 200, body: { total_count: count, items: [] } };
  });
  const client = githubClient(fake.endpoint(), memoryCredential(`app:${BOT}`, fake.userToken(BOT)));
  return { fake, comments, searches, executor: { client, owner: "o", repository: "r", repositoryRoot: REPOSITORY, botLogin: BOT, maxCommentPages: 5 } };
}

function opened(login: string, association: string, number = 50, type = "User"): unknown {
  return { action: "opened", issue: { number, user: { login, type }, author_association: association } };
}

test("the greeting's words follow the association; a regular, a bot or an odd login gets no welcome", () => {
  assert.match(greetingFor("issue", "FIRST_TIMER") ?? "", /first contribution on GitHub/u);
  assert.equal(greetingFor("pull_request", "FIRST_TIME_CONTRIBUTOR"), "your first pull request here");
  for (const association of ["CONTRIBUTOR", "COLLABORATOR", "MEMBER", "OWNER"]) assert.equal(greetingFor("issue", association), null, association);
  assert.equal(welcomeReply("issue", { login: "dependabot[bot]", type: "Bot" }, "NONE", "u"), null);
  assert.equal(welcomeReply("issue", { login: "x y", type: "User" }, "NONE", "u"), null);
});

test("a newcomer's first issue is welcomed once; a second issue, a regular and a bot are not", async () => {
  const { executor, comments, searches, fake } = setup();
  comments(50);
  searches.set("author:newbie", 1);
  const first = await welcomeIssue(executor, opened("newbie", "NONE"));
  assert.ok(first.kind === "welcomed" && first.created);
  assert.ok(comments(50)[0]!.body.startsWith(replyMarker("welcome-50")));
  assert.match(comments(50)[0]!.body, /Welcome, @newbie/u);
  const again = await welcomeIssue(executor, opened("newbie", "NONE"));
  assert.ok(again.kind === "welcomed" && !again.created, "a re-delivered event edits the one welcome");
  assert.equal(comments(50).length, 1);
  searches.set("author:returning", 3);
  assert.deepEqual(await welcomeIssue(executor, opened("returning", "NONE", 51)), { kind: "ignored", why: "not their first issue or pull request" });
  const requestsBefore = fake.requests.length;
  assert.deepEqual(await welcomeIssue(executor, opened("member", "MEMBER", 52)), { kind: "ignored", why: "not a newcomer" });
  assert.deepEqual(await welcomeIssue(executor, opened("renovate[bot]", "NONE", 53, "Bot")), { kind: "ignored", why: "not a newcomer" });
  assert.equal(fake.requests.length, requestsBefore, "a regular or a bot costs no request");
  await assert.rejects(welcomeIssue(executor, { action: "opened" }), (error: unknown) => error instanceof HarnessError && error.code === "community_event_invalid");
});

test("the scheduled pass welcomes each newcomer's open pull request once", async () => {
  const { executor, comments, fake } = setup();
  fake.objects.set("/repos/o/r/pulls", [
    { number: 60, user: { login: "fresh", type: "User" }, author_association: "FIRST_TIME_CONTRIBUTOR" },
    { number: 61, user: { login: "regular", type: "User" }, author_association: "CONTRIBUTOR" },
    { number: 62, user: { login: "dependabot[bot]", type: "Bot" }, author_association: "NONE" },
  ]);
  comments(60);
  const outcomes = await welcomeOpenPullRequests(executor, 5);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind === "welcomed" && outcome.number), [60]);
  assert.match(comments(60)[0]!.body, /DCO sign-off/u);
  await welcomeOpenPullRequests(executor, 5);
  assert.equal(comments(60).length, 1);
});

test("a first landed pull request is thanked once; a later one, an unmerged one and a bot's are not", async () => {
  const { executor, comments, searches, fake } = setup();
  fake.objects.set("/repos/o/r/pulls/70", { number: 70, merged: true, user: { login: "fresh", type: "User" } });
  fake.objects.set("/repos/o/r/pulls/71", { number: 71, merged: false, user: { login: "fresh", type: "User" } });
  fake.objects.set("/repos/o/r/pulls/72", { number: 72, merged: true, user: { login: "dependabot[bot]", type: "Bot" } });
  fake.objects.set("/repos/o/r/pulls/73", { number: 73, merged: true, user: { login: "veteran", type: "User" } });
  comments(70);
  searches.set("author:fresh is:pr is:merged", 1);
  searches.set("author:veteran is:pr is:merged", 9);
  const thanked = await thankFirstLanding(executor, 70);
  assert.ok(thanked.kind === "welcomed");
  assert.ok(comments(70)[0]!.body.startsWith(replyMarker("thanks-70")));
  assert.deepEqual(await thankFirstLanding(executor, 71), { kind: "ignored", why: "not merged" });
  assert.deepEqual(await thankFirstLanding(executor, 72), { kind: "ignored", why: "a bot or an unreadable author" });
  assert.deepEqual(await thankFirstLanding(executor, 73), { kind: "ignored", why: "not their first landed pull request" });
});

test("a push thanks the first-time authors of every pull request it landed, each once; a new branch is judged by its head", async () => {
  const { executor, comments, searches, fake } = setup();
  const [before, middle, after] = ["1".repeat(40), "2".repeat(40), "3".repeat(40)];
  fake.objects.set(`/repos/o/r/compare/${before}...${after}`, { commits: [{ sha: middle, author: null, commit: { message: "m" } }, { sha: after, author: null, commit: { message: "m" } }] });
  fake.objects.set(`/repos/o/r/commits/${middle}/pulls`, [{ number: 80, merge_commit_sha: middle }]);
  fake.objects.set(`/repos/o/r/commits/${after}/pulls`, [{ number: 81, merge_commit_sha: after }, { number: 80, merge_commit_sha: middle }]);
  fake.objects.set("/repos/o/r/pulls/80", { number: 80, merged: true, user: { login: "fresh", type: "User" } });
  fake.objects.set("/repos/o/r/pulls/81", { number: 81, merged: true, user: { login: "other", type: "User" } });
  comments(80);
  comments(81);
  searches.set("author:fresh is:pr is:merged", 1);
  searches.set("author:other is:pr is:merged", 1);
  const outcomes = await thankLandedRange(executor, before, after, 5);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind === "welcomed" && outcome.number), [80, 81], "every pull request of the range, once");
  const created = "0".repeat(40);
  fake.objects.set(`/repos/o/r/commits/${after}/pulls`, [{ number: 81, merge_commit_sha: after }]);
  const fromNewBranch = await thankLandedRange(executor, created, after, 5);
  assert.deepEqual(fromNewBranch.map((outcome) => outcome.kind === "welcomed" && outcome.number), [81]);
});

test("credit is by GitHub login, never by email: co-authors by their noreply login or name, the tooling never, newcomers per release", async () => {
  const commits: CreditCommit[] = [
    { sha: "a1", authorLogin: "ada", authorName: "Ada", message: "feat: x" },
    { sha: "a2", authorLogin: "bridlewise-agent[bot]", authorName: "bridlewise-agent[bot]", message: "feat: y\n\nCo-authored-by: Grace <123+grace@users.noreply.github.com>\nCo-authored-by: Linus <linus@example.invalid>\nCo-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>" },
    { sha: "a3", authorLogin: "Ada", authorName: "Ada Lovelace", message: "fix: z\n\nCo-authored-by: Ada <ada@example.invalid>" },
    { sha: "a4", authorLogin: "harness-agent", authorName: "Harness", message: "chore" },
  ];
  const people = contributorsOf(commits, new Set(["harness-agent"]));
  assert.deepEqual(people.map((person) => [person.login, person.name, person.commits]), [
    ["ada", "Ada Lovelace", ["a1", "a3"]],
    ["grace", "Grace", ["a2"]],
    [null, "Linus", ["a2"]],
    [null, "Ada", ["a3"]],
  ]);
  assert.doesNotMatch(JSON.stringify(people), /@/u, "no email in anything credit answers");
  const release = releaseCredit(commits.slice(0, 1), commits.slice(1), new Set(["harness-agent"]));
  assert.deepEqual(release.newcomers.map((person) => person.login ?? person.name), ["grace", "Linus", "Ada"]);
  assert.doesNotMatch(JSON.stringify(release), /@/u);
  // The commits come from GitHub with each author's login.
  const { fake, executor } = setup();
  fake.objects.set("/repos/o/r/compare/base...head", { commits: [{ sha: "c1", author: { login: "ada" }, commit: { author: { name: "Ada", email: "ada@example.invalid" }, message: "x" } }, { sha: "c2", author: null, commit: { author: { name: "Nobody" }, message: "y" } }] });
  const read = await landedCommits(executor.client, "o", "r", "base", "head", 5);
  assert.deepEqual(read, [{ sha: "c1", authorLogin: "ada", authorName: "Ada", message: "x" }, { sha: "c2", authorLogin: null, authorName: "Nobody", message: "y" }]);
  assert.doesNotMatch(JSON.stringify(read), /@/u, "the email GitHub answered is never kept");
});

test("moderation: the spam signal follows its mode and window, a lock falls due on the declared day, a limit is the maintainer's", async () => {
  const settings = readModeration(REPOSITORY);
  const asOf = "2026-10-22T12:00:00Z";
  const burst: Interaction[] = Array.from({ length: settings.interactionLimit.spamSignal.threshold }, (_, index) => ({
    kind: "comment", author: `new${String(index % 3)}`, at: "2026-10-22T10:00:00Z", authorCreatedAt: "2026-10-21T00:00:00Z",
  }));
  assert.deepEqual(spamSignal(settings, burst, asOf), { raised: true, action: "propose-limit", count: burst.length, authors: ["new0", "new1", "new2"] });
  assert.equal(spamSignal({ ...settings, interactionLimit: { ...settings.interactionLimit, mode: "manual" } }, burst, asOf).action, "report");
  assert.deepEqual(spamSignal({ ...settings, interactionLimit: { ...settings.interactionLimit, mode: "off" } }, burst, asOf), { raised: false, action: "none", count: burst.length, authors: ["new0", "new1", "new2"] });
  const old = burst.map((interaction) => ({ ...interaction, authorCreatedAt: "2020-01-01T00:00:00Z" }));
  assert.equal(spamSignal(settings, old, asOf).raised, false, "established accounts are no burst");
  const stale = burst.map((interaction) => ({ ...interaction, at: "2026-10-20T00:00:00Z" }));
  assert.equal(spamSignal(settings, stale, asOf).count, 0, "outside the window");
  assert.throws(() => spamSignal(settings, burst, "yesterday"), (error: unknown) => error instanceof HarnessError && error.code === "community_moderation_input_invalid");

  const closed = (days: number, stateReason: string | null, locked = false) => ({ closedAt: new Date(Date.parse(asOf) - days * 86_400_000).toISOString(), stateReason, locked });
  assert.equal(lockDue(settings, closed(settings.lockClosedAfterDays, "completed"), asOf), true);
  assert.equal(lockDue(settings, closed(settings.lockClosedAfterDays - 1, "completed"), asOf), false);
  assert.equal(lockDue(settings, closed(99, "not_planned"), asOf), true);
  assert.equal(lockDue(settings, closed(99, "duplicate"), asOf), false);
  assert.equal(lockDue(settings, closed(99, "completed", true), asOf), false);

  const fake = fakeGithub();
  fake.objects.set("/repos/o/r/interaction-limits", { limit: "none" });
  const maintainer = githubClient(fake.endpoint(), memoryCredential("user:maintainer", fake.userToken("maintainer")));
  await applyInteractionLimit(maintainer, "o", "r", { limit: "existing_users", expiry: "one_week" });
  assert.deepEqual(fake.objects.get("/repos/o/r/interaction-limits"), { limit: "existing_users", expiry: "one_week" });
  await applyInteractionLimit(maintainer, "o", "r", null);
  assert.equal(fake.objects.has("/repos/o/r/interaction-limits"), false);
  await assert.rejects(applyInteractionLimit(maintainer, "o", "r", { limit: "everyone" as never, expiry: "one_week" }), (error: unknown) => error instanceof HarnessError && error.code === "community_moderation_input_invalid");
});

test("the moderation source refuses what it cannot mean", () => {
  withTempDir("community-moderation-", (root) => {
    cpSync(join(REPOSITORY, "docs/community"), join(root, "docs/community"), { recursive: true });
    writeFileSync(join(root, MODERATION_PATH), JSON.stringify({ ...readModeration(root), interactionLimit: { mode: "auto", spamSignal: { windowHours: 1, newAccountDays: 1, threshold: 1 } } }));
    assert.throws(() => readModeration(root), (error: unknown) => error instanceof HarnessError && error.code === "community_source_invalid");
  });
});
