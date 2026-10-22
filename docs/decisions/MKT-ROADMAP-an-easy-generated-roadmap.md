---
id: MKT-ROADMAP
date: 2026-10-21
by: user
group: brand
status: in-force
implementation: partial
route: MKT
acted_in: [scripts/floor/roadmap-status.ts, docs/floor/roadmap.md, tests/prevention/roadmap-status-owner.test.ts]
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

Done so far: the roadmap page (`docs/floor/roadmap.md`) has its status tables
generated from the tracker and the evidence page's non-proofs
(`scripts/floor/roadmap-status.ts`), guarded against hand edits by
`tests/prevention/roadmap-status-owner.test.ts`.

Still missing: the decision records are not yet an input; an item's state
comes from the page's hand-written plan block, not from evidence; there is no
Projects roadmap view and no feed.
