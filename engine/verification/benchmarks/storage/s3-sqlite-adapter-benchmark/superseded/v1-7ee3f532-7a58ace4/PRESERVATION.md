# Superseded benchmark preservation disposition

`README.md`, `docs/`, `artifacts/raw/`, and `SHA256SUMS` remain preserved
bytes (see the public-snapshot note below). The two `.tar.gz` files also retain
their exact bytes, but they are typed as rejected raw fixtures and cannot
establish evidence, qualification, finding removal, or readiness.

Independent replay found that `historical-evidence.tar.gz` contradicted its
claimed bytewise member order: `SHA256SUMS` appeared immediately before
`README.md`. The nested runner archive replayed all ten identities and had the
claimed order, but valid archive admission is suspended because the prior
admission rule trusted sidecar claims and two-byte magic rather than validating
gzip and tar structure. `independent-archive-replay.json` preserves both facts.

The exact runner bytes remain recoverable from the rejected runner archive.
Files under `expanded-runner/` are explicitly normalized search projections,
not originals. `content-manifest.json` binds each projection's length and
SHA-256 to the original length and SHA-256 and declares either an identity
transform or appending exactly one LF. The shared reconstruction verifier must
reproduce all ten original digests.

Public-snapshot note: the public import sanitizes local home paths in the three
text projections that carried one (`docs/README.md`,
`artifacts/raw/benchmark-results-project-fs.json`, and
`expanded-runner/verification/benchmarks/storage/s3-sqlite-adapter-benchmark/verify-artifacts.mjs`):
The local home path was sanitized to `/home/example`. `content-manifest.json` is
re-measured against the bytes this tree carries, so the "original" digest for
those entries is the sanitized public byte string; the `.tar.gz` archives keep
their exact pre-sanitization bytes. The identity/append-one-LF reconstruction
contract is unchanged.
