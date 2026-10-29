/**
 * ONE-FILE-PER-ENTRY RECORDS: the lesson and decision formats and the decision index.
 *
 * Workflow lessons (`docs/trackers/workflow-lessons/`) and decisions
 * (`docs/decisions/`) are each one Markdown file per entry, opened by a front
 * matter a machine reads:
 *
 *     ---
 *     id: L-2026-09-28-some-lesson
 *     status: acted
 *     acted_in: [engine/src/a.ts, tests/b.test.ts]
 *     ---
 *
 * Both formats are read by the tracker's one front-matter reader
 * (src/workflow/failure-owners.ts `parseFrontMatter`, which also reads the
 * structured tracker items) and judged by its `entryViolations` against a
 * per-kind schema, so a rule (a required field, an enumeration, a list of
 * tracked paths) is spelled once.
 * The format tests, the commit guard's `Lesson:` trailer check and the
 * `lessons` report all read entries through this module.
 */
import { dirname } from "node:path";

import type { PartBar } from "../../../shared/figures.ts";
import { DECISION_INDEX } from "../../src/kernel/verification-paths.ts";
import { entryViolations, listValue, parseFrontMatter, type FrontMatter } from "../../src/workflow/failure-owners.ts";

/** Where each kind of entry lives, repository-relative. */
export const LESSONS_DIRECTORY = "docs/trackers/workflow-lessons";
/** The decisions live beside their generated index (`DECISION_INDEX.path`, one spelling). */
export const DECISIONS_DIRECTORY = dirname(DECISION_INDEX.path);

// ── Workflow lessons ────────────────────────────────────────────────────────

const LESSON_NAME = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u;
export const LESSON_KINDS = Object.freeze(["tooling", "guard", "doc", "config", "process", "environment"] as const);
export const LESSON_STATUSES = Object.freeze(["pending", "acted", "wontfix"] as const);

/** A lesson's id from its file name (`L-<stem>`). */
export function lessonId(name: string): string {
  return `L-${name.slice(0, -".md".length)}`;
}

/**
 * `acted_in` names repository-relative paths, never a commit SHA: a hand-typed
 * SHA is a hand-edited generated value, and the commit that acts cannot
 * contain its own. The link to the commit is its `Lesson:` trailer.
 *
 * WHETHER GIT HOLDS each path is judged when the entry is written — the commit
 * that adds or changes it (`tracked` given: the staged tree,
 * `stagedTrackerEntryViolations` in `lesson-trailers.ts`) — and never again:
 * a closed record names where the work was done THEN, and a later rename or
 * deletion of that file must not turn the record red or force it to be
 * rewritten (wf-1b3a-design M2). Without `tracked`, only the shape is judged.
 */
function actedInCheck(tracked: ReadonlySet<string> | undefined): (item: string) => string | null {
  return (item) => {
    if (/^[0-9a-f]{7,40}$/u.test(item)) return `${item} is a commit id; name the tracked paths, and link the commit with its Lesson: trailer`;
    if (item.startsWith("/") || item.startsWith("~") || item.split("/").includes("..")) return `${item} is not a repository-relative path`;
    return tracked === undefined || tracked.has(item) ? null : `${item} is not a path git holds (tracked or staged)`;
  };
}

