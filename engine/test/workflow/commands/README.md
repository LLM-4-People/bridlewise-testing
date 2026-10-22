# Harness verb tests

The `engine/test/workflow/commands/` folder tests the derived verb registry
(`engine/src/workflow/commands/`, `engine/scripts/verification/command-registry.ts`).

## What each file does

- `command-registry.test.ts` — the registry IS the commands folder: every module
  is a registered verb and nothing else is, and they are the CLI's verbs. The
  committed registry is its generator's output. A module is a verb by location
  and type: an unannotated declaration still counts, while a missing, renamed
  or second export, a value of another shape, a verb named otherwise and an
  empty folder are refused. A new verb is one import and one entry. The wiring:
  `harness check` reds a stale registry and `harness regenerate` rewrites it.
