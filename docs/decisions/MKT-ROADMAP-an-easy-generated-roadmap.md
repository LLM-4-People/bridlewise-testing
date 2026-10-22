---
id: MKT-ROADMAP
date: 2026-10-21
by: user
group: brand
status: in-force
implementation: partial
route: MKT
acted_in: [engine/scripts/roadmap/render.ts, engine/scripts/roadmap/graph.ts, engine/scripts/roadmap/cli.ts, docs/floor/roadmap.md, .github/workflows/pages.yml]
---
# A roadmap that is easy to follow and generated from the records

A newcomer should be able to see in one page what is done, what is being
worked on and what comes next, and trust it. So the roadmap is generated from
the tracker and the decision records, with each item's status computed from
evidence rather than typed in.

The user, 2026-10-21: "go with all recommandations, but ensure we have a very
good roadmap, we need to expose everything and it must be easy to follow".

- The recommendations are accepted: the blend of the three concepts, a light
  theme, the old indigo disc retired, fixture captures labelled as such, and
  a failing check retracts the claim it backs, publicly.
- The roadmap is generated from the tracker plus the decisions, with status
  computed from evidence, as one easy page plus milestones, a Projects
  roadmap view and a feed.

Done so far: the roadmap is rendered at publish from the one roadmap feed
(`engine/scripts/tooling/roadmap-feed.ts`, every state computed from the
tracker items' evidence, the decision records an input) by
`engine/scripts/roadmap/` (`.github/workflows/pages.yml`). It produces:

- the page: Now/Next/Later with the reason for each placement, what changed
  this week, time travel through the feed's history, each milestone's
  critical path, forecast (a band, or "unknown" when the data is too thin,
  never a date) and burn-up, the dependency graph, how far each decision is
  built, the risks and what is not planned;
- a print one-pager, an Atom feed and the feed itself as JSON.

The committed page (`docs/floor/roadmap.md`) keeps only its shell and the
dated snapshot.

Still missing: per-item checks with public retraction, in-flight pull
requests, participation (RFC links, votes as a signal, good first items),
and the GitHub milestones and Projects roadmap view, which wait on the feed
and the projector (P5.2).
