---
id: NO-LOAD-BLOCK
date: 2026-10-15
by: user
group: process
status: in-force
implementation: partial
route: TEST-10X
acted_in: [engine/src/process/instrument-lock.ts, engine/src/process/subprocess-bounds.ts, engine/scripts/tooling/test-run-lock.ts, engine/src/workflow/slot-cli.ts]
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

Built (2026-10-22): heavy runs are admitted at once under per-run caps — a
cgroup v2 scope per supervised command (memory ceiling, CPU weight) and the
harness's CPU-time limit — and never wait for each other
(`engine/src/process/instrument-lock.ts`); a host that cannot cap a run
refuses it. The harness's script subprocesses are bounded by CPU work and one
hang backstop, never a wall timeout (`engine/src/process/subprocess-bounds.ts`).

What is missing: the measurement half. The `held` stamp, the "unslotted is
refused" rule and the held filters still stand (audit A-04, A-05, A-07, A-12),
the suite budget verdict still defers a saturated host as provisional
(`engine/src/shared/budget-verdict.ts`), and the browser speed gates still
judge wall milliseconds until UI-CPU lands (they become recorded signals).
