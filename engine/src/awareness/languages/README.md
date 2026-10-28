# Awareness language adapters

The per-language adapters the awareness engine dispatches each file to. An
adapter is a pure function `(filePath, source) → FileAnalysis`; it never
touches the filesystem or holds state. Adding a language is adding one file
here and registering it in `index.ts`.

## What each file does

- `index.ts` — the language adapter registry: dispatches each file to the
  adapter whose extensions include the file's.
- `python-tree-sitter.ts` — python adapter (tree-sitter) — REAL AST parser, no regex.
- `python.ts` — python adapter — line + regex based.
- `rust-tree-sitter.ts` — rust adapter (tree-sitter) — REAL AST parser, no regex.
- `rust.ts` — rust adapter — line + regex based.
- `typescript.ts` — the TypeScript/JavaScript adapter, using `@babel/parser`
  (a real parser, already a dependency).
- `go.ts` / `python.ts` / `rust.ts` — the line+regex Go/Python/Rust
  adapters, kept only as fallbacks when the tree-sitter native binding is
  unavailable.
- `go-tree-sitter.ts` / `python-tree-sitter.ts` / `rust-tree-sitter.ts` —
  the real-AST Go/Python/Rust adapters built on tree-sitter.
- `tree-sitter-base.ts` — the shared real-parser infrastructure for the
  non-TypeScript tree-sitter adapters.
- `generic.ts` — the fallback adapter for any file whose extension matches
  no language adapter, so the engine never silently skips a file.

## Where it lives

The folder lives at `engine/src/awareness/languages/`.
