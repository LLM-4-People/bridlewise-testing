/**
 * THE ROADMAP RENDERER (scripts/roadmap/render.ts) over the ONE roadmap model:
 * every fixture here is a feed computed by GH-7's `roadmapFeed` itself, so the
 * renderer is judged on what the feed really says. It places items in
 * Now/Next/Later with a reason each, words ETAs as bands or honest unknowns
 * (never a date), replays the feed's history for the burn-up and the Atom
 * digest, escapes every text through the one markup owner, states what the
 * feed does not carry yet, and renders byte-identically.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { escapeHtml } from "../../../shared/markup.ts";

import { ROADMAP_FEED_INPUT_SCHEMA, roadmapFeed, type FeedItem, type RoadmapFeed, type RoadmapFeedInput } from "../../src/workflow/forge/projector/roadmap-feed.ts";
import { graphItems, readFeed } from "../../scripts/roadmap/cli.ts";
import { TIMELINE_SCRIPT, burnUp, etaWords, placeItems, renderAtom, renderPage, renderPrint, type RenderContext } from "../../scripts/roadmap/render.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "https://github.com/o/r";
const item = (id: string, fields: Partial<FeedItem> = {}): FeedItem => ({
  id, type: "Task", state: "open", resolution: null, parent: null, milestone: "M1", blockedBy: [], decisions: [],
  title: `Title of ${id}`, lane: "floor", relates: [], horizon: null, order: null, ownerRole: null, area: [], severity: null,
  evidence: null, tests: [], rfc: null, gh: null, path: `docs/trackers/items/${id}.md`, ...fields,
});
const closed = { state: "closed" as const, resolution: "completed" as const };

function feed(overrides: Partial<RoadmapFeedInput> = {}): RoadmapFeed {
  const items: FeedItem[] = [
    item("M1", { type: "Milestone", milestone: null, order: 1, title: "First" }),
    item("M2", { type: "Milestone", milestone: null, order: 2, title: "Second" }),
    item("A-SHIPPED", { ...closed, decisions: ["D-1"] }),
    item("B-NEXT", { title: "Escape <script>alert(1)</script> & co", tests: ["engine/test/b.test.ts"] }),
    item("C-BLOCKED", { blockedBy: ["B-NEXT"] }),
    item("D-LATER", { milestone: "M2" }),
    item("E-MARKED", { milestone: "M2", horizon: "now" }),
    item("F-DROPPED", { state: "closed", resolution: "not-planned", title: "A release date" }),
    item("H-CLAIMED", { ...closed, milestone: "M2", title: "Closed without proof" }),
    item("G-RISK", { type: "Risk", milestone: null, severity: "P1" }),
  ];
  const statusOf = (list: readonly FeedItem[]) => list.map(({ id, type, state, resolution, parent, milestone, blockedBy, decisions, tests, evidence }) => ({ id, type, state, resolution, parent, milestone, blockedBy, decisions, tests, evidence }));
  return roadmapFeed({
    schema: ROADMAP_FEED_INPUT_SCHEMA,
    source: "abcdef0123456789abcdef0123456789abcdef01",
    sourceDate: "2026-10-21T12:00:00Z",
    repositoryUrl: REPO,
    items,
    recordedEvidence: [],
    decisions: [{ id: "D-1", status: "in-force", implementation: "done", title: "Built thing" }, { id: "D-2", status: "in-force", implementation: "pending", title: "Designed thing" }],
    history: [
      { commit: "1111111111", date: "2026-10-05T10:00:00Z", items: statusOf(items.map((i) => (i.id === "A-SHIPPED" ? { ...i, state: "open" as const, resolution: null } : i))), decisions: [], recordedEvidence: [] },
      { commit: "2222222222", date: "2026-10-19T10:00:00Z", items: statusOf(items), decisions: [{ id: "D-1", status: "in-force", implementation: "done" }], recordedEvidence: [] },
    ],
    minimumWeeks: 4,
    ...overrides,
  });
}

const CTX: RenderContext = { roadmapUrl: "https://o.github.io/r/floor/roadmap/", repositoryUrl: REPO, graphSvg: null, script: "/* graph */" };

test("Now/Next/Later: the item's own horizon first, then the feed's state, each with its reason", () => {
  const placed = placeItems(feed());
  assert.deepEqual(Object.fromEntries([...placed].map(([id, p]) => [id, p.horizon])), {
    "A-SHIPPED": "done", "B-NEXT": "next", "C-BLOCKED": "later", "D-LATER": "later", "E-MARKED": "now", "F-DROPPED": "done", "G-RISK": "later", "H-CLAIMED": "done",
  });
  assert.match(placed.get("B-NEXT")!.reason, /critical path of M1|M1 is the earliest unfinished milestone/u);
  assert.match(placed.get("C-BLOCKED")!.reason, /^Blocked by B-NEXT/u);
  assert.match(placed.get("D-LATER")!.reason, /it belongs to M2, after M1\.$/u);
  assert.match(placed.get("E-MARKED")!.reason, /the item is marked now\.$/u);
  assert.match(placed.get("G-RISK")!.reason, /it is in no milestone yet\.$/u);
  assert.ok(!placed.has("M1"), "milestones are not lane items");
});

