---
id: L-2026-11-15-published-draft-resume
date: 2026-11-15
source: published workspace editing and authority handoff
kind: tooling
status: acted
acted_in: [engine/src/workflow/workspace-manager.ts, engine/src/workflow/workspace-cli.ts, engine/src/workflow/workspace-registry.ts, engine/test/workspaces/workspace-forge.test.ts, engine/test/workspaces/workspace-concurrency.test.ts, engine/test/workspaces/workspace-migration.test.ts, engine/test/workspaces/workspace-land.test.ts]
---

## Observation

A published pull request could leave draft through the normal workspace command, but it had no matching command to withdraw readiness and resume editing. Readiness also correctly prevented authority handoffs. This left valid corrective work without a normal transition back to an editable workspace, particularly when the current validation report recorded a failure.

## Lesson

Expose both directions of a lifecycle transition through the same owner and operation gate. Preserve existing evidence when withdrawing permission. Remote effects require a readback of the same subject before the local compare-and-swap records completion, and a partial remote success must remain recoverable without inventing local success.

## Change

The workspace manager and CLI expose `harness workspace draft <id>`. They share the existing per-workspace publication resource across lifecycle mutations, refuse changed native custody or remote subjects, and keep the complete validation report when the workspace returns to active editing. The registry binds records to the workspace id in their filename so the operation gate and the affected subject agree. The existing workspace tests cover real draft withdrawal, failed qualification, staged and unstaged work, partial conversion, concurrent operations, and current and migrated record identities through the existing workspace test files.
