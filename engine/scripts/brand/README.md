# Brand

The project's public messaging sources, read by every generated surface.

## What each file does

- `messaging.ts` — reads `docs/brand/messaging.json`: the project's name and
  the repository and site addresses every surface links to.
- `claims.ts` — reads `docs/brand/claims.json`, the claims register. Each
  claim holds while its checks pass, is designed but not built (it names its
  decision), or is not claimed (it states its reason). A claim whose check is
  red is rendered as retracted.

## Where it lives and what consumes it

The folder lives at `engine/scripts/brand/`. The roadmap generator
(`engine/scripts/roadmap/`) reads both files.
