---
id: D-17
date: 2026-09-28
by: coordinator
group: process
status: in-force
implementation: partial
route: A4-OWNED-BUDGET
acted_in: [scripts/testing/measure-web-budget.ts, engine/src/shared/budget-verdict.ts, tests/helpers/budget-config.ts]
---
# Measured budgets come from their measuring tool

A measured budget (the web test-runtime budget, a per-file ceiling) is a
generated value: a measuring tool records it from N clean runs, owned by a
generator, and it is never edited by hand (see
[UR-02](UR-02-generated-values-come-from-generators.md)). A reading is CPU
work (`calibrated-work/v1`), valid whatever else ran on the host: it is never
refused, adjusted or tuned for load
([NO-LOAD-BLOCK](NO-LOAD-BLOCK-nothing-is-blocked-by-cpu-load.md)).

The web budget's tool is `npm run budget:measure -- --check|--write`
(`scripts/testing/measure-web-budget.ts`, arithmetic `measureBudgetFloor` in
`engine/src/shared/budget-verdict.ts`): the median of the last
`baselineWindowRuns` clean judged full runs of the current population, as
recorded, written through the config-path writer. A row's legacy `heavySlot`
field is ignored: there is no slot to have held.

**The ambient-load allowance is removed (the user's decision of 2026-10-07,
[UD-AUDIT-NO-FORGIVENESS](UD-AUDIT-NO-FORGIVENESS-no-rerun-forgiveness-no-ambient-allowance.md)),
built 2026-10-22 with NO-LOAD-BLOCK's measurement half.** No cap and no
reading is scaled by host load: the configuration keys
(`ambientInflationSlopePerCpu`, `ambientInflationCapFraction`), the envelope
in `engine/src/shared/budget-verdict.ts` and its signals are deleted. The
recorded load legs ride beside each reading as signals ("recorded, not
judged" on every verdict line). The calibrated metric's validity bound
(`validThroughLoad5PerCpu`) stays: past it a verdict is NOT JUDGED (said,
never a pass, never a wait), because the metric's residual was not measured
there.

Until `baselineWindowRuns` runs of the current population are recorded the
tool answers `unmeasurable` with the count, and the re-derivation waits for
them.

The rows it measures are the eligible rows (one rule, `eligibleBudgetReadings`:
not a mutation run, the current population within the declared drift, none of
the gate's own failures other than its population arm, each reading as
recorded), and one outlier line
(`sameTreeSpreadFraction`) drops an overloaded outlier against the window's
own median (a stale floor cannot be the reference of its own re-derivation).
The ROLLING BASELINE reads the same eligible rows, but a row feeds it only if
its OWN CPU outcome passed (the outcome it recorded, and its reading within
the cap in force at its moment): a run that failed the cap never moves the
cap (round 13, design HIGH 1). With the floor as its lower bound, the rolling
baseline therefore never rises above the floor; only this tool moves the
floor. The spread is never a verdict's allowance (one judged run over the cap
fails, UR-24-BUDGETS).
