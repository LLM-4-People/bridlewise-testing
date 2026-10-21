# Roadmap

The roadmap generator. Every roadmap surface is rendered from the tracker
items (`docs/trackers/items/`), the decision records (`docs/decisions/`), git
history, a checks snapshot and an optional live snapshot. Nothing on the
roadmap is typed by hand, and no date is promised.

## What each file does

- `types.ts` — the one data model every surface renders from (`bridlewise-roadmap/v1`).
- `inputs.ts` — reads and validates the inputs: decision records, the floor
  checks snapshot, the live snapshot, and links that must resolve.
- `model.ts` — `buildRoadmap`, a pure function. It computes status from
  evidence (a closed item whose check is red is retracted), Now/Next/Later
  with a reason each, milestone progress, designed-vs-built by area, risks and
  gaps.
- `graph.ts` — the dependency graph, the critical path per milestone, a
  deterministic layered layout, an accessible SVG and its small page script.
- `history.ts` — git history replayed exactly: snapshots, changes, `Item:`
  trailers, burn-up, weekly throughput, time travel and the history document
  the page folds in the browser.
- `forecast.ts` — honest milestone forecasts: a seeded Monte Carlo band from
  measured throughput, or `unknown` with the reason.
- `render.ts` — the page, the print one-pager, the README block, the Atom
  feed and `roadmap.json`.
- `cli.ts` — `readme --check|--write` (run by `harness sync` and
  `harness check`), `build --out <dir> …` (run by the site build), and
  `diff <a> <b>`.

## Where it lives and what consumes it

The folder lives at `engine/scripts/roadmap/`. `harness sync` and
`harness check` run `cli.ts readme`. The Pages build runs `cli.ts build`. The
projector reads the `roadmap.json` it writes.
