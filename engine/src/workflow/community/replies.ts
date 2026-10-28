/**
 * THE BOT REPLIES: every text a community bot posts is a template in
 * `docs/community/replies/<key>.md.tmpl` (github-only §10.4: "the one source
 * of bot text"), rendered with the slots its key declares here. A reply
 * carries a marker naming what it answers, so re-running the same command
 * edits the same reply instead of posting a second one.
 *
 * {@link replyTemplateViolations} is the agreement between the code and the
 * folder: every key has its template, every template is a key's, and a
 * template names only its key's slots.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { escapeGithubText } from "../../../../shared/markup.ts";
import { InputError } from "../../kernel/errors.ts";
import { COMMUNITY_DIRECTORY } from "./sources.ts";

const REPLIES_DIRECTORY = `${COMMUNITY_DIRECTORY}/replies`;
const TEMPLATE_SUFFIX = ".md.tmpl";

/** Every reply key and the slots its template may name. */
export const REPLY_SLOTS = Object.freeze({
  help: ["commands"],
  status: ["id", "title", "type", "state", "lane", "milestone", "severity", "blockers", "issue"],
  "status-intake": ["issue"],
  "status-unknown": ["target"],
  accepted: ["id", "type", "severity", "milestone", "parent", "pull"],
  declined: ["id", "reason", "pull"],
  duplicate: ["id", "original", "pull"],
  explain: ["check", "verdict", "title", "summary", "url"],
  "explain-unavailable": ["check", "sha"],
  "refused-role": ["command", "needs", "has"],
  "refused-target": ["command", "on"],
  "refused-usage": ["command", "usage", "why"],
  "refused-unknown": ["word"],
  "welcome-issue": ["author", "greeting", "repositoryUrl"],
  "welcome-pull-request": ["author", "greeting", "repositoryUrl"],
  "thanks-first-landing": ["author", "repositoryUrl"],
} as const satisfies Readonly<Record<string, readonly string[]>>);

export type ReplyKey = keyof typeof REPLY_SLOTS;
export type ReplySlots<K extends ReplyKey> = Readonly<Record<(typeof REPLY_SLOTS)[K][number], string>>;

/** A reply to render: its key and its slots' values. */
export type Reply = { [K in ReplyKey]: Readonly<{ key: K; slots: ReplySlots<K> }> }[ReplyKey];

const SLOT = /\{\{([A-Za-z]+)\}\}/gu;

/** The reply templates of the repository at `repositoryRoot`, by key. */
export function readReplyTemplates(repositoryRoot: string): ReadonlyMap<string, string> {
  const directory = join(repositoryRoot, REPLIES_DIRECTORY);
  if (!existsSync(directory)) return new Map();
  return new Map(readdirSync(directory).filter((name) => name.endsWith(TEMPLATE_SUFFIX)).map((name) => [name.slice(0, -TEMPLATE_SUFFIX.length), readFileSync(join(directory, name), "utf8")]));
}

/** Every disagreement between {@link REPLY_SLOTS} and `templates` (empty when they agree). */
export function replyTemplateViolations(templates: ReadonlyMap<string, string>): readonly string[] {
  const problems: string[] = [];
  for (const key of Object.keys(REPLY_SLOTS)) if (!templates.has(key)) problems.push(`${REPLIES_DIRECTORY}/${key}${TEMPLATE_SUFFIX} is missing`);
  for (const [key, text] of templates) {
    if (!Object.hasOwn(REPLY_SLOTS, key)) {
      problems.push(`${REPLIES_DIRECTORY}/${key}${TEMPLATE_SUFFIX} is no reply key's template`);
      continue;
    }
    const known: readonly string[] = REPLY_SLOTS[key as ReplyKey];
    for (const [, slot] of text.matchAll(SLOT)) if (!known.includes(slot!)) problems.push(`${REPLIES_DIRECTORY}/${key}${TEMPLATE_SUFFIX} names {{${slot!}}}, not a slot of ${key} (${known.join(", ")})`);
  }
  return problems;
}

/**
 * EVERY slot value is escaped by the markup owner's GitHub escape
 * (`escapeGithubText`: no Markdown, no HTML, no `@` mention) unless it is
 * named here: the command table the harness itself renders, and a URL GitHub
 * itself answered (a pull request's, a check run's), which must be one.
 * Record text, a person's words, a check run's title and summary: all escaped.
 */
const RAW_SLOTS: Readonly<Record<string, "markdown" | "url">> = Object.freeze({
  "help.commands": "markdown",
  "accepted.pull": "url",
  "declined.pull": "url",
  "duplicate.pull": "url",
  "explain.url": "url",
});
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9._~/%-]{1,200}$/u;

/** The marker that keys a reply to what it answers (a comment id, or `welcome-<n>`): the executor edits a reply carrying it instead of posting another. */
export function replyMarker(answers: string): string {
  return `<!-- bridlewise:reply=${answers} -->`;
}

/** `reply` rendered from `templates`, headed by the marker of `answers`; a missing template is `community_reply_invalid`. */
export function renderReply(templates: ReadonlyMap<string, string>, reply: Reply, answers: string): string {
  const template = templates.get(reply.key);
  if (template === undefined) throw new InputError(`${REPLIES_DIRECTORY}/${reply.key}${TEMPLATE_SUFFIX} is missing`, "community_reply_invalid", { key: reply.key });
  const slots = reply.slots as Readonly<Record<string, string>>;
  const body = template.replace(SLOT, (whole, slot: string) => {
    const value = slots[slot];
    if (value === undefined) return whole;
    const kind = RAW_SLOTS[`${reply.key}.${slot}`];
    if (kind === undefined) return escapeGithubText(value);
    if (kind === "url" && !GITHUB_URL.test(value)) throw new InputError(`the ${reply.key} reply's ${slot} is no GitHub URL`, "community_reply_invalid", { key: reply.key, slot });
    return value;
  });
  return `${replyMarker(answers)}\n${body.trimEnd()}\n`;
}
