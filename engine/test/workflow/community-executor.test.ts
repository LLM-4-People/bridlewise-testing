/**
 * THE ISSUEOPS EXECUTOR on the forge port, driven against the fake GitHub
 * (`src/workflow/community/executor.ts`): the commenter's permission decides,
 * one reply per command comment (a re-delivered event edits it), a bot's
 * comment and a plain comment cost no request, `/explain` reads the door's
 * check run, and no issue state is ever written.
 */
import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HarnessError } from "../../src/kernel/errors.ts";
import { DOOR_CHECK_NAME, handleCommentEvent, permissionOf, type CommunityExecutor } from "../../src/workflow/community/executor.ts";
import { replyMarker } from "../../src/workflow/community/replies.ts";
import { memoryCredential } from "../../src/workflow/forge/credentials.ts";
import { githubClient } from "../../src/workflow/forge/github.ts";
import { fakeGithub, type FakeGithub } from "../forge/fake-github.ts";

const REPOSITORY = dirname(fileURLToPath(new URL("../../", import.meta.url)));
const BOT = "bridlewise-publisher[bot]";

type Comment = { id: number; body: string; user: { login: string } };

function setup(): { fake: FakeGithub; executor: CommunityExecutor; comments: (n: number) => Comment[] } {
  const fake = fakeGithub();
  const lists = new Map<number, Comment[]>();
  const comments = (n: number): Comment[] => {
    if (!lists.has(n)) {
      lists.set(n, []);
      fake.objects.set(`/repos/o/r/issues/${String(n)}/comments`, lists.get(n));
    }
    return lists.get(n)!;
  };
  let nextId = 5000;
  fake.route("POST", /^\/repos\/o\/r\/issues\/(\d+)\/comments$/u, (request, match) => {
    const created = { id: nextId++, body: (request.body as { body: string }).body, user: { login: fake.principalOf(request) ?? "?" } };
    comments(Number(match[1])).push(created);
    return { status: 201, body: created };
  });
  fake.route("PATCH", /^\/repos\/o\/r\/issues\/comments\/(\d+)$/u, (request, match) => {
    for (const list of lists.values()) {
      const found = list.find((comment) => comment.id === Number(match[1]));
      if (found !== undefined) {
        found.body = (request.body as { body: string }).body;
        return { status: 200, body: found };
      }
    }
    return { status: 404, body: { message: "Not Found" } };
  });
  const client = githubClient(fake.endpoint(), memoryCredential(`app:${BOT}`, fake.userToken(BOT)));
  return { fake, comments, executor: { client, owner: "o", repository: "r", repositoryRoot: REPOSITORY, botLogin: BOT, maxCommentPages: 5 } };
}

function payload(body: string, overrides: Readonly<{ login?: string; type?: string; number?: number; pull?: boolean; id?: number; action?: string; issueBody?: string }> = {}): unknown {
  return {
    action: overrides.action ?? "created",
    comment: { id: overrides.id ?? 77, body, user: { login: overrides.login ?? "alice", type: overrides.type ?? "User" } },
    issue: {
      number: overrides.number ?? 40,
      title: "a flaky test",
      body: overrides.issueBody ?? "### Summary\n\nbroken",
      ...(overrides.pull === true ? { pull_request: { url: "x" } } : {}),
    },
  };
}

function grant(fake: FakeGithub, login: string, permission: string, roleName: string): void {
  fake.objects.set(`/repos/o/r/collaborators/${login}/permission`, { permission, role_name: roleName });
}

test("the permission answer maps GitHub's role names to the ladder, `none` to a reader", async () => {
  const { fake, executor } = setup();
  grant(fake, "t", "read", "triage");
  grant(fake, "m", "write", "maintain");
  grant(fake, "n", "none", "none");
  grant(fake, "w", "write", "write");
  assert.equal(await permissionOf(executor, "t"), "triage");
  assert.equal(await permissionOf(executor, "m"), "maintain");
  assert.equal(await permissionOf(executor, "n"), "read");
  assert.equal(await permissionOf(executor, "w"), "write");
  fake.objects.set("/repos/o/r/collaborators/x/permission", { permission: "owner-ish" });
  await assert.rejects(permissionOf(executor, "x"), (error: unknown) => error instanceof HarnessError && error.code === "community_permission_unreadable");
});

test("a plain comment, an edit and a bot's comment cost no request", async () => {
  const { fake, executor } = setup();
  assert.deepEqual(await handleCommentEvent(executor, payload("thanks, looks good")), { kind: "ignored", why: "no-command" });
  assert.deepEqual(await handleCommentEvent(executor, payload("/status", { action: "edited" })), { kind: "ignored", why: "not-created" });
  assert.deepEqual(await handleCommentEvent(executor, payload("/status", { login: "dependabot[bot]", type: "Bot" })), { kind: "ignored", why: "bot-author" });
  assert.deepEqual(await handleCommentEvent(executor, payload("/status", { login: BOT })), { kind: "ignored", why: "bot-author" });
  assert.equal(fake.requests.length, 0);
  await assert.rejects(handleCommentEvent(executor, { action: "created" }), (error: unknown) => error instanceof HarnessError && error.code === "community_event_invalid");
});

