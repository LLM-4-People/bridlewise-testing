# process

The `engine/test/process/` folder of the development surface.

## What each file does

- `bounded-run.test.ts` — the one bounded run (`runCpuBounded`, under `SubprocessBounds`): a command's process group is stopped past its CPU budget, on a stall (no output and CPU under the floor) and past its output bound, never for progress however long; an instant exit is never unowned or unmeasurable; a stopped run answers only once its group is gone; the kernel's CPU limit ends a process that left the group; SIGXCPU, a poller under the floor and the wall backstop each end as named; every bound is pinned by a test a mutation turns red.
- `confinement-canary.test.ts` — the one test-execution door's canary: a write into the checkout or HOME is EROFS under every runner of the engine suite; a runner that ran it unconfined turns it red.
- `environment-projection.test.ts` — the one environment projection: exact names and `PREFIX*` pass, a bare `*` is refused, and the engine command tool's child never sees a key this process holds.
- `launcher-watch.test.ts` — a run never outlives its launcher: `watchLauncher` fires once a real launcher (a shell waiting on the watched process, as `npm run` waits) exits, with its pid, and never while it lives; a recorded command is stopped with SIGTERM when its `stop` signal aborts (also before the start), and an unaborted one runs as before.
- `network-under-test.test.ts` — a test run dials nothing but this machine, at the socket: the platform fetch, `http.request` and `net.connect` to a public address (by address and by name) are refused in a guarded process, loopback is reached, only a consented live host passes, and both runners that arm the checkout write door install the guard.
- `supervised-run.test.ts` — the one test-run supervisor, over the real native primitive: a detached grandchild never survives a supervised command, its fd-3 report is passed through, a stop reaches the command before the kill, the engine worker's recorded launch runs supervised, and a malformed receipt is refused.
- `checkout-confinement.test.ts` — the confined test run (`runTestCommand`): the whole filesystem read-only (the checkout, beside it, HOME and the trusted state; writes, chmods, utimes, links, HEAD moves in a repository and a linked worktree are EROFS) but the run's scratch and the declared places; the mounts locked (no remount, no detach, a submount read-only too); no same-user service reachable by its well-known places (the service manager, an abstract socket, a loopback port; fresh /run, /run/user, /tmp; only a loopback); each writable-place refusal, the door's and the native supervisor's own (a link, outside the checkout, a hard-linked file); never an unconfined run (exit 125); on the live checkout the configuration bootstrap reads it and an up-to-date make writes nothing; a refusing host is a typed refusal.
- `worker-bootstrap.test.ts` — a bootstrapped worker thread of a parent started on eval input with `--input-type` (both forms) starts, runs its entry and is still held by the prelude's fault policy: node hands the thread that option, which a file entry refuses.

## Where it lives and what consumes it

The folder lives at `engine/test/process/`.
