---
id: UR-24-BUDGETS
date: 2026-10-07
by: coordinator
group: process
status: in-force
implementation: done
acted_in: [engine/src/workflow/workspace-manager.ts, engine/src/workflow/failure-owners.ts, engine/src/kernel/root-policy.ts, engine/src/shared/budget-verdict.ts, scripts/testing/performance-measurements.ts, engine/src/kernel/web-performance-budgets.ts]
---
# A budget breach joins the one judgement

This is the coordinator's amendment to [UR-24](UR-24-zero-new-failures-every-failure-owned.md):
round-3 decision E' of 2026-10-07, tightened in LAND-OC-FIX round 5 §2 and by
the user's decision #2 of 2026-10-08 (round 12). It adds no second rule.

- **One judged run is the verdict (USER DECISION #2, 2026-10-08).** A CPU
  budget breach fails the run it happened in: the `overCapRunsBeforeRed`
  streak and the "recorded, not red" spread band are deleted
  (engine/src/shared/budget-verdict.ts `cpuCap`). The same-tree spread
  survives only as the measuring tool's outlier line (D-17), never as a
  verdict's allowance; the rolling baseline is fed only by runs whose own CPU
  outcome passed, so it cannot climb on failing runs (round 13).

- **When a breach passes.** A budget gate's breach that persists from the
  target passes only while both of these hold:
  - an open task row declares the budget, by its config key, for example
    `testExecution.webUiSuiteCpuBudget`, matched as a whole token
    (engine/src/workflow/failure-owners.ts);
  - this change's value is no higher than the LOWEST value the target's tree
    recorded.
- **Every recorded row counts, on both sides
  ([NO-LOAD-BLOCK](NO-LOAD-BLOCK-nothing-is-blocked-by-cpu-load.md), built
  2026-10-22).** A judged value is CPU work, valid whatever else ran on the
  host, so no row is refused for having shared the cores: the `heavySlot`
  stamp and its "unslotted" refusal and filters are deleted, and a legacy
  row's stamp is ignored.
- **A target with no run is measured first.** The workspace measures the
  target (`ensureTargetBaselines`) and then judges strictly. A target whose
  runs carry no value of a budget an open row owns is measured too, through
  the one sequencer (its suite's producers first: the web suite's perf
  profile). There is no allowance and no re-run.
- **The web-UI performance budgets are judged here, and only here**
  (coordinator, LAND-OC-FIX round 9; UR-16). Their names and kinds are one
  list (`ROOT_POLICY.workflow.webPerformanceBudgets`). The web reporter reads
  the profile report's measurements (scripts/testing/performance-measurements.ts),
  records them in the run's row and fails a breach by its gate
  (`performance:<name>`); the regression gate's arms judge only the report's
  integrity, never a budget. A report that cannot be judged — absent or of
  other code (`judgeableProfileReport`, the one predicate) — FAILS the run
  (`performance-report`): an unmeasured budget is never a pass, and the
  workspace judge counts any non-pass outcome of a budget gate as a breach
  (round 12). A WALL-TIME budget (`WEB_PERFORMANCE_WALL_SIGNALS`: LCP, long
  tasks, switch, typing, response and render times) is a recorded signal,
  never a verdict (NO-LOAD-BLOCK, ruling of 2026-10-22): its outcome says its
  value beside its budget and never fails a run.
- **What fails.** All of the following fail:
  - a breach with no value on either side;
  - a worse value;
  - an unowned breach;
  - any budget gate that `ROOT_POLICY.workflow.failureOwners.budgets` does not
    name.
- **A read-only validation passes no breach.** It has no target to own one
  against.
- **No ambient-load allowance.** The user removed it on 2026-10-07
  (UD-AUDIT-NO-FORGIVENESS); it is deleted from code and configuration
  (2026-10-22). No cap moves with host load; the load legs are printed beside
  every verdict as recorded signals.
