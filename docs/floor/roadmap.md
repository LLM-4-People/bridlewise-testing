---
layout: default
floor_assets: true
page_class: floor
title: "Roadmap: build the floor"
description: "A milestone roadmap for the Bridlewise development floor: reproducible tests, sharded qualification, admission evidence, hardening, and contribution paths."
permalink: /floor/roadmap/
---

# Roadmap: build the floor

This is the engineering roadmap for the Bridlewise development floor. It is a statement of intent with exit criteria, not a release schedule. There are no dates and no promise that a milestone closes on a particular version.

<div class="callout-warning" role="note">
<p>Bridlewise is an experimental developer preview. It is not production-ready and it is not safe for sensitive, proprietary, regulated, or production code. A roadmap item is not a security review, a support commitment, or permission to use the preview on code you cannot lose.</p>
</div>

## Snapshot

| Dimension | Current state |
|---|---|
| Latest prerelease | `v0.0.3-preview`, published through the promotion gate with a receipt and checksums |
| Public gate | Green on both repositories at the recorded commits |
| Public smoke suites | Product `11/11`, testing `28/28` |
| Full suite | **Not reproducible from a fresh clone.** At the 2026-10-20 audit the public snapshot had 31 failing tests across 14 files. The external corpus and performance report are not published |
| Full-suite time | The 521-file web suite takes roughly 170 to 200s on a 12-core host, already at about 94% of that host's physical floor |
| Readiness | Pre-admission. `preflight` reports `harnessReady: false` |
| Security review | None |
| Contribution path | Documented in [How to help]({{ '/floor/help/' | relative_url }}) and [CONTRIBUTING.md](https://github.com/LLM-4-People/bridlewise-testing/blob/main/CONTRIBUTING.md) |

The snapshot is dated by the [status page]({{ '/floor/status/' | relative_url }}) and the [atlas]({{ '/floor/atlas/' | relative_url }}). This page names the direction; those pages carry the generated evidence.

## How to read a milestone

Each milestone has four parts:

- **Problem:** the gap that makes the next claim unsafe.
- **Workstreams:** the owned mechanisms that close it.
- **Exit criteria:** observable statements that can be reproduced.
- **Help wanted:** the lanes where a contribution moves the milestone.

A milestone is not "done" because a page says so. It is done when the exit criteria are reproducible from the public tree or a documented external prerequisite.

---

## M0 · Public floor online

**State: Done.**

**Problem:** the project needed a public, inspectable development surface without pretending the private corpus, full test floor, or internal evidence could be published as a product.

**What exists:**

- Two public repositories under AGPL-3.0-only with separate roles.
- A product Pages site and a testing Pages site with a contributor hub, floor console, atlas, evidence, and promotion pages.
- A public gate in both repositories: typecheck, secret scan, public smoke tests, builds, and guardian checks.
- Failure reporting that opens one issue per workflow and branch or pull request, comments on repeats, and closes on success.
- A promotion gate that reads runs at the exact commit, waits for in-flight checks, and emits a receipt.
- `v0.0.3-preview`, published through the gate with checksums and attestations.

**Evidence:** [Floor status]({{ '/floor/status/' | relative_url }}) · [Evidence commands]({{ '/floor/evidence/' | relative_url }}) · [Promotion contract]({{ '/floor/promotion/' | relative_url }}) · [Release](https://github.com/LLM-4-People/bridlewise/releases/tag/v0.0.3-preview)

---

## M1 · Reproducible, sharded floor

**State: Active.**

**Problem:** the full suite is not reproducible from a fresh clone, and its wall-clock time does not fit a useful feedback loop. The 4.1 GB corpus and the performance report are external; the 521-file web suite is already at the physical floor of one 12-core host. The supported public set is now explicit, but the 10x test-phase target has not been measured on a larger runner class.

**Workstreams:**

1. **Shard the full suite.** `tests/test-shards.json` is the supported set, derived from `vitest list --filesOnly --json` and accounting for every live file. `scripts/test-shard-manifest.mjs` verifies drift, assigns deterministic weighted shards, and wraps every report with its head commit and manifest hash. A matrix of runners runs disjoint shards.
2. **One qualification receipt.** Each shard records its tree, file manifest, results, and timing. The merge job writes one receipt with the shard count, the exact commit, the manifest and assignment hashes, and the measured test-phase wall clock. It refuses missing, duplicate, failed, skipped, unexpected, or wrong-commit shards.
3. **Reproducible fixtures.** Publish a pinned corpus manifest and fetch script, or a small sanitized permissive subset. Do not publish the raw cache with mixed licenses, nested histories, duplicate checkouts, and credential-shaped fixtures.
4. **Reproducible performance report.** Make `npm run perf:profile` a documented prerequisite step with an idle-host contract, and judge the report in the suite instead of relying on a stale artifact. The performance regression gate is a named exclusion until the report and the budget contract are reproducible.
5. **Repair the baseline reds.** Restore or explicitly exclude missing public fixtures, fix the public-snapshot guards that disagree with the public test layout, and split any file that exceeds the per-file share budget. The rewind suite is now four behavior files, each with a fresh harness. The merged gate must not hide a red shard.

The manual workflow is `.github/workflows/test-shards.yml`; it is not a push trigger and not a required check. The ten-shard default on standard runners is a reproducibility path, not a claim of 10x. The workflow accepts a runner label so the measured 10x target can be attempted on a documented larger class.

**Exit criteria:**

- A `workflow_dispatch` full-suite workflow runs the supported file set on shards and merges the results.
- The merge refuses a missing shard, a duplicate file, a skipped file, a failed result, a dirty tree, or a shard from another commit.
- One receipt records the exact commit, shard count, runner class, total test-phase time, and any unsupported suite with its named prerequisite.
- The full-suite test phase is at least 10x faster than the single-runner baseline on the documented runner class. The receipt records the measured factor. A single host is not claimed to be 10x faster, because it cannot be.
- A fresh clone with the documented fetch step can run the supported suite without guessing which tests are silently missing.

**Help wanted:**

- Build the shard manifest and merge verifier.
- Add a node:test shard runner that preserves the inventory contract.
- Write the corpus manifest and fetch script, with license and security boundaries.
- Repair one baseline red with a regression that fails before and passes after.
- Split a slow test file without changing what it proves.

---

## M2 · Admission evidence

**State: Next.**

**Problem:** readiness is still described by a single boolean that is `false`. A boolean cannot say which capability is admitted, what evidence supports it, or what remedy remains.

**Workstreams:**

- Per-capability readiness receipts with the gate decision, the evidence path, and the remedy.
- Close the remaining pre-admission gates for model invocation, repository mutation, process execution, and network egress.
- Publish the method and limits of the safety and privacy controls, including the detectors, redaction, and Landlock boundary.
- Add release provenance: versioned metadata, checksums, attestations, and a verification path. Signing follows a reproducible build, not the other way around.
- Commission or clearly state the absence of an independent security review.

**Exit criteria:**

- `preflight` names each capability and its state, with evidence and a remedy for anything denied.
- No capability is described as admitted without a reproducible receipt.
- A release can be verified from published assets and instructions.
- The project states exactly what has and has not been reviewed, without implying that CI is an audit.

**Help wanted:** readiness receipt design, evidence indexing, release verification, threat-model review, and tests for refusal paths.

---

## M3 · Product hardening

**State: Next.**

**Problem:** the preview has real machinery but no supported backup, limited provider coverage, Linux-only confinement, and no published performance envelope.

**Workstreams:**

- Backup and restore for the database and key home, with verification.
- Provider conformance fixtures for the Responses path and a second provider shape, plus clearer setup failures.
- Cross-platform path handling, with an explicit refusal when Landlock is unavailable.
- A measured scale and performance envelope for large repositories and concurrent runs.
- Accessibility and responsive behavior as tested contracts, not visual claims.
- A stable extension surface with compatibility notes.

**Exit criteria:**

- Each capability has a documented failure path and a regression.
- Backup and restore are one documented flow with a verification step.
- Platform limits are stated before installation.
- Performance claims link to a method and a report.

**Help wanted:** backup/restore, provider adapters, platform probes, benchmark design, and accessibility tests.

---

## M4 · Sustainable contribution

**State: Active.**

**Problem:** the floor is inspectable, but a new contributor still needs a guided path from clone to a reviewed change. The roadmap and the contribution lanes must be visible without reading internal history.

**Workstreams:**

- A contributor hub that is distinct from the product home.
- Issue lanes with evidence requirements and a named next action.
- A first-patch path for docs, tests, guards, benchmarks, and portability.
- Review expectations that reward reproduction and prevention, not just a green run.
- A roadmap that records state and exit criteria instead of a wish list.

**Exit criteria:**

- A new contributor can install, run the public gate, pick a labeled issue, and open a reviewable change using only public instructions.
- Every open issue states what evidence is missing or what decision is needed.
- The roadmap and the issue labels agree about the current milestone.
- A documentation example is verified against the command output before it ships.

**Help wanted:** onboarding tests, issue triage, docs examples, review guides, and translations of the evidence into plain language.

---

## Now, next, later

| Horizon | Work | Milestone |
|---|---|---|
| Now | Shard the full suite and merge the receipt | M1 |
| Now | Publish the corpus manifest or a sanitized subset | M1 |
| Now | Repair the public baseline reds and the slow-file budget | M1 |
| Now | Keep the contributor hub and roadmap current | M4 |
| Next | Per-capability admission receipts | M2 |
| Next | Release provenance and verification | M2 |
| Next | Backup and restore | M3 |
| Later | Provider and MCP coverage | M3 |
| Later | Scale and performance envelope | M3 |
| Later | Stable extension surface | M3 |

"Now" means the next engineering focus, not a delivery date.

## Not planned

- Publishing the raw 4.1 GB corpus as a repository.
- A hosted multi-tenant service in the preview.
- A production-readiness claim before the admission evidence exists.
- Skipping or hiding a failing test to make a badge green.
- A benchmark number without its method.
- A universal provider compatibility claim.
- A release date.

## How this roadmap changes

A milestone or exit criterion changes through a focused pull request or a decision record, with the evidence that made the old statement wrong. The [decision records]({{ '/decisions/' | relative_url }}) hold the durable reasoning. The [status page]({{ '/floor/status/' | relative_url }}) holds the generated snapshot. This page holds the direction.

If an item is blocked, say so. A visible block is better than a quiet omission.
