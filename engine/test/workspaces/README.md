# workspaces

The `engine/test/workspaces/` folder of the development surface.

## What each file does

- `conflict-detection.test.ts` — the static write-set conflict detection the admission check consumes.
- `timeline-shard.test.ts` — the `timeline-shard.test` module.
- `workspace-concurrency.test.ts` — one registry and lock pair per repository seen from every worktree, concurrent
  admission (exactly one of two overlapping creates), read-only workspaces, `extend`, merge-lock contention and
  stale-lock recovery, a destroyed worktree, lease expiry and the sweep of quarantined (locked) worktrees.
- `workspace-contracts.test.ts` — the closed v2 records, the state machine, the receipt hash, the derived
  never-leasable set and the read-only lease invariants.
- `workspace-integration.test.ts` — the flow on real git: create, validate (`--full`), the merge in the workspace,
  the land (fast-forward into a DIRTY checkout that keeps every entry, refusal on overlap or a moved target, the
  ref compare-and-swap, `merge.autostash` ignored, a refused land kept `validating`), land targets, a base off the
  target and a merged-in branch (the fork-point changed set), the lease exempting a regeneration and never an
  authored edit, generated-output conflicts, the merge's own pending-lease and staleness checks, the regenerate
  phase's declared writes, convergence, setup, placement, the like-for-like ledger baseline, the record
  compare-and-swap, recovery of a dead integrator, the timeline import and the teardown failures.
- `workspace-overlay.test.ts` — `create --overlay` of a dirty linked worktree (its index byte-identical, the
  overlay equal to what `git add -A` would commit), the adoption, and its refusals (stale — files, index only or
  target only —, a staged version or a kept staged deletion the snapshot cannot carry, a move-loss, a clean
  checkout, another target).
- `workspace-test-support.ts` — temp repositories, the recording fake command runner and the manager factory.
- `worktree-port.test.ts` — the pinned port's argument vectors, refusals as data, hostile inputs and the projected
  hook environment; the promotion candidate's operations (`merge -s ours` of a commit, `read-tree --reset`,
  stage-all answering the tree, missing objects), the dated identity, and the harness's own refs (create only
  when absent, delete only at the old value, never a branch, tag or remote-tracking ref).
- `write-set-proof.test.ts` — the write-set path arithmetic (prefix boundaries, the regeneration-only exemption).

## Where it lives and what consumes it

The folder lives at `engine/test/workspaces/`.
