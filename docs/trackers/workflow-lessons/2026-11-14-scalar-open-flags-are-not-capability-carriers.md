---
id: L-2026-11-14-scalar-open-flags-are-not-capability-carriers
date: 2026-11-14
source: conditional metadata directory flags
kind: guard
status: acted
acted_in: [engine/scripts/verification/architecture.ts, engine/scripts/verification/authority/typescript-adapter.ts, engine/test/effect-analysis.test.ts, engine/test/prevention/filesystem-cache-shared-counter.test.ts]
---

## Observation

The effect analyzer understood a conditional directory-open flag as a scalar, but its capability-carrier pass treated the same conditional's filesystem constant as a namespace. A read-only adapter acquired a false write effect.

## Lesson

A secondary capability pass must reuse the existing scalar proof. That proof needs the exact immutable declaration and canonical module identity; a familiar property name alone proves neither. Unknown values and writable flags must retain their effects.

## Change

The carrier pass reuses the open-flag classifier. Its provenance checks reuse the existing lexical-scope owner over the same parsed program, and distinguish binding reassignment from mutation through object aliases. The regression matrix preserves writable and unknown joins, callable carriers, forged authorities, shadowing and direct assignment, update and delete mutations. Cache identity includes the shared scope owner, with a causal unavailability control.
