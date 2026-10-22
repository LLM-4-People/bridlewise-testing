---
layout: default
title: "The repository is a run record: how Bridlewise uses GitHub"
description: "How Bridlewise uses GitHub: Actions as checks, Security as custody, Releases as effects, Pages as a logbook, and the other surfaces that make the repository auditable."
permalink: /github/
---

# The repository is a run record

How Bridlewise uses GitHub.

A governed run leaves eight kinds of trace. The public repository is where this project leaves them.

```text
intent → boundary → tool → effect → check → finding → decision → release
```

That sequence is not a metaphor pasted onto a README. It is the same shape the harness records for a single run: what was asked, what was allowed, what executed, what changed, what was checked, what was found, what was decided, and what left the machine. GitHub is the project's flight recorder for the same beats at repository scale.

## The eight beats

| Beat | In a run | On GitHub |
|---|---|---|
| **Intent** | The prompt, project, model, and plan | [README]({{ site.repository_url }}#readme), [roadmap]({{ '/floor/roadmap/' | relative_url }}), [topics]({{ site.repository_url }}) |
| **Boundary** | Provider, policy, project root, confinement | [SECURITY.md](../SECURITY.md), [CODEOWNERS](../.github/CODEOWNERS), [branch protection]({{ site.repository_url }}/branches) |
| **Tool** | The registered tool, typed arguments, pre-dispatch gate | [Actions workflows]({{ site.repository_url }}/actions), [CLI]({{ '/cli/' | relative_url }}), lifecycle scripts |
| **Effect** | A file diff, command result, or published artifact | Commits, [Releases]({{ site.repository_url }}/releases), [Pages deploy]({{ site.repository_url }}/actions/workflows/pages.yml) |
| **Check** | The check, its before/after, and the delta | [CI]({{ site.repository_url }}/actions/workflows/ci.yml), [CodeQL]({{ site.repository_url }}/actions/workflows/codeql.yml), [secret scan]({{ site.repository_url }}/actions/workflows/secret-scan.yml), [Scorecard]({{ site.repository_url }}/actions/workflows/scorecard.yml) |
| **Finding** | What a check or detector found, with its derivation | [Issues]({{ site.repository_url }}/issues), [Security tab: code scanning and Dependabot]({{ site.repository_url }}/security) |
| **Decision** | Allow, deny, stop, retry, or escalate — with a reason | [Discussions]({{ site.repository_url }}/discussions), pull requests, [decision records](decisions) |
| **Release** | What leaves the harness, and what the record says about it | [The preview release]({{ site.repository_url }}/releases/tag/v0.0.3-preview), [Citation](../CITATION.cff), [Pages](index.md) |

## The surfaces, and what they actually prove

| Surface | Live | Proves | Does not prove |
|---|---|---|---|
| **Actions** | [Workflows]({{ site.repository_url }}/actions) | Named commands ran on a clean `ubuntu-24.04` runner at a commit, and the result is attached to that commit | That the code is correct, secure, or behaves the same on your host |
| **Security** | [Security tab]({{ site.repository_url }}/security) | A policy, private reporting, code scanning, and dependency alerts are configured | That findings are closed, or that the code has been audited |
| **Releases** | [Releases]({{ site.repository_url }}/releases) | The named assets exist, and `SHA256SUMS` describes them | Authorship, reproducibility, or a signature |
| **Discussions** | [Discussions]({{ site.repository_url }}/discussions) | A public place to ask a question exists | That anyone has answered, or that the answer is correct |
| **Issues** | [Issues]({{ site.repository_url }}/issues) | A finding can be filed with a reproduction, revision, environment, and redacted logs | That every finding is public, or that a filed issue is triaged |
| **Pages** | [The docs site](index.md) | The Jekyll site in `docs/` builds and deploys | That the cockpit runs, or that the deployment is the app |
| **Rulesets** | [Rules]({{ site.repository_url }}/rules) · [Branches]({{ site.repository_url }}/branches) | A tag ruleset protects `v*` from deletion or force-update; a merge gate exists on `main` | That a human reviewed the change; no PR review is required |
| **Codespaces** | [Codespaces]({{ '/codespaces/' | relative_url }}) | A devcontainer can install the dependencies and forward the two local ports | Landlock confinement, CI parity, or a governed run |
| **Insights** | [Pulse]({{ site.repository_url }}/pulse) | Repository activity: commits, contributors, traffic, dependency graph | Anything about how the harness behaves during a run |
| **Topics** | [Repository topics]({{ site.repository_url }}) | The project is labeled for discovery: `local-first`, `coding-agents`, `landlock`, and others | That any label is a capability claim |
| **Citation** | [CITATION.cff](../CITATION.cff) | A citable identity, version, license, and date | Peer review, endorsement, or academic provenance |

## Actions: the check is a receipt

The repository runs one build gate and several security gates:

| Workflow | Job | Trigger |
|---|---|---|
| [CI]({{ site.repository_url }}/actions/workflows/ci.yml) | **Typecheck, public tests, build**, **Full suite shards** | Push to `main`, pull request, manual |
| [Secret scan]({{ site.repository_url }}/actions/workflows/secret-scan.yml) | **Secret and privacy scan** | Push to `main`, pull request, manual |
| [CodeQL]({{ site.repository_url }}/actions/workflows/codeql.yml) | **Analyze JavaScript and TypeScript** | Push to `main`, pull request, weekly, manual |
| [Dependency review]({{ site.repository_url }}/actions/workflows/dependency-review.yml) | **Review dependency changes** | Pull request, manual |
| [Scorecard]({{ site.repository_url }}/actions/workflows/scorecard.yml) | **Scorecard analysis** | Push to `main`, weekly, branch protection change, manual |
| [Docs links]({{ site.repository_url }}/actions/workflows/docs-links.yml) | **Relative Markdown links** | Push to `main`, pull request, manual |
| [Docs site]({{ site.repository_url }}/actions/workflows/pages.yml) | **Build the site** (pull request and `main`), **Deploy to GitHub Pages** (`main` only) | Push to `main`, pull request, manual |

The guardian is built and tested inside CI.

A green run means the steps in that workflow exited zero. It does not mean the workflow covered the failure you care about. Read the steps, not just the badge.

Two details are easy to miss:

- **Four checks are required on `main`**: `Build and verify`, `Secret and privacy scan`, `Relative Markdown links`, and `Analyze JavaScript and TypeScript`. Dependency review, Scorecard, and the Pages build are configured but are not required merge checks.
- **CodeQL is not a clean bill.** The analysis can succeed while the code-scanning queue holds open alerts. The workflow proves the analyzer ran; the Security tab holds the findings.

## Security: custody, not a certificate

The [Security tab]({{ site.repository_url }}/security) is where the repository keeps its custody surfaces:

- [Private vulnerability reporting]({{ site.repository_url }}/security/advisories/new) is enabled. There is no public exploit channel, no bug bounty, and no response SLA.
- [Code scanning]({{ site.repository_url }}/security) carries CodeQL results and OpenSSF Scorecard checks. At publication, the Dependabot queue is at **0 open alerts** and the security-query queue was triaged to zero open findings; test-only and false positives are dismissed with reasons, not silently closed.
- [Dependabot]({{ site.repository_url }}/security) is enabled, and dependency review fails pull requests on high-severity changes. The product and testing queues currently report **0 open alerts**; new advisories can reopen them.

Direct code-scanning and Dependabot views can require repository access. The Security tab is the stable public entry point; the alert queues are also inspectable through the authenticated `gh api` commands on the [evidence page]({{ '/evidence/' | relative_url }}#4-the-security-surfaces).

Custody means the surfaces exist and someone can inspect them. It does not mean the contents are clean. The [known issues]({{ '/known-issues/' | relative_url }}) page states the current gaps without turning them into a score.

## Releases: an effect with a receipt

The [v0.0.3-preview release]({{ site.repository_url }}/releases/tag/v0.0.3-preview) is the public effect of the release workflow. It carries:

- `bridlewise-v0.0.3-preview-source.tar.gz` — the tracked source tree;
- `bridlewise-v0.0.3-preview-cockpit.tar.gz` — the built static cockpit;
- `bridlewise-v0.0.3-preview-engine-bundle.js` — the esbuild bundle;
- `bridlewise-v0.0.3-preview-sbom-web.spdx.json` and `...-engine.spdx.json` — SPDX SBOMs;
- `bridlewise-v0.0.3-preview-promotion-receipt.json` — the gate receipt;
- `SHA256SUMS` — checksums for all assets.

The release is a **prerelease**, and its assets are not OS-signed. All five checksummed assets passed `sha256sum -c` on 2026-10-19 (the release has six assets, including `SHA256SUMS`); all five attested assets passed `gh attestation verify`. The provenance attestation is signed by GitHub's OIDC identity, not by a maintainer key, and it is not a reproducible-build proof. `SHA256SUMS` proves that the bytes you downloaded match the published list. See [Evidence]({{ '/evidence/' | relative_url }}) for the verification commands.

## Rulesets: the gate that exists, and the review that does not

A tag ruleset named `protect-release-tags` is active for `refs/tags/v*`; it blocks deletion, force-update, and update. Classic branch protection on `main` is doing the merge work:

- required status checks: **Build and verify**, **Secret and privacy scan**, **Relative Markdown links**, **Analyze JavaScript and TypeScript**;
- strict: the branch must be up to date before merging;
- conversation resolution: required;
- required pull-request reviews: none;
- enforce for administrators: off.

That is a real merge gate, and it is narrower than it looks. A change can land with four green checks and no human approval. The project compensates with a [contribution guide](../CONTRIBUTING.md), a [testing floor]({{ site.repository_url }}), and a review culture — not with a GitHub setting. Do not read the gate as a review.

## Codespaces: a workspace, not a boundary

The snapshot includes a devcontainer built on the Node 24 image, with `build-essential` for the guardian and its process supervisor. See [Open it in a Codespace]({{ '/codespaces/' | relative_url }}) for the workspace walkthrough.

It installs both dependency trees, fixes the config mode, forwards ports `5173` and `5174`, and asks for 2 CPUs, 4 GB of memory, and 32 GB of storage.

That is a useful disposable workspace. It is not a governed run, and it does not reproduce the security boundary. Landlock availability depends on the host kernel and the container's privileges; the guardian fails closed when the kernel path is unavailable. A Codespace is also not CI: the same commands can pass in one and fail in the other.

## The small surfaces

**Discussions** is a question channel. Its categories include Q&A, Ideas, and Show and tell. The first thread is an announcement that asks you to read the limits before the welcome — which is the correct order. A discussion proves someone can ask; it does not prove an answer exists.

**Issues** is the finding channel. The bug template requires a summary, reproduction, expected and actual behavior, revision, environment, and redacted logs, plus three confirmations: you searched, you removed secrets and private data, and you understand there is no support SLA. That is a better finding template than most projects have. At the snapshot, the public issue list was empty; six scoped issues were then opened for refusal documentation, link anchors, provider conformance, dependency triage, and the missing test fixture. An open issue list is a work queue, not a claim that everything is known.

**Pages** is the logbook. The [docs site](index.md) is built from `docs/` by Jekyll and deployed by the Pages workflow. It is a static record, not the cockpit. The [interactive run]({{ '/run/' | relative_url }}) and the [policy lab]({{ '/policy-lab/' | relative_url }}) are illustrations of the record and the governance console; they do not call a model or execute a tool.

**Insights** is GitHub's telemetry about the repository: pulse, contributors, traffic, dependency graph, network, forks. The harness's own telemetry is local and narrower: `harness metrics` prints a measured snapshot, `harness timeline` queries the durable ledger, and `scripts/trace.ts` inspects runs. GitHub cannot see a run.

**Topics** are luggage tags. The repository carries `agpl`, `ai`, `coding-agents`, `developer-tools`, `landlock`, `llm`, `local-first`, `nodejs`, `sqlite`, `svelte`, and `typescript`. They help someone find the project; they do not describe its readiness.

**Citation** is a return address. `CITATION.cff` names the project, version `0.0.3-preview`, license, repository, site, and release date. It makes the work citable. It does not make it peer-reviewed.

## What the record does not show

The repository is a record of what the project did, not a certificate of what it can be trusted with. The missing beats are explicit:

- no independent security audit;
- no OS-signed installer; `v0.0.2-preview` adds GitHub build-provenance attestations and SPDX SBOMs, which are not a substitute for an independent audit;
- no required human review on `main`;
- no hosted demo or hosted execution;
- no published 4.1 GB test corpus, so the full corpus-backed suite is not reproducible from a fresh clone;
- open code-scanning and dependency alerts that are not all triaged;
- Linux-only Landlock confinement, with no equivalent on macOS or Windows;
- provider coverage limited to OpenAI-style protocols, with native Anthropic and Gemini adapters unverified;
- no multi-tenant hardening or audited isolation between mutually distrusting users.

Those are not hidden in a footnote. They are on the [known issues]({{ '/known-issues/' | relative_url }}) page, in [Security and limits]({{ '/security/' | relative_url }}), and in the warning at the top of every page.

## A five-minute audit

1. Open the latest [CI run]({{ site.repository_url }}/actions/workflows/ci.yml). Read the job name and the conclusion. Then read the steps.
2. Open [code scanning]({{ site.repository_url }}/security). Sort by severity. Note what is open, not just what is closed.
3. Open the [release]({{ site.repository_url }}/releases/tag/v0.0.3-preview). Download `SHA256SUMS` and one asset. Verify the checksum.
4. Open [branch protection]({{ site.repository_url }}/branches). See which checks are required and which are advisory.
5. Read [known issues]({{ '/known-issues/' | relative_url }}). Compare it with what the badges imply.

You will know more than a green check tells you. That is the point of a run record.
