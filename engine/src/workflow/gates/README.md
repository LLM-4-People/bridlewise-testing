# Gates

The gate catalogue and everything generated from it: the ONE declaration of
what "qualified" means, the generated GitHub Actions workflows, and the verbs
those workflows call (`harness gates`). Local and CI differ only in where a
gate runs, never in what it runs (github-only §5.1).

Every file under `.github/workflows/` is generated here. Edit the owner, then
run `harness sync`; `harness check` refuses a hand edit, a stale file, or any
other file in that folder.

## What each file does

- `catalogue.ts` — THE CATALOGUE (`bridlewise-gate-catalogue/v1`): each gate's id, title, class (`light`, `suite`, `action`), role (`required` or `signal`), the registry commands it runs through the one runner (never a shell string; a command may take an earlier one's full log), its registry setup commands and system toolchain, its reuse eligibility, a suite's population and split; the action pins (`ACTION_PINS`, full commit SHAs); the runner classes; the shard budget under the hosted-job cap; the population exclusions with their reasons; `validateCatalogue`, `gateById`, `gatesOfClass`, `catalogueCommandNames` (the dead-command check counts the gates as a registry consumer).
- `workflows.ts` — THE GENERATOR: `ci.yml` (plan, the light job's gates in turn on one checkout, the shard matrix, the action gates, the seal; registry setup through `harness gates setup`, every redacted log uploaded), `codeql.yml`, `publish.yml`, `audit.yml`, each a document emitted as YAML (the one emitter, `../../text/yaml-emit.ts`) under the generated header; `lintWorkflow` (full-SHA pins from `ACTION_PINS`, `permissions:` everywhere, no expression inside `run:`, no `pull_request_target`, `merge_group` beside `pull_request`, a `main` run never cancelled); `syncGeneratedWorkflows`, the check and write arm of `harness sync`.
- `populations.ts` — the suites' test files, from the owners the runners read: the web runner's `TEST_INCLUDE` globs over the tree's files, and the engine's test inventory; a stale exclusion is a refusal.
- `plan.ts` — `planGates`: the plan of one tree (`bridlewise-gate-plan/v1`): the gates, the populations, and the cells of both suites (longest-first packing into equal weight, the cell budget shared by weight); `weights.basis` says whether the weights were measured; `parsePlan`, `matrixCells`, `catalogueDigest`.
- `cell-run.ts` — `runLightGate` and `runShard`: one cell, on the planned tree only, its registry commands run by the ONE command runner (`../checkout-setup.ts`: supervised, redacted logs, each command's process-tree CPU time recorded), its result (`bridlewise-gate-result/v1`) written on every ending; a web cell is judged by its vitest report, an engine cell (its sources listed for the runner's `--cell`) by the runner's cell rule and summary.
- `vitest-report.ts` — the one judgement of a web shard's vitest JSON report: the rows, not the summary, are the record; the files run are exactly the planned files.
- `seal.ts` — `sealReceipt`: every result merged into one receipt (`bridlewise-gate-receipt/v1`), with the missing, duplicate, unexpected, wrong-commit, failed and coverage refusals; `renderReceipt`, the table the job summary shows.
- `gates-cli.ts` — `harness gates list|population|plan|setup|run|shard|seal`.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/workflow/gates/`.

- `catalogue.ts` is consumed by `engine/src/workflow/gates/cell-run.ts`, `engine/src/workflow/gates/gates-cli.ts`, `engine/src/workflow/gates/plan.ts`, `engine/src/workflow/gates/populations.ts`, `engine/src/workflow/gates/seal.ts`, `engine/src/workflow/gates/workflows.ts` and 1 more.
- `cell-run.ts` is consumed by `engine/src/workflow/gates/gates-cli.ts`, `engine/src/workflow/gates/seal.ts`.
- `gates-cli.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `plan.ts` is consumed by `engine/src/workflow/gates/cell-run.ts`, `engine/src/workflow/gates/gates-cli.ts`, `engine/src/workflow/gates/seal.ts`.
- `populations.ts` is consumed by `engine/src/workflow/gates/gates-cli.ts`, `engine/src/workflow/gates/plan.ts`.
- `seal.ts` is consumed by `engine/src/workflow/gates/gates-cli.ts`.
- `vitest-report.ts` is consumed by `engine/src/workflow/gates/cell-run.ts`.
- `workflows.ts` is consumed by `engine/src/workflow/harness-commands.ts`.

<!-- /consumers:generated -->
