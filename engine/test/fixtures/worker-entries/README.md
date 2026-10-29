# worker entries

The `engine/test/fixtures/worker-entries/` folder of the development surface.

## What each file does

- `load-failure.mjs` — a declared worker entry that fails to load: its thread ends with the fault exit code (70).
- `lost-rejection.mjs` — a declared worker entry that loses a rejection: a `worker` thread fails closed (exit 70), a `server-thread` lives on.
- `role-probe.mjs` — a declared worker entry that reports the fault role its prelude installed and its own `workerData`.
- `up.mjs` — a declared worker entry that starts and answers `up`.

## Where it lives and what consumes it

The folder lives at `engine/test/fixtures/worker-entries/`. Each file is declared in `DECLARED_WORKER_ENTRIES` (`engine/src/process/worker-bootstrap.ts`), the only entries a bootstrapped thread may start on. `engine/test/process/worker-bootstrap.test.ts`, `tests/prevention/guarded-callbacks.test.ts` and `tests/unit/process-fault-policy.test.ts` start threads on them.
