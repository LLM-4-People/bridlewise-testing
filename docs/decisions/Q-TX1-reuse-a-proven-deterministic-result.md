---
id: Q-TX1
date: 2026-10-15
by: user
group: process
status: in-force
implementation: pending
route: TEST-10X
---
# A deterministic test file's result may be reused

Re-running a test file whose content has not changed, and which is proven to
give the same answer every time, spends machine time to learn nothing new. So
such a file's result may be reused, under checks that catch a reuse that
should not have happened.

The user, 2026-10-15: "yes".

- A test file's result may be reused when the file is proven deterministic:
  its current content has passed repeated runs through the flake door's
  runner ([FLAKE-REPRO](FLAKE-REPRO-a-flake-cause-needs-a-recorded-reproduction.md)).
  Amended the same day by [NO-LOAD-BLOCK](NO-LOAD-BLOCK-nothing-is-blocked-by-cpu-load.md):
  the proof holds under any load, judged on CPU work and events, never wall
  time.
- It takes one seeding pass, then re-proof of only the changed files. Flaky
  files are never reused.
- A random sample of reused files is re-run on every validation; a scheduled
  nightly cold run audits; a mismatch evicts the entry and raises an alarm.

What is missing: not built yet. Every validation runs every file.
