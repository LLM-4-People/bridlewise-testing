# Tools domain

The tools domain owns the tools the model can call: the manifest that lists
them, the one executor that dispatches them, and the UI-control contract that
lets the model drive the interface. Adding a tool means registering it in the
manifest; the executor and the UI pick it up automatically.

## What each file does

- `tools-bridge.ts` — the one canonical registry of every tool the web UI
  exposes.
- `tool-executor.ts` — the one executor; every manifest tool has a handler
  here, and tools run in the project directory with path safety enforced.
- `ui-control.ts` — the single owner of the `control_interface` tool action
  schema, the contract by which the model drives the UI.

## Where it lives

The folder lives at `server/tools/`.
