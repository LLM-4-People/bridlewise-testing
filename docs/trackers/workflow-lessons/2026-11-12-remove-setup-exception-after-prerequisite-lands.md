---
id: L-2026-11-12-remove-setup-exception-after-prerequisite-lands
date: 2026-11-12
source: GitHub issue 743 and the shared engine setup guard
kind: guard
status: pending
route: P3.1
---

## Observation

Commit records kept its manual dependency install and config permission step
after the shared engine setup action became available on main. The test's
temporary exception continued to permit the duplication. It checked whether
the exception was still used, which could not establish whether its original
prerequisite still justified it.

## Lesson

Reconcile a deferred exception when its prerequisite lands. Remove its
filtering machinery once all consumers use the shared owner, so the live-tree
guard judges every workflow by the same contract.

## Change awaiting qualification

The base-owned Commit records workflow now calls the shared engine setup with
lifecycle scripts disabled. Its call site is declared in the external-surface
registry, and the engine setup guard has no temporary exception. Independent
review and full qualification remain required before this lesson is acted.
