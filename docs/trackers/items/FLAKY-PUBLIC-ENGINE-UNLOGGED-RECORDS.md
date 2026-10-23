---
schema: bridlewise-tracker-item/v1
published: false
id: FLAKY-PUBLIC-ENGINE-UNLOGGED-RECORDS
type: Flake
state: open
lane: flaky-burn-down
opened: 2026-10-20
---

public re-owning of `FLAKY-ENGINE-UNLOGGED-RECORDS`; **needs private history, still owned**. Covers `engine/test/evaluation/matrix-executor.test.ts` `evaluation/matrix-executor: tokens accumulate from run usage` and `engine/test/mcp/transport.test.ts` `streamable http: a server ping on the answer stream is answered and never resolves the client's request (H-1)`; both files are green at HEAD (160/160 in the 2026-10-20 focused run). The private row says the causes are reproduced and fixed (matrix: the stall after the first response, fix `2d2b58e2`; transport: the late ping answer, fix `7305adbf`), but the two records (`d1c7abfdb12b746761457109.json`, ten statistical runs; `fbe9f9c7cdad96d8f24298a0.json`, one deterministic run under `flake-shim-hold-requests.ts`) are schema v2, the current door ignores them, and neither has an `attempts/` file here. The transport test at HEAD is byte-identical to `7305adbf` (`b067b0e2…`), and the matrix fix's `engine/src/shared/outbound-http.ts` moved on afterward, but a fix is not a current-door reproduction. Missing artifact: two schema-v3 records plus their `attempts/` files, re-recorded under the door (the hold-requests shim is registered; the stall shim is statistical). The private row's own instruction is "Re-record … and the entries leave". Guarded by `engine/test/prevention/flaky-test-memory.test.ts`.
