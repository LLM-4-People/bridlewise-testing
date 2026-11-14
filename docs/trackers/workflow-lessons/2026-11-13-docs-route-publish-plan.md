---
id: L-2026-11-13-docs-route-publish-plan
date: 2026-11-13
source: issue 621 and the moved-provider comment audit
kind: guard
status: pending
route: qualify the shared publish plan and all consumers before promotion
---

## Observation

Moving documentation by changing authored URL strings left navigation, release snapshots, generated front doors and legacy links with independent address rules. Markdown-only discovery also omitted the published HTML demos. A build command could recursively remove an existing output directory before validating the new source.

## Lesson

A location is derived from its source identity by one owner. Every consumer must use that plan, and publication must inspect the assembled artifact. The configured renderer decides which source constructs are links. A source approximation disagreed on escaped backticks, adjacent fences and raw HTML; the authoritative rewrite therefore reads the rendered HTML with the actual HTML parser. Output ownership must be checked before writes.

## Change

The W5 candidate makes the site plan own documentation prefixes, live pages, HTML pages, navigation and captured old-to-current URLs. The builder writes every page's permalink and source identity, retains source-relative page bodies through Jekyll, resolves actual rendered attributes, and derives aliases from preserved history. It disables the platform's second link rewriter and projects deferred builder globals from rendered output; an unrelated source token grants no link exception. URI decoding and existing-file candidates share their owners with the crawler. A generated per-artifact source-ID projection binds the source and deployment; its link phase is not a qualification receipt. Snapshot assembly checks live targets against the merged artifact. Fresh-only outputs preserve previous work. Qualification remains pending until the complete source, generator outputs, policy component and independent review agree.

## Public demo integration

The homepage must demonstrate the existing production interface, rather than maintain a second transcript or tool-effect renderer. Its embedded view shares the canonical public replay, guided selection, Flow and inspector. The source build invokes the existing trusted artifact assembler once after source validation; Jekyll copies that output. Theme and natural height remain presentation messages bound to the exact same-origin frame. The example stays offline and cannot reopen its client network. Actual hosted execution and online GitHub observation remain separate qualification work.

A whole front-door sync also revealed a missing ownership preflight: it projected the claims URL into an unleased README owned by another workspace. Both versions were preserved, and that single unintended write was restored by exact preimage before further work. The shared generator must check the complete changed target set against its admitted writer ownership before its first write. This prevention remains pending at the generator owner; source, integration and rendered qualification remain open.
