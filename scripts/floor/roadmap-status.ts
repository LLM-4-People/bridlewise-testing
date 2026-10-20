/**
 * THE ROADMAP STATUS GENERATOR: `docs/floor/roadmap.md`'s status blocks,
 * rebuilt from their owners.
 *
 *   npm run docs:roadmap              # rewrite the three generated blocks
 *   npm run docs:roadmap -- --check   # exit 1 when a block is stale
 *
 * The owners are:
 *
 *   - the page's own `ROADMAP-PLAN` JSON block (workstreams, exit criteria,
 *     milestone focus, not-planned statements, and the state rule for each
 *     TASKS.md section);
 *   - `docs/trackers/TASKS.md` open rows, read through the one task-row
 *     parser (`engine/src/workflow/failure-owners.ts` `taskRows`);
 *   - `docs/floor/evidence.md`'s explicit non-proofs (`What this does not
 *     prove`, the audit-scope paragraph, and `What none of this proves`).
 *
 * No rendered table is hand-editable: `npm run docs:roadmap` is the only
 * writer, and `tests/prevention/roadmap-status-owner.test.ts` refuses a page
 * that differs from the renderer's output or a page that omits an open task
 * row, an open plan item, or an evidence non-proof.
 *
 * The prose outside the generated markers stays hand-written, including the
 * `## Snapshot` anchor other pages link to.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { taskRows, type TaskRow } from "../../engine/src/workflow/failure-owners.ts";

export const ROADMAP_PATH = "docs/floor/roadmap.md";
export const TASKS_PATH = "docs/trackers/TASKS.md";
export const EVIDENCE_PATH = "docs/floor/evidence.md";

const PLAN_SCHEMA = "bridlewise-roadmap-plan/v1";
const PLAN_BEGIN = "<!-- ROADMAP-PLAN-BEGIN";
const PLAN_END = "ROADMAP-PLAN-END -->";
const PLAN_PATTERN = /<!-- ROADMAP-PLAN-BEGIN\n([\s\S]*?)\nROADMAP-PLAN-END -->/u;

export const ROADMAP_BLOCKS = {
  summary: {
    begin: "<!-- BEGIN GENERATED: roadmap summary, from this page's ROADMAP-PLAN block (npm run docs:roadmap; scripts/floor/roadmap-status.ts) -->",
    end: "<!-- END GENERATED: roadmap summary -->",
  },
  plan: {
    begin: "<!-- BEGIN GENERATED: roadmap workstreams and exit criteria, from this page's ROADMAP-PLAN block (npm run docs:roadmap; scripts/floor/roadmap-status.ts) -->",
    end: "<!-- END GENERATED: roadmap workstreams and exit criteria -->",
  },
  open: {
    begin: "<!-- BEGIN GENERATED: roadmap open work, from TASKS.md open rows, this page's ROADMAP-PLAN block and docs/floor/evidence.md (npm run docs:roadmap; scripts/floor/roadmap-status.ts) -->",
    end: "<!-- END GENERATED: roadmap open work -->",
  },
} as const;

export type RoadmapBlock = keyof typeof ROADMAP_BLOCKS;
const BLOCK_ORDER: readonly RoadmapBlock[] = Object.keys(ROADMAP_BLOCKS) as readonly RoadmapBlock[];
const STATES = ["shipped", "in progress", "planned", "blocked", "not planned"] as const;
export type RoadmapState = (typeof STATES)[number];
const HORIZONS = ["now", "next", "later"] as const;
type Horizon = (typeof HORIZONS)[number];

export type RoadmapItem = Readonly<{
  id: string;
  milestone: string;
  title: string;
  state: RoadmapState;
  owner: string;
  exit: string;
  evidence: string;
  source: string;
  horizon?: Horizon;
  blockedBy?: string;
}>;

type Milestone = Readonly<{ id: string; title: string; state: RoadmapState }>;
type TaskSectionRule = Readonly<{ state: RoadmapState; owner: string; exit: string; evidence: string }>;
type TaskOverride = Readonly<{
  state?: RoadmapState;
  owner?: string;
  exit?: string;
  evidence?: string;
  blockedBy?: string;
}>;
type NotPlanned = Readonly<{ statement: string; reason: string; evidence: string }>;

export type RoadmapPlan = Readonly<{
  schemaVersion: string;
  milestones: readonly Milestone[];
  workstreams: readonly RoadmapItem[];
  exitCriteria: readonly RoadmapItem[];
  taskSections: Readonly<Record<string, TaskSectionRule>>;
  taskOverrides: Readonly<Record<string, TaskOverride>>;
  notPlanned: readonly NotPlanned[];
}>;

export type EvidenceNonProof = Readonly<{ area: string; anchor: string; text: string }>;

type OpenTask = Readonly<{
  row: TaskRow;
  section: string;
  state: RoadmapState;
  owner: string;
  exit: string;
  evidence: string;
  blockedBy?: string;
}>;

export type RoadmapSources = Readonly<{ trackerText: string; evidenceText: string }>;

export type RoadmapReport = Readonly<{
  staleBlocks: readonly RoadmapBlock[];
  violations: readonly string[];
}>;

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${where} must be a JSON object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${where} must be a non-empty string`);
  return value;
}

function list(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  return value;
}

function stateOf(value: unknown, where: string): RoadmapState {
  if (typeof value !== "string" || !(STATES as readonly string[]).includes(value)) {
    fail(`${where} must be one of ${STATES.join(" / ")}`);
  }
  return value as RoadmapState;
}

function horizonOf(value: unknown, where: string): Horizon {
  if (typeof value !== "string" || !(HORIZONS as readonly string[]).includes(value)) {
    fail(`${where} must be one of ${HORIZONS.join(" / ")}`);
  }
  return value as Horizon;
}

function isOpen(state: RoadmapState): boolean {
  return state === "in progress" || state === "planned" || state === "blocked";
}

function parseItem(value: unknown, where: string, requireExit = true): RoadmapItem {
  const entry = record(value, where);
  const state = stateOf(entry.state, `${where}.state`);
  const horizon = entry.horizon === undefined ? undefined : horizonOf(entry.horizon, `${where}.horizon`);
  const blockedBy = entry.blockedBy === undefined ? undefined : text(entry.blockedBy, `${where}.blockedBy`);
  if (state === "blocked" && blockedBy === undefined) fail(`${where}.blockedBy is required on a blocked item`);
  if (state !== "blocked" && blockedBy !== undefined) fail(`${where}.blockedBy belongs only to a blocked item`);
  if (!isOpen(state) && horizon !== undefined) fail(`${where}.horizon belongs only to an open item`);
  return Object.freeze({
    id: text(entry.id, `${where}.id`),
    milestone: text(entry.milestone, `${where}.milestone`),
    title: text(entry.title, `${where}.title`),
    state,
    owner: text(entry.owner, `${where}.owner`),
    exit: entry.exit === undefined && !requireExit ? text(entry.title, `${where}.title`) : text(entry.exit, `${where}.exit`),
    evidence: text(entry.evidence, `${where}.evidence`),
    source: text(entry.source, `${where}.source`),
    ...(horizon === undefined ? {} : { horizon }),
    ...(blockedBy === undefined ? {} : { blockedBy }),
  });
}

function parseRule(value: unknown, where: string): TaskSectionRule {
  const entry = record(value, where);
  return Object.freeze({
    state: stateOf(entry.state, `${where}.state`),
    owner: text(entry.owner, `${where}.owner`),
    exit: text(entry.exit, `${where}.exit`),
    evidence: text(entry.evidence, `${where}.evidence`),
  });
}

function parseOverride(value: unknown, where: string): TaskOverride {
  const entry = record(value, where);
  const override: {
    state?: RoadmapState;
    owner?: string;
    exit?: string;
    evidence?: string;
    blockedBy?: string;
  } = {};
  if (entry.state !== undefined) override.state = stateOf(entry.state, `${where}.state`);
  if (entry.owner !== undefined) override.owner = text(entry.owner, `${where}.owner`);
  if (entry.exit !== undefined) override.exit = text(entry.exit, `${where}.exit`);
  if (entry.evidence !== undefined) override.evidence = text(entry.evidence, `${where}.evidence`);
  if (entry.blockedBy !== undefined) override.blockedBy = text(entry.blockedBy, `${where}.blockedBy`);
  if (override.blockedBy !== undefined && override.state !== "blocked") {
    fail(`${where}.blockedBy requires state "blocked"`);
  }
  if (override.state === "blocked" && override.blockedBy === undefined) {
    fail(`${where}.blockedBy is required on a blocked override`);
  }
  return Object.freeze(override);
}

/** Parses the page's machine-readable plan block. Throws on a malformed plan; drift is reported separately. */
export function readRoadmapPlan(pageText: string): RoadmapPlan {
  const matches = [...pageText.matchAll(new RegExp(PLAN_PATTERN.source, "gu"))];
  if (matches.length !== 1) fail(`the page must carry exactly one ${PLAN_BEGIN} block; found ${matches.length}`);
  const raw = matches[0]?.[1];
  if (raw === undefined) fail("the ROADMAP-PLAN block is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`the ROADMAP-PLAN block is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entry = record(parsed, "ROADMAP-PLAN");
  if (text(entry.schemaVersion, "ROADMAP-PLAN.schemaVersion") !== PLAN_SCHEMA) {
    fail(`ROADMAP-PLAN.schemaVersion must be ${PLAN_SCHEMA}`);
  }
  const milestones = list(entry.milestones, "ROADMAP-PLAN.milestones").map((value, index) => {
    const where = `ROADMAP-PLAN.milestones[${index}]`;
    const milestone = record(value, where);
    return Object.freeze({
      id: text(milestone.id, `${where}.id`),
      title: text(milestone.title, `${where}.title`),
      state: stateOf(milestone.state, `${where}.state`),
    });
  });
  const workstreams = list(entry.workstreams, "ROADMAP-PLAN.workstreams")
    .map((value, index) => parseItem(value, `ROADMAP-PLAN.workstreams[${index}]`));
  const exitCriteria = list(entry.exitCriteria, "ROADMAP-PLAN.exitCriteria")
    .map((value, index) => parseItem(value, `ROADMAP-PLAN.exitCriteria[${index}]`, false));
  const taskSections = record(entry.taskSections, "ROADMAP-PLAN.taskSections");
  const rules: Record<string, TaskSectionRule> = {};
  for (const [section, value] of Object.entries(taskSections)) {
    rules[section] = parseRule(value, `ROADMAP-PLAN.taskSections[${JSON.stringify(section)}]`);
  }
  const taskOverrides = record(entry.taskOverrides, "ROADMAP-PLAN.taskOverrides");
  const overrides: Record<string, TaskOverride> = {};
  for (const [id, value] of Object.entries(taskOverrides)) {
    overrides[id] = parseOverride(value, `ROADMAP-PLAN.taskOverrides[${JSON.stringify(id)}]`);
  }
  const notPlanned = list(entry.notPlanned, "ROADMAP-PLAN.notPlanned").map((value, index) => {
    const where = `ROADMAP-PLAN.notPlanned[${index}]`;
    const statement = record(value, where);
    return Object.freeze({
      statement: text(statement.statement, `${where}.statement`),
      reason: text(statement.reason, `${where}.reason`),
      evidence: text(statement.evidence, `${where}.evidence`),
    });
  });
  return Object.freeze({
    schemaVersion: PLAN_SCHEMA,
    milestones: Object.freeze(milestones),
    workstreams: Object.freeze(workstreams),
    exitCriteria: Object.freeze(exitCriteria),
    taskSections: Object.freeze(rules),
    taskOverrides: Object.freeze(overrides),
    notPlanned: Object.freeze(notPlanned),
  });
}

/** The GitHub / kramdown heading id: punctuation is removed, then each remaining space becomes a hyphen. */
export function headingSlug(heading: string): string {
  return heading
    .replace(/<[^>]*>/gu, "")
    .replace(/[`*_~]/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/gu, "-");
}

function markdownHeadings(markdown: string): ReadonlySet<string> {
  const headings = new Set<string>();
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const match = /^(?:#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match?.[1] !== undefined) headings.add(headingSlug(match[1]));
  }
  return headings;
}

function localEvidenceViolation(evidence: string, repositoryRoot: string): string | null {
  if (/^https?:\/\//u.test(evidence)) return null;
  const hash = evidence.indexOf("#");
  const pathPart = hash === -1 ? evidence : evidence.slice(0, hash);
  const anchor = hash === -1 ? "" : evidence.slice(hash + 1);
  const target = pathPart.length === 0
    ? join(repositoryRoot, ROADMAP_PATH)
    : resolve(join(repositoryRoot, "docs/floor"), pathPart);
  if (!existsSync(target)) return `${evidence}: target does not exist`;
  if (anchor.length > 0 && target.endsWith(".md")) {
    const headings = markdownHeadings(readFileSync(target, "utf8"));
    if (!headings.has(anchor)) return `${evidence}: no heading anchor #${anchor} in ${pathPart.length === 0 ? ROADMAP_PATH : pathPart}`;
  }
  return null;
}

function openSectionMap(trackerText: string, rows: readonly TaskRow[]): ReadonlyMap<string, string> {
  const firstLine = new Map<string, string>();
  for (const row of rows) {
    const line = row.text.split("\n")[0];
    if (line !== undefined) firstLine.set(line, row.id);
  }
  const sections = new Map<string, string>();
  let heading = "Unsectioned";
  for (const line of trackerText.split("\n")) {
    const match = /^#{2,3}\s+(.+?)\s*$/u.exec(line);
    if (match?.[1] !== undefined) {
      heading = match[1];
      continue;
    }
    const id = firstLine.get(line);
    if (id !== undefined) sections.set(id, heading);
  }
  return sections;
}

function openTasks(plan: RoadmapPlan, trackerText: string): readonly OpenTask[] {
  const openRows = taskRows(trackerText).filter((row) => !row.done);
  const sections = openSectionMap(trackerText, openRows);
  return openRows.map((row) => {
    const section = sections.get(row.id) ?? "Unsectioned";
    const rule = plan.taskSections[section];
    const override = plan.taskOverrides[row.id] ?? {};
    const state = override.state ?? rule?.state ?? "planned";
    const fallback: TaskSectionRule = {
      state: "planned",
      owner: "task tracker",
      exit: "The row closes in TASKS.md with its reproduction and verification.",
      evidence: TASKS_PATH,
    };
    return Object.freeze({
      row,
      section,
      state,
      owner: override.owner ?? rule?.owner ?? fallback.owner,
      exit: override.exit ?? rule?.exit ?? fallback.exit,
      evidence: override.evidence ?? rule?.evidence ?? fallback.evidence,
      ...(override.blockedBy === undefined ? {} : { blockedBy: override.blockedBy }),
    });
  });
}

function normalizeProse(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** The evidence page's explicit refusals: each `What … does not prove` paragraph, the audit-scope paragraph, and every `What none of this proves` bullet. */
export function extractEvidenceNonProofs(markdown: string): readonly EvidenceNonProof[] {
  const out: EvidenceNonProof[] = [];
  let section = "Evidence";
  let anchor = "evidence";
  let paragraph: string[] = [];
  let fence = false;
  const flush = (): void => {
    if (paragraph.length === 0) return;
    const value = normalizeProse(paragraph.join(" "));
    paragraph = [];
    if (value.length === 0) return;
    const stripped = value.replace(/^What (?:this|it) does not prove:\s*/u, "");
    if (stripped !== value) {
      out.push({ area: section, anchor, text: stripped });
      return;
    }
    const later = /(?:^|[.!?]\s)It does not prove\s+(.+)$/u.exec(value);
    if (later?.[1] !== undefined) {
      out.push({ area: section, anchor, text: later[1] });
      return;
    }
    if (value.startsWith("This is one ")) out.push({ area: section, anchor, text: value });
  };
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      flush();
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const heading = /^(#{2,3})\s+(.+?)\s*$/u.exec(line);
    if (heading?.[2] !== undefined) {
      flush();
      section = heading[2];
      anchor = headingSlug(section);
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("- ") && section === "What none of this proves") {
      flush();
      out.push({ area: section, anchor, text: normalizeProse(line.slice(2)) });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return Object.freeze(out);
}

/** Renders the three generated blocks. The page's own plan block is the only plan source. */
export function renderRoadmapPage(pageText: string, sources: RoadmapSources): string {
  const plan = readRoadmapPlan(pageText);
  const tasks = openTasks(plan, sources.trackerText);
  const nonProofs = extractEvidenceNonProofs(sources.evidenceText);
  const bodies: Record<RoadmapBlock, string> = {
    summary: renderSummary(plan, tasks),
    plan: renderPlan(plan),
    open: renderOpenWork(plan, tasks, nonProofs),
  };
  let next = pageText;
  for (const block of BLOCK_ORDER) {
    const spec = ROADMAP_BLOCKS[block];
    const pattern = new RegExp(`${escapeRegExp(spec.begin)}[\\s\\S]*?${escapeRegExp(spec.end)}`, "gu");
    const matches = [...next.matchAll(new RegExp(pattern.source, "gu"))];
    if (matches.length !== 1) fail(`the page must carry exactly one "${block}" generated block; found ${matches.length}`);
    next = next.replace(pattern, `${spec.begin}\n${bodies[block]}\n${spec.end}`);
  }
  return next;
}

/** Compares the page to the renderer's output and collects owner violations. Never writes. */
export function roadmapDrift(pageText: string, sources: RoadmapSources, repositoryRoot?: string): RoadmapReport {
  const root = repositoryRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const violations: string[] = [];
  let rendered: string;
  try {
    rendered = renderRoadmapPage(pageText, sources);
  } catch (error) {
    return Object.freeze({
      staleBlocks: [],
      violations: Object.freeze([error instanceof Error ? error.message : String(error)]),
    });
  }
  const staleBlocks: RoadmapBlock[] = [];
  for (const block of BLOCK_ORDER) {
    const current = blockBody(pageText, block);
    const next = blockBody(rendered, block);
    if (current !== next) staleBlocks.push(block);
  }
  let plan: RoadmapPlan;
  try {
    plan = readRoadmapPlan(pageText);
  } catch (error) {
    return Object.freeze({
      staleBlocks: Object.freeze(staleBlocks),
      violations: Object.freeze([...violations, error instanceof Error ? error.message : String(error)]),
    });
  }
  const milestoneIds = new Set(plan.milestones.map((milestone) => milestone.id));
  if (milestoneIds.size !== plan.milestones.length) violations.push("ROADMAP-PLAN.milestones holds a duplicate id");
  const itemIds = new Set<string>();
  for (const [kind, items] of [["workstreams", plan.workstreams], ["exitCriteria", plan.exitCriteria]] as const) {
    for (const item of items) {
      if (itemIds.has(item.id)) violations.push(`${kind}: duplicate item id ${item.id}`);
      itemIds.add(item.id);
      if (!milestoneIds.has(item.milestone)) violations.push(`${kind} ${item.id}: unknown milestone ${item.milestone}`);
    }
  }
  const openRows = taskRows(sources.trackerText).filter((row) => !row.done);
  const openIds = new Set(openRows.map((row) => row.id));
  if (openIds.size !== openRows.length) violations.push("TASKS.md holds two open rows with the same id");
  const sections = openSectionMap(sources.trackerText, openRows);
  for (const row of openRows) {
    const section = sections.get(row.id);
    if (section === undefined) violations.push(`TASKS.md open row ${row.id} has no section`);
    else if (plan.taskSections[section] === undefined) {
      violations.push(`TASKS.md open row ${row.id} is in section "${section}", which has no state rule in the ROADMAP-PLAN block`);
    }
  }
  for (const id of Object.keys(plan.taskOverrides)) {
    if (!openIds.has(id)) violations.push(`ROADMAP-PLAN.taskOverrides names ${id}, which is not an open TASKS.md row`);
  }
  for (const [key, evidence] of [
    ...plan.workstreams.map((item) => [`workstream ${item.id}`, item.evidence] as const),
    ...plan.exitCriteria.map((item) => [`exit criterion ${item.id}`, item.evidence] as const),
    ...plan.notPlanned.map((entry, index) => [`not planned[${index}]`, entry.evidence] as const),
    ...Object.entries(plan.taskSections).map(([section, rule]) => [`task section ${section}`, rule.evidence] as const),
    ...Object.entries(plan.taskOverrides).flatMap(([id, override]) => (override.evidence === undefined ? [] : [[`task override ${id}`, override.evidence] as const])),
  ]) {
    const problem = localEvidenceViolation(evidence, root);
    if (problem !== null) violations.push(`${key}: ${problem}`);
  }
  return Object.freeze({ staleBlocks: Object.freeze(staleBlocks), violations: Object.freeze(violations) });
}

function blockBody(pageText: string, block: RoadmapBlock): string {
  const spec = ROADMAP_BLOCKS[block];
  const pattern = new RegExp(`${escapeRegExp(spec.begin)}\\n([\\s\\S]*?)\\n${escapeRegExp(spec.end)}`, "u");
  const match = pattern.exec(pageText);
  return match?.[1] ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function cell(value: string): string {
  return normalizeProse(value).replace(/\|/gu, "\\|");
}

function html(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function link(evidence: string): string {
  if (/^https?:\/\//u.test(evidence)) return `[GitHub](${evidence})`;
  const hash = evidence.indexOf("#");
  const pathPart = hash === -1 ? evidence : evidence.slice(0, hash);
  const anchor = hash === -1 ? "" : evidence.slice(hash + 1);
  const label = pathPart.length === 0 ? "this page" : basename(pathPart).replace(/\.md$/u, "");
  return anchor.length === 0 ? `[${label}](${evidence})` : `[${label}: ${anchor}](${evidence})`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function milestoneAnchor(milestone: Milestone): string {
  return headingSlug(`${milestone.id} · ${milestone.title}`);
}

function milestoneLink(milestone: Milestone): string {
  return `[${milestone.id}](#${milestoneAnchor(milestone)})`;
}

function stateText(item: { state: RoadmapState; blockedBy?: string }): string {
  return item.blockedBy === undefined ? item.state : `${item.state} (blocked by: ${item.blockedBy})`;
}

function countState(items: readonly { state: RoadmapState }[], state: RoadmapState): number {
  return items.filter((item) => item.state === state).length;
}

function horizonOrder(horizon: Horizon): number {
  return HORIZONS.indexOf(horizon);
}

function renderSummary(plan: RoadmapPlan, tasks: readonly OpenTask[]): string {
  const tracked: readonly { state: RoadmapState }[] = [...plan.workstreams, ...plan.exitCriteria, ...tasks];
  const total = tracked.length;
  const shipped = countState(tracked, "shipped");
  const inProgress = countState(tracked, "in progress");
  const planned = countState(tracked, "planned");
  const blocked = countState(tracked, "blocked");
  const notPlanned = plan.notPlanned.length;
  const percent = total === 0 ? 0 : Math.round((shipped / total) * 100);
  const lines: string[] = [];
  lines.push("### Where the floor stands");
  lines.push("");
  lines.push(
    `**${shipped} of ${total} tracked items shipped (${percent}%).** The tracked total covers workstreams, exit criteria, and open TASKS.md rows. ${notPlanned} not-planned statements sit outside it.`,
  );
  lines.push("");
  lines.push(
    `${shipped} shipped · ${inProgress} in progress · ${planned} planned · ${blocked} blocked · ${notPlanned} not planned.`,
  );
  lines.push("");
  lines.push("### Milestones");
  lines.push("");
  lines.push("A milestone's state is its focus state; the item states are below. Shipped and open counts cover the workstreams and exit criteria assigned to it.");
  lines.push("");
  lines.push("| Milestone | Focus | Shipped | Open |");
  lines.push("|---|---|---|---|");
  for (const milestone of plan.milestones) {
    const items = [...plan.workstreams, ...plan.exitCriteria].filter((item) => item.milestone === milestone.id);
    lines.push(
      `| ${milestoneLink(milestone)} | ${cell(milestone.title)} | ${countState(items, "shipped")} | ${items.filter((item) => isOpen(item.state)).length} |`,
    );
  }
  lines.push("");
  lines.push("### Now / next / later");
  lines.push("");
  lines.push("Every tracked workstream or exit criterion, ordered by horizon. The plan below carries the exit criterion and source for each row.");
  lines.push("");
  const rows = [...plan.workstreams, ...plan.exitCriteria]
    .filter((item): item is RoadmapItem & { readonly horizon: Horizon } => item.horizon !== undefined)
    .sort((left, right) => horizonOrder(left.horizon) - horizonOrder(right.horizon))
    .map((item) => [
      cell(item.horizon),
      `**${cell(item.title)}**`,
      milestoneLink(plan.milestones.find((milestone) => milestone.id === item.milestone)!),
      cell(stateText(item)),
      cell(item.owner),
      link(item.evidence),
    ]);
  lines.push(table(["Horizon", "Work", "Milestone", "State", "Owner", "Evidence"], rows));
  return lines.join("\n");
}

function renderPlan(plan: RoadmapPlan): string {
  const lines: string[] = [];
  lines.push("### Milestone plan");
  lines.push("");
  lines.push("Each milestone group names its workstreams and exit criteria with the owner, state, exit criterion, evidence, and source. The Source column names the statement each row was carried from.");
  for (const milestone of plan.milestones) {
    const items = [...plan.workstreams, ...plan.exitCriteria].filter((item) => item.milestone === milestone.id);
    const open = items.filter((item) => isOpen(item.state)).length;
    const done = countState(items, "shipped");
    const workstreams = plan.workstreams.filter((item) => item.milestone === milestone.id);
    const exits = plan.exitCriteria.filter((item) => item.milestone === milestone.id);
    lines.push("");
    lines.push(`#### ${milestone.id} · ${html(milestone.title)} — ${cell(milestone.state)} (${done} shipped · ${open} open)`);
    lines.push("");
    lines.push("**Workstreams**");
    lines.push("");
    if (workstreams.length === 0) {
      lines.push("No workstream is recorded.");
    } else {
      const rows = workstreams.map((item) => [
        `**${cell(item.title)}**<br>Exit: ${cell(item.exit)}<br>Source: ${cell(item.source)}`,
        cell(stateText(item)),
        cell(item.owner),
        link(item.evidence),
      ]);
      lines.push(table(["Workstream", "State", "Owner", "Evidence"], rows));
    }
    lines.push("");
    lines.push("**Exit criteria**");
    lines.push("");
    if (exits.length === 0) {
      lines.push("No exit criterion is recorded.");
    } else {
      const rows = exits.map((item) => [
        `**${cell(item.exit)}**<br>Source: ${cell(item.source)}`,
        cell(stateText(item)),
        cell(item.owner),
        link(item.evidence),
      ]);
      lines.push(table(["Exit criterion", "State", "Owner", "Evidence"], rows));
    }
  }
  return lines.join("\n");
}

function renderOpenWork(plan: RoadmapPlan, tasks: readonly OpenTask[], nonProofs: readonly EvidenceNonProof[]): string {
  const lines: string[] = [];
  lines.push("### Open task board");
  lines.push("");
  lines.push("Every open row of [TASKS.md](../trackers/TASKS.md) appears here. A row leaves this table only when its tracker row closes; the state rule and exit criterion for each tracker section are declared in the ROADMAP-PLAN block.");
  const sections = [...new Set(tasks.map((task) => task.section))];
  for (const section of sections) {
    const sectionTasks = tasks.filter((task) => task.section === section);
    lines.push("");
    lines.push(`#### ${section}`);
    lines.push("");
    const rows = sectionTasks.map((task) => [
      `**${cell(task.row.id)}**<br>Exit: ${cell(task.exit)}`,
      cell(stateText(task)),
      cell(task.owner),
      link(task.evidence),
    ]);
    lines.push(table(["Task", "State", "Owner", "Evidence"], rows));
  }
  if (tasks.length === 0) {
    lines.push("");
    lines.push("No open task row remains.");
  }
  lines.push("");
  lines.push("### What the evidence does not prove");
  lines.push("");
  lines.push("The public evidence page names what its receipts do not establish. These statements are not coverage and not a pass.");
  lines.push("");
  if (nonProofs.length === 0) {
    lines.push("No non-proof is recorded.");
  } else {
    const rows = nonProofs.map((nonProof) => [
      cell(nonProof.area),
      `[${cell(nonProof.text)}](evidence.md#${nonProof.anchor})`,
    ]);
    lines.push(table(["Evidence area", "Not proved"], rows));
  }
  lines.push("");
  lines.push("### Not planned");
  lines.push("");
  lines.push("Deliberate non-goals, kept here with their reason.");
  lines.push("");
  if (plan.notPlanned.length === 0) {
    lines.push("No not-planned statement is recorded.");
  } else {
    const rows = plan.notPlanned.map((entry) => [cell(entry.statement), cell(entry.reason), link(entry.evidence)]);
    lines.push(table(["Not planned", "Why", "Evidence"], rows));
  }
  return lines.join("\n");
}

function readSources(repositoryRoot: string): RoadmapSources {
  return Object.freeze({
    trackerText: readFileSync(join(repositoryRoot, TASKS_PATH), "utf8"),
    evidenceText: readFileSync(join(repositoryRoot, EVIDENCE_PATH), "utf8"),
  });
}

function run(argv: readonly string[]): number {
  const check = argv.includes("--check");
  if (argv.some((argument) => argument !== "--check" && argument !== "--write")) {
    process.stderr.write("usage: roadmap-status [--write|--check]\n");
    return 1;
  }
  const write = !check;
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const pagePath = join(repositoryRoot, ROADMAP_PATH);
  const page = readFileSync(pagePath, "utf8");
  const sources = readSources(repositoryRoot);
  const report = roadmapDrift(page, sources, repositoryRoot);
  if (report.violations.length > 0) {
    process.stdout.write(`${JSON.stringify({ allCurrent: false, status: "invalid", changed: [], violations: report.violations })}\n`);
    return 1;
  }
  if (report.staleBlocks.length === 0) {
    process.stdout.write(`${JSON.stringify({ allCurrent: true, status: "current", changed: [] })}\n`);
    return 0;
  }
  if (!write) {
    process.stdout.write(`${JSON.stringify({ allCurrent: false, status: "stale", changed: report.staleBlocks })}\n`);
    return 1;
  }
  const next = renderRoadmapPage(page, sources);
  const written = atomicWriteFile(pagePath, next);
  if (!written.success) {
    process.stdout.write(`${JSON.stringify({ allCurrent: false, status: "write-failed", changed: [], reason: written.reason ?? "unknown" })}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify({ allCurrent: true, status: "regenerated", changed: report.staleBlocks })}\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
