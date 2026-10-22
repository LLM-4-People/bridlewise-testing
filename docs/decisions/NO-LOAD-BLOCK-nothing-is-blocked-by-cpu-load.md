---
id: NO-LOAD-BLOCK
date: 2026-10-15
by: user
group: process
status: in-force
implementation: pending
route: TEST-10X
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

What is missing: not built yet. Heavy runs still take the one instrument lock
and wait for it, and the suite budget verdict still defers a saturated host
as provisional (`engine/src/shared/budget-verdict.ts`).
