# process

The `engine/test/process/` folder of the development surface.

## What each file does

- `environment-projection.test.ts` — the one environment projection: exact names and `PREFIX*` pass, a bare `*` is refused, and the engine command tool's child never sees a key this process holds.
- `instrument-lock.test.ts` — the host's ONE instrument lock: two heavy runs serialize (the second waits, naming the holder), a crashed holder frees it, a run inside a hold borrows it whatever its label holds (backslash, TAB, long command), a door killed outright leaves it held until the command it supervised is gone, a light run takes nothing, the stamp is read from the live holder (an environment cannot forge it), and the lock is never in a checkout.
- `launcher-watch.test.ts` — a run never outlives its launcher: `watchLauncher` fires once a real launcher (a shell waiting on the watched process, as `npm run` waits) exits, with its pid, and never while it lives; a recorded command is stopped with SIGTERM when its `stop` signal aborts (also before the start), and an unaborted one runs as before.
- `network-under-test.test.ts` — a test run dials nothing but this machine, at the socket: the platform fetch, `http.request` and `net.connect` to a public address (by address and by name) are refused in a guarded process, loopback is reached, only a consented live host passes, and both runners that arm the checkout write door install the guard.
- `supervised-run.test.ts` — the one test-run supervisor, over the real native primitive: a detached grandchild never survives a supervised command, its fd-3 report is passed through, a stop reaches the command before the kill, the engine worker's recorded launch runs supervised, and a malformed receipt is refused.

## Where it lives and what consumes it

The folder lives at `engine/test/process/`.
