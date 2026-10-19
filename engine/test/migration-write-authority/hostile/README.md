# hostile

The `engine/test/migration-write-authority/hostile/` folder of the development surface.

## What each file does

- `01-two-process-races.test.ts` — mWA Tranche 4 — Hostile.
- `02-semantic-ref-conflicts.test.ts` — mWA Tranche 4 — Hostile.
- `03-reader-writer.test.ts` — mWA Tranche 4 — Hostile.
- `04-stale-forged-fences.test.ts` — mWA Tranche 4 — Hostile.
- `05-heartbeat-pid-clock.test.ts` — mWA Tranche 4 — Hostile.
- `06-drift-boundaries.test.ts` — mWA Tranche 4 — Hostile.
- `07-crash-boundaries.test.ts` — mWA Tranche 4 — Hostile.
- `08-partial-unknown.test.ts` — mWA Tranche 4 — Hostile.
- `09-direct-write-rejection.test.ts` — mWA Tranche 4 — Hostile.
- `10-observer-interruption.test.ts` — mWA Tranche 4 — Hostile.
- `11-rollback-revert.test.ts` — mWA Tranche 4 — Hostile.
- `harness.ts` — mWA Tranche 4 — hostile qualification matrix: shared test harness.
- `worker.ts` — mWA Tranche 4 — hostile qualification matrix: two-process worker.

## Where it lives and what consumes it

The folder lives at `engine/test/migration-write-authority/hostile/`.
