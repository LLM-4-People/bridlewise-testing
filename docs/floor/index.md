---
layout: default
floor_assets: true
page_class: floor
title: "The development floor"
description: "The Bridlewise development floor: tests, prevention guards, benchmarks, decision records, and the promotion contract behind the product repository."
permalink: /floor/
---

# The development floor

The floor is the repository where Bridlewise is verified before a change reaches the product. It carries the full test tree, prevention guards, benchmark harness, decision records, traceability artifacts, and the promotion profile. The product repository is a curated projection of this tree.

> [!WARNING]
> Bridlewise is an experimental developer preview. It is not production-ready and it is not safe for sensitive, proprietary, regulated, or production code. The floor records verification work about Bridlewise. It does not turn Bridlewise into a supported product.

## Two repositories, one direction

| Repository | Role | What it carries |
|---|---|---|
| [`LLM-4-People/bridlewise`](https://github.com/LLM-4-People/bridlewise) | Product | Cockpit, loopback server, engine, guardian, shared contracts, and public docs. This is the tree a user clones. |
| [`LLM-4-People/bridlewise-testing`](https://github.com/LLM-4-People/bridlewise-testing) | Development floor | The source tree plus the suites, fixtures, benchmarks, decisions, evidence records, and promotion machinery that are kept out of the product clone. |

The product repository does not carry the full test corpus or the private fixture root. Publishing an inventory without its fixtures would suggest a reproducibility the project does not have. The floor is public so the machinery can be inspected, not so the preview can be trusted with production code.

The floor is not the product, a staging environment, a hosted service, or a support channel. It is a working repository with incomplete suites, moving counts, and known gaps.

## Where the evidence lives

| Question | Surface | What it shows | What it does not show |
|---|---|---|---|
| Did the floor's public gate pass? | [Testing CI](https://github.com/LLM-4-People/bridlewise-testing/actions/workflows/ci.yml) | Typechecks, secret scan, public smoke tests, cockpit and engine builds, guardian build and tests | The corpus-backed suites, the live provider suite, or E2E on every change |
| Did the product gate pass? | [Product CI](https://github.com/LLM-4-People/bridlewise/actions/workflows/ci.yml) | Typechecks, public smoke tests, secret scan, cockpit and engine builds, and guardian checks at one commit | Runtime correctness, security, or coverage of an untested path |
| Which tests and records exist? | [Test atlas]({{ '/floor/atlas/' | relative_url }}) | Inventory entries, dispositions, prevention guards, and decision records | That any entry ran, passed, or applies to your checkout |
| What rules govern a change? | [Decision records]({{ '/decisions/' | relative_url }}) | The rule, its state, and the paths where it was carried out | That the implementation is correct or complete |
| How does code reach the product branch? | [Promotion contract]({{ '/floor/promotion/' | relative_url }}) | The projection boundary, deterministic gates, and the publication step | A security audit or a production release guarantee |
| What runs at each layer? | [Testing docs]({{ '/testing/' | relative_url }}) | The test map, prerequisites, commands, and known gaps | That a fresh clone can run the full suite |
| What ships in a release? | [Shipping docs]({{ '/shipping/' | relative_url }}) | Build outputs, verification steps, release assets, and rollback | A production endorsement |
| Can I rerun a claim? | [Evidence commands]({{ '/floor/evidence/' | relative_url }}) | Commands, expected output shapes, and explicit non-proofs | Anything the command did not observe |
| Did a public workflow fail? | [Testing failure reports](https://github.com/LLM-4-People/bridlewise-testing/issues?q=is%3Aissue+label%3Aci-failure) and [product failure reports](https://github.com/LLM-4-People/bridlewise/issues?q=is%3Aissue+label%3Aci-failure) | One issue per workflow and branch or pull request, with the run link and failed jobs | The diagnosis, the fix, or a guarantee that the failure is covered |

## The floor console and the test atlas

Both pages are generated at build time from tracked data. They read generated JSON. Neither calls GitHub from your browser, and neither becomes a second source of truth.

**Floor console.** The [status page]({{ '/floor/status/' | relative_url }}) shows the last generated snapshot: source commit, promotion state, gate results, and the latest public CI runs. It is live only in the sense that it displays a generated snapshot. It does not stream, it may lag the source, it does not reduce the floor to one green badge, and it renders unknown when data is missing.

**Test atlas.** The [atlas]({{ '/floor/atlas/' | relative_url }}) filters test surface files by category and disposition, and lists prevention guards and decision records. One row is an inventory entry. It is not a passing result.

The generators write public, redacted JSON. A missing file, an unknown schema, a stale snapshot, or an unavailable GitHub API produces a visible fallback state on the affected page. None of those states is green.

## Choose a path

| If you want to | Start here |
|---|---|
| Rerun the public gate on a disposable clone | [Evidence commands]({{ '/floor/evidence/' | relative_url }}) |
| Understand how a test change becomes a product commit | [Promotion contract]({{ '/floor/promotion/' | relative_url }}) |
| Inspect the test inventory, guards, or decisions | [Test atlas]({{ '/floor/atlas/' | relative_url }}) |
| Read the current snapshot and its limits | [Floor status]({{ '/floor/status/' | relative_url }}) |
| Read the product documentation | [Product docs]({{ '/' | relative_url }}) |
| Run the preview | [Quickstart]({{ '/quickstart/' | relative_url }}) |

## The product docs are at the root

The site build mirrors the product documentation at `{{ '/' | relative_url }}`. The root mirror and the floor pages are build targets. The floor pages are additive: they document the machinery behind the product. If a floor page and the product docs disagree about user-facing behavior, the source and the command output win. Report the drift rather than choosing the more convenient statement.

## When a public gate fails

A reusable reporter watches the public workflows in both repositories. A failure opens one issue for that workflow and branch or pull request. A repeat failure adds a comment to the same open issue, and a later success for the same scope closes it. The issue links the run and lists the failed jobs. It does not copy logs or secrets.

The reporter is a pointer to evidence. It is not a diagnosis. Read the failed job, reproduce the failure, fix the owner, and add prevention. The [failure issue list](https://github.com/LLM-4-People/bridlewise-testing/issues?q=is%3Aissue+label%3Aci-failure) is the queue, not a second test result.

## What the floor does not prove

- **A fresh clone cannot run every suite.** The 4.1 GB external corpus and the performance report are not published. Runners refuse with a named prerequisite instead of skipping.
- **Green CI is not correctness.** It proves the configured steps passed at one commit. It does not prove those steps cover the failure you care about.
- **No security audit exists.** There has been no third-party review, penetration test, or certification.
- **Counts move.** The atlas and status pages date their snapshots. Treat an old snapshot as history, not as the current state.
- **The floor is not permission.** Do not point the preview at a codebase you cannot lose.

Start with a disposable copy, a revocable provider key, and your own backups. The product docs state the rest of the limits.
