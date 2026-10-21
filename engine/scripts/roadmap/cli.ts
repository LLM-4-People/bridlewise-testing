/**
 * THE ROADMAP GENERATOR — one command for every roadmap surface.
 *
 *   node scripts/roadmap/cli.ts readme --check|--write
 *       The root README's roadmap summary (`ROADMAP_README_BLOCK`). Run by
 *       `harness sync` (write) and `harness check` (check); prints ONE JSON
 *       line, the last: `{ allCurrent, status, changed }`.
 *   node scripts/roadmap/cli.ts build --site <assembled source> --out <dir> [--checks <status.json>]
 *                                      (--live <snapshot.json> | --no-live <reason>)
 *       The site's roadmap: the page body between the markers of the assembled
 *       `floor/roadmap.md` (ROADMAP_PAGE_BLOCK), `<out>/print/index.md`
 *       (the one-pager), `<out>/feed.xml` (the weekly digest), and
 *       `<out>/data/roadmap.json` + `<out>/data/history.json` (the model and
 *       the replayable history, for the projector and the page's time travel).
 *       Run by the site build at publish (GH-5), after the floor data.
 *   node scripts/roadmap/cli.ts diff <a> <b>
 *       What changed in the roadmap between two versions (a commit that changed
 *       the items, or an ISO date), as JSON. The page's time travel folds the
 *       same history in the browser (`data/history.json`).
 *
 * The live snapshot is required to be named either way: `--no-live <reason>`
 * states why there is none, and the page shows that reason; nothing is
 * substituted.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { HarnessError, InputError } from "../../src/kernel/errors.ts";
import { ROADMAP_README_BLOCK } from "../../src/kernel/verification-paths.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { readTrackerItems } from "../../src/workflow/failure-owners.ts";
import { readClaims } from "../brand/claims.ts";
import { readMessaging } from "../brand/messaging.ts";
import { criticalPath, dependencyGraph, GRAPH_SCRIPT, layoutGraph, renderGraphSvg } from "./graph.ts";
import { forecast, isoWeek } from "./forecast.ts";
import { burnUp, changesBetween, commitAt, historyChanges, historyDocument, itemTrailers, replayHistory, snapshotAt, weeklyThroughput } from "./history.ts";
import { readChecks, readDecisions, readLive, unresolvedLinks, type CheckResult, type LiveSnapshot } from "./inputs.ts";
import { buildRoadmap, type HistoryFacts } from "./model.ts";
import { ROADMAP_PAGE_BLOCK, TIMELINE_SCRIPT, renderFeed, renderJson, renderPage, renderPrint, renderReadmeBlock, timelineDocument, type RenderContext } from "./render.ts";
import type { Roadmap, RoadmapItem } from "./types.ts";

const REPOSITORY_ROOT = dirname(fileURLToPath(new URL("../../", import.meta.url)));

export type RoadmapReadmeReport = Readonly<{ allCurrent: boolean; status: "current" | "regenerated" | "stale" | "absent"; changed: readonly string[] }>;

const graphCriticalPath = (items: readonly RoadmapItem[], milestoneId: string): readonly string[] => criticalPath(dependencyGraph(items), milestoneId);

/** The records-only model (no history, checks or live data): what the README summary renders. */
function recordsModel(root: string): Roadmap {
  const items = readTrackerItems(root);
  const decisions = readDecisions(root);
  const problems = unresolvedLinks(root, items, decisions, existsSync);
  if (problems.length > 0) throw new InputError(`the tracker items link to records that do not exist:\n${problems.join("\n")}`, "roadmap_link_unknown");
  const claims = readClaims(root, new Set(decisions.map((d) => d.id)));
  return buildRoadmap({
    repository: readMessaging(root).repositoryUrl,
    commit: "",
    committedAt: "",
    items,
    decisions,
    claims,
    checks: null,
    live: null,
    liveReason: "the README summary is rendered from the records alone",
    history: null,
    criticalPath: graphCriticalPath,
    forecast: (remaining, throughput, seed) => forecast({ remaining, weekly: [], weeksOfData: 0, seed, asOfWeek: throughput?.asOfWeek ?? "1970-W01" }),
  });
}

