# Text

The text-processing layer: the canonical authority for translating between UTF-16 code-unit offsets and UTF-8 byte offsets, owned once so every consumer agrees on the same mapping. It also owns the canonical JSON repair for model tool-call arguments (`json-repair.ts`): a weak model's almost-JSON output (fences, control chars, unclosed braces, trailing commas, single quotes, smart quotes, Python literals, NaN, comments) is repaired at the transport boundary before any tool sees it. Valid JSON passes through byte-identical — the repair never mangles a well-formed payload.

## What each file does

- `json-repair.ts` — the json-repair module.
- `utf8-offsets.ts` — Canonical shared UTF-16-code-unit ↔ UTF-8-byte offset authority.
- `yaml-emit.ts` — THE ONE YAML EMITTER (GH-9's, #56; decided in #103): a JSON value as deterministic block-style YAML for every generated file GitHub reads (the workflows, the community forms), proven to read back as its value under YAML 1.1 and 1.2 (`tests/public/yaml-emit-round-trip.test.mjs`); what it cannot hold is a typed refusal.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/text/`.

- `json-repair.ts` is consumed by `server/llm/llm-bridge.ts`.
- `utf8-offsets.ts` is consumed by `engine/scripts/verification/authority/occurrence-selectors.ts`, `engine/src/editor/edit-operations.ts`, `engine/src/privacy/redaction-engine.ts`.
- `yaml-emit.ts` is consumed by `engine/src/workflow/community/health-files.ts`, `engine/src/workflow/gates/workflows.ts`.

<!-- /consumers:generated -->
