# Contributing to the Bridlewise development floor

This repository carries the tests, guards, benchmarks, and design records behind [Bridlewise](https://github.com/LLM-4-People/bridlewise). It is intentionally noisier than the product repository and is not a stable SDK.

> [!WARNING]
> Do not use Bridlewise on sensitive, proprietary, regulated, or production codebases. Run it against disposable copies. Never include real credentials, private source, personal data, or local database contents in an issue, fixture, screenshot, or pull request.

## Setup

Requirements: Linux, Node `>=24.18.0 <25.0.0`, npm, Git, `gcc-14` (the guardian's pinned compiler; on Debian/Ubuntu install it with `sudo apt-get install -y gcc-14`), and optionally Playwright Chromium for E2E.

```bash
git clone https://github.com/LLM-4-People/bridlewise-testing.git
cd bridlewise-testing
npm ci
npm --prefix engine ci
npm run bootstrap:hooks
chmod 600 engine/bridlewise.config.json
make -C engine/guardian all
npm --prefix engine run build:bundle
```

Run the fresh-clone gate:

```bash
npm run typecheck
npm --prefix engine run typecheck
npm run check:secrets
npm run test:public
make -C engine/guardian all
make -C engine/guardian test
```

See [docs/testing.md](docs/testing.md) for the full suite and its prerequisites. The 4.1 GB corpus and the performance report are not published, so a fresh clone cannot run every suite.

The supported shard set lives in `tests/test-shards.json`. The shard workflow is `.github/workflows/test-shards.yml`; CI calls it as the `shards` job on pushes and pull requests to `main`, and it remains dispatchable. Making it a required check is a branch-protection setting. Use `scripts/test-shard-manifest.mjs` to verify the manifest before planning shards. A shard receipt proves coverage and exact-commit provenance, not the full-run runtime budget.

## What makes a good change

The [mandatory engineering rules](docs/process/AGENTS.md#mandatory-engineering-rules)
and the [evidence bar](docs/process/AGENTS.md#evidence) bind every change; the
[agent process](docs/process/AGENTS.md#what-we-will-not-accept) owns what the
floor will not accept. This page keeps the contribution mechanics around them.

- Validate at trust boundaries: paths, schema fields, finite numbers, uniqueness, and cross-field invariants.
- Make multi-step state changes atomic, and give background work ownership, cancellation, timeout, and shutdown.
- Update the docs when a command, route, config key, or user-visible behavior changes.

## Test conventions

Where a test goes, which runner it uses, how it stays deterministic and when it
must fail first are owned by [Adding a test](docs/testing.md#adding-a-test).
The contribution mechanics for a test change are the commit and pull-request
rules below.

## Commit and pull request style

- Conventional prefixes: `feat:`, `fix:`, `docs:`, `test:`, `ci:`, `refactor:`, `chore:`.
- One logical change per pull request.
- Describe what changed, how it was verified, and what could not be verified.
- Link the relevant decision record or design doc when the change is architectural.
- By submitting a contribution, you agree that it is licensed under AGPL-3.0-only.

## AI-assisted contributions

AI-assisted work is welcome. You remain responsible for the result. Disclose material assistance, verify every claim, and do not paste unreviewed generated code into safety, privacy, auth, or persistence paths.

## Review

Review applies the [evidence bar](docs/process/AGENTS.md#evidence) through the
[reviewer role](docs/process/ROLES.md#reviewer). A green CI run is necessary
but not sufficient: changes that make the preview look more complete than it is
may be declined.

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
