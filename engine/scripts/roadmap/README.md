# Roadmap

The roadmap renderer. Its one input is the roadmap feed
(`bridlewise-roadmap-feed/v1`, `engine/src/workflow/forge/projector/roadmap-feed.ts`),
which is the one roadmap model and is owned by the projector lane. The
renderer computes no state, critical path or forecast. It decides how the feed
reads: the page's order, the Now/Next/Later lanes with a reason each, the
words, and the drawing.

## What each file does

- `render.ts` renders the page body (written between the publish markers of
  `docs/floor/roadmap.md`), the print one-pager and the Atom weekly digest. It
  also holds the browser's time-travel script, which replays the feed's own
  history.
- `graph.ts` draws the dependency graph: a deterministic layered layout, an
  accessible SVG, and the small script that lights blockers and dependents.
- `cli.ts` is `build --feed <roadmap.json> --site <assembled site> --out <dir>`,
  which the Pages build runs after it computes the feed with
  `engine/scripts/tooling/roadmap-feed.ts`.

## Where it lives and what consumes it

The folder lives at `engine/scripts/roadmap/`. The Pages workflow runs
`cli.ts build`. The page's styles are floor components in
`docs/assets/floor/floor.css`, and the DESIGN lane owns them.
