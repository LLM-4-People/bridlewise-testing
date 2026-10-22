---
id: Q-TX2
date: 2026-10-15
by: user
group: process
status: in-force
implementation: partial
route: TEST-10X
acted_in: [engine/src/shared/run-cpu.ts, engine/src/shared/budget-verdict.ts, engine/test/prevention/suite-cpu-budget.test.ts]
---
# Test budgets count CPU work, not wall time

How long a test suite takes on the clock depends on whatever else the machine
is doing, so a wall-clock budget fails on a busy host even when nothing got
slower. The work the suite itself does (CPU time, instructions retired) does
not change with load, so budgets are counted in that work.

The user, 2026-10-15: "yes count in cpu work".

- Test and suite budgets are counted in CPU work that host load does not
  affect (instructions retired or CPU time, from the sandbox's instruments),
  not wall time.
- Suites may then run concurrently.
- [UI-CPU](UI-CPU-browser-gates-judged-in-cpu-work.md) extends it to the
  browser speed gates; [NO-LOAD-BLOCK](NO-LOAD-BLOCK-nothing-is-blocked-by-cpu-load.md)
  makes it the rule for every judged measurement.

Done so far: the suite budget is a CPU budget. `engine/src/shared/run-cpu.ts`
reads a run's CPU time, and `engine/src/shared/budget-verdict.ts` judges it
(`engine/test/prevention/suite-cpu-budget.test.ts` drives that door).

Still missing (TEST-10X): the counter is process CPU time, not instructions
retired, and the verdict still defers a saturated host as provisional, so the
judgement is not yet fully load-independent; the measurement does not yet come
from the sandbox's instruments; suites do not yet run concurrently.
