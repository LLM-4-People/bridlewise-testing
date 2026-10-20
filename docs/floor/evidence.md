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

> [!WARNING]
> Bridlewise is an experimental developer preview. A passing command is evidence about the surface it exercised, not a production guarantee. Do not run the preview against sensitive or production code.

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
ℹ tests 18
ℹ pass 18
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
{"conservation":{"canonicalCount":510,"excludedCount":9,"gitRecognizableCount":527,"kind":"verified","nonCanonicalCount":8},"generatorRevision":"test-inventory-generator/v4","inventoryHash":"<sha256>","sourceSetHash":"<sha256>","status":"current","testCount":10491,"transactionPresent":false}
```

The claim is `"status":"current"`. It means the generated inventory and the disposition manifest match the tracked test surface this checkout sees. Counts move when tests are added or removed.

What this proves: the inventory is not hand-edited drift, and every recognized test surface entry has a disposition.

What it does not prove: that any test passed, that the count is coverage, or that the private corpus is present. `engine/large-codebases` is not published.

## Corpus boundary

The 4.1 GB `engine/large-codebases` fixture root is not published. It is an assembled cache of dozens of public upstream checkouts. The cache carries mixed licenses, duplicate trees, nested Git histories, and test-only key, certificate, and environment fixtures. Publishing the cache as another public repository would redistribute third-party code under incompatible terms and would preserve historical material that a current-tree scan does not clear. The floor does not do that. The [third-party notices](https://github.com/LLM-4-People/bridlewise-testing/blob/main/THIRD_PARTY_NOTICES.md) record the boundary.

To reproduce a corpus-backed test, supply the root from upstream at the revisions you record. Most of the cache is not read by the default suite, and the cache alone is not enough for the full suite. The performance report, Chromium, systemd, OpenSSL, Landlock, and the live provider consent remain separate prerequisites.

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
- **The public smoke suite is not the floor.** The full suite needs the corpus, the performance report, Chromium, systemd, OpenSSL, and Landlock.
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
