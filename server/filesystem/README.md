# Filesystem domain

The filesystem domain owns how the server touches the user's files: every
project-scoped read or write is gated here so a route cannot reach outside the
allowed roots. The gate is the choke point — routes and bridges do not check
paths themselves.

## What each file does

- `fs-gate.ts` — the single filesystem access owner. Verifies project path
  ownership, resolves paths within the project root, and refuses traversal
  above it. Every project-scoped route and bridge imports the gate from here.
- `file-read.ts` — the single UTF-8 file-read owner, so the encoding is decided
  once at the lowest level and a caller never restates it.
- `editor-bridge.ts` — file reading and editing for the web UI, providing
  privacy-safe file viewing and the raw read/write primitives the tool
  executor and editor route use.

## Where it lives

The folder lives at `server/filesystem/`.
