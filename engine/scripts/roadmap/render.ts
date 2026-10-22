/**
 * THE ROADMAP'S RENDERER — every roadmap surface drawn from ONE input: the
 * roadmap feed (`bridlewise-roadmap-feed/v1`, src/workflow/forge/projector/
 * roadmap-feed.ts, GH-7's one data model). This module computes no state,
 * no critical path and no forecast; it decides only how the feed reads:
 * the order of the page, the three lanes a reader scans first, and the words.
 *
 * Surfaces: the page body (written into `docs/floor/roadmap.md`'s publish
 * markers), the print one-pager, and the Atom weekly digest. The browser's
 * time travel replays the feed's own `history` (the feed's documented use).
 *
 * Escaping goes through the one markup owner (shared/markup.ts). Styling is
 * the floor design layer's (docs/assets/floor/floor.css, owned by DESIGN);
 * nothing here carries a colour, a length or a date that was not computed.
 * The copy is plain and exact, and it never promises a date.
 */
import { escapeHtml } from "../../../shared/markup.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import type { RoadmapFeed } from "../../src/workflow/forge/projector/roadmap-feed.ts";
import { ROADMAP_STATES, type RoadmapState } from "../../src/workflow/tracker-status.ts";

type FeedItem = RoadmapFeed["items"][number];
type FeedMilestone = RoadmapFeed["milestones"][number];

/** The three lanes a reader scans first, plus where finished work goes. */
export type Horizon = "now" | "next" | "later" | "done";

export type RenderContext = Readonly<{
  /** The site's address of the roadmap page (for the feed's links), with a trailing slash. */
  roadmapUrl: string;
  /** `https://github.com/<owner>/<repo>`. */
  repositoryUrl: string;
  /** The dependency graph as inline SVG (graph.ts), or `null` when no open item records a dependency. */
  graphSvg: string | null;
  /** The page's one inline script, or `null`. */
  script: string | null;
}>;

/**
 * The markers in `docs/floor/roadmap.md` between which the site build writes
 * the rendered body (the page's front matter, title and dated snapshot stay
 * in that file, once).
 */
export const ROADMAP_PAGE_BLOCK = Object.freeze({
  path: "docs/floor/roadmap.md",
  begin: "<!-- BEGIN GENERATED AT PUBLISH: the roadmap, from the roadmap feed (engine/scripts/roadmap/cli.ts build) -->",
  end: "<!-- END GENERATED AT PUBLISH: the roadmap -->",
});

const h = escapeHtml;
const short = (sha: string): string => sha.slice(0, 8);
const slug = (state: string): string => state.replace(/ /gu, "-");
const link = (href: string, text: string): string => `<a href="${h(href)}">${h(text)}</a>`;

/**
 * Where an item sits for a reader: the item's own `horizon` when it names one;
 * otherwise from its feed state — in progress is Now; blocked is Later;
 * planned is Next when it belongs to the earliest unfinished milestone or lies
 * on a milestone's critical path, else Later. Closed work (shipped, claimed
 * and not planned) leaves the lanes; a claim is listed apart, unproven. Each placement carries its reason in one sentence.
 */
