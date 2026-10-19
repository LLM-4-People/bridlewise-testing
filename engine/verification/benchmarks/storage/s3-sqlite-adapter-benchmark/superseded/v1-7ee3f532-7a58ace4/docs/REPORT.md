# SQLite adapter qualification report

## Outcome

Both adapters passed this synthetic qualification; neither is selected for
production by this evidence alone. The narrow next-stage preference is
`node:sqlite` when dependency minimization and enforceable API boundaries are
weighted most heavily. `better-sqlite3` remains a viable comparator and carries
SQLite 3.53.2 rather than Node's 3.53.1, but its native install produced the same
deprecated-installer and npm allow-scripts warnings on all three clean trials.

The same 30-repetition matrix passed on both `/tmp` tmpfs and isolated ext4
scratch on the project's filesystem. Production selection remains blocked on
private file-mode enforcement, a longer reader/checkpoint contention test,
qualification of SQLite 3.53.3 or later, and real power-loss validation (which
SIGKILL cannot provide).

## Exact identities

| Surface | Exact identity |
|---|---|
| Node | `v24.18.0`; npm `11.16.0` |
| `node:sqlite` | SQLite `3.53.1`; source `c88b22011a54b4f6fbd149e9f8e4de77658ce58143a1af0e3785e4e6475127e9` |
| `better-sqlite3` | npm `12.11.1` (`latest` at qualification); SQLite `3.53.2`; source `d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24` |
| npm tarball | 2,660,617 bytes; SHA-256 `ebf0ed75a7a59dbcb3b24bbd014ef49d9f15bc328e4adcbf516f2a8fadfa2835`; registry SRI matched |
| Native addon | SHA-256 `45cb92a176fb758533db6d9a343acdfc73e4de27ac4c20a0cb2a6fb5be3e84f2` |
| Schema SQL | SHA-256 `cc2ac7bf6d9d491ddc9ee22c1b8624f6dc8f6a7e71c069305000bd651c307828` |
| Closed operation SQL | SHA-256 `d104e82d7895684913800f57811ba681e01f370d40b35cadad226aadbd305859` |
| Runner ordered code digest | SHA-256 `5d94d339964523e5f34dbe8161adf6987a3cd2b9d892f8dfc1cc5c8a10893e9a` |
| tmpfs raw JSON | SHA-256 `7ee3f532b7800e807b2f9118a0c8602489da509a301a416f373ac48047bbbbf3` |
| ext4 raw JSON | SHA-256 `7a58ace44cdd824a8e0fd631a80d5a125643e7001eb4ccb5b56c7f8fe502a745` |
| Install raw JSON | SHA-256 `0152dd73065c86dc9288bc85e855c2f7e0c82eef3d38f9c0c5b09238f24dbdca` |

All runtime compile options are preserved verbatim in the raw JSON. Notable
differences are `THREADSAFE=1`, session/RBU, and default WAL FULL in Node versus
`THREADSAFE=2`, `OMIT_SHARED_CACHE`, STAT4, and default WAL NORMAL in
better-sqlite3. Runtime configuration overrode both to synchronous FULL.

Three clean cached `npm ci` trials completed in 418.97, 375.88, and 383.55 ms,
and an independent process opened the native module and reported SQLite 3.53.2
after every install. These are cache-warm installation results, not cold-network
installation timings.

## Correctness and recovery

- Before timing, both adapters produced identical `3 ledger / 2 projection / 3
  outbox` behavior, descending entity search, atomic duplicate rejection, STRICT
  BLOB rejection, valid backup/reopen state, zero foreign-key or cross-table
  errors, and `quick_check=ok`.
- Neither wrapper exposes `exec`, `prepare`, a raw database, ATTACH, or an
  extension loader. Node additionally uses `allowExtension=false`, defensive
  mode, and an authorizer denying ATTACH, DETACH, and `load_extension`.
