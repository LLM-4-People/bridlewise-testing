---
layout: default
page_class: article
title: "Roadmap: build the floor"
description: "A milestone roadmap for the Bridlewise development floor: what shipped, what is in progress, what is planned but not done, and the evidence behind each status."
permalink: /floor/roadmap/
---

# Roadmap: build the floor

This is the engineering roadmap for the Bridlewise development floor: what shipped, what is in progress, what is planned but not done, and the evidence behind each claim. It is a statement of intent with exit criteria, not a release schedule and not a promise that a milestone closes on a particular version. The status blocks are generated from their owners; the prose is hand-written.

<div class="callout-warning" role="note">
<p>Bridlewise is an experimental developer preview. It is not production-ready and it is not safe for sensitive, proprietary, regulated, or production code. A roadmap item is not a security review, a support commitment, or permission to use the preview on code you cannot lose.</p>
</div>

## At a glance

<!-- BEGIN GENERATED: roadmap summary, from the tracker items and the decision records (npm run docs:roadmap; scripts/floor/roadmap-status.ts) -->
### Where the floor stands

**24 of 56 tracked items shipped (43%).** The tracked total covers the roadmap's workstreams and exit criteria and every open tracker item. 7 not-planned statements sit outside it. Every state below is computed from the items' evidence, never typed.

24 shipped · 4 in progress · 27 planned · 1 blocked · 7 not planned.

### Milestones

A milestone's state is computed from its members: shipped when every planned member shipped, in progress when any landed. Shipped and open count the workstreams and exit criteria assigned to it.