export function placeItems(feed: RoadmapFeed): ReadonlyMap<string, Readonly<{ horizon: Horizon; reason: string }>> {
  const current = [...feed.milestones].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)).find((m) => !isClosed(m.state))?.id ?? null;
  const critical = new Map<string, string[]>();
  // A critical path is a chain: a lone open member waits on nothing and reads as no path.
  for (const m of feed.milestones) if (m.criticalPath.length >= 2) for (const id of m.criticalPath) critical.set(id, [...(critical.get(id) ?? []), m.id]);
  const placed = new Map<string, { horizon: Horizon; reason: string }>();
  for (const item of feed.items) {
    if (item.type === "Milestone") continue;
    if (isClosed(item.state)) {
      placed.set(item.id, { horizon: "done", reason: `${capital(item.because)}.` });
    } else if (item.horizon === "now" || item.horizon === "next" || item.horizon === "later") {
      placed.set(item.id, { horizon: item.horizon, reason: `${capital(item.because)}; the item is marked ${item.horizon}.` });
    } else if (item.state === "in progress") {
      placed.set(item.id, { horizon: "now", reason: `${capital(item.because)}.` });
    } else if (item.state === "blocked") {
      placed.set(item.id, { horizon: "later", reason: `${capital(item.because)}.` });
    } else if (critical.has(item.id)) {
      placed.set(item.id, { horizon: "next", reason: `${capital(item.because)}; it is on the critical path of ${critical.get(item.id)!.join(", ")}.` });
    } else if (current !== null && item.milestone === current) {
      placed.set(item.id, { horizon: "next", reason: `${capital(item.because)}; ${current} is the earliest unfinished milestone.` });
    } else {
      placed.set(item.id, { horizon: "later", reason: `${capital(item.because)}; ${item.milestone === null ? "it is in no milestone yet" : `it belongs to ${item.milestone}${current === null ? "" : `, after ${current}`}`}.` });
    }
  }
  return placed;
}

/** Closed work: proven (shipped), unproven (claimed) or dropped (not planned). It leaves the three lanes. */
function isClosed(state: RoadmapState): boolean {
  return state === "shipped" || state === "claimed" || state === "not planned";
}

/** A state as a reader meets it: a claim is said to be unverified. */
function stateWords(state: RoadmapState): string {
  return state === "claimed" ? "claimed, unverified" : state;
}

