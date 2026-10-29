# Quality checks

The individual quality checks the multi-language quality pack runs over
parsed files. Each check is one module named for what it flags — dead code,
dead exports, duplicate bodies, complexity, security hotspots, the ESLint
parity checks (`no-*`, `prefer-const`), and the rest. A check consumes the
parsed AST and emits findings; the aggregator runs them all.

## How it is organized

Every check is its own file, discovered by the aggregator rather than named
at a call site, so adding a check is adding a file. The shared machinery is
in `shared.ts` (the DRY extraction of the common helpers) and
`shared-helpers.ts`; the language-agnostic checks operate on the parsed
file model from `../base.ts`, and the per-language parsing lives under
`../languages/`.

## Where it lives

The folder lives at `engine/src/quality/checks/`.
