---
schema: bridlewise-tracker-item/v1
id: FLAKY-PUBLIC-ENGINE-UNDIAGNOSED
type: Flake
state: open
lane: flaky-burn-down
opened: 2026-10-20
---

public re-owning of the private lane `FLAKY-ENGINE-UNDIAGNOSED`; **needs private history, still owned**. The identity is `engine/test/repository-root-capability.test.ts` `Linux test adapter is explicit, path-closed, and has typed unavailable outcomes` (the title is present at HEAD; the file is 26/26 green in the 2026-10-20 focused run). The private floor's row records the red three times on 2026-10-07 (17:13Z–20:19Z, one digest) and says **cause not found**. The only record here, `engine/traceability/flake-reproductions/9971023809fa1b13bd0845c6.json` (recorded 2026-10-08T06:24:49Z), is schema v2; the current door refuses v2 by version before it reads the attempt log (`engine/src/shared/flake-reproduction.ts`), so the record explains nothing. Its parent `cf352060` → fix `50130fbb`, one run per side, is not a current-door reproduction; `50130fbb`'s change to the test (the mount point comes from this system's mount table) is present at HEAD (`2660a069…`), but the lane owner has not accepted it as the cause. Missing artifact: a schema-v3 reproduction record plus its `attempts/` file for this identity (or the private lane's accepted cause/record); until one exists the entry stays owned. Guarded by `engine/test/prevention/flaky-test-memory.test.ts`.
