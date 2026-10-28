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
 * fails a stale board, and a row typed by hand outside the block. Every guard
 * that reads task rows reads the board through {@link boardRows} — only the
 * rows inside the block — so a row is exactly its item.
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

import type { TreeReader } from "../git/tree-reader.ts";

import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { HarnessError, InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { schemaId } from "../kernel/product-identity.ts";
import { relativePath } from "./markdown-links.ts";
import { decodeSiteText, escapeSiteText } from "../../../shared/markup.ts";
import { siteProse, type ProseTarget } from "./site-prose.ts";
import { DECISION_INDEX, spliceGeneratedBlock, splitGeneratedBlock, TRACKER_BOARD } from "../kernel/verification-paths.ts";

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
    // The board writes a title through the site escape (site-prose.ts): its row is read back as the text it shows.
    rows.push({ id: decodeSiteText(match[3]!), done: match[2] !== " ", text: text.join("\n") });
  }
  return deepFreeze(rows);
}

/**
 * THE BOARD'S ROWS — every task row of the board file's text, read ONLY
 * between its `TRACKER_BOARD` markers: a row typed by hand above or below
 * the generated block is no row (and `harness check` refuses it,
 * {@link syncTrackerBoard}), so every row a guard reads is an item's. A text
 * without the block is refused typed (`tracker_board_block_missing`). Every
 * reader of the tracker file reads rows through this.
 */
export function boardRows(boardText: string): readonly TaskRow[] {
  const split = splitGeneratedBlock(boardText, TRACKER_BOARD);
  if (split === null) throw new HarnessError(`${TRACKER_BOARD.path} carries no generated board block (its begin and end markers, TRACKER_BOARD in src/kernel/verification-paths.ts)`, "tracker_board_block_missing");
  return taskRows(split.body);
}

/** Every OPEN row of the board ({@link boardRows}), in order. */
export function openBoardRows(boardText: string): readonly OpenTaskRow[] {
  return deepFreeze(boardRows(boardText).filter((row) => !row.done));
}

