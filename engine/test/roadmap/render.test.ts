/**
 * THE ROADMAP RENDERERS (scripts/roadmap/render.ts): every surface is a pure
 * function of the model; every text is escaped through the one markup owner;
 * a retraction is visible on every surface; the live and check gaps are said
 * plainly; a forecast reads as a measured band or an honest unknown, never a
 * promised date; the feed is well-formed Atom with stable ids.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { trackerItems } from "../../src/workflow/failure-owners.ts";
import { forecast } from "../../scripts/roadmap/forecast.ts";
import { criticalPath, dependencyGraph } from "../../scripts/roadmap/graph.ts";
import { buildRoadmap } from "../../scripts/roadmap/model.ts";
import { TIMELINE_SCRIPT, burnUpSvg, forecastWords, renderFeed, renderJson, renderPage, renderPrint, renderReadmeBlock, timelineDocument, type RenderContext } from "../../scripts/roadmap/render.ts";
import type { Roadmap } from "../../scripts/roadmap/types.ts";

const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
const entry = (id: string, fields: Record<string, string>, body = "The outcome."): { name: string; text: string } => ({
  name: `${id}.md`,
  text: `---\n${Object.entries({ schema: "bridlewise-tracker-item/v1", id, type: "Task", state: "open", lane: "floor", opened: "2026-10-01", ...fields })
    .map(([name, value]) => `${name}: ${value}`).join("\n")}\n---\n\n${body}\n`,
});

const model = (overrides: Partial<Parameters<typeof buildRoadmap>[0]> = {}): Roadmap => buildRoadmap({
  repository: "https://github.com/o/r",
  commit: COMMIT,
  committedAt: "2026-10-21T12:00:00Z",
  items: trackerItems([
    entry("M1", { type: "Milestone", title: "First", order: "1" }, "The first thing."),
    entry("A-RED", { state: "closed", resolution: "completed", closed: "2026-10-10", milestone: "M1", checks: "[testing.ci]", title: "Escape <script>alert(1)</script> & co" }),
    entry("B-READY", { milestone: "M1", title: "Ready one" }, "Do [the thing](../../floor/x.md) **now**."),
  ]),
  decisions: [],
  claims: [{ id: "release-dates", kind: "not-claimed", text: "A release date", reason: "Intent, not a schedule.", evidence: null }],
  checks: [{ id: "testing.ci", status: "fail", headSha: COMMIT, runUrl: "https://example.test/run/1" }],
  live: null,
  liveReason: "no live snapshot was given to this build",
  history: null,
  criticalPath: (items, milestone) => criticalPath(dependencyGraph(items), milestone),
  forecast: (remaining, _t, seed) => forecast({ remaining, weekly: [], weeksOfData: 0, seed, asOfWeek: "2026-W43" }),
  ...overrides,
});

const CTX: RenderContext = { repositoryUrl: "https://github.com/o/r", roadmapUrl: "https://o.github.io/r/roadmap/", graphSvg: null, script: "/* graph */" };

test("the page escapes every text, shows the retraction under Now, and states the live gap", () => {
  const page = renderPage(model(), CTX);
  assert.ok(!page.startsWith("---") && page.includes('<div class="floor-roadmap"'), "the body only: the front matter is the page shell's");
  assert.ok(!page.includes("<script>alert(1)</script>"));
  assert.ok(page.includes("Escape &lt;script&gt;alert(1)&lt;/script&gt; &amp; co"));
  assert.match(page, /data-status="retracted"/u);
  assert.match(page, /Closed, but testing\.ci \(red\): retracted until it passes again\./u);
  assert.match(page, /Live data unavailable in this build: no live snapshot was given to this build\./u);
  assert.match(page, new RegExp(`https://github\\.com/o/r/blob/${COMMIT}/docs/trackers/items/B-READY\\.md`, "u"), "record links are pinned to the rendered commit");
  assert.match(page, /Do the thing now\./u, "the excerpt drops Markdown syntax, the full text is one click away");
  assert.match(page, /<script>\/\* graph \*\/<\/script>/u);
  assert.ok(!/\b(?:will ship|guaranteed|by Q[1-4])\b/iu.test(page), "no promise language");
});

test("an inline script that names </script is neutralised", () => {
  const page = renderPage(model(), { ...CTX, script: "const s = '</script><img>';" });
  assert.ok(!page.includes("'</script><img>'"));
});

