# workspaces

The `engine/test/workspaces/` folder of the development surface.

## What each file does

- `conflict-detection.test.ts` — the static write-set conflict detection the admission check consumes.
- `timeline-shard.test.ts` — the `timeline-shard.test` module.
- `workspace-concurrency.test.ts` — one registry and lock pair per repository seen from every worktree, concurrent
  admission (exactly one of two overlapping creates), read-only workspaces, `extend`, two simultaneous lands,
  merge-lock contention on the local follow (the land happened; recover finishes it) and stale-lock recovery, a destroyed worktree, lease expiry and the sweep of quarantined (locked) worktrees.
- `workspace-contracts.test.ts` — the closed v4 records (the forge state and its land request among them), the state machine, the receipt hash, the derived
  never-leasable set and the read-only lease invariants.
- `fake-forge.ts` — a fake forge over a real bare repository (the workspace's remote): the Git Data API writes real
  objects there, pull requests are kept in memory with the forge's own refusals, the async merge API and a merge
  queue that merges with real git (or fails a group, or holds it), every call is recorded.
- `workspace-forge.test.ts` — publishing on the forge: signed twins with the local trees (modes, links, nested paths),
  no identity in a commit request, the local branch moved to the twins, one draft pull request with a generated body,
  later rounds (only new blobs), merges of the trunk and rebases, a crashed round's pull request adopted, `ready`,
  and every refusal (no forge, read-only, dirty, unleased, empty, forge branch ahead, unsigned, wrong object, a
  changed or missing upstream).
- `workspace-integration.test.ts` — the flow on real git: create, validate (`--full`), publish, ready, the land
  through the queue and the local follow (fast-forward into a DIRTY checkout that keeps every entry, a refused
  follow recorded on overlap, on local commits or under `merge.autostash`, the ref compare-and-swap), land targets
  (the upstream trunk), the land's preconditions, a base off the target and a merged-in branch (the fork-point
  changed set), the lease exempting a regeneration and never an authored edit, the land's own pending-lease,
  staleness and dynamic-overlap checks, a file/directory conflict the queue dequeues, convergence, setup,
  placement, the like-for-like ledger baseline, the record compare-and-swap, the timeline import and the
  teardown failures (finished by recover).
- `workspace-land.test.ts` — the land through the forge's merge queue: a refused request, a dequeue, a head pushed
  after the request, a land that outlives its wait (resumed by `land`, looked at by `recover` and `sweep`), the
  follow to a trunk tip past the merge, an already merged pull request, abort's and the lease sweep's closed pull
  request, a trunk moved by a disjoint land.
- `workspace-overlay.test.ts` — `create --overlay` of a dirty linked worktree (its index byte-identical, the
  overlay equal to what `git add -A` would commit), the adoption of the landed trunk, and its refusals (stale — files, index only or
  target only —, a staged version or a kept staged deletion the snapshot cannot carry, a move-loss, a clean
  checkout, another target).
- `workspace-test-support.ts` — temp repositories on a bare forge remote (`trackBranch`, `pushTrunk`), the fake forges
  (`forgeAt`, `advanceEveryQueue`), the recording fake command runner, the manager factory and `landWorkspace`.
- `worktree-port.test.ts` — the pinned port's argument vectors, refusals as data, hostile inputs and the projected
  hook environment; the promotion candidate's operations (`merge -s ours` of a commit, `read-tree --reset`,
  stage-all answering the tree, missing objects), the dated identity, and the harness's own refs (create only
  when absent, delete only at the old value, never a branch, tag or remote-tracking ref).
- `write-set-proof.test.ts` — the write-set path arithmetic (prefix boundaries, the regeneration-only exemption).

## Where it lives and what consumes it

The folder lives at `engine/test/workspaces/`.
