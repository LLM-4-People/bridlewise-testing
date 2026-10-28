# Shared debug system

The centralized debug, error, and audit system — the single entry point for
all debug logging, error handling, and audit events across the harness.
Everything goes through here; when debug is off, debug calls are ignored.

## What each file does

- `debug-system.ts` — the central debug/error/audit system itself.
- `debug-config.ts` — the single source of truth for the debug system's
  configuration, composed into the central config contract.

## Where it lives

The folder lives at `engine/src/shared/debug/`.
