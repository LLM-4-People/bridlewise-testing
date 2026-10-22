---
layout: default
floor_assets: true
page_class: floor
title: "Verify the floor"
description: "Commands that check the Bridlewise development floor and a product preview release, with expected output shapes and explicit non-proofs."
permalink: /floor/evidence/
---

# Verify the floor

Every claim on this floor should have a command. These commands check the published snapshot on a disposable clone. None needs a provider key, a database key, or a real credential. The `gh` commands require an authenticated GitHub CLI session; the local commands do not.

<div class="callout-warning" role="note">
<p>Bridlewise is an experimental developer preview. A passing command is evidence about the surface it exercised, not a production guarantee. Do not run the preview against sensitive or production code.</p>
</div>

Expected outputs below are shapes from the 2026-10-19 public snapshot. Counts and hashes move. Read the command, the exit status, and the field that carries the claim, not only the last line.

## Fresh clone gate

```bash
git clone https://github.com/LLM-4-People/bridlewise-testing.git
cd bridlewise-testing
npm ci
npm --prefix engine ci
chmod 600 engine/bridlewise.config.json
npm run typecheck
npm --prefix engine run typecheck
npm run check:secrets
npm run test:public
```

Expected:

```text
secret scan: clean (201 synthetic fixture reference(s) allowlisted)
ℹ tests 28
ℹ pass 28
ℹ fail 0
```

The typechecks exit 0 with no diagnostics. The allowlist count moves with the fixtures.

What this proves: the launcher is executable, the version command answers, `harness` without a verb is a typed refusal, `preflight` reports `harnessReady: false`, the secret scanner passes and fails on its own test plants, the shipped docs and community files exist, canonical JSON is stable, and a provider-shaped key is redacted before display.

What it does not prove: the cockpit, the engine domain suites, the browser E2E suite, a live provider, a large repository, or the guardian. Those are separate gates.

## Inventory check

```bash
cd engine
npm run inventory:check
```

Expected shape, on one line:

```json
{"conservation":{"canonicalCount":511,"excludedCount":9,"gitRecognizableCount":528,"kind":"verified","nonCanonicalCount":8},"generatorRevision":"test-inventory-generator/v4","inventoryHash":"<sha256>","sourceSetHash":"<sha256>","status":"current","testCount":10499,"transactionPresent":false}
```

The claim is `"status":"current"`. It means the generated inventory and the disposition manifest match the tracked test surface this checkout sees. Counts move when tests are added or removed.

What this proves: the inventory is not hand-edited drift, and every recognized test surface entry has a disposition.

What it does not prove: that any test passed, that the count is coverage, or that the private corpus is present. The corpus root the tests read is not published.

## The supported suite on one host

Run the supported set in one process; the generated CI runs the same population across shards.

```bash
npm run test:supported
```

On 2026-10-20, at `fd7e058f`, the run passed **521/521 files, 8720 tests, 2 expected failures, 0 failed** in 193.2 s wall clock (1137.7 s CPU). The same set at `b4dc6b33` (before two documentation fixes) failed three tests: the two guards that found the docs and the folder README stale, and `test-run-watchdog` C3, which re-ran green alone and in the fixed run (the recorded FLAKY-WATCHDOG-C3 entry).

Those runs predate the calibrated-work migration. The two budget numbers below are kept as HISTORY in the retired raw-CPU unit (`raw-cpu-ms/v0`); they are INCOMPARABLE with the current declaration and no longer judge anything.

- `cpu-per-test-file` (then): 2183.7 ms/file against a 2032.2 ms/file cap (baseline 1926.0 × the +5.5% ambient allowance). The ledger held no clean judged run on this machine, so it was a first measured reading, not a same-host comparison.
- `performance-report`: unjudgeable because the profile report was generated at `2caada8f` and this tree's measured surface differs. Generate the profile at the head being judged.

### Why the unit changed

Raw CPU per test file is invariant to a runnable process waiting for a core, but not at saturation: cache and memory-bandwidth contention add real work to the same instructions. The same tree measured 2124.7 ms/file under load ~9-10 against the 1926 ms/file floor — a red caused by the box, not the suite.

