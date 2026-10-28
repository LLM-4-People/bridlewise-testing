# Shared tree-sitter machinery

The tree-sitter infrastructure the tree-sitter-backed language parsers
share, owned once so a loader or walker fix reaches every language.

## What each file does

- `tree-sitter-loader.ts` — the single owner for tree-sitter
  initialization, language-WASM loading, and the parser pool.
- `tree-sitter-walker.ts` — the generic AST-walking helpers that are not
  language-specific.

## Where it lives

The folder lives at `engine/src/quality/languages/shared/`.
