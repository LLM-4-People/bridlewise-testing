# Awareness

The awareness domain: the engine that computes a codebase's snapshot — complexity, clones, drift, hotspots, and risk — and the signals derived from it.

## What each file does

- `clone-helpers.ts` — the clone-helpers module.
- `compact.ts` — Compact representation: a 200–500 token block summarizing the.
- `config.ts` — Central configuration for the dynamic codebase awareness engine.
- `delta.ts` — EXP387 — Real-time multi-turn awareness delta.
- `engine.ts` — Dynamic awareness engine — the orchestrator.
- `fisher-ranking.ts` — EXP387 — Fisher information ranking + redundancy removal (EXP324).
- `git-command-runner.ts` — the git-command-runner module.
- `language-helpers.ts` — the language-helpers module.
- `module-helpers.ts` — the module-helpers module.
- `multi-turn.ts` — EXP387 — Multi-turn awareness engine.
- `temperature.ts` — the temperature module.
- `types.ts` — Shared types for the dynamic awareness engine. These are produced by.

## Where it lives

The folder lives at `engine/src/awareness/`.