test("forecasts read as a measured band, an honest unknown, or complete; never a promised date", () => {
  assert.equal(forecastWords({ kind: "complete" }), "Complete.");
  assert.equal(forecastWords({ kind: "unknown", remaining: 3, reason: "needs 4 more weeks of history", weeksOfData: 0, method: "m" }), "Forecast unknown: needs 4 more weeks of history.");
  assert.match(forecastWords({ kind: "band", remaining: 5, p50Weeks: 2, p85Weeks: 4, p50Week: "2026-W45", p85Week: "2026-W47", weeksOfData: 8, method: "m" }),
    /^5 left\. Measured from 8 weeks of history: half the simulated futures finish by 2026-W45, 85 in 100 by 2026-W47\.$/u);
});

test("the burn-up draws exact points or says it has too few", () => {
  const m = model().milestones[0]!;
  assert.match(burnUpSvg(m), /needs at least two recorded changes/u);
  const svg = burnUpSvg({ ...m, burnUp: [{ commit: "a", date: "2026-10-01T00:00:00Z", scope: 2, done: 0 }, { commit: "b", date: "2026-10-05T00:00:00Z", scope: 3, done: 1 }] });
  assert.match(svg, /role="img"/u);
  assert.match(svg, /1 of 3 done at 2026-10-05, from 2 recorded changes/u);
});

test("the README block, the print page, the feed and the JSON are derived from the same model", () => {
  const m = model();
  const readme = renderReadmeBlock(m, CTX);
  assert.match(readme, /\| M1 · First \| in progress \| 0 of 2 \(1 retracted\) \|/u);
  assert.match(readme, /no date is promised/u);
  assert.match(readme, /applies each item's checks/u);
  const print = renderPrint(m, CTX);
  assert.match(print, /permalink: \/floor\/roadmap\/print\//u);
  assert.match(print, /A release date\. Intent, not a schedule\./u);
  const feed = renderFeed(m, CTX, [
    { commit: "1111111111", date: "2026-10-20T10:00:00Z", item: "B-READY", kind: "added", detail: "Ready <one>" },
    { commit: "2222222222", date: "2026-10-13T10:00:00Z", item: "A-RED", kind: "closed", detail: "completed" },
  ]);
  assert.ok(feed.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">'));
  assert.equal((feed.match(/<entry>/gu) ?? []).length, 2, "one entry per ISO week");
  assert.match(feed, /<id>https:\/\/o\.github\.io\/r\/roadmap\/#week-2026-10-19<\/id>/u);
  assert.ok(!feed.includes("Ready <one>"));
  assert.deepEqual(JSON.parse(renderJson(m)), JSON.parse(JSON.stringify(m)));
});

test("renders are deterministic: the same model renders byte-identically", () => {
  assert.equal(renderPage(model(), CTX), renderPage(model(), CTX));
  assert.equal(renderPrint(model(), CTX), renderPrint(model(), CTX));
});

test("time travel: the timeline indexes every change and burn-up point by its commit; the script compiles and needs no framework", () => {
  const base = model();
  const m = { ...base, milestones: [{ ...base.milestones[0]!, burnUp: [{ commit: "s1", date: "2026-10-01T00:00:00Z", scope: 2, done: 0 }, { commit: "s2", date: "2026-10-05T00:00:00Z", scope: 2, done: 1 }] }] };
  const commits = [{ sha: "s1", date: "2026-10-01T00:00:00Z" }, { sha: "s2", date: "2026-10-05T00:00:00Z" }];
  const timeline = timelineDocument(m, commits, [{ commit: "s2", date: "2026-10-05T00:00:00Z", item: "A-RED", kind: "closed", detail: "as completed" }]);
  assert.deepEqual(timeline.milestones[0]!.points, [{ c: 0, done: 0, scope: 2 }, { c: 1, done: 1, scope: 2 }]);
  assert.deepEqual(timeline.changes, [{ c: 1, item: "A-RED", kind: "closed", detail: "as completed" }]);
  assert.throws(() => timelineDocument(m, commits.slice(0, 1), []), /s2 is not one of the history's commits/u, "a point outside the history is refused, never dropped");
  assert.doesNotThrow(() => new Function(TIMELINE_SCRIPT));
  assert.ok(!/\bimport\b|require\(/u.test(TIMELINE_SCRIPT));
  const page = renderPage(m, CTX);
  assert.match(page, /data-timeline-src="\{\{ '\/floor\/roadmap\/data\/timeline\.json' \| relative_url \}\}"/u);
  assert.match(page, /Since your last visit/u);
});
