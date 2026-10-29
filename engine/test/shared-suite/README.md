# shared suite

The `engine/test/shared-suite/` folder of the development surface.

## What each file does

- `backoff.test.ts` — the one backoff formula: growth, cap and jitter bounds.
- `best-effort.test.ts` — the `best-effort.test` module.
- `dev-mode-env.test.ts` — the `dev-mode-env.test` module.
- `exposure-action-args.test.ts` — the `exposure-action-args.test` module.
- `exposure-action-recorded.test.ts` — the `exposure-action-recorded.test` module.
- `exposure-contract-validation.test.ts` — the `exposure-contract-validation.test` module.
- `exposure-customization-liveness.test.ts` — the `exposure-customization-liveness.test` module.
- `exposure-language-guard.test.ts` — the `exposure-language-guard.test` module.
- `exposure-module-declaration.test.ts` — the `exposure-module-declaration.test` module.
- `exposure-registrations.test.ts` — the `exposure-registrations.test` module.
- `exposure.test.ts` — the `exposure.test` module.
- `llm-client-v2.test.ts` — the `llm-client-v2.test` module.
- `llm-failover-v2.test.ts` — the `llm-failover-v2.test` module.
- `llm-gemma-integration.test.ts` — eXP421 — integration test against the.
- `llm-observation.test.ts` — the cross-consumer public observation contract for untrusted Responses resources, credentials, labels, headers, counters and queue scopes. Wire admission remains in `llm-responses-privacy.test.ts`; HTTP lifecycle remains in `llm-responses-http.test.ts`.
- `llm-queue-config.test.ts` — eXP457 — configurable queue + concurrency for the.
- `llm-response-transcript.test.ts` — native Responses replay and interruption evidence survive the transcript projection.
- `llm-responses-http.test.ts` — the Responses HTTP transport: envelopes, bounded reads, error classification, cancellation and lifecycle queries.
- `llm-responses-privacy.test.ts` — request minting and redaction for native Responses bodies, including URL credentials in both spellings.
- `numeric-helpers.test.ts` — the `numeric-helpers.test` module.
- `outbound-http.test.ts` — the outbound HTTP policy: redirects refused with no second request, cleartext/TLS/URL-credential/scheme refusals, the header allowlist, bounded bodies and deadlines.
- `shared-functions.test.ts` — the `shared-functions.test` module.
- `source-scan.test.ts` — the `source-scan.test` module.

## The subfolders

- `debug/`
- `dedup-compression/`
- `stats-seeded.test.ts` — the one seeded random source (`seededRandom`/`seededShuffle` in src/shared/stats.ts): a seed reproduces the evaluation executor's former sequence and order (golden values), and a shuffle is a permutation that leaves its input alone.
- `thread-cpu-work.test.ts` — the CPU work of one piece of code (`engine/src/shared/run-cpu.ts`): measured over several scheduler ticks, this thread's work only (a worker burning CPU is not counted), and a typed refusal when unreadable.

## Where it lives and what consumes it

The folder lives at `engine/test/shared-suite/`.

The Responses HTTP owner also qualifies operation-specific enum/null/code-point bounds, composed stream-option admission, actual versus absent status, context-code classification, policy priority, zero retry/failover and returned failed-resource logging. Runtime/session and web run owners qualify the actual error consumers, observers, queued steering, durable conversation admission and fresh-context controls; successful transport status is never substituted for a native error status.
