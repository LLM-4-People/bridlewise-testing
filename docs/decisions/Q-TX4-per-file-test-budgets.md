---
id: Q-TX4
date: 2026-10-15
by: user
group: process
status: in-force
implementation: pending
route: TEST-10X
---
# Every test file has its own budget

A single budget for the whole suite has to be re-measured every time a file is
added or removed, and it cannot say which file got slower. A budget per file
answers both: the suite's budget is just the sum, and a new file is measured
as part of the runs that happen anyway.

The user's choice of 2026-10-15: option (B), per-file budgets.

- Each test file has its own measured budget, in CPU work
  ([Q-TX2](Q-TX2-budgets-count-cpu-work.md)), and the suite's budget is their
  sum.
- A new or changed file is measured within the runs that already happen, so a
  change in the test population never needs a dedicated burst of runs.
- The ratchet only goes down.

What is missing: not built yet. The web suite's budgets judge the supported
set as a whole (the average CPU per test file, and each file's share of the
worker pool); no file has its own measured budget, and the suite's budget is
not their sum.
