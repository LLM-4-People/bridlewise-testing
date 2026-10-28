/**
 * THE ISSUEOPS EXECUTOR: one comment event, carried out on the forge port
 * (`../forge/port.ts`). It reads what the decision needs — the commenter's
 * repository permission, the tracker records of this checkout, the door's
 * verdict for `/explain` — calls the pure {@link decide}, and posts or edits
 * the ONE reply that answers the comment (keyed by the reply marker, so a
 * re-delivered event edits instead of posting twice).
 *
 * What it never does: change an issue's state, labels, type or fields (the
 * projector is their one writer), execute anything a person typed, or act on
 * a comment a bot wrote (loop safety). A record action is LANDED FIRST, through
 * the caller's {@link RecordLanding} (a pull request), and the reply names that
 * pull request; with no landing the command is refused before anything is
 * posted (`community_record_landing_unavailable`), so no reply ever promises a
 * pull request that was not opened.
 */
import { z } from "zod";

import { HarnessError } from "../../kernel/errors.ts";
import { readTrackerItems } from "../failure-owners.ts";
import type { ForgeClient } from "../forge/port.ts";
import { decide, type CommandAction, type CommentEvent, type Decision, type IntakeRecord } from "./issue-ops.ts";
import { readReplyTemplates, renderReply, replyMarker, type Reply } from "./replies.ts";
import { PERMISSION_LEVELS, readIntake, readRoles, type PermissionLevel } from "./sources.ts";

/** The check run whose explanation `/explain` answers with (github-only §5.3: the door's one required check). */
export const DOOR_CHECK_NAME = "bridlewise/door";

export type CommunityExecutor = Readonly<{
  client: ForgeClient;
  owner: string;
  repository: string;
  /** The checkout whose records and sources the decision reads (`main`'s code, never a pull request's). */
  repositoryRoot: string;
  /** The login the replies are posted as (the publisher App's bot): only its comments are ever edited. */
  botLogin: string;
  /** The most comment pages read to find an earlier reply. */
  maxCommentPages: number;
}>;

const USER = z.looseObject({ login: z.string().min(1), type: z.string() });
const COMMENT_EVENT = z.looseObject({
  action: z.string(),
  comment: z.looseObject({ id: z.number().int().positive(), body: z.string().nullable(), user: USER, created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T/u) }),
  issue: z.looseObject({
    number: z.number().int().positive(),
    created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T/u),
    title: z.string(),
    body: z.string().nullable(),
    pull_request: z.unknown().optional(),
  }),
});

/**
 * Lands a triage command's record as a pull request and answers its URL
 * (`record.ts` `landIntakeRecord`, bound by the caller). `dates` are the
 * record's, from the event itself (no clock is read): the issue's creation
 * day and the command comment's.
 */
export type RecordLanding = (record: IntakeRecord, command: string, dates: Readonly<{ opened: string; closed: string }>) => Promise<Readonly<{ url: string }>>;

/** What one comment event came to. */
export type CommentOutcome =
  | Readonly<{ kind: "ignored"; why: "not-created" | "bot-author" | "no-command" }>
  | Readonly<{ kind: "answered"; command: string; replyId: number; created: boolean; action: CommandAction | null }>;

function invalidEvent(why: string): never {
  throw new HarnessError(`the comment event is not one this executor reads: ${why}`, "community_event_invalid");
}

const repoPath = (executor: CommunityExecutor): string => `/repos/${encodeURIComponent(executor.owner)}/${encodeURIComponent(executor.repository)}`;

/**
 * The repository permission of `login` (`GET …/collaborators/{u}/permission`):
 * GitHub's `role_name` when it is one of the five levels (it tells triage and
 * maintain apart), else its `permission`, where `none` is a reader's access.
 */
export async function permissionOf(executor: CommunityExecutor, login: string): Promise<PermissionLevel> {
  const answer = await executor.client.rest<{ permission?: unknown; role_name?: unknown }>({
    method: "GET",
    path: `${repoPath(executor)}/collaborators/${encodeURIComponent(login)}/permission`,
  });
  const levels: readonly string[] = PERMISSION_LEVELS;
  const role = answer.data.role_name;
  if (typeof role === "string" && levels.includes(role)) return role as PermissionLevel;
  const permission = answer.data.permission;
  if (permission === "none") return "read";
  if (typeof permission === "string" && levels.includes(permission)) return permission as PermissionLevel;
  throw new HarnessError(`GitHub answered no permission level for ${login}`, "community_permission_unreadable", false, { login });
}

/**
 * The ONE reply of `answers` on issue or pull request `number`: the bot's
 * comment carrying its marker is edited, or a new one is posted.
 */
