# Gates

The gate catalogue and everything generated from it: the ONE declaration of
what "qualified" means, the generated GitHub Actions workflows, and the verbs
those workflows call (`harness gates`). Local and CI differ only in where a
gate runs, never in what it runs (github-only §5.1).

Every file under `.github/workflows/` is generated here. Edit the owner, then
run `harness sync`; `harness check` refuses a hand edit, a stale file, or any
other file in that folder.

## What each file does

- `catalogue.ts` — THE CATALOGUE (`bridlewise-gate-catalogue/v1`): each gate's id, title, class (`light`, `suite`, `action`), role (`required` or `signal`), the argument vectors it runs (never a shell string), its toolchain, its reuse eligibility, a suite's population and split; the action pins (`ACTION_PINS`, full commit SHAs); the runner classes; the shard budget under the hosted-job cap; the population exclusions with their reasons; `validateCatalogue`, `gateById`, `gatesOfClass`.
- `workflows.ts` — THE GENERATOR: `ci.yml` (plan, the light job's background steps, the shard matrix, the action gates, the seal), `codeql.yml`, `publish.yml`, `audit.yml`, each a document emitted as YAML under the generated header; `lintWorkflow` (full-SHA pins from `ACTION_PINS`, `permissions:` everywhere, no expression inside `run:`, no `pull_request_target`, `merge_group` beside `pull_request`, a `main` run never cancelled); `syncGeneratedWorkflows`, the check and write arm of `harness sync`.
- `yaml.ts` — the one deterministic YAML emitter (a JSON-shaped value to block YAML; `Commented` for an action pin's version comment); anything it cannot represent is a typed refusal.
- `populations.ts` — the suites' test files, from the owners the runners read: the web runner's `TEST_INCLUDE` globs over the tree's files, and the engine's test inventory; a stale exclusion is a refusal.
- `plan.ts` — `planGates`: the plan of one tree (`bridlewise-gate-plan/v1`): the gates, the populations, and the shard cells (longest-first packing into equal weight, the cell budget shared by weight); `weights.basis` says whether the weights were measured; `parsePlan`, `matrixCells`, `catalogueDigest`.
- `run.ts` — `runLightGate` and `runShard`: one cell, on the planned tree only, its steps spawned without a shell and logged, its result (`bridlewise-gate-result/v1`) written on every ending; a web shard is judged by its vitest report, the engine suite by its runner's exit and summary.
- `vitest-report.ts` — the one judgement of a web shard's vitest JSON report: the rows, not the summary, are the record; the files run are exactly the planned files.
- `seal.ts` — `sealReceipt`: every result merged into one receipt (`bridlewise-gate-receipt/v1`), with the missing, duplicate, unexpected, wrong-commit, failed and coverage refusals; `renderReceipt`, the table the job summary shows.
- `gates-cli.ts` — `harness gates list|plan|run|shard|seal`.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/workflow/gates/`.

- `catalogue.ts` is consumed by `engine/src/workflow/gates/gates-cli.ts`, `engine/src/workflow/gates/plan.ts`, `engine/src/workflow/gates/populations.ts`, `engine/src/workflow/gates/run.ts`, `engine/src/workflow/gates/seal.ts`, `engine/src/workflow/gates/workflows.ts`.
- `gates-cli.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `plan.ts` is consumed by `engine/src/workflow/gates/gates-cli.ts`, `engine/src/workflow/gates/run.ts`, `engine/src/workflow/gates/seal.ts`.
- `populations.ts` is consumed by `engine/src/workflow/gates/gates-cli.ts`, `engine/src/workflow/gates/plan.ts`.
- `run.ts` is consumed by `engine/src/workflow/gates/gates-cli.ts`, `engine/src/workflow/gates/seal.ts`.
- `seal.ts` is consumed by `engine/src/workflow/gates/gates-cli.ts`.
- `vitest-report.ts` is consumed by `engine/src/workflow/gates/run.ts`.
- `workflows.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `yaml.ts` is consumed by `engine/src/workflow/gates/workflows.ts`.

<!-- /consumers:generated -->
