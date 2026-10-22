---
id: TESTS-TEST-THEMSELVES
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: pending
route: TTT
---
# Tests test themselves

A test that passes on the old code as well as the new one proves nothing
about the change it was written for. So a test a model writes is accepted only
when the harness has shown, by running it, that it fails before the change
and passes after it.

The user's rule of 2026-10-10 (stated with
[HARNESS-DRIVES](HARNESS-DRIVES-the-harness-drives-the-model-creates.md)):
a model-written test is valid only if the harness replays it on the OLD code
and it FAILS there, then passes on the new code, mechanically and
deterministically.

- The replay is done by the harness, not claimed by the model.
- It reuses the one flake-reproduction door
  ([FLAKE-REPRO](FLAKE-REPRO-a-flake-cause-needs-a-recorded-reproduction.md))
  rather than a second runner, and it is part of the verified-done gate.

What is missing: not built yet. Nothing in the harness replays a new test on
the parent tree before accepting it.
