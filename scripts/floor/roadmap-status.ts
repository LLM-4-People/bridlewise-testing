/**
 * THE ROADMAP STATUS GENERATOR: `docs/floor/roadmap.md`'s status blocks,
 * rebuilt from their owners.
 *
 *   npm run docs:roadmap              # rewrite the three generated blocks
 *   npm run docs:roadmap -- --check   # exit 1 when a block is stale
 *
 * The owners are:
 *
 *   - the structured tracker items (`docs/trackers/items/`, read through the
 *     tracker's one parser, `engine/src/workflow/failure-owners.ts`): the
 *     Milestones, the roadmap's workstreams and exit criteria (lane
 *     `roadmap`, each naming its milestone), its not-planned statements
 *     (closed as not planned), and every other open item (the open board);
 *   - the decision records (`docs/decisions/`), whose progress is evidence;
 *   - `docs/floor/evidence.md`'s explicit non-proofs (`What this does not
 *     prove`, the audit-scope paragraph, and `What none of this proves`).
 *
 * EVERY STATE IS COMPUTED: a close is the item's recorded claim, `shipped`
 * only when linked evidence proves it and `claimed` otherwise; in progress, planned,
 * blocked or not planned comes from the item's own facts, its sub-items, what
 * it is blocked by and the decisions it carries out
 * (`engine/src/workflow/tracker-status.ts`), and the reason is printed beside
 * the state. A milestone's state is its members'.
 *
 * No rendered table is hand-editable: `npm run docs:roadmap` is the only
 * writer, and `tests/prevention/roadmap-status-owner.test.ts` refuses a page
 * that differs from the renderer's output or a page that omits an open item,
 * a roadmap item, or an evidence non-proof.
 *
 * The prose outside the generated markers stays hand-written, including the
 * `## Snapshot` anchor other pages link to.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { bootstrapProcess, isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";
import { TRACKER_BOARD } from "../../engine/src/kernel/verification-paths.ts";
import { readDecisionRecords, readTrackerItems, rebaseRelativeLinks, TRACKER_LANES, type DecisionRecord, type TrackerItem } from "../../engine/src/workflow/failure-owners.ts";
import { relativePath } from "../../engine/src/workflow/markdown-links.ts";
import { itemStatuses, ROADMAP_STATES, type ItemStatus, type RoadmapState } from "../../engine/src/workflow/tracker-status.ts";
import { itemMarkupViolation } from "../../engine/src/workflow/failure-owners.ts";
import { recordedEvidence } from "../../engine/src/workflow/evidence-store.ts";
// The site tooling is plain Node ESM with no declaration file (the same import the floor-site tests make).
// @ts-expect-error -- a .mjs module has no declaration file in the TS program.
import { TESTING_REPO_URL } from "./site-pages.mjs";

/** This repository's URL: only its own pull requests, runs and releases prove a close (`closeProof`). */
const REPOSITORY_URL: string = TESTING_REPO_URL;
import { escapeHtml, escapeMarkdownTableCell, stripTags } from "../../shared/markup.ts";

export const ROADMAP_PATH = "docs/floor/roadmap.md";
export const EVIDENCE_PATH = "docs/floor/evidence.md";
const PAGE_DIRECTORY = dirname(ROADMAP_PATH);

export const ROADMAP_BLOCKS = {
  milestones: {
    begin: "<!-- BEGIN GENERATED: roadmap milestones, from the Milestone tracker items (npm run docs:roadmap; scripts/floor/roadmap-status.ts) -->",
    end: "<!-- END GENERATED: roadmap milestones -->",
  },
  summary: {
    begin: "<!-- BEGIN GENERATED: roadmap summary, from the tracker items and the decision records (npm run docs:roadmap; scripts/floor/roadmap-status.ts) -->",
    end: "<!-- END GENERATED: roadmap summary -->",
  },
  plan: {
    begin: "<!-- BEGIN GENERATED: roadmap workstreams and exit criteria, from the tracker items (npm run docs:roadmap; scripts/floor/roadmap-status.ts) -->",
    end: "<!-- END GENERATED: roadmap workstreams and exit criteria -->",
  },
  open: {
    begin: "<!-- BEGIN GENERATED: roadmap open work, from the tracker items and docs/floor/evidence.md (npm run docs:roadmap; scripts/floor/roadmap-status.ts) -->",
    end: "<!-- END GENERATED: roadmap open work -->",
  },
} as const;

