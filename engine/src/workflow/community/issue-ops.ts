/**
 * THE ISSUEOPS DECISION (github-only §9.1 inbound flows, §10.4): what one
 * comment's command means, as a pure function of the comment, the commenter's
 * permission, the issue it is on and the harness's records. It decides; it
 * writes nothing. The executor (on the forge port) posts the reply and runs
 * the action:
 *   - `record`: a tracker record to add through a pull request. The commands
 *     never change GitHub's issue state themselves: the record lands through
 *     the door, and the projector (the one writer of issue state) adopts or
 *     closes the issue from it;
 *   - `/explain`: the door's explanation of a pull request's verdict, which
 *     the executor reads from the door's check run.
 *
 * Every value a person typed reaches a reply only through {@link untrusted}:
 * no mention pings anyone, and no text can fake a bot marker.
 */
import { escapeGithubText } from "../../../../shared/markup.ts";
import { COMMANDS, authorise, commandTable, parseCommandLine, type CommandName, type CommandTarget } from "./commands.ts";
import type { Reply } from "./replies.ts";
import { type CommunityIntake, type CommunityRoles, type IssueForm, type PermissionLevel } from "./sources.ts";

/** The facts of a tracker record the decision reads (the tracker item reader's shape, structurally). */
export type RecordView = Readonly<{
  id: string;
  type: string;
  title: string | null;
  /** `null`: a record whose state the tracker derives (a milestone's). */
  state: "open" | "closed" | null;
  /** `null`: a record outside the board's lanes (a milestone). */
  lane: string | null;
  milestone: string | null;
  severity: string | null;
  blockedBy: readonly string[];
  /** The GitHub object the record adopted (`issue-<n>` or `discussion-<n>`, the tracker's spelling). */
  gh: string | null;
}>;

/** One command comment, as the event delivers it. */
export type CommentEvent = Readonly<{
  commentId: number;
  author: string;
  body: string;
  target: CommandTarget;
  /** The issue or pull request number. */
  number: number;
  /** The issue's own title and body (the form's answers). */
  title: string;
  issueBody: string;
}>;

export type DecisionFacts = Readonly<{
  roles: CommunityRoles;
  intake: CommunityIntake;
  /** The commenter's repository permission (`GET …/collaborators/{u}/permission`). */
  permission: PermissionLevel;
  records: readonly RecordView[];
}>;

/** A record the executor adds through a pull request (the tracker item format is the tracker's own writer's). */
export type IntakeRecord = Readonly<{
  id: string;
  type: string;
  title: string;
  state: "open" | "closed";
  resolution: "not-planned" | "duplicate" | null;
  severity: string | null;
  milestone: string | null;
  parent: string | null;
  /** `issue-<n>`: the issue the record adopts (the tracker's spelling). */
  gh: string;
  /** The record's body: where it came from (the report itself stays the issue's text). */
  body: string;
}>;

export type CommandAction = Readonly<{ kind: "record"; record: IntakeRecord }>;

/**
 * What a comment means: nothing (no command), or a reply and possibly an
 * action. `/explain`'s reply is the door's own explanation, which the
 * executor reads, so its decision carries the action and no reply.
 */
export type Decision =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "answer"; command: string; reply: Reply; action: CommandAction | null }>
  | Readonly<{ kind: "explain"; command: "explain" }>;

const SEVERITIES = Object.freeze(["P0", "P1", "P2", "P3"]);
/** The record pull request's slot before the executor lands it (the executor fills in its URL; it never posts this). */
const PULL_PENDING = "(the record's pull request)";
const RECORD_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/u;
const ISSUE_REF = /^#([1-9]\d*)$/u;
const MILESTONE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MAX_TYPED = 300;

/**
 * A value a person typed, made safe to quote in a bot reply: one line,
 * bounded, no `@` mention that pings, and no `<!--` that could fake a marker.
 */
export function untrusted(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  // The one markup owner's GitHub escape: no Markdown, no HTML (so no marker), no `@` that mentions anyone.
  return escapeGithubText(line.length > MAX_TYPED ? `${line.slice(0, MAX_TYPED)}…` : line);
}

