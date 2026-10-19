# Superseded S3 SQLite benchmark evidence epoch

This directory preserves the exact benchmark evidence and staged runner bytes
that existed before the candidate-format guard normalized six authored runner
files to one terminal newline. The formatting change was semantically inert,
but the original raw results bind exact source hashes. Preserving those bytes
prevents a later rerun from rewriting what the earlier experiment executed.

- Original tmpfs result SHA-256:
  `7ee3f532b7800e807b2f9118a0c8602489da509a301a416f373ac48047bbbbf3`
- Original ext4 result SHA-256:
  `7a58ace44cdd824a8e0fd631a80d5a125643e7001eb4ccb5b56c7f8fe502a745`
- Original ordered runner-code digest:
  `5d94d339964523e5f34dbe8161adf6987a3cd2b9d892f8dfc1cc5c8a10893e9a`
- Reason superseded: `FOUNDATION-002-candidate-format-verifier-blind-spot`

`artifacts/raw/` and `docs/` are byte-preserved copies. The exact runner is in
`runner-source-snapshot.tar.gz` with SHA-256
`4bfab87b0ba4fa865d96791ec42159386cefce7810679116e7d34e79c287427f`.
It was assembled from exact `git checkout-index` bytes without rewriting or
decoding them. `SHA256SUMS` is the original identity file;
its relative paths describe the earlier assembled evidence bundle rather than
this archival wrapper.