/** Judges (and with `write`, rewrites) the README's roadmap summary of the repository at `root`. */
export function syncRoadmapReadme(root: string, write: boolean): RoadmapReadmeReport {
  const path = join(root, ROADMAP_README_BLOCK.path);
  if (!existsSync(path) || !existsSync(join(root, "docs/trackers/items"))) return Object.freeze({ allCurrent: true, status: "absent", changed: [] });
  const readme = readFileSync(path, "utf8");
  const begin = readme.indexOf(ROADMAP_README_BLOCK.begin);
  const end = readme.indexOf(ROADMAP_README_BLOCK.end);
  if (begin < 0 || end < begin) throw new HarnessError(`${ROADMAP_README_BLOCK.path} carries no roadmap summary block (ROADMAP_README_BLOCK in src/kernel/verification-paths.ts)`, "roadmap_readme_block_missing");
  const messaging = readMessaging(root);
  const ctx: RenderContext = { repositoryUrl: messaging.repositoryUrl, roadmapUrl: `${messaging.siteUrl}floor/roadmap/`, graphSvg: null, script: null };
  const block = renderReadmeBlock(recordsModel(root), ctx);
  const next = `${readme.slice(0, begin + ROADMAP_README_BLOCK.begin.length)}\n${block}\n${readme.slice(end)}`;
  if (next === readme) return Object.freeze({ allCurrent: true, status: "current", changed: [] });
  if (!write) return Object.freeze({ allCurrent: false, status: "stale", changed: [ROADMAP_README_BLOCK.path] });
  const written = atomicWriteFile(path, next);
  if (!written.success) throw new HarnessError(`Failed to write ${ROADMAP_README_BLOCK.path}: ${written.reason ?? "unknown error"}`, "roadmap_readme_write_failed");
  return Object.freeze({ allCurrent: true, status: "regenerated", changed: [ROADMAP_README_BLOCK.path] });
}

function write(path: string, text: string): void {
  // Served files: world-readable like everything the site publishes.
  const written = atomicWriteFile(path, text, { exactMode: 0o644 });
  if (!written.success) throw new HarnessError(`Failed to write ${path}: ${written.reason ?? "unknown error"}`, "roadmap_write_failed");
}

