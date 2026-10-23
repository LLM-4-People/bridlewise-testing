# setup

The `tests/setup/` folder of the development surface.

## What each file does

- `concurrency-lock.ts` — tHE VITEST DOOR OF THE ONE-INSTRUMENT LOCK. Every way of running the web suite — `npx vitest run`, `npm test`, `npm run test:raw`, watch mode — loads….
- `dev-server-freshness.ts` — a DEV SERVER THAT PREDATES THE LAST HEAD CHANGE IS REFUSED, NOT JUDGED. ── THE INCIDENT ──────────────────────────────────────────────────────────….
- `e2e-concurrency-lock.ts` — the `e2e-concurrency-lock` module.
- `perf-concurrency-lock.ts` — the `perf-concurrency-lock` module.
- `playwright-concurrency-lock.ts` — oNE SHARED BODY FOR BOTH PLAYWRIGHT DOORS. Playwright's `globalSetup` must be a module path, so each config gets its own three-line door that names….
- `source-tree-immutable.ts` — tHE SUITE MAY NOT MODIFY FIRST-PARTY SOURCE. Measured once, then measured again, at the one place that runs exactly once per suite. ── THE INCIDENT….
- `test-cpu-class.ts` — the web suite's per-test judgement: each test's CPU work against its file's class ceiling (`testExecution.testCpuClasses`, TEST-CPU-CLASSES), never its wall time; a test at the hang backstop is reported `hung`.
- `test-setup.ts` — vitest setup file — the isolation contract under `isolate: true`. `vitest.config.ts` pins `isolate: true`.
- `real-database-refusal.ts` — a browser suite never drives a real database (UD-S15): `armPlaywrightRun` arms each Playwright run like every runner (the checkout write door's marker, a private key home; the e2e API server's own database paths) and `refuseRealApiServer` (the shared global setup) refuses a server whose `/api/health` says it serves a `product` database.

## Where it lives and what consumes it

The folder lives at `tests/setup/`.
