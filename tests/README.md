# tests

The `tests/` folder of the development surface.

## What each file does

- `declared-root.ts` — eVERY ENTRY AT THIS REPOSITORY'S ROOT **THAT GIT MUST HOLD** — and nothing else. ── WHAT THIS MODULE IS AND IS NOT….
- `test-budget.ts` — tHE TEST RUN'S TIME BUDGETS — one owner, read by the vitest config.
- `test-include.ts` — eVERY DECLARED TEST GLOB — the one declaration, in a module with no weight. ── WHY IT LIVES HERE AND NOT IN `vite.config.ts` ────────────────────────….

## The subfolders

- `cockpit/`
- `fixtures/`
- `helpers/`
- `performance/`
- `prevention/`
- `reporters/`
- `setup/`
- `unit/`

## Where it lives and what consumes it

The folder lives at `tests/`.
