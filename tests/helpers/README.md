# helpers

The `tests/helpers/` folder of the development surface.

## What each file does

- `flake-shim-orchestration-run-id.ts` — a reproduction shim (`harness flake reproduce --preload`, FLAKE-REPRO): every `Math.random()` draw from `tests/unit/agent-orchestration.test.ts` answers one whose base-36 digits make `run-orch-tokens-…` read as a credential; never imported by a test.
- `isolated-config.ts` — select a private harness config copy and assert original bytes/mode/nanosecond mtime/inode remain unchanged; `plantSettingsDocument` lands exact bytes the way an operator edit does and runs the request-start refresh (the config owner never reads the file per call).
- `native-script.ts` — runs a module source in a fresh native Node process and returns its status and output (for tests of process-wide owners).

- `control-floor.ts` — shared pointer target CSS analysis without test registration; scans unconditional token recipes and local styles.

- `budget-config.ts` — wHAT THE OPERATOR DECLARED, AND HOW BIG A FULL RUN IS — read once, here.
- `budget-history.ts` — tHE RUN-HISTORY LEDGER'S WEB BINDING — the web path, bound onto the shared owner.
- `budget-paths.ts` — shared budget-summary path — the single owner of the `.bridlewise/web-test-results/latest-summary.json` path.

