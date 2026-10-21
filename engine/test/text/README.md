# text

The `engine/test/text/` folder of the development surface — tests for the shared text-processing layer.

## What each file does

- `json-repair.test.ts` — the `json-repair.test` module.
- `yaml-emit.test.ts` — the one YAML emitter: plain scalars only where unambiguous (GitHub's `${{ … }}` bare), quoted otherwise, plain identifier keys (any other refused), block indentation, literal blocks with the right chomping, null as the bare key, pin comments, leading comment lines, determinism, and the typed refusal of anything unrepresentable.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/test/text/`.

- `json-repair.test.ts` is consumed by nothing yet.
- `yaml-emit.test.ts` is consumed by nothing yet.

<!-- /consumers:generated -->
