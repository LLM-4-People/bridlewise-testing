# Editor

The editor domain: the transactional file editor and the edit operations that apply, validate, and record changes to source files.

The model faces exactly ONE edit tool, `edit(path, oldString, newString)`. The model supplies a string preimage — never a hash or byte offset; `edit-resolve.ts` resolves it to a byte range through a deterministic heal cascade (exact → whitespace → escape-repair → fuzzy) and computes the preimage hash itself, then the transactional editor applies the change with full governance (preimage verify → syntax → atomic write → post-write verify → rollback). Whole-file replace uses the explicit `<all>` sentinel; an empty oldString on a non-existent file creates it; an ambiguous or absent preimage is refused with an actionable message.

## What each file does

- `edit-feedback.ts` — the edit-feedback module.
- `edit-operations.ts` — the edit-operations module.
- `edit-resolve.ts` — the edit-resolve module.
- `edit-tools.ts` — the edit-tools module.
- `monotone-complexity-guard-config.ts` — Canonical configuration owner for the AL5 monotone-complexity guard.
- `monotone-complexity-guard.ts` — the monotone-complexity-guard module.
- `syntax-validator.ts` — the syntax-validator module.
- `transactional-editor.ts` — the transactional-editor module.

## Where it lives

The folder lives at `engine/src/editor/`.
