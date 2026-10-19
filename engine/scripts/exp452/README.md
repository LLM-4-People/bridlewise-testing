# EXP452 — billion-token memory

The EXP452 benchmark: memory at a billion tokens (~5M entries) on the sharded SQLite + FTS5 inverted index.

## What each file does

- `run-exp452.mjs` — the benchmark runner.

## Where it lives and what consumes it

The folder lives at `engine/scripts/exp452/`. These are experiment runners and artifacts, driven by hand during the experiment; the validated techniques are promoted into the engine source.
