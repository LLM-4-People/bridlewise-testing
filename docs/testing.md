---
layout: default
title: Testing
description: What the public product verifies, what the development floor verifies, and how to add a test.
permalink: /testing/
---

# Testing

> [!WARNING]
> Bridlewise is a developer preview. A green suite is evidence about the tested surface, not a production guarantee. Do not run the harness against sensitive or production codebases.

## Two layers

| Layer | Repository | What it proves | Fresh-clone status |
|---|---|---|---|
| Public smoke tests | `bridlewise` | The shipped CLI launcher, the typed refusal surface, the preflight receipt, the secret scanner, the safety warning and docs | Green with `npm run test:public` |
| Development floor | `bridlewise-testing` | Prevention guards, server/cockpit unit tests, engine domain tests, performance and E2E suites | CI runs typechecks and the public smoke suite; the full suite has prerequisites below |

The product repository intentionally carries no large test tree. Publishing a test inventory without its fixtures and frozen records would create a false impression of coverage. The development floor is published separately so the machinery can be inspected.

## Public smoke tests

```bash
npm ci
chmod 600 engine/bridlewise.config.json
npm run test:public
```

The suite uses Node's built-in test runner and covers:

- `bin/bridlewise.mjs` is executable, prints help/version, and lists every harness verb;
- `harness` without a verb is a typed refusal, not a crash or a silent success;
- `preflight` returns `harnessReady: false` and denies model invocation, repository mutation, and network egress;
- the secret scanner passes a clean tree, fails on a provider-shaped key outside a fixture path, fails on an internal absolute path, and never prints the candidate value;
- the README carries the developer-preview and sensitive-codebase warning;
- the CLI/testing/extending docs and the licence/community files exist.

Run the whole public gate with:

```bash
npm run verify:public   # typecheck + secret scan + public tests
```

## Development-floor setup

```bash
git clone https://github.com/LLM-4-People/bridlewise-testing.git
cd bridlewise-testing
npm ci
npm --prefix engine ci
npm run bootstrap:hooks
chmod 600 engine/bridlewise.config.json
make -C engine/guardian all            # the Landlock guardian and its test payload
npm --prefix engine run build:bundle   # the engine bundle, pinned by self-protection
npm run corpus:fetch                   # optional: the pinned subset for the corpus-backed tests
```

A clone that skips the two build steps still passes the public smoke suite, but the supported full suite reports named refusals: confinement tests report the guardian binary missing, and the self-protection guard reports the engine bundle absent. Neither is a skip.

Requirements beyond the product:

- Linux with Landlock for confinement tests; WSL works with the documented caveats.
- A C compiler and `make` for the guardian and process supervisor.
- Chromium for Playwright E2E: `npx playwright install --with-deps chromium`.
- User systemd for the long-task-runner test.
- `openssl` for the outbound-HTTP test.
- The pinned corpus subset for the engine tests that read real code: `npm run corpus:fetch` materialises only the files those tests read (lodash, express, babel/traverse) from their upstream commits and links the corpus root the tests read. The raw 4.1 GB cache is not published; `npm run corpus:verify` judges the subset against `engine/test/fixtures/corpus-manifest.json`.
- The generated performance profile produced by `npm run perf:profile` under `tests/performance` for the root performance-regression test.

The raw corpus and the performance report are deliberately not published. A fresh clone is two documented commands from the corpus-backed tests, and the runners refuse a missing prerequisite by name instead of silently skipping. The full engine suite still needs the other host requirements above.

## Commands

### Root web suite

```bash
npm run typecheck
npm run typecheck:includes
npm test                 # vite/vitest suite through the watchdog
npm run test:watch
npm run test:raw         # vitest under the harness slot
npm run test:e2e         # Playwright
npm run test:all         # root suite + Playwright
npm run perf:profile     # writes the gitignored report
node --experimental-strip-types bench/run.ts
```

### The performance profile (idle-host contract)

`npm run perf:profile` writes the gitignored report under `tests/performance`, the artifact the root
performance-regression gate (`tests/performance/regression.test.ts`) judges. A profile is a
measurement, not a smoke test, so the conditions under which it is taken are part of the
result:

- **One profile at a time.** The step takes the host's one instrument lock. A second run
  waits, and a run that did not hold the lock records no measurement.
- **The host is otherwise idle.** No other suite, build, container, or browser runs on the
  same cores. The budgets judge worker CPU time, so contention inflates the measurement
  rather than the budget.
