# Traceability self-protection

The published self-protection artifacts.

## What each file does

- `guardian-spec-schema.json` — the published schema of the Landlock
  guardian ruleset spec. The bundle build writes it; the guardian bootstrap
  validates compiled specs against it.

## Where it lives and what consumes it

The folder lives at `engine/traceability/self-protection/`. It is written
by `engine/scripts/build-bundle.ts` and by `harness regenerate` / `harness
sync` (through `engine/scripts/verification/guardian-spec-artifact.ts`, which
rebuilds the projection from the live `GUARDIAN_SPEC_SCHEMA`), and read by the
self-protection bootstrap and the slice projections. `harness check` refuses a
published artifact that differs from a fresh in-memory projection, and the
root-policy `specSchemaArtifactSha256` pin binds the published bytes.
