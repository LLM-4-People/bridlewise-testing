# roadmap

The `engine/test/roadmap/` folder of the development surface.

## What each file does

- `graph.test.ts` — the roadmap's dependency graph drawing (`scripts/roadmap/graph.ts`): edges and their typed refusals (an unknown id, a repeated id or edge, a cycle named in order), the deterministic layered layout, the accessible SVG (every text escaped, critical and blocked classes, no colour or inline style) and the page script.
- `render.test.ts` — the renderer (`scripts/roadmap/render.ts`) over feeds computed by the feed's own `roadmapFeed`: Now/Next/Later with reasons, ETAs as bands or honest unknowns, the burn-up replayed from the feed's history, escaping, the gaps the page states, the print page and the Atom digest, determinism, and the feed reader's refusal of another schema.
