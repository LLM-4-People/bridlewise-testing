# Shared memory

The shared memory architecture: the multi-layer (hot/warm/cold) store, the
canonical memory entry, the tree classification, and the token-cap pruning,
all owned once. The retrieval math and the storage backends are in the
`retrieval/` and `storage/` subfolders.

## What each file does

- `index.ts` — the public API barrel for the shared memory architecture.
- `shared-memory-store.ts` — the multi-layer shared memory store with tree
  classification and full metadata.
- `memory-entry.ts` — the canonical memory entry shape.
- `memory-config.ts` — the single canonical owner of all shared-memory
  configuration.
- `memory-exposure.ts` — the module's exposure registrations.
- `memory-tree.ts` — the tree classification: project → conversation → type
  → entry.
- `ebbinghaus.ts` — the canonical Ebbinghaus forgetting-curve and
  spaced-repetition scoring.
- `token-cap.ts` — the single owner of the token-cap pruning and
  compression strategies.

## The subfolders

- `retrieval/` — the canonical retrieval math: cosine, TF-IDF, embeddings,
  HNSW, inverted index, RRF.
- `storage/` — the storage backends behind the single backend contract.

## Where it lives

The folder lives at `engine/src/shared/memory/`.
