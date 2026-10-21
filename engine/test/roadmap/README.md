# roadmap

The `engine/test/roadmap/` folder of the development surface.

## What each file does

- `graph.test.ts` — the roadmap's dependency graph (`scripts/roadmap/graph.ts`): edges and their typed refusals (an unknown id, a repeated id or edge, a cycle named in order), the per-milestone critical path (open nodes only, across milestones, a finished node breaking a chain, weights, id-order ties), the deterministic layered layout (edge direction, no overlap, one mid-point per crossed layer, barycenter sweeps), the accessible SVG (every text escaped, critical and blocked classes, no colour or inline style) and the page script (compiles, under its size cap, safe on a page without the graph, upstream/downstream marking, the milestone filter and Escape on a minimal DOM).