Every run now pairs its CPU delta with a fixed deterministic calibration benchmark taken at run start and run end (`engine/src/shared/run-cpu.ts`): a fixed integer loop over a 256 KiB working set, six fixed chunks, spawned with `--no-opt` so V8's time-based tiering cannot change the instruction count, each chunk timed by its own `process.cpuUsage()`. The reading is the median chunk; the run's unit is the mean of its start and end readings; the judged figure is

```text
workUnitsPerTestFile = (runCpuMs / calibrationMs) / testFileCount
```

computed once by `computeRunWork` and read by every consumer. The declaration is in `testExecution.webUiSuiteCpuBudget` (`calibrated-work/v1`), currently in its ACCUMULATION phase until twelve clean full runs exist, when the window's clean median is derived into the floor; its population is the 537 test files a full run now covers (re-based 2026-10-21 from the 521 the retired floor was measured on), and the retired 1926 ms/file floor is recorded there under `legacy` with `incomparable: true` and is never rescaled.

On 2026-10-20, on this 12-core WSL2 host, a four-file/68-test run of the supported suite was measured three times in the ambient background and twice with eight CPU burners. The host was NOT idle during the ambient runs: `/proc/pressure/cpu` `some avg10` read 75%, 22.8% and 5.5% before them, and other agents' work was still running. The calibrated figures are from the exact production calibrant (5,000,000 iterations, six chunks, 256 KiB).

| condition | run | raw ms/file | calibration ms | units/file | calibration drift | load5 per CPU |
|---|---|---:|---:|---:|---:|---:|
| ambient | 1 | 14,158.2 | 52.48 | 269.80 | 26.2% | 1.65 |
| ambient | 2 | 11,272.2 | 43.81 | 257.27 | 11.9% | 1.62 |
| ambient | 3 | 10,657.5 | 41.64 | 255.93 | 11.9% | 1.57 |
| 8 burners | 1 | 8,871.8 | 45.87 | 193.41 | 17.9% | 1.46 |
| 8 burners | 2 | 11,432.0 | 44.19 | 258.70 | 4.8% | 1.44 |

All five runs are inside the declared load bound (`validThroughLoad5PerCpu` 1.7; the measured maximum was 1.65/cpu). The full five-run set is still NOT invariant: raw spread was 29.1% across the ambient runs and 25.2% across the loaded ones, and the calibrated spread was 5.3% and 28.9%. The two runs whose OWN stationarity witness exceeded the declared `calibrationDriftMaxFraction` (0.15) are the ones that break it — a 26.2% and a 17.9% start/end drift, during a load transition. The gate DEFERS those runs (`not-judged`) rather than judging them outside the regime where the residual was measured.

Among the three runs inside BOTH declared bounds, the result is tight:

| set (drift <= 15%, load5 <= 1.7/cpu) | raw ms/file | units/file |
|---|---:|---:|
| ambient 2 | 11,272.2 | 257.27 |
| ambient 3 | 10,657.5 | 255.93 |
| 8 burners 2 | 11,432.0 | 258.70 |
| **spread** | **7.0%** | **1.1%** |
| **loaded step (ambient 3 → 8 burners 2)** | **+7.3%** | **+1.1%** |

That is the claim this page makes: within the metric's declared validity bounds the calibrated unit moved +1.1% under eight burners while raw CPU moved +7.3% and the run's wall clock moved +42% (18.4 s to 26.2 s); outside either bound the gate says it cannot judge, rather than passing or failing. The eight burners are visible in the pressure reading, not in loadavg: `/proc/pressure/cpu` `some avg10` was 1.4% before the first loaded run and 14.3-17.7% after it, while loadavg stayed at its ambient level because other agents' work dominated it. The residual is stated, not assumed away. An earlier synthetic calibration design (12 in-process JS threads) was rejected because it moved ~60% under the same burners while the target moved 5%; hardware counters were refused because `perf` is unavailable (`kernel.perf_event_paranoid=2`).

