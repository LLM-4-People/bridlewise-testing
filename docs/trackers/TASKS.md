# Public floor tasks

This is the public task board for the Bridlewise development floor. It is a working list, not a release schedule. Each row names one outcome; the detailed exit criteria live in the [build roadmap](https://llm-4-people.github.io/bridlewise-testing/floor/roadmap/).

## Open

- [ ] **Repair the public full-suite baseline** — close the remaining public-snapshot failures, or record each as a named exclusion with evidence.
- [ ] **Activate the sharded full-suite gate** — run the canonical file set on disjoint shards, merge one receipt, and refuse a missing, duplicate, failed, or wrong-commit shard.
- [ ] **Publish the corpus manifest** — add a pinned fetch step or a sanitized permissive subset without publishing the raw 4.1 GB cache.
- [ ] **Make the performance report reproducible** — document the idle-host contract and judge a fresh profile in the suite.
- [ ] **Split the slow rewind test** — bring each file under the per-file share budget without changing what it proves.
- [ ] **Add per-capability admission receipts** — replace the single readiness boolean with named evidence and remedies.
- [ ] **Document the backup and restore flow** — cover the database and the key home with a verification step.
- [ ] **Add a second provider conformance fixture** — prove the Chat Completions shape without claiming universal compatibility.
- [ ] **Make the testing hub discoverable from every surface** — keep the README, Pages hub, roadmap, and help paths in step.
- [ ] **Verify the public floor on a fresh machine** — run the public gate and the focused corpus probe from a clean clone.

## Flaky burn-down owners

Each row owns one entry in the tracked flaky burn-down list. The owner is the task that must reproduce, fix, or explicitly retire the entry.

- [ ] **FLAKY-CUSTODY-KEEPOUT-ESTALE** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/unit/custody-blocks-real-ledger.test.ts`, `tests/unit/custody-see-what-changed.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)
- [ ] **FLAKY-HELPERS-README-HARNESS-VIEW** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/prevention/source-root-organization.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)
- [ ] **FLAKY-ISOLATION-PIDFD** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/prevention/test-isolation-contract.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)
- [ ] **FLAKY-PERF-GATE-STALE-REPORT** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/performance/regression.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)
- [ ] **FLAKY-POPULATION-FLOOR-REDERIVED** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/prevention/web-ui-runtime-budget.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)
- [ ] **FLAKY-RESOURCE-SAMPLER-TICK** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/unit/resource-sampler.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)
- [ ] **FLAKY-VERDICT-CONFIG-RACE** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/prevention/web-ui-runtime-budget-verdict.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)
- [ ] **FLAKY-WATCHDOG-C3** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/prevention/test-run-watchdog.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)
- [ ] **FLAKY-WEB-ARTIFACT-CENSUS** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/prevention/generated-artifact-freshness.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)
- [ ] **FLAKY-WEB-F5-LINK-RUN** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/prevention/allowed-commands-config.test.ts`, `tests/prevention/effect-kind-recording.test.ts`, `tests/prevention/git-bridge-owner.test.ts`, `tests/prevention/git-refusal-not-emptiness.test.ts`, `tests/prevention/gitignore-anchoring.test.ts`, `tests/prevention/subprocess-confinement-owner.test.ts`, `tests/unit/auto-check-runner.test.ts`, `tests/unit/tool-executor-unified.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)
- [ ] **FLAKY-WEB-GUARD-REDS-ON-ROUND-TREES** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/prevention/agent-docs-liveness.test.ts`, `tests/prevention/centralized-config.test.ts`, `tests/prevention/config-write-gate-owner.test.ts`, `tests/prevention/declared-pattern-liveness.test.ts`, `tests/prevention/error-debug-owner.test.ts`, `tests/prevention/error-handling-consistency.test.ts`, `tests/prevention/exposure-reachable.test.ts`, `tests/prevention/guarded-callbacks.test.ts`, `tests/prevention/integration-rule-refs-ratchet.test.ts`, `tests/prevention/no-proximity-window-assertions.test.ts`, `tests/prevention/no-rule-refs.test.ts`, `tests/prevention/no-unused-imports.test.ts`, `tests/prevention/path-spelling-comparison.test.ts`, `tests/prevention/raw-handle-owner.test.ts`, `tests/prevention/raw-source-reader-owner.test.ts`, `tests/prevention/secret-intelligence-owner.test.ts`, `tests/prevention/source-root-organization.test.ts`, `tests/prevention/test-helpers-dedup.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)
- [ ] **FLAKY-WEB-PROXIMITY-ROUND-13-REGEX** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/prevention/no-proximity-window-assertions.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)
- [ ] **FLAKY-WEB-STRAY-TREE-RUN** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/performance/regression.test.ts`, `tests/prevention/decisions-format.test.ts`, `tests/prevention/git-refusal-not-emptiness.test.ts`, `tests/prevention/run-executes-once.test.ts`, `tests/prevention/subprocess-confinement-owner.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)
- [ ] **FLAKY-WEB-SUBSTITUTE-HOME** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/unit/mcp-servers-route.test.ts`, `tests/unit/mcp-stdio-landlock.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)
- [ ] **FLAKY-WEB-UNDIAGNOSED** — reproduce the recorded flake, fix its owner, or retire the entry with evidence. (covers `tests/unit/config-write-concurrency.test.ts`, `tests/unit/landlock-project-refusal.test.ts`, and `tests/prevention/flaky-test-memory.test.ts`)

## Done

- [x] **Give the testing repository its own front door** — publish a contributor hub, move product documentation to a linked entry point, and keep the complete mirror.
- [x] **Publish the milestone roadmap** — state M0 to M4, exit criteria, and the full-suite audit.
- [x] **Add the shard merge contract** — refuse missing, duplicate, failed, unexpected, and out-of-root shard files, and write one receipt.
- [x] **Record the v0.0.3 release evidence** — receipt, checksums, attestations, and verification commands.
- [x] **Anchoring the public ignore rules** — keep every pattern scoped to the place it names, and pass the floor guard.
- [x] **Update the rewind provider stub** — read the Responses request shape and exercise the real context path.
- [x] **Allow the public node:test suite in the source walks** — keep `.mjs` smoke files visible to the guards that judge the tree.