- `test-manifest.ts` — reads `tests/test-shards.json` once: the supported population a full run judges, and every declared exclusion with the reason it cannot be judged in this snapshot.
- `budget-verdict.ts` — tHE VERDICT MOVED; THE DOOR STAYED. The runtime budget's decision logic — summary judgment, the three run-cost gates, the sustained-condition streak,….
- `client-writes.ts` — tHE WRITE-DOOR SCANNERS — one owner for "which `client.ts` calls change the world, and which module owes the read-only assertion". WHY THIS EXISTS AS….
- `data-loss-helpers.ts` — shared helpers for the data-loss mechanical tests.
- `dossier-floor.ts` — the guard-dossier ratchet's tracked content floor: canonical per-guard fact lines, absent/corrupt refusals, and the pure judge. The only writer is `npm run dossier-floor:update` (`scripts/testing/update-dossier-floor.ts`); a test run never writes it.
- `egress-id-corpus.ts` — the settings ids whose own egress is at risk — the shared oracle for the wire-level redaction arms (the served settings ids the raw detector would corrupt), consumed by the schema-wire suite and the block-door suite.
- `error-scan.ts` — shared error-mapping scan helpers for the prevention test suite.
- `freshness-exemption.ts` — the one owner of `@freshness-exempt <reason>` quality: the marker shape and the refusal of empty, placeholder, and content-free reasons, plus the two required halves (the artifact that would be stale AND the command, producer, or property that establishes its currency), shared by the freshness census and the dossier ratchet.
- `fresh-mtime.ts` — sINGLE-PARTY OWNER of "write a file, then force its mtime so an mtime-keyed cache observes the write". ── The defect this exists to make impossible….
- `function-scope.ts` — sTRUCTURAL SCOPES FOR SOURCE ASSERTIONS — this suite's door to the shared owner, which is `integration/src/shared/source-structure.ts`. The matcher….
- `git-spawn-owner.ts` — wHO CAN MAKE GIT RUN — derived from the owner's own source, not spelled. ── WHY THIS EXISTS ──────────────────────────────────────────────────────….
- `global-boundary.ts` — sINGLE-PARTY OWNER of the per-file global boundary under `isolate: false`. ── The defect this exists to make impossible ────────────────────────────….
- `history-page.ts` — tHE PAGE FACTS A FAKE `/history`.
- `http-server.ts` — shared HTTP test-server lifecycle helper. 14+ integration tests.
- `json-request.ts` — shared JSON HTTP request helper for integration tests. 9+ integration test files each defined their own `async function req()` to send a.
- `memory-storage.ts` — the working `Storage` double for the node environment (write then read back) plus `RefusingStorage`, whose `setItem` throws the way a full or private-mode browser refuses a write.
- `migrate-path-literals.ts` — migrate prevention guards off hardcoded product-path literals onto the module resolver.
- `mock-http.ts` — shared HTTP mock primitives for tests that exercise.
- `module-resolver.ts` — tHE SINGLE OWNER OF "WHERE DOES A PRODUCT MODULE LIVE". ── THE DEFECT THIS OWNER ENDS ──────────────────────────────────────────── A module's.
- `network-install.ts` — the one reader of "this shell text installs system packages from the network" (`networkInstalls`), shared by the workflow-policy, external-surface-registry and guardian-compiler-pin guards.
- `multi-user.ts` — multi-user test helpers.
- `native-authority.ts` — the shared native-authority ceiling suite: a delegation profile's tool names stay a ceiling under restrictions, proven on the admitted native request.
- `playwright-liveness.ts` — tHE FOURTH DECLARATION CLASS: Playwright's `testDir` + `testMatch`. Three file-selecting declaration classes already refuse a dead member at their….
- `prevention-dossier.ts` — tHE GUARD DOSSIER — one parser, one validator, shared by both prevention estates and both runners. ── What a dossier is….
- `promotion-view.ts` — what this branch ships, as its promotion profiles declare it: the working tree classified by every profile (the projection `harness promote` runs), memoized per root — `ships(path)`, the shipped folders and root entries (product, derived), and the profiles' excluded trees; the one answer the guards ask about product (`declared-root-inventory`, `source-root-organization`, `no-hardcoded-truncation-slices`, `promotion-boundary`).
- `provider-stream.ts` — a terminal native response for a hand-written provider stream stub, built from the canonical Responses fixtures so a test does not shape a second response format.
- `rewind-provider-harness.ts` — the shared server, database, run, rewind and restore helpers for the split rewind suites.
- `rewind-provider-state.ts` — the provider recorder shared by every split rewind suite's module mock.
- `readme-consumers.ts` — gENERATE the README "what consumes it" section from the import graph. ── THE DEFECT THIS ENDS ────────────────────────────────────────────────── Each….
- `run-source.ts` — tHE RUN PATH'S SOURCE, AS ONE SUBJECT. The run used to be one file. `GET /api/run/:runId/stream` was the executor, so `server/routes/run.ts`….
- `hub-population.ts` — the canonical hub's decorated re-export population, derived from the hub's own `engineSpans(...)` destructures — the one scanner the hub-discipline guards and the engine-lane behavioural tests share.
- `source-scan.ts` — shared source-scan helpers for the prevention test suite.
- `stub-llm-client.ts` — shared stub for the provider seam: the scripted `SharedLLMClient` mock factory + state, so tests drive the real `streamChat` chain without a live provider.
- `temp-git-repo.ts` — a throwaway git repository for a fixture: the temp-dir owner's folder, a local fixture identity (never the ambient one), a named first branch (`main` by default), and a `git(...)` that runs without the caller's `GIT_*` variables or global/system config (the engine owner's `directoryGitEnvironment`) and throws with git's own stderr, so a broken fixture fails as a fixture and never touches another repository.
- `until.ts` — the one wait for a condition (`until`): polls every 10 ms with NO wall deadline (NO-LOAD-BLOCK); a condition that never holds is a hang, ended and named by the hang backstop.
- `temp-dir.ts` — sINGLE-PARTY OWNER of test temporary directories. ── The defect this exists to make impossible ──────────────────────────── Test files created temp….
- `timeline-documents.ts` — a timeline document as the ledger admits it: exact JSON text and the digest of that text; fixtures build documents here and never hand-write a digest.
- `vm-context-pool.ts` — the DOM test process pool: fresh VM contexts per file, cancellation and memory recycling through Vitest's owned child processes.
- `vm-isolation-witness.ts` — the isolation guard's real process/context, input freshness, cancellation and effective population witnesses.

## Where it lives and what consumes it

The folder lives at `tests/helpers/`.
