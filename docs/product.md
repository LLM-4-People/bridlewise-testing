---
layout: default
floor_assets: true
page_class: floor
title: "Product documentation"
description: "Where to start in the mirrored Bridlewise product documentation, separate from the development floor."
permalink: /product/
---

# Product documentation

This site mirrors the complete product documentation for [Bridlewise](https://github.com/LLM-4-People/bridlewise). The root of this site is the development floor's contributor hub. The product home remains at <https://llm-4-people.github.io/bridlewise/>.

Use this page when you want to understand or run the product. Use the [development floor]({{ '/floor/' | relative_url }}) when you want to test, extend, review, or reproduce it.

<div class="callout-warning" role="note">
<p>Bridlewise is an experimental developer preview. It is not production-ready, and it is not safe for sensitive, proprietary, regulated, or production code. Read [Security and limits]({{ '/security/' | relative_url }}) before running anything important.</p>
</div>

## Start here

| If you want to | Read |
|---|---|
| Run the preview on a disposable copy | [Quickstart]({{ '/quickstart/' | relative_url }}) · [CLI]({{ '/cli/' | relative_url }}) · [Codespaces]({{ '/codespaces/' | relative_url }}) |
| Understand the run record and the architecture | [Architecture]({{ '/architecture/' | relative_url }}) · [Run record]({{ '/run/' | relative_url }}) · [Glossary]({{ '/glossary/' | relative_url }}) |
| Audit the limits | [Security and limits]({{ '/security/' | relative_url }}) · [Known issues]({{ '/known-issues/' | relative_url }}) · [Roadmap and status]({{ '/roadmap/' | relative_url }}) |
| Build on the harness | [Building on the harness]({{ '/extending/' | relative_url }}) · [Testing]({{ '/testing/' | relative_url }}) |
| See how the project records itself | [GitHub map]({{ '/github/' | relative_url }}) · [Evidence]({{ '/evidence/' | relative_url }}) |
| Inspect the verification machinery | [Development floor]({{ '/floor/' | relative_url }}) · [Test atlas]({{ '/floor/atlas/' | relative_url }}) · [Status]({{ '/floor/status/' | relative_url }}) |

## What is mirrored

The product docs cover the cockpit, the loopback server, the engine, the guardian, governed tools, code intelligence, memory, safety, configuration, releases, and the honest limits of the preview. The mirror is assembled from the public product repository at build time. It is not a second hand-maintained copy.

The floor adds the contributor hub, the test atlas, the status snapshot, the promotion contract, evidence commands, and the build roadmap. If a floor page and the product docs disagree about user-facing behavior, the source and the command output win. Report the drift rather than choosing the more convenient statement.
