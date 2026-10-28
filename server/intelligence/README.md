# Intelligence domain

The intelligence domain owns the server's window into a codebase: the
repository map, dependency graph, symbol search, and content search. The heavy
analysis runs on worker threads so a map build never wedges the request loop —
each bridge hands its worker to the run domain's pool, never spawning its own.

The Git bridge owns both synchronous and asynchronous reads through the same confinement plan, result classification and effect boundary. Custody status uses asynchronous captured reads and reuses a successful status as repository evidence. An incomplete capture is unavailable, so it cannot become an empty status or claim Git never executed.

## What each file does

- `intelligence-bridge.ts` — the single server-side owner of code
  intelligence. Adapt routes and tools to the canonical engine's repository
  map, dependency graph, impact analysis, and symbol search, gating every call
  through the filesystem gate.
- `auto-heal.ts` — detects and repairs a stale code index and broken import
  edges, so the map the model reads reflects the tree as it is now.
- `content-search.ts` — the content-search door. Owns the bounds from config
  and routes a search through the worker pool to the engine.
- `content-search-engine.ts` — the pure content-search engine: the one module
  that walks the tree applying a regex per line and ranking matches.
- `repository-map-worker.ts` — the worker-thread entry point that builds the
  repository map off the main thread.
- `quick-view-worker.ts` — the worker-thread entry point that builds the
  quick-view index off the main thread.
- `content-search-worker.ts` — the worker-thread entry point that runs content
  search off the main thread.
- `git-bridge.ts` — read-only git status for a project path, the single owner
  of the git spawn.
- `git-ops-bridge.ts` — extends the read-only git bridge with branch, diff, and
  log reads.

## Where it lives

The folder lives at `server/intelligence/`.
