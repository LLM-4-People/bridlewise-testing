/**
 * THE ISSUEOPS COMMANDS (github-only §10.4): the ONE registry of the slash
 * commands people type in an issue or pull-request comment, the grammar that
 * reads one, and who may use it. The registry also generates the command
 * table of the community files and the `/help` reply, so a command is
 * declared once.
 *
 * Authorisation is the role table's (`sources.ts`): a commenter's role is the
 * one their repository permission reaches (`GET …/collaborators/{u}/permission`,
 * asked by the executor), never `author_association`, which has a TOCTOU flaw.
 * Every refusal is a typed answer the reply renders, never a silent ignore of a
 * command someone typed.
 */
import { COMMUNITY_LIMITS } from "./community-config.ts";
import { PERMISSION_LEVELS, roleForPermission, type CommunityRoles, type PermissionLevel } from "./sources.ts";

/** Where a command may be typed. */
export type CommandTarget = "issue" | "pull_request";

export type CommandSpec = Readonly<{
  /** The weakest role that may use it (a role id of the role table). */
  minimumRole: string;
  on: readonly CommandTarget[];
  usage: string;
  summary: string;
}>;

/** THE REGISTRY, in the order the help lists it. */
export const COMMANDS = Object.freeze({
  help: { minimumRole: "contributor", on: ["issue", "pull_request"], usage: "/help", summary: "list the commands and who may use them" },
  status: {
    minimumRole: "contributor",
    on: ["issue", "pull_request"],
    usage: "/status [<record-id> or #<n>]",
    summary: "the record's state, lane, milestone, severity and blockers, read from the harness's records (this issue's when none is named)",
  },
  accept: {
    minimumRole: "triager",
    on: ["issue"],
    usage: "/accept <P0-P3> <milestone> [<parent-id>]",
    summary: "adopt this intake issue: the harness opens a pull request adding its record; when that lands, the issue becomes the record's face",
  },
  decline: { minimumRole: "triager", on: ["issue"], usage: "/decline <reason>", summary: "record the intake as not planned, with the reason; the issue closes when that record lands" },
  duplicate: { minimumRole: "triager", on: ["issue"], usage: "/duplicate #<n>", summary: "record the intake as a duplicate of #n; the issue closes when that record lands" },
  explain: { minimumRole: "contributor", on: ["pull_request"], usage: "/explain", summary: "the door's explanation of this pull request's verdict: the failing gate, its evidence and its owning record" },
} as const satisfies Readonly<Record<string, CommandSpec>>);

export type CommandName = keyof typeof COMMANDS;

/** One parsed command line: the name and its whitespace-separated arguments. */
export type ParsedCommand = Readonly<{ name: CommandName; args: readonly string[] }>;

/** What a comment's first line says: no command, a known one, or a word that names no command. */
export type CommandLine = Readonly<{ kind: "none" }> | Readonly<{ kind: "command"; command: ParsedCommand }> | Readonly<{ kind: "unknown"; word: string }>;

/** A command word, then its arguments, on one bounded line (no unbounded run: the line is capped before it is matched). */
const COMMAND_LINE = /^\/([a-z][a-z-]{0,31})(?:[ \t]([^\r\n]{0,500}))?$/u;

/**
 * The command a comment carries: its FIRST line, and only when the comment
 * STARTS with `/` (the workflow's prefilter asks GitHub the same question, so
 * a comment that is no command costs no job). A command quoted (`> /accept`),
 * fenced, indented or mid-text is no command, so quoting someone never
 * re-runs what they typed.
 */
export function parseCommandLine(body: string): CommandLine {
  if (!body.startsWith("/")) return Object.freeze({ kind: "none" });
  const end = body.search(/\r?\n/u);
  const first = (end < 0 ? body : body.slice(0, end)).trimEnd();
  if (first.length > COMMUNITY_LIMITS.commandLineMaxLength) return Object.freeze({ kind: "none" });
  const match = COMMAND_LINE.exec(first);
  if (match === null) return Object.freeze({ kind: "none" });
  const word = match[1]!;
  if (!Object.hasOwn(COMMANDS, word)) return Object.freeze({ kind: "unknown", word });
  const args = (match[2] ?? "").split(/[ \t]+/u).filter((arg) => arg.length > 0);
  return Object.freeze({ kind: "command", command: Object.freeze({ name: word as CommandName, args: Object.freeze(args) }) });
}

/** Why a command may not run here, by whom: a refusal the reply names, or `null` when it may. */
export type CommandRefusal =
  | Readonly<{ code: "community_command_role"; needs: string; has: string }>
  | Readonly<{ code: "community_command_target"; on: readonly CommandTarget[] }>;

/**
 * Whether `permission` (the commenter's repository permission) may run
 * `name` on `target`. The command's minimum role must be a role of the table:
 * a registry naming an undeclared role is refused by {@link commandRegistryViolations}.
 */
export function authorise(roles: CommunityRoles, name: CommandName, target: CommandTarget, permission: PermissionLevel): CommandRefusal | null {
  const spec: CommandSpec = COMMANDS[name];
  if (!spec.on.includes(target)) return Object.freeze({ code: "community_command_target", on: spec.on });
  const has = roleForPermission(roles, permission);
  const needed = roles.roles.find((role) => role.id === spec.minimumRole)!;
  return PERMISSION_LEVELS.indexOf(has.permission) >= PERMISSION_LEVELS.indexOf(needed.permission)
    ? null
    : Object.freeze({ code: "community_command_role", needs: needed.title, has: has.title });
}

/** Every command whose minimum role the role table does not declare (an empty list when the registry and the table agree). */
export function commandRegistryViolations(roles: CommunityRoles): readonly string[] {
  const ids = new Set(roles.roles.map((role) => role.id));
  return Object.entries(COMMANDS).flatMap(([name, spec]) => (ids.has(spec.minimumRole) ? [] : [`/${name} needs the undeclared role ${spec.minimumRole}`]));
}

/** The command table (Markdown), for the generated community files and the `/help` reply. */
export function commandTable(roles: CommunityRoles): string {
  const titleOf = new Map(roles.roles.map((role) => [role.id, role.title]));
  const where = (on: readonly CommandTarget[]): string => on.map((target) => (target === "issue" ? "issue" : "pull request")).join(", ");
  return [
    "| Command | Where | Who | What it does |",
    "|---|---|---|---|",
    ...Object.values(COMMANDS).map((spec: CommandSpec) => `| \`${spec.usage}\` | ${where(spec.on)} | ${titleOf.get(spec.minimumRole) ?? spec.minimumRole} and above | ${spec.summary} |`),
  ].join("\n");
}
