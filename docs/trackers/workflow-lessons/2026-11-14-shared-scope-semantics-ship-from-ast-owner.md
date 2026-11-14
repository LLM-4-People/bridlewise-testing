---
id: L-2026-11-14-shared-scope-semantics-ship-from-ast-owner
date: 2026-11-14
source: source-side promotion boundary regression
kind: guard
status: acted
acted_in: [engine/src/quality-packs/prevention/ast-helpers.ts, engine/scripts/verification/architecture.ts, engine/scripts/verification/authority/typescript-adapter.ts, engine/scripts/verification/authority/literal-semantics.ts, engine/scripts/verification/authority/occurrence-discovery.ts, engine/scripts/verification/authority/occurrence-selectors.ts, engine/scripts/verification/authority/semantic-resolution.ts, engine/scripts/verification/authority/shape-semantics.ts, engine/test/prevention/filesystem-cache-shared-counter.test.ts, engine/test/authority-graph/authority-graph-boundary.test.ts]
---

## Observation

A shipped architecture analyzer imported generic scope functions from an intentionally excluded authority adapter. Its explicit analysis-cache dependency URL referenced the same excluded module. The production source projector reproduced two exclusion refusals on the changed tree and none on its base under the same promotion profile. The hosted assertion exposed a two-entry refusal array, while its exact entries were unavailable in the retained report.

## Lesson

Reusable semantics used by shipped and verification modules belong to their shared shipped owner. Move the implementation and its cache-identity dependency together, and keep narrow product exclusions intact. Tests must preserve scope traversal, shadowing, unavailable-source recovery and the unique implementation boundary across the move.

## Change

The existing AST helper owns lexical scope and binding identity. Authority consumers import generic helpers directly, while their adapter retains authority-specific parsing and facts. The analyzer and its cache identity name the shared owner. The existing AST walk keeps its committed optional leave callback exactly. Metadata, TypeScript parameter-property, cache recovery and existing product-boundary controls cover this ownership change without widening the promotion profile.
