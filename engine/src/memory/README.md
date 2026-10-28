# Memory

The memory domain: the persistent memory store, its backends, and the retrieve and inject paths that carry context between sessions.

## What each file does

- `attempt-history.ts` — the attempt-history module.
- `context-helpers.ts` — the context-helpers module.
- `memory-config.ts` — the memory-config module.
- `memory-search.ts` — the memory-search module.
- `memory-store.ts` — the memory-store module.
- `memory-types.ts` — the memory-types module.
- `tool-result-exposure.ts` — Test-only hook to reset the registration flag AND clear the shared exposure registry.
- `tool-result-retrieval.ts` — Semantic retrieval for the tool-result-in-memory store (EXP433).
- `tool-result-store.ts` — Tool-result-in-memory store (EXP433).
- `tool-result-summary.ts` — Deterministic per-tool-type summary generator for the tool-result-in-memory.

## Where it lives

The folder lives at `engine/src/memory/`.
