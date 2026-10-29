# Tools

The tools domain: the tool manifest, registry, and the concurrent dispatcher the run executes tools through.

## What each file does

- `built-in-tool-manifest.ts` — the built-in-tool-manifest module.
- `built-in-tools.ts` — the built-in-tools module.
- `command-reach.ts` — what a model-chosen command can REACH, the one judgement both `execute_command` doors ask: git by what it is (its name, git's own programs, its file under another name), a program launcher, and an argument that launches a program, each refused typed before it runs.
- `tool-adapter.ts` — the tool-adapter module.
- `tool-manifest.ts` — the tool-manifest module.
- `tools-config.ts` — the tools-config module.

## Where it lives

The folder lives at `engine/src/tools/`.
