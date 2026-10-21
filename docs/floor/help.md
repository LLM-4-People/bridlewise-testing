---
layout: default
floor_assets: true
page_class: floor
title: "How to help"
description: "Contribution lanes for the Bridlewise development floor: reproduce a bug, add prevention, improve the test floor, extend the harness, or review a change."
permalink: /floor/help/
---

# How to help

The development floor is where Bridlewise is tested, challenged, and made reproducible. You do not need to be a maintainer to help. You do need to bring evidence, keep the scope small, and leave the record clearer than you found it.

<div class="callout-warning" role="note">
<p><strong>Developer preview.</strong> Do not use Bridlewise on sensitive, proprietary, regulated, or production codebases. Run it on disposable copies. Never include real credentials, private source, personal data, or local database contents in an issue, fixture, screenshot, or pull request.</p>
</div>

## Pick a lane

| Lane | Good for | First step |
|---|---|---|
| **Reproduce** | Turning a report into a failing test | Find an issue labeled [`needs-evidence`](https://github.com/LLM-4-People/bridlewise-testing/issues?q=is%3Aissue+is%3Aopen+label%3Aneeds-evidence) |
| **Prevent** | Adding a guard that would have caught the failure | Read the [testing guide]({{ '/testing/' | relative_url }}) and pick a [`testing`](https://github.com/LLM-4-People/bridlewise-testing/issues?q=is%3Aissue+is%3Aopen+label%3Atesting) issue |
| **Make it reproducible** | Sharding, fixtures, corpus manifests, performance reports | Start with [M1 on the roadmap]({{ '/floor/roadmap/' | relative_url }}) |
| **Extend** | Tools, blocks, providers, MCP, quality packs, embedding | Read [Building on the harness]({{ '/extending/' | relative_url }}) |
| **Document** | Making examples match the command output | Pick a [`documentation`](https://github.com/LLM-4-People/bridlewise-testing/issues?q=is%3Aissue+is%3Aopen+label%3Adocumentation) issue |
| **Review** | Reading for the failure mode, not the happy path | Use the [reviewer role's checklist](https://github.com/LLM-4-People/bridlewise-testing/blob/main/docs/process/ROLES.md#reviewer) |

New here? The [`good first issue`](https://github.com/LLM-4-People/bridlewise-testing/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label is the shortest path. If an issue is unclear, ask for the missing evidence before writing code.

## The first hour

The setup commands and the fresh-clone gate live in [CONTRIBUTING](https://github.com/LLM-4-People/bridlewise-testing/blob/main/CONTRIBUTING.md#setup); run them before your first change. That is the public gate, and it works on a fresh clone without the external corpus. If it fails, capture the exact command and the first typed error; do not disable the gate to get past it.

The full suite has named prerequisites. The [testing guide](https://github.com/LLM-4-People/bridlewise-testing/blob/main/docs/testing.md) owns them and the full-run bar.

## What a good contribution looks like

### A reproduced bug

The [evidence rules](https://github.com/LLM-4-People/bridlewise-testing/blob/main/docs/process/AGENTS.md#evidence) own the bar. A useful report:

1. States the observed behavior and the expected behavior.
2. Gives the smallest command or fixture that reproduces it, with the typed error, the run id if there is one, and the relevant version or commit.
3. Redacts secrets, private code, and personal data, and adds a regression test that fails before the fix.

If reproduction is impossible, say so explicitly. Do not present a guess as a diagnosis.

### A prevention guard

A guard is not just a new assertion: the [evidence rules](https://github.com/LLM-4-People/bridlewise-testing/blob/main/docs/process/AGENTS.md#evidence) own the standard it must meet, including its failure proof, and [CONTRIBUTING](https://github.com/LLM-4-People/bridlewise-testing/blob/main/CONTRIBUTING.md#test-conventions) owns where the test goes.

### A test-floor improvement

The floor is throughput-bound and fixture-bound. Useful work includes:

- Sharding the full suite and merging the results into one receipt.
- A corpus manifest or sanitized subset with a pinned fetch step.
- A reproducible performance profile with an idle-host contract.
- Splitting a slow file without changing what it proves.
- Verifying the supported shard manifest and running the shard workflow on a named runner class.
- Repairing a missing fixture or an explicit, named exclusion.

The goal is not a smaller test count. The goal is a complete, reproducible run that finishes sooner.

### An extension

Tools, blocks, providers, MCP servers, quality checks, and embeddings are contracts. Add the declaration and the behavior together. Keep the refusal path typed and visible. Add a test for the configured path, the unconfigured path, and the malformed input.

Read [Building on the harness]({{ '/extending/' | relative_url }}) first. If the extension point does not exist, open a design issue before building a parallel mechanism.

### A documentation change

Verify the example against the code, and link the source of truth. [CONTRIBUTING](https://github.com/LLM-4-People/bridlewise-testing/blob/main/CONTRIBUTING.md#what-makes-a-good-change) owns the documentation rule; if a floor page and the product docs disagree, report the drift rather than choosing the friendlier statement.

## Labels and next actions

| Label | Meaning | What to do |
|---|---|---|
| `good first issue` | A scoped entry point | Comment with your plan and the evidence you will add |
| `help wanted` | Maintainers want a contributor | Ask for the owner and the acceptance check |
| `needs-evidence` | The report lacks a reproduction | Add the command, error, and smallest fixture |
| `testing` | Test or guard work | Link the layer and the failure it prevents |
| `documentation` | Docs or examples | Verify the command before editing |
| `security` | Security-sensitive work | Do not post exploit details publicly; use the security policy |
| `preview` | Preview behavior | State the limits; do not imply production readiness |

## What we will not accept

The [Tier 1 contract](https://github.com/LLM-4-People/bridlewise-testing/blob/main/docs/process/TIER1-AGENT-CONTRACT.md#you-must-not) owns the refusals, and the [evidence rules](https://github.com/LLM-4-People/bridlewise-testing/blob/main/docs/process/AGENTS.md#evidence) own what counts as evidence. The warning above is the short version for anything involving real code or data.

## Ask, report, or review

- **Questions and design discussion:** [GitHub Discussions](https://github.com/LLM-4-People/bridlewise-testing/discussions).
- **Reproducible bug:** open an issue with the exact command and typed error.
- **Security report:** follow [SECURITY.md](https://github.com/LLM-4-People/bridlewise-testing/blob/main/SECURITY.md). Do not open a public exploit issue.
- **Contribution rules:** read [CONTRIBUTING.md](https://github.com/LLM-4-People/bridlewise-testing/blob/main/CONTRIBUTING.md).

The floor is public so the machinery can be inspected and improved, not so the preview can be trusted with production code.
