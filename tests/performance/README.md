# performance

The `tests/performance/` folder of the development surface.

## What each file does

- `.gitignore` — the `` module.
- `.report.json` — the `.report` module.
- `.run.json` — the `.run` module.
- `profile.spec.ts` — performance profile — the orchestration that drives `PerfHarness` across the cockpit and writes a structured.
- `regression.test.ts` — performance regression gate — reads the.

## The subfolders

- `.cockpit-report/`
- `cockpit/`
- `lib/`
- `scale/`

## Where it lives and what consumes it

The folder lives at `tests/performance/`.
