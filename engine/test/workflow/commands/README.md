# Harness verb tests

The `engine/test/workflow/commands/` folder tests the derived verb registry
(`engine/src/workflow/commands/`).

## What each file does

- `command-registry.test.ts` — the registry lists exactly the verbs the
  folder's files declare, in verb order, and they are the CLI's verbs. The
  committed registry is its generator's output. A new verb file is one import
  and one entry, nothing else. A stale registry is refused until sync rewrites
  it, and a verb declared in a file named otherwise is refused.
