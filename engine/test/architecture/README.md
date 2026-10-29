# architecture

The `engine/test/architecture/` folder of the development surface.

## What each file does

- `architecture-baseline-clean.test.ts` — the live repository's architecture verification reports zero unclassified architecture or audit-matrix violations (the routine-tier registration of the s1 scenario battery's control arm, owned in the scenario support module).
- `ceiling-consistency.test.ts` — the `ceiling-consistency.test` module.
- `dead-export-scanner.test.ts` — the `dead-export-scanner.test` module.
- `dead-package-scanner.test.ts` — the `dead-package-scanner.test` module.
- `no-duplicate-module-basenames.test.ts` — no Scattered Helpers — duplicate-module-basename mechanical test.
- `no-math-random-ids.test.ts` — the `no-math-random-ids.test` module.
- `production-graph-scoped-allowances.test.ts` — the production graph's owner-scoped allowances: `node:worker_threads` only in the synchronous bounded run's two owners (any other module is refused), and the worker prelude's gated load as the one non-literal module load admitted.
- `scan-excluded-dependency.test.ts` — the scan universe and the import universe are.

## Where it lives and what consumes it

The folder lives at `engine/test/architecture/`.