test("a command is answered once: a re-delivered event edits the same reply", async () => {
  const { fake, executor, comments } = setup();
  grant(fake, "alice", "read", "read");
  comments(40);
  const first = await handleCommentEvent(executor, payload("/status"));
  assert.ok(first.kind === "answered" && first.created && first.action === null);
  assert.equal(comments(40).length, 1);
  assert.ok(comments(40)[0]!.body.startsWith(replyMarker("77")));
  assert.match(comments(40)[0]!.body, /intake issue/u);
  comments(40)[0]!.body = `${replyMarker("77")}\nstale`;
  const again = await handleCommentEvent(executor, payload("/status"));
  assert.ok(again.kind === "answered" && !again.created && again.replyId === first.replyId);
  assert.equal(comments(40).length, 1);
  assert.match(comments(40)[0]!.body, /intake issue/u);
  // Someone else's comment carrying the marker is never edited.
  comments(41).push({ id: 9, body: `${replyMarker("78")}\nforged`, user: { login: "mallory" } });
  const fresh = await handleCommentEvent(executor, payload("/help", { number: 41, id: 78 }));
  assert.ok(fresh.kind === "answered" && fresh.created);
  assert.equal(comments(41).find((comment) => comment.id === 9)!.body, `${replyMarker("78")}\nforged`);
});

test("a reader's /accept is refused by role; a triager's answers a record and writes no issue state", async () => {
  const { fake, executor, comments } = setup();
  comments(40);
  grant(fake, "alice", "read", "read");
  const refused = await handleCommentEvent(executor, payload("/accept P2 M1"));
  assert.ok(refused.kind === "answered" && refused.action === null);
  assert.match(comments(40).at(-1)!.body, /needs the Triager role/u);
  grant(fake, "tess", "read", "triage");
  const before = comments(40).length;
  await assert.rejects(handleCommentEvent(executor, payload("/accept P2 M1", { login: "tess", id: 78 })), (error: unknown) => error instanceof HarnessError && error.code === "community_record_landing_unavailable");
  assert.equal(comments(40).length, before, "with no landing nothing is posted: no reply promises a pull request that was not opened");
  const landed: string[] = [];
  const landing = async (record: { id: string }, command: string) => { landed.push(`${command} ${record.id}`); return { url: "https://github.com/o/r/pull/900" }; };
  const accepted = await handleCommentEvent(executor, payload("/accept P2 M1", { login: "tess", id: 78 }), landing);
  assert.ok(accepted.kind === "answered" && accepted.action?.kind === "record" && accepted.action.record.id === "ISSUE-40");
  assert.deepEqual(landed, ["/accept ISSUE-40"], "the record lands before the reply");
  assert.match(comments(40).at(-1)!.body, /added by https:\/\/github\.com\/o\/r\/pull\/900/u);
  const writes = fake.requests.filter((request) => request.method !== "GET");
  assert.ok(writes.length > 0 && writes.every((request) => /^\/repos\/o\/r\/issues\/(?:\d+\/comments|comments\/\d+)$/u.test(request.path)), JSON.stringify(writes.map((request) => `${request.method} ${request.path}`)));
  assert.ok(!writes.some((request) => /\/issues\/40$|\/labels|\/assignees/u.test(request.path)), "no issue state is written");
});

test("/explain answers the door's check run on the pull request's head, or that there is none yet", async () => {
  const { fake, executor, comments } = setup();
  comments(56);
  grant(fake, "alice", "read", "read");
  fake.objects.set("/repos/o/r/pulls/56", { number: 56, head: { sha: "abcdef0123456789" } });
  fake.objects.set("/repos/o/r/commits/abcdef0123456789/check-runs", { total_count: 0, check_runs: [] });
  await handleCommentEvent(executor, payload("/explain", { number: 56, pull: true }));
  assert.match(comments(56).at(-1)!.body, new RegExp(`no \`${DOOR_CHECK_NAME}\` check run`, "u"));
  fake.objects.set("/repos/o/r/commits/abcdef0123456789/check-runs", {
    total_count: 1,
    check_runs: [{ conclusion: "failure", html_url: "https://example.invalid/run/1", output: { title: "1 gate red", summary: "engine-suite: 2 tests failed" } }],
  });
  await handleCommentEvent(executor, payload("/explain", { number: 56, pull: true }));
  const reply = comments(56).at(-1)!.body;
  assert.match(reply, /failure/u);
  assert.match(reply, /engine-suite: 2 tests failed/u);
  assert.equal(comments(56).length, 1, "the same command comment keeps one reply");
  const checkRequest = fake.requests.find((request) => request.path.endsWith("/check-runs"));
  assert.equal(checkRequest?.query.get("check_name"), DOOR_CHECK_NAME);
});
