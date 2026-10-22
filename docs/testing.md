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

| Layer | Where | What it proves | Fresh-clone status |
|---|---|---|---|
| Public smoke tests | `main` and the `product` projection | The shipped CLI launcher, the typed refusal surface, the preflight receipt, the secret scanner, the safety warning and docs | Green with `npm run test:public` |
| Development floor | `main` | Prevention guards, server/cockpit unit tests, engine domain tests, performance and E2E suites | CI runs typechecks and the public smoke suite; the full suite has prerequisites below |

The `product` branch intentionally carries no large test tree. Publishing a test inventory without its fixtures and frozen records would create a false impression of coverage. The development floor stays on `main`, public, so the machinery can be inspected.

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
git clone {{ site.repository_url }}.git
cd bridlewise
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
- `gcc-14` and `make` for the guardian and process supervisor; `engine/guardian/Makefile` pins `CC := gcc-14`, so another compiler name is not a substitute (on Debian/Ubuntu: `sudo apt-get install -y gcc-14`).
- Chromium for Playwright E2E: `npx playwright install --with-deps chromium`.
- User systemd for the long-task-runner test.
- `openssl` for the outbound-HTTP test.
- The pinned corpus subset for the engine tests that read real code: `npm run corpus:fetch` materialises only the files those tests read (lodash, express, babel/traverse) from their upstream commits and links the corpus root the tests read. The raw 4.1 GB cache is not published; `npm run corpus:verify` judges the subset against `engine/test/fixtures/corpus-manifest.json`.
- The generated performance profile produced by `npm run perf:profile` under `tests/performance` for the root performance-regression test.

The raw corpus and the performance report are deliberately not published. A fresh clone is two documented commands from the corpus-backed tests, and the runners refuse a missing prerequisite by name instead of silently skipping. The full engine suite still needs the other host requirements above.

## The measurement registry

Every signal the floor judges, records or quotes is declared once in
`engine/src/shared/measurement-registry.ts`: its unit, its one producer
(module and exported function), its consumers (gate, record, budget or doc),
its absent semantics, its zero semantics and its load behaviour. The guard
`tests/prevention/measurement-contract.test.ts`, driven by
`engine/scripts/verification/measurement-contract.ts`, refuses a producer
that does not exist or is derived twice, a zero used for an unreadable value,
a gate or `webUi.performance` budget no entry maps, and an "agnostic" load
claim with no normalisation step. A sensitive signal with no deferral bound
is recorded as a finding, not softened.

The registered non-CPU signals at the time of writing are the profile's
measured-surface hash and instrument lock; the `web.perf.*` entries, each a
`webUi.performance` budget (the page LCP, layout shift, long-task, tab-switch,
typing, API-response, long-session heap and DOM growth, long-chat,
many-projects and viewport LCP budgets); and the suite, shard and ambient
signals the registry records as doc consumers, not budgets: the per-file collect
and per-file occupancy costs, their total collect and total occupancy
denominators, and the run-start ambient load the CPU verdict reads. The server's token throughput (`performance.tokensPerSecond`,
whose non-positive denominator is recorded and served as `null`, never 0) is a
doc consumer too. The CPU metric itself is a clearly
marked placeholder while its owner changes `run-cpu.ts` and
`budget-verdict.ts`; its final fields and load declaration are not guessed
here.

## Commands

### Root web suite

```bash
npm run typecheck
npm run typecheck:includes
npm test                 # vite/vitest suite through the watchdog
npm run test:watch
npm run test:raw         # vitest under the harness slot (every live file)
npm run test:supported   # the supported population a full run judges (the gate catalogue's web population)
npm run test:e2e         # Playwright
npm run test:all         # root suite + Playwright
npm run perf:profile     # writes the gitignored report
node --experimental-strip-types bench/run.ts
```

### The performance profile (idle-host contract)

The web suite's CPU window and the performance profile are measured over the supported population:
`npm run test:supported` runs exactly the web population (`harness gates population web-tests`). A raw run also includes the excluded
files (private artifacts the public snapshot does not publish), so its reds are declared exclusions,
not a clean run. `npm run perf:profile` writes the gitignored report under `tests/performance`, the artifact the root
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

The guardian tests exercise Landlock itself. An exit code of 3 (`landlock_unavailable`) is a skip, not a pass; the Node-side tests cover the refusal path with a mock. The shell runner is stricter still: a run that skips any test exits non-zero, and CI additionally requires a positive `PASS n/n` with `SKIP 0` from the log, so a skipped security suite cannot certify the gate.

## Gates and sharding

CI is generated from ONE gate catalogue, `engine/src/workflow/gates/catalogue.ts`. Every file under `.github/workflows/` is that owner's output (`harness sync` writes it; `harness check` refuses a hand edit, a stale file, or any other file in the folder). Each gate declares its id, class (`light`, `suite`, `action`), role (`required` is judged; `signal` is recorded and shown, never judging), the argument vectors it runs (no shell string), its toolchain, its reuse eligibility, and for a suite its population. CI and a local run use the same verbs:

```bash
cd engine
node src/cli.ts harness gates list
node src/cli.ts harness gates population web-tests --text
node src/cli.ts harness gates plan --out ../.bridlewise/gates
node src/cli.ts harness gates run typecheck-web --plan ../.bridlewise/gates/plan.json --out ../.bridlewise/gates/results
node src/cli.ts harness gates shard web-suite-3 --plan ../.bridlewise/gates/plan.json --out ../.bridlewise/gates/results
node src/cli.ts harness gates seal --plan ../.bridlewise/gates/plan.json --results ../.bridlewise/gates/results --out ../.bridlewise/gates/receipt --event pull_request
```

**Populations.** The web population is every file of the tree the runner's own globs select (`TEST_INCLUDE`, `tests/test-include.ts`, the binding `vitest.config.ts` spreads into `include`), less the catalogue's named exclusions: the private cutover graph tool, the private frozen-record population, the generated performance report consumed by the performance regression gate, and the WSL-host keep-out arm that requires a mounted Windows profile. Each exclusion carries its reason and evidence, every receipt names them, and an exclusion that names a file the globs no longer select is a refusal. The engine population is the sources its test inventory runs, asked of the inventory's owner (`engine/scripts/test-inventory.ts`) for the tree: the inventory file is a cache, never committed.

**The plan.** `plan` reads the tree once (its commit and tree id) and writes `plan.json` (`bridlewise-gate-plan/v1`): the gates, the populations, and the shard cells. Each suite packs its files longest-first into cells of equal weight (ties by path, the lowest cell first). An engine cell runs the engine runner with `--cell <file>`: it dispatches the cell's sources and WITHHOLDS the rest of the inventory — still expected, counted skipped, named on the receipt, never subtracted — and passes by the cell rule (`cellReceiptPassing`: the withheld entries are its only skips and every dispatched test passed); a cell run is never recorded as a suite run. The cell budget is the catalogue's, under the hosted-job cap. Weights are per-file CPU work from the ledger; a tree with no ledger is planned `unmeasured` (every file one unit) and the plan says so, so it never cites a weight nobody measured.

**A cell.** `run` (a light gate) and `shard` (one suite cell) first require the job's tree to be the planned tree, then run the gate's steps without a shell, forwarding and logging their output, and write one result (`bridlewise-gate-result/v1`) on every ending. A web shard runs `scripts/run-tests.ts` on exactly its files with vitest's JSON reporter and passes only when the rows of that report — not its summary — record every planned file as a passed suite of passed tests (absent counts are refused, never read as zero; a passed row with a failure message, a file with no assertions, a duplicate, an unexpected or a missing file are each refused). The engine cell passes only when the engine runner exits 0 and its own summary says every test passed.

**The seal.** `seal` merges every result into ONE receipt (`bridlewise-gate-receipt/v1`) and refuses a missing, duplicate, unexpected, failed or wrong-commit cell, a shard that ran other files than planned, and shards that do not cover their population exactly once. An action gate (the dependency review) is judged by its job's outcome on the events it runs on. The verdict is `passed` only when every required gate passed and nothing was refused; the receipt table is the job summary.

A gate cell judges coverage, completion, and exact-commit provenance. It does not judge the full-run runtime budget, which needs a separate full-suite run; do not describe a gate receipt as that budget's verdict.

Earlier shard receipts (from the hand-maintained shard manifest and its wall-clock weights, before the generated pipeline) are recorded on [the evidence page](floor/evidence.md#the-sharded-gate) as history.

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
4. Prefer one strong invariant over many equivalent assertions. The fail-first requirement for a reproduced bug belongs to the [evidence bar](process/AGENTS.md#evidence).
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
import { evalWhen } from "../../shared/when-eval.ts";

test("a malformed when-clause is refused, not defaulted", () => {
  expect(() => evalWhen("(", {})).toThrowError(/unexpected end/u);
});
```

## CI

CI runs on every pull request and every push to `main`: Node 24, both typechecks, the secret scan, the public smoke suite, the cockpit and engine builds, the guardian build/test, and the supported file set on ten disjoint shards. It does not run the corpus-backed engine suite, the four named shard exclusions, or the E2E suite. Those remain documented manual or nightly work until their prerequisites can be published reproducibly.

## Flakiness

A flaky test is a defect in the test or its subject. Reproduce it, name the cause, and fix the owner. Do not add retries to the default suite and do not reorder assertions until it passes. The E2E suite's retry policy is Playwright's: `playwright.config.ts` sets `retries: process.env.CI ? 2 : 0`, and Playwright's HTML reporter records every retry in its report. That suite is not run by this repository's CI ([CI](#ci)), so the policy is not exercised here; a retry in another suite is not permission to retry the default suite.

## What is not covered

- Production multi-tenant behavior.
- A security audit or penetration test.
- Every provider's streaming edge cases.
- Windows and macOS behavior.
- A hosted demo.
- The private corpus, private evidence, and frozen records.