/** The full site roadmap of the checkout at `root` (its HEAD), written into the assembled `site` and under `out`. */
export function buildSite(root: string, out: string, options: Readonly<{ site: string; checks: readonly CheckResult[] | null; live: LiveSnapshot | null; liveReason: string }>): Roadmap {
  const head = commitAt(root, "HEAD");
  const history = replayHistory(root, head.sha);
  const items = readTrackerItems(root);
  const decisions = readDecisions(root);
  const problems = unresolvedLinks(root, items, decisions, existsSync);
  if (problems.length > 0) throw new InputError(`the tracker items link to records that do not exist:\n${problems.join("\n")}`, "roadmap_link_unknown");
  const claims = readClaims(root, new Set(decisions.map((d) => d.id)));
  const messaging = readMessaging(root);
  const trailers = itemTrailers(root, head.sha);
  const throughput = weeklyThroughput(history, head.date, 12);
  const facts: HistoryFacts = {
    changes: historyChanges(history),
    burnUp: (milestoneId) => burnUp(history, milestoneId),
    trailers: Object.fromEntries(Object.entries(trailers).map(([id, refs]) => [id, refs.map((ref) => (ref.pr === null ? ref.sha : `#${ref.pr}`))])),
    throughput: { weekly: throughput.weeks.map((w) => w.closed), weeksOfData: throughput.weeksOfData, asOfWeek: isoWeek(head.date) },
  };
  const model = buildRoadmap({
    repository: messaging.repositoryUrl,
    commit: head.sha,
    committedAt: head.date,
    items,
    decisions,
    claims,
    checks: options.checks,
    live: options.live,
    liveReason: options.liveReason,
    history: facts,
    criticalPath: graphCriticalPath,
    forecast: (remaining, t, seed) => forecast({ remaining, weekly: [...(t?.weekly ?? [])], weeksOfData: t?.weeksOfData ?? 0, seed, asOfWeek: t?.asOfWeek ?? "" }),
  });
  const graph = dependencyGraph(model.items);
  const critical = new Set(model.milestones.flatMap((m) => m.criticalPath));
  const ctx: RenderContext = {
    repositoryUrl: messaging.repositoryUrl,
    roadmapUrl: `${messaging.siteUrl}floor/roadmap/`,
    graphSvg: graph.edges.length === 0 ? null : renderGraphSvg(layoutGraph(graph), model.items, critical),
    script: `${GRAPH_SCRIPT}\n${TIMELINE_SCRIPT}`,
  };
  const pagePath = join(options.site, ROADMAP_PAGE_BLOCK.path.replace(/^docs\//u, ""));
  const shell = readFileSync(pagePath, "utf8");
  const begin = shell.indexOf(ROADMAP_PAGE_BLOCK.begin);
  const end = shell.indexOf(ROADMAP_PAGE_BLOCK.end);
  if (begin < 0 || end < begin) throw new HarnessError(`${pagePath} carries no roadmap block (ROADMAP_PAGE_BLOCK in scripts/roadmap/render.ts)`, "roadmap_page_block_missing");
  write(pagePath, `${shell.slice(0, begin + ROADMAP_PAGE_BLOCK.begin.length)}\n${renderPage(model, ctx)}\n${shell.slice(end)}`);
  write(join(out, "print", "index.md"), renderPrint(model, ctx));
  write(join(out, "feed.xml"), renderFeed(model, ctx, facts.changes));
  write(join(out, "data", "roadmap.json"), renderJson(model));
  write(join(out, "data", "history.json"), `${JSON.stringify(historyDocument(history, trailers))}\n`);
  const commits = history.snapshots.map((snapshot) => ({ sha: snapshot.sha, date: snapshot.date }));
  write(join(out, "data", "timeline.json"), `${JSON.stringify(timelineDocument(model, commits, facts.changes))}\n`);
  return model;
}

function run(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (command === "readme") {
    const { values } = parseArgs({ args: rest, options: { check: { type: "boolean" }, write: { type: "boolean" } } });
    if (values.check === values.write) throw new InputError("Usage: roadmap readme --check|--write", "input_error");
    const report = syncRoadmapReadme(REPOSITORY_ROOT, values.write === true);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.allCurrent ? 0 : 1;
  }
  if (command === "build") {
    const { values } = parseArgs({ args: rest, options: { site: { type: "string" }, out: { type: "string" }, checks: { type: "string" }, live: { type: "string" }, "no-live": { type: "string" } } });
    if (values.site === undefined || values.out === undefined) throw new InputError("roadmap build needs --site <assembled site source> and --out <dir>", "input_error");
    if ((values.live === undefined) === (values["no-live"] === undefined)) throw new InputError("roadmap build needs exactly one of --live <snapshot.json> or --no-live <reason>", "input_error");
    const model = buildSite(REPOSITORY_ROOT, values.out, {
      site: values.site,
      checks: values.checks === undefined ? null : readChecks(values.checks),
      live: values.live === undefined ? null : readLive(values.live),
      liveReason: values["no-live"] ?? "",
    });
    process.stdout.write(`${JSON.stringify({ commit: model.commit, items: model.items.length, milestones: model.milestones.length, out: values.out })}\n`);
    return 0;
  }
  if (command === "diff") {
    if (rest.length !== 2) throw new InputError("Usage: roadmap diff <a> <b>", "input_error");
    const history = replayHistory(REPOSITORY_ROOT, "HEAD");
    const a = snapshotAt(history, rest[0]!);
    const b = snapshotAt(history, rest[1]!);
    process.stdout.write(`${JSON.stringify({ from: a.sha, to: b.sha, changes: changesBetween(a.items, b.items, b.sha, b.date) }, null, 1)}\n`);
    return 0;
  }
  throw new InputError("Usage: roadmap readme --check|--write | build --out <dir> … | diff <a> <b>", "input_error");
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = run(process.argv.slice(2));
}
