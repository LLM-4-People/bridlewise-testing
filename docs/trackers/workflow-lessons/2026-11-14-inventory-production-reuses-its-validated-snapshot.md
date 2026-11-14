---
id: L-2026-11-14-inventory-production-reuses-its-validated-snapshot
date: 2026-11-14
source: full guard real two-branch generator fixture timeout
kind: guard
status: acted
acted_in: [engine/scripts/test-inventory.ts, engine/test/verification/recursive-test-inventory.test.ts, engine/src/shared/workflow/e2e-runner.mjs, engine/src/shared/workflow/e2e-runner.d.mts, engine/scripts/README.md]
---

## Observation

A stale inventory CLI write discovered every canonical test name, then sent
that newly built inventory through the public transaction writer, which
repeated the full discovery. The real two-branch module integration therefore
performed four full discovery passes while requiring two complete generator
runs. Its timeout remains recorded; duplicated work alone does not establish
the timing cause or a recovered full qualification.

## Lesson

A producer can retain its own complete validated build without granting
arbitrary callers that trust. Before publishing, recheck the current source
bytes, recognizable population, bound scope, policy, manifest and independent
Git conservation inputs. Identical source bytes preserve discovered names;
a structural snapshot supplied by another caller cannot establish completeness.

## Change

The CLI discovers names once and rechecks its private build against fresh
canonical inputs, including on cache hits. The existing public transaction
writer still rebuilds arbitrary inventory values. Both paths use one journal
publication body. Qualification must use native discovery-call counters, controlled input drift
and forged inventory cases to verify that distinction. The real module
integration must keep both whole fixtures, every assertion and the original bounds.

This change is implemented at the canonical producer and is covered by native
discovery-call controls, input-drift refusals and the unchanged real module
integration. The retained timeout remains evidence; this record makes no main,
full-CI or wall-time speedup claim.
