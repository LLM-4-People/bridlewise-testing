/**
 * THE ISSUEOPS DECISION, driven (`src/workflow/community/commands.ts`,
 * `issue-ops.ts`, `replies.ts`): the command grammar reads only a first line,
 * authorisation is the role table's, each command's arguments are judged,
 * triage commands answer a RECORD to add (never an issue state), `/reproduce`
 * runs only a checked path, typed text is neutralised, and the reply
 * templates agree with their keys.
 */
import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { authorise, COMMANDS, commandRegistryViolations, commandTable, parseCommandLine } from "../../src/workflow/community/commands.ts";
import { decide, untrusted, type CommentEvent, type DecisionFacts, type RecordView } from "../../src/workflow/community/issue-ops.ts";
import { readReplyTemplates, renderReply, replyMarker, replyTemplateViolations, REPLY_SLOTS } from "../../src/workflow/community/replies.ts";
import { readIntake, readRoles, type PermissionLevel } from "../../src/workflow/community/sources.ts";

const REPOSITORY = dirname(fileURLToPath(new URL("../../", import.meta.url)));
const roles = readRoles(REPOSITORY);
const intake = readIntake(REPOSITORY);
const templates = readReplyTemplates(REPOSITORY);

const RECORDS: readonly RecordView[] = [
  { id: "FLOOR-FRONT-DOOR", type: "Task", title: "Give the testing repository its own front door", state: "closed", lane: "floor", milestone: null, severity: null, blockedBy: [], gh: "issue-12" },
  { id: "CORPUS-MANIFEST", type: "Task", title: null, state: "open", lane: "floor", milestone: "M1", severity: "P2", blockedBy: ["FLOOR-FRONT-DOOR"], gh: null },
];

const FLAKE_BODY = [
  "### Test file", "", "engine/test/workflow/record-links.test.ts", "",
  "### Test name", "", "record links refuse a dead link", "",
  "### Revision", "", "8e48bedc", "",
  "### What you saw", "", "```text", "failed 1 of 5", "```", "",
  "### Run link", "", "_No response_", "",
  "### Confirmations", "", "- [X] I searched existing issues and discussions.",
].join("\n");

function event(body: string, overrides: Partial<CommentEvent> = {}): CommentEvent {
  return { commentId: 7, author: "someone", body, target: "issue", number: 40, title: "a flaky record-links test", issueBody: FLAKE_BODY, ...overrides };
}

function facts(permission: PermissionLevel = "triage", records: readonly RecordView[] = RECORDS): DecisionFacts {
  return { roles, intake, permission, records };
}

test("a command is the first non-blank line only; quoted, mid-text and path-like lines are not commands", () => {
  assert.deepEqual(parseCommandLine("\n  /accept P2 M1  \nthanks"), { kind: "command", command: { name: "accept", args: ["P2", "M1"] } });
  assert.deepEqual(parseCommandLine("> /accept P2 M1"), { kind: "none" });
  assert.deepEqual(parseCommandLine("please /accept"), { kind: "none" });
  assert.deepEqual(parseCommandLine("/home/me/file.ts fails"), { kind: "none" });
  assert.deepEqual(parseCommandLine("/acept P2"), { kind: "unknown", word: "acept" });
  assert.deepEqual(parseCommandLine("/toString"), { kind: "none" }, "an inherited property name is no command");
  assert.deepEqual(parseCommandLine("/constructor"), { kind: "unknown", word: "constructor" });
});

