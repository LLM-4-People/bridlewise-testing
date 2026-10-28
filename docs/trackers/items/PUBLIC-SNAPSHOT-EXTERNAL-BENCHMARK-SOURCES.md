---
schema: bridlewise-tracker-item/v1
published: false
id: PUBLIC-SNAPSHOT-EXTERNAL-BENCHMARK-SOURCES
type: Task
state: closed
resolution: completed
lane: floor
opened: 2026-10-20
closed: 2026-10-20
---

closed 2026-10-20 at `c0f637e7`. Reproduced 35 diagnostics (3 hash-drift, 16 missing, 16 unreadable; the row's 34 was the `f518c9f6` measurement). Decision: this is the public boundary, not a missing fixture. The 16 `verification/benchmarks/historical-opencode/` sources are the private floor's historical research and the public snapshot pruned them deliberately (`ROOT_POLICY` records the 16→8 test-surface prune; the public tree carries no `historical-opencode/` directory), so no source was fabricated or restored. The architecture owner now declares `publication: "not-published"` on those 16 commands: `verifyExternalCommands` emits `architecture-external-command-source-not-published:<path>` on every run and `architecture-external-command-source-unexpectedly-published:<path>` if one appears; the S1 reader skips only the expected-absent read, and `isUnavailableCapabilityDiagnostic` classifies the named boundary so `S1-B08-CONTROL` and `S1-B13-CONTROL` accept it as a baseline refusal — `verifyS1Structure().ok` stays false and all 16 named diagnostics remain visible, not silenced. The three published sources that had drifted (`code-intelligence/inspect_existing_baseline.py`, `code-intelligence/tests/test_qualification.py`, `runtime/verify-node-v24.18.0-linux-x64.sh`) are deliberately sanitized public copies, so their `sourceSha256` pins were re-measured to the public bytes (`478d8122…`, `191b4eb3…`, `8d20dcf7…`) and they remain published and hash-bound. The recursive inventory's second hand-written pin moved 16→8 / `8dcad553…` to match `root-policy.ts`. Ran: `node --experimental-strip-types --test test/verification/architecture-external-commands.test.ts` 8/8 (new absent and unexpectedly-present boundary arms), `test/s1-scenarios/b08.test.ts` 3/3, `test/s1-scenarios/b13.test.ts` 3/3, `test/verification/recursive-test-inventory.test.ts` 29/29, `test/prevention/flaky-test-memory.test.ts` 19/19, `test/verification/test-surface-conservation.test.ts` 11/11, and `node src/cli.ts harness sync --with-bundle` (pass; re-pinned `f7138261…`).
