# llm beyond max

The `engine/test/llm-beyond-max/` folder of the development surface.

## What each file does

- `dedup-v2-keywords.test.ts` — regression test for EXP449: hardcoded.
- `dedup-compress-speed-modules.test.ts` — unit tests for the dedup-v2, compress-v2, and speed-v2 modules.
- `mock-integration.test.ts` — eXP410 — integration tests for the beyond-max modules with a.
- `new-modules.test.ts` — eXP410 — unit tests for the new modules.
- `unit.test.ts` — eXP410 — unit tests for the deterministic pieces.

## Where it lives and what consumes it

The folder lives at `engine/test/llm-beyond-max/`.
