# Path-policy sources

The upstream sources the repository path policy is derived from: the Unicode
data is vendored here; Git's sources are pinned here and fetched.

## The sources

- Git 2.55.0's path handling (`path.c`, the upstream t0060 test that pins its
  behavior, and its GPL-2.0-only `COPYING`) is **fetched for testing, never
  vendored**: `manifest.json` pins the commit and each file's size and
  SHA-256, and its paths point into the pinned corpus
  (`engine/large-codebases/git/`), which the development repository's
  pinned-corpus fetch (`engine/scripts/verification/corpus.ts`) materialises
  outside the tree and verifies against those pins. This AGPL-3.0 tree
  carries the pins and none of the bytes, so nothing is redistributed. A test
  that reads them with the corpus absent fails with a typed error naming the
  fetch command.
- `unicode-17.0.0/` — the Unicode 17.0.0 data files (case folding and
  normalization) with the license and manifest.

## Where it lives and what consumes it

The folder lives at `engine/traceability/sources/path-policy/`.
`engine/scripts/generation/repository-path-unicode.ts` reads these to
generate the path-policy fixtures; each subfolder carries its digests.
