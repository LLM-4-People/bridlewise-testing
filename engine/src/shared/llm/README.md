# Shared LLM module

The one OpenAI-compatible client all agents reuse. Retry and error handling,
the request queue, the circuit breaker, adaptive concurrency, failover, and
token accounting are owned here once, so every caller gets the same behavior
and no module re-implements a provider adapter.

## What each file does

- `index.ts` — the public API barrel.
- `client.ts` — the shared client: handles the error taxonomy, bounds
  concurrency, opens the circuit breaker, and tracks tokens.
- `config.ts` — the central LLM configuration owner: defaults, types,
  ranges, and validation. `RESPONSES_TRANSPORT_DEFAULTS` is the one place the
  native transport defaults live; `runtime.responses` overrides each. The
  transport limits are REQUIRED parameters at every consumer
  (`captureResponseHeaders`, `extractResponseHeaders`, `cancelBody`,
  `readBody`/`decodeReadableStream`, `ProviderHttpRequest.transport`,
  `ProviderFailureOptions.maximumMessageCharacters`,
  `fetchProviderModels({ transport })`, and the privacy doors:
  `redactAndMintRequest`'s `limits`, `snapshotRequestContext`,
  `observeResponseProtocol`/`observeResponseEnvelope`'s `limits`, and
  `resolveResponsesTransportConfig(input)` itself — `{}` spells "the declared
  defaults" where no document exists, a2-design M5): no call site falls back
  to code defaults behind the configured document. The web server's one door
  is `getResponsesTransportSettings()` (the resolved section). One interim
  residue: the Chat-era drift detector resolves the declared defaults
  (`memory/unified/drift-detector.ts`; deleted by Chat removal). Cleartext to another host is the
  outbound door's ONE setting (`network.cleartextRemote`, default `refuse`;
  a local-network inference server over plain HTTP needs it set to `warn`).
  There is no transport seam: the door owns its client, and tests answer
  through a real loopback server. Every client states `allowPrivateAddress`
  (the credential's destination rule). A user's provider key is
  held by the client for its own calls (masked at the mint and in its
  diagnostics), never registered process-wide.
- `provider-http.ts` — the authenticated provider request lifetime: it
  prepares every request under the one outbound HTTP policy
  (`shared/outbound-http.ts`) BEFORE any observer sees it, dispatches through
  it (no redirect followed, verified TLS, bounded bodies and deadline), and
  maps the policy's refusals into the LLM error family (an oversized body is
  `InvalidResponseError`; every other refusal is a non-retryable bad request
  carrying the policy's code, e.g. `outbound_redirect_refused`).
- `errors.ts` — the typed LLM error hierarchy.
- `responses.ts` — native Responses request schemas, lossless resources, usage,
  display/tool projections, and authoritative transcript replay. Owns
  `RESPONSE_MCP_ITEM_TYPES`, the protocol's native MCP item discriminants
  (wire vocabulary, not harness error codes).
- `response-transcript.ts` — native replay and dependency grouping; owns
  `projectToolCallArguments`, the one tool-call argument projection every
  serializer (including the unified context manager) uses.
- `responses-stream.ts` — the Responses lifecycle owner shared by live transport
  and the runtime ModelEvent adapter. Native events and final resources survive;
  executable function completion is released only after validated response.completed.
- `responses-disposition.ts` — classifies complete native output using the exact admitted tools and selector, with an injected host authority resolver; unbound actions produce typed refusal before any local work.
- `queue.ts` — the canonical request-admission, ordering, and
  concurrency-bounding queue.
- `circuit-breaker.ts` — the circuit breaker for consecutive failures.
- `adaptive.ts` — the AIMD adaptive concurrency controller.
- `failover.ts` — the optional per-model and per-provider failover chain.
- `stats.ts` — the canonical cumulative usage counters.
- `provider-endpoint.ts` — shared endpoint syntax admission for configuration and discovery.
- `provider-observation.ts` — intentional authentication context and safe public labels, distinct from exact routing identities.
- `exposure.ts` — the module's exposure catalog.

## Where it lives

The folder lives at `engine/src/shared/llm/`.

## Responses contract

Native request extensions, hosted tools, reasoning/encrypted state, refusals,
annotations and usage details are retained. An absent response status stays
unknown. Resume retains the same stream-state object; a response ID and cursor
alone cannot reconstruct a partial item. EOF never implies completion. Protocol
limits reuse the central root policy.

Current source evidence, endpoint controls, WebSocket/steering semantics, provider
limits and deterministic test coverage live in
[the protocol research contract](https://github.com/LLM-4-People/bridlewise).
Transport integration and provider capability tests must establish actual
support before exposing a feature as available.

Public output observations use `privacy/responses-observation.ts`'s
`observeResponseProtocol(value, { limits, policy, heldCredentials })`. It snapshots
bounded JSON, applies one ephemeral complete-resource declaration context, and
returns immutable evidence without modifying private native resources. Resources,
terminal event envelopes and input-item pages retain their safe structure; opaque
media, ciphertext and intentional credentials are hidden. Arbitrary progress
strings and keys stay private until complete context exists; only validated numeric
sequence/index fields are exposed. This projection is never a replay body.

Transport labels, captured headers, error diagnostics and public targets use the
same canonical detector with locally held credentials even when global credential
registration refuses a short value or reaches its bounded capacity. Raw failure
codes still control retry classification. Public target reads are side-effect free.

Endpoint admission uses each operation's contract: compact service tier is a nullable enum and its cache key allows at most 64 Unicode code points; input-token personality is an optional non-null open string with the same bound, and truncation is optional/non-null. Create stream options require the final composed streaming mode. Other endpoints retain their opaque extensions. No wire normalization is performed.

Native failures carry one optional observed HTTP `status`; native/SSE errors without transport status retain absence. Count-free context codes still produce ContextTooLongError. Exact misalignment policy codes take precedence over status-based authentication and remain non-retryable under the existing bad-request taxonomy. Accepted failed JSON resources remain returned resources, with native failure taxonomy in the central response_failed log.
