# Harness-root scripts

Retained predecessor integration/bootstrap tooling. These files explain and
read old round records; they are not invoked to ship current work.
The [process index](../../CONTRIBUTING.md) routes live tasks, and
[MERGE-GUIDE.md](../../CONTRIBUTING.md) owns current merge-back.

## What each file does

- `bootstrap-integration.mjs` — the retired one-time helper that seeded the
  `integration/` tree from the candidate.
- `merge-round.mjs` — the retained predecessor merge/record reader.
- `merge-round.test.mjs` — the unit tests for the merge script, testing the
  mechanical merge in isolation.

## Where it lives and what consumes it

The folder lives at `scripts/harness-root/`. Current workflows do not invoke
the bootstrap or round merge; `merge-round.test.mjs` is run by the suite.
