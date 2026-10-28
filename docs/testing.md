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
- the secret scanner reads the one secret catalogue, exempts no path (test trees included: a test assembles any credential at runtime), fails on a credential shape or an internal absolute path, and never prints the candidate value;
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
denominators, the shard weights and their measurement path (`testPhaseMs` and
`testPhaseCpuMs` on the CI receipt), and the run-start ambient load the CPU
verdict reads. The server's token throughput (`performance.tokensPerSecond`,
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
npm run test:supported   # the supported population a full run judges (the manifest's files)
npm run test:e2e         # Playwright
npm run test:all         # root suite + Playwright
npm run perf:profile     # writes the gitignored report
node --experimental-strip-types bench/run.ts
```

### The performance profile (any-host contract)

The web suite's CPU window and the performance profile are measured over the supported population:
`npm run test:supported` runs exactly the manifest's files. A raw run also includes the excluded
files (private artifacts the public snapshot does not publish), so its reds are declared exclusions,
not a clean run. `npm run perf:profile` writes the gitignored report under `tests/performance`, the artifact the root
performance-regression gate (`tests/performance/regression.test.ts`) judges. Nothing about the
profile waits for, or is refused because of, what else runs on the host
([NO-LOAD-BLOCK](decisions/NO-LOAD-BLOCK-nothing-is-blocked-by-cpu-load.md)):

- **Admitted, never queued, never exclusive.** The step is admitted at once as a heavy run under
  its per-run caps (a cgroup scope and a CPU-time limit). It never waits for another run, and
  other runs never wait for it. A report records no lock or slot stamp, and none is asked of it.
- **Wall time is a signal, never a verdict.** The latency readings (page and viewport LCP, long
  tasks, tab switch, typing, API response, the long-chat and 10k-projects renders) are wall
  clock, which a busy host inflates. They are recorded in the run's ledger row and printed
  beside their budgets as `NOT JUDGED`; none fails a run, measured or not
  (`WEB_PERFORMANCE_WALL_SIGNALS` in `engine/src/kernel/web-performance-budgets.ts`).
- **What is not time stays judged.** Layout shift, DOM node counts, and long-session heap and
  DOM growth are judged against their budgets. A breach or an unmeasured value fails.
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
  can be judged (present, fresh, non-vacuous); the web suite's reporter compares the judged
  measurements with their budgets. Neither a dark gate nor a missing report is a pass.
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
npm run test:live:s1     # the S1 scenarios that need a real supplementary group (CI runs them)
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

## Sharding

`tests/test-shards.json` is the supported-suite manifest. Its file list comes from `vitest list --filesOnly --json`, not from a second glob. Its generated `weightSource` is the population record: it names the supported count, the heads the weights were measured at, and which files needed a separate measurement; a self-check test refuses a manifest whose declared count disagrees with its file list, so no page restates the count by hand. The manifest names the exclusions with a reason and evidence: the private cutover graph tool, the private frozen-record population, the generated performance report consumed by the performance regression gate, and the WSL-host keep-out arm that requires a mounted Windows profile. A live file that is neither supported nor excluded fails verification.

`scripts/test-shard-manifest.mjs` owns the manifest hash, the deterministic weighted assignment, the shard report envelope, and the one weight producer. `measure` reads the wrapped shard reports of a complete green run, takes each supported file's `endTime - startTime` from the JSON reporter, and rewrites `weightMs`, `measuredHeadSha`, `measuredAt`, and `weightSource` together; it refuses a partial, duplicated, non-green, or different-manifest population. `scripts/test-shard-merge.mjs` accepts only envelopes that name the same head commit, manifest hash, assignment hash, shard count, and exact file assignment; the plan is required (`--plan`), the measured manifest is required (`--manifest-source`), and a measured timing window is required by default (`--require-timing` is the default), because a receipt without them names a caller's head with nothing binding the reports to it. The merge derives its test counts from the assertion rows and refuses a summary that declares more tests than the rows record, a passed row carrying a failure message, a supported file with no assertions, a plan whose file assignment is not the canonical assignment re-derived from the measured manifest (even when its own hash was recomputed), and a zero-file shard while the manifest is non-empty. It also refuses a missing shard, a duplicate file, a failed or skipped test, a file outside the checkout, and a report from another commit. One receipt records the exact commit, shard count, runner class, manifest hash, assignment hash, per-shard file, test, pass/fail/skipped counts and timings, the excluded files with their reason and evidence anchor, the measured test-phase wall time, and summed shard duration.

The shard gate is `.github/workflows/test-shards.yml`, called as the `shards` job in `.github/workflows/ci.yml` on every push and pull request to `main`. It is also dispatchable with a chosen shard count and runner label. The merge job is the gate: a failed shard, a missing report, a duplicate file, a failed or skipped test, an unexpected file, or a report from another commit refuses the receipt and fails the run. The union of the shard reports must equal the manifest exactly once, so a missing shard cannot look like a smaller green suite. The merge job uploads `test-shard-receipt` (JSON); the artifact names the manifest digest, the shard indexes and timings, the pass/fail counts, and the four exclusions with their evidence anchors. Making the job a required check is a branch-protection setting, not a workflow property.

The ten-shard `ubuntu-24.04` receipt at `f54df4a5` (CI run `39470087124`, artifact `test-shard-receipt`) measured `testPhaseMs` 83438, `testPhaseCpuMs` 658687, 523 files, and 8734 tests. Against the 244017ms single-host supported run that is 2.92x, not 10x (the factor is the single-host wall time divided by the receipt's `testPhaseMs`: 244017/83438 = 2.92; `testPhaseCpuMs` is the summed shard cost and is not the numerator). The first green receipt at `d47909de` measured 2.81x on 521 files. The CI gate uses the same ten-shard `ubuntu-24.04` plan; the 10x exit criterion still needs a documented larger runner class. The receipt records the measured factor rather than inferring it from the number of jobs.

```bash
mkdir -p .bridlewise/shard-plan
npm run test:list -- --out .bridlewise/shard-plan/live-manifest.json
npm run test:verify-shards -- --manifest tests/test-shards.json --live .bridlewise/shard-plan/live-manifest.json
node scripts/test-shard-manifest.mjs plan --manifest tests/test-shards.json --shards 10 --head "$(git rev-parse HEAD)" --out-dir .bridlewise/shard-plan/plan
```

`vitest list` does not run the vitest global setup, so a raw listing takes neither the host's instrument lock nor a source fingerprint and is not accepted as evidence about a tree. `test:list` records a content fingerprint of the working tree before and after the listing; `test:verify-shards` recomputes that fingerprint itself and refuses a listing from another tree, another checkout, or a tree that moved while the listing ran. An explicit `--tree` is only a cross-check against the recomputed value, never an override: passing the stale fingerprint a listing was written under cannot make that listing certify a tree that changed after it. Verification also RE-RUNS the enumeration: the supplied listing is the subject under judgement, never the evidence about its own population, so a document that omits a file the fresh enumeration selected (or names one it did not) is refused even when its fingerprint is current. The two listings take no instrument lock — that gap is stated rather than hidden; the fingerprint binding plus the set comparison are what keep the population evidence honest.

A complete green run's wrapped reports are the weight measurement; pass the head so a report from another commit cannot be measured by mistake:

```bash
args=()
for index in $(seq 1 10); do
  args+=(--report ".bridlewise/shard-plan/reports/shard-${index}.json")
done
node scripts/test-shard-manifest.mjs measure \
  --manifest tests/test-shards.json \
  --head "$(git rev-parse HEAD)" \
  --runner local \
  --out tests/test-shards.json \
  "${args[@]}"
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
| `engine/live/` | The live suite, unconfined by design: opt-in provider and MCP smoke tests, and the S1 scenarios that need a real supplementary group (`npm --prefix engine run test:live:s1`, run in CI's engine job) |
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