export async function upsertReply(executor: CommunityExecutor, number: number, answers: string, body: string): Promise<Readonly<{ id: number; created: boolean }>> {
  const marker = replyMarker(answers);
  const comments = await executor.client.paginate<{ id: number; body?: string | null; user?: { login?: string } | null }>(
    { path: `${repoPath(executor)}/issues/${String(number)}/comments` },
    { maxPages: executor.maxCommentPages, perPage: 100 },
  );
  const earlier = comments.find((comment) => comment.user?.login === executor.botLogin && (comment.body ?? "").startsWith(marker));
  if (earlier !== undefined) {
    if (earlier.body !== body) await executor.client.rest({ method: "PATCH", path: `${repoPath(executor)}/issues/comments/${String(earlier.id)}`, body: { body } });
    return Object.freeze({ id: earlier.id, created: false });
  }
  const posted = await executor.client.rest<{ id: number }>({ method: "POST", path: `${repoPath(executor)}/issues/${String(number)}/comments`, body: { body } });
  return Object.freeze({ id: posted.data.id, created: true });
}

/** `/explain`'s reply: the door's check run on the pull request's head, or that it has none yet. */
async function explainReply(executor: CommunityExecutor, number: number): Promise<Reply> {
  const pull = await executor.client.rest<{ head?: { sha?: unknown } }>({ method: "GET", path: `${repoPath(executor)}/pulls/${String(number)}` });
  const sha = pull.data.head?.sha;
  if (typeof sha !== "string") throw new HarnessError(`pull request #${String(number)} answered no head commit`, "community_pull_unreadable");
  const runs = await executor.client.rest<{ check_runs?: readonly { conclusion?: string | null; status?: string; html_url?: string; output?: { title?: string | null; summary?: string | null } }[] }>({
    method: "GET",
    path: `${repoPath(executor)}/commits/${sha}/check-runs`,
    query: { check_name: DOOR_CHECK_NAME },
  });
  const run = runs.data.check_runs?.[0];
  if (run === undefined) return { key: "explain-unavailable", slots: { sha: sha.slice(0, 12), check: DOOR_CHECK_NAME } };
  return {
    key: "explain",
    slots: {
      check: DOOR_CHECK_NAME,
      verdict: run.conclusion ?? run.status ?? "unknown",
      title: run.output?.title ?? "(no title)",
      summary: run.output?.summary ?? "(the door wrote no summary)",
      url: run.html_url ?? "",
    },
  };
}

/** Carry out one `issue_comment` event (see the header). */
export async function handleCommentEvent(executor: CommunityExecutor, payload: unknown, landing?: RecordLanding): Promise<CommentOutcome> {
  const parsed = COMMENT_EVENT.safeParse(payload);
  if (!parsed.success) invalidEvent(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  const { action, comment, issue } = parsed.data;
  if (action !== "created") return Object.freeze({ kind: "ignored", why: "not-created" });
  if (comment.user.type === "Bot" || comment.user.login === executor.botLogin) return Object.freeze({ kind: "ignored", why: "bot-author" });
  const event: CommentEvent = {
    commentId: comment.id,
    author: comment.user.login,
    body: comment.body ?? "",
    target: issue.pull_request === undefined ? "issue" : "pull_request",
    number: issue.number,
    title: issue.title,
    issueBody: issue.body ?? "",
  };
  const root = executor.repositoryRoot;
  // The cheap pure pass first: a comment that carries no command costs no request.
  const roles = readRoles(root);
  const intake = readIntake(root);
  const probe = decide(event, { roles, intake, permission: "read", records: [] });
  if (probe.kind === "none") return Object.freeze({ kind: "ignored", why: "no-command" });
  const decision: Decision = decide(event, { roles, intake, permission: await permissionOf(executor, event.author), records: readTrackerItems(root) });
  if (decision.kind === "none") return Object.freeze({ kind: "ignored", why: "no-command" });
  let reply = decision.kind === "explain" ? await explainReply(executor, event.number) : decision.reply;
  if (decision.kind === "answer" && decision.action?.kind === "record") {
    if (landing === undefined) {
      throw new HarnessError(`/${decision.command} adds a record through a pull request, and no record landing is configured: nothing was posted`, "community_record_landing_unavailable", false, { command: decision.command });
    }
    const pull = await landing(decision.action.record, `/${decision.command}`, { opened: issue.created_at.slice(0, 10), closed: comment.created_at.slice(0, 10) });
    reply = { ...reply, slots: { ...reply.slots, pull: pull.url } } as typeof reply;
  }
  const answers = String(event.commentId);
  const posted = await upsertReply(executor, event.number, answers, renderReply(readReplyTemplates(root), reply, answers));
  return Object.freeze({ kind: "answered", command: decision.command, replyId: posted.id, created: posted.created, action: decision.kind === "answer" ? decision.action : null });
}
