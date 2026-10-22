# Brand

The project's public words, rendered from two sources: `docs/brand/messaging.json`
and `docs/brand/claims.json`.

## What each file does

- `messaging.ts` validates and reads the messaging source: the name, the
  promise, the summary, the status line, the licence, the
  description and topics, and the name's story. It refuses a promise word, a
  date, or a status line that does not say "developer preview".
- `claims.ts` validates and reads the claims register against the decision
  records. A designed claim whose decision got built must be rebound to its
  check.
- `render.ts` judges every claim from the checks that ran on the published
  commit. A red or missing check retracts the claim. It renders each surface:
  the README front block, the org profile, the repository metadata and the
  release header, and `brandSite` gives the site the judged register as plain
  data (the landing and the claims page are templates over it).
- `cli.ts` exposes `render <surface>` (used by GH-7's projector and the release
  train) and `siteData(root, statusPath)`, which the one site builder writes to
  `_data/brand.json` right after the floor data.

## Where it lives and what consumes it

The folder lives at `engine/scripts/brand/`. The site build
(`scripts/floor/site-design.mjs`) calls `siteData`. The projector and the release train run `cli.ts render`. The
roadmap renderer reads `messaging.ts`.
