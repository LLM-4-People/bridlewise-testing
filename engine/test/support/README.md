# support

The `engine/test/support/` folder of the development surface.

## What each file does

- `assertions.ts` — the `assertions` module.
- `authority-graph-fixture.ts` — the `authority-graph-fixture` module.
- `authority-graph-test-catalog.ts` — the `authority-graph-test-catalog` module.
- `current-slice-projection-fixture.ts` — the `current-slice-projection-fixture` module.
- `factories.ts` — the `factories` module.
- `host-requirement.ts` — a HOST REQUIREMENT said by name (`requireHost`, `requireLinuxHost`): a hermetic test that needs Linux, the built guardian, a user systemd or a linked fixture asserts it, never returns green without it.
- `flake-shim-stall-after-response.ts` — a REPRODUCTION SHIM (`--preload`): one event-loop stall of 7.5 s right after the loopback server's first answer inside the matrix-executor test "tokens accumulate from run usage" (the test is known through a wrapped `node:test`), recreating the lost reference run deterministically; never imported by a test.
- `flake-shim-hold-requests.ts` — a REPRODUCTION SHIM (`harness flake reproduce --preload`): every HTTP server of the process holds a JSON-RPC answer it receives for 50 ms, recreating the late ping answer of the transport test's H-1 case; never imported by a test.
- `flake-shim-routing-rss.ts` — a REPRODUCTION SHIM for the web runner (`--env NODE_OPTIONS=--import=…`): every resident-set reading is 245748169 bytes, a count that passes the bank-routing check digit, recreating the resource tick whose `process.rss` the ledger's redactor wrote as "[REDACTED:pii]" (REDACT-NUM).
- `flake-shim-cpu-frequency-scaling.ts` — a REPRODUCTION SHIM (`harness flake reproduce --preload`): every `os.cpus()` call answers an alternating current clock speed (1200/3400 MHz), recreating what frequency scaling does between two calls on a hosted runner (#429: the hardware fingerprint hashed that speed). Registered as a deterministic shim; never imported by a test.
- `foundation-cascade-hostile-worker.test.ts` — the `foundation-cascade-hostile-worker.test` module.
- `foundation-cascade-test-catalog.ts` — the `foundation-cascade-test-catalog` module.
- `git-fixtures.ts` — the `git-fixtures` module.
- `guardian-apply.ts` — test-only `applySelfProtection`: runs a payload under the real guardian with a compiled spec (the product's CLI re-exec it replaced is deleted).
- `guardian-build-stamp.ts` — copy the guardian's sealed build inputs (the one spec and every source it names) into another harness root, so a test that builds or places a guardian binary has them beside it.
- `handoff-continuity-hostile-worker.test.ts` — the `handoff-continuity-hostile-worker.test` module.
- `handoff-continuity-test-catalog.ts` — the `handoff-continuity-test-catalog` module.
- `handoff-continuity-test-oracles.ts` — the `handoff-continuity-test-oracles` module.
- `keep-out-facts.ts` — `emptyKeepOutFacts()`: stated host facts (no host files, the registry of a fresh EMPTY key home of the test's own; the registry is an explicit dependency of the keep-out list), and `emptyTestKeyHome()`.
- `legacy-core.ts` — the `legacy-core` module.
- `legacy-errors.ts` — the `legacy-errors` module.
- `legacy-state-boundary.ts` — the `legacy-state-boundary` module.
- `legacy-store-worker.ts` — the `legacy-store-worker` module.
- `legacy-store.ts` — the `legacy-store` module.
- `legacy-text-validation.ts` — the `legacy-text-validation` module.
- `loopback-upstream.ts` — a REAL upstream on 127.0.0.1 for the outbound door's requests (`serve`, `address`, `received`, `resolveAs`): the door owns its transport, so tests drive it end to end. `onDoorBodyReader` watches the readers taken from the door's real response bodies (fault injection without replacing a byte); `mockDoorClock` mocks `setTimeout` for a test and closes the door's pooled connections when it ends (a pooled connection's keep-alive timer belongs to the clock it was armed on).
- `matrix.ts` — the `matrix` module.
- `mock-provider.ts` — the `mock-provider` module.
- `module-resolver.test.ts` — the `module-resolver.test` module.
- `module-resolver.ts` — the TEST-ESTATE door onto the engine module resolver.
- `path-boundary-probe.ts` — the `path-boundary-probe` module.
- `planned-node-test-evidence.ts` — the `planned-node-test-evidence` module.
- `planned-node-test-runtime-environments.ts` — the `planned-node-test-runtime-environments` module.
- `planned-node-test-source-authority.ts` — the `planned-node-test-source-authority` module.
- `refused-alias-probe.ts` — measures whether a bind-mount alias of a refused folder reaches the compiler floor (the identity check), in a private mount namespace.
- `repository-local-temporary-worker.ts` — the `repository-local-temporary-worker` module.
- `repository-local-temporary.ts` — repository-local test fixtures and working copies (`createRepositoryLocalTemporaryDirectory`, `createRepositoryWorkingCopy`) under ONE owned root per process (`owner-<pid>-<start>-<nonce>`: created through `createOwnedTemporaryDirectory`, so a root a killed process left is swept by the next creation; removed at exit).
- `repository-path-hostile-worker.test.ts` — the `repository-path-hostile-worker.test` module.
- `repository-path-test-catalog.ts` — the `repository-path-test-catalog` module.
- `repository-path-test-oracles.ts` — the `repository-path-test-oracles` module.
- `s1-scenario-shared.ts` — the `s1-scenario-shared` module.
- `scratch-runtime-config.ts` — the `scratch-runtime-config` module.
- `slice-projection-hostile-worker.ts` — the `slice-projection-hostile-worker` module.
- `source-scan.ts` — the `source-scan` module.
- `subprocess-mock.ts` — shared subprocess mock helper for unit tests.
- `temp-dir.ts` — `createTempDir` and its block-scoped forms: every directory registered for removal after the file's tests, created inside ONE owned root per process in the system temp root (`bridlewise-engine-test-<pid>-<start>-<nonce>`, dead owners' roots swept on first use, removed at exit).
- `test-env-helpers.ts` — the `test-env-helpers` module.
- `test-git-identity.ts` — `TEST_GIT_IDENTITY` and `testGitIdentityEnvironment()`: the ONE git identity every fixture of both suites commits as (a leaf the web helpers import too).
- `test-inventory-fixture.ts` — the `test-inventory-fixture` module.
- `test-key-home.ts` — `armTestKeyHome()`: the run's private key home (the runners arm it; production never picks one by detecting a test).
- `timeline.ts` — the `timeline` module.
- `websocket-server.ts` — a REAL WebSocket server (RFC 6455 over `node:http` upgrade) on 127.0.0.1: records handshakes, text messages and the close codes a client sends; sends frames and drops connections, so the MCP websocket transport runs through the platform WebSocket.

## Where it lives and what consumes it

The folder lives at `engine/test/support/`.
