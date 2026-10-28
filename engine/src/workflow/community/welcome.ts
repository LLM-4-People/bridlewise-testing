/**
 * THE WELCOME AND THE THANK-YOU (github-only §10.3, §10.6): a first-time
 * contributor's first issue or pull request gets ONE comment, and their first
 * landed pull request gets ONE thank-you, each a reply template under its own
 * marker (`welcome-<n>`, `thanks-<n>`), so a re-run edits and never posts
 * twice.
 *
 * Who is "first" is GitHub's own count, asked through the search API (the
 * author's issues, pull requests or merged pull requests in this repository),
 * never guessed. `author_association` only chooses the greeting's words; it
 * authorises nothing. A bot is never greeted.
 *
 * Fork pull requests run CI on `pull_request` with a read-only token, so no
 * job triggered by one can comment: the pull-request welcome is a scheduled
 * pass over the open pull requests ({@link welcomeOpenPullRequests}), on
 * `main`'s code, never on a fork's.
 */
import { z } from "zod";

import { HarnessError } from "../../kernel/errors.ts";
import { upsertReply, type CommunityExecutor } from "./executor.ts";
import { readReplyTemplates, renderReply, type Reply } from "./replies.ts";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;

/** The words a greeting uses for an author association (GitHub's values); `null`: not a newcomer, no welcome. */
export function greetingFor(kind: "issue" | "pull_request", association: string): string | null {
  const thing = kind === "issue" ? "opening your first issue here" : "your first pull request here";
  switch (association) {
    case "FIRST_TIMER":
      return `${thing}, and your first contribution on GitHub`;
    case "FIRST_TIME_CONTRIBUTOR":
    case "NONE":
      return thing;
    default:
      return null;
  }
}

/** The welcome reply for a newcomer, or `null` (a bot, an unusual login, or an author who is no newcomer). */
export function welcomeReply(kind: "issue" | "pull_request", author: Readonly<{ login: string; type: string }>, association: string, repositoryUrl: string): Reply | null {
  if (author.type === "Bot" || !LOGIN.test(author.login)) return null;
  const greeting = greetingFor(kind, association);
  if (greeting === null) return null;
  return { key: kind === "issue" ? "welcome-issue" : "welcome-pull-request", slots: { author: author.login, greeting, repositoryUrl } };
}

const repoUrl = (executor: CommunityExecutor): string => `https://github.com/${executor.owner}/${executor.repository}`;

/** How many of `login`'s issues or pull requests in the repository match `qualifiers` (GitHub's search count). */
async function authoredCount(executor: CommunityExecutor, login: string, qualifiers: string): Promise<number> {
  const answer = await executor.client.rest<{ total_count?: unknown }>({
    method: "GET",
    path: "/search/issues",
    query: { q: `repo:${executor.owner}/${executor.repository} author:${login} ${qualifiers}`, per_page: 1 },
  });
  const count = answer.data.total_count;
  if (typeof count !== "number") throw new HarnessError("GitHub's search answered no total_count", "community_search_unreadable", false, { login });
  return count;
}

const USER = z.looseObject({ login: z.string(), type: z.string() });
const ISSUE_OPENED = z.looseObject({
  action: z.string(),
  issue: z.looseObject({ number: z.number().int().positive(), user: USER, author_association: z.string(), pull_request: z.unknown().optional() }),
});

export type WelcomeOutcome = Readonly<{ kind: "ignored"; why: string }> | Readonly<{ kind: "welcomed"; number: number; replyId: number; created: boolean }>;