export type RoadmapBlock = keyof typeof ROADMAP_BLOCKS;
const BLOCK_ORDER: readonly RoadmapBlock[] = Object.keys(ROADMAP_BLOCKS) as readonly RoadmapBlock[];
const HORIZONS = ["now", "next", "later"] as const;

export type EvidenceNonProof = Readonly<{ area: string; anchor: string; text: string }>;

/** The roadmap's owners: the items, the decision records, the evidence paths recorded in tracked manifests (a close's proof), the evidence page. */
export type RoadmapSources = Readonly<{ items: readonly TrackerItem[]; decisions: readonly DecisionRecord[]; recordedEvidence: ReadonlySet<string>; evidenceText: string }>;

export type RoadmapReport = Readonly<{
  staleBlocks: readonly RoadmapBlock[];
  violations: readonly string[];
}>;

/** The roadmap, read from its items: the milestones in order, each one's plan items, the open board, the not-planned statements, every computed state. */
type Roadmap = Readonly<{
  milestones: readonly TrackerItem[];
  workstreams: readonly TrackerItem[];
  exitCriteria: readonly TrackerItem[];
  board: readonly TrackerItem[];
  notPlanned: readonly TrackerItem[];
  status: (item: TrackerItem) => ItemStatus;
}>;

function fail(message: string): never {
  throw new Error(message);
}

