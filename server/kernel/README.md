# Kernel domain

The kernel domain owns the shared infrastructure every other server domain
builds on: the typed error hierarchy, the single import point for the engine's
schemas and invariants, and content hashing. Nothing here depends on a specific
feature — these are the primitives the features share.

## What each file does

- `errors.ts` — the server typed error hierarchy, mirroring the engine's, so
  every thrown error carries a type and a code the router maps to a status.
- `canonical.ts` — the single server-side import point for the engine's
  schemas and root policy. Nothing reaches into `engine/` directly; it goes
  through this door.
- `digest.ts` — the single owner of "hash this text the way the harness does",
  so a digest is computed one consistent way everywhere.
- `config.ts` — the server's operational configuration owner: the resolved
  values the running server uses.
- `harness-config.ts` — the reader owner for the `bridlewise.config.json`
  document, with the per-feature accessors every module reads its tunables
  through. Every accessor answers from ONE resolved snapshot, never the file
  (`readSettingsDocument` is the whole snapshot, read-only, for readers that
  parse a section themselves): the router refreshes it once at the start of
  every request (`refreshSettingsSnapshot`, never throws), every run at its
  start, the store watch (`watchSettingsStore`, armed at boot, a registered
  `settings-watch` component) when the file changes, and the server's own
  saves swap it. A document that goes bad after boot — unreadable, or removed
  after it was read — keeps the LAST GOOD snapshot in force and refuses every
  save and raw read (`config_unreadable`, 503); one that decodes but weakens
  the privacy section is kept out the same way as `refused`. Each is a state
  (`getSettingsStoreState`, the `settings.storeState` signal), every
  transition logged through the always-on sink.
- `boot-settings-preflight.ts` — imported first by `server/index.ts`: at boot
  there is no last good snapshot, so an unreadable or refused settings file is one typed
  refusal line and exit 78 (EX_CONFIG), before any module reads the settings
  at load.
- `process-fault-policy.ts` — the web server's door to the one process fault policy (`engine/src/process/fault-policy.ts`, role `server`: a lost rejection or a guarded callback fault is counted and reported and the server lives; an uncaught exception exits 70): `server/index.ts`'s FIRST import, before the settings preflight; its import graph (the policy, the fault description, the debug system) reads no settings file at load.

## Where it lives

The folder lives at `server/kernel/`.
