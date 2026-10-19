# performance

The `engine/test/performance/` folder of the development surface.

## What each file does

- `benchmark-runner.test.ts` — the `benchmark-runner.test` module.
- `diagnostic-modes.test.ts` — the `diagnostic-modes.test` module.
- `engine-instrumentation.test.ts` — the engine-span decoration owner's unit arms: every function export wrapped unless reviewed-excluded, no-context pass-through, in-context span, error path, shapes-never-values canary, re-entrancy suppression.
- `function-manifest.test.ts` — the `function-manifest.test` module.
- `metrics-collector.test.ts` — the `metrics-collector.test` module.
- `performance-config.test.ts` — the `performance-config.test` module.
- `performance-extra.test.ts` — the `performance-extra.test` module.
- `performance-hostile.test.ts` — the `performance-hostile.test` module.

## Where it lives and what consumes it

The folder lives at `engine/test/performance/`.
