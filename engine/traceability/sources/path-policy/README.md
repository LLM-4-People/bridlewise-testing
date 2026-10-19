# Path-policy sources

The vendored upstream sources the repository path policy is derived from.

## The subfolders

- `git-2.55.0/` — **not published.** Git 2.55.0's path handling (`path.c`,
  its GPL-2.0-only license, and the upstream test that pins the behavior) is
  referenced by the manifest for provenance, but the source is excluded from
  this AGPL-3.0 snapshot. Fetch it from upstream if you need to reproduce
  those checks.
- `unicode-17.0.0/` — the Unicode 17.0.0 data files (case folding and
  normalization) with the license and manifest.

## Where it lives and what consumes it

The folder lives at `engine/traceability/sources/path-policy/`.
`engine/scripts/generation/repository-path-unicode.ts` reads these to
generate the path-policy fixtures; each subfolder carries its digests.
