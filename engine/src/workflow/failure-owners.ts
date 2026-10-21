/**
 * THE TRACKER'S ONE PARSER — its records, its board, and which named task owns
 * a test that fails on the target.
 *
 * THE RECORDS (github-only §9.1). Every task is one STRUCTURED ITEM,
 * `docs/trackers/items/<id>.md` (`TRACKER_BOARD.items`): a front matter of the
 * `bridlewise-tracker-item/v1` fields ({@link trackerItemViolations}) and a
 * Markdown body. The id is written once, when the item is created; it is
 * content, never generated. One file per item, so concurrent writers never
 * meet on one table. The same front-matter reader ({@link parseFrontMatter})
 * reads the workflow lessons and the decisions (scripts/verification/tracker-entries.ts).
 *
 * THE BOARD. `docs/trackers/TASKS.md` carries the items as rows inside ONE
 * generated block (`TRACKER_BOARD`), rendered by {@link renderTrackerBoard}
 * and kept current by `harness sync` ({@link syncTrackerBoard}); `harness check`
 * fails a stale board. Every guard that reads task rows keeps reading the
 * board through {@link taskRows}, so a row is exactly its item.
 *
 * WHO OWNS A FAILURE. The user's standing policy for a land: zero NEW
 * failures, and every remaining failure owned by a named task. The workspace's
 * ledger judge (src/workflow/workspace-manager.ts) reads this answer for every
 * failure that persists from the target's recorded run: a persisting failure an
 * OPEN task row owns is accepted (named in the gate's output), one no open row
 * owns is refused. Nothing is re-run and nothing else decides (UR-17: one
 * judgement).
 *
 * THE ROW GRAMMAR (the tracker `ROOT_POLICY.workflow.failureOwners.tracker`):
 * a task is a list item `- [ ] **<TASK-ID>**` (open) or `- [x] **<TASK-ID>**`
 * (closed) at any indentation; its text runs on over every following line
 * indented deeper than its dash. An open row OWNS what it DECLARES: the names
 * its text carries as whole tokens (`declaredNames`: split at whitespace,
 * quotes, backticks, brackets and list punctuation; a trailing `.`/`:` and a
 * `:<line>` suffix dropped) — a failing test's REPOSITORY path (`engine/test/…`,
 * `tests/…`), a budget's config key. Never a fragment: `tests/unit/a.test.tsx`
 * does not own `tests/unit/a.test.ts`, and a closed row or a prose mention owns
 * nothing.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { HarnessError, InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { schemaId } from "../kernel/product-identity.ts";
import { TRACKER_BOARD } from "../kernel/verification-paths.ts";

// ── Task rows ───────────────────────────────────────────────────────────────

/** One task row: its id, whether it is closed, and its whole text (the first line and its continuation lines). */
export type TaskRow = Readonly<{ id: string; done: boolean; text: string }>;

/** One open task row. */
export type OpenTaskRow = TaskRow;

const ROW = /^(\s*)- \[([ xX])\] \*\*([^*\n]+?)\*\*/u;

/** Every task row of a tracker's text, open and closed, in order. */
export function taskRows(trackerText: string): readonly TaskRow[] {
  const lines = trackerText.split("\n");
  const rows: TaskRow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = ROW.exec(lines[index]!);
    if (match === null) continue;
    const indent = match[1]!.length;
    const text = [lines[index]!];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]!;
      const lineIndent = line.length - line.trimStart().length;
      if (line.trim().length === 0 || lineIndent <= indent) break;
      text.push(line);
    }
    rows.push({ id: match[3]!, done: match[2] !== " ", text: text.join("\n") });
  }
  return deepFreeze(rows);
}

/** Every OPEN task row of a tracker's text, in order. */
export function openTaskRows(trackerText: string): readonly OpenTaskRow[] {
  return deepFreeze(taskRows(trackerText).filter((row) => !row.done));
}

