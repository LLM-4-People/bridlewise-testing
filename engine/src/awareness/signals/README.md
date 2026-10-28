# Awareness signals

The signal library of the codebase-awareness engine. Each signal is a pure
function over the parsed files plus its context, returning signal values the
awareness engine aggregates and exposes. The library spans the conventional
signals (complexity, clones, health, architecture, dependencies) and the
experiment-derived mathematical signals (topology, information theory,
physics, network centrality, and the rest), each named after the technique
it computes.

## How it is organized

Each file computes one signal family and is named for it; the header of the
file records the technique and the experiment that motivates it. The shared
`clone-graph.ts` builder backs the clone-based signals. The engine
(`../engine.ts`) discovers and runs them through the registry in
`../config.ts`; no signal is invoked by name from a call site.

## Where it lives

The folder lives at `engine/src/awareness/signals/`.
