---
id: GH-PROJECTION
date: 2026-10-21
by: user
group: github
status: in-force
implementation: partial
route: P5.2
acted_in: [scripts/floor/roadmap-status.ts, tests/prevention/roadmap-status-owner.test.ts, .github/workflows/publish.yml]
---
# GitHub always reflects the harness

Anything posted by hand on GitHub goes stale the moment the project moves on.
If instead every page, issue and status on GitHub is computed from the
repository's own records, it is always current and can never disagree with
them.

The user's emphasis on the GitHub decisions, 2026-10-21: "ensure things are
really dynamics and deterministic as much as possible, like the github should
always automatically reflects the harness, its state, its issues, its tests,
etc".

- GitHub is a deterministic, always-current projection of the harness: its
  state, tracker, tests, budgets and decisions.
- Nothing is posted by hand, and no drift is possible: a projection can be
  rebuilt from the records at any time.

Done so far: the docs site is built from the repository on every push to
(`.github/workflows/pages.yml`), and the roadmap's status tables are
generated from the tracker (`scripts/floor/roadmap-status.ts`), with
`tests/prevention/roadmap-status-owner.test.ts` refusing a page that differs
from the generator's output.

Still missing: issues, the project board, milestones, releases and
discussions are not yet projected from the records (the projector, P5.2), and
the automatic failure issues are opened by a separate workflow rather than by
the projection.
