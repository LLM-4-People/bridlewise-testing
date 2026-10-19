# safety

The `engine/test/safety/` folder of the development surface.

## What each file does

- `bandaid-detector.test.ts` — the `bandaid-detector.test` module.
- `bandaid-harder.test.ts` — the `bandaid-harder.test` module.
- `bandaid-no-static.test.ts` — the `bandaid-no-static.test` module.
- `deviation-detector.test.ts` — the `deviation-detector.test` module.
- `learned-bandaid-corpus.ts` — shared helpers that build the learned bandaid pragma/marker corpus and config (no static keyword list).
- `bias-detector-benchmark.test.ts` — bias detector benchmark across all bias types (triggers fire, balanced controls do not).
- `hallucination-benchmark.test.ts` — hallucination benchmark across the structural and semantic detection layers.
- `synthetic-source-fixtures.ts` — synthetic source files + claim/record builders shared across the hallucination, bias, and bandaid benchmark suites.
- `safety-fix-regressions.test.ts` — targeted regression tests for the safety-detector fixes (precise TS rendering, structural index sets, single parse, edit-similarity gate, n-gram discrimination floor).
- `infer-claims-double-parse.test.ts` — regression test for EXP447: inferClaimsFromCode double-parses.
- `investigation.test.ts` — the `investigation.test` module.
- `pause-ask.test.ts` — the `pause-ask.test` module.
- `step-skip-detector.test.ts` — the `step-skip-detector.test` module.
- `tool-call-gate.test.ts` — adversarial tests for the pre-dispatch tool-call gate.
- `workaround-detector.test.ts` — the `workaround-detector.test` module.

## Where it lives and what consumes it

The folder lives at `engine/test/safety/`.
