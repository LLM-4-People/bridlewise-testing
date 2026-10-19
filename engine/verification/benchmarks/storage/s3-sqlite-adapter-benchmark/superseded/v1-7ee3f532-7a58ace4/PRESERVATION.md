# Superseded benchmark preservation disposition

`README.md`, `docs/`, `artifacts/raw/`, and `SHA256SUMS` remain exact preserved
bytes. The two `.tar.gz` files also retain their exact bytes, but they are typed
as rejected raw fixtures and cannot establish evidence, qualification, finding
removal, or readiness.

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
