# tools

The `engine/test/tools/` folder of the development surface.

## What each file does

- `built-in-tools-timeout-config.test.ts` — the `built-in-tools-timeout-config.test` module.
- `built-in-tools-timeout.test.ts` — the `built-in-tools-timeout.test` module.
- `built-in-tools.test.ts` — the `built-in-tools.test` module.
- `command-reach.test.ts` — what a command can reach: git by its name, git's own programs and its file under another name (a symbolic link, a hard link, another git by its real name); program launchers and interpreters (`awk`, `sed`) by name; every argument that launches a program (`find -exec`, `fd -x`, `rg --pre`, `sort --compress-program`, `cmake -E`), with passing look-alikes.
- `tool-adapter.test.ts` — the `tool-adapter.test` module.
- `tool-manifest.test.ts` — the `tool-manifest.test` module.
- `tools-config.test.ts` — the `tools-config.test` module.

## The subfolders

- `concurrent/`

## Where it lives and what consumes it

The folder lives at `engine/test/tools/`.