/** The names a row declares: its text's whole tokens (see the header). */
export function declaredNames(row: TaskRow): ReadonlySet<string> {
  return new Set(decodeSiteText(row.text).split(/[\s`'"()[\]{}<>,;|*]+/u)
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

/** Whether a folder's file `name` is an entry: a `.md` file, not the folder's README. */
function isEntryName(name: string): boolean {
  return name.endsWith(".md") && name !== "README.md";
}

/** Each `.md` entry of `directory` (not its README) with its text. */
export function readEntries(root: string, directory: string): readonly { readonly name: string; readonly text: string }[] {
  return readdirSync(join(root, directory))
    .filter(isEntryName)
    .sort()
    .map((name) => ({ name, text: readFileSync(join(root, directory, name), "utf8") }));
}

// ── The structured tracker items ────────────────────────────────────────────

export const TRACKER_ITEM_SCHEMA = schemaId("tracker-item", 1);
/** An item id: upper-case words and numbers joined by hyphens; the file is `<id>.md`. */
const TRACKER_ITEM_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/u;
/**
 * The item types: each is the GitHub issue type its projection carries
 * (github-only §9.2). A `Milestone` is the roadmap's grouping: it has no lane
 * and no state of its own (its state is computed from its members,
 * src/workflow/tracker-status.ts), and items name it in `milestone`.
 */
const TRACKER_ITEM_TYPES = Object.freeze(["Milestone", "Workstream", "Task", "Bug", "Flake", "Lesson", "Risk", "Finding", "Security", "Intake"] as const);
/** How soon an open item is meant: a plan's order of intent, never a date. */
const TRACKER_HORIZONS = Object.freeze(["now", "next", "later"] as const);
const TRACKER_ITEM_STATES = Object.freeze(["open", "closed"] as const);
/** How a closed item closed: its projection's `state_reason`. */
const TRACKER_ITEM_RESOLUTIONS = Object.freeze(["completed", "not-planned", "duplicate"] as const);
const TRACKER_ITEM_SEVERITIES = Object.freeze(["P0", "P1", "P2", "P3"] as const);
/**
 * The board's lanes, in board order: each one's section heading (the open
 * rows of a lane; every closed row is under `DONE_HEADING`) and the
 * GitHub label its items carry (`lane:<lane>`, this colour and description;
 * the projector writes the label, src/workflow/forge/projector/).
 */
export const TRACKER_LANES = Object.freeze({
  floor: Object.freeze({ heading: "Open", color: "1d76db", description: "Tracker lane: the public floor's open work" }),
  roadmap: Object.freeze({ heading: "Roadmap", color: "0e8a16", description: "Tracker lane: a roadmap workstream, exit criterion or scope statement" }),
  "flaky-burn-down": Object.freeze({ heading: "Flaky burn-down owners", color: "d93f0b", description: "Tracker lane: owns an entry of a flaky burn-down list" }),
  "private-web": Object.freeze({ heading: "Private web lanes (retained as ordinary work)", color: "c5def5", description: "Tracker lane: a private web workstream kept as ordinary work" }),
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
  /** Open or closed; `null` for a Milestone (computed from its members). */
  state: typeof TRACKER_ITEM_STATES[number] | null;
  resolution: typeof TRACKER_ITEM_RESOLUTIONS[number] | null;
  /** The board lane; `null` for a Milestone. */
  lane: TrackerLane | null;
  ownerRole: string | null;
  milestone: string | null;
  parent: string | null;
  blockedBy: readonly string[];
  relates: readonly string[];
  severity: typeof TRACKER_ITEM_SEVERITIES[number] | null;
  area: readonly string[];
  /** An `evidence:<path>` record link, a repository document (`docs/…/page.md#anchor`) or an https URL. */
  evidence: string | null;
  /** The plan's rank among its siblings (lower first); `null` when unranked. */
  order: number | null;
  horizon: typeof TRACKER_HORIZONS[number] | null;
  /** The decision records the item carries out (`docs/decisions/`, by id). */
  decisions: readonly string[];
  /** The tests that prove it (repository paths). */
  tests: readonly string[];
  /** The RFC discussion that shapes it (`discussion-<n>`). */
  rfc: string | null;
  /** The GitHub object the item adopted (`issue-<n>` or `discussion-<n>`), when it came in from GitHub. */
  gh: string | null;
  /** `YYYY-MM-DD`. */
  opened: string;
  closed: string | null;
  /** The Markdown body, its relative links written from the items folder. */
  body: string;
}>;

/** A tracker date, `YYYY-MM-DD` (the one pattern every writer of an item checks against). */
export const DATE = /^\d{4}-\d{2}-\d{2}$/u;
/** A value YAML reads back as the same plain STRING (the site reads item front matter as YAML; a YAML 1.1 reader turns `No` into false). */
/** Why `item` is not a value YAML reads back as the same plain string (the site reads item front matter as YAML), or `null`. */
export function yamlPlain(item: string): string | null {
  if (/^[-?:,[\]{}#&*!|>'"%@`]|: | #|\s$/u.test(item)) return `${JSON.stringify(item)} is not a plain YAML scalar (no leading indicator, ": " or " #")`;
  if (/^(?:y|yes|n|no|true|false|on|off|null|~)$/iu.test(item) || /^[-+]?(?:\.?\d)[\d._:eE+-]*$/u.test(item)) return `${JSON.stringify(item)} reads as a YAML boolean, null or number, not text`;
  return null;
}
/** What a whole-set judgement may also check: the decision ids that exist, and whether a repository path exists. */
export type TrackerItemContext = Readonly<{ decisions?: ReadonlySet<string>; exists?: (path: string) => boolean }>;

/**
 * Every way the item files `entries` (`<id>.md` with its text) break the
 * `bridlewise-tracker-item/v1` format, judged together: each file is named by
 * its id; `parent`, `blocked-by` and `relates` name OTHER items that exist,
 * `milestone` a Milestone item; no parent or blocked-by chain returns to its
 * start; a closed item names how and when it closed, an open one neither; a
 * Milestone has no lane or state. With `context`, every decision an item
 * names exists, and every test path exists.
 */
export function trackerItemViolations(entries: readonly { readonly name: string; readonly text: string }[], context: TrackerItemContext = {}): readonly string[] {
  const ids = new Set(entries.map(({ name }) => name.replace(/\.md$/u, "")));
  const milestones = new Set(entries.filter(({ text }) => parseFrontMatter(text)?.fields.get("type") === "Milestone").map(({ name }) => name.replace(/\.md$/u, "")));
  const parents = new Map<string, string>();
  const blockers = new Map<string, readonly string[]>();
  const problems: string[] = [];
  for (const { name, text } of entries) {
    const id = name.replace(/\.md$/u, "");
    if (!name.endsWith(".md") || !TRACKER_ITEM_ID.test(id)) {
      problems.push(`${name}: an item file is named <ID>.md, its id upper-case words joined by hyphens`);
      continue;
    }
    const otherItem = (item: string): string | null => (item === id ? `${item} is this item itself` : ids.has(item) ? null : `${item} names no item`);
    // A Milestone groups through `milestone`, never as a parent or a blocker.
    const otherWorkItem = (item: string): string | null => otherItem(item) ?? (milestones.has(item) ? `${item} is a Milestone (name it in milestone)` : null);
    const closed = (fields: FrontMatter): boolean => fields.get("state") === "closed";
    const milestone = (fields: FrontMatter): boolean => fields.get("type") === "Milestone";
    const decision = (item: string): string | null => (context.decisions === undefined || context.decisions.has(item) ? null : `${item} names no decision record`);
    const testPath = (item: string): string | null => {
      if (item.startsWith("/") || item.split("/").includes("..")) return `${item} is not a repository-relative path`;
      return context.exists === undefined || context.exists(item) ? null : `${item} is not a file of the repository`;
    };
    problems.push(...entryViolations(name, text, {
      closed: true,
      fields: {
        schema: { required: true, values: [TRACKER_ITEM_SCHEMA] },
        // An item is a record, never a site page: its text reaches the site only through the renderers that escape it (site-prose.ts).
        published: { required: true, values: ["false"] },
        id: { required: true, values: [id] },
        type: { required: true, values: TRACKER_ITEM_TYPES },
        // A flaky owner is matched by its row id (src/workflow/flaky-burn-down.ts), so its row is headed by its id.
        title: { check: yamlPlain, forbiddenWhen: (fields) => fields.get("lane") === "flaky-burn-down" },
        state: { required: (fields) => !milestone(fields), forbiddenWhen: milestone, values: TRACKER_ITEM_STATES },
        resolution: { required: closed, forbiddenWhen: (fields) => !closed(fields), values: TRACKER_ITEM_RESOLUTIONS },
        lane: { required: (fields) => !milestone(fields), forbiddenWhen: milestone, values: Object.keys(TRACKER_LANES) },
        "owner-role": { check: yamlPlain },
        milestone: { forbiddenWhen: milestone, pattern: TRACKER_ITEM_ID, check: (item) => (milestones.has(item) ? null : `${item} names no Milestone item`) },
        parent: { forbiddenWhen: milestone, pattern: TRACKER_ITEM_ID, check: otherWorkItem },
        "blocked-by": { list: true, pattern: TRACKER_ITEM_ID, check: otherWorkItem },
        relates: { list: true, pattern: TRACKER_ITEM_ID, check: otherItem },
        severity: { values: TRACKER_ITEM_SEVERITIES },
        area: { list: true, check: yamlPlain },
        evidence: { pattern: /^(?:evidence:\S+|https:\/\/\S+|(?:[\w.-]+\/)*[\w.-]+\.md(?:#[\w-]+)?)$/u },
        order: { pattern: /^(?:0|[1-9]\d{0,5})$/u },
        horizon: { forbiddenWhen: (fields) => closed(fields) || milestone(fields), values: TRACKER_HORIZONS },
        decisions: { list: true, pattern: /^[A-Z][A-Z0-9]*[a-z]?(?:-[A-Z0-9]+[a-z]?)*$/u, check: decision },
        tests: { list: true, check: testPath },
        rfc: { pattern: /^discussion-[1-9]\d*$/u },
        // `issue-31`, never `#31`: YAML reads ` #31` as a comment.
        gh: { pattern: /^(?:issue|discussion)-[1-9]\d*$/u },
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
    // A body line shaped like a task row would be a second row on the board, owning failures no item declares.
    for (const line of parsed.body.split("\n")) if (ROW.test(line)) problems.push(`${name}: the body line ${JSON.stringify(line.trim())} is a task row; a row is an item of its own`);
    const parent = parsed.fields.get("parent");
    if (parent !== undefined && parent.length > 0) parents.set(id, parent);
    blockers.set(id, listValue(parsed.fields.get("blocked-by") ?? "[]") ?? []);
  }
  for (const start of parents.keys()) {
    const seen = new Set([start]);
    for (let next = parents.get(start); next !== undefined; next = parents.get(next)) {
      if (seen.has(next)) { problems.push(`${start}.md: its parent chain returns to ${next}`); break; }
      seen.add(next);
    }
  }
  // A blocked-by cycle would block every member forever: refused, like a parent cycle.
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string, path: readonly string[]): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) { problems.push(`${path[0]}.md: its blocked-by chain returns to ${id}`); return; }
    visiting.add(id);
    for (const next of blockers.get(id) ?? []) visit(next, [...path, next]);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of [...blockers.keys()].sort()) visit(id, [id]);
  return problems;
}

/** The items of `entries` (`<id>.md` with its text), in id order; refused whole (typed) when any breaks the format. */
export function trackerItems(entries: readonly { readonly name: string; readonly text: string }[], context: TrackerItemContext = {}): readonly TrackerItem[] {
  const problems = trackerItemViolations(entries, context);
  if (problems.length > 0) throw new InputError(`the tracker items break ${TRACKER_ITEM_SCHEMA}:\n${problems.join("\n")}`, "tracker_item_invalid");
  return deepFreeze(entries.map(({ text }) => {
    const { fields, body } = parseFrontMatter(text)!;
    const optional = (name: string): string | null => fields.get(name) ?? null;
    const list = (name: string): readonly string[] => listValue(fields.get(name) ?? "[]") ?? [];
    return {
      id: fields.get("id")!,
      type: fields.get("type") as TrackerItemType,
      title: optional("title"),
      state: optional("state") as TrackerItem["state"],
      resolution: optional("resolution") as TrackerItem["resolution"],
      lane: optional("lane") as TrackerItem["lane"],
      ownerRole: optional("owner-role"),
      milestone: optional("milestone"),
      parent: optional("parent"),
      blockedBy: list("blocked-by"),
      relates: list("relates"),
      severity: optional("severity") as TrackerItem["severity"],
      area: list("area"),
      evidence: optional("evidence"),
      order: fields.has("order") ? Number(fields.get("order")) : null,
      horizon: optional("horizon") as TrackerItem["horizon"],
      decisions: list("decisions"),
      tests: list("tests"),
      rfc: optional("rfc"),
      gh: optional("gh"),
      opened: fields.get("opened")!,
      closed: optional("closed"),
      body: body.replace(/^\n+|\n+$/gu, ""),
    };
  }).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)));
}

/** Each entry directly in `directory` of a tree (a commit's, through `reader`) with its text, read in one batch: {@link readEntries} for a commit. */
export function treeEntries(reader: TreeReader, directory: string): readonly { readonly name: string; readonly text: string }[] {
  const prefix = `${directory}/`;
  const paths = reader.paths().filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && isEntryName(path.slice(prefix.length))).sort();
  reader.prefetch(paths);
  return paths.map((path) => ({ name: path.slice(prefix.length), text: reader.text(path) ?? "" }));
}

/** The items a tree holds (a commit's, through `reader`): the same entries and parser as {@link readTrackerItems}; a tree without the folder has none. */
export function trackerItemsOf(reader: TreeReader): readonly TrackerItem[] {
  return trackerItems(treeEntries(reader, TRACKER_BOARD.items));
}

/**
 * The items of the repository at `root` (`TRACKER_BOARD.items`), judged
 * against the decision records beside them and the files of the tree; a tree
 * without the folder has none.
 */
export function readTrackerItems(root: string): readonly TrackerItem[] {
  if (!existsSync(join(root, TRACKER_BOARD.items))) return deepFreeze([]);
  return trackerItems(readEntries(root, TRACKER_BOARD.items), { decisions: new Set(readDecisionRecords(root).map((record) => record.id)), exists: (path) => existsSync(join(root, path)) });
}

/** A decision record as the tracker reads it: its id, whether it is in force, and how far it is carried out. */
export type DecisionRecord = Readonly<{ id: string; status: string; implementation: string; title: string }>;

/** The decision records among `entries` (`<file>.md` with its text), from their front matter. */
export function decisionRecords(entries: readonly { readonly name: string; readonly text: string }[]): readonly DecisionRecord[] {
  return deepFreeze(entries.flatMap(({ text }) => {
    const parsed = parseFrontMatter(text);
    const id = parsed?.fields.get("id");
    if (parsed === null || id === undefined) return [];
    return [{ id, status: parsed.fields.get("status") ?? "", implementation: parsed.fields.get("implementation") ?? "", title: /^# (.+)$/mu.exec(parsed.body)?.[1]?.trim() ?? id }];
  }));
}

/** The decision records of the repository at `root` (`DECISION_INDEX`'s folder); none when the folder is absent. */
export function readDecisionRecords(root: string): readonly DecisionRecord[] {
  const directory = posix.dirname(DECISION_INDEX.path);
  return existsSync(join(root, directory)) ? decisionRecords(readEntries(root, directory)) : deepFreeze([]);
}

/**
 * The status facts of the item files `entries` AS THEY WERE (a commit of the
 * items' history): id, type, open or closed and how, parent, milestone,
 * blocked-by, decisions, tests and evidence, read from the front matter WITHOUT judging the
 * format of the day — a past commit is history, read as written, never
 * refused by a later rule. A file without front matter or an id is skipped.
 */
export function itemStatusFacts(entries: readonly { readonly name: string; readonly text: string }[]): readonly Readonly<{
  id: string; type: string; state: "open" | "closed" | null; resolution: "completed" | "not-planned" | "duplicate" | null;
  parent: string | null; milestone: string | null; blockedBy: readonly string[]; decisions: readonly string[];
  tests: readonly string[]; evidence: string | null;
}>[] {
  return deepFreeze(entries.flatMap(({ text }) => {
    const fields = parseFrontMatter(text)?.fields;
    const id = fields?.get("id");
    if (fields === undefined || id === undefined) return [];
    const state = fields.get("state");
    const resolution = fields.get("resolution");
    return [{
      id,
      type: fields.get("type") ?? "Task",
      state: state === "open" || state === "closed" ? state : null,
      resolution: resolution === "completed" || resolution === "not-planned" || resolution === "duplicate" ? resolution : null,
      parent: fields.get("parent") ?? null,
      milestone: fields.get("milestone") ?? null,
      blockedBy: listValue(fields.get("blocked-by") ?? "[]") ?? [],
      decisions: listValue(fields.get("decisions") ?? "[]") ?? [],
      tests: listValue(fields.get("tests") ?? "[]") ?? [],
      evidence: fields.get("evidence") ?? null,
    }];
  }));
}

// ── The board ───────────────────────────────────────────────────────────────

/** The shallowest heading an item's prose takes on the board, under its lane's `##` section. */
const BOARD_HEADING_FLOOR = 3;

/**
 * One item's board row: `- [ ] **<title or id>** — <body>`, its later body
 * lines indented under the dash. The board is a site page: the title and the
 * body are written through the site escape (site-prose.ts), so no spelling of
 * an item is markup there; an id is upper-case words and hyphens.
 */
export function itemRow(item: TrackerItem): string {
  const board = posix.dirname(TRACKER_BOARD.path);
  const href = (target: ProseTarget): string => (target.kind === "relative" ? `${relativePath(board, target.path)}${target.fragment}` : target.url);
  const lines = siteProse(item.body, TRACKER_BOARD.items, href, BOARD_HEADING_FLOOR).split("\n").filter((line) => line.trim().length > 0);
  const head = `- [${item.state === "open" ? " " : "x"}] **${item.title === null ? item.id : escapeSiteText(item.title)}**`;
  return [lines.length === 0 ? head : `${head} — ${lines[0]!}`, ...lines.slice(1).map((line) => `  ${line}`)].join("\n");
}

/**
 * THE BOARD, generated from the items alone (a Milestone is no row): one
 * section per lane holding open items (its {@link TRACKER_LANES} heading;
 * ranked by `order`, then oldest opened first), then
 * every closed item under `Done` (most recently closed first); ties by id.
 * It is the text between the `TRACKER_BOARD` markers; nothing in it is typed
 * by hand.
 */
export function renderTrackerBoard(items: readonly TrackerItem[]): string {
  const byId = (left: TrackerItem, right: TrackerItem): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const rank = (item: TrackerItem): number => item.order ?? Number.MAX_SAFE_INTEGER;
  const section = (heading: string, rows: readonly TrackerItem[]): string[] => (rows.length === 0 ? [] : [`## ${heading}\n\n${rows.map(itemRow).join("\n")}\n`]);
  const open = (Object.entries(TRACKER_LANES) as [TrackerLane, typeof TRACKER_LANES[TrackerLane]][]).flatMap(([lane, { heading }]) =>
    section(heading, items.filter((item) => item.state === "open" && item.lane === lane).sort((left, right) => rank(left) - rank(right) || left.opened.localeCompare(right.opened) || byId(left, right))));
  const done = section(DONE_HEADING, items.filter((item) => item.state === "closed").sort((left, right) => right.closed!.localeCompare(left.closed!) || byId(left, right)));
  return [...open, ...done].join("\n");
}

export type TrackerBoardReport = Readonly<{
  status: "current" | "regenerated" | "stale" | "absent" | "invalid";
  converged: boolean;
  changed: readonly string[];
  /** Why an `invalid` board cannot be judged or written. */
  problems: readonly string[];
}>;

/**
 * Judges (and with `write`, rewrites) the board of the repository at
 * `repositoryRoot` (`harness check` / `harness sync`). A tree with neither
 * the items folder nor a board block (a product-only tree) is converged by
 * absence. INVALID, never written: a board file without its block, a block
 * without its items folder (deleting the items would otherwise silence the
 * check), a missing board file, and a task row typed by hand outside the
 * block (it would own failures no item declares).
 */
export function syncTrackerBoard(repositoryRoot: string, write: boolean): TrackerBoardReport {
  const path = join(repositoryRoot, TRACKER_BOARD.path);
  const hasItems = existsSync(join(repositoryRoot, TRACKER_BOARD.items));
  const text = existsSync(path) ? readFileSync(path, "utf8") : null;
  const invalid = (...problems: string[]): TrackerBoardReport => deepFreeze({ status: "invalid", converged: false, changed: [], problems });
  const split = text === null ? null : splitGeneratedBlock(text, TRACKER_BOARD);
  if (!hasItems) return split === null ? deepFreeze({ status: "absent", converged: true, changed: [], problems: [] }) : invalid(`${TRACKER_BOARD.path} carries the generated board block but ${TRACKER_BOARD.items} is missing`);
  if (text === null) return invalid(`${TRACKER_BOARD.path} is missing while ${TRACKER_BOARD.items} holds the items`);
  if (split === null) return invalid(`${TRACKER_BOARD.path} carries no generated board block (its begin and end markers, TRACKER_BOARD in src/kernel/verification-paths.ts)`);
  const handRows = taskRows(`${split.before}\n${split.after}`);
  if (handRows.length > 0) return invalid(...handRows.map((row) => `${TRACKER_BOARD.path}: the row ${row.id} is typed outside the generated board block; a task is an item file in ${TRACKER_BOARD.items}`));
  const next = spliceGeneratedBlock(text, TRACKER_BOARD, renderTrackerBoard(readTrackerItems(repositoryRoot)))!;
  if (next === text) return deepFreeze({ status: "current", converged: true, changed: [], problems: [] });
  if (!write) return deepFreeze({ status: "stale", converged: false, changed: [TRACKER_BOARD.path], problems: [] });
  const written = atomicWriteFile(path, next);
  if (!written.success) throw new HarnessError(`Failed to write ${TRACKER_BOARD.path}: ${written.reason ?? "unknown error"}`, "tracker_board_write_failed");
  return deepFreeze({ status: "regenerated", converged: true, changed: [TRACKER_BOARD.path], problems: [] });
}
