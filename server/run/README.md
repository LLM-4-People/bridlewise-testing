# Run domain

The run domain owns the lifecycle of a single LLM run: claiming the run so it
executes once, assembling and sending the prompt, dispatching tool calls,
publishing what the run said to whoever is listening, and the worker pool that
runs CPU-heavy analysis off the main thread. Nothing else in the server spends
money or spawns a general-purpose worker — those two facts are mechanically
enforced against this folder.

## What each file does

- `run-executor.ts` — the only module that spends money. Assembles the prompt,
  calls the provider through the LLM bridge, dispatches tools through the tool
  executor, writes the projection, and records the ledger. The first effect is
  a primary-key claim on `run_executions.run_id`, so a second execution of one
  run is refused by the database before a prompt is assembled.
- `run-feed.ts` — the run frame pub/sub. A run publishes frames here and
  subscribers read them, decoupling the run's lifetime from any single HTTP
  response so a second connection does not start a second execution.
- `run-registry.ts` — the process-global table of in-flight runs. Answers
  "does this run exist and whose is it" for the routes, and holds the mutable
  per-run state the executor accumulates while a turn streams.
- `rewind.ts` — conversation rewind. Retracts or replaces a prior turn and
  re-runs from that point, recording the rewind so the ledger stays append-only.
- `attempt-counter.ts` — the per-tool retry badge logic. A pure helper that
  decides the attempt number shown against each tool call in the run stream.
- `worker-pool.ts` — the owner of general-purpose `node:worker_threads`
  spawning. Bridges call `runWorkerTask(...)`; the pool owns spawning,
  same-key dedup, the per-spawn timeout, and shutdown. The one declared
  exception is the database thread (`db/thread-backend.ts`), which outlives
  every task this pool would run.
- `worker-ipc.ts` — the single owner of the `post` helper the worker entry
  points use to forward a shaped result to the parent thread.

## Where it lives

The folder lives at `server/run/`.