/** How the tracker names issue `n` in a record's `gh` field. */
function issueRef(issue: number): string {
  return `issue-${String(issue)}`;
}

/** The id a record adopting issue `n` takes: stable, from the issue number, written once. */
function intakeRecordId(issue: number): string {
  return `ISSUE-${String(issue)}`;
}

/**
 * The answers of an issue-form body (GitHub renders each field as `### <label>`
 * then its value; an empty optional field as `_No response_`), keyed by the
 * form's field ids; `null` when `body` is not this form's (a required field's
 * heading is missing).
 */
function parseFormBody(form: IssueForm, body: string): ReadonlyMap<string, string | null> | null {
  const sections = new Map<string, string>();
  const parts = body.replace(/\r\n/gu, "\n").split(/^### /mu).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const heading = (newline < 0 ? part : part.slice(0, newline)).trim();
    if (!sections.has(heading)) sections.set(heading, newline < 0 ? "" : part.slice(newline + 1).trim());
  }
  const answers = new Map<string, string | null>();
  for (const field of form.fields) {
    const section = sections.get(field.label);
    if (section === undefined && field.required) return null;
    // A field with `render` comes back fenced (```text … ```): its answer is the fence's content.
    const value = section === undefined ? undefined : /^(`{3,})[^\n]*\n([\s\S]*?)\n?\1$/u.exec(section)?.[2] ?? section;
    answers.set(field.id, value === undefined || value === "_No response_" || value.trim().length === 0 ? null : value);
  }
  return answers;
}

/** The intake form `body` answers (the first form whose required headings it carries), with its answers. */
export function intakeFormOf(intake: CommunityIntake, body: string): Readonly<{ form: IssueForm; answers: ReadonlyMap<string, string | null> }> | null {
  for (const form of intake.issueForms) {
    const answers = parseFormBody(form, body);
    if (answers !== null) return Object.freeze({ form, answers });
  }
  return null;
}

function reply(command: string, value: Reply, action: CommandAction | null = null): Decision {
  return Object.freeze({ kind: "answer", command, reply: value, action });
}

function usage(name: CommandName, why: string): Decision {
  return reply(name, { key: "refused-usage", slots: { command: `/${name}`, usage: COMMANDS[name].usage, why } });
}

function recordOf(event: CommentEvent, facts: DecisionFacts): RecordView | undefined {
  return facts.records.find((record) => record.gh === issueRef(event.number));
}

/**
 * The record body: where it came from, never the reporter's text. That text
 * stays the issue's own (GitHub-owned, above the projector's marker), so the
 * record carries no unreviewed prose, link or secret a person pasted.
 */
function intakeBody(event: CommentEvent, facts: DecisionFacts): string {
  const form = intakeFormOf(facts.intake, event.issueBody)?.form;
  return `Reported in #${String(event.number)}${form === undefined ? "" : ` through the ${form.name} form`}; the report is the issue's own text.`;
}

function decideStatus(event: CommentEvent, facts: DecisionFacts, args: readonly string[]): Decision {
  if (args.length > 1) return usage("status", "name one record or one issue");
  const named = args[0];
  const record = named === undefined
    ? recordOf(event, facts)
    : RECORD_ID.test(named)
      ? facts.records.find((candidate) => candidate.id === named)
      : ISSUE_REF.test(named)
        ? facts.records.find((candidate) => candidate.gh === issueRef(Number(named.slice(1))))
        : null;
  if (record === null) return usage("status", `${untrusted(named!)} is neither a record id nor #<n>`);
  if (record === undefined) {
    return named === undefined
      ? reply("status", { key: "status-intake", slots: { issue: `#${String(event.number)}` } })
      : reply("status", { key: "status-unknown", slots: { target: untrusted(named) } });
  }
  return reply("status", {
    key: "status",
    slots: {
      id: record.id,
      title: record.title ?? record.id,
      type: record.type,
      state: record.state ?? "derived",
      lane: record.lane ?? "none",
      milestone: record.milestone ?? "none",
      severity: record.severity ?? "none",
      blockers: record.blockedBy.length === 0 ? "none" : record.blockedBy.join(", "),
      issue: record.gh === null ? "not projected yet" : record.gh.replace(/^issue-/u, "#").replace(/^discussion-/u, "discussion #"),
    },
  });
}

function decideIntake(name: "accept" | "decline" | "duplicate", event: CommentEvent, facts: DecisionFacts, args: readonly string[]): Decision {
  const existing = recordOf(event, facts);
  if (existing !== undefined) return usage(name, `this issue is already the record ${existing.id}`);
  const id = intakeRecordId(event.number);
  const base = { id, title: event.title.trim().length > 0 ? event.title.trim() : id, gh: issueRef(event.number), body: intakeBody(event, facts) };
  if (name === "accept") {
    const [severity, milestone, parent, ...rest] = args;
    if (severity === undefined || !SEVERITIES.includes(severity)) return usage(name, "the first argument is the severity, P0 to P3");
    if (milestone === undefined || !MILESTONE.test(milestone)) return usage(name, "the second argument is the milestone (for example M1)");
    if (rest.length > 0) return usage(name, "too many arguments");
    if (parent !== undefined && !facts.records.some((record) => record.id === parent)) return usage(name, `the parent ${untrusted(parent)} names no record`);
    const type = intakeFormOf(facts.intake, event.issueBody)?.form.type ?? "Task";
    return reply(name, { key: "accepted", slots: { id, type, severity, milestone, parent: parent ?? "none", pull: PULL_PENDING } }, {
      kind: "record",
      record: Object.freeze({ ...base, type, state: "open", resolution: null, severity, milestone, parent: parent ?? null }),
    });
  }
  if (name === "decline") {
    if (args.length === 0) return usage(name, "say why, so the reporter knows");
    const reason = untrusted(args.join(" "));
    return reply(name, { key: "declined", slots: { id, reason, pull: PULL_PENDING } }, {
      kind: "record",
      record: Object.freeze({ ...base, type: "Intake", state: "closed", resolution: "not-planned", severity: null, milestone: null, parent: null, body: `${base.body} Declined: ${reason}` }),
    });
  }
  const original = args[0];
  if (args.length !== 1 || original === undefined || !ISSUE_REF.test(original) || original === `#${String(event.number)}`) return usage(name, "name the one other issue this duplicates, as #<n>");
  return reply(name, { key: "duplicate", slots: { id, original, pull: PULL_PENDING } }, {
    kind: "record",
    record: Object.freeze({ ...base, type: "Intake", state: "closed", resolution: "duplicate", severity: null, milestone: null, parent: null, body: `${base.body} Duplicate of ${original}.` }),
  });
}

/** What the comment `event` means, given `facts` (pure; see the header). */
export function decide(event: CommentEvent, facts: DecisionFacts): Decision {
  const line = parseCommandLine(event.body);
  if (line.kind === "none") return Object.freeze({ kind: "none" });
  if (line.kind === "unknown") return reply(`/${line.word}`, { key: "refused-unknown", slots: { word: untrusted(`/${line.word}`) } });
  const { name, args } = line.command;
  const refusal = authorise(facts.roles, name, event.target, facts.permission);
  if (refusal !== null) {
    return refusal.code === "community_command_target"
      ? reply(name, { key: "refused-target", slots: { command: `/${name}`, on: refusal.on.map((on) => (on === "issue" ? "an issue" : "a pull request")).join(" or ") } })
      : reply(name, { key: "refused-role", slots: { command: `/${name}`, needs: refusal.needs, has: refusal.has } });
  }
  switch (name) {
    case "help":
      return reply(name, { key: "help", slots: { commands: commandTable(facts.roles) } });
    case "status":
      return decideStatus(event, facts, args);
    case "accept":
    case "decline":
    case "duplicate":
      return decideIntake(name, event, facts, args);
    case "explain":
      return args.length > 0 ? usage(name, "it takes no argument") : Object.freeze({ kind: "explain", command: "explain" });
  }
}