/** The names a row declares: its text's whole tokens (see the header). */
export function declaredNames(row: TaskRow): ReadonlySet<string> {
  return new Set(row.text.split(/[\s`'"()[\]{}<>,;|*]+/u)
    .map((token) => token.replace(/:\d+(?:-\d+)?$/u, "").replace(/[.:!?]+$/u, ""))
    .filter((token) => token.length > 0));
}

/** The ids of the open rows that declare EVERY one of `names` (a test's repository path, a budget key; empty: nobody owns it). */
export function ownersOf(rows: readonly TaskRow[], ...names: readonly string[]): readonly string[] {
  return deepFreeze(rows.filter((row) => !row.done).filter((row) => {
    const declared = declaredNames(row);
    return names.every((name) => declared.has(name));
  }).map((row) => row.id));
}

// ── One-file-per-entry records: the front matter ───────────────────────────

/** The field names and values of one front matter, in file order. */
export type FrontMatter = ReadonlyMap<string, string>;

/**
 * The front matter of `text` (between a leading `---` line and the next), or
 * `null` when the text opens with none. `body` is everything after it;
 * `duplicates` names every field spelled twice (the first value is kept, and
 * the checker refuses the entry: a second spelling silently winning was how a
 * stale status could hide below a fresh one).
 */
export function parseFrontMatter(text: string): { readonly fields: FrontMatter; readonly body: string; readonly duplicates: readonly string[] } | null {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(text);
  if (match === null) return null;
  const fields = new Map<string, string>();
  const duplicates: string[] = [];
  for (const line of match[1]!.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (fields.has(name)) duplicates.push(name);
    else fields.set(name, line.slice(colon + 1).trim());
  }
  return { fields, body: text.slice(match[0].length), duplicates };
}

/** A `[a, b]` list value as its items; `null` when the value is not a bracketed list. */
export function listValue(value: string): readonly string[] | null {
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  return value.slice(1, -1).split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

type Condition = (fields: FrontMatter) => boolean;

/** What one field of a kind of entry must be. */
export type FieldRule = Readonly<{
  /** `true`: always required; a function: required exactly when it answers true. */
  required?: boolean | Condition;
  /** The field must be absent when this answers true. */
  forbiddenWhen?: Condition;
  /** An enumeration the value (or each list item) must belong to. */
  values?: readonly string[];
  /** A shape the value (or each list item) must match. */
  pattern?: RegExp;
  /** The value is a `[a, b]` list (at least one item when present). */
  list?: boolean;
  /** A further judgement of one value or item; returns the problem, or `null`. */
  check?: (item: string) => string | null;
}>;

/** A kind of entry: its fields and the Markdown sections its body must hold. */
export type EntrySchema = Readonly<{
  fields: Readonly<Record<string, FieldRule>>;
  sections?: readonly string[];
  /** A pattern the body must open with (e.g. a `# ` title). */
  bodyOpens?: RegExp;
  /** Refuse a field the schema does not name (a misspelt field is never silently ignored). */
  closed?: boolean;
}>;

/** Every way `text` breaks `schema`, each prefixed with `label`. */
export function entryViolations(label: string, text: string, schema: EntrySchema): readonly string[] {
  const parsed = parseFrontMatter(text);
  if (parsed === null) return [`${label}: no front matter`];
  const { fields, body, duplicates } = parsed;
  const problems: string[] = duplicates.map((name) => `${label}: ${name} is spelled twice`);
  if (schema.closed === true) for (const name of fields.keys()) if (schema.fields[name] === undefined) problems.push(`${label}: ${name} is not a field of this record`);
  for (const [name, rule] of Object.entries(schema.fields)) {
    const value = fields.get(name);
    const required = typeof rule.required === "function" ? rule.required(fields) : rule.required === true;
    if (value === undefined || value.length === 0) {
      if (required) problems.push(`${label}: ${name} is required`);
      continue;
    }
    if (rule.forbiddenWhen?.(fields) === true) {
      problems.push(`${label}: ${name} does not belong on this entry`);
      continue;
    }
    let items: readonly string[] = [value];
    if (rule.list === true) {
      const listed = listValue(value);
      if (listed === null || listed.length === 0) {
        problems.push(`${label}: ${name} must be a non-empty [a, b] list`);
        continue;
      }
      items = listed;
    }
    for (const item of items) {
      if (rule.values !== undefined && !rule.values.includes(item)) problems.push(`${label}: ${name} must be one of ${rule.values.join(", ")} (was ${item})`);
      else if (rule.pattern !== undefined && !rule.pattern.test(item)) problems.push(`${label}: ${name} ${item} does not match ${String(rule.pattern)}`);
      else {
        const problem = rule.check?.(item) ?? null;
        if (problem !== null) problems.push(`${label}: ${name} ${problem}`);
      }
    }
  }
  if (schema.bodyOpens !== undefined && !schema.bodyOpens.test(body)) problems.push(`${label}: the body must open with ${String(schema.bodyOpens)}`);
  for (const section of schema.sections ?? []) if (!`\n${body}`.includes(`\n${section}`)) problems.push(`${label}: missing ${section}`);
  return problems;
}

/** Each `.md` entry of `directory` (not its README) with its text. */
export function readEntries(root: string, directory: string): readonly { readonly name: string; readonly text: string }[] {
  return readdirSync(join(root, directory))
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
    .map((name) => ({ name, text: readFileSync(join(root, directory, name), "utf8") }));
}

// ── The structured tracker items ────────────────────────────────────────────

const TRACKER_ITEM_SCHEMA = schemaId("tracker-item", 1);
/** An item id: upper-case words and numbers joined by hyphens; the file is `<id>.md`. */
const TRACKER_ITEM_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/u;
/** The item types: each is the GitHub issue type its projection carries (github-only §9.2). */
const TRACKER_ITEM_TYPES = Object.freeze(["Workstream", "Task", "Bug", "Flake", "Lesson", "Risk", "Finding", "Security", "Intake"] as const);
const TRACKER_ITEM_STATES = Object.freeze(["open", "closed"] as const);
/** How a closed item closed: its projection's `state_reason`. */
const TRACKER_ITEM_RESOLUTIONS = Object.freeze(["completed", "not-planned", "duplicate"] as const);
const TRACKER_ITEM_SEVERITIES = Object.freeze(["P0", "P1", "P2", "P3"] as const);
/**
 * The board's lanes, in board order, with their section headings (the open
 * rows of a lane; every closed row is under `DONE_HEADING`). A heading is the
 * section name the roadmap's ROADMAP-PLAN `taskSections` state rules key on.
 */
const TRACKER_LANES = Object.freeze({
  floor: "Open",
  "flaky-burn-down": "Flaky burn-down owners",
  "private-web": "Private web lanes (retained as ordinary work)",
} as const);
const DONE_HEADING = "Done";

export type TrackerItemType = typeof TRACKER_ITEM_TYPES[number];
export type TrackerLane = keyof typeof TRACKER_LANES;

/** One structured tracker item, read from its file. */
export type TrackerItem = Readonly<{
  id: string;
  type: TrackerItemType;
  /** The display title; `null` when the id is the title. */
  title: string | null;
  state: typeof TRACKER_ITEM_STATES[number];
  resolution: typeof TRACKER_ITEM_RESOLUTIONS[number] | null;
  lane: TrackerLane;
  ownerRole: string | null;
  milestone: string | null;
  parent: string | null;
  blockedBy: readonly string[];
  relates: readonly string[];
  severity: typeof TRACKER_ITEM_SEVERITIES[number] | null;
  area: readonly string[];
  /** An `evidence:<path>` record link or an https URL. */
  evidence: string | null;
  /** The GitHub object the item adopted (`#<n>` or `discussion#<n>`), when it came in from GitHub. */
  gh: string | null;
  /** `YYYY-MM-DD`. */
  opened: string;
  closed: string | null;
  /** The Markdown body, its relative links written from the items folder. */
  body: string;
}>;

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
/** A value YAML reads back as the same plain string (the site reads item front matter as YAML). */
function yamlPlain(item: string): string | null {
  return /^[-?:,[\]{}#&*!|>'"%@`]|: | #|\s$/u.test(item) ? `${JSON.stringify(item)} is not a plain YAML scalar (no leading indicator, ": " or " #")` : null;
}

/**
 * Every way the item files `entries` (`<id>.md` with its text) break the
 * `bridlewise-tracker-item/v1` format, judged together: each file is named by
 * its id; `parent`, `blocked-by` and `relates` name OTHER items that exist;
 * no parent chain returns to its start; a closed item names how and when it
 * closed, an open one neither.
 */
export function trackerItemViolations(entries: readonly { readonly name: string; readonly text: string }[]): readonly string[] {
  const ids = new Set(entries.map(({ name }) => name.replace(/\.md$/u, "")));
  const parents = new Map<string, string>();
  const problems: string[] = [];
  for (const { name, text } of entries) {
    const id = name.replace(/\.md$/u, "");
    if (!name.endsWith(".md") || !TRACKER_ITEM_ID.test(id)) {
      problems.push(`${name}: an item file is named <ID>.md, its id upper-case words joined by hyphens`);
      continue;
    }
    const otherItem = (item: string): string | null => (item === id ? `${item} is this item itself` : ids.has(item) ? null : `${item} names no item`);
    const closed = (fields: FrontMatter): boolean => fields.get("state") === "closed";
    problems.push(...entryViolations(name, text, {
      closed: true,
      fields: {
        schema: { required: true, values: [TRACKER_ITEM_SCHEMA] },
        id: { required: true, values: [id] },
        type: { required: true, values: TRACKER_ITEM_TYPES },
        title: { check: yamlPlain },
        state: { required: true, values: TRACKER_ITEM_STATES },
        resolution: { required: closed, forbiddenWhen: (fields) => !closed(fields), values: TRACKER_ITEM_RESOLUTIONS },
        lane: { required: true, values: Object.keys(TRACKER_LANES) },
        "owner-role": { check: yamlPlain },
        milestone: { check: yamlPlain },
        parent: { pattern: TRACKER_ITEM_ID, check: otherItem },
        "blocked-by": { list: true, pattern: TRACKER_ITEM_ID, check: otherItem },
        relates: { list: true, pattern: TRACKER_ITEM_ID, check: otherItem },
        severity: { values: TRACKER_ITEM_SEVERITIES },
        area: { list: true, check: yamlPlain },
        evidence: { pattern: /^(?:evidence:\S+|https:\/\/\S+)$/u },
        gh: { pattern: /^(?:discussion)?#[1-9]\d*$/u },
        opened: { required: true, pattern: DATE },
        closed: { required: closed, forbiddenWhen: (fields) => !closed(fields), pattern: DATE },
      },
    }));
    const parsed = parseFrontMatter(text);
    if (parsed === null) continue;
    const opened = parsed.fields.get("opened") ?? "";
    const closedOn = parsed.fields.get("closed") ?? "";
    if (DATE.test(opened) && DATE.test(closedOn) && closedOn < opened) problems.push(`${name}: closed ${closedOn} is before opened ${opened}`);
    if (parsed.body.trim().length === 0) problems.push(`${name}: the body is empty`);
    const parent = parsed.fields.get("parent");
    if (parent !== undefined && parent.length > 0) parents.set(id, parent);
  }
  for (const start of parents.keys()) {
    const seen = new Set([start]);
    for (let next = parents.get(start); next !== undefined; next = parents.get(next)) {
      if (seen.has(next)) { problems.push(`${start}.md: its parent chain returns to ${next}`); break; }
      seen.add(next);
    }
  }
  return problems;
}

/** The items of `entries` (`<id>.md` with its text), in id order; refused whole (typed) when any breaks the format. */
export function trackerItems(entries: readonly { readonly name: string; readonly text: string }[]): readonly TrackerItem[] {
  const problems = trackerItemViolations(entries);
  if (problems.length > 0) throw new InputError(`the tracker items break ${TRACKER_ITEM_SCHEMA}:\n${problems.join("\n")}`, "tracker_item_invalid");
  return deepFreeze(entries.map(({ text }) => {
    const { fields, body } = parseFrontMatter(text)!;
    const optional = (name: string): string | null => fields.get(name) ?? null;
    const list = (name: string): readonly string[] => listValue(fields.get(name) ?? "[]") ?? [];
    return {
      id: fields.get("id")!,
      type: fields.get("type") as TrackerItemType,
      title: optional("title"),
      state: fields.get("state") as TrackerItem["state"],
      resolution: optional("resolution") as TrackerItem["resolution"],
      lane: fields.get("lane") as TrackerLane,
      ownerRole: optional("owner-role"),
      milestone: optional("milestone"),
      parent: optional("parent"),
      blockedBy: list("blocked-by"),
      relates: list("relates"),
      severity: optional("severity") as TrackerItem["severity"],
      area: list("area"),
      evidence: optional("evidence"),
      gh: optional("gh"),
      opened: fields.get("opened")!,
      closed: optional("closed"),
      body: body.replace(/^\n+|\n+$/gu, ""),
    };
  }).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)));
}

/** The items of the repository at `root` (`TRACKER_BOARD.items`); a tree without the folder has none. */
export function readTrackerItems(root: string): readonly TrackerItem[] {
  if (!existsSync(join(root, TRACKER_BOARD.items))) return deepFreeze([]);
  return trackerItems(readEntries(root, TRACKER_BOARD.items));
}

// ── The board ───────────────────────────────────────────────────────────────

const MARKDOWN_LINK = /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/gu;
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu;

/**
 * `markdown` with every relative link target written from `fromDirectory`
 * rewritten to the same file as seen from `toDirectory` (both
 * repository-relative folders): an item's body links from the items folder,
 * the board's row from the board's.
 */
export function rebaseRelativeLinks(markdown: string, fromDirectory: string, toDirectory: string): string {
  return markdown.replace(MARKDOWN_LINK, (whole, open: string, target: string, close: string) => {
    if (NOT_RELATIVE.test(target)) return whole;
    const hash = target.indexOf("#");
    const path = hash < 0 ? target : target.slice(0, hash);
    const rebased = posix.relative(toDirectory, posix.join(fromDirectory, path)) || ".";
    return `${open}${rebased}${hash < 0 ? "" : target.slice(hash)}${close}`;
  });
}

/** One item's board row: `- [ ] **<title or id>** — <body>`, its later body lines indented under the dash. */
export function itemRow(item: TrackerItem): string {
  const lines = rebaseRelativeLinks(item.body, TRACKER_BOARD.items, posix.dirname(TRACKER_BOARD.path)).split("\n").filter((line) => line.trim().length > 0);
  const head = `- [${item.state === "open" ? " " : "x"}] **${item.title ?? item.id}**`;
  return [lines.length === 0 ? head : `${head} — ${lines[0]!}`, ...lines.slice(1).map((line) => `  ${line}`)].join("\n");
}

/**
 * THE BOARD, generated from the items alone: one section per lane holding
 * open items (its {@link TRACKER_LANES} heading; oldest opened first), then
 * every closed item under `Done` (most recently closed first); ties by id.
 * It is the text between the `TRACKER_BOARD` markers; nothing in it is typed
 * by hand.
 */
export function renderTrackerBoard(items: readonly TrackerItem[]): string {
  const byId = (left: TrackerItem, right: TrackerItem): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const section = (heading: string, rows: readonly TrackerItem[]): string[] => (rows.length === 0 ? [] : [`## ${heading}\n\n${rows.map(itemRow).join("\n")}\n`]);
  const open = (Object.entries(TRACKER_LANES) as [TrackerLane, string][]).flatMap(([lane, heading]) =>
    section(heading, items.filter((item) => item.state === "open" && item.lane === lane).sort((left, right) => left.opened.localeCompare(right.opened) || byId(left, right))));
  const done = section(DONE_HEADING, items.filter((item) => item.state === "closed").sort((left, right) => right.closed!.localeCompare(left.closed!) || byId(left, right)));
  return [...open, ...done].join("\n");
}

/** The board file `text` with its generated block replaced by `board`, or `null` when it carries no (or a torn) block. */
export function withTrackerBoard(text: string, board: string): string | null {
  const begin = text.indexOf(TRACKER_BOARD.begin);
  const end = text.indexOf(TRACKER_BOARD.end);
  if (begin < 0 || end < begin) return null;
  return `${text.slice(0, begin + TRACKER_BOARD.begin.length)}\n\n${board}\n${text.slice(end)}`;
}

export type TrackerBoardReport = Readonly<{
  status: "current" | "regenerated" | "stale" | "absent";
  converged: boolean;
  changed: readonly string[];
}>;

/**
 * Judges (and with `write`, rewrites) the board of the repository at
 * `repositoryRoot` (`harness check` / `harness sync`). A tree without the
 * items folder (a product-only tree) is converged by absence; a board file
 * without its block is refused, never silently left ungenerated.
 */
export function syncTrackerBoard(repositoryRoot: string, write: boolean): TrackerBoardReport {
  const path = join(repositoryRoot, TRACKER_BOARD.path);
  if (!existsSync(join(repositoryRoot, TRACKER_BOARD.items))) return deepFreeze({ status: "absent", converged: true, changed: [] });
  const text = readFileSync(path, "utf8");
  const next = withTrackerBoard(text, renderTrackerBoard(readTrackerItems(repositoryRoot)));
  if (next === null) throw new HarnessError(`${TRACKER_BOARD.path} carries no generated board block (its begin and end markers, TRACKER_BOARD in src/kernel/verification-paths.ts)`, "tracker_board_block_missing");
  if (next === text) return deepFreeze({ status: "current", converged: true, changed: [] });
  if (!write) return deepFreeze({ status: "stale", converged: false, changed: [TRACKER_BOARD.path] });
  const written = atomicWriteFile(path, next);
  if (!written.success) throw new HarnessError(`Failed to write ${TRACKER_BOARD.path}: ${written.reason ?? "unknown error"}`, "tracker_board_write_failed");
  return deepFreeze({ status: "regenerated", converged: true, changed: [TRACKER_BOARD.path] });
}