- **The host is on its normal power and thermal profile.** A laptop on battery, a throttled
  host, or a shared runner under load is not a valid host for a comparison.
- **Comparisons stay within one runner class.** A receipt names the runner class and the
  exact commit; numbers from different machines, core counts, or runner labels are not
  compared.
- **A report belongs to one tree.** It names the head commit and a measured-surface hash. A
  report minted against different code, or a surface that has since changed, refuses the
  freshness test instead of judging an artifact that no longer describes the tree.
- **The step isolates its stack.** It prepares a fresh fixture under the user's cache home,
  serves it on port 0 with its own server, and removes the fixture when it ends. It never
  uses the developer's running servers or stores.
- **A budget breach is recorded as a breach.** The regression gate judges whether the report
  can be judged (present, fresh, non-vacuous, lock-held); the web suite's reporter compares
  the measurements with their budgets. Neither a dark gate nor a missing report is a pass.
- **Not per shard.** The report is a prerequisite of the root performance-regression test.
  The shard manifest excludes that test because a shard runner does not produce the report,
  and a shard receipt is not a performance verdict.

The evidence page carries the command, the commit, the measured values, and the gate's
result. The report and its run record are gitignored; a later tree does not inherit them.

### Engine suite

```bash
cd engine
npm run typecheck
npm test                 # full engine suite; refuses without the corpus
npm run test:guards      # architecture, prevention, workflow guards
npm run test:unit
npm run test:editor
npm run test:live        # opt-in provider/network tests
npm run check            # typecheck + verification
npm run coverage
```

### Guardian

```bash
make -C engine/guardian all
make -C engine/guardian test
make -C engine/guardian test_process_supervisor
```

The guardian tests exercise Landlock itself. An exit code of 3 (`landlock_unavailable`) is a skip, not a pass; the Node-side tests cover the refusal path with a mock.

## Sharding

`tests/test-shards.json` is the supported-suite manifest. Its file list comes from `vitest list --filesOnly --json`, not from a second glob. It currently accounts for 521 supported files and names four exclusions with a reason and evidence: the private cutover graph tool, the private frozen-record population, the generated performance report consumed by the performance regression gate, and the WSL-host keep-out arm that requires a mounted Windows profile. A live file that is neither supported nor excluded fails verification.

`scripts/test-shard-manifest.mjs` owns the manifest hash, the deterministic weighted assignment, and the shard report envelope. `scripts/test-shard-merge.mjs` accepts only envelopes that name the same head commit, manifest hash, assignment hash, shard count, and exact file assignment. It refuses a missing shard, a duplicate file, a failed or skipped test, a file outside the checkout, and a report from another commit. One receipt records the exact commit, shard count, runner class, manifest hash, assignment hash, per-shard file, test, pass/fail/skipped counts and timings, the excluded files with their reason and evidence anchor, the measured test-phase wall time, and summed shard duration.

The shard gate is `.github/workflows/test-shards.yml`, called as the `shards` job in `.github/workflows/ci.yml` on every push and pull request to `main`. It is also dispatchable with a chosen shard count and runner label. The merge job is the gate: a failed shard, a missing report, a duplicate file, a failed or skipped test, an unexpected file, or a report from another commit refuses the receipt and fails the run. The union of the shard reports must equal the manifest exactly once, so a missing shard cannot look like a smaller green suite. The merge job uploads `test-shard-receipt` (JSON); the artifact names the manifest digest, the shard indexes and timings, the pass/fail counts, and the four exclusions with their evidence anchors. Making the job a required check is a branch-protection setting, not a workflow property.

The first green ten-shard receipt at `d47909de` on `ubuntu-24.04` measured `testPhaseMs` 86708, `testPhaseCpuMs` 636835, 521 files, and 8722 tests. Against the 244017ms single-host supported run that is 2.81x, not 10x. The CI gate uses the same ten-shard `ubuntu-24.04` plan; the 10x exit criterion still needs a documented larger runner class. The receipt records the measured factor rather than inferring it from the number of jobs.

```bash
mkdir -p .bridlewise/shard-plan
npx vitest list --filesOnly --json > .bridlewise/shard-plan/live-manifest.json
node scripts/test-shard-manifest.mjs verify --manifest tests/test-shards.json --live .bridlewise/shard-plan/live-manifest.json
node scripts/test-shard-manifest.mjs plan --manifest tests/test-shards.json --shards 10 --head "$(git rev-parse HEAD)" --out-dir .bridlewise/shard-plan/plan
```

