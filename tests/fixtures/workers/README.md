# workers

The `tests/fixtures/workers/` folder of the development surface.

## What each file does

- `bad-payload-worker.ts` — test fixture — a worker that posts `{ ok: true }` with.
- `echo-worker.ts` — test fixture — an echo worker that posts `{ ok: true, value }` back to the parent.
- `hanging-worker.ts` — test fixture — a hanging worker that.

## Where it lives and what consumes it

The folder lives at `tests/fixtures/workers/`.
