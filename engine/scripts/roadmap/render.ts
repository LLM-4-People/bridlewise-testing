/**
 * THE ROADMAP'S RENDERERS — every surface is a pure function of the model
 * (model.ts): the page, the print one-pager, the README block, the Atom feed
 * and `roadmap.json`. Escaping goes through the one markup owner
 * (shared/markup.ts). Styling comes from the floor design layer
 * (docs/assets/floor/roadmap.css), which reads the site's tokens; nothing
 * here carries a colour, a length or a date that was not computed.
 *
 * The copy follows the claims register's voice: plain, exact, dated, with the
 * evidence one click away. Nothing reads as a promise: a forecast always
 * names its method and its band, and "unknown" is said plainly.
 */
import { escapeHtml } from "../../../shared/markup.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import type { Forecast, Horizon, Roadmap, RoadmapItem, RoadmapMilestone } from "./types.ts";

export type RenderContext = Readonly<{
  /** `https://github.com/<owner>/<repo>`: every record link is pinned to the rendered commit. */
  repositoryUrl: string;
  /** The site's base URL for the roadmap's own pages (`…/roadmap/`), used by the feed. */
  roadmapUrl: string;
  /** The dependency graph as inline SVG (graph.ts), or `null` when there is no open dependency to draw. */
  graphSvg: string | null;
  /** The page's one inline script (the graph's interactions and time travel), or `null` for none. */
  script: string | null;
}>;

const h = escapeHtml;
const short = (sha: string): string => sha.slice(0, 8);

const STATUS_WORDS: Readonly<Record<RoadmapItem["computedStatus"], string>> = {
  done: "done",
  retracted: "retracted",
  "in-flight": "in flight",
  ready: "ready",
  blocked: "blocked",
  dropped: "not doing",
};

const HORIZONS: readonly { key: Exclude<Horizon, "done">; title: string; empty: string }[] = [
  { key: "now", title: "Now", empty: "Nothing is moving in this build: no open pull request names an item, and no closed item has a red check." },
  { key: "next", title: "Next", empty: "Nothing can start right now: every open item is waiting on another." },
  { key: "later", title: "Later", empty: "Nothing is queued behind the current work." },
];

const blob = (ctx: RenderContext, model: Roadmap, path: string): string => `${ctx.repositoryUrl}/blob/${model.commit}/${path}`;
const link = (href: string, text: string): string => `<a href="${h(href)}">${h(text)}</a>`;

