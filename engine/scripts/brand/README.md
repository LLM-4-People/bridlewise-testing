# Brand

The project's public words, rendered from two sources: `docs/brand/messaging.json`
and `docs/brand/claims.json`.

## What each file does

The messaging source's reader and validator is `engine/src/workflow/messaging.ts`
(the runtime layer, so the forge's repository settings read it too).

- `claims.ts` validates and reads the claims register against the decision
  records. A designed claim whose decision got built must be rebound to its
  check.
- `render.ts` judges every claim from the checks that ran on the published
  commit. A red or missing check retracts the claim. It renders each surface:
  the README front block, the org profile, the repository metadata, the
  release header and the claims page.
- `cli.ts` exposes `render <surface>` (used by GH-7's projector and the release
  train), `build --site --checks` (the claims page, run by the Pages build) and
  `sync --write|--check`, the harness arm: it validates both sources whole and
  writes the front doors' generated blocks (the README's opening and the site
  home's hero and description). `harness sync` runs it to write and
  `harness check` (a required check) to judge, so a broken source fails the
  pull request that broke it.

## Where it lives and what consumes it

The folder lives at `engine/scripts/brand/`. `harness sync` and `harness
check` run `cli.ts sync` (`FRONT_DOOR_GENERATOR`,
`engine/src/kernel/verification-paths.ts`). The Pages workflow runs `cli.ts
build`. The projector and the release train run `cli.ts render`.
