# Shared

The shared domain: the agnostic helpers every engine domain consumes, owned once so a fix reaches every consumer.

## What each file does

- `abort-signals.ts` — Canonical AbortSignal combination helpers, and the
  one abortable delay (`abortableDelay`).
- `backoff.ts` — THE retry backoff formula (`backoffDelayMs`: base, factor, cap, jitter) — the LLM client and the MCP registry both ask it.
- `best-effort.ts` — Canonical best-effort operation helpers: `bestEffort`,
  `bestEffortAsync`, and `bestEffortBoxed` (the value boxed, for an operation
  whose `undefined` result is meaningful). (`guarded`, the event loop's door,
  is the fault policy's own: `src/process/fault-policy.ts`.)
- `budget-verdict.ts` — The runtime budget's DECISION, as a pure function of a recorded summary.
- `dev-mode-env.ts` — the dev-mode-env module.
- `flake-reproduction.ts` — THE RECORDS THAT EXPLAIN A FLAKY SUSPECT (FLAKE-REPRO): the schemas, file names, folder (`ROOT_POLICY.workflow.flakeReproductions`), serializers and reader of the reproductions (deterministic or statistical, with their one set of conditions, digests, counts and loads) and of the identity moves `harness flake` writes. The flaky verdict explains a suspect only with such a record.
- `git-churn-config.ts` — Canonical configuration owner for the shared git-churn helper.
- `git-churn.ts` — the git-churn module.
- `identity.ts` — Canonical `BigIntStats` identity comparison.
- `json-pointer.ts` — Canonical JSON Pointer (RFC 6901) helpers.
- `long-task-timing.ts` — the long-task-timing module.
- `module-location.ts` — The single owner of where an engine module lives, resolved from the tree.
- `numeric-helpers.ts` — the numeric-helpers module.
- `outbound-http.ts` — THE outbound door: every HTTP request and WebSocket
  the harness sends goes through it, and it OWNS its transport — ONE client,
  `undici` (a direct dependency, loaded when the first request or WebSocket
  is sent), with no seam (tests answer through a real loopback server,
  `engine/test/support/loopback-upstream.ts`). Every request and handshake is
  resolved once and PINNED to the checked addresses, on a connection pool
  keyed by them (a kept-alive connection never serves a request pinned
  elsewhere; `closeOutboundConnections` closes the pools, at the web server's
  shutdown), and states `allowPrivateAddress` (the destination rule,
  `privateAddressesAllowedFor`). No redirect is followed (any 3xx is
  `outbound_redirect_refused`), TLS verification cannot be switched off,
  cleartext to a host that is not EXACTLY loopback (`isLoopbackHostName`;
  `*.localhost` is not) is refused or warned per `network.cleartextRemote`,
  an environment proxy never relays a cleartext request silently and never
  carries a request held off private addresses
  (`outbound_destination_unpinnable`), a request held off private addresses
  refuses loopback, private, link-local, shared, benchmark, multicast,
  reserved and documentation ranges (IPv4 embedded in IPv6 judged by the
  inner IPv4), operator headers pass a grammar/role allowlist (protocol
  headers win), every refusal is logged once and counted, a WebSocket
  message is bounded before it is assembled (`openOutboundWebSocket`), and
  bodies (`readBody`, `decodeReadableStream`, `discardBody`) and lifetimes
  (`outboundDeadline`) are bounded.
  `engine/test/prevention/outbound-http-owner.test.ts` (AST) refuses any
  other `fetch`, `http(s).request`, socket, `WebSocket` or `undici` use in
  the product trees and scripts.
- `outbound-policy.ts` — the door's POLICY and observable state, with no
  transport: the `network` config section (schema, defaults, the host's live
  source), the destination rule (`privateAddressesAllowedFor`,
  `OPERATOR_OWNER`) and the door's counters (`outboundSignals`), so the
  config contract and the `network` exposure module never load the HTTP
  client.
- `path-utils.ts` — Canonical path-extension helper.
- `run-cpu.ts` — The CPU time a test run actually consumed — the run's WORK, as opposed to.
- `run-history.ts` — THE RUN-HISTORY LEDGER — what makes "sustained" a measurable word, for.
- `similarity.ts` — Canonical set-similarity primitives.
- `source-extensions.ts` — the source-extensions module.
- `source-scan.ts` — Experiment source-directory exclusion — the single source of truth.
- `source-structure.ts` — STRUCTURAL SCOPES FOR SOURCE ASSERTIONS — the shared owner that makes a.
- `stats.ts` — Canonical statistical helpers.
- `tree-identity.ts` — TREE IDENTITY — the answers a measurement record binds to: WHICH commit the.
- `type-guards.ts` — Canonical type-guard and exhaustiveness helpers.
- `fault-description.ts` — `describeFault(value)`: the one TOTAL description of a thrown or rejected value (an Error, `undefined`, a Symbol, a null-prototype object, a throwing getter — one hostile getter loses only its own field) as plain strings, and `faultLine`/`describeFaultLine`: the one `Name [code]: message` spelling (the fault policy's report, a refusal reason, the database threads' restart report); a leaf module, so the fault policy, `guarded` and the debug system use it without a cycle.

## Where it lives

The folder lives at `engine/src/shared/`.
