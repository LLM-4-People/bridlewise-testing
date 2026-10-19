# EXP433 — tool results in memory

The experiment artifacts for EXP433: storing tool results in memory with
semantic retrieval to save tokens.

## What each file does

- `EXPERIMENT.md` — the experiment write-up: the question, the method, the
  results.
- `exp433-results.json` — the measured results.
- `merge-manifest.json` — the merge manifest recording what the experiment
  changed.

## Where it lives and what consumes it

The folder lives at `engine/scripts/exp433/`. The experiment record consumes
these; the techniques it validated were promoted into
`engine/src/memory/unified/`.
