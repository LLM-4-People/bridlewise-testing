---
id: L-2026-11-14-unstable-visual-checks-retain-both-observations
date: 2026-11-14
source: hosted visual instability retained only the first same-page capture
kind: guard
status: acted
acted_in: [scripts/visual/plan.ts, scripts/visual/screens.ts, scripts/visual/screens.test.mjs]
---

## Observation

The visual runner detected different bytes in two captures of the same page,
but retained only the first capture and its comparison base. The report could
not show the actual divergence, and its unstable result carried no measured
pixel count. That missing evidence prevents diagnosis of the original render.

## Lesson

Preserve both observations at the comparison owner when their difference is
itself a refusal. Bind the report to their exact bytes and retain the diff;
a declaration of an intended design change cannot accept nondeterminism.

## Change

The existing visual runner retains both same-page images, their byte lengths
and SHA-256 values, the existing canvas owner's pixel diff and counts, and
report links to all three. Stable and intentional-change behavior and every
refusal remain unchanged. A real browser regression covers the complete theme
and viewport matrix with stable, intentionally changed and deterministically
unstable pages. It fails against the prior runner's missing evidence and
passes with the retained pair, including every file hash and report link.

The browser regression is explicitly invoked after the pinned browser is
installed. Its proposed CI wiring remains separate pending the existing
workflow-write authority. This evidence improvement does not identify or fix
the original hosted instability, clear a separate Engine failure, or make a
later green result a causal explanation.
