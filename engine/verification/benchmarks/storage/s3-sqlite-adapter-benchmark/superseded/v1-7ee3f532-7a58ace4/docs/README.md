# S3 SQLite adapter qualification

This directory is a synthetic-only, bounded comparison of Node 24.18.0
`node:sqlite` and npm-registry stable `better-sqlite3@12.11.1`. It does not read
user or OpenCode data and makes no production-selection claim.

Both adapters use the exact SQL in `schema.mjs`: one STRICT
ledger/projection/outbox schema, `journal_mode=WAL`, `synchronous=FULL`, foreign
keys, trusted-schema off, fixed prepared statements, and no caller SQL,
extensions, or ATTACH/DETACH operation. The benchmark-only stage/commit methods
exist solely for process-kill boundary tests.

Reproduce from this exact directory:

```bash
node --version                 # must print v24.18.0
npm run install-check          # three clean npm ci + native runtime probes
npm run benchmark              # correctness gates, then randomized measurements
S3_SQLITE_BENCH_WORK_ROOT=/home/example/.cache/bridlewise-sqlite-benchmark \
S3_SQLITE_BENCH_OUTPUT_STEM=benchmark-results-project-fs npm run benchmark
node verify-artifacts.mjs       # verify identities, sample counts, and invariants
sha256sum -c SHA256SUMS
```

`install-check` requires npm registry access. The benchmark asserts the Node
version, recreates and finally removes `work/`, uses only deterministic
synthetic bytes, and writes raw results under `artifacts/raw/`.

The qualification records both `/tmp` (`tmpfs`) and an isolated scratch run on
the project's ext4 filesystem. The runner deletes either work tree at the end.
FULL/WAL and process-crash behavior are exercised, but SIGKILL cannot establish
power-loss durability. See `REPORT.md` for the bounded result.
