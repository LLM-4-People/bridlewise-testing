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

## Current recurrence and bounded repair

At author head 9f20863ffcaf413d5993814f0175b24c7458c285, [the current Engine job](https://github.com/LLM-4-People/bridlewise-testing/actions/runs/43615214562/job/132508659040) again failed the outer status assertion. This time the retained diagnostic reports status null, signal SIGKILL, no spawn error and empty stdout. It records the phases started, before-admission, probed and before-allocation. The last marker precedes renewed admission and linking as well as allocation. No later phase or post-termination memory-event counters were retained. SIGKILL is observed; its underlying cause remains unknown.

A separate admission-order control found that confinedCall linked modules before obtaining its admitted hold. The repair admits before linkProgram and performs linking inside the existing owned release/error path. The non-allocating real-adapter guard passes with the repair and fails with the old order because no admitted hold exists at linking. It also checks the original exception and registry release. This establishes the order defect; it does not establish the cause of the hosted SIGKILL.

The first changed-subject execution of the original memory case passed on the local host with its original one-percent cap, three-times allocation, zero-status assertion and typed memory-refusal assertion unchanged. This is evidence for that selected changed case on that host. It supplies neither the hosted job's absolute cap nor a retrospective kill explanation, whole-file result or general OOM guarantee. PROJECTOR-NATIVE-TERMINATION-BURN-DOWN remains open and its entry is retained.

## Open lifetime goal

Keep the broader surviving-owner and delegated-child design open under this Bug. It must preserve the normal aggregate cap and admission of every descendant while an authoritative outer owner survives the payload's failure domain, retains owned payload-lifetime facts and proves cleanup. The planned outer aggregate/coordinator leaf and owned delegated payload subgroup still need capability, process-placement and lifecycle proof through the existing admission owners. Holding cgroup descriptors alone did not preserve readable facts after scope collection in a separate natural-exit control. The minimal admission-order repair does not implement or close this broader goal.
