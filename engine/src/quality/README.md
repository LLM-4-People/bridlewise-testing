# Quality

The quality domain: the quality indicators and checks computed over a codebase.

## What each file does

- `aggregator.ts` — Aggregator + runner (EXP368, refactored for async tree-sitter parsers).
- `base.ts` — Multi-language quality pack — base types (EXP357).
- `config.ts` — Multi-language quality pack — central config (EXP357).
- `index.ts` — Public API for the multi-language quality pack (EXP368 / EXP386).
- `monitoring.ts` — Real-time quality monitoring (EXP386).
- `scoring.ts` — Quality scoring (EXP386, refactored EXP462).
- `signals.ts` — Multi-language signals (EXP357).

## Where it lives

The folder lives at `engine/src/quality/`.
