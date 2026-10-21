---
layout: default
floor_assets: true
page_class: roadmap
title: "Roadmap"
description: "Where Bridlewise is and what comes next, generated from its tracker items and decision records, with the evidence behind every status. No dates are promised."
permalink: /floor/roadmap/
---

# Roadmap

<!-- BEGIN GENERATED AT PUBLISH: the roadmap, from the tracker items, the decision records, git history and the checks (engine/scripts/roadmap/cli.ts build) -->
The roadmap is rendered here when the site is built. It comes from the tracker items (`docs/trackers/items/`, where milestones are items too), the decision records (`docs/decisions/`), the git history and the floor's check results, so nobody types a status. In the repository, read the [task board](../trackers/TASKS.md); every decision record is in `docs/decisions/`.
<!-- END GENERATED AT PUBLISH: the roadmap -->

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
| Contribution path | Documented in [How to help]({{ '/floor/help/' | relative_url }}) and [CONTRIBUTING.md](https://github.com/LLM-4-People/bridlewise-testing/blob/main/CONTRIBUTING.md) |

The snapshot is dated by the [status page]({{ '/floor/status/' | relative_url }}) and the [atlas]({{ '/floor/atlas/' | relative_url }}). This page names the direction; those pages carry the generated evidence.
