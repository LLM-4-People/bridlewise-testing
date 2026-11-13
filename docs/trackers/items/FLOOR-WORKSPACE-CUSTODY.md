---
schema: bridlewise-tracker-item/v1
published: false
id: FLOOR-WORKSPACE-CUSTODY
type: Task
title: Preserve unique workspace work before automatic retirement
state: open
lane: floor
opened: 2026-11-13
---

Automatic retirement must prove that no unique work remains before deleting a workspace, branch, recovery reference or Git administrative record. A missing working directory, expired lease or old timestamp is not that proof. Preserve and verify the administrative index, HEAD, reflogs and reachable unique objects, together with any remaining staged, working-tree, untracked and recovery work. An ambiguous or unreadable state must retain the work and report the unresolved custody.

The shared Git operation in [worktree-port.ts](../../../engine/src/git/worktree-port.ts) still exposes repository-wide `worktreePrune`. Its callers include home preparation in [promoter-home.ts](../../../engine/src/workflow/promotion/promoter-home.ts) and candidate sweeping in [tree-landing.ts](../../../engine/src/workflow/tree-landing.ts); private reproduction cleanup in [flake-cli.ts](../../../engine/src/workflow/flake-cli.ts) also invokes Git prune directly. Route every automatic prune and retirement through one conservative preservation judgment, including administrative records whose working directory is absent. Preserve successful landing receipts separately from a cleanup that retained work. Recheck current ownership and observed state before effects; native refusal must not become a force fallback.

The current home inventory contains absent worktree paths and broken repository links. Inventory and the bounded library classification correction are useful evidence, but reuse, relocation, metadata repair and retirement remain unqualified. Reconcile every retained work location before any destructive migration; the library correction does not wire an automatic host repair flow. Prove refusal with causal tests for unique index, branch, reflog, recovery-only and missing-directory work, as well as metadata inspection failures, and prove the safe no-unique-work case independently.

This is the open preservation prerequisite for the existing `A5-CANDIDATE-RETIRE` route in [D-11](../../decisions/D-11-isolation-tooling.md), not closure of that route. Retained evidence follows [REC-DIR](../../decisions/REC-DIR-useful-recovery-records-live-in-the-repository.md) and [EVD-STORE](../../decisions/EVD-STORE-raw-evidence-in-a-content-addressed-store.md); private host details and credentials do not belong in this public record.
