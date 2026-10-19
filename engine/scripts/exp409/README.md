# EXP409 — context-trim sweep

The experiment scripts for EXP409: sweeping context-trim percentage and step
count to find the combination that holds up at 10× scale.

## What each file does

- `sweep.mjs` — the sweep orchestrator: defines the fractional-factorial
  combination set and runs it.
- `run-escalate.mjs` — the 10×-harder escalation launcher: runs the winning
  combination at 5000 turns.

## Where it lives and what consumes it

The folder lives at `engine/scripts/exp409/`. These are experiment runners,
driven by hand during the experiment; the results feed the experiment record.
