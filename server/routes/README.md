# Routes

The HTTP route layer: every API endpoint the web UI calls — one file per resource, all registered through the single route registry that owns auth, validation, and error mapping.

## What each file does

- `agents.ts` — Agents route — returns the current agent states, available agent types.
- `auth.ts` — Auth routes — multi-user authentication.
- `auto-checks.ts` — Auto-checks routes — backed by the SQLite projection.
- `awareness.ts` — Awareness routes — codebase awareness signals (complexity, clones, …).
- `chats.ts` — Chat routes — backed by the SQLite projection.
- `config.ts` — Config route — reads the real harness config (not a fixture).
- `editor.ts` — Editor routes — file reading, writing, and editing within the project root.
- `extensions.ts` — Extensions routes — list configured extensions and manifest info.
- `filesystem.ts` — Filesystem routes — server-side directory browsing.
- `file-tree.ts` — File tree routes — list files (not just directories) in a project.
- `git-ops.ts` — Git operations routes — branches, log, diff, status for a project.
- `health.ts` — Health check route — reports server liveness and harness readiness.
- `intelligence.ts` — Intelligence routes — code graph, repository map, symbol search.
- `live.ts` — THE STANDING LIVENESS STREAM — the socket that answers "is the API there".
- `mcp.ts` — MCP routes — list configured MCP servers with live connection status.
- `memory.ts` — Memory route — searches and retrieves from the real harness memory store.
- `metrics.ts` — Metrics route — returns a combined metrics payload.
- `models.ts` — Model providers — the HTTP surface over the user's saved providers.
- `projects.ts` — Project routes — backed by the SQLite projection (server/db).
- `quality.ts` — Quality routes — codebase quality indicator and recommendations.
- `registry.ts` — Route registry — the SINGLE owner of route registration.
- `run.ts` — RUN CONTROL — start, cancel, steer. Every route here is a POST.
- `run-status.ts` — THE RUN'S ONE STATUS READ — a GET-only module answering liveness from the registry alone.
- `run-stream.ts` — THE RUN STREAM — a subscriber, and only a subscriber.
- `safety.ts` — Safety feature testing routes — lets the user trigger each detector.
- `schema.ts` — Schema route — serves the schema-driven UI extension manifest.
- `settings.ts` — Settings routes — per-user preferences stored encrypted in the DB.
- `timeline.ts` — Timeline route — queries the timeline event ledger.
- `tools.ts` — Tools route — returns the tool manifest (built-in + MCP).
- `views.ts` — DB row → client view mappers. The single owner of the snake_case → camelCase mapping.

## Where it lives

The folder lives at `server/routes/`.