- Each adapter committed exactly 960 rows under 30 four-process contention
  trials with contiguous sequence values, zero application-level busy retries,
  and no ledger/outbox/projection disagreement.
- Thirty close/reopen checks per adapter retained every commit. Ten SIGKILLs
  before COMMIT per adapter retained no staged rows; ten SIGKILLs after COMMIT
  retained every committed row.
- Thirty 5,000-row online backups per adapter all passed integrity and logical
  count checks. Backup bytes were identical across all 30 repetitions within
  each adapter.
- WAL and SHM existed while connections were active and disappeared after the
  final clean close. Files were mode `0644` under the benchmark umask; a
  production wrapper must instead enforce its required private directory and
  file modes.

## Measured distributions

Every listed cell has 30 randomized-order repetitions. The primary table below
is the ext4 confirmation; times are milliseconds. "Cold" includes connection
open, safety PRAGMAs, idempotent schema calls, and statement preparation, but
does not flush the OS page cache.

| Operation (median / p95) | `node:sqlite` | `better-sqlite3` |
|---|---:|---:|
| Cold append, 1 KiB | 15.001 / 17.145 | 14.862 / 17.259 |
| Warm append, 1 KiB | 4.911 / 5.965 | 4.993 / 8.038 |
| Cold append, 16 KiB | 15.817 / 17.988 | 15.051 / 17.129 |
| Warm append, 16 KiB | 4.947 / 6.044 | 5.001 / 6.007 |
| Cold append, 256 KiB | 18.207 / 21.729 | 17.243 / 21.700 |
| Warm append, 256 KiB | 6.886 / 14.729 | 6.028 / 17.999 |
| 50k-row entity search | 0.062 / 0.112 | 0.054 / 0.098 |
| 50k-row pending outbox search | 0.084 / 0.143 | 0.075 / 0.138 |
| 5k-row online backup | 40.066 / 47.869 | 41.689 / 47.863 |
| Four-process contention trial | 228.115 / 378.495 | 230.335 / 235.445 |
| Close/reopen and count | 0.302 / 0.362 | 0.319 / 0.388 |

On ext4, better-sqlite3 had modestly lower large-payload append and search
medians and a tighter contention p95; Node had slightly lower backup and restart
medians. Node's cold 256-KiB cell had one 174-ms p99 outlier, while
better-sqlite3's backup cell had one 152-ms p99 outlier. The separate tmpfs run
was much faster but ranked the adapters similarly overall. Neither filesystem
supports a general performance winner.

## SQLite 3.53.3 relevance

The official 3.53.3 release source ID is
`d4c0e51e4aeb96955b99185ab9cde75c339e2c29c3f3f12428d364a10d782c62`.
Neither tested runtime contains the complete patch set.

The historical WAL-reset corruption race is directly relevant to a WAL,
multi-process workload, but SQLite documents it as fixed in 3.51.3 and later;
both runtimes include that fix. The 3.53.3 backup use-after-free requires ATTACH,
and its deserialize/backup crash requires deserialize—both operations are
excluded here. Mutex expansion, corrupt WAL/SHM/page hardening, and additional
index/freelist checks remain useful defense in depth. The other timeline fixes
primarily concern query shapes and optional modules absent from this closed
workload.

Official references: [3.53.3 release notes](https://www.sqlite.org/releaselog/current.html),
[3.53 branch timeline](https://sqlite.org/src/timeline?from=version-3.53.0&to=version-3.53.3&to2=branch-3.53&y=ci),
[WAL and WAL-reset bug](https://www.sqlite.org/wal.html), and
[Node 24.18 SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).

## Bounded recommendation

Advance both adapters to longer-duration and power-loss-capable qualification.
Put `node:sqlite` first for that next stage because it avoided a third-party
native installation and allowed the stronger defensive/authorizer boundary
while remaining competitive. Do not treat that ordering as production
approval: Node's SQLite API is still documented as release-candidate stability,
Node is one SQLite patch behind better-sqlite3, and both are behind 3.53.3.