What this proves: the supported file set runs to completion on this host with no failing and no skipped test.

What it does not prove: the four excluded suites, a 10x shard claim, an idle-host CPU verdict, or a fresh-clone run.

## The sharded gate

The CI gate is generated from the gate catalogue (`engine/src/workflow/gates/`, [the testing map](../testing.md#gates-and-sharding)): `ci.yml`'s `shard` matrix runs each suite's planned cells and its `seal` job merges every result into one `gate-receipt`, refusing a missing, duplicate, failed or wrong-commit cell and shards that do not cover their population exactly once. The receipt names the four web exclusions with their reasons.

The runs below were taken through the earlier hand-written shard workflow and its hand-maintained manifest; they are kept as history.

On 2026-10-20 the local manifest and plan checks passed at `c3349a33`:

```text
shard manifest: 521 supported, 4 excluded, 525 live, e553d052b256
shard plan: 10 shard(s), e553d052b256
assignment 62374d29ac19e613b4c32eec23343a817862e17445c5d1cfce0ad149bd11d45e
```

The full ten-shard run was **not** run locally: the host load was 21 to 26 on 12 cores, and the idle-host rule in this page applies to a full measurement. Instead, two shards of a twelve-file subset were run through the same runner and merge path. Shard 1 ran 7 files and 15 tests in 11.431 s; shard 2 ran 5 files and 38 tests in 7.869 s. The merged receipt named 12 files, 53 tests, 53 passed, 0 failed, 0 skipped, manifest hash `585307ad590f68ad4a39438bd44cfed5b8568e400e4c47dd6cf62421189d2a55`, and all four exclusions. This is a mechanism sample, not a supported-set receipt.

Receipt shape from that sample (abridged):

```json
{
  "schemaVersion": "bridlewise-test-shard-receipt/v1",
  "headSha": "c3349a33afe138097e252ee4076e8ecf5e13267a",
  "shardCount": 2,
  "runnerClass": "local",
  "manifestHash": "585307ad590f68ad4a39438bd44cfed5b8568e400e4c47dd6cf62421189d2a55",
  "fileCount": 12,
  "testCount": 53,
  "passedTests": 53,
  "failedTests": 0,
  "skippedTests": 0,
  "excludedFileCount": 4,
  "exclusions": [
    {
      "path": "tests/performance/regression.test.ts",
      "reason": "requires the generated tests/performance report from an idle-host profile; the report is not published and cannot be produced on every shard",
      "evidence": "docs/floor/roadmap.md#snapshot · public baseline audit"
    }
  ],
  "testPhaseMs": 34624,
  "testPhaseCpuMs": 19300,
  "shards": [
    { "index": 1, "fileCount": 7, "testCount": 15, "passedTests": 15, "failedTests": 0, "skippedTests": 0, "durationMs": 11431 },
    { "index": 2, "fileCount": 5, "testCount": 38, "passedTests": 38, "failedTests": 0, "skippedTests": 0, "durationMs": 7869 }
  ]
}
```

The refusal arms were driven directly: merging one report while expecting two refused with `expected 2 shard report(s), received 1`; a union missing one planned file refused with `missing 1 manifest file(s): tests/prevention/no-unused-exports.test.ts`; and a report with `success=false` refused with `shard 2: vitest reported success=false`.

On 2026-10-20, CI run [`39439338300`](https://github.com/LLM-4-People/bridlewise-testing/actions/runs/39439338300) at `3b4db454` carried the full set through that gate on a push, not a dispatch: `Typecheck, public tests, build`, `Plan the supported file set`, all ten shard jobs, and `Merge one qualification receipt` succeeded. The merge job uploaded the `test-shard-receipt` artifact, and the downloaded receipt names `headSha` `3b4db4548f8a20520bf0bf44640f4cf49dbbdb61`, ten `ubuntu-24.04` shards, manifest `e553d052b256` and assignment `62374d29…`, 521 files and 8722 tests (8722 passed, 0 failed, 0 skipped), the four exclusions with their evidence anchors, and `testPhaseMs` 88000 with `testPhaseCpuMs` 692556. This is the supported-set receipt as a CI artifact, not prose.

On 2026-10-20, CI run [`39470087124`](https://github.com/LLM-4-People/bridlewise-testing/actions/runs/39470087124) at `f54df4a5` ran the current set through the same gate. The downloaded `test-shard-receipt` artifact names ten `ubuntu-24.04` shards, manifest `b0e9f6305c0a`, assignment `80e3d108…`, 523 files and 8734 tests (8734 passed, 0 failed, 0 skipped), the four exclusions, `testPhaseMs` 83438 and `testPhaseCpuMs` 658687 (the summed shard duration). The shard walls were 62736, 66395, 56882, 49566, 69874, 67883, 71445, 81359, 67206 and 65341 ms: max/min **1.64x**, mean 65869 ms. Shard 8 was the heavy one (81359 ms, 53 files, 684 tests); its measured file times are led by `promotion-boundary` 29003 ms, `subprocess-confinement-owner` 22641 ms, `content-search-deadline` 11618 ms and `redaction-reaches-provider` 9362 ms. Shard 4 was the light one (49566 ms, 52 files, 579 tests); its leaders are `run-executes-once` 25727 ms and `database-thread-supervision` 10692 ms. The run's `test-shard-plan` artifact holds the exact per-shard file lists; the receipt itself records counts and timings.

The checked-in manifest still carried weights measured at `0ba57912`, and its plan predicted 148734–148736 ms for every shard (1.00x). The 1.64x wall spread was therefore stale per-file weights, not the assignment arithmetic. The ten `test-shard-report-*` artifacts give each file's `endTime - startTime`; against the checked-in weights the ratio ranges from 0.052x (`customization-write-path-owner`, 17400 → 896 ms) to 10.47x (`router`, 301 → 3152 ms), and the weight sum falls from 1487347 ms to 798882 ms (1.86x). The manifest owner's `measure` command rewrote all 523 weights and `measuredHeadSha` from those reports (`f54df4a5`, measuredAt `2026-10-20T17:56:30.903Z`). The new plan predicts 79888–79889 ms per shard (1.00x) and assigns 51–53 files per shard. The after wall spread is **not** measured: replaying the same file durations under the new assignment equalises the sums by construction, and a projection that packs each shard onto the three concurrent slots this run used has a 26630–39967 ms critical path (1.50x), because `test-isolation-contract` alone costs 39967 ms in whichever shard carries it. The next CI receipt is the wall-time confirmation; the remaining lever is splitting that file or a makespan-aware assignment, not another weight edit.

What this proves: the checked-in manifest verifies against the live, tree-bound listing, the deterministic plan is reproducible, the selected files run through the watchdog, and the merge emits one receipt with the exclusion evidence and the required counts and timings. The CI caller is wired to the same workflow, and run `39439338300` exercised it end to end on a push: the matrix and the union enforcement operate in CI, and the qualification receipt is a recorded artifact rather than a narrative.

What it does not prove: a 10x factor, a clean same-commit single-host comparison for the speedup, or that branch protection makes the job a required check. The receipt's `testPhaseMs` is one measurement on the `ubuntu-24.04` class; the 2.81x figure at `d47909de` remains a historical comparison.

## A fresh clone

On 2026-10-20 a clean clone at `b866b826` was put through the documented path (in `/home/example/fresh-floor`): `npm ci` in both trees, `npm run bootstrap:hooks`, `chmod 600 engine/bridlewise.config.json`, `make -C engine/guardian all`, `npm --prefix engine run build:bundle`, and `npm run corpus:fetch`.

| Step | Result |
|---|---|
| `npm run corpus:fetch`, `npm run corpus:verify` | reused the verified cache (digest `58b5aeb696ea`, 2.8 MB) and linked the root; verify green |
| `npm run verify:public` | exit 0: five typecheck configurations, secret scan clean, public smoke `28/28` |
| Focused corpus probe | 81 engine tests and 12 Vitest tests, 0 failed |
| Supported 521-file suite | **521/521 files, 8720 passed, 2 expected failures, 0 failed** (132.4 s wall, 1054.3 s CPU) |
| Judged budgets | `cpu-per-test-file` red at 2023.6 ms/file against a 1988.2 ms/file cap — a RETIRED raw-CPU reading, kept as history and INCOMPARABLE with the calibrated-work declaration; `performance-report` unjudgeable because a fresh clone has no profile (`npm run perf:profile` is its named prerequisite) |

The clone found three defects the working tree could not, because that tree had already been set up:

1. `npm run corpus:fetch` refused a cache it had itself verified: it judged the declared corpus root, which a fresh clone has not linked, instead of the cache it would reuse. Fixed at `0e45bf58`; the fetch arm now removes the upstream before its second call, so only reuse can answer.
2. Ten supported files (55 tests) failed until two builds ran. The Landlock guardian was never built, so every confined git read refused; the engine bundle did not exist, so the self-protection guard failed its own premise. Both are setup steps now (`5522cc3d`), and the ten files pass 205 tests with them.
3. One documentation line named the generated engine bundle path — a gitignored path a briefing document may not spell — and the doc guard said so; the line now names the artifact by role (`b866b826`).

What this proves: a clean clone with the documented commands runs the public gate, the corpus-backed tests, and the whole supported suite without guessing which tests are silently missing.

What it does not prove: the four excluded suites (two private-only guards, the performance regression gate, the WSL keep-out arm), an idle-host CPU verdict, or a 10x shard claim.

## Corpus boundary

The 4.1 GB corpus fixture root is not published. It is an assembled cache of dozens of public upstream checkouts. The cache carries mixed licenses, duplicate trees, nested Git histories, and test-only key, certificate, and environment fixtures. Publishing the cache as another public repository would redistribute third-party code under incompatible terms and would preserve historical material that a current-tree scan does not clear. The floor does not do that. The [third-party notices](https://github.com/LLM-4-People/bridlewise-testing/blob/main/THIRD_PARTY_NOTICES.md) record the boundary.

To reproduce a corpus-backed test without publishing the cache, fetch the pinned subset. `engine/test/fixtures/corpus-manifest.json` names the three members the public tests read (lodash, express, babel/traverse), their upstream commits, licences, and the size and sha256 of every file. The fetch materialises only those files outside the checkout and links the result at the declared corpus root:

```bash
npm run corpus:fetch     # materialise the pinned subset and link it
npm run corpus:verify    # judge every size and hash against the manifest
cd engine
node --experimental-strip-types --test --test-concurrency=1 \
  test/aux/awareness.test.ts \
  test/aux/quality.test.ts \
  test/tools/concurrent/worker-pool.test.ts \
  test/safety/hallucination-benchmark.test.ts \
  test/verification/required-fixture-roots.test.ts \
  test/verification/corpus-manifest.test.ts
cd ..
./node_modules/.bin/vitest run tests/prevention/dev-server-scanner-exclusion.test.ts
```

On 2026-10-20, on the public tree at `2caada8f`, the pinned subset (manifest digest `58b5aeb696ea…`, 99 files, 1.6 MB) was fetched and verified from the three upstream commits, and the focused probe passed **80 engine tests** (including the eight `corpus-manifest` arms) and **12 Vitest tests**. The earlier manual probe at `856f101` passed 73 engine tests and 5 Vitest tests. The pinned subset is the reproducible replacement for that manual copy: most of the cache is not read by the default suite, and the cache alone is not enough for the full suite. The performance report, Chromium, systemd, OpenSSL, Landlock, and the live provider consent remain separate prerequisites.

### Performance probe

On 2026-10-20, on the public tree at `2caada8f` (clean), the profile and its regression gate ran on this host:

```bash
npm run perf:profile
./node_modules/.bin/vitest run tests/performance/regression.test.ts
```

Result: the profile passed 3 of 3 tests and the regression gate passed 36 of 36. The report carried `instrumentLock: "held"` and `treeIdentity.headSha` `2caada8f8272c987378e3f7484cb76fb21349577` with `dirty: false`, generated at 11:25:03Z. The report and its run record are gitignored and were not published. The conditions are the idle-host contract in [the test map](https://github.com/LLM-4-People/bridlewise-testing/blob/main/docs/testing.md#the-performance-profile-idle-host-contract).

Measured against the configured budgets: page LCP 2144ms (1500), worst long task 199ms (100), tab switches 81.6 to 148.2ms (200), chat-input typing 23.49ms mean (60), isolated API maximum 2032ms on `GET /api/schema/ui/values` (250), long-chat (1000 messages) render 5100ms (2000), long-session DOM growth 549 nodes (1500), viewport LCP 852 to 1220ms (2000). The LCP, worst-long-task, API and long-chat budgets are red. The supported shard set does not judge them, and this page does not call the profile a pass.

The previous probe at `0ba57912` measured 2081ms for the same long-chat phase and 1208ms for the isolated API maximum; the 5100ms and 2032ms readings here are one run on one host, not a trend.

The manual shard workflow produced a green qualification receipt on 2026-10-20 at `d47909de` on ten `ubuntu-24.04` runners: 521 files, 8722 tests, `testPhaseMs` 86708, `testPhaseCpuMs` 636835, and assignment hash `62374d29ac19e613b4c32eec23343a817862e17445c5d1cfce0ad149bd11d45e`. The single-host supported run took 244017ms, so the measured test-phase factor is 2.81x. This is not a 10x claim.

This is one profile and one shard class on one audit date. It is not a cross-machine benchmark, a reproducible performance proof, or the full suite.

## Guardian

```bash
make -C engine/guardian all
make -C engine/guardian test
```

Expected on a host without a private mount namespace:

```text
PASS 40/40
ALL TESTS PASS
```

Expected on a host where `unshare -rm` works:

```text
PASS 44/44
ALL TESTS PASS
```

An exit code of 3 (`landlock_unavailable`) is a skip, not a pass. The two bind-mount alias tests add four assertions when the host can create the namespace.

What this proves: the tested guardian paths work on this host kernel.

What it does not prove: that the guardian is a VM, a network firewall, a seccomp profile, or a user-namespace boundary. A pass on one kernel is not a pass on every kernel.

## Promotion state

```bash
npm run promote -- status
```

On a fresh public clone, the expected answer is a typed refusal:

```json
{
  "command": "promote status",
  "generatedAt": "<iso8601>",
  "integrityHash": "<sha256>",
  "result": {
    "ok": false,
    "code": "promotion_source_missing",
    "class": "input",
    "message": "the source branch refs/heads/testing of profile testing-to-master does not exist here",
    "remedy": "Name a source revision that exists (--source <rev>), or create the profile's source branch.",
    "data": {
      "source": "refs/heads/testing"
    }
  },
  "schemaVersion": "bridlewise-harness-command/v1",
  "status": "fail"
}
```

The command may print one audit line to stderr before the JSON envelope. That is not a broken checkout. In the public snapshot used for this check, only `main` is published; the `testing` source ref belongs to the maintainer topology. A checkout that has the source ref returns `promotion_status` instead, with the profile, source, target, pending count, pending and hold refs, hold record, state, and last run.

What this proves: the request reached the promotion primitive and received its typed answer. A refusal names its class and its one remedy.

What it does not prove: that a promotion is due, that the target gate passes, that the remote is reachable, or that the public branch matches the maintainer target. Use `npm run promote -- plan --diff` in a checkout with the source ref for a projected diff. Nothing there publishes.

## CI evidence

Latest run for the floor:

```bash
gh run list \
  --repo LLM-4-People/bridlewise-testing \
  --workflow ci.yml \
  --limit 1 \
  --json conclusion,headSha,url
```

Expected shape:

```json
[{"conclusion":"success","headSha":"<sha>","url":"https://github.com/LLM-4-People/bridlewise-testing/actions/runs/<id>"}]
```

Read the jobs, not only the run:

```bash
run_id=$(gh run list \
  --repo LLM-4-People/bridlewise-testing \
  --workflow ci.yml \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')

gh run view "$run_id" \
  --repo LLM-4-People/bridlewise-testing \
  --json jobs \
  --jq '.jobs[] | "\(.name): \(.conclusion)"'
```

Expected job line:

```text
Typecheck, public tests, build: success
```

For the product repository, the expected job line is:

```text
Build and verify: success
```

What this proves: the configured steps passed at that commit.

What it does not prove: that the full corpus-backed, live, or E2E suites ran. They do not run in that job.

The product repository's own smoke commands and expected counts are on the mirrored [product evidence page]({{ '/evidence/' | relative_url }}). That page and this one check different trees.

## Product preview release

List a prerelease and download its assets:

```bash
tag=$(gh release list \
  --repo LLM-4-People/bridlewise \
  --exclude-drafts \
  --limit 20 \
  --json tagName,isPrerelease \
  --jq '[.[] | select(.isPrerelease)][0].tagName // empty')

if [ -z "$tag" ]; then
  echo "no prerelease found"
  exit 1
fi

work=$(mktemp -d)
cd "$work"
gh release download "$tag" --repo LLM-4-People/bridlewise
sha256sum -c SHA256SUMS
```

Expected shape:

```text
./bridlewise-<tag>-source.tar.gz: OK
./bridlewise-<tag>-cockpit.tar.gz: OK
./bridlewise-<tag>-engine-bundle.js: OK
./bridlewise-<tag>-sbom-engine.spdx.json: OK
./bridlewise-<tag>-sbom-web.spdx.json: OK
./bridlewise-<tag>-promotion-receipt.json: OK
```

At the 2026-10-20 snapshot the selected tag was `v0.0.3-preview`. What this proves: the downloaded bytes match the published list, the receipt is attached, and the release is marked as a prerelease.

What it does not prove: who published the list, that the build is reproducible, that the assets are signed, or that the code is correct. A checksum is not a signature.

If the release publishes a build provenance attestation, verify one asset:

```bash
gh attestation verify <downloaded-asset> --repo LLM-4-People/bridlewise
```

An exit status of 0 binds the asset digest to the release workflow run and commit under GitHub's OIDC identity. It does not prove the source is correct or the build is reproducible.

## Docs links

```bash
npm run docs:links
```

Expected shape:

```text
docs links: clean (489 Markdown files)
```

The count moves as pages are added. The checker reads `git ls-files` and resolves repository-relative Markdown links. It skips absolute URLs, root-relative paths, anchors, and Liquid `relative_url` expressions.

What this proves: the tracked Markdown links it can resolve are present.

What it does not prove: that the rendered Pages site has no broken links, or that an untracked page is deployed.

## What none of this proves

- **A green CI run is not correctness.** It proves the configured steps passed at one commit.
- **The focused probes are not the full suite.** The full suite still needs the complete corpus, a fresh performance report, Chromium, systemd, OpenSSL, and Landlock. The probes above cover the declared corpus root, the corpus readers, the scanner bait, the profile, and the profile regression gate, not the full inventory or the live provider suite.
- **A current inventory is not a passing suite.** It proves the inventory matches the tracked surface.
- **Guardian passes are not a universal sandbox proof.** A skip is not a pass, and one kernel is not every kernel.
- **A promotion refusal is not a failed release.** It can be the correct answer for a checkout that lacks the maintainer refs.
- **Checksums and attestations are not audits.** They bind bytes and build identity, not intent or correctness.
- **The docs link check is not a site crawl.** It does not see rendered Liquid links.
- **There has been no security audit.** No third-party review, penetration test, or certification exists.

## Record your own check

If you repeat a claim, leave a record someone else can replay:

```text
claim:
commit:
command:
observed:
interpretation:
```

A claim without a command is a story. The [known issues]({{ '/known-issues/' | relative_url }}) page lists the gaps these commands cannot close, and the [status snapshot]({{ '/floor/status/' | relative_url }}) shows the last generated floor state.
