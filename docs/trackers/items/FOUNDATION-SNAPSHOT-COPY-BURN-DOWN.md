---
schema: bridlewise-tracker-item/v1
published: false
id: FOUNDATION-SNAPSHOT-COPY-BURN-DOWN
type: Task
state: open
lane: flaky-burn-down
owner-role: engine test-evidence maintainer
severity: P1
area: [test evidence, owned snapshots, retained failure memory]
horizon: now
decisions: [FLAKE-REPRO, UR-24, UR-18]
tests: [engine/test/foundation-cascade.test.ts, engine/test/prevention/flaky-test-memory.test.ts]
evidence: repo:actions/runs/43665134038/job/132662706578
opened: 2026-11-15
---

Retain the foundation snapshot-copy failure from pull request #810 as an owned red suspect. This task owns the exact failure identity, its engine burn-down entry, the missing filesystem observations and the later cause investigation, same-condition reproduction or explicit disposition. The original filesystem operation and actor remain unknown.

The exact retained producer identity is:

``test/foundation-cascade.test.ts::[FC-E002] worker catalog executor and output mutations cannot fabricate evidence``

For pull request author head 67422eb3081f0c8e0d3b8e192107b44c6ce8b09e, [the retained Engine producer][repo:actions/runs/43665134038/job/132662706578] failed at step 10. The test declaration is engine/test/foundation-cascade.test.ts:167:1. The thrown error is located at engine/test/support/planned-node-test-evidence.ts:210:7: ERR_TEST_FAILURE caused by ENOENT while copying a snapshot. Its reported path ends in planned-node-test-session-13/source-snapshot/.git/objects, a destination of that copy. The retained stack reaches the Node internal copyDir operation at cp-sync:145:22.

The retained underlying message is 235 UTF-8 bytes with SHA-256 `7dc9c238517c0cb4afc32be4df5383902b9a03989e9a8d9bca433149e0ad4094`. This is a message digest, not a canonical run-history failure digest or location. The retained projection does not provide syscall, errno, source or destination fields, before/after directory identities, the deletion actor, a native ledger row or its execution closure. Do not manufacture those values from the author head or transfer separate Visual checkout provenance into Engine evidence. The reported destination path does not prove that the original source object store was missing or corrupt.

Guarded by engine/test/prevention/flaky-test-memory.test.ts; the suspect's test is engine/test/foundation-cascade.test.ts. Add this exact identity and owner to the existing engine list in the same first native commit that adds this task's genuinely new generated open TASKS row. Preserve every existing list entry and the retained failed producer. A preview or edited existing row is not same-commit history proof. Generate the row through the existing tracker generator.

Investigate through the existing snapshot-copy and owned-temporary owners. Bounded known-field copy diagnostics must preserve the original error, cause and code and leave a failed copy failed. A deterministic fault-injection control can prove those diagnostics and their privacy; it does not reproduce or explain this producer's original ENOENT. A later complete changed-subject pass does not erase that failure. Git housekeeping, external cleanup and native copy behavior are hypotheses until supported by actual observations or causal controls.

Keep this task and its entry open until a genuine recorded cause correction, move, regeneration or the existing FLAKE-REPRO E-01 / GC-0 disposition explains it. No Flake-cause declaration, current-versus-target exception, new or changed failure waiver, budget forgiveness or extra execution gate follows from ownership or diagnostics. Every later current recurrence still receives the normal UR-24 judgement. All five separate bounded-run signal-witness failures and the original bounded/projector investigations remain distinct retained work.

<!-- BEGIN GENERATED: repository links, from the repository identity (harness sync; engine/src/workflow/forge/repository-identity.ts) -->
[repo:actions/runs/43665134038/job/132662706578]: https://github.com/LLM-4-People/bridlewise-testing/actions/runs/43665134038/job/132662706578
<!-- END GENERATED: repository links -->
