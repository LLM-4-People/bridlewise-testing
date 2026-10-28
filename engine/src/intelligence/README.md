# Intelligence

The intelligence domain: the repository map, dependency graph, symbol search, and retrieval the model's code questions are answered from.

## What each file does

- `action-affinity-config.ts` — Canonical configuration owner for the action-affinity re-ranker.
- `action-affinity.ts` — the action-affinity module.
- `data-flow.ts` — the data-flow module.
- `dependency-graph.ts` — the dependency-graph module.
- `repository-stat-scan.ts` — the stat-scan half of the repository map: the walk limits, the stat-cache baseline types, and the readdir+lstat-only scan + diff that answer "did anything actually change?" WITHOUT reading or parsing a single file.
- `retrieval.ts` — the codebase-file retrieval module.
- `farm-child.ts` — Crash-isolated extract child (init tree-sitter at spawn).
- `js-tokenizer.ts` — the JS/TS tokenizer (`tokenizeWithPositions`, `Token`): identifiers, punctuation, string and template literals (a `${…}` substitution skipped whole, its own strings and templates included), numbers and regex literals (a `/` opens one after an operator, `=>`, a keyword expecting an operand or a statement head's `)`) with their positions, comments dropped. Read by the symbol extractor, the data-flow and TypeScript quality-pack analyses, and the reachability walk (`src/workflow/reachability.ts`: a specifier in a comment or another string is never an edge); kept apart so a consumer that needs tokens loads no tree-sitter.
- `file-slice.ts` — the file-slice module.
- `intelligence-config.ts` — Intelligence operational defaults — the SINGLE canonical owner for.
- `intelligence-types.ts` — the intelligence-types module.
- `language-registry.ts` — Canonical multi-language registry — ONE source of truth for the.
- `multi-import-extractor.ts` — Multi-language import extractor — regex-based dependency detection for.
- `next-edit-prefetch.ts` — the next-edit-prefetch module.
- `process-farm.ts` — Crash-isolated child-process farm for parse/extract.
- `quick-view.ts` — the quick-view module.
- `repository-map.ts` — the repository-map module.
- `reuse-discovery.ts` — the reuse-discovery module.
- `symbol-extractor.ts` — the symbol-extractor module.
- `symbol-search.ts` — the symbol-search module.
- `tree-sitter-backend.ts` — Tree-sitter WASM backend — async-init, sync-parse.
- `tree-sitter-extractor.ts` — Tree-sitter-backed symbol extractor for non-JS/TS languages.

## Where it lives

The folder lives at `engine/src/intelligence/`.
