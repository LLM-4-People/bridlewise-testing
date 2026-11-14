---
schema: bridlewise-tracker-item/v1
published: false
id: PROJECTOR-NATIVE-TERMINATION
type: Bug
title: Diagnose projector subprocess termination
state: open
lane: floor
owner-role: engine process maintainer
severity: P1
area: [process admission, GitHub projector]
horizon: now
decisions: [UR-24, FLAKE-REPRO, UR-18]
tests: [engine/test/forge/projector.test.ts]
evidence: repo:actions/runs/43576533070/job/132391868972
opened: 2026-11-14
---

# Diagnose projector subprocess termination

The Engine CI run for pull request #810 reported 10,999 tests, with 10,998 passing and one failing. In the memory-cap case in engine/test/forge/projector.test.ts, the outer child process returned a null status where the test expected zero. This assertion failed before the typed projection_memory_exhausted assertion. The retained output did not record the child signal, spawn error or execution phase, so the termination cause remains unknown.

## Work

- Retain native status, signal, spawn error and optional phase diagnostics through the existing projector test boundary, without changing its assertions or admission limits.
- Use a changed diagnostic subject to capture the missing facts in CI. A passing local diagnostic run does not explain or clear the original failure.
- Establish and fix the actual cause at its existing owner, with a controlled regression and the normal source-relevant checks. Do not increase the cap, skip the test or rerun the unchanged failure away.

## Completion

Close this item only after the observed termination class has a justified cause and a causal fix, the original evidence remains preserved, and the normal qualification permits the resulting source to land. A Flake-cause trailer requires an actual cause-changing fix and recorded reproduction.

## Comparison boundary

Older pull requests contain the same assertion failure, but that alone does not establish the target-tree comparison required by UR-24. More recent retained target references passed this case. This open owner records real unfinished work; it does not grant an unchanged-failure exception or readiness.
