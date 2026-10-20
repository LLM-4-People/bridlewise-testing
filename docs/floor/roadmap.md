---
layout: default
floor_assets: true
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

<!-- BEGIN GENERATED: roadmap summary, from this page's ROADMAP-PLAN block (npm run docs:roadmap; scripts/floor/roadmap-status.ts) -->
### Where the floor stands

**24 of 55 tracked items shipped (44%).** The tracked total covers workstreams, exit criteria, and open TASKS.md rows. 7 not-planned statements sit outside it.

24 shipped · 10 in progress · 20 planned · 1 blocked · 7 not planned.

### Milestones

A milestone's state is its focus state; the item states are below. Shipped and open counts cover the workstreams and exit criteria assigned to it.

| Milestone | Focus | Shipped | Open |
|---|---|---|---|
| [M0](#m0--public-floor-online) | Public floor online | 6 | 0 |
| [M1](#m1--reproducible-sharded-floor) | Reproducible, sharded floor | 9 | 3 |
| [M2](#m2--admission-evidence) | Admission evidence | 3 | 6 |
| [M3](#m3--product-hardening) | Product hardening | 2 | 9 |
| [M4](#m4--sustainable-contribution) | Sustainable contribution | 4 | 5 |

### Now / next / later

Every tracked workstream or exit criterion, ordered by horizon. The plan below carries the exit criterion and source for each row.

| Horizon | Work | Milestone | State | Owner | Evidence |
|---|---|---|---|---|---|
| now | **Reproducible performance report** | [M1](#m1--reproducible-sharded-floor) | in progress | performance | [evidence: performance-probe](evidence.md#performance-probe) |
| now | **A node:test shard runner that preserves the inventory contract** | [M1](#m1--reproducible-sharded-floor) | planned | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| now | **10x test-phase factor on a documented runner class** | [M1](#m1--reproducible-sharded-floor) | planned | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| next | **Per-capability readiness receipts** | [M2](#m2--admission-evidence) | in progress | engine governance | [TASKS](../trackers/TASKS.md) |
| next | **Close the remaining pre-admission gates** | [M2](#m2--admission-evidence) | planned | engine governance | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| next | **Release provenance and verification** | [M2](#m2--admission-evidence) | in progress | release | [evidence: product-preview-release](evidence.md#product-preview-release) |
| later | **Publish the method and limits of the safety and privacy controls** | [M2](#m2--admission-evidence) | planned | engine safety | [evidence: guardian](evidence.md#guardian) |
| later | **Independent security review** | [M2](#m2--admission-evidence) | planned | maintainers | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| later | **Provider conformance fixtures and clearer setup failures** | [M3](#m3--product-hardening) | in progress | engine providers | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| later | **MCP coverage** | [M3](#m3--product-hardening) | planned | engine MCP | [extending](../extending.md) |
| later | **Cross-platform path handling with an explicit Landlock refusal** | [M3](#m3--product-hardening) | planned | engine platform | [evidence: guardian](evidence.md#guardian) |
| later | **Measured scale and performance envelope** | [M3](#m3--product-hardening) | in progress | performance | [evidence: performance-probe](evidence.md#performance-probe) |
| later | **Accessibility and responsive behavior as tested contracts** | [M3](#m3--product-hardening) | planned | web | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| later | **A stable extension surface with compatibility notes** | [M3](#m3--product-hardening) | planned | engine extension | [extending](../extending.md) |
| later | **Issue lanes with evidence requirements and a named next action** | [M4](#m4--sustainable-contribution) | planned | maintainers | [GitHub](https://github.com/LLM-4-People/bridlewise-testing/issues) |

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
| Full suite | **Supported set green, complete tree still gated.** At the 2026-10-20 audit the 521-file supported set passed 8722 tests with 0 skipped, and a clean clone at `b866b826` reproduced it with the documented setup (8720 passed, 2 expected, 0 failed). Four named exclusions remain: two private-only guards, the performance regression gate, and the WSL-host keep-out arm. The raw corpus and the performance report are not published; the pinned subset is fetched with `npm run corpus:fetch` |
| Full-suite time | The 10-shard `ubuntu-24.04` receipt at `d47909de` measured `testPhaseMs` 86.7s and `testPhaseCpuMs` 636.8s: 2.81x the 244.0s single-host supported run. The 10x line is not met on this runner class |
| Readiness | Pre-admission. `preflight` reports `harnessReady: false` |
| Security review | None |
| Contribution path | Documented in [How to help]({{ '/floor/help/' | relative_url }}) and [CONTRIBUTING.md](https://github.com/LLM-4-People/bridlewise-testing/blob/main/CONTRIBUTING.md) |

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

**Evidence:** [Floor status]({{ '/floor/status/' | relative_url }}) · [Evidence commands]({{ '/floor/evidence/' | relative_url }}) · [Promotion contract]({{ '/floor/promotion/' | relative_url }}) · [Release](https://github.com/LLM-4-People/bridlewise/releases/tag/v0.0.3-preview)

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

The machine-readable owner of this section is the ROADMAP-PLAN block immediately below. It carries every workstream and exit criterion, the milestone focus, the not-planned list, and the state rule for each TASKS.md section. Edit that block, not a table; `npm run docs:roadmap` rewrites the generated block from it. The `Source` column names the statement each row was carried from, so a plan that was only implicit in prose is still attributable.

<!-- ROADMAP-PLAN-BEGIN
{
  "schemaVersion": "bridlewise-roadmap-plan/v1",
  "milestones": [
    {
      "id": "M0",
      "title": "Public floor online",
      "state": "shipped"
    },
    {
      "id": "M1",
      "title": "Reproducible, sharded floor",
      "state": "in progress"
    },
    {
      "id": "M2",
      "title": "Admission evidence",
      "state": "planned"
    },
    {
      "id": "M3",
      "title": "Product hardening",
      "state": "planned"
    },
    {
      "id": "M4",
      "title": "Sustainable contribution",
      "state": "in progress"
    }
  ],
  "workstreams": [
    {
      "id": "M0-FLOOR",
      "milestone": "M0",
      "title": "Public floor, public gate and preview release",
      "state": "shipped",
      "owner": "maintainers",
      "exit": "Both repositories, the Pages sites, the public gate, failure reporting, the promotion gate and v0.0.3-preview are live.",
      "evidence": "#snapshot",
      "source": "M0, existing roadmap"
    },
    {
      "id": "M0-FLOOR-BUILD",
      "milestone": "M0",
      "title": "Build the floor from a clean machine",
      "state": "shipped",
      "owner": "floor tooling",
      "exit": "A clean clone reaches the public gate, the pinned corpus probe, and the supported suite through the documented commands; the sharded gate and receipt (M1), corpus boundary (M1), contributor hub (M4), and remaining known gaps (M2-X4) are composed here rather than restated.",
      "evidence": "evidence.md#a-fresh-clone",
      "source": "TASKS.md closed rows: Verify the public floor on a fresh machine, Publish the corpus manifest; docs/testing.md setup; composes M1-SHARD, M1-RECEIPT, M1-CORPUS, M4-HUB and M2-X4"
    },
    {
      "id": "M1-SHARD",
      "milestone": "M1",
      "title": "Shard the full suite",
      "state": "shipped",
      "owner": "floor tooling",
      "exit": "The manifest verifies against the live suite, the plan is deterministic, and a matrix of runners executes disjoint shards.",
      "evidence": "evidence.md#the-sharded-gate",
      "source": "M1 workstream 1, existing roadmap"
    },
    {
      "id": "M1-RECEIPT",
      "milestone": "M1",
      "title": "One qualification receipt",
      "state": "shipped",
      "owner": "floor tooling",
      "exit": "The merge refuses a missing, duplicate, failed, skipped, dirty or wrong-commit shard and uploads one receipt with the counts, timings and exclusion anchors.",
      "evidence": "evidence.md#the-sharded-gate",
      "source": "M1 workstream 2, existing roadmap"
    },
    {
      "id": "M1-CORPUS",
      "milestone": "M1",
      "title": "Reproducible fixtures",
      "state": "shipped",
      "owner": "engine fixtures",
      "exit": "The pinned corpus subset is fetched and verified outside the checkout; the raw cache stays unpublished.",
      "evidence": "evidence.md#corpus-boundary",
      "source": "M1 workstream 3, existing roadmap"
    },
    {
      "id": "M1-PERF",
      "milestone": "M1",
      "title": "Reproducible performance report",
      "state": "in progress",
      "owner": "performance",
      "exit": "A profile at the judged head is generated by npm run perf:profile under the idle-host contract and judged by the regression gate.",
      "evidence": "evidence.md#performance-probe",
      "source": "M1 workstream 4, existing roadmap",
      "horizon": "now"
    },
    {
      "id": "M1-REDS",
      "milestone": "M1",
      "title": "Repair the baseline reds",
      "state": "shipped",
      "owner": "floor tooling",
      "exit": "The supported file set runs without a failing or skipped test, and every exclusion is named with evidence.",
      "evidence": "evidence.md#the-supported-suite-on-one-host",
      "source": "M1 workstream 5, existing roadmap"
    },
    {
      "id": "M1-NODETEST",
      "milestone": "M1",
      "title": "A node:test shard runner that preserves the inventory contract",
      "state": "planned",
      "owner": "floor tooling",
      "exit": "The public node:test smoke files run inside the same shard and receipt contract as the supported Vitest set, without leaving the inventory.",
      "evidence": "evidence.md#the-sharded-gate",
      "source": "M1 help-wanted lane, existing roadmap; no task row yet",
      "horizon": "now"
    },
    {
      "id": "M2-RECEIPTS",
      "milestone": "M2",
      "title": "Per-capability readiness receipts",
      "state": "in progress",
      "owner": "engine governance",
      "exit": "Every capability names its gate decision, the policy fact that decided it, and a remedy when denied.",
      "evidence": "../trackers/TASKS.md",
      "source": "M2 workstream 1, existing roadmap; receipt shape recorded in TASKS.md",
      "horizon": "next"
    },
    {
      "id": "M2-GATES",
      "milestone": "M2",
      "title": "Close the remaining pre-admission gates",
      "state": "planned",
      "owner": "engine governance",
      "exit": "Model invocation, repository mutation, process execution and network egress each have an admission decision or a named refusal.",
      "evidence": "evidence.md#what-none-of-this-proves",
      "source": "M2 workstream 2, existing roadmap",
      "horizon": "next"
    },
    {
      "id": "M2-CONTROLS",
      "milestone": "M2",
      "title": "Publish the method and limits of the safety and privacy controls",
      "state": "planned",
      "owner": "engine safety",
      "exit": "The detectors, redaction and Landlock boundary are documented with their limits.",
      "evidence": "evidence.md#guardian",
      "source": "M2 workstream 3, existing roadmap",
      "horizon": "later"
    },
    {
      "id": "M2-PROVENANCE",
      "milestone": "M2",
      "title": "Release provenance and verification",
      "state": "in progress",
      "owner": "release",
      "exit": "Versioned metadata, checksums, attestations and a verification path ship; signing follows a reproducible build.",
      "evidence": "evidence.md#product-preview-release",
      "source": "M2 workstream 4, existing roadmap",
      "horizon": "next"
    },
    {
      "id": "M2-REVIEW",
      "milestone": "M2",
      "title": "Independent security review",
      "state": "planned",
      "owner": "maintainers",
      "exit": "An independent review is commissioned, or its absence is stated without implying that CI is an audit.",
      "evidence": "evidence.md#what-none-of-this-proves",
      "source": "M2 workstream 5, existing roadmap",
      "horizon": "later"
    },
    {
      "id": "M3-BACKUP",
      "milestone": "M3",
      "title": "Backup and restore for the database and key home, with verification",
      "state": "shipped",
      "owner": "server database",
      "exit": "One documented flow backs up and restores the database with its key material and proves each copy opens.",
      "evidence": "../cli.md#db-backupts",
      "source": "M3 workstream 1, existing roadmap; task board done row"
    },
    {
      "id": "M3-PROVIDERS",
      "milestone": "M3",
      "title": "Provider conformance fixtures and clearer setup failures",
      "state": "in progress",
      "owner": "engine providers",
      "exit": "The Responses path and a second provider shape are proved offline, with typed setup failures.",
      "evidence": "evidence.md#what-none-of-this-proves",
      "source": "M3 workstream 2, existing roadmap; a second fixture is closed in TASKS.md",
      "horizon": "later"
    },
    {
      "id": "M3-MCP",
      "milestone": "M3",
      "title": "MCP coverage",
      "state": "planned",
      "owner": "engine MCP",
      "exit": "The MCP transports and server lifecycle have conformance coverage and named prerequisites.",
      "evidence": "../extending.md",
      "source": "M3 later list, existing roadmap; not one of the six workstreams",
      "horizon": "later"
    },
    {
      "id": "M3-PLATFORM",
      "milestone": "M3",
      "title": "Cross-platform path handling with an explicit Landlock refusal",
      "state": "planned",
      "owner": "engine platform",
      "exit": "Platform limits are stated before installation, and unsupported confinement refuses explicitly.",
      "evidence": "evidence.md#guardian",
      "source": "M3 workstream 3, existing roadmap",
      "horizon": "later"
    },
    {
      "id": "M3-SCALE",
      "milestone": "M3",
      "title": "Measured scale and performance envelope",
      "state": "in progress",
      "owner": "performance",
      "exit": "Large repositories and concurrent runs have a measured envelope, and red budgets are tracked rather than called a pass.",
      "evidence": "evidence.md#performance-probe",
      "source": "M3 workstream 4, existing roadmap; red LCP, long-task, API and long-chat budgets",
      "horizon": "later"
    },
    {
      "id": "M3-A11Y",
      "milestone": "M3",
      "title": "Accessibility and responsive behavior as tested contracts",
      "state": "planned",
      "owner": "web",
      "exit": "Accessibility and responsive behavior have tested contracts, not visual claims.",
      "evidence": "evidence.md#what-none-of-this-proves",
      "source": "M3 workstream 5, existing roadmap",
      "horizon": "later"
    },
    {
      "id": "M3-EXTENSION",
      "milestone": "M3",
      "title": "A stable extension surface with compatibility notes",
      "state": "planned",
      "owner": "engine extension",
      "exit": "Extension points carry compatibility notes and a tested failure path.",
      "evidence": "../extending.md",
      "source": "M3 workstream 6, existing roadmap",
      "horizon": "later"
    },
    {
      "id": "M4-HUB",
      "milestone": "M4",
      "title": "A contributor hub distinct from the product home",
      "state": "shipped",
      "owner": "docs",
      "exit": "The floor has its own front door, separate from the product documentation mirror.",
      "evidence": "../index.md",
      "source": "M4 workstream 1, existing roadmap"
    },
    {
      "id": "M4-ISSUES",
      "milestone": "M4",
      "title": "Issue lanes with evidence requirements and a named next action",
      "state": "planned",
      "owner": "maintainers",
      "exit": "Every open issue names the evidence it needs or the decision it waits on.",
      "evidence": "https://github.com/LLM-4-People/bridlewise-testing/issues",
      "source": "M4 workstream 2, existing roadmap; lives on GitHub, not in this tree",
      "horizon": "later"
    },
    {
      "id": "M4-FIRST",
      "milestone": "M4",
      "title": "A first-patch path for docs, tests, guards, benchmarks and portability",
      "state": "shipped",
      "owner": "docs",
      "exit": "Each contribution lane starts from a public command and a reviewable first step.",
      "evidence": "help.md",
      "source": "M4 workstream 3, existing roadmap"
    },
    {
      "id": "M4-REVIEW",
      "milestone": "M4",
      "title": "Review expectations that reward reproduction and prevention",
      "state": "shipped",
      "owner": "maintainers",
      "exit": "The review guide asks for the reproduction, the prevention guard and the evidence, not only a green run.",
      "evidence": "https://github.com/LLM-4-People/bridlewise-testing/blob/main/CONTRIBUTING.md",
      "source": "M4 workstream 4, existing roadmap"
    },
    {
      "id": "M4-ROADMAP",
      "milestone": "M4",
      "title": "A roadmap that records state and exit criteria instead of a wish list",
      "state": "shipped",
      "owner": "docs",
      "exit": "Every planned-but-not-done item is rendered from its owner, and a guard refuses a stale status block.",
      "evidence": "#workstreams-and-exit-criteria",
      "source": "M4 workstream 5, existing roadmap; this change"
    }
  ],
  "exitCriteria": [
    {
      "id": "M0-B1",
      "milestone": "M0",
      "title": "The clean-machine setup names every build before the suite",
      "state": "shipped",
      "owner": "floor tooling",
      "evidence": "evidence.md#a-fresh-clone",
      "source": "docs/testing.md: Development-floor setup; TASKS.md: Verify the public floor on a fresh machine",
      "exit": "The setup sequence names the guardian build and engine bundle before the supported suite, and docs/testing.md names each refusal rather than calling it a skip."
    },
    {
      "id": "M0-B2",
      "milestone": "M0",
      "title": "Docs and briefings resolve only to tracked paths",
      "state": "shipped",
      "owner": "docs",
      "evidence": "evidence.md#docs-links",
      "source": "tests/prevention/agent-docs-liveness.test.ts; scripts/check-docs-links.mjs",
      "exit": "The docs link check resolves every tracked repository-relative Markdown link, and the briefing liveness guard refuses a linked path or backticked repo path that git does not hold."
    },
    {
      "id": "M0-B3",
      "milestone": "M0",
      "title": "Tracked modes and the self-protection config keep their contract",
      "state": "shipped",
      "owner": "floor tooling",
      "evidence": "../trackers/TASKS.md#done",
      "source": "TASKS.md: PUBLIC-SNAPSHOT-FILE-MODES; .github/workflows/ci.yml",
      "exit": "A tracked file recorded as 100644 stays 0644 in the working tree; a new atomic write takes 0600 only when it creates the file; and engine/bridlewise.config.json is 0600 in the checkout and CI."
    },
    {
      "id": "M0-B4",
      "milestone": "M0",
      "title": "Every gate carries a replayable evidence record",
      "state": "shipped",
      "owner": "docs",
      "evidence": "evidence.md#record-your-own-check",
      "source": "docs/floor/evidence.md: Record your own check",
      "exit": "The evidence page's gates name a command and an expected shape, and the record-your-own-check form gives a reviewer the claim, commit, command, observation, and interpretation fields."
    },
    {
      "id": "M1-X1",
      "milestone": "M1",
      "title": "CI calls the shard workflow",
      "state": "shipped",
      "owner": "CI",
      "evidence": "evidence.md#the-sharded-gate",
      "source": "M1 exit criterion 1, existing roadmap",
      "exit": "A push and pull-request CI job calls the shard workflow; dispatch remains available."
    },
    {
      "id": "M1-X2",
      "milestone": "M1",
      "title": "The merge refuses a bad shard set",
      "state": "shipped",
      "owner": "floor tooling",
      "evidence": "evidence.md#the-sharded-gate",
      "source": "M1 exit criterion 2, existing roadmap",
      "exit": "The merge refuses a missing shard, a duplicate file, a skipped file, a failed result, a dirty tree, or a shard from another commit."
    },
    {
      "id": "M1-X3",
      "milestone": "M1",
      "title": "The merge uploads one receipt",
      "state": "shipped",
      "owner": "floor tooling",
      "evidence": "evidence.md#the-sharded-gate",
      "source": "M1 exit criterion 3, existing roadmap",
      "exit": "The merge uploads one receipt naming the manifest digest, shard indexes and timings, pass/fail counts, and the excluded files with their evidence anchors."
    },
    {
      "id": "M1-X4",
      "milestone": "M1",
      "title": "The receipt names commit, class, time and prerequisites",
      "state": "shipped",
      "owner": "floor tooling",
      "evidence": "evidence.md#the-sharded-gate",
      "source": "M1 exit criterion 4, existing roadmap",
      "exit": "One receipt records the exact commit, shard count, runner class, total test-phase time, and any unsupported suite with its named prerequisite."
    },
    {
      "id": "M1-X5",
      "milestone": "M1",
      "title": "10x test-phase factor on a documented runner class",
      "state": "planned",
      "owner": "floor tooling",
      "evidence": "evidence.md#the-sharded-gate",
      "source": "M1 exit criterion 5, existing roadmap; 2.81x measured at d47909de",
      "horizon": "now",
      "exit": "The full-suite test phase is at least 10x faster than the single-runner baseline on the documented runner class, and the receipt records the measured factor."
    },
    {
      "id": "M1-X6",
      "milestone": "M1",
      "title": "A fresh clone runs the supported suite",
      "state": "shipped",
      "owner": "floor tooling",
      "evidence": "evidence.md#a-fresh-clone",
      "source": "M1 exit criterion 6, existing roadmap; met at b866b826",
      "exit": "A fresh clone with the documented setup runs the supported suite without guessing which tests are silently missing."
    },
    {
      "id": "M2-X1",
      "milestone": "M2",
      "title": "preflight names each capability",
      "state": "shipped",
      "owner": "engine governance",
      "evidence": "../trackers/TASKS.md",
      "source": "M2 exit criterion 1, existing roadmap; receipt shape recorded in TASKS.md",
      "exit": "preflight names each capability and its state, with evidence and a remedy for anything denied."
    },
    {
      "id": "M2-X2",
      "milestone": "M2",
      "title": "No admitted capability without a receipt",
      "state": "in progress",
      "owner": "engine governance",
      "evidence": "../trackers/TASKS.md",
      "source": "M2 exit criterion 2, existing roadmap; only preflight is admitted",
      "exit": "No capability is described as admitted without a reproducible receipt."
    },
    {
      "id": "M2-X3",
      "milestone": "M2",
      "title": "A release is verifiable from published assets",
      "state": "shipped",
      "owner": "release",
      "evidence": "evidence.md#product-preview-release",
      "source": "M2 exit criterion 3, existing roadmap",
      "exit": "A release can be verified from published assets and instructions."
    },
    {
      "id": "M2-X4",
      "milestone": "M2",
      "title": "The review boundary is stated without an audit claim",
      "state": "shipped",
      "owner": "maintainers",
      "evidence": "evidence.md#what-none-of-this-proves",
      "source": "M2 exit criterion 4, existing roadmap",
      "exit": "The project states exactly what has and has not been reviewed, without implying that CI is an audit."
    },
    {
      "id": "M3-X1",
      "milestone": "M3",
      "title": "Each capability has a failure path and a regression",
      "state": "in progress",
      "owner": "product",
      "evidence": "evidence.md#what-none-of-this-proves",
      "source": "M3 exit criterion 1, existing roadmap; backup and restore carry the first regression",
      "exit": "Each capability has a documented failure path and a regression."
    },
    {
      "id": "M3-X2",
      "milestone": "M3",
      "title": "Backup and restore are one verified flow",
      "state": "shipped",
      "owner": "server database",
      "evidence": "../cli.md#db-backupts",
      "source": "M3 exit criterion 2, existing roadmap",
      "exit": "Backup and restore are one documented flow with a verification step."
    },
    {
      "id": "M3-X3",
      "milestone": "M3",
      "title": "Platform limits are stated before installation",
      "state": "planned",
      "owner": "engine platform",
      "evidence": "evidence.md#guardian",
      "source": "M3 exit criterion 3, existing roadmap",
      "exit": "Platform limits are stated before installation."
    },
    {
      "id": "M3-X4",
      "milestone": "M3",
      "title": "Performance claims link to a method and a report",
      "state": "in progress",
      "owner": "performance",
      "evidence": "evidence.md#performance-probe",
      "source": "M3 exit criterion 4, existing roadmap; the method and probe exist, the envelope does not",
      "exit": "Performance claims link to a method and a report."
    },
    {
      "id": "M4-X1",
      "milestone": "M4",
      "title": "A newcomer can go from clone to a reviewable change",
      "state": "in progress",
      "owner": "docs",
      "evidence": "evidence.md#a-fresh-clone",
      "source": "M4 exit criterion 1, existing roadmap; install and run are proved, the labeled-issue path is not",
      "exit": "A new contributor can install, run the public gate, pick a labeled issue, and open a reviewable change using only public instructions."
    },
    {
      "id": "M4-X2",
      "milestone": "M4",
      "title": "Every open issue names its missing evidence",
      "state": "planned",
      "owner": "maintainers",
      "evidence": "https://github.com/LLM-4-People/bridlewise-testing/issues",
      "source": "M4 exit criterion 2, existing roadmap; judged on GitHub, not in this tree",
      "exit": "Every open issue states what evidence is missing or what decision is needed."
    },
    {
      "id": "M4-X3",
      "milestone": "M4",
      "title": "The roadmap and issue labels agree",
      "state": "planned",
      "owner": "maintainers",
      "evidence": "https://github.com/LLM-4-People/bridlewise-testing/issues",
      "source": "M4 exit criterion 3, existing roadmap; judged on GitHub, not in this tree",
      "exit": "The roadmap and the issue labels agree about the current milestone."
    },
    {
      "id": "M4-X4",
      "milestone": "M4",
      "title": "A documented example matches its command output",
      "state": "in progress",
      "owner": "docs",
      "evidence": "evidence.md#docs-links",
      "source": "M4 exit criterion 4, existing roadmap; docs:links checks targets, not command output",
      "exit": "A documentation example is verified against the command output before it ships."
    }
  ],
  "taskSections": {
    "Open": {
      "state": "in progress",
      "owner": "public floor",
      "exit": "The row closes in TASKS.md with the reproduction and verification named in its text.",
      "evidence": "../trackers/TASKS.md"
    },
    "Flaky burn-down owners": {
      "state": "planned",
      "owner": "public floor flaky memory",
      "exit": "Reproduce, fix, or explicitly retire the entry; the row closes.",
      "evidence": "../trackers/TASKS.md"
    },
    "Private web lanes (retained as ordinary work)": {
      "state": "planned",
      "owner": "private web floor",
      "exit": "Reproduce the recorded flake, fix its owner, or retire the entry with evidence; the row closes.",
      "evidence": "../trackers/TASKS.md"
    }
  },
  "taskOverrides": {
    "Bring the supported suite back under the CPU-per-file cap": {
      "state": "blocked",
      "blockedBy": "No clean judged run: 2 of 12 recorded; needs a 12-run idle campaign or an explicit policy decision.",
      "evidence": "evidence.md#the-supported-suite-on-one-host"
    }
  },
  "notPlanned": [
    {
      "statement": "Publishing the raw 4.1 GB corpus as a repository.",
      "reason": "Mixed licenses, nested histories, duplicate checkouts and credential-shaped fixtures.",
      "evidence": "evidence.md#corpus-boundary"
    },
    {
      "statement": "A hosted multi-tenant service in the preview.",
      "reason": "The preview is a single-user developer preview and carries no hosting claim.",
      "evidence": "#snapshot"
    },
    {
      "statement": "A production-readiness claim before the admission evidence exists.",
      "reason": "The admission gates are open and no capability beyond preflight is admitted.",
      "evidence": "evidence.md#what-none-of-this-proves"
    },
    {
      "statement": "Skipping or hiding a failing test to make a badge green.",
      "reason": "A failing test is owned by a named task row, and a guard refuses a stale duplicate.",
      "evidence": "../trackers/TASKS.md"
    },
    {
      "statement": "A benchmark number without its method.",
      "reason": "Performance claims must link to a method and a report.",
      "evidence": "evidence.md#performance-probe"
    },
    {
      "statement": "A universal provider compatibility claim.",
      "reason": "Provider conformance is proved per shape, not universally.",
      "evidence": "../extending.md"
    },
    {
      "statement": "A release date.",
      "reason": "This roadmap is a statement of intent, not a schedule.",
      "evidence": "#snapshot"
    }
  ]
}
ROADMAP-PLAN-END -->

<!-- BEGIN GENERATED: roadmap workstreams and exit criteria, from this page's ROADMAP-PLAN block (npm run docs:roadmap; scripts/floor/roadmap-status.ts) -->
### Milestone plan

Each milestone group names its workstreams and exit criteria with the owner, state, exit criterion, evidence, and source. The Source column names the statement each row was carried from.

#### M0 · Public floor online — shipped (6 shipped · 0 open)

**Workstreams**

| Workstream | State | Owner | Evidence |
|---|---|---|---|
| **Public floor, public gate and preview release**<br>Exit: Both repositories, the Pages sites, the public gate, failure reporting, the promotion gate and v0.0.3-preview are live.<br>Source: M0, existing roadmap | shipped | maintainers | [this page: snapshot](#snapshot) |
| **Build the floor from a clean machine**<br>Exit: A clean clone reaches the public gate, the pinned corpus probe, and the supported suite through the documented commands; the sharded gate and receipt (M1), corpus boundary (M1), contributor hub (M4), and remaining known gaps (M2-X4) are composed here rather than restated.<br>Source: TASKS.md closed rows: Verify the public floor on a fresh machine, Publish the corpus manifest; docs/testing.md setup; composes M1-SHARD, M1-RECEIPT, M1-CORPUS, M4-HUB and M2-X4 | shipped | floor tooling | [evidence: a-fresh-clone](evidence.md#a-fresh-clone) |

**Exit criteria**

| Exit criterion | State | Owner | Evidence |
|---|---|---|---|
| **The setup sequence names the guardian build and engine bundle before the supported suite, and docs/testing.md names each refusal rather than calling it a skip.**<br>Source: docs/testing.md: Development-floor setup; TASKS.md: Verify the public floor on a fresh machine | shipped | floor tooling | [evidence: a-fresh-clone](evidence.md#a-fresh-clone) |
| **The docs link check resolves every tracked repository-relative Markdown link, and the briefing liveness guard refuses a linked path or backticked repo path that git does not hold.**<br>Source: tests/prevention/agent-docs-liveness.test.ts; scripts/check-docs-links.mjs | shipped | docs | [evidence: docs-links](evidence.md#docs-links) |
| **A tracked file recorded as 100644 stays 0644 in the working tree; a new atomic write takes 0600 only when it creates the file; and engine/bridlewise.config.json is 0600 in the checkout and CI.**<br>Source: TASKS.md: PUBLIC-SNAPSHOT-FILE-MODES; .github/workflows/ci.yml | shipped | floor tooling | [TASKS: done](../trackers/TASKS.md#done) |
| **The evidence page's gates name a command and an expected shape, and the record-your-own-check form gives a reviewer the claim, commit, command, observation, and interpretation fields.**<br>Source: docs/floor/evidence.md: Record your own check | shipped | docs | [evidence: record-your-own-check](evidence.md#record-your-own-check) |

#### M1 · Reproducible, sharded floor — in progress (9 shipped · 3 open)

**Workstreams**

| Workstream | State | Owner | Evidence |
|---|---|---|---|
| **Shard the full suite**<br>Exit: The manifest verifies against the live suite, the plan is deterministic, and a matrix of runners executes disjoint shards.<br>Source: M1 workstream 1, existing roadmap | shipped | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| **One qualification receipt**<br>Exit: The merge refuses a missing, duplicate, failed, skipped, dirty or wrong-commit shard and uploads one receipt with the counts, timings and exclusion anchors.<br>Source: M1 workstream 2, existing roadmap | shipped | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| **Reproducible fixtures**<br>Exit: The pinned corpus subset is fetched and verified outside the checkout; the raw cache stays unpublished.<br>Source: M1 workstream 3, existing roadmap | shipped | engine fixtures | [evidence: corpus-boundary](evidence.md#corpus-boundary) |
| **Reproducible performance report**<br>Exit: A profile at the judged head is generated by npm run perf:profile under the idle-host contract and judged by the regression gate.<br>Source: M1 workstream 4, existing roadmap | in progress | performance | [evidence: performance-probe](evidence.md#performance-probe) |
| **Repair the baseline reds**<br>Exit: The supported file set runs without a failing or skipped test, and every exclusion is named with evidence.<br>Source: M1 workstream 5, existing roadmap | shipped | floor tooling | [evidence: the-supported-suite-on-one-host](evidence.md#the-supported-suite-on-one-host) |
| **A node:test shard runner that preserves the inventory contract**<br>Exit: The public node:test smoke files run inside the same shard and receipt contract as the supported Vitest set, without leaving the inventory.<br>Source: M1 help-wanted lane, existing roadmap; no task row yet | planned | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |

**Exit criteria**

| Exit criterion | State | Owner | Evidence |
|---|---|---|---|
| **A push and pull-request CI job calls the shard workflow; dispatch remains available.**<br>Source: M1 exit criterion 1, existing roadmap | shipped | CI | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| **The merge refuses a missing shard, a duplicate file, a skipped file, a failed result, a dirty tree, or a shard from another commit.**<br>Source: M1 exit criterion 2, existing roadmap | shipped | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| **The merge uploads one receipt naming the manifest digest, shard indexes and timings, pass/fail counts, and the excluded files with their evidence anchors.**<br>Source: M1 exit criterion 3, existing roadmap | shipped | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| **One receipt records the exact commit, shard count, runner class, total test-phase time, and any unsupported suite with its named prerequisite.**<br>Source: M1 exit criterion 4, existing roadmap | shipped | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| **The full-suite test phase is at least 10x faster than the single-runner baseline on the documented runner class, and the receipt records the measured factor.**<br>Source: M1 exit criterion 5, existing roadmap; 2.81x measured at d47909de | planned | floor tooling | [evidence: the-sharded-gate](evidence.md#the-sharded-gate) |
| **A fresh clone with the documented setup runs the supported suite without guessing which tests are silently missing.**<br>Source: M1 exit criterion 6, existing roadmap; met at b866b826 | shipped | floor tooling | [evidence: a-fresh-clone](evidence.md#a-fresh-clone) |

#### M2 · Admission evidence — planned (3 shipped · 6 open)

**Workstreams**

| Workstream | State | Owner | Evidence |
|---|---|---|---|
| **Per-capability readiness receipts**<br>Exit: Every capability names its gate decision, the policy fact that decided it, and a remedy when denied.<br>Source: M2 workstream 1, existing roadmap; receipt shape recorded in TASKS.md | in progress | engine governance | [TASKS](../trackers/TASKS.md) |
| **Close the remaining pre-admission gates**<br>Exit: Model invocation, repository mutation, process execution and network egress each have an admission decision or a named refusal.<br>Source: M2 workstream 2, existing roadmap | planned | engine governance | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| **Publish the method and limits of the safety and privacy controls**<br>Exit: The detectors, redaction and Landlock boundary are documented with their limits.<br>Source: M2 workstream 3, existing roadmap | planned | engine safety | [evidence: guardian](evidence.md#guardian) |
| **Release provenance and verification**<br>Exit: Versioned metadata, checksums, attestations and a verification path ship; signing follows a reproducible build.<br>Source: M2 workstream 4, existing roadmap | in progress | release | [evidence: product-preview-release](evidence.md#product-preview-release) |
| **Independent security review**<br>Exit: An independent review is commissioned, or its absence is stated without implying that CI is an audit.<br>Source: M2 workstream 5, existing roadmap | planned | maintainers | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |

**Exit criteria**

| Exit criterion | State | Owner | Evidence |
|---|---|---|---|
| **preflight names each capability and its state, with evidence and a remedy for anything denied.**<br>Source: M2 exit criterion 1, existing roadmap; receipt shape recorded in TASKS.md | shipped | engine governance | [TASKS](../trackers/TASKS.md) |
| **No capability is described as admitted without a reproducible receipt.**<br>Source: M2 exit criterion 2, existing roadmap; only preflight is admitted | in progress | engine governance | [TASKS](../trackers/TASKS.md) |
| **A release can be verified from published assets and instructions.**<br>Source: M2 exit criterion 3, existing roadmap | shipped | release | [evidence: product-preview-release](evidence.md#product-preview-release) |
| **The project states exactly what has and has not been reviewed, without implying that CI is an audit.**<br>Source: M2 exit criterion 4, existing roadmap | shipped | maintainers | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |

#### M3 · Product hardening — planned (2 shipped · 9 open)

**Workstreams**

| Workstream | State | Owner | Evidence |
|---|---|---|---|
| **Backup and restore for the database and key home, with verification**<br>Exit: One documented flow backs up and restores the database with its key material and proves each copy opens.<br>Source: M3 workstream 1, existing roadmap; task board done row | shipped | server database | [cli: db-backupts](../cli.md#db-backupts) |
| **Provider conformance fixtures and clearer setup failures**<br>Exit: The Responses path and a second provider shape are proved offline, with typed setup failures.<br>Source: M3 workstream 2, existing roadmap; a second fixture is closed in TASKS.md | in progress | engine providers | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| **MCP coverage**<br>Exit: The MCP transports and server lifecycle have conformance coverage and named prerequisites.<br>Source: M3 later list, existing roadmap; not one of the six workstreams | planned | engine MCP | [extending](../extending.md) |
| **Cross-platform path handling with an explicit Landlock refusal**<br>Exit: Platform limits are stated before installation, and unsupported confinement refuses explicitly.<br>Source: M3 workstream 3, existing roadmap | planned | engine platform | [evidence: guardian](evidence.md#guardian) |
| **Measured scale and performance envelope**<br>Exit: Large repositories and concurrent runs have a measured envelope, and red budgets are tracked rather than called a pass.<br>Source: M3 workstream 4, existing roadmap; red LCP, long-task, API and long-chat budgets | in progress | performance | [evidence: performance-probe](evidence.md#performance-probe) |
| **Accessibility and responsive behavior as tested contracts**<br>Exit: Accessibility and responsive behavior have tested contracts, not visual claims.<br>Source: M3 workstream 5, existing roadmap | planned | web | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| **A stable extension surface with compatibility notes**<br>Exit: Extension points carry compatibility notes and a tested failure path.<br>Source: M3 workstream 6, existing roadmap | planned | engine extension | [extending](../extending.md) |

**Exit criteria**

| Exit criterion | State | Owner | Evidence |
|---|---|---|---|
| **Each capability has a documented failure path and a regression.**<br>Source: M3 exit criterion 1, existing roadmap; backup and restore carry the first regression | in progress | product | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| **Backup and restore are one documented flow with a verification step.**<br>Source: M3 exit criterion 2, existing roadmap | shipped | server database | [cli: db-backupts](../cli.md#db-backupts) |
| **Platform limits are stated before installation.**<br>Source: M3 exit criterion 3, existing roadmap | planned | engine platform | [evidence: guardian](evidence.md#guardian) |
| **Performance claims link to a method and a report.**<br>Source: M3 exit criterion 4, existing roadmap; the method and probe exist, the envelope does not | in progress | performance | [evidence: performance-probe](evidence.md#performance-probe) |

#### M4 · Sustainable contribution — in progress (4 shipped · 5 open)

**Workstreams**

| Workstream | State | Owner | Evidence |
|---|---|---|---|
| **A contributor hub distinct from the product home**<br>Exit: The floor has its own front door, separate from the product documentation mirror.<br>Source: M4 workstream 1, existing roadmap | shipped | docs | [index](../index.md) |
| **Issue lanes with evidence requirements and a named next action**<br>Exit: Every open issue names the evidence it needs or the decision it waits on.<br>Source: M4 workstream 2, existing roadmap; lives on GitHub, not in this tree | planned | maintainers | [GitHub](https://github.com/LLM-4-People/bridlewise-testing/issues) |
| **A first-patch path for docs, tests, guards, benchmarks and portability**<br>Exit: Each contribution lane starts from a public command and a reviewable first step.<br>Source: M4 workstream 3, existing roadmap | shipped | docs | [help](help.md) |
| **Review expectations that reward reproduction and prevention**<br>Exit: The review guide asks for the reproduction, the prevention guard and the evidence, not only a green run.<br>Source: M4 workstream 4, existing roadmap | shipped | maintainers | [GitHub](https://github.com/LLM-4-People/bridlewise-testing/blob/main/CONTRIBUTING.md) |
| **A roadmap that records state and exit criteria instead of a wish list**<br>Exit: Every planned-but-not-done item is rendered from its owner, and a guard refuses a stale status block.<br>Source: M4 workstream 5, existing roadmap; this change | shipped | docs | [this page: workstreams-and-exit-criteria](#workstreams-and-exit-criteria) |

**Exit criteria**

| Exit criterion | State | Owner | Evidence |
|---|---|---|---|
| **A new contributor can install, run the public gate, pick a labeled issue, and open a reviewable change using only public instructions.**<br>Source: M4 exit criterion 1, existing roadmap; install and run are proved, the labeled-issue path is not | in progress | docs | [evidence: a-fresh-clone](evidence.md#a-fresh-clone) |
| **Every open issue states what evidence is missing or what decision is needed.**<br>Source: M4 exit criterion 2, existing roadmap; judged on GitHub, not in this tree | planned | maintainers | [GitHub](https://github.com/LLM-4-People/bridlewise-testing/issues) |
| **The roadmap and the issue labels agree about the current milestone.**<br>Source: M4 exit criterion 3, existing roadmap; judged on GitHub, not in this tree | planned | maintainers | [GitHub](https://github.com/LLM-4-People/bridlewise-testing/issues) |
| **A documentation example is verified against the command output before it ships.**<br>Source: M4 exit criterion 4, existing roadmap; docs:links checks targets, not command output | in progress | docs | [evidence: docs-links](evidence.md#docs-links) |

<!-- END GENERATED: roadmap workstreams and exit criteria -->

## Open work

Everything below is rendered from its owners: the open rows of [TASKS.md](../trackers/TASKS.md), the state rules in the plan block, and the explicit non-proofs of [the evidence page](evidence.md). A TASKS.md row disappears from the task board only when that row closes; a non-proof disappears only when the evidence page stops naming it.

<!-- BEGIN GENERATED: roadmap open work, from TASKS.md open rows, this page's ROADMAP-PLAN block and docs/floor/evidence.md (npm run docs:roadmap; scripts/floor/roadmap-status.ts) -->
### Open task board

Every open row of [TASKS.md](../trackers/TASKS.md) appears here. A row leaves this table only when its tracker row closes; the state rule and exit criterion for each tracker section are declared in the ROADMAP-PLAN block.

#### Open

| Task | State | Owner | Evidence |
|---|---|---|---|
| **Bring the supported suite back under the CPU-per-file cap**<br>Exit: The row closes in TASKS.md with the reproduction and verification named in its text. | blocked (blocked by: No clean judged run: 2 of 12 recorded; needs a 12-run idle campaign or an explicit policy decision.) | public floor | [evidence: the-supported-suite-on-one-host](evidence.md#the-supported-suite-on-one-host) |

#### Flaky burn-down owners

| Task | State | Owner | Evidence |
|---|---|---|---|
| **FLAKY-PUBLIC-ENGINE-UNDIAGNOSED**<br>Exit: Reproduce, fix, or explicitly retire the entry; the row closes. | planned | public floor flaky memory | [TASKS](../trackers/TASKS.md) |
| **FLAKY-PUBLIC-ENGINE-UNLOGGED-RECORDS**<br>Exit: Reproduce, fix, or explicitly retire the entry; the row closes. | planned | public floor flaky memory | [TASKS](../trackers/TASKS.md) |
| **FLAKY-PUBLIC-ENGINE-GUARD-REDS-ON-ROUND-TREES**<br>Exit: Reproduce, fix, or explicitly retire the entry; the row closes. | planned | public floor flaky memory | [TASKS](../trackers/TASKS.md) |
| **FLAKY-PUBLIC-S1-B12-CONTROL**<br>Exit: Reproduce, fix, or explicitly retire the entry; the row closes. | planned | public floor flaky memory | [TASKS](../trackers/TASKS.md) |
| **FLAKY-PUBLIC-WEB-GUARD-REDS-ON-ROUND-TREES**<br>Exit: Reproduce, fix, or explicitly retire the entry; the row closes. | planned | public floor flaky memory | [TASKS](../trackers/TASKS.md) |
| **FLAKY-PUBLIC-WEB-WATCHDOG-C3**<br>Exit: Reproduce, fix, or explicitly retire the entry; the row closes. | planned | public floor flaky memory | [TASKS](../trackers/TASKS.md) |

#### Private web lanes (retained as ordinary work)

| Task | State | Owner | Evidence |
|---|---|---|---|
| **FLAKY-PERF-GATE-STALE-REPORT**<br>Exit: Reproduce the recorded flake, fix its owner, or retire the entry with evidence; the row closes. | planned | private web floor | [TASKS](../trackers/TASKS.md) |

### What the evidence does not prove

The public evidence page names what its receipts do not establish. These statements are not coverage and not a pass.

| Evidence area | Not proved |
|---|---|
| Fresh clone gate | [the cockpit, the engine domain suites, the browser E2E suite, a live provider, a large repository, or the guardian. Those are separate gates.](evidence.md#fresh-clone-gate) |
| Inventory check | [that any test passed, that the count is coverage, or that the private corpus is present. The corpus root the tests read is not published.](evidence.md#inventory-check) |
| The supported suite on one host | [the four excluded suites, a 10x shard claim, an idle-host CPU verdict, or a fresh-clone run.](evidence.md#the-supported-suite-on-one-host) |
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
| Publishing the raw 4.1 GB corpus as a repository. | Mixed licenses, nested histories, duplicate checkouts and credential-shaped fixtures. | [evidence: corpus-boundary](evidence.md#corpus-boundary) |
| A hosted multi-tenant service in the preview. | The preview is a single-user developer preview and carries no hosting claim. | [this page: snapshot](#snapshot) |
| A production-readiness claim before the admission evidence exists. | The admission gates are open and no capability beyond preflight is admitted. | [evidence: what-none-of-this-proves](evidence.md#what-none-of-this-proves) |
| Skipping or hiding a failing test to make a badge green. | A failing test is owned by a named task row, and a guard refuses a stale duplicate. | [TASKS](../trackers/TASKS.md) |
| A benchmark number without its method. | Performance claims must link to a method and a report. | [evidence: performance-probe](evidence.md#performance-probe) |
| A universal provider compatibility claim. | Provider conformance is proved per shape, not universally. | [extending](../extending.md) |
| A release date. | This roadmap is a statement of intent, not a schedule. | [this page: snapshot](#snapshot) |

<!-- END GENERATED: roadmap open work -->

## How this roadmap changes

A milestone or exit criterion changes in the ROADMAP-PLAN block; an open task changes in [TASKS.md](../trackers/TASKS.md); a non-proof changes in [the evidence page](evidence.md). Then run `npm run docs:roadmap` to rewrite the generated blocks. `npm run docs:roadmap -- --check` is the read-only form.

The generated blocks are not hand-editable. The site build also refuses a page whose emitted classes have no rule in the shared stylesheet (`npm run design:coverage`), and a built-page assertion checks that this page's tables are tables rather than paragraphs, so a generator change that breaks rendering fails the deploy rather than the reader. A guard (`tests/prevention/roadmap-status-owner.test.ts`) fails when the page differs from the renderer's output, when an open task row has no state rule, when a plan row points at a missing evidence anchor, or when a task override names a row that is no longer open.

The [decision records]({{ '/decisions/' | relative_url }}) hold the durable reasoning. The [status page]({{ '/floor/status/' | relative_url }}) holds the generated snapshot. This page holds the direction and the plan. If an item is blocked, its row says so. A visible block is better than a quiet omission.