function capital(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** A milestone's ETA in words: the feed's band, its honest unknown, or done. Never a date. */
export function etaWords(m: FeedMilestone): string {
  switch (m.eta.state) {
    case "done":
      return "Done.";
    case "unknown":
      return `ETA unknown: ${m.eta.because}.`;
    case "band": {
      const { low, high } = m.eta.weeks!;
      return high === null
        ? `At the faster recent pace, about ${low} more week${low === 1 ? "" : "s"}; at the slower pace no end is in sight. Measured from shipped history, not promised.`
        : `Between ${low} and ${high} more weeks at recent paces. Measured from shipped history, not promised.`;
    }
  }
}

/**
 * A milestone's burn-up: TODAY's members replayed through the feed's history
 * (scope = members that existed and were not dropped; done = shipped), one
 * point per landing that moved any member.
 */
export function burnUp(feed: RoadmapFeed, m: FeedMilestone): readonly Readonly<{ commit: string; date: string; scope: number; done: number }>[] {
  const members = new Set(m.members);
  const states = new Map<string, string | null>();
  const points: { commit: string; date: string; scope: number; done: number }[] = [];
  for (const landing of feed.history) {
    let moved = false;
    for (const change of landing.changes) {
      if (!members.has(change.id)) continue;
      states.set(change.id, change.to);
      moved = true;
    }
    if (!moved) continue;
    const live = [...states.values()].filter((state) => state !== null && state !== "not planned");
    points.push({ commit: landing.commit, date: landing.date, scope: live.length, done: live.filter((state) => state === "shipped").length });
  }
  return points;
}

function burnUpSvg(feed: RoadmapFeed, m: FeedMilestone): string {
  const points = burnUp(feed, m);
  if (points.length < 2) return `<p class="floor-quiet">No burn-up yet: it needs two landings that moved this milestone's members.</p>`;
  const W = 320;
  const H = 72;
  const t0 = Date.parse(points[0]!.date);
  const span = Math.max(Date.parse(points[points.length - 1]!.date) - t0, 1);
  const top = Math.max(...points.map((p) => p.scope), 1);
  const x = (date: string): string => (((Date.parse(date) - t0) / span) * W).toFixed(1);
  const y = (n: number): string => (H - (n / top) * H).toFixed(1);
  const step = (value: (p: (typeof points)[number]) => number): string =>
    points.map((p, i) => (i === 0 ? `M${x(p.date)} ${y(value(p))}` : `H${x(p.date)}V${y(value(p))}`)).join("") + `H${W}`;
  const last = points[points.length - 1]!;
  return `<svg class="floor-burnup" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="burn-${h(m.id)}"><title id="burn-${h(m.id)}">${h(m.id)} burn-up of today's members: ${last.done} of ${last.scope} shipped at ${h(last.date.slice(0, 10))}, from ${points.length} landings</title>`
    + `<path class="floor-burnup-scope" d="${step((p) => p.scope)}"/><path class="floor-burnup-done" d="${step((p) => p.done)}"/></svg>`;
}

function chip(item: FeedItem): string {
  return `<span class="state" data-state="${slug(item.state)}">${h(stateWords(item.state))}</span>`;
}

function itemDetail(feed: RoadmapFeed, item: FeedItem, reason: string, repositoryUrl: string): string {
  const rows: string[] = [];
  const decisions = item.decisions.map((id) => feed.decisions.find((d) => d.id === id)).filter((d) => d !== undefined);
  rows.push(`<dt>Why</dt><dd>${decisions.length === 0 ? `<span class="floor-gap">No decision record is linked yet.</span>` : decisions.map((d) => `${h(d.title)} <span class="state" data-state="${slug(d.progress)}">${h(d.progress)}</span>`).join("; ")}</dd>`);
  rows.push(`<dt>State</dt><dd>${chip(item)} ${h(reason)} ${link(item.record, "Read the item")}</dd>`);
  rows.push(`<dt>Decisions</dt><dd>${item.decisions.length === 0 ? `<span class="floor-gap">none linked</span>` : item.decisions.map((id) => h(id)).join(" · ")}</dd>`);
  rows.push(`<dt>Tests</dt><dd>${item.tests.length === 0 ? `<span class="floor-gap">none linked</span>` : item.tests.map((t) => link(t.url, t.path)).join(" · ")}</dd>`);
  if (item.evidence !== null) rows.push(`<dt>Evidence</dt><dd>${h(item.evidence)}</dd>`);
  if (item.blockedBy.length > 0) rows.push(`<dt>Blocked by</dt><dd>${item.blockedBy.map((id) => `<a href="#item-${h(id)}">${h(id)}</a>`).join(" · ")}</dd>`);
  if (item.children.length > 0) rows.push(`<dt>Parts</dt><dd>${item.children.map((id) => `<a href="#item-${h(id)}">${h(id)}</a>`).join(" · ")}</dd>`);
  const talk: string[] = [];
  if (item.rfc !== null) talk.push(link(`${repositoryUrl}/discussions/${item.rfc.replace(/^discussion#/u, "")}`, "RFC discussion"));
  if (item.gh !== null && /^#\d+$/u.test(item.gh)) talk.push(link(`${repositoryUrl}/issues/${item.gh.slice(1)}`, "Watch the issue"));
  if (talk.length > 0) rows.push(`<dt>Take part</dt><dd>${talk.join(" · ")}</dd>`);
  return `<details class="floor-item" id="item-${h(item.id)}" data-status="${slug(item.state)}"${item.milestone === null ? "" : ` data-milestone="${h(item.milestone)}"`}>`
    + `<summary>${chip(item)}<span class="floor-item-title">${item.title === item.id ? `<code>${h(item.id)}</code>` : h(item.title)}</span><code>${h(item.id)}</code></summary><dl>${rows.join("")}</dl></details>`;
}

function milestoneSection(feed: RoadmapFeed, placed: ReturnType<typeof placeItems>, m: FeedMilestone, repositoryUrl: string): string {
  const own = feed.items.filter((i) => i.milestone === m.id && i.type !== "Milestone");
  const pct = m.progress === null ? null : Math.round(m.progress * 100);
  const share = (n: number): string => (own.length === 0 ? "0" : ((n / own.length) * 100).toFixed(1));
  const path = m.criticalPath.length < 2
    ? `<p class="floor-quiet">${m.criticalPath.length === 0 ? "Nothing open." : "No chain: no open member waits on another."}</p>`
    : `<ol class="floor-path">${m.criticalPath.map((id) => `<li><a href="#item-${h(id)}">${h(feed.items.find((i) => i.id === id)?.title ?? id)}</a></li>`).join("")}</ol>`;
  return `<section class="floor-milestone" id="milestone-${h(m.id)}" data-state="${slug(m.state)}">`
    + `<header><h3><span class="floor-ms">${h(m.id)}</span> ${h(m.title)}</h3><p class="floor-ms-state">${h(stateWords(m.state))}${pct === null ? "" : ` · ${pct}% shipped`} · ${h(m.because)}</p></header>`
    + `<div class="floor-progress" role="img" aria-label="${m.counts.shipped} shipped, ${m.counts.claimed} claimed, unverified, ${m.counts["in progress"]} in progress, ${m.counts.blocked} blocked, ${m.counts.planned} planned">`
    + `<span class="floor-progress-done" style="--floor-share:${share(m.counts.shipped)}%"></span><span class="floor-progress-moving" style="--floor-share:${share(m.counts["in progress"])}%"></span></div>`
    + `<div class="floor-ms-grid"><div><h4>Forecast</h4><p>${h(etaWords(m))} <a href="#method">How</a></p>${burnUpSvg(feed, m)}</div>`
    + `<div><h4>Critical path</h4>${path}</div></div>`
    + `<div class="floor-items">${own.map((item) => itemDetail(feed, item, placed.get(item.id)!.reason, repositoryUrl)).join("")}</div></section>`;
}

/** The page's script, inlined as written; a script that could close its own element is refused, never rewritten. */
function inlineScript(script: string): string {
  if (script.toLowerCase().includes("</script")) throw new HarnessError("the roadmap page script contains a closing script tag, so it cannot be inlined", "roadmap_script_not_inlinable");
  return script;
}

/** The roadmap page body (HTML), written between {@link ROADMAP_PAGE_BLOCK}'s markers by the site build. */
export function renderPage(feed: RoadmapFeed, ctx: RenderContext): string {
  const placed = placeItems(feed);
  const work = feed.items.filter((i) => i.type !== "Milestone");
  const lanes = (["now", "next", "later"] as const).map((key) => {
    const rows = work.filter((i) => placed.get(i.id)!.horizon === key);
    const title = { now: "Now", next: "Next", later: "Later" }[key];
    const empty = { now: "Nothing is in progress.", next: "Nothing can start right now: every open item waits on another.", later: "Nothing is queued behind the current work." }[key];
    return `<section class="floor-lane" aria-labelledby="lane-${key}"><h3 id="lane-${key}">${title} <span class="floor-count">${rows.length}</span></h3>`
      + (rows.length === 0 ? `<p class="floor-quiet">${empty}</p>` : `<ol class="floor-lane-cards">${rows.slice(0, 12).map((i) => `<li class="floor-lane-card" data-status="${slug(i.state)}"><a class="floor-lane-card-title" href="#item-${h(i.id)}">${i.title === i.id ? `<code>${h(i.id)}</code>` : h(i.title)}</a><div class="floor-lane-card-meta">${chip(i)}${i.milestone === null ? "" : `<span class="floor-ms">${h(i.milestone)}</span>`}</div><p>${h(placed.get(i.id)!.reason)}</p></li>`).join("")}</ol>${rows.length > 12 ? `<p class="floor-quiet">${rows.length - 12} more below, in their milestones.</p>` : ""}`)
      + `</section>`;
  }).join("");
  const sinceDate = new Date(Date.parse(feed.sourceDate) - 7 * 24 * 3600 * 1000).toISOString();
  const week = feed.history.filter((l) => new Date(l.date).toISOString() > sinceDate).slice().reverse();
  const weekList = week.length === 0 ? `<p class="floor-quiet">No item changed state in the 7 days before this commit.</p>`
    : `<ol class="floor-feed">${week.flatMap((l) => l.changes.map((c) => `<li><time datetime="${h(l.date)}">${h(l.date.slice(0, 10))}</time> <a href="#item-${h(c.id)}">${h(c.id)}</a> ${h(c.from ?? "new")} → ${h(c.to ?? "removed")} <a class="floor-quiet" href="${h(`${ctx.repositoryUrl}/commit/${l.commit}`)}">${short(l.commit)}</a></li>`)).join("")}</ol>`;
  const unassigned = work.filter((i) => i.milestone === null && i.state !== "not planned");
  const progress = ["built", "partly built", "designed", "standing"].map((p) => [p, feed.decisions.filter((d) => d.status === "in-force" && d.progress === p).length] as const);
  const gaps = work.filter((i) => i.state === "not planned");
  const claims = work.filter((i) => i.state === "claimed");
  const risks = work.filter((i) => i.type === "Risk" && !isClosed(i.state));
  const graphSection = ctx.graphSvg === null
    ? `<section aria-labelledby="graph"><h2 id="graph">Dependencies</h2><p class="floor-quiet">No open item records a dependency yet (a tracker item's <code>blocked-by</code> or <code>parent</code>), so there is no graph to draw.</p></section>`
    : `<section aria-labelledby="graph"><h2 id="graph">Dependencies</h2><p class="floor-quiet">Hover or focus an item to light what it waits on and what it unblocks. Critical paths are drawn heavier. Press Enter to jump to the item.</p><label class="floor-filter">Milestone <select data-graph-milestone><option value="">All</option>${feed.milestones.map((m) => `<option value="${h(m.id)}">${h(m.id)} ${h(m.title)}</option>`).join("")}</select></label><div class="floor-graph">${ctx.graphSvg}</div></section>`;
  const body = [
    `<link rel="alternate" type="application/atom+xml" title="Bridlewise roadmap: what changed" href="{{ '/floor/roadmap/feed.xml' | relative_url }}">`,
    `<div class="floor-roadmap" data-commit="${h(feed.source)}">`,
    `<header>`,
    `<p class="floor-lede">Where Bridlewise is, what comes next, and why. Generated from the tracker items and the decision records at ${link(`${ctx.repositoryUrl}/commit/${feed.source}`, `main@${short(feed.source)}`)} (${h(feed.sourceDate.slice(0, 10))}). Nobody types a state here, and no date is promised.</p>`,
    `<p class="floor-facts">${ROADMAP_STATES.map((s) => `${feed.totals[s]} ${stateWords(s)}`).join(" · ")}</p>`,
    `<p class="floor-links"><a href="{{ '/floor/roadmap/print/' | relative_url }}">One-page print</a> · <a href="{{ '/floor/roadmap/feed.xml' | relative_url }}">Weekly digest (Atom)</a> · <a href="{{ '/floor/roadmap/data/roadmap.json' | relative_url }}">The data (roadmap.json)</a> · <a href="#method">How it is computed</a></p>`,
    `</header>`,
    `<section aria-labelledby="summary"><h2 id="summary">Now, next, later</h2><div class="floor-lanes">${lanes}</div></section>`,
    `<section aria-labelledby="claims"><h2 id="claims">Closed, not proven</h2>${claims.length === 0 ? `<p class="floor-quiet">Every closed item links its proof.</p>` : `<p>Closed as done, but no linked evidence proves it, so none of these counts as shipped. Linking a test, a recorded evidence file, a built decision, or a pull request, run or release of this repository turns one into shipped.</p><details><summary>The ${claims.length} unproven closes</summary><ul class="floor-gaps">${claims.map((c) => `<li><a href="#item-${h(c.id)}">${h(c.title)}</a> <code>${h(c.id)}</code></li>`).join("")}</ul></details>`}</section>`,
    `<section aria-labelledby="week"><h2 id="week">What changed this week</h2>${weekList}</section>`,
    `<section aria-labelledby="travel" data-timeline-src="{{ '/floor/roadmap/data/roadmap.json' | relative_url }}"><h2 id="travel">Time travel</h2><div class="floor-ms-grid"><div><h3>Since your last visit</h3><div data-timeline-since><p class="floor-quiet">Needs JavaScript.</p></div></div><div><h3>Any version</h3><label class="floor-filter">Version <input type="range" min="0" max="0" value="0" disabled></label><div data-timeline-out><p class="floor-quiet">Needs JavaScript. The roadmap at any commit is <code>${h("node engine/scripts/tooling/roadmap-feed.ts --at <commit>")}</code>.</p></div></div></div></section>`,
    `<section aria-labelledby="milestones"><h2 id="milestones">Milestones</h2>${[...feed.milestones].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((m) => milestoneSection(feed, placed, m, ctx.repositoryUrl)).join("")}`,
    unassigned.length === 0 ? "" : `<section class="floor-milestone" id="milestone-none"><header><h3>Not in a milestone yet</h3><p class="floor-ms-state">${unassigned.length} items. Placing them is work too.</p></header><div class="floor-items">${unassigned.map((item) => itemDetail(feed, item, placed.get(item.id)!.reason, ctx.repositoryUrl)).join("")}</div></section>`,
    `</section>`,
    graphSection,
    `<section aria-labelledby="built"><h2 id="built">Decided, and how far it is built</h2><p>${progress.map(([p, n]) => `${n} ${p}`).join(" · ")}, from each in-force decision record's own state. Standing rules govern work and are never "built".</p><details><summary>Every decision</summary><table class="floor-table"><thead><tr><th scope="col">Record</th><th scope="col">Decision</th><th scope="col">State</th><th scope="col">Carried by</th></tr></thead><tbody>${feed.decisions.map((d) => `<tr><td>${h(d.id)}</td><td>${h(d.title)}</td><td><span class="state" data-state="${slug(d.progress)}">${h(d.progress)}</span></td><td>${d.carriedBy.length === 0 ? `<span class="floor-gap">no item yet</span>` : d.carriedBy.map((id) => `<a href="#item-${h(id)}">${h(id)}</a>`).join(" ")}</td></tr>`).join("")}</tbody></table></details></section>`,
    `<section aria-labelledby="risks"><h2 id="risks">Risks</h2>${risks.length === 0 ? `<p class="floor-quiet">No open risk.</p>` : `<ul>${risks.map((r) => `<li><a href="#item-${h(r.id)}">${h(r.title)}</a>${r.severity === null ? "" : ` (${h(r.severity)})`}: ${h(r.because)}</li>`).join("")}</ul>`}</section>`,
    `<section aria-labelledby="gaps"><h2 id="gaps">What we do not plan</h2>${gaps.length === 0 ? `<p class="floor-quiet">Nothing is recorded as not planned.</p>` : `<ul class="floor-gaps">${gaps.map((g) => `<li>${link(g.record, g.title)}</li>`).join("")}</ul>`}</section>`,
    `<section aria-labelledby="method"><h2 id="method">How this is computed</h2><ul class="floor-method">`,
    `<li><strong>Every state</strong> is the roadmap feed's, computed from the tracker items' own evidence (<code>engine/src/workflow/tracker-status.ts</code>), never typed on this page.</li>`,
    `<li><strong>Shipped needs proof.</strong> A closed item counts as shipped only when linked evidence proves it; without that it reads claimed, unverified, and counts as nothing.</li>`,
    `<li><strong>Now, next, later.</strong> An item's own horizon when it names one; otherwise in progress is Now, blocked is Later, and planned work is Next when it belongs to the earliest unfinished milestone or lies on a critical path.</li>`,
    `<li><strong>ETAs</strong> come from weeks of shipped history (${feed.throughput.minimumWeeks} weeks at least) and read "unknown" until there are enough. They are bands, never dates.</li>`,
    `<li><strong>Burn-up</strong> replays today's members through the feed's history of landings.</li>`,
    `<li><strong>Not shown yet:</strong> each item's check results (and a retraction when a closed item's check turns red), work in flight and its pull request checks, and votes. They join when the feed carries them.</li>`,
    `</ul></section>`,
    `</div>`,
    ctx.script === null ? "" : `<script>${inlineScript(ctx.script)}</script>`,
  ].join("\n");
  return body;
}

/** The one-page print view: the three lanes, the milestones and what is not planned. No script. */
export function renderPrint(feed: RoadmapFeed, ctx: RenderContext): string {
  const placed = placeItems(feed);
  const work = feed.items.filter((i) => i.type !== "Milestone");
  const lane = (key: Exclude<Horizon, "done">, title: string): string => {
    const rows = work.filter((i) => placed.get(i.id)!.horizon === key).slice(0, 8);
    return `<section><h2>${title}</h2>${rows.length === 0 ? "<p>Nothing.</p>" : `<ol>${rows.map((i) => `<li><strong>${h(i.title)}</strong> <code>${h(i.id)}</code>. ${h(placed.get(i.id)!.reason)}</li>`).join("")}</ol>`}</section>`;
  };
  return [
    "---", "layout: default", "floor_assets: true", "page_class: roadmap-print", 'title: "Roadmap (print)"', 'description: "The Bridlewise roadmap on one page."', "permalink: /floor/roadmap/print/", "---", "",
    `<article class="floor-roadmap floor-print"><h1>Bridlewise roadmap</h1>`,
    `<p>Generated at main@${short(feed.source)}, ${h(feed.sourceDate.slice(0, 10))}. Developer preview: not production-ready. States are computed from the tracker; no date is promised.</p>`,
    `<div class="floor-print-lanes">${lane("now", "Now")}${lane("next", "Next")}${lane("later", "Later")}</div>`,
    `<h2>Milestones</h2><table class="floor-table"><thead><tr><th scope="col">Milestone</th><th scope="col">State</th><th scope="col">Shipped</th><th scope="col">Forecast</th></tr></thead><tbody>${[...feed.milestones].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((m) =>
      `<tr><td>${h(m.id)} ${h(m.title)}</td><td>${h(stateWords(m.state))}</td><td>${m.counts.shipped} of ${m.members.length}</td><td>${h(etaWords(m))}</td></tr>`).join("")}</tbody></table>`,
    `<h2>What we do not plan</h2><ul>${work.filter((i) => i.state === "not planned").map((g) => `<li>${h(g.title)}</li>`).join("")}</ul>`,
    `<p>The full roadmap, with the evidence for every item: ${h(ctx.roadmapUrl)}</p></article>`,
    "",
  ].join("\n");
}

/** The Atom feed: one entry per ISO week of landings (newest first), each listing its state changes; ids are stable. */
export function renderAtom(feed: RoadmapFeed, ctx: RenderContext): string {
  const titles = new Map(feed.items.map((i) => [i.id, i.title]));
  const weeks = new Map<string, { date: string; lines: string[] }>();
  for (const landing of feed.history) {
    const d = new Date(landing.date);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))).toISOString().slice(0, 10);
    const week = weeks.get(monday) ?? { date: landing.date, lines: [] };
    if (new Date(landing.date) > new Date(week.date)) week.date = landing.date;
    for (const c of landing.changes) week.lines.push(`<li>${h(titles.get(c.id) ?? c.id)} (${h(c.id)}): ${h(c.from ?? "new")} → ${h(c.to ?? "removed")}, ${h(short(landing.commit))}</li>`);
    weeks.set(monday, week);
  }
  const entries = [...weeks.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 26).map(([monday, week]) =>
    `<entry><id>${h(`${ctx.roadmapUrl}#week-${monday}`)}</id><title>Week of ${monday}: ${week.lines.length} roadmap change${week.lines.length === 1 ? "" : "s"}</title><updated>${h(new Date(week.date).toISOString())}</updated><link href="${h(ctx.roadmapUrl)}"/><content type="html">${h(`<ul>${week.lines.join("")}</ul>`)}</content></entry>`);
  return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><id>${h(ctx.roadmapUrl)}</id><title>Bridlewise roadmap: what changed</title><updated>${h(new Date(feed.sourceDate).toISOString())}</updated><link rel="self" href="${h(`${ctx.roadmapUrl}feed.xml`)}"/><link href="${h(ctx.roadmapUrl)}"/><author><name>Bridlewise roadmap</name></author>${entries.join("")}</feed>\n`;
}

/**
 * The page's time travel and "since your last visit", in plain browser
 * JavaScript over the feed itself (`data/roadmap.json`): it replays the feed's
 * `history` the way the feed documents. The last-seen commit is a per-viewer
 * convenience in localStorage; without storage the panel says so.
 */
export const TIMELINE_SCRIPT = `(() => {
  const root = document.querySelector("[data-timeline-src]");
  if (!root) return;
  const out = root.querySelector("[data-timeline-out]");
  const since = root.querySelector("[data-timeline-since]");
  const range = root.querySelector("input[type=range]");
  // Every text reaches the page as a text node: nothing here is parsed as markup.
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  const quiet = (text) => el("p", text, "floor-quiet");
  const list = (rows) => {
    if (rows.length === 0) return quiet("No item changed state.");
    const ol = el("ol", undefined, "floor-feed");
    for (const r of rows) {
      const link = el("a", r.id);
      link.href = "#item-" + r.id;
      const li = el("li");
      li.append(link, " " + (r.from || "new") + " to " + (r.to || "removed"));
      ol.append(li);
    }
    return ol;
  };
  fetch(root.getAttribute("data-timeline-src")).then((r) => r.json()).then((feed) => {
    const history = feed.history;
    const last = history.length - 1;
    if (last < 0) { out.textContent = "No history yet."; since.textContent = ""; return; }
    range.max = String(last); range.value = String(last); range.disabled = false;
    const show = () => {
      const k = Number(range.value);
      const states = new Map();
      for (let i = 0; i <= k; i += 1) for (const c of history[i].changes) states.set(c.id, c.to);
      const milestones = el("ul");
      for (const m of feed.milestones) {
        const live = m.members.map((id) => states.get(id)).filter((s) => s && s !== "not planned");
        milestones.append(el("li", m.id + " " + m.title + ": " + live.filter((s) => s === "shipped").length + " of " + live.length + " shipped"));
      }
      const head = el("p", "The roadmap at ");
      head.append(el("code", history[k].commit.slice(0, 8)), ", " + history[k].date.slice(0, 10) + " (landing " + (k + 1) + " of " + (last + 1) + ")");
      out.replaceChildren(head, milestones, el("h4", "Changes in that landing"), list(history[k].changes));
    };
    range.addEventListener("input", show);
    show();
    let seen = null;
    try { seen = window.localStorage.getItem("bridlewise.roadmap.seen"); } catch (e) { seen = null; }
    const at = seen === null ? -1 : history.findIndex((l) => l.commit === seen);
    if (seen === null) since.replaceChildren(quiet("First visit from this browser: from now on this lists what changed since you last looked."));
    else if (at < 0) since.replaceChildren(quiet("Your last visit is older than this history."));
    else since.replaceChildren(list(history.slice(at + 1).flatMap((l) => l.changes)));
    try { window.localStorage.setItem("bridlewise.roadmap.seen", history[last].commit); } catch (e) { since.append(quiet("This browser keeps no storage, so the next visit cannot compare.")); }
  }).catch(() => { out.textContent = "The roadmap data could not be loaded."; });
})();`;
