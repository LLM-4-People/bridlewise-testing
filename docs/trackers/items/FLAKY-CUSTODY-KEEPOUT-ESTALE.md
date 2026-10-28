---
schema: bridlewise-tracker-item/v1
published: false
id: FLAKY-CUSTODY-KEEPOUT-ESTALE
type: Flake
state: closed
resolution: completed
lane: flaky-burn-down
opened: 2026-10-20
closed: 2026-10-20
---

retired 2026-10-20 on `agent/flaky-keepout` from `f6c8cef2` as a stale private-web lane: the recorded failure mechanism is gone, and the public ledger does not carry its entry. The record claimed the guardian refused a whole confined spawn when a keep-out entry changed while it was located — `keep_out[#] is not a resolved path: '<tmp>/<dir>/web.db': Stale file handle` at 2026-10-07T16:54Z — because the run's one key home registers every test file's temporary database, so one file's cleanup churned another's keep-out entry; the private floor fixed it at `d250d3da`, whose code this tree carries in its sanitized import. `engine/guardian/landlock-guardian.c` re-locates an ESTALE entry, keeps it out by its folder and its name, and runs the unrelated spawn (`keep_out_retries` in `engine/src/filesystem/self-protection/self-protection-contracts.ts`), and the deterministic arm `engine/test/filesystem/self-protection/keep-out-links.test.ts` "S2, DETERMINISTIC: … (ESTALE) …" proves the old whole-spawn refusal is gone while the entry is still kept out. Observed at `f6c8cef2`: the two named tests are 31/31 in ten consecutive `npx vitest run` runs and 18/18 in three runs under the recorded condition (a private `HARNESS_KEY_HOME` holding a registered `$TMPDIR/bw-custody-race-*/web.db` that a loop unlinked and re-created); `engine/test/filesystem/self-protection/keep-out-links.test.ts` is 8/8; `engine/test/prevention/flaky-test-memory.test.ts` is 19/19; `tests/prevention/flaky-test-memory.test.ts` is 8/8. No entry was removed because none is in the public list: the import `2545d94f` carried the private web history, `94b1a97f` emptied it, and `400a130a` added only the three public suspects that `engine/traceability/flaky-burn-down/web.json` now holds under the README's rule; `engine/traceability/flaky-burn-down/engine.json` is the engine suite's list and has never held a custody identity. The ledger guards pass over the closed row. This closes the public tracking row only; the private floor remains the owner of its own records. What remains is the run-wide key home's cross-file coupling (ordinary work on the private floor, not a public entry); it no longer manifests as this refusal.
