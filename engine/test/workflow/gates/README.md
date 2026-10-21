# gates

The `engine/test/workflow/gates/` folder of the development surface: the gate catalogue's owner (`src/workflow/gates/`) on planted trees, plans and reports.

## What each file does

- `yaml.test.ts` — the one YAML emitter: plain scalars only where no reader could take them for anything else (quoted otherwise, GitHub's `${{ … }}` left bare), slug keys bare, block indentation, literal blocks with the right chomping, null as the bare key, a pin's version comment, determinism, and the typed refusal of anything unrepresentable.
- `workflows.test.ts` — the workflow generator: the file list is the one declaration, every file carries the header and is deterministic, the live tree's folder is exactly the output, a planted hand edit (the runbook P3.1 check), a deleted file and a hand-added file are drift the check step fails on and sync repairs, a tree without the folder is stale; every workflow passes the lint and each lint refuses its planted violation (with the `env:` near miss allowed); the CI job graph, `publish.yml`'s ordered queue and CodeQL's three languages.
- `plan.test.ts` — the plan and the populations: deterministic longest-first packing, the cell budget shared by weight, a plan covering each population exactly once (the whole engine suite one cell, weights `unmeasured`), a plan of another shape refused; the web population from the runner's globs less the named exclusions, a stale exclusion and an empty population refused, the engine population from the inventory.
- `cells.test.ts` — one cell and the seal: a light gate on its planned tree (its log as `{gateLog}`, the first failing step ending it, another tree refused), the vitest report judged by its rows with every refusal the old shard merge made, a web shard and the engine cell, and the seal's receipt with each way a run can lie about its coverage, an action gate's events, a signal gate recorded but never judged, and the job outcomes read from `toJSON(needs)`.
