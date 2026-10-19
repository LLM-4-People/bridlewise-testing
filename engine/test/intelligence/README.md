# intelligence

The `engine/test/intelligence/` folder of the development surface.

## What each file does

- `data-flow.test.ts` — the `data-flow.test` module.
- `dependency-graph.test.ts` — the `dependency-graph.test` module.
- `integration.test.ts` — the `integration.test` module.
- `multi-import-extractor.test.ts` — the `multi-import-extractor.test` module.
- `process-farm.test.ts` — crash-isolation farm: hang/crash contained, culprit named.
- `quick-view-slice.test.ts` — the `quick-view-slice.test` module.
- `repository-map.test.ts` — the `repository-map.test` module.
- `reuse-discovery.test.ts` — the `reuse-discovery.test` module.
- `symbol-extractor.test.ts` — the `symbol-extractor.test` module.
- `tree-sitter-absence-is-an-answer.test.ts` — an unconfigured process initializes the tree-sitter backend from a folder where most wasm candidates are absent (and with a language that has no wasm) and prints nothing: absence is an answer, never a best-effort failure (the 156-line "[debug] diagnostic unavailable" flood per project registration).
- `tree-sitter-js-extract.test.ts` — JS/TS tree-sitter extract; unready is not silent empty.
- `symbol-search-hard.test.ts` — the `symbol-search-hard.test` module.
- `symbol-search-scale.test.ts` — the `symbol-search-scale.test` module.
- `symbol-search.test.ts` — the `symbol-search.test` module.

## Where it lives and what consumes it

The folder lives at `engine/test/intelligence/`.
