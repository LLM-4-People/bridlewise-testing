# State

The client state layer: the nanostores that hold every piece of reactive UI state — plain, Node-testable modules fed only by the data layer and reset through a single auto-registering registry.

## What each file does

- `auth.ts` — Auth state — multi-user dashboard login/session.
- `auto-checks.ts` — the auto-checks module.
- `chat-history-load.ts` — WHETHER THIS CONVERSATION COULD BE READ.
- `chat-history-reach.ts` — HOW FAR BACK THE READER HAS ACTUALLY READ.
- `chat-messages.ts` — Plain store — fed only by client.ts.
- `chats.ts` — Plain store — fed only by client.ts.
- `config-snapshot.ts` — Plain store — fed only by client.ts.
- `coverage.ts` — DARKFIELD + ANNUNCIATOR state.
- `cross-tab.ts` — CROSS-TAB — the one place a change made in another browser tab lands.
- `dedup.ts` — Dedup summary — the one shape owner of the call's input-dedup savings; the live latest snapshot plus the type the message record and the beat carry.
- `errors.ts` — Plain store — fed only by client.ts.
- `extensions.ts` — Extensions — fed only by client.ts at the listExtensions fetch.
- `git.ts` — Git status — fed only by client.ts at the getGitStatus fetch.
- `lens.ts` — LENS state — what the provenance instrument is currently pointing at.
- `memory.ts` — the memory module.
- `metrics.ts` — Plain store — fed only by client.ts.
- `models.ts` — LLM models + the user's selection.
- `persistence.ts` — Safe localStorage persistence for client-side UI selection state.
- `projects.ts` — Plain store — Node-testable via Vitest without any Svelte compile.
- `quality.ts` — Quality snapshot — fed only by client.ts from the "quality" SSE event.
- `redaction.ts` — Redaction notice — the one shape owner of the call's masked-input fact; the live latest snapshot plus the type the message record and the beat carry.
- `reset-all.ts` — The SINGLE owner of client-side store reset on logout.
- `run-pane.ts` — Run pane — the live data projection behind the right-docked console.
- `run-state.ts` — Plain store — Node-testable via Vitest without a Svelte compile.
- `schema-store.ts` — Schema store — nanostore holding the UI schema + current signals.
- `store-registry.ts` — Store reset registry — the SINGLE owner of the auto-registering store-reset mechanism.
- `telemetry.ts` — Client telemetry — the browser's own observability owner: uncaught errors, long tasks, feed-ingest lag and boot cost, captured at the lowest browser choke points, bounded and flushed (beacon on hide, broker POST while alive) into the server's verified ingestion door.
- `timeline-event-documents.ts` — Plain store — the recorded documents of one
  ledger event, read lazily through an injectable door; fed only by the
  BeatScope fold's open.
- `timeline-query.ts` — Plain store — fed only by client.ts.
- `timeline-refs.ts` — Plain store — fed only by client.ts.
- `tools.ts` — Tools manifest — built-in + MCP, tagged.
- `ui-control.ts` — UI-control application — the single client-side owner that maps signals to actions.
- `web-ui-config.ts` — Frontend accessor for the `webUi.graph` + `webUi.metrics` config.
- `workspaces.ts` — WORKSPACES — what the cockpit is working on, of which a page may hold many.

## Where it lives

The folder lives at `src/state/`.
