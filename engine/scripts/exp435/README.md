# EXP435 — context-trim comparison

The EXP435 comparison: C16 (evict-to-zero) against C09 plus summary, for context-trim token efficiency versus continuity.

## What each file does

- `compare.mjs` — the comparison runner.
- `run-5000.sh` — the 5000-run wrapper for the long-task runner.

## Where it lives and what consumes it

The folder lives at `engine/scripts/exp435/`. These are experiment runners and artifacts, driven by hand during the experiment; the validated techniques are promoted into the engine source.
