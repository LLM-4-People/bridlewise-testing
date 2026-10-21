# verification

The `engine/test/verification/` folder of the development surface.

## What each file does

- `architecture-external-commands.test.ts` — the `architecture-external-commands.test` module.
- `artifact-manifest.test.ts` — the canonical artifact inventory's producer: generatedAt derived from the captures (never read back), origins admitted by pinned provenance shapes, and a dropped artifact refused unless named or forbidden by canonical retention.
- `corpus-manifest.test.ts` — the corpus manifest's validation (hash, path, upstream, licence refused by name), a drift report that names the file, a real fetch over a local bare repo, and the relink rule.
- `hash-binding-registry.test.ts` — the `hash-binding-registry.test` module.
- `ratchet.test.ts` — the one shrink-only ratchet (scripts/verification/ratchet.ts): every baseline entry carries a reason, the committed baseline is read from git HEAD, and the real commit guard refuses a staged baseline that grew.
- `recursive-test-inventory.test.ts` — the `recursive-test-inventory.test` module.
- `required-fixture-roots.test.ts` — the declared-corpus refusal, driven both ways.
- `static-source-tokenizer.test.ts` — the static-source tokenizer's multi-character punctuation, the arrow-fed fenced-code regex, and the two-scanner export agreement over the repository-root scan population.
- `test-surface-conservation.test.ts` — the `test-surface-conservation.test` module.

## Where it lives and what consumes it

The folder lives at `engine/test/verification/`.

`static-source-tokenizer.test.ts` also binds independent runtime/erased-reference
and source-name channels to explicit TS/TSX profiles. Fixtures cover declarations,
annotations versus initializers, ambient ancestors, semicolonless boundaries,
string punctuation, JSX text versus expressions, generic arrows and values named
`type`. Actual pinned Node subprocesses observe module side effects and missing
targets; active TypeScript verbatim emission provides separate compiler-backed
TSX witnesses. Neither is substituted for full project typechecks. Cache tests
reject absent/malformed erased channels and distinguish profile keys. Graph,
excluded/unknown-target and registrar owners supply actual admission controls;
full-tree residual diagnostics remain visible and require owner-level repairs.
