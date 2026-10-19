# Unicode 17.0.0 data

The vendored Unicode 17.0.0 data files the path policy's case-folding and
normalization behavior derives from.

## What each file does

- `CaseFolding.txt` — the Unicode case-folding mappings.
- `NormalizationTest.txt` — the Unicode normalization conformance vectors.
- `ReadMe.txt` — the Unicode data files' own documentation.
- `LICENSE.txt` — the Unicode license.
- `manifest.json` — the vendored-set manifest with the digests.

## Where it lives and what consumes it

The folder lives at `engine/traceability/sources/path-policy/unicode-17.0.0/`.
`engine/scripts/generation/repository-path-unicode.ts` reads the data files
to generate the path-policy fixtures.