| Milestone | Focus | State | Shipped | Open |
|---|---|---|---|---|
| [M0](#m0--public-floor-online) | Public floor online | shipped | 6 | 0 |
| [M1](#m1--reproducible-sharded-floor) | Reproducible, sharded floor | in progress | 9 | 3 |
| [M2](#m2--admission-evidence) | Admission evidence | in progress | 3 | 6 |
| [M3](#m3--product-hardening) | Product hardening | in progress | 2 | 9 |
| [M4](#m4--sustainable-contribution) | Sustainable contribution | in progress | 4 | 5 |

### Now / next / later

Every open workstream or exit criterion that names a horizon, ordered by horizon, then milestone, then rank. The plan below carries every item.

| Horizon | Work | Milestone | State | Owner | Evidence |
|---|---|---|---|---|---|
| now | **[Reproducible performance report](../trackers/items/M1-PERF.md)** | [M1](#m1--reproducible-sharded-floor) | in progress (PERF-REPORT-REPRODUCIBLE shipped) | performance | [evidence: performance-probe](evidence.md#performance-probe) |
| now | **[10x test-phase factor on a documented runner class](../trackers/items/M1-X5.md)** | [M1](#m1--reproducible-sharded-floor) | planned | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| now | **[A node:test shard runner that preserves the inventory contract](../trackers/items/M1-NODETEST.md)** | [M1](#m1--reproducible-sharded-floor) | planned | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| next | **[Per-capability readiness receipts](../trackers/items/M2-RECEIPTS.md)** | [M2](#m2--admission-evidence) | in progress (PREFLIGHT-ADMISSION-RECEIPTS shipped) | engine governance | [TASKS](../trackers/TASKS.md) |
| next | **[Close the remaining pre-admission gates](../trackers/items/M2-GATES.md)** | [M2](#m2--admission-evidence) | planned | engine governance | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| next | **[Release provenance and verification](../trackers/items/M2-PROVENANCE.md)** | [M2](#m2--admission-evidence) | in progress (RELEASE-V0-0-3-EVIDENCE shipped) | release | [evidence: product-preview-release](evidence.md#product-preview-release) |
| later | **[Publish the method and limits of the safety and privacy controls](../trackers/items/M2-CONTROLS.md)** | [M2](#m2--admission-evidence) | planned | engine safety | [evidence: guardian](evidence.md#guardian) |
| later | **[Independent security review](../trackers/items/M2-REVIEW.md)** | [M2](#m2--admission-evidence) | planned | maintainers | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| later | **[Provider conformance fixtures and clearer setup failures](../trackers/items/M3-PROVIDERS.md)** | [M3](#m3--product-hardening) | in progress (PROVIDER-CONFORMANCE-SECOND-FIXTURE shipped) | engine providers | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| later | **[MCP coverage](../trackers/items/M3-MCP.md)** | [M3](#m3--product-hardening) | planned | engine MCP | [extending](../extending.md) |
| later | **[Cross-platform path handling with an explicit Landlock refusal](../trackers/items/M3-PLATFORM.md)** | [M3](#m3--product-hardening) | planned | engine platform | [evidence: guardian](evidence.md#guardian) |
| later | **[Measured scale and performance envelope](../trackers/items/M3-SCALE.md)** | [M3](#m3--product-hardening) | planned | performance | [evidence: performance-probe](evidence.md#performance-probe) |
| later | **[Accessibility and responsive behavior as tested contracts](../trackers/items/M3-A11Y.md)** | [M3](#m3--product-hardening) | planned | web | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| later | **[A stable extension surface with compatibility notes](../trackers/items/M3-EXTENSION.md)** | [M3](#m3--product-hardening) | planned | engine extension | [extending](../extending.md) |
| later | **[Issue lanes with evidence requirements and a named next action](../trackers/items/M4-ISSUES.md)** | [M4](#m4--sustainable-contribution) | planned | maintainers | [GitHub](https://github.com/LLM-4-People/bridlewise-testing/issues) |

<!-- END GENERATED: roadmap summary -->

## Status legend

| State | Meaning |
|---|---|
| shipped | The mechanism exists, and its evidence resolves in the public tree or a documented external record. |
| in progress | Work has started; the exit criterion is not met. |
| planned | Named, owned, and not started. |
| blocked | Named and owned, but it cannot proceed until the named condition changes. |
| not planned | A deliberate non-goal, kept here with its reason. |

A milestone's state is its focus state, not a roll-up of the item states. An item's state is the row's own. A status is not a review, a support commitment, or permission to run the preview on code you cannot lose.

## Snapshot

This is the dated public-baseline audit. It is a point-in-time record, not a live roll-up of the tables on this page; the status page and the atlas carry the generated, dated evidence.

| Dimension | Current state |
|---|---|
| Latest prerelease | `v0.0.3-preview`, published through the promotion gate with a receipt and checksums |
| Public gate | Green on both repositories at the recorded commits |
| Public smoke suites | Product `11/11`, testing `34/34` (the generated blocks and the tracker are the state of record; this row is a dated audit) |
| Full suite | **Supported set green, complete tree still gated.** At the 2026-10-20 audit the 521-file supported set passed 8722 tests with 0 skipped, and a clean clone at `b866b826` reproduced it with the documented setup (8720 passed, 2 expected, 0 failed). Four named exclusions remain: two private-only guards, the performance regression gate, and the WSL-host keep-out arm. The raw corpus and the performance report are not published; the pinned subset is fetched with `npm run corpus:fetch`. The supported set has since grown to 523 files and 8734 tests (receipt `39471843640`); the status page carries the current dated numbers |
| Full-suite time | The 10-shard `ubuntu-24.04` receipt at `d47909de` measured `testPhaseMs` 86.7s and `testPhaseCpuMs` 636.8s: 2.81x the 244.0s single-host supported run. The 10x line is not met on this runner class. This row records that audit; later receipts, including the re-measured shard weights, are on the status page |
| Readiness | Pre-admission. `preflight` reports `harnessReady: false` |
| Security review | None |
| Contribution path | Documented in [How to help]({{ '/floor/help/' | relative_url }}) and [CONTRIBUTING.md](../../CONTRIBUTING.md) |

The snapshot is dated by the [status page]({{ '/floor/status/' | relative_url }}) and the [atlas]({{ '/floor/atlas/' | relative_url }}). This page names the direction; those pages carry the generated evidence.

## How to read a milestone

Each milestone below names the problem and the contribution lane. Its workstreams and exit criteria are not typed into the milestone prose: they are rendered under [Workstreams and exit criteria](#workstreams-and-exit-criteria) from the page's machine-readable plan block. That keeps a state in one place.

A milestone is not "done" because a page says so. It is done when the exit criteria are reproducible from the public tree or a documented external prerequisite. The `Source` column on each generated row names the statement it was carried from, so a plan that was implicit in the old prose remains attributable.

---

## M0 · Public floor online

**Problem:** the project needed a public, inspectable development surface without pretending the private corpus, full test floor, or internal evidence could be published as a product.

**What exists:**

- Two public repositories under AGPL-3.0-only with separate roles.
- A product Pages site and a testing Pages site with a contributor hub, floor console, atlas, evidence, and promotion pages.
- A public gate in both repositories: typecheck, secret scan, public smoke tests, builds, and guardian checks.
- Failure reporting that opens one issue per workflow and branch or pull request, comments on repeats, and closes on success.
- A promotion gate that reads runs at the exact commit, waits for in-flight checks, and emits a receipt.
- `v0.0.3-preview`, published through the gate with checksums and attestations.

**Evidence:** [Floor status]({{ '/floor/status/' | relative_url }}) · [Evidence commands]({{ '/floor/evidence/' | relative_url }}) · [Promotion contract]({{ '/floor/promotion/' | relative_url }}) · [Release]({{ site.repository_url }}/releases/tag/v0.0.3-preview)

---

## M1 · Reproducible, sharded floor

**Problem:** the full suite is not reproducible from a fresh clone, and its wall-clock time does not fit a useful feedback loop. The 4.1 GB corpus and the performance report are external; the supported web suite is already at the physical floor of one 12-core host. The supported public set is now explicit, but the 10x test-phase target has not been measured on a larger runner class.

**How the gate works.** The shard gate is `.github/workflows/test-shards.yml`, called as the `shards` job from `.github/workflows/ci.yml` on every push and pull request to `main`, and still dispatchable on its own. The merge job fails the run when a shard fails or when the union of the shard reports does not equal the manifest exactly once, and it uploads `test-shard-receipt` as the receipt artifact. The ten-shard default on standard runners is a reproducibility path, not a claim of 10x. The workflow accepts a runner label so the measured 10x target can be attempted on a documented larger class. Making the job a required check is a branch-protection setting, not a workflow property.

**Help wanted:** measure the 10x test-phase target on a documented larger runner class; run an idle-host campaign that makes the CPU-per-file budget judgeable; add a same-commit single-host comparison to the receipt; split a slow test file without changing what it proves.

---

## M2 · Admission evidence

**Problem:** readiness is still described by a single boolean that is `false`. A boolean cannot say which capability is admitted, what evidence supports it, or what remedy remains.

The receipt shape for each capability is recorded in the task board; the admission gates themselves are open. The plan rows below separate the receipt shape from the gates so a shipped receipt cannot be read as an admitted capability.

**Help wanted:** readiness receipt design, evidence indexing, release verification, threat-model review, and tests for refusal paths.

---

## M3 · Product hardening

**Problem:** the preview has a supported backup/restore flow for the database and its key material, but limited provider coverage, Linux-only confinement, and no published performance envelope.

**What shipped.** `npm run db-backup -- backup|restore` writes a new folder holding a verified database copy, the key material (or passphrase salt) that opens it, and a digest/row-count manifest; it proves the copy opens under that material, and a restore holds the database alone, keeps a verified `<db>.pre-restore` copy, and proves the restored database opens before calling it done. The flow, its refusals and its limits (the timeline ledger and the pre-migration/pre-rekey copies are not in the bundle) are documented in [the CLI reference](../cli.md#db-backupts).

**Help wanted:** provider adapters, platform probes, benchmark design, and accessibility tests.

---

## M4 · Sustainable contribution

**Problem:** the floor is inspectable, but a new contributor still needs a guided path from clone to a reviewed change. The roadmap and the contribution lanes must be visible without reading internal history.

**Help wanted:** onboarding tests, issue triage, docs examples, review guides, and translations of the evidence into plain language.

---

## Workstreams and exit criteria

The owner of this section is the tracker: every milestone, workstream, exit criterion and not-planned statement is one item file in `docs/trackers/items/` (each title below links to its record; the [task board](../trackers/TASKS.md) lists them all), and every state is computed from the items' evidence — closed or open, what an item is blocked by, its sub-items, the decision records it carries out — never typed. Change an item, not a table; `npm run docs:roadmap` rewrites the generated blocks. Each record says where it was carried from, so a plan that was only implicit in prose is still attributable.

<!-- BEGIN GENERATED: roadmap workstreams and exit criteria, from the tracker items (npm run docs:roadmap; scripts/floor/roadmap-status.ts) -->
### Milestone plan

Each milestone group names its workstreams and exit criteria with the owner, the computed state, the exit criterion and the evidence. Each title links to its record, which carries where it was carried from, its links and its history.

#### M0 · Public floor online — shipped (6 shipped · 0 open)

**Workstreams**

| Workstream | State | Owner | Evidence |
|---|---|---|---|
| **[Public floor, public gate and preview release](../trackers/items/M0-FLOOR.md)**<br>Exit: Both repositories, the Pages sites, the public gate, failure reporting, the promotion gate and v0.0.3-preview are live. | shipped | maintainers | [this page: snapshot](#snapshot) |
| **[Build the floor from a clean machine](../trackers/items/M0-FLOOR-BUILD.md)**<br>Exit: A clean clone reaches the public gate, the pinned corpus probe, and the supported suite through the documented commands; the sharded gate and receipt (M1), corpus boundary (M1), contributor hub (M4), and remaining known gaps (M2-X4) are composed here rather than restated. | shipped | floor tooling | [evidence: a-fresh-clone](evidence.md#a-fresh-clone) |

**Exit criteria**

| Exit criterion | State | Owner | Evidence |
|---|---|---|---|
| **[The clean-machine setup names every build before the suite](../trackers/items/M0-B1.md)**<br>Exit: The setup sequence names the guardian build and engine bundle before the supported suite, and docs/testing.md names each refusal rather than calling it a skip. | shipped | floor tooling | [evidence: a-fresh-clone](evidence.md#a-fresh-clone) |
| **[Docs and briefings resolve only to tracked paths](../trackers/items/M0-B2.md)**<br>Exit: The docs link check resolves every tracked repository-relative Markdown link, and the briefing liveness guard refuses a linked path or backticked repo path that git does not hold. | shipped | docs | [evidence: docs-links](evidence.md#docs-links) |
| **[Tracked modes and the self-protection config keep their contract](../trackers/items/M0-B3.md)**<br>Exit: A tracked file recorded as 100644 stays 0644 in the working tree; a new atomic write takes 0600 only when it creates the file; and engine/bridlewise.config.json is 0600 in the checkout and CI. | shipped | floor tooling | [TASKS: done](../trackers/TASKS.md#done) |
| **[Every gate carries a replayable evidence record](../trackers/items/M0-B4.md)**<br>Exit: The evidence page's gates name a command and an expected shape, and the record-your-own-check form gives a reviewer the claim, commit, command, observation, and interpretation fields. | shipped | docs | [evidence: record-your-own-check](evidence.md#record-your-own-check) |

#### M1 · Reproducible, sharded floor — in progress (9 shipped · 3 open)

**Workstreams**

| Workstream | State | Owner | Evidence |
|---|---|---|---|
| **[Shard the full suite](../trackers/items/M1-SHARD.md)**<br>Exit: The manifest verifies against the live suite, the plan is deterministic, and a matrix of runners executes disjoint shards. | shipped | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| **[One qualification receipt](../trackers/items/M1-RECEIPT.md)**<br>Exit: The merge refuses a missing, duplicate, failed, skipped, dirty or wrong-commit shard and uploads one receipt with the counts, timings and exclusion anchors. | shipped | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| **[Reproducible fixtures](../trackers/items/M1-CORPUS.md)**<br>Exit: The pinned corpus subset is fetched and verified outside the checkout; the raw cache stays unpublished. | shipped | engine fixtures | [evidence: corpus-boundary](evidence.md#corpus-boundary) |
| **[Reproducible performance report](../trackers/items/M1-PERF.md)**<br>Exit: A profile at the judged head is generated by npm run perf:profile under the idle-host contract and judged by the regression gate. | in progress (PERF-REPORT-REPRODUCIBLE shipped) | performance | [evidence: performance-probe](evidence.md#performance-probe) |
| **[Repair the baseline reds](../trackers/items/M1-REDS.md)**<br>Exit: The supported file set runs without a failing or skipped test, and every exclusion is named with evidence. | shipped | floor tooling | [evidence: the-supported-suite-on-one-host](evidence.md#the-supported-suite-on-one-host) |
| **[A node:test shard runner that preserves the inventory contract](../trackers/items/M1-NODETEST.md)**<br>Exit: The public node:test smoke files run inside the same shard and receipt contract as the supported Vitest set, without leaving the inventory. | planned | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |

**Exit criteria**

| Exit criterion | State | Owner | Evidence |
|---|---|---|---|
| **[CI calls the shard workflow](../trackers/items/M1-X1.md)**<br>Exit: A push and pull-request CI job calls the shard workflow; dispatch remains available. | shipped | CI | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| **[The merge refuses a bad shard set](../trackers/items/M1-X2.md)**<br>Exit: The merge refuses a missing shard, a duplicate file, a skipped file, a failed result, a dirty tree, or a shard from another commit. | shipped | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| **[The merge uploads one receipt](../trackers/items/M1-X3.md)**<br>Exit: The merge uploads one receipt naming the manifest digest, shard indexes and timings, pass/fail counts, and the excluded files with their evidence anchors. | shipped | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| **[The receipt names commit, class, time and prerequisites](../trackers/items/M1-X4.md)**<br>Exit: One receipt records the exact commit, shard count, runner class, total test-phase time, and any unsupported suite with its named prerequisite. | shipped | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| **[10x test-phase factor on a documented runner class](../trackers/items/M1-X5.md)**<br>Exit: The full-suite test phase is at least 10x faster than the single-runner baseline on the documented runner class, and the receipt records the measured factor. | planned | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| **[A fresh clone runs the supported suite](../trackers/items/M1-X6.md)**<br>Exit: A fresh clone with the documented setup runs the supported suite without guessing which tests are silently missing. | shipped | floor tooling | [evidence: a-fresh-clone](evidence.md#a-fresh-clone) |

#### M2 · Admission evidence — in progress (3 shipped · 6 open)

**Workstreams**

| Workstream | State | Owner | Evidence |
|---|---|---|---|
| **[Per-capability readiness receipts](../trackers/items/M2-RECEIPTS.md)**<br>Exit: Every capability names its gate decision, the policy fact that decided it, and a remedy when denied. | in progress (PREFLIGHT-ADMISSION-RECEIPTS shipped) | engine governance | [TASKS](../trackers/TASKS.md) |
| **[Close the remaining pre-admission gates](../trackers/items/M2-GATES.md)**<br>Exit: Model invocation, repository mutation, process execution and network egress each have an admission decision or a named refusal. | planned | engine governance | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| **[Publish the method and limits of the safety and privacy controls](../trackers/items/M2-CONTROLS.md)**<br>Exit: The detectors, redaction and Landlock boundary are documented with their limits. | planned | engine safety | [evidence: guardian](evidence.md#guardian) |
| **[Release provenance and verification](../trackers/items/M2-PROVENANCE.md)**<br>Exit: Versioned metadata, checksums, attestations and a verification path ship; signing follows a reproducible build. | in progress (RELEASE-V0-0-3-EVIDENCE shipped) | release | [evidence: product-preview-release](evidence.md#product-preview-release) |
| **[Independent security review](../trackers/items/M2-REVIEW.md)**<br>Exit: An independent review is commissioned, or its absence is stated without implying that CI is an audit. | planned | maintainers | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |

**Exit criteria**

| Exit criterion | State | Owner | Evidence |
|---|---|---|---|
| **[preflight names each capability](../trackers/items/M2-X1.md)**<br>Exit: preflight names each capability and its state, with evidence and a remedy for anything denied. | shipped | engine governance | [TASKS](../trackers/TASKS.md) |
| **[No admitted capability without a receipt](../trackers/items/M2-X2.md)**<br>Exit: No capability is described as admitted without a reproducible receipt. | planned | engine governance | [TASKS](../trackers/TASKS.md) |
| **[A release is verifiable from published assets](../trackers/items/M2-X3.md)**<br>Exit: A release can be verified from published assets and instructions. | shipped | release | [evidence: product-preview-release](evidence.md#product-preview-release) |
| **[The review boundary is stated without an audit claim](../trackers/items/M2-X4.md)**<br>Exit: The project states exactly what has and has not been reviewed, without implying that CI is an audit. | shipped | maintainers | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |

#### M3 · Product hardening — in progress (2 shipped · 9 open)

**Workstreams**

| Workstream | State | Owner | Evidence |
|---|---|---|---|
| **[Backup and restore for the database and key home, with verification](../trackers/items/M3-BACKUP.md)**<br>Exit: One documented flow backs up and restores the database with its key material and proves each copy opens. | shipped | server database | [cli: db-backupts](../cli.md#db-backupts) |
| **[Provider conformance fixtures and clearer setup failures](../trackers/items/M3-PROVIDERS.md)**<br>Exit: The Responses path and a second provider shape are proved offline, with typed setup failures. | in progress (PROVIDER-CONFORMANCE-SECOND-FIXTURE shipped) | engine providers | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| **[MCP coverage](../trackers/items/M3-MCP.md)**<br>Exit: The MCP transports and server lifecycle have conformance coverage and named prerequisites. | planned | engine MCP | [extending](../extending.md) |
| **[Cross-platform path handling with an explicit Landlock refusal](../trackers/items/M3-PLATFORM.md)**<br>Exit: Platform limits are stated before installation, and unsupported confinement refuses explicitly. | planned | engine platform | [evidence: guardian](evidence.md#guardian) |
| **[Measured scale and performance envelope](../trackers/items/M3-SCALE.md)**<br>Exit: Large repositories and concurrent runs have a measured envelope, and red budgets are tracked rather than called a pass. | planned | performance | [evidence: performance-probe](evidence.md#performance-probe) |
| **[Accessibility and responsive behavior as tested contracts](../trackers/items/M3-A11Y.md)**<br>Exit: Accessibility and responsive behavior have tested contracts, not visual claims. | planned | web | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| **[A stable extension surface with compatibility notes](../trackers/items/M3-EXTENSION.md)**<br>Exit: Extension points carry compatibility notes and a tested failure path. | planned | engine extension | [extending](../extending.md) |

**Exit criteria**

| Exit criterion | State | Owner | Evidence |
|---|---|---|---|
| **[Each capability has a failure path and a regression](../trackers/items/M3-X1.md)**<br>Exit: Each capability has a documented failure path and a regression. | planned | product | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| **[Backup and restore are one verified flow](../trackers/items/M3-X2.md)**<br>Exit: Backup and restore are one documented flow with a verification step. | shipped | server database | [cli: db-backupts](../cli.md#db-backupts) |
| **[Platform limits are stated before installation](../trackers/items/M3-X3.md)**<br>Exit: Platform limits are stated before installation. | planned | engine platform | [evidence: guardian](evidence.md#guardian) |
| **[Performance claims link to a method and a report](../trackers/items/M3-X4.md)**<br>Exit: Performance claims link to a method and a report. | planned | performance | [evidence: performance-probe](evidence.md#performance-probe) |

#### M4 · Sustainable contribution — in progress (4 shipped · 5 open)

**Workstreams**

| Workstream | State | Owner | Evidence |
|---|---|---|---|
| **[A contributor hub distinct from the product home](../trackers/items/M4-HUB.md)**<br>Exit: The floor has its own front door, separate from the product documentation mirror. | shipped | docs | [index](../index.md) |
| **[Issue lanes with evidence requirements and a named next action](../trackers/items/M4-ISSUES.md)**<br>Exit: Every open issue names the evidence it needs or the decision it waits on. | planned | maintainers | [GitHub](https://github.com/LLM-4-People/bridlewise-testing/issues) |
| **[A first-patch path for docs, tests, guards, benchmarks and portability](../trackers/items/M4-FIRST.md)**<br>Exit: Each contribution lane starts from a public command and a reviewable first step. | shipped | docs | [help](help.md) |
| **[Review expectations that reward reproduction and prevention](../trackers/items/M4-REVIEW.md)**<br>Exit: The review guide asks for the reproduction, the prevention guard and the evidence, not only a green run. | shipped | maintainers | [CONTRIBUTING](../../CONTRIBUTING.md) |
| **[A roadmap that records state and exit criteria instead of a wish list](../trackers/items/M4-ROADMAP.md)**<br>Exit: Every planned-but-not-done item is rendered from its owner, and a guard refuses a stale status block. | shipped | docs | [this page: workstreams-and-exit-criteria](#workstreams-and-exit-criteria) |

**Exit criteria**

| Exit criterion | State | Owner | Evidence |
|---|---|---|---|
| **[A newcomer can go from clone to a reviewable change](../trackers/items/M4-X1.md)**<br>Exit: A new contributor can install, run the public gate, pick a labeled issue, and open a reviewable change using only public instructions. | planned | docs | [evidence: a-fresh-clone](evidence.md#a-fresh-clone) |
| **[Every open issue names its missing evidence](../trackers/items/M4-X2.md)**<br>Exit: Every open issue states what evidence is missing or what decision is needed. | planned | maintainers | [GitHub](https://github.com/LLM-4-People/bridlewise-testing/issues) |
| **[The roadmap and issue labels agree](../trackers/items/M4-X3.md)**<br>Exit: The roadmap and the issue labels agree about the current milestone. | planned | maintainers | [GitHub](https://github.com/LLM-4-People/bridlewise-testing/issues) |
| **[A documented example matches its command output](../trackers/items/M4-X4.md)**<br>Exit: A documentation example is verified against the command output before it ships. | planned | docs | [evidence: docs-links](evidence.md#docs-links) |

<!-- END GENERATED: roadmap workstreams and exit criteria -->

## Open work

Everything below is rendered from its owners: the open rows of [TASKS.md](../trackers/TASKS.md), the state rules in the plan block, and the explicit non-proofs of [the evidence page](evidence.md). A TASKS.md row disappears from the task board only when that row closes; a non-proof disappears only when the evidence page stops naming it.

<!-- BEGIN GENERATED: roadmap open work, from the tracker items and docs/floor/evidence.md (npm run docs:roadmap; scripts/floor/roadmap-status.ts) -->
### Open task board

Every open tracker item outside the milestone plan appears here, by lane. An item leaves this table only when it closes.

#### Open

| Task | State | Owner | Evidence |
|---|---|---|---|
| **[Bring the supported suite under the calibrated-work cap](../trackers/items/FLOOR-SUITE-CALIBRATED-CAP.md)** | blocked (blocked by RISK-NO-CALIBRATED-JUDGED-RUN) | — | — |
| **[No clean judged run in calibrated-work/v1 yet](../trackers/items/RISK-NO-CALIBRATED-JUDGED-RUN.md)** | planned | — | [evidence: the-supported-suite-on-one-host](evidence.md#the-supported-suite-on-one-host) |

#### Flaky burn-down owners

| Task | State | Owner | Evidence |
|---|---|---|---|
| **[FLAKY-PUBLIC-ENGINE-GUARD-REDS-ON-ROUND-TREES](../trackers/items/FLAKY-PUBLIC-ENGINE-GUARD-REDS-ON-ROUND-TREES.md)** | planned | — | — |
| **[FLAKY-PUBLIC-ENGINE-UNDIAGNOSED](../trackers/items/FLAKY-PUBLIC-ENGINE-UNDIAGNOSED.md)** | planned | — | — |
| **[FLAKY-PUBLIC-ENGINE-UNLOGGED-RECORDS](../trackers/items/FLAKY-PUBLIC-ENGINE-UNLOGGED-RECORDS.md)** | planned | — | — |
| **[FLAKY-PUBLIC-S1-B12-CONTROL](../trackers/items/FLAKY-PUBLIC-S1-B12-CONTROL.md)** | planned | — | — |
| **[FLAKY-PUBLIC-WEB-GUARD-REDS-ON-ROUND-TREES](../trackers/items/FLAKY-PUBLIC-WEB-GUARD-REDS-ON-ROUND-TREES.md)** | planned | — | — |
| **[FLAKY-PUBLIC-WEB-WATCHDOG-C3](../trackers/items/FLAKY-PUBLIC-WEB-WATCHDOG-C3.md)** | planned | — | — |

#### Private web lanes (retained as ordinary work)

| Task | State | Owner | Evidence |
|---|---|---|---|
| **[FLAKY-PERF-GATE-STALE-REPORT](../trackers/items/FLAKY-PERF-GATE-STALE-REPORT.md)** | planned | — | — |

### What the evidence does not prove

The public evidence page names what its receipts do not establish. These statements are not coverage and not a pass.

| Evidence area | Not proved |
|---|---|
| Fresh clone gate | [the cockpit, the engine domain suites, the browser E2E suite, a live provider, a large repository, or the guardian. Those are separate gates.](evidence.md#fresh-clone-gate) |
| Inventory check | [that any test passed, that the count is coverage, or that the private corpus is present. The corpus root the tests read is not published.](evidence.md#inventory-check) |
| Why the unit changed | [the four excluded suites, a 10x shard claim, an idle-host CPU verdict, or a fresh-clone run.](evidence.md#why-the-unit-changed) |
| The sharded gate | [a 10x factor, a clean same-commit single-host comparison for the speedup, or that branch protection makes the job a required check. The receipt's `testPhaseMs` is one measurement on the `ubuntu-24.04` class; the 2.81x figure at `d47909de` remains a historical comparison.](evidence.md#the-sharded-gate) |
| A fresh clone | [the four excluded suites (two private-only guards, the performance regression gate, the WSL keep-out arm), an idle-host CPU verdict, or a 10x shard claim.](evidence.md#a-fresh-clone) |
| Performance probe | [This is one profile and one shard class on one audit date. It is not a cross-machine benchmark, a reproducible performance proof, or the full suite.](evidence.md#performance-probe) |
| Guardian | [that the guardian is a VM, a network firewall, a seccomp profile, or a user-namespace boundary. A pass on one kernel is not a pass on every kernel.](evidence.md#guardian) |
| Promotion state | [that a promotion is due, that the target gate passes, that the remote is reachable, or that the public branch matches the maintainer target. Use `npm run promote -- plan --diff` in a checkout with the source ref for a projected diff. Nothing there publishes.](evidence.md#promotion-state) |
| CI evidence | [that the full corpus-backed, live, or E2E suites ran. They do not run in that job.](evidence.md#ci-evidence) |
| Product preview release | [who published the list, that the build is reproducible, that the assets are signed, or that the code is correct. A checksum is not a signature.](evidence.md#product-preview-release) |
| Product preview release | [the source is correct or the build is reproducible.](evidence.md#product-preview-release) |
| Docs links | [that the rendered Pages site has no broken links, or that an untracked page is deployed.](evidence.md#docs-links) |
| What none of this proves | [**A green CI run is not correctness.** It proves the configured steps passed at one commit.](evidence.md#what-none-of-this-proves) |
| What none of this proves | [**The focused probes are not the full suite.** The full suite still needs the complete corpus, a fresh performance report, Chromium, systemd, OpenSSL, and Landlock. The probes above cover the declared corpus root, the corpus readers, the scanner bait, the profile, and the profile regression gate, not the full inventory or the live provider suite.](evidence.md#what-none-of-this-proves) |
| What none of this proves | [**A current inventory is not a passing suite.** It proves the inventory matches the tracked surface.](evidence.md#what-none-of-this-proves) |
| What none of this proves | [**Guardian passes are not a universal sandbox proof.** A skip is not a pass, and one kernel is not every kernel.](evidence.md#what-none-of-this-proves) |
| What none of this proves | [**A promotion refusal is not a failed release.** It can be the correct answer for a checkout that lacks the maintainer refs.](evidence.md#what-none-of-this-proves) |
| What none of this proves | [**Checksums and attestations are not audits.** They bind bytes and build identity, not intent or correctness.](evidence.md#what-none-of-this-proves) |
| What none of this proves | [**The docs link check is not a site crawl.** It does not see rendered Liquid links.](evidence.md#what-none-of-this-proves) |
| What none of this proves | [**There has been no security audit.** No third-party review, penetration test, or certification exists.](evidence.md#what-none-of-this-proves) |

### Not planned

Deliberate non-goals, kept here with their reason.

| Not planned | Why | Evidence |
|---|---|---|
| [Skipping or hiding a failing test to make a badge green](../trackers/items/NOT-PLANNED-HIDDEN-FAILURES.md) | A failing test is owned by a named task row, and a guard refuses a stale duplicate. | [TASKS](../trackers/TASKS.md) |
| [A hosted multi-tenant service in the preview](../trackers/items/NOT-PLANNED-HOSTED-SERVICE.md) | The preview is a single-user developer preview and carries no hosting claim. | [this page: snapshot](#snapshot) |
| [Publishing the raw 4.1 GB corpus as a repository](../trackers/items/NOT-PLANNED-RAW-CORPUS.md) | Mixed licenses, nested histories, duplicate checkouts and credential-shaped fixtures. | [evidence: corpus-boundary](evidence.md#corpus-boundary) |
| [A production-readiness claim before the admission evidence exists](../trackers/items/NOT-PLANNED-READINESS-CLAIM.md) | The admission gates are open and no capability beyond preflight is admitted. | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| [A release date](../trackers/items/NOT-PLANNED-RELEASE-DATE.md) | This roadmap is a statement of intent, not a schedule. | [this page: snapshot](#snapshot) |
| [A universal provider compatibility claim](../trackers/items/NOT-PLANNED-UNIVERSAL-PROVIDER.md) | Provider conformance is proved per shape, not universally. | [extending](../extending.md) |
| [A benchmark number without its method](../trackers/items/NOT-PLANNED-UNMETHODED-BENCHMARK.md) | Performance claims must link to a method and a report. | [evidence: performance-probe](evidence.md#performance-probe) |

<!-- END GENERATED: roadmap open work -->

## How this roadmap changes

A milestone, workstream, exit criterion, not-planned statement or task changes in its item file under `docs/trackers/items/` (the [task board](../trackers/TASKS.md) and this page are both rendered from them); a non-proof changes in [the evidence page](evidence.md). Then run `npm run docs:roadmap` to rewrite the generated blocks. `npm run docs:roadmap -- --check` is the read-only form.

The generated blocks are not hand-editable. The site build also refuses a page whose emitted classes have no rule in the shared stylesheet (`npm run design:coverage`), and a built-page assertion checks that this page's tables are tables rather than paragraphs, so a generator change that breaks rendering fails the deploy rather than the reader. A guard (`tests/prevention/roadmap-status-owner.test.ts`) fails when the page differs from the renderer's output, when an open roadmap item names no milestone, or when an item's evidence points at a missing file or anchor.

The [decision records]({{ '/decisions/' | relative_url }}) hold the durable reasoning. The [status page]({{ '/floor/status/' | relative_url }}) holds the generated snapshot. This page holds the direction and the plan. If an item is blocked, its row says so. A visible block is better than a quiet omission.
