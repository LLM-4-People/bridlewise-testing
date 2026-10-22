# workspaces

The `engine/test/workspaces/` folder of the development surface.

## What each file does

- `conflict-detection.test.ts` — the static write-set conflict detection the admission check consumes.
- `timeline-shard.test.ts` — the `timeline-shard.test` module.
- `workspace-concurrency.test.ts` — one registry and lock pair per repository seen from every worktree, concurrent
  admission (exactly one of two overlapping creates), read-only workspaces, `extend`, merge-lock contention and
  stale-lock recovery, a destroyed worktree, lease expiry and the sweep of quarantined (locked) worktrees.
- `workspace-contracts.test.ts` — the closed v4 records (the forge state and its land in flight among them), the state machine, the receipt hash, the derived
  never-leasable set and the read-only lease invariants.
- `fake-forge.ts` — a fake forge over a real bare repository (the workspace's remote): the Git Data API writes real
  objects there, pull requests are kept in memory with the forge's own refusals, a merge queue with GitHub's
  semantics (an enqueue only at the expected head, a moved head leaves the queue, the queue's merge a real merge
  commit on the base), every call is recorded.
- `workspace-forge-github.test.ts` — the port's GitHub implementation through the forge client's own transport,
  against the forge port's fake GitHub: the Git Data API requests (no identity in a commit), the compare-and-swap
  branch move and its read-back, the one GraphQL read of a pull request, the enqueue and the refusals it answers or
  keeps as errors, the pull request's lifecycle, the remote-URL reading and the CLI factory's refusal of a remote
  that is not the trunk.
- `workspace-land.test.ts` — `ws land` against the fake merge queue: the land and its receipt, the local follow
  (and a refused one, receipted), the preconditions, every guard each in its own test (a moved head, a closed pull
  request, the changed set judged against the forge's trunk, an unconfirmed merge, an idempotent finish), the probes
  of a forge that queued or merged another head, the queue's own verdicts, the wait budget and its resume, and
  abort closing the pull request.
- `workspace-forge.test.ts` — publishing on the forge: signed twins with the local trees (modes, links, nested paths),
  no identity in a commit request, the local branch moved to the twins, one draft pull request with a generated body,
  later rounds (only new blobs), merges of the trunk and rebases, a crashed round's pull request and twins adopted,
  the compare-and-swap branch move (another writer's commits, diverged or racing, never overwritten), the ready gate
  on every round, concurrent publishes, a deletion's mode, an adopted pull request's base, `ready`, and every refusal
  (no forge, read-only, dirty, unleased, empty, unsigned, each of the three wrong objects, a changed or missing
  upstream).
- `workspace-integration.test.ts` — the flow on real git: create, validate (`--full`), the merge in the workspace,
  the land (fast-forward into a DIRTY checkout that keeps every entry, refusal on overlap or a moved target, the
  ref compare-and-swap, `merge.autostash` ignored, a refused land kept `validating`), land targets (the upstream
  trunk, never the local name), a base off the
  target and a merged-in branch (the fork-point changed set), the lease exempting a regeneration and never an
  authored edit, generated-output conflicts, the merge's own pending-lease and staleness checks, the regenerate
  phase's declared writes, convergence, setup, placement, the like-for-like ledger baseline, the record
  compare-and-swap, recovery of a dead integrator, the timeline import and the teardown failures.
- `workspace-migration.test.ts` — the one record migration chain v2 → v3 → v4 and per-version storage over real v2
  records (`fixtures/v2-records/`, copied from a host registry: arrays trimmed, home paths replaced) and v3 records
  of this code's own workspaces: deterministic, receipts kept verbatim, migrated in memory and NEVER rewritten
  (every v2 file byte-identical after list, create, publish and sweep; each store holding only its own version); a
  v2-only and a v3-only workspace READ-ONLY to every saving or destructive verb (real ones: abort, extend,
  validate, publish, ready, land, merge, recover, snapshot and an expired sweep refuse, the worktree, branch and
  record intact, no current twin); the sweep reporting an orphaned live one.
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
