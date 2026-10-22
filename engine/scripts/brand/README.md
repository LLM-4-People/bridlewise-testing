# Brand

The project's public messaging source, read by every generated surface.

## What each file does

- `messaging.ts` reads `docs/brand/messaging.json`, which holds the project's
  name and the repository and site addresses every surface links to.

## Where it lives and what consumes it

The folder lives at `engine/scripts/brand/`. The roadmap renderer
(`engine/scripts/roadmap/cli.ts`) reads it for its links.
