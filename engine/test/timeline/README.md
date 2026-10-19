# timeline

The `engine/test/timeline/` folder of the development surface.

## What each file does

- `append-only-enforcement.test.ts` — the `append-only-enforcement.test` module.
- `digest-consistency.test.ts` — the `digest-consistency.test` module.
- `edge-type-consistency.test.ts` — the `edge-type-consistency.test` module.
- `ledger-primitives.test.ts` — the `ledger-primitives.test` module.
- `outcomes-consistency.test.ts` — the `outcomes-consistency.test` module.
- `provider-recording.test.ts` — paired provider-stream recording: teardown, typed iterator failures and unavailable capture evidence.
- `recorded-effect.test.ts` — the `recorded-effect.test` module.
- `rollback-record-kind-contract.test.ts` — the `rollback-record-kind-contract.test` module.
- `rollback.test.ts` — the `rollback.test` module.
- `timeline-sealing.test.ts` — the protected projection and its sealed originals: the sealing owner's round trip (empty, multi-chunk) and every typed refusal (wrong key, another event or sequence, reordered, truncated or missing chunks, a digest that is not the original's); a secret across the chunk boundary in no ledger file; ONE seal key per ledger (a lost key never replaced, a sibling sharing it refuses to mint, a second key refused at open, a check value recorded, never the key); every opening of a seal audited with its purpose and outcome, never bytes (a refused one too); description masking beside UUIDs and SHAs; sensitive names and identities refused; a known migration name under another id refused.
- `timeline-concurrency-worker.ts` — the `timeline-concurrency-worker` module.
- `timeline-concurrency.test.ts` — the `timeline-concurrency.test` module.
- `timeline-coverage-counts.test.ts` — the `timeline-coverage-counts.test` module.
- `timeline-fidelity.test.ts` — timeline fidelity — what is recorded reaches the ledger, and what the ledger holds can be read out completely.
- `timeline-integration.test.ts` — the `timeline-integration.test` module.
- `timeline-query-batch.test.ts` — the `timeline-query-batch.test` module.
- `timeline-query.test.ts` — the `timeline-query.test` module.
- `timeline-recorder.test.ts` — the `timeline-recorder.test` module.
- `timeline-spectrum.test.ts` — the `timeline-spectrum.test` module.
- `timeline-store-checkpoint.test.ts` — the `timeline-store-checkpoint.test` module.
- `timeline-store-invariants.test.ts` — the `timeline-store-invariants.test` module.
- `timeline-store.test.ts` — the `timeline-store.test` module.
- `timeline-synthesis-facts.test.ts` — the `timeline-synthesis-facts.test` module.
- `query-plans.test.ts` — SCALE-CR1 C5: the lineage statements and the pending-intent scan plan through migration 11's partial `idx_event_log_effect_lineage` on a store-created ledger, and a pairing costs the same on a ledger ten times larger.
- `recorder-retained-heap.test.ts` — SCALE-CR1 C6: ten thousand paired effects leave the recorder's heap where it was (< 100 KiB): the persisted recorder keeps no in-memory closure.

## Where it lives and what consumes it

The folder lives at `engine/test/timeline/`.
