---
schema: bridlewise-tracker-item/v1
published: false
id: HARNESS-CHECK-SHARED-OBSERVATION
type: Task
title: Share fresh architecture and registrar observations
state: open
lane: floor
owner-role: workflow command maintainer
severity: P1
area: [workflow commands, CPU work]
horizon: now
decisions: [UR-24, UR-06, UR-18]
tests: [engine/test/workflow/harness-commands.test.ts]
evidence: repo:actions/runs/43615214562/job/132508659040
opened: 2026-11-14
---

# Share fresh architecture and registrar observations

The convergence case in engine/test/workflow/harness-commands.test.ts failed its CPU class in the Engine job for author head 9f20863ffcaf413d5993814f0175b24c7458c285: 131,214 ms of CPU work exceeded the existing 130,346 ms ceiling. That failed producer remains retained; its wall time and the suite's cold-cache nonjudgment do not excuse the per-test breach.

The remaining production duplication is in harnessCheck: its architecture arm obtains a registrar report, then its independent registrar arm obtains another report after the awaited inventory and progress callbacks. Besides repeating source work, a callback edit can leave the two arms describing different source observations. The shared observation must be made after the inventory boundary and both callbacks, without a persistent cache or caller-supplied success result. Standalone architecture checks must still observe their own root afresh.

The changed private subject passes its complete 65-case harness-commands file. The same convergence case reports 117,610 ms of CPU work under the unchanged 130,346 ms ceiling. Its restored two-observation control exposes the extra source read and stale architecture result after a registrar-progress edit. These are bounded changed-subject results, not clearance of the old 131,214 ms failure, full Engine qualification or main readiness.

Keep this Task open for integration of the independently reviewed source, actual-source qualification and current CI judgement. Preserve the real callback-mutation, one-read and fresh-next-invocation regressions, standalone refusal contracts and existing result order. This Task owns the duplicate observation and its qualification; it is neither a flaky-burn-down entry nor an exception for a current failure, class ceiling or other budget.
