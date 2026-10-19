# Node v24.18.0 linux-x64 source

The manifest pinning the Node.js runtime.

## What each file does

- `manifest.json` — the pinned runtime manifest: the exact Node.js
  v24.18.0 linux-x64 build and its digest, the runtime the slice evidence
  was produced under.

## Where it lives and what consumes it

The folder lives at `engine/traceability/sources/runtime/node-v24.18.0-linux-x64/`.
The runtime verifiers read the manifest; the engine's engines field requires
this Node range.
