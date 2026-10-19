# config

The `engine/test/config/` folder of the development surface.

## What each file does

- `config-consistency.test.ts` — the `config-consistency.test` module.
- `config-contracts.test.ts` — the `config-contracts.test` module.
- `config-implementation-consistency.test.ts` — the `config-implementation-consistency.test` module.
- `config-platform.test.ts` — the `config-platform.test` module.
- `config-root-snapshot.test.ts` — what a configuration bootstrap holds the root by: work inside an excluded entry (the state directory) leaves the snapshot unchanged; replacing or re-moding it, or touching a held entry, changes it.
- `config-schema-diagnostics.test.ts` — the `config-schema-diagnostics.test` module.
- `config-sections.test.ts` — the `config-sections.test` module.
- `git-enums-dry.test.ts` — the `git-enums-dry.test` module.

## Where it lives and what consumes it

The folder lives at `engine/test/config/`.
