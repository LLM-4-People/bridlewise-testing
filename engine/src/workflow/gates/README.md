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
- `workflows.ts` — THE GENERATOR: `ci.yml` (plan, the light job's gates in turn on one checkout, the shard matrix, the action gates, the seal; registry setup through `harness gates setup`, every redacted log uploaded), `codeql.yml`, `publish.yml`, `audit.yml`, `door.yml`, each a document emitted as YAML under the generated header; `lintWorkflow` (full-SHA pins from `ACTION_PINS`, `permissions:` everywhere, no expression inside `run:`, no `pull_request_target`, `merge_group` beside `pull_request`, a `main` run never cancelled); `syncGeneratedWorkflows`, the check and write arm of `harness sync`.
- `key.ts` — THE REUSE KEY K (`bridlewise-gate-key/v1`): the tree, the catalogue's digest, the toolchain (the Node version file and the running Node, both lockfiles, the runner image), the config's digest, the runner class and its capability probes (CPU model, cgroup v2, Landlock, user namespaces, a CPU counter unit); its canonical bytes are the door attestation's subject, their sha256 is K; `treeKeyInputs` is what the door re-derives from a commit.
- `reuse.ts` — reuse by K: the verdict locator (`door-verdict-<K>-<success|failure>`, found by its exact name), the eligibility (never a fork, a CI-changing tree, a cold run, or a key with a failed verdict on record), the proof (`gh attestation verify` output judged against K and the door's predicate), and the one path-object reader the pipeline-owner comparison and the ratchet share.
- `main-integrity.ts` — THE POST-LAND SEAL: a `main` commit is sealed only when it carries the door App's successful `bridlewise/door` check keyed by K and the door's proven verdict for K names that commit's tree; each other case is a finding of the `bridlewise/main-integrity` job. The generator emits the job, and the push trigger that runs it alone, only once `DOOR_ENFORCED` is flipped with the trunk ruleset (P3.7).
- `populations.ts` — the suites' test files, from the owners the runners read: the web runner's `TEST_INCLUDE` globs over the tree's files, and the engine's test inventory; a stale exclusion is a refusal.
- `plan.ts` — `planGates`: the plan of one tree (`bridlewise-gate-plan/v1`): the gates, the populations, and the cells of both suites (longest-first packing into equal weight, the cell budget shared by weight); `weights.basis` says whether the weights were measured; `parsePlan`, `matrixCells`, `catalogueDigest`.
- `cell-run.ts` — `runLightGate` and `runShard`: one cell, on the planned tree only, its registry commands run by the ONE command runner (`../checkout-setup.ts`: supervised, redacted logs, each command's process-tree CPU time recorded), its result (`bridlewise-gate-result/v1`) written on every ending; a web cell is judged by its vitest report, an engine cell (its sources listed for the runner's `--cell`) by the runner's cell rule and summary.
- `vitest-report.ts` — the one judgement of a web shard's vitest JSON report: the rows, not the summary, are the record; the files run are exactly the planned files.
- `seal.ts` — `sealReceipt`: every result merged into one receipt (`bridlewise-gate-receipt/v1`), with the missing, duplicate, unexpected, wrong-commit, failed and coverage refusals; `renderReceipt`, the table the job summary shows.
- `gates-cli.ts` — `harness gates list|population|plan|reuse|main-integrity|setup|run|shard|seal`.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/workflow/gates/`.

- `catalogue.ts` is consumed by `engine/src/workflow/door/judge.ts`, `engine/src/workflow/door/ratchet.ts`, `engine/src/workflow/gates/cell-run.ts`, `engine/src/workflow/gates/gates-cli.ts`, `engine/src/workflow/gates/key.ts`, `engine/src/workflow/gates/plan.ts` and 5 more.
- `cell-run.ts` is consumed by `engine/src/workflow/gates/gates-cli.ts`, `engine/src/workflow/gates/seal.ts`.
- `gates-cli.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `key.ts` is consumed by `engine/src/workflow/door/judge.ts`, `engine/src/workflow/gates/gates-cli.ts`, `engine/src/workflow/gates/plan.ts`.
- `main-integrity.ts` is consumed by `engine/src/workflow/door/door-github.ts`, `engine/src/workflow/gates/gates-cli.ts`.
- `plan.ts` is consumed by `engine/src/workflow/door/door-cli.ts`, `engine/src/workflow/door/judge.ts`, `engine/src/workflow/gates/cell-run.ts`, `engine/src/workflow/gates/gates-cli.ts`, `engine/src/workflow/gates/seal.ts`.
- `populations.ts` is consumed by `engine/src/workflow/gates/gates-cli.ts`, `engine/src/workflow/gates/plan.ts`.
- `reuse.ts` is consumed by `engine/src/workflow/door/door-cli.ts`, `engine/src/workflow/door/door-git.ts`, `engine/src/workflow/door/judge.ts`, `engine/src/workflow/gates/gates-cli.ts`, `engine/src/workflow/gates/main-integrity.ts`, `engine/src/workflow/gates/workflows.ts`.
- `seal.ts` is consumed by `engine/src/workflow/door/judge.ts`, `engine/src/workflow/door/verdict.ts`, `engine/src/workflow/gates/gates-cli.ts`.
- `vitest-report.ts` is consumed by `engine/src/workflow/gates/cell-run.ts`.
- `workflows.ts` is consumed by `engine/src/workflow/door/judge.ts`, `engine/src/workflow/harness-commands.ts`.

<!-- /consumers:generated -->