/** Every way the lesson file `name` with `text` breaks the lesson format. */
export function lessonViolations(name: string, text: string, tracked?: ReadonlySet<string>): readonly string[] {
  const nameMatch = LESSON_NAME.exec(name);
  if (nameMatch === null) return [`${name}: the name must be <YYYY-MM-DD>-<slug>.md`];
  const status = (fields: FrontMatter): string | undefined => fields.get("status");
  // A field belongs to its status alone — judged only once the status is one we know (an unknown one is its own refusal).
  const knownStatusOtherThan = (wanted: string) => (fields: FrontMatter): boolean => (LESSON_STATUSES as readonly string[]).includes(status(fields) ?? "") && status(fields) !== wanted;
  return entryViolations(name, text, {
    fields: {
      id: { required: true, values: [lessonId(name)] },
      date: { required: true, values: [nameMatch[1]!] },
      source: { required: true },
      kind: { required: true, values: LESSON_KINDS },
      status: { required: true, values: LESSON_STATUSES },
      route: { required: (fields) => status(fields) === "pending", forbiddenWhen: knownStatusOtherThan("pending") },
      acted_in: { required: (fields) => status(fields) === "acted", forbiddenWhen: knownStatusOtherThan("acted"), list: true, check: actedInCheck(tracked) },
      reason: { required: (fields) => status(fields) === "wontfix", forbiddenWhen: knownStatusOtherThan("wontfix") },
    },
    sections: ["## Observation", "## Lesson", "## Change"],
  });
}

// ── Decisions ───────────────────────────────────────────────────────────────

/**
 * A decision id: upper-case words and numbers joined by hyphens, as the plan
 * and the specs cite them (`D-04`, `D-R1`, `UD-C1`, `U2`, `CFG-DIR`), each
 * part optionally ending in one lower-case variant letter (`X3b`: option b).
 */
export const DECISION_ID = /^[A-Z][A-Z0-9]*[a-z]?(?:-[A-Z0-9]+[a-z]?)*$/u;
export const DECISION_BY = Object.freeze(["user", "coordinator"] as const);
export const DECISION_STATUSES = Object.freeze(["in-force", "superseded"] as const);
/**
 * How far a decision is carried out: `standing` binds all work and is never
 * "done"; `pending` and `partial` name the task that carries it (`route`);
 * `done` and `partial` name where (`acted_in`).
 */
export const DECISION_IMPLEMENTATIONS = Object.freeze(["standing", "pending", "partial", "done"] as const);
/** The index's sections (`group` in each decision's front matter), in the index's order, with their headings. */
export const DECISION_GROUPS = Object.freeze({
  "user-rules": "User rules (standing)",
  process: "Process decisions (coordinator)",
  engine: "Earlier engine decisions (coordinator)",
  "prompt-cache": "Prompt cache",
  configuration: "Configuration, prompts and credentials",
  promotion: "Promotion",
  responses: "The Responses sequence",
  scale: "Scale",
  memory: "Memory layers",
  labs: "Labs (docs, browser, intelligence)",
  // The GitHub-only rules (GITHUB-*, GH-*) and the public messaging rules (MKT-*).
  github: "GitHub",
  brand: "Brand and public messaging",
} as const);

/**
 * Every way the decision files `entries` break the decision format, judged
 * together: ids and their `covers` aliases are unique; `superseded_by` and
 * `overrides` name OTHER ids that exist; every supersession chain ends at a
 * decision in force, without a cycle; and an amendment is recorded on both
 * ends: a decision another one `overrides` names it in `amended_by`, and
 * every `amended_by` names a decision whose `overrides` names this one (or
 * one of the ids it covers), so a reader of the older decision always learns
 * it was amended, and by what.
 */
