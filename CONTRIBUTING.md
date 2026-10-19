# Contributing to the Bridlewise development floor

This repository carries the tests, guards, benchmarks, and design records behind [Bridlewise](https://github.com/LLM-4-People/bridlewise). It is intentionally noisier than the product repository and is not a stable SDK.

> [!WARNING]
> Do not use Bridlewise on sensitive, proprietary, regulated, or production codebases. Run it against disposable copies. Never include real credentials, private source, personal data, or local database contents in an issue, fixture, screenshot, or pull request.

## Setup

Requirements: Linux, Node `>=24.18.0 <25.0.0`, npm, Git, a C compiler, and optionally Playwright Chromium for E2E.

```bash
git clone https://github.com/LLM-4-People/bridlewise-testing.git
cd bridlewise-testing
npm ci
npm --prefix engine ci
npm run bootstrap:hooks
chmod 600 engine/bridlewise.config.json
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

## What makes a good change

- Fix the cause, not the symptom. Do not add retries, silent fallbacks, or special cases to hide a failure.
- Reproduce the failure before editing. Add a regression test that fails on the old behavior.
- State the class a prevention guard protects, the plant it uses, the driven behavior, and the liveness check.
- Keep one owner per fact. Reuse the canonical declaration; do not add a parallel registry, route, or manifest.
- Validate at trust boundaries: paths, schema fields, finite numbers, uniqueness, and cross-field invariants.
- Make multi-step state changes atomic, and give background work ownership, cancellation, timeout, and shutdown.
- Do not skip a test to make CI green. A typed refusal is better than a green lie.
- Update the docs when a command, route, config key, or user-visible behavior changes.

## Test conventions

- Web tests use Vitest; engine tests use `node:test` and `node:assert/strict`.
- Use the provided temp helpers; never depend on the developer's home directory or a live network.
- Do not plant a real credential. Use obvious synthetic values and keep them in a fixture path.
- For a reproduced bug, add the regression at the narrowest layer that would have caught it.
- For a cross-module contract, test the observable behavior, not the implementation detail.

## Commit and pull request style

- Conventional prefixes: `feat:`, `fix:`, `docs:`, `test:`, `ci:`, `refactor:`, `chore:`.
- One logical change per pull request.
- Describe what changed, how it was verified, and what could not be verified.
- Link the relevant decision record or design doc when the change is architectural.
- By submitting a contribution, you agree that it is licensed under AGPL-3.0-only.

## AI-assisted contributions

AI-assisted work is welcome. You remain responsible for the result. Disclose material assistance, verify every claim, and do not paste unreviewed generated code into safety, privacy, auth, or persistence paths.

## Review

Maintainers review correctness, evidence, scope, and consistency with the design principles. A green CI run is necessary but not sufficient. Changes that make the preview look more complete than it is may be declined.

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
