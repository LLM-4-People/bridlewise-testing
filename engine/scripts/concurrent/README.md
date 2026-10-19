# Concurrent scripts

The worker-thread entry scripts for the engine's concurrent tool dispatch
benchmarks and verification.

## What each file does

- `worker-entry.mjs` — the worker-thread entry point: sends a ready
  handshake on startup so the pool knows the worker is live.
- `worker-handlers.mjs` — the CPU-bound tool handlers that run inside the
  worker threads to escape Node's single-threaded event loop.

## Where it lives and what consumes it

The folder lives at `engine/scripts/concurrent/`. The concurrent-dispatch
benchmarks spawn these as worker entry points.
