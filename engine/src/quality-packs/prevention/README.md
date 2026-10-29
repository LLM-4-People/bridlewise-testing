# Prevention quality packs

The prevention detectors: the experiment-derived detectors that catch defect
classes conventional checks miss — duplicate bodies, duplicated literals,
ESM/CJS hazards, dead code by digital-organism fitness, and bandaid debt.
Each detector is one module, exported through the `index.ts` barrel.

## What each file does

- `index.ts` — the barrel re-export for the prevention detectors.
- `ast-helpers.ts` — the shared AST helpers the detectors reuse.
- `async-effect-normalizer.ts` — the algebraic-effect normalizer for
  async↔sync equivalence.
- `duplicate-body-detector.ts` — the duplicate-function-body detector.
- `duplicate-body-types.ts` — the types and constants for the
  duplicate-body detector.
- `duplicated-literals-detector.ts` — the duplicated-literals detector.
- `embedding-provider.ts` — a thin adapter delegating to the canonical
  shared embeddings provider.
- `esm-cjs-detector.ts` — the ESM/CJS interop hazard detector.
- `le-chatelier-bandaid.ts` — the Le Chatelier bandaid-debt detector.
- `novel-principles-config.ts` — the configuration owner for the
  novel-principles packs.
- `tierra-dead-code.ts` — the Tierra/Avida dead-code fitness detector.
- `xenova-transformers.d.ts` — the minimal type declaration for the
  optional `@xenova/transformers` peer dependency.

## Where it lives

The folder lives at `engine/src/quality-packs/prevention/`.
