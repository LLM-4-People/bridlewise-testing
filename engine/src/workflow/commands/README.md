# Harness verbs

The `engine/src/workflow/commands/` folder holds one file per `harness` verb.
Each verb file declares itself, and the registry the CLI dispatches through is
generated from the folder (#221). Adding a verb touches its own new file and two
generated lines of `registry.ts`, never a hand-kept list or a dispatch chain in
`harness-commands.ts`.

## What each file does

- `command.ts` — the contract: `HarnessCommand` (`{ verb, run(context) }`), the
  `CommandContext` a verb is handed (the harness root, its own arguments, the
  progress sink), and `unknownFlag`, the one refusal of a flag a verb does not
  take.
- One file per verb, named after it (`check.ts`, `sync.ts`, `regenerate.ts`,
  `register.ts`, `flake.ts`, `workspace.ts`, …) — exports `COMMAND`,
  with its own argument parser. Its heavy owner is imported inside `run`, so
  the CLI's start stays light.
- `prune-options.ts` — the `--prune <test path>` option that `regenerate` and
  `sync` share.
- `command-registry.ts` — THE GENERATOR: `declaredVerbs` reads each file's
  code through the source-view owner, and a verb declared in a file named
  otherwise is refused (`command_registry_invalid`). `commandRegistryText`
  writes the registry, and `syncCommandRegistry` is the check and write arm
  of `harness sync` and `harness check` (the `command-registry` step).
- `registry.ts` — GENERATED, never edited by hand: one import and one list
  entry per verb, in verb order (`HARNESS_COMMANDS`). It is wholly generated,
  so a merge conflict on it takes either side and regenerates.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/workflow/commands/`.

- `benchmark.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `check.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `command-registry.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `command.ts` is consumed by `engine/src/workflow/commands/benchmark.ts`, `engine/src/workflow/commands/check.ts`, `engine/src/workflow/commands/deletions.ts`, `engine/src/workflow/commands/diagnostic.ts`, `engine/src/workflow/commands/eval.ts`, `engine/src/workflow/commands/evidence.ts` and 21 more.
- `deletions.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `diagnostic.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `eval.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `evidence.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `extension.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `flake.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `forge.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `format.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `frozen.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `index.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `metrics.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `new-module.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `promote.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `prune-options.ts` is consumed by `engine/src/workflow/commands/regenerate.ts`, `engine/src/workflow/commands/sync.ts`.
- `regenerate.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `register.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `registry.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `release.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `rollback.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `slot.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `sync.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `test.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `timeline.ts` is consumed by `engine/src/workflow/commands/registry.ts`.
- `workspace.ts` is consumed by `engine/src/workflow/commands/registry.ts`.

<!-- /consumers:generated -->