/** A one-line plain excerpt of an item body (the full text is one click away). */
function excerpt(body: string): string {
  const first = body.split(/\n\s*\n/u).map((p) => p.trim()).find((p) => p.length > 0) ?? "";
  const plain = first.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/[*_`]/gu, "").replace(/\s+/gu, " ").trim();
  return plain.length > 220 ? `${plain.slice(0, 219).trimEnd()}…` : plain;
}

/** A forecast in words: a measured band, an honest unknown, or complete. Never a date someone promised. */
export function forecastWords(forecast: Forecast): string {
  switch (forecast.kind) {
    case "complete":
      return "Complete.";
    case "unknown":
      return `Forecast unknown: ${forecast.reason}.`;
    case "band":
      return `${forecast.remaining} left. Measured from ${forecast.weeksOfData} weeks of history: half the simulated futures finish by ${forecast.p50Week}, 85 in 100 by ${forecast.p85Week}.`;
  }
}

function progressBar(m: RoadmapMilestone): string {
  const { done, retracted, total } = m.progress;
  const pct = (n: number): string => (total === 0 ? "0" : ((n / total) * 100).toFixed(1));
  return `<div class="floor-progress" role="img" aria-label="${done} of ${total} done${retracted > 0 ? `, ${retracted} retracted` : ""}">`
    + `<span class="floor-progress-done" style="--floor-share:${pct(done)}%"></span>`
    + `<span class="floor-progress-retracted" style="--floor-share:${pct(retracted)}%"></span></div>`;
}

/** A burn-up as a small SVG: scope (outline) and done (filled), step lines, from exact history points. */
export function burnUpSvg(m: RoadmapMilestone): string {
  const points = m.burnUp;
  if (points.length < 2) return `<p class="floor-quiet">No burn-up yet: it needs at least two recorded changes to this milestone.</p>`;
  const W = 320;
  const H = 72;
  const t0 = Date.parse(points[0]!.date);
  const t1 = Date.parse(points[points.length - 1]!.date);
  const span = Math.max(t1 - t0, 1);
  const top = Math.max(...points.map((p) => p.scope), 1);
  const x = (date: string): string => (((Date.parse(date) - t0) / span) * W).toFixed(1);
  const y = (n: number): string => (H - (n / top) * H).toFixed(1);
  const step = (value: (p: (typeof points)[number]) => number): string =>
    points.map((p, i) => `${i === 0 ? "M" : `H${x(p.date)}V`}${i === 0 ? `${x(p.date)} ${y(value(p))}` : y(value(p))}`).join("") + `H${W}`;
  const last = points[points.length - 1]!;
  return `<svg class="floor-burnup" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="burn-${h(m.id)}"><title id="burn-${h(m.id)}">${h(m.id)} burn-up: ${last.done} of ${last.scope} done at ${h(last.date.slice(0, 10))}, from ${points.length} recorded changes</title>`
    + `<path class="floor-burnup-scope" d="${step((p) => p.scope)}"/><path class="floor-burnup-done" d="${step((p) => p.done)}"/></svg>`;
}

function chip(item: RoadmapItem): string {
  return `<span class="floor-state" data-status="${item.computedStatus}">${STATUS_WORDS[item.computedStatus]}</span>`;
}

function itemCard(item: RoadmapItem): string {
  const ms = item.milestone === null ? "" : `<span class="floor-ms">${h(item.milestone)}</span>`;
  return `<li class="floor-lane-card" data-status="${item.computedStatus}"><a class="floor-lane-card-title" href="#item-${h(item.id)}">${h(item.title)}</a>`
    + `<div class="floor-lane-card-meta">${chip(item)}${ms}${item.goodFirst ? `<span class="floor-good-first">good first</span>` : ""}</div>`
    + `<p>${h(item.reason)}</p></li>`;
}

function itemDetail(ctx: RenderContext, model: Roadmap, item: RoadmapItem): string {
  const rows: string[] = [];
  if (item.why !== null) rows.push(`<dt>Why</dt><dd>${h(item.why)}</dd>`);
  else rows.push(`<dt>Why</dt><dd class="floor-gap">No decision record is linked yet.</dd>`);
  const what = excerpt(item.body);
  if (what.length > 0) rows.push(`<dt>What</dt><dd>${h(what)} ${link(blob(ctx, model, item.path), "Read the item")}</dd>`);
  rows.push(`<dt>Status</dt><dd>${chip(item)} ${h(item.reason)}</dd>`);
  rows.push(`<dt>Decisions</dt><dd>${item.decisions.length === 0 ? `<span class="floor-gap">none linked</span>` : item.decisions.map((id) => {
    const record = model.decisions.find((d) => d.id === id);
    return record === undefined ? h(id) : `${link(blob(ctx, model, record.path), id)} <span class="floor-impl" data-impl="${record.implementation}">${record.implementation}</span>`;
  }).join(" · ")}</dd>`);
  rows.push(`<dt>Checks</dt><dd>${item.checks.length === 0 ? `<span class="floor-gap">none bound: the status rests on the tracker alone</span>` : item.checks.map((c) =>
    `${c.runUrl === null ? h(c.id) : link(c.runUrl, c.id)} <span class="floor-check" data-check="${c.status}">${c.status}</span>`).join(" · ")}</dd>`);
  rows.push(`<dt>Tests</dt><dd>${item.tests.length === 0 ? `<span class="floor-gap">none linked</span>` : item.tests.map((t) => link(blob(ctx, model, t), t)).join(" · ")}</dd>`);
  if (item.prs.length > 0) rows.push(`<dt>Landed in</dt><dd>${item.prs.map((ref) => (/^#\d+$/u.test(ref) ? link(`${ctx.repositoryUrl}/pull/${ref.slice(1)}`, ref) : link(`${ctx.repositoryUrl}/commit/${ref}`, short(ref)))).join(" · ")}</dd>`);
  if (item.inFlight.length > 0) rows.push(`<dt>In flight</dt><dd>${item.inFlight.map((p) => `${link(p.url, `#${p.number}`)} ${h(p.title)}${p.lane === null ? "" : ` (${h(p.lane)})`} <span class="floor-check" data-check="${p.checks}">checks ${p.checks}</span>${p.failed.length > 0 ? `: ${h(p.failed.join(", "))}` : ""}`).join("<br>")}</dd>`);
  if (item.blockers.length > 0) rows.push(`<dt>Blocked by</dt><dd>${item.blockers.map((id) => `<a href="#item-${h(id)}">${h(id)}</a>`).join(" · ")}</dd>`);
  const talk: string[] = [];
  if (item.rfc !== null) talk.push(link(`${ctx.repositoryUrl}/discussions/${item.rfc.replace(/^discussion#/u, "")}`, "RFC discussion"));
  if (item.participation?.issueUrl) talk.push(`${link(item.participation.issueUrl, "Watch the issue")}${item.participation.reactions > 0 ? ` (${item.participation.reactions} reactions)` : ""}`);
  if (item.participation?.discussionUrl) talk.push(`${link(item.participation.discussionUrl, "Discussion")} (${item.participation.upvotes} upvotes, ${item.participation.comments} comments)`);
  if (talk.length > 0) rows.push(`<dt>Take part</dt><dd>${talk.join(" · ")} <span class="floor-quiet">Votes are a signal; they never reorder the roadmap.</span></dd>`);
  return `<details class="floor-item" id="item-${h(item.id)}" data-status="${item.computedStatus}" data-horizon="${item.horizon}"${item.milestone === null ? "" : ` data-milestone="${h(item.milestone)}"`}>`
    + `<summary>${chip(item)}<span class="floor-item-title">${h(item.title)}</span><code>${h(item.id)}</code></summary><dl>${rows.join("")}</dl></details>`;
}

function milestoneSection(ctx: RenderContext, model: Roadmap, m: RoadmapMilestone): string {
  const own = model.items.filter((i) => i.milestone === m.id);
  const path = m.criticalPath.length === 0 ? `<p class="floor-quiet">No open chain: nothing in ${h(m.id)} waits on anything.</p>`
    : `<ol class="floor-path">${m.criticalPath.map((id) => `<li><a href="#item-${h(id)}">${h(model.items.find((i) => i.id === id)?.title ?? id)}</a></li>`).join("")}</ol>`;
  return `<section class="floor-milestone" id="milestone-${h(m.id)}" data-state="${m.state.replace(/ /gu, "-")}">`
    + `<header><h3><span class="floor-ms">${h(m.id)}</span> ${h(m.title)}</h3><p class="floor-ms-state">${h(m.state)} · ${m.progress.done} of ${m.progress.total} done${m.progress.retracted > 0 ? ` · ${m.progress.retracted} retracted` : ""}</p></header>`
    + progressBar(m)
    + (m.why === null || m.why.length === 0 ? "" : `<p class="floor-why">${h(m.why)}</p>`)
    + `<div class="floor-ms-grid"><div><h4>Forecast</h4><p>${h(forecastWords(m.forecast))} <a href="#method">How this is computed</a></p>${burnUpSvg(m)}</div>`
    + `<div><h4>Critical path</h4>${path}</div></div>`
    + `<div class="floor-items">${own.map((item) => itemDetail(ctx, model, item)).join("")}</div></section>`;
}

/**
 * The markers in `docs/floor/roadmap.md` between which the site build writes
 * the rendered roadmap (the page's front matter and title stay hand-written,
 * once, in that file).
 */
export const ROADMAP_PAGE_BLOCK = Object.freeze({
  path: "docs/floor/roadmap.md",
  begin: "<!-- BEGIN GENERATED AT PUBLISH: the roadmap, from the tracker items, the decision records, git history and the checks (engine/scripts/roadmap/cli.ts build) -->",
  end: "<!-- END GENERATED AT PUBLISH: the roadmap -->",
});

/** The roadmap page body (HTML), written between {@link ROADMAP_PAGE_BLOCK}'s markers by the site build. */
export function renderPage(model: Roadmap, ctx: RenderContext): string {
  const open = model.items.filter((i) => i.horizon !== "done");
  const lanes = HORIZONS.map(({ key, title, empty }) => {
    const rows = open.filter((i) => i.horizon === key);
    return `<section class="floor-lane" aria-labelledby="lane-${key}"><h3 id="lane-${key}">${title} <span class="floor-count">${rows.length}</span></h3>`
      + (rows.length === 0 ? `<p class="floor-quiet">${h(empty)}</p>` : `<ol class="floor-lane-cards">${rows.slice(0, 12).map((i) => itemCard(i)).join("")}</ol>${rows.length > 12 ? `<p class="floor-quiet">${rows.length - 12} more below, in their milestones.</p>` : ""}`)
      + `</section>`;
  }).join("");
  const unassigned = model.items.filter((i) => i.milestone === null);
  const areas = model.areas.map((a) => {
    const total = a.done + a.partial + a.pending;
    const pct = (n: number): string => (total === 0 ? "0" : ((n / total) * 100).toFixed(1));
    return `<tr><th scope="row">${h(a.group)}</th><td><div class="floor-area" role="img" aria-label="${a.done} built, ${a.partial} partly built, ${a.pending} designed but not built">`
      + `<span data-impl="done" style="--floor-share:${pct(a.done)}%"></span><span data-impl="partial" style="--floor-share:${pct(a.partial)}%"></span><span data-impl="pending" style="--floor-share:${pct(a.pending)}%"></span></div></td>`
      + `<td>${a.done}</td><td>${a.partial}</td><td>${a.pending}</td><td>${a.standing}</td></tr>`;
  }).join("");
  const decisions = model.decisions.filter((d) => d.status === "in-force").map((d) =>
    `<tr><td>${link(blob(ctx, model, d.path), d.id)}</td><td>${h(d.title)}</td><td>${d.by}</td><td><span class="floor-impl" data-impl="${d.implementation}">${d.implementation}</span></td></tr>`).join("");
  const week = model.thisWeek.length === 0 ? `<p class="floor-quiet">No tracked change in the 7 days before this commit.</p>`
    : `<ol class="floor-feed">${model.thisWeek.map((c) => `<li><time datetime="${h(c.date)}">${h(c.date.slice(0, 10))}</time> <a href="#item-${h(c.item)}">${h(c.item)}</a> ${h(c.kind)}: ${h(c.detail)} <a class="floor-quiet" href="${h(`${ctx.repositoryUrl}/commit/${c.commit}`)}">${short(c.commit)}</a></li>`).join("")}</ol>`;
  const counts = (status: RoadmapItem["computedStatus"]): number => model.items.filter((i) => i.computedStatus === status).length;
  const body = [
    `<link rel="alternate" type="application/atom+xml" title="Bridlewise roadmap: what changed" href="{{ '/floor/roadmap/feed.xml' | relative_url }}">`,
    `<div class="floor-roadmap" data-commit="${h(model.commit)}">`,
    `<header class="floor-head">`,
    `<p class="floor-lede">Where Bridlewise is, what comes next, and the evidence behind every status. This page is generated from the tracker items and the decision records at ${link(`${ctx.repositoryUrl}/commit/${model.commit}`, `main@${short(model.commit)}`)} (${h(model.generatedAt.slice(0, 10))}). Nobody types a status: a closed item counts as done only while its checks pass, and no date is promised.</p>`,
    `<p class="floor-facts">${counts("done")} done · ${counts("retracted")} retracted · ${counts("in-flight")} in flight · ${counts("ready")} ready · ${counts("blocked")} blocked</p>`,
    `<p class="floor-links"><a href="{{ '/floor/roadmap/print/' | relative_url }}">One-page print</a> · <a href="{{ '/floor/roadmap/feed.xml' | relative_url }}">Weekly digest (Atom)</a> · <a href="{{ '/floor/roadmap/data/roadmap.json' | relative_url }}">The data (roadmap.json)</a> · <a href="#method">How it is computed</a></p>`,
    model.live.available ? `<p class="floor-live">Live data from ${h(model.live.generatedAt ?? "")}.</p>` : `<p class="floor-live floor-gap">Live data unavailable in this build: ${h(model.live.reason ?? "")}. In-flight work and participation are not shown.</p>`,
    `</header>`,
    `<section class="floor-summary" aria-labelledby="summary"><h2 id="summary">Now, next, later</h2><div class="floor-lanes">${lanes}</div></section>`,
    `<section aria-labelledby="week"><h2 id="week">What changed this week</h2>${week}</section>`,
    `<section aria-labelledby="travel" data-timeline-src="{{ '/floor/roadmap/data/timeline.json' | relative_url }}"><h2 id="travel">Time travel</h2><div class="floor-ms-grid"><div><h3>Since your last visit</h3><div data-timeline-since><p class="floor-quiet">Needs JavaScript.</p></div></div><div><h3>Any version</h3><label class="floor-filter">Version <input type="range" min="0" max="0" value="0" disabled></label><div data-timeline-out><p class="floor-quiet">Needs JavaScript. The same data is in <a href="{{ '/floor/roadmap/data/timeline.json' | relative_url }}">timeline.json</a>, and <code>node engine/scripts/roadmap/cli.ts diff &lt;a&gt; &lt;b&gt;</code> prints the difference between two versions.</p></div></div></div></section>`,
    `<section aria-labelledby="milestones"><h2 id="milestones">Milestones</h2>${model.milestones.map((m) => milestoneSection(ctx, model, m)).join("")}`,
    unassigned.length === 0 ? "" : `<section class="floor-milestone" id="milestone-none"><header><h3>Not in a milestone yet</h3><p class="floor-ms-state">${unassigned.length} items. Placing them is itself work to do.</p></header><div class="floor-items">${unassigned.map((item) => itemDetail(ctx, model, item)).join("")}</div></section>`,
    `</section>`,
    ctx.graphSvg === null ? `<section aria-labelledby="graph"><h2 id="graph">Dependencies</h2><p class="floor-quiet">No open item records a dependency yet (a tracker item's <code>blocked-by</code> or <code>parent</code>), so there is no graph or critical path to draw. Recording them is how this section fills in.</p></section>` : `<section aria-labelledby="graph"><h2 id="graph">Dependencies</h2><p class="floor-quiet">Hover or focus an item to light its blockers and what it unblocks; the critical path is drawn heavier. Press Enter to jump to the item.</p><label class="floor-filter">Milestone <select data-graph-milestone><option value="">All</option>${model.milestones.map((m) => `<option value="${h(m.id)}">${h(m.id)} ${h(m.title)}</option>`).join("")}</select></label><div class="floor-graph">${ctx.graphSvg}</div></section>`,
    `<section aria-labelledby="areas"><h2 id="areas">Designed and built, by area</h2><p class="floor-quiet">From each in-force decision record's own implementation state. Standing rules govern work and are never "built".</p><table class="floor-table"><thead><tr><th scope="col">Area</th><th scope="col">Share</th><th scope="col">Built</th><th scope="col">Partly</th><th scope="col">Designed only</th><th scope="col">Standing</th></tr></thead><tbody>${areas}</tbody></table></section>`,
    `<section aria-labelledby="risks"><h2 id="risks">Risks</h2>${model.risks.length === 0 ? `<p class="floor-quiet">No open risk item. A risk is a tracker item of type Risk.</p>` : `<ul>${model.risks.map((r) => `<li><a href="#item-${h(r.id)}">${h(r.title)}</a>${r.severity === null ? "" : ` (${h(r.severity)})`}: ${h(r.reason)}</li>`).join("")}</ul>`}</section>`,
    `<section aria-labelledby="gaps"><h2 id="gaps">What we do not claim</h2><ul class="floor-gaps">${model.gaps.map((g) => `<li><strong>${h(g.statement)}.</strong> ${h(g.reason)}${g.evidence === null ? "" : ` ${link(g.evidence.startsWith("https://") ? g.evidence : blob(ctx, model, g.evidence), "Evidence")}`}</li>`).join("")}</ul></section>`,
    `<section aria-labelledby="rules"><h2 id="rules">Every decision in force</h2><p class="floor-quiet">Each rule and decision is a record with its implementation state. ${model.decisions.filter((d) => d.status === "in-force").length} in force.</p><details><summary>Show all decisions</summary><table class="floor-table"><thead><tr><th scope="col">Record</th><th scope="col">Decision</th><th scope="col">By</th><th scope="col">State</th></tr></thead><tbody>${decisions}</tbody></table></details></section>`,
    `<section aria-labelledby="method" id="method-section"><h2 id="method">How this is computed</h2><ul class="floor-method">`,
    `<li><strong>Status</strong> comes from evidence. A closed item is done only while every check bound to it passed on this commit; otherwise it is retracted and shown under Now. An open item is in flight when an open pull request names it, blocked while an open item blocks it, and ready otherwise.</li>`,
    `<li><strong>Now, next, later</strong> are computed. Now is what is moving or needs a fix. Next is what can start in the earliest open milestone, plus anything on a critical path, marked P0 or P1, or unblocking P0 or P1 work. Later is the rest, each with its reason.</li>`,
    `<li><strong>Forecasts</strong> are measured, never promised: a Monte Carlo bootstrap over the items closed per week in git history. A band needs at least 4 weeks of history and 3 closed items; otherwise it reads "unknown" with the reason.</li>`,
    `<li><strong>Burn-up</strong> is replayed from git history: a milestone's scope and done count at each commit that changed them.</li>`,
    `<li><strong>Votes and reactions</strong> are shown as a signal and never change the order.</li>`,
    `</ul></section>`,
    `</div>`,
    ctx.script === null ? "" : `<script>${ctx.script.replace(/<\/script/giu, "<\\/script")}</script>`,
  ].join("\n");
  return body;
}

/** The one-page print view: Now/Next/Later, milestones with progress and forecast, gaps. No scripts. */
export function renderPrint(model: Roadmap, ctx: RenderContext): string {
  const open = model.items.filter((i) => i.horizon !== "done");
  const lane = (key: Exclude<Horizon, "done">, title: string): string => {
    const rows = open.filter((i) => i.horizon === key).slice(0, 8);
    return `<section><h2>${title}</h2>${rows.length === 0 ? "<p>Nothing.</p>" : `<ol>${rows.map((i) => `<li><strong>${h(i.title)}</strong> <code>${h(i.id)}</code>. ${h(i.reason)}</li>`).join("")}</ol>`}</section>`;
  };
  const body = [
    `<article class="floor-roadmap floor-print"><h1>Bridlewise roadmap</h1>`,
    `<p>Generated from ${h(ctx.repositoryUrl.replace(/^https:\/\//u, ""))} at main@${short(model.commit)}, ${h(model.generatedAt.slice(0, 10))}. Developer preview: not production-ready. Statuses are computed from checks; no date is promised.</p>`,
    `<div class="floor-print-lanes">${lane("now", "Now")}${lane("next", "Next")}${lane("later", "Later")}</div>`,
    `<h2>Milestones</h2><table class="floor-table"><thead><tr><th scope="col">Milestone</th><th scope="col">State</th><th scope="col">Done</th><th scope="col">Forecast</th></tr></thead><tbody>${model.milestones.map((m) =>
      `<tr><td>${h(m.id)} ${h(m.title)}</td><td>${h(m.state)}</td><td>${m.progress.done} of ${m.progress.total}${m.progress.retracted > 0 ? ` (${m.progress.retracted} retracted)` : ""}</td><td>${h(forecastWords(m.forecast))}</td></tr>`).join("")}</tbody></table>`,
    `<h2>What we do not claim</h2><ul>${model.gaps.map((g) => `<li>${h(g.statement)}. ${h(g.reason)}</li>`).join("")}</ul>`,
    `<p>The full roadmap, with every item's evidence: ${h(ctx.roadmapUrl)}</p></article>`,
  ].join("\n");
  return `---\nlayout: default\nfloor_assets: true\npage_class: roadmap-print\ntitle: "Roadmap (print)"\ndescription: "The Bridlewise roadmap on one page."\npermalink: /floor/roadmap/print/\n---\n\n${body}\n`;
}

/**
 * The time-travel data the page's script reads (`data/timeline.json`): every
 * commit that changed the items, each milestone's done/scope at each of them,
 * and every change with the index of its commit. Everything is computed here,
 * from the history; the browser only indexes arrays (no second fold or diff).
 */
export type Timeline = Readonly<{
  commits: readonly Readonly<{ sha: string; date: string }>[];
  milestones: readonly Readonly<{ id: string; title: string; points: readonly Readonly<{ c: number; done: number; scope: number }>[] }>[];
  changes: readonly Readonly<{ c: number; item: string; kind: string; detail: string }>[];
}>;

export function timelineDocument(model: Roadmap, commits: Timeline["commits"], changes: Roadmap["thisWeek"]): Timeline {
  const index = new Map(commits.map((commit, c) => [commit.sha, c]));
  const at = (sha: string): number => {
    const c = index.get(sha);
    if (c === undefined) throw new HarnessError(`timeline: ${sha} is not one of the history's commits`, "roadmap_timeline_commit_unknown");
    return c;
  };
  return {
    commits,
    milestones: model.milestones.map((m) => ({ id: m.id, title: m.title, points: m.burnUp.map((p) => ({ c: at(p.commit), done: p.done, scope: p.scope })) })),
    changes: changes.map((change) => ({ c: at(change.commit), item: change.item, kind: change.kind, detail: change.detail })),
  };
}

/**
 * The page's time travel and "since your last visit", in plain browser
 * JavaScript over `data/timeline.json`. The last-seen commit is a per-viewer
 * convenience in localStorage (absent storage: the panel says so). No
 * framework, no dependency.
 */
export const TIMELINE_SCRIPT = `(() => {
  const root = document.querySelector("[data-timeline-src]");
  if (!root) return;
  const out = root.querySelector("[data-timeline-out]");
  const since = root.querySelector("[data-timeline-since]");
  const range = root.querySelector("input[type=range]");
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const list = (rows) => rows.length === 0 ? "<p class='floor-quiet'>No tracked change.</p>" : "<ol class='floor-feed'>" + rows.map((r) => "<li><a href='#item-" + esc(r.item) + "'>" + esc(r.item) + "</a> " + esc(r.kind) + ": " + esc(r.detail) + "</li>").join("") + "</ol>";
  fetch(root.getAttribute("data-timeline-src")).then((r) => r.json()).then((t) => {
    const last = t.commits.length - 1;
    if (last < 0) { out.textContent = "No history yet."; return; }
    range.max = String(last); range.value = String(last); range.disabled = false;
    const show = () => {
      const k = Number(range.value);
      const c = t.commits[k];
      const rows = t.milestones.map((m) => { const p = m.points.filter((x) => x.c <= k).pop(); return "<li>" + esc(m.id) + " " + esc(m.title) + ": " + (p ? p.done + " of " + p.scope + " done" : "no items yet") + "</li>"; }).join("");
      out.innerHTML = "<p>The roadmap at <code>" + esc(c.sha.slice(0, 8)) + "</code>, " + esc(c.date.slice(0, 10)) + " (" + (k + 1) + " of " + (last + 1) + " versions)</p><ul>" + rows + "</ul><h4>Changes in that version</h4>" + list(t.changes.filter((x) => x.c === k));
    };
    range.addEventListener("input", show);
    show();
    let seen = null;
    try { seen = window.localStorage.getItem("bridlewise.roadmap.seen"); } catch (e) { seen = null; }
    const seenIndex = seen === null ? -1 : t.commits.findIndex((x) => x.sha === seen);
    if (seen === null) since.innerHTML = "<p class='floor-quiet'>First visit from this browser: from now on this panel lists what changed since you last looked.</p>";
    else if (seenIndex < 0) since.innerHTML = "<p class='floor-quiet'>Your last visit is older than this history.</p>";
    else since.innerHTML = list(t.changes.filter((x) => x.c > seenIndex));
    try { window.localStorage.setItem("bridlewise.roadmap.seen", t.commits[last].sha); } catch (e) { /* storage refused: the panel already said what it could */ }
  }).catch(() => { out.textContent = "The history could not be loaded."; });
})();`;

const xml = escapeHtml;

/** The Atom feed: one entry per ISO week with its changes (the weekly digest), newest first; ids are stable. */
export function renderFeed(model: Roadmap, ctx: RenderContext, changes: Roadmap["thisWeek"]): string {
  const weeks = new Map<string, Roadmap["thisWeek"][number][]>();
  for (const change of changes) {
    const d = new Date(change.date);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    const key = monday.toISOString().slice(0, 10);
    weeks.set(key, [...(weeks.get(key) ?? []), change]);
  }
  const entries = [...weeks.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 26).map(([monday, list]) => {
    const updated = list.map((c) => c.date).sort().at(-1)!;
    const lines = list.map((c) => `<li>${xml(c.item)} ${xml(c.kind)}: ${xml(c.detail)} (${xml(short(c.commit))})</li>`).join("");
    return `<entry><id>${xml(`${ctx.roadmapUrl}#week-${monday}`)}</id><title>Week of ${monday}: ${list.length} roadmap change${list.length === 1 ? "" : "s"}</title><updated>${xml(updated)}</updated><link href="${xml(ctx.roadmapUrl)}"/><content type="html">${xml(`<ul>${lines}</ul>`)}</content></entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><id>${xml(ctx.roadmapUrl)}</id><title>Bridlewise roadmap: what changed</title><updated>${xml(model.generatedAt)}</updated><link rel="self" href="${xml(`${ctx.roadmapUrl}feed.xml`)}"/><link href="${xml(ctx.roadmapUrl)}"/><author><name>Bridlewise roadmap generator</name></author>${entries.join("")}</feed>\n`;
}

/** The README's roadmap block: slow-changing, so it is committed (harness sync) and drift fails harness check. */
export function renderReadmeBlock(model: Roadmap, ctx: RenderContext): string {
  const row = (m: RoadmapMilestone): string => `| ${m.id} · ${m.title} | ${m.state} | ${m.progress.done} of ${m.progress.total}${m.progress.retracted > 0 ? ` (${m.progress.retracted} retracted)` : ""} |`;
  const next = model.items.filter((i) => i.horizon === "next").slice(0, 5).map((i) => `- **${i.title}** (\`${i.id}\`): ${i.reason}`);
  return [
    "| Milestone | State | Done |",
    "|---|---|---|",
    ...model.milestones.map(row),
    "",
    next.length === 0 ? "Nothing can start right now: every open item waits on another." : `Next up:\n\n${next.join("\n")}`,
    "",
    `Computed from the tracker items at this commit; no date is promised. The published roadmap also applies each item's checks (a closed item whose check is red is shown retracted) and links the evidence for every item: ${ctx.roadmapUrl}`,
  ].join("\n");
}

/** `roadmap.json`: the model as data, for the projector (milestones, the Project) and the page's scripts. */
export function renderJson(model: Roadmap): string {
  return `${JSON.stringify(model, null, 1)}\n`;
}