export function decisionViolations(entries: readonly { readonly name: string; readonly text: string }[], tracked?: ReadonlySet<string>): readonly string[] {
  const known = new Map<string, string>();
  const problems: string[] = [];
  for (const { name, text } of entries) {
    const fields = parseFrontMatter(text)?.fields;
    for (const id of [fields?.get("id") ?? "", ...(listValue(fields?.get("covers") ?? "") ?? [])]) {
      if (id.length === 0) continue;
      const holder = known.get(id);
      if (holder !== undefined) problems.push(`${name}: the id ${id} is also ${holder}'s`);
      known.set(id, name);
    }
  }
  const implementation = (fields: FrontMatter): string | undefined => fields.get("implementation");
  const carriesOut = (fields: FrontMatter): boolean => ["done", "partial"].includes(implementation(fields) ?? "");
  const routed = (fields: FrontMatter): boolean => ["pending", "partial"].includes(implementation(fields) ?? "");
  // Judged only once the implementation is one we know (an unknown one is its own refusal).
  const knownImplementation = (fields: FrontMatter): boolean => (DECISION_IMPLEMENTATIONS as readonly string[]).includes(implementation(fields) ?? "");
  const fieldsOf = new Map<string, FrontMatter>();
  for (const { text } of entries) {
    const fields = parseFrontMatter(text)?.fields;
    if (fields === undefined) continue;
    for (const alias of [fields.get("id") ?? "", ...(listValue(fields.get("covers") ?? "") ?? [])]) if (alias.length > 0 && !fieldsOf.has(alias)) fieldsOf.set(alias, fields);
  }
  // Who amends whom: each `overrides` target (an id or a covered alias) → the ids of the decisions that override it.
  const amenders = new Map<string, Set<string>>();
  for (const { text } of entries) {
    const fields = parseFrontMatter(text)?.fields;
    const amender = fields?.get("id") ?? "";
    for (const target of listValue(fields?.get("overrides") ?? "") ?? []) {
      const holder = fieldsOf.get(target)?.get("id") ?? target;
      // Overriding itself is refused once, by the overrides field's own check.
      if (holder === amender) continue;
      if (!amenders.has(holder)) amenders.set(holder, new Set());
      amenders.get(holder)!.add(amender);
    }
  }
  for (const { name, text } of entries) {
    const id = parseFrontMatter(text)?.fields.get("id") ?? "";
    const knownId = (item: string): string | null => (item === id ? `${item} is this decision itself` : known.has(item) ? null : `${item} names no decision`);
    const amendedBy = new Set(listValue(parseFrontMatter(text)?.fields.get("amended_by") ?? "") ?? []);
    for (const amender of amenders.get(id) ?? []) {
      if (!amendedBy.has(amender)) problems.push(`${name}: ${amender} overrides it, so its amended_by must name ${amender}`);
    }
    if (DECISION_ID.test(id) && !name.startsWith(`${id}-`)) problems.push(`${name}: its id ${id} does not name it`);
    // A supersession chain ends at a decision in force: never a cycle, never a dead end.
    const seen = new Set<string>([id]);
    const successor = fieldsOf.get(id)?.get("superseded_by");
    // (A decision superseded by ITSELF is refused once, by its field's own check.)
    for (let next = successor === id ? undefined : successor; next !== undefined && known.has(next); next = fieldsOf.get(next)?.get("superseded_by")) {
      if (seen.has(next)) { problems.push(`${name}: its supersession chain returns to ${next}`); break; }
      seen.add(next);
      if (fieldsOf.get(next)?.get("status") === "in-force") break;
      if (fieldsOf.get(next)?.get("superseded_by") === undefined) { problems.push(`${name}: its supersession chain ends at ${next}, which is not in force`); break; }
    }
    problems.push(...entryViolations(name, text, {
      fields: {
        id: { required: true, pattern: DECISION_ID },
        date: { required: true, pattern: /^\d{4}-\d{2}-\d{2}$/u },
        by: { required: true, values: DECISION_BY },
        status: { required: true, values: DECISION_STATUSES },
        superseded_by: { required: (fields) => fields.get("status") === "superseded", forbiddenWhen: (fields) => fields.get("status") !== "superseded", check: knownId },
        overrides: { list: true, check: knownId },
        amended_by: { list: true, check: (item) => knownId(item) ?? ((amenders.get(id) ?? new Set()).has(item) ? null : `${item} does not override this decision (its overrides must name ${id})`) },
        covers: { list: true, pattern: DECISION_ID },
        group: { required: true, values: Object.keys(DECISION_GROUPS) },
        implementation: { required: true, values: DECISION_IMPLEMENTATIONS },
        route: { required: routed, forbiddenWhen: (fields) => knownImplementation(fields) && !routed(fields) },
        acted_in: { required: carriesOut, forbiddenWhen: (fields) => knownImplementation(fields) && !carriesOut(fields), list: true, check: actedInCheck(tracked) },
      },
      bodyOpens: /^# \S/u,
    }));
  }
  return problems;
}

