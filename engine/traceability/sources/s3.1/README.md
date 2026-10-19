# S3.1 sources

The vendored S3.1 primary sources: the JCS (RFC 8785) reference vectors and
license the canonicalization is verified against.

## What each file does

- `manifest.json` — the vendored-set manifest with the digests.
- `jcs-values-input.json` / `jcs-values-output.json` — the JCS value
  canonicalization vectors.
- `jcs-unicode-input.json` / `jcs-unicode-output.json` — the JCS Unicode
  canonicalization vectors (including verified erratum 7920).
- `jcs-LICENSE` — the license of the reference vectors.

## Where it lives and what consumes it

The folder lives at `engine/traceability/sources/s3.1/`. The ledger
canonicalizer's tests and the S3.1 verifiers run against these vectors.
