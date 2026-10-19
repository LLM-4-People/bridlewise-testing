# cockpit

The `tests/performance/cockpit/` folder of the development surface.

## What each file does

- `cockpit-perf.spec.ts` — tHE COCKPIT PERFORMANCE SWEEP. One spec, three targets, selected by env so the same measurements can be compared across builds and data scales….
- `preview-server.ts` — a PRODUCTION-SHAPED STATIC SERVER for the built client.
- `probe.ts` — tHE IN-PAGE PROBE — one script, injected before any app code runs, that makes a cockpit boot and every later interaction measurable.

## Where it lives and what consumes it

The folder lives at `tests/performance/cockpit/`.
