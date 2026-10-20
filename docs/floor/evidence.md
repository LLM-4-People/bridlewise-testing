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

What it does not prove: that any test passed, that the count is coverage, or that the private corpus is present. `engine/large-codebases` is not published.

## The supported suite on one host

Run the 521-file supported set in one process; the sharded workflow runs the same set across shards.

```bash
FILES=$(node -e "process.stdout.write(require('./tests/test-shards.json').files.map(f => f.path).join(' '))")
./node_modules/.bin/vitest run $FILES
```

On 2026-10-20, at `fd7e058f`, the run passed **521/521 files, 8720 tests, 2 expected failures, 0 failed** in 193.2 s wall clock (1137.7 s CPU). The same set at `b4dc6b33` (before two documentation fixes) failed three tests: the two guards that found the docs and the folder README stale, and `test-run-watchdog` C3, which re-ran green alone and in the fixed run (the recorded FLAKY-WATCHDOG-C3 entry).

Two judged budget gates are red on that run, and they belong to the performance track rather than to the tests:

- `cpu-per-test-file`: 2183.7 ms/file against a 2032.2 ms/file cap (baseline 1926.0 × the +5.5% ambient allowance). The ledger holds no clean judged run on this machine, so this is a first measured reading, not a same-host comparison.
- `performance-report`: unjudgeable because the profile report was generated at `2caada8f` and this tree's measured surface differs. Generate the profile at the head being judged.

What this proves: the supported file set runs to completion on this host with no failing and no skipped test.

What it does not prove: the four excluded suites, a 10x shard claim, an idle-host CPU verdict, or a fresh-clone run.

## The sharded gate

The CI gate is `.github/workflows/test-shards.yml`, called as the `shards` job by `.github/workflows/ci.yml` on every push and pull request to `main`. The manual dispatch path remains. The merge job refuses a failed shard or a union of shard reports that is not the manifest exactly once, then uploads `test-shard-receipt`. The receipt names the manifest digest, the shard indexes and timings, the pass/fail counts, and the four exclusions with their evidence anchors.

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

What this proves: the checked-in manifest verifies against the live `vitest list`, the deterministic plan is reproducible, the selected files run through the watchdog, and the merge emits one receipt with the exclusion evidence and the required counts and timings. The CI caller and the artifact upload are wired to the same workflow.

What it does not prove: a full 521-file sharded run on CI, the ten-shard timing, the 10x target, or that branch protection makes the job a required check. Those need a green GitHub run and the recorded artifact.

## A fresh clone

On 2026-10-20 a clean clone at `b866b826` was put through the documented path (in `/home/jadorais/fresh-floor`): `npm ci` in both trees, `npm run bootstrap:hooks`, `chmod 600 engine/bridlewise.config.json`, `make -C engine/guardian all`, `npm --prefix engine run build:bundle`, and `npm run corpus:fetch`.

| Step | Result |
|---|---|
| `npm run corpus:fetch`, `npm run corpus:verify` | reused the verified cache (digest `58b5aeb696ea`, 2.8 MB) and linked the root; verify green |
| `npm run verify:public` | exit 0: five typecheck configurations, secret scan clean, public smoke `28/28` |
| Focused corpus probe | 81 engine tests and 12 Vitest tests, 0 failed |
| Supported 521-file suite | **521/521 files, 8720 passed, 2 expected failures, 0 failed** (132.4 s wall, 1054.3 s CPU) |
| Judged budgets | `cpu-per-test-file` red at 2023.6 ms/file against a 1988.2 ms/file cap; `performance-report` unjudgeable because a fresh clone has no profile (`npm run perf:profile` is its named prerequisite) |

The clone found three defects the working tree could not, because that tree had already been set up:

1. `npm run corpus:fetch` refused a cache it had itself verified: it judged the declared root (`engine/large-codebases`), which a fresh clone has not linked, instead of the cache it would reuse. Fixed at `0e45bf58`; the fetch arm now removes the upstream before its second call, so only reuse can answer.
2. Ten supported files (55 tests) failed until two builds ran. The Landlock guardian was never built, so every confined git read refused; the engine bundle did not exist, so the self-protection guard failed its own premise. Both are setup steps now (`5522cc3d`), and the ten files pass 205 tests with them.
3. One documentation line named `engine/dist/bundle.js` — a gitignored path a briefing document may not spell — and the doc guard said so; the line now names the artifact by role (`b866b826`).

What this proves: a clean clone with the documented commands runs the public gate, the corpus-backed tests, and the whole supported suite without guessing which tests are silently missing.

What it does not prove: the four excluded suites (two private-only guards, the performance regression gate, the WSL keep-out arm), an idle-host CPU verdict, or a 10x shard claim.

## Corpus boundary

The 4.1 GB `engine/large-codebases` fixture root is not published. It is an assembled cache of dozens of public upstream checkouts. The cache carries mixed licenses, duplicate trees, nested Git histories, and test-only key, certificate, and environment fixtures. Publishing the cache as another public repository would redistribute third-party code under incompatible terms and would preserve historical material that a current-tree scan does not clear. The floor does not do that. The [third-party notices](https://github.com/LLM-4-People/bridlewise-testing/blob/main/THIRD_PARTY_NOTICES.md) record the boundary.

To reproduce a corpus-backed test without publishing the cache, fetch the pinned subset. `engine/test/fixtures/corpus-manifest.json` names the three members the public tests read (lodash, express, babel/traverse), their upstream commits, licences, and the size and sha256 of every file. The fetch materialises only those files outside the checkout and links the result at `engine/large-codebases`:

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