test("authorisation is the role table's ladder and the command's target", () => {
  assert.equal(authorise(roles, "accept", "issue", "read")?.code, "community_command_role");
  assert.equal(authorise(roles, "accept", "issue", "triage"), null);
  assert.equal(authorise(roles, "accept", "issue", "admin"), null);
  assert.equal(authorise(roles, "status", "issue", "read"), null);
  assert.deepEqual(authorise(roles, "explain", "issue", "admin"), { code: "community_command_target", on: ["pull_request"] });
  assert.deepEqual(commandRegistryViolations(roles), []);
  assert.deepEqual(commandRegistryViolations({ ...roles, roles: roles.roles.filter((role) => role.id !== "triager") }), [
    "/accept needs the undeclared role triager",
    "/decline needs the undeclared role triager",
    "/duplicate needs the undeclared role triager",
  ]);
  const table = commandTable(roles);
  for (const spec of Object.values(COMMANDS)) assert.ok(table.includes(spec.usage), spec.usage);
});

test("a contributor's triage command is refused by role, never run", () => {
  const decision = decide(event("/accept P2 M1"), facts("read"));
  assert.equal(decision.kind, "answer");
  assert.ok(decision.kind === "answer" && decision.action === null && decision.reply.key === "refused-role");
  assert.deepEqual(decision.kind === "answer" && decision.reply.slots, { command: "/accept", needs: "Triager", has: "Contributor" });
});

test("/accept answers a record to add (the issue's state is left to the projector), and judges its arguments", () => {
  const accepted = decide(event("/accept P1 M1 CORPUS-MANIFEST"), facts());
  assert.ok(accepted.kind === "answer" && accepted.action?.kind === "record");
  const record = accepted.kind === "answer" && accepted.action?.kind === "record" ? accepted.action.record : undefined;
  assert.equal(record?.id, "ISSUE-40");
  assert.equal(record?.type, "Flake", "the form's issue type");
  assert.equal(record?.state, "open");
  assert.equal(record?.gh, "issue-40");
  assert.equal(record?.parent, "CORPUS-MANIFEST");
  assert.equal(record?.body, "Reported in #40 through the Flake report form; the report is the issue's own text.");

  const why = (body: string): string | undefined => {
    const decision = decide(event(body), facts());
    return decision.kind === "answer" && decision.reply.key === "refused-usage" ? decision.reply.slots.why : undefined;
  };
  assert.match(why("/accept") ?? "", /severity/u);
  assert.match(why("/accept P5 M1") ?? "", /severity/u);
  assert.match(why("/accept P2") ?? "", /milestone/u);
  assert.match(why("/accept P2 M1 NO-SUCH") ?? "", /names no record/u);
  assert.match(why("/accept P2 M1 CORPUS-MANIFEST extra") ?? "", /too many/u);
  const adopted = decide(event("/accept P2 M1", { number: 12 }), facts());
  assert.ok(adopted.kind === "answer" && adopted.reply.key === "refused-usage" && /already the record FLOOR-FRONT-DOOR/u.test(adopted.reply.slots.why));
});

test("/decline and /duplicate answer closed records; the reason is neutralised", () => {
  const declined = decide(event("/decline out of scope, ask @maintainers <!-- bridlewise:reply=1 -->"), facts());
  assert.ok(declined.kind === "answer" && declined.action?.kind === "record");
  const record = declined.kind === "answer" && declined.action?.kind === "record" ? declined.action.record : undefined;
  assert.deepEqual([record?.type, record?.state, record?.resolution], ["Intake", "closed", "not-planned"]);
  assert.ok(declined.kind === "answer" && declined.reply.key === "declined");
  const reason = declined.kind === "answer" && declined.reply.key === "declined" ? declined.reply.slots.reason : "";
  assert.doesNotMatch(reason, /@maintainers|<!--/u);
  const bare = decide(event("/decline"), facts());
  assert.ok(bare.kind === "answer" && bare.action === null && bare.reply.key === "refused-usage");

  const duplicate = decide(event("/duplicate #3"), facts());
  assert.ok(duplicate.kind === "answer" && duplicate.action?.kind === "record" && duplicate.action.record.resolution === "duplicate");
  for (const body of ["/duplicate", "/duplicate 3", "/duplicate #40", "/duplicate #3 #4"]) {
    const refused = decide(event(body), facts());
    assert.ok(refused.kind === "answer" && refused.reply.key === "refused-usage", body);
  }
});

