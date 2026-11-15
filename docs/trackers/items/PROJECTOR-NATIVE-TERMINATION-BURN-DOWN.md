---
schema: bridlewise-tracker-item/v1
published: false
id: PROJECTOR-NATIVE-TERMINATION-BURN-DOWN
type: Task
state: open
lane: flaky-burn-down
parent: PROJECTOR-NATIVE-TERMINATION
owner-role: engine process maintainer
severity: P1
area: [process admission, retained failure memory]
horizon: now
decisions: [FLAKE-REPRO, UR-24, UR-18]
tests: [engine/test/forge/projector.test.ts, engine/test/prevention/flaky-test-memory.test.ts]
evidence: repo:actions/runs/43576533070/job/132391868972
opened: 2026-11-14
---

Retain the original projector termination as an owned red suspect while PROJECTOR-NATIVE-TERMINATION remains the single causal problem record. This child task owns retention, the burn-down entry and the later reproduction or disposition; it does not claim that diagnostics fixed the cause.

The exact producer failure identity is:

`test/forge/projector.test.ts::memory is the admitted run's cgroup cap (the one memory-bounds owner): a program allocating three times its run's memory.max, read from the run's own cgroup, is refused typed projection_memory_exhausted`

The original Engine run for pull request #810 at author head e5d49b001a7a210a2f4ec5018b5626b5c982c151 reported a null child status where zero was expected, before the typed memory-refusal assertion. The child signal, spawn error, execution phase and cause remain unknown. The original summary reports 10,999 tests, 10,998 passing and one failing. A changed diagnostic head passing does not turn this failure into a pass.

The retained producer diagnostic yields failure digest `0a7a9baed697e6a0` and location `650fbc2e54ee81c4` through the unchanged production readers. These values are re-derived from the retained job diagnostic, not evidence that a native ledger row was retained. The known committed test file is keyed whole by source SHA-256 `06f55a5e1666a3ad33dd0d9ea509e423f436c0e10fe61987c248f90d7565bd29`; its tested commit and author head carry Git blob 42a63ff131e4d0aa84e9506fd43f41ff2caad1fe. A complete original execution receipt, native run-history row and measured source closure are not available in the retained summary, so none is fabricated.

Guarded by `engine/test/prevention/flaky-test-memory.test.ts`; the suspect's test is `engine/test/forge/projector.test.ts`. Add the exact identity and this new owner to the existing engine burn-down list in the same commit that first adds this task's generated open board row. Keep the failing producer evidence and this owned-red entry until the existing memory judgement accepts a genuine explanation or an explicit disposition.

Establish and fix the actual cause under the parent Bug, then use the existing same-condition reproduction door and a truthful Flake-cause declaration before claiming it explained. If the retained failure cannot be explained under the current door, retain it owned and follow the FLAKE-REPRO `E-01` / `GC-0` disposition route. Never close this task or remove its entry because a later run passes, the cache was cold, an older target failed, or the host state changed. This entry does not waive UR-24 for a new or changed current failure, any budget, or the normal review and landing gates.