test("a close without proof is a claim: out of the lanes, listed apart, never counted as shipped", () => {
  const f = feed();
  assert.equal(f.items.find((i) => i.id === "A-SHIPPED")!.state, "shipped");
  assert.equal(f.items.find((i) => i.id === "H-CLAIMED")!.state, "claimed");
  const page = renderPage(f, CTX);
  const claims = page.slice(page.indexOf('<section aria-labelledby="claims">'), page.indexOf('<section aria-labelledby="week">'));
  assert.ok(claims.includes('href="#item-H-CLAIMED"'), "the claim is listed under Closed, not proven");
  assert.ok(!claims.includes("A-SHIPPED"), "a proven close is not listed as a claim");
  assert.ok(page.includes(`${f.totals.claimed} claimed, unverified`), "the totals name the claims as unverified");
  assert.ok(page.includes('<span class="state" data-state="claimed">claimed, unverified</span>'), "the item chip says unverified, in the shared state component");
  const m2 = burnUp(f, f.milestones.find((m) => m.id === "M2")!);
  assert.equal(m2.at(-1)!.done, 0, "a claim adds nothing to the burn-up");
});

test("ETAs are the feed's band or its honest unknown, never a date", () => {
  const m = feed().milestones[0]!;
  assert.equal(etaWords(m), `ETA unknown: ${m.eta.state === "unknown" ? m.eta.because : ""}.`);
  assert.equal(etaWords({ ...m, eta: { state: "done", weeks: null } }), "Done.");
  assert.equal(etaWords({ ...m, eta: { state: "band", weeks: { low: 2, high: 5 } } } as typeof m), "Between 2 and 5 more weeks at recent paces. Measured from shipped history, not promised.");
  assert.match(etaWords({ ...m, eta: { state: "band", weeks: { low: 3, high: null } } } as typeof m), /^At the faster recent pace, about 3 more weeks; at the slower pace no end is in sight\./u);
});

test("the burn-up replays today's members through the feed's history", () => {
  const f = feed();
  const points = burnUp(f, f.milestones[0]!);
  assert.deepEqual(points.map((p) => [p.commit, p.scope, p.done]), [["1111111111", 3, 0], ["2222222222", 3, 1]], "the dropped member leaves the scope");
});

test("the page escapes every text, links records at the commit, and states what the feed does not carry", () => {
  const page = renderPage(feed(), CTX);
  assert.ok(!page.startsWith("---"), "the body only: the front matter is the page shell's");
  assert.ok(!page.includes("<script>alert(1)</script>"));
  assert.ok(page.includes(escapeHtml("Escape <script>alert(1)</script> & co")));
  assert.match(page, /https:\/\/github\.com\/o\/r\/blob\/abcdef0123456789abcdef0123456789abcdef01\/docs\/trackers\/items\/B-NEXT\.md/u);
  assert.match(page, /Not shown yet:<\/strong> each item's check results/u);
  assert.match(page, /No open item records a dependency yet|Hover or focus an item/u);
  assert.match(page, /1 built · 0 partly built · 1 designed · 0 standing/u);
  assert.match(page, /What we do not plan/u);
  assert.match(page, /A release date/u);
  assert.match(page, /<script>\/\* graph \*\/<\/script>/u);
  assert.ok(!/\b(?:will ship|guaranteed|by Q[1-4])\b/iu.test(page), "no promise language");
});

test("the print page and the Atom digest come from the same feed; renders are deterministic", () => {
  const f = feed();
  const print = renderPrint(f, CTX);
  assert.ok(print.startsWith("---\nlayout: default\n"), "the print page opens with its front matter");
  const frontMatter = print.slice(0, print.indexOf("\n---\n", 4) + 1).split("\n");
  assert.ok(frontMatter.includes("permalink: /floor/roadmap/print/"), "the front matter places the page at /floor/roadmap/print/");
  assert.match(print, /<li>A release date<\/li>/u);
  const atom = renderAtom(f, CTX);
  assert.ok(atom.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">'));
  assert.equal((atom.match(/<entry>/gu) ?? []).length, 2, "one entry per ISO week of landings");
  assert.match(atom, /<id>https:\/\/o\.github\.io\/r\/floor\/roadmap\/#week-2026-10-19<\/id>/u);
  assert.ok(!atom.includes("<script>alert(1)"));
  assert.equal(renderPage(f, CTX), renderPage(feed(), CTX));
  assert.equal(renderAtom(f, CTX), renderAtom(feed(), CTX));
});

test("the graph items keep only work items as blockers and parents; the feed reader refuses another schema", () => {
  const items = graphItems(feed());
  assert.deepEqual(items.find((i) => i.id === "C-BLOCKED")!.blockers, ["B-NEXT"]);
  assert.ok(!items.some((i) => i.id === "M1"));
  const dir = createTempDir("roadmap-feed-");
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify(feed()));
  assert.equal(readFeed(good).source, "abcdef0123456789abcdef0123456789abcdef01");
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ schema: "bridlewise-roadmap/v1" }));
  assert.throws(() => readFeed(bad), (error: Error & { code?: string }) => error.code === "roadmap_feed_schema");
});

test("the time-travel script compiles, needs no framework, and writes text nodes only", () => {
  assert.doesNotThrow(() => new Function(TIMELINE_SCRIPT));
  assert.ok(!/\bimport\b|require\(/u.test(TIMELINE_SCRIPT));
  assert.ok(!TIMELINE_SCRIPT.includes("innerHTML") && !TIMELINE_SCRIPT.includes("insertAdjacentHTML"), "no feed text is parsed as markup");
});

test("a page script that could close its own element is refused, never rewritten", () => {
  assert.throws(() => renderPage(feed(), { ...CTX, script: "const s = '</SCRIPT>';" }), /roadmap page script contains a closing script tag/u);
  assert.ok(renderPage(feed(), CTX).includes("<script>/* graph */</script>"));
});
