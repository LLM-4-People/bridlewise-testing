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

## Current recurrence and separate arbitration defect

At author head 9f20863ffcaf413d5993814f0175b24c7458c285, [the current Engine job][repo:actions/runs/43615214562/job/132508659040] again reported cpu-rlimit expected and stalled received at line 149. The original SIGXCPU stop/native-exit ordering and terminator result remain unknown. This recurrence is retained as a failed current producer.

A separate controlled generic case reproduces an arbitration gap: the leader has exited naturally with status zero, the owned group is empty when a stall is requested, and the actual terminator reports GONE, yet the old classifier returns stalled. The paired control with a quiet live member in the same group passes and confirms that remaining owned work must still be bounded and cleaned up. This is a different, observed natural-exit branch; it is not a reproduction of the original line-149 SIGXCPU ordering.

The narrow repair targets only that no-op stalled request after a known native ending and empty group when termination reports GONE. A stop that actually terminates owned work, and CPU, output, hung or unmeasurable limits, retain their existing precedence. Requested-stop and actual-termination diagnostics remain distinct. No original-failure explanation is claimed by this record.

Both this Task and PROJECTOR-NATIVE-TERMINATION-BURN-DOWN remain open with their existing entries retained. No Flake-cause declaration, failed-run forgiveness or new/changed-failure exception follows from the controlled pair, diagnostics or changed-subject qualification. Normal source-relevant qualification and the existing reproduction or disposition route still govern closure.

## Accepted changed-subject qualification

Under the same controlled protocol, the old empty-group case is red while the live-group companion is green; with the narrow correction both cases pass (2/2). A separately authorized complete run of engine/test/process/bounded-run.test.ts passes all 18 cases, including its two SIGXCPU cases, under unchanged caps without name filtering, a private preload or an extra probe. These results qualify the changed private subject on that host.

This evidence does not establish the original line-149 stop/native-exit ordering, turn its retained failure into a pass, or give qualification credit to the separate unplanned incident. The original entry stays owned and open. A new recurrence on a later current subject still blocks until the normal judgement establishes otherwise. No Flake-cause, budget forgiveness, broader goal closure or additional execution gate is introduced.

<!-- BEGIN GENERATED: repository links, from the repository identity (harness sync; engine/src/workflow/forge/repository-identity.ts) -->
[repo:actions/runs/43615214562/job/132508659040]: https://github.com/LLM-4-People/bridlewise-testing/actions/runs/43615214562/job/132508659040
<!-- END GENERATED: repository links -->
