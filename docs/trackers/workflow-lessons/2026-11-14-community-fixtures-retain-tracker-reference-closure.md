---
id: L-2026-11-14-community-fixtures-retain-tracker-reference-closure
date: 2026-11-14
source: two community intake fixture failures in Engine CI for pull request 810
kind: tooling
status: acted
acted_in: [engine/test/workflow/community-record.test.ts]
---

## Observation

The shared intake fixture copied every canonical tracker item and its board but omitted the decision records and test files those items reference. Adding a valid Bug exposed that incomplete fixture in both the write and landing cases. The strict production reader correctly refused the copied world; the referenced files existed in the source repository.

## Lesson

A fixture that copies canonical records must derive and retain their structured reference closure through the existing readers. A spelling list of known decisions or tests would become stale when the records change. Keep production validation strict so missing dependencies remain observable.

## Change

The existing trackerRepository builder reads the complete item population through readTrackerItems, resolves decision IDs with the existing front-matter reader, copies the declared decision and test files, and commits those dependencies with the items and board. Its regression uses an arbitrary decision filename and nested test path, then removes each dependency to prove the strict refusal still works. The existing real write and landing cases share that same builder.

This fixture correction does not explain the original projector termination or clear the separate bounded-run and CPU failures. Their retained evidence and normal qualification requirements remain in force.