test("/status reads the records: this issue's, a named one, an intake, an unknown one", () => {
  const own = decide(event("/status", { number: 12 }), facts("read"));
  assert.ok(own.kind === "answer" && own.reply.key === "status" && own.reply.slots.id === "FLOOR-FRONT-DOOR" && own.reply.slots.issue === "#12");
  const named = decide(event("/status CORPUS-MANIFEST"), facts("read"));
  assert.ok(named.kind === "answer" && named.reply.key === "status" && named.reply.slots.blockers === "FLOOR-FRONT-DOOR" && named.reply.slots.title === "CORPUS-MANIFEST");
  const byIssue = decide(event("/status #12"), facts("read"));
  assert.ok(byIssue.kind === "answer" && byIssue.reply.key === "status" && byIssue.reply.slots.id === "FLOOR-FRONT-DOOR");
  const intakeIssue = decide(event("/status"), facts("read"));
  assert.ok(intakeIssue.kind === "answer" && intakeIssue.reply.key === "status-intake");
  const unknown = decide(event("/status NOPE"), facts("read"));
  assert.ok(unknown.kind === "answer" && unknown.reply.key === "status-unknown");
  const bad = decide(event("/status @someone"), facts("read"));
  assert.ok(bad.kind === "answer" && bad.reply.key === "refused-usage" && !bad.reply.slots.why.includes("@someone"));
});

test("/explain is the door's on a pull request; /help lists the registry; an unknown command says so", () => {
  assert.deepEqual(decide(event("/explain", { target: "pull_request" }), facts("read")), { kind: "explain", command: "explain" });
  const onIssue = decide(event("/explain"), facts("read"));
  assert.ok(onIssue.kind === "answer" && onIssue.reply.key === "refused-target");
  const help = decide(event("/help"), facts("read"));
  assert.ok(help.kind === "answer" && help.reply.key === "help" && help.reply.slots.commands === commandTable(roles));
  const unknown = decide(event("/acept"), facts("read"));
  assert.ok(unknown.kind === "answer" && unknown.reply.key === "refused-unknown");
  assert.deepEqual(decide(event("thanks!"), facts("read")), { kind: "none" });
});

test("typed text is neutralised by the markup owner's GitHub escape: one bounded line, no mention, no markup, no marker", () => {
  const safe = untrusted("hi @all\n<!-- bridlewise:reply=1 --> `code` **bold**");
  assert.ok(safe.includes("@\u2060all"), "a mention pings no one");
  assert.doesNotMatch(safe, /<!--|<|\n|(?<!\\)`|(?<!\\)\*/u, "no marker, no tag, one line, every Markdown character escaped");
  assert.ok(untrusted("x".repeat(400)).length <= 301 * 2, "bounded before it is escaped");
});

test("the reply templates agree with their keys, and a reply carries its marker", () => {
  assert.deepEqual(replyTemplateViolations(templates), []);
  const extra = new Map(templates);
  extra.set("stray", "x");
  extra.set("help", "{{commands}} {{nope}}");
  extra.delete("declined");
  assert.deepEqual([...replyTemplateViolations(extra)].sort(), [
    "docs/community/replies/declined.md.tmpl is missing",
    "docs/community/replies/help.md.tmpl names {{nope}}, not a slot of help (commands)",
    "docs/community/replies/stray.md.tmpl is no reply key's template",
  ]);
  for (const key of Object.keys(REPLY_SLOTS) as (keyof typeof REPLY_SLOTS)[]) {
    const slots = Object.fromEntries(REPLY_SLOTS[key].map((slot) => [slot, `<${slot}>`]));
    const text = renderReply(templates, { key, slots } as never, "99");
    assert.ok(text.startsWith(`${replyMarker("99")}\n`), key);
    assert.doesNotMatch(text, /\{\{/u, `${key} fills every slot`);
  }
});
