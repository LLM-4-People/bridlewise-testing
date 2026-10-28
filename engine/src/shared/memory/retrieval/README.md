# Shared memory retrieval

The canonical retrieval math for all memory and search: each primitive is
owned once here so every consumer shares one implementation rather than
re-deriving it.

## What each file does

- `retriever.ts` — the canonical retrieval facade: the single entry point
  that dispatches to the backends.
- `cosine.ts` — the canonical cosine similarity.
- `tfidf.ts` — the canonical TF-IDF index and query.
- `embeddings.ts` — the canonical embeddings provider (the lazy
  `@xenova/transformers` loader).
- `hnsw.ts` — the minimal pure-TS HNSW vector index.
- `inverted-index.ts` — the posting-list inverted index for lexical
  retrieval.
- `rrf.ts` — reciprocal rank fusion.
- `text-utils.ts` — the canonical tokenizer.
- `types.ts` — the shared retrieval types.

## Where it lives

The folder lives at `engine/src/shared/memory/retrieval/`.