const byOrder = (left: TrackerItem, right: TrackerItem): number =>
  (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

function readRoadmap(sources: RoadmapSources): Roadmap {
  const statuses = itemStatuses(sources.items, { decisions: sources.decisions, recordedEvidence: sources.recordedEvidence, repositoryUrl: REPOSITORY_URL });
  const status = (item: TrackerItem): ItemStatus => statuses.get(item.id) ?? fail(`no state was computed for ${item.id}`);
  const plan = sources.items.filter((item) => item.lane === "roadmap" && item.milestone !== null);
  return Object.freeze({
    milestones: sources.items.filter((item) => item.type === "Milestone").sort(byOrder),
    workstreams: plan.filter((item) => item.type === "Workstream").sort(byOrder),
    exitCriteria: plan.filter((item) => item.type !== "Workstream").sort(byOrder),
    board: sources.items.filter((item) => item.state === "open" && item.milestone === null).sort(byOrder),
    notPlanned: sources.items.filter((item) => item.lane === "roadmap" && item.milestone === null && status(item).state === "not planned").sort(byOrder),
    status,
  });
}

/** Every way an item's text would publish markup (the item format's judgement, applied again to whatever items the renderer is handed). */
function markupViolations(items: readonly TrackerItem[]): readonly string[] {
  return items.flatMap((item) => {
    const title = item.title !== null && /<[A-Za-z/!?]/u.test(item.title) ? [`${item.id}: its title opens markup: a title is text, never markup`] : [];
    const body = itemMarkupViolation(item.body);
    return [...title, ...(body === null ? [] : [`${item.id}: ${body}`])];
  });
}

function isOpen(state: RoadmapState): boolean {
  return state === "in progress" || state === "planned" || state === "blocked";
}

/** The GitHub / kramdown heading id: punctuation is removed, then each remaining space becomes a hyphen. */
export function headingSlug(heading: string): string {
  return stripTags(heading)
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


/** A repository evidence path (`docs/…/page.md#anchor`) that names no file, or no heading of it. */
function localEvidenceViolation(evidence: string, repositoryRoot: string): string | null {
  if (/^https?:\/\//u.test(evidence) || evidence.startsWith("evidence:")) return null;
  const hash = evidence.indexOf("#");
  const pathPart = hash === -1 ? evidence : evidence.slice(0, hash);
  const anchor = hash === -1 ? "" : evidence.slice(hash + 1);
  const target = join(repositoryRoot, pathPart);
  if (!existsSync(target)) return `${evidence}: target does not exist`;
  if (anchor.length > 0 && target.endsWith(".md") && !markdownHeadings(readFileSync(target, "utf8")).has(anchor)) return `${evidence}: no heading anchor #${anchor} in ${pathPart}`;
  return null;
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


/** Renders the generated blocks from the items. Item text that would publish markup is refused, never rendered. */
export function renderRoadmapPage(pageText: string, sources: RoadmapSources): string {
  const markup = markupViolations(sources.items);
  if (markup.length > 0) fail(`item text would publish markup:\n${markup.join("\n")}`);
  const roadmap = readRoadmap(sources);
  const nonProofs = extractEvidenceNonProofs(sources.evidenceText);
  const bodies: Record<RoadmapBlock, string> = {
    milestones: renderMilestones(roadmap),
    summary: renderSummary(roadmap),
    plan: renderPlan(roadmap),
    open: renderOpenWork(roadmap, nonProofs),
  };
  let next = pageText;
  for (const block of BLOCK_ORDER) {
    const spec = ROADMAP_BLOCKS[block];
    const pattern = new RegExp(`${escapeRegExp(spec.begin)}[\\s\\S]*?${escapeRegExp(spec.end)}`, "gu");
    const matches = [...next.matchAll(new RegExp(pattern.source, "gu"))];
    if (matches.length !== 1) fail(`the page must carry exactly one "${block}" generated block; found ${matches.length}`);
    next = next.replace(pattern, `${spec.begin}\n${bodies[block].replace(/\n+$/u, "")}\n\n${spec.end}`);
  }
  return next;
}

/** Compares the page to the renderer's output and collects owner violations. Never writes. */
export function roadmapDrift(pageText: string, sources: RoadmapSources, repositoryRoot?: string): RoadmapReport {
  const root = repositoryRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  let rendered: string;
  try {
    rendered = renderRoadmapPage(pageText, sources);
  } catch (error) {
    return Object.freeze({ staleBlocks: [], violations: Object.freeze([error instanceof Error ? error.message : String(error)]) });
  }
  const staleBlocks = BLOCK_ORDER.filter((block) => blockBody(pageText, block) !== blockBody(rendered, block));
  const violations: string[] = [];
  const roadmap = readRoadmap(sources);
  if (roadmap.milestones.length === 0) violations.push("the tracker holds no Milestone item");
  for (const item of sources.items.filter((entry) => entry.lane === "roadmap" && entry.milestone === null && entry.state === "open")) {
    violations.push(`roadmap item ${item.id} is open and names no milestone (an open roadmap item belongs to one)`);
  }
  for (const item of sources.items) {
    if (item.evidence === null) continue;
    const problem = localEvidenceViolation(item.evidence, root);
    if (problem !== null) violations.push(`${item.id}: ${problem}`);
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
  return escapeMarkdownTableCell(normalizeProse(value));
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}


/** A link from the roadmap page to an item's own record. */
function itemLink(item: TrackerItem): string {
  return `[${cell(escapeHtml(item.title ?? item.id))}](${relativePath(PAGE_DIRECTORY, `${TRACKER_BOARD.items}/${item.id}.md`)})`;
}

/** The first paragraph of an item's body: its outcome, in one cell. */
function outcome(item: TrackerItem): string {
  return cell(item.body.split(/\n\s*\n/u)[0] ?? "");
}

function link(evidence: string | null): string {
  if (evidence === null) return "—";
  if (/^https?:\/\//u.test(evidence)) return `[GitHub](${evidence})`;
  const hash = evidence.indexOf("#");
  const pathPart = hash === -1 ? evidence : evidence.slice(0, hash);
  const anchor = hash === -1 ? "" : evidence.slice(hash + 1);
  const target = pathPart === ROADMAP_PATH ? "" : relativePath(PAGE_DIRECTORY, pathPart);
  const label = pathPart === ROADMAP_PATH ? "this page" : basename(pathPart).replace(/\.md$/u, "");
  return anchor.length === 0 ? `[${label}](${target})` : `[${label}: ${anchor}](${target}#${anchor})`;
}

function milestoneAnchor(milestone: TrackerItem): string {
  return headingSlug(`${milestone.id} · ${milestone.title ?? milestone.id}`);
}

function milestoneLink(roadmap: Roadmap, id: string | null): string {
  const milestone = roadmap.milestones.find((entry) => entry.id === id);
  return milestone === undefined ? "—" : `[${milestone.id}](#${milestoneAnchor(milestone)})`;
}

/** The state and, for anything but a plain shipped or planned item, the evidence it rests on. */
/** Each milestone's section, from its Milestone item alone (the one place its title and prose are written): `## <id> · <title>` (the anchor every link targets) and its body, links rebased to this page. */
function renderMilestones(roadmap: Roadmap): string {
  return roadmap.milestones.map((milestone) => [
    `## ${milestone.id} · ${escapeHtml(milestone.title ?? milestone.id)}`,
    "",
    `**State:** ${roadmap.status(milestone).state} — ${roadmap.status(milestone).because}. [The record](${relativePath(PAGE_DIRECTORY, `${TRACKER_BOARD.items}/${milestone.id}.md`)}).`,
    "",
    rebaseRelativeLinks(milestone.body, TRACKER_BOARD.items, PAGE_DIRECTORY),
  ].join("\n")).join("\n\n---\n\n");
}

/** The state, and for an open state its evidence; a claim reads as the unverified claim it is. */
function stateText(status: ItemStatus): string {
  if (status.state === "claimed") return "claimed, unverified";
  return status.state === "shipped" || status.state === "planned" ? status.state : `${status.state} (${status.because})`;
}

function count(roadmap: Roadmap, items: readonly TrackerItem[], state: RoadmapState): number {
  return items.filter((item) => roadmap.status(item).state === state).length;
}

function renderSummary(roadmap: Roadmap): string {
  const planItems = [...roadmap.workstreams, ...roadmap.exitCriteria].filter((item) => roadmap.status(item).state !== "not planned");
  const tracked = [...planItems, ...roadmap.board];
  const total = tracked.length;
  const tally = Object.fromEntries(ROADMAP_STATES.map((state) => [state, count(roadmap, tracked, state)])) as Record<RoadmapState, number>;
  const percent = total === 0 ? 0 : Math.round((tally.shipped / total) * 100);
  const lines: string[] = [];
  lines.push("### Where the floor stands");
  lines.push("");
  lines.push(`**${tally.shipped} of ${total} tracked items shipped (${percent}%).** The tracked total covers the roadmap's workstreams and exit criteria and every open tracker item. ${roadmap.notPlanned.length} not-planned statements sit outside it. A close counts as shipped only when linked evidence proves it; a close without proof reads claimed.`);
  lines.push("");
  lines.push(`${tally.shipped} shipped · ${tally.claimed} claimed, unverified · ${tally["in progress"]} in progress · ${tally.planned} planned · ${tally.blocked} blocked · ${roadmap.notPlanned.length} not planned.`);
  lines.push("");
  lines.push("### Milestones");
  lines.push("");
  lines.push("A milestone's state is computed from its members: shipped when every planned member shipped (proven), claimed when every member is closed but some only by an unverified claim, in progress when any proven work landed. Shipped and open count the workstreams and exit criteria assigned to it.");
  lines.push("");
  lines.push(table(["Milestone", "Focus", "State", "Shipped", "Open"], roadmap.milestones.map((milestone) => {
    const members = [...roadmap.workstreams, ...roadmap.exitCriteria].filter((item) => item.milestone === milestone.id);
    return [
      milestoneLink(roadmap, milestone.id),
      cell(milestone.title ?? milestone.id),
      cell(roadmap.status(milestone).state),
      String(count(roadmap, members, "shipped")),
      String(members.filter((item) => isOpen(roadmap.status(item).state)).length),
    ];
  })));
  lines.push("");
  lines.push("### Now / next / later");
  lines.push("");
  lines.push("Every open workstream or exit criterion that names a horizon, ordered by horizon, then milestone, then rank. The plan below carries every item.");
  lines.push("");
  const milestoneRank = (item: TrackerItem): number => roadmap.milestones.findIndex((milestone) => milestone.id === item.milestone);
  const rows = [...roadmap.workstreams, ...roadmap.exitCriteria]
    .filter((item) => item.horizon !== null && isOpen(roadmap.status(item).state))
    .sort((left, right) => HORIZONS.indexOf(left.horizon!) - HORIZONS.indexOf(right.horizon!) || milestoneRank(left) - milestoneRank(right) || byOrder(left, right))
    .map((item) => [cell(item.horizon!), `**${itemLink(item)}**`, milestoneLink(roadmap, item.milestone), cell(stateText(roadmap.status(item))), cell(item.ownerRole ?? "—"), link(item.evidence)]);
  lines.push(table(["Horizon", "Work", "Milestone", "State", "Owner", "Evidence"], rows));
  return lines.join("\n");
}

function planTable(roadmap: Roadmap, heading: string, items: readonly TrackerItem[]): string {
  if (items.length === 0) return `No ${heading.toLowerCase()} is recorded.`;
  return table([heading, "State", "Owner", "Evidence"], items.map((item) => [
    `**${itemLink(item)}**<br>Exit: ${outcome(item)}`,
    cell(stateText(roadmap.status(item))),
    cell(item.ownerRole ?? "—"),
    link(item.evidence),
  ]));
}

function renderPlan(roadmap: Roadmap): string {
  const lines: string[] = [];
  lines.push("### Milestone plan");
  lines.push("");
  lines.push("Each milestone group names its workstreams and exit criteria with the owner, the computed state, the exit criterion and the evidence. Each title links to its record, which carries where it was carried from, its links and its history.");
  for (const milestone of roadmap.milestones) {
    const items = [...roadmap.workstreams, ...roadmap.exitCriteria].filter((item) => item.milestone === milestone.id);
    lines.push("");
    lines.push(`#### ${milestone.id} · ${escapeHtml(milestone.title ?? milestone.id)} — ${cell(roadmap.status(milestone).state)} (${count(roadmap, items, "shipped")} shipped · ${items.filter((item) => isOpen(roadmap.status(item).state)).length} open)`);
    lines.push("");
    lines.push("**Workstreams**");
    lines.push("");
    lines.push(planTable(roadmap, "Workstream", roadmap.workstreams.filter((item) => item.milestone === milestone.id)));
    lines.push("");
    lines.push("**Exit criteria**");
    lines.push("");
    lines.push(planTable(roadmap, "Exit criterion", roadmap.exitCriteria.filter((item) => item.milestone === milestone.id)));
  }
  return lines.join("\n");
}

function renderOpenWork(roadmap: Roadmap, nonProofs: readonly EvidenceNonProof[]): string {
  const lines: string[] = [];
  lines.push("### Open task board");
  lines.push("");
  lines.push("Every open tracker item outside the milestone plan appears here, by lane. An item leaves this table only when it closes.");
  for (const [lane, { heading }] of Object.entries(TRACKER_LANES)) {
    const items = roadmap.board.filter((item) => item.lane === lane);
    if (items.length === 0) continue;
    lines.push("");
    lines.push(`#### ${heading}`);
    lines.push("");
    lines.push(table(["Task", "State", "Owner", "Evidence"], items.map((item) => [
      `**${itemLink(item)}**`,
      cell(stateText(roadmap.status(item))),
      cell(item.ownerRole ?? "—"),
      link(item.evidence),
    ])));
  }
  if (roadmap.board.length === 0) {
    lines.push("");
    lines.push("No open item remains.");
  }
  lines.push("");
  lines.push("### What the evidence does not prove");
  lines.push("");
  lines.push("The public evidence page names what its receipts do not establish. These statements are not coverage and not a pass.");
  lines.push("");
  if (nonProofs.length === 0) {
    lines.push("No non-proof is recorded.");
  } else {
    lines.push(table(["Evidence area", "Not proved"], nonProofs.map((nonProof) => [cell(nonProof.area), `[${cell(nonProof.text)}](evidence.md#${nonProof.anchor})`])));
  }
  lines.push("");
  lines.push("### Not planned");
  lines.push("");
  lines.push("Deliberate non-goals, kept here with their reason.");
  lines.push("");
  if (roadmap.notPlanned.length === 0) {
    lines.push("No not-planned statement is recorded.");
  } else {
    lines.push(table(["Not planned", "Why", "Evidence"], roadmap.notPlanned.map((item) => [itemLink(item), outcome(item), link(item.evidence)])));
  }
  return lines.join("\n");
}

function readSources(repositoryRoot: string): RoadmapSources {
  return Object.freeze({
    items: readTrackerItems(repositoryRoot),
    decisions: readDecisionRecords(repositoryRoot),
    recordedEvidence: new Set(recordedEvidence(repositoryRoot).keys()),
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

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = run(process.argv.slice(2));
}
