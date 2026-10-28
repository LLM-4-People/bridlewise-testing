# Dedup and compression lower layer

Transparent deduplication and compression applied below the API to all data
flowing through the harness. Modules call `store(data, moduleId)` and
`retrieve(id)` without knowing dedup or compression happened — the layer
dedups, compresses, stores, and reverses it on read.

## What each file does

- `decompression.ts` — EXP454 — decompression (transparent to modules).
- `index.ts` — the public API: `store`/`retrieve`.
- `lower-layer.ts` — the lower layer itself: the store→dedup→compress→keep
  pipeline.
- `dedup.ts` — the dedup engine (line, token, and structural techniques).
- `compression.ts` / `decompression.ts` — the lossless compression and its
  inverse.
- `dynamic-keywords.ts` — dynamic keyword detection for the dedup engine.
- `config.ts` — the single source of truth for the layer's tunables.
- `exposure.ts` — the exposure signals for the layer.
- `module-integration.ts` — wires the layer into each module.
- `shared-helpers.ts` — helpers shared inside the layer.

## Where it lives

The folder lives at `engine/src/shared/dedup-compression/`.
