# Harness verbs

The `engine/src/workflow/commands/` folder holds the `harness` verbs, one module
per verb, and nothing else. A module here IS a verb: it must export exactly one
value, `COMMAND`, a `HarnessCommand` (`src/workflow/harness-command.ts`) named
after its file. The generator (`scripts/verification/command-registry.ts`) imports every
module and refuses one that exports anything else
(`command_registry_invalid`), so a verb can never vanish from the CLI silently.
The registry the CLI dispatches through, `src/workflow/harness-verbs.ts`, is
generated from this folder by `harness sync` (#221). Adding a verb touches its
own new module and two generated lines, never a hand-kept list or a dispatch
chain.

## What each file does

- One module per verb, named after it (`check.ts`, `sync.ts`, `regenerate.ts`,
  `register.ts`, `flake.ts`, `workspace.ts`, …) — exports `COMMAND`, with its
  own argument parser. Its heavy owner is imported inside `run`, so the CLI's
  start stays light.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/workflow/commands/`.

- `benchmark.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `check.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `deletions.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `diagnostic.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `eval.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `evidence.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `extension.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `flake.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `forge.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `format.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `frozen.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `index.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `metrics.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `new-module.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `promote.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `regenerate.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `register.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `release.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `rollback.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `slot.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `sync.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `test.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `timeline.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.
- `workspace.ts` is consumed by `engine/src/workflow/harness-verbs.ts`.

<!-- /consumers:generated -->
