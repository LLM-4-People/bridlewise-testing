# bench

The `bench/` folder of the development surface.

## What each file does

- `.gitignore` — the `` module.
- `bench-config.ts` — @config-owner — THE BENCH HARNESS (its truncations and its scan bounds).
- `concurrency.bench.ts` — cONCURRENCY BENCHMARK — does work overlap, or does it serialize?
- `db.bench.ts` — dB LAYER BENCHMARK — `server/db/client.ts` against real scale fixtures.
- `history-page.bench.ts` — oPENING A CONVERSATION — before and after the cursor.
- `ledger.bench.ts` — lEDGER BENCHMARK — the recording tax, measured separately and explicitly.
- `payload.bench.ts` — pAYLOAD + BUNDLE BENCHMARK — what the client actually downloads.
- `redaction.bench.ts` — rEDACTION BENCHMARK — the per-response egress tax. `sendJson`.
- `run.ts` — bENCH ORCHESTRATOR — run every suite and emit one comparable report.
- `writepath.bench.ts` — wRITE-PATH DECOMPOSITION + fsync reality check. `bench/db.bench.ts` measured `DbClient.createMessage` at ~12ms p50 while `bench/ledger.bench.ts`….

## The subfolders

- `fixtures/`
- `lib/`
- `wire/`

## Where it lives and what consumes it

The folder lives at `bench/`.
