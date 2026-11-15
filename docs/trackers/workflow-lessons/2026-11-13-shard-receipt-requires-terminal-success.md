---
id: L-2026-11-13-shard-receipt-requires-terminal-success
date: 2026-11-13
source: required web shard receipt producer review
kind: guard
status: pending
route: sdk-milestone-successor-89fb16aaf31f (first SDK PR full qualification and required CI receipt)
---

## Observation

The required receipt job depended on both the plan and shard jobs, but its first prerequisite tested only the plan result. Report wrapping and upload run after a failed command, so valid green assertion JSON alone could still reach the receipt merger. This is a source-proven possible false pass; no live GitHub exploit was performed.

## Lesson

A required qualification receipt must require successful terminal outcomes from every producer it certifies, in addition to validating report content and provenance. Keep the receipt job unconditional so failure, cancellation and skipped producers receive a failing check.

## Change

Extend the existing prerequisite to test both dependency results. The existing official GitHub expression helper evaluates the authored environment expressions, and the existing merger tests execute the actual first shell guard over all sixteen terminal-result pairs. Real wrapper and merger fixtures retain the existing report checks; a failed-command fixture and prepare-only mutant are designed to demonstrate why green JSON cannot replace a successful producer result. This component requires the separately reviewed SDK dependency and does not include the later W5 visual changes. Full CI and publication qualification remain separately owned.