Run each planned shard's files through `scripts/run-tests.ts`, wrap the JSON report with `test-shard-manifest.mjs wrap`, and merge every wrapped report:

```bash
args=()
for index in $(seq 1 10); do
  args+=(--shard ".bridlewise/shard-plan/reports/shard-${index}.json")
done
node scripts/test-shard-merge.mjs \
  --manifest .bridlewise/shard-plan/plan/manifest.json \
  --manifest-source tests/test-shards.json \
  --plan .bridlewise/shard-plan/plan/plan.json \
  --expected-shards 10 \
  --head "$(git rev-parse HEAD)" \
  --runner local \
  --require-timing \
  --out .bridlewise/shard-plan/receipt.json \
  "${args[@]}"
```

The merge contract and the manifest contract are covered by the public smoke suite. The local sample in [the evidence page](floor/evidence.md#the-sharded-gate) is a two-shard subset, not a supported-set receipt. A shard run judges coverage, completion, and exact-commit provenance. It does not judge the full-run runtime budget, which needs a separate full-suite run; do not describe a shard receipt as that budget's verdict.

## Test map

| Path | Subject |
|---|---|
| `tests/unit/` | Server, client, API, persistence, and focused behavior |
| `tests/prevention/` | Guards against a class of regression, not one bug |
| `tests/cockpit/` | Svelte surfaces and interaction invariants |
| `tests/performance/` | Budgets and measured regressions |
| `tests/helpers/`, `tests/fixtures/` | Shared setup and deterministic fixtures |
| `tests/setup/` | Hermetic network and process setup |
| `engine/test/` | Engine domains: editor, intelligence, memory, privacy, safety, timeline, workflow, MCP, quality, and more |
| `engine/live/` | Opt-in provider and MCP smoke tests |
| `bench/` | Concurrency, DB, ledger, payload, redaction, and write-path measurements |

## Adding a test

1. Put the test beside its subject's domain: root web behavior in `tests/unit/` or `tests/prevention/`; engine behavior in the matching `engine/test/<domain>/`.
2. Use the runner already used by that tree. The web suite uses Vitest (`import { describe, expect, test } from "vitest"`); the engine suite uses `node:test` and `node:assert/strict`.
3. Make it deterministic. Use `mkdtemp`/the provided temp helpers, inject clocks and providers, and never depend on the developer's home directory, a live network, or a real credential.
4. Prefer one strong invariant over many equivalent assertions. If the test protects a reproduced bug, make it fail on the old behavior first.
5. For a prevention guard, state the class, the plant, the driven behavior, and the liveness check in the header comment. A guard that cannot prove it sees the plant is not a guard.
6. Do not add skips. If a prerequisite is absent, the runner should refuse with a typed reason; a skipped test that looks green is the failure this project exists to prevent.
7. Run the focused file, then the domain suite, then the checks that touch your change.

Example engine test:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../../src/kernel/integrity.ts";

test("canonical JSON is stable across key order", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
});
```

Example web test:

```ts
import { expect, test } from "vitest";
import { normalize } from "../../server/intelligence/query.ts";

test("a blank query is refused, not broadened", () => {
  expect(() => normalize("   ")).toThrowError(/empty/u);
});
```

## CI

The product repository runs Node 24, two `npm ci` installs, both typechecks, the secret scan, the public smoke tests, the cockpit build, the engine bundle, and the guardian build/test on every push and pull request.

The testing repository runs both typechecks, the secret scan, the public smoke suite, the cockpit and engine builds, the guardian build/test, and the supported file set on ten disjoint shards. It does not run the corpus-backed engine suite, the four named shard exclusions, or the E2E suite. Those remain documented manual or nightly work until their prerequisites can be published reproducibly.

## Flakiness

A flaky test is a defect in the test or its subject. Reproduce it, name the cause, and fix the owner. Do not add retries to the default suite and do not reorder assertions until it passes. Playwright CI may use a bounded retry for browser timing, and the retry must be visible in the report.

## What is not covered

- Production multi-tenant behavior.
- A security audit or penetration test.
- Every provider's streaming edge cases.
- Windows and macOS behavior.
- A hosted demo.
- The private corpus, private evidence, and frozen records.
