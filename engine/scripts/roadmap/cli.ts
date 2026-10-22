/**
 * THE ROADMAP RENDERER'S COMMAND, run by the site build after the roadmap
 * feed is computed:
 *
 *   node scripts/tooling/roadmap-feed.ts --at HEAD --repository-url <url> --out <site>/floor/roadmap/data/roadmap.json
 *   node scripts/roadmap/cli.ts build --feed <site>/floor/roadmap/data/roadmap.json --site <site> --out <site>/floor/roadmap
 *
 * It writes the page body between the publish markers of the assembled
 * `floor/roadmap.md` (`ROADMAP_PAGE_BLOCK`), `<out>/print/index.md` and
 * `<out>/feed.xml`. Its only data is the feed (GH-7's one roadmap model) and
 * the messaging source's addresses; it computes no state of its own.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { HarnessError, InputError } from "../../src/kernel/errors.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { ROADMAP_FEED_SCHEMA, type RoadmapFeed } from "../../src/workflow/forge/projector/roadmap-feed.ts";
import { readMessaging } from "../brand/messaging.ts";
import { GRAPH_SCRIPT, dependencyGraph, layoutGraph, renderGraphSvg, type GraphItem } from "./graph.ts";
import { ROADMAP_PAGE_BLOCK, TIMELINE_SCRIPT, renderAtom, renderPage, renderPrint, type RenderContext } from "./render.ts";

const REPOSITORY_ROOT = dirname(fileURLToPath(new URL("../../", import.meta.url)));

/** The feed at `path`, refused (typed) unless it is the schema this renderer reads. */
export function readFeed(path: string): RoadmapFeed {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new InputError(`${path} cannot be read as JSON (${error instanceof Error ? error.message : String(error)})`, "roadmap_feed_unreadable");
  }
  const schema = (document as { schema?: unknown } | null)?.schema;
  if (schema !== ROADMAP_FEED_SCHEMA) throw new InputError(`${path} is ${JSON.stringify(schema)}, not a ${ROADMAP_FEED_SCHEMA} feed`, "roadmap_feed_schema");
  return document as RoadmapFeed;
}

/** The graph's items: the feed's work items, with blockers and parents that are work items (a Milestone is membership, not a dependency). */
export function graphItems(feed: RoadmapFeed): readonly GraphItem[] {
  const work = new Set(feed.items.filter((i) => i.type !== "Milestone").map((i) => i.id));
  return feed.items.filter((i) => work.has(i.id)).map((i) => ({
    id: i.id,
    title: i.title,
    milestone: i.milestone,
    state: i.state,
    blockers: i.blockedBy.filter((id) => work.has(id)),
    parent: i.parent !== null && work.has(i.parent) ? i.parent : null,
  }));
}

function write(path: string, text: string): void {
  // Served files: world-readable like everything the site publishes.
  const written = atomicWriteFile(path, text, { exactMode: 0o644 });
  if (!written.success) throw new HarnessError(`Failed to write ${path}: ${written.reason ?? "unknown error"}`, "roadmap_write_failed");
}

/** Renders every roadmap surface from `feed` into the assembled `site` and under `out`. */
export function buildSite(root: string, feed: RoadmapFeed, site: string, out: string): void {
  const messaging = readMessaging(root);
  const items = graphItems(feed);
  const graph = dependencyGraph(items);
  const ctx: RenderContext = {
    roadmapUrl: `${messaging.siteUrl}floor/roadmap/`,
    repositoryUrl: messaging.repositoryUrl,
    graphSvg: graph.edges.length === 0 ? null : renderGraphSvg(layoutGraph(graph), items, new Set(feed.milestones.flatMap((m) => m.criticalPath))),
    script: `${GRAPH_SCRIPT}\n${TIMELINE_SCRIPT}`,
  };
  const pagePath = join(site, ROADMAP_PAGE_BLOCK.path.replace(/^docs\//u, ""));
  const shell = readFileSync(pagePath, "utf8");
  const begin = shell.indexOf(ROADMAP_PAGE_BLOCK.begin);
  const end = shell.indexOf(ROADMAP_PAGE_BLOCK.end);
  if (begin < 0 || end < begin) throw new HarnessError(`${pagePath} carries no roadmap block (ROADMAP_PAGE_BLOCK in scripts/roadmap/render.ts)`, "roadmap_page_block_missing");
  write(pagePath, `${shell.slice(0, begin + ROADMAP_PAGE_BLOCK.begin.length)}\n${renderPage(feed, ctx)}\n${shell.slice(end)}`);
  write(join(out, "print", "index.md"), renderPrint(feed, ctx));
  write(join(out, "feed.xml"), renderAtom(feed, ctx));
}

function run(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (command !== "build") throw new InputError("Usage: roadmap build --feed <roadmap.json> --site <assembled site> --out <dir>", "input_error");
  const { values } = parseArgs({ args: rest, options: { feed: { type: "string" }, site: { type: "string" }, out: { type: "string" } } });
  if (values.feed === undefined || values.site === undefined || values.out === undefined) throw new InputError("roadmap build needs --feed, --site and --out", "input_error");
  const feed = readFeed(values.feed);
  buildSite(REPOSITORY_ROOT, feed, values.site, values.out);
  process.stdout.write(`${JSON.stringify({ source: feed.source, items: feed.items.length, milestones: feed.milestones.length, out: values.out })}\n`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = run(process.argv.slice(2));
}
