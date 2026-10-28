---
id: TEST-CONFINEMENT-SELF-BIND
date: 2026-10-28
by: coordinator
group: engine
status: in-force
implementation: done
acted_in: [engine/guardian/test-process-supervisor.c, engine/src/process/supervised-run.ts, engine/src/filesystem/linux-path.ts, engine/src/git/repository-ownership.ts, engine/src/filesystem/checkout-write-door.ts, engine/scripts/tooling/run-tests.ts, engine/scripts/tooling/test-guards.ts, scripts/run-tests.ts]
---
# A test run sees its checkout read-only; a self-bind is not a mountpoint

The coordinator's decisions of 2026-10-28, following #293 and #132. A test
process changed the live configuration's ctime (a same-mode chmod through a
fixture's link into the live engine), and a concurrent commit guard's
configuration bootstrap refused an unrelated commit.

- **The checkout is read-only to every test run, by the kernel.** Each
  runner's workers are started by the one supervisor
  (`engine/src/process/supervised-run.ts`, `readOnlyCheckout`) in a user and
  mount namespace. There, the checkout and every directory its git state lives
  in are read-only binds of themselves: the git directory, the common one (a
  linked worktree's lies outside the checkout) and the borrowed object
  directories. The only exceptions are the checkout write door's declared
  state directories, bound read-write. A second user and mount namespace locks
  the mounts, so the test can neither remount nor unmount them. Every write,
  chmod, utime, link and rename there is EROFS, for every descendant.
  - The places are computed by the supervisor from the checkout's own facts,
    never passed by a caller.
  - The arrangement is probed before use. A host that refuses unprivileged
    user namespaces gets a typed refusal (`test_confinement_unavailable`)
    naming the one-time fix, and never an unconfined run.
  - The fix is a profile that admits user namespaces for the supervisor binary
    alone (`node engine/guardian/build.ts --apparmor-profile`), never a
    global sysctl. Contributors and the shard jobs in CI use the same setup.
  - Landlock was rejected for this boundary: no ABI governs chmod, chown,
    utimes or xattrs, which were #293's own vector.
- **A self-bind is not a mountpoint.** S1 refuses a mounted runtime root,
  repository root or ancestor, configuration and receipt chain. Those refusals
  exist to stop a path resolving to different content: another filesystem or
  another subtree swapped in. The one mount reader
  (`engine/src/filesystem/linux-path.ts` `readLinuxMountPoints`) therefore
  reports every mount except a self-bind. A self-bind is a mount of the same
  filesystem as a visible mount of that filesystem's root: same major:minor,
  type and source, with its `root` equal to its own mount point's path
  relative to where that root is mounted.
  - A self-bind only changes flags, so it is content-neutral.
  - A bind of another subtree of the same filesystem is still reported, and
    so is every other filesystem.
  - Each entry is judged alone: a non-self-bind mount nested under a self-bind
    is still reported.
  - The planted tables in `engine/test/filesystem/mount-self-bind.test.ts`
    hold all of this. Treating every bind as a self-bind turns them red.
