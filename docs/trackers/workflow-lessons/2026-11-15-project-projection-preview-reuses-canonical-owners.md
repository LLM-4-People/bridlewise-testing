---
id: L-2026-11-15-project-projection-preview-reuses-canonical-owners
date: 2026-11-15
source: GitHub Projects read-only projection host implementation
kind: guard
status: acted
acted_in: [engine/src/workflow/forge/cli.ts, engine/src/workflow/forge/projector/command.ts, engine/src/workflow/forge/projector/apply.ts, engine/test/forge/projection-command.test.ts]
---

## Observation

The generic GitHub projector already owns committed-source parsing, confined computation, adoption reads and field planning. A CLI host must compose those owners rather than create a second projection, Git view or API client.

## Lesson

The projection preview uses the actual exported production composition and an explicit native object repository. A hostile ordinary view is the positive control; removing only the production wrapper must break the native-source oracle. The preview shares apply's first read while preserving apply's second read and store-local state.

## Change

Candidate metadata is not a completed board audit or an apply receipt. Unknown Project, baseline, adoption, pull-request, main-health and CPU scopes remain explicit. Source computation finishes before the host acquires credentials or reads the live store. New test files include their existing mechanically required README entry through a normal path-ownership handoff; the unfinished source work remains preserved.
