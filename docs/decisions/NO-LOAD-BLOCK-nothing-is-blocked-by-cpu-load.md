---
id: NO-LOAD-BLOCK
date: 2026-10-15
by: user
group: process
status: in-force
implementation: partial
route: TEST-10X
acted_in: [engine/src/process/instrument-lock.ts, engine/src/process/subprocess-bounds.ts, engine/scripts/tooling/test-run-lock.ts, engine/src/workflow/slot-cli.ts, engine/src/shared/budget-verdict.ts, engine/src/workflow/workspace-manager.ts, tests/reporters/budget-reporter.ts, scripts/testing/performance-measurements.ts, engine/src/kernel/web-performance-budgets.ts]
overrides: [INSTRUMENT-LOCK, FLAKE-REPRO]
---
# Nothing is ever blocked by CPU load

Waiting for a busy machine to calm down before running, merging or judging
anything means work stalls for reasons that have nothing to do with it, and
on a shared host the wait can be endless. So no task ever waits on, or fails
because of, how busy the machine is: what is judged is the work itself.

The user's standing rule of 2026-10-15: "i never want anything to be blocked
no matter what cpu usage we have" … "no matter what task".

- It applies to EVERY task: merges, validations, tests, builds, lab rounds and
  agent work.
- Every judged measurement in the harness and the labs is load-independent:
  CPU work, not wall time ([Q-TX2](Q-TX2-budgets-count-cpu-work.md),
  [UI-CPU](UI-CPU-browser-gates-judged-in-cpu-work.md)). Wall values are
  recorded signals only.
- No quiet waits or load thresholds anywhere: chains, gates, runners, labs.
- Landings are never queued behind lab runs.
- The one global instrument lock
  ([INSTRUMENT-LOCK](INSTRUMENT-LOCK-the-host-has-one-instrument-lock.md))
  gives way to concurrent runs under per-run caps once measurement is
  load-independent.
- A "flake under load" needs no quiet host to reproduce: a test that fails
  under load is itself a load-dependence defect to fix (CPU work or event
  waits), not a flake to excuse
  ([FLAKE-REPRO](FLAKE-REPRO-a-flake-cause-needs-a-recorded-reproduction.md),
  amended).
- Retroactive: a whole-tree and all-labs audit lists every load-dependent gate
  and wait, and each gets an owned fix.

Built (2026-10-22): heavy runs are admitted at once under per-run caps and
never wait for each other (`engine/src/process/instrument-lock.ts`).
Admission moves the admitting process itself into the run's own cgroup v2
scope (memory ceiling, CPU weight) and under the harness's CPU-time limit, so
everything the run starts — a supervised command or a child spawned directly
— is born under them, and a process borrows a run only from inside its scope:
there is no uncapped path. A host that cannot cap a run refuses it. The harness's script subprocesses are bounded by CPU work and one
hang backstop, never a wall timeout (`engine/src/process/subprocess-bounds.ts`).

Built (2026-10-22), the measurement half: no reading is stamped "held" or
refused "unslotted" — the stamp, its refusals in both suite reporters and the
held filters of the rolling baseline, the measuring tool and the workspace's
budget judgement are deleted (audit A-04, A-05, A-07, A-12); a profile report
is judgeable whatever ran beside it. The ambient envelope is deleted (A-08):
no cap moves with load, and the load legs are printed as recorded signals.
The browser profile's wall-time budgets (LCP, long tasks, switch, typing,
response and render times) are recorded signals only, never a verdict
(`WEB_PERFORMANCE_WALL_SIGNALS`), and the profile takes no exclusivity.

What is missing: the browser's work judged in CPU work
([UI-CPU](UI-CPU-browser-gates-judged-in-cpu-work.md)), which turns those
signals back into gates, and a residual measured past the calibrated metric's
validity bound (`validThroughLoad5PerCpu`): past it a suite budget verdict is
NOT JUDGED (said, never a pass, never a wait).
