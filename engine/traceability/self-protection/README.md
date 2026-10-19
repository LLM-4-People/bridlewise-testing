# Traceability self-protection

The published self-protection artifacts.

## What each file does

- `guardian-spec-schema.json` — the published schema of the Landlock
  guardian ruleset spec. The bundle build writes it; the guardian bootstrap
  validates compiled specs against it.

## Where it lives and what consumes it

The folder lives at `engine/traceability/self-protection/`. It is written
by `engine/scripts/build-bundle.ts` and read by the self-protection
bootstrap and the slice projections.
