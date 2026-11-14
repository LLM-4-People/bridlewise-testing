---
schema: bridlewise-tracker-item/v1
published: false
id: BOUNDED-SIGXCPU-STALL-BURN-DOWN
type: Task
state: open
lane: flaky-burn-down
owner-role: engine process maintainer
severity: P1
area: [process supervision, retained failure memory]
horizon: now
decisions: [FLAKE-REPRO, UR-24, UR-18]
tests: [engine/test/process/bounded-run.test.ts, engine/test/prevention/flaky-test-memory.test.ts]
evidence: repo:actions/runs/43597843498/job/132456055220
opened: 2026-11-14
---

Retain the bounded-run SIGXCPU classification failure from pull request #810 as an owned red suspect. This task owns the retained failure, its engine burn-down entry and the later cause investigation, same-condition reproduction or explicit disposition. The original stop and native-exit ordering and the causal defect remain unknown.

The exact producer failure identity is:

``test/process/bounded-run.test.ts::the endings no budget decides, each pinned: SIGXCPU is `cpu-rlimit`; a poller doing any CPU work is progressing, never stalled; a run past the wall backstop is hung``

The Engine job for author head d0c4b4b07b283197d1259ced5c1d319c3ae083f8 reported ERR_ASSERTION at engine/test/process/bounded-run.test.ts:149:10: the SIGXCPU case expected cpu-rlimit and received stalled. The declaration starts at line 145. The retained structured diagnostic lists five failures. It does not establish which stop decision or native event occurred first, whether the group was already gone when termination was requested, or the actual terminator result. Do not infer the cause from the assertion or from a later passing run.

The exact retained structured producer error yields failure digest `7ab42ddc5f65e235` and location `650fbc2e54ee81c4` through the unchanged production failure readers. These identify the retained diagnostic; they do not assert that an original native run-history row exists. The committed bounded-run test file is keyed whole by SHA-256 `68c0ddc3b34ae11e48ac74e23cfbe272168f798bc16c7a30cb3ca5a48d24a743`. A complete native execution receipt, run-history row and measured execution closure are not available from this log, so none is fabricated.

Guarded by engine/test/prevention/flaky-test-memory.test.ts; the suspect's test is engine/test/process/bounded-run.test.ts. Add this exact identity and owner to the existing engine list in the same first native commit that adds this task's genuinely new generated open board row. Preserve every existing list entry, including the separate projector owner, and retain the failing producer evidence. An in-memory generated row does not prove the same-commit history rule.

Establish the real cause at the existing bounded-run and termination owners, preserve the observed facts through their canonical diagnostics, and prove any causal correction through the existing same-condition reproduction door before declaring a truthful Flake-cause. Diagnostics, split case identities, a changed-subject pass or owned-red retention do not establish the original ordering or clear its failure. If the retained failure cannot be explained through the current door, retain it owned and use the FLAKE-REPRO E-01 / GC-0 disposition route. Never remove the entry because a later run passes, a cache is cold, a target once failed or the host state changed.

The current bounded-run recurrence remains a blocking failure against the target comparison until the normal judgement establishes otherwise. This owned-red entry does not waive UR-24 for a new or changed failure, any budget, independent review or the normal landing gates.