// ── The decision index (docs/decisions/README.md) ──────────────────────────

/** One decision's index row: its id and file, its title (with the ids it covers), its author, its state. */
function indexRow(name: string, fields: FrontMatter, title: string): string {
  const covers = listValue(fields.get("covers") ?? "") ?? [];
  const amended = listValue(fields.get("amended_by") ?? "") ?? [];
  const state = (fields.get("status") === "superseded"
    ? `superseded by ${fields.get("superseded_by") ?? "?"}`
    : `${fields.get("implementation") ?? "?"}${fields.get("route") === undefined ? "" : ` (${fields.get("route")!})`}`)
    + (amended.length === 0 ? "" : `, amended by ${amended.join(", ")}`);
  return `| [${fields.get("id") ?? "?"}](${name}) | ${title}${covers.length === 0 ? "" : ` (covers ${covers.join(", ")})`} | ${fields.get("by") ?? "?"} | ${state} |`;
}

/**
 * Every decision record by how far it is built, from the records' own front
 * matter: a superseded record is superseded whatever it reached; a record in
 * force is built, partly built, designed but not built, or a standing rule.
 * The parts are the figure's (`shared/figures.ts`); the site build draws it
 * (scripts/floor/site-design.mjs) when the site is built, never committed.
 */
export function decisionStatus(entries: readonly { readonly name: string; readonly text: string }[]): PartBar {
  const counts = { done: 0, partial: 0, pending: 0, standing: 0, superseded: 0 };
  for (const { text } of entries) {
    const fields = parseFrontMatter(text)?.fields;
    if (fields === undefined) continue;
    if (fields.get("status") === "superseded") counts.superseded += 1;
    else {
      const implementation = fields.get("implementation");
      if (implementation === "done" || implementation === "partial" || implementation === "pending" || implementation === "standing") counts[implementation] += 1;
    }
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    title: `${String(total)} decision records`,
    subtitle: "by how far each is built",
    parts: [
      { label: "built", count: counts.done, ink: "--ok" },
      { label: "partly built", count: counts.partial, ink: "--ok", hatched: true },
      { label: "designed, not built", count: counts.pending, ink: "--warn" },
      { label: "standing rules", count: counts.standing, ink: "--ink-2" },
      { label: "superseded", count: counts.superseded, ink: "--ink-2", hatched: true },
    ],
    source: "generated from docs/decisions/*.md front matter",
  };
}

/**
 * THE DECISION INDEX, generated from the decision files alone (their front
 * matter and `# ` title): one section per {@link DECISION_GROUPS} entry that
 * holds a decision, the rows in file-name order. It is the text between the
 * `DECISION_INDEX` markers (src/kernel/verification-paths.ts); nothing in it is typed by hand
 * (wf-1b3a-design M1: a hand-kept index restated every file's state and could
 * lie after a `pending → done` flip).
 */
export function renderDecisionIndex(entries: readonly { readonly name: string; readonly text: string }[]): string {
  const sections = Object.entries(DECISION_GROUPS).flatMap(([group, heading]) => {
    const rows = entries.flatMap(({ name, text }) => {
      const parsed = parseFrontMatter(text);
      if (parsed === null || parsed.fields.get("group") !== group) return [];
      return [indexRow(name, parsed.fields, /^# (.+)$/mu.exec(parsed.body)?.[1]?.trim() ?? name)];
    });
    return rows.length === 0 ? [] : [`## ${heading}\n\n| Id | Decision | By | State |\n|---|---|---|---|\n${rows.join("\n")}\n`];
  });
  return sections.join("\n");
}
