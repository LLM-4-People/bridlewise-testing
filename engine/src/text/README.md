# Text

The text-processing layer: the canonical authority for translating between UTF-16 code-unit offsets and UTF-8 byte offsets, owned once so every consumer agrees on the same mapping. It also owns the canonical JSON repair for model tool-call arguments (`json-repair.ts`): a weak model's almost-JSON output (fences, control chars, unclosed braces, trailing commas, single quotes, smart quotes, Python literals, NaN, comments) is repaired at the transport boundary before any tool sees it. Valid JSON passes through byte-identical — the repair never mangles a well-formed payload.

## What each file does

- `json-repair.ts` — the json-repair module.
- `utf8-offsets.ts` — Canonical shared UTF-16-code-unit ↔ UTF-8-byte offset authority.
- `yaml-emit.ts` — THE ONE YAML EMITTER for every generated file GitHub reads as YAML (the forms; the generated workflows): block style, insertion-ordered keys, a plain scalar only where no YAML 1.1 or 1.2 reader can read it as anything else, literal blocks for multi-line text, double quotes otherwise with every character a reader folds or refuses raw escaped, reserved words quoted as keys too, numbers only in a form every reader reads back, `Commented` for a trailing comment; anything else is `yaml_unrepresentable`. Its round trip is `tests/public/yaml-emit-round-trip.test.mjs`.

## Where it lives

The folder lives at `engine/src/text/`.
