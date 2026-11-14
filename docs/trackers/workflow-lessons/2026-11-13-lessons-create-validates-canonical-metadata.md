---
id: L-2026-11-13-lessons-create-validates-canonical-metadata
date: 2026-11-13
source: repeated invalid lesson kinds found during independent review
kind: tooling
status: acted
acted_in: [engine/scripts/tooling/lessons.ts, tests/prevention/workflow-lessons-format.test.ts]
---

## Observation

Handwritten lesson records repeatedly used kind values outside the existing canonical schema. The pending report could read records but offered no validated creation path.

## Lesson

Generate metadata through the same values and validator used by the commit guard. Reject invalid inputs before the shared editor receives a write, and bind creation to a new file.

## Change

The existing lessons tool exposes typed rendering and creation, derives metadata identity from the canonical filename owner, validates the complete record through lessonViolations, and writes through the existing editor with the shared exclusive atomic writer. CLI choices come from the canonical allowed values. Tests exercise valid output, invalid kinds and encoding, no-write refusals, overwrite refusal, and CLI options. The normal commit guard still judges staged path membership and malformed records; this tool does not prevent arbitrary Markdown edits on disk.