/** Welcome the author of an `issues: opened` event when it is their first issue or pull request here. */
export async function welcomeIssue(executor: CommunityExecutor, payload: unknown): Promise<WelcomeOutcome> {
  const parsed = ISSUE_OPENED.safeParse(payload);
  if (!parsed.success) throw new HarnessError(`the issue event is not one this executor reads: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`, "community_event_invalid");
  const { action, issue } = parsed.data;
  if (action !== "opened" || issue.pull_request !== undefined) return Object.freeze({ kind: "ignored", why: "not an opened issue" });
  const reply = welcomeReply("issue", issue.user, issue.author_association, repoUrl(executor));
  if (reply === null) return Object.freeze({ kind: "ignored", why: "not a newcomer" });
  if ((await authoredCount(executor, issue.user.login, "")) > 1) return Object.freeze({ kind: "ignored", why: "not their first issue or pull request" });
  const answers = `welcome-${String(issue.number)}`;
  const posted = await upsertReply(executor, issue.number, answers, renderReply(readReplyTemplates(executor.repositoryRoot), reply, answers));
  return Object.freeze({ kind: "welcomed", number: issue.number, replyId: posted.id, created: posted.created });
}

const OPEN_PULL = z.looseObject({ number: z.number().int().positive(), user: USER, author_association: z.string() });

/** Welcome every open pull request whose author is a newcomer (the scheduled pass; see the header). */
export async function welcomeOpenPullRequests(executor: CommunityExecutor, maxPages: number): Promise<readonly WelcomeOutcome[]> {
  const pulls = await executor.client.paginate<unknown>({ path: `/repos/${executor.owner}/${executor.repository}/pulls`, query: { state: "open" } }, { maxPages, perPage: 100 });
  const templates = readReplyTemplates(executor.repositoryRoot);
  const outcomes: WelcomeOutcome[] = [];
  for (const raw of pulls) {
    const pull = OPEN_PULL.parse(raw);
    const reply = welcomeReply("pull_request", pull.user, pull.author_association, repoUrl(executor));
    if (reply === null) continue;
    const answers = `welcome-${String(pull.number)}`;
    const posted = await upsertReply(executor, pull.number, answers, renderReply(templates, reply, answers));
    outcomes.push(Object.freeze({ kind: "welcomed", number: pull.number, replyId: posted.id, created: posted.created }));
  }
  return outcomes;
}

/**
 * Thank every first-time author whose pull request landed as `sha` (the
 * `push` to the trunk): the merged pull requests GitHub associates with the
 * commit, each thanked by {@link thankFirstLanding}.
 */
export async function thankLandedCommit(executor: CommunityExecutor, sha: string): Promise<readonly WelcomeOutcome[]> {
  const pulls = await executor.client.rest<readonly { number?: unknown; merge_commit_sha?: unknown }[]>({ method: "GET", path: `/repos/${executor.owner}/${executor.repository}/commits/${sha}/pulls` });
  const landed = pulls.data.filter((pull) => pull.merge_commit_sha === sha && typeof pull.number === "number").map((pull) => pull.number as number);
  const outcomes: WelcomeOutcome[] = [];
  for (const number of landed) outcomes.push(await thankFirstLanding(executor, number));
  return outcomes;
}

/** Thank the author of merged pull request `number` when it is their first to land here. */
export async function thankFirstLanding(executor: CommunityExecutor, number: number): Promise<WelcomeOutcome> {
  const pull = await executor.client.rest<{ merged?: unknown; user?: { login?: unknown; type?: unknown } }>({ method: "GET", path: `/repos/${executor.owner}/${executor.repository}/pulls/${String(number)}` });
  const login = pull.data.user?.login;
  const type = pull.data.user?.type;
  if (pull.data.merged !== true) return Object.freeze({ kind: "ignored", why: "not merged" });
  if (typeof login !== "string" || typeof type !== "string" || type === "Bot" || !LOGIN.test(login)) return Object.freeze({ kind: "ignored", why: "a bot or an unreadable author" });
  if ((await authoredCount(executor, login, "is:pr is:merged")) !== 1) return Object.freeze({ kind: "ignored", why: "not their first landed pull request" });
  const answers = `thanks-${String(number)}`;
  const reply: Reply = { key: "thanks-first-landing", slots: { author: login, repositoryUrl: repoUrl(executor) } };
  const posted = await upsertReply(executor, number, answers, renderReply(readReplyTemplates(executor.repositoryRoot), reply, answers));
  return Object.freeze({ kind: "welcomed", number, replyId: posted.id, created: posted.created });
}
