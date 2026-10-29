---
id: TEST-CONFINEMENT-SELF-BIND
date: 2026-10-28
by: coordinator
group: engine
status: in-force
implementation: done
acted_in: [engine/guardian/test-process-supervisor.c, engine/src/process/supervised-run.ts, engine/src/filesystem/linux-path.ts, engine/src/filesystem/checkout-write-door.ts, engine/scripts/tooling/run-tests.ts, engine/scripts/tooling/test-guards.ts, engine/src/workflow/slot-cli.ts, engine/src/workflow/flake-cli.ts, scripts/run-tests.ts, engine/test/prevention/test-runner-door.test.ts]
---
# A test run sees its checkout read-only; a self-bind is not a mountpoint

The coordinator's decisions of 2026-10-28, following #293 and #132. A test
process changed the live configuration's ctime (a same-mode chmod through a
fixture's link into the live engine), and a concurrent commit guard's
configuration bootstrap refused an unrelated commit. Revised the same day after
the four-lens adversarial review of #634 (B1–B12): the whole filesystem is
read-only to a test run, not the checkout alone, under the user's rule that a
malicious module cannot bypass core, by a kernel boundary.

- **One test-execution door, mandatory.** Every test run starts through
  `runTestCommand` (`engine/src/process/supervised-run.ts`), never opt-in per
  caller: the engine runner, the guard runner (`check`, `test:guards`,
  `test:public`, CI's plain steps), the web runner (`npm test`, CI's shards),
  `harness slot run` (coverage, `test:raw`, `test:supported`, `test:e2e`,
  the perf profile), both sides of a flake reproduction, the shard manifest's
  `vitest list`, the consumer-plant re-runs and the merge round's e2e runner.
  `engine/test/prevention/test-runner-door.test.ts` refuses a test runner
  started anywhere else, and a canary in each suite (`confinement-canary`)
  turns red under a runner that ran it unconfined. The live suite
  (`engine/live/`) is the one declared unconfined exception (real host facts);
  a run mixing live and hermetic files is refused. Work that must write the
  checkout (a build, `harness sync`) runs through its own trusted runner,
  never through this door.
- **The whole filesystem is read-only to a test run, by the kernel.** The
  native supervisor (`engine/guardian/test-process-supervisor.c`) enters new
  user, mount, network and IPC namespaces and makes every mount read-only at
  once (`mount_setattr(AT_RECURSIVE, MOUNT_ATTR_RDONLY)` on `/`, the one
  mechanism; a kernel without it is refused, typed, with the remedy). Writable
  are only: the run's own scratch root, outside the checkout, made for the run
  and removed after it (its `TMPDIR`, compile cache, vite and vitest caches,
  key home); the checkout's declared state folders (`.bridlewise/`); and the
  kernel pseudo-filesystems. `/tmp`, `/run` (with `/run/user/$UID`) and
  `/dev/shm` are fresh tmpfs, the network namespace has only its own loopback,
  and every inherited descriptor beyond the standard three (and the result
  channel) is closed. A second user and mount namespace locks the mounts, so a
  test can neither remount nor unmount them.
  - The supervisor enforces its own invariant: it opens each writable place
    without following a link, proves its canonical path from the descriptor,
    refuses one outside the checkout, a scratch root inside it, and any file
    beneath a place with more than one name (a hard link aliasing a read-only
    file), and binds each place from that descriptor. It refuses (exit 125)
    rather than run a command unconfined.
  - The arrangement is probed before every run (`--probe-confinement`). A host
    that refuses gets a typed refusal (`test_confinement_unavailable`) naming
    the step and its remedy, never an unconfined run.
  - On a host whose AppArmor restricts unprivileged user namespaces, the fix
    is a profile for THIS checkout's supervisor at its exact canonical path
    (`node engine/guardian/build.ts --apparmor-install` prints the commands),
    never a global sysctl and never a glob. The path is the user's to write, so
    the profile narrows the exemption to one path; it is not a privilege
    boundary. Each checkout and workspace installs its own.
  - Nothing a test can write is executed or trusted by a later run: caches
    live in the run's scratch and go with it (vite's `configLoader: runner`
    keeps its config bundle out of `node_modules/.vite-temp`).
  - Same-user services are not reachable: the service manager and session
    bus (under `/run/user`), abstract sockets (the network namespace) and
    loopback ports. Every pathname unix socket bound when the run starts
    (read from `/proc/net/unix` before the run's own network namespace) has
    its folder covered by an empty read-only tmpfs, the run's own excepted. A
    folder that cannot be covered without hiding the run's own places, or a
    socket inside the checkout outside its writable places, refuses the run.
    A socket bound after the run starts, or a relative one whose holder has
    since moved, stays reachable until Landlock ABI 9
    (`LANDLOCK_ACCESS_FS_RESOLVE_UNIX`, Linux 7.1) can refuse it (#654).
  - What needs the host's user service manager — a heavy run's admission (a
    cgroup scope) and the long-task runner (`systemd --user`) — is a live-suite
    fact (`npm --prefix engine run test:live:host`, a CI step), never reached
    from a confined run.
  - Landlock was rejected for the filesystem boundary: no ABI governs chmod,
    chown, utimes or xattrs, which were #293's own vector.
- **A self-bind is not a mountpoint.** S1 refuses a mounted runtime root,
  repository root or ancestor, configuration and receipt chain. Those refusals
  exist to stop a path resolving to different content: another filesystem or
  another subtree swapped in. The one mount reader
  (`engine/src/filesystem/linux-path.ts` `readLinuxMountPoints`) therefore
  reports every mount except a self-bind. A self-bind is a mount of the same
  filesystem (major:minor, type and source) as the mount it is mounted on, its
  parent, showing exactly the directory the path named through that parent
  (the parent's own directory joined with the mount point's path beneath it),
  with the parent visible: nothing stacked over it and no mount on the path
  between them.
  - A self-bind only changes flags, so it is content-neutral.
  - A bind of another subtree of the same filesystem is still reported, and
    so is every other filesystem, a shadowed lower directory and a bind onto
    an overmounted parent (review of #634, B11/N11).
  - Each entry is judged alone: a non-self-bind mount nested under a self-bind
    is still reported.
  - The planted tables in `engine/test/filesystem/mount-self-bind.test.ts`
    hold all of this; dropping any one condition turns them red.
