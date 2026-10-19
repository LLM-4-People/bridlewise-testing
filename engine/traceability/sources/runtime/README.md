# Runtime sources

The pinned runtime manifests.

## The subfolders

- `node-v24.18.0-linux-x64/` — the manifest pinning the Node.js runtime the
  slices were verified against.

## Where it lives and what consumes it

The folder lives at `engine/traceability/sources/runtime/`. The runtime
verifiers read the manifests to bind the environment the evidence was
produced under.
