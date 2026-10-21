# Text

The text-processing layer: the canonical authority for translating between UTF-16 code-unit offsets and UTF-8 byte offsets, owned once so every consumer agrees on the same mapping. It also owns the canonical JSON repair for model tool-call arguments (`json-repair.ts`): a weak model's almost-JSON output (fences, control chars, unclosed braces, trailing commas, single quotes, smart quotes, Python literals, NaN, comments) is repaired at the transport boundary before any tool sees it. Valid JSON passes through byte-identical — the repair never mangles a well-formed payload.

## What each file does

- `json-repair.ts` — the json-repair module.
- `utf8-offsets.ts` — Canonical shared UTF-16-code-unit ↔ UTF-8-byte offset authority.
- `yaml-emit.ts` — THE ONE YAML EMITTER: a JSON-shaped value as deterministic block YAML for every generated file GitHub reads (the workflows, the community forms): key order kept, plain identifier keys, plain scalars only where unambiguous and double-quoted otherwise, literal blocks for multi-line text, `Commented` pin comments, leading `#` comment lines; what it cannot hold is `yaml_value_unrepresentable`.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/text/`.

- `json-repair.ts` is consumed by `server/llm/llm-bridge.ts`.
- `utf8-offsets.ts` is consumed by `engine/scripts/verification/authority/occurrence-selectors.ts`, `engine/src/editor/edit-operations.ts`, `engine/src/privacy/redaction-engine.ts`.
- `yaml-emit.ts` is consumed by `engine/src/workflow/gates/workflows.ts`.

<!-- /consumers:generated -->
